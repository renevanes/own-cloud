/**
 * Twee aanbieders (Dienst A en B) met de centrale adressendienst (BROKER_ADRES_URL), tegen één nep-deSEC:
 * een klant bestelt een gratis adres bij A, zijn cloud schrijft DNS via de proxy van A (met het token dat alleen
 * in zijn zone mag schrijven), en stapt daarna met de overdrachtscode over naar B: B krijgt het adres, het token
 * van A werkt niet meer, de records blijven staan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker, type Broker } from "../src/broker/app.js";
import { readSecrets } from "../src/broker/provision.js";
import { getOrder } from "../src/broker/db.js";
import { cancelOrder, cleanupOrder, releaseAdres } from "../src/broker/ops.js";
import { loadAdresConfig } from "../src/adressen/config.js";
import { createAdressen } from "../src/adressen/app.js";
import { freePort } from "./helpers/cluster.js";
import { smtpSink, fakeUpstream, fakeMandate } from "./helpers/broker-fakes.js";

const ZONE = "eigencloud.test";
const NAAM = `vanes.${ZONE}`;

test("Eigen Cloud Dienst + adressendienst: gratis adres meenemen naar een andere aanbieder", { timeout: 90_000 }, async (t) => {
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.desecAccount("desec-centraal", "centraal");
  up.desecAccount("desec-b", "b");
  up.st.desec.zones.set(ZONE, { name: ZONE, account: "centraal", keys: [], rrsets: new Map() });
  const cleanup: (() => Promise<unknown> | void)[] = [];
  t.after(async () => { for (const f of cleanup.reverse()) await f(); await up.close(); });

  // De adressendienst (bij Rene) en de lijst van aanbieders.
  const adresDir = fs.mkdtempSync(path.join(os.tmpdir(), "adressen-"));
  const adresPort = await freePort();
  const ADRES = `http://127.0.0.1:${adresPort}`;
  const list = path.join(adresDir, "aanbieders.json");

  // Twee aanbieders, elk met een eigen deSEC-account en eigen sleutel.
  const dienst = async (naam: string, desecToken: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dienst-${naam}-`));
    const smtp = await smtpSink();
    const port = await freePort();
    const PUBLIC = `http://127.0.0.1:${port}`;
    const cfg = loadConfig({
      BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC, BROKER_ADRES_URL: `${ADRES}/`,
      MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
      OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
      DESEC_TOKEN: desecToken, DESEC_URL: `${U}/desec`,
      SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
      BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: `Dienst ${naam} <dienst@${naam}.test>`, BROKER_LOOP_MS: "20",
    });
    assert.equal(fs.statSync(path.join(dir, "aanbieder.key")).mode & 0o777, 0o600, "sleutel alleen voor de eigenaar");
    assert.equal(loadConfig({ BROKER_DATA_DIR: dir }).providerPublicKey, cfg.providerPublicKey, "zelfde sleutel na herstart");
    cleanup.push(() => smtp.close(), () => fs.rmSync(dir, { recursive: true, force: true }));
    return { naam, cfg, PUBLIC, smtp, broker: null as unknown as Broker };
  };
  const A = await dienst("a", "desec-dienst");
  const B = await dienst("b", "desec-b");
  assert.notEqual(A.cfg.providerPublicKey, B.cfg.providerPublicKey);
  fs.writeFileSync(list, JSON.stringify([
    { naam: "Aanbieder A", url: A.PUBLIC, sleutel: A.cfg.providerPublicKey },
    { naam: "Aanbieder B", url: B.PUBLIC, sleutel: B.cfg.providerPublicKey },
  ]));
  const svc = await createAdressen(loadAdresConfig({
    ADRES_ZONE: ZONE, ADRES_DESEC_TOKEN: "desec-centraal", ADRES_DESEC_URL: `${U}/desec`,
    ADRES_PORT: String(adresPort), ADRES_DATA_DIR: adresDir, ADRES_LIST_URL: list,
  }));
  await svc.app.listen({ port: adresPort, host: "127.0.0.1" });
  cleanup.push(() => fs.rmSync(adresDir, { recursive: true, force: true }), () => svc.close());
  for (const d of [A, B]) {
    d.broker = await createBroker(d.cfg);
    await d.broker.app.listen({ port: d.cfg.port, host: "127.0.0.1" });
    cleanup.push(() => d.broker.close());
  }

  type D = typeof A;
  const api = async (d: D, method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(d.PUBLIC + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const login = async (d: D, email: string) => {
    assert.equal((await api(d, "POST", "/v1/auth/start", { email })).status, 202);
    let m; for (let i = 0; i < 100 && !m; i++) { m = d.smtp.mails.find((x) => x.to.includes(email) && /inlogcode: \d{6}/.test(x.data)); if (!m) await new Promise((res) => setTimeout(res, 30)); }
    d.smtp.mails.splice(d.smtp.mails.indexOf(m!), 1);
    return (await api(d, "POST", "/v1/auth/verify", { email, code: /inlogcode: (\d{6})/.exec(m!.data)![1] })).json.token as string;
  };
  const payAndWait = async (d: D, orderId: string, token: string) => {
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata.orderId === orderId)!;
    const mdt = `mdt_${orderId}`;
    Object.assign(pay, { status: "paid", mandateId: mdt, method: "ideal", paidAt: new Date().toISOString() });
    up.st.mollie.mandates.push(fakeMandate(mdt, pay.customerId, "directdebit"));
    await fetch(`${d.PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${pay.id}` });
    let o: any;
    for (let i = 0; i < 100; i++) { await d.broker.idle(); o = (await api(d, "GET", `/v1/orders/${orderId}`, undefined, token)).json; if (o.status === "ready" || o.status === "failed") break; await new Promise((res) => setTimeout(res, 30)); }
    assert.equal(o.status, "ready", JSON.stringify(o));
    return o;
  };
  const dnsWrite = (d: D, token: string, records: string[]) => fetch(`${d.PUBLIC}/v1/desec/domains/${NAAM}/rrsets/`, {
    method: "PATCH", headers: { authorization: `Token ${token}`, "content-type": "application/json" },
    body: JSON.stringify([{ subname: "cloud", type: "A", ttl: 3600, records }]),
  }).then((r) => r.status);
  const zone = () => up.st.desec.zones.get(NAAM);

  let orderA = "", kitA: any = null, tokenKlantA = "";

  await t.test("A: zone en vrij/bezet komen van de adressendienst", async () => {
    assert.equal((await api(A, "GET", "/v1/info")).json.freeZone, ZONE);
    assert.deepEqual((await api(A, "GET", "/v1/domains/check?name=Vanes")).json, { domain: NAAM, available: true, price: null, free: true });
    assert.match((await api(A, "GET", "/v1/domains/check?name=mail")).json.error, /gereserveerd/);
    assert.ok(up.calls.every((c) => c.headers.authorization !== "Token desec-dienst"), "A gebruikt zijn eigen deSEC niet voor gratis adressen");
  });

  await t.test("A: bestellen, klaarzetten, pakket met overdrachtscode", async () => {
    tokenKlantA = await login(A, "klant@elders.test");
    let r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes", transferCode: "AAAA-BBBB-CCCC-DDDD-EEEE" }, acceptTerms: true }, tokenKlantA);
    assert.equal(r.status, 404, "overnemen van een adres dat niet bestaat"); assert.match(r.json.error, /niet in gebruik/);
    r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes" }, acceptTerms: true }, tokenKlantA);
    assert.equal(r.status, 200, r.text);
    orderA = r.json.orderId;
    const o = await payAndWait(A, orderA, tokenKlantA);
    assert.equal(o.steps.find((s: any) => s.id === "dns-zone").detail, "Je adres is aangevraagd bij de adressendienst");
    assert.equal(o.steps.find((s: any) => s.id === "domain").detail, "Je adres werkt");
    assert.equal(zone()?.account, "centraal", "de zone staat in het centrale account");
    assert.deepEqual(up.st.desec.zones.get(ZONE)!.rrsets.get("vanes/NS")?.records, ["ns1.desec.io.", "ns2.desec.org."]);

    kitA = (await api(A, "GET", `/v1/orders/${orderA}/kit`, undefined, tokenKlantA)).json;
    assert.equal(kitA.domain, NAAM);
    assert.equal(kitA.delegated, true);
    assert.equal(kitA.dns.zone, NAAM);
    assert.equal(kitA.dns.api, `${A.PUBLIC}/v1/desec`);
    assert.match(kitA.dns.transferCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    const secrets = readSecrets(A.broker.ctx, getOrder(A.broker.ctx.db, orderA)!);
    assert.equal(secrets.transferCode, kitA.dns.transferCode);
    assert.notEqual(secrets.zoneToken, kitA.dns.token, "het zone-token blijft bij de Dienst");

    // Alles in de zone van de klant ging met het token van alleen die zone (DKIM, acme-CNAME's).
    const zoneCalls = up.calls.filter((c) => c.path.startsWith(`/desec/domains/${NAAM}/`) && c.method !== "GET");
    assert.ok(zoneCalls.length >= 2);
    assert.ok(zoneCalls.every((c) => c.headers.authorization === `Token ${secrets.zoneToken}`), "alleen het zone-token");
    assert.ok([...zone()!.rrsets.keys()].some((k) => /\._domainkey\/TXT$/.test(k)), "DKIM staat in de zone");
    assert.ok(zone()!.rrsets.has("_acme-challenge.cloud/CNAME"));
    assert.ok(up.calls.every((c) => c.headers.authorization !== "Token desec-dienst"), "het eigen deSEC-account van A is niet gebruikt");

    r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes" }, acceptTerms: true }, await login(A, "ander@elders.test"));
    assert.equal(r.status, 409, "bezet");
  });

  await t.test("A: de cloud schrijft DNS via de proxy en acme-dns", async () => {
    assert.equal(await dnsWrite(A, kitA.dns.token, ["192.0.2.1"]), 200);
    assert.deepEqual(zone()!.rrsets.get("cloud/A").records, ["192.0.2.1"]);
    const last = up.calls.filter((c) => c.path === `/desec/domains/${NAAM}/rrsets/`).at(-1)!;
    assert.equal(last.headers.authorization, `Token ${readSecrets(A.broker.ctx, getOrder(A.broker.ctx.db, orderA)!).zoneToken}`);
    const txt = "a".repeat(43);
    const r = await fetch(`${A.PUBLIC}/v1/acme-dns/update`, { method: "POST", headers: { "content-type": "application/json", "x-api-user": orderA, "x-api-key": kitA.dns.acme.password }, body: JSON.stringify({ subdomain: "_acme", txt }) });
    assert.equal(r.status, 200);
    assert.deepEqual(zone()!.rrsets.get("_acme/TXT").records, [`"${txt}"`]);
    // De proxy blijft beperkt tot de eigen zone.
    const other = await fetch(`${A.PUBLIC}/v1/desec/domains/${ZONE}/rrsets/`, { method: "PATCH", headers: { authorization: `Token ${kitA.dns.token}`, "content-type": "application/json" }, body: "[]" });
    assert.equal(other.status, 403);
  });

  await t.test("B: overstappen met de overdrachtscode", async () => {
    const tokenKlantB = await login(B, "klant@elders.test");
    assert.equal((await api(B, "GET", "/v1/info")).json.freeZone, ZONE, "dezelfde gedeelde zone");
    assert.equal((await api(B, "GET", "/v1/domains/check?name=vanes")).json.available, false);
    let r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes" }, acceptTerms: true }, tokenKlantB);
    assert.equal(r.status, 409, "zonder code: bezet");
    r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes", transferCode: "AAAA-BBBB-CCCC-DDDD-EEEE" }, acceptTerms: true }, tokenKlantB);
    assert.equal(r.status, 400); assert.match(r.json.error, /overdrachtscode klopt niet/);
    r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "vanes.nl" }, transferCode: kitA.dns.transferCode, acceptTerms: true }, tokenKlantB);
    assert.equal(r.status, 400, "code alleen bij een gratis adres");
    r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "vanes" }, transferCode: kitA.dns.transferCode.toLowerCase(), acceptTerms: true }, tokenKlantB);
    assert.equal(r.status, 200, r.text);
    const orderB = r.json.orderId as string;
    const o = await payAndWait(B, orderB, tokenKlantB);
    assert.equal(o.steps.find((s: any) => s.id === "dns-zone").detail, "Je adres is overgenomen, met al je DNS-records");
    const kitB = (await api(B, "GET", `/v1/orders/${orderB}/kit`, undefined, tokenKlantB)).json;
    assert.equal(kitB.domain, NAAM);
    assert.equal(kitB.dns.api, `${B.PUBLIC}/v1/desec`);
    assert.match(kitB.dns.transferCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    assert.notEqual(kitB.dns.transferCode, kitA.dns.transferCode, "nieuwe code");
    assert.deepEqual(zone()!.rrsets.get("cloud/A").records, ["192.0.2.1"], "records van de klant blijven staan");

    assert.equal(await dnsWrite(B, kitB.dns.token, ["192.0.2.2"]), 200, "B kan schrijven");
    assert.deepEqual(zone()!.rrsets.get("cloud/A").records, ["192.0.2.2"]);
    assert.equal(await dnsWrite(A, kitA.dns.token, ["192.0.2.66"]), 401, "het token van A is ingetrokken");
    assert.deepEqual(zone()!.rrsets.get("cloud/A").records, ["192.0.2.2"]);
    const acme = await fetch(`${A.PUBLIC}/v1/acme-dns/update`, { method: "POST", headers: { "content-type": "application/json", "x-api-user": orderA, "x-api-key": kitA.dns.acme.password }, body: JSON.stringify({ subdomain: "_acme", txt: "b".repeat(43) }) });
    assert.equal(acme.status, 502);
    assert.ok(up.calls.every((c) => c.headers.authorization !== "Token desec-b"), "ook B gebruikt zijn eigen deSEC-account niet");
    const log = svc.ctx.db.prepare("SELECT actie, dienst FROM logboek WHERE naam = ? ORDER BY id").all(NAAM) as { actie: string; dienst: string }[];
    assert.deepEqual(log.map((l) => l.actie), ["aangemaakt", "overgedragen"]);
    assert.equal(log[1].dienst, B.PUBLIC);
  });

  await t.test("A: opzeggen en opruimen laat het adres staan; vrijgeven kan niet meer (is van B)", async () => {
    await cancelOrder(A.broker.ctx, orderA);
    const r = await cleanupOrder(A.broker.ctx, orderA, true);
    assert.ok(r.manual.some((l) => /blijft bij de adressendienst/.test(l)), JSON.stringify(r.manual));
    assert.ok(zone(), "zone blijft");
    const rel = await releaseAdres(A.broker.ctx, orderA, true);
    assert.match(rel.done[0], /andere aanbieder/);
    assert.ok(zone(), "B houdt het adres");
    assert.equal(readSecrets(A.broker.ctx, getOrder(A.broker.ctx.db, orderA)!).zoneToken, undefined);
  });
});
