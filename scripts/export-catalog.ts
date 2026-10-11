/**
 * Exporteert de aanbiederscatalogus uit de registry (src/cluster/adapters.ts) naar de Android-app, zodat die
 * gegevens maar op één plek bijgehouden worden. Gebruik: npx tsx scripts/export-catalog.ts [uitvoerbestand]
 *
 * Vorm (alles pure data, geen functies of geheimen):
 *   version  2
 *   stores   StoreOffer[]  {id, name, owner, home, regions:[{id,label,country,endpoint}], customEndpoint?, help, signupUrl}
 *   servers  ServerOffer[] {id, name, owner, home, regions:[{id,label,country,city}], fields:[Field], signupUrl, keyHelp}
 *   dns      DnsOffer[]    {id, name, owner, home, fields:[Field], keyHelp, signupUrl, sharesKeyWith?}
 *   adapters [{id, name, owner, home, signupUrl, keyHelp, fields, capabilities:{servers, storage, dns, quick}, quick?}]
 * Field = {key, label, secret?, help?, optional?, placeholder?}. De testaanbieder "local" staat er niet in.
 */
import fs from "node:fs";
import path from "node:path";
import { adapters } from "../src/cluster/adapters.js";
import { storeOffers, serverOffers, dnsOffers } from "../src/console/catalog.js";

export function catalogJson() {
  return {
    version: 2,
    stores: storeOffers(),
    servers: serverOffers(),
    dns: dnsOffers(),
    adapters: adapters().filter((a) => !a.testOnly).map((a) => ({
      id: a.id, name: a.name, owner: a.owner, home: a.home, signupUrl: a.signupUrl, keyHelp: a.keyHelp, fields: a.fields,
      capabilities: { servers: !!a.servers, storage: !!a.storage, dns: !!a.dns, quick: !!a.quick },
      ...(a.quick ? { quick: a.quick } : {}),
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root = path.resolve(import.meta.dirname, "..");
  const out = path.resolve(process.argv[2] ?? path.join(root, "android/app/src/main/assets/catalog.json"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(catalogJson(), null, 2) + "\n");
  console.log(`Catalogus geschreven naar ${path.relative(process.cwd(), out)}`);
}
