import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-cloud-test-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MAIL_DOMAINS = "test.nl";
process.env.MAIL_FROM = "rene@test.nl";
process.env.SMTP_PORT = "0";
process.env.ICAL_TOKEN = "geheimtoken123";

const { buildApp } = await import("../src/server.js");
const { setPassword } = await import("../src/auth.js");
const { db } = await import("../src/db.js");
const { importGmailMbox } = await import("../src/import/gmail.js");
const { importIcs } = await import("../src/calendar/ics.js");
const { importTakeoutPhotos, findSidecar } = await import("../src/import/photos.js");
const { startSmtpServer } = await import("../src/mail/smtp.js");
const nodemailer = (await import("nodemailer")).default;
const sharp = (await import("sharp")).default;

let app: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>;

before(async () => {
  app = await buildApp();
  setPassword("supergeheim-wachtwoord");
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "supergeheim-wachtwoord" } });
  assert.equal(res.statusCode, 200);
  auth = { authorization: "Bearer " + res.json().token };
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("login: fout wachtwoord en zonder token geweigerd", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "fout" } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/mail/messages" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/me", headers: auth })).statusCode, 200);
});

test("SMTP: ontvangt mail voor eigen domein, weigert relay", async () => {
  const server = startSmtpServer();
  await new Promise((r) => server.server.once("listening", r));
  const port = (server.server.address() as { port: number }).port;
  const t = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
  await t.sendMail({ from: "jan@elders.nl", to: "rene@test.nl", subject: "Hallo via SMTP", text: "Testbericht", attachments: [{ filename: "a.txt", content: "bijlage!" }] });
  await assert.rejects(t.sendMail({ from: "jan@elders.nl", to: "iemand@gmail.com", subject: "x", text: "x" }), /550|Relay/);
  server.close();

  const list = (await app.inject({ url: "/api/mail/messages?folder=inbox", headers: auth })).json();
  const m = list.find((x: { subject: string }) => x.subject === "Hallo via SMTP");
  assert.ok(m, "bericht staat in inbox");
  assert.equal(m.attachment_count, 1);
  const full = (await app.inject({ url: `/api/mail/messages/${m.id}`, headers: auth })).json();
  assert.match(full.body_text, /Testbericht/);
  const att = await app.inject({ url: `/api/mail/attachments/${full.attachments[0].id}`, headers: auth });
  assert.equal(att.body, "bijlage!");
});

test("Gmail mbox-import: labels, mappen, dedup, >From-escaping", async () => {
  const msg = (id: string, labels: string, subject: string, body: string) =>
    `From 1700000000000000${id}@xxx Mon Jan 01 10:00:00 +0000 2024\nX-GM-THRID: 1\nX-Gmail-Labels: ${labels}\nMessage-ID: <${id}@gmail.test>\nFrom: Piet <piet@voorbeeld.nl>\nTo: rene@test.nl\nSubject: ${subject}\nDate: Mon, 01 Jan 2024 10:00:00 +0000\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`;
  const mbox = path.join(tmp, "test.mbox");
  fs.writeFileSync(mbox,
    msg("1", "Inbox,Unread,Werk", "Inbox-bericht", "regel\n>From the start of a line\neinde") +
    msg("2", "Archived,Opened,Category Personal", "Gearchiveerd", "hoi") +
    msg("3", "Sent", "Verzonden", "verstuurd") +
    msg("4", "Trash", "Weg", "weg") +
    msg("1", "Inbox", "Dubbel", "dubbel"));
  const s = await importGmailMbox(mbox);
  assert.deepEqual({ added: s.added, skipped: s.skipped, failed: s.failed }, { added: 4, skipped: 1, failed: 0 });

  const row = (subj: string) => db.prepare("SELECT folder, is_read, labels, body_text FROM messages WHERE subject = ?").get(subj) as { folder: string; is_read: number; labels: string; body_text: string };
  assert.equal(row("Inbox-bericht").folder, "inbox");
  assert.equal(row("Inbox-bericht").is_read, 0);
  assert.deepEqual(JSON.parse(row("Inbox-bericht").labels), ["Werk"]);
  assert.match(row("Inbox-bericht").body_text, /^From the start/m);
  assert.equal(row("Gearchiveerd").folder, "archive");
  assert.equal(row("Verzonden").folder, "sent");
  assert.equal(row("Weg").folder, "trash");

  const search = (await app.inject({ url: "/api/mail/messages?q=gearchiv", headers: auth })).json();
  assert.equal(search.length, 1);
  const byLabel = (await app.inject({ url: "/api/mail/messages?label=Werk", headers: auth })).json();
  assert.equal(byLabel.length, 1);
});

