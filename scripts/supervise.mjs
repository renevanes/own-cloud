// Kleine procesbewaker (zoals Docker's restart-policy): herstart de node bij exitcode 75 (herstel nodig) of een crash.
//   node scripts/supervise.mjs src/main.ts
//
// Met EIGEN_LOCAL_UPDATER=1 speelt hij ook de updater van een echte server na (zie updaterScript in
// src/cluster/cloudinit.ts): een verzoek in DATA_DIR/update-request.json → herstarten met de nieuwe versie,
// controleren of hij gezond terugkomt, anders terug naar de vorige versie. Voor de tests: een versie met
// "kapot" erin start nooit goed op.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [entry] = process.argv.slice(2);
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; child?.kill(sig); });

let child;
let restarts = 0;
let swapping = false;
let version = process.env.EIGEN_VERSION ?? "";

function run() {
  const broken = /kapot/.test(version) || (!!process.env.EIGEN_BROKEN_VERSION && version === process.env.EIGEN_BROKEN_VERSION);
  const args = broken ? ["-e", "setTimeout(() => process.exit(1), 200)"] : ["--import", "tsx", entry];
  child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, EIGEN_VERSION: version } });
  child.on("exit", (code, signal) => {
    if (stopping || signal === "SIGKILL") process.exit(code ?? 0);
    if (swapping) { swapping = false; setTimeout(run, 100); return; }
    restarts++;
    const delay = code === 75 ? 200 : Math.min(broken ? 1000 : 30000, 1000 * restarts);
    console.log(`[supervise] node stopte (code ${code}, signaal ${signal}); herstart over ${delay} ms`);
    setTimeout(run, delay);
  });
}
run();

if (process.env.EIGEN_LOCAL_UPDATER === "1" && process.env.DATA_DIR) {
  const dir = process.env.DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "updater.json"), '{"v":1,"local":true}');
  const reqFile = path.join(dir, "update-request.json"), resFile = path.join(dir, "update-result.json");
  const healthMs = Number(process.env.EIGEN_UPDATE_HEALTH_MS ?? 20000);
  let busy = false;
  const restartWith = (v) => { version = v; restarts = 0; swapping = true; child.kill("SIGTERM"); };
  const healthy = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.CLUSTER_PORT}/cluster/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok && (await r.json()).version === version;
    } catch { return false; }
  };
  const write = (o) => { fs.writeFileSync(resFile + ".tmp", JSON.stringify({ ...o, at: Date.now() })); fs.renameSync(resFile + ".tmp", resFile); };
  setInterval(async () => {
    if (busy || !fs.existsSync(reqFile)) return;
    let req;
    try { req = JSON.parse(fs.readFileSync(reqFile, "utf8")); } catch { return; }
    let done = null;
    try { done = JSON.parse(fs.readFileSync(resFile, "utf8")); } catch { /* nog geen uitkomst */ }
    if (!req.id || done?.id === req.id) return;
    busy = true;
    const previous = version;
    console.log(`[updater] bijwerken naar ${req.version}`);
    restartWith(req.version);
    const end = Date.now() + healthMs;
    let ok = false;
    while (Date.now() < end) { if (await healthy()) { ok = true; break; } await new Promise((r) => setTimeout(r, 500)); }
    if (!ok) {
      console.log(`[updater] ${req.version} kwam niet gezond op; terug naar ${previous}`);
      restartWith(previous);
      write({ id: req.id, version: req.version, ok: false, rolledBack: true, saved: false, error: "nieuwe versie kwam niet gezond op; vorige versie teruggezet" });
    } else {
      let saved = false;
      if (req.saveApp?.startsWith("file://")) { fs.writeFileSync(req.saveApp.slice(7), `eigen-cloud ${req.version}`); saved = true; }
      write({ id: req.id, version: req.version, ok: true, rolledBack: false, saved, error: null });
    }
    busy = false;
  }, 500);
}
