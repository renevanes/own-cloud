/**
 * Startpunt. Drie modi:
 *  1. Losse server (geen cluster.json): zoals voorheen.
 *  2. Nieuwe cloudserver (BOOTSTRAP_URL + JOIN_TOKEN): haalt versleutelde configuratie op, herstelt data, sluit aan.
 *  3. Clusternode (cluster.json aanwezig): data-node of witness.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "./data");
process.env.DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

async function bootstrap(cfgFile: string) {
  const { fetchUrl } = await import("./cluster/stores.js");
  const { deriveKey, openJson } = await import("./cluster/crypto.js");
  const { writeClusterConfig } = await import("./cluster/config.js");
  const url = process.env.BOOTSTRAP_URL!;
  const token = process.env.JOIN_TOKEN!;
  console.log("🌱 Nieuwe node: configuratie ophalen…");
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const buf = await fetchUrl(url).catch(() => null);
    if (buf) {
      const cfg = openJson<import("./cluster/config.js").ClusterConfig>(deriveKey(Buffer.from(token, "hex"), "bootstrap"), buf, "bootstrap");
      writeClusterConfig(cfgFile, cfg);
      return;
    }
    if (Date.now() > deadline) throw new Error("Configuratie niet binnen een uur beschikbaar");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function restoreIfNeeded(cfg: import("./cluster/config.js").ClusterConfig) {
  const dbFile = path.join(DATA_DIR, "eigen-cloud.sqlite");
  const marker = path.join(DATA_DIR, "restore-pending");
  if (fs.existsSync(marker)) {
    // Oude database bewaren (kan niet-gerepliceerde wijzigingen van een afgezette leider bevatten).
    const dir = path.join(DATA_DIR, "orphans", String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, path.join(dir, path.basename(dbFile) + suffix));
    fs.copyFileSync(marker, path.join(dir, "reden.json"));
    console.warn(`📦 Oude database bewaard in ${dir}`);
  }
  if (fs.existsSync(dbFile)) { fs.rmSync(marker, { force: true }); return; }

  const { makeStore } = await import("./cluster/stores.js");
  const { restoreFromAny } = await import("./cluster/backup.js");
  const { keysFor } = await import("./cluster/config.js");
  const stores = cfg.stores.map(makeStore);
  const keys = keysFor(cfg);
  for (let attempt = 1; ; attempt++) {
    const r = await restoreFromAny(stores, keys.db!, dbFile).catch((e) => { console.error("Herstel mislukt:", e.message); return null; });
    if (r) {
      console.log(`♻️  Hersteld uit ${r.store}: snapshot ${r.snapshot} + ${r.applied} wijzigingen → seq ${r.seq}`);
      break;
    }
    if (cfg.bootstrapLeader) { console.log("Geen back-up gevonden: nieuw, leeg cluster."); break; }
    if (attempt % 10 === 1) console.log("Wachten op een snapshot in de opslag…");
    await new Promise((res) => setTimeout(res, 3000));
  }
  fs.rmSync(marker, { force: true });
}

async function main() {
  if (process.env.NODE_ID && !process.env.CLUSTER_CONFIG) delete process.env.CLUSTER_CONFIG;
  const cfgFile = process.env.CLUSTER_CONFIG || path.join(DATA_DIR, "cluster.json");
  if (!fs.existsSync(cfgFile) && process.env.BOOTSTRAP_URL) await bootstrap(cfgFile);

  if (!fs.existsSync(cfgFile)) {
    // ── Losse server ──
    const { config } = await import("./config.js");
    const { buildApp } = await import("./server.js");
    const { startSmtpServer } = await import("./mail/smtp.js");
    const app = await buildApp();
    await app.listen({ port: config.httpPort, host: "0.0.0.0" });
    console.log(`🌐 Web/API op http://localhost:${config.httpPort}`);
    if (process.env.DISABLE_SMTP !== "1") startSmtpServer();
    return;
  }

  const { loadClusterConfig, keysFor } = await import("./cluster/config.js");
  const { deriveKey } = await import("./cluster/crypto.js");
  const cfg = loadClusterConfig(cfgFile);
  const keys = keysFor(cfg);
  if (keys.master) {
    process.env.SESSION_SECRET ||= deriveKey(keys.master, "session").toString("hex");
    process.env.ICAL_TOKEN ||= deriveKey(keys.master, "ical").toString("hex").slice(0, 32);
  }
  for (const [k, v] of Object.entries(cfg.appEnv)) process.env[k] ??= v;

  const { ClusterService } = await import("./cluster/service.js");
  if (cfg.kind === "witness") {
    const svc = new ClusterService(cfg, cfgFile, DATA_DIR);
    await svc.start();
    console.log(`👁️  Witness ${cfg.nodeId} actief op poort ${process.env.CLUSTER_PORT ?? cfg.clusterPort}`);
    return;
  }

  await restoreIfNeeded(cfg);
  const svc = new ClusterService(cfg, cfgFile, DATA_DIR);
  await svc.start();
  const { setClusterService } = await import("./cluster/routes.js");
  setClusterService(svc);
  const { blobFetcher } = await import("./blobs.js");
  blobFetcher.fetch = (rel) => svc.fetchBlob(rel);

  const { config } = await import("./config.js");
  const { buildApp } = await import("./server.js");
  const { startSmtpServer } = await import("./mail/smtp.js");
  const app = await buildApp();
  await app.listen({ port: config.httpPort, host: "0.0.0.0" });
  if (process.env.DISABLE_SMTP !== "1") startSmtpServer();
  console.log(`🐌 Data-node ${cfg.nodeId}: web ${config.httpPort}, mail ${config.smtpPort}, cluster ${process.env.CLUSTER_PORT ?? cfg.clusterPort}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
