import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireAuth, uid } from "../auth.js";
import { OWNER_ID, defaultCalendar, getUser } from "../users.js";
import { expand, validateRecurrence, type EventRow } from "./recurrence.js";
import { exportIcs, importIcs } from "./ics.js";
import { calendarAccessSql, resourceAccess, resourceOwner } from "../sharing.js";
import { checkRevision, revisionTag } from "../security/preconditions.js";

interface EventInput {
  calendar_id?: number; title?: string; description?: string | null; location?: string | null;
  start?: number; end?: number; all_day?: boolean; tz?: string | null; rrule?: string | null; reminder_min?: number | null;
}

/**
 * Geheim adres van de agenda-feed. De eigenaar houdt ICAL_TOKEN (bestaande abonnementen blijven werken);
 * een extra gebruiker krijgt een eigen token dat daarvan is afgeleid (niets opgeslagen, dus niets te repliceren).
 */
export function icalTokenFor(userId: number): string | null {
  if (!config.icalToken) return null;
  if (userId === OWNER_ID) return config.icalToken;
  return crypto.createHmac("sha256", config.sessionSecret).update(`ical-user:${userId}:${config.icalToken}`).digest("hex").slice(0, 32);
}

function icalOwner(token: string): number | null {
  const same = (a: string | null) => !!a && Buffer.byteLength(a) === Buffer.byteLength(token) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(token));
  if (same(icalTokenFor(OWNER_ID))) return OWNER_ID;
  for (const r of db.prepare("SELECT id FROM users WHERE status IN ('active','invited')").all() as { id: number }[]) if (same(icalTokenFor(r.id))) return r.id;
  return null;
}

const ownsCalendar = (userId: number, calId: unknown) => !!db.prepare("SELECT 1 FROM calendars WHERE id = ? AND user_id = ?").get(calId, userId);

