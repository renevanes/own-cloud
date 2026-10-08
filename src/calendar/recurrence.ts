import rrulePkg from "rrule";
const { RRule } = rrulePkg as unknown as typeof import("rrule");

/** Offset (ms) van tijdzone tz t.o.v. UTC op moment `utcMs`. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Echte UTC-tijd → "wandklok"-tijd in tz, gecodeerd als UTC-ms. */
export function utcToWall(utcMs: number, tz: string) {
  return utcMs + tzOffset(utcMs, tz);
}
/** Wandklok-tijd in tz (gecodeerd als UTC-ms) → echte UTC-tijd. Houdt rekening met zomer-/wintertijd. */
export function wallToUtc(wallMs: number, tz: string) {
  let guess = wallMs - tzOffset(wallMs, tz);
  guess = wallMs - tzOffset(guess, tz);
  return guess;
}

export interface EventRow {
  id: number; uid: string; calendar_id: number; title: string; description: string | null; location: string | null;
  start: number; end: number; all_day: number; tz: string | null; rrule: string | null; exdates: string; reminder_min: number | null;
}

export interface Occurrence extends Omit<EventRow, "exdates"> { occurrence_start: number; occurrence_end: number; recurring: boolean }

/**
 * Breidt terugkerende events uit binnen [from, to).
 * Herhaling wordt in lokale wandkloktijd berekend, zodat "elke maandag 09:00"
 * ook na de overgang naar wintertijd om 09:00 blijft.
 */
export function expand(ev: EventRow, from: number, to: number): Occurrence[] {
  const dur = ev.end - ev.start;
  const { exdates, ...base } = ev;
  if (!ev.rrule) {
    return ev.start < to && ev.end > from ? [{ ...base, occurrence_start: ev.start, occurrence_end: ev.end, recurring: false }] : [];
  }
  const tz = ev.all_day ? "UTC" : ev.tz || "Europe/Amsterdam";
  const ex = new Set((JSON.parse(exdates || "[]") as number[]));
  const opts = RRule.parseString(ev.rrule.replace(/^RRULE:/, ""));
  opts.dtstart = new Date(utcToWall(ev.start, tz));
  if (opts.until) opts.until = new Date(utcToWall(opts.until.getTime(), tz));
  const rule = new RRule(opts);
  const wallFrom = new Date(utcToWall(from - dur, tz) - 864e5);
  const wallTo = new Date(utcToWall(to, tz) + 864e5);
  return rule
    .between(wallFrom, wallTo, true)
    .map((d) => wallToUtc(d.getTime(), tz))
    .filter((s) => !ex.has(s) && s < to && s + dur > from)
    .map((s) => ({ ...base, occurrence_start: s, occurrence_end: s + dur, recurring: true }));
}
