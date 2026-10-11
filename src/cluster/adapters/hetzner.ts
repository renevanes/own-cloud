import type { CreateSpec, DnsProvider, Provider, ProviderAdapter, ServerInfo } from "./types.js";
import { api, getJson } from "./http.js";

// ───────── Hetzner Cloud (Duitsland, Finland) ─────────

export class HetznerProvider implements Provider {
  readonly name = "hetzner";
  private base = "https://api.hetzner.cloud/v1";
  constructor(private cfg: { token: string; image?: string; sshKey?: string }) {}
  private h() {
    return { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
  }
  country(region: string) {
    return region.startsWith("hel") ? "FI" : "DE";
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const body = {
      name: `${s.cluster}-${s.nodeId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63),
      server_type: s.size,
      image: this.cfg.image ?? "ubuntu-24.04",
      location: s.region,
      user_data: s.userData,
      labels: { cluster: s.cluster, node: s.nodeId, kind: s.kind },
      public_net: { enable_ipv4: true, enable_ipv6: true },
      ...(this.cfg.sshKey ? { ssh_keys: [this.cfg.sshKey] } : {}),
    };
    const { json } = await api(`${this.base}/servers`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    const srv = json.server;
    const v6net: string | undefined = srv.public_net?.ipv6?.ip;
    const price = (srv.server_type?.prices as { location: string; price_monthly: { gross: string } }[] | undefined)?.find((p) => p.location === s.region);
    return {
      serverId: String(srv.id),
      ipv4: srv.public_net?.ipv4?.ip,
      ipv6: v6net ? v6net.replace(/\/\d+$/, "").replace(/::$/, "::1") : undefined,
      monthlyCost: price ? Number(price.price_monthly.gross) : undefined,
      country: this.country(s.region),
    };
  }
  async destroy(id: string) {
    await api(`${this.base}/servers/${id}`, { method: "DELETE", headers: this.h(), okStatus: [404] });
  }
  async list(cluster: string) {
    const out: { serverId: string; nodeId: string }[] = [];
    for (let page = 1; ; page++) {
      const { json } = await api(`${this.base}/servers?label_selector=${encodeURIComponent(`cluster=${cluster}`)}&per_page=50&page=${page}`, { headers: this.h() });
      for (const s of json.servers ?? []) out.push({ serverId: String(s.id), nodeId: s.labels?.node });
      if (!json.meta?.pagination?.next_page) break;
    }
    return out;
  }
  async setPtr(server: ServerInfo, hostname: string) {
    for (const ip of [server.ipv4, server.ipv6].filter(Boolean)) {
      await api(`${this.base}/servers/${server.serverId}/actions/change_dns_ptr`, { method: "POST", headers: this.h(), body: JSON.stringify({ ip, dns_ptr: hostname }) });
    }
  }
}

/** Hetzner DNS via de Cloud API (zones/rrsets). Controleer of je zone al naar de Cloud Console is gemigreerd. */
export class HetznerDns implements DnsProvider {
  constructor(readonly name: string, private cfg: { token: string; zone: string }) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const base = `https://api.hetzner.cloud/v1/zones/${this.cfg.zone}/rrsets`;
    const h = { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
    const name = sub || "@";
    if (!values.length) {
      const r = await fetch(`${base}/${name}/${type}`, { method: "DELETE", headers: h });
      if (!r.ok && r.status !== 404) throw new Error(`Hetzner DNS delete ${name}/${type}: ${r.status}`);
      return;
    }
    const records = values.map((value) => ({ value }));
    let r = await fetch(`${base}/${name}/${type}/actions/set_records`, { method: "POST", headers: h, body: JSON.stringify({ records }) });
    if (r.status === 404) r = await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ name, type, ttl, records }) });
    if (!r.ok) throw new Error(`Hetzner DNS ${name}/${type}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

export const hetzner: ProviderAdapter = {
  id: "hetzner",
  name: "Hetzner Cloud",
  owner: "Hetzner Online GmbH (Duitsland)",
  home: "DE",
  signupUrl: "https://console.hetzner.com",
  keyHelp: "Hetzner Console → je project → Beveiliging → API-tokens → token met lezen en schrijven.",
  fields: [{ key: "token", label: "API-token (lezen en schrijven)", secret: true }],
  servers: {
    regions: [
      { id: "fsn1", label: "Falkenstein", country: "DE", city: "Falkenstein" },
      { id: "nbg1", label: "Neurenberg", country: "DE", city: "Neurenberg" },
      { id: "hel1", label: "Helsinki", country: "FI", city: "Helsinki" },
    ],
    create: (f) => new HetznerProvider(f as never),
    async fetchSizes(cfg, region) {
      const j = await getJson("https://api.hetzner.cloud/v1/server_types?per_page=50", { authorization: `Bearer ${cfg.token}` });
      return (j.server_types as any[])
        .filter((t) => !t.deprecation && t.architecture === "x86" && t.prices?.some((p: any) => p.location === region))
        .map((t) => ({ size: t.name, label: `${t.cores} vCPU, ${t.memory} GB`, ramGb: t.memory, cpus: t.cores, monthly: Number(t.prices.find((p: any) => p.location === region).price_monthly.gross) }))
        .sort((a, b) => (a.monthly ?? 0) - (b.monthly ?? 0));
    },
  },
  storage: {
    name: "Hetzner Object Storage",
    regions: [
      { id: "fsn1", label: "Falkenstein", country: "DE", endpoint: "https://fsn1.your-objectstorage.com" },
      { id: "nbg1", label: "Neurenberg", country: "DE", endpoint: "https://nbg1.your-objectstorage.com" },
      { id: "hel1", label: "Helsinki", country: "FI", endpoint: "https://hel1.your-objectstorage.com" },
    ],
    keyHelp: "Cloud Console → je project → Object Storage → S3-sleutels aanmaken.",
  },
  dns: {
    name: "Hetzner DNS",
    keyHelp: "Hetzner Console → je project → Beveiliging → API-tokens. Maak de DNS-zone eerst aan (Console → DNS).",
    async connect(fields, zone) {
      const r = await fetch(`https://api.hetzner.cloud/v1/zones?name=${zone}`, { headers: { authorization: `Bearer ${fields.token}` } });
      if (!r.ok) throw new Error("Hetzner accepteert dit token niet (of DNS staat nog in de oude DNS-console)");
      const j = (await r.json()) as { zones?: { authoritative_nameservers?: { assigned?: string[] } }[] };
      if (!j.zones?.length) throw new Error(`Maak eerst de zone ${zone} aan in de Hetzner Console → DNS`);
      return { nameservers: j.zones[0].authoritative_nameservers?.assigned ?? ["hydrogen.ns.hetzner.com", "oxygen.ns.hetzner.com", "helium.ns.hetzner.de"] };
    },
    create: (name, f, zone) => new HetznerDns(name, { token: f.token, zone }),
    caddy: (f) => `dns hetzner ${f.token}`,
  },
};
