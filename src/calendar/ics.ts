import crypto from "node:crypto";
import ICAL from "ical.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { utcToWall, type EventRow } from "./recurrence.js";

type ICALTime = InstanceType<typeof ICAL.Time>;

function timeToMs(t: ICALTime): number {
  if (t.isDate) return Date.UTC(t.year, t.month - 1, t.day);
  return t.toJSDate().getTime();
}

export interface ImportResult { added: number; updated: number; skipped: number }

/** Importeert een .ics-bestand (bijv. Google Agenda-export uit Takeout) in een agenda. */
export function importIcs(text: string, calendarId: number): ImportResult {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(vtz); } catch { /* al geregistreerd */ }
  }

  const result: ImportResult = { added: 0, updated: 0, skipped: 0 };
  const overrides: { masterUid: string; recurrenceMs: number }[] = [];

  const upsert = db.prepare(`
    INSERT INTO events (uid, calendar_id, title, description, location, start, end, all_day, tz, rrule, exdates, reminder_min, updated)
    VALUES (@uid, @calendar_id, @title, @description, @location, @start, @end, @all_day, @tz, @rrule, @exdates, @reminder_min, @updated)
    ON CONFLICT(uid) DO UPDATE SET title=excluded.title, description=excluded.description, location=excluded.location,
      start=excluded.start, end=excluded.end, all_day=excluded.all_day, tz=excluded.tz, rrule=excluded.rrule,
      exdates=excluded.exdates, reminder_min=excluded.reminder_min, updated=excluded.updated`);

  const run = db.transaction(() => {
    for (const v of root.getAllSubcomponents("vevent")) {
      try {
        const ev = new ICAL.Event(v);
        if (!ev.startDate) { result.skipped++; continue; }
        if (v.getFirstPropertyValue("status") === "CANCELLED" && !ev.recurrenceId) { result.skipped++; continue; }

        const allDay = ev.startDate.isDate;
        const start = timeToMs(ev.startDate);
        const end = ev.endDate ? timeToMs(ev.endDate) : start + (allDay ? 864e5 : 3600e3);
        const tzid = allDay ? null : (ev.startDate.zone?.tzid && ev.startDate.zone.tzid !== "floating" ? ev.startDate.zone.tzid : null);

        const recur = v.getFirstPropertyValue("rrule") as { toString(): string } | null;
        const exdates: number[] = [];
        for (const p of v.getAllProperties("exdate")) for (const val of p.getValues() as ICALTime[]) exdates.push(timeToMs(val));

        let reminder: number | null = null;
        const alarm = v.getFirstSubcomponent("valarm");
        const trig = alarm?.getFirstPropertyValue("trigger") as { toSeconds?: () => number } | null;
        if (trig?.toSeconds) reminder = Math.round(-trig.toSeconds() / 60);

        let uid = ev.uid || crypto.randomUUID();
        if (ev.recurrenceId) {
          const recMs = timeToMs(ev.recurrenceId);
          overrides.push({ masterUid: uid, recurrenceMs: recMs });
          uid = `${uid}#${recMs}`;
          if (v.getFirstPropertyValue("status") === "CANCELLED") { result.skipped++; continue; }
        }

        const existed = db.prepare("SELECT 1 FROM events WHERE uid = ?").get(uid);
        upsert.run({
          uid, calendar_id: calendarId, title: ev.summary || "(zonder titel)", description: ev.description || null, location: ev.location || null,
          start, end, all_day: allDay ? 1 : 0, tz: tzid, rrule: recur && !ev.recurrenceId ? recur.toString() : null,
          exdates: JSON.stringify(exdates), reminder_min: reminder, updated: Date.now(),
        });
        existed ? result.updated++ : result.added++;
      } catch (e) {
        result.skipped++;
      }
    }
    // Gewijzigde/geannuleerde losse herhalingen uitsluiten bij de hoofdreeks.
    for (const o of overrides) {
      const m = db.prepare("SELECT id, exdates FROM events WHERE uid = ?").get(o.masterUid) as { id: number; exdates: string } | undefined;
      if (!m) continue;
      const ex = new Set(JSON.parse(m.exdates) as number[]);
      ex.add(o.recurrenceMs);
      db.prepare("UPDATE events SET exdates = ? WHERE id = ?").run(JSON.stringify([...ex]), m.id);
    }
  });
  run();
  return result;
}

// ───────────── Export ─────────────

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}
function utcStamp(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function dateStamp(ms: number) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

export function exportIcs(events: EventRow[], name = "Eigen Agenda"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//eigen-cloud//NL", `X-WR-CALNAME:${esc(name)}`, "CALSCALE:GREGORIAN"];
  for (const e of events) {
    const [uid, rec] = e.uid.split("#");
    lines.push("BEGIN:VEVENT", `UID:${uid.includes("@") ? uid : uid + "@" + config.hostname}`, `DTSTAMP:${utcStamp(Date.now())}`);
    if (rec) lines.push(`RECURRENCE-ID:${e.all_day ? dateStamp(Number(rec)) : utcStamp(Number(rec))}`);
    if (e.all_day) lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`, `DTEND;VALUE=DATE:${dateStamp(e.end)}`);
    else if (e.tz) {
      // Lokale tijd + TZID, zodat herhalingen correct over zomer-/wintertijd lopen.
      const local = (ms: number) => utcStamp(utcToWall(ms, e.tz!)).replace("Z", "");
      lines.push(`DTSTART;TZID=${e.tz}:${local(e.start)}`, `DTEND;TZID=${e.tz}:${local(e.end)}`);
    } else lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    for (const x of JSON.parse(e.exdates || "[]") as number[]) lines.push(e.all_day ? `EXDATE;VALUE=DATE:${dateStamp(x)}` : `EXDATE:${utcStamp(x)}`);
    if (e.reminder_min != null) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.reminder_min}M`, "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
