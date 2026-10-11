/**
 * Overstappen naar een andere aanbieder (of zelf beheren).
 *  1. De Diensten: DNS vrijgeven (eigen domein, geregistreerd domein → verhuizen met de verhuiscode), de nieuwe
 *     aanbieder wacht daarop, en terug (dns-terug).
 *  2. Opslag kopiëren: hervatten, niets dubbel, controle.
 *  3. De console met een gratis adres van de adressendienst: overdrachtscode, en stoppen (adres terug naar A).
 *  4. De console van begin tot eind met een echte (lokale) cloud: A → B (eigen domein), dan B → zelf beheren
 *     waarbij het wekken mislukt en de cloud terug gaat naar B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { twoDiensten, REGISTRANT } from "./helpers/two-diensten.js";
import { getOrder } from "../src/broker/db.js";
import { readInput } from "../src/broker/provision.js";
import { makeStore } from "../src/cluster/stores.js";
import { fakeS3 } from "./helpers/fake-s3.js";

const WAIT = "Wacht tot je vorige aanbieder je DNS vrijgeeft";
const stepOf = (o: any, id: string) => o.steps.find((s: any) => s.id === id);

test("Diensten: DNS vrijgeven, de nieuwe aanbieder wacht, en terug", { timeout: 120_000 }, async (t) => {
  const w = await twoDiensten();
  t.after(() => w.close());
  const { A, B, api, login, pay, order, until, up } = w;
  const zone = (d: string) => up.st.desec.zones.get(d);

  await t.test("eigen domein: A geeft vrij, B wacht en maakt daarna de zone", async () => {
    const ta = await login(A, "klant@elders.test");
    let r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "vanes.test" }, acceptTerms: true }, ta);
    assert.equal(r.status, 200, r.text);
    const oa = r.json.orderId;
    await pay(A, oa);
    await until("A klaar", async () => (await order(A, oa, ta)).status === "ready");
    assert.equal(zone("vanes.test")?.account, "dienst", "zone bij A (account dienst)");
    assert.ok(zone("vanes.test")!.rrsets.has("_acme-challenge.cloud/CNAME"));

    r = await api(A, "POST", `/v1/orders/${oa}/dns-vrijgeven`, {}, ta);
    assert.equal(r.status, 409, "niet zonder te bevestigen dat je overstapt");
    assert.match(r.json.error, /gebruikt deze DNS nog/);

    const tb = await login(B, "klant@elders.test");
    r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "own", name: "vanes.test" }, acceptTerms: true }, tb);
    assert.equal(r.status, 200, r.text);
    const ob = r.json.orderId;
    await pay(B, ob);
    const waiting = await until("B wacht op de DNS", async () => { const o = await order(B, ob, tb); return stepOf(o, "dns-zone")?.detail === WAIT && stepOf(o, "scaleway-iam")?.state === "done" && o; });
    assert.equal(waiting.status, "provisioning", "wachten is geen fout");
    assert.equal(stepOf(waiting, "scaleway-project").state, "done", "wat de zone niet nodig heeft, loopt alvast door");
    assert.equal(stepOf(waiting, "mail").state, "wait");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal((await order(B, ob, tb)).status, "provisioning", "blijft wachten (niet mislukt)");

    r = await api(A, "POST", `/v1/orders/${oa}/dns-vrijgeven`, { overstap: true }, ta);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, domain: "vanes.test", released: true, dnssec: "zelf" });
    assert.equal((await api(A, "POST", `/v1/orders/${oa}/dns-vrijgeven`, {}, ta)).status, 200, "nog eens: verandert niets");

    await until("B klaar", async () => (await order(B, ob, tb)).status === "ready");
    assert.equal(zone("vanes.test")?.account, "b", "zone nu bij B");
    const kitB = (await api(B, "GET", `/v1/orders/${ob}/kit`, undefined, tb)).json;
    assert.deepEqual(kitB.ds, ["12345 13 2 abcdef"], "DS-records voor bij de registrar");

    // Terug (overstappen mislukt): B geeft vrij, A zet de zone weer neer met zijn eigen records.
    assert.equal((await api(A, "POST", `/v1/orders/${oa}/dns-terug`, {}, ta)).status, 409, "zone staat nog bij B");
    assert.equal((await api(B, "POST", `/v1/orders/${ob}/cancel`, {}, tb)).status, 200);
    assert.equal((await api(B, "POST", `/v1/orders/${ob}/dns-vrijgeven`, {}, tb)).status, 200, "opgezegd: vrijgeven zonder bevestiging");
    r = await api(A, "POST", `/v1/orders/${oa}/dns-terug`, {}, ta);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.ds, ["12345 13 2 abcdef"]);
    assert.equal(zone("vanes.test")?.account, "dienst", "zone weer bij A");
    assert.ok(zone("vanes.test")!.rrsets.has("_acme-challenge.mail/CNAME"), "acme-verwijzingen terug");
    assert.ok([...zone("vanes.test")!.rrsets.keys()].some((k) => /\._domainkey\/TXT$/.test(k)), "DKIM van de mail-relay terug");
  });

  await t.test("geregistreerd domein: DNSSEC uit bij het register, B verhuist met de verhuiscode", async () => {
    const ta = await login(A, "tweede@elders.test");
    let r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "register", name: "vanes.eu" }, registrant: REGISTRANT, acceptTerms: true }, ta);
    assert.equal(r.status, 200, r.text);
    const oa = r.json.orderId;
    await pay(A, oa);
    await until("A klaar", async () => (await order(A, oa, ta)).status === "ready");
    const opDomain = up.st.op.domains.find((d) => `${d.domain.name}.${d.domain.extension}` === "vanes.eu")!;
    assert.equal(opDomain.is_dnssec_enabled, true);
    const auth = (await api(A, "GET", `/v1/orders/${oa}/authcode`, undefined, ta)).json.authCode;

    const tb = await login(B, "tweede@elders.test");
    r = await api(B, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "transfer", name: "vanes.eu", authCode: auth }, registrant: REGISTRANT, acceptTerms: true }, tb);
    assert.equal(r.status, 200, r.text);
    const ob = r.json.orderId;
    assert.equal(readInput(B.broker.ctx, getOrder(B.broker.ctx.db, ob)!).authCode, auth, "verhuiscode van A");
    await pay(B, ob);
    await until("B wacht", async () => stepOf(await order(B, ob, tb), "dns-zone")?.detail === WAIT);
    r = await api(A, "POST", `/v1/orders/${oa}/dns-vrijgeven`, { overstap: true }, ta);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.dnssec, "uitgezet");
    assert.equal(opDomain.is_dnssec_enabled, false, "geen DS bij het register: het domein blijft werken met de nieuwe sleutels");
    const done = await until("B klaar", async () => { const o = await order(B, ob, tb); return o.status === "ready" && o; });
    assert.match(stepOf(done, "domain").detail, /Verhuizing aangevraagd|Geregistreerd/);
  });

  await t.test("een gratis adres geef je niet vrij", async () => {
    const ta = await login(A, "derde@elders.test");
    const r = await api(A, "POST", "/v1/orders", { bundle: "compleet", domain: { mode: "sub", name: "derde" }, acceptTerms: true }, ta);
    await pay(A, r.json.orderId);
    await until("klaar", async () => (await order(A, r.json.orderId, ta)).status === "ready");
    const rel = await api(A, "POST", `/v1/orders/${r.json.orderId}/dns-vrijgeven`, { overstap: true }, ta);
    assert.equal(rel.status, 400);
    assert.match(rel.json.error, /overdrachtscode/);
  });
});

test("opslag kopiëren: hervatten, niets dubbel, controle", async () => {
  const { copyStores } = await import("../src/console/overstap.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kopie-"));
  const a = makeStore({ name: "a", type: "fs", purpose: "replica", dir: path.join(dir, "a") });
  const ab = makeStore({ name: "ab", type: "fs", purpose: "backup", dir: path.join(dir, "ab") });
  const s3 = fakeS3();
  const S3 = `http://127.0.0.1:${await s3.listening}`;
  const b = makeStore({ name: "b", type: "s3", purpose: "replica", endpoint: S3, region: "nl-ams", bucket: "b", accessKey: "x", secretKey: "y" });
  const bb = makeStore({ name: "bb", type: "s3", purpose: "backup", endpoint: S3, region: "fr-par", bucket: "bb", accessKey: "x", secretKey: "y" });
  try {
    s3.buckets.set("b", { lock: false, versioning: false, retentionDays: 0, objects: new Map() });
    s3.buckets.set("bb", { lock: true, versioning: true, retentionDays: 30, objects: new Map() });
    for (let i = 0; i < 12; i++) await a.put(`blobs/aa/${i}`, Buffer.alloc(100 + i, i));
    await a.put("db/snap-1.enc", Buffer.from("snapshot"));
    await a.put("manifest.enc", Buffer.from("manifest-1"));
    await a.put("bootstrap/n-1.enc", Buffer.from("niet mee"));
    await ab.put("db/snap-1.enc", Buffer.from("snapshot"));
    await ab.put("db/snap-0.enc", Buffer.from("oude snapshot (alleen in de back-up)"));

    // Halverwege gestopt: een deel staat er al (en één met een andere grootte).
    await b.put("blobs/aa/0", Buffer.alloc(100, 0));
    await b.put("blobs/aa/1", Buffer.alloc(5, 1));
    let seen = 0;
    const p1 = await copyStores([a, ab], [b, bb], () => { seen++; });
    assert.ok(seen > 0, "voortgang gemeld");
    assert.equal(p1.objects, 14 + 2, "replica→replica en back-up→back-up, zonder bootstrap/");
    assert.equal(p1.skipped, 1, "alleen de al complete blob overgeslagen");
    assert.equal((await b.getBuffer("blobs/aa/1"))!.length, 101, "verkeerde grootte opnieuw gekopieerd");
    assert.equal(await b.head("bootstrap/n-1.enc"), false);
    assert.equal((await bb.getBuffer("db/snap-0.enc"))!.toString(), "oude snapshot (alleen in de back-up)");

    // Nog eens: alles onder db/ en blobs/ overgeslagen; het manifest (verandert) altijd opnieuw.
    await a.put("manifest.enc", Buffer.from("manifest-2"));
    const p2 = await copyStores([a, ab], [b, bb]);
    assert.equal(p2.skipped, 13 + 2);
    assert.equal((await b.getBuffer("manifest.enc"))!.toString(), "manifest-2");

    // Controle: wat niet aankomt, wordt gemeld.
    const kapot = { ...b, name: "kapot", purpose: "replica" as const, config: b.config, put: async (_k: string, body: unknown) => { if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") for await (const _ of body as AsyncIterable<unknown>) { /* weggooien */ } }, list: b.list.bind(b), get: b.get.bind(b), getBuffer: b.getBuffer.bind(b), head: b.head.bind(b), delete: b.delete.bind(b), presignGet: b.presignGet.bind(b) };
    await a.put("blobs/bb/nieuw", Buffer.from("nieuw"));
    await assert.rejects(copyStores([a], [kapot]), /1 bestand ontbreekt in kapot/);
  } finally {
    await s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────── De console ─────────

type App = { inject: (o: object) => Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }>; close: () => Promise<unknown> };
function client(app: App) {
  let cookie = "";
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method, url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    let json: any = null; try { json = r.json(); } catch { /* */ }
    return { status: r.statusCode, json, text: r.body };
  };
}
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 300): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error(`Timeout: ${what}`); await new Promise((r) => setTimeout(r, every)); }
};
/** Alle lokale "servers" (processen) onder deze map stoppen. */
function killAll(base: string) {
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === "servers.json" ? [path.join(d, e.name)] : []) : [];
  for (const f of walk(base)) for (const s of Object.values(JSON.parse(fs.readFileSync(f, "utf8"))) as { pid: number }[]) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* */ } }
}
const PASS = "vier losse woorden hier";

