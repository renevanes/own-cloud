/**
 * Dunne clients voor Mollie, Openprovider, deSEC en Scaleway. Alleen wat de dienst nodig heeft;
 * elke basis-URL komt uit de config zodat tests een nep-server kunnen gebruiken.
 */
import type { BrokerConfig } from "./config.js";
import { AdresClient } from "./adres.js";

export class ApiError extends Error {
  constructor(readonly service: string, readonly status: number, message: string, readonly body?: unknown) { super(message); }
  /** Blijvend mis: opnieuw proberen helpt niet (4xx behalve 401/408/425/429). */
  get permanent() { return this.status >= 400 && this.status < 500 && ![401, 408, 425, 429].includes(this.status); }
}

/** Een netwerkfout of 5xx is tijdelijk; ApiError.permanent bepaalt de rest. */
export const isPermanent = (e: unknown) => e instanceof ApiError && e.permanent;

export async function call(service: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: string }) {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  let body: string | undefined = init.raw;
  if (init.body !== undefined) { body = JSON.stringify(init.body); headers["content-type"] = "application/json"; }
  let r: Response;
  try {
    r = await fetch(url, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ApiError(service, 0, `${service} niet bereikbaar: ${(e as Error).message}`);
  }
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
  if (!r.ok) {
    const msg = json?.detail ?? json?.desc ?? json?.message ?? json?.error?.message ?? json?.title ?? (typeof json === "object" && json ? JSON.stringify(json).slice(0, 200) : text.slice(0, 200));
    throw new ApiError(service, r.status, `${service} ${r.status}: ${msg}`, json ?? text);
  }
  return { status: r.status, json };
}

// ───────── Mollie ─────────

export class Mollie {
  constructor(private c: BrokerConfig["mollie"]) {}
  private h() { return { authorization: `Bearer ${this.c.apiKey}` }; }
  req(method: string, p: string, body?: unknown): Promise<any> { return call("Mollie", this.c.url + p, { method, headers: this.h(), body }).then((r) => r.json); }
  createCustomer(name: string, email: string) { return this.req("POST", "/customers", { name, email }); }
  createPayment(body: Record<string, unknown>) { return this.req("POST", "/payments", body); }
  getPayment(id: string) { return this.req("GET", `/payments/${encodeURIComponent(id)}`); }
  createSubscription(customerId: string, body: Record<string, unknown>) { return this.req("POST", `/customers/${encodeURIComponent(customerId)}/subscriptions`, body); }
  cancelSubscription(customerId: string, subId: string) { return this.req("DELETE", `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subId)}`); }
  getSubscription(customerId: string, subId: string) { return this.req("GET", `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subId)}`); }
  /** Bedrag, omschrijving of machtiging (mandateId) van een lopend abonnement wijzigen. */
  updateSubscription(customerId: string, subId: string, body: Record<string, unknown>) { return this.req("PATCH", `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subId)}`, body); }
  async mandates(customerId: string): Promise<any[]> {
    const j = await this.req("GET", `/customers/${encodeURIComponent(customerId)}/mandates?limit=250`);
    return j?._embedded?.mandates ?? [];
  }
  createRefund(paymentId: string, body: Record<string, unknown>) { return this.req("POST", `/payments/${encodeURIComponent(paymentId)}/refunds`, body); }
}

// ───────── Openprovider ─────────

export class Openprovider {
  private token: { value: string; until: number } | null = null;
  constructor(private c: BrokerConfig["openprovider"]) {}

  private async login() {
    const r = await call("Openprovider", `${this.c.url}/auth/login`, { method: "POST", body: { username: this.c.username, password: this.c.password, ip: "0.0.0.0" } });
    const t = r.json?.data?.token;
    if (!t) throw new ApiError("Openprovider", 401, "Openprovider: inloggen gaf geen token");
    this.token = { value: t, until: Date.now() + 47 * 3600_000 }; // geldig 48 uur
    return t as string;
  }

  async req(method: string, p: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const t = this.token && this.token.until > Date.now() ? this.token.value : await this.login();
      try {
        const r = await call("Openprovider", this.c.url + p, { method, headers: { authorization: `Bearer ${t}` }, body });
        // Openprovider meldt fouten soms met HTTP 200 en een code ≠ 0.
        if (r.json && typeof r.json.code === "number" && r.json.code !== 0) throw new ApiError("Openprovider", 400, `Openprovider: ${r.json.desc ?? "fout " + r.json.code}`, r.json);
        return r.json;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && attempt === 0) { this.token = null; continue; }
        throw e;
      }
    }
  }

  async check(name: string, extension: string) {
    const j = await this.req("POST", "/domains/check", { domains: [{ name, extension }], with_price: true });
    const res = (Array.isArray(j?.data) ? j.data[0] : j?.data?.results?.[0]) ?? {};
    // Een premium-domein kost meer dan price.reseller (premium.price.create): niet aanbieden tegen de gewone prijs.
    if (res.is_premium === true) return { available: false, price: null };
    const p = res.price?.reseller ?? res.price?.product ?? null;
    const price = p && p.price !== undefined && p.price !== null ? { currency: String(p.currency ?? "EUR"), value: Number(p.price).toFixed(2) } : null;
    return { available: res.status === "free", price };
  }

  /** Id van een domein in ons reseller-account (of null). */
  async findDomainId(domain: string): Promise<number | null> {
    const j = await this.req("GET", `/domains?full_name=${encodeURIComponent(domain)}&limit=1`);
    const found = (j?.data?.results ?? []).find((d: any) => `${d.domain?.name}.${d.domain?.extension}` === domain || d.full_name === domain);
    return found?.id ?? null;
  }

  /**
   * DNSSEC bij het register aan of uit (overstappen: de zone gaat naar een ander deSEC-account met andere sleutels;
   * zonder DS-records blijft het domein bereikbaar tot de nieuwe sleutels er staan). Volgens de documentatie:
   * PUT /domains/{id} met is_dnssec_enabled en dnssec_keys. Nog niet getest met een echt account.
   */
  async setDnssec(domainId: number | string, keys: { flags: number; protocol: number; alg: number; pub_key: string }[] | null) {
    return this.req("PUT", `/domains/${encodeURIComponent(String(domainId))}`, keys && keys.length ? { is_dnssec_enabled: true, dnssec_keys: keys } : { is_dnssec_enabled: false, dnssec_keys: [] });
  }

  /**
   * Verhuiscode (auth code) van een domein. Volgens de documentatie: GET /domains/{id}/authcode → data.auth_code;
   * lukt dat niet (of is hij leeg), dan één keer POST /domains/{id}/authcode/reset. Nog niet getest met een echt account.
   */
  async authCode(domainId: number | string): Promise<string> {
    const p = `/domains/${encodeURIComponent(String(domainId))}/authcode`;
    let first: unknown = null;
    try {
      const code = (await this.req("GET", p))?.data?.auth_code;
      if (code) return String(code);
    } catch (e) { first = e; }
    const r = await this.req("POST", `${p}/reset`, {});
    let code = r?.data?.auth_code;
    if (!code) code = (await this.req("GET", p))?.data?.auth_code;
    if (!code) throw first ?? new ApiError("Openprovider", 502, "Openprovider gaf geen verhuiscode terug");
    return String(code);
  }
}

