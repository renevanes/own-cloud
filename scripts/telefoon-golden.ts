/**
 * "Agenda en foto's op deze telefoon" (Android-app) tegen de cloud-code:
 *
 *   npx tsx scripts/telefoon-golden.ts maak <uitvoer.json>   vaste afspraken + exportIcs-uitvoer (src/calendar/ics.ts),
 *                                                             die AgendaIcsTest (Java) byte voor byte moet nadoen en
 *                                                             teruglezen; en findSidecar (src/import/photos.ts) voor een
 *                                                             reeks Takeout-namen, die TakeoutTest moet nadoen
 *   npx tsx scripts/telefoon-golden.ts controleer <build>     leest java-out/agenda-telefoon.ics (een reservekopie
 *                                                             zoals de telefoon hem maakt) met importIcs in een lege
 *                                                             database en vergelijkt met java-out/agenda-telefoon.json
 *
 * De controle draait in een andere tijdzone dan UTC (America/New_York), zodat een TZID zonder VTIMEZONE (dat
 * ical.js als zwevende tijd leest) meteen opvalt.
 */
process.env.TZ = "America/New_York";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenda-golden-"));
process.env.DATA_DIR = path.join(tmp, "data");
const { exportIcs, importIcs } = await import("../src/calendar/ics.js");
const { findSidecar } = await import("../src/import/photos.js");
const { db } = await import("../src/db.js");

const [mode, target] = process.argv.slice(2);
let failures = 0;
const done = () => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(failures ? 1 : 0); };

if (mode === "maak") {
  const amsterdam = (y: number, m: number, d: number, h: number, min = 0) => {
    // Wandkloktijd in Amsterdam → UTC (alleen voor de vaste testdata; maart–oktober is +2, anders +1)
    const summer = m > 2 && m < 9 || (m === 2 && d >= 29) || (m === 9 && d < 25);
    return Date.UTC(y, m, d, h - (summer ? 2 : 1), min);
  };
  const events = [
    { id: 1, uid: "tandarts-1@eigen-cloud", calendar_id: 1, title: "Tandarts", description: "Controle; neem je pasje mee\nRoute: links, dan rechts \\ boven", location: "Kerkstraat 1, Rotterdam",
      start: Date.UTC(2026, 2, 10, 9, 0), end: Date.UTC(2026, 2, 10, 9, 30), all_day: 0, tz: null, rrule: null, exdates: "[]", reminder_min: 15, updated: Date.UTC(2026, 1, 1, 12, 0) },
    { id: 2, uid: "overleg-2@eigen-cloud", calendar_id: 1, title: "Teamoverleg", description: null, location: null,
      start: amsterdam(2026, 2, 2, 9), end: amsterdam(2026, 2, 2, 10), all_day: 0, tz: "Europe/Amsterdam", rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z",
      exdates: JSON.stringify([amsterdam(2026, 2, 16, 9), amsterdam(2026, 3, 6, 9)]), reminder_min: null },
    { id: 3, uid: `overleg-2@eigen-cloud#${amsterdam(2026, 2, 23, 9)}`, calendar_id: 1, title: "Teamoverleg (verplaatst naar de grote zaal)", description: null, location: "Grote zaal",
      start: amsterdam(2026, 2, 23, 14), end: amsterdam(2026, 2, 23, 15), all_day: 0, tz: "Europe/Amsterdam", rrule: null, exdates: "[]", reminder_min: 10 },
    { id: 4, uid: "vakantie-3@eigen-cloud", calendar_id: 1,
      title: "Zomervakantie in Frankrijk — met de caravan, de fietsen en de hond naar Bretagne en daarna nog een week naar de Côte d'Émeraude",
      description: null, location: null, start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 6, 4), all_day: 1, tz: null, rrule: null, exdates: "[]", reminder_min: null },
    { id: 5, uid: "jarig-4@eigen-cloud", calendar_id: 1, title: "Oma jarig", description: null, location: null,
      start: Date.UTC(2020, 4, 12), end: Date.UTC(2020, 4, 13), all_day: 1, tz: null, rrule: "FREQ=YEARLY", exdates: JSON.stringify([Date.UTC(2025, 4, 12)]), reminder_min: 1440 },
  ];
  const ics = exportIcs(events, "Werk & privé, thuis");
  // Takeout: welke JSON hoort bij welke foto (zelfde regels op de telefoon als in de cloud).
  const jsons = ["a.jpg.json", "b.jpg.supplemental-metadata.json", "c.jpg(2).json", "d.jpg.supplemental-metadata.json", "IMG_20190101_120000.jpg.supplemental-meta.json",
    "PXL_20230615_101010123.NIGHT.jpg.supplemen.json", "Screenshot_20200202-101112_WhatsAp.json", "Screenshot_2020-02-02-10-1.json", "foto.json", "IMG_1.jpg.json",
    "IMG_1-edited.jpg.json", "kort.j.json", "e.mp4.supplemental-metadata(1).json", "Vakantie (1).jpg.json", "x.HEIC.json", "metadata.json"];
  const media = ["/x/a.jpg", "b.jpg", "c(2).jpg", "d-bewerkt.jpg", "d-edited.jpg", "IMG_20190101_120000.jpg", "PXL_20230615_101010123.NIGHT.jpg", "Screenshot_20200202-101112_WhatsApp.jpg",
    "Screenshot_2020-02-02-10-11-12.png", "foto.jpg", "IMG_1.jpg", "IMG_1-edited.jpg", "kort.jpg", "e(1).mp4", "e.mp4", "Vakantie (1).jpg", "x.HEIC", "geen.jpg", "a(1).jpg"];
  const sidecars = media.map((m) => ({ media: m, json: findSidecar(m, jsons) ?? null }));
  fs.writeFileSync(target, JSON.stringify({ events, ics, sidecars: { jsons, cases: sidecars } }, null, 1));
  done();
}

