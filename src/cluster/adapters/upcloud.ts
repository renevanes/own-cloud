import type { CreateSpec, Provider, ProviderAdapter, ServerInfo } from "./types.js";
import { api, getJson } from "./http.js";

// ───────── UpCloud (Finland, met zones in o.a. Amsterdam en Frankfurt) ─────────

export class UpCloudProvider implements Provider {
  readonly name = "upcloud";
  private base = "https://api.upcloud.com/1.3";
  constructor(private cfg: { username?: string; password?: string; token?: string; template?: string; sshKey?: string }) {}
  private h() {
    const auth = this.cfg.token ? `Bearer ${this.cfg.token}` : "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
    return { authorization: auth, "content-type": "application/json" };
  }
  country(region: string) {
    return region.slice(0, 2).toUpperCase();
  }
  private async template() {
    const want = this.cfg.template ?? "Ubuntu Server 24.04";
    const { json } = await api(`${this.base}/storage/template`, { headers: this.h() });
    const t = (json.storages?.storage ?? []).find((s: { title: string }) => s.title.includes(want));
    if (!t) throw new Error(`UpCloud: template ${want} niet gevonden`);
    return t.uuid as string;
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const body = {
      server: {
        zone: s.region, title: `${s.cluster}-${s.nodeId}`, hostname: `${s.nodeId}.${s.cluster}`, plan: s.size, metadata: "yes", user_data: s.userData,
        labels: { label: [{ key: "cluster", value: s.cluster }, { key: "node", value: s.nodeId }, { key: "kind", value: s.kind }] },
        storage_devices: { storage_device: [{ action: "clone", storage: await this.template(), title: "root", size: 25, tier: "maxiops" }] },
        networking: { interfaces: { interface: [
          { type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
          { type: "public", ip_addresses: { ip_address: [{ family: "IPv6" }] } },
          { type: "utility", ip_addresses: { ip_address: [{ family: "IPv4" }] } },
        ] } },
        login_user: { username: "root", create_password: "no", ...(this.cfg.sshKey ? { ssh_keys: { ssh_key: [this.cfg.sshKey] } } : {}) },
      },
    };
    const { json } = await api(`${this.base}/server`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    const ips = (json.server.ip_addresses?.ip_address ?? []) as { access: string; family: string; address: string }[];
    return {
      serverId: json.server.uuid,
      ipv4: ips.find((i) => i.access === "public" && i.family === "IPv4")?.address,
      ipv6: ips.find((i) => i.access === "public" && i.family === "IPv6")?.address,
      country: this.country(s.region),
    };
  }
  async destroy(uuid: string) {
    const r = await api(`${this.base}/server/${uuid}/stop`, { method: "POST", headers: this.h(), body: JSON.stringify({ stop_server: { stop_type: "hard", timeout: "60" } }), okStatus: [400, 404, 409] });
    if (r.status === 404) return;
    for (let i = 0; i < 40; i++) {
      const { json, status } = await api(`${this.base}/server/${uuid}`, { headers: this.h(), okStatus: [404] });
      if (status === 404 || json.server?.state === "stopped") break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    await api(`${this.base}/server/${uuid}?storages=1&backups=delete`, { method: "DELETE", headers: this.h(), okStatus: [404] });
  }
  async list(cluster: string) {
    const { json } = await api(`${this.base}/server?label=${encodeURIComponent(`cluster=${cluster}`)}`, { headers: this.h() });
    return ((json.servers?.server ?? []) as { uuid: string; labels?: { label: { key: string; value: string }[] } }[]).map((s) => ({
      serverId: s.uuid, nodeId: s.labels?.label.find((l) => l.key === "node")?.value ?? "",
    }));
  }
}

export const upcloud: ProviderAdapter = {
  id: "upcloud",
  name: "UpCloud",
  owner: "UpCloud Ltd (Finland)",
  home: "FI",
  signupUrl: "https://hub.upcloud.com",
  keyHelp: "UpCloud Hub → Account → API-tokens → token maken. Zet bij Account → Permissions ook 'API-toegang' aan.",
  fields: [{ key: "token", label: "API-token", secret: true }],
  servers: {
    regions: [
      { id: "nl-ams1", label: "Amsterdam", country: "NL", city: "Amsterdam" },
      { id: "de-fra1", label: "Frankfurt", country: "DE", city: "Frankfurt" },
      { id: "fi-hel1", label: "Helsinki", country: "FI", city: "Helsinki" },
      { id: "se-sto1", label: "Stockholm", country: "SE", city: "Stockholm" },
    ],
    create: (f) => new UpCloudProvider(f as never),
    async fetchSizes(cfg) {
      const j = await getJson("https://api.upcloud.com/1.3/plan", { authorization: `Bearer ${cfg.token}` });
      return (j.plans.plan as any[])
        .filter((p) => /^\d+xCPU-\d+GB$/.test(p.name))
        .map((p) => ({ size: p.name, label: `${p.core_number} vCPU, ${p.memory_amount / 1024} GB`, ramGb: p.memory_amount / 1024, cpus: p.core_number, monthly: null }))
        .sort((a, b) => a.ramGb - b.ramGb || a.cpus - b.cpus);
    },
  },
  storage: {
    name: "UpCloud Object Storage",
    regions: [{ id: "europe-1", label: "Eigen endpoint (zie UpCloud-console)", country: "FI", endpoint: "" }],
    customEndpoint: true,
    keyHelp: "Maak een Object Storage-instantie; kopieer de endpoint-URL en een toegangssleutel.",
  },
  // UpCloud heeft geen DNS-dienst.
};
