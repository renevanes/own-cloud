import crypto from "node:crypto";
import type { DnsProvider, ProviderAdapter } from "./types.js";
import { parseMx, unquoteTxt } from "./http.js";
import { L, loginFailed, row, type KeyCheck } from "./check.js";

/**
 * Openprovider (registrar, Nederland): alleen DNS. Voor domeinen die bij Openprovider staan, zodat je de DNS niet hoeft
 * te verhuizen. De console gebruikt dezelfde client ook voor domeinen kopen, nameservers en DNSSEC (aanbieder worden).
 *
 * Bronnen (nagekeken 12-10-2026):
 *  - developer.openprovider.com/get-started.html: POST {base}/auth/login {username, password, ip} → data.token,
 *    daarna "Authorization: Bearer <token>"; een `code` ≠ 0 is een fout, met `desc` als uitleg. Basisadres
 *    https://api.openprovider.eu/v1 (de paden zijn verder die van /v1beta in de swagger hieronder).
 *  - github.com/openprovider/api-documentation, swagger.json op de branch v1beta (en docs.openprovider.com/swagger.json,
 *    zelfde paden): GET/POST /dns/zones, GET/PUT/DELETE
 *    /dns/zones/{name} (PUT: records {add, remove, replace, update} met {name, type, value, ttl, prio}),
 *    GET /dns/zones/{name}/records, GET/PUT /domains/{id} (name_servers [{name}], is_dnssec_enabled,
 *    dnssec_keys [{flags, protocol, alg, pub_key}]), POST /domains/check {domains, with_price}, POST /domains,
 *    GET/POST /customers, GET /contacts?username_pattern=, PUT /contacts/{id} (api_client_ip_list {allow, deny}).
 * Niet in de documentatie en dus aangenomen (⚠️ nog niet met een echt account getest): recordnamen schrijven we
 * relatief ("www", "" voor het domein zelf) en lezen we zowel relatief als volledig; TXT zonder aanhalingstekens; een
 * TTL van minstens 900 seconden; de nameservers van Openprovider zelf.
 */
export const opApi = () => (process.env.EIGEN_OPENPROVIDER_URL ?? "https://api.openprovider.eu/v1").replace(/\/+$/, "");
/** De nameservers van Openprovider DNS (⚠️ niet in de API-documentatie; uit het controlepaneel). */
export const OP_NAMESERVERS = ["ns1.openprovider.nl", "ns2.openprovider.be", "ns3.openprovider.eu"];
export const OP_MIN_TTL = 900;

export class OpError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null = null) { super(message); }
}

/** Tokens per gebruiker (Openprovider: tijdelijk geldig; we vragen na een dag of na een 401 een nieuwe). */
const tokens = new Map<string, { token: string; until: number }>();
export function resetOpTokens() { tokens.clear(); }

/** Een kleine client: inloggen (token bewaard), verzoeken, en fouten als Nederlandse melding. */
export class OpenproviderApi {
  constructor(private f: { username?: string; password?: string }, private base = opApi()) {}
  private key() { return `${this.base}|${this.f.username}|${crypto.createHash("sha256").update(String(this.f.password)).digest("hex")}`; }

