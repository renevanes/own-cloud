// Nieuwe gebruiker zonder gedoe: met één Scaleway-sleutel zet de console opslag, servers en mail klaar,
// en je kunt in de assistent terug of helemaal opnieuw beginnen (met opruimen bij de aanbieder).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fakeS3 } from "./helpers/fake-s3.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "quick-"));
process.env.DATA_DIR = path.join(base, "data");
process.env.MAIL_DOMAINS = "vanes.nl";
process.env.MAIL_FROM = "rene@vanes.nl";
const AK = "SCWABCDEFGHJKMNPQRST", SK = "11111111-2222-3333-4444-555555555555", PROJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Nep-Scaleway: sleutelinfo, serverlijst en -prijzen, en het maildomein (TEM). */
function fakeScaleway() {
  const st = { tem: [] as any[], calls: [] as string[] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x"), p = u.pathname;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      st.calls.push(`${req.method} ${p}`);
      const send = (s: number, j: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (req.headers["x-auth-token"] !== SK) return send(401, { message: "authentication is denied" });
      let m: RegExpExecArray | null;
      if ((m = /^\/iam\/v1alpha1\/api-keys\/([^/]+)$/.exec(p))) return m[1] === AK ? send(200, { access_key: AK, default_project_id: PROJECT, user_id: "u-1" }) : send(404, { message: "not found" });
      if (/^\/instance\/v1\/zones\/[^/]+\/servers$/.test(p)) return send(200, { servers: [] });
      if (/^\/instance\/v1\/zones\/[^/]+\/products\/servers$/.test(p)) return send(200, { servers: {
        "DEV1-S": { ncpus: 2, ram: 2 * 1024 ** 3, arch: "x86_64", monthly_price: 6.42 },
        "STARDUST1-S": { ncpus: 1, ram: 1 * 1024 ** 3, arch: "x86_64", monthly_price: 0.5 },
      } });
      const tem = "/transactional-email/v1alpha1/regions/fr-par/domains";
      if (p === tem && req.method === "GET") return send(200, { domains: st.tem.filter((d) => d.project_id === u.searchParams.get("project_id") && d.name === u.searchParams.get("name")) });
      if (p === tem && req.method === "POST") {
        const d = { id: `tem-${st.tem.length + 1}`, name: body.domain_name, project_id: body.project_id, status: "pending",
          records: { dkim: { name: `${body.project_id}._domainkey.${body.domain_name}`, value: "v=DKIM1; h=sha256; k=rsa; p=MIIB" }, spf: { name: body.domain_name, value: "v=spf1 include:_spf.tem.scaleway.com -all" } } };
        st.tem.push(d);
        return send(200, d);
      }
      if ((m = new RegExp(`^${tem}/([^/]+)(/revoke)?$`).exec(p))) {
        const d = st.tem.find((x) => x.id === m![1]);
        if (!d) return send(404, {});
        if (m[2]) d.status = "revoked";
        return send(200, d);
      }
      send(599, { message: `onbekend: ${req.method} ${p}` });
    });
  });
  const listening = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  return { st, listening, close: () => new Promise<void>((r) => server.close(() => r())) };
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

