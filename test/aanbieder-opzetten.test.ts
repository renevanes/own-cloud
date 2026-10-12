/**
 * Aanbieder worden vanuit de console: bedrijf, accounts (live gecontroleerd tegen nep-Scaleway/-Mollie/-deSEC/-SMTP),
 * adres (je cloud publiceert het A-record), server en back-ups (aanbieder en regio met live prijzen, back-ups elders),
 * opzetten (project, back-upsleutel, bucket, server met user-data), status (tegen een echte Dienst met back-ups naar
 * een nep-S3), opnieuw opzetten bij een andere aanbieder (Scaleway → Hetzner: laatste back-up, terugzetten, oude
 * server weg) en verwijderen. Ook: een oude kluis (alleen Scaleway) en back-ups in een gekoppelde opslag. Plus het
 * opstartscript zelf (bash -n), de dagelijkse versiecontrole en de updater.
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

const HZ_TOKEN = "hetzner-dienst-token";

/**
 * Nep-Hetzner Cloud (servers, formaten) via globalThis.fetch; alle andere adressen gaan gewoon door. De adapter
 * praat met het vaste adres api.hetzner.cloud.
 */
function fakeHetzner(token: string) {
  const st = { servers: [] as any[], n: 100, calls: [] as string[] };
  const real = globalThis.fetch;
  const price = (loc: string, eur: string) => ({ location: loc, price_monthly: { gross: eur } });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.hetzner.cloud/v1/")) return real(input, init);
    const u = new URL(url), method = init.method ?? "GET", p = u.pathname.slice(3);
    st.calls.push(`${method} ${p}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init.headers).get("authorization") !== `Bearer ${token}`) return json(401, { error: { code: "unauthorized", message: "unable to authenticate" } });
    let m: RegExpExecArray | null;
    if (p === "/servers" && method === "GET") return json(200, { servers: st.servers.filter((x) => `cluster=${x.labels.cluster}` === u.searchParams.get("label_selector")), meta: { pagination: { next_page: null } } });
    if (p === "/servers" && method === "POST") {
      const id = ++st.n, b = JSON.parse(String(init.body));
      const x = { id, ...b, public_net: { ipv4: { ip: `198.51.100.${id - 100}` }, ipv6: { ip: `2001:db8:${id}::/64` } } };
      st.servers.push(x);
      return json(201, { server: x });
    }
    if ((m = /^\/servers\/(\d+)$/.exec(p)) && method === "DELETE") {
      const i = st.servers.findIndex((x) => String(x.id) === m![1]);
      if (i < 0) return json(404, { error: { code: "not_found" } });
      st.servers.splice(i, 1);
      return json(200, { action: { id: 1 } });
    }
    if (p === "/server_types") return json(200, { server_types: [
      { name: "cx11", cores: 1, memory: 1, architecture: "x86", prices: [price("fsn1", "3.0000"), price("nbg1", "3.0000")] },
      { name: "cax11", cores: 2, memory: 4, architecture: "arm", prices: [price("fsn1", "3.9900")] },
      { name: "cx23", cores: 2, memory: 4, architecture: "x86", prices: [price("fsn1", "4.5100"), price("nbg1", "4.5100")] },
      { name: "cx33", cores: 4, memory: 8, architecture: "x86", prices: [price("fsn1", "7.0000"), price("hel1", "7.2000")] },
    ] });
    return json(599, { error: `nep-Hetzner kent ${method} ${p} niet` });
  }) as typeof fetch;
  return { st, restore: () => { globalThis.fetch = real; } };
}

/** dienst.env uit de user-data halen (zoals de server hem schrijft). */
function envFromUserData(ud: string): Record<string, string> {
  const m = /cat > \/srv\/dienst\/dienst\.env <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(ud);
  assert.ok(m, "user-data schrijft dienst.env");
  return Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("aanbieder worden: van bedrijfsgegevens tot een draaiende Dienst, vervangen en verwijderen", { timeout: 120_000 }, async (t) => {
  const s3 = fakeS3(), up = fakeUpstream(), smtp = await smtpSink(), hz = fakeHetzner(HZ_TOKEN);
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
    await app.close(); await s3.close(); await up.close(); await smtp.close(); hz.restore();
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
    return [a?.accounts?.mollieKey, a?.accounts?.desecToken, a?.accounts?.scalewaySecretKey, a?.backup?.secretKey, a?.secret, "geheim@smtp", HZ_TOKEN].filter(Boolean) as string[];
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
    assert.deepEqual(r.json.dns, { host: "dienst.vanes.nl", sub: "dienst", managed: true, value: null, mode: "cloud", provider: "desec", zone: "vanes.nl" });
    assert.equal(r.json.step, "server");
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns), [], "nog geen record zonder server");
  });

  await t.test("4. server en back-ups: aanbieder, regio met prijs, back-ups elders", async () => {
    r = await c("POST", "/api/aanbieder/server", { provider: "nergens" });
    assert.match(r.json.error, /Kies een aanbieder/);
    r = await c("POST", "/api/aanbieder/server", { provider: "hetzner" });
    assert.match(r.json.error, /Vul in: API-token/);
    r = await c("POST", "/api/aanbieder/server", { provider: "hetzner", fields: { token: "fout" } });
    assert.match(r.json.error, /Inloggen bij Hetzner Cloud lukt niet/);
    r = await c("POST", "/api/aanbieder/server", { provider: "hetzner", fields: { token: ` ${HZ_TOKEN} ` } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.regions, [
      { region: "fsn1", label: "Falkenstein", city: "Falkenstein", country: "DE", size: "cx23", sizeLabel: "2 vCPU, 4 GB", monthly: 4.51 },
      { region: "nbg1", label: "Neurenberg", city: "Neurenberg", country: "DE", size: "cx23", sizeLabel: "2 vCPU, 4 GB", monthly: 4.51 },
      { region: "hel1", label: "Helsinki", city: "Helsinki", country: "FI", size: "cx33", sizeLabel: "4 vCPU, 8 GB", monthly: 7.2 },
    ], "kleinste geschikte formaat per regio (≥ 2 GB, x86)");
    assert.ok(!hz.st.calls.some((x) => x.startsWith("POST")), "alleen gekeken");
    // Bewaard token: zonder invullen nog eens.
    r = await c("POST", "/api/aanbieder/server", { provider: "hetzner", fields: { token: "••••••••oken" } });
    assert.equal(r.json.regions.length, 3);
    r = await c("POST", "/api/aanbieder/server", { provider: "scaleway" });
    assert.ok(r.json.regions.every((x: any) => x.size === "DEV1-S" && x.monthly === 6.42), JSON.stringify(r.json.regions));
    r = await c("POST", "/api/aanbieder/server", { provider: "scaleway", region: "nl-ams-9" });
    assert.match(r.json.error, /Kies een regio/);
    r = await c("POST", "/api/aanbieder/server", { provider: "scaleway", region: "nl-ams-1" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.hosting, { provider: "scaleway", name: "Scaleway", region: "nl-ams-1", regionLabel: "Amsterdam 1", city: "Amsterdam", country: "NL", size: "DEV1-S", monthly: 6.42 });
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.match(r.json.error, /Kies eerst waar de back-ups komen/);
    r = await c("POST", "/api/aanbieder/backup", { provider: "hetzner", region: "fsn1" });
    assert.match(r.json.error, /toegangssleutel en geheime sleutel/);
    r = await c("POST", "/api/aanbieder/backup", { store: "bestaat-niet" });
    assert.match(r.json.error, /gekoppelde opslag/);
    r = await c("POST", "/api/aanbieder/backup", { provider: "custom", region: "eigen", endpoint: "ftp://x", accessKey: "a", secretKey: "b" });
    assert.match(r.json.error, /endpoint-URL/);
    r = await c("POST", "/api/aanbieder/backup", { provider: "hetzner", region: "nbg1", accessKey: "HZAK", secretKey: "hz-s3-geheim" });
    assert.equal(r.json.backup.provider, "hetzner");
    r = await c("POST", "/api/aanbieder/backup", { provider: "scaleway", region: "fr-par" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.backup, { provider: "scaleway", name: "Scaleway Object Storage", region: "fr-par", regionLabel: "Parijs", country: "FR", bucket: null, auto: true });
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.ready.server, true);
    assert.deepEqual(v.hostingKeys, ["scaleway", "hetzner"]);
    noSecrets(JSON.stringify(v), "GET /api/aanbieder");
    noSecrets((await c("GET", "/api/config")).text, "GET /api/config");
    assert.equal((await c("POST", "/api/aanbieder/stap", { step: "opzetten" })).json.step, "opzetten");
  });

  let userData = "", env: Record<string, string> = {};
  await t.test("5. opzetten: project, back-upsleutel, bucket en server", async () => {
    up.st.scw.failNext.add("/account/v3/projects");
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Scaleway antwoordt 503/);
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.steps.map((x: any) => x.ok), r.json.steps.map(() => true));
    assert.deepEqual(r.json.steps.slice(0, 4).map((x: any) => x.label), ["Project eigen-cloud-dienst bij Scaleway", "Sleutel voor de back-ups (werkt alleen in dit project)",
      "Back-upopslag bij Scaleway Object Storage (Parijs), 30 dagen niet te wissen", "Server bij Scaleway in Amsterdam (DEV1-S)"]);
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
    assert.equal(v.server.provider, "scaleway");
    assert.equal(v.beheerUrl, "https://dienst.vanes.nl/beheer");
    r = await c("POST", "/api/aanbieder/backup", { provider: "hetzner", region: "fsn1", accessKey: "a", secretKey: "b" });
    assert.match(r.json.error, /staan al in vanes-dienst-backup-/, "de back-upplek ligt vast");
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

  await t.test("6. klaar: status van de Dienst, user-data weg bij Scaleway", async () => {
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
    assert.deepEqual(r.json.dns, { host: "dienst.vanes.nl", want: ip, have: [ip], ok: true, mode: "cloud", error: null });
    assert.equal(up.st.scw.userData.size, 0, "user-data met geheimen is weggehaald");
    assert.ok(up.calls.some((x) => x.method === "DELETE" && /user_data\/cloud-init$/.test(x.path)));
    const s = await (await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status`)).json();
    assert.deepEqual(Object.keys(s).sort(), ["backup", "closing", "lastBackupAt", "uptime", "version"]);
    // Zonder het juiste token geen overdracht.
    const bad = await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status/handover`, { method: "POST", headers: { authorization: "Beheer " + "0".repeat(64) } });
    assert.equal(bad.status, 401);
  });

  await t.test("instellingen wijzigen zonder nieuwe server: toepassen", async () => {
    let v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.wijzigingen, "geen", "net opgezet: alles staat op de server");
    r = await c("POST", "/api/aanbieder/bedrijf", { ...v.company, vatPercent: "9", enforce: true });
    assert.equal(r.status, 200, r.text);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.wijzigingen, "toepassen");
    assert.deepEqual([v.company.vatPercent, v.company.enforce], ["9", true]);
    r = await c("POST", "/api/aanbieder/toepassen");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.restart, false, "deze test-Dienst start zichzelf niet opnieuw");
    assert.ok(r.json.keys.includes("BROKER_VAT_PERCENT") && r.json.keys.includes("BROKER_ENFORCE") && !r.json.keys.includes("BROKER_SECRET"), r.json.keys.join(","));
    noSecrets(JSON.stringify(r.json), "toepassen-antwoord");
    assert.equal((await c("GET", "/api/aanbieder")).json.wijzigingen, "geen");
    // Bij de volgende start van deze server gelden ze (nieuwer dan zijn dienst.env).
    const { applyOverride } = await import("../src/broker/instellingen.js");
    const e: Record<string, string | undefined> = { ...env, BROKER_DATA_DIR: first.cfg.dataDir };
    assert.ok(applyOverride(e));
    assert.deepEqual([e.BROKER_VAT_PERCENT, e.BROKER_ENFORCE, e.MOLLIE_API_KEY], ["9", "1", "test_mollie"]);
  });

  await t.test("opnieuw opzetten bij Hetzner: laatste back-up, nieuwe server zet hem terug, oude weg bij Scaleway", async () => {
    const before = (await c("GET", "/api/aanbieder")).json.server;
    r = await c("POST", "/api/aanbieder/server", { provider: "hetzner", region: "fsn1" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.pending, true, "gaat pas in bij opnieuw opzetten");
    assert.equal((await c("GET", "/api/aanbieder")).json.wijzigingen, "opnieuw", "een andere plek vraagt een nieuwe server");
    assert.match((await c("POST", "/api/aanbieder/toepassen")).json.error, /nieuwe server/);
    assert.deepEqual(r.json.hosting, { provider: "hetzner", name: "Hetzner Cloud", region: "fsn1", regionLabel: "Falkenstein", city: "Falkenstein", country: "DE", size: "cx23", monthly: 4.51 });
    const owner = first.b.ctx.db.prepare("SELECT email, role FROM staff").all();
    assert.deepEqual(owner, [{ email: "rene@elders.example", role: "eigenaar" }]);
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.replaced, true);
    assert.equal(r.json.steps.find((x: any) => /Laatste back-up/.test(x.label)).ok, true, JSON.stringify(r.json.steps));
    assert.ok(r.json.steps.some((x: any) => x.label === "Server bij Hetzner Cloud in Falkenstein (cx23)"), JSON.stringify(r.json.steps));
    assert.ok(!r.json.steps.some((x: any) => /Project|Sleutel voor/.test(x.label)), "geen nieuw project of nieuwe sleutel nodig");
    // De oude server schrijft niets meer.
    const blocked = await fetch(`http://127.0.0.1:${first.cfg.port}/v1/info`);
    assert.equal(blocked.status, 503);
    assert.equal((await (await fetch(`http://127.0.0.1:${first.cfg.port}/v1/status`)).json()).closing, true);
    const after = (await c("GET", "/api/aanbieder")).json;
    assert.notEqual(after.server.serverId, before.serverId);
    assert.notEqual(after.server.ipv4, before.ipv4);
    assert.equal(after.server.provider, "hetzner");
    // Oude server opgeruimd bij Scaleway (op de achtergrond).
    for (let i = 0; i < 50 && (await c("GET", "/api/aanbieder")).json.retired; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(up.st.scw.servers.length, 0, "Scaleway-server weg");
    assert.equal(hz.st.servers.length, 1);
    const srv = hz.st.servers[0];
    assert.equal(String(srv.id), after.server.serverId);
    assert.deepEqual([srv.location, srv.server_type, srv.labels.cluster], ["fsn1", "cx23", "eigen-cloud-dienst"]);
    assert.equal(after.server.ipv6, "2001:db8:101::1");
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns).slice(0, 2), [{ sub: "dienst", type: "A", value: after.server.ipv4 }, { sub: "dienst", type: "AAAA", value: after.server.ipv6 }]);
    // Nieuwe server met lege datamap: zet de laatste back-up terug (nog steeds bij Scaleway), met dezelfde sleutel van de aanbieder.
    env = envFromUserData(srv.user_data);
    assert.equal(env.SCW_SECRET_KEY, SCW_KEY, "de Scaleway-sleutel blijft voor de clouds van klanten");
    assert.equal(env.BROKER_VAT_PERCENT, "9", "toegepaste instellingen staan ook in de nieuwe dienst.env");
    assert.ok(Number(env.BROKER_ENV_AT) > 0, "dienst.env weet wanneer hij geschreven is");
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
    assert.equal(hz.st.servers.length, 1);
    r = await c("POST", "/api/aanbieder/verwijderen", { confirm: " Dienst.Vanes.nl " });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.finalBackup, true);
    assert.ok(r.json.bucket);
    for (let i = 0; i < 50 && hz.st.servers.length; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(hz.st.servers.length, 0, "server weg bij Hetzner");
    assert.ok(hz.st.calls.includes(`DELETE /servers/${String(101)}`));
    assert.ok(s3.buckets.has(r.json.bucket), "back-ups blijven");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.removed, true);
    assert.equal(v.server, null);
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns), [{ sub: "dienst", type: "A", value: "" }, { sub: "dienst", type: "AAAA", value: "" }]);
    r = await c("GET", "/api/aanbieder/status");
    assert.deepEqual(r.json, { reachable: false, server: false, removed: true });
  });
});

