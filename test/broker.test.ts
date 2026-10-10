/**
 * Eigen Cloud Dienst van begin tot eind, tegen een nep-Mollie, -Openprovider, -deSEC en -Scaleway
 * en een nep-mailserver: inloggen → domein → bestellen → betalen → klaarzetten → pakket → DNS-proxy →
 * incasso mislukt → bewaker → opschorten/hervatten → opzeggen → opruimen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { addMonths, todayNl, paidThrough } from "../src/broker/context.js";
import { parsePhone, parseDnskey, txtRecord, subnameOf, temRecords } from "../src/broker/provision.js";
import { retryOrder, suspendOrder, resumeOrder, cleanupOrder } from "../src/broker/ops.js";
import { runGuard } from "../src/broker/guard.js";
import { DesecDns } from "../src/cluster/dns.js";
import { freePort } from "./helpers/cluster.js";
import { smtpSink, fakeUpstream, fakeMandate } from "./helpers/broker-fakes.js";
import { vatSplit, euro, periodLabel, dateNl, periodStartFor, readInvoice, type InvoiceRow } from "../src/broker/invoice.js";
import { mandateLabel, nlMidnight } from "../src/broker/billing.js";

// ───────── De test ─────────

test("Eigen Cloud Dienst: van inloggen tot opruimen", { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dienst-"));
  const smtp = await smtpSink();
  const up = fakeUpstream();
  const upPort = await up.listening;
  const port = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`;
  const U = `http://127.0.0.1:${upPort}`;
  const cfg = loadConfig({
    BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC,
    BROKER_TERMS_URL: "https://dienst.test/voorwaarden",
    MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
    OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
    DESEC_TOKEN: "desec-dienst", DESEC_URL: `${U}/desec`,
    SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
    BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: "Eigen Cloud Dienst <dienst@dienst.test>",
    BROKER_ADMIN_EMAIL: "beheer@dienst.test", BROKER_LOOP_MS: "20",
    BROKER_COMPANY_NAME: "Van Es Diensten B.V.", BROKER_COMPANY_ADDRESS: "Blaak 10\\n3011 TA Rotterdam",
    BROKER_COMPANY_KVK: "12345678", BROKER_COMPANY_VAT: "NL001234567B01",
  });
  assert.deepEqual(cfg.company.address, ["Blaak 10", "3011 TA Rotterdam"]);
  assert.equal(cfg.vatPercent, 21);
  assert.equal(fs.statSync(path.join(dir, "geheim.key")).mode & 0o777, 0o600, "sleutel alleen voor de eigenaar");
  const broker = await createBroker(cfg);
  await broker.app.listen({ port, host: "127.0.0.1" });
  t.after(async () => { await broker.close(); await up.close(); await smtp.close(); if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); });

  const api = async (method: string, p: string, body?: unknown, token?: string) => {
    const r = await fetch(PUBLIC + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const webhook = async (id: string) => {
    const r = await fetch(`${PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${id}` });
    assert.equal(r.status, 200);
    await broker.idle();
  };
  const waitMail = async (to: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const m = smtp.mails.find((x) => x.to.includes(to) && re.test(x.data));
      if (m) return m;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`geen mail aan ${to} met ${re}`);
  };
  const mailCount = (to: string, re: RegExp) => smtp.mails.filter((x) => x.to.includes(to) && re.test(x.data)).length;
  const login = async (email: string) => {
    assert.equal((await api("POST", "/v1/auth/start", { email })).status, 202);
    const m = await waitMail(email, /inlogcode/);
    const code = /inlogcode: (\d{6})/.exec(m.data)![1];
    smtp.mails.splice(smtp.mails.indexOf(m), 1);
    const r = await api("POST", "/v1/auth/verify", { email, code });
    assert.equal(r.status, 200, r.text);
    return r.json as { token: string; customer: { id: string; email: string } };
  };

  const registrant = { firstName: "Rene", lastName: "van Es", street: "Coolsingel", number: "40", zipcode: "3011 AD", city: "Rotterdam", country: "nl", phone: "+31 6 12345678", email: "rene@elders.test" };
  let tokenA = "", tokenB = "", orderId = "", ownOrderId = "";

  const YEAR = todayNl().slice(0, 4);
  const invoices = () => broker.ctx.db.prepare("SELECT * FROM invoices ORDER BY year, seq").all() as InvoiceRow[];
  const invoiceOf = (paymentId: string) => broker.ctx.db.prepare("SELECT * FROM invoices WHERE payment_id = ?").get(paymentId) as InvoiceRow | undefined;
  const billing = async (id: string, token = tokenA) => { const r = await api("GET", `/v1/orders/${id}/billing`, undefined, token); assert.equal(r.status, 200, r.text); return r.json; };
  const subId = () => (broker.ctx.db.prepare("SELECT mollie_subscription_id AS s FROM orders WHERE id = ?").get(orderId) as { s: string }).s;

  await t.test("hulpjes: telefoon, DNSKEY, TXT, datums, TEM-records", () => {
    assert.deepEqual(parsePhone("+31 6 12345678"), { country_code: "+31", area_code: "6", subscriber_number: "12345678" });
    assert.deepEqual(parsePhone("0612345678"), { country_code: "+31", area_code: "6", subscriber_number: "12345678" });
    assert.deepEqual(parsePhone("010-1234567"), { country_code: "+31", area_code: "10", subscriber_number: "1234567" });
    assert.deepEqual(parsePhone("+32 2 1234567"), { country_code: "+32", area_code: "2", subscriber_number: "1234567" });
    assert.deepEqual(parsePhone("+4930123456"), { country_code: "+49", area_code: "30", subscriber_number: "123456" });
    assert.equal(parsePhone("bel me"), null);
    assert.equal(parsePhone("12345"), null);
    assert.deepEqual(parseDnskey("257 3 13 abc def=="), { flags: 257, protocol: 3, alg: 13, pub_key: "abcdef==" });
    const long = txtRecord("x".repeat(300));
    assert.match(long, /^"x{255}" "x{45}"$/);
    assert.equal(subnameOf("p1._domainkey.vanes.nl.", "vanes.nl"), "p1._domainkey");
    assert.equal(subnameOf("vanes.nl", "vanes.nl"), "");
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2026-10-09", 1), "2026-11-09");
    assert.equal(paidThrough("2026-11-09", "2026-10-20"), "2026-11-09");
    assert.equal(paidThrough("2026-11-09", "2026-12-09"), "2027-01-09");
    assert.deepEqual(temRecords({ spf_config: "include:_spf.tem.scaleway.com", dkim_config: "v=DKIM1; p=AB" }, "p1"),
      { dkim: { name: "p1._domainkey", value: "v=DKIM1; p=AB" }, dmarc: null, spfExtra: "include:_spf.tem.scaleway.com" });
  });

  await t.test("info", async () => {
    const r = await api("GET", "/v1/info");
    assert.equal(r.json.name, "Eigen Cloud Dienst");
    assert.deepEqual(r.json.bundles.map((b: any) => b.id), ["compleet", "ruim"]);
    assert.deepEqual(r.json.bundles[0].monthly, { currency: "EUR", value: "24.95" });
    assert.equal(r.json.bundles[0].includes.dataServers, 2);
    assert.equal(r.json.termsUrl, "https://dienst.test/voorwaarden");
    assert.equal(r.json.privacyUrl, null);
  });

  await t.test("inloggen met een code: fout, te vaak, goed; snelheidslimiet", async () => {
    assert.equal((await api("POST", "/v1/auth/start", { email: "geen-adres" })).status, 400);
    assert.equal((await api("POST", "/v1/auth/start", { email: "Rene@Vanes.test" })).status, 202);
    const m = await waitMail("rene@vanes.test", /inlogcode/);
    const code = /inlogcode: (\d{6})/.exec(m.data)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    let r = await api("POST", "/v1/auth/verify", { email: "rene@vanes.test", code: wrong });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /klopt niet/);
    r = await api("POST", "/v1/auth/verify", { email: "rene@vanes.test", code });
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.equal(r.json.customer.email, "rene@vanes.test");
    tokenA = r.json.token;
    // Code is eenmalig
    assert.equal((await api("POST", "/v1/auth/verify", { email: "rene@vanes.test", code })).status, 400);
    // Sessie werkt; opnieuw inloggen geeft dezelfde klant
    const me = await api("GET", "/v1/me", undefined, tokenA);
    assert.equal(me.json.customer.email, "rene@vanes.test");
    assert.deepEqual(me.json.orders, []);
    assert.equal((await api("GET", "/v1/me", undefined, "f".repeat(64))).status, 401);

    // Vijf keer fout → code vervalt, ook de goede werkt dan niet meer
    assert.equal((await api("POST", "/v1/auth/start", { email: "raden@vanes.test" })).status, 202);
    const m2 = await waitMail("raden@vanes.test", /inlogcode/);
    const good = /inlogcode: (\d{6})/.exec(m2.data)![1];
    const bad = good === "123456" ? "654321" : "123456";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api("POST", "/v1/auth/verify", { email: "raden@vanes.test", code: bad })).status);
    assert.deepEqual(statuses, [400, 400, 400, 400, 429]);
    assert.equal((await api("POST", "/v1/auth/verify", { email: "raden@vanes.test", code: good })).status, 400);

    // Hooguit 5 codes per adres per uur
    const starts: number[] = [];
    for (let i = 0; i < 6; i++) starts.push((await api("POST", "/v1/auth/start", { email: "spam@vanes.test" })).status);
    assert.deepEqual(starts, [202, 202, 202, 202, 202, 429]);

    tokenB = (await login("ander@klant.test")).token;
  });

  await t.test("domein controleren (en Openprovider-token verversen)", async () => {
    let r = await api("GET", "/v1/domains/check?name=Vanes.nl");
    assert.deepEqual(r.json, { domain: "vanes.nl", available: true, price: { currency: "EUR", value: "6.50" } });
    up.st.op.tokenValid = false; // token verlopen → 401 → opnieuw inloggen
    r = await api("GET", "/v1/domains/check?name=bezet.nl");
    assert.deepEqual(r.json, { domain: "bezet.nl", available: false, price: null });
    assert.equal(up.count("POST", /^\/op\/auth\/login$/), 2);
    assert.equal((await api("GET", "/v1/domains/check?name=niet%20goed")).status, 400);
    const check = up.calls.find((c) => c.path === "/op/domains/check")!;
    assert.deepEqual(check.body, { domains: [{ name: "vanes", extension: "nl" }], with_price: true });
  });

  await t.test("bestellen: controles en betaallink", async () => {
    const base = { bundle: "compleet", domain: { mode: "register", name: "vanes.nl" }, registrant, acceptTerms: true };
    assert.equal((await api("POST", "/v1/orders", base)).status, 401);
    const bad = async (body: unknown, re: RegExp, status = 400) => {
      const r = await api("POST", "/v1/orders", body, tokenA);
      assert.equal(r.status, status, r.text);
      assert.match(r.json.error, re);
    };
    await bad({ ...base, bundle: "goud" }, /bundel/);
    await bad({ ...base, acceptTerms: false }, /voorwaarden/);
    await bad({ ...base, domain: { mode: "kopen", name: "vanes.nl" } }, /domeinnaam/);
    await bad({ ...base, domain: { mode: "register", name: "vanes" } }, /geen geldige domeinnaam/);
    await bad({ ...base, registrant: undefined }, /houder.*voornaam, achternaam/);
    await bad({ ...base, registrant: { ...registrant, phone: "bel me" } }, /telefoonnummer/);
    await bad({ ...base, registrant: { ...registrant, country: "Nederland" } }, /landcode/);
    await bad({ ...base, domain: { mode: "transfer", name: "vanes.nl" } }, /verhuiscode/);
    await bad({ ...base, domain: { mode: "register", name: "bezet.nl" } }, /niet \(meer\) vrij/, 409);
    assert.equal(up.count("POST", /^\/mollie\//), 0, "nog niets bij Mollie");

    const r = await api("POST", "/v1/orders", base, tokenA);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.orderId, /^[0-9a-f]{16}$/);
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\//);
    orderId = r.json.orderId;
    const pay = up.calls.find((c) => c.method === "POST" && c.path === "/mollie/payments")!;
    assert.deepEqual(pay.body.amount, { currency: "EUR", value: "24.95" });
    assert.equal(pay.body.sequenceType, "first");
    assert.equal(pay.body.redirectUrl, `${PUBLIC}/betaald?order=${orderId}`);
    assert.equal(pay.body.webhookUrl, `${PUBLIC}/v1/mollie/webhook`);
    assert.deepEqual(pay.body.metadata, { orderId });
    assert.equal(pay.body.customerId, up.st.mollie.customers[0].id);
    assert.deepEqual({ name: up.st.mollie.customers[0].name, email: up.st.mollie.customers[0].email }, { name: "Rene van Es", email: "rene@vanes.test" });

    // Tweede bestelling (eigen domein): geen tweede Mollie-klant
    const r2 = await api("POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "eigendomein.test" }, acceptTerms: true }, tokenA);
    assert.equal(r2.status, 200, r2.text);
    ownOrderId = r2.json.orderId;
    assert.equal(up.count("POST", /^\/mollie\/customers$/), 1);

    const o = await api("GET", `/v1/orders/${orderId}`, undefined, tokenA);
    assert.equal(o.json.status, "awaiting_payment");
    assert.equal(o.json.domain, "vanes.nl");
    assert.deepEqual(o.json.steps.map((s: any) => s.id), ["payment", "dns-zone", "domain", "scaleway-project", "scaleway-iam", "mail", "dns-token", "ready"]);
    assert.equal(o.json.steps[0].state, "busy");
    assert.equal((await api("GET", `/v1/orders/${orderId}/kit`, undefined, tokenA)).status, 409);

    const page = await fetch(`${PUBLIC}/betaald?order=${orderId}`);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(await page.text(), /Betaling ontvangen/);
  });

  await t.test("webhook: open doet niets, betaald → abonnement en klaarzetten", async () => {
    const payId: string = [...up.st.mollie.payments.values()].find((p) => p.metadata.orderId === orderId)!.id;
    await webhook(payId);
    assert.equal((await api("GET", `/v1/orders/${orderId}`, undefined, tokenA)).json.status, "awaiting_payment");
    assert.equal(up.count("POST", /subscriptions$/), 0);
    await webhook("tr_bestaatniet");
    await webhook("geen-mollie-id");

    up.st.mollie.payments.get(payId).status = "paid";
    up.st.mollie.payments.get(payId).mandateId = "mdt_1";
    up.st.mollie.payments.get(payId).method = "ideal";
    up.st.mollie.payments.get(payId).paidAt = new Date().toISOString();
    // Na een eerste betaling met iDEAL maakt Mollie een SEPA-machtiging aan.
    up.st.mollie.mandates.push({ ...fakeMandate("mdt_1", up.st.mollie.customers[0].id, "directdebit"), createdAt: "2026-01-01T10:00:00+00:00" });
    await webhook(payId);
    const o = await api("GET", `/v1/orders/${orderId}`, undefined, tokenA);
    assert.equal(o.json.status, "ready", JSON.stringify(o.json));
    assert.ok(o.json.steps.every((s: any) => s.state === "done"), JSON.stringify(o.json.steps));
    assert.equal(o.json.steps.find((s: any) => s.id === "domain").detail, "Geregistreerd");

    const sub = up.calls.find((c) => c.method === "POST" && /subscriptions$/.test(c.path))!;
    assert.deepEqual(sub.body.amount, { currency: "EUR", value: "24.95" });
    assert.equal(sub.body.interval, "1 month");
    assert.equal(sub.body.startDate, addMonths(todayNl(), 1));
    assert.equal(sub.body.webhookUrl, `${PUBLIC}/v1/mollie/webhook`);
    assert.deepEqual(sub.body.metadata, { orderId });

    // Openprovider: klant en domein met nameservers en DNSSEC
    const cust = up.calls.find((c) => c.method === "POST" && c.path === "/op/customers")!.body;
    assert.deepEqual(cust.phone, { country_code: "+31", area_code: "6", subscriber_number: "12345678" });
    assert.deepEqual(cust.name, { first_name: "Rene", last_name: "van Es", initials: "R." });
    assert.equal(cust.address.country, "NL");
    const dom = up.calls.find((c) => c.method === "POST" && c.path === "/op/domains")!.body;
    assert.deepEqual(dom.domain, { name: "vanes", extension: "nl" });
    assert.deepEqual(dom.name_servers, [{ name: "ns1.desec.io" }, { name: "ns2.desec.org" }]);
    assert.equal(dom.owner_handle, up.st.op.customers[0].handle);
    assert.equal(dom.is_dnssec_enabled, true);
    assert.deepEqual(dom.dnssec_keys[0], { flags: 257, protocol: 3, alg: 13, pub_key: up.st.desec.zones.get("vanes.nl")!.keys[0].dnskey.split(" ")[3] });
    assert.equal(dom.auth_code, undefined);

    // Scaleway: project, applicatie, policy alleen voor dat project, sleutel
    const proj = up.st.scw.projects[0];
    assert.match(proj.name, new RegExp(`^eigen-cloud-[0-9a-f]{12}-${orderId.slice(0, 8)}$`));
    assert.equal(proj.organization_id, "org-1");
    const pol = up.st.scw.policies[0];
    assert.deepEqual(pol.rules, [{ permission_set_names: ["InstancesFullAccess", "BlockStorageFullAccess", "ObjectStorageFullAccess", "TransactionalEmailFullAccess"], project_ids: [proj.id] }]);
    assert.equal(pol.application_id, up.st.scw.applications[0].id);
    assert.equal(up.st.scw.apiKeys[0].default_project_id, proj.id);
    assert.ok(up.calls.filter((c) => c.path.startsWith("/scw/")).every((c) => c.headers["x-auth-token"] === "scw-org-geheim"));

    // Mail: DKIM en DMARC in de zone, geen SPF aan de apex
    const z = up.st.desec.zones.get("vanes.nl")!;
    const dkim = z.rrsets.get(`${proj.id}._domainkey/TXT`);
    assert.ok(dkim, "DKIM-record staat in de zone");
    assert.match(dkim.records[0], /^"v=DKIM1; h=sha256; k=rsa; p=A+" "A+IDAQAB"$/);
    assert.deepEqual(z.rrsets.get("_dmarc/TXT").records, ['"v=DMARC1; p=none"']);
    assert.equal(z.rrsets.get("/TXT"), undefined, "geen SPF: dat doet het cluster");
    assert.ok(up.calls.some((c) => c.method === "POST" && /\/domains\/tem-\d+\/check$/.test(c.path)));
    await waitMail("rene@vanes.test", /klaar om te starten/);
  });

  await t.test("idempotent: webhook en lus nog eens → niets dubbel", async () => {
    const payId = [...up.st.mollie.payments.values()].find((p) => p.metadata.orderId === orderId)!.id;
    await webhook(payId);
    await webhook(payId);
    await broker.runLoop();
    await broker.idle();
    assert.equal(up.count("POST", /\/subscriptions$/), 1);
    assert.equal(up.count("POST", /^\/op\/customers$/), 1);
    assert.equal(up.count("POST", /^\/op\/domains$/), 1);
    assert.equal(up.count("POST", /^\/desec\/domains\/$/), 1);
    assert.equal(up.count("POST", /^\/scw\/account\/v3\/projects$/), 1);
    assert.equal(up.count("POST", /^\/scw\/iam\/v1alpha1\/applications$/), 1);
    assert.equal(up.count("POST", /^\/scw\/iam\/v1alpha1\/policies$/), 1);
    assert.equal(up.count("POST", /^\/scw\/iam\/v1alpha1\/api-keys$/), 1);
    assert.equal(up.count("POST", /\/transactional-email\/v1alpha1\/regions\/fr-par\/domains$/), 1);
    assert.equal(mailCount("rene@vanes.test", /klaar om te starten/), 1);
  });

  let kit: any;
  await t.test("pakket: inhoud en versleuteld bewaard", async () => {
    const r = await api("GET", `/v1/orders/${orderId}/kit`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    kit = r.json;
    const proj = up.st.scw.projects[0];
    const key = up.st.scw.apiKeys[0];
    assert.equal(kit.domain, "vanes.nl");
    assert.deepEqual(kit.nameservers, ["ns1.desec.io", "ns2.desec.org"]);
    assert.equal(kit.delegated, true);
    assert.deepEqual(kit.provider, { id: "scaleway", fields: { secretKey: key.secret_key, projectId: proj.id } });
    assert.deepEqual(kit.storage, [
      { offer: "scaleway", region: "nl-ams", accessKey: key.access_key, secretKey: key.secret_key, purpose: "replica" },
      { offer: "scaleway", region: "fr-par", accessKey: key.access_key, secretKey: key.secret_key, purpose: "backup" },
    ]);
    assert.deepEqual(kit.placement, cfg.bundles[0].placement);
    assert.deepEqual(kit.policy, { minDataNodes: 2, witnesses: 1 });
    assert.equal(kit.dns.type, "desec");
    assert.equal(kit.dns.name, "dienst");
    assert.equal(kit.dns.zone, "vanes.nl");
    assert.equal(kit.dns.api, `${PUBLIC}/v1/desec`);
    assert.match(kit.dns.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(kit.mailRelay, { host: "smtp.tem.scaleway.com", port: 587, user: proj.id, password: key.secret_key, secure: false });
    assert.equal(kit.spfExtra, "include:_spf.tem.scaleway.com");

    // Niets geheims leesbaar in de databasebestanden
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("dienst.sqlite")).map((f) => fs.readFileSync(path.join(dir, f)));
    for (const secret of [key.secret_key, kit.dns.token, "Coolsingel", "+31 6 12345678"]) {
      assert.ok(files.every((b) => !b.includes(secret)), `${secret} staat leesbaar in de database`);
    }
  });

  await t.test("rekenen voor facturen: btw, bedragen, periodes, machtigingen", () => {
    assert.deepEqual(vatSplit(2495, 21), { excl: 2062, vat: 433 });
    assert.deepEqual(vatSplit(3995, 21), { excl: 3302, vat: 693 });
    assert.deepEqual(vatSplit(1, 21), { excl: 1, vat: 0 });
    for (let c = 1; c < 20000; c += 7) { const v = vatSplit(c, 21); assert.equal(v.excl + v.vat, c); }
    assert.deepEqual(vatSplit(1000, 9), { excl: 917, vat: 83 });
    assert.equal(euro("24.95"), "€ 24,95");
    assert.equal(euro(123456), "€ 1.234,56");
    assert.equal(euro(5), "€ 0,05");
    assert.equal(dateNl("2026-10-10"), "10 oktober 2026");
    assert.equal(periodLabel("2026-10-10"), "10 oktober – 9 november 2026");
    assert.equal(periodLabel("2026-12-15"), "15 december 2026 – 14 januari 2027");
    assert.equal(periodLabel("2026-01-31"), "31 januari – 27 februari 2026");
    assert.equal(periodStartFor("2026-11-09", "2027-01-20"), "2027-01-09");
    assert.equal(periodStartFor("2026-11-09", "2026-11-09"), "2026-11-09");
    assert.equal(periodStartFor("2026-11-09", "2026-10-10"), "2026-10-10");
    assert.equal(mandateLabel(fakeMandate("m", "c", "directdebit")), "NL** **** **** 4567");
    assert.equal(mandateLabel(fakeMandate("m", "c", "creditcard")), "Visa •••• 4242");
    assert.equal(mandateLabel({ method: "paypal", details: {} }), "PayPal");
    assert.equal(new Date(nlMidnight("2026-11-10")).toISOString(), "2026-11-09T23:00:00.000Z");
    assert.equal(new Date(nlMidnight("2026-07-01")).toISOString(), "2026-06-30T22:00:00.000Z");
  });

  await t.test("abonnement: overzicht na de eerste betaling, factuur EC-<jaar>-0001", async () => {
    const b = await billing(orderId);
    const [inv] = invoices();
    assert.equal(inv.number, `EC-${YEAR}-0001`);
    assert.equal(inv.order_id, orderId);
    assert.equal(inv.amount, "24.95");
    const firstPay = up.calls.find((c) => c.method === "POST" && c.path === "/mollie/payments")!;
    assert.deepEqual(b, {
      orderId, status: "ready", domain: "vanes.nl",
      bundle: { id: "compleet", title: "Compleet", monthly: { currency: "EUR", value: "24.95" } },
      nextPaymentDate: addMonths(todayNl(), 1),
      endsAt: null,
      mandate: { method: "directdebit", label: "NL** **** **** 4567", status: "valid" },
      payments: [{ id: inv.payment_id, date: todayNl(), amount: { currency: "EUR", value: "24.95" }, status: "paid", description: firstPay.body.description, invoiceId: inv.id }],
      outstanding: null,
      bundles: [
        { id: "compleet", title: "Compleet", monthly: { currency: "EUR", value: "24.95" }, current: true },
        { id: "ruim", title: "Ruim", monthly: { currency: "EUR", value: "39.95" }, current: false },
      ],
      canResume: false,
      domainTransferable: true,
    });
    const d = readInvoice(broker.ctx, inv);
    assert.deepEqual({ incl: d.amountIncl, excl: d.amountExcl, vat: d.vatAmount, pct: d.vatPercent }, { incl: "24.95", excl: "20.62", vat: "4.33", pct: 21 });
    assert.equal(d.description, "Eigen Cloud Compleet — vanes.nl");
    assert.equal(d.period, periodLabel(todayNl()));
    assert.equal(d.method, "iDEAL");
    assert.deepEqual(d.customer, { name: "Rene van Es", company: null, address: ["Coolsingel 40", "3011 AD Rotterdam"], email: "rene@vanes.test" });
    assert.deepEqual(d.seller, { name: "Van Es Diensten B.V.", address: ["Blaak 10", "3011 TA Rotterdam"], kvk: "12345678", vat: "NL001234567B01" });
    const m = await waitMail("rene@vanes.test", new RegExp(`Factuur EC-${YEAR}-0001`));
    assert.match(m.data, /Abonnement/);

    // Eigen-domein-bestelling, nog niet betaald: geen machtiging, geen domein om mee te nemen.
    const own = await billing(ownOrderId);
    assert.equal(own.status, "awaiting_payment");
    assert.deepEqual(own.payments, []);
    assert.equal(own.mandate, null);
    assert.equal(own.domainTransferable, false);
  });

  await t.test("factuur als HTML: alleen voor de eigen klant", async () => {
    const [inv] = invoices();
    const r = await fetch(`${PUBLIC}/v1/invoices/${inv.id}`, { headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /^text\/html/);
    const html = await r.text();
    for (const want of [`<title>Factuur EC-${YEAR}-0001</title>`, ">Factuur<", `EC-${YEAR}-0001`, "€ 24,95", "€ 20,62", "€ 4,33", "Btw 21%",
      "Van Es Diensten B.V.", "Blaak 10", "3011 TA Rotterdam", "KvK 12345678", "Btw-nummer NL001234567B01",
      "Rene van Es", "Coolsingel 40", "3011 AD Rotterdam", "rene@vanes.test", "Eigen Cloud Compleet — vanes.nl", periodLabel(todayNl()),
      `Betaald op ${dateNl(todayNl())} via iDEAL`, "@page", "size:A4", orderId]) assert.ok(html.includes(want), `factuur mist ${want}`);
    assert.ok(!/<(script|link)\b/.test(html), "zelfstandig: geen scripts of stylesheets van buiten");
    assert.ok(!html.includes("Bedrijfsgegevens ontbreken"));
    assert.equal((await api("GET", `/v1/invoices/${inv.id}`, undefined, tokenB)).status, 404);
    assert.equal((await api("GET", `/v1/invoices/${inv.id}`)).status, 401);
    assert.equal((await api("GET", "/v1/invoices/bestaatniet", undefined, tokenA)).status, 404);
    assert.equal((await api("GET", `/v1/orders/${orderId}/billing`, undefined, tokenB)).status, 404);
    assert.equal((await api("GET", `/v1/orders/${orderId}/billing`)).status, 401);

    // Zonder bedrijfsnaam: duidelijke melding op de factuur (die wordt bij het maken vastgelegd).
    const { renderInvoiceHtml } = await import("../src/broker/invoice.js");
    assert.match(renderInvoiceHtml({ ...readInvoice(broker.ctx, inv), seller: null }), /Bedrijfsgegevens ontbreken \(stel BROKER_COMPANY_\* in\)/);
  });

  await t.test("maandelijkse incasso betaald → factuur 0002; webhook twee keer → één factuur", async () => {
    const cid = up.st.mollie.customers[0].id;
    up.st.mollie.payments.set("tr_rp1", { id: "tr_rp1", status: "paid", method: "directdebit", sequenceType: "recurring", subscriptionId: subId(), customerId: cid, mandateId: "mdt_1",
      metadata: { orderId }, amount: { currency: "EUR", value: "24.95" }, description: `Eigen Cloud Compleet — vanes.nl (${orderId.slice(0, 8)})`, createdAt: new Date().toISOString(), paidAt: new Date().toISOString() });
    await webhook("tr_rp1");
    await webhook("tr_rp1");
    assert.equal(invoices().length, 2);
    assert.equal(invoiceOf("tr_rp1")!.number, `EC-${YEAR}-0002`);
    assert.equal(readInvoice(broker.ctx, invoiceOf("tr_rp1")!).method, "SEPA-incasso");
    await waitMail("rene@vanes.test", new RegExp(`Factuur EC-${YEAR}-0002`));
    assert.equal(mailCount("rene@vanes.test", new RegExp(`Factuur EC-${YEAR}-0002`)), 1);
    const b = await billing(orderId);
    assert.equal(b.status, "ready");
    assert.deepEqual(b.payments.map((p: any) => [p.id, p.invoiceId]), [["tr_rp1", invoiceOf("tr_rp1")!.id], [invoices()[0].payment_id, invoices()[0].id]]);
    // Eén factuur per betaling, ook als de database het zelf moet afdwingen.
    assert.throws(() => broker.ctx.db.prepare("INSERT INTO invoices (id, number, year, seq, order_id, customer_id, payment_id, date, amount, data_enc, created_at) VALUES ('x', 'EC-x', 1, 1, 'o', 'c', 'tr_rp1', 'd', '1', x'00', 0)").run(), /UNIQUE/);
  });

  await t.test("een andere klant ziet niets", async () => {
    assert.equal((await api("GET", `/v1/orders/${orderId}`, undefined, tokenB)).status, 404);
    assert.equal((await api("GET", `/v1/orders/${orderId}/kit`, undefined, tokenB)).status, 404);
    assert.equal((await api("POST", `/v1/orders/${orderId}/cancel`, undefined, tokenB)).status, 404);
    assert.deepEqual((await api("GET", "/v1/me", undefined, tokenB)).json.orders, []);
    assert.equal((await api("GET", `/v1/orders/${orderId}/kit`)).status, 401);
    // Een tweede bestelling voor hetzelfde domein door iemand anders kan niet
    const r = await api("POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "vanes.nl" }, acceptTerms: true }, tokenB);
    assert.equal(r.status, 409);
  });

  await t.test("DNS-proxy: eigen zone wel, andere zone en fout token niet; DesecDns werkt erdoorheen", async () => {
    const proxy = (method: string, p: string, token: string, body?: unknown) =>
      fetch(`${PUBLIC}/v1/desec${p}`, { method, headers: { authorization: `Token ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let r = await proxy("GET", "/domains/vanes.nl/", kit.dns.token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).name, "vanes.nl");
    const before = up.calls.length;
    const dns = new DesecDns("dienst", { token: kit.dns.token, zone: kit.dns.zone, api: kit.dns.api });
    await dns.setRecords("cloud", "A", ["1.2.3.4", "5.6.7.8"], 300);
    const fwd = up.calls.slice(before).find((c) => c.method === "PUT")!;
    assert.equal(fwd.path, "/desec/domains/vanes.nl/rrsets/");
    assert.equal(fwd.headers.authorization, "Token desec-dienst", "doorgestuurd met het token van de dienst");
    assert.deepEqual(up.st.desec.zones.get("vanes.nl")!.rrsets.get("cloud/A").records, ["1.2.3.4", "5.6.7.8"]);
    r = await proxy("GET", "/domains/vanes.nl/rrsets/cloud/A/", kit.dns.token);
    assert.equal(r.status, 200);
    r = await proxy("DELETE", "/domains/vanes.nl/rrsets/cloud/A/", kit.dns.token);
    assert.equal(r.status, 204);
    r = await proxy("GET", "/domains/vanes.nl/rrsets/cloud/A/", kit.dns.token);
    assert.equal(r.status, 404, "status van deSEC wordt doorgegeven");

    r = await proxy("PUT", "/domains/ander.nl/rrsets/", kit.dns.token, [{ subname: "x", type: "A", ttl: 3600, records: ["1.1.1.1"] }]);
    assert.equal(r.status, 403);
    assert.match((await r.json() as any).error, /hoort niet bij dit domein/);
    r = await proxy("GET", "/domains/vanes.nl/", "0".repeat(64));
    assert.equal(r.status, 403);
    r = await proxy("GET", "/domains/vanes.nl/", "kapot");
    assert.equal(r.status, 403);
    r = await proxy("DELETE", "/domains/vanes.nl/", kit.dns.token);
    assert.equal(r.status, 403, "zone zelf weggooien mag niet");
    await assert.rejects(new DesecDns("x", { token: "0".repeat(64), zone: "vanes.nl", api: kit.dns.api }).setRecords("cloud", "A", ["1.2.3.4"], 300), /403/);
  });

  await t.test("tijdelijke fout wordt later opnieuw geprobeerd (eigen domein)", async () => {
    up.st.scw.failNext.add("/account/v3/projects");
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata.orderId === ownOrderId)!;
    pay.status = "paid";
    await webhook(pay.id);
    let o = await api("GET", `/v1/orders/${ownOrderId}`, undefined, tokenA);
    assert.equal(o.json.status, "provisioning");
    const step = o.json.steps.find((s: any) => s.id === "scaleway-project");
    assert.equal(step.state, "busy");
    assert.match(step.detail, /opnieuw/);
    assert.match(o.json.steps.find((s: any) => s.id === "domain").detail, /ns1\.desec\.io en ns2\.desec\.org/);
    await new Promise((r) => setTimeout(r, 60));
    await broker.runLoop();
    o = await api("GET", `/v1/orders/${ownOrderId}`, undefined, tokenA);
    assert.equal(o.json.status, "ready", JSON.stringify(o.json.steps));
    assert.equal(up.count("POST", /^\/op\/domains$/), 1, "eigen domein: niets bij de registrar");
    const k = (await api("GET", `/v1/orders/${ownOrderId}/kit`, undefined, tokenA)).json;
    assert.equal(k.delegated, false);
    assert.notEqual(k.provider.fields.projectId, kit.provider.fields.projectId, "elk abonnement een eigen project");
  });

  await t.test("blijvende fout → mislukt + melding; na herstel 'opnieuw'", async () => {
    const r = await api("POST", "/v1/orders", { bundle: "ruim", domain: { mode: "register", name: "weigeren.nl" }, registrant, acceptTerms: true }, tokenB);
    assert.equal(r.status, 200, r.text);
    up.st.op.rejectNext.add("weigeren");
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata.orderId === r.json.orderId)!;
    pay.status = "paid";
    await webhook(pay.id);
    let o = await api("GET", `/v1/orders/${r.json.orderId}`, undefined, tokenB);
    assert.equal(o.json.status, "failed");
    const step = o.json.steps.find((s: any) => s.id === "domain");
    assert.equal(step.state, "fail");
    assert.match(step.detail, /De domeinnaam kon niet worden geregeld: .*Domain name is not valid/);
    assert.match(o.json.error, /domeinnaam/);
    await waitMail("beheer@dienst.test", /Klaarzetten mislukt/);
    await broker.runLoop();
    assert.equal((await api("GET", `/v1/orders/${r.json.orderId}`, undefined, tokenB)).json.status, "failed", "lus laat mislukte bestellingen met rust");
    assert.equal(await retryOrder(broker.ctx, r.json.orderId), "ready");
    o = await api("GET", `/v1/orders/${r.json.orderId}`, undefined, tokenB);
    assert.equal(o.json.status, "ready");
    assert.equal(o.json.error, undefined);
    const k = (await api("GET", `/v1/orders/${r.json.orderId}/kit`, undefined, tokenB)).json;
    assert.equal(k.placement.length, 4);
    assert.deepEqual(k.policy, { minDataNodes: 3, witnesses: 1 });
  });

  await t.test("maandelijkse incasso mislukt → betalingsprobleem en mail; daarna weer betaald", async () => {
    const order = broker.ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
    const cid = up.st.mollie.customers[0].id;
    up.st.mollie.payments.set("tr_rec1", { id: "tr_rec1", status: "failed", sequenceType: "recurring", subscriptionId: order.mollie_subscription_id, customerId: cid, amount: { currency: "EUR", value: "24.95" } });
    await webhook("tr_rec1");
    assert.equal((await api("GET", `/v1/orders/${orderId}`, undefined, tokenA)).json.status, "payment_problem");
    await waitMail("rene@vanes.test", /niet gelukt/);
    await waitMail("beheer@dienst.test", /Incasso mislukt/);
    assert.equal((await api("GET", `/v1/orders/${orderId}/kit`, undefined, tokenA)).status, 200, "cloud blijft werken");
    await webhook("tr_rec1");
    assert.equal(mailCount("beheer@dienst.test", /Incasso mislukt/), 1, "geen dubbele melding");
    up.st.mollie.payments.set("tr_rec2", { id: "tr_rec2", status: "paid", sequenceType: "recurring", subscriptionId: order.mollie_subscription_id, customerId: cid, amount: { currency: "EUR", value: "24.95" } });
    await webhook("tr_rec2");
    assert.equal((await api("GET", `/v1/orders/${orderId}`, undefined, tokenA)).json.status, "ready");
  });

  await t.test("bewaker: te veel servers → melding (één keer per dag), afdwingen alleen met BROKER_ENFORCE", async () => {
    const proj = kit.provider.fields.projectId;
    const add = (zone: string, n: number, created: string) => up.st.scw.servers.push({ id: `srv-${n}`, name: `n-${n}`, zone, project: proj, state: "running", creation_date: created });
    add("nl-ams-1", 1, "2026-10-01T10:00:00Z"); add("nl-ams-2", 2, "2026-10-01T10:01:00Z"); add("fr-par-1", 3, "2026-10-01T10:02:00Z"); add("nl-ams-1", 4, "2026-10-02T10:00:00Z");
    up.st.scw.servers.push({ id: "srv-elders", name: "x", zone: "nl-ams-1", project: "ander-project", state: "running", creation_date: "2026-10-05T00:00:00Z" });
    assert.deepEqual(await runGuard(broker.ctx), [], "4 = 2 data + 1 witness + 1 reserve: prima");
    add("fr-par-1", 5, "2026-10-03T10:00:00Z");
    const f = await runGuard(broker.ctx);
    assert.deepEqual(f, [{ orderId, domain: "vanes.nl", running: 5, allowed: 4, poweredOff: [] }]);
    await waitMail("beheer@dienst.test", /Te veel servers/);
    await waitMail("rene@vanes.test", /meer servers dan je bundel/);
    assert.equal(up.count("POST", /\/action$/), 0, "standaard niets uitzetten");
    broker.ctx.cfg.enforce = true;
    const g = await runGuard(broker.ctx);
    broker.ctx.cfg.enforce = false;
    assert.deepEqual(g[0].poweredOff, ["fr-par-1/srv-5"], "de nieuwste extra server");
    assert.equal(mailCount("beheer@dienst.test", /Te veel servers/), 1, "hooguit één melding per dag");
    const ev = broker.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'guard-too-many'").get() as { n: number };
    assert.equal(ev.n, 2);
    up.st.scw.servers = up.st.scw.servers.filter((s) => s.id !== "srv-elders");
  });

  await t.test("bundel wisselen: Mollie-bedrag, pakket en bewaker volgen de nieuwe bundel", async () => {
    const bad = async (body: unknown, status: number, re: RegExp, token = tokenA) => {
      const r = await api("POST", `/v1/orders/${orderId}/bundle`, body, token);
      assert.equal(r.status, status, r.text);
      assert.match(r.json.error, re);
    };
    await bad({ bundle: "goud" }, 400, /bestaat niet/);
    await bad({ bundle: "compleet" }, 400, /al/);
    await bad({}, 400, /bestaat niet/);
    await bad({ bundle: "ruim" }, 404, /bestaat niet/, tokenB);
    assert.equal(up.count("PATCH", /subscriptions/), 0);

    // Een vijfde server: te veel voor Compleet (2 + 1 + 1 reserve)…
    up.st.scw.servers.push({ id: "srv-6", name: "n-6", zone: "fr-par-1", project: kit.provider.fields.projectId, state: "running", creation_date: "2026-10-04T10:00:00Z" });
    assert.ok((await runGuard(broker.ctx)).some((f) => f.orderId === orderId && f.allowed === 4 && f.running === 5));

    const r = await api("POST", `/v1/orders/${orderId}/bundle`, { bundle: "ruim" }, tokenA);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, bundle: { id: "ruim", title: "Ruim", monthly: { currency: "EUR", value: "39.95" } }, effective: addMonths(todayNl(), 1) });
    const patch = up.calls.find((c) => c.method === "PATCH" && /subscriptions/.test(c.path))!;
    assert.equal(patch.path, `/mollie/customers/${up.st.mollie.customers[0].id}/subscriptions/${subId()}`);
    assert.deepEqual(patch.body, { amount: { currency: "EUR", value: "39.95" }, description: `Eigen Cloud Ruim — vanes.nl (${orderId.slice(0, 8)})` });
    // …maar prima voor Ruim (3 + 1 + 1): meer servers mogen meteen.
    assert.ok(!(await runGuard(broker.ctx)).some((f) => f.orderId === orderId));
    const k = (await api("GET", `/v1/orders/${orderId}/kit`, undefined, tokenA)).json;
    assert.deepEqual(k.placement, cfg.bundles[1].placement);
    assert.deepEqual(k.policy, { minDataNodes: 3, witnesses: 1 });
    assert.equal(k.provider.fields.secretKey, kit.provider.fields.secretKey, "zelfde sleutel");
    const b = await billing(orderId);
    assert.deepEqual(b.bundle, { id: "ruim", title: "Ruim", monthly: { currency: "EUR", value: "39.95" } });
    assert.deepEqual(b.bundles.map((x: any) => [x.id, x.current]), [["compleet", false], ["ruim", true]]);
    await waitMail("rene@vanes.test", /bundel is gewijzigd naar Ruim/);
  });

  await t.test("betaalmethode wijzigen: € 0,01 → machtiging op het abonnement, cent terug, geen factuur", async () => {
    assert.equal((await api("POST", `/v1/orders/${orderId}/payment-method`, undefined, tokenB)).status, 404);
    const before = invoices().length;
    const r = await api("POST", `/v1/orders/${orderId}/payment-method`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\//);
    const call = up.calls.filter((c) => c.method === "POST" && c.path === "/mollie/payments").at(-1)!;
    assert.deepEqual(call.body, {
      amount: { currency: "EUR", value: "0.01" }, description: `Betaalmethode wijzigen ${orderId.slice(0, 8)}`,
      redirectUrl: `${PUBLIC}/betaald?order=${orderId}`, webhookUrl: `${PUBLIC}/v1/mollie/webhook`,
      customerId: up.st.mollie.customers[0].id, sequenceType: "first", locale: "nl_NL", metadata: { orderId, purpose: "mandate" },
    });
    const pay = [...up.st.mollie.payments.values()].at(-1)!;
    await webhook(pay.id); // nog open: niets
    assert.equal(up.count("PATCH", /subscriptions/), 1);

    Object.assign(pay, { status: "paid", method: "creditcard", mandateId: "mdt_2", paidAt: new Date().toISOString() });
    up.st.mollie.mandates.push({ ...fakeMandate("mdt_2", up.st.mollie.customers[0].id, "creditcard"), createdAt: "2026-02-01T10:00:00+00:00" });
    await webhook(pay.id);
    await webhook(pay.id);
    const patches = up.calls.filter((c) => c.method === "PATCH" && /subscriptions/.test(c.path));
    assert.equal(patches.length, 2, "één keer de machtiging omgezet");
    assert.deepEqual(patches[1].body, { mandateId: "mdt_2" });
    assert.equal(up.st.mollie.subscriptions.find((x) => x.id === subId())!.mandateId, "mdt_2");
    assert.equal(up.st.mollie.refunds.length, 1);
    assert.deepEqual({ p: up.st.mollie.refunds[0].paymentId, a: up.st.mollie.refunds[0].amount }, { p: pay.id, a: { currency: "EUR", value: "0.01" } });
    await waitMail("rene@vanes.test", /Je betaalmethode is gewijzigd/);
    assert.equal(mailCount("rene@vanes.test", /Je betaalmethode is gewijzigd/), 1);
    assert.equal(invoices().length, before, "de cent krijgt geen factuur");
    const b = await billing(orderId);
    assert.deepEqual(b.mandate, { method: "creditcard", label: "Visa •••• 4242", status: "valid" });
    assert.ok(!b.payments.some((p: any) => p.id === pay.id), "de cent staat niet tussen de betalingen");

    // Terugstorten mislukt → alleen een gebeurtenis; de wijziging zelf gaat door.
    up.st.mollie.failRefund = true;
    const r2 = await api("POST", `/v1/orders/${orderId}/payment-method`, undefined, tokenA);
    assert.equal(r2.status, 200);
    const pay2 = [...up.st.mollie.payments.values()].at(-1)!;
    Object.assign(pay2, { status: "paid", method: "creditcard", mandateId: "mdt_2", paidAt: new Date().toISOString() });
    await webhook(pay2.id);
    up.st.mollie.failRefund = false;
    assert.ok(broker.ctx.db.prepare("SELECT 1 FROM events WHERE order_id = ? AND kind = 'mandate-refund-error'").get(orderId));
    assert.equal(mailCount("rene@vanes.test", /Je betaalmethode is gewijzigd/), 2);
  });

  await t.test("incasso mislukt → openstaand bedrag; zelf betalen (eenmalig) → weer klaar met factuur", async () => {
    let r = await api("POST", `/v1/orders/${orderId}/settle`, undefined, tokenA);
    assert.equal(r.status, 409, "niets open");
    assert.match(r.json.error, /niets open/);
    const cid = up.st.mollie.customers[0].id;
    up.st.mollie.payments.set("tr_rec3", { id: "tr_rec3", status: "failed", method: "creditcard", sequenceType: "recurring", subscriptionId: subId(), customerId: cid, metadata: { orderId },
      amount: { currency: "EUR", value: "39.95" }, createdAt: new Date().toISOString() });
    await webhook("tr_rec3");
    let b = await billing(orderId);
    assert.equal(b.status, "payment_problem");
    // De eerder mislukte incasso (tr_rec1, € 24,95) is nooit alsnog betaald en telt dus mee.
    assert.deepEqual(b.outstanding, { currency: "EUR", value: "64.90" });
    assert.equal(b.payments.find((p: any) => p.id === "tr_rec3").status, "failed");
    assert.equal(b.payments.find((p: any) => p.id === "tr_rec3").invoiceId, null);
    assert.equal((await api("POST", `/v1/orders/${orderId}/bundle`, { bundle: "compleet" }, tokenA)).status, 409, "geen bundel wisselen bij een betalingsprobleem");
    assert.equal((await api("POST", `/v1/orders/${orderId}/settle`, undefined, tokenB)).status, 404);

    r = await api("POST", `/v1/orders/${orderId}/settle`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\//);
    const call = up.calls.filter((c) => c.method === "POST" && c.path === "/mollie/payments").at(-1)!;
    assert.deepEqual(call.body.amount, { currency: "EUR", value: "64.90" });
    assert.equal(call.body.sequenceType, "oneoff");
    assert.deepEqual(call.body.metadata, { orderId, purpose: "settle" });
    assert.equal(call.body.redirectUrl, `${PUBLIC}/betaald?order=${orderId}`);
    assert.equal(call.body.mandateId, undefined);
    const pay = [...up.st.mollie.payments.values()].at(-1)!;
    Object.assign(pay, { status: "paid", method: "ideal", paidAt: new Date().toISOString() });
    await webhook(pay.id);
    await webhook(pay.id);
    b = await billing(orderId);
    assert.equal(b.status, "ready");
    assert.equal(b.outstanding, null);
    const inv = invoiceOf(pay.id)!;
    assert.equal(inv.number, `EC-${YEAR}-0006`);
    assert.deepEqual(invoices().map((i) => i.seq), [1, 2, 3, 4, 5, 6], "doorlopend, zonder gaten");
    assert.equal(invoices().filter((i) => i.payment_id === pay.id).length, 1);
    assert.equal(b.payments[0].id, pay.id);
    assert.equal(b.payments[0].invoiceId, inv.id);
    const d = readInvoice(broker.ctx, inv);
    assert.match(d.description, /^Achterstallige betaling Eigen Cloud Ruim — vanes\.nl$/);
    assert.equal(d.period!.split("; ").length, 2);
    assert.deepEqual({ incl: d.amountIncl, excl: d.amountExcl, vat: d.vatAmount }, { incl: "64.90", excl: "53.64", vat: "11.26" });
    const settled = broker.ctx.db.prepare("SELECT id FROM payments WHERE settled_by = ? ORDER BY id").all(pay.id) as { id: string }[];
    assert.deepEqual(settled.map((x) => x.id), ["tr_rec1", "tr_rec3"]);
    assert.equal((await api("POST", `/v1/orders/${orderId}/settle`, undefined, tokenA)).status, 409);
  });

  await t.test("opschorten en hervatten (CLI)", async () => {
    const before = (await api("GET", `/v1/orders/${ownOrderId}/kit`, undefined, tokenA)).json;
    const proj = before.provider.fields.projectId;
    up.st.scw.servers.push({ id: "srv-own", name: "own-1", zone: "nl-ams-1", project: proj, state: "running", creation_date: "2026-10-01T00:00:00Z" });
    const log = await suspendOrder(broker.ctx, ownOrderId);
    assert.ok(log.some((l) => /ingetrokken/.test(l)));
    assert.ok(up.calls.some((c) => c.method === "DELETE" && c.path === `/scw/iam/v1alpha1/api-keys/${before.storage[0].accessKey}`));
    assert.equal(up.st.scw.servers.find((s) => s.id === "srv-own")!.state, "stopped");
    assert.equal((await api("GET", `/v1/orders/${ownOrderId}`, undefined, tokenA)).json.status, "suspended");
    assert.equal((await api("GET", `/v1/orders/${ownOrderId}/kit`, undefined, tokenA)).status, 409);
    const blocked = await fetch(`${PUBLIC}/v1/desec/domains/eigendomein.test/`, { headers: { authorization: `Token ${before.dns.token}` } });
    assert.equal(blocked.status, 403);
    await waitMail("rene@vanes.test", /opgeschort/);

    assert.equal(await resumeOrder(broker.ctx, ownOrderId), "ready");
    const after = (await api("GET", `/v1/orders/${ownOrderId}/kit`, undefined, tokenA)).json;
    assert.notEqual(after.provider.fields.secretKey, before.provider.fields.secretKey, "nieuwe sleutel");
    assert.equal(after.mailRelay.password, after.provider.fields.secretKey);
    assert.equal(after.dns.token, before.dns.token);
  });

  await t.test("opzeggen en weer voortzetten: endsAt, canResume en een nieuw abonnement vanaf de einddatum", async () => {
    assert.equal((await api("POST", `/v1/orders/${orderId}/resume`, undefined, tokenA)).status, 409, "loopt nog");
    const oldSub = subId();
    const r = await api("POST", `/v1/orders/${orderId}/cancel`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    const endDate = addMonths(todayNl(), 1);
    assert.equal(r.json.endsAt, endDate);
    let b = await billing(orderId);
    assert.equal(b.status, "cancelled");
    assert.equal(b.endsAt, nlMidnight(endDate));
    assert.equal(typeof b.endsAt, "number");
    assert.equal(b.canResume, true);
    assert.equal(b.nextPaymentDate, null);
    assert.equal(b.domainTransferable, true);
    assert.equal((await api("POST", `/v1/orders/${orderId}/resume`, undefined, tokenB)).status, 404);

    const res = await api("POST", `/v1/orders/${orderId}/resume`, undefined, tokenA);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, { ok: true, status: "ready", nextPaymentDate: endDate });
    const sub = up.calls.filter((c) => c.method === "POST" && /\/subscriptions$/.test(c.path)).at(-1)!;
    assert.equal(sub.body.startDate, endDate);
    assert.deepEqual(sub.body.amount, { currency: "EUR", value: "39.95" });
    assert.equal(sub.body.mandateId, "mdt_2", "de nieuwste geldige machtiging");
    assert.deepEqual(sub.body.metadata, { orderId });
    assert.notEqual(sub.body.description, up.st.mollie.subscriptions.find((x) => x.id === oldSub)!.description, "omschrijving blijft uniek");
    assert.notEqual(subId(), oldSub);
    b = await billing(orderId);
    assert.equal(b.status, "ready");
    assert.equal(b.endsAt, null);
    assert.equal(b.canResume, false);
    assert.equal(b.nextPaymentDate, endDate);
    await waitMail("rene@vanes.test", /loopt weer door/);
    assert.equal((await api("POST", `/v1/orders/${orderId}/resume`, undefined, tokenA)).status, 409);
  });

  await t.test("opzeggen → Mollie-abonnement stopt; opruimen ruimt IAM en mail op", async () => {
    const order = broker.ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
    const r = await api("POST", `/v1/orders/${orderId}/cancel`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.endsAt, addMonths(todayNl(), 1));
    assert.ok(up.calls.some((c) => c.method === "DELETE" && c.path === `/mollie/customers/${up.st.mollie.customers[0].id}/subscriptions/${order.mollie_subscription_id}`));
    assert.equal((await api("GET", `/v1/orders/${orderId}`, undefined, tokenA)).json.status, "cancelled");
    await waitMail("rene@vanes.test", /opgezegd/);
    const me = await api("GET", "/v1/me", undefined, tokenA);
    assert.equal(me.json.orders.find((o: any) => o.id === orderId).endsAt, r.json.endsAt);

    await assert.rejects(cleanupOrder(broker.ctx, ownOrderId, true), /opgezegde/);
    const dry = await cleanupOrder(broker.ctx, orderId, false);
    assert.ok(dry.plan.length >= 3 && dry.done.length === 0);
    assert.equal(up.count("DELETE", /applications/), 0);
    const res = await cleanupOrder(broker.ctx, orderId, true);
    assert.ok(res.manual.some((l) => /srv-1|n-1/.test(l)), "servers staan in de handmatige lijst");
    assert.equal(up.count("DELETE", /^\/scw\/iam\/v1alpha1\/applications\//), 1);
    assert.equal(up.count("DELETE", /^\/scw\/iam\/v1alpha1\/policies\//), 1);
    assert.ok(up.calls.some((c) => c.method === "POST" && /\/domains\/tem-\d+\/revoke$/.test(c.path)));
    assert.equal(up.st.scw.apiKeys.filter((k) => k.default_project_id === kit.provider.fields.projectId).length, 0, "sleutels weg");
    const dead = await fetch(`${PUBLIC}/v1/desec/domains/vanes.nl/`, { headers: { authorization: `Token ${kit.dns.token}` } });
    assert.equal(dead.status, 403, "DNS-toegang ingetrokken");
  });

  await t.test("domein meenemen: verhuiscode via Openprovider; niet bij een eigen domein", async () => {
    const r = await api("GET", `/v1/orders/${orderId}/authcode`, undefined, tokenA);
    assert.equal(r.status, 200, r.text);
    const dom = up.st.op.domains.find((d) => d.domain.name === "vanes")!;
    assert.deepEqual(r.json, { domain: "vanes.nl", authCode: `Ab3-${dom.id}-Qz9!` });
    assert.ok(up.calls.some((c) => c.method === "GET" && c.path === `/op/domains/${dom.id}/authcode`));
    assert.ok(broker.ctx.db.prepare("SELECT 1 FROM events WHERE order_id = ? AND kind = 'authcode-requested'").get(orderId));
    // Geeft Openprovider geen code, dan één keer opnieuw laten maken.
    up.st.op.authcodeFailOnce = true;
    const r2 = await api("GET", `/v1/orders/${orderId}/authcode`, undefined, tokenA);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.authCode, `Nieuw-${dom.id}-Xy7#`);
    assert.equal(up.count("POST", /\/authcode\/reset$/), 1);

    const own = await api("GET", `/v1/orders/${ownOrderId}/authcode`, undefined, tokenA);
    assert.equal(own.status, 409);
    assert.match(own.json.error, /eigen registrar/);
    assert.equal((await api("GET", `/v1/orders/${orderId}/authcode`, undefined, tokenB)).status, 404);
    // Opgeruimd: niet meer voortzetten.
    const b = await billing(orderId);
    assert.equal(b.canResume, false);
    assert.equal((await api("POST", `/v1/orders/${orderId}/resume`, undefined, tokenA)).status, 409);
  });
});
