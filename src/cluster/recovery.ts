import crypto from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import { DecryptStream } from "./crypto.js";
import type { ObjectStore } from "./stores.js";

export interface BlobProof { total: number; checked: number; bytes: number; missing: number; damaged: number; failures: string[] }

/** Verify every reference from the restored database, including staging and queued outgoing mail. */
export async function verifyRestoredBlobs(db: Database.Database, store: ObjectStore, key: Buffer): Promise<BlobProof> {
  const proof: BlobProof = { total: 0, checked: 0, bytes: 0, missing: 0, damaged: 0, failures: [] };
  const seen = new Set<string>();
  const rows = db.prepare(`SELECT raw_path AS p, size, NULL AS hash, 0 AS thumbnail FROM messages WHERE raw_path IS NOT NULL
    UNION ALL SELECT path, size, NULL, 0 FROM attachments
    UNION ALL SELECT path, size, sha256, 0 FROM photos
    UNION ALL SELECT thumb_path, NULL, NULL, 1 FROM photos WHERE thumb_path IS NOT NULL
    UNION ALL SELECT raw_path, NULL, NULL, 0 FROM mail_outbox
    UNION ALL SELECT path, size, sha256, 0 FROM import_chunks`).iterate() as Iterable<{ p: string; size: number | null; hash: string | null; thumbnail: number }>;
  for (const r of rows) {
    if (seen.has(r.p)) continue;
    seen.add(r.p); proof.total++;
    if (!r.p || r.p.startsWith("/") || r.p.split(/[\\/]/).includes("..")) {
      proof.damaged++; if (proof.failures.length < 20) proof.failures.push("Ongeldig bestandspad"); continue;
    }
    try {
      const stream = await store.get(`blobs/${r.p}`);
      if (!stream) { proof.missing++; if (proof.failures.length < 20) proof.failures.push(`Ontbreekt: ${r.p}`); continue; }
      const hash = crypto.createHash("sha256"); let bytes = 0;
      await pipeline(stream, new DecryptStream(key), new Writable({ write(chunk: Buffer, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(); } }));
      const expected = r.hash ?? (!r.thumbnail ? /([0-9a-f]{64})(?:\.[a-z0-9]+)?$/.exec(r.p)?.[1] : null);
      if ((r.size !== null && bytes !== r.size) || (expected && hash.digest("hex") !== expected)) throw new Error("Inhoud of grootte klopt niet");
      proof.checked++; proof.bytes += bytes;
    } catch {
      proof.damaged++; if (proof.failures.length < 20) proof.failures.push(`Beschadigd: ${r.p}`);
    }
  }
  return proof;
}
