import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sealJson } from "./crypto.js";
import { verifyRestoredBlobs, type BlobProof } from "./recovery.js";
import { lastSeq } from "./changelog.js";
import { restoreFromStore, storedUpTo } from "./backup.js";
import { imageUrls, userData } from "./cloudinit.js";
import { isNotLeader } from "./fence.js";
import type { Placement } from "./config.js";
import { place, role } from "./places.js";
import type { ClusterService, NodeRow } from "./service.js";
import { updateStep, updateTarget, imageTar } from "./updates.js";

/**
 * Duurzame jobs: staan in de (gerepliceerde) database, dus als de leider wegvalt of verhuist,
 * pakt de volgende leider ze op. Elke stap is idempotent en slaat zijn voortgang op vóór de volgende stap.
 */

export type JobType = "spawn" | "remove" | "move" | "sleep" | "drill" | "snapshot" | "update";

interface Job {
  id: string; type: JobType; params: string; state: string; status: string; after: string | null;
  error: string | null; attempts: number; created: number; updated: number;
}

type StepResult = { state?: Record<string, unknown>; done?: boolean; fail?: string } | void;
type Step = (svc: ClusterService, params: Record<string, any>, state: Record<string, any>, job: Job) => Promise<StepResult>;

export function createJob(svc: ClusterService, type: JobType, params: Record<string, unknown>, after?: string) {
  const id = `${type}-${crypto.randomBytes(4).toString("hex")}`;
  const now = Date.now();
  svc.db!.prepare("INSERT INTO cluster_jobs (id, type, params, state, status, after, created, updated) VALUES (?, ?, ?, '{}', 'pending', ?, ?, ?)")
    .run(id, type, JSON.stringify(params), after ?? null, now, now);
  svc.event("job", `Job ${id} aangemaakt`, "info", params);
  return id;
}

let running = false;
export async function runJobs(svc: ClusterService) {
  if (running) return;
  running = true;
  try {
    const db = svc.db!;
    const jobs = db.prepare("SELECT * FROM cluster_jobs WHERE status IN ('pending','running') ORDER BY created").all() as Job[];
    for (const job of jobs) {
      if (!svc.raft.isLeader()) return;
      if (job.after) {
        const dep = db.prepare("SELECT status FROM cluster_jobs WHERE id = ?").get(job.after) as { status: string } | undefined;
        if (dep?.status === "failed") { finish(svc, job, "failed", "afhankelijke job mislukt"); continue; }
        if (dep && dep.status !== "done") continue;
      }
      // Terugvallen na fouten: wacht 5 s × aantal pogingen.
      if (job.error && Date.now() - job.updated < Math.min(60_000, 5000 * job.attempts)) continue;
      const step = STEPS[job.type];
      const params = JSON.parse(job.params);
      const state = JSON.parse(job.state);
      try {
        const r = (await step(svc, params, state, job)) ?? {};
        const newState = JSON.stringify(r.state ?? state);
        if (r.fail) finish(svc, job, "failed", r.fail, newState);
        else if (r.done) finish(svc, job, "done", null, newState);
        else if (newState !== job.state || job.status !== "running" || job.error)
          db.prepare("UPDATE cluster_jobs SET status = 'running', state = ?, error = NULL, updated = ? WHERE id = ?").run(newState, Date.now(), job.id);
      } catch (e) {
        if (isNotLeader(e)) return;
        const attempts = job.attempts + 1;
        const msg = (e as Error).message;
        if (attempts >= 30) finish(svc, job, "failed", msg);
        else db.prepare("UPDATE cluster_jobs SET status = 'running', error = ?, attempts = ?, updated = ? WHERE id = ?").run(msg, attempts, Date.now(), job.id);
      }
    }
  } finally {
    running = false;
  }
}

function finish(svc: ClusterService, job: Job, status: "done" | "failed", error: string | null, state?: string) {
  svc.db!.prepare("UPDATE cluster_jobs SET status = ?, error = ?, state = COALESCE(?, state), updated = ? WHERE id = ?").run(status, error, state ?? null, Date.now(), job.id);
  svc.event("job", `Job ${job.id} ${status === "done" ? "klaar" : "mislukt: " + error}`, status === "done" ? "info" : "error");
}

function node(svc: ClusterService, id: string) {
  return svc.db!.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
}

