import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { db } from "../db.js";
import { importIcs } from "../calendar/ics.js";
import { importGmailMbox } from "./gmail.js";
import { importTakeoutPhotos } from "./photos.js";
import { isMediaFile } from "../photos/store.js";

export interface ImportProgress {
  phase: "uitpakken" | "mail" | "agenda" | "foto's" | "klaar";
  file?: string;
  mail: { done: number; added: number; skipped: number; failed: number };
  calendar: { calendars: number; added: number; updated: number };
  photos: { done: number; added: number; duplicates: number; failed: number };
  log: string[];
}

export function newProgress(): ImportProgress {
  return { phase: "uitpakken", mail: { done: 0, added: 0, skipped: 0, failed: 0 }, calendar: { calendars: 0, added: 0, updated: 0 }, photos: { done: 0, added: 0, duplicates: 0, failed: 0 }, log: [] };
}

export function importCalendarText(name: string, text: string) {
  const clean = name.replace(/\.ics$/i, "").replace(/@.*$/, "") || "Geïmporteerd";
  let cal = db.prepare("SELECT id FROM calendars WHERE name = ?").get(clean) as { id: number } | undefined;
  if (!cal) {
    const colors = ["#3f6f4a", "#2f6f8f", "#8a5a9e", "#c2810c", "#b3392f", "#4f7d7a"];
    const color = colors[(db.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number }).n % colors.length];
    cal = { id: Number(db.prepare("INSERT INTO calendars (name, color) VALUES (?, ?)").run(clean, color).lastInsertRowid) };
  }
  return { name: clean, ...importIcs(text, cal.id) };
}

/** Herkent Takeout-paden in alle talen die Google gebruikt voor Foto's. */
const PHOTOS_ROOT = /(^|\/)(Google Photos|Google Foto's|Google Fotos|Google Foto|Google Photos?)\//i;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (e, z) => (e ? rej(e) : res(z!))));
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))));
}

/**
 * Verwerkt Takeout-zips (en losse .mbox/.ics-bestanden).
 * Mail en agenda worden direct geïmporteerd; foto's worden eerst uit álle zips verzameld,
 * omdat Google een foto en zijn metadata soms over verschillende zips verdeelt.
 */
export async function processTakeout(files: { path: string; name: string }[], workDir: string, p: ImportProgress, onUpdate: () => void) {
  const staging = path.join(workDir, `staging-${Date.now()}`);
  const photosDir = path.join(staging, "photos");
  fs.mkdirSync(photosDir, { recursive: true });
  const log = (m: string) => { p.log.push(m); if (p.log.length > 200) p.log.shift(); onUpdate(); };

  const importMbox = async (file: string, label: string) => {
    p.phase = "mail"; p.file = label; onUpdate();
    const before = { ...p.mail };
    const s = await importGmailMbox(file, (x) => { Object.assign(p.mail, { done: before.done + x.done, added: before.added + x.added, skipped: before.skipped + x.skipped, failed: before.failed + x.failed }); onUpdate(); });
    Object.assign(p.mail, { done: before.done + s.done, added: before.added + s.added, skipped: before.skipped + s.skipped, failed: before.failed + s.failed });
    log(`Mail uit ${label}: ${s.added} nieuw, ${s.skipped} stonden er al`);
  };
  const importIcsText = (name: string, text: string) => {
    p.phase = "agenda"; p.file = name;
    const r = importCalendarText(path.basename(name), text);
    p.calendar.calendars++;
    p.calendar.added += r.added;
    p.calendar.updated += r.updated;
    log(`Agenda '${r.name}': ${r.added} nieuw, ${r.updated} bijgewerkt`);
  };

  try {
    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith(".mbox")) { await importMbox(f.path, f.name); continue; }
      if (lower.endsWith(".ics")) { importIcsText(f.name, fs.readFileSync(f.path, "utf8")); continue; }
      if (!lower.endsWith(".zip")) { log(`${f.name} overgeslagen: geen zip, mbox of ics`); continue; }

      p.phase = "uitpakken"; p.file = f.name; onUpdate();
      const zip = await openZip(f.path);
      let photoFiles = 0;
      await new Promise<void>((resolve, reject) => {
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", async (entry: yauzl.Entry) => {
          try {
            const name = entry.fileName.replace(/\\/g, "/");
            if (name.endsWith("/") || name.includes("..")) return zip.readEntry();
            const lowerName = name.toLowerCase();
            if (lowerName.endsWith(".mbox")) {
              const tmp = path.join(staging, `mail-${Date.now()}.mbox`);
              await pipeline(await entryStream(zip, entry), fs.createWriteStream(tmp));
              await importMbox(tmp, path.basename(name));
              fs.rmSync(tmp, { force: true });
            } else if (lowerName.endsWith(".ics")) {
              const chunks: Buffer[] = [];
              for await (const c of await entryStream(zip, entry)) chunks.push(c as Buffer);
              importIcsText(path.basename(name), Buffer.concat(chunks).toString("utf8"));
            } else {
              const m = PHOTOS_ROOT.exec(name);
              if (m && (isMediaFile(name) || lowerName.endsWith(".json"))) {
                const rel = name.slice(m.index + m[0].length);
                const dest = path.join(photosDir, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                await pipeline(await entryStream(zip, entry), fs.createWriteStream(dest));
                const mt = entry.getLastModDate?.();
                if (mt) fs.utimesSync(dest, mt, mt);
                if (isMediaFile(name)) photoFiles++;
              }
            }
            zip.readEntry();
          } catch (e) {
            reject(e);
          }
        });
        zip.readEntry();
      });
      if (photoFiles) log(`${photoFiles} foto's/video's uit ${f.name} klaargezet`);
    }

    if (fs.readdirSync(photosDir).length) {
      p.phase = "foto's"; p.file = undefined; onUpdate();
      const s = await importTakeoutPhotos(photosDir, (x) => { Object.assign(p.photos, x); onUpdate(); });
      Object.assign(p.photos, s);
      log(`Foto's: ${s.added} nieuw, ${s.duplicates} stonden er al${s.failed ? `, ${s.failed} mislukt` : ""}`);
    }
    p.phase = "klaar"; p.file = undefined;
    onUpdate();
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
