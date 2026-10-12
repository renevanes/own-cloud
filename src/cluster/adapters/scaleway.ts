import type { CreateSpec, DnsProvider, Provider, ProviderAdapter, ServerInfo } from "./types.js";
import { api, getJson, parseMx, unquoteTxt } from "./http.js";
import { L, RIGHTS_HIDDEN, failText, good, look, loginFailed, row, type KeyCheck } from "./check.js";

/** Basisadres van de Scaleway-API (in tests een nepserver via EIGEN_SCW_API). */
export const scwApi = () => (process.env.EIGEN_SCW_API ?? "https://api.scaleway.com").replace(/\/$/, "");

// ───────── Scaleway (Frankrijk, Nederland, Polen) ─────────

export class ScalewayProvider implements Provider {
  readonly name = "scaleway";
  constructor(private cfg: { secretKey: string; projectId: string; imageLabel?: string }) {}
  private h(ct = "application/json") {
    return { "x-auth-token": this.cfg.secretKey, "content-type": ct };
  }
  private base(zone: string) {
    return `${scwApi()}/instance/v1/zones/${zone}`;
  }
  country(region: string) {
    return region.startsWith("nl-") ? "NL" : region.startsWith("pl-") ? "PL" : "FR";
  }
  private async image(zone: string) {
    const label = this.cfg.imageLabel ?? "ubuntu_noble";
    const { json } = await api(`${scwApi()}/marketplace/v2/local-images?image_label=${label}&zone=${zone}&type=instance_sbs`, { headers: this.h() });
    const id = json.local_images?.[0]?.id;
    if (!id) throw new Error(`Scaleway: geen image ${label} in ${zone}`);
    return id as string;
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const zone = s.region;
    const ip = (await api(`${this.base(zone)}/ips`, { method: "POST", headers: this.h(), body: JSON.stringify({ project: this.cfg.projectId, type: "routed_ipv4", tags: [`cluster=${s.cluster}`, `node=${s.nodeId}`] }) })).json.ip;
    try {
      const { json } = await api(`${this.base(zone)}/servers`, {
        method: "POST", headers: this.h(),
        body: JSON.stringify({
          name: `${s.cluster}-${s.nodeId}`, commercial_type: s.size, image: await this.image(zone), project: this.cfg.projectId,
          public_ips: [ip.id], tags: [`cluster=${s.cluster}`, `node=${s.nodeId}`, `kind=${s.kind}`],
        }),
      });
      const id = json.server.id as string;
      await api(`${this.base(zone)}/servers/${id}/user_data/cloud-init`, { method: "PATCH", headers: this.h("text/plain"), body: s.userData });
      await api(`${this.base(zone)}/servers/${id}/action`, { method: "POST", headers: this.h(), body: JSON.stringify({ action: "poweron" }) });
      return { serverId: `${zone}/${id}/${ip.id}`, ipv4: ip.address, country: this.country(zone) };
    } catch (e) {
      await api(`${this.base(zone)}/ips/${ip.id}`, { method: "DELETE", headers: this.h(), okStatus: [404] }).catch(() => {});
      throw e;
    }
  }
  async destroy(serverId: string) {
    const [zone, id, ipId] = serverId.split("/");
    await api(`${this.base(zone)}/servers/${id}/action`, { method: "POST", headers: this.h(), body: JSON.stringify({ action: "terminate" }), okStatus: [404] });
    if (ipId) {
      // IP komt pas vrij als de server weg is.
      for (let i = 0; i < 30; i++) {
        const r = await api(`${this.base(zone)}/ips/${ipId}`, { method: "DELETE", headers: this.h(), okStatus: [404, 409, 412] });
        if (r.status < 300 || r.status === 404) break;
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  }
  async clearUserData(serverId: string) {
    const [zone, id] = serverId.split("/");
    await api(`${this.base(zone)}/servers/${id}/user_data/cloud-init`, { method: "DELETE", headers: this.h(), okStatus: [404] });
  }
  async list(cluster: string) {
    const out: { serverId: string; nodeId: string }[] = [];
    for (const zone of ["nl-ams-1", "nl-ams-2", "nl-ams-3", "fr-par-1", "fr-par-2", "fr-par-3", "pl-waw-1", "pl-waw-2", "pl-waw-3"]) {
      const { json } = await api(`${this.base(zone)}/servers?tags=${encodeURIComponent(`cluster=${cluster}`)}&per_page=100`, { headers: this.h() }).catch(() => ({ json: {} as Record<string, never> }));
      for (const s of (json as { servers?: { id: string; tags: string[]; public_ips?: { id: string }[] }[] }).servers ?? []) {
        const node = s.tags.find((t) => t.startsWith("node="))?.slice(5) ?? "";
        out.push({ serverId: `${zone}/${s.id}/${s.public_ips?.[0]?.id ?? ""}`, nodeId: node });
      }
    }
    return out;
  }
}

/**
 * Scaleway Domains and DNS (domain/v2beta1). Records per naam+type vervangen met één PATCH ("set").
 * ⚠️ Niet tegen een live account getest: notatie van MX (data + priority) en TXT (zonder aanhalingstekens) volgt de
 *    API-documentatie, zie PROVIDERS.md.
 */
export class ScalewayDns implements DnsProvider {
  constructor(readonly name: string, private cfg: { secretKey: string; zone: string }) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const id_fields = { name: sub, type };
    const records = values.map((v) => type === "MX"
      ? { name: sub, type, ttl, data: `${parseMx(v).host}.`, priority: parseMx(v).priority }
      : { name: sub, type, ttl, data: type === "TXT" ? unquoteTxt(v) : v });
    const change = values.length ? { set: { id_fields, records } } : { delete: { id_fields } };
    await api(`${scwApi()}/domain/v2beta1/dns-zones/${encodeURIComponent(this.cfg.zone)}/records`, {
      method: "PATCH", headers: { "x-auth-token": this.cfg.secretKey, "content-type": "application/json" },
      body: JSON.stringify({ changes: [change], return_all_records: false }),
      okStatus: values.length ? [] : [404],
    });
  }
}

// ───────── Sleutels controleren (alleen lezen) ─────────

const SCW_KEY = "Scaleway herkent deze geheime sleutel niet. Maak een nieuwe: Console → IAM → API-sleutels.";

/**
 * Rechten van de sleutel via IAM (alleen met de toegangssleutel, SCW…, erbij; die staat niet bij Servers maar wel
 * bij opslag van Scaleway): API-sleutel → gebruiker (eigenaar = alles) of applicatie → groepen → beleid → regels met
 * hun permission sets. Mag de sleutel IAM niet lezen, dan is het onbekend.
 */
async function scwRights(f: Record<string, string>, sets: string[], need: string, label: string, project: string): Promise<KeyCheck> {
  if (!f.accessKey) return row("rights", label, null, RIGHTS_HIDDEN);
  const h = { "x-auth-token": f.secretKey };
  const iam = `${scwApi()}/iam/v1alpha1`;
  const k = await look(`${iam}/api-keys/${encodeURIComponent(f.accessKey)}`, h);
  if (!good(k.status) || (k.json?.secret_key && k.json.secret_key !== f.secretKey)) return row("rights", label, null, RIGHTS_HIDDEN);
  const [param, id] = k.json?.user_id ? ["user_ids", k.json.user_id as string] : ["application_ids", (k.json?.application_id ?? "") as string];
  const who = await look(`${iam}/${param === "user_ids" ? "users" : "applications"}/${encodeURIComponent(id)}`, h);
  if (!good(who.status)) return row("rights", label, null, RIGHTS_HIDDEN);
  if (who.json?.type === "owner") return row("rights", label, true, "De sleutel hoort bij de eigenaar van het account en mag alles");
  const org = encodeURIComponent(who.json?.organization_id ?? "");
  const g = await look(`${iam}/groups?organization_id=${org}&${param}=${encodeURIComponent(id)}&page_size=100`, h);
  if (!good(g.status)) return row("rights", label, null, RIGHTS_HIDDEN);
  const owners = [`${param}=${encodeURIComponent(id)}`, ...((g.json?.groups ?? []) as { id: string }[]).map((x) => `group_ids=${encodeURIComponent(x.id)}`)];
  const policies: string[] = [];
  for (const o of owners) {
    const p = await look(`${iam}/policies?organization_id=${org}&${o}&page_size=100`, h);
    if (!good(p.status)) return row("rights", label, null, RIGHTS_HIDDEN);
    for (const x of (p.json?.policies ?? []) as { id: string }[]) if (!policies.includes(x.id)) policies.push(x.id);
  }
  for (const pid of policies) {
    const r = await look(`${iam}/rules?policy_id=${encodeURIComponent(pid)}&page_size=100`, h);
    if (!good(r.status)) return row("rights", label, null, RIGHTS_HIDDEN);
    for (const rule of (r.json?.rules ?? []) as { permission_set_names?: string[]; project_ids?: string[]; organization_id?: string; account_root_user_id?: string }[]) {
      const hit = (rule.permission_set_names ?? []).find((n) => sets.includes(n));
      if (hit && (rule.organization_id || rule.account_root_user_id || !project || (rule.project_ids ?? []).includes(project))) return row("rights", label, true, `Recht ${hit} gevonden`);
    }
  }
  return row("rights", label, false, `De sleutel mist het recht ${need}. Voeg het toe: Console → IAM → Beleid → je beleid → regel met ${need}${project ? " voor dit project" : ""}.`);
}

/** Servers bekijken (instance-API, Amsterdam 1), formaten en prijzen, en de rechten via IAM. */
async function scalewayCheck(f: Record<string, string>): Promise<KeyCheck[]> {
  const h = { "x-auth-token": f.secretKey };
  const base = `${scwApi()}/instance/v1/zones/nl-ams-1`;
  const s = await look(`${base}/servers?per_page=1${f.projectId ? `&project=${encodeURIComponent(f.projectId)}` : ""}`, h);
  const rest: [string, string][] = [["servers", L.servers], ["sizes", L.sizes], ["rights", L.rights]];
  if (s.status === 401) return loginFailed(SCW_KEY, rest);
  if (!good(s.status) && s.status !== 403) return loginFailed(failText(s), rest);
  const out = [row("login", L.login, true)];
  out.push(good(s.status) ? row("servers", L.servers, true) : row("servers", L.servers, false, "De sleutel mag geen servers bekijken. Geef hem het recht InstancesFullAccess: Console → IAM → Beleid."));
  const t = await look(`${base}/products/servers?per_page=100`, h);
  out.push(good(t.status) ? row("sizes", L.sizes, true, `${Object.keys(t.json?.servers ?? {}).length} formaten`) : row("sizes", L.sizes, false, failText(t)));
  out.push(await scwRights(f, ["AllProductsFullAccess", "InstancesFullAccess"], "InstancesFullAccess", L.rights, f.projectId ?? ""));
  return out;
}

/** DNS-zone bekijken (Domains and DNS) en de rechten via IAM. */
async function scalewayDnsCheck(f: Record<string, string>, zone: string): Promise<KeyCheck[]> {
  const r = await look(`${scwApi()}/domain/v2beta1/dns-zones?${zone ? `dns_zone=${encodeURIComponent(zone)}` : "page_size=1"}`, { "x-auth-token": f.secretKey });
  const label = zone ? L.zone : L.zones;
  const rest: [string, string][] = [["zone", label], ["rights", L.dnsRights]];
  if (r.status === 401) return loginFailed(SCW_KEY, rest);
  if (!good(r.status) && r.status !== 403) return loginFailed(failText(r), rest);
  const out = [row("login", L.login, true)];
  if (r.status === 403) out.push(row("zone", label, false, "De sleutel mag DNS niet bekijken. Geef hem het recht DomainsDNSFullAccess: Console → IAM → Beleid."));
  else if (!zone) out.push(row("zone", label, true));
  else if (((r.json?.dns_zones ?? []) as { domain: string; subdomain: string }[]).some((x) => (x.subdomain ? `${x.subdomain}.${x.domain}` : x.domain) === zone)) out.push(row("zone", label, true, `${zone} gevonden`));
  else out.push(row("zone", label, false, `Zet ${zone} eerst bij Scaleway: Console → Domains and DNS → domein toevoegen`));
  out.push(await scwRights(f, ["AllProductsFullAccess", "DomainsDNSFullAccess"], "DomainsDNSFullAccess", L.dnsRights, ""));
  return out;
}

export const scaleway: ProviderAdapter = {
  id: "scaleway",
  name: "Scaleway",
  owner: "Scaleway SAS (Frankrijk)",
  home: "FR",
  signupUrl: "https://console.scaleway.com",
  keyHelp: "Console → IAM → API-sleutels → sleutel maken. Kopieer de geheime sleutel; het project-ID staat bij Project → Instellingen.",
  fields: [{ key: "secretKey", label: "Geheime API-sleutel", secret: true }, { key: "projectId", label: "Project-ID" }],
  servers: {
    regions: [
      { id: "nl-ams-1", label: "Amsterdam 1", country: "NL", city: "Amsterdam" },
      { id: "nl-ams-2", label: "Amsterdam 2", country: "NL", city: "Amsterdam" },
      { id: "nl-ams-3", label: "Amsterdam 3", country: "NL", city: "Amsterdam" },
      { id: "fr-par-1", label: "Parijs 1", country: "FR", city: "Parijs" },
      { id: "pl-waw-1", label: "Warschau 1", country: "PL", city: "Warschau" },
    ],
    create: (f) => new ScalewayProvider(f as never),
    async fetchSizes(cfg, region) {
      // `api`: een ander basisadres (de Eigen Cloud Dienst gebruikt zijn eigen SCW_API_URL).
      const j = await getJson(`${(cfg.api || scwApi()).replace(/\/+$/, "")}/instance/v1/zones/${region}/products/servers?per_page=100`, { "x-auth-token": cfg.secretKey });
      return Object.entries(j.servers as Record<string, any>)
        .filter(([name, s]) => /^(DEV1|PLAY2|PRO2|GP1|STARDUST|POP2)/i.test(name) && s.arch === "x86_64")
        .map(([name, s]) => ({ size: name, label: `${s.ncpus} vCPU, ${Math.round(s.ram / 1024 ** 3)} GB`, ramGb: Math.round(s.ram / 1024 ** 3), cpus: s.ncpus, monthly: s.monthly_price ?? (s.hourly_price ? Math.round(s.hourly_price * 730 * 100) / 100 : null) }))
        .sort((a, b) => (a.monthly ?? 999) - (b.monthly ?? 999));
    },
    check: scalewayCheck,
  },
  storage: {
    name: "Scaleway Object Storage",
    regions: [
      { id: "nl-ams", label: "Amsterdam", country: "NL", endpoint: "https://s3.nl-ams.scw.cloud" },
      { id: "fr-par", label: "Parijs", country: "FR", endpoint: "https://s3.fr-par.scw.cloud" },
      { id: "pl-waw", label: "Warschau", country: "PL", endpoint: "https://s3.pl-waw.scw.cloud" },
    ],
    keyHelp: "Console → IAM → API-sleutels. Toegangssleutel en geheime sleutel.",
    // Standard Multi-AZ (de standaardklasse): € 0,000022 per GB per uur ≈ € 0,01606 per GB per maand, excl. btw.
    // Nagekeken op 12-10-2026 (prijslijst toont Parijs; Amsterdam en Warschau gaan we uit van hetzelfde).
    pricePerGbMonth: 0.01606,
    priceInfo: { vat: "excl", checked: "2026-10-12", source: "https://www.scaleway.com/en/pricing/storage/", note: "Standard Multi-AZ, prijs voor Parijs" },
  },
  dns: {
    name: "Scaleway DNS",
    fields: [{ key: "secretKey", label: "Geheime API-sleutel", secret: true }],
    keyHelp: "Console → IAM → API-sleutels; de sleutel heeft het recht DomainsDNSFullAccess nodig. Zet je domein eerst in Domains and DNS (bij Scaleway geregistreerd, of als extern domein toegevoegd).",
    async connect(fields, zone) {
      const r = await fetch(`${scwApi()}/domain/v2beta1/dns-zones?dns_zone=${encodeURIComponent(zone)}`, { headers: { "x-auth-token": fields.secretKey } });
      if (r.status === 401 || r.status === 403) throw new Error("Scaleway accepteert deze sleutel niet voor DNS (recht DomainsDNSFullAccess nodig)");
      if (!r.ok) throw new Error(`Scaleway DNS: ${r.status} ${(await r.text()).slice(0, 160)}`);
      const j = (await r.json()) as { dns_zones?: { domain: string; subdomain: string; ns?: string[]; ns_default?: string[]; project_id?: string }[] };
      const z = (j.dns_zones ?? []).find((x) => (x.subdomain ? `${x.subdomain}.${x.domain}` : x.domain) === zone);
      if (!z) throw new Error(`Zet ${zone} eerst bij Scaleway: Console → Domains and DNS → domein toevoegen`);
      // Caddy (DNS-01) wil ook het organisatie-ID; zoek het op via het project van de zone. De console bewaart alle
      // velden ná connect (geen apart invulveld nodig, de sleutel blijft gedeeld met servers). Lukt het niet: HTTP-01.
      if (!fields.organizationId && z.project_id) {
        const p = await fetch(`${scwApi()}/account/v3/projects/${encodeURIComponent(z.project_id)}`, { headers: { "x-auth-token": fields.secretKey } }).catch(() => null);
        const org = p?.ok ? ((await p.json().catch(() => ({}))) as { organization_id?: string }).organization_id : undefined;
        if (org) fields.organizationId = org;
      }
      return { nameservers: z.ns?.length ? z.ns : z.ns_default?.length ? z.ns_default : ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"] };
    },
    create: (name, f, zone) => new ScalewayDns(name, { secretKey: f.secretKey, zone }),
    check: scalewayDnsCheck,
    // github.com/caddy-dns/scaleway; die wil secret_key én organization_id. Zonder organisatie-ID: HTTP-01.
    caddy: (f) => f.secretKey && f.organizationId
      ? `dns scaleway {\n\t\t\tsecret_key ${f.secretKey}\n\t\t\torganization_id ${f.organizationId}\n\t\t}`
      : "",
  },
  quick: { title: "Eén sleutel bij Scaleway", signupUrl: "https://account.scaleway.com/register", keysUrl: "https://console.scaleway.com/iam/api-keys" },
};
