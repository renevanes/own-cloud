import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { requireAuth, uid } from "../auth.js";
import { getUser, OWNER_ID, removeUnreferencedFiles } from "../users.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { blobWritten, ensureLocal, relData } from "../blobs.js";
import { runtime } from "../cluster/runtime.js";
import { boundedWork, fsyncFile, reserveSpace } from "../work.js";
import { newProgress, processTakeout, type ImportProgress } from "./takeout.js";
import { object, integer } from "../apiContract.js";

type Upload = { id: string; user_id: number; name: string; size: number; received: number; created: number };
type Job = { id: string; user_id: number; uploads: string; status: string; progress: string; error: string | null; created: number; updated: number; finished: number | null; cancelled: number };
const active = new Map<string, Promise<void>>();
const dir = (user: number) => {
  const d = path.join(config.dataDir, "import", ...(user === OWNER_ID ? [] : [`u${user}`])); fs.mkdirSync(d, { recursive: true }); return d;
};
const uploads = (u: number) => db.prepare("SELECT * FROM import_uploads WHERE user_id=? ORDER BY created").all(u) as Upload[];
const upload = (u: number, id: string) => db.prepare("SELECT * FROM import_uploads WHERE user_id=? AND id=?").get(u, id) as Upload | undefined;
const job = (id: string) => db.prepare("SELECT * FROM import_jobs WHERE id=?").get(id) as Job | undefined;

/** Old local uploads are adopted once; new chunks are immutable and travel with the replicated metadata. */
async function adoptLegacy(user: number) {
  if (!runtime.isLeader() || runtime.featuresBlocked()) return;
  for (const name of fs.readdirSync(dir(user))) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue;
    let m: Upload;
    try { m = JSON.parse(fs.readFileSync(path.join(dir(user), name), "utf8")); } catch { continue; }
    if (!/^[0-9a-f]{16}$/.test(m.id) || upload(user, m.id)) continue;
    const part = path.join(dir(user), m.id + ".part");
    if (!fs.existsSync(part) || fs.statSync(part).size !== m.received || !Number.isSafeInteger(m.size)) continue;
    let sha: string | null = null;
    if (m.received) { const hash = crypto.createHash("sha256"); for await (const b of fs.createReadStream(part)) hash.update(b); sha = hash.digest("hex"); }
    if (upload(user, m.id) || !runtime.isLeader() || runtime.featuresBlocked() || getUser(user)?.status !== "active") continue;
    db.prepare("INSERT INTO import_uploads VALUES (?,?,?,?,?,?)").run(m.id, user, m.name, m.size, m.received, m.created);
    if (m.received) {
      // Legacy files are copied by the cluster before another uploaded chunk can be acknowledged.
      const rel = relData(part);
      db.prepare("INSERT INTO import_chunks VALUES (?,0,?,?,?)").run(m.id, rel, m.received, sha); blobWritten(rel);
    }
  }
}
async function assemble(u: Upload) {
  const dest = path.join(dir(u.user_id), `${u.id}.assembled`);
  const chunks = db.prepare("SELECT * FROM import_chunks WHERE upload_id=? ORDER BY offset").all(u.id) as { offset: number; path: string; size: number; sha256: string }[];
  fs.writeFileSync(dest, "", { mode: 0o600 });
  try {
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== offset) throw new Error("Er ontbreekt een uploadblok; upload opnieuw vanaf de aangegeven positie");
    const file = await ensureLocal(chunk.path); if (!file) throw new Error("Wachten op een uploadblok uit de opslag");
    const h = crypto.createHash("sha256"); let bytes = 0;
    for await (const b of fs.createReadStream(file)) { h.update(b); bytes += (b as Buffer).length; }
    if (bytes !== chunk.size || h.digest("hex") !== chunk.sha256) throw new Error("Een uploadblok is beschadigd");
    await pipeline(fs.createReadStream(file), fs.createWriteStream(dest, { flags: "a" })); offset += bytes;
  }
  if (offset !== u.size) throw new Error("Upload is nog niet compleet"); fsyncFile(dest); return dest;
  } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}
