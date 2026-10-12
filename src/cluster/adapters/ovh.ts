import crypto from "node:crypto";
import type { CreateSpec, DnsProvider, Provider, ProviderAdapter, ServerInfo, SizeOption } from "./types.js";
import { api, sleep } from "./http.js";
import { L, failText, good, look, loginFailed, row, ruleCovers, type KeyCheck } from "./check.js";

/**
 * OVHcloud (Frankrijk). API https://eu.api.ovh.com/1.0 met een application key, application secret en consumer key.
 *
 * Ondertekening (zoals de officiële bibliotheken python-ovh en node-ovh):
 *   X-Ovh-Signature = "$1$" + sha1_hex(AS + "+" + CK + "+" + METHOD + "+" + volledige URL incl. query + "+" + body + "+" + tijd)
 * met X-Ovh-Application, X-Ovh-Consumer en X-Ovh-Timestamp erbij. De tijd is de servertijd: eenmalig opgevraagd via
 * GET /auth/time (zonder ondertekening) en als verschil met de eigen klok bewaard.
 *
 * Servers zijn Public Cloud-instances in één project (serviceName = project-ID).
 * De consumer key moet deze rechten hebben (zie PROVIDERS.md, of maak hem via OVH_CREATE_TOKEN_URL):
 */
export const OVH_ACCESS_RULES = (projectId = "{projectId}", zone = "{zone}") => [
  { method: "GET", path: `/cloud/project/${projectId}/*` },
  { method: "POST", path: `/cloud/project/${projectId}/instance` },
  { method: "DELETE", path: `/cloud/project/${projectId}/instance/*` },
  { method: "GET", path: `/domain/zone/${zone}` },
  { method: "GET", path: `/domain/zone/${zone}/*` },
  { method: "POST", path: `/domain/zone/${zone}/*` },
  { method: "DELETE", path: `/domain/zone/${zone}/record/*` },
];

/** Pagina van OVHcloud waar je in één keer een sleutel met precies deze rechten maakt. */
export const OVH_CREATE_TOKEN_URL = "https://eu.api.ovh.com/createToken/?GET=/cloud/project/*&POST=/cloud/project/*/instance&DELETE=/cloud/project/*/instance/*&GET=/domain/zone/*&POST=/domain/zone/*&DELETE=/domain/zone/*/record/*";

export const ovhBase = () => (process.env.EIGEN_OVH_API ?? "https://eu.api.ovh.com/1.0").replace(/\/$/, "");

/** Wachten tot een nieuwe instance een IP-adres heeft (tests zetten pollMs op 0). */
export const ovhTiming = { pollMs: 5000, polls: 60 };

export function ovhSign(appSecret: string, consumerKey: string, method: string, url: string, body: string, timestamp: number) {
  return "$1$" + crypto.createHash("sha1").update([appSecret, consumerKey, method.toUpperCase(), url, body, String(timestamp)].join("+"), "utf8").digest("hex");
}

type OvhCfg = { appKey: string; appSecret: string; consumerKey: string; projectId?: string; image?: string };

class OvhClient {
  private delta?: number;
  constructor(private cfg: OvhCfg) {}
  private async now() {
    if (this.delta === undefined) {
      const { json } = await api(`${ovhBase()}/auth/time`);
      this.delta = Number(json) - Math.floor(Date.now() / 1000);
    }
    return Math.floor(Date.now() / 1000) + this.delta;
  }
  async call(method: string, pathq: string, body?: unknown, okStatus?: number[]) {
    const url = `${ovhBase()}${pathq}`;
    const b = body === undefined ? "" : JSON.stringify(body);
    const ts = await this.now();
    return api(url, {
      method,
      headers: {
        "X-Ovh-Application": this.cfg.appKey, "X-Ovh-Consumer": this.cfg.consumerKey, "X-Ovh-Timestamp": String(ts),
        "X-Ovh-Signature": ovhSign(this.cfg.appSecret, this.cfg.consumerKey, method, url, b, ts), "content-type": "application/json",
      },
      body: b || undefined,
      okStatus,
    });
  }
}

const COUNTRY: [RegExp, string][] = [[/^(GRA|SBG|RBX|EU-WEST-PAR)/, "FR"], [/^DE/, "DE"], [/^WAW/, "PL"], [/^UK/, "GB"], [/^(BHS|CA)/, "CA"]];

type OvhInstance = { id: string; name: string; region?: string; status?: string; ipAddresses?: { ip: string; type: string; version: number }[] };

