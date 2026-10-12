/**
 * Alles via de app, voor een aanbieder en de beheerder van het project:
 *  - de lijst van aanbieders met een standaardaanbieder ("standaard": true) die de app alleen aanbiedt als hij antwoordt;
 *  - de gratis-adressendienst op de server van een Dienst: vertrouwt de eigen Dienst (ook vóór de lijst), beheer in
 *    /beheer (namen, logboek, vrijgeven), mee in de back-up van de Dienst, en "Op de lijst" met de hele nieuwe lijst;
 *  - Diensten vinden de adressendienst via de lijst ("adressen" op de standaardregel);
 *  - instellingen van een draaiende Dienst wijzigen zonder nieuwe server (POST /v1/status/instellingen);
 *  - de console: de adressendienst aanzetten (live gecontroleerd bij deSEC) en het opstartscript daarmee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { freePort } from "./helpers/cluster.js";
import { fakeUpstream } from "./helpers/broker-fakes.js";
import { fakeS3 } from "./helpers/fake-s3.js";

/** Kleine HTTP-server met een vaste handler; geeft het adres. */
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

test("lijst van aanbieders: standaard vooraan, alleen als hij antwoordt", { timeout: 60_000 }, async (t) => {
  let up = false;
  const dienst = await serve((req, res) => (up && req.url === "/v1/info" ? json(res, 200, { name: "ESAPE", bundles: [], freeZone: null }) : json(res, 503, { error: "nog niet" })));
  let lijst: unknown[] = [];
  const list = await serve((_req, res) => json(res, 200, lijst));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aanbieders-"));
  process.env.EIGEN_AANBIEDERS_URL = `${list.url}/aanbieders.json`;
  process.env.EIGEN_VAULT = path.join(base, "kluis.json");
  delete process.env.EIGEN_DIENST_URL;
  const extras = await import("../src/console/extras.js");
  // Zelfde lijst als in de Java-test (scripts/android-dienst.ts, /aanbieders-standaard.json).
  lijst = [{ naam: "Ander", url: "http://127.0.0.1:1" }, { naam: "Dienst Test", url: `${dienst.url}/`, land: "NL", standaard: true, adressen: "https://adressen.example" }, { naam: "Ook standaard", url: "http://127.0.0.1:2/", standaard: true }];
  extras.resetAanbiedersCache();
  const { buildConsole } = await import(`../src/console/server.js?aanbieders=${Date.now()}`);
  const app = await buildConsole();
  await new Promise((res) => setTimeout(res, 300)); // de console haalt de lijst bij het starten alvast op
  t.after(async () => { await app.close(); await dienst.close(); await list.close(); delete process.env.EIGEN_AANBIEDERS_URL; delete process.env.EIGEN_DIENST_URL; extras.resetAanbiedersCache(); });
  const get = async (url: string) => { const r = await app.inject({ method: "GET", url }); return { status: r.statusCode, json: r.json() as any }; };

  let r = await get("/api/aanbieders");
  assert.deepEqual(r.json.aanbieders, [
    { naam: "Dienst Test", url: dienst.url, land: "NL", standaard: true, adressen: "https://adressen.example", bereikbaar: false },
    { naam: "Ander", url: "http://127.0.0.1:1", bereikbaar: false },
    { naam: "Ook standaard", url: "http://127.0.0.1:2", bereikbaar: false },
  ], "standaard vooraan, alleen de eerste telt; niemand antwoordt nog");
  assert.equal(extras.defaultDienst(), "", "een standaard die niet antwoordt, is geen standaard");
  assert.equal((await get("/api/state")).json.dienst, false, "de app biedt geen aanbieder aan");
  assert.equal((await get("/api/dienst/info")).status, 502, "geen standaard: geen info");

  // De Dienst start; na het onthouden (2 minuten, hier meteen) wordt hij vanzelf de standaard.
  up = true;
  r = await get("/api/aanbieders");
  assert.equal(r.json.aanbieders[0].bereikbaar, false, "onbereikbaar wordt even onthouden");
  extras.resetAanbiedersCache();
  r = await get("/api/aanbieders");
  assert.deepEqual(r.json.aanbieders.map((a: any) => [a.naam, a.bereikbaar]), [["Dienst Test", true], ["Ander", false], ["Ook standaard", false]]);
  assert.equal(extras.defaultDienst(), dienst.url);
  assert.equal(extras.baseOf(null), dienst.url, "zonder keuze: de standaard uit de lijst");
  assert.equal((await get("/api/state")).json.dienst, true);
  assert.equal((await get("/api/dienst/info")).json.name, "ESAPE", "de standaard beantwoordt de eerste stap");

  // DIENST_URL (of EIGEN_DIENST_URL) gaat altijd voor.
  process.env.EIGEN_DIENST_URL = "http://127.0.0.1:3";
  r = await get("/api/aanbieders");
  assert.deepEqual(r.json.aanbieders.slice(0, 2).map((a: any) => [a.naam, a.url]), [["Eigen Cloud Dienst", "http://127.0.0.1:3"], ["Dienst Test", dienst.url]]);
  assert.equal(extras.defaultDienst(), "http://127.0.0.1:3");
  delete process.env.EIGEN_DIENST_URL;

  // Zonder lijst op internet: de lijst uit de repository (ESAPE, standaard).
  process.env.EIGEN_AANBIEDERS_URL = "http://127.0.0.1:1/aanbieders.json";
  extras.resetAanbiedersCache();
  r = await get("/api/aanbieders");
  const repo = JSON.parse(fs.readFileSync(new URL("../aanbieders.json", import.meta.url), "utf8"));
  assert.deepEqual(r.json.aanbieders.map((a: any) => [a.naam, a.url, a.standaard]), repo.map((a: any) => [a.naam, a.url, a.standaard]));
  assert.equal(repo.filter((a: any) => a.standaard === true).length, 1, "aanbieders.json: precies één standaard");
  assert.deepEqual(Object.keys(repo[0]).sort(), ["adressen", "contact", "land", "naam", "omschrijving", "standaard", "url"]);
});