/** Console met een abonnement bij A (pakket op deze computer), zonder of met een gestarte cloud. */
async function consoleBij(w: Awaited<ReturnType<typeof twoDiensten>>, base: string, domain: string, mode: "own" | "sub" | "buy", email: string) {
  process.env.EIGEN_VAULT = path.join(base, "kluis.json");
  const { buildConsole } = await import(`../src/console/server.js?o=${Date.now()}`);
  const app = (await buildConsole()) as App;
  const c = client(app);
  let r = await c("POST", "/api/setup/create", { domain, domainMode: mode, mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: email, passphrase: PASS });
  assert.equal(r.status, 200, r.text);
  const key = (await c("GET", "/api/key")).json;
  assert.equal((await c("POST", "/api/key/confirm", { g3: key.groups[2], g7: key.groups[6] })).status, 200);
  assert.equal((await c("POST", "/api/dienst/select", { url: w.A.PUBLIC })).status, 200);
  assert.equal((await c("POST", "/api/dienst/login", { email })).status, 200);
  assert.equal((await c("POST", "/api/dienst/verify", { code: await w.code(w.A, email) })).status, 200);
  r = await c("POST", "/api/dienst/order", { bundle: "compleet", mode: mode === "buy" ? "register" : mode, acceptTerms: true, ...(mode === "buy" ? { registrant: REGISTRANT } : {}) });
  assert.equal(r.status, 200, r.text);
  await w.pay(w.A, r.json.orderId);
  await until("A klaar", async () => (await c("GET", "/api/dienst/status")).json.status === "ready", 20_000, 50);
  r = await c("POST", "/api/dienst/apply");
  assert.equal(r.status, 200, r.text);
  return { app, c, orderA: (await c("GET", "/api/config")).json.dienst.orderId as string };
}