export class OvhProvider implements Provider {
  readonly name = "ovh";
  private c: OvhClient;
  constructor(private cfg: OvhCfg) {
    if (!cfg.projectId) throw new Error("OVHcloud: vul het project-ID van je Public Cloud-project in");
    this.c = new OvhClient(cfg);
  }
  private get p() { return `/cloud/project/${encodeURIComponent(this.cfg.projectId!)}`; }
  country(region: string) {
    return COUNTRY.find(([re]) => re.test(region.toUpperCase()))?.[1] ?? "FR";
  }
  private async image(region: string) {
    const want = this.cfg.image ?? "Ubuntu 24.04";
    const { json } = await this.c.call("GET", `${this.p}/image?osType=linux&region=${encodeURIComponent(region)}`);
    const list = json as { id: string; name: string }[];
    const img = list.find((i) => i.name === want) ?? list.find((i) => i.name.includes(want));
    if (!img) throw new Error(`OVHcloud: geen image ${want} in ${region}`);
    return img.id;
  }
  private async flavor(region: string, size: string) {
    const { json } = await this.c.call("GET", `${this.p}/flavor?region=${encodeURIComponent(region)}`);
    const f = (json as { id: string; name: string }[]).find((x) => x.name === size);
    if (!f) throw new Error(`OVHcloud: formaat ${size} bestaat niet in ${region}`);
    return f.id;
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const [imageId, flavorId] = [await this.image(s.region), await this.flavor(s.region, s.size)];
    let { json: inst } = await this.c.call("POST", `${this.p}/instance`, {
      name: `${s.cluster}-${s.nodeId}`, region: s.region, flavorId, imageId, userData: s.userData, monthlyBilling: false,
    }) as { json: OvhInstance };
    const pub = (i: OvhInstance, v: number) => i.ipAddresses?.find((a) => a.type === "public" && a.version === v)?.ip;
    // Het IP-adres komt pas als de instance is opgebouwd.
    for (let i = 0; !pub(inst, 4) && i < ovhTiming.polls; i++) {
      await sleep(ovhTiming.pollMs);
      inst = (await this.c.call("GET", `${this.p}/instance/${inst.id}`)).json;
      if (inst.status === "ERROR") throw new Error(`OVHcloud: instance ${inst.id} kon niet starten`);
    }
    return { serverId: inst.id, ipv4: pub(inst, 4), ipv6: pub(inst, 6), country: this.country(s.region) };
  }
  async destroy(id: string) {
    await this.c.call("DELETE", `${this.p}/instance/${encodeURIComponent(id)}`, undefined, [404]);
  }
  /** OVHcloud-instances hebben geen labels: we herkennen ze aan de naam <cluster>-<node-id>. */
  async list(cluster: string) {
    const { json } = await this.c.call("GET", `${this.p}/instance`);
    const out: { serverId: string; nodeId: string }[] = [];
    for (const i of json as OvhInstance[]) {
      if (!i.name.startsWith(`${cluster}-`)) continue;
      const node = i.name.slice(cluster.length + 1);
      // Node-id's zijn "n-<hex>"; zo valt "eigen-x-n-1" (cluster eigen-x) niet onder cluster "eigen".
      if (/^n-[0-9a-z]+$/.test(node)) out.push({ serverId: i.id, nodeId: node });
    }
    return out;
  }
  // Geen setPtr: reverse DNS van Public Cloud-adressen stel je in via het OVHcloud-beheer (zie PROVIDERS.md).
}

async function ovhSizes(cfg: OvhCfg, region: string): Promise<SizeOption[]> {
  const c = new OvhClient(cfg);
  const { json } = await c.call("GET", `/cloud/project/${encodeURIComponent(cfg.projectId ?? "")}/flavor?region=${encodeURIComponent(region)}`);
  const flavors = (json as { name: string; ram: number; vcpus: number; osType?: string; available?: boolean; planCodes?: { hourly?: string | null; monthly?: string | null } }[])
    .filter((f) => f.available !== false && (f.osType ?? "linux") === "linux" && /^(d2|b2|b3|c2|c3|r2|r3)-\d+$/i.test(f.name));
  // Prijzen uit de openbare catalogus (geen sleutel nodig). Lukt dat niet, dan "prijs onbekend".
  let prices = new Map<string, number>();
  try {
    const { json: cat } = await api(`${ovhBase()}/order/catalog/public/cloud?ovhSubsidiary=FR`);
    prices = new Map(((cat.addons ?? []) as { planCode: string; pricings?: { price: number }[] }[])
      .filter((a) => a.pricings?.length).map((a) => [a.planCode, a.pricings![0].price]));
  } catch { /* geen prijzen */ }
  return flavors.map((f) => {
    const hourly = f.planCodes?.hourly ? prices.get(f.planCodes.hourly) : undefined;
    // Catalogusprijzen staan in 1/100.000.000 euro per uur; een maand = 730 uur.
    return { size: f.name, label: `${f.vcpus} vCPU, ${f.ram} GB`, ramGb: f.ram, cpus: f.vcpus, monthly: hourly !== undefined ? Math.round((hourly / 1e8) * 730 * 100) / 100 : null };
  }).sort((a, b) => (a.monthly ?? a.ramGb * 3) - (b.monthly ?? b.ramGb * 3));
}

