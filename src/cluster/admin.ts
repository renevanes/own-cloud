/**
 * Beheerhandelingen van buitenaf (beheerconsole en CLI): eerste node starten / wekken, status lezen,
 * opdrachten aan het cluster geven, en de beheerconfiguratie veilig in de opslag bewaren.
 */
import crypto from "node:crypto";
import { deriveKey, openJson, sealJson } from "./crypto.js";
import { keysFor, type ClusterConfig, type Member } from "./config.js";
import { makeProvider } from "./providers.js";
import { makeStore, S3Store, type StoreConfig } from "./stores.js";
import { imageUrls, userData } from "./cloudinit.js";
import { rpc } from "./transport.js";
import { parseBudget, serverPrices } from "./costs.js";

export interface Manifest {
  cluster: string; state: "awake" | "asleep"; term: number; lastSeq: number; updated: number; leader: string;
  nodes: { id: string; kind: string; provider: string; region: string | null; country: string | null; ipv4: string | null; clusterUrl?: string | null; status: string }[];
  topology: { kind: string; provider: string; region: string; size: string }[];
  lastDrill?: { ts: number; message: string } | null;
  _store?: string;
}

export async function readManifest(c: ClusterConfig): Promise<Manifest | null> {
  const keys = keysFor(c);
  let best: Manifest | null = null;
  for (const s of c.stores.map(makeStore)) {
    try {
      const buf = await s.getBuffer("manifest.enc");
      if (!buf) continue;
      const m = openJson<Manifest>(keys.manifest!, buf, "manifest");
      if (!best || m.updated > best.updated) best = { ...m, _store: s.name };
    } catch { /* volgende opslag */ }
  }
  return best;
}

/** Ondertekende opdracht: alleen wie de hoofdsleutel heeft (niet een witness) kan jobs starten. */
export function adminProof(masterKeyHex: string, payload: unknown) {
  const ts = Date.now();
  const mac = crypto.createHmac("sha256", deriveKey(Buffer.from(masterKeyHex, "hex"), "admin")).update(`${ts}:${JSON.stringify(payload)}`).digest("hex");
  return { ts, mac };
}
export function verifyAdminProof(masterKeyHex: string, payload: unknown, proof: { ts: number; mac: string } | undefined) {
  if (!proof || Math.abs(Date.now() - proof.ts) > 120_000) return false;
  const good = crypto.createHmac("sha256", deriveKey(Buffer.from(masterKeyHex, "hex"), "admin")).update(`${proof.ts}:${JSON.stringify(payload)}`).digest("hex");
  return good.length === proof.mac.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(proof.mac));
}

function memberUrls(m: Manifest, c: ClusterConfig) {
  return m.nodes.filter((n) => n.status !== "removed").map((n) => n.clusterUrl ?? `http://${n.ipv4}:${c.clusterPort}`);
}

/** Zoekt de leider via de nodes uit het manifest (of een opgegeven lijst). */
export async function findLeader(c: ClusterConfig, urls: string[]): Promise<{ url: string; status: any } | null> {
  const keys = keysFor(c);
  const tried = new Set<string>();
  const queue = [...urls];
  while (queue.length) {
    const url = queue.shift()!;
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      const st = await rpc<any>(keys.cluster, url, { type: "status" }, 3000);
      if (st.role === "leader") return { url, status: st };
      const leader = (st.members as Member[] | undefined)?.find((x) => x.id === st.leaderId);
      if (leader) queue.unshift(leader.clusterUrl);
      for (const mb of (st.members as Member[] | undefined) ?? []) queue.push(mb.clusterUrl);
    } catch { /* niet bereikbaar */ }
  }
  return null;
}

export async function probeCluster(c: ClusterConfig, m: Manifest): Promise<string[]> {
  const keys = keysFor(c);
  const alive: string[] = [];
  await Promise.all(m.nodes.filter((n) => n.status !== "removed").map(async (n) => {
    try { await rpc(keys.cluster, n.clusterUrl ?? `http://${n.ipv4}:${c.clusterPort}`, { type: "status" }, 3000); alive.push(n.id); } catch { /* weg */ }
  }));
  return alive;
}

