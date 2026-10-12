import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-recovery-"));
process.env.DATA_DIR = path.join(tmp, "data");
const { db } = await import("../src/db.js");
const { installReplication, setLease, setTerm, entriesAfter, lastSeq } = await import("../src/cluster/changelog.js");
const { makeSnapshot, restoreFromAny, restoreFromStore, storedUpTo, chainHealth, uploadSegment } = await import("../src/cluster/backup.js");
const { makeStore } = await import("../src/cluster/stores.js");
const { encryptBuffer } = await import("../src/cluster/crypto.js");
const { verifyRestoredBlobs } = await import("../src/cluster/recovery.js");
const { ClusterService } = await import("../src/cluster/service.js");
const key = crypto.randomBytes(32);
db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"); installReplication(db); setTerm(db, 1); setLease(db, Date.now() + 120_000);
const store = (name: string) => makeStore({ name, type: "fs", purpose: "replica", dir: path.join(tmp, name) });
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("production rejects missing, blank, short and development session secrets", () => {
  for (const secret of [undefined, "", " ".repeat(40), "short", "verander-mij-dev" + "x".repeat(40)]) {
    const env = { ...process.env, NODE_ENV: "production" }; delete env.SESSION_SECRET; if (secret !== undefined) env.SESSION_SECRET = secret;
    const r = spawnSync(process.execPath, ["--import", "tsx", "-e", "import('./src/config.ts')"], { env, encoding: "utf8" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /SESSION_SECRET/);
  }
});

test("a missing middle segment cannot outrank a newer complete store; corrupt snapshots fall back safely", async () => {
  const broken = store("broken"), intact = store("intact");
  db.prepare("INSERT INTO notes VALUES (1,'one')").run();
  const first = await makeSnapshot(db, key, tmp); await broken.put(first.key, first.open(), first.size); first.cleanup();
  db.prepare("INSERT INTO notes VALUES (2,'two')").run();
  const second = await makeSnapshot(db, key, tmp); await intact.put(second.key, second.open(), second.size); second.cleanup();
  const completeSeq = lastSeq(db);
  db.prepare("INSERT INTO notes VALUES (3,'three')").run(); await uploadSegment([broken], key, entriesAfter(db, completeSeq));
  assert.equal(await storedUpTo(broken), first.seq); assert.equal((await chainHealth(broken)).gap, true);
  const dest = path.join(tmp, "best.sqlite"), result = await restoreFromAny([broken, intact], key, dest);
  assert.equal(result?.store, "intact"); assert.equal(result?.seq, completeSeq);
  const copy = new Database(dest, { readonly: true }); assert.equal(copy.prepare("SELECT COUNT(*) FROM notes").pluck().get(), 2); copy.close();
  const bad = await makeSnapshot(db, key, tmp), encrypted = fs.readFileSync(bad.file); encrypted[encrypted.length - 1] ^= 1;
  await broken.put(bad.key, encrypted); bad.cleanup();
  assert.equal((await restoreFromStore(broken, key, path.join(tmp, "fallback.sqlite")))?.seq, first.seq);
});

test("restore evidence checks every referenced blob and reports missing data beyond a ten-file sample", async () => {
  const blobs = store("proof"), blobKey = crypto.randomBytes(32);
  for (let i = 0; i < 12; i++) {
    const raw = Buffer.from(`mail ${i}`), sha = crypto.createHash("sha256").update(raw).digest("hex"), rel = `mail/raw/${sha}.eml`;
    db.prepare("INSERT INTO messages(message_id,thread_key,folder,labels,to_addrs,cc_addrs,subject,date,raw_path,size,user_id) VALUES (?,?,'inbox','[]','[]','[]','test',1,?,?,1)").run(`proof-${i}`, `proof-${i}`, rel, raw.length);
    if (i < 11) await blobs.put(`blobs/${rel}`, await encryptBuffer(blobKey, raw));
  }
  const proof = await verifyRestoredBlobs(db, blobs, blobKey); assert.equal(proof.total, 12); assert.equal(proof.checked, 11); assert.equal(proof.missing, 1); assert.equal(proof.damaged, 0);
});

test("a witness vote needs a durable data copy; reachable object storage can replace the standby", async () => {
  const svc = new ClusterService({ cluster: "test", nodeId: "leader", kind: "data", masterKey: key.toString("hex"), stores: [], advertise: { clusterUrl: "http://localhost:1", apiUrl: "http://localhost:2" } } as any, path.join(tmp, "config.json"), process.env.DATA_DIR!);
  svc.db = db;
  svc.raft = { isLeader: () => true, members: [{ id: "leader", kind: "data" }, { id: "standby", kind: "data", clusterUrl: "http://127.0.0.1:1" }, { id: "witness", kind: "witness" }], waitDurable: async () => false } as any;
  assert.equal(await svc.waitDurable(30), false);
  svc.stores = [store("acknowledged")];
  assert.equal(await svc.waitDurable(2000), true);
  const restored = await restoreFromAny(svc.stores, svc.keys.db!, path.join(tmp, "acknowledged.sqlite"));
  assert.ok(restored && restored.seq >= lastSeq(db) - 1);
  db.prepare("INSERT INTO blob_queue(rel,added) VALUES ('photos/missing.jpg',?)").run(Date.now());
  svc.raft.waitDurable = async () => true; assert.equal(await svc.waitDurable(30), false);
  svc.raft.isLeader = () => false; assert.equal(await svc.waitDurable(30), false);
});
