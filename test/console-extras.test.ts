/**
 * Alles regelen vanuit de console:
 *  - gratis: deSEC-account aanmaken met plaatje (captcha) en bevestigingsmail, met een gratis naam.dedyn.io;
 *  - betaald: de Eigen Cloud Dienst — inloggen met een code, domein kiezen, bestellen, betalen, pakket overnemen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { freePort } from "./helpers/cluster.js";
import { smtpSink, fakeUpstream } from "./helpers/broker-fakes.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "console-extras-"));

/** Nep-deSEC voor het aanmaken van een account (captcha, registratie, bevestigen, inloggen, token). */
function fakeDesec() {
  const st = { accounts: new Map<string, { password: string; domain?: string; active: boolean }>(), domains: new Set<string>(), taken: new Set(["bezet.dedyn.io"]), tokens: new Map<string, string>() };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const p = new URL(req.url!, "http://x").pathname;
      const auth = String(req.headers.authorization ?? "").replace(/^Token /, "");
      if (req.method === "POST" && p === "/captcha/") return send(201, { id: "cap-1", challenge: Buffer.from("png").toString("base64"), kind: "image" });
      if (req.method === "POST" && p === "/auth/") {
        if (body.captcha?.solution !== "ABC12") return send(400, { captcha: ["CAPTCHA could not be validated. Please obtain a new one and try again."] });
        st.accounts.set(body.email, { password: body.password, domain: body.domain, active: false });
        return send(202, { detail: "Welcome! Please check your mailbox." });
      }
      if (req.method === "POST" && p === "/auth/login/") {
        const a = st.accounts.get(body.email);
        if (!a || !a.active || a.password !== body.password) return send(403, { detail: "Invalid username/password." });
        st.tokens.set("login-1", body.email);
        return send(200, { id: "t1", token: "login-1" });
      }
      if (req.method === "POST" && p === "/auth/tokens/") {
        const email = st.tokens.get(auth);
        if (!email) return send(401, { detail: "Invalid token." });
        st.tokens.set("blijvend-token-1234", email);
        return send(201, { id: "t2", token: "blijvend-token-1234", name: body.name });
      }
      const m = /^\/domains\/([^/]+)\/$/.exec(p);
      if (m && req.method === "GET") {
        if (!st.tokens.has(auth)) return send(401, { detail: "Invalid token." });
        return st.domains.has(m[1]) ? send(200, { name: m[1] }) : send(404, { detail: "Not found." });
      }
      if (req.method === "POST" && p === "/domains/") { st.domains.add(body.name); return send(201, { name: body.name }); }
      send(599, { detail: `onbekend: ${req.method} ${p}` });
    });
  });
  /** De gebruiker klikt op de link in de bevestigingsmail. */
  const activate = (email: string) => {
    const a = st.accounts.get(email)!;
    if (a.domain && st.taken.has(a.domain)) { st.accounts.delete(email); return; } // deSEC verwijdert het account
    a.active = true;
    if (a.domain) st.domains.add(a.domain);
  };
  const listening = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  return { st, activate, listening, close: () => new Promise<void>((r) => server.close(() => r())) };
}

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