test("Agenda: wekelijkse afspraak blijft 09:00 lokale tijd over de wintertijd-overgang", async () => {
  const start = Date.parse("2026-10-12T09:00:00+02:00");
  const r = await app.inject({ method: "POST", url: "/api/events", headers: auth, payload: { title: "Standup", start, end: start + 15 * 60e3, rrule: "FREQ=WEEKLY;COUNT=4", tz: "Europe/Amsterdam" } });
  const id = r.json().id;
  const occ = (await app.inject({ url: `/api/events?from=${Date.parse("2026-10-01")}&to=${Date.parse("2026-11-30")}`, headers: auth })).json()
    .filter((e: { title: string }) => e.title === "Standup");
  assert.equal(occ.length, 4);
  const local = occ.map((o: { occurrence_start: number }) => new Date(o.occurrence_start).toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }));
  assert.deepEqual(local, ["09:00", "09:00", "09:00", "09:00"]);

  // Eén herhaling verwijderen
  await app.inject({ method: "DELETE", url: `/api/events/${id}?occurrence=${occ[1].occurrence_start}`, headers: auth });
  const after = (await app.inject({ url: `/api/events?from=${Date.parse("2026-10-01")}&to=${Date.parse("2026-11-30")}`, headers: auth })).json()
    .filter((e: { title: string }) => e.title === "Standup");
  assert.equal(after.length, 3);
});

test("Agenda: Google .ics-import met tijdzone, hele dag, herhaling en uitzondering", () => {
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "BEGIN:VTIMEZONE", "TZID:Europe/Amsterdam",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:tandarts@google.com", "DTSTART;TZID=Europe/Amsterdam:20260315T143000", "DTEND;TZID=Europe/Amsterdam:20260315T150000", "SUMMARY:Tandarts", "LOCATION:Rotterdam",
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT30M", "END:VALARM", "END:VEVENT",
    "BEGIN:VEVENT", "UID:verjaardag@google.com", "DTSTART;VALUE=DATE:20260501", "DTEND;VALUE=DATE:20260502", "RRULE:FREQ=YEARLY", "SUMMARY:Verjaardag", "END:VEVENT",
    "BEGIN:VEVENT", "UID:sport@google.com", "DTSTART;TZID=Europe/Amsterdam:20260105T190000", "DTEND;TZID=Europe/Amsterdam:20260105T200000", "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:Sport", "END:VEVENT",
    "BEGIN:VEVENT", "UID:sport@google.com", "RECURRENCE-ID;TZID=Europe/Amsterdam:20260112T190000", "DTSTART;TZID=Europe/Amsterdam:20260113T190000", "DTEND;TZID=Europe/Amsterdam:20260113T200000", "SUMMARY:Sport (verzet)", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const r = importIcs(ics, 1);
  assert.deepEqual(r, { added: 4, updated: 0, skipped: 0 });
  const t = db.prepare("SELECT * FROM events WHERE uid = 'tandarts@google.com'").get() as { start: number; reminder_min: number; tz: string };
  assert.equal(t.start, Date.parse("2026-03-15T14:30:00+01:00"));
  assert.equal(t.reminder_min, 30);
  assert.equal(t.tz, "Europe/Amsterdam");
  const v = db.prepare("SELECT * FROM events WHERE uid = 'verjaardag@google.com'").get() as { all_day: number; start: number };
  assert.equal(v.all_day, 1);
  assert.equal(v.start, Date.UTC(2026, 4, 1));
  const sport = db.prepare("SELECT exdates FROM events WHERE uid = 'sport@google.com'").get() as { exdates: string };
  assert.deepEqual(JSON.parse(sport.exdates), [Date.parse("2026-01-12T19:00:00+01:00")]);
  // Opnieuw importeren = bijwerken, geen dubbelingen
  assert.deepEqual(importIcs(ics, 1), { added: 0, updated: 4, skipped: 0 });
});

test("Agenda: privé iCal-feed werkt alleen met juist token", async () => {
  assert.equal((await app.inject({ url: "/ical/fout/agenda.ics" })).statusCode, 404);
  const ok = await app.inject({ url: "/ical/geheimtoken123/agenda.ics" });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /BEGIN:VCALENDAR/);
  assert.match(ok.body, /DTSTART;TZID=Europe\/Amsterdam:20261012T090000/);
  assert.match(ok.body, /SUMMARY:Tandarts/);
});

