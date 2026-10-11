/**
 * Centrale adressendienst tegen een nep-deSEC: ondertekening (onbekende aanbieder, foute handtekening, klok,
 * opnieuw afspelen), aanvragen (token schrijft alleen in de eigen zone), overdragen met de code van de klant
 * (oud token ingetrokken, code vernieuwd) en vrijgeven (met quarantaine).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAdresConfig } from "../src/adressen/config.js";
import { createAdressen } from "../src/adressen/app.js";
import { publicKeyB64, signHeaders, signingString, verifySignature } from "../src/adressen/sign.js";
import { freePort } from "./helpers/cluster.js";
import { fakeUpstream } from "./helpers/broker-fakes.js";

const ZONE = "eigencloud.test";
const A = "https://dienst-a.test", B = "https://dienst-b.test", C = "https://zonder-sleutel.test", X = "https://niet-op-de-lijst.test";

test("ondertekening: heen en terug", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const h = signHeaders(privateKey, A, "post", "/v1/namen?x=1", '{"a":1}', 1_700_000_000_000);
  assert.equal(h["x-tijd"], "1700000000000");
  assert.match(signingString("post", "/p", "1", ""), /^POST\n\/p\n1\ne3b0c442/);
  assert.ok(verifySignature(publicKey, "POST", "/v1/namen?x=1", h["x-tijd"], '{"a":1}', h["x-handtekening"]));
  assert.ok(!verifySignature(publicKey, "POST", "/v1/namen?x=1", h["x-tijd"], '{"a":2}', h["x-handtekening"]), "andere body");
  assert.ok(!verifySignature(publicKey, "POST", "/v1/namen", h["x-tijd"], '{"a":1}', h["x-handtekening"]), "ander pad");
  assert.ok(!verifySignature(publicKey, "POST", "/v1/namen?x=1", h["x-tijd"], '{"a":1}', "kapot"));
});

test("adressendienst: aanvragen, overdragen, vrijgeven", { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adressen-"));
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.desecAccount("desec-centraal", "centraal");
  up.st.desec.zones.set(ZONE, { name: ZONE, account: "centraal", keys: [], rrsets: new Map() });
  // Een ander account met een eigen zone: daar mag een uitgegeven token nooit bij.
  up.st.desec.zones.set("anders.test", { name: "anders.test", keys: [], rrsets: new Map() });

  const keyA = crypto.generateKeyPairSync("ed25519").privateKey;
  const keyB = crypto.generateKeyPairSync("ed25519").privateKey;
  const list = path.join(dir, "aanbieders.json");
  fs.writeFileSync(list, JSON.stringify([
    { naam: "Aanbieder A", url: `${A}/`, land: "NL", sleutel: publicKeyB64(keyA) },
    { naam: "Aanbieder B", url: B, sleutel: publicKeyB64(keyB) },
    { naam: "Zonder sleutel", url: C },
  ]));
  const port = await freePort();
  const svc = await createAdressen(loadAdresConfig({
    ADRES_ZONE: "EigenCloud.test.", ADRES_DESEC_TOKEN: "desec-centraal", ADRES_DESEC_URL: `${U}/desec`,
    ADRES_PORT: String(port), ADRES_DATA_DIR: dir, ADRES_LIST_URL: list, ADRES_PUBLIC_URL: `http://127.0.0.1:${port}`,
  }));
  await svc.app.listen({ port, host: "127.0.0.1" });
  t.after(async () => { await svc.close(); await up.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const BASE = `http://127.0.0.1:${port}`;

  const call = async (method: string, p: string, opts: { key?: crypto.KeyObject; dienst?: string; body?: unknown; headers?: Record<string, string>; now?: number } = {}) => {
    const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      ...(opts.key ? signHeaders(opts.key, opts.dienst ?? A, method, p, raw, opts.now) : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    };
    const r = await fetch(BASE + p, { method, headers, body: opts.body === undefined ? undefined : raw });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text, headers };
  };
  /** Rechtstreeks naar de nep-deSEC met een uitgegeven token. */
  const desec = async (token: string, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${U}/desec${p}`, { method, headers: { authorization: `Token ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.status;
  };
  const rr = (sub: string, value: string) => [{ subname: sub, type: "TXT", ttl: 3600, records: [`"${value}"`] }];
  const logs = () => svc.ctx.db.prepare("SELECT actie, naam, dienst FROM logboek ORDER BY id").all() as { actie: string; naam: string; dienst: string }[];

  await t.test("info en vrij/bezet (openbaar)", async () => {
    assert.deepEqual((await call("GET", "/v1/info")).json, { zone: ZONE, nameservers: ["ns1.desec.io", "ns2.desec.org"] });
    assert.deepEqual((await call("GET", "/v1/naam/Vanes")).json, { naam: `vanes.${ZONE}`, vrij: true });
    assert.deepEqual((await call("GET", `/v1/naam/vanes.${ZONE}`)).json, { naam: `vanes.${ZONE}`, vrij: true });
    let r = await call("GET", "/v1/naam/mail");
    assert.equal(r.status, 400); assert.match(r.json.error, /gereserveerd/);
    r = await call("GET", "/v1/naam/a_b");
    assert.equal(r.status, 400); assert.match(r.json.error, /3 tot 32/);
    assert.equal((await call("GET", "/v1/naam/vanes.nl")).status, 400);
  });

  await t.test("ondertekening: onbekend, zonder sleutel, fout, klok, opnieuw afspelen", async () => {
    const body = { label: "vanes", ref: "o1" };
    let r = await call("POST", "/v1/namen", { body });
    assert.equal(r.status, 401, "niet ondertekend"); assert.match(r.json.error, /niet ondertekend/);
    r = await call("POST", "/v1/namen", { key: keyA, dienst: X, body });
    assert.equal(r.status, 403); assert.match(r.json.error, /niet op de lijst/);
    r = await call("POST", "/v1/namen", { key: keyA, dienst: C, body });
    assert.equal(r.status, 403); assert.match(r.json.error, /geen \(geldige\) sleutel/);
    r = await call("POST", "/v1/namen", { key: keyB, dienst: A, body });
    assert.equal(r.status, 401, "met de sleutel van B namens A"); assert.match(r.json.error, /handtekening klopt niet/);
    r = await call("POST", "/v1/namen", { key: keyA, body, now: Date.now() - 6 * 60_000 });
    assert.equal(r.status, 401); assert.match(r.json.error, /klok/);
    r = await call("POST", "/v1/namen", { key: keyA, body, now: Date.now() + 6 * 60_000 });
    assert.equal(r.status, 401, "ook te ver vooruit");
    // Body aangepast na het ondertekenen
    const h = signHeaders(keyA, A, "POST", "/v1/namen", JSON.stringify(body));
    r = await call("POST", "/v1/namen", { body: { label: "kaper", ref: "o1" }, headers: h });
    assert.equal(r.status, 401);
    // Opnieuw afspelen: een ondertekende vraag werkt één keer.
    const g = signHeaders(keyA, A, "GET", "/v1/naam/vanes", "");
    assert.equal((await call("GET", "/v1/naam/vanes", { headers: g })).status, 200);
    r = await call("GET", "/v1/naam/vanes", { headers: g });
    assert.equal(r.status, 401); assert.match(r.json.error, /al eens gedaan/);
    assert.equal((svc.ctx.db.prepare("SELECT COUNT(*) AS n FROM namen").get() as { n: number }).n, 0, "niets aangemaakt");
  });

  let tokenA1 = "", tokenA2 = "", codeA = "", tokenB = "", codeB = "";

  await t.test("aanvragen: eigen zone, verwijzing, token alleen voor die zone", async () => {
    const r = await call("POST", "/v1/namen", { key: keyA, body: { label: "Vanes", ref: "o1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.naam, `vanes.${ZONE}`);
    assert.equal(r.json.zone, `vanes.${ZONE}`);
    assert.match(r.json.overdrachtscode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    tokenA1 = r.json.token; codeA = r.json.overdrachtscode;
    const child = up.st.desec.zones.get(`vanes.${ZONE}`)!;
    assert.equal(child.account, "centraal", "zone in het centrale account");
    const parent = up.st.desec.zones.get(ZONE)!;
    assert.deepEqual(parent.rrsets.get("vanes/NS")?.records, ["ns1.desec.io.", "ns2.desec.org."]);
    assert.deepEqual(parent.rrsets.get("vanes/DS")?.records, ["12345 13 2 abcdef"]);
    // Token: zonder beheerrechten, standaardregel eerst (alleen lezen), dan schrijven in de eigen zone.
    const tok = up.st.desec.tokens.get(tokenA1)!;
    assert.equal(tok.perm_manage_tokens, false);
    assert.equal(tok.perm_create_domain, false);
    assert.equal(tok.perm_delete_domain, false);
    assert.deepEqual(tok.policies.map(({ id: _, ...p }) => p), [
      { domain: null, subname: null, type: null, perm_write: false },
      { domain: `vanes.${ZONE}`, subname: null, type: null, perm_write: true },
    ]);
    const tokCall = up.calls.find((c) => c.method === "POST" && c.path === "/desec/auth/tokens/")!;
    assert.equal(tokCall.headers.authorization, "Token desec-centraal");
    assert.deepEqual(tokCall.body, { name: `adres vanes.${ZONE}`, perm_manage_tokens: false, perm_create_domain: false, perm_delete_domain: false });

    assert.equal(await desec(tokenA1, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "hallo")), 200, "eigen zone: schrijven mag");
    assert.equal(await desec(tokenA1, "PATCH", `/domains/vanes.${ZONE}/rrsets/`, rr("cloud", "x")), 200);
    assert.equal(await desec(tokenA1, "DELETE", `/domains/vanes.${ZONE}/rrsets/cloud/TXT/`), 204);
    assert.equal(await desec(tokenA1, "GET", `/domains/vanes.${ZONE}/`), 200, "lezen mag");
    assert.equal(await desec(tokenA1, "PUT", `/domains/${ZONE}/rrsets/`, [{ subname: "vanes", type: "NS", ttl: 3600, records: ["ns.kaper.test."] }]), 403, "gedeelde zone: niet schrijven");
    assert.equal(await desec(tokenA1, "PUT", `/domains/${ZONE}/rrsets/`, rr("ander", "x")), 403);
    assert.equal(await desec(tokenA1, "DELETE", `/domains/vanes.${ZONE}/`), 403, "zone niet weggooien");
    assert.equal(await desec(tokenA1, "POST", "/domains/", { name: `nog.${ZONE}` }), 403, "geen zones maken");
    assert.equal(await desec(tokenA1, "POST", "/auth/tokens/", { name: "meer" }), 403, "geen tokens maken");
    assert.equal(await desec(tokenA1, "GET", "/domains/anders.test/"), 404, "ander account: onzichtbaar");

    assert.deepEqual((await call("GET", "/v1/naam/vanes")).json, { naam: `vanes.${ZONE}`, vrij: false });
    // Een andere aanbieder, of A voor een andere bestelling: bezet.
    let x = await call("POST", "/v1/namen", { key: keyB, dienst: B, body: { label: "vanes" } });
    assert.equal(x.status, 409); assert.match(x.json.error, /al in gebruik/);
    x = await call("POST", "/v1/namen", { key: keyA, body: { label: "vanes", ref: "o2" } });
    assert.equal(x.status, 409);
    // Een tweede naam van B: tokens van A kunnen daar niet bij.
    x = await call("POST", "/v1/namen", { key: keyB, dienst: B, body: { label: "ander", ref: "b9" } });
    assert.equal(x.status, 200, x.text);
    assert.equal(await desec(tokenA1, "PUT", `/domains/ander.${ZONE}/rrsets/`, rr("", "x")), 403, "andermans adres: niet schrijven");
    assert.equal(await desec(x.json.token, "PUT", `/domains/ander.${ZONE}/rrsets/`, rr("", "x")), 200);
  });

  await t.test("zelfde aanvraag nog eens (zelfde Dienst en ref): nieuw token, oude ingetrokken", async () => {
    const r = await call("POST", "/v1/namen", { key: keyA, body: { label: "vanes", ref: "o1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.naam, `vanes.${ZONE}`);
    tokenA2 = r.json.token;
    assert.notEqual(tokenA2, tokenA1);
    assert.notEqual(r.json.overdrachtscode, codeA, "nieuwe code");
    codeA = r.json.overdrachtscode;
    assert.equal(await desec(tokenA1, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "oud")), 401, "oud token ingetrokken");
    assert.equal(await desec(tokenA2, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "nieuw")), 200);
    assert.equal(up.st.desec.zones.get(`vanes.${ZONE}`)!.rrsets.get("/TXT").records[0], '"nieuw"', "records blijven staan");
  });

  await t.test("overdragen met de code van de klant", async () => {
    const p = `/v1/namen/vanes.${ZONE}/overdragen`;
    let r = await call("POST", `/v1/namen/vanes.${ZONE}/controle`, { key: keyB, dienst: B, body: { overdrachtscode: codeA.toLowerCase() } });
    assert.deepEqual(r.json, { naam: `vanes.${ZONE}`, geldig: true }, "hoofdletters en streepjes maken niet uit");
    r = await call("POST", `/v1/namen/vanes.${ZONE}/controle`, { key: keyB, dienst: B, body: { overdrachtscode: "AAAA-BBBB-CCCC-DDDD-EEEE" } });
    assert.equal(r.json.geldig, false);
    r = await call("POST", p, { key: keyB, dienst: B, body: { overdrachtscode: "AAAA-BBBB-CCCC-DDDD-EEEE", ref: "b1" } });
    assert.equal(r.status, 403); assert.match(r.json.error, /klopt niet/);
    assert.equal((await call("POST", `/v1/namen/niets.${ZONE}/overdragen`, { key: keyB, dienst: B, body: { overdrachtscode: codeA } })).status, 404);

    r = await call("POST", p, { key: keyB, dienst: B, body: { overdrachtscode: codeA, ref: "b1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.naam, `vanes.${ZONE}`);
    tokenB = r.json.token; codeB = r.json.overdrachtscode;
    assert.notEqual(codeB, codeA, "code vernieuwd");
    assert.equal(await desec(tokenA2, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "A")), 401, "token van A ingetrokken");
    assert.equal(await desec(tokenB, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "B")), 200, "token van B werkt");
    // De oude code werkt niet meer (ook niet voor A zelf).
    r = await call("POST", p, { key: keyA, body: { overdrachtscode: codeA, ref: "o1" } });
    assert.equal(r.status, 403);
    // B nog eens met dezelfde ref (bijv. na een onderbroken poging): mag, ook zonder geldige code.
    r = await call("POST", p, { key: keyB, dienst: B, body: { overdrachtscode: codeA, ref: "b1" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(await desec(tokenB, "PUT", `/domains/vanes.${ZONE}/rrsets/`, rr("", "B")), 401);
    tokenB = r.json.token; codeB = r.json.overdrachtscode;
    const row = svc.ctx.db.prepare("SELECT dienst, ref, code_hash FROM namen WHERE label = 'vanes'").get() as { dienst: string; ref: string; code_hash: string };
    assert.equal(row.dienst, B);
    assert.equal(row.ref, "b1");
    assert.doesNotMatch(row.code_hash, new RegExp(codeB), "code alleen gehasht bewaard");
    assert.deepEqual(logs().filter((l) => l.naam === `vanes.${ZONE}`).map((l) => l.actie), ["aangemaakt", "opnieuw-uitgegeven", "overdracht-geweigerd", "overgedragen", "overdracht-geweigerd", "opnieuw-uitgegeven"]);
  });

  await t.test("vrijgeven: alleen de huidige aanbieder; daarna 30 dagen quarantaine", async () => {
    let r = await call("DELETE", `/v1/namen/vanes.${ZONE}`, { key: keyA });
    assert.equal(r.status, 403, "A is de naam kwijt"); assert.match(r.json.error, /andere aanbieder/);
    r = await call("DELETE", `/v1/namen/vanes.${ZONE}`, { key: keyB, dienst: B });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.naam, `vanes.${ZONE}`);
    assert.ok(!up.st.desec.zones.has(`vanes.${ZONE}`), "zone weg");
    const parent = up.st.desec.zones.get(ZONE)!;
    assert.ok(!parent.rrsets.has("vanes/NS") && !parent.rrsets.has("vanes/DS"), "verwijzing weg");
    assert.ok(!up.st.desec.tokens.has(tokenB), "token weg");
    assert.equal((await call("DELETE", `/v1/namen/vanes.${ZONE}`, { key: keyB, dienst: B })).status, 404);
    assert.equal((await call("GET", "/v1/naam/vanes")).json.vrij, false, "quarantaine");
    r = await call("POST", "/v1/namen", { key: keyA, body: { label: "vanes", ref: "o3" } });
    assert.equal(r.status, 409); assert.match(r.json.error, /net vrijgegeven/);
    // 31 dagen later
    svc.ctx.db.prepare("UPDATE namen SET released_at = ? WHERE label = 'vanes'").run(Date.now() - 31 * 86400_000);
    assert.equal((await call("GET", "/v1/naam/vanes")).json.vrij, true);
    r = await call("POST", "/v1/namen", { key: keyA, body: { label: "vanes", ref: "o3" } });
    assert.equal(r.status, 200, r.text);
    assert.ok(up.st.desec.zones.has(`vanes.${ZONE}`));
    assert.deepEqual(logs().at(-1), { actie: "aangemaakt", naam: `vanes.${ZONE}`, dienst: A });
  });

  await t.test("een zone die al bestaat zonder dat de dienst hem kent, wordt niet overgenomen", async () => {
    up.st.desec.zones.set(`los.${ZONE}`, { name: `los.${ZONE}`, account: "centraal", keys: [], rrsets: new Map() });
    const r = await call("POST", "/v1/namen", { key: keyA, body: { label: "los", ref: "o4" } });
    assert.equal(r.status, 409);
    assert.equal(svc.ctx.db.prepare("SELECT 1 FROM namen WHERE label = 'los'").get(), undefined);
  });
});
