/**
 * Alles regelen vanuit de console, zonder zelf accounts aan te maken:
 *  - gratis: een deSEC-account (open source, non-profit, Berlijn) met desgewenst een gratis naam.dedyn.io;
 *  - betaald: de Eigen Cloud Dienst (src/broker), die domein, servers, opslag en mail-relay centraal regelt.
 * De Android-app heeft dezelfde stappen in Java (android/core ConsoleApi).
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type { AdminConfig } from "./vault.js";
import { DEFAULT_POLICY, type Placement } from "../cluster/config.js";
import { temRecords, subnameOf } from "../tem.js";
import { scwApi } from "../cluster/providers.js";

export const DESEC_URL = () => (process.env.EIGEN_DESEC_URL ?? "https://desec.io/api/v1").replace(/\/$/, "");
/** Uit EIGEN_DIENST_URL, anders uit het bestand DIENST_URL in de repository (eerste regel zonder #). */
export const DIENST_URL = () => (process.env.EIGEN_DIENST_URL || dienstFromFile()).replace(/\/$/, "");
let dienstFile: string | null = null;
function dienstFromFile() {
  if (dienstFile === null) {
    try {
      const f = new URL("../../DIENST_URL", import.meta.url);
      dienstFile = (readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "");
    } catch { dienstFile = ""; }
  }
  return dienstFile;
}

async function json(r: Response) {
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return { error: t.slice(0, 200) }; }
}

/** Foutmelding van deSEC leesbaar maken ({"captcha": ["…"]} of {"detail": "…"}). */
function desecError(j: unknown): string {
  if (!j || typeof j !== "object") return "onbekende fout";
  const o = j as Record<string, unknown>;
  if (o.captcha) return "De tekens uit het plaatje kloppen niet. Probeer het met een nieuw plaatje.";
  if (o.email) return `E-mailadres: ${[o.email].flat().join(" ")}`;
  if (o.domain) return `Naam: ${[o.domain].flat().join(" ")}`;
  if (typeof o.detail === "string") return o.detail;
  return JSON.stringify(j).slice(0, 200);
}

// ───────── deSEC ─────────

export async function desecCaptcha() {
  const r = await fetch(`${DESEC_URL()}/captcha/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = await json(r);
  if (!r.ok || !j?.id) throw new Error(`deSEC is niet bereikbaar (${r.status})`);
  return { id: j.id as string, challenge: j.challenge as string, kind: (j.kind as string) ?? "image" };
}

export async function desecRegister(c: AdminConfig, b: { captchaId: string; solution: string; email?: string }) {
  const email = (b.email || c.console.alertEmail || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new Error("Vul een e-mailadres in voor je deSEC-account");
  if (email.endsWith("@" + c.domain)) throw new Error("Gebruik een adres buiten je nieuwe domein; dat bestaat nog niet");
  const password = crypto.randomBytes(18).toString("base64url");
  const body: Record<string, unknown> = { email, password, captcha: { id: b.captchaId, solution: (b.solution ?? "").trim() }, outreach_preference: false };
  if (c.domain?.endsWith(".dedyn.io")) body.domain = c.domain;
  const r = await fetch(`${DESEC_URL()}/auth/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status !== 202 && !r.ok) throw new Error(desecError(await json(r)));
  c.console.desec = { email, password, at: Date.now() };
  return { ok: true, email };
}

/**
 * Na het klikken op de bevestigingslink: inloggen en een blijvend token maken. null = nog niet bevestigd.
 * (Inlogtokens van deSEC verlopen na een uur; het token voor je cloud niet.)
 */
