import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { requireAuth, uid } from "../auth.js";
import { addPhotoFromFile, isMediaFile, type PhotoMeta } from "./store.js";
import { ensureLocal } from "../blobs.js";
import { accessiblePhoto, resourceAccess } from "../sharing.js";
import { boundedWork, reserveSpace } from "../work.js";

interface PhotoRow { id: number; path: string; thumb_path: string | null; mime: string; filename: string; size: number }

/** Bestand serveren met Range-ondersteuning (nodig om video's te kunnen spoelen). */
function sendFileRange(req: FastifyRequest, reply: FastifyReply, file: string, mime: string) {
  const size = fs.statSync(file).size;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", mime).header("Cache-Control", "private, max-age=31536000, immutable");
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (req.headers.range && !m) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if ((!m[1] && Number(m[2]) <= 0) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return reply.code(416).header("Content-Range", `bytes */${size}`).send();
    reply.code(206).header("Content-Range", `bytes ${start}-${end}/${size}`).header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("Content-Length", size);
  return reply.send(fs.createReadStream(file));
}

/**
 * Optionele velden vóór het bestand, zoals de Android-app ze meestuurt bij "Uit Google Foto's halen" (uit de
 * Takeout-JSON): takenAt (ms), lat + lon, description, favorite ("1"), album. Zelfde betekenis als bij de
 * Takeout-import in de cloud (src/import/photos.ts): takenAt en plaats gaan vóór EXIF.
 */
export function uploadMeta(filename: string, fields: Record<string, unknown>): PhotoMeta {
  const field = (k: string) => {
    const f = fields[k] as { value?: unknown } | { value?: unknown }[] | undefined;
    const v = (Array.isArray(f) ? f.at(-1) : f)?.value;
    return typeof v === "string" ? v : undefined;
  };
  const meta: PhotoMeta = { filename };
  const takenAt = Number(field("takenAt"));
  if (Number.isFinite(takenAt) && takenAt > 0 && takenAt < 4_102_444_800_000) meta.takenAt = Math.round(takenAt);
  const lat = Number(field("lat")), lon = Number(field("lon"));
  if (field("lat") && field("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) { meta.lat = lat; meta.lon = lon; }
  const description = field("description")?.trim();
  if (description) meta.description = description.slice(0, 5000);
  if (field("favorite") === "1" || field("favorite") === "true") meta.favorite = true;
  const album = field("album")?.trim();
  if (album) meta.albums = [album.slice(0, 200)];
  return meta;
}

const LIST_COLS ="id, filename, mime, width, height, taken_at, lat, lon, camera, description, is_video, is_favorite, (thumb_path IS NOT NULL) AS has_thumb";

export function photoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  /** Tijdlijn, nieuwste eerst. Pagineren met ?before=<taken_at>&beforeId=<id>. */
  app.get<{ Querystring: { before?: string; beforeId?: string; limit?: string; album?: string; favorites?: string; videos?: string; q?: string; trash?: string; tag?: string } }>("/api/photos", async (req, reply) => {
    const q = req.query;
    const limit = Math.min(Number(q.limit ?? 120), 500);
    if (q.album && !resourceAccess("album", Number(q.album), uid(req))) return reply.code(404).send({ error: "Niet gevonden" });
    const where: string[] = q.album ? ["id IN (SELECT photo_id FROM album_photos WHERE album_id=?)"] : ["user_id = ?"];
    const params: unknown[] = [q.album ? Number(q.album) : uid(req)];
    where.push(q.trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL");
    if (q.album && q.trash) { where.push("user_id = ?"); params.push(uid(req)); }
    if (q.before) { where.push("(taken_at < ? OR (taken_at = ? AND id < ?))"); params.push(Number(q.before), Number(q.before), Number(q.beforeId ?? 1e15)); }
    if (q.favorites) where.push("is_favorite = 1");
    if (q.videos) where.push("is_video = 1");
    if (q.q) { where.push("(filename LIKE ? OR description LIKE ? OR camera LIKE ? OR id IN (SELECT photo_id FROM photo_text WHERE text LIKE ?))"); const like = `%${q.q}%`; params.push(like, like, like, like); }
    if (q.tag) { where.push("id IN (SELECT photo_id FROM photo_tags WHERE tag=?)"); params.push(q.tag); }
    return db.prepare(`SELECT ${LIST_COLS} FROM photos WHERE ${where.join(" AND ")} ORDER BY taken_at DESC, id DESC LIMIT ?`).all(...params, limit);
  });

  /** Aantallen per maand, voor een scrubber/jaaroverzicht. */
  app.get("/api/photos/summary", async (req) =>
    db.prepare("SELECT strftime('%Y-%m', taken_at / 1000, 'unixepoch') AS month, COUNT(*) AS count FROM photos WHERE deleted_at IS NULL AND user_id = ? GROUP BY month ORDER BY month DESC").all(uid(req)));

  app.get<{ Params: { id: string } }>("/api/photos/:id", async (req, reply) => {
    const p = accessiblePhoto(req.params.id, uid(req)) ? db.prepare(`SELECT ${LIST_COLS}, size FROM photos WHERE id = ?`).get(req.params.id) : null;
    if (!p) return reply.code(404).send({ error: "Niet gevonden" });
    const albums = db.prepare("SELECT a.id, a.name FROM albums a JOIN album_photos ap ON ap.album_id = a.id WHERE ap.photo_id = ? AND a.user_id = ?").all(req.params.id, uid(req));
    return { ...p, albums };
  });

  app.get<{ Params: { id: string } }>("/api/photos/:id/thumb", async (req, reply) => {
    const p = accessiblePhoto(req.params.id, uid(req)) ? db.prepare("SELECT thumb_path FROM photos WHERE id = ?").get(req.params.id) as PhotoRow | undefined : undefined;
    const file = p?.thumb_path ? await ensureLocal(p.thumb_path) : null;
    if (!file) return reply.code(404).send();
    return sendFileRange(req, reply, file, "image/webp");
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/photos/:id/original", async (req, reply) => {
    const p = accessiblePhoto(req.params.id, uid(req)) ? db.prepare("SELECT path, mime, filename FROM photos WHERE id = ?").get(req.params.id) as PhotoRow | undefined : undefined;
    const file = p ? await ensureLocal(p.path) : null;
    if (!p || !file) return reply.code(404).send();
    if (req.query.download) reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(p.filename)}`);
    return sendFileRange(req, reply, file, p.mime);
  });

  /** Upload (multipart, meerdere bestanden). */
  app.post("/api/photos/upload", async (req) => {
    const userId = uid(req);
    const results: { filename: string; id?: number; duplicate?: boolean; error?: string }[] = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"));
    try {
      for await (const part of req.files()) {
        if (!isMediaFile(part.filename)) { results.push({ filename: part.filename, error: "Geen foto of video" }); part.file.resume(); continue; }
        const tmp = path.join(tmpDir, `${Date.now()}-${path.basename(part.filename)}`);
        const maximum = Number(process.env.EIGEN_MAX_UPLOAD_BYTES ?? 8 * 1024 ** 3);
        const release = reserveSpace(userId, 0);
        let received = 0, reserved = 0;
        const budget = new Transform({ transform(chunk, _encoding, callback) {
          try {
            received += chunk.length;
            if (received > maximum) throw Object.assign(new Error("Bestand is te groot"), { statusCode: 413 });
            if (received > reserved) {
              reserved = Math.min(maximum, received + 1024 ** 2);
              try { release.resize(reserved); } catch { reserved = received; release.resize(reserved); }
            }
            callback(null, chunk);
          } catch (e) { callback(e as Error); }
        } });
        try {
        await boundedWork("uploads", 2, () => pipeline(part.file, budget, fs.createWriteStream(tmp)));
        if (part.file.truncated) throw Object.assign(new Error("Bestand is te groot"), { statusCode: 413 });
        // Optioneel veld 'lastModified' (ms) vóór het bestand: gebruikt als datum als er geen EXIF is.
        const lmField = part.fields.lastModified as { value?: string } | { value?: string }[] | undefined;
        const lastModified = Number((Array.isArray(lmField) ? lmField.at(-1) : lmField)?.value);
        if (lastModified > 0) fs.utimesSync(tmp, lastModified / 1000, lastModified / 1000);
        try {
          const r = await addPhotoFromFile(tmp, uploadMeta(part.filename, part.fields), { move: true, userId, reserved: true });
          results.push({ filename: part.filename, ...r });
        } catch (e) {
          results.push({ filename: part.filename, error: (e as Error).message });
        }
        } finally { release(); }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return results;
  });

  app.post<{ Params: { id: string } }>("/api/photos/:id/restore", async (req, reply) => {
    const r = db.prepare("UPDATE photos SET deleted_at = NULL WHERE id = ? AND user_id = ?").run(req.params.id, uid(req));
    if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { is_favorite?: boolean; description?: string; taken_at?: number } }>("/api/photos/:id", async (req, reply) => {
    const b = req.body ?? {};
    const r = db.prepare("UPDATE photos SET is_favorite = COALESCE(?, is_favorite), description = COALESCE(?, description), taken_at = COALESCE(?, taken_at) WHERE id = ? AND user_id = ?")
      .run(b.is_favorite === undefined ? null : Number(b.is_favorite), b.description ?? null, b.taken_at ?? null, req.params.id, uid(req));
    if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/photos/:id", async (req, reply) => {
    // Zacht verwijderen: na 30 dagen definitief (zie purgeDeletedPhotos).
    const r = db.prepare("UPDATE photos SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL").run(Date.now(), req.params.id, uid(req));
    if (!r.changes) return reply.code(404).send();
    return { ok: true, trash: true };
  });

  // ── Albums ──
  app.get("/api/albums", async (req) =>
    db.prepare(`SELECT a.id, a.name, a.user_id AS ownerId, CASE WHEN a.user_id=? THEN 'owner' ELSE (SELECT role FROM resource_shares s WHERE s.kind='album' AND s.resource_id=a.id AND s.member_id=? AND s.status='accepted') END AS role, COUNT(p.id) AS count,
      (SELECT ap2.photo_id FROM album_photos ap2 JOIN photos p2 ON p2.id=ap2.photo_id WHERE ap2.album_id=a.id AND p2.deleted_at IS NULL ORDER BY p2.taken_at DESC LIMIT 1) AS cover_id
      FROM albums a LEFT JOIN album_photos ap ON ap.album_id=a.id LEFT JOIN photos p ON p.id=ap.photo_id AND p.deleted_at IS NULL
      WHERE a.user_id=? OR EXISTS (SELECT 1 FROM resource_shares s WHERE s.kind='album' AND s.resource_id=a.id AND s.member_id=? AND s.status='accepted') GROUP BY a.id ORDER BY a.name`).all(uid(req), uid(req), uid(req), uid(req)));

  app.post<{ Body: { name: string } }>("/api/albums", async (req, reply) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return reply.code(400).send({ error: "Geef het album een naam" });
    db.prepare("INSERT OR IGNORE INTO albums (name, user_id) VALUES (?, ?)").run(name, uid(req));
    return db.prepare("SELECT id, name FROM albums WHERE name = ? AND user_id = ?").get(name, uid(req));
  });

  const ownAlbum = (userId: number, id: unknown) => !!db.prepare("SELECT 1 FROM albums WHERE id = ? AND user_id = ?").get(id, userId);

  app.post<{ Params: { id: string }; Body: { photo_ids: number[] } }>("/api/albums/:id/photos", async (req, reply) => {
    const me = uid(req);
    if (!resourceAccess("album", req.params.id, me, true)) return reply.code(404).send({ error: "Niet gevonden" });
    const ins = db.prepare("INSERT OR IGNORE INTO album_photos (album_id, photo_id) SELECT ?, id FROM photos WHERE id = ? AND user_id = ?");
    db.transaction(() => { for (const pid of req.body?.photo_ids ?? []) ins.run(req.params.id, pid, me); })();
    return { ok: true };
  });

  app.delete<{ Params: { id: string; photoId: string } }>("/api/albums/:id/photos/:photoId", async (req, reply) => {
    if (!resourceAccess("album", req.params.id, uid(req), true)) return reply.code(404).send({ error: "Niet gevonden" });
    db.prepare("DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?").run(req.params.id, req.params.photoId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/albums/:id", async (req, reply) => {
    const r = db.prepare("DELETE FROM albums WHERE id = ? AND user_id = ?").run(req.params.id, uid(req));
    if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
    db.prepare("DELETE FROM resource_shares WHERE kind='album' AND resource_id=?").run(req.params.id);
    return { ok: true };
  });
}
