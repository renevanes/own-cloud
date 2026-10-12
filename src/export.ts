import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import Database from "better-sqlite3";
import { ZipArchive } from "archiver";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { requireAuth, uid } from "./auth.js";
import { ensureLocal } from "./blobs.js";
import { exportIcs } from "./calendar/ics.js";
import type { EventRow } from "./calendar/recurrence.js";
import { getUser } from "./users.js";
import { boundedWork } from "./work.js";

const selections = {
  messages: "SELECT * FROM messages WHERE user_id=? ORDER BY id",
  attachments: "SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.user_id=?",
  calendars: "SELECT * FROM calendars WHERE user_id=?",
  events: "SELECT * FROM events WHERE user_id=?",
  photos: "SELECT * FROM photos WHERE user_id=?",
  albums: "SELECT * FROM albums WHERE user_id=?",
  albumPhotos: "SELECT ap.* FROM album_photos ap JOIN albums a ON a.id=ap.album_id WHERE a.user_id=?",
  contacts: "SELECT * FROM contacts WHERE user_id=? ORDER BY name",
  drafts: "SELECT id,mail,updated FROM mail_drafts WHERE user_id=?",
  outbox: "SELECT * FROM mail_outbox WHERE user_id=?",
  deliveries: "SELECT d.* FROM mail_delivery d JOIN mail_outbox o ON o.id=d.outbox_id WHERE o.user_id=?",
  rules: "SELECT * FROM mail_rules WHERE user_id=?",
  tags: "SELECT t.* FROM photo_tags t JOIN photos p ON p.id=t.photo_id WHERE p.user_id=?",
  recognizedText: "SELECT t.* FROM photo_text t JOIN photos p ON p.id=t.photo_id WHERE p.user_id=?",
};
export function exportPreview(user: number) {
  const count = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id=?`).pluck().get(user) as number;
  const bytes = db.prepare("SELECT COALESCE(SUM(size),0) FROM (SELECT size FROM messages WHERE user_id=? UNION ALL SELECT size FROM photos WHERE user_id=? UNION ALL SELECT a.size FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.user_id=?)").pluck().get(user, user, user) as number;
  return { messages: count("messages"), events: count("events"), photos: count("photos"), contacts: count("contacts"), drafts: count("mail_drafts"), outbox: count("mail_outbox"), bytes, format: "zip", includesDeletedPhotos: true, includesSecrets: false };
}
export function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/export/preview", async (req) => exportPreview(uid(req)));
  app.get("/api/export/download", async (req, reply) => boundedWork("exports", 2, async () => {
    const userId = uid(req), user = getUser(userId)!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-export-"));
    const archive = new ZipArchive({ zlib: { level: 3 } });
    let copy: Database.Database | undefined;
    const abort = () => { if (!reply.raw.writableFinished) archive.abort(); };
    try {
      // A consistent SQLite copy keeps exports independent of concurrent edits without a long read transaction.
      const file = path.join(tmp, "snapshot.sqlite");
      await db.backup(file); fs.chmodSync(file, 0o600); copy = new Database(file, { readonly: true });
      archive.on("error", (e) => { archive.abort(); reply.raw.destroy(e); });
      reply.raw.on("close", abort);
      reply.header("Content-Disposition", 'attachment; filename="eigen-cloud-export.zip"').type("application/zip");
      reply.send(archive);
      const manifest: { name: string; bytes: number; sha256: string }[] = [];
      const addText = (text: string, name: string) => {
        archive.append(text, { name }); manifest.push({ name, bytes: Buffer.byteLength(text), sha256: crypto.createHash("sha256").update(text).digest("hex") });
      };
      const snapshot = copy;
      function* metadata() {
        yield `{"format":1,"user":${JSON.stringify({ id: user.id, name: user.name, address: user.address })}`;
        for (const [name, sql] of Object.entries(selections)) {
          yield `,${JSON.stringify(name)}:[`; let first = true;
          for (const row of snapshot.prepare(sql).iterate(userId)) { if (!first) yield ","; yield JSON.stringify(row); first = false; }
          yield "]";
        }
        yield "}";
      }
      const metadataHash = crypto.createHash("sha256"); let metadataBytes = 0;
      const digest = new Transform({ transform(chunk: Buffer, _enc, cb) { metadataHash.update(chunk); metadataBytes += chunk.length; cb(null, chunk); } });
      const metadataDone = new Promise<void>((resolve, reject) => { digest.on("end", resolve); digest.on("error", reject); archive.on("error", reject); archive.on("close", () => { if (!reply.raw.writableFinished) reject(new Error("Export afgebroken")); }); });
      archive.append(Readable.from(metadata()).pipe(digest), { name: "metadata.json" });
      addText(exportIcs(copy.prepare(selections.events).all(userId) as EventRow[]), "agenda.ics");
      addText((copy.prepare("SELECT vcard FROM contacts WHERE user_id=? ORDER BY id").all(userId) as { vcard: string }[]).map((c) => c.vcard).join(""), "contacten.vcf");
      const appendFile = async (rel: string, name: string) => {
        if (archive.destroyed) throw new Error("Export afgebroken");
        const local = await ensureLocal(rel); if (!local) throw new Error("Een bestand ontbreekt; controleer eerst je back-up");
        const h = crypto.createHash("sha256"); for await (const b of fs.createReadStream(local)) h.update(b);
        manifest.push({ name, bytes: fs.statSync(local).size, sha256: h.digest("hex") }); archive.file(local, { name });
      };
      for (const m of copy.prepare("SELECT id,raw_path FROM messages WHERE user_id=? ORDER BY id").iterate(userId) as Iterable<any>) if (m.raw_path) await appendFile(m.raw_path, `mail/${m.id}.eml`);
      for (const a of copy.prepare(selections.attachments).iterate(userId) as Iterable<any>) await appendFile(a.path, `bijlagen/${a.id}-${path.basename(a.filename ?? "bijlage").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 180)}`);
      for (const p of copy.prepare("SELECT id,path,filename FROM photos WHERE user_id=? ORDER BY id").iterate(userId) as Iterable<any>) await appendFile(p.path, `fotos/${p.id}${path.extname(p.filename).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12)}`);
      for (const o of copy.prepare("SELECT id,raw_path FROM mail_outbox WHERE user_id=? ORDER BY id").iterate(userId) as Iterable<any>) await appendFile(o.raw_path, `postvak-uit/${o.id}.eml`);
      await metadataDone;
      manifest.unshift({ name: "metadata.json", bytes: metadataBytes, sha256: metadataHash.digest("hex") });
      addText(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), complete: true, files: manifest }, null, 2), "manifest.json");
      await archive.finalize();
    } catch (e) {
      archive.abort();
      if (reply.sent) { reply.raw.destroy(e as Error); return reply; }
      throw e;
    } finally { copy?.close(); reply.raw.off("close", abort); fs.rmSync(tmp, { recursive: true, force: true }); }
    return reply;
  }));
}
