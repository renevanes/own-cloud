/**
 * Aanbieder worden zonder eigen cloud, en "Je dienst" als één plek voor alles:
 * - een kluis alleen voor de Dienst (wachtwoordzin + herstelsleutel, geen cloudstappen), en later toch een cloud erbij;
 * - een eigen DNS-koppeling (nep-DNS-adapter uit de registry): de console zet de A/AAAA-records zelf bij opzetten,
 *   werkt ze bij als de server een ander IP-adres krijgt en haalt ze weg bij verwijderen of een andere keuze;
 * - de onderdelen van "Je dienst" met links naar /beheer, wat nog niet is toegepast (per onderdeel), kerncijfers van de
 *   Dienst (GET /v1/status/overzicht met het beheertoken), de hersteltest en de herstelkopie van de kluis in de
 *   back-upbucket (herstellen op een nieuw toestel);
 * - de plaatsing van servers per bundel in het beheer (regio's, formaten met prijzen, controles).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeS3 } from "./helpers/fake-s3.js";
import { fakeUpstream, smtpSink } from "./helpers/broker-fakes.js";
import { freePort } from "./helpers/cluster.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aanbieder-hub-"));
process.env.DATA_DIR = path.join(base, "data");

const SCW_KEY = "12345678-aaaa-bbbb-cccc-1234567890ab", ORG = "87654321-dddd-eeee-ffff-ba0987654321";
const PASS = "vier losse woorden hier";
const DNS_TOKEN = "dns-geheim";

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

function envFromUserData(ud: string): Record<string, string> {
  const m = /cat > \/srv\/dienst\/dienst\.env <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(ud);
  assert.ok(m, "user-data schrijft dienst.env");
  return Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

test("aanbieder worden zonder eigen cloud: eigen DNS, Je dienst, hersteltest en herstelkopie", { timeout: 120_000 }, async (t) => {
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

  // Een DNS-aanbieder in de registry die records in het geheugen bewaart.
  const { registerAdapter } = await import("../src/cluster/adapters.js");
  const dns = { zones: new Set<string>(), records: new Map<string, string[]>(), writes: [] as string[], fail: false };
  const unregister = registerAdapter({
    id: "testdns", name: "Test-DNS", owner: "Test (Nederland)", home: "NL", signupUrl: "", keyHelp: "Maak een token bij Test-DNS.",
    fields: [{ key: "token", label: "Token", secret: true }],
    dns: {
      async connect(f, zone) {
        if (f.token !== DNS_TOKEN) throw new Error("Test-DNS accepteert dit token niet");
        dns.zones.add(zone);
        return { nameservers: ["ns1.test-dns.example", "ns2.test-dns.example"] };
      },
      create: (name, f, zone) => ({
        name,
        async setRecords(sub, type, values) {
          if (dns.fail) throw new Error("Test-DNS is even weg");
          assert.equal(f.token, DNS_TOKEN);
          const k = `${sub ? `${sub}.` : ""}${zone} ${type}`;
          dns.writes.push(`${k}=${values.join(",")}`);
          if (values.length) dns.records.set(k, values); else dns.records.delete(k);
        },
      }),
    },
  });

  const { buildConsole } = await import(`../src/console/server.js?hub=${Date.now()}`);
  const aanbieder = await import("../src/console/aanbieder.js");
  const { Vault } = await import("../src/console/vault.js");
  const { consoleSettings } = await import("../src/cluster/admin.js");
  const app = await buildConsole();
  const c = client(app);
  const brokers: { close: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const b of brokers) await b.close().catch(() => {});
    await app.close(); await s3.close(); await up.close(); await smtp.close(); unregister();
    for (const k of ["EIGEN_TEST_S3", "EIGEN_SCW_API", "EIGEN_MOLLIE_URL", "EIGEN_DESEC_URL", "EIGEN_OPENPROVIDER_URL"]) delete process.env[k];
  });
  const vaultConfig = () => { const v = new Vault(process.env.EIGEN_VAULT!); v.unlock(PASS); return v.config!; };
  let r: Awaited<ReturnType<typeof c>>;

  await t.test("kluis alleen voor de Dienst: wachtwoordzin en herstelsleutel, geen cloudstappen", async () => {
    r = await c("POST", "/api/setup/aanbieder", { passphrase: "kort" });
    assert.match(r.json.error, /minstens 12 tekens/);
    r = await c("POST", "/api/setup/aanbieder", { passphrase: PASS });
    assert.equal(r.status, 200, r.text);
    assert.equal((await c("POST", "/api/setup/aanbieder", { passphrase: PASS })).status, 409, "één kluis");
    const st = (await c("GET", "/api/state")).json;
    assert.deepEqual([st.vault, st.unlocked, st.step, st.done, st.domain], [true, true, "sleutel", false, null]);
    const cfg = (await c("GET", "/api/config")).json;
    assert.equal(cfg.alleenDienst, true);
    assert.deepEqual([cfg.domain, cfg.stores, cfg.dns], [undefined, [], []]);
    const k = (await c("GET", "/api/key")).json;
    assert.equal(k.groups.length, 8);
    assert.equal((await c("POST", "/api/key/confirm", { g3: k.groups[2], g7: k.groups[6] })).status, 200);
    assert.equal((await c("POST", "/api/step", { step: "dienst" })).status, 200);
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual([v.started, v.defaultUrl, v.defaultEmail], [false, null, null]);
  });

  await t.test("stappen zonder cloud: geen mail van een cloud, het adres onder een eigen domein", async () => {
    r = await c("POST", "/api/aanbieder/bedrijf", { name: "ESAPE", address: "Coolsingel 1\n3011 AD Rotterdam", kvk: "12345678", email: "support@esape.nl" });
    assert.equal(r.status, 200, r.text);
    r = await c("POST", "/api/aanbieder/accounts", { scalewaySecretKey: SCW_KEY, scalewayOrgId: ORG, mollieKey: "test_mollie", desecToken: "desec-dienst" });
    assert.equal(r.json.ok, false, "zonder cloud is er geen mailserver vanzelf");
    assert.match(r.json.checks.find((x: any) => x.id === "smtp").detail, /Vul een mailserver in/);
    r = await c("POST", "/api/aanbieder/accounts", { smtpUrl: `smtp://127.0.0.1:${smtp.port}` });
    assert.equal(r.json.ok, true, JSON.stringify(r.json.checks));
    let v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.accounts.smtpFromCloud, false);
    r = await c("POST", "/api/aanbieder/adres", {});
    assert.match(r.json.error, /geldig adres|domeinnaam/, "geen standaardadres zonder cloud");
    r = await c("POST", "/api/aanbieder/adres", { url: "dienst.esape.nl" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.dns, { host: "dienst.esape.nl", sub: null, managed: false, value: null, mode: "handmatig", provider: null, zone: null });
    v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.accounts.mailFrom, "noreply@esape.nl", "afzender onder het domein van de Dienst");
    assert.deepEqual([v.cloudDns, v.alleenDienst, v.defaultZone, v.dnsKeuze, v.dnsLink, v.hub], [false, true, "esape.nl", null, null, null]);
  });

  await t.test("eigen DNS-koppeling: controleren, zone, bewaarde sleutel", async () => {
    r = await c("POST", "/api/aanbieder/dns", { provider: "cloud" });
    assert.match(r.json.error, /Je cloud kan dienst\.esape\.nl niet in de DNS zetten/);
    r = await c("POST", "/api/aanbieder/dns", { provider: "nergens" });
    assert.match(r.json.error, /Kies een DNS-aanbieder/);
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns" });
    assert.match(r.json.error, /Vul in: Token/);
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns", zone: "ander.nl", fields: { token: DNS_TOKEN } });
    assert.match(r.json.error, /dienst\.esape\.nl valt niet onder ander\.nl/);
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns", fields: { token: "fout" } });
    assert.match(r.json.error, /^Test-DNS: Test-DNS accepteert dit token niet/);
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns", fields: { token: ` ${DNS_TOKEN} ` } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, dns: { host: "dienst.esape.nl", sub: "dienst", managed: true, value: null, mode: "eigen", provider: "testdns", zone: "esape.nl" },
      nameservers: ["ns1.test-dns.example", "ns2.test-dns.example"], synced: null, detail: null });
    assert.deepEqual([...dns.zones], ["esape.nl"]);
    assert.equal(dns.writes.length, 0, "nog geen server: nog geen records");
    // Nog eens, zonder token: het bewaarde blijft.
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns", fields: { token: "••••••••heim" } });
    assert.equal(r.status, 200, r.text);
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual(v.dnsLink, { provider: "testdns", zone: "esape.nl", fields: ["token"], records: [], error: null, at: null, nameservers: ["ns1.test-dns.example", "ns2.test-dns.example"] });
    assert.equal(v.dnsKeuze, "testdns");
    assert.ok(!JSON.stringify(v).includes(DNS_TOKEN), "het token staat nooit in een antwoord");
    assert.ok(!(await c("GET", "/api/config")).text.includes(DNS_TOKEN));
  });

  let ip = "";
  await t.test("opzetten: de console zet dienst.esape.nl zelf bij de DNS-aanbieder", async () => {
    assert.equal((await c("POST", "/api/aanbieder/server", { provider: "scaleway", region: "nl-ams-1" })).status, 200);
    assert.equal((await c("POST", "/api/aanbieder/backup", { provider: "scaleway", region: "fr-par" })).status, 200);
    r = await c("POST", "/api/aanbieder/opzetten");
    assert.equal(r.status, 200, r.text);
    ip = r.json.server.ipv4;
    assert.ok(ip);
    assert.deepEqual(r.json.steps.at(-1), { label: `dienst.esape.nl wijst naar ${ip}`, ok: true, detail: "De console zet dit record bij Test-DNS" });
    assert.deepEqual([...dns.records], [["dienst.esape.nl A", [ip]]]);
    const bucket = [...s3.buckets.keys()].find((n) => n.startsWith("eigen-dienst-backup-"));
    assert.ok(bucket, "bucket met de naam van een kluis zonder cloud");
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual(v.dnsLink.records, [{ sub: "dienst", type: "A", value: ip }]);
    assert.deepEqual(JSON.parse(consoleSettings(vaultConfig()).extra_dns), [], "geen cloud: geen extra_dns");
    // Je dienst: alle onderdelen, links naar het beheer.
    assert.deepEqual(v.hub.map((x: any) => [x.id, x.waar, x.link]), [
      ["overzicht", "console", null], ["bedrijf", "console", null], ["accounts", "console", null],
      ["aanbod", "dienst", "https://dienst.esape.nl/beheer#/aanbod"], ["huisstijl", "dienst", "https://dienst.esape.nl/beheer#/huisstijl"],
      ["voorwaarden", "beide", "https://dienst.esape.nl/beheer#/voorwaarden"], ["medewerkers", "dienst", "https://dienst.esape.nl/beheer#/medewerkers"], ["klanten", "dienst", "https://dienst.esape.nl/beheer#/klanten"],
      ["hulpvragen", "dienst", "https://dienst.esape.nl/beheer#/hulpvragen"], ["berichten", "dienst", "https://dienst.esape.nl/beheer#/berichten"],
      ["adressendienst", "beide", null], ["lijst", "beide", "https://dienst.esape.nl/beheer#/lijst"],
      ["server", "console", null], ["kosten", "beide", "https://dienst.esape.nl/beheer#/kosten"], ["updates", "console", null],
    ]);
    assert.deepEqual([v.wijzigingen, v.pending], ["geen", []]);
    // De herstelkopie van de kluis staat in de back-upbucket (versleuteld met de herstelsleutel).
    for (let i = 0; i < 50 && !s3.buckets.get(bucket!)?.objects.has("admin-config.enc"); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(s3.buckets.get(bucket!)?.objects.has("admin-config.enc"), "herstelkopie in de back-upbucket");
  });

  // Een echte Dienst met de omgeving uit de user-data (back-ups naar de nep-S3).
  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const startDienst = async (dir: string, env: Record<string, string>) => {
    const e = { ...env, BROKER_DATA_DIR: dir, BROKER_PORT: String(await freePort()), BROKER_LOOP_MS: "600000", BROKER_BACKUP_EVERY_MS: "600000", BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
      SCW_API_URL: `${U}/scw`, MOLLIE_API_URL: `${U}/mollie`, DESEC_URL: `${U}/desec` };
    const { restoreIfEmpty } = await import("../src/broker/backup.js");
    await restoreIfEmpty(e);
    const cfg = loadConfig(e);
    const b = await createBroker(cfg);
    await b.app.listen({ port: cfg.port, host: "127.0.0.1" });
    brokers.push(b);
    aanbieder.aanbiederNet.reach = () => `http://127.0.0.1:${cfg.port}`;
    return { b, cfg };
  };
  let dienst: Awaited<ReturnType<typeof startDienst>>;

  await t.test("overzicht: status met kerncijfers uit de Dienst; hersteltest", async () => {
    const env = envFromUserData(up.st.scw.userData.get(up.st.scw.servers[0].id)!);
    assert.equal(env.BROKER_MAIL_FROM, "ESAPE <noreply@esape.nl>");
    dienst = await startDienst(path.join(base, "dienst-1"), env);
    dienst.b.startLoops();
    aanbieder.aanbiederNet.resolve4 = async () => [ip];
    for (let i = 0; i < 50 && !dienst.b.backup!.lastBackupAt; i++) await new Promise((res) => setTimeout(res, 50));
    r = await c("GET", "/api/aanbieder/status");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.dns, { host: "dienst.esape.nl", want: ip, have: [ip], ok: true, mode: "eigen", error: null });
    assert.deepEqual(Object.keys(r.json.overzicht).sort(), ["achterstanden", "actief", "bundels", "klanten", "omzetMaand", "openHulpvragen", "version"]);
    assert.deepEqual([r.json.overzicht.klanten, r.json.overzicht.actief, r.json.overzicht.omzetMaand.net], [0, 0, "0.00"]);
    // Zonder het beheertoken: niets.
    const bad = await fetch(`http://127.0.0.1:${dienst.cfg.port}/v1/status/overzicht`, { headers: { authorization: "Beheer " + "0".repeat(64) } });
    assert.equal(bad.status, 401);
    r = await c("POST", "/api/aanbieder/hersteltest");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.json.detail);
    assert.match(r.json.detail, /^Terug te zetten: aanbieder\.key, dienst\.sqlite \(database \d+ KB\)$/);
    assert.equal(r.json.backupAt, dienst.b.backup!.lastBackupAt);
    assert.deepEqual((await c("GET", "/api/aanbieder")).json.hersteltest, r.json);
  });

  await t.test("nog niet toegepast: per onderdeel, en weer leeg na toepassen", async () => {
    let v = (await c("GET", "/api/aanbieder")).json;
    assert.equal((await c("POST", "/api/aanbieder/bedrijf", { ...v.company, vatPercent: "9" })).status, 200);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual([v.wijzigingen, v.pending], ["toepassen", ["bedrijf"]]);
    assert.equal(v.hub.find((x: any) => x.id === "bedrijf").pending, true);
    assert.equal(v.hub.find((x: any) => x.id === "accounts").pending, false);
    assert.equal((await c("POST", "/api/aanbieder/accounts", { mailFrom: "dienst@esape.nl" })).json.ok, true);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual(v.pending, ["bedrijf", "accounts"]);
    r = await c("POST", "/api/aanbieder/toepassen");
    assert.equal(r.status, 200, r.text);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual([v.wijzigingen, v.pending], ["geen", []]);
    // Een andere plek voor de server: dat vraagt een nieuwe server.
    assert.equal((await c("POST", "/api/aanbieder/server", { provider: "scaleway", region: "fr-par-1" })).status, 200);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual([v.wijzigingen, v.pending], ["opnieuw", ["server"]]);
    assert.equal((await c("POST", "/api/aanbieder/server", { provider: "scaleway", region: "nl-ams-1" })).status, 200);
    assert.equal((await c("GET", "/api/aanbieder")).json.wijzigingen, "geen");
  });

  await t.test("ander IP-adres: de console werkt het record bij (ook na een storing bij de DNS-aanbieder)", async () => {
    // De server krijgt (bijv. na opnieuw opzetten) een ander IP-adres; de DNS-aanbieder is eerst even weg.
    const cfgNow = vaultConfig() as any;
    const v = new Vault(process.env.EIGEN_VAULT!);
    v.unlock(PASS);
    (v.config!.console as any).aanbieder.server.ipv4 = "192.0.2.99";
    (v.config!.console as any).aanbieder.server.ipv6 = "2001:db8::99";
    v.save();
    assert.ok(cfgNow);
    await c("POST", "/api/lock");
    assert.equal((await c("POST", "/api/unlock", { passphrase: PASS })).status, 200);
    dns.fail = true;
    r = await c("GET", "/api/aanbieder/status");
    assert.equal(r.json.dns.error, "Test-DNS: Test-DNS is even weg");
    assert.equal((await c("GET", "/api/aanbieder")).json.dnsLink.error, "Test-DNS: Test-DNS is even weg");
    dns.fail = false;
    r = await c("GET", "/api/aanbieder/status");
    assert.equal(r.json.dns.error, null);
    assert.deepEqual([...dns.records], [["dienst.esape.nl A", ["192.0.2.99"]], ["dienst.esape.nl AAAA", ["2001:db8::99"]]]);
    assert.deepEqual((await c("GET", "/api/aanbieder")).json.dnsLink.records, [{ sub: "dienst", type: "A", value: "192.0.2.99" }, { sub: "dienst", type: "AAAA", value: "2001:db8::99" }]);
    const n = dns.writes.length;
    await c("GET", "/api/aanbieder/status");
    assert.equal(dns.writes.length, n, "niets gewijzigd: niets geschreven");
  });

  await t.test("herstellen op een nieuw toestel met de herstelkopie in de back-upbucket", async () => {
    const cfg = vaultConfig() as any;
    const bk = cfg.console.aanbieder.backup;
    const vault2 = path.join(base, "kluis-2.json");
    process.env.EIGEN_VAULT = vault2;
    const { buildConsole: build2 } = await import(`../src/console/server.js?hub2=${Date.now()}`);
    const app2 = await build2();
    try {
      const c2 = client(app2);
      const key = cfg.masterKey.match(/.{8}/g).join(" ");
      r = await c2("POST", "/api/setup/recover", { masterKey: key, passphrase: PASS, store: { name: "herstel", type: "s3", purpose: "replica", endpoint: bk.endpoint, region: bk.region, bucket: bk.bucket, accessKey: bk.accessKey, secretKey: bk.secretKey } });
      assert.equal(r.status, 200, r.text);
      const st = (await c2("GET", "/api/state")).json;
      assert.deepEqual([st.done, st.step], [false, "dienst"], "geen cloud: niet als klaar gemarkeerd");
      assert.equal((await c2("GET", "/api/config")).json.alleenDienst, true);
      const v = (await c2("GET", "/api/aanbieder")).json;
      assert.equal(v.company.name, "ESAPE");
      assert.ok([ip, "192.0.2.99"].includes(v.server.ipv4), "de kopie heeft de draaiende Dienst");
    } finally {
      await app2.close();
      process.env.EIGEN_VAULT = path.join(base, "kluis.json");
    }
  });

  await t.test("opnieuw beginnen kan niet zolang de Dienst in de kluis staat", async () => {
    r = await c("POST", "/api/setup/reset", { cleanup: false });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Eigen Cloud Dienst/);
  });

  await t.test("andere keuze voor de DNS: de oude records gaan weg", async () => {
    r = await c("POST", "/api/aanbieder/dns", { provider: "handmatig" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.detail, null);
    assert.equal(dns.records.size, 0, "records weg bij Test-DNS");
    let v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual([v.dnsKeuze, v.dnsLink, v.dns.mode], ["handmatig", null, "handmatig"]);
    r = await c("POST", "/api/aanbieder/dns", { provider: "testdns", fields: { token: DNS_TOKEN } });
    assert.equal(r.json.synced, true);
    assert.deepEqual([...dns.records.keys()], ["dienst.esape.nl A", "dienst.esape.nl AAAA"]);
    v = (await c("GET", "/api/aanbieder")).json;
    assert.equal(v.dnsKeuze, "testdns");
  });

  await t.test("verwijderen: de console haalt de records weg", async () => {
    r = await c("POST", "/api/aanbieder/verwijderen", { confirm: "dienst.esape.nl" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.dns, true);
    assert.equal(dns.records.size, 0);
    const v = (await c("GET", "/api/aanbieder")).json;
    assert.deepEqual(v.dnsLink.records, []);
    assert.equal(v.hub.find((x: any) => x.id === "klanten").link, null, "geen server: geen links naar het beheer");
  });

  await t.test("later toch een eigen cloud: dezelfde kluis, verder bij Waar je cloud draait", async () => {
    r = await c("POST", "/api/setup/cloud", { domain: "vanes.nl", mailbox: "rene", appPassword: "kort" });
    assert.match(r.json.error, /minstens 10 tekens/);
    r = await c("POST", "/api/setup/cloud", { domain: "vanes.nl", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.step, "regelen", "herstelsleutel is al bevestigd");
    const cfg = (await c("GET", "/api/config")).json;
    assert.deepEqual([cfg.alleenDienst, cfg.domain, cfg.mailFrom, cfg.cluster], [false, "vanes.nl", "rene@vanes.nl", "vanes"]);
    assert.equal((await c("GET", "/api/aanbieder")).json.company.name, "ESAPE", "de Dienst blijft");
    assert.equal((await c("POST", "/api/setup/cloud", { domain: "x.nl", mailbox: "a", appPassword: "mijn-cloud-wachtwoord" })).status, 409);
  });
});

test("cloud met DNS en een eigen DNS-koppeling voor de Dienst: de cloud haalt alleen namen buiten die zone weg", async () => {
  const { aanbiederDns } = await import("../src/cluster/admin.js");
  const c = { domain: "vanes.nl", console: { aanbieder: { url: "https://dienst.vanes.nl", server: { ipv4: "192.0.2.1" }, dnsRemove: ["oud"], adressen: { host: "adressen.vanes.nl" } } } };
  assert.deepEqual(aanbiederDns(c as never).map((x) => `${x.sub} ${x.type} ${x.value}`), ["oud A ", "oud AAAA ", "dienst A 192.0.2.1", "dienst AAAA ", "adressen A 192.0.2.1", "adressen AAAA "]);
  (c.console.aanbieder as any).dns = { zone: "vanes.nl" };
  assert.deepEqual(aanbiederDns(c as never), [], "alles valt onder de eigen koppeling");
  (c.console.aanbieder as any).dns = { zone: "dienst.vanes.nl" };
  assert.deepEqual(aanbiederDns(c as never).map((x) => `${x.sub} ${x.type} ${x.value}`), ["oud A ", "oud AAAA ", "adressen A ", "adressen AAAA "]);
});

test("Je dienst: onderdelen en links (zonder Dienst geen hub)", async () => {
  const a = await import("../src/console/aanbieder.js");
  assert.equal(a.beheerLink("https://dienst.esape.nl", "klanten"), "https://dienst.esape.nl/beheer#/klanten");
  assert.deepEqual([a.defaultZone("dienst.esape.nl"), a.defaultZone("esape.nl"), a.defaultZone("a.b.esape.nl"), a.defaultZone(null)], ["esape.nl", "esape.nl", "b.esape.nl", null]);
  assert.deepEqual(a.HUB.map(([id]) => id), ["overzicht", "bedrijf", "accounts", "aanbod", "huisstijl", "voorwaarden", "medewerkers", "klanten", "hulpvragen", "berichten", "adressendienst", "lijst", "server", "kosten", "updates"]);
  assert.deepEqual(a.ownDnsWant({ step: "klaar", url: "https://dienst.esape.nl", dns: { provider: "x", zone: "esape.nl", fields: {} }, server: { provider: "p", region: "r", size: "s", serverId: "1", ipv4: "192.0.2.1", createdAt: 1 }, adressen: { zone: "eigencloud.nl", desecToken: "t", host: "esape.nl" } }),
    [{ sub: "dienst", type: "A", value: "192.0.2.1" }, { sub: "dienst", type: "AAAA", value: "" }, { sub: "", type: "A", value: "192.0.2.1" }, { sub: "", type: "AAAA", value: "" }]);
});

test("plaatsing van servers per bundel: regio's, formaten met prijzen, controles", { timeout: 60_000 }, async (t) => {
  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const { ensureOwner } = await import("../src/broker/staff.js");
  const pl = await import("../src/broker/placement.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaatsing-"));
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  const port = await freePort();
  const cfg = loadConfig({ BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: `http://127.0.0.1:${port}`, SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`, BROKER_LOOP_MS: "600000" });
  const b = await createBroker(cfg);
  t.after(async () => { await b.close(); await up.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sizes = await pl.placementSizes(b.ctx);
  assert.deepEqual(sizes["nl-ams-1"].map((s) => s.size), ["STARDUST1-S", "DEV1-S", "DEV1-M", "PLAY2-MICRO"], "live van Scaleway (via SCW_API_URL van de Dienst)");
  const o = await pl.placementOptions(b.ctx);
  assert.equal(o.error, null);
  assert.deepEqual(o.regions.map((r) => r.id), ["nl-ams-1", "nl-ams-2", "nl-ams-3", "fr-par-1", "pl-waw-1"]);
  assert.deepEqual(o.storage.map((r) => r.id), ["nl-ams", "fr-par", "pl-waw"]);
  const ok = [{ kind: "data", region: "nl-ams-1", size: "dev1-s" }, { kind: "data", region: "fr-par-1", size: "DEV1-M" }, { kind: "witness", region: "pl-waw-1", size: "STARDUST1-S" }];
  assert.deepEqual(pl.checkPlacement(ok, sizes), [
    { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", country: "NL", kind: "data" },
    { provider: "scaleway", region: "fr-par-1", size: "DEV1-M", country: "FR", kind: "data" },
    { provider: "scaleway", region: "pl-waw-1", size: "STARDUST1-S", country: "PL", kind: "witness" },
  ]);
  const err = (p: unknown) => { try { pl.checkPlacement(p, sizes); return ""; } catch (e) { return (e as Error).message; } };
  assert.match(err([]), /minstens drie servers/);
  assert.match(err([ok[0], ok[2]]), /minstens twee servers met gegevens/);
  assert.match(err([ok[0], ok[1]]), /witness/);
  assert.match(err([ok[0], ok[1], { ...ok[2], region: "us-east-1" }]), /Server 3: kies een regio/);
  assert.match(err([ok[0], ok[1], { ...ok[2], size: "GROOT9" }]), /Server 3: formaat GROOT9 bestaat niet in Warschau 1/);
  assert.match(err([{ ...ok[0], size: "STARDUST1-S" }, ok[1], ok[2]]), /Server 1: een server met gegevens heeft minstens 2 GB geheugen nodig \(STARDUST1-S heeft 1 GB\)/);
  assert.match(err([ok[0], ok[1], { ...ok[2], kind: "x" }]), /Server 3: kies "gegevens" of "witness"/);
  assert.match(err(Array(10).fill(ok[0])), /Hooguit 9 servers/);
  assert.doesNotThrow(() => pl.checkPlacement([ok[0], ok[1], { ...ok[2], size: "WHATEVER-1" }], null), "zonder prijzen: alleen de vorm");
  assert.deepEqual(pl.checkStorage([{ region: "nl-ams", purpose: "replica" }, { region: "pl-waw", purpose: "backup" }]), [{ region: "nl-ams", purpose: "replica" }, { region: "pl-waw", purpose: "backup" }]);
  assert.throws(() => pl.checkStorage([{ region: "nl-ams", purpose: "replica" }, { region: "nl-ams", purpose: "backup" }]), /andere plek/);
  assert.throws(() => pl.checkStorage([{ region: "nl-ams", purpose: "replica" }]), /één plek/);
  assert.throws(() => pl.checkStorage([{ region: "maan", purpose: "replica" }]), /plek voor de opslag/);

  // Via het beheer (rol beheer heeft "offering").
  await b.app.listen({ port, host: "127.0.0.1" });
  ensureOwner(b.ctx, "eigenaar@esape.nl", "test");
  const crypto = await import("node:crypto");
  const staff = b.ctx.db.prepare("SELECT id FROM staff WHERE email = ?").get("eigenaar@esape.nl") as { id: string };
  const token = crypto.randomBytes(32).toString("hex");
  const { sha256 } = await import("../src/broker/db.js");
  // Een sessie zoals na inloggen (code + tweede stap), rechtstreeks in de database.
  const cols = (b.ctx.db.prepare("PRAGMA table_info(staff_sessions)").all() as { name: string }[]).map((x) => x.name);
  const row: Record<string, unknown> = { token_hash: sha256(token), staff_id: staff.id, created_at: Date.now(), expires_at: Date.now() + 3600_000, last_used_at: Date.now() };
  const use = cols.filter((k) => k in row);
  b.ctx.db.prepare(`INSERT INTO staff_sessions (${use.join(",")}) VALUES (${use.map(() => "?").join(",")})`).run(...use.map((k) => row[k]));
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Staff ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  let r = await api("GET", "/v1/admin/placement");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.regions[0].sizes[1].monthly, 6.42);
  r = await api("PUT", "/v1/admin/bundles/compleet", { placement: [ok[0], ok[2]] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /minstens twee servers met gegevens/);
  r = await api("PUT", "/v1/admin/bundles/compleet", { placement: [...ok, { kind: "data", region: "nl-ams-2", size: "PLAY2-MICRO" }], storage: [{ region: "nl-ams", purpose: "replica" }, { region: "pl-waw", purpose: "backup" }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const bundle = b.ctx.cfg.bundles.find((x) => x.id === "compleet")!;
  assert.deepEqual([bundle.includes.dataServers, bundle.includes.witnesses], [3, 1], "aantallen volgen de servers");
  assert.deepEqual(bundle.storage, [{ region: "nl-ams", purpose: "replica" }, { region: "pl-waw", purpose: "backup" }]);
  assert.equal(b.ctx.cfg.costs.servers["STARDUST1-S"], "0.50", "ontbrekende prijs aangevuld uit de live prijzen");
  assert.equal(b.ctx.cfg.costs.servers["DEV1-S"], "4.50", "bestaande prijs blijft");
});
