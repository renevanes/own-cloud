import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SMTPServer } from "smtp-server";
import sharp from "sharp";
import yauzl from "yauzl";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-features-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MAIL_DOMAINS = "family.test";
process.env.MAIL_FROM = "owner@family.test";
process.env.ICAL_TOKEN = "owner-private-ical-link";
const { buildApp } = await import("../src/server.js");
const { setPassword, createToken } = await import("../src/auth.js");
const { db, setSetting } = await import("../src/db.js");
const { runtime } = await import("../src/cluster/runtime.js");
const { totpCode, base32Decode } = await import("../src/security/totp.js");
const { processOutbox } = await import("../src/mail/outbox.js");
const { drainImports } = await import("../src/import/persistent.js");
const { deliverInbound, withEnvelope } = await import("../src/mail/inbound.js");
let app: Awaited<ReturnType<typeof buildApp>>, owner: string, member: string, memberId: number;
const call = (method: string, url: string, payload?: unknown, token = owner, headers: Record<string, string> = {}) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}`, ...headers } });
const ok = (r: any, code = 200) => { assert.equal(r.statusCode, code, r.body); return r.headers["content-type"]?.includes("json") ? r.json() : r.body; };
before(async () => {
  app = await buildApp(); setPassword("long-test-password"); owner = createToken();
  memberId = ok(await call("POST", "/api/users", { name: "Member", localpart: "member", password: "member-password", invite: false })).user.id;
  member = ok(await call("POST", "/api/login", { user: "member", password: "member-password" })).token;
});
after(async () => { runtime.enabled = false; await app.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("runtime schemas reject unlimited pages, invalid fields, and huge ranges; cursor preserves equal-date messages", async () => {
  for (const url of ["/api/mail/messages?limit=-1", "/api/mail/messages?limit=0", "/api/photos?limit=501", "/api/photos?beforeId=NaN", "/api/events/nope"])
    ok(await call("GET", url), 400);
  ok(await call("POST", "/api/events", { title: "bad", start: "not a date", end: 3 }), 400);
  ok(await call("POST", "/api/events", { title: "bad", start: 2, end: 3, extra: true }), 400);
  ok(await call("POST", "/api/events", { title: "unbounded", start: 1793520000000, end: 1793523600000, rrule: "FREQ=SECONDLY" }), 400);
  ok(await call("POST", "/api/calendar/import", { ics: "not an iCalendar file" }), 400);
  for (let i = 0; i < 3; i++) await deliverInbound(Buffer.from(`Message-ID: <cursor-${i}@family.test>\r\nDate: Thu, 01 Jan 2026 12:00:00 +0000\r\nFrom: a@outside.test\r\nTo: owner@family.test\r\nSubject: cursor\r\n\r\nbody`));
  const first = ok(await call("GET", "/api/mail/messages?limit=2"));
  const second = ok(await call("GET", `/api/mail/messages?limit=2&before=${first[1].date}&beforeId=${first[1].id}`));
  assert.equal(second.length, 1); assert.equal(new Set([...first, ...second].map((r: any) => r.id)).size, 3);
});

test("uncertain acknowledgements replay the same operation and reject a changed payload", async () => {
  const original = runtime.waitDurable;
  runtime.enabled = true; runtime.waitDurable = async () => false;
  try {
    const headers = { "idempotency-key": "calendar-operation-test" };
    const r = await call("POST", "/api/calendars", { name: "Replay" }, owner, headers);
    assert.equal(r.statusCode, 503); assert.equal(r.json().uncertain, true);
    const n = db.prepare("SELECT COUNT(*) FROM calendars WHERE name='Replay'").pluck().get();
    runtime.waitDurable = async () => true;
    const replay = ok(await call("POST", "/api/calendars", { name: "Replay" }, owner, headers)); assert.ok(replay.id);
    assert.equal(db.prepare("SELECT COUNT(*) FROM calendars WHERE name='Replay'").pluck().get(), n);
    ok(await call("POST", "/api/calendars", { name: "Different" }, owner, headers), 409);
    ok(await call("GET", "/api/operations/calendar-operation-test", undefined, member), 404);
  } finally { runtime.enabled = false; runtime.waitDurable = original; }
});

test("MFA counters and recovery codes cannot be replayed; logout and generation revoke bearer sessions", async () => {
  const enrol = ok(await call("POST", "/api/security/mfa/enrol", { password: "member-password" }, member));
  const code = totpCode(base32Decode(enrol.secret));
  const confirmed = ok(await call("POST", "/api/security/mfa/confirm", { code }, member));
  ok(await call("GET", "/api/me", undefined, member), 401); member = confirmed.token;
  const login = (second?: string) => app.inject({ method: "POST", url: "/api/login", payload: { user: "member", password: "member-password", code: second } });
  assert.equal((await login()).json().mfaRequired, true); ok(await login(code), 401);
  const recovery = confirmed.recoveryCodes[0]; const session = ok(await login(recovery)).token;
  ok(await login(recovery), 401);
  ok(await call("POST", "/api/logout", {}, session)); ok(await call("GET", "/api/me", undefined, session), 401);
  const devices = ok(await call("GET", "/api/security", undefined, member)); assert.ok(devices.sessions.some((s: any) => s.current));
  const old = member;
  member = ok(await call("POST", "/api/security/mfa/disable", { password: "member-password", code: confirmed.recoveryCodes[1] }, member)).token;
  ok(await call("GET", "/api/me", undefined, old), 401);
});

test("DAV discovery, conditional CalDAV updates, XML hardening, and scoped CardDAV credentials", async () => {
  const credential = ok(await call("POST", "/api/security/credentials", { password: "member-password", label: "Contacts client", scopes: ["carddav"] }, member));
  const basic = { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}` };
  const home = `/dav/principals/${memberId}/`;
  ok(await call("PROPFIND", home, "", member, { depth: "1", "content-type": "application/xml" }), 207);
  const cardPath = `/dav/addressbooks/${memberId}/contacts/friend.vcf`;
  const card = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:external-uid\r\nFN:Friend\r\nitem1.EMAIL:friend@outside.test\r\nBDAY:19900101\r\nEND:VCARD\r\n";
  ok(await call("PUT", cardPath, card, member, { ...basic, "content-type": "text/vcard", "if-none-match": "*" }), 201);
  const got = await call("GET", cardPath, undefined, member, basic); ok(got);
  assert.match(got.body, /BDAY:19900101/); assert.ok(got.headers.etag);
  ok(await call("PUT", cardPath, card.replace("Friend", "Changed"), member, { ...basic, "content-type": "text/vcard" }), 428);
  ok(await call("PUT", cardPath, card.replace("Friend", "Changed"), member, { ...basic, "content-type": "text/vcard", "if-match": '"stale"' }), 412);
  const contact = ok(await call("GET", "/api/contacts", undefined, member))[0];
  ok(await call("PUT", `/api/contacts/${contact.id}`, { name: "API edit", email: "friend@outside.test", revision: contact.revision }, member));
  const edited = ok(await call("GET", cardPath, undefined, member, basic)); assert.match(edited, /UID:external-uid/); assert.match(edited, /BDAY:19900101/);
  const search = (name: string) => call("REPORT", `/dav/addressbooks/${memberId}/contacts/`, `<A:addressbook-query xmlns:A="urn:ietf:params:xml:ns:carddav"><A:filter><A:prop-filter name="FN"><A:text-match match-type="contains">${name}</A:text-match></A:prop-filter></A:filter></A:addressbook-query>`, member, { ...basic, "content-type": "application/xml" });
  assert.match(ok(await search("api edit"), 207), /friend.vcf/);
  assert.doesNotMatch(ok(await search("absent"), 207), /friend.vcf/);
  ok(await call("PUT", cardPath.replace("friend.vcf", "duplicate.vcf"), card, member, { ...basic, "content-type": "text/vcard", "if-none-match": "*" }), 409);
  ok(await call("PUT", `/api/contacts/${contact.id}`, { name: "Stale", revision: contact.revision }, member), 409);
  const cal = ok(await call("GET", "/api/calendars", undefined, member))[0].id;
  ok(await call("PROPFIND", `/dav/calendars/${memberId}/${cal}/`, "", member, { ...basic, "content-type": "application/xml" }), 403);
  const icsPath = `/dav/calendars/${memberId}/${cal}/meeting.ics`;
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dav-meeting\r\nDTSTART:20261101T090000Z\r\nDTEND:20261101T100000Z\r\nSUMMARY:DAV meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const created = await call("PUT", icsPath, ics, member, { "content-type": "text/calendar", "if-none-match": "*" }); ok(created, 201);
  const current = await call("GET", icsPath, undefined, member); ok(current); assert.equal(current.body, ics);
  ok(await call("PUT", icsPath, ics.replace("DAV meeting", "New meeting"), member, { "content-type": "text/calendar", "if-match": String(current.headers.etag) }), 204);
  ok(await call("DELETE", icsPath, undefined, member, { "if-match": String(current.headers.etag) }), 412);
  ok(await call("REPORT", `/dav/addressbooks/${memberId}/contacts/`, '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', member, { "content-type": "application/xml" }), 400);
  ok(await call("DELETE", `/api/security/credentials/${credential.id}`, {}, member));
  ok(await call("GET", cardPath, undefined, member, basic), 401);
});

