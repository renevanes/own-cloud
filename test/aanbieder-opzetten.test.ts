/**
 * Aanbieder worden vanuit de console: bedrijf, accounts (live gecontroleerd tegen nep-Scaleway/-Mollie/-deSEC/-SMTP),
 * adres (je cloud publiceert het A-record), opzetten (project, back-upsleutel, bucket, server met user-data), status
 * (tegen een echte Dienst met back-ups naar een nep-S3), opnieuw opzetten (laatste back-up, terugzetten, oude server
 * weg) en verwijderen. Plus het opstartscript zelf (bash -n), de dagelijkse versiecontrole en de updater.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fakeS3 } from "./helpers/fake-s3.js";
import { fakeUpstream, smtpSink } from "./helpers/broker-fakes.js";
import { freePort } from "./helpers/cluster.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aanbieder-"));
process.env.DATA_DIR = path.join(base, "data");
process.env.MAIL_DOMAINS = "vanes.nl";
process.env.MAIL_FROM = "rene@vanes.nl";

const SCW_KEY = "12345678-aaaa-bbbb-cccc-1234567890ab", ORG = "87654321-dddd-eeee-ffff-ba0987654321";
const PASS = "vier losse woorden hier";

function client(app: { inject: (o: object) => Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }> }) {
  let cookie = "";
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method, url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    let json: any = null; try { json = r.json(); } catch { /* */ }
    return { status: r.statusCode, json, text: r.body };
  };
}