export async function runImport(id: string) {
  if (active.has(id)) return active.get(id);
  const promise = boundedWork("imports", 1, async () => {
    if (!runtime.isLeader()) return;
    const row = job(id); if (!row || !["queued", "running", "paused"].includes(row.status)) return;
    if (row.cancelled || getUser(row.user_id)?.status !== "active") {
      db.prepare("UPDATE import_jobs SET status='cancelled',finished=?,updated=? WHERE id=?").run(Date.now(), Date.now(), id); return;
    }
    if (runtime.enabled && !(await runtime.waitDurable())) return;
    const sources = (JSON.parse(row.uploads) as string[]).map((x) => upload(row.user_id, x));
    if (sources.some((x) => !x || x.received !== x.size)) {
      db.prepare("UPDATE import_jobs SET status='paused',error='Een bronupload ontbreekt of is niet compleet',updated=? WHERE id=?").run(Date.now(), id); return;
    }
    const chosen = sources as Upload[];
    let release: () => unknown = () => {};
    const files: { path: string; name: string }[] = [];
    let progress: ImportProgress = newProgress();
    let lastCheckpoint = 0;
    const checkpoint = () => {
      if (!runtime.isLeader()) throw new Error("NOT_LEADER");
      if (!job(id) || job(id)?.cancelled || getUser(row.user_id)?.status !== "active") throw new Error("IMPORT_CANCELLED");
      if (Date.now() - lastCheckpoint < 250 && progress.phase !== "klaar") return;
      db.prepare("UPDATE import_jobs SET progress=?,updated=? WHERE id=?").run(JSON.stringify(progress), Date.now(), id); lastCheckpoint = Date.now();
    };
    try {
      release = reserveSpace(row.user_id, Math.ceil(chosen.reduce((n, x) => n + x.size, 0) * 1.2));
      db.prepare("UPDATE import_jobs SET status='running',error=NULL,updated=? WHERE id=?").run(Date.now(), id);
      for (const u of chosen) files.push({ path: await assemble(u), name: u.name });
      await processTakeout(files, dir(row.user_id), progress, checkpoint, row.user_id, { preserveAfter: row.created, cancelled: () => !job(id) || !!job(id)?.cancelled || getUser(row.user_id)?.status !== "active" || !runtime.isLeader() });
      if (runtime.enabled && !(await runtime.waitDurable())) throw new Error("Wachten op een veilige kopie; probeer de import opnieuw");
      const obsolete = (db.prepare("SELECT path FROM import_chunks WHERE upload_id IN (SELECT id FROM import_uploads WHERE user_id=?)").all(row.user_id) as { path: string }[]).map((r) => r.path);
      db.transaction(() => {
        db.prepare("UPDATE import_jobs SET status='done',progress=?,finished=?,updated=? WHERE id=?").run(JSON.stringify(progress), Date.now(), Date.now(), id);
        for (const u of chosen) db.prepare("DELETE FROM import_uploads WHERE id=? AND user_id=?").run(u.id, row.user_id);
      })();
      removeUnreferencedFiles(obsolete);
      for (const u of chosen) for (const suffix of [".json", ".part"]) fs.rmSync(path.join(dir(row.user_id), u.id + suffix), { force: true });
    } catch (e) {
      if (!runtime.isLeader()) return;
      const error = (e as Error).message;
      db.prepare("UPDATE import_jobs SET status=?,progress=?,error=?,updated=?,finished=? WHERE id=?")
        .run(error === "IMPORT_CANCELLED" ? "cancelled" : "paused", JSON.stringify(progress), error === "IMPORT_CANCELLED" ? "Import gestopt; wat al binnen is blijft bewaard" : error, Date.now(), error === "IMPORT_CANCELLED" ? Date.now() : null, id);
    } finally { release(); for (const f of files) fs.rmSync(f.path, { force: true }); }
  });
  active.set(id, promise);
  try { await promise; } finally { active.delete(id); }
}
export async function drainImports() {
  if (!runtime.isLeader()) return;
  const rows = db.prepare("SELECT id FROM import_jobs WHERE status IN ('queued','running') ORDER BY created LIMIT 10").all() as { id: string }[];
  for (const r of rows) await runImport(r.id);
}
export function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/import/uploads", async (req) => { await adoptLegacy(uid(req)); return uploads(uid(req)); });
  app.post<{ Body: { name: string; size: number } }>("/api/import/uploads", async (req, reply) => {
    const user = uid(req), { name, size } = req.body;
    if (!/\.(zip|mbox|ics)$/i.test(name)) return reply.code(400).send({ error: "Alleen zip, mbox of ics" });
    await adoptLegacy(user);
    const previous = uploads(user).find((x) => x.name === path.basename(name) && x.size === size); if (previous) return previous;
    if (uploads(user).length >= 100) return reply.code(400).send({ error: "Verwerk of verwijder eerst je bestaande uploads" });
    const other = (db.prepare("SELECT COALESCE(SUM(size-received),0) AS n FROM import_uploads").get() as { n: number }).n;
    const release = reserveSpace(user, Math.ceil(size * 2.2 + other)); release();
    const id = crypto.randomBytes(8).toString("hex");
    db.prepare("INSERT INTO import_uploads VALUES (?,?,?,?,0,?)").run(id, user, path.basename(name), size, Date.now()); return upload(user, id);
  });
  app.put<{ Params: { id: string }; Querystring: { offset: number } }>("/api/import/uploads/:id", { schema: { querystring: object({ offset: integer() }, ["offset"]) } }, async (req, reply) => {
    const u = upload(uid(req), req.params.id); if (!u) return reply.code(404).send({ error: "Onbekende upload" });
    const body = req.body as Buffer, offset = Number(req.query.offset);
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "Leeg blok" });
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const previous = db.prepare("SELECT sha256,size,path FROM import_chunks WHERE upload_id=? AND offset=?").get(u.id, offset) as { sha256: string; size: number; path: string } | undefined;
    if (previous?.sha256 === sha && previous.size === body.length) {
      const file = path.join(config.dataDir, previous.path);
      if (!fs.existsSync(file)) {
        const release = reserveSpace(uid(req), body.length, 30 * 60_000, true);
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o600 }); fsyncFile(file); blobWritten(previous.path); } finally { release(); }
      }
      return { received: u.received, done: u.received === u.size };
    }
    if (offset !== u.received) return reply.code(409).send({ error: "Verkeerde positie", received: u.received });
    if (offset + body.length > u.size) return reply.code(400).send({ error: "Meer data dan aangekondigd" });
    const release = reserveSpace(uid(req), body.length);
    try {
      const file = path.join(dir(uid(req)), "chunks", u.id, String(offset), sha + ".bin"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o600 }); fsyncFile(file);
      db.transaction(() => {
        db.prepare("INSERT INTO import_chunks VALUES (?,?,?,?,?)").run(u.id, offset, relData(file), body.length, sha);
        db.prepare("UPDATE import_uploads SET received=received+? WHERE id=?").run(body.length, u.id); blobWritten(relData(file));
      })();
      return { received: offset + body.length, done: offset + body.length === u.size };
    } finally { release(); }
  });
  app.delete<{ Params: { id: string } }>("/api/import/uploads/:id", async (req, reply) => {
    const row = db.prepare("SELECT uploads FROM import_jobs WHERE user_id=? AND status IN ('queued','running')").all(uid(req)) as { uploads: string }[];
    if (row.some((x) => (JSON.parse(x.uploads) as string[]).includes(req.params.id))) return reply.code(409).send({ error: "Stop eerst de import" });
    const obsolete = (db.prepare("SELECT c.path FROM import_chunks c JOIN import_uploads u ON u.id=c.upload_id WHERE u.id=? AND u.user_id=?").all(req.params.id, uid(req)) as { path: string }[]).map((r) => r.path);
    db.prepare("DELETE FROM import_uploads WHERE id=? AND user_id=?").run(req.params.id, uid(req));
    removeUnreferencedFiles(obsolete); return { ok: true };
  });
  app.post<{ Body: { ids?: string[] } }>("/api/import/start", async (req, reply) => {
    const user = uid(req); await adoptLegacy(user);
    if (db.prepare("SELECT 1 FROM import_jobs WHERE user_id=? AND status IN ('queued','running')").get(user)) return reply.code(409).send({ error: "Er loopt al een import" });
    const chosen = uploads(user).filter((x) => !req.body?.ids?.length || req.body.ids.includes(x.id));
    if (!chosen.length || chosen.some((x) => x.received !== x.size)) return reply.code(400).send({ error: "Upload eerst je bestanden helemaal" });
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO import_jobs (id,user_id,uploads,status,progress,created,updated) VALUES (?,?,?,'queued',?,?,?)")
      .run(id, user, JSON.stringify(chosen.map((x) => x.id)), JSON.stringify(newProgress()), Date.now(), Date.now());
    void runImport(id).catch((e) => console.error("import:", (e as Error).message)); return { ok: true, id };
  });
  app.get("/api/import/status", async (req) => {
    const row = db.prepare("SELECT * FROM import_jobs WHERE user_id=? ORDER BY created DESC LIMIT 1").get(uid(req)) as Job | undefined;
    return row ? { id: row.id, status: row.status, running: ["queued", "running"].includes(row.status), progress: JSON.parse(row.progress), error: row.error, startedAt: row.created, finishedAt: row.finished } : { running: false, progress: null, error: null };
  });
  app.post<{ Params: { id: string } }>("/api/import/jobs/:id/resume", async (req, reply) => {
    const row = job(req.params.id); if (!row || row.user_id !== uid(req)) return reply.code(404).send({ error: "Niet gevonden" });
    if (!['paused', 'cancelled'].includes(row.status)) return reply.code(409).send({ error: "Deze import kan niet worden hervat" });
    if ((JSON.parse(row.uploads) as string[]).some((id) => { const u = upload(uid(req), id); return !u || u.received !== u.size; })) return reply.code(400).send({ error: "Upload de ontbrekende bestanden en begin een nieuwe import" });
    db.prepare("UPDATE import_jobs SET status='queued',cancelled=0,error=NULL WHERE id=?").run(row.id); void runImport(row.id).catch(() => {}); return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/import/jobs/:id/cancel", async (req) => { db.prepare("UPDATE import_jobs SET cancelled=1,status=CASE WHEN status='running' THEN status ELSE 'cancelled' END WHERE id=? AND user_id=?").run(req.params.id, uid(req)); return { ok: true }; });
}
