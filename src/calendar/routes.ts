import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireAuth } from "../auth.js";
import { expand, type EventRow } from "./recurrence.js";
import { exportIcs, importIcs } from "./ics.js";

interface EventInput {
  calendar_id?: number; title?: string; description?: string | null; location?: string | null;
  start?: number; end?: number; all_day?: boolean; tz?: string | null; rrule?: string | null; reminder_min?: number | null;
}

export function calendarRoutes(app: FastifyInstance) {
  // Privé iCal-feed: abonneer hierop vanuit je telefoonagenda. Beveiligd met ICAL_TOKEN in de URL.
  app.get<{ Params: { token: string } }>("/ical/:token/agenda.ics", async (req, reply) => {
    const ok = config.icalToken && req.params.token.length === config.icalToken.length &&
      crypto.timingSafeEqual(Buffer.from(req.params.token), Buffer.from(config.icalToken));
    if (!ok) return reply.code(404).send();
    const events = db.prepare("SELECT * FROM events").all() as EventRow[];
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    return exportIcs(events);
  });

  app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/api/calendars", async () => db.prepare("SELECT * FROM calendars ORDER BY id").all());

    api.post<{ Body: { name: string; color?: string } }>("/api/calendars", async (req) => {
      const r = db.prepare("INSERT INTO calendars (name, color) VALUES (?, ?)").run(req.body.name, req.body.color ?? "#10b981");
      return { id: Number(r.lastInsertRowid) };
    });

    api.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>("/api/calendars/:id", async (req) => {
      db.prepare("UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?").run(req.body.name ?? null, req.body.color ?? null, req.params.id);
      return { ok: true };
    });

    api.delete<{ Params: { id: string } }>("/api/calendars/:id", async (req, reply) => {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number }).n;
      if (count <= 1) return reply.code(400).send({ error: "De laatste agenda kan niet worden verwijderd." });
      db.prepare("DELETE FROM calendars WHERE id = ?").run(req.params.id);
      return { ok: true };
    });

    /** Alle (uitgebreide) afspraken binnen een periode. */
    api.get<{ Querystring: { from: string; to: string; q?: string } }>("/api/events", async (req, reply) => {
      const from = Number(req.query.from), to = Number(req.query.to);
      if (!from || !to || to <= from) return reply.code(400).send({ error: "Geef from en to (unix ms)" });
      if (to - from > 400 * 864e5) return reply.code(400).send({ error: "Periode te lang (max. ruim een jaar)" });
      const rows = db.prepare("SELECT * FROM events WHERE (rrule IS NULL AND start < ? AND end > ?) OR (rrule IS NOT NULL AND start < ?)").all(to, from, to) as EventRow[];
      const q = req.query.q?.toLowerCase();
      return rows
        .filter((e) => !q || `${e.title} ${e.location ?? ""} ${e.description ?? ""}`.toLowerCase().includes(q))
        .flatMap((e) => expand(e, from, to))
        .sort((a, b) => a.occurrence_start - b.occurrence_start);
    });

    api.get<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
      const e = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
      return e ?? reply.code(404).send({ error: "Niet gevonden" });
    });

    api.post<{ Body: EventInput }>("/api/events", async (req, reply) => {
      const b = req.body;
      if (!b.title || !b.start || !b.end || b.end < b.start) return reply.code(400).send({ error: "Titel, start en eind zijn verplicht" });
      const r = db.prepare(`INSERT INTO events (uid, calendar_id, title, description, location, start, end, all_day, tz, rrule, reminder_min, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), b.calendar_id ?? 1, b.title, b.description ?? null, b.location ?? null, b.start, b.end,
        b.all_day ? 1 : 0, b.all_day ? null : (b.tz ?? "Europe/Amsterdam"), b.rrule || null, b.reminder_min ?? null, Date.now());
      return { id: Number(r.lastInsertRowid) };
    });

    api.patch<{ Params: { id: string }; Body: EventInput }>("/api/events/:id", async (req, reply) => {
      const cur = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) as EventRow | undefined;
      if (!cur) return reply.code(404).send({ error: "Niet gevonden" });
      const b = req.body;
      const next = {
        ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
        all_day: b.all_day === undefined ? cur.all_day : b.all_day ? 1 : 0,
        rrule: b.rrule === undefined ? cur.rrule : b.rrule || null,
      };
      db.prepare(`UPDATE events SET calendar_id=@calendar_id, title=@title, description=@description, location=@location, start=@start, end=@end,
        all_day=@all_day, tz=@tz, rrule=@rrule, reminder_min=@reminder_min, updated=${Date.now()} WHERE id=@id`).run(next);
      return { ok: true };
    });

    /** Verwijdert een hele reeks, of met ?occurrence=<ms> alleen één herhaling. */
    api.delete<{ Params: { id: string }; Querystring: { occurrence?: string } }>("/api/events/:id", async (req, reply) => {
      const cur = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id) as EventRow | undefined;
      if (!cur) return reply.code(404).send({ error: "Niet gevonden" });
      if (req.query.occurrence && cur.rrule) {
        const ex = JSON.parse(cur.exdates) as number[];
        ex.push(Number(req.query.occurrence));
        db.prepare("UPDATE events SET exdates = ?, updated = ? WHERE id = ?").run(JSON.stringify(ex), Date.now(), cur.id);
        return { ok: true, occurrenceRemoved: true };
      }
      db.prepare("DELETE FROM events WHERE id = ?").run(cur.id);
      return { ok: true };
    });

    api.post<{ Body: { ics: string; calendar_id?: number } }>("/api/calendar/import", async (req) => importIcs(req.body.ics, req.body.calendar_id ?? 1));

    api.get("/api/calendar/export.ics", async (_req, reply) => {
      reply.header("Content-Type", "text/calendar; charset=utf-8");
      reply.header("Content-Disposition", 'attachment; filename="agenda.ics"');
      return exportIcs(db.prepare("SELECT * FROM events").all() as EventRow[]);
    });
  });
}
