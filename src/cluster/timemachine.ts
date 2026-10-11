import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { requireAuth, uid } from "../auth.js";
import { defaultCalendar } from "../users.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { listChain, restoreFromAny } from "./backup.js";
import type { ClusterService } from "./service.js";

/**
 * Tijdmachine: herstel de database van een eerder moment naast de huidige (alleen-lezen),
 * laat zien wat er toen anders was, en zet gekozen mails, afspraken en foto's terug.
 * De huidige gegevens blijven staan; terugzetten voegt alleen toe of herstelt.
 */
export const timeMachine: { svc?: ClusterService } = {};

interface Preview { id: string; file: string; at: number; created: number; restoredTo: number | null; userId: number }
const previews = new Map<string, Preview>();

function cleanup() {
  for (const [id, p] of previews) if (Date.now() - p.created > 30 * 60_000) { fs.rmSync(p.file, { force: true }); previews.delete(id); }
}

function withPast<T>(p: Preview, fn: (cur: Database.Database) => T): T {
  const cur = new Database(path.join(config.dataDir, "eigen-cloud.sqlite"), { readonly: true });
  try {
    cur.prepare("ATTACH DATABASE ? AS past").run(p.file);
    return fn(cur);
  } finally {
    cur.close();
  }
}

/** Alleen de gegevens van de gebruiker die het voorbeeld opvroeg (de back-up is bij herstel al naar het nieuwe schema gebracht). */
function diff(p: Preview) {
  const u = p.userId;
  return withPast(p, (cur) => ({
    messages: cur.prepare(`
      SELECT p.id, p.subject, p.from_name, p.from_addr, p.date, p.folder, 'verwijderd' AS reason FROM past.messages p
       WHERE p.user_id = ? AND p.message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM main.messages m WHERE m.message_id = p.message_id AND m.user_id = p.user_id)
      UNION ALL
      SELECT p.id, p.subject, p.from_name, p.from_addr, p.date, p.folder, 'in prullenbak' FROM past.messages p
        JOIN main.messages m ON m.message_id = p.message_id AND m.user_id = p.user_id WHERE p.user_id = ? AND m.folder = 'trash' AND p.folder != 'trash'
      ORDER BY 5 DESC LIMIT 500`).all(u, u),
    events: cur.prepare(`
      SELECT p.uid, p.title, p.start, p.all_day, 'verwijderd' AS reason FROM past.events p
       WHERE p.user_id = ? AND NOT EXISTS (SELECT 1 FROM main.events e WHERE e.uid = p.uid AND e.user_id = p.user_id)
      UNION ALL
      SELECT p.uid, p.title, p.start, p.all_day, 'gewijzigd' FROM past.events p JOIN main.events e ON e.uid = p.uid AND e.user_id = p.user_id
       WHERE p.user_id = ? AND (e.title IS NOT p.title OR e.start != p.start OR e.end != p.end OR e.location IS NOT p.location OR e.description IS NOT p.description OR e.rrule IS NOT p.rrule OR e.exdates != p.exdates)
      ORDER BY 3 DESC LIMIT 500`).all(u, u),
    photos: cur.prepare(`
      SELECT p.id, p.filename, p.taken_at, p.is_video, (p.thumb_path IS NOT NULL) AS has_thumb, 'verwijderd' AS reason FROM past.photos p
       WHERE p.user_id = ? AND p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM main.photos f WHERE f.sha256 = p.sha256 AND f.user_id = p.user_id)
      UNION ALL
      SELECT p.id, p.filename, p.taken_at, p.is_video, (p.thumb_path IS NOT NULL), 'in prullenbak' FROM past.photos p
        JOIN main.photos f ON f.sha256 = p.sha256 AND f.user_id = p.user_id WHERE p.user_id = ? AND f.deleted_at IS NOT NULL AND p.deleted_at IS NULL
      ORDER BY 3 DESC LIMIT 500`).all(u, u),
  }));
}