test("family sharing requires acceptance and read-only shares reject edits and disappear after revocation", async () => {
  const calendar = ok(await call("POST", "/api/calendars", { name: "Family" })).id;
  const event = ok(await call("POST", "/api/events", { title: "Family lunch", calendar_id: calendar, start: 1793520000000, end: 1793523600000 })).id;
  const share = ok(await call("POST", "/api/sharing", { kind: "calendar", resourceId: calendar, member: "member", role: "read" })).id;
  ok(await call("GET", `/api/events/${event}`, undefined, member), 404);
  ok(await call("POST", `/api/sharing/${share}/respond`, { accept: true }, member));
  ok(await call("GET", `/api/events/${event}`, undefined, member)); ok(await call("PATCH", `/api/events/${event}`, { title: "Changed" }, member), 404);
  const current = await call("GET", `/api/events/${event}`);
  ok(await call("PATCH", `/api/events/${event}`, { title: "Another device" }));
  ok(await call("PATCH", `/api/events/${event}`, { title: "Offline stale" }, owner, { "if-match": String(current.headers.etag) }), 412);
  ok(await call("DELETE", `/api/sharing/${share}`, {})); ok(await call("GET", `/api/events/${event}`, undefined, member), 404);
});

test("durable outbox records recipient failures and retries only undelivered recipients with a stable message ID", async () => {
  const deliveries: { to: string; raw: string }[] = []; let reject = true;
  const relay = new SMTPServer({ authOptional: true, disabledCommands: ["AUTH", "STARTTLS"], logger: false,
    onRcptTo(a, _s, cb) { if (a.address === "later@outside.test" && reject) cb(Object.assign(new Error("Try later"), { responseCode: 450 })); else cb(); },
    onData(stream, session, cb) { let raw = ""; stream.on("data", (b: Buffer) => raw += b); stream.on("end", () => { deliveries.push({ to: session.envelope.rcptTo[0].address, raw }); cb(); }); } });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const port = (relay.server.address() as any).port; setSetting("mail_relay", `smtp://127.0.0.1:${port}`);
  try {
    const key = { "idempotency-key": "outgoing-unique-operation" };
    const mail = { to: ["first@outside.test", "later@outside.test"], subject: "Delivery test", text: "body" };
    const sent = ok(await call("POST", "/api/mail/send", mail, owner, key));
    assert.equal(sent.status, "retry"); assert.equal(deliveries.length, 1);
    const out = ok(await call("GET", "/api/mail/outbox"))[0]; assert.equal(out.deliveries.filter((d: any) => d.status === "sent").length, 1);
    ok(await call("POST", "/api/mail/send", mail, owner, key)); assert.equal(deliveries.length, 1);
    reject = false; await processOutbox(sent.outboxId); assert.equal(deliveries.length, 2);
    assert.equal(/Message-ID: ([^\r]+)/i.exec(deliveries[0].raw)?.[1], /Message-ID: ([^\r]+)/i.exec(deliveries[1].raw)?.[1]);
    assert.equal(db.prepare("SELECT status FROM mail_outbox WHERE id=?").pluck().get(sent.outboxId), "sent");
    db.prepare("UPDATE mail_outbox SET status='processing' WHERE id=?").run(sent.outboxId);
    db.prepare("UPDATE mail_delivery SET status='sending' WHERE outbox_id=? AND address='later@outside.test'").run(sent.outboxId);
    await processOutbox(sent.outboxId); assert.equal(deliveries.length, 2); assert.equal(db.prepare("SELECT status FROM mail_outbox WHERE id=?").pluck().get(sent.outboxId), "uncertain");
    ok(await call("POST", `/api/mail/outbox/${sent.outboxId}/retry`, {}), 409);
    ok(await call("GET", "/api/mail/outbox", undefined, member)); assert.deepEqual(ok(await call("GET", "/api/mail/outbox", undefined, member)), []);
  } finally { setSetting("mail_relay", ""); await new Promise<void>((r) => relay.close(r)); }
});

