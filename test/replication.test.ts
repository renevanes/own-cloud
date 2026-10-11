import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { decryptBuffer, encryptBuffer, encryptedSize, CHUNK, randomKeyHex, parseKey, deriveKey } from "../src/cluster/crypto.js";
import { installReplication, applyEntries, entriesAfter, lastSeqTerm, setLease, setTerm, ensureSequence, ConflictError } from "../src/cluster/changelog.js";
import { FsStore } from "../src/cluster/stores.js";
import { makeSnapshot, uploadSegment, restoreFromStore } from "../src/cluster/backup.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repl-"));
const key = deriveKey(parseKey(randomKeyHex()), "db");

function mkdb(name: string) {
  const db = new Database(path.join(tmp, name + ".sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
    CREATE TABLE IF NOT EXISTS tags (note_id INTEGER, tag TEXT, PRIMARY KEY (note_id, tag));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  installReplication(db);
  return db;
}
const leaderOf = (db: Database.Database, term: number) => { setTerm(db, term); ensureSequence(db, lastSeqTerm(db).seq); setLease(db, Date.now() + 60_000); };

test("versleuteling: stroom heen en terug, afkappen en knoeien worden gedetecteerd", async () => {
  const k = parseKey(randomKeyHex());
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
    const plain = Buffer.alloc(size, 7);
    const enc = await encryptBuffer(k, plain);
    assert.equal(enc.length, encryptedSize(size), `grootte ${size}`);
    assert.deepEqual(await decryptBuffer(k, enc), plain);
  }
  const enc = await encryptBuffer(k, Buffer.alloc(2 * CHUNK + 5, 1));
  await assert.rejects(decryptBuffer(k, enc.subarray(0, enc.length - 30)), /afgekapt|beschadigd|unable|auth/i);
  const bad = Buffer.from(enc); bad[100] ^= 1;
  await assert.rejects(decryptBuffer(k, bad));
  // Laatste blok weglaten (afkappen op blokgrens) moet ook falen
  await assert.rejects(decryptBuffer(k, enc.subarray(0, 12 + CHUNK + 20)), /afgekapt/);
});

test("fencing: zonder geldige lease kan niemand schrijven (ook geen ander proces)", () => {
  const db = mkdb("fence");
  assert.throws(() => db.prepare("INSERT INTO notes (title) VALUES ('x')").run(), /NOT_LEADER/);
  setLease(db, Date.now() + 5000);
  db.prepare("INSERT INTO notes (title) VALUES ('x')").run();
  const other = new Database(path.join(tmp, "fence.sqlite")); // ander proces/verbinding
  other.prepare("INSERT INTO notes (title) VALUES ('y')").run();
  setLease(db, Date.now() - 1000);
  assert.throws(() => other.prepare("INSERT INTO notes (title) VALUES ('z')").run(), /NOT_LEADER/);
  other.close();
});

test("replicatie: insert/update/delete, samengestelde sleutel, idempotent, conflict-detectie", () => {
  const a = mkdb("a"), b = mkdb("b");
  leaderOf(a, 1);
  a.prepare("INSERT INTO notes (id, title, body) VALUES (1, 'een', 'x')").run();
  a.prepare("INSERT INTO tags VALUES (1, 'werk')").run();
  a.prepare("UPDATE notes SET title = 'één' WHERE id = 1").run();
  a.prepare("INSERT INTO notes (id, title) VALUES (2, 'twee')").run();
  a.prepare("DELETE FROM notes WHERE id = 2").run();
  const e = entriesAfter(a, 0);
  assert.equal(e.length, 5);
  assert.equal(applyEntries(b, 0, 0, e), 5);
  assert.equal(applyEntries(b, 0, 0, e), 5); // nogmaals = geen effect
  assert.deepEqual(b.prepare("SELECT * FROM notes").all(), [{ id: 1, title: "één", body: "x" }]);
  assert.deepEqual(b.prepare("SELECT * FROM tags").all(), [{ note_id: 1, tag: "werk" }]);
  assert.deepEqual(lastSeqTerm(b), { seq: 5, term: 1 });
  // Volger kan niet zelf schrijven
  assert.throws(() => b.prepare("INSERT INTO notes (title) VALUES ('stiekem')").run(), /NOT_LEADER/);

  // b wordt leider in term 2 en schrijft door; a schreef ondertussen (afgezet) nog iets in term 1
  leaderOf(b, 2);
  b.prepare("INSERT INTO notes (id, title) VALUES (10, 'nieuw')").run();
  a.prepare("INSERT INTO notes (id, title) VALUES (11, 'wees')").run();
  const fromB = entriesAfter(b, 5);
  setLease(a, 0);
  assert.throws(() => applyEntries(a, 5, 1, fromB), ConflictError);
});

test("back-up: snapshot + segmenten, herstel naar tijdstip, verweesde entries van afgezette leider genegeerd", async () => {
  const store = new FsStore({ name: "s", type: "fs", purpose: "replica", dir: path.join(tmp, "store") });
  const a = mkdb("pa");
  leaderOf(a, 1);
  a.prepare("INSERT INTO notes (id, title) VALUES (1, 'voor snapshot')").run();
  const snap = await makeSnapshot(a, key, tmp);
  await store.put(snap.key, snap.open(), snap.size);
  snap.cleanup();
  a.prepare("INSERT INTO notes (id, title) VALUES (2, 'na snapshot')").run();
  await new Promise((r) => setTimeout(r, 30));
  const tMid = Date.now();
  await new Promise((r) => setTimeout(r, 30));
  a.prepare("INSERT INTO notes (id, title) VALUES (3, 'later')").run();
  await uploadSegment([store], key, entriesAfter(a, snap.seq));

  // Afgezette leider (term 1) uploadt nog seq 4 'wees'; nieuwe leider (term 2) schrijft óók seq 4 en 5.
  const b = mkdb("pb");
  applyEntries(b, 0, 0, entriesAfter(a, 0));
  a.prepare("INSERT INTO notes (id, title) VALUES (4, 'wees')").run();
  await uploadSegment([store], key, entriesAfter(a, 3));
  leaderOf(b, 2);
  b.prepare("INSERT INTO notes (id, title) VALUES (5, 'nieuwe leider')").run();
  b.prepare("UPDATE notes SET title = 'bijgewerkt' WHERE id = 1").run();
  await uploadSegment([store], key, entriesAfter(b, 3));

  const out = path.join(tmp, "restored.sqlite");
  const r = await restoreFromStore(store, key, out);
  assert.ok(r);
  const rdb = new Database(out, { readonly: true });
  assert.deepEqual(rdb.prepare("SELECT id, title FROM notes ORDER BY id").all(), [
    { id: 1, title: "bijgewerkt" }, { id: 2, title: "na snapshot" }, { id: 3, title: "later" }, { id: 5, title: "nieuwe leider" },
  ]);
  rdb.close();

  const r2 = await restoreFromStore(store, key, out, { until: tMid });
  assert.ok(r2);
  const pit = new Database(out, { readonly: true });
  assert.deepEqual(pit.prepare("SELECT id FROM notes ORDER BY id").all(), [{ id: 1 }, { id: 2 }]);
  pit.close();

  // Niets in de opslag is leesbaar zonder sleutel
  for (const f of await store.list("")) assert.ok(!fs.readFileSync(path.join(tmp, "store", f.key)).includes("snapshot"), f.key);
});

// ───────── Meerdere gebruikers: gemengde versies tijdens een rollende update ─────────

const { migrateUserSchema } = await import("../src/userSchema.js");
const OLD_SCHEMA = fs.readFileSync(path.join(import.meta.dirname, "helpers/schema-1.6.sql"), "utf8");
function cloudDb(name: string, version: "oud" | "nieuw") {
  const db = new Database(path.join(tmp, name + ".sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(OLD_SCHEMA);
  if (version === "nieuw") migrateUserSchema(db);
  installReplication(db);
  return db;
}
const msg = (id: number, extra = "") =>
  `INSERT INTO messages (id, message_id, thread_key, folder, subject, date${extra ? ", user_id" : ""}) VALUES (${id}, '<m${id}@x>', 't', 'inbox', 'bericht ${id}', 1${extra ? ", " + extra : ""})`;

test("rollende update: wijzigingen tussen oude en nieuwe versie (kolom user_id) gaan beide kanten op goed", () => {
  // Nieuwe leider, oude volger: de onbekende kolom user_id wordt genegeerd, niets loopt vast.
  const nieuw = cloudDb("mu-nieuw", "nieuw"), oud = cloudDb("mu-oud", "oud");
  leaderOf(nieuw, 1);
  nieuw.prepare(msg(1)).run();
  nieuw.prepare("INSERT INTO calendars (id, name) VALUES (1, 'Persoonlijk')").run();
  nieuw.prepare("INSERT INTO events (id, uid, calendar_id, title, start, end, updated) VALUES (1, 'u1', 1, 'Tandarts', 1, 2, 1)").run();
  nieuw.prepare("INSERT INTO photos (id, sha256, filename, taken_at, path, added) VALUES (1, 'aa', 'a.jpg', 1, 'p/a.jpg', 1)").run();
  const e = entriesAfter(nieuw, 0);
  assert.ok(JSON.parse(e[0].data).user_id === 1, "nieuwe versie stuurt user_id mee");
  assert.equal(applyEntries(oud, 0, 0, e), e.length);
  assert.equal(oud.prepare("SELECT subject FROM messages WHERE id = 1").pluck().get(), "bericht 1");
  assert.equal(oud.prepare("SELECT title FROM events WHERE id = 1").pluck().get(), "Tandarts");

  // Oude leider (na leiderwissel terug), nieuwe volger: zonder user_id → standaard 1 (de eigenaar).
  leaderOf(oud, 2);
  oud.prepare(msg(2)).run();
  oud.prepare("INSERT INTO photos (id, sha256, filename, taken_at, path, added) VALUES (2, 'bb', 'b.jpg', 1, 'p/b.jpg', 1)").run();
  setLease(nieuw, 0);
  assert.equal(applyEntries(nieuw, e.length, 1, entriesAfter(oud, e.length)), e.length + 2);
  assert.deepEqual(nieuw.prepare("SELECT id, user_id FROM messages ORDER BY id").all(), [{ id: 1, user_id: 1 }, { id: 2, user_id: 1 }]);
  assert.equal(nieuw.prepare("SELECT user_id FROM photos WHERE id = 2").pluck().get(), 1);
});

test("rollende update: een oude server weigert de onbekende tabel users zonder iets half toe te passen (daarom wacht toevoegen)", () => {
  const nieuw = cloudDb("mu2-nieuw", "nieuw"), oud = cloudDb("mu2-oud", "oud");
  leaderOf(nieuw, 1);
  nieuw.prepare(msg(1)).run();
  nieuw.prepare("INSERT INTO users (id, localpart, name, status, created, updated) VALUES (2, 'anna', 'Anna', 'active', 1, 1)").run();
  nieuw.prepare(msg(2, "2")).run();
  const e = entriesAfter(nieuw, 0);
  assert.throws(() => applyEntries(oud, 0, 0, e), /Onbekende tabel users/);
  assert.equal(lastSeqTerm(oud).seq, 0, "niets toegepast: de transactie is teruggedraaid");
  assert.equal(oud.prepare("SELECT COUNT(*) FROM messages").pluck().get(), 0);
  // Na het bijwerken (schema migreren) lukt hetzelfde wel, met de juiste eigenaar per bericht
  migrateUserSchema(oud);
  installReplication(oud);
  assert.equal(applyEntries(oud, 0, 0, e), e.length);
  assert.deepEqual(oud.prepare("SELECT id, user_id FROM messages ORDER BY id").all(), [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }]);
  assert.equal(oud.prepare("SELECT localpart FROM users WHERE id = 2").pluck().get(), "anna");
});

test("herstel: snapshot van de oude versie + nieuwere wijzigingen met gebruikers", async () => {
  const store = new FsStore({ name: "mu", type: "fs", purpose: "replica", dir: path.join(tmp, "store-mu") });
  const oud = cloudDb("mu3-oud", "oud");
  leaderOf(oud, 1);
  oud.prepare(msg(1)).run();
  oud.prepare("INSERT INTO calendars (id, name) VALUES (1, 'Persoonlijk')").run();
  oud.prepare("INSERT INTO events (id, uid, calendar_id, title, start, end, updated) VALUES (1, 'gedeeld', 1, 'Van de eigenaar', 1, 2, 1)").run();
  const snap = await makeSnapshot(oud, key, tmp);
  await store.put(snap.key, snap.open(), snap.size);
  snap.cleanup();
  // Daarna bijgewerkt naar de nieuwe versie (zelfde database), gebruiker erbij met eigen gegevens
  migrateUserSchema(oud);
  installReplication(oud);
  leaderOf(oud, 2);
  oud.prepare("INSERT INTO users (id, localpart, name, status, created, updated) VALUES (2, 'anna', 'Anna', 'active', 1, 1)").run();
  oud.prepare(msg(2, "2")).run();
  oud.prepare("INSERT INTO events (id, uid, calendar_id, title, start, end, updated, user_id) VALUES (2, 'gedeeld', 1, 'Van Anna', 1, 2, 1, 2)").run();
  oud.prepare("INSERT INTO messages (id, message_id, thread_key, folder, subject, date, user_id) VALUES (3, '<m1@x>', 't', 'inbox', 'zelfde bericht bij Anna', 1, 2)").run();
  await uploadSegment([store], key, entriesAfter(oud, snap.seq));

  const out = path.join(tmp, "mu-restored.sqlite");
  const r = await restoreFromStore(store, key, out);
  assert.ok(r);
  const rdb = new Database(out, { readonly: true });
  assert.deepEqual(rdb.prepare("SELECT id, user_id FROM messages ORDER BY id").all(), [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }, { id: 3, user_id: 2 }]);
  assert.deepEqual(rdb.prepare("SELECT title, user_id FROM events ORDER BY id").all(), [{ title: "Van de eigenaar", user_id: 1 }, { title: "Van Anna", user_id: 2 }]);
  assert.equal(rdb.prepare("SELECT name FROM users WHERE id = 2").pluck().get(), "Anna");
  rdb.close();
});
