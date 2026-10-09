import crypto from "node:crypto";
import dnsp from "node:dns/promises";
import fs from "node:fs";
import tls from "node:tls";
import { config } from "./config.js";
import { db, getSetting, setSetting } from "./db.js";
import { mailSettings, ownAddress } from "./mail/send.js";

/** Gmail-koppeling: "naast" = proefperiode, mail komt nog bij Google binnen. */
export function gmailMode(): "uit" | "naast" | "vangnet" {
  const m = getSetting("gmail_mode");
  return m === "naast" || m === "vangnet" ? m : "uit";
}

/**
 * Gezondheidscontroles met automatisch herstel. Werkt op een losse server en in een cluster;
 * in een cluster draait de leider ze elk kwartier en mailt hij bij veranderingen.
 */

export type Status = "ok" | "warn" | "fail" | "skip";
export interface Check {
  id: string;
  group: "Mail" | "Domein" | "Back-up" | "Servers" | "Meldingen";
  title: string;
  status: Status;
  detail: string;
  /** Automatische reparatie (knop). */
  fix?: { action: string; label: string };
  /** Handmatige instructie als automatisch niet kan (bijv. DNS-record om te kopiëren). */
  manual?: { name: string; type: string; value: string }[];
}

export interface DnsRecord { sub: string; type: "A" | "AAAA" | "MX" | "TXT"; values: string[]; ttl: number }

/** Te vervangen in tests. */
export const net = {
  resolver: new dnsp.Resolver({ timeout: 4000, tries: 2 }) as Pick<dnsp.Resolver, "resolveMx" | "resolveTxt" | "resolve4" | "reverse">,
  tlsDaysLeft: async (host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = tls.connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
        const cert = s.getPeerCertificate();
        s.end();
        if (!s.authorized) return reject(new Error(String(s.authorizationError)));
        resolve(Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 864e5));
      });
      s.on("error", reject);
      s.on("timeout", () => { s.destroy(); reject(new Error("time-out")); });
    }),
};

/** Wat het cluster nodig heeft om de context te vullen (zonder harde afhankelijkheid). */
export interface ClusterInfo {
  ips4: string[];
  ips6: string[];
  dnsAutomatic: boolean;
  ptrAutomatic: boolean;
  snapshotAgeH: number | null;
  snapshotEveryH: number;
  stores: { name: string; country?: string | null; purpose: string; lag: number | null }[];
  lastDrill: { ts: number; ok: boolean; message: string } | null;
  drillEveryDays: number;
  dataReady: number;
  witnessReady: number;
  wantData: number;
  wantWitness: number;
  autoHeal: boolean;
  unreachable: string[];
}

export function domain(): string | null {
  const from = ownAddress();
  const d = from.split("@")[1] ?? config.mailDomains[0];
  return d && d !== "example.nl" ? d.toLowerCase() : null;
}

// ───────── DKIM ─────────

export function dkimSelector() {
  return getSetting("dkim_selector") || config.dkimSelector || "eigen";
}

export function dkimPublic(): string | null {
  const priv = getSetting("dkim_private");
  if (!priv) return null;
  return crypto.createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
}

export function generateDkim() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  setSetting("dkim_private", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  if (!getSetting("dkim_selector")) setSetting("dkim_selector", "eigen");
}

/** TXT-waarden langer dan 255 tekens moeten in stukken. */
export function txt(value: string) {
  return (value.match(/.{1,255}/g) ?? [""]).map((c) => `"${c}"`).join(" ");
}

// ───────── Verwachte records ─────────