test("console: gratis adres van de adressendienst gaat mee met de overdrachtscode; stoppen geeft het terug", { timeout: 120_000 }, async (t) => {
  const w = await twoDiensten();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "overstap-adres-"));
  process.env.EIGEN_CONSOLE_LOCAL = "1";
  process.env.EIGEN_TEST_KIT_LOCAL = "1";
  t.after(async () => { await w.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const { app, c } = await consoleBij(w, base, "vanes.eigencloud.test", "sub", "adres@elders.test");
  t.after(() => app.close());
  const conf = (await c("GET", "/api/config")).json;
  assert.equal(conf.dienst.applied, true);

  let r = await c("POST", "/api/overstap/start", { naar: w.B.PUBLIC });
  assert.equal(r.status, 400, "nog niet gestart");
  assert.match(r.json.error, /nog niet gestart/);
  // Doen alsof de cloud draait (de echte cloud zit in de grote test hieronder).
  await c("POST", "/api/lock");
  const { Vault } = await import("../src/console/vault.js");
  const v = new Vault(process.env.EIGEN_VAULT!);
  v.unlock(PASS);
  assert.match(v.config!.console.dienst!.transferCode!, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/, "overdrachtscode bewaard bij het overnemen van het pakket");
  v.config!.console.done = true;
  v.save();
  assert.equal((await c("POST", "/api/unlock", { passphrase: PASS })).status, 200);

  r = await c("POST", "/api/overstap/start", { naar: "zelf" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /alleen bij een aanbieder blijven/);
  r = await c("POST", "/api/overstap/start", { naar: w.A.PUBLIC });
  assert.match(r.json.error, /al bij deze aanbieder/);

  r = await c("POST", "/api/overstap/start", { naar: w.B.PUBLIC });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.stap, "inloggen");
  assert.equal(r.json.naarNaam, "Aanbieder B");
  assert.deepEqual(r.json.van, { url: w.A.PUBLIC, naam: "Aanbieder A", domain: "vanes.eigencloud.test", mode: "sub", central: true });
  assert.equal(r.json.dnsNodig, false);
  assert.equal(r.json.schatting.minuten, 17, "vooraf kopiëren: kwartier plus een paar minuten");
  assert.equal((await c("POST", "/api/overstap/login", { email: "adres@elders.test" })).status, 200);
  assert.equal((await c("POST", "/api/overstap/verify", { code: await w.code(w.B, "adres@elders.test") })).status, 200);
  assert.equal((await c("GET", "/api/overstap")).json.stap, "bestellen");
  assert.equal((await c("GET", "/api/config")).json.dienst.url, w.A.PUBLIC, "de sessie bij A blijft tot het omzetten");
  r = await c("POST", "/api/overstap/order", { bundle: "compleet", acceptTerms: true });
  assert.equal(r.status, 200, r.text);
  const orderB = r.json.orderId;
  const inB = readInput(w.B.broker.ctx, getOrder(w.B.broker.ctx.db, orderB)!);
  assert.equal(inB.transferCode, v.config!.console.dienst!.transferCode, "besteld met de overdrachtscode");
  assert.equal(getOrder(w.B.broker.ctx.db, orderB)!.domain_mode, "sub");
  await w.pay(w.B, orderB);
  const g = await until("klaar om over te zetten", async () => { const x = (await c("GET", "/api/overstap")).json; return x.stap === "gereed" && x; }, 20_000, 50);
  assert.equal(g.bestelling.status, "ready");
  const log = w.svc.ctx.db.prepare("SELECT actie, dienst FROM logboek WHERE naam = ? ORDER BY id").all("vanes.eigencloud.test") as { actie: string; dienst: string }[];
  assert.deepEqual(log.map((l) => l.actie), ["aangemaakt", "overgedragen"], "B heeft het adres");

  // Toch niet: stoppen. Het adres gaat terug naar A (met de nieuwe code van B) en de bestelling bij B wordt opgezegd.
  r = await c("POST", "/api/overstap/stoppen");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await c("GET", "/api/overstap")).json, { actief: false });
  const log2 = w.svc.ctx.db.prepare("SELECT actie, dienst FROM logboek WHERE naam = ? ORDER BY id").all("vanes.eigencloud.test") as { actie: string; dienst: string }[];
  assert.equal(log2.at(-1)!.dienst, w.A.PUBLIC, "weer bij A");
  assert.equal(getOrder(w.B.broker.ctx.db, orderB)!.status, "cancelled");
  // De cloud kan weer DNS schrijven via A.
  const tokenA = v.config!.dns[0].token!;
  const wr = await fetch(`${w.A.PUBLIC}/v1/desec/domains/vanes.eigencloud.test/rrsets/`, { method: "PATCH", headers: { authorization: `Token ${tokenA}`, "content-type": "application/json" }, body: JSON.stringify([{ subname: "cloud", type: "A", ttl: 3600, records: ["192.0.2.9"] }]) });
  assert.equal(wr.status, 200);
});