// ───────── deSEC (met het eigen token van de dienst, of het token van één gratis adres) ─────────

export class Desec {
  constructor(private c: BrokerConfig["desec"]) {}
  /** Zelfde deSEC, ander token (bijv. het token dat alleen in de zone van één gratis adres mag schrijven). */
  withToken(token: string) { return new Desec({ ...this.c, token }); }
  private h() { return { authorization: `Token ${this.c.token}` }; }
  async getZone(name: string) {
    try { return (await call("deSEC", `${this.c.url}/domains/${name}/`, { headers: this.h() })).json; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  }
  async createZone(name: string) { return (await call("deSEC", `${this.c.url}/domains/`, { method: "POST", headers: this.h(), body: { name } })).json; }
  /** Zone weghalen (met alle records). true = weggehaald, false = bestond niet (meer) in dit account. */
  async deleteZone(name: string) {
    try { await call("deSEC", `${this.c.url}/domains/${name}/`, { method: "DELETE", headers: this.h() }); return true; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e; }
  }
  async getRrset(zone: string, sub: string, type: string) {
    try { return (await call("deSEC", `${this.c.url}/domains/${zone}/rrsets/${sub || "@"}/${type}/`, { headers: this.h() })).json; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  }
  async putRrsets(zone: string, rrsets: { subname: string; type: string; ttl: number; records: string[] }[]) {
    return (await call("deSEC", `${this.c.url}/domains/${zone}/rrsets/`, { method: "PUT", headers: this.h(), body: rrsets })).json;
  }
  /** Stuurt een verzoek van een klant ongewijzigd door (DNS-proxy). */
  async forward(method: string, pathAndQuery: string, body: string | undefined) {
    const headers: Record<string, string> = { ...this.h(), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${this.c.url}${pathAndQuery}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  }
}

// ───────── Scaleway (organisatie-sleutel van de dienst) ─────────

export class Scaleway {
  constructor(private c: BrokerConfig["scaleway"]) {}
  get organizationId() { return this.c.organizationId; }
  get permissionSets() { return this.c.permissionSets; }
  req(method: string, p: string, body?: unknown): Promise<any> {
    return call("Scaleway", this.c.url + p, { method, headers: { "x-auth-token": this.c.secretKey }, body }).then((r) => r.json);
  }
  async reqOr404(method: string, p: string, body?: unknown): Promise<any> {
    try { return await this.req(method, p, body); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  }
  /** Draaiende en uitgezette servers van een project in één zone. */
  async servers(zone: string, projectId: string): Promise<{ id: string; name: string; state: string; creation_date: string; commercial_type?: string }[]> {
    const j = await this.req("GET", `/instance/v1/zones/${zone}/servers?project=${encodeURIComponent(projectId)}&per_page=100`);
    return (j?.servers ?? []) as never;
  }
  serverAction(zone: string, id: string, action: "poweroff" | "poweron" | "terminate") {
    return this.req("POST", `/instance/v1/zones/${zone}/servers/${id}/action`, { action });
  }
}

export interface Apis {
  mollie: Mollie; openprovider: Openprovider; desec: Desec; scaleway: Scaleway;
  /** Centrale adressendienst (alleen met BROKER_ADRES_URL). */
  adres: AdresClient | null;
}

export function makeApis(c: BrokerConfig): Apis {
  return {
    mollie: new Mollie(c.mollie), openprovider: new Openprovider(c.openprovider), desec: new Desec(c.desec), scaleway: new Scaleway(c.scaleway),
    adres: c.adresUrl ? new AdresClient({ url: c.adresUrl, dienst: c.publicUrl, key: c.providerKey }) : null,
  };
}
