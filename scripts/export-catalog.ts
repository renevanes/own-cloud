/**
 * Exporteert de aanbiederscatalogus (STORE_OFFERS / SERVER_OFFERS) naar de Android-app, zodat die gegevens
 * maar op één plek bijgehouden worden. Gebruik: npx tsx scripts/export-catalog.ts [uitvoerbestand]
 */
import fs from "node:fs";
import path from "node:path";
import { STORE_OFFERS, SERVER_OFFERS } from "../src/console/catalog.js";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "android/app/src/main/assets/catalog.json"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ stores: STORE_OFFERS, servers: SERVER_OFFERS }, null, 2) + "\n");
console.log(`Catalogus geschreven naar ${path.relative(process.cwd(), out)}`);
