import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireAuth, uid } from "../auth.js";
import { accessiblePhoto } from "../sharing.js";
import { getUser } from "../users.js";
import { ensureLocal } from "../blobs.js";
import { runtime } from "../cluster/runtime.js";
import { boundedWork } from "../work.js";
import { object, string, list } from "../apiContract.js";

const run = promisify(execFile);
const active = new Set<string>();
export async function drainMedia() {
  if (!runtime.isLeader() || runtime.featuresBlocked()) return;
  const jobs = db.prepare("SELECT * FROM media_jobs WHERE status IN ('queued','running') ORDER BY created LIMIT 10").all() as any[];
  for (const job of jobs) {
    if (active.has(job.id)) continue;
    active.add(job.id);
    try {
      await boundedWork("ocr", 1, async () => {
        const photo = db.prepare("SELECT path,width,height,mime,size FROM photos WHERE id=? AND user_id=? AND deleted_at IS NULL").get(job.photo_id, job.user_id) as any;
        if (!photo) { db.prepare("DELETE FROM media_jobs WHERE id=?").run(job.id); return; }
        if ((photo.width ?? 0) * (photo.height ?? 0) > 40_000_000 || photo.size > 100 * 1024 ** 2) throw new Error("Foto is te groot voor tekstherkenning");
        const file = await ensureLocal(photo.path); if (!file) throw new Error("Foto nog niet beschikbaar");
        db.prepare("UPDATE media_jobs SET status='running',error=NULL,updated=? WHERE id=?").run(Date.now(), job.id);
        if (runtime.enabled && !(await runtime.waitDurable())) return;
        const result = await run(process.env.EIGEN_TESSERACT ?? "tesseract", [file, "stdout", "-l", process.env.EIGEN_OCR_LANGUAGES ?? "eng+nld"], { timeout: 60_000, maxBuffer: 2 * 1024 ** 2, env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
        if (!runtime.isLeader() || getUser(job.user_id)?.status !== "active" || !db.prepare("SELECT 1 FROM photos WHERE id=?").get(job.photo_id)) return;
        db.transaction(() => {
          db.prepare("INSERT INTO photo_text VALUES (?,?,?) ON CONFLICT(photo_id) DO UPDATE SET text=excluded.text,updated=excluded.updated").run(job.photo_id, result.stdout.slice(0, 1_000_000), Date.now());
          db.prepare("UPDATE media_jobs SET status='done',error=NULL,updated=? WHERE id=?").run(Date.now(), job.id);
        })();
      });
    } catch (e) {
      if (runtime.isLeader()) db.prepare("UPDATE media_jobs SET status='failed',error=?,updated=? WHERE id=?").run((e as NodeJS.ErrnoException).code === "ENOENT" ? "Tekstherkenning is niet geïnstalleerd op deze server" : "Tekstherkenning lukte niet; probeer een kleinere afbeelding", Date.now(), job.id);
    } finally { active.delete(job.id); }
  }
}
export function photoToolRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/photos/map", async (req) => db.prepare("SELECT id,filename,lat,lon,taken_at FROM photos WHERE user_id=? AND deleted_at IS NULL AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 ORDER BY taken_at DESC LIMIT 5000").all(uid(req)));
  app.get("/api/photos/tags", async (req) => db.prepare("SELECT t.tag,COUNT(*) AS count FROM photo_tags t JOIN photos p ON p.id=t.photo_id WHERE p.user_id=? AND p.deleted_at IS NULL GROUP BY t.tag ORDER BY t.tag").all(uid(req)));
  app.get<{ Params: { id: string } }>("/api/photos/:id/annotations", async (req, reply) => {
    if (!accessiblePhoto(req.params.id, uid(req))) return reply.code(404).send({ error: "Niet gevonden" });
    return { tags: db.prepare("SELECT tag FROM photo_tags WHERE photo_id=? ORDER BY tag").all(req.params.id).map((r: any) => r.tag),
      canEdit: !!db.prepare("SELECT 1 FROM photos WHERE id=? AND user_id=?").get(req.params.id, uid(req)),
      text: (db.prepare("SELECT text FROM photo_text WHERE photo_id=?").get(req.params.id) as { text: string } | undefined)?.text ?? "",
      ocr: db.prepare("SELECT id,status,error FROM media_jobs WHERE photo_id=? ORDER BY created DESC LIMIT 1").get(req.params.id) ?? null };
  });
  app.put<{ Params: { id: string }; Body: { tags: string[] } }>("/api/photos/:id/tags", { schema: { body: object({ tags: list({ ...string(120), minLength: 1 }, 50) }, ["tags"]) } }, async (req, reply) => {
    if (!db.prepare("SELECT 1 FROM photos WHERE id=? AND user_id=?").get(req.params.id, uid(req))) return reply.code(404).send({ error: "Niet gevonden" });
    db.transaction(() => {
      db.prepare("DELETE FROM photo_tags WHERE photo_id=?").run(req.params.id);
      const ins = db.prepare("INSERT OR IGNORE INTO photo_tags VALUES (?,?)");
      for (const tag of req.body.tags.map((t) => t.trim().toLocaleLowerCase("nl-NL")).filter(Boolean)) ins.run(req.params.id, tag);
    })(); return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/photos/:id/ocr", async (req, reply) => {
    const photo = db.prepare("SELECT is_video FROM photos WHERE id=? AND user_id=? AND deleted_at IS NULL").get(req.params.id, uid(req)) as { is_video: number } | undefined;
    if (!photo || photo.is_video) return reply.code(400).send({ error: "Kies een eigen foto voor tekstherkenning" });
    const existing = db.prepare("SELECT id FROM media_jobs WHERE photo_id=? AND status IN ('queued','running')").get(req.params.id);
    if (existing) return existing;
    const id = crypto.randomUUID(); db.prepare("INSERT INTO media_jobs VALUES (?,?,?,'queued',NULL,?,?)").run(id, req.params.id, uid(req), Date.now(), Date.now()); return { id, status: "queued" };
  });
}
