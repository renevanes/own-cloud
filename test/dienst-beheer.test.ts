/**
 * Eigen Cloud Dienst, kant van de aanbieder: medewerkers met rollen, inloggen in twee stappen (code + TOTP of
 * toestelsleutel), rechten, logboek, klanten en acties, geld (terugbetalen, omzet, achterstand), servers en kosten,
 * aanbod met extra gebruikers, huisstijl, uitnodigingscodes, hulpvragen, berichten en de gezondheid van clouds.
 * Tegen de echte dienst met nep-Mollie/-deSEC/-Scaleway en een nep-mailserver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { base32Decode, base32Encode, hotp, totpCode, verifyTotp, ensureOwner } from "../src/broker/staff.js";
import { freePort } from "./helpers/cluster.js";
import { smtpSink, fakeUpstream, fakeMandate } from "./helpers/broker-fakes.js";

test("TOTP volgens RFC 6238 (testvectoren SHA1) en base32", () => {
  const secret = Buffer.from("12345678901234567890");
  // RFC 6238, bijlage B (8 cijfers): 94287082 @59s, 07081804 @1111111109s → laatste 6 cijfers.
  assert.equal(hotp(secret, Math.floor(59 / 30)), "287082");
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(hotp(secret, Math.floor(1234567890 / 30)), "005924");
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.deepEqual(base32Decode("MZXW6YTBOI"), Buffer.from("foobar"));
  const now = 1_700_000_000_000;
  const code = totpCode(secret, now);
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, code, 0, now), step);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 30_000), 0, now), step - 1, "één stap terug mag");
  assert.equal(verifyTotp(secret, totpCode(secret, now + 30_000), 0, now), step + 1, "één stap vooruit mag");
  assert.equal(verifyTotp(secret, totpCode(secret, now - 90_000), 0, now), null, "drie stappen terug niet");
  assert.equal(verifyTotp(secret, code, step, now), null, "dezelfde code niet twee keer");
  assert.equal(verifyTotp(secret, "12345", 0, now), null);
});

test("Eigen Cloud Dienst: beheer door de aanbieder", { timeout: 90_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dienst-beheer-"));
  const smtp = await smtpSink();
  const up = fakeUpstream();
  const upPort = await up.listening;
  const port = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`;
  const U = `http://127.0.0.1:${upPort}`;
  const UNHEALTHY_MS = 300, SILENT_MS = 60_000;
  const cfg = loadConfig({
    BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC,
    BROKER_TERMS_URL: "https://dienst.test/voorwaarden",
    MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
    OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
    DESEC_TOKEN: "desec-dienst", DESEC_URL: `${U}/desec`,
    SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
    BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: "Dienst <dienst@dienst.test>",
    BROKER_ADMIN_EMAIL: "meldingen@dienst.test", BROKER_LOOP_MS: "20",
    BROKER_COMPANY_NAME: "Van Es Diensten B.V.",
    BROKER_OWNER_EMAIL: "Eigenaar@Dienst.test",
    BROKER_HEALTH_UNHEALTHY_MS: String(UNHEALTHY_MS), BROKER_HEALTH_SILENT_MS: String(SILENT_MS),
  });
  const broker = await createBroker(cfg);
  await broker.app.listen({ port, host: "127.0.0.1" });
  t.after(async () => { await broker.close(); await up.close(); await smtp.close(); if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); });
  const db = broker.ctx.db;

  type Auth = { staff?: string; bearer?: string; token?: string };
  const api = async (method: string, p: string, body?: unknown, auth: Auth = {}) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth.staff) headers.authorization = `Staff ${auth.staff}`;
    if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    if (auth.token) headers.authorization = `Token ${auth.token}`;
    const r = await fetch(PUBLIC + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const ok = async (method: string, p: string, body?: unknown, auth: Auth = {}) => {
    const r = await api(method, p, body, auth);
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${p} → ${r.status} ${r.text}`);
    return r.json;
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
  const webhook = async (id: string) => {
    await fetch(`${PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${id}` });
    await broker.idle();
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── Hulpjes voor medewerkers ──
  const staffCode = async (email: string) => {
    assert.equal((await api("POST", "/v1/admin/auth/start", { email })).status, 202);
    const m = await waitMail(email, /inlogcode voor het beheer/);
    smtp.mails.splice(smtp.mails.indexOf(m), 1);
    return /beheer: (\d{6})/.exec(m.data)![1];
  };
  const pendingFor = async (email: string) => {
    const code = await staffCode(email);
    const r = await api("POST", "/v1/admin/auth/verify", { email, code });
    assert.equal(r.status, 200, r.text);
    return r.json as { pending: string; next: "enrol" | "second"; methods: string[] };
  };
  const newDevice = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    return {
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      sign: (challenge: string) => crypto.sign("sha256", Buffer.from(`eigen-dienst-login:${challenge}`), privateKey).toString("base64"),
      signRaw: (challenge: string) => crypto.sign("sha256", Buffer.from(`eigen-dienst-login:${challenge}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64"),
    };
  };
  type Device = ReturnType<typeof newDevice>;
  const enrolDevice = async (email: string, dev: Device) => {
    const p = await pendingFor(email);
    assert.equal(p.next, "enrol");
    const { challenge } = await ok("POST", "/v1/admin/auth/challenge", { pending: p.pending });
    const r = await api("POST", "/v1/admin/auth/enrol/device", { pending: p.pending, publicKey: dev.publicKey, signature: dev.sign(challenge), label: "Pixel" });
    assert.equal(r.status, 200, r.text);
    return r.json.token as string;
  };
  const loginDevice = async (email: string, dev: Device) => {
    const p = await pendingFor(email);
    assert.equal(p.next, "second");
    assert.ok(p.methods.includes("device"));
    const { challenge } = await ok("POST", "/v1/admin/auth/challenge", { pending: p.pending });
    const r = await api("POST", "/v1/admin/auth/device", { pending: p.pending, signature: dev.sign(challenge) });
    assert.equal(r.status, 200, r.text);
    return r.json.token as string;
  };

  // ── Hulpjes voor klanten ──
  const customerLogin = async (email: string) => {
    assert.equal((await api("POST", "/v1/auth/start", { email })).status, 202);
    const m = await waitMail(email, /Je inlogcode/);
    smtp.mails.splice(smtp.mails.indexOf(m), 1);
    const code = /inlogcode: (\d{6})/.exec(m.data)![1];
    return (await ok("POST", "/v1/auth/verify", { email, code })).token as string;
  };
  let mandateN = 0;
  const payOrder = async (orderId: string) => {
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata?.orderId === orderId)!;
    const mid = `mdt_t${++mandateN}`;
    Object.assign(pay, { status: "paid", mandateId: mid, method: "ideal", paidAt: new Date().toISOString() });
    up.st.mollie.mandates.push(fakeMandate(mid, pay.customerId, "directdebit"));
    await webhook(pay.id);
    return pay.id as string;
  };

  const OWNER = "eigenaar@dienst.test", BEHEER = "beheer@dienst.test", SUPPORT = "support@dienst.test", FIN = "geld@dienst.test";
  const devOwner = newDevice(), devBeheer = newDevice(), devSupport = newDevice(), devFin = newDevice();
  let owner = "", beheer = "", support = "", fin = "";
  let totpSecret = "";

  await t.test("eigenaar uit BROKER_OWNER_EMAIL; opdrachtregel maakt of promoveert", async () => {
    const rows = db.prepare("SELECT email, role FROM staff").all();
    assert.deepEqual(rows, [{ email: OWNER, role: "eigenaar" }]);
    assert.equal(ensureOwner(broker.ctx, OWNER, "test").created, false);
    // Onbekend adres: ook 202, maar geen mail (niemand kan zo uitzoeken wie medewerker is).
    assert.equal((await api("POST", "/v1/admin/auth/start", { email: "vreemde@elders.test" })).status, 202);
    await sleep(100);
    assert.equal(mailCount("vreemde@elders.test", /./), 0);
  });

  await t.test("eigenaar: code per mail, daarna verplicht een authenticator-app instellen", async () => {
    // Zonder tweede stap: niets.
    let p = await pendingFor(OWNER);
    assert.equal(p.next, "enrol");
    assert.deepEqual(p.methods, []);
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: p.pending })).status, 401, "aanmelding is nog geen sessie");
    assert.equal((await api("POST", "/v1/admin/auth/totp", { pending: p.pending, code: "123456" })).status, 409);
    const en = await ok("POST", "/v1/admin/auth/enrol/totp", { pending: p.pending });
    assert.match(en.secret, /^[A-Z2-7]{32}$/);
    assert.equal(en.uri, `otpauth://totp/${encodeURIComponent(`Eigen Cloud Dienst:${OWNER}`)}?secret=${en.secret}&issuer=Eigen%20Cloud%20Dienst&algorithm=SHA1&digits=6&period=30`);
    totpSecret = en.secret;
    const secret = base32Decode(totpSecret);
    const used = totpCode(secret);
    const wrong = used === "000000" ? "111111" : "000000";
    assert.equal((await api("POST", "/v1/admin/auth/enrol/totp/confirm", { pending: p.pending, code: wrong })).status, 400);
    const r = await api("POST", "/v1/admin/auth/enrol/totp/confirm", { pending: p.pending, code: used });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.equal(r.json.staff.role, "eigenaar");
    assert.equal(r.json.staff.totp, true);
    assert.ok(r.json.permissions.includes("staff"));
    owner = r.json.token;
    // Aanmelding is verbruikt.
    assert.equal((await api("POST", "/v1/admin/auth/totp", { pending: p.pending, code: used })).status, 401);
    // Sessie alleen met "Staff", niet als klanttoken.
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: owner })).json.staff.email, OWNER);
    assert.equal((await api("GET", "/v1/admin/me", undefined, { bearer: owner })).status, 401);
    assert.equal((await api("GET", "/v1/me", undefined, { bearer: owner })).status, 401);
    // Tokens staan alleen als hash in de database.
    assert.ok(!db.prepare("SELECT 1 FROM staff_sessions WHERE token_hash = ?").get(owner));

    // Nog eens inloggen: dezelfde code (zelfde stap) mag niet opnieuw; de volgende stap wel.
    p = await pendingFor(OWNER);
    assert.equal(p.next, "second");
    assert.deepEqual(p.methods, ["totp"]);
    assert.equal((await api("POST", "/v1/admin/auth/enrol/totp", { pending: p.pending })).status, 409, "instellen kan niet meer zonder in te loggen");
    const replay = await api("POST", "/v1/admin/auth/totp", { pending: p.pending, code: used });
    assert.equal(replay.status, 400, "zelfde code twee keer");
    const next = await api("POST", "/v1/admin/auth/totp", { pending: p.pending, code: totpCode(secret, Date.now() + 30_000) });
    assert.equal(next.status, 200, next.text);
    assert.equal((await api("POST", "/v1/admin/auth/logout", undefined, { staff: next.json.token })).status, 200);
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: next.json.token })).status, 401);
  });

  await t.test("eigenaar koppelt zijn telefoon (toestelsleutel) en logt daarmee in", async () => {
    const { challenge } = await ok("POST", "/v1/admin/me/device/challenge", undefined, { staff: owner });
    const other = newDevice();
    // Handtekening van een andere sleutel → geweigerd.
    assert.equal((await api("POST", "/v1/admin/me/device", { publicKey: devOwner.publicKey, signature: other.sign(challenge) }, { staff: owner })).status, 400);
    const c2 = (await ok("POST", "/v1/admin/me/device/challenge", undefined, { staff: owner })).challenge;
    const r = await ok("POST", "/v1/admin/me/device", { publicKey: devOwner.publicKey, signature: devOwner.sign(c2), label: "Telefoon Rene" }, { staff: owner });
    assert.equal(r.staff.devices.length, 1);
    assert.equal(r.staff.devices[0].label, "Telefoon Rene");
    // Geen RSA- of andere sleutels.
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    await ok("POST", "/v1/admin/me/device/challenge", undefined, { staff: owner });
    assert.match((await api("POST", "/v1/admin/me/device", { publicKey: rsa, signature: "AAAA" }, { staff: owner })).json.error, /P-256/);

    // Inloggen met de toestelsleutel; een uitdaging is eenmalig.
    const p = await pendingFor(OWNER);
    assert.deepEqual(p.methods.sort(), ["device", "totp"]);
    assert.equal((await api("POST", "/v1/admin/auth/device", { pending: p.pending, signature: "AAAA" })).status, 400, "eerst een uitdaging");
    const { challenge: ch } = await ok("POST", "/v1/admin/auth/challenge", { pending: p.pending });
    assert.equal((await api("POST", "/v1/admin/auth/device", { pending: p.pending, signature: other.sign(ch) })).status, 400);
    assert.equal((await api("POST", "/v1/admin/auth/device", { pending: p.pending, signature: devOwner.sign(ch) })).status, 400, "uitdaging al gebruikt");
    const { challenge: ch2 } = await ok("POST", "/v1/admin/auth/challenge", { pending: p.pending });
    // Ook de vorm r‖s (64 bytes, zoals sommige toestellen hem geven) wordt geaccepteerd.
    const r2 = await api("POST", "/v1/admin/auth/device", { pending: p.pending, signature: devOwner.signRaw(ch2) });
    assert.equal(r2.status, 200, r2.text);
    owner = r2.json.token;
  });

  await t.test("medewerkers uitnodigen; elk stelt bij de eerste keer een toestel in", async () => {
    const add = async (email: string, role: string) => {
      const r = await api("POST", "/v1/admin/staff", { email, role, name: role === "support" ? "Sanne" : undefined }, { staff: owner });
      assert.equal(r.status, 200, r.text);
      await waitMail(email, /Je bent medewerker bij Eigen Cloud Dienst/);
      return r.json.staff;
    };
    await add(BEHEER, "beheer");
    await add(SUPPORT, "support");
    await add(FIN, "financien");
    assert.equal((await api("POST", "/v1/admin/staff", { email: BEHEER, role: "support" }, { staff: owner })).status, 409);
    assert.equal((await api("POST", "/v1/admin/staff", { email: "x@dienst.test", role: "baas" }, { staff: owner })).status, 400);
    beheer = await enrolDevice(BEHEER, devBeheer);
    support = await enrolDevice(SUPPORT, devSupport);
    fin = await enrolDevice(FIN, devFin);
    // Na het instellen: een tweede keer instellen via de aanmelding kan niet.
    const p = await pendingFor(FIN);
    await ok("POST", "/v1/admin/auth/challenge", { pending: p.pending });
    assert.equal((await api("POST", "/v1/admin/auth/enrol/device", { pending: p.pending, publicKey: newDevice().publicKey, signature: "x" })).status, 409);
    const staff = await ok("GET", "/v1/admin/staff", undefined, { staff: owner });
    assert.deepEqual(staff.staff.map((s: any) => [s.email, s.role, s.devices.length]), [[OWNER, "eigenaar", 1], [BEHEER, "beheer", 1], [SUPPORT, "support", 1], [FIN, "financien", 1]]);
    assert.equal(staff.staff[2].name, "Sanne");
  });

  await t.test("sessie verloopt na 12 uur niets doen", async () => {
    const tok = await loginDevice(FIN, devFin);
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: tok })).status, 200);
    db.prepare("UPDATE staff_sessions SET last_used_at = ? WHERE token_hash = ?").run(Date.now() - 12 * 3600_000 - 1000, crypto.createHash("sha256").update(tok).digest("hex"));
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: tok })).status, 401);
  });

  // ── Klanten met bestellingen ──
  let tokA = "", tokB = "", orderA = "", orderB = "", inviteCode = "";

  await t.test("uitnodigingscodes: maken, controleren, gebruiken bij bestellen, maximum, verlopen, intrekken", async () => {
    assert.equal((await api("POST", "/v1/admin/invites", { label: "Buurt" }, { staff: support })).status, 403);
    const r = await ok("POST", "/v1/admin/invites", { label: "Buurtvereniging", bundle: "compleet", maxUses: 2 }, { staff: beheer });
    inviteCode = r.invite.code;
    assert.match(inviteCode, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(r.invite.display, `${inviteCode.slice(0, 4)}-${inviteCode.slice(4)}`);
    assert.equal((await api("POST", "/v1/admin/invites", { bundle: "goud" }, { staff: beheer })).status, 400);
    let pub = await ok("GET", `/v1/invite/${r.invite.display.toLowerCase()}`);
    assert.equal(pub.valid, true);
    assert.equal(pub.code, inviteCode);
    assert.equal(pub.brand.name, "Eigen Cloud Dienst");
    assert.equal(pub.bundle.id, "compleet");
    assert.equal(pub.bundle.includes.users, 2);
    assert.deepEqual(await ok("GET", "/v1/invite/BESTAATNIET"), { valid: false, reason: "Deze code bestaat niet", brand: pub.brand });

    tokA = await customerLogin("anna@klant.test");
    tokB = await customerLogin("bram@klant.test");
    let o = await api("POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "anna.test" }, acceptTerms: true, invite: r.invite.display }, { bearer: tokA });
    assert.equal(o.status, 200, o.text);
    orderA = o.json.orderId;
    assert.equal((db.prepare("SELECT invite_code FROM orders WHERE id = ?").get(orderA) as any).invite_code, inviteCode);
    o = await api("POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "bram.test" }, acceptTerms: true, invite: inviteCode }, { bearer: tokB });
    assert.equal(o.status, 200, o.text);
    orderB = o.json.orderId;
    pub = await ok("GET", `/v1/invite/${inviteCode}`);
    assert.deepEqual([pub.valid, pub.reason], [false, "Deze code is al zo vaak gebruikt als mocht"]);
    o = await api("POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "derde.test" }, acceptTerms: true, invite: inviteCode }, { bearer: tokB });
    assert.equal(o.status, 400);
    assert.match(o.json.error, /zo vaak gebruikt/);

    const old = await ok("POST", "/v1/admin/invites", { expiresAt: new Date(Date.now() - 1000).toISOString() }, { staff: beheer });
    assert.equal((await ok("GET", `/v1/invite/${old.invite.code}`)).reason, "Deze code is verlopen");
    const later = await ok("POST", "/v1/admin/invites", { expiresAt: Date.now() + 86400_000 }, { staff: owner });
    assert.equal((await ok("GET", `/v1/invite/${later.invite.code}`)).valid, true);
    await ok("DELETE", `/v1/admin/invites/${later.invite.code}`, undefined, { staff: beheer });
    assert.equal((await ok("GET", `/v1/invite/${later.invite.code}`)).reason, "Deze code is ingetrokken");
    assert.equal((await api("DELETE", `/v1/admin/invites/${later.invite.code}`, undefined, { staff: beheer })).status, 404);
    const list = await ok("GET", "/v1/admin/invites", undefined, { staff: beheer });
    const mine = list.invites.find((i: any) => i.code === inviteCode);
    assert.deepEqual([mine.uses, mine.maxUses, mine.orders, mine.valid, mine.createdBy], [2, 2, 2, false, BEHEER]);

    await payOrder(orderA);
    await payOrder(orderB);
    assert.equal((await ok("GET", `/v1/orders/${orderA}`, undefined, { bearer: tokA })).status, "ready");
    assert.equal((await ok("GET", `/v1/orders/${orderB}`, undefined, { bearer: tokB })).status, "ready");
  });

  await t.test("rechten per rol (en zonder inloggen)", async () => {
    const expect = async (auth: Auth, method: string, p: string, status: number, body?: unknown) => {
      const r = await api(method, p, body, auth);
      assert.equal(r.status, status, `${method} ${p}: ${r.text}`);
      if (status === 403) assert.match(r.json.error, /Dit kan niet met jouw rol/);
    };
    await expect({}, "GET", "/v1/admin/customers", 401);
    await expect({ bearer: tokA }, "GET", "/v1/admin/customers", 401);
    await expect({ staff: tokA }, "GET", "/v1/admin/customers", 401);
    for (const tok of [owner, beheer, support, fin]) await expect({ staff: tok }, "GET", "/v1/admin/customers", 200);
    await expect({ staff: support }, "POST", `/v1/admin/orders/${orderA}/suspend`, 403);
    await expect({ staff: fin }, "POST", `/v1/admin/orders/${orderA}/suspend`, 403);
    await expect({ staff: support }, "POST", "/v1/admin/payments/tr_x/refund", 403, {});
    await expect({ staff: beheer }, "POST", "/v1/admin/payments/tr_x/refund", 403, {});
    await expect({ staff: support }, "GET", "/v1/admin/payments", 403);
    await expect({ staff: fin }, "GET", "/v1/admin/payments", 200);
    await expect({ staff: fin }, "POST", "/v1/admin/staff", 403, { email: "x@y.test", role: "support" });
    await expect({ staff: beheer }, "POST", "/v1/admin/staff", 403, { email: "x@y.test", role: "support" });
    await expect({ staff: fin }, "PATCH", "/v1/admin/staff/x", 403, { role: "eigenaar" });
    await expect({ staff: beheer }, "GET", "/v1/admin/audit", 403);
    await expect({ staff: fin }, "PUT", "/v1/admin/bundles/compleet", 403, {});
    await expect({ staff: support }, "PUT", "/v1/admin/bundles/compleet", 403, {});
    await expect({ staff: beheer }, "PUT", "/v1/admin/brand", 403, {});
    await expect({ staff: fin }, "GET", "/v1/admin/tickets", 403);
    await expect({ staff: support }, "POST", "/v1/admin/announcements", 403, { title: "x", body: "y" });
    await expect({ staff: support }, "GET", "/v1/admin/announcements", 200);
    await expect({ staff: support }, "GET", `/v1/admin/orders/${orderA}/servers`, 403);
    // Wat het overzicht laat zien hangt af van de rol.
    const ov = await ok("GET", "/v1/admin/overview", undefined, { staff: support });
    assert.equal(ov.revenueThisMonth, undefined);
    assert.equal(ov.openTickets, 0);
    assert.equal(ov.orders.ready, 2);
    const ovFin = await ok("GET", "/v1/admin/overview", undefined, { staff: fin });
    assert.equal(ovFin.openTickets, undefined);
    assert.equal(ovFin.revenueThisMonth.incl, "49.90");
  });

  await t.test("klanten: zoeken, filteren, details", async () => {
    let r = await ok("GET", "/v1/admin/customers?q=anna", undefined, { staff: support });
    assert.deepEqual(r.orders.map((o: any) => o.id), [orderA]);
    assert.equal(r.orders[0].customer.email, "anna@klant.test");
    assert.equal(r.orders[0].statusLabel, "Klaar");
    assert.equal(r.orders[0].users, 2);
    assert.equal(r.orders[0].inviteCode, inviteCode);
    r = await ok("GET", `/v1/admin/customers?q=${inviteCode.toLowerCase()}`, undefined, { staff: support });
    assert.equal(r.total, 2, "zoeken op uitnodigingscode");
    r = await ok("GET", "/v1/admin/customers?status=ready", undefined, { staff: support });
    assert.equal(r.total, 2);
    r = await ok("GET", "/v1/admin/customers?status=suspended", undefined, { staff: support });
    assert.equal(r.total, 0);
    const d = await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: beheer });
    assert.equal(d.order.domain, "anna.test");
    assert.ok(d.steps.every((s: any) => s.state === "done"));
    assert.ok(d.events.some((e: any) => e.kind === "ready"));
    assert.match(d.technical.projectId, /^proj-/);
    assert.equal(d.technical.kitReady, true);
    assert.equal(d.technical.kitUsers, 2);
    assert.equal(d.health, null);
    assert.equal(d.billing.bundle.id, "compleet");
    assert.deepEqual(d.actions, { suspend: true, resume: false, cancel: true, retry: false, cleanup: false });
    // Support ziet geen acties en geen abonnement, wel de technische status.
    const ds = await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: support });
    assert.equal(ds.actions, null);
    assert.equal(ds.billing, null);
    assert.equal(ds.costs, undefined);
    // Nooit geheimen in het beheer.
    assert.doesNotMatch(JSON.stringify(d), /secretKey|aaaaaaaa-bbbb/);
    assert.equal((await api("GET", "/v1/admin/orders/bestaatniet", undefined, { staff: support })).status, 404);
  });

  await t.test("acties: opschorten, hervatten, opnieuw proberen, opruimen (met controles)", async () => {
    let r = await api("POST", `/v1/admin/orders/${orderB}/retry`, {}, { staff: beheer });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /alleen 'failed' of 'provisioning'/);
    assert.equal((await api("POST", `/v1/admin/orders/${orderB}/cleanup`, {}, { staff: beheer })).status, 409);
    assert.equal((await api("POST", `/v1/admin/orders/${orderB}/resume`, {}, { staff: beheer })).status, 409);
    r = await api("POST", `/v1/admin/orders/${orderB}/suspend`, {}, { staff: beheer });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.order.status, "suspended");
    await waitMail("bram@klant.test", /opgeschort/);
    assert.equal((await api("GET", `/v1/orders/${orderB}/kit`, undefined, { bearer: tokB })).status, 409);
    r = await api("POST", `/v1/admin/orders/${orderB}/resume`, {}, { staff: owner });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.order.status, "ready");
    assert.equal(r.json.result, "ready");
    const ev = db.prepare("SELECT detail FROM events WHERE order_id = ? AND kind = 'staff-suspend'").get(orderB) as { detail: string };
    assert.deepEqual(JSON.parse(ev.detail), { by: BEHEER });
  });

  let firstPaymentA = "";
  await t.test("geld: betalingen, factuur, terugbetalen, omzet per maand, achterstand", async () => {
    let r = await ok("GET", "/v1/admin/payments", undefined, { staff: fin });
    assert.equal(r.payments.length, 2);
    const pA = r.payments.find((p: any) => p.orderId === orderA);
    firstPaymentA = pA.id;
    assert.deepEqual([pA.status, pA.kind, pA.amount, pA.refundable, pA.email], ["paid", "first", "24.95", "24.95", "anna@klant.test"]);
    assert.match(pA.invoice.number, /^EC-\d{4}-000\d$/);
    const inv = await ok("GET", `/v1/admin/invoices?orderId=${orderA}`, undefined, { staff: fin });
    assert.equal(inv.invoices.length, 1);
    const html = await api("GET", `/v1/admin/invoices/${inv.invoices[0].id}`, undefined, { staff: fin });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type")!, /text\/html/);
    assert.match(html.text, /Factuur/);
    assert.equal((await api("GET", `/v1/admin/invoices/${inv.invoices[0].id}`, undefined, { staff: support })).status, 403);

    // Terugbetalen: deels, te veel, de rest.
    r = await api("POST", `/v1/admin/payments/${pA.id}/refund`, { amount: "5,00", description: "Excuus voor de storing" }, { staff: fin });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.refund.amount, "5.00");
    const call = up.calls.filter((c) => c.method === "POST" && c.path === `/mollie/payments/${pA.id}/refunds`).at(-1)!;
    assert.deepEqual(call.body, { amount: { currency: "EUR", value: "5.00" }, description: "Excuus voor de storing" });
    r = await api("POST", `/v1/admin/payments/${pA.id}/refund`, { amount: "20.00" }, { staff: fin });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /hooguit 19\.95/);
    assert.equal((await api("POST", `/v1/admin/payments/${pA.id}/refund`, { amount: "nul" }, { staff: fin })).status, 400);
    up.st.mollie.failRefund = true;
    r = await api("POST", `/v1/admin/payments/${pA.id}/refund`, {}, { staff: owner });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Mollie/);
    up.st.mollie.failRefund = false;
    r = await api("POST", `/v1/admin/payments/${pA.id}/refund`, {}, { staff: owner });
    assert.equal(r.json.refund.amount, "19.95");
    assert.equal((await api("POST", `/v1/admin/payments/${pA.id}/refund`, {}, { staff: owner })).status, 409, "alles is al terug");
    assert.equal((await api("POST", "/v1/admin/payments/tr_bestaatniet/refund", {}, { staff: owner })).status, 404);

    const rev = await ok("GET", "/v1/admin/revenue", undefined, { staff: fin });
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit" }).format(new Date());
    assert.equal(rev.vatPercent, 21);
    assert.deepEqual(rev.months[0], { month, incl: "49.90", excl: "41.24", vat: "8.66", refunded: "24.95", net: "24.95", count: 2 });

    // Mislukte incasso bij bestelling B → achterstand.
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderB) as any;
    const cust = db.prepare("SELECT mollie_customer_id FROM customers WHERE id = ?").get(o.customer_id) as any;
    up.st.mollie.payments.set("tr_fail1", { id: "tr_fail1", status: "failed", sequenceType: "recurring", subscriptionId: o.mollie_subscription_id, customerId: cust.mollie_customer_id, amount: { currency: "EUR", value: "24.95" }, createdAt: new Date().toISOString() });
    await webhook("tr_fail1");
    const ar = await ok("GET", "/v1/admin/arrears", undefined, { staff: fin });
    assert.deepEqual(ar.orders.map((x: any) => [x.id, x.outstanding, x.failedPayments.length]), [[orderB, "24.95", 1]]);
    assert.equal((await ok("GET", "/v1/admin/overview", undefined, { staff: owner })).arrears, 1);
    // Weer in orde (volgende incasso gelukt) voor de rest van de test.
    up.st.mollie.payments.set("tr_ok1", { id: "tr_ok1", status: "paid", sequenceType: "recurring", subscriptionId: o.mollie_subscription_id, customerId: cust.mollie_customer_id, amount: { currency: "EUR", value: "24.95" }, createdAt: new Date().toISOString(), paidAt: new Date().toISOString() });
    await webhook("tr_ok1");
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = ?").get(orderB) as any).status, "ready");
  });

  await t.test("servers en kosten: wat draait er, geschatte kosten naast de prijs", async () => {
    const projectId = (await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: owner })).technical.projectId;
    up.st.scw.servers.push(
      { id: "srv-1", name: "anna-1", zone: "nl-ams-1", project: projectId, state: "running", commercial_type: "DEV1-M", creation_date: "2026-10-01T10:00:00Z" },
      { id: "srv-2", name: "anna-2", zone: "nl-ams-2", project: projectId, state: "running", commercial_type: "PLAY2-MICRO", creation_date: "2026-10-01T10:00:00Z" },
      { id: "srv-3", name: "anna-w", zone: "fr-par-1", project: projectId, state: "stopped", commercial_type: "DEV1-S", creation_date: "2026-10-01T10:00:00Z" },
    );
    const r = await ok("GET", `/v1/admin/orders/${orderA}/servers`, undefined, { staff: fin });
    assert.deepEqual(r.servers.map((s: any) => [s.zone, s.name, s.state, s.type]).sort(), [["fr-par-1", "anna-w", "stopped", "DEV1-S"], ["nl-ams-1", "anna-1", "running", "DEV1-M"], ["nl-ams-2", "anna-2", "running", "PLAY2-MICRO"]]);
    assert.equal(r.running, 2);
    assert.equal(r.allowed, 4);
    assert.equal(r.runningCost, "14.00");
    // Bundel compleet: DEV1-M 8,50 + PLAY2-MICRO 5,50 + DEV1-S 4,50 + 2 × 100 GB × 0,015 = 21,50.
    assert.equal(r.cost.total, "21.50");
    assert.deepEqual(r.price, { incl: "24.95", excl: "20.62", vat: "4.33" });
    assert.equal(r.margin, "-0.88");
    const all = await ok("GET", "/v1/admin/costs", undefined, { staff: beheer });
    assert.equal(all.orders.length, 2);
    assert.deepEqual(all.totals, { priceExcl: "41.24", cost: "43.00", margin: "-1.76" });
  });

  await t.test("aanbod: prijzen en gebruikers aanpassen; bestaande klanten houden hun prijs; extra gebruikers kopen", async () => {
    let r = await api("PUT", "/v1/admin/bundles/compleet", { monthly: { value: "29.95" }, includes: { users: 3 }, extraUserMonthly: { value: "3.00" } }, { staff: beheer });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.bundle.monthly.value, r.json.bundle.includes.users, r.json.bundle.extraUserMonthly.value], ["29.95", 3, "3.00"]);
    assert.equal(r.json.bundle.placement.length, 3, "servers blijven staan");
    assert.equal((await api("PUT", "/v1/admin/bundles/compleet", { monthly: { value: "veel" } }, { staff: beheer })).status, 400);
    assert.equal((await api("PUT", "/v1/admin/bundles/compleet", { includes: { users: 0 } }, { staff: beheer })).status, 400);
    const info = await ok("GET", "/v1/info");
    const c = info.bundles.find((b: any) => b.id === "compleet");
    assert.deepEqual([c.monthly.value, c.includes.users, c.extraUserMonthly.value], ["29.95", 3, "3.00"]);
    assert.ok(db.prepare("SELECT 1 FROM settings WHERE key = 'bundles'").get(), "opgeslagen in de database");
    // Bestaande bestelling houdt zijn bedrag.
    assert.equal((await ok("GET", `/v1/orders/${orderA}/billing`, undefined, { bearer: tokA })).bundle.monthly.value, "24.95");
    // Nieuwe bundel toevoegen en weer weghalen; een gebruikte bundel kan niet weg.
    r = await api("PUT", "/v1/admin/bundles/gezin", { title: "Gezin", monthly: { value: "49.95" }, includes: { users: 6, storageGb: 1000 }, placement: cfg.bundles[1].placement, storage: cfg.bundles[1].storage }, { staff: owner });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.bundle.extraUserMonthly, null);
    assert.deepEqual((await ok("GET", "/v1/info")).bundles.map((b: any) => b.id), ["compleet", "ruim", "gezin"]);
    const list = await ok("GET", "/v1/admin/bundles", undefined, { staff: beheer });
    assert.equal(list.bundles.find((b: any) => b.id === "compleet").orders, 2);
    assert.equal(list.bundles.find((b: any) => b.id === "compleet").cost.total, "21.50");
    r = await api("DELETE", "/v1/admin/bundles/compleet", undefined, { staff: beheer });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /nog door 2 klanten gebruikt/);
    await ok("DELETE", "/v1/admin/bundles/gezin", undefined, { staff: beheer });

    // Klant koopt 2 extra gebruikers: Mollie-bedrag = bundelprijs + 2 × prijs per extra gebruiker.
    r = await api("POST", `/v1/orders/${orderA}/users`, { count: -1 }, { bearer: tokA });
    assert.equal(r.status, 400);
    assert.equal((await api("POST", `/v1/orders/${orderA}/users`, { count: 2 }, { bearer: tokB })).status, 404, "niet van een ander");
    r = await api("POST", `/v1/orders/${orderA}/users`, { count: 2 }, { bearer: tokA });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.users, { included: 3, extra: 2, total: 5 });
    assert.deepEqual(r.json.amount, { currency: "EUR", value: "35.95" });
    const patch = up.calls.filter((x) => x.method === "PATCH" && /\/subscriptions\//.test(x.path)).at(-1)!;
    assert.deepEqual(patch.body.amount, { currency: "EUR", value: "35.95" });
    const kit = await ok("GET", `/v1/orders/${orderA}/kit`, undefined, { bearer: tokA });
    assert.equal(kit.users, 5);
    const bill = await ok("GET", `/v1/orders/${orderA}/billing`, undefined, { bearer: tokA });
    assert.deepEqual(bill.users, { included: 3, extra: 2, extraUserMonthly: { currency: "EUR", value: "3.00" } });
    assert.equal(bill.bundle.monthly.value, "35.95");
    await waitMail("anna@klant.test", /nu 5 gebruikers/);
    assert.equal((await api("POST", `/v1/orders/${orderA}/users`, { count: 2 }, { bearer: tokA })).status, 400, "zelfde aantal");
    // Bundel wisselen neemt de extra gebruikers mee (tegen de prijs van de nieuwe bundel).
    r = await api("POST", `/v1/orders/${orderA}/bundle`, { bundle: "ruim" }, { bearer: tokA });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.amount, { currency: "EUR", value: "43.95" });
    assert.equal((await ok("GET", `/v1/orders/${orderA}/kit`, undefined, { bearer: tokA })).users, 7);
    // Een bundel zonder prijs per extra gebruiker: niets bij te kopen.
    await ok("PUT", "/v1/admin/bundles/ruim", { extraUserMonthly: null }, { staff: beheer });
    r = await api("POST", `/v1/orders/${orderA}/users`, { count: 3 }, { bearer: tokA });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /geen extra gebruikers/);
  });

  await t.test("huisstijl: naam, kleur, contact, voorwaarden, logo; openbaar te lezen", async () => {
    let r = await api("PUT", "/v1/admin/brand", { accentColor: "groen" }, { staff: owner });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /#rrggbb/);
    r = await api("PUT", "/v1/admin/brand", { name: "Rotterdamse Cloud", accentColor: "#1A6B3C", contact: { email: "hallo@rc.test", phone: "+31 10 1234567", website: "https://rc.test" }, privacyUrl: "https://rc.test/privacy" }, { staff: owner });
    assert.equal(r.status, 200, r.text);
    const b = await ok("GET", "/v1/brand");
    assert.deepEqual({ ...b, logoUrl: null }, { name: "Rotterdamse Cloud", accentColor: "#1a6b3c", contact: { email: "hallo@rc.test", phone: "+31 10 1234567", website: "https://rc.test" }, termsUrl: "https://dienst.test/voorwaarden", privacyUrl: "https://rc.test/privacy", logoUrl: null });
    const info = await ok("GET", "/v1/info");
    assert.equal(info.name, "Rotterdamse Cloud");
    assert.equal(info.privacyUrl, "https://rc.test/privacy");
    assert.equal(info.termsUrl, "https://dienst.test/voorwaarden", "standaard uit de omgeving");
    assert.equal(info.brand.accentColor, "#1a6b3c");
    // Leeg = terug naar de standaard.
    await ok("PUT", "/v1/admin/brand", { privacyUrl: "" }, { staff: owner });
    assert.equal((await ok("GET", "/v1/brand")).privacyUrl, null);

    assert.equal((await api("GET", "/v1/brand/logo")).status, 404);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
    r = await api("PUT", "/v1/admin/brand/logo", { dataUrl: `data:image/png;base64,${png.toString("base64")}` }, { staff: owner });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.brand.logoUrl, new RegExp(`^${PUBLIC}/v1/brand/logo\\?v=\\d+$`));
    const logo = await fetch(`${PUBLIC}/v1/brand/logo`);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), png);
    assert.match(logo.headers.get("content-security-policy")!, /sandbox/);
    const bad = async (type: string, data: Buffer, re: RegExp) => {
      const x = await api("PUT", "/v1/admin/brand/logo", { type, data: data.toString("base64") }, { staff: owner });
      assert.equal(x.status, 400, x.text);
      assert.match(x.json.error, re);
    };
    await bad("image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /scripts/);
    await bad("image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()"/></svg>'), /scripts/);
    await bad("image/png", Buffer.from("geen png"), /geen PNG/);
    await bad("image/gif", png, /PNG- of SVG/);
    await bad("image/png", Buffer.concat([png, Buffer.alloc(200 * 1024)]), /te groot/);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#1a6b3c"/></svg>';
    await ok("PUT", "/v1/admin/brand/logo", { type: "image/svg+xml", data: Buffer.from(svg).toString("base64") }, { staff: owner });
    const l2 = await fetch(`${PUBLIC}/v1/brand/logo`);
    assert.equal(l2.headers.get("content-type"), "image/svg+xml");
    assert.equal(await l2.text(), svg);
    // De naam komt ook in de mails aan medewerkers.
    assert.equal((await api("POST", "/v1/admin/auth/start", { email: SUPPORT })).status, 202);
    await waitMail(SUPPORT, /beheer van Rotterdamse Cloud/);
  });

  let ticketId = "";
  await t.test("hulpvragen: klant vraagt, medewerker antwoordt, met mails over en weer", async () => {
    assert.equal((await api("POST", "/v1/tickets", { subject: "Hoi" }, { bearer: tokA })).status, 400);
    assert.equal((await api("POST", "/v1/tickets", { subject: "Hoi", message: "x", orderId: orderB }, { bearer: tokA })).status, 404, "niet andermans bestelling");
    assert.equal((await api("POST", "/v1/tickets", { subject: "Hoi", message: "x" })).status, 401);
    let r = await api("POST", "/v1/tickets", { subject: "Mail komt niet aan", message: "Sinds gisteren krijg ik geen mail meer binnen.", orderId: orderA }, { bearer: tokA });
    assert.equal(r.status, 200, r.text);
    ticketId = r.json.id;
    assert.equal(r.json.status, "open");
    assert.deepEqual(r.json.messages.map((m: any) => [m.from, m.name]), [["customer", "Jij"]]);
    for (const to of [OWNER, BEHEER, SUPPORT, "meldingen@dienst.test"]) await waitMail(to, /Nieuwe hulpvraag: Mail komt niet aan/);
    assert.equal(mailCount(FIN, /hulpvraag/), 0, "financiën krijgt geen hulpvragen");

    const list = await ok("GET", "/v1/admin/tickets", undefined, { staff: support });
    assert.deepEqual(list.tickets.map((x: any) => [x.id, x.status, x.customer.email, x.domain]), [[ticketId, "open", "anna@klant.test", "anna.test"]]);
    assert.equal((await ok("GET", "/v1/admin/overview", undefined, { staff: support })).openTickets, 1);
    r = await api("POST", `/v1/admin/tickets/${ticketId}/messages`, { message: "We kijken ernaar. Staat je server aan?" }, { staff: support });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, "answered");
    const m = await waitMail("anna@klant.test", /Antwoord op je vraag: Mail komt niet aan/);
    assert.match(m.data, /Sanne van Rotterdamse Cloud/);
    assert.match(m.data, /Staat je server aan\?/);

    // Klant ziet het antwoord en reageert; een ander ziet de vraag niet.
    assert.equal((await api("GET", `/v1/tickets/${ticketId}`, undefined, { bearer: tokB })).status, 404);
    assert.deepEqual((await ok("GET", "/v1/tickets", undefined, { bearer: tokB })).tickets, []);
    const mine = await ok("GET", "/v1/tickets", undefined, { bearer: tokA });
    assert.equal(mine.tickets[0].statusLabel, "Beantwoord");
    assert.equal(mine.tickets[0].lastMessage.name, "Sanne (Rotterdamse Cloud)");
    r = await api("POST", `/v1/tickets/${ticketId}/messages`, { message: "Ja, hij staat aan." }, { bearer: tokA });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, "open");
    assert.equal(r.json.messages.length, 3);
    await waitMail(SUPPORT, /Reactie op hulpvraag: Mail komt niet aan/);
    assert.equal((await api("POST", `/v1/tickets/${ticketId}/messages`, { message: "" }, { bearer: tokA })).status, 400);

    r = await api("POST", `/v1/admin/tickets/${ticketId}/messages`, { message: "Opgelost: de mailserver is herstart.", close: true }, { staff: beheer });
    assert.equal(r.json.status, "closed");
    assert.equal((await ok("GET", "/v1/admin/tickets", undefined, { staff: support })).tickets.length, 0, "standaard alleen lopende vragen");
    assert.equal((await ok("GET", "/v1/admin/tickets?status=closed", undefined, { staff: support })).tickets.length, 1);
    assert.equal((await ok("POST", `/v1/admin/tickets/${ticketId}/reopen`, undefined, { staff: support })).status, "open");
    assert.equal((await ok("POST", `/v1/admin/tickets/${ticketId}/close`, undefined, { staff: support })).status, "closed");
    const detail = await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: support });
    assert.equal(detail.tickets[0].id, ticketId);
  });

  await t.test("berichten: voor iedereen of voor bepaalde klanten, gepland, beëindigen", async () => {
    assert.equal((await api("POST", "/v1/admin/announcements", { title: "x", body: "y", severity: "ramp" }, { staff: beheer })).status, 400);
    assert.equal((await api("POST", "/v1/admin/announcements", { title: "x", body: "y", orderIds: ["nee"] }, { staff: beheer })).status, 400);
    const all = await ok("POST", "/v1/admin/announcements", { title: "Onderhoud zondag", body: "Zondag tussen 2 en 4 uur kan mail even haperen.", severity: "onderhoud" }, { staff: beheer });
    const onlyB = await ok("POST", "/v1/admin/announcements", { title: "Storing bij jouw servers", body: "We zijn ermee bezig.", severity: "storing", audience: "orders", orderIds: [orderB] }, { staff: owner });
    await ok("POST", "/v1/admin/announcements", { title: "Later", body: "Nog niet zichtbaar.", startsAt: new Date(Date.now() + 3600_000).toISOString() }, { staff: beheer });
    assert.equal((await api("GET", "/v1/announcements")).status, 401);
    const a = await ok("GET", "/v1/announcements", undefined, { bearer: tokA });
    assert.deepEqual(a.announcements.map((x: any) => x.title), ["Onderhoud zondag"]);
    const b = await ok("GET", "/v1/announcements", undefined, { bearer: tokB });
    assert.deepEqual(b.announcements.map((x: any) => x.title), ["Storing bij jouw servers", "Onderhoud zondag"]);
    assert.equal(b.announcements[0].severity, "storing");
    assert.equal(b.announcements[0].orderIds, undefined, "klant ziet geen lijst met bestellingen");
    const staffList = await ok("GET", "/v1/admin/announcements", undefined, { staff: support });
    assert.deepEqual(staffList.announcements.map((x: any) => x.state), ["gepland", "actief", "actief"]);
    await ok("POST", `/v1/admin/announcements/${onlyB.announcement.id}/end`, undefined, { staff: beheer });
    assert.equal((await api("POST", `/v1/admin/announcements/${onlyB.announcement.id}/end`, undefined, { staff: beheer })).status, 404);
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokB })).announcements.map((x: any) => x.title), ["Onderhoud zondag"]);
    await ok("POST", `/v1/admin/announcements/${all.announcement.id}/end`, undefined, { staff: beheer });
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokA })).announcements, []);
  });

  await t.test("gezondheid: cloud meldt zich met zijn DNS-token; ongezond → automatisch bericht; weer gezond → weg", async () => {
    const kit = await ok("GET", `/v1/orders/${orderA}/kit`, undefined, { bearer: tokA });
    const kitB = await ok("GET", `/v1/orders/${orderB}/kit`, undefined, { bearer: tokB });
    const report = { version: "1.7.3", healthy: true, problems: [], storageUsedBytes: 123456789, users: 2, nodes: [{ id: "n1", region: "nl-ams-1", status: "ok" }], mail: "geheime inhoud" };
    assert.equal((await api("POST", `/v1/orders/${orderA}/health`, report)).status, 403);
    assert.equal((await api("POST", `/v1/orders/${orderA}/health`, report, { token: kitB.dns.token })).status, 403, "token van een ander");
    assert.equal((await api("POST", `/v1/orders/${orderA}/health`, report, { bearer: tokA })).status, 403, "klanttoken is geen cloudtoken");
    assert.equal((await api("POST", `/v1/orders/${orderA}/health`, { ...report, healthy: "ja" }, { token: kit.dns.token })).status, 400);
    let r = await api("POST", `/v1/orders/${orderA}/health`, report, { token: kit.dns.token });
    assert.equal(r.status, 200, r.text);
    const row = db.prepare("SELECT * FROM health WHERE order_id = ?").get(orderA) as any;
    assert.doesNotMatch(JSON.stringify(row), /geheime inhoud/, "alleen techniek wordt bewaard");
    let d = await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: support });
    assert.deepEqual([d.health.healthy, d.health.version, d.health.storageUsedBytes, d.health.users, d.health.nodes], [true, "1.7.3", 123456789, 2, [{ id: "n1", region: "nl-ams-1", status: "ok" }]]);

    // Ongezond: eerst nog geen bericht, na de drempel wel.
    r = await api("POST", `/v1/orders/${orderA}/health`, { ...report, healthy: false, problems: ["Server n2 reageert niet"] }, { token: kit.dns.token });
    assert.equal(r.status, 200);
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokA })).announcements, []);
    await sleep(UNHEALTHY_MS + 50);
    await broker.runLoop();
    let a = await ok("GET", "/v1/announcements", undefined, { bearer: tokA });
    assert.equal(a.announcements.length, 1);
    assert.equal(a.announcements[0].title, "Je cloud heeft een probleem");
    assert.equal(a.announcements[0].auto, true);
    assert.match(a.announcements[0].body, /Server n2 reageert niet/);
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokB })).announcements, [], "alleen voor deze klant");
    await waitMail("meldingen@dienst.test", /Ongezonde cloud: anna\.test/);
    const ov = await ok("GET", "/v1/admin/overview", undefined, { staff: support });
    assert.deepEqual(ov.unhealthy.map((x: any) => [x.orderId, x.flagged, x.flagReason]), [[orderA, true, "unhealthy"]]);
    assert.equal((await ok("GET", "/v1/admin/customers?health=problem", undefined, { staff: support })).total, 1);
    // Nog eens ongezond melden: geen tweede bericht.
    await api("POST", `/v1/orders/${orderA}/health`, { ...report, healthy: false, problems: ["Server n2 reageert niet"] }, { token: kit.dns.token });
    await broker.runLoop();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM announcements WHERE auto = 1").get() as any).n, 1);

    // Weer gezond → bericht beëindigd, vlag weg.
    await ok("POST", `/v1/orders/${orderA}/health`, report, { token: kit.dns.token });
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokA })).announcements, []);
    d = await ok("GET", `/v1/admin/orders/${orderA}`, undefined, { staff: support });
    assert.equal(d.health.flagged, false);
    assert.equal((await ok("GET", "/v1/admin/overview", undefined, { staff: support })).unhealthy.length, 0);

    // Lang niets gehoord terwijl de cloud klaar is → bericht; nieuwe melding → weg.
    db.prepare("UPDATE health SET reported_at = ? WHERE order_id = ?").run(Date.now() - SILENT_MS - 1000, orderA);
    await broker.runLoop();
    a = await ok("GET", "/v1/announcements", undefined, { bearer: tokA });
    assert.deepEqual(a.announcements.map((x: any) => x.title), ["We horen niets van je cloud"]);
    const h = await ok("GET", "/v1/admin/health", undefined, { staff: beheer });
    assert.equal(h.clouds.find((c: any) => c.orderId === orderA).health.flagReason, "silent");
    assert.equal(h.clouds.find((c: any) => c.orderId === orderB).health, null, "B heeft zich nog nooit gemeld");
    await ok("POST", `/v1/orders/${orderA}/health`, report, { token: kit.dns.token });
    assert.deepEqual((await ok("GET", "/v1/announcements", undefined, { bearer: tokA })).announcements, []);
    assert.equal((await api("GET", "/v1/admin/health", undefined, { staff: fin })).status, 403);
  });

  await t.test("medewerkers beheren: rol wijzigen, laatste eigenaar blijft, verwijderen, tweede stap wissen", async () => {
    const list = (await ok("GET", "/v1/admin/staff", undefined, { staff: owner })).staff;
    const id = (email: string) => list.find((s: any) => s.email === email).id;
    let r = await api("PATCH", `/v1/admin/staff/${id(OWNER)}`, { role: "beheer" }, { staff: owner });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /minstens één eigenaar/);
    assert.equal((await api("DELETE", `/v1/admin/staff/${id(OWNER)}`, undefined, { staff: owner })).status, 409);
    r = await api("PATCH", `/v1/admin/staff/${id(SUPPORT)}`, { role: "financien" }, { staff: owner });
    assert.equal(r.json.staff.role, "financien");
    assert.equal((await api("GET", "/v1/admin/payments", undefined, { staff: support })).status, 200, "nieuwe rol geldt meteen");
    assert.equal((await api("GET", "/v1/admin/tickets", undefined, { staff: support })).status, 403);
    // Tweede eigenaar: dan mag de eerste wel weg (hier niet gedaan), en de rol terug.
    await ok("PATCH", `/v1/admin/staff/${id(BEHEER)}`, { role: "eigenaar" }, { staff: owner });
    await ok("PATCH", `/v1/admin/staff/${id(BEHEER)}`, { role: "beheer" }, { staff: beheer });
    // Tweede stap wissen: sessies vervallen, bij de volgende keer opnieuw instellen.
    await ok("POST", `/v1/admin/staff/${id(FIN)}/reset`, undefined, { staff: owner });
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: fin })).status, 401);
    assert.equal((await pendingFor(FIN)).next, "enrol");
    // Verwijderen: sessie werkt meteen niet meer.
    await ok("DELETE", `/v1/admin/staff/${id(SUPPORT)}`, undefined, { staff: owner });
    assert.equal((await api("GET", "/v1/admin/me", undefined, { staff: support })).status, 401);
    assert.equal((await api("DELETE", `/v1/admin/staff/${id(SUPPORT)}`, undefined, { staff: owner })).status, 404);
    // Eigen account: telefoon weghalen kan niet als het de enige tweede stap is.
    const meB = (await ok("GET", "/v1/admin/me", undefined, { staff: beheer })).staff;
    r = await api("DELETE", `/v1/admin/me/device/${meB.devices[0].id}`, undefined, { staff: beheer });
    assert.equal(r.status, 409);
  });

  await t.test("opzeggen en opruimen door beheer", async () => {
    let r = await api("POST", `/v1/admin/orders/${orderB}/cancel`, {}, { staff: beheer });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.order.status, "cancelled");
    assert.equal((await api("POST", `/v1/admin/orders/${orderB}/cancel`, {}, { staff: beheer })).status, 409);
    r = await ok("POST", `/v1/admin/orders/${orderB}/cleanup`, {}, { staff: beheer });
    assert.deepEqual(r.result.done, []);
    assert.ok(r.result.plan.length > 0);
    r = await ok("POST", `/v1/admin/orders/${orderB}/cleanup`, { sure: true }, { staff: beheer });
    assert.ok(r.result.done.includes("DNS-toegang en pakket gewist"));
    assert.equal((await ok("GET", `/v1/admin/orders/${orderB}`, undefined, { staff: beheer })).actions.cleanup, false);
  });

  await t.test("logboek: wie deed wat, alleen voor de eigenaar", async () => {
    const r = await ok("GET", "/v1/admin/audit?limit=500", undefined, { staff: owner });
    const has = (action: string, who: string | null, target?: string) => r.entries.some((e: any) => e.action === action && e.staff === who && (target === undefined || e.target === target));
    assert.ok(has("staff-add", null, OWNER), "eigenaar uit de omgeving");
    assert.ok(has("login", OWNER));
    assert.ok(has("second-factor-add", OWNER));
    assert.ok(has("staff-add", OWNER, BEHEER));
    assert.ok(has("invite-create", BEHEER, inviteCode));
    assert.ok(has("order-suspend", BEHEER, orderB));
    assert.ok(has("order-resume", OWNER, orderB));
    assert.ok(has("refund", FIN, firstPaymentA));
    assert.ok(has("bundle-change", BEHEER, "compleet"));
    assert.ok(has("bundle-add", OWNER, "gezin"));
    assert.ok(has("brand-change", OWNER));
    assert.ok(has("brand-logo", OWNER));
    assert.ok(has("ticket-reply", SUPPORT, ticketId));
    assert.ok(has("announcement-create", BEHEER));
    assert.ok(has("staff-role", OWNER, SUPPORT));
    assert.ok(has("staff-remove", OWNER, SUPPORT));
    assert.ok(has("order-cleanup", BEHEER, orderB));
    const refund = r.entries.find((e: any) => e.action === "refund");
    assert.deepEqual([refund.detail.amount, refund.detail.orderId], ["19.95", orderA]);
    assert.ok(r.entries.every((e: any) => typeof e.at === "number"));
    const page = await ok("GET", `/v1/admin/audit?limit=2&before=${r.entries[1].id}`, undefined, { staff: owner });
    assert.equal(page.entries[0].id, r.entries[2].id);
    assert.ok((await ok("GET", `/v1/admin/audit?staff=${FIN}`, undefined, { staff: owner })).entries.every((e: any) => e.staff === FIN));
  });

  await t.test("beheerpagina's op /beheer", async () => {
    const r = await fetch(`${PUBLIC}/beheer`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/beheer/");
    const page = await fetch(`${PUBLIC}/beheer/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
    const html = await page.text();
    assert.match(html, /<html lang="nl">/);
    for (const f of ["app.js", "dienst.css", "tokens.css"]) assert.equal((await fetch(`${PUBLIC}/beheer/${f}`)).status, 200, f);
    assert.equal((await fetch(`${PUBLIC}/beheer/fonts/atkinson-hyperlegible-latin-400-normal.woff2`)).status, 200);
  });
});
