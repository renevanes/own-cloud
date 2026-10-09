import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { request } from "undici";
import type Database from "better-sqlite3";
import { DecryptStream, EncryptStream, deriveKey, encryptedSize, sealJson } from "./crypto.js";
import {
  applyEntries, blobRefs, entriesAfter, ensureSequence, firstSeq, installReplication, lastSeq, lastSeqTerm,
  setLease, setTerm, termAt, trim, type Entry,
} from "./changelog.js";
import { keysFor, writeClusterConfig, type ClusterConfig, type Keys, type Member, type Policy } from "./config.js";
import { makeSnapshot, listChain, prune, storedUpTo, uploadSegment } from "./backup.js";
import { makeStore, type ObjectStore } from "./stores.js";
import { RaftNode, type DataLog } from "./raft.js";
import { openMsg, rpc, sealMsg, signGet, verifyGet } from "./transport.js";
import { makeProvider, type Provider } from "./providers.js";
import { makeDns, type DnsProvider } from "./dns.js";
import { caddyfile } from "./cloudinit.js";
import { runtime } from "./runtime.js";
import { runJobs, autoHeal, createJob, choosePlacement, type JobType } from "./jobs.js";
import { verifyAdminProof } from "./admin.js";
import { isNotLeader } from "./fence.js";
import * as health from "../health.js";
import { place, role } from "./places.js";

export interface NodeRow {
  id: string; name: string | null; kind: "data" | "witness"; provider: string; region: string | null; country: string | null; size: string | null;
  server_id: string | null; ipv4: string | null; ipv6: string | null; cluster_url: string | null; api_url: string | null; status: string;
  join_token_hash: string | null; monthly_cost: number | null; created: number; updated: number; last_error: string | null;
}

const SHA_IN_NAME = /(?:^|\/)([0-9a-f]{64})(?:\.[a-z0-9]+)?$/;

export class ClusterService {
  raft!: RaftNode;
  keys: Keys;
  stores: ObjectStore[];
  db?: Database.Database;
  rpcServer?: FastifyInstance;
  self: Member;
  storeProgress = new Map<string, number>();
  uploadedSeq = 0;
  dnsDirty = true;
  manifestDirty = true;
  leaderInit = false;
  private timers: Record<string, number> = {};
  private looping = false;
  private fetchQueue = new Set<string>();
  private fetching = new Map<string, Promise<boolean>>();
  private restoring = false;
  private providerCache = new Map<string, Provider>();
  lastSnapshotAt = 0;
  private healthRunning = false;

  constructor(public cfg: ClusterConfig, private cfgFile: string, readonly dataDir: string) {
    this.keys = keysFor(cfg);
    this.stores = cfg.kind === "data" ? cfg.stores.map(makeStore) : [];
    this.self = { id: cfg.nodeId, kind: cfg.kind, clusterUrl: cfg.advertise.clusterUrl, apiUrl: cfg.advertise.apiUrl, voter: true };
  }

  // ───────── Starten ─────────

  async start() {
    let log: DataLog | null = null;
    if (this.cfg.kind === "data") {
      this.db = (await import("../db.js")).db;
      installReplication(this.db);
      const db = this.db;
      log = {
        last: () => lastSeqTerm(db),
        termAt: (s) => termAt(db, s),
        firstSeq: () => firstSeq(db),
        entriesAfter: (s, max) => entriesAfter(db, s, max),
        apply: (p, t, e) => applyEntries(db, p, t, e, (x) => this.onEntryApplied(x)),
        setTerm: (t) => setTerm(db, t),
        setLease: (u) => setLease(db, u),
        ensureSequence: (s) => ensureSequence(db, s),
      };
      const caddy = caddyfile(this.cfg);
      if (caddy) fs.writeFileSync(path.join(this.dataDir, "Caddyfile"), caddy, { mode: 0o600 });
    }

    this.raft = new RaftNode(this.self, this.keys.cluster, path.join(this.dataDir, "cluster-state.json"), log, {
      leaderMembers: () => this.registryMembers(),
      onLeader: () => { this.leaderInit = false; },
      onFollower: () => { this.leaderInit = false; },
      onNeedsRestore: (reason) => this.requestRestore(reason),
      onAppended: (info) => this.onAppended(info),
      onMessage: (m) => this.onMessage(m),
      leaderExtras: () => ({ uploadedSeq: this.uploadedSeq }),
    });

    await this.startRpcServer();
    this.raft.start({ seeds: this.cfg.seeds, bootstrapLeader: this.cfg.bootstrapLeader, bootstrapTerm: this.cfg.bootstrapTerm });
    this.wireRuntime();
    setInterval(() => void this.loop(), 1000);
    if (this.cfg.joinToken) void this.joinLoop();
    if (this.db) setTimeout(() => this.scanMissingBlobs(), 2000);
  }

  private wireRuntime() {
    runtime.enabled = true;
    runtime.isLeader = () => this.raft.isLeader();
    runtime.apiServername = this.cfg.apiServername ?? (this.cfg.domain ? `cloud.${this.cfg.domain}` : undefined);
    runtime.leaderApiUrl = () => {
      if (this.raft.role === "leader") return null;
      return this.raft.leader()?.apiUrl ?? null;
    };
    runtime.waitDurable = async () => (this.db ? this.raft.waitDurable(lastSeq(this.db)) : true);
    runtime.spool = (raw) => this.spool(raw);
    runtime.sleeping = () => this.getSetting("cluster_mode") === "sleeping";
  }

