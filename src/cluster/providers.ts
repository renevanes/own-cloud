import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Adapters voor Europese cloudaanbieders. Elke adapter kan een server maken met een cloud-init-script,
 * verwijderen, en de servers van dit cluster opsommen (om vergeten servers op te ruimen).
 *
 * ⚠️ De Scaleway- en UpCloud-adapters volgen de publieke API-documentatie maar zijn niet tegen een live account getest;
 *    test ze eerst met `eigen provider-test <naam>` voordat je ze in de plaatsingsvolgorde zet.
 */

export interface CreateSpec {
  cluster: string;
  nodeId: string;
  kind: "data" | "witness";
  region: string;
  size: string;
  userData: string;
  /** Alleen local-provider: extra omgeving voor het proces. */
  env?: Record<string, string>;
}

export interface ServerInfo {
  serverId: string;
  ipv4?: string;
  ipv6?: string;
  monthlyCost?: number;
  country?: string;
  /** Overschrijft de standaard http://<ipv4>:7946 (local-provider). */
  clusterUrl?: string;
  apiUrl?: string;
}

export interface Provider {
  readonly name: string;
  create(spec: CreateSpec): Promise<ServerInfo>;
  destroy(serverId: string): Promise<void>;
  list(cluster: string): Promise<{ serverId: string; nodeId: string }[]>;
  setPtr?(server: ServerInfo, hostname: string): Promise<void>;
  country(region: string): string;
}

/** Basisadres van de Scaleway-API (in tests een nepserver via EIGEN_SCW_API). */
export const scwApi = () => (process.env.EIGEN_SCW_API ?? "https://api.scaleway.com").replace(/\/$/, "");

async function api(url: string, init: RequestInit & { okStatus?: number[] } = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok && !(init.okStatus ?? []).includes(r.status)) throw new Error(`${init.method ?? "GET"} ${url} → ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}

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

// ───────── Lokaal (processen op deze machine — voor tests en een thuisserver-demo) ─────────

const here = path.dirname(fileURLToPath(import.meta.url));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

export class LocalProvider implements Provider {
  readonly name = "local";
  constructor(private cfg: { baseDir: string }) {
    fs.mkdirSync(cfg.baseDir, { recursive: true });
  }
  private registry() {
    const f = path.join(this.cfg.baseDir, "servers.json");
    return { f, data: (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}) as Record<string, { pid: number; nodeId: string; cluster: string; dir: string }> };
  }
  country() {
    return "NL";
  }
  async create(s: CreateSpec): Promise<ServerInfo> {
    const [http, smtp, cl] = [await freePort(), await freePort(), await freePort()];
    const dir = path.join(this.cfg.baseDir, `${s.nodeId}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const bootstrap = /BOOTSTRAP_URL=(\S+)/.exec(s.userData)?.[1];
    const token = /JOIN_TOKEN=(\S+)/.exec(s.userData)?.[1];
    const supervisor = path.resolve(here, "../../scripts/supervise.mjs");
    const log = fs.openSync(path.join(dir, "node.log"), "a");
    const child = spawn(process.execPath, [supervisor, path.resolve(here, "../main.ts")], {
      env: {
        ...process.env, DATA_DIR: path.join(dir, "data"), HTTP_PORT: String(http), SMTP_PORT: String(smtp), CLUSTER_PORT: String(cl),
        BOOTSTRAP_URL: bootstrap ?? "", JOIN_TOKEN: token ?? "", NODE_ID: s.nodeId, CLUSTER_CONFIG: "", ...(s.env ?? {}),
      },
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    const reg = this.registry();
    const serverId = `local-${s.nodeId}-${http}`;
    reg.data[serverId] = { pid: child.pid!, nodeId: s.nodeId, cluster: s.cluster, dir };
    fs.writeFileSync(reg.f, JSON.stringify(reg.data, null, 2));
    return { serverId, ipv4: "127.0.0.1", clusterUrl: `http://127.0.0.1:${cl}`, apiUrl: `http://127.0.0.1:${http}`, monthlyCost: 0 };
  }
  async destroy(serverId: string) {
    const reg = this.registry();
    const e = reg.data[serverId];
    if (!e) return;
    // Eerst administratie bijwerken: een node kan zichzelf opheffen (slapen).
    delete reg.data[serverId];
    fs.writeFileSync(reg.f, JSON.stringify(reg.data, null, 2));
    try { process.kill(-e.pid, "SIGKILL"); } catch { /* al weg */ }
  }
  async list(cluster: string) {
    return Object.entries(this.registry().data).filter(([, v]) => v.cluster === cluster).map(([k, v]) => ({ serverId: k, nodeId: v.nodeId }));
  }
}

export function makeProvider(name: string, cfg: Record<string, string>): Provider {
  switch (cfg.type ?? name) {
    case "hetzner": return new HetznerProvider(cfg as never);
    case "scaleway": return new ScalewayProvider(cfg as never);
    case "upcloud": return new UpCloudProvider(cfg as never);
    case "local": return new LocalProvider(cfg as never);
    default: throw new Error(`Onbekende aanbieder ${name}`);
  }
}