/** Doen alsof de cloud al draait (zonder echte servers). */
async function markDone(c: ReturnType<typeof client>) {
  await c("POST", "/api/lock");
  const { Vault } = await import("../src/console/vault.js");
  const v = new Vault(process.env.EIGEN_VAULT!);
  v.unlock(PASS);
  v.config!.console.done = true;
  v.save();
  assert.equal((await c("POST", "/api/unlock", { passphrase: PASS })).status, 200);
  return v;
}

test("console: domein via A geregistreerd → bij B verhuizen met de verhuiscode van A", { timeout: 120_000 }, async (t) => {
  const w = await twoDiensten();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "overstap-domein-"));
  process.env.EIGEN_CONSOLE_LOCAL = "1";
  process.env.EIGEN_TEST_KIT_LOCAL = "1";
  t.after(async () => { await w.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const { app, c, orderA } = await consoleBij(w, base, "vanes.eu", "buy", "domein@elders.test");
  t.after(() => app.close());
  await markDone(c);
  let r = await c("POST", "/api/overstap/start", { naar: w.B.PUBLIC });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.van.mode, "register");
  assert.equal((await c("POST", "/api/overstap/login", { email: "domein@elders.test" })).status, 200);
  assert.equal((await c("POST", "/api/overstap/verify", { code: await w.code(w.B, "domein@elders.test") })).status, 200);
  r = await c("POST", "/api/overstap/order", { bundle: "compleet", acceptTerms: true });
  assert.equal(r.status, 400, "houder nodig om te verhuizen");
  assert.match(r.json.error, /houder/);
  r = await c("POST", "/api/overstap/order", { bundle: "compleet", acceptTerms: true, registrant: REGISTRANT });
  assert.equal(r.status, 200, r.text);
  const ob = getOrder(w.B.broker.ctx.db, r.json.orderId)!;
  assert.equal(ob.domain_mode, "transfer");
  const opA = w.up.st.op.domains.find((d) => `${d.domain.name}.${d.domain.extension}` === "vanes.eu")!;
  assert.equal(readInput(w.B.broker.ctx, ob).authCode, opA.authCode, "verhuiscode van A");
  assert.ok(getOrder(w.A.broker.ctx.db, orderA), "A ongewijzigd");
  assert.equal((await c("POST", "/api/overstap/nu", { confirm: true })).status, 400, "nog niet betaald");
  assert.equal((await c("POST", "/api/overstap/stoppen")).status, 200);
  assert.equal(getOrder(w.B.broker.ctx.db, ob.id)!.status, "cancelled", "bestelling bij B opgezegd");
  assert.equal(getOrder(w.A.broker.ctx.db, orderA)!.status, "ready", "A loopt gewoon door");
});