export async function desecFinish(c: AdminConfig): Promise<string | null> {
  const acc = c.console.desec;
  if (!acc) throw new Error("Maak eerst het deSEC-account aan");
  const login = await fetch(`${DESEC_URL()}/auth/login/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: acc.email, password: acc.password }) });
  if (login.status === 403 || login.status === 401) {
    if (Date.now() - acc.at > 12 * 3_600_000) throw new Error("De bevestigingslink is verlopen. Maak het account opnieuw aan.");
    return null;
  }
  const lj = await json(login);
  if (!login.ok || !lj?.token) throw new Error(`Inloggen bij deSEC mislukt: ${desecError(lj)}`);
  const h = { authorization: `Token ${lj.token}`, "content-type": "application/json" };
  const tr = await fetch(`${DESEC_URL()}/auth/tokens/`, { method: "POST", headers: h, body: JSON.stringify({ name: `eigen-cloud ${c.domain}`, perm_manage_tokens: false }) });
  const tj = await json(tr);
  if (!tr.ok || !tj?.token) throw new Error(`Token maken bij deSEC mislukt: ${desecError(tj)}`);
  return tj.token as string;
}

// ───────── Domein wijzigen (vóór de start) ─────────

export function changeDomain(c: AdminConfig, domain: string, mode: "own" | "free" | "buy" | "sub") {
  const mailbox = (c.appEnv.MAIL_FROM ?? "").split("@")[0] || "post";
  if (c.console.alertEmail?.endsWith("@" + domain)) throw new Error("Je meldadres valt onder dit domein; kies eerst een ander meldadres");
  if (domain !== c.domain) {
    c.dns = [];
    delete c.console.dnsMode;
    delete c.console.nameservers;
  }
  c.domain = domain;
  c.appEnv = { ...c.appEnv, MAIL_DOMAINS: domain, MAIL_FROM: `${mailbox}@${domain}`, HOSTNAME_FQDN: `mail.${domain}` };
  c.console.domainMode = mode;
}

// ───────── Eigen Cloud Dienst ─────────

/** Bij welke aanbieder (dienst) hoort deze kluis: de gekozen aanbieder, anders de standaard van deze versie. */
export const baseOf = (c?: AdminConfig | null) => (c?.console.dienst?.url || DIENST_URL()).replace(/\/$/, "");

/** Verzoek aan een Dienst (aanbieder); fouten als Nederlandse melding. Ook voor overstappen (andere basis en sessie). */
export async function dienstCall(path: string, opts: { method?: string; body?: unknown; token?: string; base?: string } = {}) {
  return dienst(path, opts);
}

async function dienst(path: string, opts: { method?: string; body?: unknown; token?: string; base?: string } = {}) {
  const base = (opts.base || DIENST_URL()).replace(/\/$/, "");
  if (!base) throw new Error("Kies eerst een aanbieder");
  const r = await fetch(base + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new Error("De Eigen Cloud Dienst is niet bereikbaar"); });
  const j = await json(r);
  if (r.status === 401) throw new Error("Log opnieuw in bij de dienst");
  if (!r.ok) throw new Error(j?.error ?? `De dienst antwoordt ${r.status}`);
  return j;
}

export const dienstInfo = (base?: string) => dienst("/v1/info", { base });

export async function dienstCheck(name: string, base?: string) {
  const d = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Zonder punt: een gratis adres van de dienst (naam.<zone>); de dienst controleert de naam zelf.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(d)) throw new Error("Vul een domeinnaam in, zoals vanes.nl");
  return dienst(`/v1/domains/check?name=${encodeURIComponent(d)}`, { base });
}

export async function dienstLogin(c: AdminConfig, email: string) {
  const e = (email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new Error("Vul een geldig e-mailadres in");
  await dienst("/v1/auth/start", { body: { email: e }, base: baseOf(c) });
  c.console.dienst = { ...(c.console.dienst ?? {}), email: e };
  return { ok: true, email: e };
}

export async function dienstVerify(c: AdminConfig, code: string) {
  const email = c.console.dienst?.email;
  if (!email) throw new Error("Vul eerst je e-mailadres in");
  const r = await dienst("/v1/auth/verify", { body: { email, code: (code ?? "").replace(/\s/g, "") }, base: baseOf(c) });
  c.console.dienst = { ...(c.console.dienst ?? {}), token: r.token };
  return { ok: true, email };
}

export interface OrderInput {
  bundle: string;
  /** register = nieuw domein, transfer = verhuizen naar de dienst, own = blijft bij je eigen registrar */
  mode: "register" | "transfer" | "own" | "sub";
  authCode?: string;
  registrant?: Record<string, string>;
  acceptTerms: boolean;
}

export async function dienstOrder(c: AdminConfig, b: OrderInput) {
  const token = c.console.dienst?.token;
  if (!token) throw new Error("Log eerst in bij de dienst");
  if (!b.acceptTerms) throw new Error("Ga akkoord met de voorwaarden om verder te gaan");
  if (c.domain?.endsWith(".dedyn.io")) throw new Error("Bij de dienst hoort een eigen domeinnaam of een gratis adres van de dienst. Kies eerst een adres.");
  const mode = c.console.domainMode === "sub" ? "sub" : b.mode;
  const r = await dienst("/v1/orders", {
    token, base: baseOf(c),
    body: { bundle: b.bundle, domain: { mode, name: c.domain, authCode: b.authCode || undefined }, registrant: mode === "register" || mode === "transfer" ? b.registrant : undefined, acceptTerms: true, ...(c.console.dienst?.invite ? { invite: c.console.dienst.invite } : {}) },
  });
  c.console.dienst = { ...(c.console.dienst ?? {}), orderId: r.orderId, bundle: b.bundle, applied: false };
  return { ok: true, orderId: r.orderId, checkoutUrl: r.checkoutUrl };
}

export async function dienstStatus(c: AdminConfig) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) return { status: "none" };
  return dienst(`/v1/orders/${d.orderId}`, { token: d.token, base: baseOf(c) });
}

// ───────── Herstellen op een nieuw apparaat, via de dienst ─────────

export async function dienstStartLogin(email: string, base?: string) {
  const e = (email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new Error("Vul een geldig e-mailadres in");
  await dienst("/v1/auth/start", { body: { email: e }, base });
  return e;
}

export async function dienstFinishLogin(email: string, code: string, base?: string): Promise<string> {
  const r = await dienst("/v1/auth/verify", { body: { email, code: (code ?? "").replace(/\s/g, "") }, base });
  return r.token as string;
}

/** Het lopende abonnement en zijn pakket (voor herstellen: opslag en sleutels komen uit het pakket). */
export async function dienstOrderKit(token: string, base?: string) {
  const me = await dienst("/v1/me", { token, base });
  const orders = ((me.orders ?? []) as { id: string; status: string; bundle: string; createdAt?: number }[])
    .filter((o) => ["ready", "payment_problem", "cancelled"].includes(o.status))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (!orders.length) throw new Error("Bij dit e-mailadres hoort geen actief abonnement");
  const o = orders[0];
  const kit = (await dienst(`/v1/orders/${o.id}/kit`, { token, base })) as Kit;
  return { order: o, kit };
}

// ───────── Abonnement beheren ─────────

function order(c: AdminConfig) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) throw new Error("Er is geen abonnement bij de dienst");
  return { token: d.token, id: d.orderId, base: baseOf(c) };
}

export async function dienstBilling(c: AdminConfig) {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/billing`, { token: o.token, base: o.base });
}

