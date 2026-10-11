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
import { smtpSink, fakeUpstream, fakeMandate } from "./helpers/broker-fakes.js";

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

  await t.test("dienst: abonnement regelen in de console (facturen, bundel, betaalmethode, opzeggen)", async () => {
    const custId = up.st.mollie.customers[0].id;
    up.st.mollie.mandates.push(fakeMandate("mdt_1", custId, "directdebit"));
    let b = (await c("GET", "/api/dienst/billing")).json;
    assert.equal(b.status, "ready");
    assert.equal(b.domain, "vanes.nl");
    assert.equal(b.mandate?.method, "directdebit");
    assert.equal(b.payments.length, 1);
    const invoiceId = b.payments[0].invoiceId;
    assert.ok(invoiceId, "de eerste betaling heeft een factuur");

    let r = await c("GET", `/api/dienst/invoice?id=${invoiceId}`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.html, /EC-\d{4}-\d{4}/);
    assert.match((await c("GET", "/api/dienst/invoice?id=../../etc")).json.error, /Onbekende factuur/);

    const other = b.bundles.find((x: any) => !x.current);
    r = await c("POST", "/api/dienst/bundle", { bundle: other.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.bundle.id, other.id);
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dienst.bundle, other.id, "nieuwe bundel bewaard in de kluis");
    assert.match((await c("POST", "/api/dienst/bundle", { bundle: other.id })).json.error, /al/);

    r = await c("POST", "/api/dienst/payment-method");
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\//);
    r = await c("POST", "/api/dienst/settle");
    assert.equal(r.status, 400);
    assert.match(r.json.error, /niets open/);

    r = await c("GET", "/api/dienst/authcode");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.domain, "vanes.nl");
    assert.ok(r.json.authCode);

    r = await c("POST", "/api/dienst/cancel");
    assert.equal(r.status, 200, r.text);
    b = (await c("GET", "/api/dienst/billing")).json;
    assert.equal(b.status, "cancelled");
    assert.equal(b.canResume, true);
    r = await c("POST", "/api/dienst/resume");
    assert.equal(r.status, 200, r.text);
    assert.equal((await c("GET", "/api/dienst/billing")).json.status, "ready");
  });

  await t.test("aanbieder: lijst, huisstijl, uitnodiging, hulpvragen, berichten, extra gebruikers, gezondheid", async () => {
    // De openbare lijst van aanbieders (normaal aanbieders.json op GitHub)
    const list = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify([{ naam: "Dienst Test", url: PUBLIC, land: "NL" }, { naam: "Kapot", url: "ftp://nee" }, { naam: "Ander", url: "https://ander.example" }])); });
    await new Promise<void>((r) => list.listen(0, "127.0.0.1", () => r()));
    process.env.EIGEN_AANBIEDERS_URL = `http://127.0.0.1:${(list.address() as { port: number }).port}/aanbieders.json`;
    t.after(() => { list.close(); delete process.env.EIGEN_AANBIEDERS_URL; });
    let r = await c("GET", "/api/aanbieders");
    assert.deepEqual(r.json.aanbieders.map((a: any) => a.url), [PUBLIC, "https://ander.example"], "ongeldige regels overgeslagen, standaard niet dubbel");

    // Huisstijl en een uitnodigingscode bij de aanbieder
    const { updateBrand } = await import("../src/broker/brand.js");
    updateBrand(broker.ctx, { name: "Van Es Cloud", accentColor: "#123abc", contact: { email: "hulp@vanes.test" } });
    r = await c("GET", `/api/aanbieder/brand?url=${encodeURIComponent(PUBLIC)}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, "Van Es Cloud");
    assert.equal(r.json.accentColor, "#123abc");
    assert.ok(r.json.bundles.length >= 1);
    const staff = await import("../src/broker/staff.js");
    const owner = staff.ensureOwner(broker.ctx, "eigenaar@dienst.test", "test") as any;
    const support = await import("../src/broker/support.js");
    const inv = support.createInvite(broker.ctx, owner ?? broker.ctx.db.prepare("SELECT * FROM staff LIMIT 1").get(), { label: "test" });
    r = await c("GET", `/api/aanbieder/invite?url=${encodeURIComponent(PUBLIC)}&code=${inv.code}`);
    assert.equal(r.json.valid, true);
    // De gedeelde link opent een pagina met een knop naar de app
    const page = await (await fetch(`${PUBLIC}/uitnodiging/${inv.code}`)).text();
    assert.match(page, /Je bent uitgenodigd door Van Es Cloud/);
    assert.ok(page.includes(`eigencloud://uitnodiging?dienst=${encodeURIComponent(PUBLIC)}&amp;code=${inv.code}`));
    assert.match(await (await fetch(`${PUBLIC}/uitnodiging/NEPCODE1`)).text(), /werkt niet meer/);
    assert.match((await c("POST", "/api/dienst/select", { url: "https://ander.example" })).json.error, /al een abonnement/, "wisselen kan niet met een lopend abonnement");
    r = await c("POST", "/api/dienst/select", { url: PUBLIC, invite: inv.code });
    assert.equal(r.status, 200, r.text);
    let conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dienst.url, PUBLIC);
    assert.equal(conf.dienst.invite, inv.code);
    assert.equal(conf.dienst.orderId, orderId, "bestaande bestelling blijft");

    // Hulpvraag stellen, antwoord van de aanbieder lezen, reageren
    r = await c("POST", "/api/dienst/tickets", { subject: "Mail komt niet aan", message: "Sinds vanochtend geen mail." });
    assert.equal(r.status, 200, r.text);
    const tid = r.json.id;
    const trow = broker.ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(tid) as any;
    await support.staffReply(broker.ctx, broker.ctx.db.prepare("SELECT * FROM staff LIMIT 1").get() as any, trow, { message: "We kijken ernaar." });
    r = await c("GET", `/api/dienst/ticket?id=${tid}`);
    assert.deepEqual(r.json.messages.map((m: any) => m.from), ["customer", "staff"]);
    assert.equal((await c("POST", "/api/dienst/ticket/reply", { id: tid, message: "Dank je!" })).status, 200);
    assert.equal((await c("GET", "/api/dienst/tickets")).json.tickets.length, 1);

    // Bericht van de aanbieder
    support.createAnnouncement(broker.ctx, null, { title: "Onderhoud zondag", body: "Even geen mail tussen 2 en 3 uur.", severity: "onderhoud" });
    r = await c("GET", "/api/dienst/announcements");
    assert.equal(r.json.announcements[0].title, "Onderhoud zondag");

    // Extra gebruikers: Mollie-bedrag en het aantal voor de cloud
    const included = (await c("GET", "/api/dienst/billing")).json.users.included;
    r = await c("POST", "/api/dienst/users", { count: 2 });
    assert.equal(r.status, 200, r.text);
    const before = included;
    assert.equal(r.json.maxUsers, included + 2);
    assert.equal((await c("GET", "/api/config")).json.maxUsers, included + 2);

    // Wat de cloud meekrijgt: het aantal gebruikers en waar hij zijn gezondheid meldt
    const { consoleSettings } = await import("../src/cluster/admin.js");
    const vaultMod = await import("../src/console/vault.js");
    const v = new vaultMod.Vault(process.env.EIGEN_VAULT!);
    v.unlock("vier losse woorden hier");
    // (het eerdere deel nam het pakket over op een losse kopie van de kluis; hier opnieuw, zoals na "toepassen")
    const kit = await (await fetch(`${PUBLIC}/v1/orders/${orderId}/kit`, { headers: { authorization: `Bearer ${v.config!.console.dienst!.token}` } })).json() as any;
    v.config!.dns = [{ type: "desec", name: "dienst", token: kit.dns.token, zone: kit.dns.zone, api: kit.dns.api }];
    v.config!.console.dienst = { ...v.config!.console.dienst, applied: true };
    const cs = consoleSettings(v.config! as any);
    assert.equal(cs.max_users, String(before + 2));
    const rep = JSON.parse(cs.dienst_report);
    assert.equal(rep.url, PUBLIC);
    assert.equal(rep.orderId, orderId);
    // ...en dat token werkt echt bij de aanbieder
    const h = await fetch(`${PUBLIC}/v1/orders/${orderId}/health`, { method: "POST", headers: { "content-type": "application/json", authorization: `Token ${rep.token}` }, body: JSON.stringify({ version: "1.8", healthy: true, problems: [], storageUsedBytes: 1234, users: 3, nodes: [] }) });
    assert.equal(h.status, 200, await h.text());
  });

  await t.test("herstellen via de dienst op een nieuw toestel (e-mail, code, sleutel)", async () => {
    process.env.EIGEN_VAULT = path.join(base, "kluis-nieuw.json");
    const { buildConsole: build2 } = await import(`../src/console/server.js?nieuw=${Date.now()}`);
    const app2 = await build2();
    t.after(() => app2.close());
    const c2 = client(app2);
    const key = "a".repeat(64);
    assert.match((await c2("POST", "/api/setup/recover-dienst", { masterKey: key, passphrase: "vier losse woorden hier" })).json.error, /Log eerst in/);
    assert.match((await c2("POST", "/api/recover/dienst/verify", { code: "123456" })).json.error, /e-mailadres/);
    const before = smtp.mails.length;
    assert.equal((await c2("POST", "/api/recover/dienst/login", { email: "rene@elders.example" })).status, 200);
    let mail;
    for (let i = 0; i < 100 && !mail; i++) { mail = smtp.mails.slice(before).find((m) => /inlogcode: \d{6}/.test(m.data)); if (!mail) await new Promise((res) => setTimeout(res, 30)); }
    assert.equal((await c2("POST", "/api/recover/dienst/verify", { code: "000000" })).status, 400);
    assert.equal((await c2("POST", "/api/recover/dienst/verify", { code: /inlogcode: (\d{6})/.exec(mail!.data)![1] })).status, 200);
    assert.match((await c2("POST", "/api/setup/recover-dienst", { masterKey: "kort", passphrase: "vier losse woorden hier" })).json.error, /64 tekens/);

    // De dienst geeft de opslag van het pakket terug; daar zoekt de console de configuratie.
    const extras = await import("../src/console/extras.js");
    const vaultMod = await import("../src/console/vault.js");
    const v = new vaultMod.Vault(path.join(base, "kluis.json"));
    v.unlock("vier losse woorden hier");
    const { order, kit } = await extras.dienstOrderKit(v.config!.console.dienst!.token!);
    assert.equal(order.id, orderId);
    assert.deepEqual(kit.storage.map((s) => s.purpose).sort(), ["backup", "replica"]);
    assert.ok(kit.storage.every((s) => s.accessKey && s.secretKey));
    assert.equal(fs.existsSync(process.env.EIGEN_VAULT!), false, "zonder geslaagd herstel geen kluis");
  });
});