test("adressendienst op de server van de Dienst: eigen Dienst vertrouwd, beheer in de app, mee in de back-up", { timeout: 90_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adressen-lokaal-"));
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.desecAccount("desec-centraal", "centraal");
  up.st.desec.zones.set("eigencloud.test", { name: "eigencloud.test", account: "centraal", keys: [], rrsets: new Map() });
  const s3 = fakeS3();
  const S3 = `http://127.0.0.1:${await s3.listening}`;
  s3.buckets.set("dienst-backup", { lock: false, versioning: false, retentionDays: 0, objects: new Map() } as never);

  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const { loadAdresConfig } = await import("../src/adressen/config.js");
  const { createAdressen } = await import("../src/adressen/app.js");
  const { signHeaders, publicKeyB64 } = await import("../src/adressen/sign.js");
  const { sha256 } = await import("../src/broker/db.js");
  const { ensureOwner } = await import("../src/broker/staff.js");
  const { restoreLatest, backupStore, backupKey } = await import("../src/broker/backup.js");

  // Een andere aanbieder op de lijst; deze Dienst (nog) niet.
  const keyB = crypto.generateKeyPairSync("ed25519").privateKey;
  const listFile = path.join(dir, "lijst.json");
  fs.writeFileSync(listFile, JSON.stringify([{ naam: "Aanbieder B", url: "https://dienst-b.test", sleutel: publicKeyB64(keyB) }]));
  const port = await freePort(), aport = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`, ADRES = `http://127.0.0.1:${aport}`;
  const dienstDir = path.join(dir, "dienst"), adresDir = path.join(dir, "adressen");
  fs.mkdirSync(dienstDir, { recursive: true });
  const SECRET = crypto.randomBytes(32).toString("hex");
  const env = {
    BROKER_DATA_DIR: dienstDir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC, BROKER_SECRET: SECRET,
    BROKER_ADRES_URL: ADRES, BROKER_ADRES_PUBLIEK: "https://adressen.vanes.test", BROKER_BACKUP_ADRESSEN: path.join(adresDir, "adressen.sqlite"),
    BROKER_BACKUP_ENDPOINT: S3, BROKER_BACKUP_BUCKET: "dienst-backup", BROKER_BACKUP_ACCESS_KEY: "a", BROKER_BACKUP_SECRET_KEY: "s", BROKER_BACKUP_EVERY_MS: "600000",
    MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`, DESEC_TOKEN: "desec-dienst", DESEC_URL: `${U}/desec`, BROKER_LOOP_MS: "600000", BROKER_LIST_URL: "uit",
  };
  const cfg = loadConfig(env);
  const broker = await createBroker(cfg);
  await broker.app.listen({ port, host: "127.0.0.1" });
  const svc = await createAdressen(loadAdresConfig({
    ADRES_ZONE: "eigencloud.test", ADRES_DESEC_TOKEN: "desec-centraal", ADRES_DESEC_URL: `${U}/desec`, ADRES_PORT: String(aport), ADRES_DATA_DIR: adresDir,
    ADRES_LIST_URL: listFile, ADRES_PUBLIC_URL: "https://adressen.vanes.test", ADRES_LOKAAL_DIENST: `${PUBLIC}/`, ADRES_LOKAAL_SLEUTEL: path.join(dienstDir, "aanbieder.key"),
  }));
  await svc.app.listen({ port: aport, host: "127.0.0.1" });
  let lijst: unknown[] = [];
  const list = await serve((_req, res) => json(res, 200, lijst));
  process.env.EIGEN_AANBIEDERS_URL = `${list.url}/aanbieders.json`;
  t.after(async () => { await broker.close(); await svc.close(); await up.close(); await s3.close(); await list.close(); delete process.env.EIGEN_AANBIEDERS_URL; fs.rmSync(dir, { recursive: true, force: true }); });

  // Eigenaar met een sessie (het inloggen zelf staat in dienst-beheer.test.ts).
  const owner = ensureOwner(broker.ctx, "eigenaar@vanes.test", "test").staff;
  const tok = crypto.randomBytes(32).toString("hex");
  broker.ctx.db.prepare("INSERT INTO staff_sessions (token_hash, staff_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(sha256(tok), owner.id, Date.now(), Date.now());
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(PUBLIC + p, { method, headers: { authorization: `Staff ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let j: any = null; try { j = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json: j, text };
  };

  await t.test("de eigen Dienst vraagt een adres aan, ook zonder regel op de lijst; anderen mogen het beheer niet", async () => {
    const a = broker.ctx.apis.adres!;
    const n = await a.create("vanes", "bestelling-1");
    assert.equal(n.naam, "vanes.eigencloud.test");
    assert.ok(up.st.desec.zones.has("vanes.eigencloud.test"));
    assert.equal((await a.beheerStatus()).namen.actief, 1);
    // Aanbieder B (wel op de lijst) mag het beheer niet gebruiken.
    const p = "/v1/beheer/status";
    const r = await fetch(ADRES + p, { headers: signHeaders(keyB, "https://dienst-b.test", "GET", p, "") });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Alleen de Dienst op deze server/);
  });

  await t.test("beheer in de app: status, namen, logboek, vrijgeven", async () => {
    assert.equal((await api("GET", "/v1/admin/me")).json.adressendienst, true);
    let r = await api("GET", "/v1/admin/adressendienst");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status.zone, "eigencloud.test");
    assert.equal(r.json.status.zoneOk, true);
    assert.deepEqual(r.json.namen.map((x: any) => [x.naam, x.status, x.dienst, x.ref]), [["vanes.eigencloud.test", "actief", PUBLIC, "bestelling-1"]]);
    assert.deepEqual(r.json.aanbieders.aanbieders.map((x: any) => [x.naam, x.sleutel]), [["Aanbieder B", true]]);
    r = await api("GET", "/v1/admin/adressendienst/logboek?naam=vanes");
    assert.deepEqual(r.json.logboek.map((x: any) => x.actie), ["aangemaakt"]);
    assert.equal((await api("POST", "/v1/admin/adressendienst/namen/vanes/vrijgeven", {})).status, 400, "eerst bevestigen");
    r = await api("POST", "/v1/admin/adressendienst/namen/vanes/vrijgeven", { sure: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.naam, "vanes.eigencloud.test");
    assert.ok(!up.st.desec.zones.has("vanes.eigencloud.test"), "zone weg");
    assert.equal((await api("POST", "/v1/admin/adressendienst/namen/vanes/vrijgeven", { sure: true })).status, 404);
    assert.ok(broker.ctx.db.prepare("SELECT 1 FROM audit WHERE action = 'adres-vrijgeven'").get());
  });

  await t.test("de database van de adressendienst gaat mee in de back-up van de Dienst", async () => {
    await broker.ctx.apis.adres!.create("bakker", "bestelling-2");
    const b = await broker.backup!.run();
    assert.ok(b);
    const to = path.join(dir, "terug"), toA = path.join(dir, "terug-adressen", "adressen.sqlite");
    const r = await restoreLatest(backupStore(cfg.backup!), backupKey(Buffer.from(SECRET, "hex")), to, toA);
    assert.ok(r);
    assert.ok(fs.existsSync(path.join(to, "dienst.sqlite")) && fs.existsSync(path.join(to, "aanbieder.key")));
    const Database = (await import("better-sqlite3")).default;
    const adb = new Database(toA, { readonly: true });
    assert.deepEqual(adb.prepare("SELECT naam, status FROM namen ORDER BY naam").all(), [{ naam: "bakker.eigencloud.test", status: "actief" }, { naam: "vanes.eigencloud.test", status: "vrijgegeven" }]);
    adb.close();
  });

  await t.test("Op de lijst: regel met de adressendienst, standaard behouden, de hele nieuwe lijst", async () => {
    lijst = [{ naam: "Ander", url: "https://ander.test" }, { naam: "ESAPE", url: `${PUBLIC}/`, land: "NL", contact: "support@vanes.test", omschrijving: "Vanuit Rotterdam.", standaard: true, sleutel: "oud" }];
    const r = await api("GET", "/v1/admin/lijst");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.opLijst, true);
    assert.equal(r.json.sleutelKlopt, false);
    assert.equal(r.json.actueel, false);
    assert.equal(r.json.entry.standaard, true, "standaard blijft staan");
    assert.equal(r.json.entry.adressen, "https://adressen.vanes.test");
    assert.equal(r.json.entry.omschrijving, "Vanuit Rotterdam.");
    assert.equal(r.json.entry.sleutel, cfg.providerPublicKey);
    const nieuw = JSON.parse(r.json.nieuweLijst);
    assert.equal(nieuw.length, 2);
    assert.deepEqual(nieuw[1], r.json.entry);
    assert.deepEqual(nieuw[0], lijst[0]);
  });
});

