import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { randomKeyHex } from "../../src/cluster/crypto.js";
import { DEFAULT_POLICY, type ClusterConfig } from "../../src/cluster/config.js";

const root = path.resolve(import.meta.dirname, "../..");

export function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

export interface Harness { base: string; cfg: ClusterConfig; first: { http: number; smtp: number; cl: number; dir: string; pid: number } }

export async function startFirstNode(base: string, policy: Partial<ClusterConfig["policy"]> = {}): Promise<Harness> {
  fs.mkdirSync(base, { recursive: true });
  const [http, smtp, cl] = [await freePort(), await freePort(), await freePort()];
  const dir = path.join(base, "first");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const cfg: ClusterConfig = {
    cluster: "test", nodeId: "n-first", kind: "data", masterKey: randomKeyHex(), clusterPort: 7946,
    advertise: { clusterUrl: `http://127.0.0.1:${cl}`, apiUrl: `http://127.0.0.1:${http}`, ipv4: "127.0.0.1" },
    seeds: [], bootstrapLeader: true, domain: "test.nl",
    stores: [
      { name: "replica-nl", type: "fs", purpose: "replica", country: "NL", dir: path.join(base, "store-replica") },
      { name: "backup-fi", type: "fs", purpose: "backup", country: "FI", dir: path.join(base, "store-backup") },
    ],
    providers: { local: { baseDir: path.join(base, "servers") } },
    dns: [{ type: "file", name: "dnsfile", file: path.join(base, "dns.json") }],
    image: {}, appEnv: { MAIL_DOMAINS: "test.nl", MAIL_FROM: "rene@test.nl", HOSTNAME_FQDN: "mail.test.nl" },
    selfInfo: { provider: "manual" },
    policy: { ...DEFAULT_POLICY, minDataNodes: 2, witnesses: 1, autoHeal: true, autoReplaceAfterMin: 0.15, drillEveryDays: 999, segmentEverySec: 1,
      placement: [{ provider: "local", region: "ams", size: "s", country: "NL" }, { provider: "local", region: "fra", size: "s", country: "DE" }], ...policy },
  };
  fs.writeFileSync(path.join(dir, "data", "cluster.json"), JSON.stringify(cfg, null, 2));
  const log = fs.openSync(path.join(dir, "node.log"), "a");
  const child = spawn(process.execPath, [path.join(root, "scripts/supervise.mjs"), path.join(root, "src/main.ts")], {
    env: { ...process.env, DATA_DIR: path.join(dir, "data"), HTTP_PORT: String(http), SMTP_PORT: String(smtp), CLUSTER_PORT: String(cl), CLUSTER_CONFIG: "", CLUSTER_FAST: "1", NODE_ID: "" },
    detached: true, stdio: ["ignore", log, log], cwd: root,
  });
  child.unref();
  return { base, cfg, first: { http, smtp, cl, dir, pid: child.pid! } };
}

export function servers(base: string): Record<string, { pid: number; nodeId: string; dir: string }> {
  const f = path.join(base, "servers", "servers.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

export function nodeDirs(h: Harness): Record<string, string> {
  const out: Record<string, string> = { "n-first": path.join(h.first.dir, "data") };
  for (const v of Object.values(servers(h.base))) out[v.nodeId] = path.join(v.dir, "data");
  return out;
}

export function readDb<T>(dataDir: string, fn: (db: Database.Database) => T): T | null {
  const f = path.join(dataDir, "eigen-cloud.sqlite");
  if (!fs.existsSync(f)) return null;
  const db = new Database(f, { readonly: true, fileMustExist: true });
  try { return fn(db); } finally { db.close(); }
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000, every = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Timeout: ${what}${lastErr ? " (" + (lastErr as Error).message + ")" : ""}`);
}

const pendingOperations = new Map<string, string>();
export async function api(url: string, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const method = opts.method ?? "GET", mutating = !["GET", "HEAD"].includes(method);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([p, method, opts.token, opts.body])).digest("hex");
  const key = pendingOperations.get(fingerprint) ?? crypto.randomUUID();
  if (mutating) pendingOperations.set(fingerprint, key);
  const r = await fetch(url + p, {
    method: opts.method ?? "GET",
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(mutating ? { "idempotency-key": key } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  if (r.ok || r.status < 500 && !json?.uncertain) pendingOperations.delete(fingerprint);
  return { status: r.status, json, text };
}

export function killAll(h: Harness) {
  for (const pid of [h.first.pid, ...Object.values(servers(h.base)).map((s) => s.pid)]) { try { process.kill(-pid, "SIGKILL"); } catch { /* */ } }
}

export function pidOf(h: Harness, nodeId: string) {
  if (nodeId === "n-first") return h.first.pid;
  return Object.values(servers(h.base)).find((s) => s.nodeId === nodeId)?.pid;
}