test("saved drafts isolate accounts and detect stale revisions", async () => {
  const draft = ok(await call("PUT", "/api/mail/drafts/draft-example", { to: [], subject: "Unsaved thought", text: "Draft" }));
  ok(await call("PUT", "/api/mail/drafts/draft-example", { to: [], text: "Changed" }));
  ok(await call("PUT", "/api/mail/drafts/draft-example", { to: [], text: "Stale" }, owner, { "if-match": `"draft-draft-example-${draft.updated}"` }), 412);
  ok(await call("PUT", "/api/mail/drafts/draft-example", { to: [], text: "Other" }, member), 404);
});

test("persisted imports survive a server restart, and duplicate immutable chunks are harmless", async () => {
  const ics = Buffer.from("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:persisted-import\r\nDTSTART:20261201T090000Z\r\nDTEND:20261201T100000Z\r\nSUMMARY:Restarted import\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  const u = ok(await call("POST", "/api/import/uploads", { name: "restart.ics", size: ics.length }));
  const headers = { "content-type": "application/octet-stream" };
  ok(await call("PUT", `/api/import/uploads/${u.id}?offset=0`, ics, owner, headers));
  const chunk = db.prepare("SELECT path FROM import_chunks WHERE upload_id=?").pluck().get(u.id) as string;
  fs.unlinkSync(path.join(process.env.DATA_DIR!, chunk));
  ok(await call("PUT", `/api/import/uploads/${u.id}?offset=0`, ics, owner, headers));
  assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR!, chunk)), ics);
  const durable = runtime.waitDurable; runtime.enabled = true; runtime.waitDurable = async () => false;
  try {
    const r = await call("POST", "/api/import/start", { ids: [u.id] }); assert.equal(r.statusCode, 503);
    await app.close(); app = await buildApp(); runtime.waitDurable = async () => true;
    await drainImports();
    const status = ok(await call("GET", "/api/import/status")); assert.equal(status.status, "done", JSON.stringify(status));
    assert.equal(db.prepare("SELECT COUNT(*) FROM events WHERE uid='persisted-import'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM import_chunks WHERE upload_id=?").pluck().get(u.id), 0);
  } finally { runtime.enabled = false; runtime.waitDurable = durable; }
});