test("Foto's: Takeout-import met (afgekapte) JSON-metadata, albums en dedup", async () => {
  const root = path.join(tmp, "Takeout", "Google Foto's");
  const year = path.join(root, "Photos from 2019");
  const album = path.join(root, "Vakantie Italië");
  fs.mkdirSync(year, { recursive: true }); fs.mkdirSync(album, { recursive: true });

  const jpg = (r: number) => sharp({ create: { width: 800, height: 600, channels: 3, background: { r, g: 100, b: 50 } } }).jpeg().toBuffer();
  const longName = "PXL_20190704_123456789.PORTRAIT-01.COVER.jpg";
  fs.writeFileSync(path.join(year, longName), await jpg(200));
  fs.writeFileSync(path.join(year, "PXL_20190704_123456789.PORTRAIT-01.COVER.jpg.supplemental-me.json"),
    JSON.stringify({ title: longName, photoTakenTime: { timestamp: "1562243696" }, geoData: { latitude: 41.89, longitude: 12.49 }, favorited: true }));
  fs.writeFileSync(path.join(year, "IMG_0001(1).jpg"), await jpg(10));
  fs.writeFileSync(path.join(year, "IMG_0001.jpg(1).json"), JSON.stringify({ photoTakenTime: { timestamp: "1546300800" } }));
  fs.copyFileSync(path.join(year, longName), path.join(album, longName)); // zelfde foto in album

  const s = await importTakeoutPhotos(root);
  assert.equal(s.added, 2);
  assert.equal(s.duplicates, 1);
  assert.equal(s.withMetadata, 2); // albumkopie heeft hier geen eigen JSON

  const list = (await app.inject({ url: "/api/photos", headers: auth })).json();
  const portrait = list.find((p: { filename: string }) => p.filename === longName);
  assert.equal(portrait.taken_at, 1562243696000);
  assert.equal(portrait.lat, 41.89);
  assert.equal(portrait.is_favorite, 1);
  assert.equal(portrait.has_thumb, 1);
  const dup = list.find((p: { filename: string }) => p.filename === "IMG_0001(1).jpg");
  assert.equal(dup.taken_at, 1546300800000);

  const albums = (await app.inject({ url: "/api/albums", headers: auth })).json();
  assert.deepEqual(albums.map((a: { name: string; count: number }) => [a.name, a.count]), [["Vakantie Italië", 1]]);

  const thumb = await app.inject({ url: `/api/photos/${portrait.id}/thumb`, headers: auth });
  assert.equal(thumb.headers["content-type"], "image/webp");
  const range = await app.inject({ url: `/api/photos/${portrait.id}/original`, headers: { ...auth, range: "bytes=0-99" } });
  assert.equal(range.statusCode, 206);
  assert.equal(range.rawPayload.length, 100);
});

test("Foto's: upload via API met EXIF-datum", async () => {
  const img = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#336699" } })
    .jpeg().withExif({ IFD0: { Make: "OPPO", Model: "Find X" }, IFD2: { DateTimeOriginal: "2025:08:15 14:20:00" } } as never).toBuffer();
  const boundary = "----testgrens";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="strand.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), img,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await app.inject({ method: "POST", url: "/api/photos/upload", headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(r.statusCode, 200);
  const [res] = r.json();
  assert.equal(res.duplicate, false);
  const p = (await app.inject({ url: `/api/photos/${res.id}`, headers: auth })).json();
  assert.equal(p.camera, "OPPO Find X");
  assert.equal(new Date(p.taken_at).getUTCFullYear(), 2025);
});

test("findSidecar: varianten van Takeout-bestandsnamen", () => {
  assert.equal(findSidecar("/x/a.jpg", ["a.jpg.json"]), "a.jpg.json");
  assert.equal(findSidecar("/x/a.jpg", ["a.jpg.supplemental-metadata.json"]), "a.jpg.supplemental-metadata.json");
  assert.equal(findSidecar("/x/a(2).jpg", ["a.jpg(2).json"]), "a.jpg(2).json");
  assert.equal(findSidecar("/x/a-bewerkt.jpg", ["a.jpg.supplemental-metadata.json"]), "a.jpg.supplemental-metadata.json");
});

test("Versturen via relay, met DKIM-handtekening, komt in 'Verzonden'", async () => {
  const { config } = await import("../src/config.js");
  const { SMTPServer } = await import("smtp-server");
  const crypto = await import("node:crypto");
  const keyFile = path.join(tmp, "dkim.pem");
  fs.writeFileSync(keyFile, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  config.dkimKeyFile = keyFile;

  let received = "";
  const relay = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onData(stream, _s, cb) { stream.on("data", (c: Buffer) => (received += c.toString())); stream.on("end", () => cb()); } });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  config.smtpRelay = `smtp://127.0.0.1:${(relay.server.address() as { port: number }).port}?ignoreTLS=true`;

  const r = await app.inject({ method: "POST", url: "/api/mail/send", headers: auth, payload: { to: "jan@elders.nl", subject: "Uitgaand", text: "Groet" } });
  relay.close();
  assert.equal(r.statusCode, 200, r.body);
  assert.match(received, /^DKIM-Signature: .*d=test\.nl/m);
  assert.match(received, /Subject: Uitgaand/);
  const sent = (await app.inject({ url: "/api/mail/messages?folder=sent", headers: auth })).json();
  assert.ok(sent.some((m: { subject: string }) => m.subject === "Uitgaand"));
});
