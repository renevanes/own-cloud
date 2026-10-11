/**
 * Beheerconsole: draait op je eigen computer (of een Raspberry Pi thuis) en regelt alles wat buiten
 * het cluster ligt — installatie, sleutelbeheer, wekken en herstellen. Start met: npm run beheer
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dnsp from "node:dns/promises";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import nodemailer from "nodemailer";
import { request } from "undici";
import { Vault, type AdminConfig } from "./vault.js";
import { STORE_OFFERS, SERVER_OFFERS, fetchSizes, pickSize, buildPresets, type SizeOption, type ServerOffer, type StoreOffer } from "./catalog.js";
import { DEFAULT_POLICY, keysFor, type Placement } from "../cluster/config.js";
import { randomKeyHex } from "../cluster/crypto.js";
import { hashPassword } from "../auth.js";
import { makeProvider } from "../cluster/providers.js";
import { makeStore, S3Store, type StoreConfig } from "../cluster/stores.js";
import { restoreFromAny, restoreFromStore } from "../cluster/backup.js";
import { rpc } from "../cluster/transport.js";
import * as extras from "./extras.js";
import * as aanbieder from "./aanbieder.js";
import { findAdminConfig } from "../cluster/admin.js";
import { consoleSettings } from "../cluster/admin.js";
import { clusterStatus, findLeader, prepareStore, probeCluster, provisionFirstNode, readManifest, recoverAdminConfig, saveAdminCopy, sendJob, adminProof, pushAdminConfig } from "../cluster/admin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.EIGEN_CONSOLE_LOCAL === "1";
const vault = new Vault(process.env.EIGEN_VAULT ?? path.join(os.homedir(), ".eigen-cloud", "kluis.json"));

const serverOffers = (): ServerOffer[] => LOCAL
  ? [...SERVER_OFFERS, { id: "local", name: "Lokaal (test)", owner: "Deze computer", home: "NL", regions: [
      { id: "ams", label: "Amsterdam (test)", country: "NL", city: "Amsterdam" },
      { id: "fra", label: "Frankfurt (test)", country: "DE", city: "Frankfurt" },
      { id: "hel", label: "Helsinki (test)", country: "FI", city: "Helsinki" }], fields: [], signupUrl: "" }]
  : SERVER_OFFERS;
// Alleen voor tests: alle S3-opslag naar één nepserver (EIGEN_TEST_S3).
const TEST_S3 = process.env.EIGEN_TEST_S3;
const BASE_STORES = TEST_S3 ? STORE_OFFERS.map((o) => ({ ...o, regions: o.regions.map((r) => ({ ...r, endpoint: r.endpoint ? TEST_S3 : r.endpoint })) })) : STORE_OFFERS;
const storeOffers = (): StoreOffer[] => LOCAL
  ? [...BASE_STORES, { id: "localfs", name: "Map op deze computer (test)", owner: "Jijzelf", regions: [{ id: "nl", label: "Lokaal", country: "NL", endpoint: "" }], help: "", signupUrl: "" }]
  : BASE_STORES;

// ───────── Sessie ─────────

let session: { token: string; lastUse: number } | null = null;
/** Inloggen bij de dienst vóórdat er een kluis is (herstellen op een nieuw apparaat). Alleen in het geheugen. */
let recoverDienst: { email: string; token?: string; base?: string } | null = null;
const IDLE_MS = 30 * 60_000;
let knownAanbieders = 0;
const brandCache = new Map<string, { at: number; v: Awaited<ReturnType<typeof extras.dienstBrand>> }>();
async function brandCached(base: string) {
  const hit = brandCache.get(base);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;
  const v = await extras.dienstBrand(base);
  brandCache.set(base, { at: Date.now(), v });
  return v;
}

function newSession(reply: FastifyReply) {
  session = { token: crypto.randomBytes(24).toString("hex"), lastUse: Date.now() };
  reply.setCookie("beheer", session.token, { httpOnly: true, sameSite: "strict", path: "/" });
}

function hasSession(req: FastifyRequest) {
  if (session && Date.now() - session.lastUse > IDLE_MS) { vault.lock(); session = null; }
  const t = req.cookies.beheer;
  return !!(vault.unlocked() && session && t && t.length === session.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(session.token)));
}

async function requireUnlocked(req: FastifyRequest, reply: FastifyReply) {
  if (!hasSession(req)) return reply.code(401).send({ error: "De kluis is op slot" });
  session!.lastUse = Date.now();
}

const cfg = () => vault.config!;
/** Opslaan in de kluis; na de start ook naar de opslag (herstelkopie) en het draaiende cluster. */
const save = () => {
  vault.save();
  const c = vault.config!;
  if (c.console.done) {
    void saveAdminCopy(c).catch(() => {});
    void pushAdminConfig(c, extras.DIENST_URL()).catch(() => {});
  }
};

// ───────── Hulpjes ─────────

const mask = (v?: string) => (v ? "•".repeat(8) + v.slice(-4) : "");

function sanitized(c: AdminConfig) {
  return {
    cluster: c.cluster, domain: c.domain, mailFrom: c.appEnv.MAIL_FROM, alertEmail: c.console.alertEmail ?? "",
    stores: c.stores.map((s) => ({ ...s, accessKey: s.accessKey ? mask(s.accessKey) : undefined, secretKey: s.secretKey ? "••••••••" : undefined })),
    providers: Object.fromEntries(Object.entries(c.providers).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, /token|secret|password/i.test(f) ? mask(x) : x]))])),
    dns: c.dns.map((d) => ({ ...d, token: d.token ? mask(d.token) : undefined })),
    dnsMode: c.console.dnsMode ?? null,
    mailRelay: c.console.mailRelay ? (() => { try { const u = new URL(c.console.mailRelay!); return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), secure: u.protocol === "smtps:" }; } catch { return null; } })() : null,
    spfExtra: c.console.spfExtra ?? "",
    policy: c.policy, preset: c.console.preset ?? null,
    domainMode: c.console.domainMode ?? "own",
    desec: c.console.desec ? { email: c.console.desec.email, at: c.console.desec.at } : null,
    quick: c.console.quick ?? null,
    dienst: c.console.dienst ? { url: c.console.dienst.url ?? null, invite: c.console.dienst.invite ?? null, email: c.console.dienst.email ?? null, loggedIn: !!c.console.dienst.token, orderId: c.console.dienst.orderId ?? null, bundle: c.console.dienst.bundle ?? null, applied: !!c.console.dienst.applied } : null,
    maxUsers: c.console.maxUsers ?? 0,
  };
}

interface Step { id: string; label: string; state: "wait" | "busy" | "done" | "fail"; detail?: string }
let launch: { steps: Step[]; appUrl: string | null; done: boolean; startedAt: number } | null = null;

