import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";

/**
 * Bestanden (mail, bijlagen, foto's, thumbnails) worden relatief t.o.v. DATA_DIR opgeslagen,
 * zodat dezelfde database op elke server werkt. Oude absolute paden blijven werken.
 */
export function relData(abs: string) {
  return path.relative(config.dataDir, abs).split(path.sep).join("/");
}
export function absData(p: string) {
  return path.isAbsolute(p) ? p : path.join(config.dataDir, p);
}

let queueExists: boolean | undefined;
/** Meldt een nieuw bestand aan voor upload naar de object-opslag (alleen in clustermodus). */
export function blobWritten(rel: string) {
  if (queueExists === undefined)
    queueExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blob_queue'").get();
  if (queueExists) db.prepare("INSERT OR IGNORE INTO blob_queue (rel, added) VALUES (?, ?)").run(rel, Date.now());
}

/** Haalt een ontbrekend bestand op (bij een replica of na herstel). Wordt door het cluster ingevuld. */
export const blobFetcher: { fetch?: (rel: string) => Promise<boolean> } = {};

export async function ensureLocal(p: string): Promise<string | null> {
  const abs = absData(p);
  if (fs.existsSync(abs)) return abs;
  if (blobFetcher.fetch && !path.isAbsolute(p) && (await blobFetcher.fetch(p).catch(() => false)) && fs.existsSync(abs)) return abs;
  return null;
}
