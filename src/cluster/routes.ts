import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { lastSeq } from "./changelog.js";
import { choosePlacement, createJob, type JobType } from "./jobs.js";
import type { ClusterService } from "./service.js";

let svc: ClusterService | null = null;
export function setClusterService(s: ClusterService) {
  svc = s;
}

const ALLOWED: JobType[] = ["spawn", "move", "remove", "sleep", "drill", "snapshot"];

export function clusterRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/api/cluster")) return requireAuth(req, reply);
  });

  /** Status van déze node (wordt niet doorgestuurd naar de leider). */
  app.get("/api/cluster/local", async () => (svc ? { enabled: true, ...svc.raft.status() } : { enabled: false }));

  app.get("/api/cluster/status", async () => {
    if (!svc?.db) return { enabled: false };
    const db = svc.db;
    const st = svc.raft.status();
    const nodes = svc.nodes("1=1").filter((n) => n.status !== "removed" || Date.now() - n.updated < 7 * 864e5).map((n) => {
      const p = svc!.raft.peers.get(n.id);
      return {
        ...n, join_token_hash: undefined,
        isLeader: n.id === st.leaderId,
        isSelf: n.id === svc!.self.id,
        lastContact: n.id === svc!.self.id ? Date.now() : p?.lastContact ?? null,
        lag: n.kind === "data" && p ? Math.max(0, st.lastSeq - p.ackSeq) : n.id === svc!.self.id ? 0 : null,
      };
    });
    return {
      enabled: true,
      cluster: svc.cfg.cluster,
      domain: svc.cfg.domain ?? null,
      self: svc.self.id,
      leader: st.leaderId,
      term: st.term,
      lastSeq: lastSeq(db),
      durableSeq: st.durableSeq,
      sleeping: svc.getSetting("cluster_mode") === "sleeping",
      policy: svc.policy(),
      providers: Object.keys(svc.cfg.providers),
      stores: svc.stores.map((s) => ({ name: s.name, purpose: s.purpose, country: s.config.country ?? null, uploadedSeq: svc!.storeProgress.get(s.name) ?? null })),
      blobQueue: svc.blobQueueLength(),
      monthlyCost: nodes.filter((n) => n.status !== "removed" && n.status !== "failed").reduce((a, n) => a + (n.monthly_cost ?? 0), 0),
      nodes,
      jobs: db.prepare("SELECT id, type, params, status, error, created, updated FROM cluster_jobs ORDER BY created DESC LIMIT 20").all(),
      events: db.prepare("SELECT ts, level, kind, message FROM cluster_events ORDER BY id DESC LIMIT 60").all(),
    };
  });

  app.post<{ Body: { type: JobType; params?: Record<string, unknown> } }>("/api/cluster/jobs", async (req, reply) => {
    if (!svc?.db) return reply.code(400).send({ error: "Geen cluster" });
    const { type, params = {} } = req.body ?? ({} as never);
    if (!ALLOWED.includes(type)) return reply.code(400).send({ error: "Onbekend jobtype" });
    if (type === "spawn") {
      const kind = params.kind === "witness" ? "witness" : "data";
      if (!params.provider) {
        const p = choosePlacement(svc, kind);
        if (!p) return reply.code(400).send({ error: "Geen plaatsingsopties in het beleid" });
        Object.assign(params, { provider: p.provider, region: p.region, size: p.size, country: p.country });
      }
      if (!(params.region && params.size)) return reply.code(400).send({ error: "region en size zijn verplicht" });
      if (!svc.cfg.providers[String(params.provider)]) return reply.code(400).send({ error: `Aanbieder ${params.provider} is niet geconfigureerd` });
      params.kind = kind;
    }
    if ((type === "move" || type === "remove") && !params.nodeId) return reply.code(400).send({ error: "nodeId is verplicht" });
    return { id: createJob(svc, type, params) };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/cluster/policy", async (req, reply) => {
    if (!svc?.db) return reply.code(400).send({ error: "Geen cluster" });
    const allowed = ["minDataNodes", "witnesses", "autoHeal", "autoReplaceAfterMin", "placement", "snapshotEveryHours", "retentionDays", "drillEveryDays"];
    const cur = JSON.parse(svc.getSetting("cluster_policy") ?? "{}");
    for (const k of allowed) if (k in req.body) cur[k] = req.body[k];
    svc.db.prepare("INSERT INTO settings (key, value) VALUES ('cluster_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cur));
    return { ok: true, policy: svc.policy() };
  });
}
