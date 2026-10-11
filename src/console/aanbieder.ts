/**
 * Aanbieder worden: je eigen Eigen Cloud Dienst (src/broker) opzetten en bijhouden vanuit de console, zonder terminal.
 * Stappen: bedrijf → accounts (live gecontroleerd) → adres (dienst.<domein>, je cloud publiceert het A-record) →
 * opzetten (project "eigen-cloud-dienst" bij Scaleway, back-upbucket met eigen sleutel, server met cloud-init) → klaar
 * (status, opnieuw opzetten, verwijderen). De toestand staat in de kluis onder console.aanbieder.
 * De Android-app heeft hetzelfde in Java (android/core Aanbieder.java); de JSON van de routes is gelijk.
 */
import crypto from "node:crypto";
import dnsp from "node:dns/promises";
import nodemailer from "nodemailer";
import type { AdminConfig } from "./vault.js";
import { DESEC_URL } from "./extras.js";
import { makeProvider, scwApi } from "../cluster/providers.js";
import { prepareStore, type StepResult } from "../cluster/admin.js";
import type { StoreConfig } from "../cluster/stores.js";
import { dienstUserData } from "../cluster/cloudinit.js";
import { deriveKey, randomKeyHex } from "../cluster/crypto.js";

export const MOLLIE_URL = () => (process.env.EIGEN_MOLLIE_URL ?? "https://api.mollie.com/v2").replace(/\/+$/, "");
export const OPENPROVIDER_URL = () => (process.env.EIGEN_OPENPROVIDER_URL ?? "https://api.openprovider.eu/v1beta").replace(/\/+$/, "");

export const PROJECT_NAME = "eigen-cloud-dienst";
export const SERVER_REGION = "nl-ams-1";
export const SERVER_SIZE = "DEV1-S";
export const BACKUP_REGION = "fr-par";
const STEPS = ["bedrijf", "accounts", "adres", "opzetten", "klaar"] as const;
type Step = (typeof STEPS)[number];

export interface AanbiederState {
  step: Step;
  company?: { name: string; address: string[]; kvk: string; vat: string; email: string };
  url?: string;
  accounts?: { scalewaySecretKey?: string; scalewayOrgId?: string; mollieKey?: string; desecToken?: string; smtpUrl?: string; openproviderUser?: string; openproviderPass?: string; adresUrl?: string; mailFrom?: string };
  checked?: Record<string, boolean>;
  projectId?: string;
  backup?: { endpoint: string; region: string; bucket?: string; accessKey?: string; secretKey?: string; applicationId?: string; policyId?: string };
  server?: { provider: "scaleway"; region: string; size: string; serverId: string; ipv4?: string; ipv6?: string; createdAt: number; userDataCleared?: boolean } | null;
  /** BROKER_SECRET van de Dienst (64 hex); de back-ups zijn daarmee versleuteld. */
  secret?: string;
  createdAt?: number;
  lastHealth?: Health | null;
  removed?: boolean;
  /** Vervangen servers die nog weg moeten. */
  retired?: string[];
  /** Vorige adressen (subnaam onder het domein) waarvan de cloud het record moet weghalen. */
  dnsRemove?: string[];
}
export interface Health { at: number; reachable: boolean; version: string | null; uptime: number | null; lastBackupAt: number | null; backup: string | null; closing: boolean; error?: string }