test("console: gratis deSEC-account en naam.dedyn.io, daarna alles via de Eigen Cloud Dienst", { timeout: 120_000 }, async (t) => {
  const desec = fakeDesec();
  const smtp = await smtpSink();
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  const port = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`;
  const dienstDir = path.join(base, "dienst");
  const broker = await createBroker(loadConfig({
    BROKER_DATA_DIR: dienstDir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC,
    MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
    OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
    DESEC_TOKEN: "desec-dienst", DESEC_URL: `${U}/desec`,
    SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
    BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: "Eigen Cloud Dienst <dienst@dienst.test>",
    BROKER_ADMIN_EMAIL: "beheer@dienst.test", BROKER_LOOP_MS: "20",
  }));
  await broker.app.listen({ port, host: "127.0.0.1" });

  process.env.EIGEN_DESEC_URL = `http://127.0.0.1:${await desec.listening}`;
  process.env.EIGEN_DIENST_URL = PUBLIC;
  process.env.EIGEN_VAULT = path.join(base, "kluis.json");
  const { buildConsole } = await import(`../src/console/server.js?extras=${Date.now()}`);
  const app = await buildConsole();
  const c = client(app);
  t.after(async () => { await app.close(); await broker.close(); await up.close(); await smtp.close(); await desec.close(); delete process.env.EIGEN_DIENST_URL; delete process.env.EIGEN_DESEC_URL; });

  await t.test("eerste stap: gratis naam", async () => {
    const st = (await c("GET", "/api/state")).json;
    assert.equal(st.dienst, true, "dienst is ingesteld");
    let r = await c("POST", "/api/setup/create", { domain: "Van Es!", domainMode: "free", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" });
    assert.match(r.json.error, /letters, cijfers en streepjes/);
    r = await c("POST", "/api/setup/create", { domain: "vanes", domainMode: "free", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", passphrase: "vier losse woorden hier" });
    assert.match(r.json.error, /meldadres/, "zonder meldadres geen deSEC-account");
    r = await c("POST", "/api/setup/create", { domain: "bezet", domainMode: "free", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" });
    assert.equal(r.status, 200, r.text);
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.domain, "bezet.dedyn.io");
    assert.equal(conf.mailFrom, "rene@bezet.dedyn.io");
  });

  await t.test("deSEC-account: plaatje, bevestigen, naam bezet → andere naam", async () => {
    const cap = (await c("POST", "/api/desec/captcha")).json;
    assert.equal(cap.id, "cap-1");
    let r = await c("POST", "/api/desec/register", { captchaId: cap.id, solution: "fout" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /plaatje kloppen niet/);
    r = await c("POST", "/api/desec/register", { captchaId: cap.id, solution: " ABC12 " });
    assert.equal(r.status, 200, r.text);
    assert.equal(desec.st.accounts.get("rene@elders.example")?.domain, "bezet.dedyn.io");
    assert.equal((await c("POST", "/api/desec/finish")).json.pending, true, "nog niet bevestigd");
    desec.activate("rene@elders.example"); // naam was bezet: deSEC verwijdert het account
    r = await c("POST", "/api/desec/finish");
    assert.equal(r.json.pending, true, "account bestaat niet meer → nog niet klaar");

    r = await c("POST", "/api/setup/domain", { domain: "vanes", domainMode: "free" });
    assert.equal(r.json.domain, "vanes.dedyn.io");
    r = await c("POST", "/api/desec/register", { captchaId: "cap-1", solution: "ABC12" });
    assert.equal(r.status, 200);
    desec.activate("rene@elders.example");
    r = await c("POST", "/api/desec/finish");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.ns, ["ns1.desec.io", "ns2.desec.org"]);
    assert.equal(r.json.delegated, true, "dedyn.io staat meteen goed");
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dnsMode, "desec");
    assert.match(conf.dns[0].token, /^••+1234$/, "token gemaskeerd");
    const kluis = fs.readFileSync(process.env.EIGEN_VAULT!, "utf8");
    assert.ok(!kluis.includes("blijvend-token"), "token alleen versleuteld bewaard");
  });

  let orderId = "";
  await t.test("dienst: bundels, domein kopen, inloggen, bestellen, betalen", async () => {
    const info = (await c("GET", "/api/dienst/info")).json;
    assert.ok(info.bundles.length >= 1);
    const check = (await c("GET", "/api/dienst/check?name=vanes.nl")).json;
    assert.equal(check.domain, "vanes.nl");
    assert.equal(typeof check.available, "boolean");

    let r = await c("POST", "/api/dienst/order", { bundle: info.bundles[0].id, mode: "register", acceptTerms: true });
    assert.match(r.json.error, /Log eerst in/);
    r = await c("POST", "/api/dienst/login", { email: "rene@elders.example" });
    assert.equal(r.status, 200, r.text);
    let mail;
    for (let i = 0; i < 100 && !mail; i++) { mail = smtp.mails.find((m) => /inlogcode: \d{6}/.test(m.data)); if (!mail) await new Promise((res) => setTimeout(res, 30)); }
    assert.equal((await c("POST", "/api/dienst/verify", { code: "000000" })).status, 400);
    r = await c("POST", "/api/dienst/verify", { code: /inlogcode: (\d{6})/.exec(mail!.data)![1] });
    assert.equal(r.status, 200, r.text);

    r = await c("POST", "/api/dienst/order", { bundle: info.bundles[0].id, mode: "register", acceptTerms: true });
    assert.match(r.json.error, /eigen domeinnaam/, "dedyn.io kan niet bij de dienst");
    assert.equal((await c("POST", "/api/setup/domain", { domain: "vanes.nl", domainMode: "buy" })).status, 200);
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dnsMode, null, "DNS-koppeling hoort bij het oude domein en is gewist");

    const registrant = { firstName: "Rene", lastName: "van Es", street: "Coolsingel", number: "40", zipcode: "3011 AD", city: "Rotterdam", country: "NL", phone: "+31 6 12345678", email: "rene@elders.example" };
    r = await c("POST", "/api/dienst/order", { bundle: info.bundles[0].id, mode: "register", registrant, acceptTerms: true });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\//);
    orderId = r.json.orderId;
    assert.equal((await c("GET", "/api/dienst/status")).json.status, "awaiting_payment");

    // Betalen bij Mollie (nep) en de webhook
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata?.orderId === orderId)!;
    pay.status = "paid";
    pay.mandateId = "mdt_1";
    await fetch(`${PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${pay.id}` });
    let status = "";
    for (let i = 0; i < 300 && status !== "ready"; i++) { await broker.idle(); status = (await c("GET", "/api/dienst/status")).json.status; if (status !== "ready") await new Promise((res) => setTimeout(res, 50)); }
    assert.equal(status, "ready");
  });

  await t.test("dienst: pakket overnemen (opslag, servers, DNS via de dienst, mail-relay)", async () => {
    const extras = await import("../src/console/extras.js");
    const vaultMod = await import("../src/console/vault.js");
    const v = new vaultMod.Vault(process.env.EIGEN_VAULT!);
    v.unlock("vier losse woorden hier");
    const added: { offer: string; region: string; purpose: string; accessKey: string }[] = [];
    const r = await extras.dienstApply(v.config!, async (b) => { added.push(b); v.config!.stores.push({ name: `${b.offer}-${b.region}`, type: "s3", purpose: b.purpose, endpoint: "https://s3.test", bucket: "x", accessKey: b.accessKey, secretKey: b.secretKey }); return { ok: true, steps: [], name: `${b.offer}-${b.region}` }; });
    assert.equal(r.ok, true);
    const cfg = v.config!;
    assert.deepEqual(added.map((a) => `${a.offer}/${a.region}/${a.purpose}`).sort(), ["scaleway/fr-par/backup", "scaleway/nl-ams/replica"]);
    assert.ok(cfg.providers.scaleway?.secretKey && cfg.providers.scaleway?.projectId, "Scaleway-sleutel voor het eigen project");
    assert.ok(cfg.policy.placement.length >= 3 && cfg.policy.placement.every((p) => p.provider === "scaleway"));
    assert.equal(cfg.dns[0].api, `${PUBLIC}/v1/desec`, "DNS loopt via de dienst");
    assert.equal(cfg.dns[0].zone, "vanes.nl");
    assert.match(cfg.console.mailRelay!, /^smtp:\/\/.+@smtp\.tem\.scaleway\.com:587$/);
    assert.equal(cfg.console.dnsMode, "dienst");
    assert.equal(cfg.console.dienst?.applied, true);
    assert.ok(!JSON.stringify(cfg).includes(up.st.scw.apiKeys.length ? "scw-org-geheim" : "@@"), "de organisatiesleutel van de dienst komt nooit bij de klant");

    // Certificaten: Caddy krijgt het acme-dns-adres van de dienst; alleen _acme.<domein> is te wijzigen.
    const { caddyfile } = await import("../src/cluster/cloudinit.js");
    const cf = caddyfile(cfg)!;
    assert.match(cf, /dns acmedns \{[\s\S]*server_url http:\/\/127\.0\.0\.1:\d+\/v1\/acme-dns/);
    assert.doesNotMatch(cf, /dns desec/, "het dienst-token werkt niet rechtstreeks bij deSEC");
    const zone = up.st.desec.zones.get("vanes.nl")!;
    assert.equal(zone.rrsets.get("_acme-challenge.cloud/CNAME")?.records[0], "_acme.vanes.nl.");
    const acme = cfg.dns[0].acme!;
    const upd = (txt: string, key = acme.password) => fetch(`${acme.server_url}/update`, { method: "POST", headers: { "x-api-user": acme.username, "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ subdomain: "_acme", txt }) });
    for (const ch of ["a", "b", "c"]) assert.equal((await upd(ch.repeat(43))).status, 200);
    assert.deepEqual(zone.rrsets.get("_acme/TXT")?.records, [`"${"b".repeat(43)}"`, `"${"c".repeat(43)}"`], "de laatste twee waarden");
    assert.equal((await upd("d".repeat(43), "0".repeat(64))).status, 401, "verkeerde sleutel");
    assert.equal((await upd("te kort")).status, 400);
  });
});
