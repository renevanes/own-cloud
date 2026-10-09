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