function updateNode(svc: ClusterService, id: string, fields: Partial<NodeRow>) {
  const keys = Object.keys(fields);
  svc.db!.prepare(`UPDATE nodes SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated = @updated WHERE id = @id`).run({ ...fields, updated: Date.now(), id });
}

// ───────── Plaatsing ─────────

export function choosePlacement(svc: ClusterService, kind: "data" | "witness", avoid?: { provider: string; region: string | null }): Placement | null {
  const options = svc.policy().placement.filter((p) => !p.kind || p.kind === kind);
  if (!options.length) return null;
  const active = svc.nodes("status IN ('provisioning','syncing','ready')");
  const usedProviders = new Set(active.map((n) => n.provider));
  const usedCountries = new Set(active.map((n) => n.country));
  const score = (p: Placement) =>
    (usedProviders.has(p.provider) ? 0 : 4) + (usedCountries.has(p.country ?? "") ? 0 : 2) +
    (avoid && p.provider === avoid.provider && p.region === avoid.region ? -10 : 0);
  return [...options].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Welke versie een nieuwe server krijgt. Na een update: precies die versie — uit je eigen opslag als daar een kopie
 * van staat, anders vast (image@sha256) uit de registry. Daarvoor: wat er in je opslag staat, anders :latest.
 */
async function imageSource(svc: ClusterService, store: import("./stores.js").ObjectStore) {
  const target = updateTarget(svc);
  if (!target) return imageUrls(store);
  const tar = imageTar(svc);
  if (tar?.version === target.version) {
    const urls = await imageUrls(store);
    if (urls.imageUrl) return { ...urls, appImage: `eigen-cloud:${tar.version}`, caddyImage: urls.caddyUrl ? `eigen-caddy:${tar.version}` : target.caddyImage ?? undefined };
  }
  return { appImage: target.image, caddyImage: target.caddyImage ?? undefined };
}

// ───────── Stappen ─────────

const STEPS: Record<JobType, Step> = {
  /** Nieuwe node: register-regel → server bij aanbieder → versleutelde configuratie in opslag → wachten tot hij aangesloten en bij is. */
  async spawn(svc, p, s) {
    const db = svc.db!;
    if (!s.step) {
      const nodeId = `n-${crypto.randomBytes(3).toString("hex")}`;
      const token = crypto.randomBytes(32).toString("hex");
      const now = Date.now();
      db.prepare(`INSERT INTO nodes (id, name, kind, provider, region, size, status, join_token_hash, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?)`)
        .run(nodeId, nodeId, p.kind, p.provider, p.region, p.size, crypto.createHash("sha256").update(token).digest("hex"), now, now);
      svc.event("spawn", `Nieuwe ${role(p.kind)} wordt aangemaakt bij ${place(p as { provider: string; region: string })}`);
      return { state: { step: "create", nodeId, token, started: now } };
    }
    const n = node(svc, s.nodeId);
    if (!n) return { fail: "node verdwenen uit register" };

    if (s.step === "create") {
      const store = svc.stores.find((x) => x.purpose === "replica") ?? svc.stores[0];
      const key = `bootstrap/${n.id}.enc`;
      const prov = svc.provider(p.provider);
      const info = await prov.create({
        cluster: svc.cfg.cluster, nodeId: n.id, kind: p.kind, region: p.region, size: p.size,
        userData: userData(svc.cfg, { nodeId: n.id, kind: p.kind, bootstrapUrl: store.presignGet(key, 7200), joinToken: s.token, ...(await imageSource(svc, store)) }),
      });
      updateNode(svc, n.id, {
        server_id: info.serverId, ipv4: info.ipv4 ?? null, ipv6: info.ipv6 ?? null, country: info.country ?? p.country ?? prov.country(p.region),
        cluster_url: info.clusterUrl ?? `http://${info.ipv4}:${svc.cfg.clusterPort}`, api_url: info.apiUrl ?? `https://${info.ipv4}`,
        monthly_cost: info.monthlyCost ?? null,
      });
      if (p.kind === "data" && svc.cfg.domain && prov.setPtr) await prov.setPtr(info, `mail.${svc.cfg.domain}`).catch((e) => svc.event("ptr", `PTR instellen mislukt: ${e.message}`, "warn"));
      return { state: { ...s, step: "bootstrap", storeName: store.name } };
    }

    if (s.step === "bootstrap") {
      const store = svc.stores.find((x) => x.name === s.storeName)!;
      const conf = svc.nodeConfig({ id: n.id, kind: n.kind, provider: n.provider, clusterUrl: n.cluster_url!, apiUrl: n.api_url ?? undefined, ipv4: n.ipv4 ?? undefined, ipv6: n.ipv6 ?? undefined }, s.token);
      (conf as { selfInfo?: unknown }).selfInfo = { provider: n.provider, region: n.region, size: n.size, serverId: n.server_id, country: n.country };
      await store.put(`bootstrap/${n.id}.enc`, sealJson(svc.bootstrapKey(s.token), conf, "bootstrap"));
      return { state: { ...s, step: "wait" } };
    }

    if (s.step === "wait") {
      if (n.status === "ready") {
        svc.dnsDirty = true;
        svc.manifestDirty = true;
        return { done: true, state: { ...s, token: undefined } };
      }
      if (Date.now() - s.started > 30 * 60_000) {
        if (n.server_id) await svc.provider(n.provider).destroy(n.server_id).catch(() => {});
        updateNode(svc, n.id, { status: "failed", last_error: "niet op tijd aangesloten" });
        return { fail: `${n.id} sloot niet binnen 30 minuten aan` };
      }
    }
  },

  /** Node netjes weghalen. Is het de leider zelf, dan eerst het leiderschap overdragen. */
  async remove(svc, p, s) {
    const n = node(svc, p.nodeId);
    if (!n || n.status === "removed") return { done: true };
    if (!s.step) {
      if (n.id === svc.self.id) {
        const target = svc.nodes("status = 'ready' AND kind = 'data'").find((x) => x.id !== svc.self.id);
        if (!target) return { fail: "kan de enige data-node niet verwijderen" };
        svc.event("transfer", `Leiderschap naar ${target.id} (voor verwijderen van ${n.id})`);
        await svc.raft.transferTo(target.id);
        return; // nieuwe leider gaat verder met deze job
      }
      updateNode(svc, n.id, { status: "removing" });
      svc.dnsDirty = true;
      return { state: { step: "destroy" } };
    }
    if (s.step === "destroy") {
      if (n.server_id && n.provider !== "manual") await svc.provider(n.provider).destroy(n.server_id);
      updateNode(svc, n.id, { status: "removed" });
      for (const st of svc.stores.filter((x) => x.purpose === "replica")) await st.delete(`bootstrap/${n.id}.enc`).catch(() => {});
      svc.event("node", `Server ${place(n)} is opgeheven`);
      svc.manifestDirty = true;
      return { done: true };
    }
  },

  /** Verhuizen = nieuwe node erbij, bijwerken, dan de oude weg (eventueel na leiderschapsoverdracht). */
  async move(svc, p, s) {
    const db = svc.db!;
    const n = node(svc, p.nodeId);
    if (!s.step) {
      if (!n) return { fail: "onbekende node" };
      const to: Placement | null = p.to ?? choosePlacement(svc, n.kind, { provider: n.provider, region: n.region });
      if (!to) return { fail: "geen plaatsingsopties in het beleid" };
      const child = createJob(svc, "spawn", { kind: n.kind, provider: to.provider, region: to.region, size: to.size, country: to.country });
      return { state: { step: "spawning", child } };
    }
    const child = db.prepare("SELECT status FROM cluster_jobs WHERE id = ?").get(s.step === "spawning" ? s.child : s.removeJob) as { status: string } | undefined;
    if (s.step === "spawning") {
      if (child?.status === "failed") return { fail: "nieuwe node kon niet gestart worden" };
      if (child?.status !== "done") return;
      const removeJob = createJob(svc, "remove", { nodeId: p.nodeId });
      return { state: { ...s, step: "removing", removeJob } };
    }
    if (s.step === "removing") {
      if (child?.status === "failed") return { fail: "oude node kon niet verwijderd worden" };
      if (child?.status === "done") return { done: true };
    }
  },

  /**
   * Slapen: alles wegschrijven, controleren, manifest bijwerken, servers weg. Daarna kost het cluster alleen opslag.
   * Mail die binnenkomt terwijl het slaapt, wordt door verzenders tot ~5 dagen opnieuw aangeboden.
   */
  async sleep(svc, _p, s, job) {
    const db = svc.db!;
    if (!s.step) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('cluster_mode', 'sleeping') ON CONFLICT(key) DO UPDATE SET value = 'sleeping'").run();
      svc.event("sleep", "Je cloud gaat slapen: alles wordt weggeschreven en gecontroleerd");
      return { state: { step: "flush" } };
    }
    if (s.step === "flush") {
      if (!s.snap) {
        await svc.snapshot();
        return { state: { ...s, snap: true } };
      }
      await svc.uploadSegments();
      await svc.uploadBlobs(100);
      const seq = lastSeq(db);
      const behind = svc.stores.filter((x) => (svc.storeProgress.get(x.name) ?? 0) < seq);
      if (behind.length || svc.blobQueueLength()) return;
      return { state: { ...s, step: "verify" } };
    }
    if (s.step === "verify") {
      const seq = lastSeq(db);
      for (const st of svc.stores) if ((await storedUpTo(st)) < seq) return { state: { ...s, step: "flush" } };
      const topology = svc.manifest().topology;
      if (!(await svc.writeManifest("asleep", topology))) throw new Error("manifest niet geschreven");
      return { state: { ...s, step: "others", topology } };
    }
    if (s.step === "others") {
      const others = svc.nodes("status IN ('provisioning','syncing','ready','removing')").filter((n) => n.id !== svc.self.id);
      if (!s.marked) {
        // Eerst uit het lidmaatschap, zodat we zonder meerderheid kunnen blijven schrijven.
        db.prepare("UPDATE nodes SET status = 'removing', updated = ? WHERE id != ? AND status IN ('provisioning','syncing','ready')").run(Date.now(), svc.self.id);
        return { state: { ...s, marked: true, others: others.map((o) => o.id) } };
      }
      for (const id of s.others as string[]) {
        const n = node(svc, id);
        if (!n || n.status === "removed") continue;
        if (n.server_id && n.provider !== "manual") await svc.provider(n.provider).destroy(n.server_id);
        updateNode(svc, id, { status: "removed" });
      }
      return { state: { ...s, step: "self" } };
    }
    if (s.step === "self") {
      // Job afronden en laatste wijzigingen wegschrijven vóórdat deze server zichzelf opheft.
      db.prepare("UPDATE cluster_jobs SET status = 'done', updated = ? WHERE id = ?").run(Date.now(), job.id);
      svc.event("sleep", "Je cloud slaapt. Wakker maken kan vanuit de beheerconsole");
      await svc.uploadSegments();
      await svc.writeManifest("asleep", s.topology);
      const me = node(svc, svc.self.id);
      const info = (svc.cfg as { selfInfo?: { provider?: string; serverId?: string } }).selfInfo;
      const provider = me?.server_id ? me.provider : info?.provider;
      const serverId = me?.server_id ?? info?.serverId;
      if (provider && serverId && provider !== "manual") {
        setTimeout(() => void svc.provider(provider).destroy(serverId).catch((e) => console.error("Zelf opheffen mislukt:", e)), 500);
      } else {
        console.log("Deze server is handmatig aangemaakt; zet hem zelf uit. Data staat veilig in de opslag.");
      }
      return { done: true, state: { ...s, step: "gone" } };
    }
  },

  /** Brandoefening: herstel uit elke opslag apart en controleer alle bestanden gestreamd. */
  async drill(svc) {
    const results: { store: string; ok: boolean; detail: string; seq?: number; lastTs?: number | null; durationMs: number; blobs?: BlobProof }[] = [];
    for (const st of svc.stores) {
      const t0 = Date.now();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drill-"));
      const file = path.join(tmp, "drill.sqlite");
      try {
        const r = await restoreFromStore(st, svc.keys.db!, file);
        if (!r) throw new Error("geen bruikbare snapshot");
        const expected = svc.storeProgress.get(st.name) ?? 0;
        if (r.seq < expected) throw new Error(`hersteld tot seq ${r.seq}, verwacht minstens ${expected}`);
        const rdb = new Database(file, { readonly: true });
        const counts = Object.fromEntries(["messages", "events", "photos"].map((t) => [t, (rdb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
        let blobs: BlobProof;
        try { blobs = await verifyRestoredBlobs(rdb, st, svc.keys.blobs!); } finally { rdb.close(); }
        const ok = blobs.missing === 0 && blobs.damaged === 0;
        results.push({ store: st.name, ok, seq: r.seq, lastTs: r.lastTs, durationMs: Date.now() - t0, blobs,
          detail: `seq ${r.seq}, ${counts.messages} mails, ${counts.events} afspraken, ${counts.photos} foto's, ${blobs.checked}/${blobs.total} bestanden gecontroleerd; ${blobs.missing} ontbreken, ${blobs.damaged} beschadigd` });
      } catch (e) {
        results.push({ store: st.name, ok: false, detail: (e as Error).message, durationMs: Date.now() - t0 });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const allOk = results.length > 0 && results.every((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    svc.event("drill", allOk
      ? `Back-uptest geslaagd: herstellen uit ${results.length === 1 ? "de opslag" : `alle ${results.length} opslagplaatsen`} werkt`
      : `Back-uptest mislukt voor ${failed.map((r) => `${r.store} (${r.detail})`).join(", ")}`, allOk ? "info" : "error", results);
    svc.manifestDirty = true;
    return allOk ? { done: true, state: { results } } : { fail: "herstel uit een of meer opslagplaatsen mislukt", state: { results } };
  },

  async snapshot(svc) {
    await svc.snapshot();
    return { done: true };
  },

  update: (svc, p, s) => updateStep(svc, p, s),
};

// ───────── Zelfherstel ─────────

export async function autoHeal(svc: ClusterService) {
  const pol = svc.policy();
  if (!pol.autoHeal || svc.getSetting("cluster_mode") === "sleeping") return;
  const db = svc.db!;
  const loadOpen = () => db.prepare("SELECT type, params FROM cluster_jobs WHERE status IN ('pending','running')").all() as { type: string; params: string }[];
  let openJobs = loadOpen();
  if (openJobs.some((j) => j.type === "sleep")) return;
  const busyNodes = new Set(openJobs.filter((j) => j.type === "move" || j.type === "remove").map((j) => JSON.parse(j.params).nodeId as string));
  // Een server die net wordt bijgewerkt, is even weg: niet vervangen (maar hij telt gewoon mee).
  const updating = new Set<string>();
  for (const u of db.prepare("SELECT state FROM cluster_jobs WHERE type = 'update' AND status IN ('pending','running')").all() as { state: string }[]) {
    const cur = JSON.parse(u.state).current;
    if (cur) updating.add(cur);
  }
  const kindOf = (j: { type: string; params: string }) => {
    const p = JSON.parse(j.params);
    return (p.kind ?? (p.nodeId ? svc.db!.prepare("SELECT kind FROM nodes WHERE id = ?").pluck().get(p.nodeId) : undefined)) as string | undefined;
  };

  // 1. Onbereikbare nodes vervangen.
  const since = svc.raft.status().leaderSince ?? Date.now();
  for (const n of svc.nodes("status = 'ready'")) {
    if (n.id === svc.self.id || busyNodes.has(n.id) || updating.has(n.id)) continue;
    const last = Math.max(svc.raft.peers.get(n.id)?.lastContact ?? 0, since);
    if (Date.now() - last > pol.autoReplaceAfterMin * 60_000) {
      const to = choosePlacement(svc, n.kind, { provider: n.provider, region: n.region });
      if (!to) continue;
      svc.event("heal", `${place(n)} is ${Math.max(1, Math.round((Date.now() - last) / 60_000))} min onbereikbaar en wordt vervangen door een server in ${place(to)}`, "warn");
      createJob(svc, "move", { nodeId: n.id, to, kind: n.kind });
      busyNodes.add(n.id);
    }
  }

  // 2. Aanvullen tot het gewenste aantal (opnieuw inlezen: stap 1 kan net verhuizingen aangemaakt hebben).
  openJobs = loadOpen();
  for (const kind of ["data", "witness"] as const) {
    const want = kind === "data" ? pol.minDataNodes : pol.witnesses;
    const have = svc.nodes(`status IN ('provisioning','syncing','ready') AND kind = '${kind}'`).filter((n) => !busyNodes.has(n.id)).length;
    // Een verhuizing telt als één node in aanbouw (de spawn-job die hij maakt niet nog eens meetellen).
    const moves = openJobs.filter((j) => j.type === "move" && kindOf(j) === kind).length;
    const spawns = openJobs.filter((j) => j.type === "spawn" && kindOf(j) === kind).length;
    const pendingSpawns = Math.max(moves, spawns);
    if (have + pendingSpawns < want) {
      const to = choosePlacement(svc, kind);
      if (!to) continue;
      svc.event("heal", `Er ${want - have === 1 ? "ontbreekt een" : "ontbreken"} ${role(kind)}${want - have === 1 ? "" : "s"}; nieuwe in ${place(to)}`);
      createJob(svc, "spawn", { kind, provider: to.provider, region: to.region, size: to.size, country: to.country });
    }
  }
}