export function expectedRecords(info: Pick<ClusterInfo, "ips4" | "ips6">): DnsRecord[] {
  const d = domain();
  if (!d) return [];
  const recs: DnsRecord[] = [];
  if (info.ips4.length) {
    for (const sub of ["cloud", "mail"]) {
      recs.push({ sub, type: "A", values: info.ips4, ttl: 300 });
      recs.push({ sub, type: "AAAA", values: info.ips6, ttl: 300 });
    }
  }
  const trial = gmailMode() === "naast";
  // Proefperiode naast Gmail: de MX blijft bij Google, dus die raken we niet aan.
  if (!trial) recs.push({ sub: "", type: "MX", values: [`10 mail.${d}.`], ttl: 3600 });
  let extra = (getSetting("spf_extra") ?? "").trim();
  // Tijdens de proefperiode mag Google ook namens je domein blijven versturen.
  if (trial && !extra.includes("_spf.google.com")) extra = `${extra} include:_spf.google.com`.trim();
  recs.push({ sub: "", type: "TXT", values: [txt(`v=spf1 a:mail.${d}${extra ? " " + extra : ""} -all`)], ttl: 3600 });
  const pub = dkimPublic();
  if (pub) recs.push({ sub: `${dkimSelector()}._domainkey`, type: "TXT", values: [txt(`v=DKIM1; k=rsa; p=${pub}`)], ttl: 3600 });
  const rua = getSetting("alert_email") || ownAddress();
  recs.push({ sub: "_dmarc", type: "TXT", values: [txt(`v=DMARC1; p=quarantine; rua=mailto:${rua}`)], ttl: 3600 });
  return recs;
}

/** Bij het apex-TXT-record andere waarden (bijv. verificaties) behouden; alleen SPF vervangen. */
export async function mergeApexTxt(rec: DnsRecord): Promise<DnsRecord> {
  if (rec.sub !== "" || rec.type !== "TXT") return rec;
  const d = domain()!;
  const existing = await net.resolver.resolveTxt(d).catch(() => [] as string[][]);
  const others = existing.map((parts) => parts.join("")).filter((v) => !v.startsWith("v=spf1")).map(txt);
  return { ...rec, values: [...rec.values, ...others] };
}

const fqdn = (sub: string) => (sub ? `${sub}.${domain()}` : domain()!);
const unquote = (v: string) => v.replace(/"\s*"/g, "").replace(/^"|"$/g, "");

// ───────── Controles ─────────

async function txtOf(name: string) {
  return (await net.resolver.resolveTxt(name).catch(() => [] as string[][])).map((p) => p.join(""));
}

