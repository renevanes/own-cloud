/**
 * Hulpdienst voor android/core/test.sh (GitHubTest): de nep-GitHub en twee echte Diensten uit
 * test/helpers/lijst-scenario.ts, zodat de Java-kern hetzelfde "Op de lijst"-scenario doorloopt als
 * test/github-lijst.test.ts, plus de nep-deSEC voor de zonelimiet. Schrijft {github, raw, control, tokens, vanes, esape,
 * desec} naar het opgegeven bestand.
 *   POST <control>/publiceer?dienst=vanes → de voorbeeldvoorwaarden van die Dienst publiceren (versie 1)
 */
import fs from "node:fs";
import http from "node:http";
import { startLijstScenario, TOKENS } from "../test/helpers/lijst-scenario.js";
import { saveDoc, voorbeeld } from "../src/broker/juridisch.js";
import { fakeDesecLimiet } from "../test/helpers/fake-desec-limiet.js";

const out = process.argv[2];
const s = await startLijstScenario();
const desec = fakeDesecLimiet();
const desecUrl = await desec.listening;
const control = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && u.pathname === "/publiceer") {
    const d = u.searchParams.get("dienst") === "esape" ? s.esape : s.vanes;
    saveDoc(d.broker.ctx, null, "voorwaarden", { body: voorbeeld(d.broker.ctx, "voorwaarden") });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise<void>((r) => control.listen(0, "127.0.0.1", () => r()));
const pick = (d: typeof s.vanes) => ({ url: d.url, reach: d.reach, secret: d.secret, publicKey: d.publicKey });
fs.writeFileSync(out, JSON.stringify({
  github: s.gh.base, raw: `${s.gh.base}/raw/aanbieders.json`, control: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
  tokens: TOKENS, vanes: pick(s.vanes), esape: pick(s.esape), desec: desecUrl,
}));
const stop = async () => { control.close(); await desec.close(); await s.close(); process.exit(0); };
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
