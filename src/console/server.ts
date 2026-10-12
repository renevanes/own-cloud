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
import * as catalog from "./catalog.js";
import * as costs from "./costs.js";
import { fetchSizes, pickSize, buildPresets, type SizeOption, type ServerOffer, type StoreOffer, type DnsOffer } from "./catalog.js";
import { DEFAULT_POLICY, keysFor, type Placement } from "../cluster/config.js";
import { randomKeyHex } from "../cluster/crypto.js";
import { hashPassword } from "../auth.js";
import { makeProvider } from "../cluster/providers.js";
import { getAdapter, isSecretField } from "../cluster/adapters.js";
import { checkStorage, genericServersCheck, row, type KeyCheck } from "../cluster/adapters/check.js";
import { dnsFields } from "../cluster/dns.js";
import { makeStore, S3Store, type StoreConfig } from "../cluster/stores.js";
import { restoreFromAny, restoreFromStore } from "../cluster/backup.js";
import { rpc } from "../cluster/transport.js";
import * as extras from "./extras.js";
import * as aanbieder from "./aanbieder.js";
import * as overstap from "./overstap.js";
import { findAdminConfig } from "../cluster/admin.js";
import { consoleSettings } from "../cluster/admin.js";
import { clusterStatus, findLeader, prepareStore, probeCluster, provisionFirstNode, readManifest, recoverAdminConfig, saveAdminCopy, sendJob, adminProof, pushAdminConfig } from "../cluster/admin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.EIGEN_CONSOLE_LOCAL === "1";
const vault = new Vault(process.env.EIGEN_VAULT ?? path.join(os.homedir(), ".eigen-cloud", "kluis.json"));

// Alle aanbieders komen uit de registry (src/cluster/adapters.ts); de testaanbieder "local" alleen met EIGEN_CONSOLE_LOCAL=1.
const serverOffers = (): ServerOffer[] => catalog.serverOffers(LOCAL);
const dnsOffers = (): DnsOffer[] => catalog.dnsOffers(LOCAL);
// Alleen voor tests: alle S3-opslag naar één nepserver (EIGEN_TEST_S3).
const TEST_S3 = process.env.EIGEN_TEST_S3;
const baseStores = () => {
  const list = catalog.storeOffers(LOCAL);
  return TEST_S3 ? list.map((o) => ({ ...o, regions: o.regions.map((r) => ({ ...r, endpoint: r.endpoint ? TEST_S3 : r.endpoint })) })) : list;
};
const storeOffers = (): StoreOffer[] => LOCAL
  ? [...baseStores(), { id: "localfs", name: "Map op deze computer (test)", owner: "Jijzelf", regions: [{ id: "nl", label: "Lokaal", country: "NL", endpoint: "" }], help: "", signupUrl: "" }]
  : baseStores();

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
  // Tijdens het overstappen niet op slot: dat loopt op de achtergrond verder en moet de kluis kunnen bijwerken.
  if (session && Date.now() - session.lastUse > IDLE_MS && !overstap.busy()) { vault.lock(); session = null; }
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
  } else if (c.console.alleenDienst) {
    // Zonder eigen cloud: de herstelkopie in de back-upbucket van de Dienst (zodra die er is).
    void aanbieder.saveDienstCopy(c).catch(() => {});
  }
};

// ───────── Hulpjes ─────────

const mask = (v?: string) => (v ? "•".repeat(8) + v.slice(-4) : "");

function sanitized(c: AdminConfig) {
  return {
    cluster: c.cluster, domain: c.domain, mailFrom: c.appEnv.MAIL_FROM, alertEmail: c.console.alertEmail ?? "",
    stores: c.stores.map((s) => ({ ...s, accessKey: s.accessKey ? mask(s.accessKey) : undefined, secretKey: s.secretKey ? "••••••••" : undefined })),
    providers: Object.fromEntries(Object.entries(c.providers).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, x]) => [f, isSecretField(v.type ?? k, f) ? mask(x) : x]))])),
    dns: c.dns.map((d) => ({ ...d, token: d.token ? mask(d.token) : undefined, ...(d.fields ? { fields: Object.fromEntries(Object.entries(d.fields).map(([f, x]) => [f, isSecretField(d.type, f) ? mask(x) : x])) } : {}) })),
    dnsMode: c.console.dnsMode ?? null,
    mailRelay: c.console.mailRelay ? (() => { try { const u = new URL(c.console.mailRelay!); return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), secure: u.protocol === "smtps:" }; } catch { return null; } })() : null,
    spfExtra: c.console.spfExtra ?? "",
    policy: c.policy, preset: c.console.preset ?? null,
    domainMode: c.console.domainMode ?? "own",
    desec: c.console.desec ? { email: c.console.desec.email, at: c.console.desec.at } : null,
    quick: c.console.quick ?? null,
    dienst: c.console.dienst ? { url: c.console.dienst.url ?? null, invite: c.console.dienst.invite ?? null, email: c.console.dienst.email ?? null, loggedIn: !!c.console.dienst.token, orderId: c.console.dienst.orderId ?? null, bundle: c.console.dienst.bundle ?? null, applied: !!c.console.dienst.applied } : null,
    maxUsers: c.console.maxUsers ?? 0,
    overstap: c.console.overstap ? { naar: c.console.overstap.naar, stap: c.console.overstap.stap } : null,
    alleenDienst: !!c.console.alleenDienst,
    keyCheck: c.console.keyConfirmed ? "ok" : c.console.keyCheckLater ? "later" : "open",
  };
}

