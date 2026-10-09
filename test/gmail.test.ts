import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.MAIL_DOMAINS = "vanes.test";
process.env.MAIL_FROM = "rene@vanes.test";
process.env.ICAL_TOKEN = "kalender-token-123";
process.env.GMAIL_IMAP_HOST = "127.0.0.1";
process.env.GMAIL_IMAP_SECURE = "0";
process.env.GMAIL_TEST_ALLOW_LOCAL = "1";

const hoodiecrow = (await import("hoodiecrow-imap")).default as (o: unknown) => any;
const { ImapFlow } = await import("imapflow");
const { buildApp } = await import("../src/server.js");
const { setPassword } = await import("../src/auth.js");
const { db, getSetting } = await import("../src/db.js");
const health = await import("../src/health.js");
const { storeRawMessage } = await import("../src/mail/store.js");

const GMAIL = "rene@gmail.com";
const APP_PW = "abcd efgh ijkl mnop"; // zoals Google het toont
const ALL = "[Gmail]/All Mail";

const msg = (id: string, subject: string, to = GMAIL) =>
  `Message-ID: <${id}@gmail.test>\r\nFrom: Piet <piet@voorbeeld.nl>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 01 Jan 2024 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${subject}, de inhoud.\r\n`;

const imap = hoodiecrow({
  plugins: ["ID", "IDLE", "SPECIAL-USE", "X-GM-EXT-1", "UIDPLUS", "ENABLE", "CONDSTORE", "LITERALPLUS"],
  users: { [GMAIL]: { password: "abcdefghijklmnop" } },
  storage: {
    INBOX: {},
    "": {
      separator: "/",
      folders: {
        "[Gmail]": {
          flags: ["\\Noselect"],
          folders: {
            "All Mail": {
              "special-use": "\\All",
              messages: [
                { raw: msg("a1", "Ongelezen in inbox"), flags: [], "X-GM-LABELS": ["\\Inbox"] },
                { raw: msg("a2", "Gearchiveerd met label"), flags: ["\\Seen"], "X-GM-LABELS": ["Familie"] },
                { raw: msg("a3", "Met ster"), flags: ["\\Seen", "\\Flagged"], "X-GM-LABELS": ["\\Inbox", "\\Starred", "\\Important"] },
                { raw: msg("a4", "Zelf verstuurd", "jan@elders.nl"), flags: ["\\Seen"], "X-GM-LABELS": ["\\Sent"] },
              ],
            },
            "Sent Mail": { "special-use": "\\Sent" },
            Trash: { "special-use": "\\Trash" },
          },
        },
      },
    },
  },
});

let app: Awaited<ReturnType<typeof buildApp>>;
let auth: Record<string, string>;
const call = async (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as never, headers: auth });
const sync = async () => {
  const r = await call("POST", "/api/gmail/sync?wait=1", {});
  assert.equal(r.statusCode, 200, r.body);
  return r.json().status;
};
const row = (id: string) => db.prepare("SELECT folder, labels, is_read, is_starred FROM messages WHERE message_id = ?").get(`<${id}@gmail.test>`) as
  { folder: string; labels: string; is_read: number; is_starred: number } | undefined;

