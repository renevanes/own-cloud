/**
 * Het updatescript dat cloud-init op elke server zet (updaterScript in src/cluster/cloudinit.ts), met een nep-docker
 * en nep-curl: bijwerken, weigeren van vreemde images, terugzetten als de nieuwe versie niet gezond opkomt,
 * kopie in je eigen opslag, en een verzoek maar één keer uitvoeren.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { updaterScript } from "../src/cluster/cloudinit.js";

const d = (c: string) => "sha256:" + c.repeat(64);
const OLD = `ghcr.io/rene/eigen-cloud@${d("1")}`, NEW = `ghcr.io/rene/eigen-cloud@${d("2")}`;
const OLDC = `ghcr.io/rene/eigen-caddy@${d("3")}`, NEWC = `ghcr.io/rene/eigen-caddy@${d("4")}`;

function setup(opts: { broken?: boolean; pullFail?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "updater-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "update-allowed"), "ghcr.io/rene/\n");
  fs.writeFileSync(path.join(root, "docker-compose.yml"), `services:\n  app:\n    image: ${OLD}  # eigen-app\n    restart: unless-stopped\n  caddy:\n    image: ${OLDC}  # eigen-caddy\n`);
  fs.writeFileSync(path.join(root, "version"), "1.0.0.1");
  const log = path.join(root, "calls.log");
  // Nep-docker: "compose up" start de versie die in docker-compose.yml staat.
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/bash
echo "docker $*" >> "${log}"
case "$1" in
  pull) ${opts.pullFail ? "exit 1" : "exit 0"} ;;
  compose) if grep -q '${d("2")}' "${root}/docker-compose.yml"; then echo ${opts.broken ? "kapot" : "1.0.0.2"} > "${root}/version"; else echo 1.0.0.1 > "${root}/version"; fi ;;
  save) echo "IMAGE-$2" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
echo "curl $*" >> "${log}"
for a in "$@"; do case "$a" in *cluster/health) printf '{"ok":true,"version":"%s"}' "$(cat "${root}/version")"; exit 0 ;; *healthz) exit 0 ;; esac; done
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "eigen-update.sh"), updaterScript(), { mode: 0o755 });
  const run = () => spawnSync("bash", [path.join(root, "eigen-update.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EIGEN_ROOT: root, CLUSTER_PORT: "7946", EIGEN_UPDATE_HEALTH_SECONDS: "9" }, encoding: "utf8" });
  const request = (o: Record<string, unknown>) => fs.writeFileSync(path.join(root, "data", "update-request.json"), JSON.stringify(o));
  const result = () => JSON.parse(fs.readFileSync(path.join(root, "data", "update-result.json"), "utf8"));
  const compose = () => fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  return { root, run, request, result, compose, calls };
}

test("updater: bijwerken naar een vaste versie, met kopie in de eigen opslag", () => {
  const u = setup();
  u.request({ id: "r1", app: NEW, caddy: NEWC, version: "1.0.0.2", saveApp: "https://opslag.test/app?sig=1", saveCaddy: "https://opslag.test/caddy?sig=2" });
  const r = u.run();
  assert.equal(r.status, 0, r.stderr);
  const res = u.result();
  assert.deepEqual([res.id, res.ok, res.rolledBack, res.saved, res.version], ["r1", true, false, true, "1.0.0.2"]);
  assert.match(u.compose(), new RegExp(`image: ${NEW.replace(/[.]/g, "\\.")}  # eigen-app`));
  assert.match(u.compose(), new RegExp(`image: ${NEWC.replace(/[.]/g, "\\.")}  # eigen-caddy`));
  assert.match(u.calls(), /docker pull -q ghcr\.io\/rene\/eigen-cloud@sha256:2+/);
  assert.match(u.calls(), /docker tag .* eigen-cloud:1\.0\.0\.2/);
  assert.match(u.calls(), /curl -fsS -X PUT -T .*app\.tgz https:\/\/opslag\.test\/app\?sig=1/);
  assert.match(u.calls(), /docker image prune -f/);
  // Hetzelfde verzoek nog eens: niets doen.
  fs.writeFileSync(path.join(u.root, "calls.log"), "");
  u.run();
  assert.equal(u.calls(), "", "een verzoek wordt maar één keer uitgevoerd");
});

test("updater: vreemde images en losse tags worden geweigerd", () => {
  const u = setup();
  u.request({ id: "r2", app: `docker.io/kwaad/image@${d("2")}`, caddy: NEWC, version: "6.6.6" });
  u.run();
  assert.match(u.result().error, /niet toegestaan/);
  u.request({ id: "r3", app: "ghcr.io/rene/eigen-cloud:latest", caddy: NEWC, version: "1.0.0.2" });
  u.run();
  assert.match(u.result().error, /niet toegestaan/, "alleen vaste versies (@sha256)");
  assert.match(u.compose(), new RegExp(OLD.replace(/[.]/g, "\\.")), "niets veranderd");
  assert.doesNotMatch(u.calls(), /docker pull/);
});

test("updater: nieuwe versie komt niet gezond op → vorige versie terug", () => {
  const u = setup({ broken: true });
  u.request({ id: "r4", app: NEW, caddy: NEWC, version: "1.0.0.2" });
  u.run();
  const res = u.result();
  assert.deepEqual([res.ok, res.rolledBack], [false, true]);
  assert.match(u.compose(), new RegExp(OLD.replace(/[.]/g, "\\.")), "oude compose terug");
  assert.equal(fs.readFileSync(path.join(u.root, "version"), "utf8").trim(), "1.0.0.1", "oude versie draait weer");
});

test("updater: downloaden mislukt → niets veranderd", () => {
  const u = setup({ pullFail: true });
  u.request({ id: "r5", app: NEW, caddy: NEWC, version: "1.0.0.2" });
  u.run();
  assert.match(u.result().error, /downloaden/);
  assert.doesNotMatch(u.calls(), /compose/);
});
