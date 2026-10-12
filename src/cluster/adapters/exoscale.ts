import crypto from "node:crypto";
import type { CreateSpec, DnsProvider, Provider, ProviderAdapter, ServerInfo, SizeOption } from "./types.js";
import { api, parseMx, sleep, unquoteTxt } from "./http.js";
import { L, NOT_CHECKED, RIGHTS_HIDDEN, failText, good, look, row, type KeyCheck } from "./check.js";

/**
 * Exoscale (Zwitserland; zones in CH, DE, AT en BG). Compute API v2 op https://api-<zone>.exoscale.com/v2.
 *
 * Ondertekening EXO2-HMAC-SHA256 (https://openapi-v2.exoscale.com/topic/topic-api-request-signature en de
 * referentie-implementatie requests-exoscale-auth/ExoscaleV2Auth):
 *
 *   bericht  = "<METHOD> <pad zonder query>\n<body>\n<waarden van de query-parameters, op naam gesorteerd, aan elkaar>\n\n<expires>"
 *   handtek. = base64(HMAC-SHA256(geheim, bericht))
 *   header   = "EXO2-HMAC-SHA256 credential=<sleutel>[,signed-query-args=<naam1;naam2>],expires=<unix-tijd>,signature=<handtek.>"
 *
 * (De tekst in de documentatie zegt "HMAC van het base64-gecodeerde bericht"; de referentie-implementatie doet
 * base64 van de HMAC van het bericht. Wij volgen de referentie-implementatie.)
 */
export const EXO_ZONES = ["ch-gva-2", "ch-dk-2", "de-fra-1", "de-muc-1", "at-vie-1", "at-vie-2", "bg-sof-1"];

export const exoBase = (zone: string) => (process.env.EIGEN_EXO_API ?? "https://api-{zone}.exoscale.com/v2").replace("{zone}", zone).replace(/\/$/, "");

/** Wachttijd tussen het opvragen van een lopende operatie (tests zetten hem op 0). */
export const exoTiming = { pollMs: 2000, polls: 90 };

export function exoSign(method: string, url: string, body: string, key: string, secret: string, expires: number) {
  const u = new URL(url);
  const params = new Map<string, string[]>();
  for (const [k, v] of u.searchParams) params.set(k, [...(params.get(k) ?? []), v]);
  const names = [...params.keys()].sort();
  const values = names.filter((n) => params.get(n)!.length === 1).map((n) => params.get(n)![0]).join("");
  const message = [`${method.toUpperCase()} ${u.pathname}`, body, values, "", String(expires)].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(message, "utf8").digest("base64");
  return `EXO2-HMAC-SHA256 credential=${key}${names.length ? `,signed-query-args=${names.join(";")}` : ""},expires=${expires},signature=${signature}`;
}

type ExoCfg = { apiKey: string; apiSecret: string; template?: string; diskGb?: string };
type Op = { id?: string; state?: string; reference?: { id?: string }; message?: string; reason?: string };

/** Ondertekend verzoek naar de Exoscale-API in een zone. */
async function exo(cfg: ExoCfg, zone: string, method: string, pathq: string, body?: unknown, okStatus?: number[]) {
  const url = `${exoBase(zone)}${pathq}`;
  const b = body === undefined ? "" : JSON.stringify(body);
  const authorization = exoSign(method, url, b, cfg.apiKey, cfg.apiSecret, Math.floor(Date.now() / 1000) + 600);
  return api(url, { method, headers: { authorization, "content-type": "application/json" }, body: b || undefined, okStatus });
}

/** Wacht tot een operatie klaar is; geeft het id van het betrokken object terug. */
async function waitOp(cfg: ExoCfg, zone: string, op: Op): Promise<string | undefined> {
  for (let i = 0; i < exoTiming.polls; i++) {
    if (op.state === "success") return op.reference?.id;
    if (op.state === "failure" || op.state === "timeout") throw new Error(`Exoscale: ${op.message ?? op.reason ?? op.state}`);
    if (!op.id) return op.reference?.id;
    await sleep(exoTiming.pollMs);
    op = (await exo(cfg, zone, "GET", `/operation/${op.id}`)).json;
  }
  throw new Error("Exoscale: operatie duurt te lang");
}

