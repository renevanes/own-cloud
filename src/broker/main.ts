/** Start de Eigen Cloud Dienst: npm run dienst (of node dist/broker/main.js). Zie BROKER.md. */
import { loadConfig, loadEnvFile, missingSettings } from "./config.js";
import { createBroker } from "./app.js";
import { restoreIfEmpty } from "./backup.js";

loadEnvFile();
// Nieuwe server met een lege datamap (bijv. na "Opnieuw opzetten"): eerst de nieuwste back-up terugzetten.
try {
  const r = await restoreIfEmpty(process.env);
  if (r) console.log(`[dienst] back-up van ${new Date(r.at).toISOString()} teruggezet (${r.name})`);
} catch (e) {
  console.error(`[dienst] back-up terugzetten mislukt: ${(e as Error).message}`);
  process.exit(1);
}
const cfg = loadConfig();
const missing = missingSettings(cfg);
if (missing.length) console.warn(`[dienst] Nog niet ingesteld: ${missing.join(", ")}. Zie BROKER.md.`);
const broker = await createBroker(cfg);
await broker.app.listen({ port: cfg.port, host: cfg.host });
broker.startLoops();
console.log(`[dienst] sleutel van deze aanbieder (voor "sleutel" in aanbieders.json): ${cfg.providerPublicKey}`);
if (cfg.adresUrl) console.log(`[dienst] gratis adressen via de adressendienst ${cfg.adresUrl} (wij zijn daar: ${cfg.publicUrl})`);
console.log(`[dienst] Eigen Cloud Dienst luistert op ${cfg.host}:${cfg.port} (${cfg.publicUrl}); gegevens in ${cfg.dataDir}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log("[dienst] stoppen…");
  await broker.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