test("Diensten vinden de adressendienst via de lijst (alleen met hun eigen regel en sleutel)", async (t) => {
  const { adresUitLijst, discoverAdres } = await import("../src/broker/adres.js");
  const key = "MCowBQYDK2VwAyEAsleutel";
  const std = { naam: "ESAPE", url: "https://dienst.esape.nl", standaard: true, adressen: "https://adressen.esape.nl/" };
  assert.equal(adresUitLijst([std, { url: "https://dienst.vanes.nl/", sleutel: key }], "https://Dienst.Vanes.nl", key), "https://adressen.esape.nl");
  assert.equal(adresUitLijst([std, { url: "https://dienst.vanes.nl", sleutel: "andere" }], "https://dienst.vanes.nl", key), null, "andere sleutel");
  assert.equal(adresUitLijst([std], "https://dienst.vanes.nl", key), null, "niet op de lijst");
  assert.equal(adresUitLijst([{ ...std, adressen: "http://onveilig.test" }, { url: "https://dienst.vanes.nl", sleutel: key }], "https://dienst.vanes.nl", key), null, "alleen https");
  assert.equal(adresUitLijst([{ ...std, standaard: undefined }, { url: "https://dienst.vanes.nl", sleutel: key }], "https://dienst.vanes.nl", key), null, "alleen van de standaardregel");

  let lijst: unknown[] = [];
  const list = await serve((_req, res) => json(res, 200, lijst));
  t.after(() => list.close());
  const ctx: any = { cfg: { adresFromEnv: false, listUrl: `${list.url}/x.json`, adresUrl: null, publicUrl: "https://dienst.vanes.nl", providerPublicKey: key, providerKey: crypto.generateKeyPairSync("ed25519").privateKey }, apis: { adres: null } };
  lijst = [std, { naam: "Van Es", url: "https://dienst.vanes.nl", sleutel: key }];
  assert.equal(await discoverAdres(ctx), "https://adressen.esape.nl");
  assert.ok(ctx.apis.adres, "client gemaakt");
  lijst = [std];
  assert.equal(await discoverAdres(ctx), null, "van de lijst gehaald: geen gratis adressen meer aanbieden");
  assert.equal(ctx.apis.adres, null);
  ctx.cfg.adresFromEnv = true; ctx.cfg.adresUrl = "https://vast.test";
  lijst = [std, { naam: "Van Es", url: "https://dienst.vanes.nl", sleutel: key }];
  assert.equal(await discoverAdres(ctx), "https://vast.test", "BROKER_ADRES_URL gaat voor");
});