const SG_NAME = "eigen-cloud";

export class ExoscaleProvider implements Provider {
  readonly name = "exoscale";
  private sg = new Map<string, string>();
  constructor(private cfg: ExoCfg) {}
  country(zone: string) {
    return zone.slice(0, 2).toUpperCase();
  }
  private async template(zone: string) {
    const want = this.cfg.template ?? "Ubuntu 24.04";
    const { json } = await exo(this.cfg, zone, "GET", "/template?visibility=public");
    const list = ((json.templates ?? []) as { id: string; name: string; zones?: string[]; "created-at"?: string }[])
      .filter((t) => t.name.includes(want) && (!t.zones || t.zones.includes(zone)))
      .sort((a, b) => String(b["created-at"] ?? "").localeCompare(String(a["created-at"] ?? "")));
    if (!list.length) throw new Error(`Exoscale: geen template ${want} in ${zone}`);
    return list[0].id;
  }
  private async instanceType(zone: string, size: string) {
    const { json } = await exo(this.cfg, zone, "GET", "/instance-type");
    const t = ((json["instance-types"] ?? []) as { id: string; family: string; size: string }[]).find((x) => `${x.family}.${x.size}` === size);
    if (!t) throw new Error(`Exoscale: formaat ${size} bestaat niet`);
    return t.id;
  }
  /**
   * Exoscale laat standaard geen verkeer binnen. Eén security group "eigen-cloud" laat alles door;
   * de firewall op de server zelf (ufw, via cloud-init) bepaalt welke poorten echt open zijn.
   */
  private async securityGroup(zone: string) {
    const hit = this.sg.get(zone);
    if (hit) return hit;
    const { json } = await exo(this.cfg, zone, "GET", "/security-group");
    let id = ((json["security-groups"] ?? []) as { id: string; name: string }[]).find((g) => g.name === SG_NAME)?.id;
    if (!id) {
      id = await waitOp(this.cfg, zone, (await exo(this.cfg, zone, "POST", "/security-group", { name: SG_NAME, description: "Eigen Cloud: alles door, de server filtert zelf (ufw)" })).json);
      if (!id) throw new Error("Exoscale: security group aanmaken mislukt");
      for (const rule of [
        { "flow-direction": "ingress", protocol: "tcp", "start-port": 1, "end-port": 65535, network: "0.0.0.0/0" },
        { "flow-direction": "ingress", protocol: "tcp", "start-port": 1, "end-port": 65535, network: "::/0" },
        { "flow-direction": "ingress", protocol: "icmp", network: "0.0.0.0/0", icmp: { type: -1, code: -1 } },
        { "flow-direction": "ingress", protocol: "icmpv6", network: "::/0", icmp: { type: -1, code: -1 } },
      ]) await waitOp(this.cfg, zone, (await exo(this.cfg, zone, "POST", `/security-group/${id}/rules`, rule)).json);
    }
    this.sg.set(zone, id);
    return id;
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const zone = s.region;
    const [template, type, sg] = [await this.template(zone), await this.instanceType(zone, s.size), await this.securityGroup(zone)];
    const op = (await exo(this.cfg, zone, "POST", "/instance", {
      name: `${s.cluster}-${s.nodeId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63),
      "instance-type": { id: type },
      template: { id: template },
      "disk-size": Number(this.cfg.diskGb ?? 25),
      "user-data": Buffer.from(s.userData, "utf8").toString("base64"),
      labels: { cluster: s.cluster, node: s.nodeId, kind: s.kind },
      "security-groups": [{ id: sg }],
      "public-ip-assignment": "inet4",
      "ipv6-enabled": true,
      "auto-start": true,
    })).json as Op;
    const id = await waitOp(this.cfg, zone, op);
    if (!id) throw new Error("Exoscale: geen server-id in het antwoord");
    const { json } = await exo(this.cfg, zone, "GET", `/instance/${id}`);
    return { serverId: `${zone}/${id}`, ipv4: json["public-ip"], ipv6: json["ipv6-address"] || undefined, country: this.country(zone) };
  }
  async destroy(serverId: string) {
    const [zone, id] = serverId.split("/");
    await exo(this.cfg, zone, "DELETE", `/instance/${id}`, undefined, [404]);
  }
  async list(cluster: string) {
    const out: { serverId: string; nodeId: string }[] = [];
    const errors: Error[] = [];
    for (const zone of EXO_ZONES) {
      try {
        const { json } = await exo(this.cfg, zone, "GET", "/instance");
        for (const i of (json.instances ?? []) as { id: string; labels?: Record<string, string> }[]) {
          if (i.labels?.cluster === cluster) out.push({ serverId: `${zone}/${i.id}`, nodeId: i.labels.node ?? "" });
        }
      } catch (e) {
        if (/→ (401|403) /.test((e as Error).message)) throw e;
        errors.push(e as Error);
      }
    }
    if (errors.length === EXO_ZONES.length) throw errors[0];
    return out;
  }
  async setPtr(server: ServerInfo, hostname: string) {
    const [zone, id] = server.serverId.split("/");
    await exo(this.cfg, zone, "POST", `/reverse-dns/instance/${id}`, { "domain-name": hostname });
  }
}

/** Exoscale DNS (v2: dns-domain en records). De DNS-API is wereldwijd; wij praten met de zone ch-gva-2. */
export class ExoscaleDns implements DnsProvider {
  private domainId?: string;
  constructor(readonly name: string, private cfg: ExoCfg & { zone: string }) {}
  private async domain() {
    if (this.domainId) return this.domainId;
    const { json } = await exo(this.cfg, "ch-gva-2", "GET", "/dns-domain");
    const d = ((json["dns-domains"] ?? []) as { id: string; "unicode-name": string }[]).find((x) => x["unicode-name"] === this.cfg.zone);
    if (!d) throw new Error(`Exoscale DNS: zone ${this.cfg.zone} niet gevonden`);
    return (this.domainId = d.id);
  }
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const dom = await this.domain();
    const { json } = await exo(this.cfg, "ch-gva-2", "GET", `/dns-domain/${dom}/record`);
    const existing = ((json["dns-domain-records"] ?? []) as { id: string; name: string; type: string; content: string; ttl?: number; priority?: number; "system-record"?: boolean }[])
      .filter((r) => r.name === sub && r.type === type && !r["system-record"]);
    const want = values.map((v) => type === "MX" ? { content: parseMx(v).host, priority: parseMx(v).priority } : { content: type === "TXT" ? unquoteTxt(v) : v });
    // Bijwerken op dezelfde plek (upsert): bestaande records hergebruiken, wat al klopt overslaan, rest weghalen.
    const keep = new Set<string>();
    const todo = want.filter((w) => {
      const same = existing.find((r) => !keep.has(r.id) && r.content === w.content && r.ttl === ttl && (w.priority === undefined || r.priority === w.priority));
      if (same) keep.add(same.id);
      return !same;
    });
    const free = existing.filter((r) => !keep.has(r.id));
    for (const w of todo) {
      const r = free.shift();
      if (r) await exo(this.cfg, "ch-gva-2", "PUT", `/dns-domain/${dom}/record/${r.id}`, { content: w.content, ttl, ...(w.priority !== undefined ? { priority: w.priority } : {}) });
      else await exo(this.cfg, "ch-gva-2", "POST", `/dns-domain/${dom}/record`, { name: sub, type, content: w.content, ttl, ...(w.priority !== undefined ? { priority: w.priority } : {}) });
    }
    for (const r of free) await exo(this.cfg, "ch-gva-2", "DELETE", `/dns-domain/${dom}/record/${r.id}`, undefined, [404]);
  }
}

async function exoSizes(cfg: ExoCfg, zone: string): Promise<SizeOption[]> {
  const { json } = await exo(cfg, zone, "GET", "/instance-type");
  return ((json["instance-types"] ?? []) as { family: string; size: string; cpus: number; memory: number; authorized?: boolean; zones?: string[] }[])
    .filter((t) => t.family === "standard" && t.authorized !== false && (!t.zones || t.zones.includes(zone)))
    .map((t) => {
      const ramGb = Math.round((t.memory / 1024 ** 3) * 100) / 100;
      // Exoscale heeft geen prijs-API; de console toont dan "prijs onbekend" (zie PROVIDERS.md).
      return { size: `${t.family}.${t.size}`, label: `${t.cpus} vCPU, ${ramGb} GB`, ramGb, cpus: t.cpus, monthly: null };
    })
    .sort((a, b) => a.ramGb - b.ramGb || a.cpus - b.cpus);
}

// ───────── Sleutels controleren (alleen lezen) ─────────

/** Ondertekende GET (geeft status en antwoord; gooit niet). */
function exoLook(cfg: ExoCfg, zone: string, pathq: string) {
  const url = `${exoBase(zone)}${pathq}`;
  return look(url, { authorization: exoSign("GET", url, "", cfg.apiKey, cfg.apiSecret, Math.floor(Date.now() / 1000) + 600) });
}

/**
 * Wat de rol van de sleutel mag met een dienst (compute of dns): GET /api-key/{sleutel} → role-id, GET /iam-role/{id}
 * → policy (default-service-strategy, services.<dienst>.type = allow | deny | rules); zie
 * https://openapi-v2.exoscale.com/operation/operation-get-iam-role. Regels (CEL) rekent de console niet na.
 */
async function exoRights(cfg: ExoCfg, service: string, name: string, label: string): Promise<KeyCheck> {
  const k = await exoLook(cfg, "ch-gva-2", `/api-key/${encodeURIComponent(cfg.apiKey)}`);
  const roleId = k.json?.["role-id"];
  if (!good(k.status) || !roleId) return row("rights", label, null, RIGHTS_HIDDEN);
  const r = await exoLook(cfg, "ch-gva-2", `/iam-role/${encodeURIComponent(roleId)}`);
  if (!good(r.status)) return row("rights", label, null, RIGHTS_HIDDEN);
  const role = r.json?.name ?? "";
  const type = r.json?.policy?.services?.[service]?.type ?? r.json?.policy?.["default-service-strategy"];
  if (type === "allow") return row("rights", label, true, `De rol '${role}' mag alles met ${name}`);
  if (type === "deny") return row("rights", label, false, `De rol '${role}' mag niets met ${name}. Pas de rol aan: Portal → IAM → Rollen → ${name} toestaan.`);
  if (type === "rules") return row("rights", label, null, `De rol '${role}' heeft eigen regels voor ${name}; of dat genoeg is, blijkt bij het starten.`);
  return row("rights", label, null, RIGHTS_HIDDEN);
}

/** GET /instance (inloggen en servers bekijken), /instance-type (formaten; Exoscale heeft geen prijs-API), rol. */
async function exoscaleCheck(f: Record<string, string>): Promise<KeyCheck[]> {
  const cfg = f as unknown as ExoCfg;
  const s = await exoLook(cfg, "ch-gva-2", "/instance");
  if (!good(s.status)) {
    const detail = s.status === 401 || s.status === 403 ? "Exoscale weigert deze sleutel. Controleer sleutel en geheim (Portal → IAM → API-sleutels), en of de rol van de sleutel Compute mag gebruiken." : failText(s);
    return [row("login", L.login, false, detail), row("servers", L.servers, null, NOT_CHECKED), row("sizes", L.sizes, null, NOT_CHECKED), await exoRights(cfg, "compute", "Compute", L.rights)];
  }
  const t = await exoLook(cfg, "ch-gva-2", "/instance-type");
  return [
    row("login", L.login, true), row("servers", L.servers, true),
    good(t.status) ? row("sizes", L.sizes, true, `${(t.json?.["instance-types"] ?? []).length} formaten; prijzen geeft Exoscale niet door`) : row("sizes", L.sizes, false, failText(t)),
    await exoRights(cfg, "compute", "Compute", L.rights),
  ];
}

/** GET /dns-domain (inloggen en zone bekijken) en de rol voor DNS. Maakt de zone NIET aan (dat doet connect). */
async function exoscaleDnsCheck(f: Record<string, string>, zone: string): Promise<KeyCheck[]> {
  const cfg = f as unknown as ExoCfg;
  const label = zone ? L.zone : L.zones;
  const l = await exoLook(cfg, "ch-gva-2", "/dns-domain");
  if (!good(l.status)) {
    const detail = l.status === 401 || l.status === 403 ? "Exoscale weigert deze sleutel voor DNS. Controleer sleutel en geheim, en of de rol van de sleutel DNS mag gebruiken." : failText(l);
    return [row("login", L.login, false, detail), row("zone", label, null, NOT_CHECKED), await exoRights(cfg, "dns", "DNS", L.dnsRights)];
  }
  const found = ((l.json?.["dns-domains"] ?? []) as { "unicode-name": string }[]).some((d) => d["unicode-name"] === zone);
  return [
    row("login", L.login, true),
    !zone ? row("zone", label, true) : found ? row("zone", label, true, `${zone} gevonden`) : row("zone", label, null, `${zone} staat er nog niet; de console maakt hem aan bij het koppelen (daarvoor heb je een DNS-abonnement bij Exoscale nodig).`),
    await exoRights(cfg, "dns", "DNS", L.dnsRights),
  ];
}

const city: Record<string, [string, string]> = {
  "ch-gva-2": ["Genève", "CH"], "ch-dk-2": ["Zürich", "CH"], "de-fra-1": ["Frankfurt", "DE"], "de-muc-1": ["München", "DE"],
  "at-vie-1": ["Wenen 1", "AT"], "at-vie-2": ["Wenen 2", "AT"], "bg-sof-1": ["Sofia", "BG"],
};

export const exoscale: ProviderAdapter = {
  id: "exoscale",
  name: "Exoscale",
  owner: "Exoscale (Zwitserland, A1 Telekom Austria)",
  home: "CH",
  signupUrl: "https://portal.exoscale.com/register",
  keyHelp: "Portal → IAM → Rollen: maak een rol met de diensten Compute en DNS (en SOS voor opslag). Daarna IAM → API-sleutels → sleutel met die rol. Je krijgt een sleutel (begint met EXO) en een geheim.",
  fields: [
    { key: "apiKey", label: "API-sleutel (begint met EXO)" },
    { key: "apiSecret", label: "Geheim", secret: true },
  ],
  servers: {
    regions: EXO_ZONES.map((z) => ({ id: z, label: city[z][0], country: city[z][1], city: city[z][0].replace(/ \d$/, "") })),
    create: (f) => new ExoscaleProvider(f as never),
    fetchSizes: (f, zone) => exoSizes(f as never, zone),
    check: exoscaleCheck,
  },
  storage: {
    name: "Exoscale SOS",
    regions: EXO_ZONES.map((z) => ({ id: z, label: city[z][0], country: city[z][1], endpoint: `https://sos-${z}.exo.io` })),
    keyHelp: "Portal → IAM → API-sleutel met rechten op Object Storage (SOS).",
    // De prijs per GB staat op de prijslijst niet leesbaar (wordt met JavaScript geladen); daarom onbekend.
    pricePerGbMonth: null,
    priceInfo: { vat: "excl", checked: "2026-10-12", source: "https://www.exoscale.com/pricing/", note: "Prijs per GB niet nagekeken" },
  },
  dns: {
    name: "Exoscale DNS",
    keyHelp: "Je hebt een DNS-abonnement bij Exoscale nodig (Portal → DNS). Gebruik een API-sleutel met een rol die DNS mag beheren; de console zet de zone zelf klaar.",
    async connect(fields, zone) {
      const cfg = fields as unknown as ExoCfg;
      let list;
      try { list = (await exo(cfg, "ch-gva-2", "GET", "/dns-domain")).json; } catch (e) {
        if (/→ (401|403) /.test((e as Error).message)) throw new Error("Exoscale accepteert deze sleutel niet voor DNS");
        throw e;
      }
      if (!((list["dns-domains"] ?? []) as { "unicode-name": string }[]).some((d) => d["unicode-name"] === zone)) {
        try { await waitOp(cfg, "ch-gva-2", (await exo(cfg, "ch-gva-2", "POST", "/dns-domain", { "unicode-name": zone })).json); } catch (e) {
          throw new Error(`Zone ${zone} aanmaken bij Exoscale mislukt (heb je een DNS-abonnement?): ${(e as Error).message.slice(0, 160)}`);
        }
      }
      return { nameservers: ["ns1.exoscale.ch", "ns1.exoscale.com", "ns1.exoscale.io", "ns1.exoscale.net"] };
    },
    create: (name, f, zone) => new ExoscaleDns(name, { ...(f as unknown as ExoCfg), zone }),
    check: exoscaleDnsCheck,
  },
};
