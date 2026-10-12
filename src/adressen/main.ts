/** Start de centrale adressendienst: npm run adressen (of node dist/adressen/main.js). Zie ADRESSEN.md. */
import fs from "node:fs";
import { loadAdresConfig, missingAdresSettings } from "./config.js";
import { createAdressen } from "./app.js";

const cfg = loadAdresConfig();
const missing = missingAdresSettings(cfg);
if (missing.length) {
  console.error(`[adressen] Nog niet ingesteld: ${missing.join(", ")}. Zie ADRESSEN.md.`);
  process.exit(1);
}
// Op de server van een Dienst: eerst wachten tot de Dienst zijn back-up (ook adressen.sqlite) heeft teruggezet.
if (cfg.waitFor) {
  let said = false;
  while (!fs.existsSync(cfg.waitFor)) {
    if (!said) { console.log(`[adressen] wachten op ${cfg.waitFor} (de Dienst zet eerst de back-up terug)…`); said = true; }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const svc = await createAdressen(cfg);
await svc.app.listen({ port: cfg.port, host: cfg.host });
console.log(`[adressen] adressendienst voor ${cfg.zone} luistert op ${cfg.host}:${cfg.port} (${cfg.publicUrl}); gegevens in ${cfg.dataDir}`);
svc.ctx.desec.getZone(cfg.zone)
  .then((z) => { if (!z) console.warn(`[adressen] Let op: zone ${cfg.zone} bestaat niet in het deSEC-account van ADRES_DESEC_TOKEN`); })
  .catch((e) => console.warn(`[adressen] deSEC nu niet bereikbaar: ${(e as Error).message}`));
svc.ctx.providers.refresh()
  .then((m) => console.log(`[adressen] ${m.size} aanbieder(s) op de lijst (${cfg.listUrl})`))
  .catch((e) => console.warn(`[adressen] lijst van aanbieders nu niet op te halen: ${(e as Error).message}`));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log("[adressen] stoppen…");
  await svc.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