test("instellingen van een draaiende Dienst wijzigen zonder nieuwe server", { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instellingen-"));
  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const { beheerToken } = await import("../src/console/aanbieder.js");
  const { applyOverride } = await import("../src/broker/instellingen.js");
  const port = await freePort();
  const SECRET = crypto.randomBytes(32).toString("hex");
  const env: Record<string, string> = { BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_SECRET: SECRET, MOLLIE_API_KEY: "test_oud", OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "x", BROKER_LOOP_MS: "600000", BROKER_ENV_AT: "1000", BROKER_LIST_URL: "uit" };
  let restarts = 0;
  const broker = await createBroker(loadConfig(env), { restart: () => { restarts++; } });
  await broker.app.listen({ port, host: "127.0.0.1" });
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (body: unknown, auth = `Beheer ${beheerToken(SECRET)}`) => fetch(`http://127.0.0.1:${port}/v1/status/instellingen`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await post({ at: 2000, env: {} }, "Beheer fout")).status, 401);
  let r = await post({ at: 2000, env: { BROKER_SECRET: "ab".repeat(32) } });
  assert.equal(r.status, 400, "het geheim hoort bij de server");
  assert.match((await r.json()).error, /BROKER_SECRET kan zo niet/);
  r = await post({ at: 2000, env: { MOLLIE_API_KEY: "live_nieuw\nX=1" } });
  assert.equal(r.status, 400, "één regel");
  r = await post({ at: 2000, env: { MOLLIE_API_KEY: "live_nieuw", BROKER_VAT_PERCENT: "9" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, keys: ["MOLLIE_API_KEY", "BROKER_VAT_PERCENT"], restart: true });
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(restarts, 1, "de Dienst start opnieuw");
  assert.equal((await post({ at: 1500, env: {} })).status, 400, "ouder dan wat er al is");
  assert.ok(!broker.ctx.db.prepare("SELECT value FROM settings WHERE key = 'instellingen'").get()!.toString().includes("live_nieuw"), "versleuteld bewaard");

  // Bij het starten: nieuwer dan dienst.env → toepassen (wat ontbreekt valt weg); ouder → dienst.env geldt.
  const e1: Record<string, string | undefined> = { ...env };
  assert.equal(applyOverride(e1), 2000);
  assert.equal(e1.MOLLIE_API_KEY, "live_nieuw");
  assert.equal(e1.BROKER_VAT_PERCENT, "9");
  assert.equal(e1.OPENPROVIDER_USERNAME, undefined, "niet meegestuurd: weg");
  assert.equal(e1.BROKER_DATA_DIR, dir, "de rest blijft");
  const e2: Record<string, string | undefined> = { ...env, BROKER_ENV_AT: "3000" };
  assert.equal(applyOverride(e2), null, "nieuwe server met nieuwere dienst.env");
  assert.equal(e2.MOLLIE_API_KEY, "test_oud");
});

