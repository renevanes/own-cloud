/**
 * Alles regelen vanuit de console, zonder zelf accounts aan te maken:
 *  - gratis: een deSEC-account (open source, non-profit, Berlijn) met desgewenst een gratis naam.dedyn.io;
 *  - betaald: de Eigen Cloud Dienst (src/broker), die domein, servers, opslag en mail-relay centraal regelt.
 * De Android-app heeft dezelfde stappen in Java (android/core ConsoleApi).
 */
import crypto from "node:crypto";
import type { AdminConfig } from "./vault.js";
import { DEFAULT_POLICY, type Placement } from "../cluster/config.js";

export const DESEC_URL = () => (process.env.EIGEN_DESEC_URL ?? "https://desec.io/api/v1").replace(/\/$/, "");
export const DIENST_URL = () => (process.env.EIGEN_DIENST_URL ?? "").replace(/\/$/, "");

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

export function changeDomain(c: AdminConfig, domain: string, mode: "own" | "free" | "buy") {
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

async function dienst(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const base = DIENST_URL();
  if (!base) throw new Error("De Eigen Cloud Dienst is in deze versie niet ingesteld");
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

export const dienstInfo = () => dienst("/v1/info");

export async function dienstCheck(name: string) {
  const d = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error("Vul een domeinnaam in, zoals vanes.nl");
  return dienst(`/v1/domains/check?name=${encodeURIComponent(d)}`);
}

export async function dienstLogin(c: AdminConfig, email: string) {
  const e = (email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new Error("Vul een geldig e-mailadres in");
  await dienst("/v1/auth/start", { body: { email: e } });
  c.console.dienst = { ...(c.console.dienst ?? {}), email: e };
  return { ok: true, email: e };
}

export async function dienstVerify(c: AdminConfig, code: string) {
  const email = c.console.dienst?.email;
  if (!email) throw new Error("Vul eerst je e-mailadres in");
  const r = await dienst("/v1/auth/verify", { body: { email, code: (code ?? "").replace(/\s/g, "") } });
  c.console.dienst = { ...(c.console.dienst ?? {}), token: r.token };
  return { ok: true, email };
}

export interface OrderInput {
  bundle: string;
  /** register = nieuw domein, transfer = verhuizen naar de dienst, own = blijft bij je eigen registrar */
  mode: "register" | "transfer" | "own";
  authCode?: string;
  registrant?: Record<string, string>;
  acceptTerms: boolean;
}

export async function dienstOrder(c: AdminConfig, b: OrderInput) {
  const token = c.console.dienst?.token;
  if (!token) throw new Error("Log eerst in bij de dienst");
  if (!b.acceptTerms) throw new Error("Ga akkoord met de voorwaarden om verder te gaan");
  if (c.domain?.endsWith(".dedyn.io")) throw new Error("Bij de dienst hoort een eigen domeinnaam. Kies eerst een domein.");
  const r = await dienst("/v1/orders", {
    token,
    body: { bundle: b.bundle, domain: { mode: b.mode, name: c.domain, authCode: b.authCode || undefined }, registrant: b.mode === "own" ? undefined : b.registrant, acceptTerms: true },
  });
  c.console.dienst = { ...(c.console.dienst ?? {}), orderId: r.orderId, bundle: b.bundle, applied: false };
  return { ok: true, orderId: r.orderId, checkoutUrl: r.checkoutUrl };
}

export async function dienstStatus(c: AdminConfig) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) return { status: "none" };
  return dienst(`/v1/orders/${d.orderId}`, { token: d.token });
}

// ───────── Herstellen op een nieuw apparaat, via de dienst ─────────

export async function dienstStartLogin(email: string) {
  const e = (email ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) throw new Error("Vul een geldig e-mailadres in");
  await dienst("/v1/auth/start", { body: { email: e } });
  return e;
}

export async function dienstFinishLogin(email: string, code: string): Promise<string> {
  const r = await dienst("/v1/auth/verify", { body: { email, code: (code ?? "").replace(/\s/g, "") } });
  return r.token as string;
}

/** Het lopende abonnement en zijn pakket (voor herstellen: opslag en sleutels komen uit het pakket). */
export async function dienstOrderKit(token: string) {
  const me = await dienst("/v1/me", { token });
  const orders = ((me.orders ?? []) as { id: string; status: string; bundle: string; createdAt?: number }[])
    .filter((o) => ["ready", "payment_problem", "cancelled"].includes(o.status))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (!orders.length) throw new Error("Bij dit e-mailadres hoort geen actief abonnement");
  const o = orders[0];
  const kit = (await dienst(`/v1/orders/${o.id}/kit`, { token })) as Kit;
  return { order: o, kit };
}

// ───────── Abonnement beheren ─────────

function order(c: AdminConfig) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) throw new Error("Er is geen abonnement bij de dienst");
  return { token: d.token, id: d.orderId };
}