  private async startRpcServer() {
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
    app.post("/cluster/rpc", async (req, reply) => {
      let msg: { type: string } & Record<string, unknown>;
      try { msg = openMsg(this.keys.cluster, req.body as Buffer); } catch { return reply.code(401).send("geweigerd"); }
      try {
        const resp = await this.raft.handle(msg);
        reply.header("content-type", "application/octet-stream");
        return reply.send(sealMsg(this.keys.cluster, resp ?? {}));
      } catch (e) {
        return reply.code(500).send((e as Error).message);
      }
    });
    app.get<{ Querystring: { p: string; t: string } }>("/cluster/blob", async (req, reply) => {
      const p = req.query.p;
      if (!this.keys.blobs || !verifyGet(this.keys.cluster, p, req.query.t) || p.includes("..")) return reply.code(401).send();
      const abs = path.join(this.dataDir, p);
      if (!fs.existsSync(abs)) return reply.code(404).send();
      reply.header("content-type", "application/octet-stream");
      return reply.send(fs.createReadStream(abs).pipe(new EncryptStream(this.keys.blobs)));
    });
    app.get("/cluster/health", async () => ({ ok: true, id: this.self.id, role: this.raft?.role }));
    await app.listen({ port: Number(process.env.CLUSTER_PORT ?? this.cfg.clusterPort), host: "0.0.0.0" });
    this.rpcServer = app;
  }

  // ───────── Register / leden ─────────