/** Ander pakket: de dienst past het abonnement aan; daarna nemen we de nieuwe plekken en aantallen over. */
export async function dienstChangeBundle(c: AdminConfig, bundle: string) {
  const o = order(c);
  const r = await dienst(`/v1/orders/${o.id}/bundle`, { token: o.token, base: o.base, body: { bundle } });
  const kit = (await dienst(`/v1/orders/${o.id}/kit`, { token: o.token, base: o.base })) as Kit;
  c.policy = { ...c.policy, placement: kit.placement, minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses };
  c.console.dienst = { ...c.console.dienst, bundle };
  return { ok: true, bundle: r.bundle, effective: r.effective, policy: { minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses } };
}

export async function dienstAction(c: AdminConfig, action: "payment-method" | "settle" | "cancel" | "resume") {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/${action}`, { token: o.token, base: o.base, body: {} });
}

export async function dienstAuthcode(c: AdminConfig) {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/authcode`, { token: o.token, base: o.base });
}

/** Factuur als HTML (de dienst vraagt een sessie, dus de console haalt hem op en toont hem zelf). */
export async function dienstInvoice(c: AdminConfig, id: string) {
  const o = order(c);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Onbekende factuur");
  const r = await fetch(`${o.base}/v1/invoices/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(r.status === 404 ? "Factuur niet gevonden" : `De dienst antwoordt ${r.status}`);
  return { html: await r.text() };
}

export interface Kit {
  domain: string;
  nameservers: string[];
  delegated: boolean;
  provider: { id: string; fields: Record<string, string> };
  storage: { offer: string; region: string; accessKey: string; secretKey: string; purpose: "replica" | "backup"; dir?: string }[];
  placement: Placement[];
  policy: { minDataNodes: number; witnesses: number };
  dns: { type: "desec"; name: string; token: string; zone: string; api: string; acme?: { username: string; password: string; subdomain: string; server_url: string }; transferCode?: string };
  mailRelay: { host: string; port: number; user: string; password: string; secure: boolean } | null;
  spfExtra: string;
  /** Aantal gebruikers in de cloud (bundel + bijgekocht); ontbreekt bij oudere diensten. */
  users?: number;
  /** DS-records van de zone (DNSSEC); ontbreekt bij een gratis adres van de adressendienst en bij oudere diensten. */
  ds?: string[];
}

/**
 * Het pakket van de dienst overnemen: aanbieder, opslag (buckets worden hier aangemaakt en ingesteld), plekken,
 * DNS via de dienst en de mail-relay. Je herstelsleutel blijft bij jou; de dienst kent hem niet.
 */
export type KitStoreInput = { offer: string; region: string; accessKey: string; secretKey: string; purpose: "replica" | "backup"; dir?: string };
export type AddStoreFn = (b: KitStoreInput) => Promise<{ ok: boolean; steps: { label: string; ok: boolean; detail?: string }[]; name: string }>;

export async function dienstApply(c: AdminConfig, addStore: AddStoreFn, localKit: (kit: Kit, orderId: string) => Kit = (k) => k) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) throw new Error("Er is nog geen bestelling");
  const kit = localKit((await dienst(`/v1/orders/${d.orderId}/kit`, { token: d.token, base: baseOf(c) })) as Kit, d.orderId);
  if (kit.domain !== c.domain) throw new Error(`Het pakket is voor ${kit.domain}, niet voor ${c.domain}`);
  const results = await applyKit(c, kit, addStore);
  // De overdrachtscode van een gratis adres (adressendienst) hoort bij de klant: nodig om over te stappen.
  c.console.dienst = { ...d, applied: true, ...(kit.dns.transferCode ? { transferCode: kit.dns.transferCode } : {}) };
  return { ok: true, stores: results, nameservers: kit.nameservers, delegated: kit.delegated };
}

/**
 * Het pakket in een configuratie zetten: aanbieder, opslag (buckets aanmaken en instellen), plekken, DNS via de
 * dienst, mail-relay en het aantal gebruikers. Ook voor overstappen (dan op een kopie, de "nieuwe plek").
 */
export async function applyKit(c: AdminConfig, kit: Kit, addStore: AddStoreFn) {
  c.providers[kit.provider.id] = { ...kit.provider.fields };
  const results: string[] = [];
  for (const st of kit.storage) {
    const r = await addStore({ offer: st.offer, region: st.region, accessKey: st.accessKey, secretKey: st.secretKey, purpose: st.purpose, ...(st.dir ? { dir: st.dir } : {}) });
    results.push(r.name);
    if (!r.ok) throw new Error(`Opslag ${r.name} klaarzetten lukte niet: ${r.steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
  }
  c.policy = { ...DEFAULT_POLICY, ...c.policy, placement: kit.placement, minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses };
  c.console.preset = "dienst";
  c.console.maxUsers = kit.users ?? 0;
  c.dns = [{ type: "desec", name: "dienst", token: kit.dns.token, zone: kit.dns.zone, api: kit.dns.api, ...(kit.dns.acme ? { acme: kit.dns.acme } : {}) }];
  c.console.dnsMode = "dienst";
  c.console.nameservers = kit.nameservers;
  if (kit.mailRelay) {
    const m = kit.mailRelay;
    c.console.mailRelay = `${m.secure ? "smtps" : "smtp"}://${encodeURIComponent(m.user)}:${encodeURIComponent(m.password)}@${m.host}:${m.port}`;
  }
  c.console.spfExtra = kit.spfExtra ?? "";
  return results;
}

// ───────── Eén sleutel bij Scaleway: de console regelt de rest ─────────
//
// Een account bij een aanbieder kan de app niet voor je aanmaken (naam, betaalmethode, soms een ID-check).
// Met één API-sleutel van Scaleway zet de console wel alles klaar: opslag in Amsterdam en Parijs, servers,
// en het versturen van mail (Transactional Email, met de DKIM-sleutel in je eigen DNS).

export const SCW_SIGNUP_URL = "https://account.scaleway.com/register";
export const SCW_KEYS_URL = "https://console.scaleway.com/iam/api-keys";

async function scw(method: string, pathname: string, secretKey: string, body?: unknown) {
  let r: Response;
  try {
    r = await fetch(`${scwApi()}${pathname}`, { method, headers: { "x-auth-token": secretKey, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Scaleway is niet bereikbaar (${(e as Error).message})`);
  }
  const j = await json(r);
  if (r.status === 401) throw Object.assign(new Error("Scaleway accepteert deze sleutel niet. Kopieer de geheime sleutel opnieuw (hij wordt maar één keer getoond)."), { status: 401 });
  if (r.status === 403) throw Object.assign(new Error(`Deze sleutel mag dit niet bij Scaleway (${String((j as { message?: string })?.message ?? "geen toegang")})`), { status: 403 });
  if (!r.ok) throw Object.assign(new Error(`Scaleway antwoordt ${r.status}: ${String((j as { message?: string })?.message ?? JSON.stringify(j)).slice(0, 160)}`), { status: r.status });
  return j as any;
}

/** Sleutels uit wat de gebruiker plakte: spaties en aanhalingstekens eraf, en de vorm controleren. */
export function scwKeys(b: { accessKey?: string; secretKey?: string }) {
  const clean = (v?: string) => (v ?? "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  const accessKey = clean(b.accessKey).toUpperCase(), secretKey = clean(b.secretKey).toLowerCase();
  if (!/^SCW[A-Z0-9]{17}$/.test(accessKey)) throw new Error("De toegangssleutel begint met SCW en heeft 20 tekens");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(secretKey)) throw new Error("De geheime sleutel ziet eruit als 8-4-4-4-12 tekens met streepjes");
  return { accessKey, secretKey };
}

/** Het project waar de sleutel bij hoort (het standaardproject van de sleutel). */
export async function scwProject(accessKey: string, secretKey: string, projectId?: string) {
  if (projectId && /^[0-9a-f-]{36}$/.test(projectId.trim())) return projectId.trim();
  const k = await scw("GET", `/iam/v1alpha1/api-keys/${encodeURIComponent(accessKey)}`, secretKey).catch((e) => {
    if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404) throw new Error("Kon het project van deze sleutel niet opzoeken. Maak de sleutel aan voor jezelf (niet voor een applicatie), of vul het project-ID in.");
    throw e;
  });
  if (k?.secret_key && k.secret_key !== secretKey) throw new Error("Deze geheime sleutel hoort niet bij deze toegangssleutel");
  const id = k?.default_project_id as string | undefined;
  if (!id) throw new Error("Deze sleutel heeft geen standaardproject. Vul het project-ID in (Scaleway-console → Project → Instellingen).");
  return id;
}

/** Mail versturen via Scaleway: maildomein aanmelden, relay instellen, DKIM-record voor de cloud klaarzetten. */
export async function scwMail(c: AdminConfig, secretKey: string, projectId: string) {
  const d = c.domain;
  if (!d) throw new Error("Nog geen domein");
  const base = "/transactional-email/v1alpha1/regions/fr-par/domains";
  let dom: any = c.console.temDomainId ? await scw("GET", `${base}/${c.console.temDomainId}`, secretKey).catch(() => null) : null;
  if (dom && (dom.name !== d || dom.status === "revoked")) dom = null;
  if (!dom) {
    const list = await scw("GET", `${base}?project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(d)}`, secretKey);
    dom = (list?.domains ?? []).find((x: any) => x.name === d && x.status !== "revoked") ?? null;
  }
  if (!dom) dom = await scw("POST", base, secretKey, { project_id: projectId, domain_name: d, accept_tos: true });
  if (!dom?.id) throw new Error("Scaleway gaf geen maildomein terug");
  const rec = temRecords(dom, projectId);
  c.console.temDomainId = dom.id;
  c.console.mailRelay = `smtp://${encodeURIComponent(projectId)}:${encodeURIComponent(secretKey)}@smtp.tem.scaleway.com:587`;
  c.console.spfExtra = rec.spfExtra || "include:_spf.tem.scaleway.com";
  c.console.extraDns = rec.dkim ? [{ sub: subnameOf(rec.dkim.name, d), type: "TXT", value: rec.dkim.value }] : [];
  return { ok: true, detail: rec.dkim ? "Je cloud zet de handtekening (DKIM) zelf in je DNS; Scaleway keurt het domein daarna goed" : "Maildomein aangemeld" };
}

/** Bij opnieuw beginnen: het maildomein bij Scaleway intrekken. */
export async function scwRevokeMail(c: AdminConfig) {
  const secret = c.providers.scaleway?.secretKey;
  if (!c.console.temDomainId || !secret) return null;
  await scw("POST", `/transactional-email/v1alpha1/regions/fr-par/domains/${c.console.temDomainId}/revoke`, secret, {});
  return "Maildomein bij Scaleway ingetrokken";
}

// ───────── Aanbieders: kiezen, uitnodigingen, huisstijl ─────────

export interface Aanbieder { naam: string; url: string; land?: string; contact?: string; omschrijving?: string }

/** De openbare lijst van aanbieders (aanbieders.json in de repository; nieuwe aanbieders komen erbij via GitHub). */
export const AANBIEDERS_URL = () => process.env.EIGEN_AANBIEDERS_URL || "https://raw.githubusercontent.com/renevanes/own-cloud/main/aanbieders.json";
let aanbiedersCache: { at: number; list: Aanbieder[] } | null = null;

export function cleanDienstUrl(raw: string) {
  let v = String(raw ?? "").trim();
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error("Dat is geen geldig adres"); }
  const local = /^(127\.0\.0\.1|localhost|10\.0\.2\.2)$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Het adres van een aanbieder begint met https://");
  if (u.username || u.password || u.search || u.hash) throw new Error("Dat is geen geldig adres");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export async function aanbieders(): Promise<Aanbieder[]> {
  let list: Aanbieder[] = [];
  if (aanbiedersCache && Date.now() - aanbiedersCache.at < 3600_000) list = aanbiedersCache.list;
  else {
    try {
      const r = await fetch(AANBIEDERS_URL(), { signal: AbortSignal.timeout(10_000) });
      if (r.ok) list = ((await r.json()) as Aanbieder[]).filter((a) => a && a.naam && a.url);
    } catch { /* geen internet: de meegeleverde lijst */ }
    if (!list.length) {
      try { list = JSON.parse(readFileSync(new URL("../../aanbieders.json", import.meta.url), "utf8")) as Aanbieder[]; } catch { list = []; }
    }
    aanbiedersCache = { at: Date.now(), list };
  }
  const out: Aanbieder[] = [];
  for (const a of list) { try { out.push({ ...a, url: cleanDienstUrl(a.url) }); } catch { /* ongeldige regel overslaan */ } }
  const def = DIENST_URL();
  if (def && !out.some((a) => a.url === def)) out.unshift({ naam: "Eigen Cloud Dienst", url: def });
  return out;
}

/** Huisstijl van een aanbieder, met het logo als data-URL (zodat de app het zonder extra verzoeken toont). */
export async function dienstBrand(base: string) {
  const info = await dienst("/v1/info", { base });
  const brand = (info?.brand ?? {}) as { name?: string; accentColor?: string | null; contact?: Record<string, string | null>; logoUrl?: string | null; termsUrl?: string | null; privacyUrl?: string | null };
  let logo: string | null = null;
  if (brand.logoUrl) {
    try {
      const r = await fetch(`${base}/v1/brand/logo`, { signal: AbortSignal.timeout(10_000) });
      const type = r.headers.get("content-type") ?? "";
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && /^image\/(png|svg\+xml|jpeg|webp)/.test(type) && buf.length <= 200 * 1024) logo = `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
    } catch { /* zonder logo */ }
  }
  return { url: base, name: brand.name ?? info?.name ?? "Eigen Cloud Dienst", accentColor: brand.accentColor ?? null, contact: brand.contact ?? {}, termsUrl: brand.termsUrl ?? info?.termsUrl ?? null, privacyUrl: brand.privacyUrl ?? info?.privacyUrl ?? null, logo, bundles: info?.bundles ?? [], freeZone: info?.freeZone ?? null };
}

export async function dienstInvite(base: string, code: string) {
  if (!/^[A-Za-z0-9-]{4,40}$/.test(code ?? "")) throw new Error("Deze code klopt niet");
  return dienst(`/v1/invite/${encodeURIComponent(code)}`, { base });
}

/** Aanbieder kiezen (of wisselen zolang er nog niets besteld is). Met een uitnodigingscode wordt die meegestuurd bij bestellen. */
export async function dienstSelect(c: AdminConfig, url: string, invite?: string) {
  const base = cleanDienstUrl(url);
  const cur = c.console.dienst;
  if (cur?.orderId && baseOf(c) !== base) throw new Error("Je hebt al een abonnement bij een andere aanbieder. Overstappen regel je bij je abonnement.");
  let code: string | undefined;
  if (invite) {
    const r = await dienstInvite(base, invite);
    if (!r.valid) throw new Error(r.reason ?? "Deze uitnodiging is niet (meer) geldig");
    code = r.code ?? invite;
  }
  const brand = await dienstBrand(base);
  const same = baseOf(c) === base;
  c.console.dienst = same ? { ...(cur ?? {}), url: base, ...(code ? { invite: code } : {}) } : { url: base, ...(code ? { invite: code } : {}) };
  return brand;
}

// ───────── Hulpvragen, berichten en extra gebruikers ─────────

function session(c: AdminConfig) {
  const d = c.console.dienst;
  if (!d?.token) throw new Error("Log eerst in bij je aanbieder");
  return { token: d.token, base: baseOf(c) };
}
export const dienstTickets = (c: AdminConfig) => dienst("/v1/tickets", session(c));
export function dienstTicket(c: AdminConfig, id: string) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id ?? "")) throw new Error("Deze hulpvraag bestaat niet");
  return dienst(`/v1/tickets/${id}`, session(c));
}
export function dienstNewTicket(c: AdminConfig, b: { subject?: string; message?: string }) {
  return dienst("/v1/tickets", { ...session(c), body: { subject: b.subject, message: b.message, ...(c.console.dienst?.orderId ? { orderId: c.console.dienst.orderId } : {}) } });
}
export function dienstTicketReply(c: AdminConfig, id: string, message: string) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id ?? "")) throw new Error("Deze hulpvraag bestaat niet");
  return dienst(`/v1/tickets/${id}/messages`, { ...session(c), body: { message } });
}
export const dienstAnnouncements = (c: AdminConfig) => dienst("/v1/announcements", session(c));

/** Extra gebruikers bijkopen of minderen; daarna het nieuwe aantal uit het pakket overnemen. */
export async function dienstSetUsers(c: AdminConfig, count: number) {
  const o = order(c);
  const r = await dienst(`/v1/orders/${o.id}/users`, { token: o.token, base: o.base, body: { count } });
  const kit = (await dienst(`/v1/orders/${o.id}/kit`, { token: o.token, base: o.base })) as Kit;
  c.console.maxUsers = kit.users ?? 0;
  return { ...r, maxUsers: c.console.maxUsers };
}

/** Voor de cloud: waar hij zijn technische gezondheid meldt (alleen bij een abonnement bij een aanbieder). */
export function dienstReport(c: AdminConfig) {
  const d = c.console.dienst;
  const token = c.dns.find((x) => x.type === "desec" && x.name === "dienst")?.token;
  if (!d?.orderId || !d.applied || !token) return null;
  return { url: baseOf(c), orderId: d.orderId, token };
}
