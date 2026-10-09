import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { DecryptStream, EncryptStream, decryptBuffer, encryptBuffer } from "./crypto.js";
import { applyEntries, lastSeqTerm, type Entry } from "./changelog.js";
import type { ObjectStore } from "./stores.js";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const pad = (n: number) => String(n).padStart(12, "0");

/**
 * Indeling in de object-opslag (alles versleuteld met sleutels afgeleid van de hoofdsleutel):
 *   db/snapshots/<seq>-<term>-<ts>.snap          volledige database
 *   db/segments/<start>-<end>-<tmin>-<tmax>.seg   wijzigingen (seq start..end)
 *   blobs/<pad>                                    bestanden (mail, bijlagen, foto's)
 *   manifest.enc                                   waar draait wat
 */

export interface SnapshotRef { key: string; seq: number; term: number; ts: number }
export interface SegmentRef { key: string; start: number; end: number; termMin: number; termMax: number }

export async function uploadSegment(stores: ObjectStore[], dbKey: Buffer, entries: Entry[]): Promise<Map<string, Error | null>> {
  const start = entries[0].seq, end = entries[entries.length - 1].seq;
  const terms = entries.map((e) => e.term);
  const key = `db/segments/${pad(start)}-${pad(end)}-${Math.min(...terms)}-${Math.max(...terms)}.seg`;
  const body = await encryptBuffer(dbKey, await gzip(Buffer.from(JSON.stringify(entries))));
  const res = new Map<string, Error | null>();
  await Promise.all(stores.map((s) => s.put(key, body).then(() => res.set(s.name, null), (e: Error) => res.set(s.name, e))));
  return res;
}

/**
 * Snapshot via SQLite's online-backup naar een tijdelijk bestand, daarna gestreamd gecomprimeerd en versleuteld.
 * Geheugengebruik blijft klein, ook bij een database van vele gigabytes.
 */
export async function makeSnapshot(db: Database.Database, dbKey: Buffer, tmpDir = os.tmpdir()) {
  const base = path.join(tmpDir, `snap-${crypto.randomBytes(4).toString("hex")}`);
  await db.backup(base + ".sqlite");
  const copy = new Database(base + ".sqlite", { readonly: true });
  const { seq, term } = lastSeqTerm(copy);
  copy.close();
  const plainSize = fs.statSync(base + ".sqlite").size;
  await pipeline(fs.createReadStream(base + ".sqlite"), zlib.createGzip({ level: 6 }), new EncryptStream(dbKey), fs.createWriteStream(base + ".enc"));
  fs.rmSync(base + ".sqlite", { force: true });
  const file = base + ".enc";
  return {
    key: `db/snapshots/${pad(seq)}-${term}-${Date.now()}.snap`, file, size: fs.statSync(file).size, seq, term, plainSize,
    open: () => fs.createReadStream(file),
    cleanup: () => fs.rmSync(file, { force: true }),
  };
}

export async function listChain(store: ObjectStore) {
  const snapshots: SnapshotRef[] = [];
  const segments: SegmentRef[] = [];
  for (const o of await store.list("db/")) {
    let m = /^db\/snapshots\/(\d+)-(\d+)-(\d+)\.snap$/.exec(o.key);
    if (m) { snapshots.push({ key: o.key, seq: +m[1], term: +m[2], ts: +m[3] }); continue; }
    m = /^db\/segments\/(\d+)-(\d+)-(\d+)-(\d+)\.seg$/.exec(o.key);
    if (m) segments.push({ key: o.key, start: +m[1], end: +m[2], termMin: +m[3], termMax: +m[4] });
  }
  snapshots.sort((a, b) => b.seq - a.seq || b.ts - a.ts);
  segments.sort((a, b) => a.start - b.start);
  return { snapshots, segments };
}

/** Hoogste seq die een opslag zeker aaneengesloten heeft (voor hervatten van uploads door een nieuwe leider). */
export async function storedUpTo(store: ObjectStore): Promise<number> {
  const { snapshots, segments } = await listChain(store);
  return Math.max(0, ...segments.map((s) => s.end), ...snapshots.map((s) => s.seq));
}

async function readSegment(store: ObjectStore, dbKey: Buffer, key: string): Promise<Entry[]> {
  const buf = await store.getBuffer(key);
  if (!buf) throw new Error(`Segment ${key} ontbreekt`);
  return JSON.parse((await gunzip(await decryptBuffer(dbKey, buf))).toString("utf8"));
}

export interface RestoreResult { seq: number; term: number; snapshot: string; snapshotSeq: number; applied: number; lastTs: number | null }

/**
 * Herstelt de database uit één opslag naar `dest`.
 * Kiest de nieuwste geldige snapshot (≤ until) en past daarna de geldige wijzigingen toe.
 *
 * Geldigheid volgt de Raft-regel: een entry (seq s, term t) is ongeldig als er een entry met een hogere term
 * bestaat op een seq ≤ s. Zo worden niet-gerepliceerde schrijfacties van een afgezette leider genegeerd.
 */