/** OVHcloud DNS: records van een zone, daarna de zone verversen. */
export class OvhDns implements DnsProvider {
  private c: OvhClient;
  constructor(readonly name: string, private cfg: OvhCfg & { zone: string }) {
    this.c = new OvhClient(cfg);
  }
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const z = `/domain/zone/${encodeURIComponent(this.cfg.zone)}`;
    const { json: ids } = await this.c.call("GET", `${z}/record?fieldType=${type}${sub ? `&subDomain=${encodeURIComponent(sub)}` : ""}`);
    const existing: { id: number; subDomain: string; target: string; ttl: number }[] = [];
    for (const id of ids as number[]) existing.push((await this.c.call("GET", `${z}/record/${id}`)).json);
    const mine = existing.filter((r) => (r.subDomain ?? "") === sub);
    const keep = new Set<number>();
    const todo = values.filter((v) => {
      const same = mine.find((r) => !keep.has(r.id) && r.target === v && r.ttl === ttl);
      if (same) keep.add(same.id);
      return !same;
    });
    const stale = mine.filter((r) => !keep.has(r.id));
    for (const r of stale) await this.c.call("DELETE", `${z}/record/${r.id}`, undefined, [404]);
    for (const v of todo) await this.c.call("POST", `${z}/record`, { fieldType: type, subDomain: sub, target: v, ttl });
    if (todo.length || stale.length) await this.c.call("POST", `${z}/refresh`);
  }
}

// ───────── Sleutels controleren (alleen lezen) ─────────

const OVH_KEY = "OVHcloud herkent deze sleutels niet. Maak nieuwe sleutels via eu.api.ovh.com/createToken.";
const NO_PROJECT = "Niet gecontroleerd zonder project-ID";

/** Ondertekende GET's met de servertijd (GET /auth/time); geven status en antwoord, gooien niet. */
async function ovhLooker(cfg: OvhCfg) {
  const t = await look(`${ovhBase()}/auth/time`);
  const delta = good(t.status) && typeof t.json === "number" ? t.json - Math.floor(Date.now() / 1000) : 0;
  return (pathq: string) => {
    const url = `${ovhBase()}${pathq}`;
    const ts = Math.floor(Date.now() / 1000) + delta;
    return look(url, { "X-Ovh-Application": cfg.appKey, "X-Ovh-Consumer": cfg.consumerKey, "X-Ovh-Timestamp": String(ts), "X-Ovh-Signature": ovhSign(cfg.appSecret, cfg.consumerKey, "GET", url, "", ts) });
  };
}

type Get = Awaited<ReturnType<typeof ovhLooker>>;
type Rule = { method?: string; path?: string };

/** GET /auth/currentCredential: werkt de sleutel, is hij bevestigd, en welke rechten (rules) heeft hij. */
async function ovhLogin(get: Get): Promise<{ fail: string } | { rules: Rule[] }> {
  const c = await get("/auth/currentCredential");
  if ([400, 401, 403].includes(c.status)) return { fail: OVH_KEY };
  if (!good(c.status)) return { fail: failText(c) };
  if (c.json?.status !== "validated") return { fail: `De consumer key is nog niet bevestigd (status: ${c.json?.status ?? "onbekend"}). Open de bevestigingslink die je kreeg, of maak nieuwe sleutels via eu.api.ovh.com/createToken.` };
  return { rules: (c.json?.rules ?? []) as Rule[] };
}

/** Welke van de nodige rechten [methode, voorbeeldpad, zo tonen] de sleutel niet heeft. */
function ovhMissing(rules: Rule[], need: [string, string, string][], label: string, how: string): KeyCheck {
  const missing = need.filter(([m, p]) => !ruleCovers(rules, m, p)).map(([m, , show]) => `${m} ${show}`);
  return missing.length
    ? row("rights", label, false, `Deze rechten ontbreken: ${missing.join(", ")}. Maak nieuwe sleutels via eu.api.ovh.com/createToken met ${how}.`)
    : row("rights", label, true, "Alle benodigde rechten staan op de sleutel");
}

