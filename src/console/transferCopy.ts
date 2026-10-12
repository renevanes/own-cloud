import crypto from "node:crypto";
import type { ObjectStore } from "../cluster/stores.js";

export interface CopyProgress { objects: number; bytes: number; done: number; doneBytes: number; skipped: number; verified: number }
const skip = (key: string) => key.startsWith("bootstrap/") || key.startsWith("test/");
async function hash(store: ObjectStore, key: string) {
  const stream = await store.get(key); if (!stream) return null;
  const digest = crypto.createHash("sha256"); for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}
/** Content checks cover copied and skipped encrypted objects; file-size equality alone is insufficient. */
export async function copyStores(from: ObjectStore[], to: ObjectStore[], onProgress: (p: CopyProgress) => void = () => {}) {
  if (!from.length || !to.length) throw new Error("Kies een bron en doel voor je gegevens");
  const p: CopyProgress = { objects: 0, bytes: 0, done: 0, doneBytes: 0, skipped: 0, verified: 0 };
  for (const target of to) {
    const source = from.find((s) => s.purpose === target.purpose) ?? from.find((s) => s.purpose === "replica") ?? from[0];
    const objects = (await source.list("")).filter((o) => !skip(o.key));
    const existing = new Map((await target.list("")).map((o) => [o.key, o.size]));
    p.objects += objects.length; p.bytes += objects.reduce((n, o) => n + o.size, 0); onProgress({ ...p });
    const queue = [...objects];
    const worker = async () => {
      for (let object = queue.shift(); object; object = queue.shift()) {
        const expected = await hash(source, object.key);
        if (!expected) throw new Error(`Bronbestand ontbreekt: ${object.key}`);
        const fixed = /^(db|blobs)\//.test(object.key);
        if (fixed && existing.get(object.key) === object.size && await hash(target, object.key) === expected) p.skipped++;
        else {
          const body = await source.get(object.key); if (!body) throw new Error(`Bronbestand ontbreekt: ${object.key}`);
          await target.put(object.key, body, object.size);
          const actual = await hash(target, object.key);
          if (!actual) throw new Error(`1 bestand ontbreekt in ${target.name} na het kopiëren (bijv. ${object.key})`);
          if (actual !== expected) throw new Error(`Bestand beschadigd in ${target.name} na het kopiëren: ${object.key}`);
        }
        p.done++; p.doneBytes += object.size; p.verified++; onProgress({ ...p });
      }
    };
    // Await every worker even on failure so retries cannot overlap a still-running copy.
    const results = await Promise.allSettled([worker(), worker()]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return p;
}
