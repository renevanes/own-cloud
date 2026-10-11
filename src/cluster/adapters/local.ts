import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateSpec, Provider, ProviderAdapter, ServerInfo } from "./types.js";

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
    const supervisor = path.resolve(here, "../../../scripts/supervise.mjs");
    const log = fs.openSync(path.join(dir, "node.log"), "a");
    const child = spawn(process.execPath, [supervisor, path.resolve(here, "../../main.ts")], {
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

/** Alleen voor tests (EIGEN_CONSOLE_LOCAL=1): "servers" zijn processen op deze computer. */
export const local: ProviderAdapter = {
  id: "local",
  name: "Lokaal (test)",
  owner: "Deze computer",
  home: "NL",
  signupUrl: "",
  keyHelp: "",
  fields: [],
  testOnly: true,
  servers: {
    regions: [
      { id: "ams", label: "Amsterdam (test)", country: "NL", city: "Amsterdam" },
      { id: "fra", label: "Frankfurt (test)", country: "DE", city: "Frankfurt" },
      { id: "hel", label: "Helsinki (test)", country: "FI", city: "Helsinki" },
    ],
    create: (f) => new LocalProvider(f as never),
    fetchSizes: async () => [{ size: "s", label: "proces op deze computer", ramGb: 4, cpus: 1, monthly: 0 }],
  },
};
