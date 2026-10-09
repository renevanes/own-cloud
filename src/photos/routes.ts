import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { requireAuth } from "../auth.js";
import { addPhotoFromFile, isMediaFile } from "./store.js";
import { ensureLocal } from "../blobs.js";

interface PhotoRow { id: number; path: string; thumb_path: string | null; mime: string; filename: string; size: number }

/** Bestand serveren met Range-ondersteuning (nodig om video's te kunnen spoelen). */
function sendFileRange(req: FastifyRequest, reply: FastifyReply, file: string, mime: string) {
  const size = fs.statSync(file).size;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", mime).header("Cache-Control", "private, max-age=31536000, immutable");
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("Content-Length", size);
  return reply.send(fs.createReadStream(file));
}

const LIST_COLS = "id, filename, mime, width, height, taken_at, lat, lon, camera, description, is_video, is_favorite, (thumb_path IS NOT NULL) AS has_thumb";

export function photoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Tijdlijn, nieuwste eerst. Pagineren met ?before=<taken_at>&beforeId=<id>. */
  app.get<{ Querystring: { before?: string; beforeId?: string; limit?: string; album?: string; favorites?: string; videos?: string; q?: string; trash?: string } }>("/api/photos", async (req) => {
    const q = req.query;
    const limit = Math.min(Number(q.limit ?? 120), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    where.push(q.trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL");
    if (q.before) { where.push("(taken_at < ? OR (taken_at = ? AND id < ?))"); params.push(Number(q.before), Number(q.before), Number(q.beforeId ?? 1e15)); }
    if (q.album) { where.push("id IN (SELECT photo_id FROM album_photos WHERE album_id = ?)"); params.push(Number(q.album)); }
    if (q.favorites) where.push("is_favorite = 1");
    if (q.videos) where.push("is_video = 1");
    if (q.q) { where.push("(filename LIKE ? OR description LIKE ? OR camera LIKE ?)"); const like = `%${q.q}%`; params.push(like, like, like); }
    return db.prepare(`SELECT ${LIST_COLS} FROM photos ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY taken_at DESC, id DESC LIMIT ?`).all(...params, limit);
  });

  /** Aantallen per maand, voor een scrubber/jaaroverzicht. */
  app.get("/api/photos/summary", async () =>
    db.prepare("SELECT strftime('%Y-%m', taken_at / 1000, 'unixepoch') AS month, COUNT(*) AS count FROM photos WHERE deleted_at IS NULL GROUP BY month ORDER BY month DESC").all());

  app.get<{ Params: { id: string } }>("/api/photos/:id", async (req, reply) => {
    const p = db.prepare(`SELECT ${LIST_COLS}, size FROM photos WHERE id = ?`).get(req.params.id);
    if (!p) return reply.code(404).send({ error: "Niet gevonden" });
    const albums = db.prepare("SELECT a.id, a.name FROM albums a JOIN album_photos ap ON ap.album_id = a.id WHERE ap.photo_id = ?").all(req.params.id);
    return { ...p, albums };
  });

  app.get<{ Params: { id: string } }>("/api/photos/:id/thumb", async (req, reply) => {
    const p = db.prepare("SELECT thumb_path FROM photos WHERE id = ?").get(req.params.id) as PhotoRow | undefined;
    const file = p?.thumb_path ? await ensureLocal(p.thumb_path) : null;
    if (!file) return reply.code(404).send();
    return sendFileRange(req, reply, file, "image/webp");
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/photos/:id/original", async (req, reply) => {
    const p = db.prepare("SELECT path, mime, filename FROM photos WHERE id = ?").get(req.params.id) as PhotoRow | undefined;
    const file = p ? await ensureLocal(p.path) : null;
    if (!p || !file) return reply.code(404).send();
    if (req.query.download) reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(p.filename)}`);
    return sendFileRange(req, reply, file, p.mime);
  });

  /** Upload (multipart, meerdere bestanden). */
  app.post("/api/photos/upload", async (req) => {
    const results: { filename: string; id?: number; duplicate?: boolean; error?: string }[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
    try {
      for await (const part of req.files()) {
        if (!isMediaFile(part.filename)) { results.push({ filename: part.filename, error: "Geen foto of video" }); part.file.resume(); continue; }
        const tmp = path.join(tmpDir, `${Date.now()}-${path.basename(part.filename)}`);
        await pipeline(part.file, fs.createWriteStream(tmp));
        // Optioneel veld 'lastModified' (ms) vóór het bestand: gebruikt als datum als er geen EXIF is.
        const lmField = part.fields.lastModified as { value?: string } | { value?: string }[] | undefined;
        const lastModified = Number((Array.isArray(lmField) ? lmField.at(-1) : lmField)?.value);
        if (lastModified > 0) fs.utimesSync(tmp, lastModified / 1000, lastModified / 1000);
        try {
          const r = await addPhotoFromFile(tmp, { filename: part.filename }, { move: true });
          results.push({ filename: part.filename, ...r });
        } catch (e) {
          results.push({ filename: part.filename, error: (e as Error).message });
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return results;
  });

  app.post<{ Params: { id: string } }>("/api/photos/:id/restore", async (req) => {
    db.prepare("UPDATE photos SET deleted_at = NULL WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { is_favorite?: boolean; description?: string; taken_at?: number } }>("/api/photos/:id", async (req) => {
    const b = req.body ?? {};
    db.prepare("UPDATE photos SET is_favorite = COALESCE(?, is_favorite), description = COALESCE(?, description), taken_at = COALESCE(?, taken_at) WHERE id = ?")
      .run(b.is_favorite === undefined ? null : Number(b.is_favorite), b.description ?? null, b.taken_at ?? null, req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/photos/:id", async (req, reply) => {
    // Zacht verwijderen: na 30 dagen definitief (zie purgeDeletedPhotos).
    const r = db.prepare("UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), req.params.id);
    if (!r.changes) return reply.code(404).send();
    return { ok: true, trash: true };
  });

  // ── Albums ──
  app.get("/api/albums", async () =>
    db.prepare(`SELECT a.id, a.name, COUNT(ap.photo_id) AS count,
      (SELECT ap2.photo_id FROM album_photos ap2 JOIN photos p ON p.id = ap2.photo_id WHERE ap2.album_id = a.id ORDER BY p.taken_at DESC LIMIT 1) AS cover_id
      FROM albums a LEFT JOIN album_photos ap ON ap.album_id = a.id GROUP BY a.id ORDER BY a.name`).all());

  app.post<{ Body: { name: string } }>("/api/albums", async (req) => {
    db.prepare("INSERT OR IGNORE INTO albums (name) VALUES (?)").run(req.body.name);
    return db.prepare("SELECT id, name FROM albums WHERE name = ?").get(req.body.name);
  });

  app.post<{ Params: { id: string }; Body: { photo_ids: number[] } }>("/api/albums/:id/photos", async (req) => {
    const ins = db.prepare("INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)");
    db.transaction(() => { for (const pid of req.body.photo_ids) ins.run(req.params.id, pid); })();
    return { ok: true };
  });

  app.delete<{ Params: { id: string; photoId: string } }>("/api/albums/:id/photos/:photoId", async (req) => {
    db.prepare("DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?").run(req.params.id, req.params.photoId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/albums/:id", async (req) => {
    db.prepare("DELETE FROM albums WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