before(async () => {
  await new Promise<void>((r) => imap.listen(0, "127.0.0.1", () => r()));
  process.env.GMAIL_IMAP_PORT = String(imap.address().port);
  app = await buildApp();
  setPassword("eerste-wachtwoord");
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "eerste-wachtwoord" } });
  auth = { authorization: "Bearer " + r.json().token };
});
after(async () => {
  await app.close();
  await new Promise((r) => imap.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("verbinding testen: goed en fout app-wachtwoord", async () => {
  let r = await call("POST", "/api/gmail/test", { address: GMAIL, password: APP_PW });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ok, true);
  assert.equal(r.json().allMail, ALL);
  assert.equal(r.json().total, 4);
  assert.ok(r.json().mailboxes >= 3);

  r = await call("POST", "/api/gmail/test", { address: GMAIL, password: "wxyz wxyz wxyz wxyz" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /accepteert dit app-wachtwoord niet/);

  assert.equal((await call("PUT", "/api/gmail", { mode: "naast" })).statusCode, 400, "zonder adres en wachtwoord kan het niet aan");
  assert.equal((await call("PUT", "/api/gmail", { mode: "raar" })).statusCode, 400);
});

test("naast Gmail: eerste ronde haalt alles op met labels, mappen, gelezen en ster", async () => {
  const r = await call("PUT", "/api/gmail", { mode: "naast", address: GMAIL, password: APP_PW });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!r.body.includes("abcdefghijklmnop"), "wachtwoord komt niet terug uit de API");
  assert.equal(r.json().hasPassword, true);

  const st = await sync();
  assert.equal(st.error, null);
  assert.deepEqual(st.initialSync, { done: 4, total: 4 });
  assert.equal(st.counts.imported, 4);
  assert.deepEqual(row("a1"), { folder: "inbox", labels: "[]", is_read: 0, is_starred: 0 });
  assert.deepEqual(row("a2"), { folder: "archive", labels: '["Familie"]', is_read: 1, is_starred: 0 });
  assert.deepEqual(row("a3"), { folder: "inbox", labels: "[]", is_read: 1, is_starred: 1 });
  assert.equal(row("a4")!.folder, "sent");
  const state = JSON.parse(getSetting("gmail_imap_state")!);
  assert.equal(state.lastUid, 4);

  // Gezondheid: Gmail-koppeling in orde
  const h = (await call("GET", "/api/health?fresh=1")).json();
  assert.equal(h.checks.find((c: { id: string }) => c.id === "gmail").status, "ok");
});

test("naast Gmail: nieuwe mail en gewijzigde vlaggen komen in de volgende ronde mee", async () => {
  imap.appendMessage(ALL, [], new Date(), msg("a5", "Net binnen"), null, { "X-GM-LABELS": ["\\Inbox"] });
  // Gelezen gemarkeerd in Gmail (via IMAP, zodat de mod-sequence meetelt)
  const c = new ImapFlow({ host: "127.0.0.1", port: imap.address().port, secure: false, doSTARTTLS: false, auth: { user: GMAIL, pass: "abcdefghijklmnop" }, logger: false } as never);
  await c.connect();
  const lock = await c.getMailboxLock(ALL);
  await c.messageFlagsAdd("1", ["\\Seen"], { uid: true });
  lock.release();
  await c.logout();

  const st = await sync();
  assert.equal(st.error, null);
  assert.equal(st.counts.imported, 5);
  assert.deepEqual(row("a5"), { folder: "inbox", labels: "[]", is_read: 0, is_starred: 0 });
  assert.equal(row("a1")!.is_read, 1, "gelezen in Gmail → gelezen hier");

  // Nog een ronde zonder nieuws: niets dubbel
  await sync();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 5);
});

test("naast Gmail: nieuwe UIDVALIDITY → opnieuw vanaf het begin, zonder dubbele berichten", async () => {
  imap.getMailbox(ALL).uidvalidity = 999;
  imap.appendMessage(ALL, ["\\Seen"], new Date(), msg("a6", "Na hernummering"), null, { "X-GM-LABELS": ["Werk"] });
  const st = await sync();
  assert.equal(st.error, null);
  const state = JSON.parse(getSetting("gmail_imap_state")!);
  assert.equal(state.uidValidity, "999");
  assert.equal(state.lastUid, 6);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 6);
  assert.deepEqual(row("a6"), { folder: "archive", labels: '["Werk"]', is_read: 1, is_starred: 0 });
});

