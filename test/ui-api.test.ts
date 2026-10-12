import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import sharp from "sharp";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-api-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MAIL_DOMAINS = "vanes.test";
process.env.MAIL_FROM = "rene@vanes.test";
process.env.ICAL_TOKEN = "kalender-token-123";

const { buildApp } = await import("../src/server.js");
const { setPassword } = await import("../src/auth.js");
const { db } = await import("../src/db.js");
const health = await import("../src/health.js");
const { SMTPServer } = await import("smtp-server");

let app: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>;
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as "GET", url, payload: payload as never, headers: { ...auth, ...headers } });

before(async () => {
  app = await buildApp();
  setPassword("eerste-wachtwoord");
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "eerste-wachtwoord" } });
  auth = { authorization: "Bearer " + r.json().token };
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("instellingen: relay wordt gemaskeerd opgeslagen, wachtwoord wijzigen, testmail via relay", async () => {
  let received = "";
  const relay = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false, onAuth: (_a, _s, cb) => cb(null, { user: "x" }),
    onData(stream, _s, cb) { stream.on("data", (c: Buffer) => (received += c)); stream.on("end", () => cb()); } });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const port = (relay.server.address() as { port: number }).port;

  let r = await call("PUT", "/api/settings", { alertEmail: "rene@extern.example", relay: { host: "127.0.0.1", port, user: "relay-user", password: "relay-geheim", secure: false } });
  assert.equal(r.statusCode, 200, r.body);
  const s = (await call("GET", "/api/settings")).json();
  assert.deepEqual(s.relay, { host: "127.0.0.1", port, user: "relay-user", hasPassword: true, secure: false });
  assert.ok(!JSON.stringify(s).includes("relay-geheim"), "wachtwoord lekt niet");
  assert.match(s.icalUrl, /\/ical\/kalender-token-123\/agenda\.ics$/);

  // Opnieuw opslaan zonder wachtwoord behoudt het oude
  await call("PUT", "/api/settings", { relay: { host: "127.0.0.1", port, user: "relay-user", secure: false } });
  assert.match(db.prepare("SELECT value FROM settings WHERE key = 'mail_relay'").pluck().get() as string, /relay-geheim/);

  r = await call("POST", "/api/settings/test-mail", {});
  relay.close();
  assert.equal(r.statusCode, 200, r.body);
  assert.match(received, /Subject: Testbericht van Eigen Cloud/);
  assert.match(received, /To: rene@extern\.example/);

  assert.equal((await call("POST", "/api/settings/password", { current: "fout", next: "nieuw-wachtwoord-1" })).statusCode, 400);
  const changed = await call("POST", "/api/settings/password", { current: "eerste-wachtwoord", next: "nieuw-wachtwoord-1" });
  assert.equal(changed.statusCode, 200);
  assert.equal((await call("GET", "/api/me")).statusCode, 401, "oude eigenaarsessie is ingetrokken");
  auth = { authorization: "Bearer " + changed.json().token };
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "nieuw-wachtwoord-1" } })).statusCode, 200);
  const qr = await call("GET", "/api/settings/ical-qr");
  assert.match(qr.body, /<svg/);
});

test("gezondheid: controles met nagebootste DNS, handmatige records, DKIM-sleutel maken", async () => {
  const txt: Record<string, string[][]> = { "vanes.test": [["v=spf1 a:mail.vanes.test -all"], ["google-site-verification=abc"]] };
  health.net.resolver = {
    resolveMx: async (d: string) => (d === "vanes.test" ? [{ exchange: "mail.vanes.test", priority: 10 }] : []),
    resolveTxt: async (d: string) => txt[d] ?? [],
    resolve4: async (d: string) => (d === "mail.vanes.test" ? ["1.2.3.4"] : []),
    reverse: async () => [],
  } as never;
  health.net.tlsDaysLeft = async () => 60;

  let h = (await call("GET", "/api/health?fresh=1")).json();
  const by = (id: string) => h.checks.find((c: { id: string }) => c.id === id);
  assert.equal(by("dns.mx").status, "ok");
  assert.equal(by("dns.spf").status, "ok");
  assert.equal(by("dns.a.cloud").status, "fail");
  assert.equal(by("dns.dkim").status, "fail");
  assert.equal(by("dns.dkim").fix.action, "dkim:generate");
  assert.equal(by("tls").status, "ok");
  assert.equal(by("alerts").status, "ok");
  assert.equal(by("backup").status, "warn", "losse server: geen externe back-up");
  assert.ok(h.summary.fail >= 2);

  const r = await call("POST", "/api/health/fix", { action: "dkim:generate" });
  assert.equal(r.statusCode, 200, r.body);
  h = (await call("GET", "/api/health?fresh=1")).json();
  const dk = h.checks.find((c: { id: string }) => c.id === "dns.dkim");
  assert.equal(dk.status, "fail");
  assert.equal(dk.manual[0].name, "eigen._domainkey.vanes.test");
  assert.match(dk.manual[0].value, /^v=DKIM1; k=rsa; p=MII/);
  // Lange waarde wordt bij publiceren in stukken van 255 gesplitst; apex-TXT behoudt andere records
  const recs = health.expectedRecords({ ips4: ["1.2.3.4"], ips6: [] });
  const dkimRec = recs.find((x) => x.sub === "eigen._domainkey")!;
  assert.ok(dkimRec.values[0].split('" "').length >= 2);
  const apex = await health.mergeApexTxt(recs.find((x) => x.sub === "" && x.type === "TXT")!);
  assert.equal(apex.values.length, 2);
  assert.match(apex.values[1], /google-site-verification/);
  // Na publiceren klopt het
  txt["eigen._domainkey.vanes.test"] = [[dk.manual[0].value]];
  h = (await call("GET", "/api/health?fresh=1")).json();
  assert.equal(h.checks.find((c: { id: string }) => c.id === "dns.dkim").status, "ok");
  // Uitgaande mail wordt met deze sleutel ondertekend
  const { sendNotice } = await import("../src/mail/send.js");
  let raw = "";
  const relay = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], logger: false, onAuth: (_a, _s, cb) => cb(null, { user: "x" }),
    onData(stream, _s, cb) { stream.on("data", (c: Buffer) => (raw += c)); stream.on("end", () => cb()); } });
  await new Promise<void>((res) => relay.listen(0, "127.0.0.1", () => res()));
  db.prepare("UPDATE settings SET value = ? WHERE key = 'mail_relay'").run(`smtp://127.0.0.1:${(relay.server.address() as { port: number }).port}`);
  await sendNotice("x@extern.example", "melding", "tekst");
  relay.close();
  assert.match(raw, /DKIM-Signature: [^]*?d=vanes\.test;[^]*?s=eigen;/);
});

