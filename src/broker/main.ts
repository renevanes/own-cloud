/** Start de Eigen Cloud Dienst: npm run dienst (of node dist/broker/main.js). Zie BROKER.md. */
import { loadConfig, missingSettings } from "./config.js";
import { createBroker } from "./app.js";

const cfg = loadConfig();
const missing = missingSettings(cfg);
if (missing.length) console.warn(`[dienst] Nog niet ingesteld: ${missing.join(", ")}. Zie BROKER.md.`);
const broker = await createBroker(cfg);
await broker.app.listen({ port: cfg.port, host: cfg.host });
broker.startLoops();
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