  getSetting(key: string): string | undefined {
    if (!this.db) return undefined;
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  policy(): Policy {
    const override = this.getSetting("cluster_policy");
    return { ...this.cfg.policy, ...(override ? JSON.parse(override) : {}) };
  }

  nodes(where = "status != 'removed'"): NodeRow[] {
    return this.db!.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY created`).all() as NodeRow[];
  }

  private registryMembers(): Member[] {
    // Tot de leider zijn register heeft bijgewerkt (bijv. na wekken staan oude nodes er nog in) blijft het lidmaatschap ongewijzigd.
    if (!this.db || !this.leaderInit) return this.raft.members;
    const rows = this.nodes("status IN ('syncing', 'ready')");
    const members: Member[] = rows
      .filter((r) => r.cluster_url)
      .map((r) => ({ id: r.id, kind: r.kind, clusterUrl: r.cluster_url!, apiUrl: r.api_url ?? undefined, voter: r.status === "ready" }));
    return members.sort((a, b) => a.id.localeCompare(b.id));
  }

  event(kind: string, message: string, level: "info" | "warn" | "error" = "info", data?: unknown) {
    console.log(`[${level}] ${kind}: ${message}`);
    if (!this.db || !this.raft?.isLeader()) return;
    try {
      this.db.prepare("INSERT INTO cluster_events (ts, level, kind, message, data) VALUES (?, ?, ?, ?, ?)").run(Date.now(), level, kind, message, data ? JSON.stringify(data) : null);
    } catch (e) { if (!isNotLeader(e)) throw e; }
  }

  provider(name: string): Provider {
    let p = this.providerCache.get(name);
    if (!p) {
      const c = this.cfg.providers[name];
      if (!c) throw new Error(`Aanbieder ${name} niet geconfigureerd`);
      this.providerCache.set(name, (p = makeProvider(name, c)));
    }
    return p;
  }

  dns(): DnsProvider[] {
    return this.cfg.dns.map(makeDns);
  }

  // ───────── Hoofdlus ─────────

  private due(name: string, everyMs: number) {
    const now = Date.now();
    if ((this.timers[name] ?? 0) + everyMs > now) return false;
    this.timers[name] = now;
    return true;
  }

  private async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      if (this.db) {
        if (this.due("adminCfg", 5000)) await this.applyAdminConfig().catch((e) => console.error("config:", e.message));
        await this.flushSpool().catch((e) => console.error("spool:", e.message));
        if (this.raft.isLeader()) await this.leaderLoop();
        else await this.fetchSome();
      }
    } catch (e) {
      if (!isNotLeader(e)) console.error("Clusterlus:", e);
    } finally {
      this.looping = false;
    }
  }

  private adminV = 0;
  /** Neemt opslag/aanbieders/DNS uit de (gerepliceerde) beheerconfiguratie over. Draait op elke data-node. */
  async applyAdminConfig() {
    const raw = this.getSetting("admin_config");
    if (!raw) return;
    const a = JSON.parse(raw) as { v: number; stores?: ClusterConfig["stores"]; providers?: ClusterConfig["providers"]; dns?: ClusterConfig["dns"] };
    if (a.v <= this.adminV) return;
    this.adminV = a.v;
    if (a.stores) {
      const before = new Set(this.stores.map((s) => s.name));
      this.cfg.stores = a.stores;
      this.stores = a.stores.map(makeStore);
      if (this.raft.isLeader()) for (const s of this.stores) if (!before.has(s.name)) this.storeProgress.set(s.name, await storedUpTo(s).catch(() => 0));
    }
    if (a.providers) { this.cfg.providers = a.providers; this.providerCache.clear(); }
    if (a.dns) this.cfg.dns = a.dns;
    writeClusterConfig(this.cfgFile, this.cfg);
  }

  private async leaderLoop() {
    const db = this.db!;
    if (!this.leaderInit) await this.initLeadership();
    if (!this.raft.isLeader()) return;
    const pol = this.policy();

    if (this.due("segments", pol.segmentEverySec * 1000)) await this.uploadSegments();
    if (this.due("snapshotCheck", 60_000) && Date.now() - this.lastSnapshotAt > pol.snapshotEveryHours * 3600e3) await this.snapshot();
    await this.uploadBlobs();
    this.promoteSyncing();
    if (this.due("trim", 60_000)) this.trimLog();
    await runJobs(this);
    if (this.due("heal", 5_000)) await autoHeal(this);
    if (this.dnsDirty || this.due("dns", 10 * 60_000)) await this.syncDns();
    if (this.manifestDirty || this.due("manifest", 60_000)) await this.writeManifest();
    if (this.due("prune", 6 * 3600e3)) for (const s of this.stores) await prune(s, pol.retentionDays).catch(() => {});
    if (this.due("reconcile", 12 * 3600e3)) await this.reconcileBlobs();
    if (this.due("purge", 3600e3)) this.purgeTrash();
    if (this.due("zombies", 30 * 60_000)) await this.cleanupZombies();
    if (!this.healthRunning && this.due("health", 15 * 60_000)) {
      // Niet blokkeren: DNS-controles kunnen even duren.
      this.healthRunning = true;
      void this.healthRound().catch((e) => console.error("health:", e)).finally(() => { this.healthRunning = false; });
    }
    if (this.due("drillCheck", 3600e3)) {
      const last = db.prepare("SELECT MAX(ts) AS ts FROM cluster_events WHERE kind = 'drill' AND level = 'info'").get() as { ts: number | null };
      const pending = db.prepare("SELECT 1 FROM cluster_jobs WHERE type = 'drill' AND status IN ('pending','running')").get();
      if (!pending && Date.now() - (last.ts ?? 0) > pol.drillEveryDays * 864e5) createJob(this, "drill", {});
    }
  }

  private async initLeadership() {
    const db = this.db!;
    const now = Date.now();
    if (lastSeq(db) === 0) {
      // Vangnet: nooit leiden met een lege database terwijl er al een back-up bestaat.
      for (const s of this.stores) {
        const chain = await listChain(s).catch(() => null);
        if (chain?.snapshots.some((x) => x.seq > 0)) return this.requestRestore("lege database terwijl er een back-up bestaat");
      }
    }
    const a = this.cfg.advertise;
    const si = this.cfg.selfInfo ?? {};
    db.prepare(`INSERT INTO nodes (id, name, kind, provider, region, size, server_id, country, status, cluster_url, api_url, ipv4, ipv6, created, updated)
      VALUES (?, ?, 'data', ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'ready', cluster_url = excluded.cluster_url, api_url = excluded.api_url, updated = excluded.updated`)
      .run(this.self.id, this.self.id, si.provider ?? "manual", si.region ?? null, si.size ?? null, si.serverId ?? null, si.country ?? null,
        a.clusterUrl, a.apiUrl ?? null, a.ipv4 ?? null, a.ipv6 ?? null, now, now);
    if (this.cfg.initialSettings) {
      for (const [k, v] of Object.entries(this.cfg.initialSettings)) db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(k, v);
      delete this.cfg.initialSettings;
      writeClusterConfig(this.cfgFile, this.cfg);
    }
    if (this.cfg.bootstrapLeader) {
      // Wakker worden / eerste start: alle andere (oude) nodes vervallen; openstaande jobs van vóór het slapen stoppen.
      db.prepare("UPDATE nodes SET status = 'removed', updated = ? WHERE id != ? AND status != 'removed'").run(now, this.self.id);
      db.prepare("UPDATE cluster_jobs SET status = 'failed', error = 'onderbroken (cluster sliep)', updated = ? WHERE status IN ('pending','running')").run(now);
      if (this.getSetting("cluster_mode") === "sleeping") db.prepare("UPDATE settings SET value = 'awake' WHERE key = 'cluster_mode'").run();
      const woke = !!this.cfg.bootstrapTerm;
      this.cfg.bootstrapLeader = false;
      delete this.cfg.bootstrapTerm;
      writeClusterConfig(this.cfgFile, this.cfg);
      this.event("wake", woke ? "Je cloud is weer wakker en heeft alles teruggehaald" : "Je cloud is gestart");
    }
    this.leaderInit = true;
    { const me = this.db!.prepare("SELECT provider, region FROM nodes WHERE id = ?").get(this.self.id) as { provider: string; region: string | null } | undefined; this.event("leader", `${me ? place(me) : this.self.id} leidt nu het cluster`); }
    // Hervat uploads vanaf wat de opslag al heeft (nooit voorbij onze eigen log: hogere seq's zijn van een afgezette leider).
    const mySeq = lastSeq(db);
    let anySnapshot = false;
    for (const s of this.stores) {
      try {
        const chain = await listChain(s);
        if (chain.snapshots.length) {
          anySnapshot = true;
          this.lastSnapshotAt = Math.max(this.lastSnapshotAt, ...chain.snapshots.map((x) => x.ts));
        }
        this.storeProgress.set(s.name, Math.min(await storedUpTo(s), mySeq));
      } catch (e) {
        this.storeProgress.set(s.name, 0);
        this.event("store", `Opslag ${s.name} onbereikbaar: ${(e as Error).message}`, "warn");
      }
    }
    if (!anySnapshot) await this.snapshot();
    this.dnsDirty = true;
    this.manifestDirty = true;
    this.timers.reconcile = Date.now() - 12 * 3600e3 + 30_000;
    this.timers.health = Date.now() - 15 * 60_000 + 90_000; // eerste controle na anderhalve minuut
  }

  // ───────── Wijzigingen en snapshots naar opslag ─────────

  async uploadSegments() {
    const db = this.db!;
    for (const s of this.stores) {
      const from = this.storeProgress.get(s.name) ?? 0;
      const entries = entriesAfter(db, from, 2000);
      if (!entries.length) continue;
      if (entries[0].seq !== from + 1) {
        // Onze log begint later dan wat deze opslag mist: maak een snapshot, dat vult het gat.
        await this.snapshot([s]);
        continue;
      }
      const res = await uploadSegment([s], this.keys.db!, entries);
      const err = res.get(s.name);
      if (err) {
        if (this.due(`storeErr:${s.name}`, 10 * 60_000)) this.event("store", `Upload naar ${s.name} mislukt: ${err.message}`, "warn");
      } else this.storeProgress.set(s.name, entries[entries.length - 1].seq);
    }
    this.uploadedSeq = Math.min(...this.stores.map((s) => this.storeProgress.get(s.name) ?? 0));
  }

  async snapshot(stores = this.stores) {
    const tmpDir = path.join(this.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const snap = await makeSnapshot(this.db!, this.keys.db!, tmpDir);
    let ok = 0;
    for (const s of stores) {
      try {
        await s.put(snap.key, snap.open(), snap.size);
        this.storeProgress.set(s.name, Math.max(this.storeProgress.get(s.name) ?? 0, snap.seq));
        ok++;
      } catch (e) {
        this.event("snapshot", `Snapshot naar ${s.name} mislukt: ${(e as Error).message}`, "warn");
      }
    }
    if (ok) {
      this.lastSnapshotAt = Date.now();
      const mb = snap.plainSize / 1e6;
      this.event("snapshot", `Volledige back-up gemaakt (${mb < 1 ? Math.max(1, Math.round(snap.plainSize / 1024)) + " kB" : mb.toFixed(1).replace(".", ",") + " MB"}) in ${ok === 1 ? "1 opslagplaats" : `${ok} opslagplaatsen`}`, "info", { seq: snap.seq, size: snap.size });
    }
    snap.cleanup();
    this.uploadedSeq = Math.min(...this.stores.map((s) => this.storeProgress.get(s.name) ?? 0));
    return snap;
  }

  // ───────── Bestanden ─────────

  async uploadBlobs(max = 20) {
    const db = this.db!;
    const rows = db.prepare("SELECT rel FROM blob_queue ORDER BY added LIMIT ?").all(max) as { rel: string }[];
    await Promise.all(rows.map(async ({ rel }) => {
      const abs = path.join(this.dataDir, rel);
      if (!fs.existsSync(abs)) { db.prepare("DELETE FROM blob_queue WHERE rel = ?").run(rel); return; }
      const size = fs.statSync(abs).size;
      let allOk = true;
      for (const s of this.stores) {
        try {
          if (await s.head(`blobs/${rel}`)) continue;
          await s.put(`blobs/${rel}`, fs.createReadStream(abs).pipe(new EncryptStream(this.keys.blobs!)), encryptedSize(size));
        } catch (e) {
          allOk = false;
          if (this.due(`blobErr:${s.name}`, 10 * 60_000)) this.event("store", `Bestand naar ${s.name} mislukt: ${(e as Error).message}`, "warn");
        }
      }
      if (allOk) db.prepare("DELETE FROM blob_queue WHERE rel = ?").run(rel);
    }));
  }

  blobQueueLength() {
    return (this.db!.prepare("SELECT COUNT(*) AS n FROM blob_queue").get() as { n: number }).n;
  }

  private onEntryApplied(e: Entry) {
    for (const rel of blobRefs(e)) if (!fs.existsSync(path.join(this.dataDir, rel))) this.fetchQueue.add(rel);
  }

  private referencedBlobs(): string[] {
    const db = this.db!;
    const rows = db.prepare(`
      SELECT raw_path AS p FROM messages WHERE raw_path IS NOT NULL
      UNION ALL SELECT path FROM attachments
      UNION ALL SELECT path FROM photos UNION ALL SELECT thumb_path FROM photos WHERE thumb_path IS NOT NULL`).all() as { p: string }[];
    return rows.map((r) => r.p).filter((p) => p && !path.isAbsolute(p));
  }

  /** Na herstel: alle ontbrekende bestanden op de achtergrond ophalen. */
  private scanMissingBlobs() {
    for (const rel of this.referencedBlobs()) if (!fs.existsSync(path.join(this.dataDir, rel))) this.fetchQueue.add(rel);
  }

  private async fetchSome() {
    const batch = [...this.fetchQueue].slice(0, 8);
    await Promise.all(batch.map(async (rel) => {
      if (await this.fetchBlob(rel)) this.fetchQueue.delete(rel);
    }));
  }

  /** Haalt een bestand op bij de leider of uit de opslag, ontsleutelt en controleert de hash. */
  fetchBlob(rel: string): Promise<boolean> {
    if (rel.includes("..")) return Promise.resolve(false);
    const running = this.fetching.get(rel);
    if (running) return running;
    const p = this.doFetchBlob(rel).finally(() => this.fetching.delete(rel));
    this.fetching.set(rel, p);
    return p;
  }

  private async doFetchBlob(rel: string): Promise<boolean> {
    const abs = path.join(this.dataDir, rel);
    if (fs.existsSync(abs)) return true;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${crypto.randomBytes(4).toString("hex")}.part`;
    const sources: (() => Promise<NodeJS.ReadableStream | null>)[] = [];
    const leader = this.raft.leader();
    if (leader && leader.id !== this.self.id && leader.kind === "data") {
      sources.push(async () => {
        const r = await request(`${leader.clusterUrl}/cluster/blob?p=${encodeURIComponent(rel)}&t=${signGet(this.keys.cluster, rel)}`, { signal: AbortSignal.timeout(120_000) });
        if (r.statusCode !== 200) { await r.body.dump(); return null; }
        return r.body;
      });
    }
    for (const s of this.stores) sources.push(() => s.get(`blobs/${rel}`));
    for (const src of sources) {
      try {
        const stream = await src();
        if (!stream) continue;
        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(tmp);
        const dec = new DecryptStream(this.keys.blobs!);
        dec.on("data", (c: Buffer) => hash.update(c));
        await pipeline(stream, dec, out);
        const m = SHA_IN_NAME.exec(rel);
        if (m && !rel.includes("/thumbs/") && hash.digest("hex") !== m[1]) throw new Error("hash klopt niet");
        fs.renameSync(tmp, abs);
        return true;
      } catch {
        fs.rmSync(tmp, { force: true });
      }
    }
    return false;
  }

  private async reconcileBlobs() {
    const db = this.db!;
    const refs = new Set(this.referencedBlobs());
    for (const s of this.stores) {
      try {
        const have = new Set((await s.list("blobs/")).map((o) => o.key.slice(6)));
        const ins = db.prepare("INSERT OR IGNORE INTO blob_queue (rel, added) VALUES (?, ?)");
        let n = 0;
        for (const r of refs) if (!have.has(r) && fs.existsSync(path.join(this.dataDir, r))) { ins.run(r, Date.now()); n++; }
        if (n) this.event("reconcile", `${n} bestanden ontbraken in ${s.name}; worden opnieuw geüpload`, "warn");
      } catch (e) {
        this.event("reconcile", `Controle ${s.name} mislukt: ${(e as Error).message}`, "warn");
      }
    }
  }

  private purgeTrash() {
    const db = this.db!;
    const cutoff = Date.now() - 30 * 864e5;
    const rows = db.prepare("SELECT id, path, thumb_path FROM photos WHERE deleted_at IS NOT NULL AND deleted_at < ?").all(cutoff) as { id: number; path: string; thumb_path: string | null }[];
    for (const r of rows) {
      db.prepare("DELETE FROM photos WHERE id = ?").run(r.id);
      // Lokale kopie weg; in de back-upopslag blijft het bestand bewaard (bewaartermijn bij de aanbieder).
      fs.rmSync(path.join(this.dataDir, r.path), { force: true });
      if (r.thumb_path) fs.rmSync(path.join(this.dataDir, r.thumb_path), { force: true });
    }
  }

  // ───────── Volger ─────────

  private onAppended(info: { uploadedSeq: number; lastSeq: number }) {
    if (this.db && info.uploadedSeq > 2000 && this.due("ftrim", 60_000)) trim(this.db, info.uploadedSeq - 1000);
  }

  private requestRestore(reason: string) {
    if (this.restoring) return;
    this.restoring = true;
    console.warn(`⚠️  ${this.self.id}: herstel vanaf opslag nodig (${reason}); herstart…`);
    fs.writeFileSync(path.join(this.dataDir, "restore-pending"), JSON.stringify({ reason, ts: Date.now(), term: this.raft.term }));
    setTimeout(() => process.exit(75), 300);
  }

  private trimLog() {
    const db = this.db!;
    const acks = this.raft.members.filter((m) => m.kind === "data" && m.id !== this.self.id).map((m) => this.raft.peers.get(m.id)?.ackSeq ?? 0);
    const floor = Math.min(this.uploadedSeq, ...acks) - 1000;
    if (floor > 0) trim(db, floor);
  }

  private promoteSyncing() {
    const db = this.db!;
    const last = lastSeq(db);
    for (const n of this.nodes("status = 'syncing'")) {
      const p = this.raft.peers.get(n.id);
      if (!p || Date.now() - p.lastContact > 5000) continue;
      if (n.kind === "data" && p.ackSeq < last - 5) continue;
      db.prepare("UPDATE nodes SET status = 'ready', updated = ? WHERE id = ?").run(Date.now(), n.id);
      this.event("node", `Nieuwe ${role(n.kind)} in ${place(n)} is klaar`);
      this.dnsDirty = true;
      this.manifestDirty = true;
      for (const s of this.stores.filter((x) => x.purpose === "replica")) void s.delete(`bootstrap/${n.id}.enc`).catch(() => {});
    }
  }

  // ───────── Berichten tussen nodes ─────────

  private async onMessage(m: { type: string } & Record<string, unknown>) {
    switch (m.type) {
      case "join": {
        if (!this.raft.isLeader() || !this.db) return { ok: false, leaderId: this.raft.leaderId };
        const n = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(m.nodeId) as NodeRow | undefined;
        const hash = crypto.createHash("sha256").update(String(m.token)).digest("hex");
        if (!n || !n.join_token_hash || n.join_token_hash.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(n.join_token_hash), Buffer.from(hash))) return { ok: false, error: "onbekende node of token" };
        if (n.status === "provisioning") {
          this.db.prepare("UPDATE nodes SET status = 'syncing', updated = ? WHERE id = ?").run(Date.now(), n.id);
          this.event("node", `${place(n)} is opgestart en haalt de gegevens op`);
        }
        return { ok: true };
      }
      case "deliverMail": {
        if (!this.raft.isLeader()) return { ok: false };
        const { storeRawMessage } = await import("../mail/store.js");
        await storeRawMessage(Buffer.from(String(m.raw), "base64"), { folder: "inbox" });
        await runtime.waitDurable();
        return { ok: true };
      }
      case "clusterSummary": {
        if (!this.raft.isLeader() || !this.db) return { leader: false, leaderId: this.raft.leaderId };
        const pol = this.policy();
        const nodes = this.nodes("status != 'removed'").map((n) => ({
          id: n.id, kind: n.kind, provider: n.provider, region: n.region, country: n.country, size: n.size, status: n.status, ipv4: n.ipv4,
          monthly_cost: n.monthly_cost, isLeader: n.id === this.self.id,
          lastContact: n.id === this.self.id ? Date.now() : this.raft.peers.get(n.id)?.lastContact ?? null,
        }));
        return {
          leader: true, id: this.self.id, term: this.raft.term, domain: this.cfg.domain ?? null, policy: pol, nodes,
          sleeping: this.getSetting("cluster_mode") === "sleeping",
          health: health.previousHealth(), healthCheckedAt: Number(this.getSetting("health_checked_at") ?? 0) || null,
          lastSnapshotAt: this.lastSnapshotAt || null,
          lastDrill: this.db.prepare("SELECT ts, level, message FROM cluster_events WHERE kind = 'drill' ORDER BY ts DESC LIMIT 1").get() ?? null,
          jobs: this.db.prepare("SELECT id, type, status, error, created FROM cluster_jobs ORDER BY created DESC LIMIT 10").all(),
          events: this.db.prepare("SELECT ts, level, kind, message FROM cluster_events WHERE kind != 'job' ORDER BY id DESC LIMIT 30").all(),
        };
      }
      case "adminJob": {
        if (!this.raft.isLeader() || !this.db) return { ok: false, error: "geen leider" };
        if (!this.cfg.masterKey || !verifyAdminProof(this.cfg.masterKey, m.job, m.proof as { ts: number; mac: string })) return { ok: false, error: "niet ondertekend" };
        const job = m.job as { type: JobType; params: Record<string, unknown> };
        if (!["spawn", "move", "remove", "sleep", "drill", "snapshot"].includes(job.type)) return { ok: false, error: "onbekende job" };
        if (job.type === "spawn" && !job.params.provider) {
          const p = choosePlacement(this, (job.params.kind as "data" | "witness") ?? "data");
          if (p) Object.assign(job.params, { provider: p.provider, region: p.region, size: p.size, country: p.country });
        }
        return { ok: true, id: createJob(this, job.type, job.params) };
      }
      case "adminConfig": {
        // Wijzigingen uit de beheerconsole (opslag, aanbieders, DNS, plaatsing, mailinstellingen).
        if (!this.raft.isLeader() || !this.db) return { ok: false, error: "geen leider" };
        if (!this.cfg.masterKey || !verifyAdminProof(this.cfg.masterKey, m.update, m.proof as { ts: number; mac: string })) return { ok: false, error: "niet ondertekend" };
        const u = m.update as { stores?: unknown; providers?: unknown; dns?: unknown; placement?: unknown; settings?: Record<string, string> };
        const up = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
        this.db.transaction(() => {
          up.run("admin_config", JSON.stringify({ v: Date.now(), stores: u.stores, providers: u.providers, dns: u.dns }));
          if (u.placement) {
            const cur = JSON.parse(this.getSetting("cluster_policy") ?? "{}");
            cur.placement = u.placement;
            up.run("cluster_policy", JSON.stringify(cur));
          }
          for (const [k, v] of Object.entries(u.settings ?? {})) up.run(k, v);
        })();
        await this.applyAdminConfig();
        this.dnsDirty = true;
        this.event("config", "Instellingen bijgewerkt vanuit de beheerconsole");
        return { ok: true };
      }
      case "setPolicy": {
        if (!this.raft.isLeader() || !this.db) return { ok: false, error: "geen leider" };
        if (!this.cfg.masterKey || !verifyAdminProof(this.cfg.masterKey, m.policy, m.proof as { ts: number; mac: string })) return { ok: false, error: "niet ondertekend" };
        const cur = JSON.parse(this.getSetting("cluster_policy") ?? "{}");
        Object.assign(cur, m.policy);
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('cluster_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cur));
        return { ok: true };
      }
      default:
        throw new Error("Onbekend bericht " + m.type);
    }
  }

  private async joinLoop() {
    for (;;) {
      for (const seed of this.raft.members.filter((s) => s.id !== this.self.id)) {
        try {
          const r = await rpc<{ ok: boolean }>(this.keys.cluster, seed.clusterUrl, { type: "join", nodeId: this.self.id, token: this.cfg.joinToken }, 3000);
          if (r.ok) {
            console.log(`🤝 ${this.self.id} is aangesloten`);
            delete this.cfg.joinToken;
            writeClusterConfig(this.cfgFile, this.cfg);
            return;
          }
        } catch { /* volgende */ }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ───────── Secundaire MX ─────────

  private spoolDir() {
    const d = path.join(this.dataDir, "spool");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  spool(raw: Buffer) {
    const name = crypto.createHash("sha256").update(raw).digest("hex") + ".eml";
    const f = path.join(this.spoolDir(), name);
    fs.writeFileSync(f + ".tmp", raw);
    fs.renameSync(f + ".tmp", f);
  }

  private async flushSpool() {
    const dir = this.spoolDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".eml")).slice(0, 20);
    if (!files.length) return;
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f));
      if (this.raft.isLeader()) {
        const { storeRawMessage } = await import("../mail/store.js");
        await storeRawMessage(raw, { folder: "inbox" });
        await runtime.waitDurable();
      } else {
        const leader = this.raft.leader();
        if (!leader || leader.kind !== "data") return;
        const r = await rpc<{ ok: boolean }>(this.keys.cluster, leader.clusterUrl, { type: "deliverMail", raw: raw.toString("base64") }, 15_000);
        if (!r.ok) return;
      }
      fs.rmSync(path.join(dir, f));
    }
  }

  // ───────── DNS, manifest, opruimen ─────────

  private ips() {
    const ready = this.nodes("status = 'ready' AND kind = 'data'");
    return {
      ips4: [...new Set(ready.map((n) => n.ipv4).filter((x): x is string => !!x))].sort(),
      ips6: [...new Set(ready.map((n) => n.ipv6).filter((x): x is string => !!x))].sort(),
    };
  }

  /** Publiceert alle verwachte records (A/AAAA, MX, SPF, DKIM, DMARC) bij elke DNS-aanbieder. */
  async syncDns() {
    if (!this.cfg.dns.length || !health.domain()) { this.dnsDirty = false; return; }
    const ips = this.ips();
    if (!ips.ips4.length) return;
    let ok = true;
    for (const d of this.dns()) {
      try {
        for (const rec of health.expectedRecords(ips)) {
          const r = await health.mergeApexTxt(rec);
          await d.setRecords(r.sub, r.type, r.values, r.ttl);
        }
      } catch (e) {
        ok = false;
        this.event("dns", `DNS bij ${d.name} bijwerken mislukt: ${(e as Error).message}`, "warn");
      }
    }
    if (ok) {
      if (this.dnsDirty) this.event("dns", `DNS bijgewerkt: ${ips.ips4.join(", ")}`);
      this.dnsDirty = false;
    }
  }

  // ───────── Gezondheid ─────────

  healthInfo(): health.ClusterInfo {
    const pol = this.policy();
    const db = this.db!;
    const ready = this.nodes("status = 'ready'");
    const last = lastSeq(db);
    const drill = db.prepare("SELECT ts, level, message FROM cluster_events WHERE kind = 'drill' ORDER BY ts DESC LIMIT 1").get() as { ts: number; level: string; message: string } | undefined;
    const peers = this.raft.peers;
    return {
      ...this.ips(),
      dnsAutomatic: this.cfg.dns.length > 0,
      ptrAutomatic: ready.some((n) => n.provider !== "manual" && !!this.cfg.providers[n.provider] && !!this.provider(n.provider).setPtr),
      snapshotAgeH: this.lastSnapshotAt ? (Date.now() - this.lastSnapshotAt) / 3600e3 : null,
      snapshotEveryH: pol.snapshotEveryHours,
      stores: this.stores.map((s) => ({ name: s.name, country: s.config.country, purpose: s.purpose, lag: this.storeProgress.has(s.name) ? Math.max(0, last - this.storeProgress.get(s.name)!) : null })),
      lastDrill: drill ? { ts: drill.ts, ok: drill.level === "info", message: drill.message } : null,
      drillEveryDays: pol.drillEveryDays,
      dataReady: ready.filter((n) => n.kind === "data").length,
      witnessReady: ready.filter((n) => n.kind === "witness").length,
      wantData: pol.minDataNodes,
      wantWitness: pol.witnesses,
      autoHeal: pol.autoHeal,
      unreachable: ready.filter((n) => n.id !== this.self.id && Date.now() - (peers.get(n.id)?.lastContact ?? 0) > 30_000 && Date.now() - (this.raft.status().leaderSince ?? 0) > 30_000).map((n) => n.id),
    };
  }

  async healthFix(action: string) {
    switch (action) {
      case "dkim:generate":
        health.generateDkim();
        this.dnsDirty = true;
        await this.syncDns();
        return "DKIM-sleutel gemaakt en gepubliceerd";
      case "dns:publish":
        this.dnsDirty = true;
        await this.syncDns();
        return this.dnsDirty ? "Niet alle records konden worden bijgewerkt" : "DNS-records bijgewerkt";
      case "ptr:set": {
        let n = 0;
        for (const node of this.nodes("status = 'ready' AND kind = 'data'")) {
          if (node.provider === "manual" || !node.server_id) continue;
          const p = this.provider(node.provider);
          if (p.setPtr) { await p.setPtr({ serverId: node.server_id, ipv4: node.ipv4 ?? undefined, ipv6: node.ipv6 ?? undefined }, `mail.${health.domain()}`); n++; }
        }
        return `Reverse DNS ingesteld voor ${n} server(s)`;
      }
      case "drill:run": createJob(this, "drill", {}); return "Brandoefening gestart";
      case "snapshot:run": createJob(this, "snapshot", {}); return "Back-up gestart";
      default: throw new Error("Onbekende reparatie");
    }
  }

  /** Elk kwartier op de leider: controleren, veilige dingen zelf repareren, melden bij veranderingen. */
  async healthRound() {
    let checks = await health.runChecks(this.healthInfo());
    const auto: string[] = [];
    const info = this.healthInfo();
    if (info.dnsAutomatic) {
      if (checks.some((c) => c.id === "dns.dkim" && c.fix?.action === "dkim:generate")) auto.push("dkim:generate");
      else if (checks.some((c) => c.fix?.action === "dns:publish")) auto.push("dns:publish");
    }
    if (checks.some((c) => c.fix?.action === "ptr:set")) auto.push("ptr:set");
    for (const a of auto) {
      try { this.event("health", `Automatisch hersteld: ${await this.healthFix(a)}`); } catch (e) { this.event("health", `Automatisch herstel ${a} mislukt: ${(e as Error).message}`, "warn"); }
    }
    if (auto.length) checks = await health.runChecks(this.healthInfo());
    const prev = health.previousHealth();
    const { worse, fixed } = health.isMailNoticeDue(prev, checks);
    health.rememberHealth(checks);
    const to = this.getSetting("alert_email");
    if (to && (worse.length || fixed.length) && Object.keys(prev).length) {
      const url = this.cfg.domain ? `https://cloud.${this.cfg.domain}` : null;
      const subject = worse.length ? `Eigen Cloud: ${worse.length} ${worse.length === 1 ? "ding vraagt" : "dingen vragen"} aandacht` : "Eigen Cloud: alles weer in orde";
      try {
        const { sendNotice } = await import("../mail/send.js");
        await sendNotice(to, subject, health.noticeText(worse, fixed, url));
        this.event("notice", `Melding gestuurd naar ${to}: ${subject}`);
      } catch (e) {
        this.event("notice", `Melding sturen mislukt: ${(e as Error).message}`, "warn");
      }
    }
    return checks;
  }

  manifest(state: "awake" | "asleep" = "awake", topology?: unknown[]) {
    const active = this.nodes("status IN ('provisioning','syncing','ready')");
    const lastDrill = this.db!.prepare("SELECT ts, message FROM cluster_events WHERE kind = 'drill' ORDER BY ts DESC LIMIT 1").get();
    return {
      cluster: this.cfg.cluster, state, term: this.raft.term, lastSeq: lastSeq(this.db!), updated: Date.now(), leader: this.self.id,
      nodes: active.map((n) => ({ id: n.id, kind: n.kind, provider: n.provider, region: n.region, country: n.country, ipv4: n.ipv4, clusterUrl: n.cluster_url, status: n.status })),
      topology: topology ?? active.filter((n) => n.provider !== "manual").map((n) => ({ kind: n.kind, provider: n.provider, region: n.region, size: n.size })),
      lastDrill,
    };
  }

  async writeManifest(state: "awake" | "asleep" = "awake", topology?: unknown[]) {
    const body = sealJson(this.keys.manifest!, this.manifest(state, topology), "manifest");
    let ok = 0;
    for (const s of this.stores) await s.put("manifest.enc", body).then(() => ok++, () => {});
    if (ok) this.manifestDirty = false;
    return ok;
  }

  private async cleanupZombies() {
    const known = new Map(this.nodes("1=1").map((n) => [n.server_id, n]));
    for (const name of Object.keys(this.cfg.providers)) {
      try {
        const p = this.provider(name);
        for (const s of await p.list(this.cfg.cluster)) {
          const n = known.get(s.serverId);
          if (n && n.status !== "removed" && n.status !== "failed") continue;
          const age = n ? Date.now() - n.updated : Infinity;
          const pendingRow = this.db!.prepare("SELECT updated FROM nodes WHERE id = ? AND status = 'provisioning'").get(s.nodeId) as { updated: number } | undefined;
          if (pendingRow && Date.now() - pendingRow.updated < 30 * 60_000) continue;
          if (age < 10 * 60_000) continue;
          await p.destroy(s.serverId);
          this.event("cleanup", `Vergeten server ${s.serverId} bij ${name} verwijderd (kosten)`, "warn");
        }
      } catch (e) {
        this.event("cleanup", `Opruimen bij ${name} mislukt: ${(e as Error).message}`, "warn");
      }
    }
  }

  /** Configuratie voor een nieuwe node (wordt versleuteld in de opslag gezet). */
  nodeConfig(node: { id: string; kind: "data" | "witness"; provider: string; clusterUrl: string; apiUrl?: string; ipv4?: string; ipv6?: string }, joinToken: string): ClusterConfig {
    const base: ClusterConfig = {
      ...this.cfg,
      nodeId: node.id,
      kind: node.kind,
      advertise: { clusterUrl: node.clusterUrl, apiUrl: node.apiUrl, ipv4: node.ipv4, ipv6: node.ipv6 },
      seeds: this.raft.members,
      bootstrapLeader: false,
      joinToken,
    };
    delete base.bootstrapTerm;
    if (node.kind === "witness") {
      return { ...base, masterKey: undefined, clusterKey: this.keys.cluster.toString("hex"), stores: [], providers: {}, dns: [], appEnv: {} };
    }
    return base;
  }

  bootstrapKey(token: string) {
    return deriveKey(Buffer.from(token, "hex"), "bootstrap");
  }
}