test("console met een echte cloud: van A naar B (eigen domein), dan naar zelf beheren; wekken mislukt → terug naar B", { skip: process.env.SKIP_CLUSTER === "1", timeout: 900_000 }, async (t) => {
  const w = await twoDiensten();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "overstap-cloud-"));
  const s3 = fakeS3();
  Object.assign(process.env, {
    EIGEN_CONSOLE_LOCAL: "1", EIGEN_TEST_KIT_LOCAL: "1", CLUSTER_FAST: "1",
    EIGEN_TEST_S3: `http://127.0.0.1:${await s3.listening}`, EIGEN_SCW_API: `${w.U}/scw`, EIGEN_DESEC_URL: `${w.U}/desec`,
    EIGEN_OVERSTAP_POLL_MS: "300", EIGEN_OVERSTAP_WAKE_MS: "180000",
  });
  t.after(async () => { if (!process.env.KEEP) killAll(base); await s3.close(); await w.close(); });
  const { app, c, orderA } = await consoleBij(w, base, "vanes.test", "own", "rene@elders.test");
  t.after(() => app.close());
  const zone = () => w.up.st.desec.zones.get("vanes.test");
  const appLogin = async (url: string) => {
    const r = await until("inloggen", async () => { const x = await fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mijn-cloud-wachtwoord" }) }); return x.status === 200 && x; }, 60_000);
    return ((await r.json()) as { token: string }).token;
  };
  const events = async (url: string) => {
    const token = await appLogin(url);
    return ((await (await fetch(`${url}/api/events?from=${Date.UTC(2026, 9, 1)}&to=${Date.UTC(2026, 11, 1)}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { title: string }[]).map((e) => e.title);
  };
  const awake = async (ms = 240_000) => until("wakker", async () => { const s = (await c("GET", "/api/status")).json; return s.state === "awake" && s.live?.nodes?.filter((n: { status: string }) => n.status === "ready").length >= 2 && s; }, ms, 1000);
  const follow = async (want: string[], ms = 600_000) => until(`overstap ${want.join("/")}`, async () => {
    const x = (await c("GET", "/api/overstap")).json;
    if (x.fout && !want.includes(x.stap)) throw Object.assign(new Error(`overstap: ${x.fout}`), { x });
    return want.includes(x.stap) && x;
  }, ms, 500).catch((e) => { throw new Error(`${(e as Error).message} ${JSON.stringify((e as { x?: unknown }).x ?? "")}`); });

  let appUrl = "";
  await t.test("de cloud draait bij A", async () => {
    assert.equal((await c("POST", "/api/launch")).status, 200);
    const st = await awake();
    appUrl = st.appUrl;
    const token = await appLogin(appUrl);
    const ev = await fetch(`${appUrl}/api/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "Gemaakt bij A", start: Date.UTC(2026, 10, 1, 9), end: Date.UTC(2026, 10, 1, 10) }) });
    assert.equal(ev.status, 200);
    await until("DNS via A", async () => zone()?.rrsets.has("cloud/A"), 60_000);
    assert.equal(zone()!.account, "dienst");
  });

  let storesA: string[] = [];
  await t.test("overstappen naar B: bestellen, B wacht op de DNS, overzetten", async () => {
    storesA = (await c("GET", "/api/config")).json.stores.map((s: { dir: string }) => s.dir);
    let r = await c("POST", "/api/overstap/start", { naar: w.B.PUBLIC });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.van.mode, "own");
    assert.equal(r.json.dnsNodig, true);
    assert.ok(r.json.schatting.objects > 0 && r.json.schatting.bytes > 0, "grootte van de cloud bekend");
    assert.equal((await c("POST", "/api/overstap/login", { email: "rene@elders.test" })).status, 200);
    assert.equal((await c("POST", "/api/overstap/verify", { code: await w.code(w.B, "rene@elders.test") })).status, 200);
    r = await c("POST", "/api/overstap/order", { bundle: "compleet", acceptTerms: true });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\//);
    assert.equal((await c("POST", "/api/overstap/nu", { confirm: true })).status, 400, "nog niet betaald");
    await w.pay(w.B, r.json.orderId);
    const g = await follow(["gereed"], 30_000);
    assert.equal(g.bestelling.status, "provisioning", "B wacht op onze DNS");
    assert.equal((await c("POST", "/api/overstap/nu", {})).status, 400, "alleen met bevestiging");
    r = await c("POST", "/api/overstap/nu", { confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stap, "overzetten");
    const k = await follow(["klaar"]);
    assert.ok(k.stappen.every((s: { state: string }) => s.state === "done"), JSON.stringify(k.stappen));
    assert.deepEqual(k.klaar.ds, ["12345 13 2 abcdef"], "nieuwe DS voor bij de registrar");
    assert.equal(k.kopie.objects > 0, true);
  });

  await t.test("bij B: gegevens terug, DNS bij B, A opgezegd, opslag van A onaangeroerd", async () => {
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dienst.url, w.B.PUBLIC);
    assert.notEqual(conf.dienst.orderId, orderA);
    assert.ok(conf.stores.every((s: { dir: string }) => s.dir.includes(conf.dienst.orderId)), "opslag van B");
    assert.match(conf.dns[0].api, new RegExp(`^${w.B.PUBLIC}`), "DNS via de proxy van B");
    const st = await awake();
    assert.deepEqual(await events(st.appUrl), ["Gemaakt bij A"]);
    assert.equal(getOrder(w.A.broker.ctx.db, orderA)!.status, "cancelled");
    assert.ok(storesA.every((d) => fs.existsSync(path.join(d, "manifest.enc"))), "opslag van A staat er nog");
    assert.equal(zone()!.account, "b");
    await until("cloud zet zijn DNS-records zelf bij B", async () => zone()!.rrsets.has("cloud/A"), 120_000, 1000);
    const live = (await c("GET", "/api/status")).json.live;
    assert.ok(live.events.some((e: { message: string }) => /nieuwe aanbieder overgenomen/.test(e.message)), "adminOverride toegepast");
    assert.equal((await c("POST", "/api/overstap/stoppen")).status, 200, "wegklikken");
  });

  await t.test("naar zelf beheren: sleutels, overzetten, wekken mislukt, terug naar B", async () => {
    const AK = "SCWZELFZELFZELF12345", SK = "99999999-2222-3333-4444-555555555555", PROJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    w.up.st.scw.keys.add(SK);
    w.up.desecAccount("desec-klant", "klant");
    let r = await c("POST", "/api/overstap/start", { naar: "zelf" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stap, "zelf");
    r = await c("POST", "/api/overstap/zelf", { accessKey: AK, secretKey: SK, projectId: PROJECT, desecToken: "fout" });
    assert.match(r.json.error, /deSEC accepteert/);
    r = await c("POST", "/api/overstap/zelf", { accessKey: AK, secretKey: SK, projectId: PROJECT, desecToken: "desec-klant" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stap, "gereed");
    process.env.EIGEN_OVERSTAP_WAKE_MS = "15000";
    r = await c("POST", "/api/overstap/nu", { confirm: true });
    assert.equal(r.status, 200, r.text);
    const m = await follow(["mislukt"]);
    assert.match(m.fout, /komt niet op/);
    assert.equal(m.kanTerug, true);
    assert.equal(zone()!.account, "klant", "zone stond al in je eigen deSEC-account");
    assert.ok(w.up.st.scw.servers.length >= 1, "server bij Scaleway (nep) gestart");
    process.env.EIGEN_OVERSTAP_WAKE_MS = "180000";
    r = await c("POST", "/api/overstap/terug");
    assert.equal(r.status, 200, r.text);
    const back = await follow(["teruggezet"]);
    assert.ok(back.stappen.every((s: { state: string }) => s.state === "done"), JSON.stringify(back.stappen));
    assert.equal(w.up.st.scw.servers.length, 0, "server bij Scaleway weer weg");
    assert.equal(zone()!.account, "b", "DNS weer bij B");
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.dienst.url, w.B.PUBLIC);
    assert.equal(conf.quick, null);
    const st = await awake();
    assert.deepEqual(await events(st.appUrl), ["Gemaakt bij A"], "gegevens nog steeds compleet");
    assert.equal((await c("POST", "/api/overstap/stoppen")).status, 200);
  });
});