test("older peers block feature writes without recording incompatible replication entries", async () => {
  const blocked = runtime.featuresBlocked;
  runtime.featuresBlocked = () => "Older server is still upgrading";
  try {
    ok(await call("POST", "/api/contacts", { name: "Blocked contact" }), 503);
    const raw = Buffer.from("Message-ID: <rolling-schema@family.test>\r\nFrom: a@outside.test\r\nSubject: Legacy-compatible mail\r\n\r\nbody");
    const ids = await deliverInbound(raw); assert.equal(ids.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM mail_security WHERE message_id=?").pluck().get(ids[0]), 0);
  } finally { runtime.featuresBlocked = blocked; }
});

test("the owner's private calendar URL cannot derive another user's feed", async () => {
  const { icalTokenFor } = await import("../src/calendar/routes.js");
  const { config } = await import("../src/config.js");
  const publicDerivation = crypto.createHmac("sha256", config.icalToken).update(`ical-user:${memberId}`).digest("hex").slice(0, 32);
  ok(await call("GET", `/ical/${publicDerivation}/agenda.ics`), 404);
  ok(await call("GET", `/ical/${icalTokenFor(memberId)}/agenda.ics`));
});

test("storage quotas reject oversized staging with an actionable response and no retained reservation", async () => {
  const payload = { name: "too-large.ics", size: 10000 }, headers = { "idempotency-key": "quota-retry-after-free-space" };
  ok(await call("PUT", "/api/admin/resources", { userId: memberId, bytes: 1000 }));
  try {
    const rejected = await call("POST", "/api/import/uploads", payload, member, headers);
    ok(rejected, 507); assert.match(rejected.json().error, /opslagruimte/);
    assert.equal(db.prepare("SELECT COUNT(*) FROM _resource_reservations WHERE user_id=?").pluck().get(memberId), 0);
  } finally { ok(await call("PUT", "/api/admin/resources", { userId: memberId, bytes: 0 })); }
  const retried = ok(await call("POST", "/api/import/uploads", payload, member, headers));
  ok(await call("DELETE", `/api/import/uploads/${retried.id}`, {}, member));
});

test("spam results come from the configured scanner; mailbox rules and stable retry deduplication are applied", async () => {
  const scanner = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ score: 20, action: "add header", symbols: { TEST: { score: 20 } } })); }); });
  await new Promise<void>((r) => scanner.listen(0, "127.0.0.1", r));
  try {
    ok(await call("PUT", "/api/mail/filter", { url: `http://127.0.0.1:${(scanner.address() as any).port}`, threshold: 6 }));
    const message = "From: bad@outside.test\r\nTo: owner@family.test\r\nSubject: spam test\r\nAuthentication-Results: forged; spf=pass\r\n\r\nSame body";
    const ids = await deliverInbound(withEnvelope(Buffer.from(`Received: from sender by cloud; first\r\n${message}`), ["owner@family.test"]));
    assert.equal(ids.length, 1); assert.equal(db.prepare("SELECT folder FROM messages WHERE id=?").pluck().get(ids[0]), "spam");
    assert.equal((await deliverInbound(withEnvelope(Buffer.from(`Received: from sender by cloud; retry\r\n${message}`), ["owner@family.test"]))).length, 0);
    const security = ok(await call("GET", `/api/mail/messages/${ids[0]}`)).security; assert.equal(security.status, "ok");
    ok(await call("PUT", "/api/mail/filter", { url: "", threshold: 6 }));
    ok(await call("POST", "/api/mail/rules", { field: "subject", pattern: "receipt", folder: "archive" }));
    const receipt = await deliverInbound(Buffer.from("Message-ID: <receipt@family.test>\r\nFrom: shop@outside.test\r\nSubject: Receipt\r\n\r\nbody"));
    assert.equal(db.prepare("SELECT folder FROM messages WHERE id=?").pluck().get(receipt[0]), "archive");
  } finally { await new Promise<void>((r) => scanner.close(() => r())); }
});