/** dienst.env uit de user-data halen (zoals de server hem schrijft). */
function envFromUserData(ud: string): Record<string, string> {
  const m = /cat > \/srv\/dienst\/dienst\.env <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(ud);
  assert.ok(m, "user-data schrijft dienst.env");
  return Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("aanbieder worden: van bedrijfsgegevens tot een draaiende Dienst, vervangen en verwijderen", { timeout: 120_000 }, async (t) => {
  const s3 = fakeS3(), up = fakeUpstream(), smtp = await smtpSink();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.st.scw.keys.add(SCW_KEY);
  process.env.EIGEN_TEST_S3 = `http://127.0.0.1:${await s3.listening}`;
  process.env.EIGEN_SCW_API = `${U}/scw`;
  process.env.EIGEN_MOLLIE_URL = `${U}/mollie`;
  process.env.EIGEN_DESEC_URL = `${U}/desec`;
  process.env.EIGEN_OPENPROVIDER_URL = `${U}/op`;
  process.env.EIGEN_VAULT = path.join(base, "kluis.json");
  delete process.env.EIGEN_DIENST_URL;
  const { buildConsole } = await import(`../src/console/server.js?aanbieder=${Date.now()}`);
  const aanbieder = await import("../src/console/aanbieder.js");
  const { Vault } = await import("../src/console/vault.js");
  const { consoleSettings } = await import("../src/cluster/admin.js");
  const app = await buildConsole();
  const c = client(app);
  const brokers: { close: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const b of brokers) await b.close().catch(() => {});
    await app.close(); await s3.close(); await up.close(); await smtp.close();
    for (const k of ["EIGEN_TEST_S3", "EIGEN_SCW_API", "EIGEN_MOLLIE_URL", "EIGEN_DESEC_URL", "EIGEN_OPENPROVIDER_URL"]) delete process.env[k];
  });
  /** De kluis zoals de console hem bewaart. */
  const vaultConfig = () => { const v = new Vault(process.env.EIGEN_VAULT!); v.unlock(PASS); return v.config!; };

  // Een cloud die al draait, met DNS die hij zelf beheert.
  let r = await c("POST", "/api/setup/create", { domain: "vanes.nl", domainMode: "own", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: PASS });
  assert.equal(r.status, 200, r.text);
  {
    const v = new Vault(process.env.EIGEN_VAULT!);
    v.unlock(PASS);
    Object.assign(v.config!.console, { done: true, step: "klaar", keyConfirmed: true, dnsMode: "desec", mailRelay: "smtp://projectid:geheim@smtp.tem.scaleway.com:587" });
    v.config!.dns = [{ type: "desec", name: "desec", token: "cloud-dns-token", zone: "vanes.nl" }];
    v.save();
    await c("POST", "/api/lock");
    assert.equal((await c("POST", "/api/unlock", { passphrase: PASS })).status, 200);
  }
  const secrets = () => {
    const a = (vaultConfig().console as any).aanbieder;
    return [a?.accounts?.mollieKey, a?.accounts?.desecToken, a?.accounts?.scalewaySecretKey, a?.backup?.secretKey, a?.secret, "geheim@smtp"].filter(Boolean) as string[];
  };
  const noSecrets = (text: string, what: string) => { for (const s of secrets()) assert.ok(!text.includes(s), `${what} bevat geen geheim (${s.slice(0, 6)}…)`); };

  await t.test("1. bedrijf: controleren en bewaren", async () => {
    r = await c("GET", "/api/aanbieder");
    assert.equal(r.json.started, false);
    assert.equal(r.json.defaultUrl, "https://dienst.vanes.nl");
    assert.equal(r.json.defaultEmail, "rene@elders.example");
    assert.equal((await c("POST", "/api/aanbieder/stap", { step: "bedrijf" })).json.step, "bedrijf");
    assert.equal((await c("POST", "/api/aanbieder/stap", { step: "klaar" })).status, 400, "klaar kan pas na opzetten");
    assert.equal((await c("POST", "/api/aanbieder/stap", { step: "uit" })).status, 200);
    assert.equal((await c("GET", "/api/aanbieder")).json.started, false, "stoppen vergeet alles");
    r = await c("POST", "/api/aanbieder/bedrijf", { name: "Van Es Diensten", address: "Blaak 10\n3011 TA Rotterdam", kvk: "1234567", email: "rene@elders.example" });
    assert.match(r.json.error, /8 cijfers/);
    r = await c("POST", "/api/aanbieder/bedrijf", { name: "Van Es Diensten", address: "Blaak 10\n3011 TA Rotterdam", kvk: "1234 5678", vat: "nl0012.34567.b01", email: "geen-adres" });
    assert.match(r.json.error, /e-mailadres van de eigenaar/);
    r = await c("POST", "/api/aanbieder/bedrijf", { name: "Rene's Diensten", address: "Blaak 10\n\n3011 TA Rotterdam ", kvk: "1234 5678", vat: "nl0012.34567.b01", email: "Rene@Elders.example" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.step, "accounts");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual(v.company, { name: "Rene's Diensten", address: ["Blaak 10", "3011 TA Rotterdam"], kvk: "12345678", vat: "NL001234567B01", email: "rene@elders.example" });
    assert.equal(v.ready.bedrijf, true);
  });

  await t.test("2. accounts: elke sleutel live gecontroleerd", async () => {
    r = await c("POST", "/api/aanbieder/accounts", { scalewaySecretKey: "99999999-aaaa-bbbb-cccc-1234567890ab", scalewayOrgId: ORG, mollieKey: "test_fout", desecToken: "nee", smtpUrl: `smtp://127.0.0.1:${smtp.port}` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, false);
    const by = Object.fromEntries(r.json.checks.map((x: any) => [x.id, x]));
    assert.match(by.scaleway.detail, /accepteert deze sleutel niet/);
    assert.match(by.mollie.detail, /accepteert deze sleutel niet/);
    assert.match(by.desec.detail, /accepteert dit token niet/);
    assert.equal(by.smtp.ok, true, by.smtp.detail);
    assert.equal(r.json.step, "accounts", "niet verder met foute sleutels");
    r = await c("POST", "/api/aanbieder/accounts", { mollieKey: "geen-sleutel" });
    assert.match(r.json.checks.find((x: any) => x.id === "mollie").detail, /test_ of live_/);

    r = await c("POST", "/api/aanbieder/accounts", { scalewaySecretKey: ` "${SCW_KEY.toUpperCase()}" `, scalewayOrgId: ORG, mollieKey: "test_mollie", desecToken: "desec-dienst", openproviderUser: "rene", openproviderPass: "fout" });
    assert.equal(r.json.ok, true, JSON.stringify(r.json.checks));
    assert.equal(r.json.checks.find((x: any) => x.id === "openprovider").ok, false, "Openprovider is optioneel en houdt niet tegen");
    r = await c("POST", "/api/aanbieder/accounts", { scalewaySecretKey: "••••••••90ab", mollieKey: "••••••••llie", openproviderPass: "op-geheim" });
    assert.equal(r.json.ok, true, JSON.stringify(r.json.checks));
    assert.ok(r.json.checks.every((x: any) => x.ok), JSON.stringify(r.json.checks));
    assert.equal(r.json.step, "adres");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.accounts.scalewaySecretKey, "••••••••90ab");
    assert.equal(v.accounts.mollieMode, "test");
    assert.equal(v.accounts.smtp, `smtp://127.0.0.1:${smtp.port}`);
    assert.equal(v.accounts.mailFrom, "noreply@vanes.nl");
    noSecrets(JSON.stringify(v), "GET /api/aanbieder");
    noSecrets(JSON.stringify(r.json), "accounts-antwoord");
  });

  await t.test("3. adres: dienst.<domein>, je cloud zet het record", async () => {
    r = await c("POST", "/api/aanbieder/adres", { url: "http://dienst.vanes.nl/pad" });
    assert.match(r.json.error, /alleen een adres/);
    r = await c("POST", "/api/aanbieder/adres", {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.url, "https://dienst.vanes.nl");
    assert.deepEqual(r.json.dns, { host: "dienst.vanes.nl", sub: "dienst", managed: true, value: null });
    assert.equal(r.json.step, "opzetten");
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns), [], "nog geen record zonder server");
  });

  let userData = "", env: Record<string, string> = {};
  await t.test("4. opzetten: project, back-upsleutel, bucket en server", async () => {
    up.st.scw.failNext.add("/account/v3/projects");
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Scaleway antwoordt 503/);
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.steps.map((x: any) => x.ok), r.json.steps.map(() => true));
    assert.equal(up.st.scw.projects.filter((p) => p.name === "eigen-cloud-dienst").length, 1, "één project");
    const project = up.st.scw.projects.find((p) => p.name === "eigen-cloud-dienst")!;
    const pol = up.st.scw.policies.find((p) => p.name === "eigen-cloud-dienst-backup")!;
    assert.deepEqual(pol.rules, [{ permission_set_names: ["ObjectStorageFullAccess"], project_ids: [project.id] }], "back-upsleutel alleen voor opslag in dit project");
    assert.equal(up.st.scw.apiKeys.at(-1).default_project_id, project.id);
    const bucket = [...s3.buckets.entries()].find(([n]) => n.startsWith("vanes-dienst-backup-"))!;
    assert.ok(bucket[1].lock && bucket[1].retentionDays === 30, "back-ups 30 dagen onveranderbaar");
    assert.equal(up.st.scw.servers.length, 1);
    const srv = up.st.scw.servers[0];
    assert.equal(srv.project, project.id);
    assert.equal(srv.commercial_type, "DEV1-S");
    assert.equal(srv.zone, "nl-ams-1");
    userData = up.st.scw.userData.get(srv.id)!;
    env = envFromUserData(userData);
    assert.equal(env.BROKER_PUBLIC_URL, "https://dienst.vanes.nl");
    assert.match(env.BROKER_SECRET, /^[0-9a-f]{64}$/);
    assert.equal(env.BROKER_OWNER_EMAIL, "rene@elders.example");
    assert.equal(env.BROKER_COMPANY_NAME, "Rene's Diensten");
    assert.equal(env.BROKER_COMPANY_ADDRESS, "Blaak 10\\n3011 TA Rotterdam");
    assert.equal(env.BROKER_COMPANY_KVK, "12345678");
    assert.equal(env.BROKER_MAIL_FROM, "Rene's Diensten <noreply@vanes.nl>");
    assert.equal(env.MOLLIE_API_KEY, "test_mollie");
    assert.equal(env.SCW_SECRET_KEY, SCW_KEY);
    assert.equal(env.SCW_ORGANIZATION_ID, ORG);
    assert.equal(env.OPENPROVIDER_PASSWORD, "op-geheim");
    assert.equal(env.BROKER_BACKUP_BUCKET, bucket[0]);
    assert.equal(env.BROKER_BACKUP_ENDPOINT, process.env.EIGEN_TEST_S3);
    assert.match(userData, /^    image: ghcr\.io\/renevanes\/eigen-cloud:latest  # eigen-app$/m);
    assert.match(userData, /command: \["node", "dist\/broker\/main\.js"\]/);
    assert.match(userData, /^dienst\.vanes\.nl \{$/m);
    assert.match(userData, /dienst-check\.timer/);
    const ud = path.join(base, "dienst-user-data.sh");
    fs.writeFileSync(ud, userData);
    const sh = spawnSync("bash", ["-n", ud], { encoding: "utf8" });
    assert.equal(sh.status, 0, sh.stderr);
    noSecrets(JSON.stringify(r.json), "opzetten-antwoord");
    noSecrets((await c("GET", "/api/aanbieder")).text, "GET /api/aanbieder");
    noSecrets((await c("GET", "/api/config")).text, "GET /api/config");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.step, "klaar");
    assert.equal(v.server.ipv4, r.json.server.ipv4);
    assert.equal(v.backup.bucket, bucket[0]);
    assert.equal(v.beheerUrl, "https://dienst.vanes.nl/beheer");
  });

  await t.test("DNS: de cloud publiceert dienst.vanes.nl (A) naast zijn eigen records", async () => {
    const ip = (await c("GET", "/api/aanbieder")).json.server.ipv4;
    const settings = consoleSettings(vaultConfig());
    assert.deepEqual(JSON.parse(settings.extra_dns), [{ sub: "dienst", type: "A", value: ip }, { sub: "dienst", type: "AAAA", value: "" }]);
    const db = await import("../src/db.js");
    const health = await import("../src/health.js");
    db.setSetting("extra_dns", JSON.stringify([...JSON.parse(settings.extra_dns), { sub: "cloud", type: "A", value: "203.0.113.9" }, { sub: "x", type: "A", value: "geen-ip" }]));
    const recs = health.expectedRecords({ ips4: ["198.51.100.1"], ips6: [] });
    assert.deepEqual(recs.find((x) => x.sub === "dienst" && x.type === "A")?.values, [ip]);
    assert.deepEqual(recs.find((x) => x.sub === "dienst" && x.type === "AAAA")?.values, [], "leeg AAAA-record: weghalen");
    assert.deepEqual(recs.find((x) => x.sub === "cloud" && x.type === "A")?.values, ["198.51.100.1"], "cloud.<domein> blijft van de cloud");
    assert.equal(recs.some((x) => x.sub === "x"), false, "ongeldig IP-adres genegeerd");
  });

  // Een echte Dienst met de omgeving uit de user-data (back-ups naar de nep-S3).
  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const startDienst = async (dir: string) => {
    const e = { ...env, BROKER_DATA_DIR: dir, BROKER_PORT: String(await freePort()), BROKER_LOOP_MS: "600000", BROKER_BACKUP_EVERY_MS: "600000", BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}` };
    const { restoreIfEmpty } = await import("../src/broker/backup.js");
    const restored = await restoreIfEmpty(e);
    const cfg = loadConfig(e);
    const b = await createBroker(cfg);
    await b.app.listen({ port: cfg.port, host: "127.0.0.1" });
    brokers.push(b);
    aanbieder.aanbiederNet.reach = () => `http://127.0.0.1:${cfg.port}`;
    return { b, cfg, restored };
  };
  let first: Awaited<ReturnType<typeof startDienst>>;

  await t.test("5. klaar: status van de Dienst, user-data weg bij Scaleway", async () => {
    first = await startDienst(path.join(base, "dienst-1"));
    assert.equal(first.restored, null, "eerste start: niets terug te zetten");
    first.b.startLoops();
    const ip = (await c("GET", "/api/aanbieder")).json.server.ipv4;
    aanbieder.aanbiederNet.resolve4 = async () => [ip];
    // De eerste back-up start meteen.
    for (let i = 0; i < 50 && !first.b.backup!.lastBackupAt; i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(first.b.backup!.lastBackupAt, "back-up gemaakt");
    r = await c("GET", "/api/aanbieder/status");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reachable, true);
    assert.match(r.json.version, /-dev$|^\d/);
    assert.equal(r.json.backup, "aan");
    assert.equal(r.json.lastBackupAt, first.b.backup!.lastBackupAt);
    assert.deepEqual(r.json.dns, { host: "dienst.vanes.nl", want: ip, have: [ip], ok: true });
    assert.equal(up.st.scw.userData.size, 0, "user-data met geheimen is weggehaald");
    assert.ok(up.calls.some((x) => x.method === "DELETE" && /user_data\/cloud-init$/.test(x.path)));
    const s = await (await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status`)).json();
    assert.deepEqual(Object.keys(s).sort(), ["backup", "closing", "lastBackupAt", "uptime", "version"]);
    // Zonder het juiste token geen overdracht.
    const bad = await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status/handover`, { method: "POST", headers: { authorization: "Beheer " + "0".repeat(64) } });
    assert.equal(bad.status, 401);
  });

  await t.test("opnieuw opzetten: laatste back-up, nieuwe server zet hem terug, oude weg", async () => {
    const before = (await c("GET", "/api/aanbieder")).json.server;
    const owner = first.b.ctx.db.prepare("SELECT email, role FROM staff").all();
    assert.deepEqual(owner, [{ email: "rene@elders.example", role: "eigenaar" }]);
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.replaced, true);
    assert.equal(r.json.steps.find((x: any) => /Laatste back-up/.test(x.label)).ok, true, JSON.stringify(r.json.steps));
    // De oude server schrijft niets meer.
    const blocked = await fetch(`http://127.0.0.1:${first.cfg.port}/v1/info`);
    assert.equal(blocked.status, 503);
    assert.equal((await (await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status`)).json()).closing, true);
    const after = (await c("GET", "/api/aanbieder")).json;
    assert.notEqual(after.server.serverId, before.serverId);
    assert.notEqual(after.server.ipv4, before.ipv4);
    // Oude server opgeruimd (op de achtergrond).
    for (let i = 0; i < 50 && (await c("GET", "/api/aanbieder")).json.retired; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(up.st.scw.servers.length, 1);
    assert.equal(up.st.scw.servers[0].id, after.server.serverId.split("/")[1]);
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns)[0], { sub: "dienst", type: "A", value: after.server.ipv4 });
    // Nieuwe server met lege datamap: zet de laatste back-up terug, met dezelfde sleutel van de aanbieder.
    env = envFromUserData(up.st.scw.userData.get(up.st.scw.servers[0].id)!);
    const second = await startDienst(path.join(base, "dienst-2"));
    assert.ok(second.restored, "back-up teruggezet");
    assert.equal(second.cfg.providerPublicKey, first.cfg.providerPublicKey, "zelfde sleutel (aanbieders.json blijft kloppen)");
    assert.deepEqual(second.b.ctx.db.prepare("SELECT email, role FROM staff").all(), owner);
    r = await c("GET", "/api/aanbieder/status");
    assert.equal(r.json.reachable, true);
    assert.equal(r.json.closing, false);
  });

  await t.test("verwijderen: met bevestiging; back-ups blijven, record weg", async () => {
    r = await c("POST", "/api/aanbieder/verwijderen", { confirm: "ja" });
    assert.match(r.json.error, /Typ dienst\.vanes\.nl/);
    assert.equal(up.st.scw.servers.length, 1);
    r = await c("POST", "/api/aanbieder/verwijderen", { confirm: " Dienst.Vanes.nl " });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.finalBackup, true);
    assert.ok(r.json.bucket);
    for (let i = 0; i < 50 && up.st.scw.servers.length; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(up.st.scw.servers.length, 0, "server weg");
    assert.ok(s3.buckets.has(r.json.bucket), "back-ups blijven");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.removed, true);
    assert.equal(v.server, null);
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns), [{ sub: "dienst", type: "A", value: "" }, { sub: "dienst", type: "AAAA", value: "" }]);
    r = await c("GET", "/api/aanbieder/status");
    assert.deepEqual(r.json, { reachable: false, server: false, removed: true });
  });
});

test("back-ups van de Dienst: bewaren en opruimen", async () => {
  const { toPrune, backupTime } = await import("../src/broker/backup.js");
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  const key = (ms: number) => `dienst/${new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-ab12.enc`;
  assert.equal(backupTime(key(now)), now);
  const keys = [now - 3600_000, now - 47 * 3600_000, now - 50 * 3600_000, now - 51 * 3600_000, now - 10 * 86400_000, now - 31 * 86400_000].map(key);
  // 50 en 51 uur geleden zijn dezelfde dag: alleen de nieuwste blijft. Ouder dan 30 dagen gaat weg.
  assert.deepEqual(toPrune([...keys, "dienst/rommel"], now), [keys[3], keys[5]]);
});

test("Dienst-server: dagelijkse versiecontrole en de updater met de gezondheid van de Dienst", async () => {
  const { dienstCheckScript, updaterScript } = await import("../src/cluster/cloudinit.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dienst-check-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(bin);
  const d = (x: string) => "sha256:" + x.repeat(64);
  fs.writeFileSync(path.join(root, "update-refs"), "ghcr.io/rene/eigen-cloud:latest\nghcr.io/rene/eigen-caddy:latest\n");
  fs.writeFileSync(path.join(root, "update-allowed"), "ghcr.io/rene/\n");
  fs.writeFileSync(path.join(root, "docker-compose.yml"), `services:\n  app:\n    image: ghcr.io/rene/eigen-cloud:latest  # eigen-app\n  caddy:\n    image: ghcr.io/rene/eigen-caddy:latest  # eigen-caddy\n`);
  fs.writeFileSync(path.join(root, "version"), "1.8.0.1");
  const log = path.join(root, "calls.log");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/bash
echo "docker $*" >> "${log}"
case "$1" in
  run) echo '{"version":"1.9.0.4","app":"ghcr.io/rene/eigen-cloud@${d("a")}","caddy":"ghcr.io/rene/eigen-caddy@${d("b")}"}' ;;
  compose) if grep -q '${d("a")}' "${root}/docker-compose.yml"; then echo 1.9.0.4 > "${root}/version"; fi ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash
echo "curl $*" >> "${log}"
for a in "$@"; do case "$a" in *v1/status) printf '{"version":"%s"}' "$(cat "${root}/version")"; exit 0 ;; *healthz) exit 7 ;; esac; done
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const envv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, EIGEN_ROOT: root, HEALTH_URL: "http://127.0.0.1:4100/v1/status", CADDY_HEALTH_URL: "", EIGEN_UPDATE_HEALTH_SECONDS: "9" };
  fs.writeFileSync(path.join(root, "check.sh"), dienstCheckScript(), { mode: 0o755 });
  fs.writeFileSync(path.join(root, "update.sh"), updaterScript(), { mode: 0o755 });
  assert.equal(spawnSync("bash", ["-n", path.join(root, "check.sh")]).status, 0);

  let r = spawnSync("bash", [path.join(root, "check.sh")], { env: envv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const req = JSON.parse(fs.readFileSync(path.join(root, "data", "update-request.json"), "utf8"));
  assert.equal(req.version, "1.9.0.4");
  assert.equal(req.app, `ghcr.io/rene/eigen-cloud@${d("a")}`);
  assert.match(fs.readFileSync(log, "utf8"), /docker run --rm --network host --entrypoint node ghcr\.io\/rene\/eigen-cloud:latest .* ghcr\.io\/rene\/eigen-cloud:latest ghcr\.io\/rene\/eigen-caddy:latest/);

  // De updater: gezond volgens /v1/status van de Dienst; de controle op poort 3000 (cloud) slaat hij over.
  r = spawnSync("bash", [path.join(root, "update.sh")], { env: envv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(fs.readFileSync(path.join(root, "data", "update-result.json"), "utf8"));
  assert.deepEqual([res.ok, res.version, res.rolledBack], [true, "1.9.0.4", false]);
  assert.match(fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8"), new RegExp(d("a")));
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /healthz/);

  // Al bijgewerkt: niets te doen. Een mislukte versie: niet opnieuw proberen.
  fs.rmSync(path.join(root, "data", "update-request.json"));
  spawnSync("bash", [path.join(root, "check.sh")], { env: envv });
  assert.equal(fs.existsSync(path.join(root, "data", "update-request.json")), false, "zelfde versie: geen verzoek");
  fs.writeFileSync(path.join(root, "version"), "1.8.0.1");
  fs.writeFileSync(path.join(root, "data", "update-result.json"), JSON.stringify({ id: "x", version: "1.9.0.4", ok: false }));
  spawnSync("bash", [path.join(root, "check.sh")], { env: envv });
  assert.equal(fs.existsSync(path.join(root, "data", "update-request.json")), false, "mislukte versie niet opnieuw");
});