test("naast Gmail: MX blijft bij Google en is in orde, geen MX in de verwachte records", async () => {
  health.net.resolver = {
    resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
    resolveTxt: async () => [],
    resolve4: async () => [],
    reverse: async () => [],
  } as never;
  health.net.tlsDaysLeft = async () => 60;
  const h = (await call("GET", "/api/health?fresh=1")).json();
  const by = (id: string) => h.checks.find((c: { id: string }) => c.id === id);
  assert.equal(by("dns.mx").status, "ok");
  assert.match(by("dns.mx").detail, /nog bij Google binnen.*proefperiode/);
  assert.equal(by("dns.spf").status, "ok");
  assert.match(by("dns.spf").detail, /proefperiode/);

  const recs = health.expectedRecords({ ips4: ["1.2.3.4"], ips6: [] });
  assert.ok(!recs.some((r) => r.type === "MX"), "geen MX publiceren tijdens de proefperiode");
  assert.match(recs.find((r) => r.sub === "" && r.type === "TXT")!.values[0], /include:_spf\.google\.com/);
});

test("versturen via Gmail zet relay en afzender, en terugzetten herstelt de oude", async () => {
  await call("PUT", "/api/settings", { relay: { host: "relay.example", port: 587, user: "u", password: "relay-geheim", secure: false } });
  const before = getSetting("mail_relay");
  assert.equal(getSetting("mail_from"), undefined, "afzender kwam uit de omgeving");

  let r = await call("PUT", "/api/gmail", { sendViaGmail: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(getSetting("mail_relay"), "smtps://rene%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465");
  assert.equal(getSetting("mail_from"), GMAIL);
  assert.equal(health.domain(), "vanes.test", "DNS en controles blijven bij je eigen domein");
  assert.equal((await call("GET", "/api/settings")).json().gmailSend.ownFrom, "rene@vanes.test");
  assert.ok(health.expectedRecords({ ips4: ["1.2.3.4"], ips6: [] }).some((x) => x.sub === "_dmarc" && x.values[0].includes("rene@vanes.test")));

  r = await call("PUT", "/api/gmail", { sendViaGmail: false });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(getSetting("mail_relay"), before);
  assert.equal(getSetting("mail_from"), undefined);
  assert.equal((await call("GET", "/api/settings")).json().mailFrom, "rene@vanes.test");

  // Overstappen naar vangnet zet het ook terug
  await call("PUT", "/api/gmail", { sendViaGmail: true });
  assert.equal(getSetting("mail_from"), GMAIL);
  await call("PUT", "/api/gmail", { mode: "uit" });
  assert.equal(getSetting("mail_relay"), before);
  assert.equal(getSetting("mail_from"), undefined);
  await call("PUT", "/api/gmail", { mode: "naast", sendViaGmail: false });
});

test("Google Agenda volgen: importeren, verwijderde afspraak verdwijnt, ontvolgen ruimt op", async () => {
  const ev = (uid: string, title: string, day: string) => ["BEGIN:VEVENT", `UID:${uid}@google.com`, `DTSTART:202611${day}T090000Z`, `DTEND:202611${day}T100000Z`, `SUMMARY:${title}`, "END:VEVENT"];
  let events = [...ev("g1", "Tandarts", "02"), ...ev("g2", "Verjaardag oma", "05")];
  const srv = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/calendar");
    res.end(["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n"));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/calendar/ical/rene%40gmail.com/private-0123456789abcdef/basic.ics`;
  try {
    assert.equal((await call("PUT", "/api/gmail", { calendars: [{ name: "Werk", url: "https://evil.example/basic.ics" }] })).statusCode, 400);
    assert.equal((await call("PUT", "/api/gmail", { calendars: [{ name: "Werk", url: "http://calendar.google.com/x.ics" }] })).statusCode, 400, "alleen https");
    let r = await call("PUT", "/api/gmail", { calendars: [{ name: "Werk", url }] });
    assert.equal(r.statusCode, 200, r.body);
    const masked = r.json().calendars[0].url;
    assert.ok(!masked.includes("0123456789abcdef"), "geheim deel verborgen");
    assert.match(masked, /private-••••/);

    let st = await sync();
    assert.equal(st.error, null);
    const cal = db.prepare("SELECT id FROM calendars WHERE name = 'Google: Werk'").get() as { id: number };
    assert.ok(cal);
    const titles = () => (db.prepare("SELECT title FROM events WHERE calendar_id = ? ORDER BY start").all(cal.id) as { title: string }[]).map((x) => x.title);
    assert.deepEqual(titles(), ["Tandarts", "Verjaardag oma"]);
    assert.equal(st.counts.calendars, 1);

    // In Google verwijderd → hier ook weg; opnieuw opslaan met het gemaskeerde adres houdt het echte adres
    events = ev("g2", "Verjaardag oma", "05");
    r = await call("PUT", "/api/gmail", { calendars: [{ name: "Werk", url: masked }] });
    assert.equal(r.statusCode, 200, r.body);
    st = await sync();
    assert.equal(st.error, null);
    assert.deepEqual(titles(), ["Verjaardag oma"]);

    // Ontvolgen: de gevolgde agenda verdwijnt, andere agenda's blijven
    await call("PUT", "/api/gmail", { calendars: [] });
    assert.equal(db.prepare("SELECT 1 FROM calendars WHERE name = 'Google: Werk'").get(), undefined);
    assert.ok(db.prepare("SELECT 1 FROM calendars WHERE name = 'Persoonlijk'").get());
  } finally {
    srv.close();
  }
});

test("vangnet: nieuwe mail gaat één keer naar het label 'Eigen Cloud' in Gmail, verzonden mail ook", async () => {
  let r = await call("PUT", "/api/gmail", { mode: "vangnet", copySent: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mode, "vangnet");
  await storeRawMessage(Buffer.from(msg("v1", "Binnen na overstap", "rene@vanes.test")), { folder: "inbox" });
  await storeRawMessage(Buffer.from(msg("v2", "Verstuurd na overstap", "jan@elders.nl")), { folder: "sent", isRead: true });

  let st = await sync();
  assert.equal(st.error, null);
  await sync();
  const box = imap.getMailbox("Eigen Cloud");
  assert.ok(box, "labelmap aangemaakt");
  const subjects = () => box.messages.map((m: { raw: string }) => /Subject: (.*)\r\n/.exec(m.raw)![1]).sort();
  assert.deepEqual(subjects(), ["Binnen na overstap", "Verstuurd na overstap"], "alleen mail van na het aanzetten, en maar één keer");
  assert.ok(box.messages.find((m: { raw: string; flags: string[] }) => m.raw.includes("Verstuurd")).flags.includes("\\Seen"));

  // Na een leiderwissel met verouderde voortgang: niet dubbel
  db.prepare("UPDATE settings SET value = ? WHERE key = 'gmail_vangnet_last'").run(getSetting("gmail_vangnet_start"));
  st = await sync();
  assert.equal(st.error, null);
  assert.equal(box.messages.length, 2);
  assert.equal(st.counts.copied, 2);

  // Zonder 'ook verzonden' gaat alleen ontvangen mail mee
  await call("PUT", "/api/gmail", { copySent: false });
  await storeRawMessage(Buffer.from(msg("v3", "Nog een verstuurd", "jan@elders.nl")), { folder: "sent", isRead: true });
  await storeRawMessage(Buffer.from(msg("v4", "Nog een binnen", "rene@vanes.test")), { folder: "inbox" });
  await sync();
  assert.deepEqual(subjects(), ["Binnen na overstap", "Nog een binnen", "Verstuurd na overstap"]);

  // In vangnet-stand is de MX weer van ons
  assert.ok(health.expectedRecords({ ips4: ["1.2.3.4"], ips6: [] }).some((x) => x.type === "MX"));
});