/** Sleutel, project, servers bekijken, formaten (GRA11) en de rechten uit de sleutel zelf (rules). */
async function ovhCheck(f: Record<string, string>): Promise<KeyCheck[]> {
  const cfg = f as unknown as OvhCfg;
  const get = await ovhLooker(cfg);
  const login = await ovhLogin(get);
  if ("fail" in login) return loginFailed(login.fail, [["project", L.project], ["servers", L.servers], ["sizes", L.sizes], ["rights", L.rights]]);
  const out = [row("login", L.login, true)];
  const pid = cfg.projectId ?? "";
  if (!pid) return [...out, row("project", L.project, false, "Vul het project-ID van je Public Cloud-project in"), row("servers", L.servers, null, NO_PROJECT), row("sizes", L.sizes, null, NO_PROJECT), row("rights", L.rights, null, NO_PROJECT)];
  const p = `/cloud/project/${encodeURIComponent(pid)}`;
  const pr = await get(p);
  out.push(good(pr.status) ? row("project", L.project, true, String(pr.json?.description ?? ""))
    : pr.status === 404 ? row("project", L.project, false, "Dit project bestaat niet (of hoort bij een ander account). Het project-ID staat bovenaan in je Public Cloud-project.")
    : pr.status === 403 ? row("project", L.project, false, "De sleutels mogen dit project niet bekijken (recht GET /cloud/project/* ontbreekt).")
    : row("project", L.project, false, failText(pr)));
  const s = await get(`${p}/instance`);
  out.push(good(s.status) ? row("servers", L.servers, true) : s.status === 403 ? row("servers", L.servers, false, "De sleutels mogen de servers van dit project niet bekijken (recht GET /cloud/project/* ontbreekt).") : row("servers", L.servers, false, failText(s)));
  const fl = await get(`${p}/flavor?region=GRA11`);
  out.push(good(fl.status) ? row("sizes", L.sizes, true, `${Array.isArray(fl.json) ? fl.json.length : 0} formaten`) : row("sizes", L.sizes, false, failText(fl)));
  out.push(ovhMissing(login.rules, [
    ["GET", `/cloud/project/${pid}/instance`, `/cloud/project/${pid}/*`],
    ["POST", `/cloud/project/${pid}/instance`, `/cloud/project/${pid}/instance`],
    ["DELETE", `/cloud/project/${pid}/instance/x`, `/cloud/project/${pid}/instance/*`],
  ], L.rights, "GET/POST/DELETE op /cloud/project/*"));
  return out;
}

/** Sleutel, zone bekijken en de rechten op /domain/zone uit de sleutel zelf. */
async function ovhDnsCheck(f: Record<string, string>, zone: string): Promise<KeyCheck[]> {
  const get = await ovhLooker(f as unknown as OvhCfg);
  const label = zone ? L.zone : L.zones;
  const login = await ovhLogin(get);
  if ("fail" in login) return loginFailed(login.fail, [["zone", label], ["rights", L.dnsRights]]);
  const out = [row("login", L.login, true)];
  const z = await get(zone ? `/domain/zone/${encodeURIComponent(zone)}` : "/domain/zone");
  out.push(good(z.status) ? row("zone", label, true, zone ? `${zone} gevonden` : "")
    : z.status === 404 ? row("zone", label, false, `Zone ${zone} staat niet bij OVHcloud DNS. Zet hem eerst in het OVHcloud-beheer (Web Cloud → Domeinen).`)
    : z.status === 403 ? row("zone", label, false, "De sleutels mogen deze zone niet bekijken (recht GET /domain/zone/* ontbreekt).")
    : row("zone", label, false, failText(z)));
  if (!zone) return [...out, row("rights", L.dnsRights, null, "Niet gecontroleerd zonder domein")];
  out.push(ovhMissing(login.rules, [
    ["GET", `/domain/zone/${zone}/record`, `/domain/zone/${zone}/*`],
    ["POST", `/domain/zone/${zone}/record`, `/domain/zone/${zone}/*`],
    ["DELETE", `/domain/zone/${zone}/record/1`, `/domain/zone/${zone}/record/*`],
  ], L.dnsRights, "GET/POST/DELETE op /domain/zone/*"));
  return out;
}

