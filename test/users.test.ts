/**
 * Meerdere gebruikers: migratie van een bestaande cloud (één gebruiker), beheer door de eigenaar, uitnodigen,
 * inloggen per gebruiker, afscherming van elkaars gegevens, mail per ontvanger, wachtwoorden, uitschakelen en verwijderen.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gebruikers-"));
const dataDir = path.join(tmp, "data");
process.env.DATA_DIR = dataDir;
process.env.MAIL_DOMAINS = "vanes.test";
process.env.MAIL_FROM = "rene@vanes.test";
process.env.SMTP_PORT = "0";
process.env.ICAL_TOKEN = "kalender-token-eigenaar-123";
process.env.SESSION_SECRET = "geheim-voor-de-test";

// ── Een bestaande cloud van vóór meerdere gebruikers (versie 1.6), met gegevens en een bestaande sessie ──
const OWNER_PW = "oud-wachtwoord-eigenaar";
fs.mkdirSync(dataDir, { recursive: true });
{
  const old = new Database(path.join(dataDir, "eigen-cloud.sqlite"));
  old.exec(fs.readFileSync(path.join(import.meta.dirname, "helpers/schema-1.6.sql"), "utf8"));
  const salt = crypto.randomBytes(16);
  const hash = `scrypt$${salt.toString("hex")}$${crypto.scryptSync(OWNER_PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
  old.prepare("INSERT INTO settings (key, value) VALUES ('password_hash', ?), ('mail_from', 'rene@vanes.test')").run(hash);
  old.prepare(`INSERT INTO messages (id, message_id, thread_key, folder, from_addr, from_name, to_addrs, subject, snippet, body_text, date, raw_path, size)
    VALUES (1, '<oud-1@elders.nl>', 't1', 'inbox', 'jan@elders.nl', 'Jan', '[]', 'Geheim van de eigenaar', 'zoekwoord', 'zoekwoord kokosnoot', 1700000000000, 'mail/raw/aa/oud.eml', 10)`).run();
  old.prepare("INSERT INTO attachments (id, message_id, filename, mime, size, path) VALUES (1, 1, 'contract.pdf', 'application/pdf', 5, 'mail/attachments/aa/contract')").run();
  old.prepare("INSERT INTO calendars (id, name, color) VALUES (1, 'Persoonlijk', '#3f6f4a')").run();
  old.prepare("INSERT INTO events (id, uid, calendar_id, title, start, end, updated) VALUES (1, 'gedeelde-uid@google.com', 1, 'Afspraak eigenaar', 1800000000000, 1800003600000, 1)").run();
  old.prepare("INSERT INTO photos (id, sha256, filename, mime, size, taken_at, path, thumb_path, added) VALUES (1, 'abc', 'oud.jpg', 'image/jpeg', 3, 1700000000000, 'photos/originals/oud.jpg', NULL, 1)").run();
  old.prepare("INSERT INTO albums (id, name) VALUES (1, 'Vakantie')").run();
  old.prepare("INSERT INTO album_photos (album_id, photo_id) VALUES (1, 1)").run();
  old.close();
  for (const [rel, body] of [["mail/attachments/aa/contract", "PDF!!"], ["photos/originals/oud.jpg", "JPG"], ["mail/raw/aa/oud.eml", "Subject: x\r\n\r\nx"]]) {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), body);
  }
}
const exp = String(Date.now() + 864e5);
const legacyToken = `${exp}.${crypto.createHmac("sha256", process.env.SESSION_SECRET).update(exp).digest("base64url")}`;

const { buildApp } = await import("../src/server.js");
const { db, setSetting } = await import("../src/db.js");
const { startSmtpServer } = await import("../src/mail/smtp.js");
const { runtime } = await import("../src/cluster/runtime.js");
const { SMTPServer } = await import("smtp-server");
const nodemailer = (await import("nodemailer")).default;
const sharp = (await import("sharp")).default;

let app: Awaited<ReturnType<typeof buildApp>>;
const owner = { authorization: "Bearer " + legacyToken };
const as = (token: string) => ({ authorization: "Bearer " + token });
const call = (headers: Record<string, string>, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as never, headers });
const login = async (user: string | undefined, password: string) =>
  app.inject({ method: "POST", url: "/api/login", payload: user === undefined ? { password } : { user, password } });

const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
let ownerPhotoId = 0;

before(async () => { app = await buildApp(); });
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function upload(token: string, img: Buffer, name: string) {
  const boundary = "----grens";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/jpeg\r\n\r\n`), img,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await app.inject({ method: "POST", url: "/api/photos/upload", headers: { ...as(token), "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(r.statusCode, 200, r.body);
  return r.json()[0] as { id: number; duplicate: boolean };
}

test("migratie: alles van de bestaande cloud is van de eigenaar; oude sessie, wachtwoord en adres werken", async () => {
  for (const t of ["messages", "calendars", "events", "photos", "albums"]) {
    assert.ok((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "user_id"), t);
    assert.deepEqual(db.prepare(`SELECT DISTINCT user_id FROM ${t}`).pluck().all(), [1], t);
  }
  assert.equal(db.prepare("SELECT COUNT(*) FROM album_photos").pluck().get(), 1, "albumkoppeling bleef staan");
  assert.equal(db.pragma("foreign_key_check").length, 0);
  // Oude sessie (token zonder gebruiker) = eigenaar
  const me = await call(owner, "GET", "/api/me");
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().user, { id: 1, name: "Rene", address: "rene@vanes.test", owner: true });
  assert.equal((await call(owner, "GET", "/api/mail/messages?folder=inbox")).json()[0].subject, "Geheim van de eigenaar");
  // Inloggen met alleen het wachtwoord, zoals voorheen
  const r = await login(undefined, OWNER_PW);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().token.split(".").length, 2, "token van de eigenaar heeft het oude formaat");
  assert.deepEqual((await app.inject({ url: "/api/login/info" })).json(), { multiUser: false });
  // Zoeken (FTS) werkt na de migratie
  assert.equal((await call(owner, "GET", "/api/mail/messages?q=kokosnoot")).json().length, 1);
  // Migratie is idempotent
  const { migrateUserSchema } = await import("../src/userSchema.js");
  migrateUserSchema(db);
  assert.equal(db.prepare("SELECT COUNT(*) FROM events").pluck().get(), 1);
});

test("eigenaar voegt gebruikers toe binnen max_users; daarboven geweigerd met uitleg", async () => {
  setSetting("max_users", "3");
  let r = await call(owner, "POST", "/api/users", { name: "Anna", localpart: "anna", password: "anna-wachtwoord-1" });
  assert.equal(r.statusCode, 200, r.body);
  ids.anna = r.json().user.id;
  assert.equal(ids.anna, 2);
  assert.equal(r.json().user.address, "anna@vanes.test");
  assert.equal(r.json().inviteUrl, null);

  r = await call(owner, "POST", "/api/users", { name: "Bob", localpart: "bob", invite: true });
  assert.equal(r.statusCode, 200, r.body);
  ids.bob = r.json().user.id;
  assert.equal(r.json().user.status, "invited");
  assert.match(r.json().inviteUrl, /\/\?uitnodiging=[A-Za-z0-9_-]{20,}$/);
  const invite = new URL(r.json().inviteUrl).searchParams.get("uitnodiging")!;

  // Dubbel adres, gereserveerd adres, eigen adres
  assert.equal((await call(owner, "POST", "/api/users", { name: "X", localpart: "anna", password: "xxxxxxxxxxxx" })).statusCode, 400);
  assert.match((await call(owner, "POST", "/api/users", { name: "X", localpart: "postmaster", password: "xxxxxxxxxxxx" })).json().error, /gereserveerd/);

  r = await call(owner, "POST", "/api/users", { name: "Carla", localpart: "carla", password: "carla-wachtwoord" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, "Je abonnement heeft ruimte voor 3 gebruikers. Extra gebruikers regel je bij je abonnement.");
  const list = (await call(owner, "GET", "/api/users")).json();
  assert.equal(list.canAdd, false);
  assert.equal(list.count, 3);
  assert.deepEqual(list.users.map((u: { address: string }) => u.address), ["rene@vanes.test", "anna@vanes.test", "bob@vanes.test"]);
  assert.ok(list.users.every((u: { storage: { total: number } }) => typeof u.storage.total === "number"));

  // Uitnodiging: gegevens bekijken, wachtwoord kiezen, daarna is de link verbruikt
  r = await app.inject({ url: `/api/invite/${invite}` });
  assert.deepEqual(r.json(), { name: "Bob", address: "bob@vanes.test" });
  assert.equal((await app.inject({ method: "POST", url: `/api/invite/${invite}`, payload: { password: "kort" } })).statusCode, 400);
  r = await app.inject({ method: "POST", url: `/api/invite/${invite}`, payload: { password: "bob-wachtwoord-1" } });
  assert.equal(r.statusCode, 200, r.body);
  tokens.bob = r.json().token;
  assert.equal((await app.inject({ url: `/api/invite/${invite}` })).statusCode, 404);
  assert.equal((await call(as(tokens.bob), "GET", "/api/me")).json().user.address, "bob@vanes.test");

  // Zonder limiet weer onbeperkt
  setSetting("max_users", "0");
  assert.equal((await call(owner, "GET", "/api/users")).json().canAdd, true);
  setSetting("max_users", "3");
});

test("inloggen per gebruiker: met naam, adres of deel vóór de @", async () => {
  assert.deepEqual((await app.inject({ url: "/api/login/info" })).json(), { multiUser: true });
  for (const who of ["anna", "Anna", "anna@vanes.test"]) {
    const r = await login(who, "anna-wachtwoord-1");
    assert.equal(r.statusCode, 200, who);
    tokens.anna = r.json().token;
  }
  assert.equal((await login("anna", OWNER_PW)).statusCode, 401, "wachtwoord van een ander werkt niet");
  assert.equal((await login(undefined, "anna-wachtwoord-1")).statusCode, 401, "zonder adres is het de eigenaar");
  assert.equal((await login("rene@vanes.test", OWNER_PW)).statusCode, 200);
  assert.equal((await login("niemand", "anna-wachtwoord-1")).statusCode, 401);
  const me = (await call(as(tokens.anna), "GET", "/api/me")).json();
  assert.deepEqual(me.user, { id: ids.anna, name: "Anna", address: "anna@vanes.test", owner: false });
  assert.equal(me.mailFrom, "anna@vanes.test");
});

test("afscherming: Anna ziet niets van de eigenaar, via geen enkel adres", async () => {
  const A = as(tokens.anna);
  const no = async (method: string, url: string, payload?: unknown) => {
    const r = await call(A, method, url, payload);
    assert.ok([403, 404, 400].includes(r.statusCode), `${method} ${url} → ${r.statusCode} ${r.body}`);
  };
  // Mail
  assert.deepEqual((await call(A, "GET", "/api/mail/messages?folder=inbox")).json(), []);
  assert.deepEqual((await call(A, "GET", "/api/mail/messages?q=kokosnoot")).json(), [], "zoeken");
  assert.deepEqual((await call(A, "GET", "/api/mail/messages?q=zoekwoord&folder=inbox")).json(), []);
  assert.ok((await call(A, "GET", "/api/mail/folders")).json().folders.every((f: { total: number }) => f.total === 0));
  await no("GET", "/api/mail/messages/1");
  await no("GET", "/api/mail/messages/1/raw");
  await no("GET", "/api/mail/attachments/1");
  await no("PATCH", "/api/mail/messages/1", { folder: "trash" });
  await no("DELETE", "/api/mail/messages/1");
  assert.equal(db.prepare("SELECT folder FROM messages WHERE id = 1").pluck().get(), "inbox");
  // Agenda
  const cals = (await call(A, "GET", "/api/calendars")).json();
  assert.equal(cals.length, 1);
  assert.notEqual(cals[0].id, 1);
  assert.deepEqual((await call(A, "GET", "/api/events?from=1790000000000&to=1820000000000")).json(), []);
  await no("GET", "/api/events/1");
  await no("PATCH", "/api/events/1", { title: "gehackt" });
  await no("DELETE", "/api/events/1");
  await no("PATCH", "/api/calendars/1", { name: "gehackt" });
  await no("DELETE", "/api/calendars/1");
  await no("POST", "/api/events", { title: "In andermans agenda", start: 1, end: 2, calendar_id: 1 });
  await no("POST", "/api/calendar/import", { ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR", calendar_id: 1 });
  assert.ok(!(await call(A, "GET", "/api/calendar/export.ics")).body.includes("Afspraak eigenaar"));
  assert.equal(db.prepare("SELECT title FROM events WHERE id = 1").pluck().get(), "Afspraak eigenaar");
  // Zelfde iCal-UID bij twee gebruikers kan (gedeelde uitnodiging), zonder elkaars afspraak te overschrijven
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:gedeelde-uid@google.com\r\nDTSTART:20270115T090000Z\r\nDTEND:20270115T100000Z\r\nSUMMARY:Afspraak Anna\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  assert.equal((await call(A, "POST", "/api/calendar/import", { ics })).json().added, 1);
  assert.equal(db.prepare("SELECT title FROM events WHERE id = 1").pluck().get(), "Afspraak eigenaar");
  // Foto's en albums
  assert.deepEqual((await call(A, "GET", "/api/photos")).json(), []);
  assert.deepEqual((await call(A, "GET", "/api/photos?q=oud")).json(), [], "zoeken in foto's");
  assert.deepEqual((await call(A, "GET", "/api/photos?album=1")).json(), []);
  assert.deepEqual((await call(A, "GET", "/api/photos/summary")).json(), []);
  assert.deepEqual((await call(A, "GET", "/api/albums")).json(), []);
  await no("GET", "/api/photos/1");
  await no("GET", "/api/photos/1/original");
  await no("GET", "/api/photos/1/thumb");
  await no("PATCH", "/api/photos/1", { is_favorite: true });
  await no("DELETE", "/api/photos/1");
  await no("POST", "/api/photos/1/restore");
  await no("DELETE", "/api/albums/1");
  await no("POST", "/api/albums/1/photos", { photo_ids: [1] });
  await no("DELETE", "/api/albums/1/photos/1");
  // Eigen album: andermans foto toevoegen lukt niet
  const album = (await call(A, "POST", "/api/albums", { name: "Vakantie" })).json();
  assert.notEqual(album.id, 1, "zelfde albumnaam, eigen album");
  await call(A, "POST", `/api/albums/${album.id}/photos`, { photo_ids: [1] });
  assert.equal(db.prepare("SELECT COUNT(*) FROM album_photos WHERE album_id = ?").pluck().get(album.id), 0);
  assert.equal(db.prepare("SELECT is_favorite FROM photos WHERE id = 1").pluck().get(), 0);
  // Beheer van de cloud is alleen voor de eigenaar
  for (const [m, u] of [["GET", "/api/users"], ["POST", "/api/users"], ["POST", "/api/health/fix"], ["PUT", "/api/settings"], ["POST", "/api/settings/test-mail"],
    ["GET", "/api/gmail"], ["GET", "/api/cluster/status"], ["GET", "/api/admin/summary"], ["DELETE", `/api/users/${ids.bob}`]] as const) {
    assert.equal((await call(A, m, u, {})).statusCode, 403, `${m} ${u}`);
  }
  // Gezondheid: alleen de samenvatting (de telefoon-app meldt dan ook bij Anna als de cloud hapert)
  const health = await import("../src/health.js");
  health.net.resolver = { resolveMx: async () => [], resolveTxt: async () => [], resolve4: async () => [], reverse: async () => [] } as never;
  health.net.tlsDaysLeft = async () => 60;
  const h = (await call(A, "GET", "/api/health")).json();
  assert.deepEqual(h.checks, []);
  assert.ok(h.summary);
  const s = (await call(A, "GET", "/api/settings")).json();
  assert.equal(s.owner, false);
  assert.equal(s.relay, undefined, "geen serverinstellingen voor een extra gebruiker");
  // Eigenaar ziet Anna's agenda-afspraak niet
  assert.equal((await call(owner, "GET", "/api/events?from=1790000000000&to=1820000000000")).json().length, 1);
});

test("agenda-feed per gebruiker met een eigen geheim adres", async () => {
  const sa = (await call(as(tokens.anna), "GET", "/api/settings")).json();
  const so = (await call(owner, "GET", "/api/settings")).json();
  assert.match(so.icalUrl, /\/ical\/kalender-token-eigenaar-123\/agenda\.ics$/, "bestaand abonnement van de eigenaar blijft werken");
  assert.notEqual(sa.icalUrl, so.icalUrl);
  const feedA = await app.inject({ url: new URL(sa.icalUrl).pathname });
  assert.equal(feedA.statusCode, 200);
  assert.match(feedA.body, /Afspraak Anna/);
  assert.ok(!feedA.body.includes("Afspraak eigenaar"));
  const feedO = await app.inject({ url: new URL(so.icalUrl).pathname });
  assert.ok(feedO.body.includes("Afspraak eigenaar") && !feedO.body.includes("Afspraak Anna"));
  assert.equal((await app.inject({ url: "/ical/verkeerd-token-123456789/agenda.ics" })).statusCode, 404);
});

test("inkomende mail: per ontvanger in de eigen mailbox; onbekend → eigenaar; vreemd domein geweigerd", async () => {
  const server = startSmtpServer();
  await new Promise((r) => server.server.once("listening", r));
  const port = (server.server.address() as { port: number }).port;
  const t = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
  await t.sendMail({ from: "oma@elders.nl", to: "anna@vanes.test", subject: "Voor Anna", text: "lief" });
  await t.sendMail({ from: "oma@elders.nl", to: ["anna@vanes.test", "Bob@vanes.test"], cc: "rene@vanes.test", subject: "Voor iedereen", text: "allemaal" });
  await t.sendMail({ from: "oma@elders.nl", to: "info@vanes.test", subject: "Catch-all", text: "x" });
  await t.sendMail({ from: "oma@elders.nl", to: "anna+school@vanes.test", subject: "Met plus", text: "x" });
  await assert.rejects(t.sendMail({ from: "x@elders.nl", to: "iemand@gmail.com", subject: "x", text: "x" }), /550|Relay/);
  server.close();
  const subjects = async (token: string) => (await call(as(token), "GET", "/api/mail/messages?folder=inbox")).json().map((m: { subject: string }) => m.subject).sort();
  assert.deepEqual(await subjects(tokens.anna), ["Met plus", "Voor Anna", "Voor iedereen"]);
  assert.deepEqual(await subjects(tokens.bob), ["Voor iedereen"]);
  assert.deepEqual(await subjects(legacyToken), ["Catch-all", "Geheim van de eigenaar", "Voor iedereen"]);
  // Zelfde bericht bij drie mensen = drie losse kopieën; Anna's kopie lezen verandert die van Bob niet
  const a = (await call(as(tokens.anna), "GET", "/api/mail/messages?q=allemaal")).json()[0];
  await call(as(tokens.anna), "GET", `/api/mail/messages/${a.id}`);
  const b = (await call(as(tokens.bob), "GET", "/api/mail/messages?q=allemaal")).json()[0];
  assert.equal(b.is_read, 0);
  // Secundaire MX: de envelop gaat mee in het gespoolde bericht
  const { withEnvelope, deliverInbound } = await import("../src/mail/inbound.js");
  await deliverInbound(withEnvelope(Buffer.from("Subject: Via spool\r\nMessage-ID: <spool-1@x>\r\n\r\nhoi"), ["bob@vanes.test"]));
  assert.deepEqual(await subjects(tokens.bob), ["Via spool", "Voor iedereen"]);
  const stored = db.prepare("SELECT raw_path FROM messages WHERE subject = 'Via spool'").pluck().get() as string;
  assert.ok(!fs.readFileSync(path.join(dataDir, stored), "utf8").includes("X-Eigen-Envelope-To"), "envelop-regel wordt niet bewaard");
});

test("uitgaande mail: afzender is het eigen adres, bewaard in de eigen map Verzonden", async () => {
  const got: { from: string; data: string }[] = [];
  const relay = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
    onData(stream, session, cb) { let d = ""; stream.on("data", (c: Buffer) => (d += c)); stream.on("end", () => { got.push({ from: (session.envelope.mailFrom as { address: string }).address, data: d }); cb(); }); } });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const port = (relay.server.address() as { port: number }).port;
  assert.equal((await call(owner, "PUT", "/api/settings", { relay: { host: "127.0.0.1", port, secure: false } })).statusCode, 200);
  let r = await call(as(tokens.anna), "POST", "/api/mail/send", { to: "oma@elders.nl", subject: "Groetjes van Anna", text: "Hoi oma" });
  assert.equal(r.statusCode, 200, r.body);
  r = await call(owner, "POST", "/api/mail/send", { to: "oma@elders.nl", subject: "Groetjes van Rene", text: "Hoi" });
  assert.equal(r.statusCode, 200, r.body);
  relay.close();
  assert.equal(got[0].from, "anna@vanes.test");
  assert.match(got[0].data, /^From: "?Anna"? <anna@vanes\.test>/m);
  assert.equal(got[1].from, "rene@vanes.test");
  assert.match(got[1].data, /^From: rene@vanes\.test/m);
  const sentA = (await call(as(tokens.anna), "GET", "/api/mail/messages?folder=sent")).json();
  assert.deepEqual(sentA.map((m: { subject: string }) => m.subject), ["Groetjes van Anna"]);
  const sentO = (await call(owner, "GET", "/api/mail/messages?folder=sent")).json();
  assert.deepEqual(sentO.map((m: { subject: string }) => m.subject), ["Groetjes van Rene"]);
  // Antwoorden op andermans bericht verwijst er niet naar
  r = await call(as(tokens.anna), "POST", "/api/mail/send", { to: "x@elders.nl", subject: "x", text: "x", replyToId: 1 });
  assert.notEqual(r.statusCode, 500);
});

test("foto's uploaden met het token van de app: per gebruiker, zelfde foto bij twee mensen", async () => {
  const img = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2a9d8f" } }).jpeg().toBuffer();
  const o = await upload(legacyToken, img, "gezin.jpg");
  const a = await upload(tokens.anna, img, "gezin.jpg");
  assert.equal(o.duplicate, false);
  assert.equal(a.duplicate, false, "voor Anna is het een nieuwe foto");
  assert.notEqual(o.id, a.id);
  ownerPhotoId = o.id;
  assert.equal((await upload(tokens.anna, img, "gezin.jpg")).duplicate, true);
  assert.deepEqual((await call(as(tokens.anna), "GET", "/api/photos")).json().map((p: { id: number }) => p.id), [a.id]);
  const thumb = await call(as(tokens.anna), "GET", `/api/photos/${a.id}/thumb`);
  assert.equal(thumb.statusCode, 200);
  assert.equal((await call(as(tokens.bob), "GET", `/api/photos/${a.id}/original`)).statusCode, 404);
  // De eigenaar gooit zijn exemplaar definitief weg: Anna's bestand blijft
  const p = db.prepare("SELECT path FROM photos WHERE id = ?").pluck().get(a.id) as string;
  const { removeUnreferencedFiles } = await import("../src/users.js");
  db.prepare("DELETE FROM photos WHERE id = ?").run(o.id);
  removeUnreferencedFiles([p]);
  assert.ok(fs.existsSync(path.join(dataDir, p)));
  assert.equal((await call(as(tokens.anna), "GET", `/api/photos/${a.id}/original`)).statusCode, 200);
});

test("wachtwoord: zelf wijzigen, opnieuw instellen door de eigenaar, of via een nieuwe uitnodiging", async () => {
  // Zelf wijzigen: andere sessies vervallen, je krijgt meteen een nieuwe
  const second = (await login("anna", "anna-wachtwoord-1")).json().token;
  let r = await call(as(tokens.anna), "POST", "/api/settings/password", { current: "fout", next: "anna-nieuw-wachtwoord" });
  assert.equal(r.statusCode, 400);
  r = await call(as(tokens.anna), "POST", "/api/settings/password", { current: "anna-wachtwoord-1", next: "anna-nieuw-wachtwoord" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call(as(second), "GET", "/api/me")).statusCode, 401);
  tokens.anna = r.json().token;
  assert.equal((await call(as(tokens.anna), "GET", "/api/me")).statusCode, 200);
  assert.equal((await login("anna", "anna-nieuw-wachtwoord")).statusCode, 200);

  // Eigenaar zet een nieuw wachtwoord: Anna's sessies vervallen
  r = await call(owner, "POST", `/api/users/${ids.anna}/reset`, { password: "door-rene-gezet" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call(as(tokens.anna), "GET", "/api/me")).statusCode, 401);
  assert.equal((await login("anna", "anna-nieuw-wachtwoord")).statusCode, 401);
  tokens.anna = (await login("anna", "door-rene-gezet")).json().token;

  // Nieuwe uitnodigingslink: oude wachtwoord werkt niet meer, mail komt wel binnen
  r = await call(owner, "POST", `/api/users/${ids.bob}/reset`, {});
  const code = new URL(r.json().inviteUrl).searchParams.get("uitnodiging")!;
  assert.equal((await login("bob", "bob-wachtwoord-1")).statusCode, 401);
  assert.equal((await call(as(tokens.bob), "GET", "/api/me")).statusCode, 401);
  tokens.bob = (await app.inject({ method: "POST", url: `/api/invite/${code}`, payload: { password: "bob-wachtwoord-2" } })).json().token;
  assert.equal((await call(as(tokens.bob), "GET", "/api/me")).statusCode, 200);

  // De eigenaar kan zichzelf hier niet resetten
  assert.equal((await call(owner, "POST", "/api/users/1/reset", { password: "xxxxxxxxxxxx" })).statusCode, 400);
  // Eigen naam wijzigen
  assert.equal((await call(as(tokens.bob), "PUT", "/api/account", { name: "Bob de Bouwer" })).statusCode, 200);
  assert.equal((await call(as(tokens.bob), "GET", "/api/account")).json().name, "Bob de Bouwer");
});

test("uitschakelen: niet meer inloggen, sessies vervallen, mail geweigerd; weer aanzetten kan", async () => {
  let r = await call(owner, "PATCH", `/api/users/${ids.bob}`, { disabled: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().user.status, "disabled");
  assert.equal((await call(as(tokens.bob), "GET", "/api/me")).statusCode, 401);
  r = await login("bob", "bob-wachtwoord-2");
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /uitgeschakeld/);
  const server = startSmtpServer();
  await new Promise((res) => server.server.once("listening", res));
  const port = (server.server.address() as { port: number }).port;
  const t = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
  await assert.rejects(t.sendMail({ from: "x@elders.nl", to: "bob@vanes.test", subject: "x", text: "x" }), /550|niet actief/);
  server.close();
  r = await call(owner, "PATCH", `/api/users/${ids.bob}`, { disabled: false });
  assert.equal(r.json().user.status, "active");
  r = await login("bob", "bob-wachtwoord-2");
  assert.equal(r.statusCode, 200);
  tokens.bob = r.json().token;
});

test("verwijderen: met bevestiging, alle gegevens weg, adres weer vrij, oude sessie werkt nooit meer", async () => {
  const anna = ids.anna;
  const counts = () => Object.fromEntries(["messages", "events", "calendars", "photos", "albums"].map((t) => [t, db.prepare(`SELECT COUNT(*) FROM ${t} WHERE user_id = ?`).pluck().get(anna)]));
  assert.ok(Object.values(counts()).every((n) => (n as number) > 0), JSON.stringify(counts()));
  const files = db.prepare("SELECT raw_path FROM messages WHERE user_id = ? AND subject = 'Voor Anna'").pluck().all(anna) as string[];
  let r = await call(owner, "DELETE", `/api/users/${anna}`, { confirm: "iemand-anders@vanes.test" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /anna@vanes\.test/);
  r = await call(owner, "DELETE", `/api/users/${anna}`, { confirm: "anna@vanes.test" });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(counts(), { messages: 0, events: 0, calendars: 0, photos: 0, albums: 0 });
  assert.ok(!fs.existsSync(path.join(dataDir, files[0])), "bestand van alleen Anna is weg");
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE subject = 'Voor iedereen' AND user_id = 1").get(), "kopie van de eigenaar blijft");
  assert.equal((await call(as(tokens.anna), "GET", "/api/me")).statusCode, 401);
  assert.equal((await login("anna", "door-rene-gezet")).statusCode, 401);
  const list = (await call(owner, "GET", "/api/users")).json();
  assert.deepEqual(list.users.map((u: { address: string }) => u.address), ["rene@vanes.test", "bob@vanes.test"]);
  // Adres weer vrij; nieuwe gebruiker krijgt een nieuw nummer (oude sessies kunnen nooit bij hem terechtkomen)
  r = await call(owner, "POST", "/api/users", { name: "Anna", localpart: "anna", password: "nieuwe-anna-1" });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().user.id > anna);
  assert.deepEqual((await call(as((await login("anna", "nieuwe-anna-1")).json().token), "GET", "/api/mail/messages?folder=inbox")).json(), []);
  // Mail naar het adres gaat nu naar de nieuwe Anna
  const { recipientUser } = await import("../src/users.js");
  assert.equal(recipientUser("anna@vanes.test"), r.json().user.id);
  // De eigenaar zelf verwijderen kan niet
  assert.equal((await call(owner, "DELETE", "/api/users/1", { confirm: "rene@vanes.test" })).statusCode, 400);
});

test("cluster in een rollende update: gebruikers toevoegen wacht tot alle servers het kennen", async () => {
  runtime.usersBlocked = () => "Je servers worden nog bijgewerkt. Gebruikers toevoegen kan zodra alle servers de nieuwste versie draaien.";
  setSetting("max_users", "0");
  try {
    const r = await call(owner, "POST", "/api/users", { name: "Dirk", localpart: "dirk", password: "dirk-wachtwoord" });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /bijgewerkt/);
    assert.equal((await call(owner, "GET", "/api/users")).json().canAdd, false);
  } finally {
    runtime.usersBlocked = () => null;
  }
});

test("overzicht voor de aanbieder: aantal gebruikers, opslag en versie (alleen eigenaar)", async () => {
  const r = await call(owner, "GET", "/api/admin/summary");
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.deepEqual(Object.keys(j).sort(), ["storageUsedBytes", "users", "version"]);
  assert.equal(j.users, 3);
  assert.ok(j.storageUsedBytes > 0);
  assert.equal((await call(as(tokens.bob), "GET", "/api/admin/summary")).statusCode, 403);
});