async function zip(file: string, entries: Record<string, Buffer | string>) {
  await new Promise<void>((res, rej) => {
    const out = fs.createWriteStream(file);
    const a = new ZipArchive();
    out.on("close", () => res());
    a.on("error", rej);
    a.pipe(out);
    for (const [name, data] of Object.entries(entries)) a.append(data, { name });
    void a.finalize();
  });
}

test("importeren via de browser: hervatbare upload, Takeout-zips over meerdere bestanden", async () => {
  const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2f6f8f" } }).jpeg().toBuffer();
  const mbox = `From 1@x Mon Jan 01 10:00:00 +0000 2024\nX-Gmail-Labels: Inbox,Familie\nMessage-ID: <imp1@x>\nFrom: Oma <oma@familie.nl>\nTo: rene@vanes.test\nSubject: Verjaardag\nDate: Mon, 01 Jan 2024 10:00:00 +0000\n\nTot zondag!\n`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:imp-ev@google.com", "DTSTART:20260301T090000Z", "DTEND:20260301T100000Z", "SUMMARY:Geïmporteerd", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const z1 = path.join(tmp, "takeout-20261009T000000Z-001.zip");
  const z2 = path.join(tmp, "takeout-20261009T000000Z-002.zip");
  await zip(z1, {
    "Takeout/Mail/Alle mail inclusief spam en prullenbak.mbox": mbox,
    "Takeout/Agenda/Werk.ics": ics,
    "Takeout/Google Foto's/Photos from 2020/IMG_1.jpg": jpg,
  });
  await zip(z2, { // metadata van IMG_1 zit in de tweede zip
    "Takeout/Google Foto's/Photos from 2020/IMG_1.jpg.supplemental-metadata.json": JSON.stringify({ photoTakenTime: { timestamp: "1593561600" }, favorited: true }),
    "Takeout/Google Foto's/Zomer/IMG_1.jpg": jpg,
  });

  for (const file of [z1, z2]) {
    const buf = fs.readFileSync(file);
    const m = (await call("POST", "/api/import/uploads", { name: path.basename(file), size: buf.length })).json();
    const half = Math.floor(buf.length / 2);
    let r = await call("PUT", `/api/import/uploads/${m.id}?offset=0`, buf.subarray(0, half), { "content-type": "application/octet-stream" });
    assert.equal(r.json().received, half);
    // Verbinding "valt weg": opnieuw beginnen geeft dezelfde upload terug met de juiste positie
    const again = (await call("POST", "/api/import/uploads", { name: path.basename(file), size: buf.length })).json();
    assert.equal(again.id, m.id);
    assert.equal(again.received, half);
    r = await call("PUT", `/api/import/uploads/${m.id}?offset=0`, buf.subarray(0, 10), { "content-type": "application/octet-stream" });
    assert.equal(r.statusCode, 409);
    r = await call("PUT", `/api/import/uploads/${m.id}?offset=${half}`, buf.subarray(half), { "content-type": "application/octet-stream" });
    assert.equal(r.json().done, true);
  }
  assert.equal((await call("POST", "/api/import/uploads", { name: "virus.exe", size: 10 })).statusCode, 400);

  assert.equal((await call("POST", "/api/import/start", {})).statusCode, 200);
  let st: any;
  for (let i = 0; i < 100; i++) {
    st = (await call("GET", "/api/import/status")).json();
    if (!st.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(st.error, null);
  assert.equal(st.progress.phase, "klaar");
  assert.equal(st.progress.mail.added, 1);
  assert.equal(st.progress.calendar.added, 1);
  assert.equal(st.progress.photos.added, 1);
  assert.equal(st.progress.photos.duplicates, 1);
  const photo = db.prepare("SELECT taken_at, is_favorite FROM photos WHERE filename = 'IMG_1.jpg'").get() as { taken_at: number; is_favorite: number };
  assert.equal(photo.taken_at, 1593561600000, "metadata uit de andere zip gevonden");
  assert.equal(photo.is_favorite, 1);
  assert.ok(db.prepare("SELECT 1 FROM albums WHERE name = 'Zomer'").get());
  assert.ok(db.prepare("SELECT 1 FROM calendars WHERE name = 'Werk'").get());
  assert.deepEqual((await call("GET", "/api/import/uploads")).json(), [], "uploads opgeruimd");
});

test("tijdmachine op een losse server legt uit wat er nodig is", async () => {
  const r = (await call("GET", "/api/timemachine")).json();
  assert.equal(r.available, false);
  assert.match(r.reason, /beheerconsole/);
});