const ovhFields = [
  { key: "appKey", label: "Application key" },
  { key: "appSecret", label: "Application secret", secret: true },
  { key: "consumerKey", label: "Consumer key", secret: true },
];

export const ovh: ProviderAdapter = {
  id: "ovh",
  name: "OVHcloud",
  owner: "OVH SAS (Frankrijk)",
  home: "FR",
  signupUrl: "https://www.ovhcloud.com/nl/public-cloud/",
  keyHelp: `Maak een Public Cloud-project (het project-ID staat bovenaan in het project). Maak daarna op ${OVH_CREATE_TOKEN_URL.split("?")[0]} een sleutel met de rechten GET/POST/DELETE op /cloud/project/* en, voor DNS, op /domain/zone/*. Je krijgt een application key, application secret en consumer key.`,
  fields: [...ovhFields, { key: "projectId", label: "Project-ID (Public Cloud)" }],
  servers: {
    regions: [
      { id: "GRA11", label: "Gravelines", country: "FR", city: "Gravelines" },
      { id: "SBG5", label: "Straatsburg", country: "FR", city: "Straatsburg" },
      { id: "DE1", label: "Frankfurt", country: "DE", city: "Frankfurt" },
      { id: "WAW1", label: "Warschau", country: "PL", city: "Warschau" },
      { id: "UK1", label: "Londen", country: "GB", city: "Londen" },
    ],
    create: (f) => new OvhProvider(f as never),
    fetchSizes: (f, region) => ovhSizes(f as never, region),
    check: ovhCheck,
  },
  storage: {
    name: "OVHcloud Object Storage",
    regions: [
      { id: "gra", label: "Gravelines", country: "FR", endpoint: "https://s3.gra.io.cloud.ovh.net" },
      { id: "sbg", label: "Straatsburg", country: "FR", endpoint: "https://s3.sbg.io.cloud.ovh.net" },
      { id: "de", label: "Frankfurt", country: "DE", endpoint: "https://s3.de.io.cloud.ovh.net" },
      { id: "waw", label: "Warschau", country: "PL", endpoint: "https://s3.waw.io.cloud.ovh.net" },
      { id: "uk", label: "Londen", country: "GB", endpoint: "https://s3.uk.io.cloud.ovh.net" },
    ],
    keyHelp: "Public Cloud → Users & Roles → gebruiker met de rol ObjectStore operator → S3-sleutels genereren.",
    // De prijslijst was op 12-10-2026 niet op te halen; daarom onbekend.
    pricePerGbMonth: null,
    priceInfo: { vat: "onbekend", checked: "2026-10-12", source: "https://www.ovhcloud.com/nl/public-cloud/prices/", note: "Prijs niet nagekeken" },
  },
  dns: {
    name: "OVHcloud DNS",
    fields: ovhFields,
    keyHelp: "Je domein moet bij OVHcloud DNS staan (Web Cloud → Domeinen → DNS-zone). De sleutel heeft GET/POST/DELETE-rechten op /domain/zone/* nodig; daarmee haalt je server ook zelf zijn HTTPS-certificaten.",
    async connect(fields, zone) {
      const c = new OvhClient(fields as never);
      const r = await c.call("GET", `/domain/zone/${encodeURIComponent(zone)}`, undefined, [401, 403, 404]);
      if (r.status === 401 || r.status === 403) throw new Error("OVHcloud accepteert deze sleutels niet (controleer de rechten op /domain/zone)");
      if (r.status === 404) throw new Error(`Zone ${zone} staat niet bij OVHcloud DNS. Zet hem eerst in het OVHcloud-beheer (Web Cloud → Domeinen).`);
      const ns = (r.json.nameServers ?? []) as string[];
      return { nameservers: ns.length ? ns : ["dns.ovh.net", "ns.ovh.net"] };
    },
    create: (name, f, zone) => new OvhDns(name, { ...(f as never as OvhCfg), zone }),
    check: ovhDnsCheck,
    // github.com/caddy-dns/ovh; endpoint "ovh-eu" = eu.api.ovh.com (zelfde API als hierboven). Zonder alle drie de sleutels: HTTP-01.
    caddy: (f) => f.appKey && f.appSecret && f.consumerKey
      ? `dns ovh {\n\t\t\tendpoint ovh-eu\n\t\t\tapplication_key ${f.appKey}\n\t\t\tapplication_secret ${f.appSecret}\n\t\t\tconsumer_key ${f.consumerKey}\n\t\t}`
      : "",
  },
};
