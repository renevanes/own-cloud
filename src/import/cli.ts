/**
 * Importeren vanuit Google Takeout.
 *
 *   npm run import -- gmail  "/pad/naar/Takeout/Mail/All mail Including Spam and Trash.mbox"
 *   npm run import -- agenda "/pad/naar/Takeout/Calendar"        (map met .ics-bestanden, of één .ics)
 *   npm run import -- fotos  "/pad/naar/Takeout/Google Photos"   (uitgepakte map)
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { importIcs } from "../calendar/ics.js";
import { importGmailMbox } from "./gmail.js";
import { importTakeoutPhotos } from "./photos.js";

const [kind, target] = process.argv.slice(2);
if (!kind || !target || !fs.existsSync(target)) {
  console.error("Gebruik: npm run import -- <gmail|agenda|fotos> <pad>");
  process.exit(1);
}

const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;

switch (kind) {
  case "gmail":
  case "mail": {
    console.log(`📥 Gmail importeren uit ${target} …`);
    const s = await importGmailMbox(target, (p) => process.stdout.write(`\r  ${p.done} berichten (${p.added} nieuw, ${p.skipped} dubbel, ${p.failed} fout) — ${elapsed()}`));
    console.log(`\n✅ Klaar: ${s.added} nieuw, ${s.skipped} al aanwezig, ${s.failed} mislukt (${elapsed()})`);
    break;
  }
  case "agenda":
  case "calendar": {
    const files = fs.statSync(target).isDirectory()
      ? fs.readdirSync(target).filter((f) => f.toLowerCase().endsWith(".ics")).map((f) => path.join(target, f))
      : [target];
    for (const file of files) {
      const name = path.basename(file, ".ics").replace(/@.*$/, "");
      let cal = db.prepare("SELECT id FROM calendars WHERE name = ?").get(name) as { id: number } | undefined;
      if (!cal) cal = { id: Number(db.prepare("INSERT INTO calendars (name, color) VALUES (?, ?)").run(name, "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")).lastInsertRowid) };
      const r = importIcs(fs.readFileSync(file, "utf8"), cal.id);
      console.log(`📅 ${name}: ${r.added} nieuw, ${r.updated} bijgewerkt, ${r.skipped} overgeslagen`);
    }
    break;
  }
  case "fotos":
  case "photos": {
    console.log(`🖼️  Foto's importeren uit ${target} …`);
    const s = await importTakeoutPhotos(target, (p) => process.stdout.write(`\r  ${p.done} bestanden (${p.added} nieuw, ${p.duplicates} dubbel, ${p.failed} fout) — ${elapsed()}`));
    console.log(`\n✅ Klaar: ${s.added} nieuw, ${s.duplicates} dubbel, ${s.failed} mislukt, ${s.withMetadata} met Google-metadata (${elapsed()})`);
    break;
  }
  default:
    console.error(`Onbekend type: ${kind}`);
    process.exit(1);
}