interface Step { id: string; label: string; state: "wait" | "busy" | "done" | "fail"; detail?: string }
let launch: { steps: Step[]; appUrl: string | null; done: boolean; startedAt: number } | null = null;
/** Elke nieuwe start krijgt een nummer; het volgen van een eerdere (bijv. mislukte wekpoging bij overstappen) stopt dan. */
let launchGen = 0;

function setStep(id: string, state: Step["state"], detail?: string) {
  const s = launch?.steps.find((x) => x.id === id);
  if (s) { s.state = state; if (detail !== undefined) s.detail = detail; }
}

async function followLaunch(clusterUrl: string, apiUrl: string | null, wantNodes: number, gen = launchGen) {
  const c = cfg();
  const keys = keysFor(c);
  const end = Date.now() + 45 * 60_000;
  // Doorgaan tot de deadline, of tot een nieuwere start deze vervangt.
  const alive = () => gen === launchGen && Date.now() < end;
  const set = (id: string, state: Step["state"], detail?: string) => { if (gen === launchGen) setStep(id, state, detail); };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  set("boot", "busy", "Software installeren en starten (meestal 2 à 4 minuten)");
  while (alive()) {
    const r = await request(`${clusterUrl}/cluster/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (r) { await r.body.dump(); if (r.statusCode === 200) break; }
    await wait(3000);
  }
  set("boot", "done", "");
  set("start", "busy", "Back-up terugzetten en de leiding nemen");
  let leaderSince = 0;
  while (alive()) {
    const st = await rpc<any>(keys.cluster, clusterUrl, { type: "status" }, 3000).catch(() => null);
    if (st?.role === "leader") { leaderSince = Date.now(); break; }
    await wait(2000);
  }
  set("start", "done", "");
  set("grow", "busy", "Tweede server en witness worden aangemaakt");
  while (alive()) {
    const leader = await findLeader(c, [clusterUrl]);
    const sum = leader ? await rpc<any>(keys.cluster, leader.url, { type: "clusterSummary" }, 5000).catch(() => null) : null;
    const ready = (sum?.nodes ?? []).filter((n: { status: string }) => n.status === "ready").length;
    if (sum) set("grow", "busy", `${ready} van ${wantNodes} servers klaar`);
    if (ready >= wantNodes) break;
    await wait(3000);
  }
  set("grow", "done", `${wantNodes} servers actief`);
  set("https", "busy", c.domain ? `Wachten tot cloud.${c.domain} bereikbaar is (DNS en certificaat)` : "");
  const url = launch!.appUrl ?? apiUrl;
  while (alive() && url) {
    const r = await request(`${url}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (r) { await r.body.dump(); if (r.statusCode === 200) break; }
    await wait(5000);
  }
  if (gen !== launchGen) return;
  set("https", "done", "");
  launch!.done = true;
  void leaderSince;
}

function adminPolicy(placement: Placement[]) {
  return { ...DEFAULT_POLICY, placement };
}

// ───────── Gedeelde stappen (ook gebruikt door de dienst-koppeling) ─────────

type StoreInput = { offer: string; region: string; endpoint?: string; accessKey?: string; secretKey?: string; bucket?: string; purpose: "replica" | "backup"; dir?: string };

/**
 * Opslag koppelen: bucket aanmaken en instellen (versiebeheer, onveranderbaar), en bij succes bewaren.
 * Met een andere configuratie t (overstappen: de nieuwe plek) komt hij daarin en wordt de kluis niet bewaard.
 */
async function addStore(b: StoreInput, t: AdminConfig = cfg()) {
  const offer = storeOffers().find((o) => o.id === b.offer);
  const region = offer?.regions.find((r) => r.id === b.region);
  if (!offer || !region) throw new Error("Kies een aanbieder en locatie");
  const name = `${offer.id}-${region.id}${b.purpose === "backup" ? "-backup" : ""}`;
  const existing = t.stores.find((x) => x.name === name);
  let store: StoreConfig;
  if (offer.id === "localfs") {
    store = { name, type: "fs", purpose: b.purpose, country: region.country, dir: b.dir || path.join(path.dirname(vault.file), "opslag", name) };
  } else {
    const endpoint = offer.customEndpoint ? b.endpoint : region.endpoint;
    if (!endpoint || !/^https?:\/\//.test(endpoint)) throw new Error("Vul de endpoint-URL in (begint met https://)");
    store = {
      name, type: "s3", purpose: b.purpose, country: region.country, endpoint, region: region.id === "eigen" ? "us-east-1" : region.id,
      // Zelfde plek opnieuw koppelen (bijv. de assistent nog eens doorlopen): dezelfde bucket houden.
      bucket: b.bucket || (existing?.endpoint === endpoint ? existing?.bucket : undefined) || `${t.cluster}-${b.purpose === "backup" ? "backup" : "data"}-${crypto.randomBytes(3).toString("hex")}`,
      accessKey: b.accessKey || existing?.accessKey, secretKey: b.secretKey || existing?.secretKey,
    };
    if (!store.accessKey || !store.secretKey) throw new Error("Vul de toegangssleutel en geheime sleutel in");
  }
  const steps = await prepareStore(store);
  const ok = steps.every((x) => x.ok || /Versiebeheer|Onveranderbaar/.test(x.label));
  if (ok) {
    t.stores = [...t.stores.filter((x) => x.name !== name), store];
    if (t === cfg()) save();
  }
  return { ok, steps, name };
}

/** Inloggegevens voor servers: wat bewaard is, met wat nu is ingevuld eroverheen (gemaskeerde "••…" tellen niet). */
function providerFields(id: string, fieldsIn: Record<string, string>, t: AdminConfig = cfg()) {
  const fields = { ...(t.providers[id] ?? {}) };
  for (const [k, v] of Object.entries(fieldsIn ?? {})) if (typeof v === "string" && v && !v.startsWith("••")) fields[k] = v.trim();
  if (id === "local" && !fields.baseDir) fields.baseDir = path.join(path.dirname(vault.file), "servers");
  return fields;
}

/** Aanbieder van servers koppelen: inloggen controleren en de live formaten en prijzen per regio ophalen. */
async function linkProvider(id: string, fieldsIn: Record<string, string>, t: AdminConfig = cfg()) {
  const offer = serverOffers().find((o) => o.id === id);
  if (!offer) throw new Error("Onbekende aanbieder");
  const fields = providerFields(offer.id, fieldsIn, t);
  try {
    await makeProvider(offer.id, fields).list(t.cluster);
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
  t.providers[offer.id] = fields;
  const cat = (t.console.catalog ??= {});
  cat[offer.id] = Object.fromEntries(regions.filter((r) => r.data).map((r) => [r.region, { data: r.data, witness: r.witness }]));
  if (t === cfg()) save();
  return { ok: true, regions };
}

/** Verspreiding kiezen; extra plekken als reserve voor zelfherstel (lagere voorkeur). */
function choosePreset(id: string, t: AdminConfig = cfg()) {
  const cat = t.console.catalog ?? {};
  const available = serverOffers().flatMap((o) => o.regions.filter((r) => cat[o.id]?.[r.id]).map((r) => ({ provider: o.id, region: r, ...cat[o.id][r.id] })));
  const p = buildPresets(available).find((x) => x.id === id);
  if (!p || !p.placement.length) throw new Error(p?.missing ?? "Onbekende keuze");
  const reserve: Placement[] = available.flatMap((a) => [
    ...(a.data ? [{ provider: a.provider, region: a.region.id, size: a.data.size, country: a.region.country, kind: "data" as const }] : []),
    ...(a.witness ? [{ provider: a.provider, region: a.region.id, size: a.witness.size, country: a.region.country, kind: "witness" as const }] : []),
  ]).filter((r) => id !== "nl" || r.country === "NL");
  const seen = new Set<string>();
  t.policy = { ...t.policy, placement: [...p.placement, ...reserve].filter((x) => { const k = `${x.kind}/${x.provider}/${x.region}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
  t.console.preset = p.id;
  if (t === cfg()) save();
  return p;
}

/**
 * Alleen voor tests (EIGEN_CONSOLE_LOCAL=1 en EIGEN_TEST_KIT_LOCAL=1): het pakket van een Dienst op deze computer
 * laten draaien (lokale "aanbieder" en opslag in een map per bestelling), zodat slapen, overstappen en wekken
 * met echte processen te testen zijn.
 */
function localKit(kit: extras.Kit, orderId: string): extras.Kit {
  if (!LOCAL || process.env.EIGEN_TEST_KIT_LOCAL !== "1") return kit;
  const dir = path.dirname(vault.file);
  return {
    ...kit,
    provider: { id: "local", fields: { baseDir: path.join(dir, `servers-${orderId}`) } },
    storage: kit.storage.map((s) => ({ ...s, offer: "localfs", region: "nl", dir: path.join(dir, "opslag", `${orderId}-${s.purpose}`) })),
    placement: [
      { provider: "local", region: "ams", size: "local", country: "NL", kind: "data" },
      { provider: "local", region: "fra", size: "local", country: "DE", kind: "data" },
      { provider: "local", region: "hel", size: "local", country: "FI", kind: "witness" },
    ],
  };
}

/**
 * DNS koppelen bij een aanbieder met DNS uit de registry (deSEC, Hetzner, Scaleway, Exoscale, OVHcloud, …) of
 * handmatig. Inloggegevens: de sleutel van dezelfde aanbieder bij Servers, daarover wat eerder voor DNS gekoppeld
 * was, daarover wat de gebruiker nu invult (gemaskeerde waarden "••…" tellen niet).
 */
async function configureDns(c: AdminConfig, mode: string, tokenIn?: string, fieldsIn?: Record<string, string>) {
  const d = c.domain!;
  if (mode === "manual") {
    c.dns = [];
    c.console.dnsMode = "manual";
    save();
    return { ok: true, ns: null, delegated: null };
  }
  const a = dnsAdapter(mode);
  const want = a.dns!.fields ?? a.fields;
  const fields = dnsFieldsFor(c, mode, { ...(fieldsIn ?? {}), ...(tokenIn ? { token: tokenIn } : {}) });
  const missing = want.filter((f) => !f.optional && !fields[f.key]);
  if (missing.length) throw new Error(missing.length === 1 && missing[0].key === "token" ? "Vul je API-token in" : `Vul in: ${missing.map((f) => f.label).join(", ")}`);
  const { nameservers: ns } = await a.dns!.connect(fields, d);
  const { token, ...rest } = fields;
  c.dns = [{ type: mode, name: mode, ...(token ? { token } : {}), zone: d, ...(Object.keys(rest).length ? { fields: rest } : {}) }];
  c.console.dnsMode = mode;
  c.console.nameservers = ns;
  save();
  // dedyn.io-namen staan meteen goed: deSEC beheert dedyn.io zelf.
  return { ok: true, ns, delegated: d.endsWith(".dedyn.io") ? true : await delegated(d, ns) };
}

function dnsAdapter(mode: string) {
  const a = getAdapter(mode);
  if (!a?.dns || (a.testOnly && !LOCAL)) throw new Error("Kies een DNS-aanbieder");
  return a;
}

/** Inloggegevens voor DNS: sleutel van Servers, daarover de eerdere DNS-koppeling, daarover wat nu is ingevuld. */
function dnsFieldsFor(c: AdminConfig, mode: string, given: Record<string, string>) {
  const a = dnsAdapter(mode);
  const want = a.dns!.fields ?? a.fields;
  const prev = c.dns.find((x) => x.type === mode);
  const fields: Record<string, string> = {};
  const linked = c.providers[mode] ?? {};
  for (const f of want) if (linked[f.key]) fields[f.key] = linked[f.key];
  if (prev) Object.assign(fields, Object.fromEntries(Object.entries(dnsFields(prev)).filter(([k]) => k !== "api")));
  for (const [k, v] of Object.entries(given)) if (typeof v === "string" && v.trim() && !v.startsWith("••") && want.some((f) => f.key === k)) fields[k] = v.trim();
  return fields;
}

/**
 * "Sleutels controleren" (POST /api/check): alleen lezende verzoeken bij de aanbieder, nooit iets maken of wijzigen.
 * kind "servers" of "dns": id = aanbieder; "storage": id = naam van een gekoppelde opslag. Velden die niet worden
 * meegegeven komen uit de kluis. Bij Scaleway zoekt de console de toegangssleutel (SCW…) bij de opslag met dezelfde
 * geheime sleutel; daarmee zijn de rechten na te gaan.
 */
async function keyChecks(c: AdminConfig, b: { kind?: string; id?: string; fields?: Record<string, string> }): Promise<KeyCheck[]> {
  const given = b.fields ?? {};
  const withAccessKey = (f: Record<string, string>) => {
    const st = f.secretKey && !f.accessKey ? c.stores.find((x) => x.secretKey === f.secretKey && x.accessKey) : undefined;
    return st ? { ...f, accessKey: st.accessKey! } : f;
  };
  if (b.kind === "servers") {
    const a = getAdapter(b.id ?? "");
    if (!a?.servers || !serverOffers().some((o) => o.id === a.id)) throw new Error("Onbekende aanbieder");
    const f = withAccessKey(providerFields(a.id, given, c));
    return a.servers.check ? a.servers.check(f) : genericServersCheck(a, f, c.cluster);
  }
  if (b.kind === "dns") {
    const a = dnsAdapter(b.id ?? "");
    const f = withAccessKey(dnsFieldsFor(c, a.id, given));
    return a.dns!.check ? a.dns!.check(f, c.domain ?? "") : [row("login", "Inloggen lukt", null, "Deze aanbieder kan de console nog niet controleren")];
  }
  if (b.kind === "storage") {
    const st = c.stores.find((x) => x.name === b.id);
    if (!st) throw new Error("Onbekende opslag");
    if (st.type !== "s3") throw new Error("Deze opslag is een map op deze computer; daar horen geen sleutels bij");
    const keys = Object.fromEntries(["accessKey", "secretKey"].filter((k) => typeof given[k] === "string" && given[k].trim() && !given[k].startsWith("••")).map((k) => [k, given[k].trim()]));
    return checkStorage({ ...st, ...keys });
  }
  throw new Error("Kies servers, dns of storage");
}

/** Na een mislukte koppeling: het lijstje erbij (als het controleren zelf lukt). */
const checksAfter = (b: Parameters<typeof keyChecks>[1]) => keyChecks(cfg(), b).then((checks) => ({ checks }), () => ({}));

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

type CloudInput = { domain: string; domainMode?: "own" | "free" | "buy" | "sub"; mailbox: string; alertEmail?: string; appPassword: string };

/** Een nieuwe kluis voor een cloud (eerste stap "Jij en je adres"); gooit een fout in gewone taal. */
function cloudConfig(b: CloudInput): AdminConfig {
  const mode = b.domainMode ?? "own";
  const domain = normalizeDomain(b.domain, mode);
  if (!/^[a-z0-9._+-]+$/i.test(b.mailbox ?? "")) throw new Error("Vul het deel vóór de @ in, zoals rene");
  if ((b.appPassword ?? "").length < 10) throw new Error("Kies een inlogwachtwoord van minstens 10 tekens");
  if (b.alertEmail && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(b.alertEmail)) throw new Error("Het meldadres is geen geldig e-mailadres");
  if (b.alertEmail?.endsWith("@" + domain)) throw new Error("Kies voor meldingen een adres buiten je eigen domein, zodat een melding je ook bereikt als je mail stuk is");
  if (mode === "free" && !b.alertEmail) throw new Error("Vul een meldadres in; daarmee maakt de console je gratis deSEC-account aan");
  return {
    cluster: domain.split(".")[0].replace(/[^a-z0-9-]/g, "").slice(0, 20) || "eigen",
    nodeId: "beheer", kind: "data", masterKey: randomKeyHex(), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], domain,
    stores: [], providers: {}, dns: [],
    image: { ref: "ghcr.io/renevanes/eigen-cloud:latest", caddyRef: "ghcr.io/renevanes/eigen-caddy:latest" } as AdminConfig["image"],
    appEnv: { MAIL_DOMAINS: domain, MAIL_FROM: `${b.mailbox}@${domain}`, HOSTNAME_FQDN: `mail.${domain}`, NODE_ENV: "production" },
    policy: adminPolicy([]),
    console: { step: "sleutel", done: false, keyConfirmed: false, appPasswordHash: hashPassword(b.appPassword), alertEmail: b.alertEmail ?? "", domainMode: mode },
  };
}

/** Een kluis alleen voor de Eigen Cloud Dienst (aanbieder worden zonder eigen cloud). */
function dienstConfig(): AdminConfig {
  return {
    cluster: "eigen", nodeId: "beheer", kind: "data", masterKey: randomKeyHex(), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [],
    stores: [], providers: {}, dns: [],
    image: { ref: "ghcr.io/renevanes/eigen-cloud:latest", caddyRef: "ghcr.io/renevanes/eigen-caddy:latest" } as AdminConfig["image"],
    appEnv: { NODE_ENV: "production" },
    policy: adminPolicy([]),
    console: { step: "sleutel", done: false, keyConfirmed: false, alleenDienst: true },
  };
}

// ───────── Herstelsleutel ─────────

const keyGroups = (c: AdminConfig) => c.masterKey!.match(/.{8}/g)!;
const keyCheckCode = (c: AdminConfig) => crypto.createHash("sha256").update(c.masterKey!).digest("hex").slice(0, 6);
/** Een getypte groep: spaties weg, kleine letters, o → 0 en i/l → 1 (die komen in een sleutel niet voor). */
const normGroup = (x: unknown) => String(x ?? "").replace(/\s/g, "").toLowerCase().replace(/o/g, "0").replace(/[il]/g, "1");
/** Een willekeurige groep (1–8), anders dan `not`. */
function pickKeyGroup(not?: number) {
  let n: number;
  do n = crypto.randomInt(1, 9); while (n === not);
  return n;
}
/** De groep die we vragen; blijft hetzelfde (ook na herladen) tot de controle lukt of je teruggaat naar de sleutel. */
function keyAsk(c: AdminConfig) {
  const a = c.console.keyAsk;
  if (typeof a === "number" && a >= 1 && a <= 8) return a;
  c.console.keyAsk = pickKeyGroup();
  save();
  return c.console.keyAsk;
}

// ───────── Server ─────────

export async function buildConsole() {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web-console"), prefix: "/" });
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web/shared"), prefix: "/shared/", decorateReply: false });
  await app.register(fastifyStatic, { root: path.resolve(here, "../../web/fonts"), prefix: "/fonts/", decorateReply: false });
  app.setErrorHandler((err, _req, reply) => reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message }));

  // De lijst van aanbieders (met wie er antwoordt) alvast ophalen, zodat de eerste stap weet of er een aanbieder is.
  void extras.aanbieders().then((list) => { knownAanbieders = list.filter((a) => a.bereikbaar).length; }).catch(() => {});

  app.get("/api/state", async (req) => ({
    vault: vault.exists(),
    unlocked: hasSession(req),
    step: vault.config?.console.step ?? null,
    done: vault.config?.console.done ?? false,
    domain: vault.config?.domain ?? null,
    offers: { stores: storeOffers(), servers: serverOffers(), dns: dnsOffers() },
    dienst: !!(extras.defaultDienst() || vault.config?.console.dienst?.url || knownAanbieders > 0),
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
    knownAanbieders = list.filter((a) => a.bereikbaar).length;
    return { aanbieders: list, gekozen: vault.config?.console.dienst?.url ?? null };
  });
  app.get<{ Querystring: { url?: string } }>("/api/aanbieder/brand", async (req, reply) => {
    try { return await brandCached(extras.cleanDienstUrl(req.query.url ?? "")); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.get<{ Querystring: { url?: string; code?: string } }>("/api/aanbieder/invite", async (req, reply) => {
    try { return await extras.dienstInvite(extras.cleanDienstUrl(req.query.url ?? ""), req.query.code ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Body: CloudInput & { passphrase: string } }>("/api/setup/create", async (req, reply) => {
    if (vault.exists()) return reply.code(409).send({ error: "Er is al een kluis. Ontgrendel hem." });
    let cfg: AdminConfig;
    try { cfg = cloudConfig(req.body ?? ({} as CloudInput)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    try { vault.create(req.body.passphrase ?? "", cfg); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    newSession(reply);
    return { ok: true };
  });

  // Aanbieder worden zonder eigen cloud: een kluis alleen voor de Dienst (herstelsleutel zoals bij een cloud).
  app.post<{ Body: { passphrase: string } }>("/api/setup/aanbieder", async (req, reply) => {
    if (vault.exists()) return reply.code(409).send({ error: "Er is al een kluis. Ontgrendel hem." });
    try { vault.create(req.body?.passphrase ?? "", dienstConfig()); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
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
      const rc = (recovered as AdminConfig).console;
      // Een kluis alleen voor een Dienst (herstelkopie uit zijn back-upbucket) heeft geen cloud om "klaar" te zijn.
      const cfg = { ...recovered, console: { ...rc, ...(rc?.alleenDienst ? {} : { step: "klaar", done: true }), keyConfirmed: true } } as AdminConfig;
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
      const base = req.body?.url ? extras.cleanDienstUrl(req.body.url) : extras.defaultDienst();
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
    // Eerst de sleutel tonen (groups), dan zonder sleutel in beeld één groep vragen (ask, 1–8, door de server gekozen en bewaard).
    s.get("/api/key", async () => {
      const c = cfg();
      return { groups: keyGroups(c), check: keyCheckCode(c), confirmed: c.console.keyConfirmed, later: !c.console.keyConfirmed && !!c.console.keyCheckLater, ask: keyAsk(c) };
    });
    s.post<{ Body: { group?: number; value?: string; g3?: string; g7?: string } }>("/api/key/confirm", async (req, reply) => {
      const c = cfg(), b = req.body ?? {};
      const g = keyGroups(c);
      if (b.value === undefined && (b.g3 !== undefined || b.g7 !== undefined)) {
        // Oude vorm: groep 3 en 7.
        if (normGroup(b.g3) !== g[2] || normGroup(b.g7) !== g[6]) return reply.code(400).send({ error: "Dat klopt niet met je sleutel. Kijk nog eens naar groep 3 en 7." });
      } else {
        const ask = keyAsk(c);
        if (b.group !== undefined && Number(b.group) !== ask) return reply.code(409).send({ error: `Er wordt nu naar groep ${ask} gevraagd`, ask });
        if (normGroup(b.value) !== g[ask - 1]) return reply.code(400).send({ error: `Dat is niet groep ${ask}. Kijk nog eens op je herstelblad.`, ask });
      }
      c.console.keyConfirmed = true;
      delete c.console.keyCheckLater;
      delete c.console.keyAsk;
      save();
      return { ok: true };
    });
    // Terug naar de sleutel: daarna wordt een andere groep gevraagd.
    s.post("/api/key/new-group", async () => {
      const c = cfg();
      c.console.keyAsk = pickKeyGroup(keyAsk(c));
      save();
      return { ask: c.console.keyAsk };
    });
    // Later controleren: de stappen gaan door; het overzicht toont een herinnering.
    s.post("/api/key/later", async () => {
      const c = cfg();
      if (!c.console.keyConfirmed) c.console.keyCheckLater = true;
      save();
      return { ok: true, later: !c.console.keyConfirmed };
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
      try { return await addStore(req.body ?? ({} as StoreInput)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    });
    s.delete<{ Params: { name: string } }>("/api/stores/:name", async (req) => {
      cfg().stores = cfg().stores.filter((x) => x.name !== req.params.name);
      save();
      return { ok: true };
    });

    // ── Servers ──
    s.post<{ Body: { id: string; fields: Record<string, string> } }>("/api/providers", async (req, reply) => {
      try { return await linkProvider(req.body.id, req.body.fields ?? {}); } catch (e) {
        const extra = /^Inloggen bij /.test((e as Error).message) ? await checksAfter({ kind: "servers", id: req.body.id, fields: req.body.fields }) : {};
        return reply.code(400).send({ error: (e as Error).message, ...extra });
      }
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
      const dienst = (c.console as { aanbieder?: aanbieder.AanbiederState }).aanbieder;
      if (dienst?.server || dienst?.removed || dienst?.backup?.bucket) return reply.code(409).send({ error: "In deze kluis staat ook je Eigen Cloud Dienst. Wissen kan niet: dan ben je de sleutel van je Dienst kwijt." });
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
    s.post<{ Body: { mode: string; token?: string; fields?: Record<string, string> } }>("/api/dns", async (req, reply) => {
      try { return await configureDns(cfg(), req.body.mode, req.body.token, req.body.fields); } catch (e) {
        const a = getAdapter(req.body.mode);
        const extra = a?.dns && !/^Vul /.test((e as Error).message) ? await checksAfter({ kind: "dns", id: req.body.mode, fields: { ...(req.body.fields ?? {}), ...(req.body.token ? { token: req.body.token } : {}) } }) : {};
        return reply.code(400).send({ error: (e as Error).message, ...extra });
      }
    });

    // ── Sleutels controleren (alleen lezen) ──
    s.post<{ Body: { kind?: string; id?: string; fields?: Record<string, string> } }>("/api/check", async (req, reply) => {
      try { return { checks: await keyChecks(cfg(), req.body ?? {}) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
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
        const r = await extras.dienstApply(c, (b) => addStore(b), localKit);
        save();
        return r;
      } catch (e) { save(); return reply.code(400).send({ error: (e as Error).message }); }
    });

    // ── Overstappen naar een andere aanbieder of naar zelf beheren ──
    const oDeps = (): overstap.Deps => ({
      cfg, save, saveVault: () => vault.save(),
      addStore: (b, t) => addStore(b, t),
      linkProvider: (id, fields, t) => linkProvider(id, fields, t),
      choosePreset: (id, t) => choosePreset(id, t),
      localKit,
      launch: async (c, first, term, adminOverride) => {
        await startLaunch(c, first, term, adminOverride);
        return { clusterUrl: c.console.firstLaunch!.clusterUrl! };
      },
    });
    const oFail = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: (e as Error).message });
    s.get("/api/overstap", async () => {
      const c = cfg();
      if (await overstap.refresh(c).catch(() => false)) vault.save();
      overstap.ensureRunning(oDeps());
      return overstap.view(c);
    });
    s.post<{ Body: { naar?: string } }>("/api/overstap/start", async (req, reply) => {
      try { const r = await overstap.start(cfg(), req.body?.naar ?? ""); save(); return r; } catch (e) { return oFail(reply, e); }
    });
    s.post<{ Body: { email?: string } }>("/api/overstap/login", async (req, reply) => {
      try { const r = await overstap.login(cfg(), req.body?.email ?? ""); vault.save(); return r; } catch (e) { return oFail(reply, e); }
    });
    s.post<{ Body: { code?: string } }>("/api/overstap/verify", async (req, reply) => {
      try { const r = await overstap.verify(cfg(), req.body?.code ?? ""); vault.save(); return r; } catch (e) { return oFail(reply, e); }
    });
    s.post<{ Body: { bundle?: string; acceptTerms?: boolean; registrant?: Record<string, string> } }>("/api/overstap/order", async (req, reply) => {
      try { const r = await overstap.order(cfg(), req.body ?? {}); vault.save(); return r; } catch (e) { return oFail(reply, e); }
    });
    s.post<{ Body: { accessKey?: string; secretKey?: string; projectId?: string; desecToken?: string } }>("/api/overstap/zelf", async (req, reply) => {
      try { const r = await overstap.zelf(cfg(), req.body ?? {}); vault.save(); return r; } catch (e) { return oFail(reply, e); }
    });
    s.post<{ Body: { confirm?: boolean } }>("/api/overstap/nu", async (req, reply) => {
      try { return overstap.overzetten(oDeps(), req.body?.confirm); } catch (e) { return oFail(reply, e); }
    });
    s.post("/api/overstap/terug", async (_req, reply) => {
      try { return overstap.terug(oDeps()); } catch (e) { return oFail(reply, e); }
    });
    s.post("/api/overstap/stoppen", async (_req, reply) => {
      try { return await overstap.stoppen(oDeps()); } catch (e) { return oFail(reply, e); }
    });

    // ── Aanbieder worden: je eigen Eigen Cloud Dienst opzetten en bijhouden ──
    const aDeps = (): aanbieder.Deps => ({ save, serverOffers, storeOffers, dnsOffers });
    const aFail = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: (e as Error).message, ...((e as { steps?: unknown }).steps ? { steps: (e as { steps?: unknown }).steps } : {}) });
    s.get("/api/aanbieder", async () => aanbieder.view(cfg(), aDeps()));
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
    s.post<{ Body: { aan?: boolean; zone?: string; desecToken?: string; host?: string } }>("/api/aanbieder/adressen", async (req, reply) => {
      try { const r = await aanbieder.saveAdressen(cfg(), req.body ?? {}); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post("/api/aanbieder/toepassen", async (_req, reply) => {
      try { return await aanbieder.toepassen(cfg(), aDeps()); } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: { provider?: string; region?: string; fields?: Record<string, unknown> } }>("/api/aanbieder/server", async (req, reply) => {
      try { const r = await aanbieder.saveServer(cfg(), req.body ?? {}, aDeps()); save(); return r; } catch (e) { return aFail(reply, e); }
    });
    s.post<{ Body: Record<string, string> }>("/api/aanbieder/backup", async (req, reply) => {
      try { const r = aanbieder.saveBackup(cfg(), req.body ?? {}, aDeps()); save(); return r; } catch (e) { return aFail(reply, e); }
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
    s.post<{ Body: { provider?: string; zone?: string; fields?: Record<string, unknown> } }>("/api/aanbieder/dns", async (req, reply) => {
      try { const r = await aanbieder.saveDns(cfg(), req.body ?? {}, aDeps()); save(); return r; } catch (e) { save(); return aFail(reply, e); }
    });
    s.post("/api/aanbieder/hersteltest", async (_req, reply) => {
      try { return await aanbieder.hersteltest(cfg(), aDeps()); } catch (e) { return aFail(reply, e); }
    });
    // Kluis alleen voor een Dienst: er komt toch een eigen cloud bij (de stap "Jij en je adres", zonder nieuwe kluis).
    s.post<{ Body: CloudInput }>("/api/setup/cloud", async (req, reply) => {
      const c = cfg();
      if (!c.console.alleenDienst) return reply.code(409).send({ error: "Je hebt al een eigen cloud" });
      let n: AdminConfig;
      try { n = cloudConfig(req.body ?? ({} as CloudInput)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      Object.assign(c, { cluster: n.cluster, domain: n.domain, appEnv: n.appEnv });
      Object.assign(c.console, { appPasswordHash: n.console.appPasswordHash, alertEmail: n.console.alertEmail, domainMode: n.console.domainMode, step: c.console.keyConfirmed || c.console.keyCheckLater ? "regelen" : "sleutel" });
      delete c.console.alleenDienst;
      save();
      return { ok: true, step: c.console.step };
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

    // ── Kosten en budget (zie costs.ts) ──
    s.get<{ Querystring: { fresh?: string } }>("/api/costs", async (req) => {
      const c = cfg();
      const st = await clusterStatus(c, c.console.firstLaunch?.clusterUrl ? [c.console.firstLaunch.clusterUrl] : []);
      return costs.view(c, st, { stores: storeOffers(), nameOf: (id) => getAdapter(id)?.name ?? id }, req.query.fresh === "1");
    });
    s.post<{ Body: { budget?: unknown } }>("/api/costs/budget", async (req, reply) => {
      try { const r = costs.setBudget(cfg(), req.body?.budget); save(); return r; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
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

async function startLaunch(c: AdminConfig, first: { provider: string; region: string; size: string; country?: string }, term: number, adminOverride?: { settings: Record<string, string> }) {
  const offer = serverOffers().find((o) => o.id === first.provider);
  const region = offer?.regions.find((r) => r.id === first.region);
  const gen = ++launchGen;
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
    const r = await provisionFirstNode(c, { ...first, term, initialSettings: term ? undefined : initialSettings, ...(adminOverride ? { adminOverride } : {}) });
    setStep("server", "done", r.info.ipv4 ? `IP-adres ${r.info.ipv4}` : "");
    c.console.firstLaunch = { at: Date.now(), nodeId: r.nodeId, provider: first.provider, region: first.region, clusterUrl: r.clusterUrl, apiUrl: r.info.apiUrl };
    c.console.done = true;
    c.console.step = "klaar";
    vault.save();
    launch.appUrl = appUrl(c);
    const want = c.policy.minDataNodes + c.policy.witnesses;
    void followLaunch(r.clusterUrl, r.info.apiUrl ?? null, want, gen).catch((e) => { if (gen === launchGen) setStep("grow", "fail", (e as Error).message); });
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
    { id: "sleutel", label: "Herstelsleutel bewaard", ok: c.console.keyConfirmed, required: !c.console.keyCheckLater || !!c.console.keyConfirmed },
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