async function unzip(buf: Buffer) {
  const file = path.join(tmp, "export.zip"); fs.writeFileSync(file, buf);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (e, z) => e ? reject(e) : resolve(z!)));
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("end", resolve); zip.on("error", reject); zip.on("entry", (entry) => {
      zip.openReadStream(entry, (e, stream) => { if (e) return reject(e); const chunks: Buffer[] = []; stream!.on("data", (b) => chunks.push(b)); stream!.on("error", reject); stream!.on("end", () => { out.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); }); });
    }); zip.readEntry();
  }); return out;
}
test("one-click export contains originals and all content extensions with a verifiable integrity manifest", async () => {
  const file = path.join(tmp, "photo.jpg"); await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).jpeg().toFile(file);
  const { addPhotoFromFile } = await import("../src/photos/store.js"); const photo = await addPhotoFromFile(file, { lat: 52, lon: 4 });
  ok(await call("PUT", `/api/photos/${photo.id}/tags`, { tags: ["Family", "family"] }));
  assert.equal(ok(await call("GET", "/api/photos/map"))[0].id, photo.id);
  const result = await call("GET", "/api/export/download"); assert.equal(result.statusCode, 200, result.body.slice(0, 100));
  const files = await unzip(result.rawPayload), manifest = JSON.parse(files.get("manifest.json")!.toString());
  assert.equal(manifest.complete, true); assert.ok(files.has("agenda.ics"));
  for (const entry of manifest.files) { const data = files.get(entry.name)!; assert.ok(data, entry.name); assert.equal(data.length, entry.bytes); assert.equal(crypto.createHash("sha256").update(data).digest("hex"), entry.sha256, entry.name); }
  const metadata = JSON.parse(files.get("metadata.json")!.toString()); assert.equal(metadata.photos.length, 1); assert.ok(metadata.drafts.length); assert.ok(metadata.outbox.length); assert.ok(metadata.tags.length); assert.ok(metadata.rules.length);
  assert.ok(!files.get("metadata.json")!.includes("password_hash")); assert.equal(metadata.user.id, 1);
  const preview = ok(await call("GET", "/api/export/preview")); assert.equal(preview.photos, 1);
});

test("local OCR stores recognized text and makes it searchable without granting another account edit access", async () => {
  const { addPhotoFromFile } = await import("../src/photos/store.js");
  const { drainMedia } = await import("../src/photos/tools.js");
  const photo = await addPhotoFromFile(path.resolve("test/fixtures/ocr.png"));
  ok(await call("POST", `/api/photos/${photo.id}/ocr`, {}, member), 400);
  const queued = ok(await call("POST", `/api/photos/${photo.id}/ocr`, {})); assert.ok(queued.id);
  const languages = process.env.EIGEN_OCR_LANGUAGES;
  process.env.EIGEN_OCR_LANGUAGES = "eng";
  try {
    await drainMedia();
    const result = ok(await call("GET", `/api/photos/${photo.id}/annotations`));
    assert.equal(result.ocr.status, "done", JSON.stringify(result)); assert.match(result.text, /INVOICE/);
    assert.ok(ok(await call("GET", "/api/photos?q=INVOICE")).some((p: any) => p.id === photo.id));
  } finally { if (languages === undefined) delete process.env.EIGEN_OCR_LANGUAGES; else process.env.EIGEN_OCR_LANGUAGES = languages; }
});