  async login(): Promise<string> {
    if (!this.f.username || !this.f.password) throw new OpError("Vul je Openprovider-gebruikersnaam en wachtwoord in", 400);
    const hit = tokens.get(this.key());
    if (hit && hit.until > Date.now()) return hit.token;
    let r: Response;
    try {
      r = await fetch(`${this.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: this.f.username, password: this.f.password, ip: "0.0.0.0" }), signal: AbortSignal.timeout(15_000) });
    } catch { throw new OpError("Openprovider is niet bereikbaar", 0); }
    const j = await r.json().catch(() => null) as any;
    const t = j?.data?.token;
    if (!r.ok || !t || (typeof j?.code === "number" && j.code !== 0)) {
      throw new OpError("Openprovider laat deze gebruiker niet inloggen. Klopt het wachtwoord, staat API-toegang aan, en mag dit IP-adres erbij?", r.status === 200 ? 401 : r.status, j?.code ?? null);
    }
    tokens.set(this.key(), { token: t, until: Date.now() + 24 * 3_600_000 });
    return t as string;
  }

  /** Verzoek met het token; bij 401 één keer opnieuw inloggen. Geeft het hele antwoord ({code, data}). */
  async req(method: string, p: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const t = await this.login();
      let r: Response;
      try {
        r = await fetch(this.base + p, { method, headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      } catch { throw new OpError("Openprovider is niet bereikbaar", 0); }
      const text = await r.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
      if (r.status === 401 && attempt === 0) { tokens.delete(this.key()); continue; }
      const code = typeof j?.code === "number" ? j.code : null;
      if (!r.ok || (code !== null && code !== 0)) throw new OpError(`Openprovider: ${String(j?.desc ?? `fout ${r.status}`).slice(0, 200)}`, r.ok ? 400 : r.status, code);
      return j;
    }
  }
}

/** "esape.nl" → {name: "esape", extension: "nl"}; "co.uk"-achtige extensies: alles na het eerste label. */
export function splitDomain(d: string) {
  const i = d.indexOf(".");
  return { name: d.slice(0, i), extension: d.slice(i + 1) };
}

/** Recordnaam van Openprovider (relatief of volledig, met of zonder punt) → subnaam binnen de zone ("" = de zone zelf). */
export function opSub(name: string, zone: string) {
  const n = String(name ?? "").toLowerCase().replace(/\.$/, "");
  if (n === "" || n === "@" || n === zone) return "";
  return n.endsWith(`.${zone}`) ? n.slice(0, -(zone.length + 1)) : n;
}

/** Een waarde in zonebestand-notatie → record voor Openprovider. */
export function opRecord(sub: string, type: string, v: string, ttl: number) {
  const base = { name: sub, type, ttl: Math.max(ttl, OP_MIN_TTL) };
  if (type === "MX") { const m = parseMx(v); return { ...base, value: m.host, prio: m.priority }; }
  if (type === "TXT") return { ...base, value: unquoteTxt(v) };
  if (type === "NS" || type === "CNAME") return { ...base, value: v.replace(/\.$/, "") };
  return { ...base, value: v };
}

export class OpenproviderDns implements DnsProvider {
  constructor(readonly name: string, private cfg: { username: string; password: string; zone: string }) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const op = new OpenproviderApi(this.cfg);
    const zone = this.cfg.zone;
    const list = await op.req("GET", `/dns/zones/${encodeURIComponent(zone)}/records?type=${encodeURIComponent(type)}&limit=500`);
    const old = ((list?.data?.results ?? []) as any[]).filter((r) => String(r.type).toUpperCase() === type && opSub(r.name, zone) === sub)
      .map((r) => ({ name: sub, type, value: String(r.value), ttl: Number(r.ttl), ...(r.prio !== undefined && r.prio !== null && type === "MX" ? { prio: Number(r.prio) } : {}) }));
    const add = values.map((v) => opRecord(sub, type, v, ttl));
    const same = old.length === add.length && add.every((a) => old.some((o) => o.value === a.value && o.ttl === a.ttl && (o as { prio?: number }).prio === (a as { prio?: number }).prio));
    if (same) return;
    await op.req("PUT", `/dns/zones/${encodeURIComponent(zone)}`, { name: zone, records: { ...(old.length ? { remove: old } : {}), ...(add.length ? { add } : {}) } });
  }
}

/** Inloggen en de zone bekijken (alleen lezen: inloggen verandert niets). */
async function opCheck(f: Record<string, string>, zone: string): Promise<KeyCheck[]> {
  const label = zone ? L.zone : L.zones;
  const rest: [string, string][] = [["zone", label], ["rights", L.dnsRights]];
  const op = new OpenproviderApi(f);
  try { await op.login(); } catch (e) { return loginFailed((e as Error).message, rest); }
  const out = [row("login", L.login, true)];
  try {
    if (zone) await op.req("GET", `/dns/zones/${encodeURIComponent(zone)}`);
    else await op.req("GET", "/dns/zones?limit=1");
    out.push(row("zone", label, true, zone ? `${zone} gevonden` : ""));
  } catch (e) {
    const s = (e as OpError).status;
    out.push(zone && (s === 404 || s === 400) ? row("zone", label, null, `${zone} heeft nog geen DNS bij Openprovider; de console maakt de zone aan bij het koppelen.`)
      : row("zone", label, false, (e as Error).message));
  }
  out.push(row("rights", L.dnsRights, null, "Openprovider laat de rechten niet zien; blijkt bij het eerste record"));
  return out;
}

export const openprovider: ProviderAdapter = {
  id: "openprovider",
  name: "Openprovider",
  owner: "Openprovider (Hosting Concepts B.V., Nederland)",
  home: "NL",
  signupUrl: "https://www.openprovider.com",
  keyHelp: "Openprovider → Account → Contactpersonen → je naam → API: zet API-toegang aan. Vul hier je gebruikersnaam en wachtwoord in. Staat er een lijst met IP-adressen? Zet dan ook het adres van dit apparaat erop.",
  fields: [
    { key: "username", label: "Gebruikersnaam" },
    { key: "password", label: "Wachtwoord", secret: true },
  ],
  dns: {
    name: "Openprovider DNS",
    async connect(fields, zone) {
      const op = new OpenproviderApi(fields);
      await op.login();
      try { await op.req("GET", `/dns/zones/${encodeURIComponent(zone)}`); }
      catch (e) {
        const s = (e as OpError).status;
        if (s !== 404 && s !== 400) throw new Error((e as Error).message);
        try { await op.req("POST", "/dns/zones", { domain: splitDomain(zone), type: "master", records: [] }); }
        catch (e2) { throw new Error(`DNS-zone aanmaken bij Openprovider mislukt: ${(e2 as Error).message}`); }
      }
      return { nameservers: [...OP_NAMESERVERS] };
    },
    create: (name, f, zone) => new OpenproviderDns(name, { username: f.username, password: f.password, zone }),
    check: opCheck,
  },
};