test("console: gratis-adressendienst aanzetten (live gecontroleerd) en het opstartscript", { timeout: 60_000 }, async (t) => {
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.desecAccount("desec-centraal", "centraal");
  up.st.desec.zones.set("eigencloud.nl", { name: "eigencloud.nl", account: "centraal", keys: [], rrsets: new Map() });
  up.st.desec.tokens.set("zonder-recht", { id: "tok-z", account: "centraal", name: "z", perm_manage_tokens: false, perm_create_domain: true, perm_delete_domain: true, policies: [] });
  process.env.EIGEN_DESEC_URL = `${U}/desec`;
  t.after(async () => { await up.close(); delete process.env.EIGEN_DESEC_URL; });
  const aanbieder = await import("../src/console/aanbieder.js");
  const { consoleSettings } = await import("../src/cluster/admin.js");
  const company = { name: "ESAPE", address: ["Blaak 10"], kvk: "", vat: "", email: "rene@elders.example" };
  const c: any = { cluster: "esape", domain: "esape.nl", providers: {}, stores: [], dns: [{ type: "desec", name: "desec", token: "t", zone: "esape.nl" }], image: {}, console: { done: true, mailRelay: "smtp://p:g@smtp.example:587",
    aanbieder: { step: "adres", url: "https://dienst.esape.nl", company, accounts: { scalewaySecretKey: "k", scalewayOrgId: "o", mollieKey: "test_x", desecToken: "d" }, checked: { scaleway: true, mollie: true, desec: true, smtp: true }, secret: "ab".repeat(32),
      hosting: { provider: "hetzner", region: "fsn1", size: "cx23", monthly: 4.51 }, backup: { provider: "hetzner", endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1", bucket: "b", accessKey: "a", secretKey: "s" } } } };
  assert.equal(aanbieder.view(c, { serverOffers: () => [], storeOffers: () => [] } as never).defaultAdressenHost, "adressen.esape.nl");
  await assert.rejects(aanbieder.saveAdressen(c, { zone: "geen zone" }), /gedeelde zone/);
  await assert.rejects(aanbieder.saveAdressen(c, { zone: "eigencloud.nl" }), /deSEC-token/);
  await assert.rejects(aanbieder.saveAdressen(c, { zone: "eigencloud.nl", desecToken: "t", host: "dienst.esape.nl" }), /eigen hostnaam/);
  let r = await aanbieder.saveAdressen(c, { zone: "eigencloud.nl", desecToken: "fout" });
  assert.equal(r.ok, false);
  assert.match(r.checks[0].detail, /accepteert dit token niet/);
  r = await aanbieder.saveAdressen(c, { zone: "anders.nl", desecToken: "desec-centraal" });
  assert.match(r.checks[0].detail, /staat niet in het deSEC-account/);
  r = await aanbieder.saveAdressen(c, { zone: "eigencloud.nl", desecToken: "zonder-recht" });
  assert.equal(r.ok, false);
  assert.match(r.checks[1].detail, /geen tokens beheren/);
  assert.equal(c.console.aanbieder.adressen, undefined, "niet bewaard");
  r = await aanbieder.saveAdressen(c, { zone: " EigenCloud.nl. ", desecToken: "desec-centraal" });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.adressen, { zone: "eigencloud.nl", desecToken: "••••••••raal", host: "adressen.esape.nl", url: "https://adressen.esape.nl" });

  // Het opstartscript: Dienst + adressendienst + Caddy voor beide, binnen 32 KiB (Hetzner).
  c.console.aanbieder.server = { provider: "hetzner", region: "fsn1", size: "cx23", serverId: "1", ipv4: "192.0.2.5", createdAt: 1 };
  c.console.aanbieder.envAt = 1760000000000;
  const ud = aanbieder.serverUserData(c, c.console.aanbieder);
  assert.ok(ud.length < 32 * 1024, `user-data ${ud.length} bytes`);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ud-")), "ud.sh");
  fs.writeFileSync(f, ud);
  assert.equal(spawnSync("bash", ["-n", f]).status, 0);
  assert.match(ud, /\nBROKER_ADRES_URL=http:\/\/127\.0\.0\.1:4200\nBROKER_ADRES_PUBLIEK=https:\/\/adressen\.esape\.nl\nBROKER_BACKUP_ADRESSEN=\/adressen\/adressen\.sqlite\n/);
  assert.match(ud, /\nBROKER_ENV_AT=1760000000000\nEOF\n/);
  assert.match(ud, /cat > \/srv\/dienst\/adressen\.env <<'EOF'\nADRES_ZONE=eigencloud\.nl\nADRES_DESEC_TOKEN=desec-centraal\nADRES_PUBLIC_URL=https:\/\/adressen\.esape\.nl\nADRES_LOKAAL_DIENST=https:\/\/dienst\.esape\.nl\nEOF\n/);
  assert.match(ud, /\nadressen\.esape\.nl \{\n\tencode zstd gzip\n\treverse_proxy 127\.0\.0\.1:4200\n\}\nEOF\n/);
  assert.match(ud, /\n  adressen:\n    image: ghcr\.io\/renevanes\/eigen-cloud:latest  # eigen-app\n/, "zelfde image: de updater werkt hem mee bij");
  assert.match(ud, /- ADRES_WACHT_OP=\/dienst\/dienst\.sqlite\n/);
  assert.match(ud, /- \/srv\/dienst\/adressen:\/adressen\n  adressen:/, "de Dienst ziet de database (back-up)");
  // De cloud zet ook het A-record van de adressendienst; uitzetten haalt het weer weg.
  assert.deepEqual(JSON.parse(consoleSettings(c).extra_dns), [{ sub: "dienst", type: "A", value: "192.0.2.5" }, { sub: "dienst", type: "AAAA", value: "" }, { sub: "adressen", type: "A", value: "192.0.2.5" }, { sub: "adressen", type: "AAAA", value: "" }]);
  r = await aanbieder.saveAdressen(c, { aan: false });
  assert.equal(r.adressen, null);
  assert.deepEqual(JSON.parse(consoleSettings(c).extra_dns), [{ sub: "adressen", type: "A", value: "" }, { sub: "adressen", type: "AAAA", value: "" }, { sub: "dienst", type: "A", value: "192.0.2.5" }, { sub: "dienst", type: "AAAA", value: "" }]);
  assert.doesNotMatch(aanbieder.serverUserData(c, c.console.aanbieder), /adressen/);
});