export function timeMachineRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/timemachine", async () => {
    const svc = timeMachine.svc;
    if (!svc) return { available: false, reason: "De tijdmachine werkt zodra je cloud back-ups naar opslag maakt (via de beheerconsole)." };
    for (const s of svc.stores) {
      try {
        const chain = await listChain(s);
        if (!chain.snapshots.length) continue;
        return { available: true, oldest: Math.min(...chain.snapshots.map((x) => x.ts)), newest: Date.now(), store: s.name };
      } catch { /* volgende */ }
    }
    return { available: false, reason: "Er is nog geen back-up gevonden. De eerste wordt binnen enkele minuten gemaakt." };
  });

  app.post<{ Body: { at: number } }>("/api/timemachine/preview", async (req, reply) => {
    const svc = timeMachine.svc;
    if (!svc) return reply.code(400).send({ error: "Niet beschikbaar" });
    cleanup();
    const at = Number(req.body?.at);
    if (!at || at > Date.now()) return reply.code(400).send({ error: "Kies een moment in het verleden" });
    const id = crypto.randomBytes(8).toString("hex");
    const dir = path.join(config.dataDir, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tijdmachine-${id}.sqlite`);
    const r = await restoreFromAny(svc.stores, svc.keys.db!, file, { until: at });
    if (!r) return reply.code(404).send({ error: "Van dat moment is geen back-up. Kies een later tijdstip." });
    const p: Preview = { id, file, at, created: Date.now(), restoredTo: r.lastTs, userId: uid(req) };
    previews.set(id, p);
    const items = diff(p);
    return { id, at, restoredTo: r.lastTs, items, counts: { messages: items.messages.length, events: items.events.length, photos: items.photos.length } };
  });

  app.get<{ Params: { id: string; photoId: string } }>("/api/timemachine/:id/photos/:photoId/thumb", async (req, reply) => {
    const p = previews.get(req.params.id);
    const svc = timeMachine.svc;
    if (!p || !svc || p.userId !== uid(req)) return reply.code(404).send();
    const row = withPast(p, (cur) => cur.prepare("SELECT thumb_path FROM past.photos WHERE id = ? AND user_id = ?").get(req.params.photoId, p.userId)) as { thumb_path: string | null } | undefined;
    if (!row?.thumb_path || !(await svc.fetchBlob(row.thumb_path))) return reply.code(404).send();
    reply.header("content-type", "image/webp");
    return reply.send(fs.createReadStream(path.join(config.dataDir, row.thumb_path)));
  });

  app.post<{ Body: { id: string; messages?: number[]; events?: string[]; photos?: number[] } }>("/api/timemachine/restore", async (req, reply) => {
    const p = previews.get(req.body?.id);
    const svc = timeMachine.svc;
    if (!p || !svc || p.userId !== uid(req)) return reply.code(404).send({ error: "Dit voorbeeld is verlopen. Kies het tijdstip opnieuw." });
    const me = p.userId;
    const { messages = [], events = [], photos = [] } = req.body;
    const past = new Database(p.file, { readonly: true });
    try {
      // Eerst alle bestanden ophalen (buiten de transactie).
      const blobRefs: string[] = [];
      const msgRows = messages.map((id) => past.prepare("SELECT * FROM messages WHERE id = ? AND user_id = ?").get(id, me) as Record<string, unknown> | undefined).filter(Boolean) as Record<string, unknown>[];
      const attRows = new Map<number, Record<string, unknown>[]>();
      for (const m of msgRows) {
        if (m.raw_path) blobRefs.push(String(m.raw_path));
        const atts = past.prepare("SELECT * FROM attachments WHERE message_id = ?").all(m.id) as Record<string, unknown>[];
        attRows.set(Number(m.id), atts);
        for (const a of atts) blobRefs.push(String(a.path));
      }
      const photoRows = photos.map((id) => past.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ?").get(id, me) as Record<string, unknown> | undefined).filter(Boolean) as Record<string, unknown>[];
      for (const ph of photoRows) { blobRefs.push(String(ph.path)); if (ph.thumb_path) blobRefs.push(String(ph.thumb_path)); }
      const missing: string[] = [];
      for (const rel of blobRefs) if (!rel.startsWith("/") && !(await svc.fetchBlob(rel))) missing.push(rel);

      const insert = (table: string, row: Record<string, unknown>, skip: string[]) => {
        const cols = Object.keys(row).filter((c) => !skip.includes(c));
        return Number(db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] as never)).lastInsertRowid);
      };
      const result = db.transaction(() => {
        let m = 0, e = 0, f = 0;
        for (const row of msgRows) {
          const cur = db.prepare("SELECT id FROM messages WHERE message_id = ? AND user_id = ?").get(row.message_id, me) as { id: number } | undefined;
          if (cur) { db.prepare("UPDATE messages SET folder = ? WHERE id = ?").run(row.folder, cur.id); m++; continue; }
          const newId = insert("messages", row, ["id"]);
          for (const a of attRows.get(Number(row.id)) ?? []) insert("attachments", { ...a, message_id: newId }, ["id"]);
          m++;
        }
        const firstCal = defaultCalendar(me);
        for (const evUid of events) {
          const row = past.prepare("SELECT * FROM events WHERE uid = ? AND user_id = ?").get(evUid, me) as Record<string, unknown> | undefined;
          if (!row) continue;
          if (!db.prepare("SELECT 1 FROM calendars WHERE id = ? AND user_id = ?").get(row.calendar_id, me)) row.calendar_id = firstCal;
          row.updated = Date.now();
          const cur = db.prepare("SELECT id FROM events WHERE uid = ? AND user_id = ?").get(evUid, me) as { id: number } | undefined;
          if (cur) {
            const cols = Object.keys(row).filter((c) => c !== "id" && c !== "uid");
            db.prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => row[c] as never), cur.id);
          } else insert("events", row, ["id"]);
          e++;
        }
        for (const row of photoRows) {
          const cur = db.prepare("SELECT id FROM photos WHERE sha256 = ? AND user_id = ?").get(row.sha256, me) as { id: number } | undefined;
          if (cur) db.prepare("UPDATE photos SET deleted_at = NULL WHERE id = ?").run(cur.id);
          else insert("photos", { ...row, deleted_at: null }, ["id"]);
          f++;
        }
        return { messages: m, events: e, photos: f };
      })();
      svc.event("timemachine", `Teruggezet uit ${new Date(p.at).toLocaleString("nl-NL")}: ${result.messages} mails, ${result.events} afspraken, ${result.photos} foto's`);
      return { ok: true, restored: result, missingFiles: missing.length };
    } finally {
      past.close();
    }
  });
}