function setStep(id: string, state: Step["state"], detail?: string) {
  const s = launch?.steps.find((x) => x.id === id);
  if (s) { s.state = state; if (detail !== undefined) s.detail = detail; }
}

async function followLaunch(clusterUrl: string, apiUrl: string | null, wantNodes: number) {
  const c = cfg();
  const keys = keysFor(c);
  const deadline = Date.now() + 45 * 60_000;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  setStep("boot", "busy", "Software installeren en starten (meestal 2 à 4 minuten)");
  while (Date.now() < deadline) {
    const r = await request(`${clusterUrl}/cluster/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (r) { await r.body.dump(); if (r.statusCode === 200) break; }
    await wait(3000);
  }
  setStep("boot", "done", "");
  setStep("start", "busy", "Back-up terugzetten en de leiding nemen");
  let leaderSince = 0;
  while (Date.now() < deadline) {
    const st = await rpc<any>(keys.cluster, clusterUrl, { type: "status" }, 3000).catch(() => null);
    if (st?.role === "leader") { leaderSince = Date.now(); break; }
    await wait(2000);
  }
  setStep("start", "done", "");
  setStep("grow", "busy", "Tweede server en witness worden aangemaakt");
  while (Date.now() < deadline) {
    const leader = await findLeader(c, [clusterUrl]);
    const sum = leader ? await rpc<any>(keys.cluster, leader.url, { type: "clusterSummary" }, 5000).catch(() => null) : null;
    const ready = (sum?.nodes ?? []).filter((n: { status: string }) => n.status === "ready").length;
    if (sum) setStep("grow", "busy", `${ready} van ${wantNodes} servers klaar`);
    if (ready >= wantNodes) break;
    await wait(3000);
  }
  setStep("grow", "done", `${wantNodes} servers actief`);
  setStep("https", "busy", c.domain ? `Wachten tot cloud.${c.domain} bereikbaar is (DNS en certificaat)` : "");
  const url = launch!.appUrl ?? apiUrl;
  while (Date.now() < deadline && url) {
    const r = await request(`${url}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (r) { await r.body.dump(); if (r.statusCode === 200) break; }
    await wait(5000);
  }
  setStep("https", "done", "");
  launch!.done = true;
  void leaderSince;
}

function adminPolicy(placement: Placement[]) {
  return { ...DEFAULT_POLICY, placement };
}

// ───────── Gedeelde stappen (ook gebruikt door de dienst-koppeling) ─────────

type StoreInput = { offer: string; region: string; endpoint?: string; accessKey?: string; secretKey?: string; bucket?: string; purpose: "replica" | "backup"; dir?: string };

/** Opslag koppelen: bucket aanmaken en instellen (versiebeheer, onveranderbaar), en bij succes bewaren. */
async function addStore(b: StoreInput) {
  const offer = storeOffers().find((o) => o.id === b.offer);
  const region = offer?.regions.find((r) => r.id === b.region);
  if (!offer || !region) throw new Error("Kies een aanbieder en locatie");
  const name = `${offer.id}-${region.id}${b.purpose === "backup" ? "-backup" : ""}`;
  const existing = cfg().stores.find((x) => x.name === name);
  let store: StoreConfig;
  if (offer.id === "localfs") {
    store = { name, type: "fs", purpose: b.purpose, country: region.country, dir: b.dir || path.join(path.dirname(vault.file), "opslag", name) };
  } else {
    const endpoint = offer.customEndpoint ? b.endpoint : region.endpoint;
    if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error("Vul de endpoint-URL in (begint met https://)");
    store = {
      name, type: "s3", purpose: b.purpose, country: region.country, endpoint, region: region.id === "eigen" ? "us-east-1" : region.id,
      // Zelfde plek opnieuw koppelen (bijv. de assistent nog eens doorlopen): dezelfde bucket houden.
      bucket: b.bucket || (existing?.endpoint === endpoint ? existing?.bucket : undefined) || `${cfg().cluster}-${b.purpose === "backup" ? "backup" : "data"}-${crypto.randomBytes(3).toString("hex")}`,
      accessKey: b.accessKey || existing?.accessKey, secretKey: b.secretKey || existing?.secretKey,
    };
    if (!store.accessKey || !store.secretKey) throw new Error("Vul de toegangssleutel en geheime sleutel in");
  }
  const steps = await prepareStore(store);
  const ok = steps.every((x) => x.ok || /Versiebeheer|Onveranderbaar/.test(x.label));
  if (ok) {
    cfg().stores = [...cfg().stores.filter((x) => x.name !== name), store];
    save();
  }
  return { ok, steps, name };
}

/** Aanbieder van servers koppelen: inloggen controleren en de live formaten en prijzen per regio ophalen. */
async function linkProvider(id: string, fieldsIn: Record<string, string>) {
  const offer = serverOffers().find((o) => o.id === id);
  if (!offer) throw new Error("Onbekende aanbieder");
  const fields = { ...(cfg().providers[offer.id] ?? {}) };
  for (const [k, v] of Object.entries(fieldsIn)) if (v && !v.startsWith("••")) fields[k] = v.trim();
  if (offer.id === "local" && !fields.baseDir) fields.baseDir = path.join(path.dirname(vault.file), "servers");
  try {
    await makeProvider(offer.id, fields).list(cfg().cluster);
  } catch (e) {
    throw new Error(`Inloggen bij ${offer.name} lukt niet: ${(e as Error).message.replace(/https?:\/\/\S+/, "").slice(0, 160)}`);
  }
  const regions: { region: string; data?: SizeOption; witness?: SizeOption; error?: string }[] = [];
  await Promise.all(offer.regions.map(async (r) => {
    try {
      const sizes = await fetchSizes(offer.id, fields, r.id);
      regions.push({ region: r.id, data: pickSize(sizes, "data"), witness: pickSize(sizes, "witness") });
    } catch (e) {
      regions.push({ region: r.id, error: (e as Error).message });
    }
  }));
  regions.sort((a, b) => offer.regions.findIndex((r) => r.id === a.region) - offer.regions.findIndex((r) => r.id === b.region));
  cfg().providers[offer.id] = fields;
  const cat = (cfg().console.catalog ??= {});
  cat[offer.id] = Object.fromEntries(regions.filter((r) => r.data).map((r) => [r.region, { data: r.data, witness: r.witness }]));
  save();
  return { ok: true, regions };
}

/** Verspreiding kiezen; extra plekken als reserve voor zelfherstel (lagere voorkeur). */
function choosePreset(id: string) {
  const cat = cfg().console.catalog ?? {};
  const available = serverOffers().flatMap((o) => o.regions.filter((r) => cat[o.id]?.[r.id]).map((r) => ({ provider: o.id, region: r, ...cat[o.id][r.id] })));
  const p = buildPresets(available).find((x) => x.id === id);
  if (!p || !p.placement.length) throw new Error(p?.missing ?? "Onbekende keuze");
  const reserve: Placement[] = available.flatMap((a) => [
    ...(a.data ? [{ provider: a.provider, region: a.region.id, size: a.data.size, country: a.region.country, kind: "data" as const }] : []),
    ...(a.witness ? [{ provider: a.provider, region: a.region.id, size: a.witness.size, country: a.region.country, kind: "witness" as const }] : []),
  ]).filter((r) => id !== "nl" || r.country === "NL");
  const seen = new Set<string>();
  cfg().policy = { ...cfg().policy, placement: [...p.placement, ...reserve].filter((x) => { const k = `${x.kind}/${x.provider}/${x.region}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
  cfg().console.preset = p.id;
  save();
  return p;
}

/** DNS koppelen bij deSEC of Hetzner (of handmatig). */
async function configureDns(c: AdminConfig, mode: "desec" | "hetzner" | "manual", tokenIn?: string) {
  const d = c.domain!;
  if (mode === "manual") {
    c.dns = [];
    c.console.dnsMode = "manual";
    save();
    return { ok: true, ns: null, delegated: null };
  }
  const token = tokenIn && !tokenIn.startsWith("••") ? tokenIn.trim() : c.dns.find((x) => x.type === mode)?.token;
  if (!token) throw new Error("Vul je API-token in");
  let ns: string[] = [];
  if (mode === "desec") {
    const base = extras.DESEC_URL();
    const h = { authorization: `Token ${token}`, "content-type": "application/json" };
    const r = await fetch(`${base}/domains/${d}/`, { headers: h });
    if (r.status === 401 || r.status === 403) throw new Error("deSEC accepteert dit token niet");
    if (r.status === 404) {
      if (d.endsWith(".dedyn.io")) throw new Error(`${d} bestaat (nog) niet bij deSEC. Maak het account opnieuw aan met een andere naam.`);
      const cr = await fetch(`${base}/domains/`, { method: "POST", headers: h, body: JSON.stringify({ name: d }) });
      if (!cr.ok) throw new Error(`Domein toevoegen bij deSEC mislukt: ${(await cr.text()).slice(0, 200)}`);
    }
    ns = ["ns1.desec.io", "ns2.desec.org"];
  } else {
    const r = await fetch(`https://api.hetzner.cloud/v1/zones?name=${d}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("Hetzner accepteert dit token niet (of DNS staat nog in de oude DNS-console)");
    const j = (await r.json()) as { zones?: { authoritative_nameservers?: { assigned?: string[] } }[] };
    if (!j.zones?.length) throw new Error(`Maak eerst de zone ${d} aan in de Hetzner Console → DNS`);
    ns = j.zones[0].authoritative_nameservers?.assigned ?? ["hydrogen.ns.hetzner.com", "oxygen.ns.hetzner.com", "helium.ns.hetzner.de"];
  }
  c.dns = [{ type: mode, name: mode, token, zone: d }];
  c.console.dnsMode = mode;
  c.console.nameservers = ns;
  save();
  // dedyn.io-namen staan meteen goed: deSEC beheert dedyn.io zelf.
  return { ok: true, ns, delegated: d.endsWith(".dedyn.io") ? true : await delegated(d, ns) };
}

/** "vanes.nl" (eigen of te kopen domein) of "rene" → "rene.dedyn.io" (gratis). */
function normalizeDomain(input: string | undefined, mode: string) {
  let d = (input ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (mode === "free") {
    d = d.replace(/\.dedyn\.io$/, "");
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) throw new Error("Kies een naam met letters, cijfers en streepjes, zoals vanes");
    return `${d}.dedyn.io`;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(mode === "sub" ? "Kies eerst een vrije naam" : "Vul een domeinnaam in, zoals vanes.nl");
  return d;
}

// ───────── Server ─────────

export async function buildConsole() {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web-console"), prefix: "/" });
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web/shared"), prefix: "/shared/", decorateReply: false });
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web/fonts"), prefix: "/fonts/", decorateReply: false });
  app.setErrorHandler((err, _req, reply) => reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message }));

  app.get("/api/state", async (req) => ({
    vault: vault.exists(),
    unlocked: hasSession(req),
    step: vault.config?.console.step ?? null,
    done: vault.config?.console.done ?? false,
    domain: vault.config?.domain ?? null,
    offers: { stores: storeOffers(), servers: serverOffers() },
    dienst: !!(extras.DIENST_URL() || vault.config?.console.dienst?.url || knownAanbieders > 0),
    aanbieder: vault.config?.console.dienst?.url ?? null,
    domainMode: vault.config?.console.domainMode ?? null,
    scaleway: { signup: extras.SCW_SIGNUP_URL, keys: extras.SCW_KEYS_URL },
  }));

  // Openbaar (ook vóór de kluis): de dienst en domeinbeschikbaarheid tonen in de eerste stap.
  const currentBase = () => extras.baseOf(vault.config);
  app.get("/api/dienst/info", async (_req, reply) => {
    try { return await extras.dienstInfo(currentBase()); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });
  app.get<{ Querystring: { name?: string } }>("/api/dienst/check", async (req, reply) => {
    try { return await extras.dienstCheck(req.query.name ?? "", currentBase()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Aanbieders: de openbare lijst, hun huisstijl en uitnodigingscodes.
  app.get("/api/aanbieders", async () => {
    const list = await extras.aanbieders();
    knownAanbieders = list.length;
    return { aanbieders: list, gekozen: vault.config?.console.dienst?.url ?? null };
  });
  app.get<{ Querystring: { url?: string } }>("/api/aanbieder/brand", async (req, reply) => {
    try { return await brandCached(extras.cleanDienstUrl(req.query.url ?? "")); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.get<{ Querystring: { url?: string; code?: string } }>("/api/aanbieder/invite", async (req, reply) => {
    try { return await extras.dienstInvite(extras.cleanDienstUrl(req.query.url ?? ""), req.query.code ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Body: { passphrase: string; domain: string; domainMode?: "own" | "free" | "buy" | "sub"; mailbox: string; alertEmail?: string; appPassword: string } }>("/api/setup/create", async (req, reply) => {
    if (vault.exists()) return reply.code(409).send({ error: "Er is al een kluis. Ontgrendel hem." });
    const b = req.body;
    const mode = b.domainMode ?? "own";
    let domain: string;
    try { domain = normalizeDomain(b.domain, mode); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    if (!/^[a-z0-9._+-]+$/i.test(b.mailbox ?? "")) return reply.code(400).send({ error: "Vul het deel vóór de @ in, zoals rene" });
    if ((b.appPassword ?? "").length < 10) return reply.code(400).send({ error: "Kies een inlogwachtwoord van minstens 10 tekens" });
    if (b.alertEmail && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(b.alertEmail)) return reply.code(400).send({ error: "Het meldadres is geen geldig e-mailadres" });
    if (b.alertEmail?.endsWith("@" + domain)) return reply.code(400).send({ error: "Kies voor meldingen een adres buiten je eigen domein, zodat een melding je ook bereikt als je mail stuk is" });
    if (mode === "free" && !b.alertEmail) return reply.code(400).send({ error: "Vul een meldadres in; daarmee maakt de console je gratis deSEC-account aan" });
    const cfg: AdminConfig = {
      cluster: domain.split(".")[0].replace(/[^a-z0-9-]/g, "").slice(0, 20) || "eigen",
      nodeId: "beheer", kind: "data", masterKey: randomKeyHex(), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], domain,
      stores: [], providers: {}, dns: [],
      image: { ref: "ghcr.io/renevanes/eigen-cloud:latest", caddyRef: "ghcr.io/renevanes/eigen-caddy:latest" } as AdminConfig["image"],
      appEnv: { MAIL_DOMAINS: domain, MAIL_FROM: `${b.mailbox}@${domain}`, HOSTNAME_FQDN: `mail.${domain}`, NODE_ENV: "production" },
      policy: adminPolicy([]),
      console: { step: "sleutel", done: false, keyConfirmed: false, appPasswordHash: hashPassword(b.appPassword), alertEmail: b.alertEmail ?? "", domainMode: mode },
    };
    try { vault.create(b.passphrase ?? "", cfg); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    newSession(reply);
    return { ok: true };
  });

  app.post<{ Body: { passphrase: string; masterKey: string; store: StoreConfig } }>("/api/setup/recover", async (req, reply) => {
    if (vault.exists()) return reply.code(409).send({ error: "Er is al een kluis op deze computer" });
    const key = (req.body.masterKey ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (key.length !== 64) return reply.code(400).send({ error: "De sleutel bestaat uit 64 tekens (0–9 en a–f)" });
    try {
      // Bucketnaam vergeten? Dan zoeken we hem op met de sleutel van de opslag.
      const { config: recovered } = await findAdminConfig(key, req.body.store);
      const cfg = { ...recovered, console: { ...(recovered as AdminConfig).console, step: "klaar", done: true, keyConfirmed: true } } as AdminConfig;
      vault.create(req.body.passphrase ?? "", cfg);
      newSession(reply);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Herstellen via de Eigen Cloud Dienst: inloggen met een code; opslag en sleutels komen uit je pakket.
  app.post<{ Body: { email: string; url?: string } }>("/api/recover/dienst/login", async (req, reply) => {
    try {
      const base = req.body?.url ? extras.cleanDienstUrl(req.body.url) : extras.DIENST_URL();
      recoverDienst = { email: await extras.dienstStartLogin(req.body?.email, base), base };
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post<{ Body: { code: string } }>("/api/recover/dienst/verify", async (req, reply) => {
    if (!recoverDienst) return reply.code(400).send({ error: "Vul eerst je e-mailadres in" });
    try { recoverDienst.token = await extras.dienstFinishLogin(recoverDienst.email, req.body?.code, recoverDienst.base); return { ok: true }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post<{ Body: { masterKey: string; passphrase: string } }>("/api/setup/recover-dienst", async (req, reply) => {
    if (vault.exists()) return reply.code(409).send({ error: "Er is al een kluis op deze computer" });
    if (!recoverDienst?.token) return reply.code(400).send({ error: "Log eerst in bij de dienst" });
    const key = (req.body.masterKey ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (key.length !== 64) return reply.code(400).send({ error: "De sleutel bestaat uit 64 tekens (0–9 en a–f)" });
    try {
      const { order, kit } = await extras.dienstOrderKit(recoverDienst.token, recoverDienst.base);
      let found: Awaited<ReturnType<typeof findAdminConfig>> | null = null, lastErr: Error | null = null;
      for (const st of [...kit.storage].sort((a, b) => (a.purpose === "replica" ? -1 : 1) - (b.purpose === "replica" ? -1 : 1))) {
        const offer = storeOffers().find((o) => o.id === st.offer);
        const region = offer?.regions.find((r) => r.id === st.region);
        if (!region) continue;
        try {
          found = await findAdminConfig(key, { name: `${st.offer}-${st.region}`, type: "s3", purpose: st.purpose, country: region.country, endpoint: region.endpoint, region: st.region, accessKey: st.accessKey, secretKey: st.secretKey });
          break;
        } catch (e) { lastErr = e as Error; }
      }
      if (!found) throw lastErr ?? new Error("Geen opslag gevonden in je pakket");
      const rec = found.config as AdminConfig;
      const cfg = { ...rec, console: { ...rec.console, step: "klaar", done: true, keyConfirmed: true, dienst: { ...(recoverDienst.base && recoverDienst.base !== extras.DIENST_URL() ? { url: recoverDienst.base } : {}), email: recoverDienst.email, token: recoverDienst.token, orderId: order.id, bundle: order.bundle, applied: true }, maxUsers: kit.users ?? rec.console.maxUsers } } as AdminConfig;
      vault.create(req.body.passphrase ?? "", cfg);
      recoverDienst = null;
      newSession(reply);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Wachtwoordzin vergeten: de kluis van dit toestel wissen (je cloud blijft draaien; herstellen kan met de herstelsleutel).
  app.post<{ Body: { confirm?: boolean } }>("/api/vault/forget", async (req, reply) => {
    if (req.body?.confirm !== true) return reply.code(400).send({ error: "Bevestig dat je de kluis wilt wissen" });
    vault.destroy();
    session = null;
    return { ok: true };
  });

  app.post<{ Body: { passphrase: string } }>("/api/unlock", async (req, reply) => {
    try { vault.unlock(req.body?.passphrase ?? ""); } catch (e) { await new Promise((r) => setTimeout(r, 800)); return reply.code(401).send({ error: (e as Error).message }); }
    newSession(reply);
    return { ok: true };
  });

  app.register(async (s) => {
    s.addHook("preHandler", requireUnlocked);

    s.post("/api/lock", async () => { vault.lock(); session = null; return { ok: true }; });
    s.get("/api/config", async () => sanitized(cfg()));
    s.post<{ Body: { step: string } }>("/api/step", async (req) => { cfg().console.step = req.body.step; save(); return { ok: true }; });

    // ── Sleutel ──
    s.get("/api/key", async () => ({ groups: cfg().masterKey!.match(/.{8}/g), check: crypto.createHash("sha256").update(cfg().masterKey!).digest("hex").slice(0, 6), confirmed: cfg().console.keyConfirmed }));
    s.post<{ Body: { g3: string; g7: string } }>("/api/key/confirm", async (req, reply) => {
      const g = cfg().masterKey!.match(/.{8}/g)!;
      const norm = (x: string) => (x ?? "").replace(/\s/g, "").toLowerCase();
      if (norm(req.body.g3) !== g[2] || norm(req.body.g7) !== g[6]) return reply.code(400).send({ error: "Dat klopt niet met je sleutel. Kijk nog eens naar groep 3 en 7." });
      cfg().console.keyConfirmed = true;
      save();
      return { ok: true };
    });
    s.get("/api/recovery-sheet", async (_req, reply) => {
      const c = cfg();
      const g = c.masterKey!.match(/.{8}/g)!;
      const check = crypto.createHash("sha256").update(c.masterKey!).digest("hex").slice(0, 6);
      reply.header("content-type", "text/html; charset=utf-8");
      return recoverySheet(c, g, check);
    });

    // ── Opslag ──
    s.post<{ Body: StoreInput }>("/api/stores", async (req, reply) => {
      try { return await addStore(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.delete<{ Params: { name: string } }>("/api/stores/:name", async (req) => {
      cfg().stores = cfg().stores.filter((x) => x.name !== req.params.name);
      save();
      return { ok: true };
    });

    // ── Servers ──
    s.post<{ Body: { id: string; fields: Record<string, string> } }>("/api/providers", async (req, reply) => {
      try { return await linkProvider(req.body.id, req.body.fields ?? {}); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
      delete cfg().providers[req.params.id];
      delete cfg().console.catalog?.[req.params.id];
      save();
      return { ok: true };
    });

    s.get("/api/presets", async () => {
      const cat = cfg().console.catalog ?? {};
      const available = serverOffers().flatMap((o) => o.regions.filter((r) => cat[o.id]?.[r.id]).map((r) => ({ provider: o.id, region: r, ...cat[o.id][r.id] })));
      return { presets: buildPresets(available), chosen: cfg().console.preset ?? null };
    });
    s.post<{ Body: { id: string } }>("/api/presets/choose", async (req, reply) => {
      try { return { ok: true, preset: choosePreset(req.body.id) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Eén sleutel bij Scaleway: de console regelt opslag, servers en mail ──
    s.post<{ Body: { accessKey?: string; secretKey?: string; projectId?: string } }>("/api/quick/scaleway", async (req, reply) => {
      const c = cfg();
      const steps: { label: string; ok: boolean; detail?: string }[] = [];
      try {
        const { accessKey, secretKey } = extras.scwKeys(req.body ?? {});
        const projectId = await extras.scwProject(accessKey, secretKey, req.body?.projectId);
        steps.push({ label: "Sleutel werkt", ok: true });
        const linked = await linkProvider("scaleway", { secretKey, projectId });
        const priced = linked.regions.filter((r) => r.data);
        if (!priced.length) throw new Error(`Scaleway gaf geen serverprijzen: ${linked.regions.map((r) => r.error).filter(Boolean)[0] ?? "onbekend"}`);
        steps.push({ label: "Servers en prijzen opgehaald", ok: true });
        for (const [region, purpose, label] of [["nl-ams", "replica", "Opslag in Amsterdam"], ["fr-par", "backup", "Back-up in Parijs, 30 dagen niet te wissen"]] as const) {
          const r = await addStore({ offer: "scaleway", region, accessKey, secretKey, purpose });
          if (!r.ok) throw new Error(`${label}: ${r.steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
          steps.push({ label, ok: true });
        }
        const preset = choosePreset("nl");
        steps.push({ label: `Servers: ${preset.title}`, ok: true, detail: preset.monthly != null ? `ongeveer € ${preset.monthly.toFixed(2).replace(".", ",")} per maand bij Scaleway, plus een paar euro voor opslag` : undefined });
        try {
          const m = await extras.scwMail(c, secretKey, projectId);
          steps.push({ label: "Mail versturen via Scaleway", ok: true, detail: m.detail });
        } catch (e) {
          steps.push({ label: "Mail versturen via Scaleway", ok: false, detail: `${(e as Error).message}. Je kunt dit later bij Mail regelen; je cloud werkt ook zonder.` });
        }
        c.console.quick = "scaleway";
        c.console.preset = preset.id;
        save();
        return { ok: true, steps, monthly: preset.monthly };
      } catch (e) {
        save();
        return reply.code(400).send({ error: (e as Error).message, steps });
      }
    });
    /** Terug naar "zelf per onderdeel": de één-sleutel-markering eraf (gekoppelde dingen blijven staan). */
    s.post("/api/quick/off", async () => { delete cfg().console.quick; save(); return { ok: true }; });

    // ── Opnieuw beginnen (alleen vóór de start) ──
    s.post<{ Body: { cleanup?: boolean } }>("/api/setup/reset", async (req, reply) => {
      const c = cfg();
      if (c.console.done || c.console.firstLaunch) return reply.code(409).send({ error: "Je cloud is al gestart. Opnieuw beginnen kan dan niet meer vanuit de assistent." });
      const done: string[] = [], left: string[] = [];
      if (req.body?.cleanup) {
        for (const st of c.stores) {
          if (st.type !== "s3") continue;
          const why = await (makeStore(st) as S3Store).destroyBucket().catch((e: Error) => e.message);
          if (why) left.push(`${st.bucket}: ${why}`); else done.push(`Bucket ${st.bucket} verwijderd`);
        }
        try { const r = await extras.scwRevokeMail(c); if (r) done.push(r); } catch (e) { left.push(`Maildomein: ${(e as Error).message}`); }
      }
      vault.destroy();
      session = null;
      return { ok: true, done, left };
    });

    // ── DNS ──
    s.post<{ Body: { mode: "desec" | "hetzner" | "manual"; token?: string } }>("/api/dns", async (req, reply) => {
      try { return await configureDns(cfg(), req.body.mode, req.body.token); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get("/api/dns/check", async () => {
      const c = cfg();
      return { ns: c.console.nameservers ?? null, delegated: c.console.nameservers ? await delegated(c.domain!, c.console.nameservers) : null, current: await dnsp.resolveNs(c.domain!).catch(() => []) };
    });

    // ── Domein wijzigen (vóór de start) ──
    s.post<{ Body: { domain: string; domainMode: "own" | "free" | "buy" | "sub" } }>("/api/setup/domain", async (req, reply) => {
      const c = cfg();
      if (c.console.done) return reply.code(409).send({ error: "Je cloud draait al; het domein wijzigen kan dan niet meer hier" });
      const before = c.domain;
      try { extras.changeDomain(c, normalizeDomain(req.body.domain, req.body.domainMode), req.body.domainMode); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      // Mail via Scaleway hoort bij het domein: bij een ander domein opnieuw aanmelden.
      if (c.console.quick && c.domain !== before && c.providers.scaleway?.secretKey && c.providers.scaleway.projectId) {
        await extras.scwRevokeMail(c).catch(() => null);
        delete c.console.temDomainId;
        await extras.scwMail(c, c.providers.scaleway.secretKey, c.providers.scaleway.projectId).catch(() => { c.console.mailRelay = ""; c.console.extraDns = []; });
      }
      save();
      return { ok: true, domain: c.domain };
    });

    // ── Gratis DNS: deSEC-account vanuit de console ──
    s.post("/api/desec/captcha", async (_req, reply) => {
      try { return await extras.desecCaptcha(); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { captchaId: string; solution: string; email?: string } }>("/api/desec/register", async (req, reply) => {
      try { const r = await extras.desecRegister(cfg(), req.body); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post("/api/desec/finish", async (_req, reply) => {
      const c = cfg();
      try {
        const token = await extras.desecFinish(c);
        if (!token) return { pending: true, email: c.console.desec?.email };
        save();
        return await configureDns(c, "desec", token);
      } catch (e) { save(); return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Eigen Cloud Dienst ──
    s.post<{ Body: { email: string } }>("/api/dienst/login", async (req, reply) => {
      try { const r = await extras.dienstLogin(cfg(), req.body.email); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { code: string } }>("/api/dienst/verify", async (req, reply) => {
      try { const r = await extras.dienstVerify(cfg(), req.body.code); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: extras.OrderInput }>("/api/dienst/order", async (req, reply) => {
      try { const r = await extras.dienstOrder(cfg(), req.body); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get("/api/dienst/status", async (_req, reply) => {
      try { return await extras.dienstStatus(cfg()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    // ── Aanbieder kiezen, huisstijl, hulpvragen, berichten, gebruikers ──
    s.post<{ Body: { url?: string; invite?: string } }>("/api/dienst/select", async (req, reply) => {
      try { const r = await extras.dienstSelect(cfg(), req.body?.url ?? "", req.body?.invite || undefined); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get("/api/dienst/brand", async (_req, reply) => {
      const base = extras.baseOf(cfg());
      if (!base) return { url: null };
      try { return await brandCached(base); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
    });
    s.get("/api/dienst/tickets", async (_req, reply) => {
      try { return await extras.dienstTickets(cfg()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { subject?: string; message?: string } }>("/api/dienst/tickets", async (req, reply) => {
      try { return await extras.dienstNewTicket(cfg(), req.body ?? {}); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get<{ Querystring: { id?: string } }>("/api/dienst/ticket", async (req, reply) => {
      try { return await extras.dienstTicket(cfg(), req.query.id ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { id?: string; message?: string } }>("/api/dienst/ticket/reply", async (req, reply) => {
      try { return await extras.dienstTicketReply(cfg(), req.body?.id ?? "", req.body?.message ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get("/api/dienst/announcements", async (_req, reply) => {
      try { return await extras.dienstAnnouncements(cfg()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { count?: number } }>("/api/dienst/users", async (req, reply) => {
      try { const r = await extras.dienstSetUsers(cfg(), Number(req.body?.count ?? 0)); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });

    s.get("/api/dienst/billing", async (_req, reply) => {
      try { return await extras.dienstBilling(cfg()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post<{ Body: { bundle: string } }>("/api/dienst/bundle", async (req, reply) => {
      const c = cfg();
      try {
        const r = await extras.dienstChangeBundle(c, req.body?.bundle);
        save();
        // Een draaiend cluster krijgt de nieuwe aantallen meteen (de plekken gaan mee met save()).
        if (c.console.done) {
          const st = await clusterStatus(c).catch(() => null);
          if (st?.leaderUrl) await rpc(keysFor(c).cluster, st.leaderUrl, { type: "setPolicy", policy: r.policy, proof: adminProof(c.masterKey!, r.policy) }, 5000).catch(() => null);
        }
        return r;
      } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    for (const action of ["payment-method", "settle", "cancel", "resume"] as const) {
      s.post(`/api/dienst/${action}`, async (_req, reply) => {
        try { return await extras.dienstAction(cfg(), action); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      });
    }
    s.get("/api/dienst/authcode", async (_req, reply) => {
      try { return await extras.dienstAuthcode(cfg()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.get<{ Querystring: { id?: string } }>("/api/dienst/invoice", async (req, reply) => {
      try { return await extras.dienstInvoice(cfg(), req.query.id ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.post("/api/dienst/apply", async (_req, reply) => {
      const c = cfg();
      try {
        const r = await extras.dienstApply(c, addStore);
        save();
        return r;
      } catch (e) { save(); return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Aanbieder worden: je eigen Eigen Cloud Dienst opzetten en bijhouden ──
    const aDeps = (): aanbieder.Deps => ({
      save,
      storeEndpoint: (region) => storeOffers().find((o) => o.id === "scaleway")?.regions.find((r) => r.id === region)?.endpoint ?? `https://s3.${region}.scw.cloud`,
    });
    const aFail = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: (e as Error).message, ...((e as { steps?: unknown }).steps ? { steps: (e as { steps?: unknown }).steps } : {}) });
    s.get("/api/aanbieder", async () => aanbieder.view(cfg()));
    s.post<{ Body: { step?: string } }>("/api/aanbieder/stap", async (req, reply) => {
      try { const r = aanbieder.setStep(cfg(), req.body?.step ?? ""); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: Record<string, string> }>("/api/aanbieder/bedrijf", async (req, reply) => {
      try { const r = aanbieder.saveBedrijf(cfg(), req.body ?? {}); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: Record<string, unknown> }>("/api/aanbieder/accounts", async (req, reply) => {
      try { const r = await aanbieder.saveAccounts(cfg(), req.body ?? {}); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: { url?: string } }>("/api/aanbieder/adres", async (req, reply) => {
      try { const r = aanbieder.saveAdres(cfg(), req.body ?? {}); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post("/api/aanbieder/opzetten", async (_req, reply) => {
      try { return await aanbieder.opzetten(cfg(), aDeps()); } catch (e) { return aFail(reply, e); }
    });
    s.get("/api/aanbieder/status", async (_req, reply) => {
      try { return await aanbieder.status(cfg(), aDeps()); } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: { confirm?: string } }>("/api/aanbieder/verwijderen", async (req, reply) => {
      try { return await aanbieder.verwijderen(cfg(), req.body ?? {}, aDeps()); } catch (e) { return aFail(reply, e); }
    });

    // ── Mail ──
    s.post<{ Body: { relay: { host: string; port: number; user?: string; password?: string; secure: boolean } | null; spfExtra?: string; sendTest?: boolean } }>("/api/mail", async (req, reply) => {
      const c = cfg();
      c.console.spfExtra = (req.body.spfExtra ?? "").trim();
      if (!req.body.relay) {
        c.console.mailRelay = "";
        save();
        return { ok: true, tested: false };
      }
      const r = req.body.relay;
      let pass = r.password;
      if (!pass && c.console.mailRelay) { try { pass = decodeURIComponent(new URL(c.console.mailRelay).password); } catch { /* */ } }
      const url = `${r.secure ? "smtps" : "smtp"}://${r.user ? `${encodeURIComponent(r.user)}:${encodeURIComponent(pass ?? "")}@` : ""}${r.host}:${r.port}`;
      try {
        const t = nodemailer.createTransport(url, { connectionTimeout: 10_000 } as never);
        await t.verify();
        if (req.body.sendTest && c.console.alertEmail) {
          await t.sendMail({ from: c.appEnv.MAIL_FROM, to: c.console.alertEmail, subject: "Test vanuit je Eigen Cloud-beheerconsole", text: "De verbinding met je mail-relay werkt." });
        }
      } catch (e) {
        return reply.code(400).send({ error: `Verbinden met ${r.host} lukt niet: ${(e as Error).message}` });
      }
      c.console.mailRelay = url;
      save();
      return { ok: true, tested: !!req.body.sendTest };
    });

    // ── Starten ──
    s.get("/api/checklist", async () => checklist(cfg()));

    s.post("/api/launch", async (req, reply) => {
      const c = cfg();
      const missing = checklist(c).filter((x) => x.required && !x.ok);
      if (missing.length) return reply.code(400).send({ error: `Nog niet klaar: ${missing.map((m) => m.label.toLowerCase()).join(", ")}` });
      if (launch && !launch.done) return reply.code(409).send({ error: "Er wordt al gestart" });
      const first = c.policy.placement.find((p) => p.kind !== "witness")!;
      c.appEnv.SMTP_RELAY = "";
      await saveAdminCopy(c);
      return startLaunch(c, first, 0);
    });

    s.get("/api/launch", async () => launch);

    // ── Dashboard ──
    s.get("/api/status", async () => {
      const c = cfg();
      const st = await clusterStatus(c, c.console.firstLaunch?.clusterUrl ? [c.console.firstLaunch.clusterUrl] : []);
      const state = launch && !launch.done ? "starting"
        : st.live?.leader ? (st.live.sleeping ? "falling-asleep" : "awake")
        : st.manifest?.state === "asleep" ? "asleep" : st.manifest ? "unreachable" : "new";
      return { state, domain: c.domain, appUrl: appUrl(c), manifest: st.manifest, live: st.live, launch };
    });

    s.post<{ Body: { type: string; params?: Record<string, unknown> } }>("/api/action", async (req, reply) => {
      const c = cfg();
      const st = await clusterStatus(c);
      if (!st.leaderUrl) return reply.code(409).send({ error: "Het cluster is niet bereikbaar" });
      const r = await sendJob(c, st.leaderUrl, req.body.type, req.body.params ?? {});
      if (!r.ok) return reply.code(400).send({ error: r.error ?? "Mislukt" });
      return r;
    });

    s.put<{ Body: Record<string, unknown> }>("/api/policy", async (req, reply) => {
      const c = cfg();
      const allowed = ["minDataNodes", "witnesses", "autoHeal", "autoReplaceAfterMin"];
      const pol = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
      Object.assign(c.policy, pol);
      save();
      await saveAdminCopy(c);
      const st = await clusterStatus(c);
      if (st.leaderUrl) await rpc(keysFor(c).cluster, st.leaderUrl, { type: "setPolicy", policy: pol, proof: adminProof(c.masterKey!, pol) }, 5000).catch(() => null);
      return { ok: true };
    });

    s.post("/api/wake", async (_req, reply) => {
      const c = cfg();
      const m = await readManifest(c);
      if (m && m.state !== "asleep" && (await probeCluster(c, m)).length) return reply.code(409).send({ error: "Je cloud is al wakker" });
      if (launch && !launch.done) return reply.code(409).send({ error: "Er wordt al gestart" });
      const t = m?.topology?.find((x) => x.kind === "data");
      const first = t ? { provider: t.provider, region: t.region, size: t.size } : c.policy.placement.find((p) => p.kind !== "witness")!;
      return startLaunch(c, first, (m?.term ?? 0) + 1);
    });

    s.post("/api/drill", async () => {
      const c = cfg();
      const keys = keysFor(c);
      const results: { store: string; ok: boolean; detail: string }[] = [];
      for (const st of c.stores.map(makeStore)) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drill-"));
        try {
          const r = await restoreFromStore(st, keys.db!, path.join(tmp, "x.sqlite"));
          results.push({ store: st.name, ok: !!r, detail: r ? `bijgewerkt tot ${new Date(r.lastTs ?? 0).toLocaleString("nl-NL")}` : "geen back-up gevonden" });
        } catch (e) {
          results.push({ store: st.name, ok: false, detail: (e as Error).message });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      return { results };
    });

    s.get<{ Querystring: { until?: string } }>("/api/download-db", async (req, reply) => {
      const c = cfg();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-"));
      const file = path.join(tmp, "eigen-cloud.sqlite");
      const r = await restoreFromAny(c.stores.map(makeStore), keysFor(c).db!, file, { until: req.query.until ? Date.parse(req.query.until) : undefined });
      if (!r) return reply.code(404).send({ error: "Geen back-up gevonden" });
      reply.header("content-type", "application/vnd.sqlite3");
      reply.header("content-disposition", `attachment; filename="eigen-cloud-${new Date(r.lastTs ?? Date.now()).toISOString().slice(0, 16).replace(":", "")}.sqlite"`);
      const stream = fs.createReadStream(file);
      stream.on("close", () => fs.rmSync(tmp, { recursive: true, force: true }));
      return reply.send(stream);
    });
  });

  return app;
}

function appUrl(c: AdminConfig) {
  if (LOCAL && c.console.firstLaunch?.apiUrl) return c.console.firstLaunch.apiUrl;
  return c.domain ? `https://cloud.${c.domain}` : null;
}

async function startLaunch(c: AdminConfig, first: { provider: string; region: string; size: string; country?: string }, term: number) {
  const offer = serverOffers().find((o) => o.id === first.provider);
  const region = offer?.regions.find((r) => r.id === first.region);
  launch = {
    startedAt: Date.now(), done: false, appUrl: null,
    steps: [
      { id: "server", label: `Server aanmaken bij ${offer?.name ?? first.provider}${region ? ` in ${region.city}` : ""}`, state: "busy" },
      { id: "boot", label: "Opstarten", state: "wait" },
      { id: "start", label: term ? "Gegevens terugzetten" : "Je cloud inrichten", state: "wait" },
      { id: "grow", label: "Tweede server en witness erbij", state: "wait" },
      { id: "https", label: `Bereikbaar maken op cloud.${c.domain}`, state: "wait" },
    ],
  };
  try {
    const initialSettings: Record<string, string> = { mail_from: c.appEnv.MAIL_FROM };
    if (c.console.appPasswordHash) initialSettings.password_hash = c.console.appPasswordHash;
    if (c.console.alertEmail) initialSettings.alert_email = c.console.alertEmail;
    if (c.console.mailRelay) initialSettings.mail_relay = c.console.mailRelay;
    if (c.console.spfExtra) initialSettings.spf_extra = c.console.spfExtra;
    if (c.console.extraDns?.length) initialSettings.extra_dns = JSON.stringify(c.console.extraDns);
    const cs = consoleSettings(c, extras.DIENST_URL());
    if (cs.max_users !== "0") initialSettings.max_users = cs.max_users;
    if (cs.dienst_report) initialSettings.dienst_report = cs.dienst_report;
    const r = await provisionFirstNode(c, { ...first, term, initialSettings: term ? undefined : initialSettings });
    setStep("server", "done", r.info.ipv4 ? `IP-adres ${r.info.ipv4}` : "");
    c.console.firstLaunch = { at: Date.now(), nodeId: r.nodeId, provider: first.provider, region: first.region, clusterUrl: r.clusterUrl, apiUrl: r.info.apiUrl };
    c.console.done = true;
    c.console.step = "klaar";
    vault.save();
    launch.appUrl = appUrl(c);
    const want = c.policy.minDataNodes + c.policy.witnesses;
    void followLaunch(r.clusterUrl, r.info.apiUrl ?? null, want).catch((e) => setStep("grow", "fail", (e as Error).message));
    return { ok: true, nodeId: r.nodeId };
  } catch (e) {
    setStep("server", "fail", (e as Error).message);
    launch.done = true;
    throw e;
  }
}

async function delegated(domain: string, ns: string[]) {
  const cur = (await dnsp.resolveNs(domain).catch(() => [] as string[])).map((x) => x.toLowerCase().replace(/\.$/, ""));
  return ns.every((n) => cur.includes(n.toLowerCase()));
}

function checklist(c: AdminConfig) {
  const countries = new Set(c.stores.map((s) => s.country));
  return [
    { id: "sleutel", label: "Herstelsleutel bewaard", ok: c.console.keyConfirmed, required: true },
    { id: "opslag", label: "Opslag gekoppeld", ok: c.stores.some((s) => s.purpose === "replica"), required: true },
    { id: "opslag-spreiding", label: "Back-up op een tweede plek, in een ander land", ok: c.stores.length >= 2 && countries.size >= 2 && c.stores.some((s) => s.purpose === "backup"), required: false },
    { id: "servers", label: "Serverplekken gekozen", ok: c.policy.placement.length > 0, required: true },
    { id: "dns", label: "Domein gekoppeld", ok: !!c.console.dnsMode, required: false },
    { id: "mail", label: "Uitgaande mail via een relay", ok: !!c.console.mailRelay, required: false },
    { id: "meldingen", label: "Meldadres buiten je eigen domein", ok: !!c.console.alertEmail, required: false },
  ];
}

function recoverySheet(c: AdminConfig, g: string[], check: string) {
  const store = c.stores[0];
  const esc = (s: string) => s.replace(/[&<>"]/g, (x) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[x]!);
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Herstelblad ${esc(c.domain ?? "")}</title>
<link rel="stylesheet" href="/shared/tokens.css"><style>
body{font-family:var(--font);color:#1d2a2f;background:#fff;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.5}
h1{font-size:28px;margin:0 0 4px}.sub{color:#5b6b70;margin:0 0 28px}
.key{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.key div{border:1.5px solid #1d2a2f;border-radius:8px;padding:12px 8px;text-align:center;font-size:22px;letter-spacing:.06em;font-variant-numeric:tabular-nums}
.key small{display:block;font-size:11px;color:#5b6b70;letter-spacing:0}
ol li{margin:6px 0}.box{border-left:4px solid #3f6f4a;background:#eef3ef;padding:12px 16px;border-radius:6px;margin:22px 0}
@media print{button{display:none}body{margin:0 auto}}
</style></head><body>
<h1>Herstelblad</h1><p class="sub">Eigen Cloud van ${esc(c.domain ?? c.cluster)} · gemaakt op ${new Date().toLocaleDateString("nl-NL", { dateStyle: "long" })}</p>
<p>Met deze sleutel en de toegang tot één opslagplaats krijg je alles terug: mail, agenda, foto's en de instellingen van je cloud. Zonder deze sleutel kan niemand je back-ups lezen — ook jij niet.</p>
<div class="key">${g.map((x, i) => `<div>${x}<small>groep ${i + 1}</small></div>`).join("")}</div>
<p>Controlegetal: <b>${check}</b></p>
<div class="box"><b>Bewaar dit blad op twee plekken</b>, bijvoorbeeld thuis in een map met belangrijke papieren en bij iemand die je vertrouwt. Niet als foto op je telefoon.</div>
<h2>Zo haal je alles terug</h2>
<ol><li>Installeer de Eigen Cloud-beheerconsole op een computer en start hem.</li>
<li>Kies <b>Ik heb al een Eigen Cloud</b>.</li>
<li>Vul deze sleutel in en de gegevens van één opslag${store ? ` (bijvoorbeeld <b>${esc(store.name)}</b>, bucket <b>${esc(store.bucket ?? store.dir ?? "")}</b>)` : ""}.</li>
<li>Kies <b>Wakker maken</b>. Binnen een kwartier draait je cloud weer.</li></ol>
<button onclick="print()">Afdrukken</button></body></html>`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.CONSOLE_PORT ?? 4000);
  const host = process.env.CONSOLE_HOST ?? "127.0.0.1";
  const app = await buildConsole();
  await app.listen({ port, host });
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log(`🐌 Beheerconsole: ${url}`);
  if (!process.env.NO_OPEN) {
    // Browser openen (Windows, macOS, Linux).
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* geen browser */ }
  }
}