/** Live overzicht van de leider, met terugval op het manifest. */
export async function clusterStatus(c: ClusterConfig, extraUrls: string[] = []) {
  const m = await readManifest(c);
  const urls = [...extraUrls, ...(m ? memberUrls(m, c) : [])];
  const leader = urls.length ? await findLeader(c, urls) : null;
  let live: any = null;
  if (leader) live = await rpc<any>(keysFor(c).cluster, leader.url, { type: "clusterSummary" }, 5000).catch(() => null);
  return { manifest: m, leaderUrl: leader?.url ?? null, live };
}

export async function sendJob(c: ClusterConfig, leaderUrl: string, type: string, params: Record<string, unknown> = {}) {
  const payload = { type, params };
  return rpc<{ ok: boolean; id?: string; error?: string }>(keysFor(c).cluster, leaderUrl, { type: "adminJob", job: payload, proof: adminProof(c.masterKey!, payload) }, 5000);
}

/** Start de eerste node van een (nieuw of slapend) cluster. */
export async function provisionFirstNode(c: ClusterConfig, opts: { provider: string; region: string; size: string; country?: string; term?: number; initialSettings?: Record<string, string>; adminOverride?: { settings: Record<string, string> } }) {
  const nodeId = `n-${crypto.randomBytes(3).toString("hex")}`;
  const token = crypto.randomBytes(32).toString("hex");
  const store = c.stores.map(makeStore).find((s) => s.purpose === "replica") ?? makeStore(c.stores[0]);
  const key = `bootstrap/${nodeId}.enc`;
  const prov = makeProvider(opts.provider, c.providers[opts.provider]);
  const info = await prov.create({
    cluster: c.cluster, nodeId, kind: "data", region: opts.region, size: opts.size,
    userData: userData(c, { nodeId, kind: "data", bootstrapUrl: store.presignGet(key, 7200), joinToken: token, ...(await imageUrls(store)) }),
  });
  const nodeCfg: ClusterConfig = {
    ...c, nodeId, kind: "data", bootstrapLeader: true, bootstrapTerm: opts.term ?? 0, joinToken: undefined, seeds: [],
    advertise: { clusterUrl: info.clusterUrl ?? `http://${info.ipv4}:${c.clusterPort}`, apiUrl: info.apiUrl ?? `https://${info.ipv4}`, ipv4: info.ipv4, ipv6: info.ipv6 },
    selfInfo: { provider: opts.provider, region: opts.region, size: opts.size, serverId: info.serverId, country: info.country ?? opts.country ?? prov.country(opts.region) },
    initialSettings: opts.initialSettings,
    ...(opts.adminOverride ? { adminOverride: opts.adminOverride } : {}),
  };
  delete (nodeCfg as { console?: unknown }).console;
  await store.put(key, sealJson(deriveKey(Buffer.from(token, "hex"), "bootstrap"), nodeCfg, "bootstrap"));
  if (c.domain && prov.setPtr) await prov.setPtr(info, `mail.${c.domain}`).catch(() => {});
  return { nodeId, info, clusterUrl: nodeCfg.advertise.clusterUrl };
}

// ───────── Beheerconfiguratie in de opslag ─────────

export async function saveAdminCopy(c: ClusterConfig) {
  const keys = keysFor(c);
  const body = sealJson(keys.manifest!, c, "admin-config");
  let ok = 0;
  for (const s of c.stores.map(makeStore)) await s.put("admin-config.enc", body).then(() => ok++, () => {});
  return ok;
}

/** Herstel met alleen de hoofdsleutel en de gegevens van één opslag. */
export async function recoverAdminConfig(masterKeyHex: string, store: StoreConfig): Promise<ClusterConfig> {
  const keys = keysFor({ masterKey: masterKeyHex });
  const buf = await makeStore(store).getBuffer("admin-config.enc");
  if (!buf) throw new Error("In deze opslag staat geen Eigen Cloud-configuratie");
  try {
    return openJson<ClusterConfig>(keys.manifest!, buf, "admin-config");
  } catch {
    throw new Error("Deze sleutel past niet bij deze opslag");
  }
}