test("één sleutel bij Scaleway: opslag, servers en mail klaar; terug en opnieuw beginnen", { timeout: 60_000 }, async (t) => {
  const s3 = fakeS3(), scw = fakeScaleway();
  process.env.EIGEN_TEST_S3 = `http://127.0.0.1:${await s3.listening}`;
  process.env.EIGEN_SCW_API = `http://127.0.0.1:${await scw.listening}`;
  process.env.EIGEN_VAULT = path.join(base, "kluis.json");
  delete process.env.EIGEN_DIENST_URL;
  const { buildConsole } = await import(`../src/console/server.js?quick=${Date.now()}`);
  const app = await buildConsole();
  const c = client(app);
  t.after(async () => { await app.close(); await s3.close(); await scw.close(); delete process.env.EIGEN_TEST_S3; delete process.env.EIGEN_SCW_API; });

  let r = await c("POST", "/api/setup/create", { domain: "vanes.nl", domainMode: "own", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" });
  assert.equal(r.status, 200, r.text);
  const st = (await c("GET", "/api/state")).json;
  assert.match(st.scaleway.signup, /^https:\/\/account\.scaleway\.com\//);
  assert.match(st.scaleway.keys, /^https:\/\/console\.scaleway\.com\/iam\/api-keys/);

  await t.test("sleutels controleren: vorm en echtheid", async () => {
    r = await c("POST", "/api/quick/scaleway", { accessKey: "abc", secretKey: SK });
    assert.match(r.json.error, /begint met SCW/);
    r = await c("POST", "/api/quick/scaleway", { accessKey: AK, secretKey: "nee" });
    assert.match(r.json.error, /8-4-4-4-12/);
    r = await c("POST", "/api/quick/scaleway", { accessKey: AK, secretKey: "99999999-2222-3333-4444-555555555555" });
    assert.match(r.json.error, /accepteert deze sleutel niet/);
    assert.equal(s3.buckets.size, 0, "niets aangemaakt met een verkeerde sleutel");
  });

  await t.test("alles klaarzetten met één sleutel (geplakt met spaties en kleine letters)", async () => {
    r = await c("POST", "/api/quick/scaleway", { accessKey: ` ${AK.toLowerCase()} `, secretKey: ` "${SK.toUpperCase()}" ` });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.steps.every((x: any) => x.ok), JSON.stringify(r.json.steps));
    assert.equal(r.json.monthly, 6.42 + 6.42 + 0.5);
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.quick, "scaleway");
    assert.equal(conf.providers.scaleway.projectId, PROJECT);
    assert.deepEqual(conf.stores.map((s: any) => `${s.name}/${s.purpose}`).sort(), ["scaleway-fr-par-backup/backup", "scaleway-nl-ams/replica"]);
    assert.equal(s3.buckets.size, 2);
    assert.ok([...s3.buckets.values()].some((b) => b.lock && b.retentionDays === 30), "back-up onveranderbaar");
    assert.deepEqual(conf.policy.placement.slice(0, 3).map((p: any) => `${p.kind}/${p.region}`), ["data/nl-ams-1", "data/nl-ams-2", "witness/nl-ams-3"]);
    assert.equal(conf.mailRelay.host, "smtp.tem.scaleway.com");
    assert.equal(conf.mailRelay.user, PROJECT);
    assert.equal(conf.spfExtra, "include:_spf.tem.scaleway.com");
    assert.equal(scw.st.tem.length, 1);

    // Nog een keer (bijv. na Vorige stap): dezelfde buckets en hetzelfde maildomein, niets dubbel.
    r = await c("POST", "/api/quick/scaleway", { accessKey: AK, secretKey: SK });
    assert.equal(r.status, 200, r.text);
    assert.equal(s3.buckets.size, 2, "geen nieuwe buckets");
    assert.equal(scw.st.tem.length, 1, "geen tweede maildomein");
  });

  await t.test("de DKIM-sleutel van Scaleway gaat mee naar het cluster en komt in de DNS", async () => {
    const { Vault } = await import("../src/console/vault.js");
    const v = new Vault(process.env.EIGEN_VAULT!);
    v.unlock("vier losse woorden hier");
    assert.deepEqual(v.config!.console.extraDns, [{ sub: `${PROJECT}._domainkey`, type: "TXT", value: "v=DKIM1; h=sha256; k=rsa; p=MIIB" }]);
    const db = await import("../src/db.js");
    const health = await import("../src/health.js");
    db.setSetting("extra_dns", JSON.stringify(v.config!.console.extraDns));
    const recs = health.expectedRecords({ ips4: ["192.0.2.1"], ips6: [] });
    assert.ok(recs.some((x) => x.sub === `${PROJECT}._domainkey` && x.type === "TXT" && x.values[0].includes("DKIM1")), JSON.stringify(recs.map((x) => x.sub)));
  });

  await t.test("ander domein: mail wordt opnieuw aangemeld", async () => {
    r = await c("POST", "/api/setup/domain", { domain: "vanes.eu", domainMode: "own" });
    assert.equal(r.status, 200, r.text);
    assert.equal(scw.st.tem.at(-1).name, "vanes.eu");
    assert.equal(scw.st.tem[0].status, "revoked", "het oude maildomein is ingetrokken");
  });

  await t.test("zelf per onderdeel: één-sleutel-markering eraf, gekoppelde dingen blijven", async () => {
    assert.equal((await c("POST", "/api/quick/off")).status, 200);
    const conf = (await c("GET", "/api/config")).json;
    assert.equal(conf.quick, null);
    assert.equal(conf.stores.length, 2);
  });

  await t.test("opnieuw beginnen met opruimen: buckets (ook de onveranderbare) en maildomein weg", async () => {
    r = await c("POST", "/api/setup/reset", { cleanup: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.left, []);
    assert.equal(s3.buckets.size, 0);
    assert.ok(scw.st.tem.every((d) => d.status === "revoked"));
    assert.equal(fs.existsSync(process.env.EIGEN_VAULT!), false);
    const s = (await c("GET", "/api/state")).json;
    assert.equal(s.vault, false);
    assert.equal((await c("GET", "/api/config")).status, 401, "sessie is weg");
  });

  await t.test("na de start kan opnieuw beginnen niet meer", async () => {
    r = await c("POST", "/api/setup/create", { domain: "vanes.nl", domainMode: "own", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", passphrase: "vier losse woorden hier" });
    assert.equal(r.status, 200, r.text);
    const { Vault } = await import("../src/console/vault.js");
    const v = new Vault(process.env.EIGEN_VAULT!);
    v.unlock("vier losse woorden hier");
    v.config!.console.firstLaunch = { at: Date.now(), nodeId: "n1", provider: "scaleway", region: "nl-ams-1" };
    v.save();
    // De console heeft zijn eigen (oude) kopie in het geheugen: opnieuw ontgrendelen.
    await c("POST", "/api/lock");
    assert.equal((await c("POST", "/api/unlock", { passphrase: "vier losse woorden hier" })).status, 200);
    r = await c("POST", "/api/setup/reset", { cleanup: false });
    assert.equal(r.status, 409);
    assert.ok(fs.existsSync(process.env.EIGEN_VAULT!));
  });

  await t.test("wachtwoordzin vergeten: kluis wissen zonder te ontgrendelen", async () => {
    await c("POST", "/api/lock");
    assert.equal((await c("POST", "/api/vault/forget", {})).status, 400);
    assert.ok(fs.existsSync(process.env.EIGEN_VAULT!), "niet zonder bevestiging");
    assert.equal((await c("POST", "/api/vault/forget", { confirm: true })).status, 200);
    assert.equal(fs.existsSync(process.env.EIGEN_VAULT!), false);
    assert.equal((await c("GET", "/api/state")).json.vault, false);
  });
});