test("oude kluis (alleen Scaleway) werkt nog; Dienst bij Hetzner met back-ups in een gekoppelde opslag", { timeout: 60_000 }, async (t) => {
  const s3 = fakeS3(), up = fakeUpstream(), hz = fakeHetzner(HZ_TOKEN);
  const U = `http://127.0.0.1:${await up.listening}`, S3 = `http://127.0.0.1:${await s3.listening}`;
  up.st.scw.keys.add(SCW_KEY);
  process.env.EIGEN_SCW_API = `${U}/scw`;
  t.after(async () => { await s3.close(); await up.close(); hz.restore(); delete process.env.EIGEN_SCW_API; });
  const aanbieder = await import("../src/console/aanbieder.js");
  const { serverOffers, storeOffers } = await import("../src/console/catalog.js");
  const deps = { save: () => {}, sleep: async () => {}, serverOffers: () => serverOffers(), storeOffers: () => storeOffers() };
  aanbieder.aanbiederNet.reach = () => "http://127.0.0.1:9";
  const company = { name: "Van Es", address: ["Blaak 10"], kvk: "", vat: "", email: "rene@elders.example" };
  const base = { url: "https://dienst.vanes.nl", company, accounts: { scalewaySecretKey: SCW_KEY, scalewayOrgId: ORG, mollieKey: "test_x", desecToken: "d" }, checked: { scaleway: true, mollie: true, desec: true, smtp: true }, secret: "ab".repeat(32) };

  // Een Dienst van vóór de keuze van aanbieder: alles bij Scaleway, vervangen servers als losse id's.
  up.st.scw.servers.push({ id: "srv-oud", zone: "nl-ams-1", tags: [], public_ips: [{ id: "ip-oud" }] });
  up.st.scw.ips.push({ id: "ip-oud", address: "192.0.2.99", zone: "nl-ams-1" });
  const c1: any = { cluster: "vanes", domain: "vanes.nl", providers: {}, stores: [], dns: [], image: {}, console: { done: true, aanbieder: { ...base, step: "klaar", projectId: "proj-1",
    backup: { endpoint: S3, region: "fr-par", bucket: "vanes-dienst-backup-oud", accessKey: "SCWAK", secretKey: "s", applicationId: "app-1", policyId: "pol-1" },
    server: { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", serverId: "nl-ams-1/srv-nu/ip-nu", ipv4: "192.0.2.10", createdAt: 1 },
    retired: ["nl-ams-1/srv-oud/ip-oud"] } } };
  const v = aanbieder.view(c1, deps) as any;
  assert.deepEqual(v.hosting, { provider: "scaleway", name: "Scaleway", region: "nl-ams-1", regionLabel: "Amsterdam 1", city: "Amsterdam", country: "NL", size: "DEV1-S", monthly: null });
  assert.deepEqual(v.backup, { provider: "scaleway", name: "Scaleway Object Storage", region: "fr-par", regionLabel: "Parijs", country: "FR", bucket: "vanes-dienst-backup-oud", auto: true });
  assert.equal(v.server.provider, "scaleway");
  assert.equal(v.ready.server, true);
  assert.deepEqual(c1.console.aanbieder.retired, [{ provider: "scaleway", serverId: "nl-ams-1/srv-oud/ip-oud" }]);
  await aanbieder.cleanupRetired(c1, deps);
  assert.equal(c1.console.aanbieder.retired, undefined);
  assert.ok(!up.st.scw.servers.some((x) => x.id === "srv-oud"), "oude server weg via de Provider van Scaleway");
  assert.throws(() => aanbieder.saveBackup(c1, { provider: "hetzner", region: "fsn1", accessKey: "a", secretKey: "b" }, deps), /staan al in vanes-dienst-backup-oud/);

  // Nieuw: de server bij Hetzner met de sleutel die de cloud al heeft, de back-ups in een gekoppelde opslag elders.
  const c2: any = { cluster: "vanes", domain: "vanes.nl", providers: { hetzner: { token: HZ_TOKEN } }, dns: [], image: {}, console: { done: true, aanbieder: { ...base, step: "server" } },
    stores: [{ name: "eigen-backup", type: "s3", purpose: "backup", country: "DE", endpoint: S3, region: "de-fra-1", bucket: "vanes-backup-x", accessKey: "EIGENAK", secretKey: "eigen-geheim" }] };
  await assert.rejects(aanbieder.opzetten(c2, deps), /Kies eerst waar de server/);
  const r = await aanbieder.saveServer(c2, { provider: "hetzner", region: "nbg1" }, deps);
  assert.deepEqual(r.hosting, { provider: "hetzner", name: "Hetzner Cloud", region: "nbg1", regionLabel: "Neurenberg", city: "Neurenberg", country: "DE", size: "cx23", monthly: 4.51 });
  assert.deepEqual(c2.console.aanbieder.keys, { hetzner: { token: HZ_TOKEN } }, "sleutel van de cloud overgenomen");
  const b = aanbieder.saveBackup(c2, { store: "eigen-backup" }, deps);
  assert.deepEqual(b.backup, { provider: "custom", name: "Eigen opslag (NAS, MinIO, Garage)", region: "de-fra-1", regionLabel: "127.0.0.1", country: "DE", bucket: null, auto: false });
  const before = up.calls.length;
  const o = await aanbieder.opzetten(c2, deps);
  assert.deepEqual(o.steps.slice(0, 2).map((x: any) => x.label), ["Back-upopslag bij Eigen opslag (NAS, MinIO, Garage) (127.0.0.1), 30 dagen niet te wissen", "Server bij Hetzner Cloud in Neurenberg (cx23)"]);
  assert.ok(!up.calls.slice(before).some((x) => x.path.startsWith("/scw/")), "niets bij Scaleway voor de server of de back-ups");
  assert.equal(c2.console.aanbieder.projectId, undefined);
  const srv = hz.st.servers.at(-1);
  assert.deepEqual([srv.location, srv.server_type], ["nbg1", "cx23"]);
  assert.ok(srv.user_data.length < 32 * 1024, "user-data past bij Hetzner (32 KiB)");
  const env = envFromUserData(srv.user_data);
  assert.deepEqual([env.BROKER_BACKUP_ENDPOINT, env.BROKER_BACKUP_REGION, env.BROKER_BACKUP_ACCESS_KEY, env.BROKER_BACKUP_SECRET_KEY], [S3, "de-fra-1", "EIGENAK", "eigen-geheim"]);
  assert.match(env.BROKER_BACKUP_BUCKET, /^vanes-dienst-backup-/, "eigen bucket, niet die van de cloud");
  assert.ok(s3.buckets.get(env.BROKER_BACKUP_BUCKET)?.lock, "bucket klaargezet met onveranderbare back-ups");
  assert.equal(env.SCW_SECRET_KEY, SCW_KEY, "Scaleway-sleutel blijft voor de clouds van klanten");
  const vv = aanbieder.view(c2, deps) as any;
  assert.deepEqual([vv.server.provider, vv.server.ipv4], ["hetzner", srv.public_net.ipv4.ip]);
  assert.ok(!JSON.stringify(vv).includes(HZ_TOKEN) && !JSON.stringify(vv).includes("eigen-geheim"), "geen geheimen in de weergave");
  const d = await aanbieder.verwijderen(c2, { confirm: "dienst.vanes.nl" }, deps);
  assert.equal(d.finalBackup, false, "server onbereikbaar: de vorige back-up blijft");
  for (let i = 0; i < 50 && hz.st.servers.length; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(hz.st.servers.length, 0, "server weg bij Hetzner");
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