export function calendarRoutes(app: FastifyInstance) {
  // Privé iCal-feed: abonneer hierop vanuit je telefoonagenda. Beveiligd met een geheim token in de URL.
  app.get<{ Params: { token: string } }>("/ical/:token/agenda.ics", async (req, reply) => {
    const owner = icalOwner(req.params.token);
    if (owner === null) return reply.code(404).send();
    const events = db.prepare(`SELECT e.* FROM events e WHERE ${calendarAccessSql("e")}`).all(owner, owner) as EventRow[];
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    return exportIcs(events, owner === OWNER_ID ? undefined : `Agenda van ${getUser(owner)?.name ?? ""}`.trim());
  });

  app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/api/calendars", async (req) => {
      const me = uid(req);
      defaultCalendarSafe(me);
      return db.prepare(`SELECT id,name,color,user_id AS ownerId, CASE WHEN user_id=? THEN 'owner' ELSE (SELECT role FROM resource_shares s WHERE s.kind='calendar' AND s.resource_id=c.id AND s.member_id=? AND s.status='accepted') END AS role FROM calendars c WHERE user_id=? OR EXISTS (SELECT 1 FROM resource_shares s WHERE s.kind='calendar' AND s.resource_id=c.id AND s.member_id=? AND s.status='accepted') ORDER BY id`).all(me, me, me, me);
    });

    api.post<{ Body: { name: string; color?: string } }>("/api/calendars", async (req, reply) => {
      if (!req.body?.name) return reply.code(400).send({ error: "Geef de agenda een naam" });
      const r = db.prepare("INSERT INTO calendars (name, color, user_id) VALUES (?, ?, ?)").run(req.body.name, req.body.color ?? "#10b981", uid(req));
      return { id: Number(r.lastInsertRowid) };
    });

    api.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>("/api/calendars/:id", async (req, reply) => {
      const r = db.prepare("UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ? AND user_id = ?").run(req.body?.name ?? null, req.body?.color ?? null, req.params.id, uid(req));
      if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
      return { ok: true };
    });

    api.delete<{ Params: { id: string } }>("/api/calendars/:id", async (req, reply) => {
      const me = uid(req);
      if (!ownsCalendar(me, req.params.id)) return reply.code(404).send({ error: "Niet gevonden" });
      const count = (db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE user_id = ?").get(me) as { n: number }).n;
      if (count <= 1) return reply.code(400).send({ error: "De laatste agenda kan niet worden verwijderd." });
      db.prepare("DELETE FROM calendars WHERE id = ? AND user_id = ?").run(req.params.id, me);
      db.prepare("DELETE FROM resource_shares WHERE kind='calendar' AND resource_id=?").run(req.params.id);
      return { ok: true };
    });

    /** Alle (uitgebreide) afspraken binnen een periode. */
    api.get<{ Querystring: { from: string; to: string; q?: string } }>("/api/events", async (req, reply) => {
      const from = Number(req.query.from), to = Number(req.query.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return reply.code(400).send({ error: "Geef from en to (unix ms)" });
      if (to - from > 400 * 864e5) return reply.code(400).send({ error: "Periode te lang (max. ruim een jaar)" });
      const rows = db.prepare(`SELECT e.* FROM events e WHERE ${calendarAccessSql("e")} AND ((rrule IS NULL AND start < ? AND end > ?) OR (rrule IS NOT NULL AND start < ?))`).all(uid(req), uid(req), to, from, to) as EventRow[];
      const q = req.query.q?.toLowerCase();
      return rows
        .filter((e) => !q || `${e.title} ${e.location ?? ""} ${e.description ?? ""}`.toLowerCase().includes(q))
        .flatMap((e) => expand(e, from, to))
        .sort((a, b) => a.occurrence_start - b.occurrence_start);
    });

    api.get<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
      const e = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) as EventRow | undefined;
      if (e && resourceAccess("calendar", e.calendar_id, uid(req))) reply.header("ETag", revisionTag("event", e.id, e.updated ?? 0));
      return e && resourceAccess("calendar", e.calendar_id, uid(req)) ? e : reply.code(404).send({ error: "Niet gevonden" });
    });

    api.post<{ Body: EventInput }>("/api/events", async (req, reply) => {
      const b = req.body;
      const me = uid(req);
      validateRecurrence(b.rrule, b.tz);
      if (!b.title || b.start === undefined || b.end === undefined || b.end < b.start) return reply.code(400).send({ error: "Titel, start en eind zijn verplicht" });
      const cal = b.calendar_id ?? defaultCalendar(me);
      if (!resourceAccess("calendar", cal, me, true)) return reply.code(400).send({ error: "Deze agenda kan je niet wijzigen" });
      const r = db.prepare(`INSERT INTO events (uid, calendar_id, title, description, location, start, end, all_day, tz, rrule, reminder_min, updated, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), cal, b.title, b.description ?? null, b.location ?? null, b.start, b.end,
        b.all_day ? 1 : 0, b.all_day ? null : (b.tz ?? "Europe/Amsterdam"), b.rrule || null, b.reminder_min ?? null, Date.now(), resourceOwner("calendar", cal));
      return { id: Number(r.lastInsertRowid) };
    });

    api.patch<{ Params: { id: string }; Body: EventInput }>("/api/events/:id", async (req, reply) => {
      const me = uid(req);
      const cur = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) as EventRow | undefined;
      if (!cur || !resourceAccess("calendar", cur.calendar_id, me, true)) return reply.code(404).send({ error: "Niet gevonden" });
      checkRevision(req, revisionTag("event", cur.id, cur.updated ?? 0));
      const b = req.body;
      if (b.calendar_id !== undefined && !resourceAccess("calendar", b.calendar_id, me, true)) return reply.code(400).send({ error: "Deze agenda kan je niet wijzigen" });
      const next = {
        ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
        all_day: b.all_day === undefined ? cur.all_day : b.all_day ? 1 : 0,
        rrule: b.rrule === undefined ? cur.rrule : b.rrule || null,
      };
      if (next.end < next.start) return reply.code(400).send({ error: "Eind moet na start liggen" });
      validateRecurrence(next.rrule, next.tz);
      const updated = Math.max(Date.now(), (cur.updated ?? 0) + 1);
      db.prepare(`UPDATE events SET calendar_id=@calendar_id, title=@title, description=@description, location=@location, start=@start, end=@end,
        all_day=@all_day, tz=@tz, rrule=@rrule, reminder_min=@reminder_min, user_id=@user_id, updated=@updated WHERE id=@id`).run({
        id: cur.id, calendar_id: next.calendar_id, title: next.title, description: next.description, location: next.location, start: next.start, end: next.end,
        all_day: next.all_day, tz: next.tz, rrule: next.rrule, reminder_min: next.reminder_min, user_id: resourceOwner("calendar", next.calendar_id), updated,
      });
      reply.header("ETag", revisionTag("event", cur.id, updated));
      return { ok: true, updated };
    });

    /** Verwijdert een hele reeks, of met ?occurrence=<ms> alleen één herhaling. */
    api.delete<{ Params: { id: string }; Querystring: { occurrence?: string } }>("/api/events/:id", async (req, reply) => {
      const cur = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) as EventRow | undefined;
      if (!cur || !resourceAccess("calendar", cur.calendar_id, uid(req), true)) return reply.code(404).send({ error: "Niet gevonden" });
      checkRevision(req, revisionTag("event", cur.id, cur.updated ?? 0));
      if (req.query.occurrence && cur.rrule) {
        const ex = JSON.parse(cur.exdates) as number[];
        ex.push(Number(req.query.occurrence));
        db.prepare("UPDATE events SET exdates = ?, updated = ? WHERE id = ?").run(JSON.stringify(ex), Date.now(), cur.id);
        return { ok: true, occurrenceRemoved: true };
      }
      db.prepare("DELETE FROM events WHERE id = ?").run(cur.id);
      return { ok: true };
    });

    api.post<{ Body: { ics: string; calendar_id?: number } }>("/api/calendar/import", async (req) => {
      const me = uid(req);
      const calendar = req.body.calendar_id ?? defaultCalendar(me);
      if (!resourceAccess("calendar", calendar, me, true)) throw Object.assign(new Error("Deze agenda kan je niet wijzigen"), { statusCode: 403 });
      return importIcs(req.body.ics, calendar, resourceOwner("calendar", calendar)!);
    });

    api.get("/api/calendar/export.ics", async (req, reply) => {
      reply.header("Content-Type", "text/calendar; charset=utf-8");
      reply.header("Content-Disposition", 'attachment; filename="agenda.ics"');
      return exportIcs(db.prepare(`SELECT e.* FROM events e WHERE ${calendarAccessSql("e")}`).all(uid(req), uid(req)) as EventRow[]);
    });
  });
}

/** Een nieuwe gebruiker heeft normaal al een agenda; mocht die ontbreken, dan maken we hem (niet op een volger). */
function defaultCalendarSafe(userId: number) {
  try { defaultCalendar(userId); } catch { /* volger of fence: volgende keer */ }
}
