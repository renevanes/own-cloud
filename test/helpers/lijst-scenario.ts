/**
 * Vaste opzet voor "Op de lijst" via GitHub, zowel voor test/github-lijst.test.ts als (via scripts/android-github.ts)
 * voor de Java-test GitHubTest: een nep-GitHub met de echte aanbieders.json uit de repository en twee echte Diensten,
 * "Van Es" (nog niet op de lijst) en "ESAPE" (op de lijst als standaard, met de adressendienst op dezelfde server).
 * De Diensten lezen de openbare lijst van de nep-GitHub (EIGEN_AANBIEDERS_URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/broker/config.js";
import { createBroker, type Broker } from "../../src/broker/app.js";
import { updateBrand } from "../../src/broker/brand.js";
import { freePort } from "./cluster.js";
import { fakeGithub, type FakeUser } from "./fake-github.js";

export const TOKENS = {
  rene: "ghp_rene00000000000000000000000000000000",
  ander: "ghp_ander0000000000000000000000000000000",
  zonder: "ghp_zonder000000000000000000000000000000",
  oauthloos: "ghp_oauthloos00000000000000000000000000",
  onbekend: "ghp_onbekend000000000000000000000000000",
  fijn: "github_pat_11AAAAAAA0000000000000_000000000000000000000000000000000000000000",
};
const USERS: Record<string, FakeUser> = {
  [TOKENS.rene]: { login: "renevanes", scopes: "public_repo, workflow" },
  [TOKENS.ander]: { login: "vanes-diensten", scopes: "public_repo" },
  [TOKENS.zonder]: { login: "iemand", scopes: "gist, read:user" },
  [TOKENS.oauthloos]: { login: "app", scopes: null },
};

export async function startLijstScenario() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const initial = fs.readFileSync(path.resolve(here, "../../aanbieders.json"), "utf8");
  const gh = fakeGithub(initial, USERS);
  await gh.listening;
  process.env.EIGEN_AANBIEDERS_URL = `${gh.base}/raw/aanbieders.json`;
  const brokers: Broker[] = [];
  const dirs: string[] = [];
  const dienst = async (url: string, secret: string, env: Record<string, string>, brand: Record<string, unknown>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lijst-dienst-"));
    dirs.push(dir);
    const port = await freePort();
    const b = await createBroker(loadConfig({ BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: url, BROKER_SECRET: secret, BROKER_LOOP_MS: "600000", ...env }));
    await b.app.listen({ port, host: "127.0.0.1" });
    updateBrand(b.ctx, brand);
    brokers.push(b);
    return { url, secret, reach: `http://127.0.0.1:${port}`, publicKey: b.ctx.cfg.providerPublicKey, broker: b };
  };
  const vanes = await dienst("https://dienst.vanes.test", "33".repeat(32), { BROKER_BRAND_NAME: "Van Es" }, { contact: { email: "hallo@vanes.test" } });
  const esape = await dienst("https://dienst.esape.nl", "44".repeat(32), { BROKER_BRAND_NAME: "ESAPE", BROKER_ADRES_PUBLIEK: "https://adressen.esape.nl" }, { contact: { email: "support@esape.nl" } });
  return {
    gh, vanes, esape,
    async close() {
      for (const b of brokers) await b.close().catch(() => {});
      await gh.close();
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}