export async function runChecks(cluster: ClusterInfo | null): Promise<Check[]> {
  const checks: Check[] = [];
  const d = domain();
  const auto = !!cluster?.dnsAutomatic;
  const trial = gmailMode() === "naast";
  const dnsFix = auto ? { action: "dns:publish", label: "DNS-records bijwerken" } : undefined;
  const expected = expectedRecords(cluster ?? { ips4: [], ips6: [] });
  const manualFor = (sub: string, type: string) => expected.filter((r) => r.sub === sub && r.type === type).flatMap((r) => r.values.map((v) => ({ name: fqdn(sub), type, value: v })));

  if (!d) {
    checks.push({ id: "domain", group: "Domein", title: "Eigen domein", status: "fail", detail: "Er is nog geen e-mailadres met een eigen domein ingesteld (Instellingen → Mail)." });
  } else {
    // MX
    const mx = await net.resolver.resolveMx(d).catch(() => []);
    const mxOk = mx.some((m) => m.exchange.replace(/\.$/, "").toLowerCase() === `mail.${d}`);
    if (trial) {
      checks.push({ id: "dns.mx", group: "Domein", title: "Mail komt bij jou binnen (MX)", status: mxOk ? "warn" : "ok",
        detail: mxOk
          ? `MX wijst al naar mail.${d}, maar de Gmail-koppeling staat nog op 'naast Gmail'. Ben je overgestapt? Zet de koppeling dan op 'Gmail als vangnet'.`
          : "Je mail komt nog bij Google binnen en wordt opgehaald (proefperiode)" });
    } else {
      checks.push({ id: "dns.mx", group: "Domein", title: "Mail komt bij jou binnen (MX)", status: mxOk ? "ok" : "fail",
        detail: mxOk ? `MX wijst naar mail.${d}` : mx.length ? `MX wijst naar ${mx.map((m) => m.exchange).join(", ")}` : "Geen MX-record gevonden",
        fix: mxOk ? undefined : dnsFix, manual: mxOk || auto ? undefined : manualFor("", "MX") });
    }

    // A-records
    for (const sub of ["cloud", "mail"]) {
      const have = await net.resolver.resolve4(`${sub}.${d}`).catch(() => [] as string[]);
      const want = cluster?.ips4 ?? [];
      const ok = have.length > 0 && want.every((ip) => have.includes(ip)) && have.every((ip) => !want.length || want.includes(ip));
      checks.push({ id: `dns.a.${sub}`, group: "Domein", title: `${sub}.${d} wijst naar je servers`, status: ok ? "ok" : have.length ? "warn" : "fail",
        detail: have.length ? `Nu: ${have.join(", ")}${want.length && !ok ? ` — verwacht: ${want.join(", ")}` : ""}` : "Bestaat nog niet",
        fix: ok ? undefined : dnsFix, manual: ok || auto ? undefined : manualFor(sub, "A") });
    }

    // SPF
    const spf = (await txtOf(d)).find((v) => v.startsWith("v=spf1"));
    // Alleen goed als SPF ónze servers toestaat: expliciet a:mail.<domein>, of 'mx' terwijl de MX naar ons wijst.
    const spfOk = !!spf && (spf.includes(`a:mail.${d}`) || (/ mx( |$)/.test(spf) && mxOk));
    if (trial && !spfOk) {
      checks.push({ id: "dns.spf", group: "Mail", title: "Afzender is toegestaan (SPF)", status: "ok",
        detail: `${spf ? spf + " — " : ""}tijdens de proefperiode naast Gmail is dit nog niet nodig. Regel het voordat je overstapt.` });
    } else {
      checks.push({ id: "dns.spf", group: "Mail", title: "Afzender is toegestaan (SPF)", status: spfOk ? "ok" : "fail",
        detail: spf ? spf : "Geen SPF-record: ontvangers zien je mail sneller als spam", fix: spfOk ? undefined : dnsFix, manual: spfOk || auto ? undefined : manualFor("", "TXT") });
    }

    // DKIM
    const pub = dkimPublic();
    if (!pub) {
      checks.push({ id: "dns.dkim", group: "Mail", title: "Handtekening op je mail (DKIM)", status: "fail", detail: "Nog geen DKIM-sleutel", fix: { action: "dkim:generate", label: "Sleutel maken" } });
    } else {
      const rec = (await txtOf(`${dkimSelector()}._domainkey.${d}`)).find((v) => v.includes("v=DKIM1"));
      const ok = !!rec && rec.replace(/\s/g, "").includes(`p=${pub}`);
      checks.push({ id: "dns.dkim", group: "Mail", title: "Handtekening op je mail (DKIM)", status: ok ? "ok" : "fail",
        detail: ok ? `Sleutel '${dkimSelector()}' staat in DNS` : rec ? "DNS bevat een andere sleutel" : "Sleutel staat nog niet in DNS",
        fix: ok ? undefined : dnsFix, manual: ok || auto ? undefined : manualFor(`${dkimSelector()}._domainkey`, "TXT").map((m) => ({ ...m, value: unquote(m.value) })) });
    }

    // DMARC
    const dmarc = (await txtOf(`_dmarc.${d}`)).find((v) => v.startsWith("v=DMARC1"));
    checks.push({ id: "dns.dmarc", group: "Mail", title: "Beleid tegen vervalsing (DMARC)", status: dmarc ? "ok" : "warn",
      detail: dmarc ?? "Geen DMARC-record", fix: dmarc ? undefined : dnsFix, manual: dmarc || auto ? undefined : manualFor("_dmarc", "TXT").map((m) => ({ ...m, value: unquote(m.value) })) });

    // Reverse DNS
    if (cluster?.ips4.length) {
      const bad: string[] = [];
      for (const ip of cluster.ips4) {
        const names = await net.resolver.reverse(ip).catch(() => [] as string[]);
        if (!names.some((n) => n.replace(/\.$/, "").toLowerCase() === `mail.${d}`)) bad.push(ip);
      }
      checks.push({ id: "dns.ptr", group: "Mail", title: "Servers stellen zich goed voor (reverse DNS)", status: bad.length ? "warn" : "ok",
        detail: bad.length ? `${bad.join(", ")} heeft geen reverse DNS mail.${d}` : "Alle servers kloppen",
        fix: bad.length && cluster.ptrAutomatic ? { action: "ptr:set", label: "Instellen bij aanbieder" } : undefined });
    }

    // Certificaat
    try {
      const days = await net.tlsDaysLeft(`cloud.${d}`);
      checks.push({ id: "tls", group: "Domein", title: "Beveiligde verbinding (HTTPS)", status: days > 14 ? "ok" : "warn", detail: `Certificaat nog ${days} dagen geldig${days <= 14 ? " — wordt normaal automatisch vernieuwd" : ""}` });
    } catch (e) {
      checks.push({ id: "tls", group: "Domein", title: "Beveiligde verbinding (HTTPS)", status: "fail", detail: `cloud.${d} niet bereikbaar via HTTPS: ${(e as Error).message}` });
    }
  }

  // Uitgaande mail
  const relay = mailSettings().relay;
  checks.push({ id: "mail.relay", group: "Mail", title: "Uitgaande mail", status: relay ? "ok" : "warn",
    detail: relay ? `Via ${relay.replace(/\/\/[^@]*@/, "//")}` : "Rechtstreeks verzenden: werkt alleen als poort 25 open is, en verhuizen kost reputatie. Stel een relay in." });

  // Gmail-koppeling
  const gmail = gmailCheck();
  if (gmail) checks.push(gmail);

  // Meldingen
  const alert = getSetting("alert_email");
  checks.push({ id: "alerts", group: "Meldingen", title: "Meldingen bij problemen", status: alert ? "ok" : "warn",
    detail: alert ? `Naar ${alert}` : "Geen adres ingesteld: je hoort het niet als er iets misgaat" });

  // Schijf
  try {
    const st = fs.statfsSync(config.dataDir);
    const free = st.bavail / st.blocks;
    const gb = (st.bavail * st.bsize) / 1e9;
    checks.push({ id: "disk", group: "Servers", title: "Vrije schijfruimte", status: free < 0.1 ? "fail" : free < 0.2 ? "warn" : "ok", detail: `${gb.toFixed(1)} GB vrij (${Math.round(free * 100)}%)` });
  } catch { /* niet ondersteund */ }

  if (!cluster) {
    checks.push({ id: "backup", group: "Back-up", title: "Back-ups buiten deze server", status: "warn", detail: "Deze server draait los. Koppel opslag via de beheerconsole om automatische back-ups en de tijdmachine te krijgen." });
    return checks;
  }

  // Back-up
  const snapOk = cluster.snapshotAgeH !== null && cluster.snapshotAgeH < cluster.snapshotEveryH * 2;
  checks.push({ id: "backup.snapshot", group: "Back-up", title: "Recente volledige back-up", status: snapOk ? "ok" : "warn",
    detail: cluster.snapshotAgeH === null ? "Nog geen snapshot" : `${cluster.snapshotAgeH < 1 ? "minder dan een uur" : Math.round(cluster.snapshotAgeH) + " uur"} geleden`,
    fix: snapOk ? undefined : { action: "snapshot:run", label: "Nu maken" } });
  for (const s of cluster.stores) {
    const ok = s.lag !== null && s.lag < 200;
    checks.push({ id: `backup.store.${s.name}`, group: "Back-up", title: `Opslag ${s.name}${s.purpose === "backup" ? " (back-up)" : ""}`, status: s.lag === null ? "fail" : ok ? "ok" : "warn",
      detail: s.lag === null ? "Onbereikbaar of nog niet gecontroleerd" : s.lag === 0 ? "Helemaal bij" : `${s.lag} wijzigingen achter` });
  }
  const countries = new Set(cluster.stores.map((s) => s.country).filter(Boolean));
  const hasBackup = cluster.stores.some((s) => s.purpose === "backup");
  const spreadOk = cluster.stores.length >= 2 && countries.size >= 2 && hasBackup;
  checks.push({ id: "backup.spread", group: "Back-up", title: "Back-ups verspreid", status: spreadOk ? "ok" : "warn",
    detail: spreadOk ? `${cluster.stores.length} opslagplaatsen in ${countries.size} landen, waarvan ${cluster.stores.filter((s) => s.purpose === "backup").length} onveranderbare back-up` : "Aanbevolen: minstens 2 opslagplaatsen in 2 landen, waarvan één alleen voor back-ups" });
  const drillAge = cluster.lastDrill ? (Date.now() - cluster.lastDrill.ts) / 864e5 : null;
  const drillOk = !!cluster.lastDrill?.ok && drillAge! < cluster.drillEveryDays * 2;
  checks.push({ id: "backup.drill", group: "Back-up", title: "Herstel getest (brandoefening)", status: cluster.lastDrill && !cluster.lastDrill.ok ? "fail" : drillOk ? "ok" : "warn",
    detail: cluster.lastDrill ? `${cluster.lastDrill.ok ? "Geslaagd" : "Mislukt"} — ${Math.round(drillAge! * 24) < 24 ? "vandaag" : Math.round(drillAge!) + " dagen geleden"}` : "Nog nooit getest",
    fix: drillOk ? undefined : { action: "drill:run", label: "Nu testen" } });

  // Servers
  const nodesOk = cluster.dataReady >= cluster.wantData && cluster.witnessReady >= cluster.wantWitness && !cluster.unreachable.length;
  checks.push({ id: "cluster.nodes", group: "Servers", title: "Genoeg servers actief", status: nodesOk ? "ok" : cluster.dataReady >= 1 ? "warn" : "fail",
    detail: `${cluster.dataReady}/${cluster.wantData} data, ${cluster.witnessReady}/${cluster.wantWitness} witness${cluster.unreachable.length ? ` — onbereikbaar: ${cluster.unreachable.join(", ")}` : ""}${!nodesOk && cluster.autoHeal ? " · wordt automatisch hersteld" : ""}` });
  return checks;
}

