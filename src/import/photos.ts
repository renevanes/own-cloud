import fs from "node:fs";
import path from "node:path";
import { addPhotoFromFile, isMediaFile, type PhotoMeta } from "../photos/store.js";

interface TakeoutJson {
  title?: string;
  description?: string;
  photoTakenTime?: { timestamp?: string };
  geoData?: { latitude?: number; longitude?: number };
  geoDataExif?: { latitude?: number; longitude?: number };
  favorited?: boolean;
}

/** Mappen die Google zelf aanmaakt per jaar — geen echt album. */
const YEAR_FOLDER = /^(photos from|foto's van|fotos van|photos de|fotos von) \d{4}$/i;
const SKIP_FOLDER = /^(trash|prullenbak|archive|archief|bin)$/i;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * Zoekt het JSON-metadatabestand dat Google Takeout naast een foto zet.
 * Takeout gebruikt wisselende namen: foto.jpg.json, foto.jpg.supplemental-metadata.json,
 * afgekapte namen (max ~51 tekens), en "foto(1).jpg" ↔ "foto.jpg(1).json".
 */
export function findSidecar(media: string, jsonsInDir: string[]): string | undefined {
  const name = path.basename(media);
  const candidates = [name];
  const dup = /^(.*)\((\d+)\)(\.[^.]+)$/.exec(name);
  if (dup) candidates.push(`${dup[1]}${dup[3]}(${dup[2]})`);
  const edited = name.replace(/-(edited|bewerkt|bearbeitet|modifié)(?=\.[^.]+$)/i, "");
  if (edited !== name) candidates.push(edited);

  for (const c of candidates) {
    const exact = jsonsInDir.find((j) => j === c + ".json" || j.startsWith(c + ".supplemental") || j.startsWith(c + ".suppl"));
    if (exact) return exact;
    // Afgekapte naam: JSON-naam (zonder .json) is een prefix van "naam.supplemental-metadata"
    const long = c + ".supplemental-metadata";
    const trunc = jsonsInDir.find((j) => {
      const stem = j.replace(/(\(\d+\))?\.json$/, "");
      return stem.length >= 30 && long.startsWith(stem);
    });
    if (trunc) return trunc;
    // Zonder extensie (foto.json)
    const noExt = jsonsInDir.find((j) => j === c.replace(/\.[^.]+$/, "") + ".json");
    if (noExt) return noExt;
  }
  return undefined;
}

type PhotoImportStats = { done: number; added: number; duplicates: number; failed: number; withMetadata: number };

export async function importTakeoutPhotos(root: string, onProgress?: (s: PhotoImportStats) => void, userId = 1, cancelled = () => false) {
  const stats: PhotoImportStats = { done: 0, added: 0, duplicates: 0, failed: 0, withMetadata: 0 };
  const jsonCache = new Map<string, string[]>();

  for (const file of walk(root)) {
    if (cancelled()) throw new Error("IMPORT_CANCELLED");
    if (!isMediaFile(file)) continue;
    const dir = path.dirname(file);
    const folder = path.basename(dir);
    if (SKIP_FOLDER.test(folder)) continue;
    if (!jsonCache.has(dir)) jsonCache.set(dir, fs.readdirSync(dir).filter((f) => f.endsWith(".json")));

    const meta: PhotoMeta = { filename: path.basename(file) };
    const sidecar = findSidecar(file, jsonCache.get(dir)!);
    if (sidecar) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, sidecar), "utf8")) as TakeoutJson;
        const ts = Number(j.photoTakenTime?.timestamp);
        if (ts > 0) meta.takenAt = ts * 1000;
        const geo = j.geoData?.latitude ? j.geoData : j.geoDataExif;
        if (geo?.latitude && geo?.longitude) { meta.lat = geo.latitude; meta.lon = geo.longitude; }
        if (j.description) meta.description = j.description;
        if (j.favorited) meta.favorite = true;
        stats.withMetadata++;
      } catch { /* kapotte JSON negeren */ }
    }
    if (!YEAR_FOLDER.test(folder) && folder !== path.basename(root) && !/^(google (photos|foto's)|takeout)$/i.test(folder)) meta.albums = [folder];

    try {
      const r = await addPhotoFromFile(file, meta, { userId });
      r.duplicate ? stats.duplicates++ : stats.added++;
    } catch {
      stats.failed++;
    }
    stats.done++;
    if (onProgress && stats.done % 100 === 0) onProgress(stats);
  }
  return stats;
}
