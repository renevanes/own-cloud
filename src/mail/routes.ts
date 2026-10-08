import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireAuth } from "../auth.js";
import { sendMail } from "./send.js";

const FOLDERS = ["inbox", "sent", "archive", "trash", "spam", "drafts"] as const;

const LIST_COLS = "id, thread_key, folder, labels, from_addr, from_name, to_addrs, subject, snippet, date, is_read, is_starred, (SELECT COUNT(*) FROM attachments a WHERE a.message_id = messages.id) AS attachment_count";

function ftsQuery(q: string) {
  // Elk woord als prefix-term; quotes verwijderen om FTS-syntaxfouten te voorkomen.
  return q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
}

export function mailRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/mail/folders", async () => {
    const rows = db.prepare("SELECT folder, COUNT(*) AS total, SUM(is_read = 0) AS unread FROM messages GROUP BY folder").all() as { folder: string; total: number; unread: number }[];
    const labels = db.prepare("SELECT DISTINCT j.value AS label FROM messages, json_each(messages.labels) j ORDER BY 1").all() as { label: string }[];
    return {
      folders: FOLDERS.map((f) => ({ folder: f, total: 0, unread: 0, ...rows.find((r) => r.folder === f) })),
      labels: labels.map((l) => l.label),
    };
  });

  app.get<{ Querystring: { folder?: string; q?: string; label?: string; starred?: string; before?: string; limit?: string } }>("/api/mail/messages", async (req) => {
    const { folder, q, label, starred, before } = req.query;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      where.push("id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
      params.push(ftsQuery(q));
    } else if (folder) {
      where.push("folder = ?");
      params.push(folder);
    }
    if (label) { where.push("EXISTS (SELECT 1 FROM json_each(messages.labels) WHERE value = ?)"); params.push(label); }
    if (starred) where.push("is_starred = 1");
    if (before) { where.push("date < ?"); params.push(Number(before)); }
    const sql = `SELECT ${LIST_COLS} FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date DESC LIMIT ?`;
    return db.prepare(sql).all(...params, limit);
  });

  app.get<{ Params: { id: string } }>("/api/mail/messages/:id", async (req, reply) => {
    const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
    if (!msg) return reply.code(404).send({ error: "Niet gevonden" });
    db.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").run(req.params.id);
    const attachments = db.prepare("SELECT id, filename, mime, size FROM attachments WHERE message_id = ?").all(req.params.id);
    const thread = db.prepare(`SELECT ${LIST_COLS} FROM messages WHERE thread_key = ? ORDER BY date`).all(msg.thread_key);
    delete msg.raw_path;
    return { ...msg, is_read: 1, attachments, thread };
  });

  app.patch<{ Params: { id: string }; Body: { folder?: string; is_read?: boolean; is_starred?: boolean } }>("/api/mail/messages/:id", async (req, reply) => {
    const { folder, is_read, is_starred } = req.body ?? {};
    if (folder && !FOLDERS.includes(folder as (typeof FOLDERS)[number])) return reply.code(400).send({ error: "Onbekende map" });
    const r = db.prepare(`UPDATE messages SET folder = COALESCE(?, folder), is_read = COALESCE(?, is_read), is_starred = COALESCE(?, is_starred) WHERE id = ?`)
      .run(folder ?? null, is_read === undefined ? null : Number(is_read), is_starred === undefined ? null : Number(is_starred), req.params.id);
    if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
    return { ok: true };
  });

  /** Verwijderen: eerst naar prullenbak, uit de prullenbak definitief. */
  app.delete<{ Params: { id: string } }>("/api/mail/messages/:id", async (req, reply) => {
    const msg = db.prepare("SELECT folder FROM messages WHERE id = ?").get(req.params.id) as { folder: string } | undefined;
    if (!msg) return reply.code(404).send({ error: "Niet gevonden" });
    if (msg.folder !== "trash") {
      db.prepare("UPDATE messages SET folder = 'trash' WHERE id = ?").run(req.params.id);
      return { ok: true, movedToTrash: true };
    }
    db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
    return { ok: true, deleted: true };
  });

  app.get<{ Params: { id: string } }>("/api/mail/attachments/:id", async (req, reply) => {
    const a = db.prepare("SELECT filename, mime, path FROM attachments WHERE id = ?").get(req.params.id) as { filename: string; mime: string; path: string } | undefined;
    if (!a) return reply.code(404).send({ error: "Niet gevonden" });
    reply.header("Content-Type", a.mime || "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    return reply.send(fs.createReadStream(a.path));
  });

  app.get<{ Params: { id: string } }>("/api/mail/messages/:id/raw", async (req, reply) => {
    const m = db.prepare("SELECT raw_path FROM messages WHERE id = ?").get(req.params.id) as { raw_path: string } | undefined;
    if (!m?.raw_path) return reply.code(404).send({ error: "Niet gevonden" });
    reply.header("Content-Type", "message/rfc822");
    reply.header("Content-Disposition", `attachment; filename="bericht-${req.params.id}.eml"`);
    return reply.send(fs.createReadStream(m.raw_path));
  });

  app.post<{
    Body: { to: string[] | string; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; replyToId?: number;
            attachments?: { filename: string; base64: string; contentType?: string }[] };
  }>("/api/mail/send", async (req, reply) => {
    const b = req.body;
    const to = (Array.isArray(b.to) ? b.to : String(b.to ?? "").split(/[,;]/)).map((s) => s.trim()).filter(Boolean);
    if (!to.length) return reply.code(400).send({ error: "Geen ontvanger opgegeven" });

    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    if (b.replyToId) {
      const orig = db.prepare("SELECT message_id, raw_path FROM messages WHERE id = ?").get(b.replyToId) as { message_id: string } | undefined;
      if (orig?.message_id) { inReplyTo = orig.message_id; references = [orig.message_id]; }
    }
    try {
      const id = await sendMail({
        to, cc: b.cc, bcc: b.bcc, subject: b.subject ?? "", text: b.text ?? "", html: b.html, inReplyTo, references,
        attachments: b.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.base64, "base64"), contentType: a.contentType })),
      });
      return { ok: true, id };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