/** "Gmail-koppeling": in orde als de laatste ronde in het afgelopen kwartier slaagde. */
export function gmailCheck(now = Date.now()): Check | null {
  const mode = gmailMode();
  if (mode === "uit") return null;
  let st: { lastRun?: number; lastOk?: number; error?: string | null } = {};
  try { st = JSON.parse(getSetting("gmail_status") ?? "{}"); } catch { /* leeg */ }
  const base = { id: "gmail", group: "Mail" as const, title: "Gmail-koppeling" };
  const what = mode === "naast" ? "Mail uit Gmail wordt opgehaald" : "Nieuwe mail wordt naar Gmail gekopieerd";
  if (!st.lastRun) return { ...base, status: "warn", detail: "Nog niet gestart. Dat gebeurt binnen een minuut na het opslaan." };
  const ago = st.lastOk ? now - st.lastOk : Infinity;
  const time = st.lastOk ? new Date(st.lastOk).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" }) : null;
  if (ago < 15 * 60_000 && !st.error) return { ...base, status: "ok", detail: `${what} · laatst gelukt om ${time}` };
  const err = st.error ? ` — ${st.error}` : "";
  return { ...base, status: ago < 60 * 60_000 ? "warn" : "fail",
    detail: st.lastOk ? `Laatst gelukt om ${time}${err}` : `Nog niet gelukt${err}` };
}