/**
 * Herstellen als je de bucketnaam niet (meer) weet: alle buckets van de sleutel langslopen en de eerste met een
 * configuratie die bij deze sleutel past nemen. Geeft de configuratie en de gevonden opslag terug.
 */
export async function findAdminConfig(masterKeyHex: string, store: StoreConfig): Promise<{ config: ClusterConfig; store: StoreConfig }> {
  if (store.type !== "s3" || store.bucket) return { config: await recoverAdminConfig(masterKeyHex, store), store };
  const buckets = await (makeStore({ ...store, bucket: "x" }) as S3Store).listBuckets();
  if (!buckets.length) throw new Error("Met deze sleutel zijn geen buckets te zien");
  let wrongKey = false;
  for (const bucket of buckets) {
    try {
      const st = { ...store, bucket };
      return { config: await recoverAdminConfig(masterKeyHex, st), store: st };
    } catch (e) { if (/past niet/.test((e as Error).message)) wrongKey = true; }
  }
  throw new Error(wrongKey ? "Deze herstelsleutel past niet bij de opslag" : "In geen van de buckets staat een Eigen Cloud-configuratie");
}

// ───────── Opslag testen en inrichten ─────────

export interface StepResult { label: string; ok: boolean; detail?: string }

export async function prepareStore(cfg: StoreConfig): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const s = makeStore(cfg);
  if (s instanceof S3Store) {
    let exists = false;
    try {
      exists = await s.bucketExists();
      steps.push({ label: `Verbinding met ${new URL(cfg.endpoint!).host}`, ok: true });
    } catch (e) {
      steps.push({ label: "Verbinding en inloggen", ok: false, detail: (e as Error).message });
      return steps;
    }
    if (!exists) {
      try {
        await s.createBucket(cfg.purpose === "backup");
        steps.push({ label: `Bucket '${cfg.bucket}' aangemaakt${cfg.purpose === "backup" ? " (met object-lock)" : ""}`, ok: true });
      } catch (e) {
        steps.push({ label: `Bucket '${cfg.bucket}' aanmaken`, ok: false, detail: (e as Error).message });
        return steps;
      }
    } else steps.push({ label: `Bucket '${cfg.bucket}' bestaat al`, ok: true });

    if (cfg.purpose === "backup") {
      const v = await s.putBucketConfig("versioning", `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>`).catch(() => false);
      steps.push({ label: "Versiebeheer aan (overschrijven bewaart de oude versie)", ok: v, detail: v ? undefined : "Niet ondersteund — zet het zo mogelijk zelf aan in de console van de aanbieder" });
      const l = await s.putBucketConfig("object-lock", `<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>`).catch(() => false);
      steps.push({ label: "Onveranderbaar: 30 dagen niet te wissen (object-lock)", ok: l, detail: l ? undefined : "Niet ondersteund door deze opslag; back-ups worden alsnog nooit door Eigen Cloud verwijderd" });
    }
  }
  try {
    const probe = `test/${crypto.randomBytes(4).toString("hex")}`;
    await s.put(probe, Buffer.from("eigen-cloud"));
    const back = await s.getBuffer(probe);
    if (back?.toString() !== "eigen-cloud") throw new Error("teruglezen gaf iets anders");
    if (cfg.purpose === "replica") await s.delete(probe);
    steps.push({ label: "Schrijven en teruglezen", ok: true });
  } catch (e) {
    steps.push({ label: "Schrijven en teruglezen", ok: false, detail: (e as Error).message });
  }
  return steps;
}

/** Stuurt gewijzigde beheerinstellingen naar het draaiende cluster (ondertekend). */
type ConsolePart = { budget?: number | null; catalog?: Parameters<typeof serverPrices>[0]; mailRelay?: string; spfExtra?: string; alertEmail?: string; extraDns?: unknown[]; maxUsers?: number; dienst?: { url?: string; orderId?: string; applied?: boolean };
  aanbieder?: { url?: string; removed?: boolean; dnsRemove?: string[]; server?: { ipv4?: string; ipv6?: string } | null; adressen?: { host?: string } } };