if (mode === "controleer") {
  const out = path.join(path.resolve(target), "java-out");
  const text = fs.readFileSync(path.join(out, "agenda-telefoon.ics"), "utf8");
  const expected = JSON.parse(fs.readFileSync(path.join(out, "agenda-telefoon.json"), "utf8")) as Record<string, unknown>[];
  const cal = Number(db.prepare("INSERT INTO calendars (name, color, user_id) VALUES ('telefoon', '#3f6f4a', 1)").run().lastInsertRowid);
  const r = importIcs(text, cal, 1);
  const check = (ok: boolean, what: string) => { if (!ok) { failures++; console.log(`  FAIL: ${what}`); } };
  check(r.skipped === 0, `niets overgeslagen (skipped=${r.skipped})`);
  const rows = db.prepare("SELECT uid, title, description, location, start, end, all_day, tz, rrule, exdates, reminder_min FROM events WHERE calendar_id = ? ORDER BY uid").all(cal) as Record<string, unknown>[];
  check(rows.length === expected.length, `aantal afspraken ${rows.length} = ${expected.length}`);
  for (const want of expected) {
    const got = rows.find((x) => x.uid === want.uid);
    if (!got) { check(false, `afspraak ${want.uid} ontbreekt`); continue; }
    const norm = { ...got, exdates: (JSON.parse(String(got.exdates)) as number[]).sort((a, b) => a - b) };
    for (const k of Object.keys(want)) check(JSON.stringify(norm[k as keyof typeof norm]) === JSON.stringify(want[k]), `${want.uid}.${k}: ${JSON.stringify(norm[k as keyof typeof norm])} = ${JSON.stringify(want[k])}`);
  }
  console.log(`  agenda-telefoon.ics: ${rows.length} afspraken via importIcs gecontroleerd`);
  done();
}

console.log("Gebruik: telefoon-golden.ts maak <uitvoer.json> | controleer <build-map>");
process.exit(2);