export async function restoreFromStore(store: ObjectStore, dbKey: Buffer, dest: string, opts: { until?: number } = {}): Promise<RestoreResult | null> {
  const until = opts.until ?? Infinity;
  const { snapshots, segments } = await listChain(store);
  const candidates = snapshots.filter((s) => s.ts <= until);
  if (!candidates.length) return null;

  const loaded = new Map<string, Entry[]>();
  const load = async (seg: SegmentRef) => {
    if (!loaded.has(seg.key)) loaded.set(seg.key, await readSegment(store, dbKey, seg.key));
    return loaded.get(seg.key)!;
  };

  for (const snap of candidates) {
    // Prefix-maximum van termen tot en met snap.seq
    let baseMax = 0;
    const later: Entry[] = [];
    for (const seg of segments) {
      if (seg.end <= snap.seq) baseMax = Math.max(baseMax, seg.termMax);
      else {
        for (const e of await load(seg)) {
          if (e.seq <= snap.seq) baseMax = Math.max(baseMax, e.term);
          else later.push(e);
        }
      }
    }
    if (baseMax > snap.term) continue; // snapshot bevat staat van een afgezette leider

    // Geldige keten na de snapshot
    later.sort((a, b) => a.seq - b.seq || b.term - a.term);
    const valid: Entry[] = [];
    let prefixMax = baseMax;
    // eerst prefix-max per seq bepalen over álle entries (ook ongeldige), dan filteren
    const maxAt = new Map<number, number>();
    for (const e of later) { prefixMax = Math.max(prefixMax, e.term); maxAt.set(e.seq, prefixMax); }
    let expect = snap.seq + 1;
    for (const e of later) {
      if (e.seq < expect) continue; // duplicaat (bijv. overlappende segmenten)
      if (e.seq > expect) break; // gat
      if (e.term !== maxAt.get(e.seq)) continue; // verouderde entry; een andere met dezelfde seq volgt mogelijk
      if (e.ts > until) break;
      valid.push(e);
      expect++;
    }

    const snapStream = await store.get(snap.key);
    if (!snapStream) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dest + suffix, { force: true });
    await pipeline(snapStream, new DecryptStream(dbKey), zlib.createGunzip(), fs.createWriteStream(dest));

    const db = new Database(dest);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("recursive_triggers = ON");
      let seq = snap.seq;
      if (valid.length) {
        const r = applyEntries(db, snap.seq, snap.term, valid);
        if (r < 0) throw new Error("Herstel: wijzigingen sluiten niet aan op snapshot");
        seq = r;
      }
      db.prepare("UPDATE _repl_meta SET lease_until = 0, applying = 0 WHERE id = 1").run();
      db.prepare("DELETE FROM blob_queue").run();
      const check = db.pragma("integrity_check", { simple: true });
      if (check !== "ok") throw new Error("Integriteitscontrole mislukt: " + check);
      return { seq, term: lastSeqTerm(db).term, snapshot: snap.key, snapshotSeq: snap.seq, applied: valid.length, lastTs: valid.at(-1)?.ts ?? snap.ts };
    } finally {
      db.close();
    }
  }
  return null;
}

/** Probeert opslagplaatsen op volgorde (meest recente eerst) tot herstel lukt. */
export async function restoreFromAny(stores: ObjectStore[], dbKey: Buffer, dest: string, opts: { until?: number } = {}) {
  const results: { store: ObjectStore; upTo: number }[] = [];
  for (const s of stores) results.push({ store: s, upTo: await storedUpTo(s).catch(() => -1) });
  results.sort((a, b) => b.upTo - a.upTo);
  const errors: string[] = [];
  for (const { store, upTo } of results) {
    if (upTo < 0) { errors.push(`${store.name}: onbereikbaar`); continue; }
    try {
      const r = await restoreFromStore(store, dbKey, dest, opts);
      if (r) return { ...r, store: store.name };
    } catch (e) {
      errors.push(`${store.name}: ${(e as Error).message}`);
    }
  }
  if (errors.length) console.warn("Herstel: " + errors.join("; "));
  return null;
}

/** Opruimen in replica-opslag: oude snapshots en segmenten; back-upopslag wordt nooit opgeruimd. */
export async function prune(store: ObjectStore, retentionDays: number) {
  if (store.purpose !== "replica") return { deleted: 0 };
  const { snapshots, segments } = await listChain(store);
  const cutoff = Date.now() - retentionDays * 864e5;
  // Bewaar de nieuwste snapshot altijd, plus alle snapshots binnen de bewaartermijn.
  const keep = snapshots.filter((s, i) => i === 0 || s.ts >= cutoff);
  const drop = snapshots.filter((s) => !keep.includes(s));
  const oldestKept = Math.min(...keep.map((s) => s.seq));
  const dropSeg = segments.filter((s) => s.end <= oldestKept);
  for (const o of [...drop, ...dropSeg]) await store.delete(o.key);
  return { deleted: drop.length + dropSeg.length };
}
