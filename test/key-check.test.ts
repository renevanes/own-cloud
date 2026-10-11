/**
 * "Sleutels controleren": per aanbieder tegen nagebootste API's (test/fixtures/key-checks.json, dezelfde gegevens als
 * de Java-test KeyCheckTest), opslag tegen een S3-nepserver, en de route POST /api/check in de beheerconsole.
 * Overal geldt: alleen GET of HEAD, nooit iets maken of wijzigen.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fakeS3 } from "./helpers/fake-s3.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "keycheck-"));
process.env.EIGEN_VAULT = path.join(base, "kluis.json");
delete process.env.EIGEN_CONSOLE_LOCAL;
delete process.env.EIGEN_SCW_API;
delete process.env.EIGEN_EXO_API;
delete process.env.EIGEN_OVH_API;
delete process.env.EIGEN_DESEC_URL;
const s3 = fakeS3();
const s3url = `http://127.0.0.1:${await s3.listening}`;
process.env.EIGEN_TEST_S3 = s3url;

const { getAdapter } = await import("../src/cluster/adapters.js");
const { checkStorage, ruleCovers } = await import("../src/cluster/adapters/check.js");
const { buildConsole } = await import("../src/console/server.js");

type Route = { status: number; json?: unknown; text?: string };
type Scenario = { name: string; adapter: string; kind: "servers" | "dns"; zone?: string; fields: Record<string, string>; routes: Record<string, Route>; expect: unknown[] };
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/key-checks.json", import.meta.url), "utf8")) as { scenarios: Scenario[] };

const realFetch = globalThis.fetch;
let seen: string[] = [];
/** Nep-API uit de fixture: "METHODE pad?query" of "METHODE pad"; onbekend = 500. */
function fake(routes: Record<string, Route>) {
  seen = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    seen.push(`${method} ${u.pathname}${u.search}`);
    const hit = routes[`${method} ${u.pathname}${u.search}`] ?? routes[`${method} ${u.pathname}`];
    if (!hit) return new Response("niet nagebootst", { status: 500 });
    if (hit.text !== undefined) return new Response(hit.text, { status: hit.status, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(hit.json ?? {}), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

test("per aanbieder: het lijstje klopt precies (zelfde gegevens als de Java-test) en er wordt alleen gelezen", async () => {
  assert.ok(fixture.scenarios.length >= 20);
  const covered = new Set<string>();
  for (const sc of fixture.scenarios) {
    fake(sc.routes);
    const a = getAdapter(sc.adapter)!;
    const checks = sc.kind === "servers" ? await a.servers!.check!(sc.fields) : await a.dns!.check!(sc.fields, sc.zone ?? "");
    assert.deepEqual(checks, sc.expect, sc.name);
    assert.ok(seen.every((r) => /^(GET|HEAD) /.test(r)), `${sc.name}: alleen lezen (${seen.join(", ")})`);
    for (const r of seen) assert.ok(!r.includes("undefined"), `${sc.name}: ${r}`);
    covered.add(`${sc.adapter}/${sc.kind}`);
  }
  for (const k of ["hetzner/servers", "hetzner/dns", "scaleway/servers", "scaleway/dns", "upcloud/servers", "exoscale/servers", "exoscale/dns", "ovh/servers", "ovh/dns", "desec/dns"]) assert.ok(covered.has(k), k);
});

test("elke aanbieder met servers of DNS heeft een eigen controle", () => {
  for (const id of ["scaleway", "hetzner", "upcloud", "exoscale", "ovh"]) assert.equal(typeof getAdapter(id)!.servers!.check, "function", id);
  for (const id of ["desec", "scaleway", "hetzner", "exoscale", "ovh"]) assert.equal(typeof getAdapter(id)!.dns!.check, "function", id);
});

test("OVHcloud: rechtenregels met * dekken onderliggende paden", () => {
  const rules = [{ method: "GET", path: "/cloud/project/*" }, { method: "POST", path: "/cloud/project/*/instance" }];
  assert.ok(ruleCovers(rules, "GET", "/cloud/project/p/instance"));
  assert.ok(ruleCovers(rules, "POST", "/cloud/project/p/instance"));
  assert.ok(!ruleCovers(rules, "POST", "/cloud/project/p/instance/x/reboot"));
  assert.ok(!ruleCovers(rules, "DELETE", "/cloud/project/p/instance/x"));
  assert.ok(!ruleCovers([{ method: "GET", path: "/cloud/project/a.b" }], "GET", "/cloud/project/aXb"), "punt is geen jokerteken");
});

test("opslag: inloggen, bucket en bestanden bekijken (alleen lezen); foutcodes in gewone taal", async () => {
  const cfg = { name: "test", type: "s3" as const, purpose: "replica" as const, endpoint: s3url, region: "nl-ams", accessKey: "ak", secretKey: "sk", bucket: "eigen-data" };
  let r = await checkStorage(cfg);
  assert.deepEqual(r, [
    { id: "login", label: "Inloggen lukt", ok: true, detail: "Buckets: 0" },
    { id: "bucket", label: "Bucket bekijken", ok: null, detail: "eigen-data bestaat nog niet; de console maakt hem aan bij het koppelen." },
    { id: "objects", label: "Bestanden bekijken", ok: null, detail: "Niet gecontroleerd, want de bucket is niet te bekijken" },
  ]);
  assert.equal(s3.buckets.size, 0, "niets aangemaakt");
  const { S3Store } = await import("../src/cluster/stores.js");
  await new S3Store(cfg).createBucket(false);
  r = await checkStorage(cfg);
  assert.deepEqual(r.map((x) => [x.id, x.ok, x.detail]), [["login", true, "Buckets: 1"], ["bucket", true, "eigen-data gevonden"], ["objects", true, ""]]);

  // Een opslag die sleutels weigert.
  let code = "InvalidAccessKeyId", status = 403;
  const srv = http.createServer((_req, res) => { res.writeHead(status, { "content-type": "application/xml" }); res.end(code ? `<Error><Code>${code}</Code></Error>` : ""); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  try {
    const bad = { ...cfg, endpoint: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
    assert.deepEqual(await checkStorage(bad), [
      { id: "login", label: "Inloggen lukt", ok: false, detail: "De opslag herkent deze toegangssleutel niet. Kopieer hem opnieuw of maak een nieuwe." },
      { id: "bucket", label: "Bucket bekijken", ok: null, detail: "Niet gecontroleerd, want inloggen lukt niet" },
      { id: "objects", label: "Bestanden bekijken", ok: null, detail: "Niet gecontroleerd, want inloggen lukt niet" },
    ]);
    code = "SignatureDoesNotMatch";
    assert.equal((await checkStorage(bad))[0].detail, "De geheime sleutel hoort niet bij deze toegangssleutel. Kopieer hem opnieuw.");
    code = "AccessDenied";
    const denied = await checkStorage(bad);
    assert.equal(denied[0].ok, null, "lijst met buckets niet toegestaan is niet erg");
    assert.deepEqual(denied[1], { id: "bucket", label: "Bucket bekijken", ok: false, detail: "Geen toegang tot eigen-data. Bestaat hij al bij iemand anders, of mag de sleutel er niet bij?" });
  } finally { srv.close(); }
});

test("console: POST /api/check voor servers, DNS en opslag, en het lijstje bij een mislukte koppeling", async (t) => {
  const app = await buildConsole();
  t.after(async () => { await app.close(); await s3.close(); });
  let cookie = "";
  const c = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), text: r.body };
  };
  assert.equal((await c("POST", "/api/check", { kind: "servers", id: "hetzner" })).status, 401, "op slot");
  assert.equal((await c("POST", "/api/setup/create", { domain: "vanes.nl", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" })).status, 200);

  const hz = fixture.scenarios.find((s) => s.name === "Hetzner servers: alles in orde")!;
  const hz401 = fixture.scenarios.find((s) => s.name === "Hetzner servers: token onbekend")!;
  // Koppelen mislukt: de fout plus het lijstje.
  fake(hz401.routes);
  let r = await c("POST", "/api/providers", { id: "hetzner", fields: { token: "fout" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Inloggen bij Hetzner Cloud lukt niet/);
  assert.deepEqual(r.json.checks, hz401.expect);

  // Koppelen lukt; daarna controleren met de sleutel uit de kluis (geen velden meegeven).
  fake({ ...hz.routes, "GET /v1/server_types": { status: 200, json: { server_types: [{ name: "cx22", cores: 2, memory: 4, architecture: "x86", prices: [{ location: "fsn1", price_monthly: { gross: "4.5" } }] }] } } });
  assert.equal((await c("POST", "/api/providers", { id: "hetzner", fields: { token: "hz-goed" } })).status, 200);
  fake(hz.routes);
  r = await c("POST", "/api/check", { kind: "servers", id: "hetzner" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { checks: hz.expect });
  assert.ok(seen.length && seen.every((x) => x.startsWith("GET ")));
  // Met een ander (nog niet bewaard) token: dat wordt gebruikt, de kluis blijft gelijk.
  fake(hz401.routes);
  assert.deepEqual((await c("POST", "/api/check", { kind: "servers", id: "hetzner", fields: { token: "ander" } })).json.checks, hz401.expect);
  assert.equal((await c("GET", "/api/config")).json.providers.hetzner.token, "••••••••goed");

  // DNS bij Hetzner met dezelfde sleutel; de zone is het domein van de cloud.
  fake({ "GET /v1/zones?name=vanes.nl": { status: 200, json: { zones: [{ name: "vanes.nl" }] } } });
  r = await c("POST", "/api/check", { kind: "dns", id: "hetzner" });
  assert.deepEqual(r.json.checks.map((x: { id: string; ok: boolean | null; detail: string }) => [x.id, x.ok, x.detail]), [["login", true, ""], ["zone", true, "vanes.nl gevonden"], ["rights", null, "Kan de aanbieder niet laten zien; blijkt bij het starten. Kies bij het maken van het token 'Lezen en schrijven'."]]);
  // DNS koppelen mislukt: lijstje erbij.
  const desec401 = fixture.scenarios.find((s) => s.name === "deSEC: token onbekend")!;
  fake({ ...desec401.routes, "GET /api/v1/domains/vanes.nl/": { status: 401, json: {} } });
  r = await c("POST", "/api/dns", { mode: "desec", token: "fout" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "deSEC accepteert dit token niet");
  assert.deepEqual(r.json.checks.map((x: { id: string; ok: boolean | null }) => [x.id, x.ok]), [["login", false], ["zone", null], ["rights", null]]);
  assert.equal(r.json.checks[1].label, "DNS-zone bekijken");

  // Opslag: op naam van de gekoppelde opslag.
  globalThis.fetch = realFetch;
  r = await c("POST", "/api/stores", { offer: "hetzner", region: "fsn1", accessKey: "ak", secretKey: "sk", purpose: "replica" });
  assert.equal(r.status, 200, r.text);
  const name = r.json.name;
  r = await c("POST", "/api/check", { kind: "storage", id: name });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.checks.map((x: { id: string; ok: boolean | null }) => [x.id, x.ok]), [["login", true], ["bucket", true], ["objects", true]]);

  // Fouten.
  assert.equal((await c("POST", "/api/check", { kind: "storage", id: "bestaat-niet" })).json.error, "Onbekende opslag");
  assert.equal((await c("POST", "/api/check", { kind: "servers", id: "local" })).json.error, "Onbekende aanbieder");
  assert.equal((await c("POST", "/api/check", { kind: "iets" })).status, 400);
});