export async function dienstBilling(c: AdminConfig) {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/billing`, { token: o.token });
}

/** Ander pakket: de dienst past het abonnement aan; daarna nemen we de nieuwe plekken en aantallen over. */
export async function dienstChangeBundle(c: AdminConfig, bundle: string) {
  const o = order(c);
  const r = await dienst(`/v1/orders/${o.id}/bundle`, { token: o.token, body: { bundle } });
  const kit = (await dienst(`/v1/orders/${o.id}/kit`, { token: o.token })) as Kit;
  c.policy = { ...c.policy, placement: kit.placement, minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses };
  c.console.dienst = { ...c.console.dienst, bundle };
  return { ok: true, bundle: r.bundle, effective: r.effective, policy: { minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses } };
}

export async function dienstAction(c: AdminConfig, action: "payment-method" | "settle" | "cancel" | "resume") {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/${action}`, { token: o.token, body: {} });
}

export async function dienstAuthcode(c: AdminConfig) {
  const o = order(c);
  return dienst(`/v1/orders/${o.id}/authcode`, { token: o.token });
}

/** Factuur als HTML (de dienst vraagt een sessie, dus de console haalt hem op en toont hem zelf). */
export async function dienstInvoice(c: AdminConfig, id: string) {
  const o = order(c);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Onbekende factuur");
  const r = await fetch(`${DIENST_URL()}/v1/invoices/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(r.status === 404 ? "Factuur niet gevonden" : `De dienst antwoordt ${r.status}`);
  return { html: await r.text() };
}

export interface Kit {
  domain: string;
  nameservers: string[];
  delegated: boolean;
  provider: { id: string; fields: Record<string, string> };
  storage: { offer: string; region: string; accessKey: string; secretKey: string; purpose: "replica" | "backup" }[];
  placement: Placement[];
  policy: { minDataNodes: number; witnesses: number };
  dns: { type: "desec"; name: string; token: string; zone: string; api: string; acme?: { username: string; password: string; subdomain: string; server_url: string } };
  mailRelay: { host: string; port: number; user: string; password: string; secure: boolean } | null;
  spfExtra: string;
}

/**
 * Het pakket van de dienst overnemen: aanbieder, opslag (buckets worden hier aangemaakt en ingesteld), plekken,
 * DNS via de dienst en de mail-relay. Je herstelsleutel blijft bij jou; de dienst kent hem niet.
 */
export async function dienstApply(c: AdminConfig, addStore: (b: { offer: string; region: string; accessKey: string; secretKey: string; purpose: "replica" | "backup" }) => Promise<{ ok: boolean; steps: { label: string; ok: boolean; detail?: string }[]; name: string }>) {
  const d = c.console.dienst;
  if (!d?.token || !d.orderId) throw new Error("Er is nog geen bestelling");
  const kit = (await dienst(`/v1/orders/${d.orderId}/kit`, { token: d.token })) as Kit;
  if (kit.domain !== c.domain) throw new Error(`Het pakket is voor ${kit.domain}, niet voor ${c.domain}`);
  c.providers[kit.provider.id] = { ...kit.provider.fields };
  const results = [];
  for (const st of kit.storage) {
    const r = await addStore({ offer: st.offer, region: st.region, accessKey: st.accessKey, secretKey: st.secretKey, purpose: st.purpose });
    results.push(r);
    if (!r.ok) throw new Error(`Opslag ${r.name} klaarzetten lukte niet: ${r.steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
  }
  c.policy = { ...DEFAULT_POLICY, ...c.policy, placement: kit.placement, minDataNodes: kit.policy.minDataNodes, witnesses: kit.policy.witnesses };
  c.console.preset = "dienst";
  c.dns = [{ type: "desec", name: "dienst", token: kit.dns.token, zone: kit.dns.zone, api: kit.dns.api, ...(kit.dns.acme ? { acme: kit.dns.acme } : {}) }];
  c.console.dnsMode = "dienst";
  c.console.nameservers = kit.nameservers;
  if (kit.mailRelay) {
    const m = kit.mailRelay;
    c.console.mailRelay = `${m.secure ? "smtps" : "smtp"}://${encodeURIComponent(m.user)}:${encodeURIComponent(m.password)}@${m.host}:${m.port}`;
  }
  c.console.spfExtra = kit.spfExtra ?? "";
  c.console.dienst = { ...d, applied: true };
  return { ok: true, stores: results.map((r) => r.name), nameservers: kit.nameservers, delegated: kit.delegated };
}