/** Te vervangen in tests: hoe de console de Dienst bereikt en DNS opzoekt. */
export const aanbiederNet = {
  reach: (url: string) => url,
  resolve4: (host: string) => { const r = new dnsp.Resolver({ timeout: 3000, tries: 1 }); return r.resolve4(host); },
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mask = (v?: string) => (v ? "•".repeat(8) + v.slice(-4) : "");
const fail = (msg: string, steps?: StepResult[]) => Object.assign(new Error(msg), { steps });

function state(c: AdminConfig): AanbiederState {
  const con = c.console as AdminConfig["console"] & { aanbieder?: AanbiederState };
  return (con.aanbieder ??= { step: "bedrijf" });
}
const existing = (c: AdminConfig) => (c.console as { aanbieder?: AanbiederState }).aanbieder ?? null;

/** De mailserver van de Dienst: zelf ingevuld, anders de relay van je eigen cloud. */
const smtpOf = (c: AdminConfig, a: AanbiederState) => a.accounts?.smtpUrl || c.console.mailRelay || "";
const mailFromOf = (c: AdminConfig, a: AanbiederState) => a.accounts?.mailFrom || `noreply@${c.domain ?? "localhost"}`;

/** "smtp://gebruiker@host:587", zonder wachtwoord. */
export function smtpDisplay(url: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? decodeURIComponent(u.username) + "@" : ""}${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch { return null; }
}

function hostOf(url?: string) {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}

/** Waar het adres van de Dienst naartoe wijst en of je cloud dat record zelf publiceert. */
export function dnsInfo(c: AdminConfig) {
  const a = existing(c);
  const host = hostOf(a?.url);
  const d = c.domain ?? "";
  const sub = host && d && host.endsWith(`.${d}`) ? host.slice(0, -(d.length + 1)) : null;
  return { host, sub, managed: !!sub && c.dns.length > 0 && !!c.console.done, value: a?.server?.ipv4 ?? null };
}

const accountsReady = (a: AanbiederState) => ["scaleway", "mollie", "desec", "smtp"].every((k) => a.checked?.[k] === true) && a.checked?.adres !== false;
const companyReady = (a: AanbiederState) => !!(a.company?.name && a.company.email);

/** Wat de console mag laten zien: geen geheimen, alleen de laatste 4 tekens. */
export function view(c: AdminConfig) {
  const a = existing(c);
  const defaultUrl = c.domain ? `https://dienst.${c.domain}` : null;
  if (!a) return { started: false, step: null, defaultUrl, defaultEmail: c.console.alertEmail || null };
  const acc = a.accounts ?? {};
  const smtp = smtpOf(c, a);
  return {
    started: true,
    step: a.step,
    defaultUrl,
    defaultEmail: c.console.alertEmail || null,
    company: a.company ?? null,
    url: a.url ?? null,
    accounts: {
      scalewayOrgId: acc.scalewayOrgId ?? "", scalewaySecretKey: mask(acc.scalewaySecretKey),
      mollieKey: mask(acc.mollieKey), mollieMode: acc.mollieKey ? (acc.mollieKey.startsWith("live_") ? "live" : "test") : null,
      desecToken: mask(acc.desecToken),
      smtp: smtpDisplay(smtp), smtpFromCloud: !acc.smtpUrl && !!c.console.mailRelay,
      openproviderUser: acc.openproviderUser ?? "", openproviderPass: mask(acc.openproviderPass),
      adresUrl: acc.adresUrl ?? "", mailFrom: mailFromOf(c, a),
    },
    checked: a.checked ?? {},
    ready: { bedrijf: companyReady(a), accounts: accountsReady(a), adres: !!a.url },
    server: a.server ? { region: a.server.region, size: a.server.size, serverId: a.server.serverId, ipv4: a.server.ipv4 ?? null, ipv6: a.server.ipv6 ?? null, createdAt: a.server.createdAt } : null,
    backup: a.backup?.bucket ? { bucket: a.backup.bucket, region: a.backup.region } : null,
    dns: dnsInfo(c),
    createdAt: a.createdAt ?? null,
    lastHealth: a.lastHealth ?? null,
    removed: !!a.removed,
    retired: (a.retired ?? []).length,
    beheerUrl: a.url ? `${a.url}/beheer` : null,
  };
}

/** Vorige/Volgende in de stappen. */
export function setStep(c: AdminConfig, step: string) {
  if (step === "uit") {
    // Stoppen met de stappen: alles vergeten, zolang er geen Dienst draait (of draaide).
    const cur = existing(c);
    if (cur?.server || cur?.removed) throw new Error("Je Dienst bestaat al; verwijderen kan bij Je dienst");
    delete (c.console as { aanbieder?: AanbiederState }).aanbieder;
    return { ok: true, step: null };
  }
  if (!STEPS.includes(step as Step)) throw new Error("Onbekende stap");
  const a = state(c);
  if (step === "klaar" && !a.server && !a.removed) throw new Error("Zet de Dienst eerst op");
  a.step = step as Step;
  return { ok: true, step: a.step };
}

// ───────── 1. Bedrijf ─────────

export function saveBedrijf(c: AdminConfig, b: { name?: string; address?: string | string[]; kvk?: string; vat?: string; email?: string }) {
  const name = String(b.name ?? "").trim();
  if (name.length < 2 || name.length > 100 || /[\r\n]/.test(name)) throw new Error("Vul de naam van je bedrijf in");
  const raw = Array.isArray(b.address) ? b.address.map(String) : String(b.address ?? "").split(/\r?\n/);
  const address = raw.map((l) => l.trim()).filter(Boolean);
  if (address.length > 5 || address.some((l) => l.length > 100)) throw new Error("Het adres mag hooguit 5 regels hebben");
  const kvk = String(b.kvk ?? "").replace(/\s/g, "");
  if (kvk && !/^\d{8}$/.test(kvk)) throw new Error("Een KvK-nummer heeft 8 cijfers");
  const vat = String(b.vat ?? "").replace(/[\s.]/g, "").toUpperCase();
  if (vat && !/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(vat)) throw new Error("Vul het btw-nummer in zoals NL001234567B01");
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Vul het e-mailadres van de eigenaar in");
  const a = state(c);
  a.company = { name, address, kvk, vat, email };
  if (a.step === "bedrijf") a.step = "accounts";
  return { ok: true, step: a.step };
}

// ───────── 2. Accounts ─────────

type Check = { id: string; label: string; ok: boolean; detail: string };
const ACCOUNT_FIELDS = ["scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "smtpUrl", "openproviderUser", "openproviderPass", "adresUrl", "mailFrom"] as const;

async function http(url: string, init: RequestInit = {}, ms = 15_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { /* geen JSON */ }
  return { status: r.status, ok: r.ok, json: j };
}

async function checkScaleway(key: string, org: string): Promise<Check> {
  const c = { id: "scaleway", label: "Scaleway" };
  if (!UUID.test(key) || !UUID.test(org)) return { ...c, ok: false, detail: "Vul de geheime sleutel en het organisatie-ID in (allebei 8-4-4-4-12 tekens)" };
  try {
    const r = await http(`${scwApi()}/account/v3/projects?organization_id=${encodeURIComponent(org)}&page_size=1`, { headers: { "x-auth-token": key } });
    if (r.status === 401) return { ...c, ok: false, detail: "Scaleway accepteert deze sleutel niet" };
    if (r.status === 403) return { ...c, ok: false, detail: "Deze sleutel mag geen projecten beheren. Geef hem de rechten uit de uitleg (ProjectManager, IAMManager, InstancesFullAccess, ObjectStorageFullAccess)" };
    if (!r.ok) return { ...c, ok: false, detail: `Scaleway antwoordt ${r.status}` };
    return { ...c, ok: true, detail: "Sleutel werkt voor je organisatie" };
  } catch { return { ...c, ok: false, detail: "Scaleway is niet bereikbaar" }; }
}

async function checkMollie(key: string): Promise<Check> {
  const c = { id: "mollie", label: "Mollie" };
  if (!/^(test|live)_[A-Za-z0-9]+$/.test(key)) return { ...c, ok: false, detail: "Een Mollie-sleutel begint met test_ of live_" };
  try {
    const r = await http(`${MOLLIE_URL()}/methods`, { headers: { authorization: `Bearer ${key}` } });
    if (r.status === 401 || r.status === 403) return { ...c, ok: false, detail: "Mollie accepteert deze sleutel niet" };
    if (!r.ok) return { ...c, ok: false, detail: `Mollie antwoordt ${r.status}` };
    return { ...c, ok: true, detail: key.startsWith("test_") ? "Testsleutel: betalingen zijn nep. Zet er later een live_-sleutel in." : "Live: echte betalingen" };
  } catch { return { ...c, ok: false, detail: "Mollie is niet bereikbaar" }; }
}

async function checkDesec(token: string): Promise<Check> {
  const c = { id: "desec", label: "deSEC" };
  if (!token) return { ...c, ok: false, detail: "Vul je deSEC-token in" };
  try {
    const r = await http(`${DESEC_URL()}/domains/`, { headers: { authorization: `Token ${token}` } });
    if (r.status === 401 || r.status === 403) return { ...c, ok: false, detail: "deSEC accepteert dit token niet" };
    if (!r.ok) return { ...c, ok: false, detail: `deSEC antwoordt ${r.status}` };
    return { ...c, ok: true, detail: "Token werkt" };
  } catch { return { ...c, ok: false, detail: "deSEC is niet bereikbaar" }; }
}

async function checkSmtp(url: string): Promise<Check> {
  const c = { id: "smtp", label: "Mail versturen" };
  if (!url) return { ...c, ok: false, detail: "Vul een mailserver in, bijv. smtp://gebruiker:wachtwoord@smtp.tem.scaleway.com:587" };
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error();
    host = u.hostname;
  } catch { return { ...c, ok: false, detail: "Dat is geen geldig adres; het begint met smtp:// of smtps://" }; }
  try {
    await nodemailer.createTransport(url, { connectionTimeout: 10_000 } as never).verify();
    return { ...c, ok: true, detail: `Mail versturen werkt (via ${host})` };
  } catch (e) { return { ...c, ok: false, detail: `Verbinden met ${host} lukt niet: ${(e as Error).message}` }; }
}

async function checkOpenprovider(user: string, pass: string): Promise<Check> {
  const c = { id: "openprovider", label: "Openprovider (optioneel)" };
  if (!user || !pass) return { ...c, ok: false, detail: "Vul gebruikersnaam én wachtwoord in" };
  try {
    const r = await http(`${OPENPROVIDER_URL()}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: pass, ip: "0.0.0.0" }) });
    if (r.ok && r.json?.data?.token) return { ...c, ok: true, detail: "Inloggen werkt: klanten kunnen een domein kopen" };
    return { ...c, ok: false, detail: "Openprovider laat deze gebruiker niet inloggen (vanaf dit apparaat). Controleer ook de IP-lijst; de Dienst kan dit later nog eens proberen." };
  } catch { return { ...c, ok: false, detail: "Openprovider is niet bereikbaar" }; }
}

function checkAdres(url: string): Check {
  const c = { id: "adres", label: "Gratis adressen (optioneel)" };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.search) throw new Error();
    return { ...c, ok: true, detail: `Gratis adressen via ${u.hostname}` };
  } catch { return { ...c, ok: false, detail: "Het adres van de adressendienst begint met https://" }; }
}

/**
 * Sleutels bewaren en live controleren. Een gemaskeerde waarde ("••••…") laat de bewaarde staan, een lege waarde wist
 * hem. Openprovider is optioneel en houdt de volgende stap niet tegen (het IP-adres van de server moet daar op de lijst).
 */
export async function saveAccounts(c: AdminConfig, b: Record<string, unknown>) {
  const a = state(c);
  const acc = { ...(a.accounts ?? {}) } as Record<string, string | undefined>;
  for (const f of ACCOUNT_FIELDS) {
    if (!(f in b) || b[f] === undefined || b[f] === null) continue;
    let v = String(b[f]).trim();
    if (v.startsWith("••")) continue;
    if (f === "scalewaySecretKey" || f === "scalewayOrgId") v = v.replace(/^["']|["']$/g, "").toLowerCase();
    if (/[\r\n]/.test(v)) throw new Error("Een sleutel past op één regel");
    if (v) acc[f] = v; else delete acc[f];
  }
  if (acc.mailFrom && !EMAIL.test(acc.mailFrom)) throw new Error("Het afzenderadres is geen geldig e-mailadres");
  a.accounts = acc;
  const checks: Check[] = await Promise.all([
    checkScaleway(acc.scalewaySecretKey ?? "", acc.scalewayOrgId ?? ""),
    checkMollie(acc.mollieKey ?? ""),
    checkDesec(acc.desecToken ?? ""),
    checkSmtp(smtpOf(c, a)),
  ]);
  if (acc.openproviderUser || acc.openproviderPass) checks.push(await checkOpenprovider(acc.openproviderUser ?? "", acc.openproviderPass ?? ""));
  if (acc.adresUrl) checks.push(checkAdres(acc.adresUrl));
  a.checked = Object.fromEntries(checks.map((x) => [x.id, x.ok]));
  const ready = accountsReady(a);
  if (ready && a.step === "accounts") a.step = "adres";
  return { ok: ready, checks, step: a.step };
}

// ───────── 3. Adres ─────────

export function cleanUrl(raw: string) {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z]+:\/\//.test(v)) v = `https://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error("Dat is geen geldig adres"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port || (u.pathname !== "/" && u.pathname !== "")) throw new Error("Vul alleen een adres in, zoals https://dienst.vanes.nl");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname)) throw new Error("Vul een adres in met een domeinnaam, zoals dienst.vanes.nl");
  return `https://${u.hostname}`;
}

export function saveAdres(c: AdminConfig, b: { url?: string }) {
  const a = state(c);
  const def = c.domain ? `https://dienst.${c.domain}` : "";
  const url = cleanUrl(b.url || def);
  if (a.url && a.url !== url && a.server) {
    // Het oude adres weghalen uit de DNS van je cloud (alleen als de cloud het beheerde).
    const old = dnsInfo(c).sub;
    if (old) a.dnsRemove = [...new Set([...(a.dnsRemove ?? []), old])];
  }
  a.url = url;
  a.dnsRemove = (a.dnsRemove ?? []).filter((x) => x !== dnsInfo(c).sub);
  if (!a.dnsRemove.length) delete a.dnsRemove;
  if (a.step === "adres") a.step = "opzetten";
  return { ok: true, url, step: a.step, dns: dnsInfo(c), pending: !!a.server };
}

// ───────── 4. Opzetten ─────────

async function scw(method: string, p: string, key: string, body?: unknown) {
  let r;
  try { r = await http(`${scwApi()}${p}`, { method, headers: { "x-auth-token": key, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, 30_000); }
  catch { throw new Error("Scaleway is niet bereikbaar"); }
  if (r.status === 401) throw new Error("Scaleway accepteert de sleutel niet meer");
  if (r.status === 403) throw new Error(`De sleutel mag dit niet bij Scaleway (${String(r.json?.message ?? "geen toegang")})`);
  if (!r.ok) throw new Error(`Scaleway antwoordt ${r.status}: ${String(r.json?.message ?? "").slice(0, 160)}`);
  return r.json as any;
}

/** De omgeving van de Dienst (dienst.env), in vaste volgorde. Alleen voor de user-data; nooit in een antwoord. */
export function dienstEnv(c: AdminConfig, a: AanbiederState): [string, string][] {
  const acc = a.accounts ?? {}, co = a.company!;
  const brand = co.name.replace(/[<>"]/g, "").trim();
  const env: [string, string][] = [
    ["BROKER_PUBLIC_URL", a.url!],
    ["BROKER_SECRET", a.secret!],
    ["BROKER_OWNER_EMAIL", co.email],
    ["BROKER_ADMIN_EMAIL", co.email],
    ["BROKER_BRAND_NAME", co.name],
    ["BROKER_MAIL_FROM", `${brand} <${mailFromOf(c, a)}>`],
    ["BROKER_COMPANY_NAME", co.name],
    ["BROKER_COMPANY_ADDRESS", co.address.join("\\n")],
  ];
  if (co.kvk) env.push(["BROKER_COMPANY_KVK", co.kvk]);
  if (co.vat) env.push(["BROKER_COMPANY_VAT", co.vat]);
  env.push(["MOLLIE_API_KEY", acc.mollieKey!], ["DESEC_TOKEN", acc.desecToken!], ["SCW_SECRET_KEY", acc.scalewaySecretKey!], ["SCW_ORGANIZATION_ID", acc.scalewayOrgId!], ["BROKER_SMTP_URL", smtpOf(c, a)]);
  if (acc.openproviderUser && acc.openproviderPass) env.push(["OPENPROVIDER_USERNAME", acc.openproviderUser], ["OPENPROVIDER_PASSWORD", acc.openproviderPass]);
  if (acc.adresUrl) env.push(["BROKER_ADRES_URL", acc.adresUrl]);
  const bk = a.backup!;
  env.push(["BROKER_BACKUP_ENDPOINT", bk.endpoint], ["BROKER_BACKUP_REGION", bk.region], ["BROKER_BACKUP_BUCKET", bk.bucket!], ["BROKER_BACKUP_ACCESS_KEY", bk.accessKey!], ["BROKER_BACKUP_SECRET_KEY", bk.secretKey!]);
  return env;
}

/** Het opstartscript voor de server van de Dienst (met dezelfde images als je cloud). */
export function serverUserData(c: AdminConfig, a: AanbiederState) {
  const img = c.image as { ref?: string; caddyRef?: string };
  const appImage = img.ref || "ghcr.io/renevanes/eigen-cloud:latest";
  const caddyImage = img.caddyRef || "ghcr.io/renevanes/eigen-caddy:latest";
  const latest = (r: string) => r.replace(/@sha256:[0-9a-f]{64}$/, ":latest");
  return dienstUserData({ host: hostOf(a.url)!, email: a.company!.email, env: dienstEnv(c, a), appImage, caddyImage, appRef: latest(appImage), caddyRef: latest(caddyImage) });
}

/** Token voor POST /v1/status/handover (zie src/broker/backup.ts). */
export const beheerToken = (secretHex: string) => deriveKey(Buffer.from(secretHex, "hex"), "dienst-beheer").toString("hex");

/** De huidige server een laatste back-up laten maken; daarna schrijft hij niets meer. */
async function handover(a: AanbiederState): Promise<{ ok: boolean; detail: string }> {
  if (!a.url || !a.secret) return { ok: false, detail: "Geen adres" };
  try {
    const r = await http(`${aanbiederNet.reach(a.url)}/v1/status/handover`, { method: "POST", headers: { authorization: `Beheer ${beheerToken(a.secret)}` } }, 120_000);
    if (r.ok) return { ok: true, detail: r.json?.lastBackupAt ? "Alles staat in de back-up" : "Geen back-up ingesteld" };
    return { ok: false, detail: `De server antwoordt ${r.status}; de nieuwe server krijgt de laatste back-up van het afgelopen uur` };
  } catch { return { ok: false, detail: "De server is niet bereikbaar; de nieuwe server krijgt de laatste back-up" }; }
}

export interface Deps {
  /** Endpoint van Scaleway Object Storage in een regio (in tests een nep-S3). */
  storeEndpoint: (region: string) => string;
  save: () => void;
  /** Wachten tussen pogingen (een nieuwe sleutel werkt bij Scaleway soms pas na een paar seconden). */
  sleep?: (ms: number) => Promise<void>;
}

async function ensureProject(a: AanbiederState, key: string, org: string) {
  if (a.projectId) return a.projectId;
  const list = await scw("GET", `/account/v3/projects?organization_id=${encodeURIComponent(org)}&name=${PROJECT_NAME}`, key);
  let id = (list?.projects ?? []).find((p: { name: string }) => p.name === PROJECT_NAME)?.id as string | undefined;
  if (!id) id = (await scw("POST", "/account/v3/projects", key, { name: PROJECT_NAME, organization_id: org, description: "Eigen Cloud Dienst: server en back-ups" }))?.id;
  if (!id) throw new Error("Scaleway gaf geen project-id terug");
  return (a.projectId = id);
}

/** Een eigen sleutel voor de back-ups: alleen Object Storage, alleen in het project van de Dienst. */
async function ensureBackupKey(a: AanbiederState, key: string, org: string, deps: Deps) {
  const bk = (a.backup ??= { endpoint: deps.storeEndpoint(BACKUP_REGION), region: BACKUP_REGION });
  if (bk.accessKey && bk.secretKey) return;
  const name = `${PROJECT_NAME}-backup`;
  if (!bk.applicationId) {
    const list = await scw("GET", `/iam/v1alpha1/applications?organization_id=${encodeURIComponent(org)}&name=${name}`, key);
    bk.applicationId = (list?.applications ?? []).find((x: { name: string }) => x.name === name)?.id
      ?? (await scw("POST", "/iam/v1alpha1/applications", key, { name, organization_id: org, description: "Back-ups van de Eigen Cloud Dienst" }))?.id;
    if (!bk.applicationId) throw new Error("Scaleway gaf geen applicatie-id terug");
    deps.save();
  }
  if (!bk.policyId) {
    const list = await scw("GET", `/iam/v1alpha1/policies?organization_id=${encodeURIComponent(org)}&application_id=${bk.applicationId}`, key);
    bk.policyId = (list?.policies ?? [])[0]?.id
      ?? (await scw("POST", "/iam/v1alpha1/policies", key, { name, organization_id: org, application_id: bk.applicationId, description: `Alleen opslag in project ${a.projectId}`, rules: [{ permission_set_names: ["ObjectStorageFullAccess"], project_ids: [a.projectId] }] }))?.id;
    if (!bk.policyId) throw new Error("Scaleway gaf geen policy-id terug");
    deps.save();
  }
  const k = await scw("POST", "/iam/v1alpha1/api-keys", key, { application_id: bk.applicationId, default_project_id: a.projectId, description: "Back-ups van de Eigen Cloud Dienst" });
  if (!k?.access_key || !k?.secret_key) throw new Error("Scaleway gaf geen sleutel terug");
  bk.accessKey = k.access_key;
  bk.secretKey = k.secret_key;
  deps.save();
}

async function ensureBucket(c: AdminConfig, a: AanbiederState, deps: Deps) {
  const bk = a.backup!;
  const bucket = bk.bucket ?? `${c.cluster}-dienst-backup-${crypto.randomBytes(3).toString("hex")}`;
  const store: StoreConfig = { name: "dienst-backup", type: "s3", purpose: "backup", country: "FR", endpoint: bk.endpoint, region: bk.region, bucket, accessKey: bk.accessKey, secretKey: bk.secretKey };
  let steps: StepResult[] = [];
  for (let i = 0; i < 4; i++) {
    steps = await prepareStore(store);
    if (steps.every((x) => x.ok || /Versiebeheer|Onveranderbaar/.test(x.label))) {
      bk.bucket = bucket;
      deps.save();
      return;
    }
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(4000);
  }
  throw new Error(`Back-upopslag klaarzetten lukte niet: ${steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
}

const provider = (a: AanbiederState) => makeProvider("scaleway", { secretKey: a.accounts!.scalewaySecretKey!, projectId: a.projectId! });

/**
 * Opzetten, of (als er al een server is) opnieuw opzetten: de huidige server maakt een laatste back-up, er komt een
 * nieuwe server die die back-up bij de eerste start terugzet, het adres wijst naar de nieuwe, de oude gaat weg.
 * Zo werken ook gewijzigde instellingen: die staan in de user-data van de nieuwe server.
 */
export async function opzetten(c: AdminConfig, deps: Deps) {
  const a = state(c);
  if (!companyReady(a)) throw new Error("Vul eerst je bedrijfsgegevens in");
  if (!accountsReady(a)) throw new Error("Controleer eerst je accounts (stap 2)");
  if (!a.url) throw new Error("Kies eerst het adres van je Dienst");
  const key = a.accounts!.scalewaySecretKey!, org = a.accounts!.scalewayOrgId!;
  const steps: StepResult[] = [];
  const replace = !!a.server?.serverId;
  try {
    await ensureProject(a, key, org);
    deps.save();
    steps.push({ label: `Project ${PROJECT_NAME} bij Scaleway`, ok: true });
    await ensureBackupKey(a, key, org, deps);
    steps.push({ label: "Sleutel voor de back-ups (werkt alleen in dit project)", ok: true });
    await ensureBucket(c, a, deps);
    steps.push({ label: "Back-upopslag in Parijs, 30 dagen niet te wissen", ok: true, detail: a.backup!.bucket });
    a.secret ??= randomKeyHex();
    deps.save();
    if (replace) {
      const h = await handover(a);
      steps.push({ label: "Laatste back-up van de huidige server", ok: h.ok, detail: h.detail });
    }
    const nodeId = `dienst-${crypto.randomBytes(3).toString("hex")}`;
    const info = await provider(a).create({ cluster: PROJECT_NAME, nodeId, kind: "data", region: SERVER_REGION, size: SERVER_SIZE, userData: serverUserData(c, a) });
    const old = a.server;
    a.server = { provider: "scaleway", region: SERVER_REGION, size: SERVER_SIZE, serverId: info.serverId, ...(info.ipv4 ? { ipv4: info.ipv4 } : {}), ...(info.ipv6 ? { ipv6: info.ipv6 } : {}), createdAt: Date.now() };
    a.removed = false;
    a.createdAt ??= Date.now();
    a.lastHealth = null;
    a.step = "klaar";
    if (old?.serverId) a.retired = [...(a.retired ?? []), old.serverId];
    deps.save();
    steps.push({ label: `Server in Amsterdam (${SERVER_SIZE})`, ok: true, detail: info.ipv4 ? `IP-adres ${info.ipv4}` : undefined });
    if (old?.serverId) steps.push({ label: "De vorige server wordt opgeruimd", ok: true });
    const d = dnsInfo(c);
    steps.push(d.managed
      ? { label: `${d.host} wijst naar ${info.ipv4}`, ok: true, detail: "Je cloud zet dit record zelf in je DNS" }
      : { label: `Zet bij je DNS een A-record: ${d.host} → ${info.ipv4}`, ok: true });
    if (a.retired?.length) void cleanupRetired(c, deps);
    return { ok: true, replaced: replace, steps, server: view(c).server };
  } catch (e) {
    deps.save();
    throw fail((e as Error).message, steps);
  }
}

let cleaning: Promise<unknown> | null = null;
/** Vervangen of verwijderde servers weghalen bij Scaleway (op de achtergrond; mislukt het, dan de volgende keer). */
export function cleanupRetired(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.retired?.length || cleaning) return cleaning ?? Promise.resolve();
  cleaning = (async () => {
    // Ook servers die tijdens het opruimen bij de lijst komen (bijv. verwijderen vlak na opnieuw opzetten).
    const tried = new Set<string>();
    for (let id = a.retired?.[0]; id !== undefined; id = (a.retired ?? []).find((x) => !tried.has(x))) {
      tried.add(id);
      try {
        await provider(a).destroy(id);
        a.retired = a.retired!.filter((x) => x !== id);
        if (!a.retired.length) delete a.retired;
        deps.save();
      } catch { /* volgende keer */ }
    }
  })().finally(() => { cleaning = null; });
  return cleaning;
}

// ───────── 5. Klaar: status, verwijderen ─────────

export async function status(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.server || !a.url) return { reachable: false, server: false, removed: !!a?.removed };
  let h: Health;
  try {
    const r = await http(`${aanbiederNet.reach(a.url)}/v1/status`, {}, 8000);
    if (!r.ok || !r.json) throw new Error(`De Dienst antwoordt ${r.status}`);
    h = { at: Date.now(), reachable: true, version: r.json.version ?? null, uptime: r.json.uptime ?? null, lastBackupAt: r.json.lastBackupAt ?? null, backup: r.json.backup ?? null, closing: !!r.json.closing };
  } catch (e) {
    const m = (e as Error).message;
    h = { at: Date.now(), reachable: false, version: null, uptime: null, lastBackupAt: a.lastHealth?.lastBackupAt ?? null, backup: null, closing: false, error: /antwoordt/.test(m) ? m : "Nog niet bereikbaar" };
  }
  a.lastHealth = h;
  // De user-data bevat de geheimen van de Dienst: weghalen bij Scaleway zodra de server draait.
  if (h.reachable && !a.server.userDataCleared) {
    const [zone, id] = a.server.serverId.split("/");
    try {
      const r = await http(`${scwApi()}/instance/v1/zones/${zone}/servers/${id}/user_data/cloud-init`, { method: "DELETE", headers: { "x-auth-token": a.accounts?.scalewaySecretKey ?? "" } });
      if (r.ok || r.status === 404) a.server.userDataCleared = true;
    } catch { /* volgende keer */ }
  }
  const host = hostOf(a.url)!;
  const have = (await aanbiederNet.resolve4(host).catch(() => [] as string[])).sort();
  deps.save();
  void cleanupRetired(c, deps);
  return { ...h, server: true, removed: false, dns: { host, want: a.server.ipv4 ?? null, have, ok: !!a.server.ipv4 && have.includes(a.server.ipv4) }, retired: (a.retired ?? []).length };
}

/** De server weghalen. De back-ups (en de sleutel ervan) blijven, zodat "Opnieuw opzetten" alles terugzet. */
export async function verwijderen(c: AdminConfig, b: { confirm?: string }, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.server) throw new Error("Er draait geen Dienst");
  const host = hostOf(a.url);
  if (String(b.confirm ?? "").trim().toLowerCase() !== host) throw new Error(`Typ ${host} om te bevestigen`);
  const h = await handover(a);
  a.retired = [...(a.retired ?? []), a.server.serverId];
  a.server = null;
  a.removed = true;
  a.lastHealth = null;
  a.step = "klaar";
  deps.save();
  void cleanupRetired(c, deps);
  return { ok: true, finalBackup: h.ok, detail: h.detail, bucket: a.backup?.bucket ?? null, pending: (a.retired ?? []).length };
}