/**
 * DNS-records voor de Eigen Cloud Dienst van een aanbieder die de cloud zelf publiceert (extra_dns): A/AAAA voor het
 * adres van de Dienst als dat onder het domein van de cloud valt (bijv. dienst.vanes.nl). Na verwijderen, of voor een
 * vorig adres, lege waarden: dan haalt de cloud het record weg. Alleen zolang er een server is (of was).
 */
export function aanbiederDns(c: { domain?: string } & { console?: ConsolePart }): { sub: string; type: "A" | "AAAA"; value: string }[] {
  const a = c.console?.aanbieder, d = c.domain;
  if (!a || !d) return [];
  const subOf = (host: string) => (host.endsWith(`.${d}`) ? host.slice(0, -(d.length + 1)) : null);
  const out: { sub: string; type: "A" | "AAAA"; value: string }[] = [];
  for (const sub of a.dnsRemove ?? []) out.push({ sub, type: "A", value: "" }, { sub, type: "AAAA", value: "" });
  let host = "";
  try { host = a.url ? new URL(a.url).hostname : ""; } catch { /* geen geldig adres */ }
  // De Dienst en (als hij er draait) de adressendienst op dezelfde server.
  for (const h of [host, a.adressen?.host ?? ""]) {
    const sub = h ? subOf(h) : null;
    if (sub && (a.removed || a.server?.ipv4)) {
      const keep = out.filter((x) => x.sub !== sub);
      out.length = 0;
      out.push(...keep, { sub, type: "A", value: a.removed ? "" : a.server?.ipv4 ?? "" }, { sub, type: "AAAA", value: a.removed ? "" : a.server?.ipv6 ?? "" });
    }
  }
  return out;
}

/** Instellingen die de beheerconsole aan de cloud doorgeeft (bij de start en na elke wijziging). */
export function consoleSettings(c: ClusterConfig & { console?: ConsolePart }, defaultDienst = ""): Record<string, string> {
  const settings: Record<string, string> = {};
  const con = c.console;
  if (!con) return settings;
  settings.mail_relay = con.mailRelay ?? "";
  settings.spf_extra = con.spfExtra ?? "";
  settings.extra_dns = JSON.stringify([...(con.extraDns ?? []), ...aanbiederDns(c)]);
  if (con.alertEmail) settings.alert_email = con.alertEmail;
  // Abonnement bij een aanbieder: hoeveel gebruikers, en waar de cloud zijn technische gezondheid meldt.
  settings.max_users = String(con.maxUsers ?? 0);
  const token = c.dns.find((d) => d.type === "desec" && d.name === "dienst")?.token;
  const url = (con.dienst?.url || defaultDienst).replace(/\/$/, "");
  settings.dienst_report = con.dienst?.orderId && con.dienst.applied && token && url ? JSON.stringify({ url, orderId: con.dienst.orderId, token }) : "";
  // Kosten en budget (zie costs.ts): budget per maand ("" = geen) en de maandprijzen van de formaten uit de catalogus.
  // Oudere servers bewaren onbekende instellingen alleen en doen er niets mee.
  const budget = parseBudget(con.budget);
  settings.budget_month = budget === null ? "" : String(budget);
  settings.cost_servers = JSON.stringify(serverPrices(con.catalog));
  return settings;
}

export async function pushAdminConfig(c: ClusterConfig & { console?: ConsolePart }, defaultDienst = "", leaderUrl?: string) {
  const st = leaderUrl ? { leaderUrl } : await clusterStatus(c);
  if (!st.leaderUrl) return false;
  const settings = consoleSettings(c, defaultDienst);
  const update = { stores: c.stores, providers: c.providers, dns: c.dns, placement: c.policy.placement, settings };
  const r = await rpc<{ ok: boolean }>(keysFor(c).cluster, st.leaderUrl, { type: "adminConfig", update, proof: adminProof(c.masterKey!, update) }, 8000);
  return r.ok;
}
