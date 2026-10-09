/**
 * Start één echte cluster-node (data, leider) voor de Java-tests van de Android-kern (ClusterRpcTest).
 * Gebruik: npx tsx scripts/android-cluster-node.ts <info.json>
 * Schrijft {clusterUrl, masterKey, config, pid, base} naar info.json zodra de node leider is, en blijft
 * draaien tot SIGTERM/SIGINT; ruimt dan alle node-processen en de tijdelijke map op.
 */
process.env.CLUSTER_FAST = "1";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFirstNode, waitFor, killAll, type Harness } from "../test/helpers/cluster.js";
import { rpc } from "../src/cluster/transport.js";
import { keysFor } from "../src/cluster/config.js";

const info = path.resolve(process.argv[2] ?? "cluster-info.json");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "eigen-android-"));
let h: Harness | null = null;

function cleanup(code: number) {
  if (h) killAll(h);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGTERM", () => cleanup(0));
process.on("SIGINT", () => cleanup(0));

try {
  h = await startFirstNode(base, { minDataNodes: 1, witnesses: 0, autoHeal: false });
  const url = h.cfg.advertise.clusterUrl;
  const key = keysFor(h.cfg).cluster;
  await waitFor("cluster/health", async () => (await fetch(`${url}/cluster/health`, { signal: AbortSignal.timeout(2000) })).ok, 120_000, 500);
  await waitFor("leider", async () => (await rpc<{ role: string }>(key, url, { type: "status" }, 2000)).role === "leader", 120_000, 500);
  fs.writeFileSync(info, JSON.stringify({ clusterUrl: url, masterKey: h.cfg.masterKey, config: h.cfg, pid: h.first.pid, base }));
  console.log(`  cluster-node: leider op ${url} (pid ${h.first.pid})`);
} catch (e) {
  console.error(`  cluster-node: starten mislukt: ${(e as Error).message}`);
  const log = path.join(base, "first", "node.log");
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, "utf8").split("\n").slice(-30).join("\n"));
  cleanup(1);
}
setInterval(() => {}, 1 << 30);