// ───────── Overzicht, automatisch herstel en meldingen ─────────

export function summarize(checks: Check[]) {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  return { fail, warn, ok: checks.filter((c) => c.status === "ok").length, level: fail ? "fail" : warn ? "warn" : "ok" };
}

export function isMailNoticeDue(prev: Record<string, Status>, now: Check[]) {
  const worse = now.filter((c) => (c.status === "fail" || c.status === "warn") && prev[c.id] !== c.status && prev[c.id] !== "fail");
  const fixed = now.filter((c) => c.status === "ok" && (prev[c.id] === "fail" || prev[c.id] === "warn"));
  return { worse, fixed };
}

export function noticeText(worse: Check[], fixed: Check[], url: string | null) {
  const lines = [
    worse.length ? `${worse.length} ${worse.length === 1 ? "ding vraagt" : "dingen vragen"} aandacht:\n` : "",
    ...worse.map((c) => `  ${c.status === "fail" ? "✕" : "!"} ${c.title}\n    ${c.detail}`),
    fixed.length ? `\nWeer in orde:\n` : "",
    ...fixed.map((c) => `  ✓ ${c.title}`),
    url ? `\nBekijk en repareer: ${url}/#instellingen` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Laatste uitkomst bewaren (gerepliceerd), zodat elke node hem kan tonen en we veranderingen zien. */
export function rememberHealth(checks: Check[]) {
  setSetting("health_last", JSON.stringify(Object.fromEntries(checks.map((c) => [c.id, c.status]))));
  setSetting("health_checked_at", String(Date.now()));
}
export function previousHealth(): Record<string, Status> {
  try { return JSON.parse(getSetting("health_last") ?? "{}"); } catch { return {}; }
}

