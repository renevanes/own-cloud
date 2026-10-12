/**
 * Voorwaarden, privacyverklaring en verwerkersovereenkomst van de aanbieder (src/broker/juridisch.ts):
 * - voorbeeldteksten uit de gegevens van de Dienst (bedrijf, bundels, subverwerkers uit de instellingen);
 * - publiceren in het beheer, openbare pagina's (/voorwaarden, …, ook eerdere versies), GET /v1/juridisch;
 * - termsUrl/privacyUrl in /v1/info vullen zich met de eigen pagina's, eigen links gaan voor;
 * - bewerken (nieuwe versie, ongewijzigd = geen versie), bericht aan klanten, rechten, logboek;
 * - de tabel gaat mee in de back-up van de Dienst; de regel voor de lijst via /v1/status/lijst (beheertoken).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { ensureOwner, addStaff } from "../src/broker/staff.js";
import { sha256 } from "../src/broker/db.js";
import { renderBody, subverwerkers, voorbeeld } from "../src/broker/juridisch.js";
import { makeBackup, backupKey, beheerToken } from "../src/broker/backup.js";
import { decryptBuffer } from "../src/cluster/crypto.js";
import { freePort } from "./helpers/cluster.js";

test("opmaak van de teksten: koppen, lijsten, links, vet, [vul in] en geen HTML", () => {
  const html = renderBody("# Titel\n\n## 1. Kop\nRegel een\nregel twee met **vet** en https://x.nl/a.\n\n- punt [tekst](https://y.nl)\n- mail a@b.nl\n  vervolg\n1. eerst\n2. dan\n\n<script>alert(1)</script> [vul in: KvK]");
  assert.equal(html, [
    "<h1>Titel</h1>", "<h2>1. Kop</h2>",
    `<p>Regel een<br>regel twee met <strong>vet</strong> en <a href="https://x.nl/a">https://x.nl/a</a>.</p>`,
    `<ul><li>punt <a href="https://y.nl">tekst</a></li><li>mail <a href="mailto:a@b.nl">a@b.nl</a> vervolg</li></ul>`,
    "<ol><li>eerst</li><li>dan</li></ol>",
    "<p>&lt;script&gt;alert(1)&lt;/script&gt; <mark>[vul in: KvK]</mark></p>",
  ].join("\n"));
});

test("voorwaarden en privacy van de Dienst: maken, publiceren, links, bericht en back-up", { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "juridisch-"));
  const port = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`;
  const SECRET = "22".repeat(32);
  const list = path.join(dir, "aanbieders.json");
  fs.writeFileSync(list, JSON.stringify([{ naam: "Ander", url: "https://ander.example" }]));
  const cfg = loadConfig({
    BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC, BROKER_SECRET: SECRET, BROKER_LOOP_MS: "600000",
    BROKER_LIST_URL: "uit", BROKER_COMPANY_NAME: "Van Es Diensten B.V.", BROKER_COMPANY_ADDRESS: "Blaak 10\\n3011 TA Rotterdam",
    BROKER_COMPANY_KVK: "12345678", BROKER_COMPANY_VAT: "NL001234567B01", BROKER_ADMIN_EMAIL: "meldingen@vanes.test",
    MOLLIE_API_KEY: "test_x", DESEC_TOKEN: "desec-x", OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "p",
    BROKER_SMTP_URL: "smtp://u:p@smtp.tem.scaleway.com:587", BROKER_HOSTING: "hetzner fsn1",
    BROKER_BACKUP_ENDPOINT: "https://s3.fr-par.scw.cloud", BROKER_BACKUP_BUCKET: "b", BROKER_BACKUP_ACCESS_KEY: "a", BROKER_BACKUP_SECRET_KEY: "s",
  });
  const broker = await createBroker(cfg);
  await broker.app.listen({ port, host: "127.0.0.1" });
  t.after(async () => { broker.backup?.stop(); await broker.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const ctx = broker.ctx, db = ctx.db;
  // Gratis adressen via de centrale adressendienst (alleen voor de teksten; hier niet echt bereikbaar).
  ctx.cfg.adresUrl = "https://adressen.esape.example";
  process.env.EIGEN_AANBIEDERS_URL = list;
  t.after(() => { delete process.env.EIGEN_AANBIEDERS_URL; });

  // Medewerkers met een sessie zoals na inloggen (code + tweede stap), rechtstreeks in de database.
  const session = (email: string) => {
    const s = db.prepare("SELECT id FROM staff WHERE email = ?").get(email) as { id: string };
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO staff_sessions (token_hash, staff_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(sha256(token), s.id, Date.now(), Date.now());
    return token;
  };
  ensureOwner(ctx, "eigenaar@vanes.test", "test");
  addStaff(ctx, null, "support@vanes.test", "support");
  const owner = session("eigenaar@vanes.test"), support = session("support@vanes.test");
  const api = async (method: string, p: string, body?: unknown, auth = owner, raw = false) => {
    const r = await fetch(PUBLIC + p, { method, headers: { ...(auth ? { authorization: auth.startsWith("Beheer ") ? auth : `Staff ${auth}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; if (!raw) { try { json = JSON.parse(text); } catch { /* */ } }
    return { status: r.status, json, text, headers: r.headers };
  };
  await api("PUT", "/v1/admin/brand", { contact: { email: "hallo@vanes.test", phone: "+31 10 1234567" } });

  await t.test("voorbeeldteksten met de gegevens en de echte subverwerkers van deze Dienst", async () => {
    const subs = subverwerkers(ctx).map((s) => s.naam);
    assert.deepEqual(subs, ["Scaleway SAS (Frankrijk)", "Hetzner Online GmbH (Duitsland)", "Mollie B.V. (Nederland)", "deSEC e.V. (Duitsland, non-profit)", "Openprovider (Nederland)", "de gratis-adressendienst van het Eigen Cloud-project (adressen.esape.example)"]);
    const scw = subverwerkers(ctx)[0];
    assert.deepEqual(scw.doel, [
      "de servers, de opslag en het versturen van mail van je cloud, in een eigen project per klant (in Nederland, Frankrijk en Polen)",
      "versleutelde back-ups van de database van onze dienst (Parijs, Frankrijk)", "het versturen van inlogcodes, facturen en meldingen per mail",
    ]);
    assert.deepEqual(subverwerkers(ctx)[1].doel, ["de server van onze dienst (Falkenstein, Duitsland)"]);

    const r = await api("GET", "/v1/admin/juridisch/voorwaarden/voorbeeld");
    assert.equal(r.status, 200, r.text);
    const av: string = r.json.body;
    for (const want of ["# Algemene voorwaarden van Van Es Diensten B.V.", "Blaak 10\n3011 TA Rotterdam", "KvK-nummer: 12345678", "Btw-nummer: NL001234567B01", "E-mail: hallo@vanes.test", "Telefoon: +31 10 1234567",
      "- **Compleet**: € 24,95 per maand.", "2 gebruikers inbegrepen, extra gebruiker € 2,50 per maand", "- **Ruim**: € 39,95 per maand.", "inclusief 21% btw",
      "elke maand opzegbaar", "nog 30 dagen", "terugdraaien", "verhuiscode", "overdrachtscode", "14 dagen", `${PUBLIC}/privacy`, `${PUBLIC}/verwerkersovereenkomst`])
      assert.ok(av.includes(want), `voorwaarden bevatten ${want}`);
    assert.ok(!av.includes("[vul in"), "alles is ingevuld");
    const pv: string = (await api("GET", "/v1/admin/juridisch/privacy/voorbeeld")).json.body;
    for (const want of ["# Privacyverklaring van Van Es Diensten B.V.", "- **Hetzner Online GmbH (Duitsland)**: de server van onze dienst (Falkenstein, Duitsland).", "- **Mollie B.V. (Nederland)**",
      "- **deSEC e.V. (Duitsland, non-profit)**: de DNS van je domein, met DNSSEC.", "Openprovider", "adressen.esape.example", "Nooit de inhoud", "Autoriteit Persoonsgegevens", "7 jaar", "15 minuten", "90 dagen"])
      assert.ok(pv.includes(want), `privacy bevat ${want}`);
    const vo: string = (await api("GET", "/v1/admin/juridisch/verwerkersovereenkomst/voorbeeld")).json.body;
    for (const want of ["# Verwerkersovereenkomst", "Van Es Diensten B.V.", "- **Compleet**: servers in Amsterdam (2×) en Parijs; je gegevens in Amsterdam, de back-up in Parijs.", "48 uur", "Scaleway SAS (Frankrijk)"])
      assert.ok(vo.includes(want), `verwerkersovereenkomst bevat ${want}`);
    assert.ok(!vo.includes("Mollie"), "Mollie verwerkt niets uit de cloud zelf");
    // Zonder BROKER_HOSTING en bedrijfsgegevens: duidelijke plekken om in te vullen.
    const was = { hosting: ctx.cfg.hosting, company: ctx.cfg.company };
    ctx.cfg.hosting = null; ctx.cfg.company = { name: null, address: [], kvk: null, vat: null };
    const leeg = voorbeeld(ctx, "privacy");
    Object.assign(ctx.cfg, was);
    for (const want of ["[vul in: partij waar de server van de dienst staat]", "[vul in: adres]", "[vul in: KvK-nummer]", "Privacyverklaring van Eigen Cloud Dienst"]) assert.ok(leeg.includes(want), want);
  });

  await t.test("publiceren: pagina's, versies, links in /v1/info en eigen links gaan voor", async () => {
    let info = await api("GET", "/v1/info", undefined, "");
    assert.deepEqual([info.json.termsUrl, info.json.privacyUrl, info.json.brand.termsUrl], [null, null, null], "nog niets gepubliceerd");
    assert.equal((await api("GET", "/voorwaarden", undefined, "", true)).status, 404);
    assert.deepEqual((await api("GET", "/v1/juridisch", undefined, "")).json, { documents: [] });

    const body = (await api("GET", "/v1/admin/juridisch/voorwaarden/voorbeeld")).json.body as string;
    const preview = await api("POST", "/v1/admin/juridisch/voorwaarden/weergave", { body }, owner, true);
    assert.equal(preview.status, 200);
    assert.match(preview.text, /Voorbeeld — nog niet gepubliceerd/);
    assert.equal((await api("PUT", "/v1/admin/juridisch/voorwaarden", { body: "kort" })).status, 400);
    assert.equal((await api("PUT", "/v1/admin/juridisch/onzin", { body })).status, 404);
    assert.equal((await api("PUT", "/v1/admin/juridisch/voorwaarden", { body }, support)).status, 403, "support mag de voorwaarden niet wijzigen");

    let r = await api("PUT", "/v1/admin/juridisch/voorwaarden", { body: `${body}\n<script>alert(1)</script>`, announce: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.changed, r.json.document.version, r.json.document.published, r.json.announcement], [true, 1, true, null], "eerste versie: geen bericht");
    info = await api("GET", "/v1/info", undefined, "");
    assert.deepEqual([info.json.termsUrl, info.json.privacyUrl, info.json.brand.termsUrl], [`${PUBLIC}/voorwaarden`, null, `${PUBLIC}/voorwaarden`]);
    const page = await api("GET", "/voorwaarden", undefined, "", true);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.match(page.text, /<h1>Algemene voorwaarden van Van Es Diensten B\.V\.<\/h1>\n<p class="meta">Versie 1 · laatst gewijzigd op \d+ [a-z]+ 20\d\d<\/p>/);
    assert.ok(page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !page.text.includes("<script>alert"), "geen HTML uit de tekst");
    assert.ok(!page.text.includes("juridisch advies"), "de opmerking over juridisch advies staat alleen in het beheer");

    for (const k of ["privacy", "verwerkersovereenkomst"]) {
      const b = (await api("GET", `/v1/admin/juridisch/${k}/voorbeeld`)).json.body;
      assert.equal((await api("PUT", `/v1/admin/juridisch/${k}`, { body: b })).status, 200);
    }
    info = await api("GET", "/v1/info", undefined, "");
    assert.deepEqual([info.json.termsUrl, info.json.privacyUrl], [`${PUBLIC}/voorwaarden`, `${PUBLIC}/privacy`]);
    assert.deepEqual((await api("GET", "/v1/juridisch", undefined, "")).json.documents.map((d: any) => [d.kind, d.version, d.url]),
      [["voorwaarden", 1, `${PUBLIC}/voorwaarden`], ["privacy", 1, `${PUBLIC}/privacy`], ["verwerkersovereenkomst", 1, `${PUBLIC}/verwerkersovereenkomst`]]);
    const pp = await api("GET", "/privacy", undefined, "", true);
    assert.ok(pp.text.includes(`<a href="/voorwaarden">Algemene voorwaarden</a><a href="/verwerkersovereenkomst">Verwerkersovereenkomst</a>`), "links naar de andere documenten");

    // Huisstijl toont alleen eigen links in de velden (anders zou opslaan de eigen pagina als "eigen link" bewaren).
    const br = await api("GET", "/v1/admin/brand");
    assert.deepEqual([br.json.own, br.json.brand.termsUrl, br.json.defaults.termsUrl], [{ termsUrl: null, privacyUrl: null }, `${PUBLIC}/voorwaarden`, `${PUBLIC}/voorwaarden`]);
    // Eigen links (Huisstijl) gaan voor; leegmaken = weer de eigen pagina.
    await api("PUT", "/v1/admin/brand", { termsUrl: "https://elders.example/av" });
    assert.deepEqual((await api("GET", "/v1/admin/brand")).json.own, { termsUrl: "https://elders.example/av", privacyUrl: null });
    info = await api("GET", "/v1/info", undefined, "");
    assert.deepEqual([info.json.termsUrl, info.json.privacyUrl], ["https://elders.example/av", `${PUBLIC}/privacy`]);
    let adm = await api("GET", "/v1/admin/juridisch");
    assert.deepEqual(adm.json.own, { termsUrl: true, privacyUrl: false });
    await api("PUT", "/v1/admin/brand", { termsUrl: "" });
    assert.equal((await api("GET", "/v1/info", undefined, "")).json.termsUrl, `${PUBLIC}/voorwaarden`);
    // Een link uit de omgeving (BROKER_TERMS_URL) gaat ook voor.
    ctx.cfg.termsUrl = "https://env.example/av";
    assert.equal((await api("GET", "/v1/brand", undefined, "")).json.termsUrl, "https://env.example/av");
    ctx.cfg.termsUrl = null;
    adm = await api("GET", "/v1/admin/juridisch");
    assert.deepEqual([adm.json.own, adm.json.termsUrl, adm.json.documents.map((d: any) => d.version)], [{ termsUrl: false, privacyUrl: false }, `${PUBLIC}/voorwaarden`, [1, 1, 1]]);
    assert.equal(adm.json.documents[0].updatedBy, "eigenaar@vanes.test");
  });

  await t.test("bewerken: nieuwe versie, ongewijzigd blijft gelijk, eerdere versies, bericht aan klanten", async () => {
    const cur = (await api("GET", "/v1/admin/juridisch")).json.documents[0];
    let r = await api("PUT", "/v1/admin/juridisch/voorwaarden", { body: cur.body, announce: true });
    assert.deepEqual([r.json.changed, r.json.document.version, r.json.announcement], [false, 1, null], "zelfde tekst: geen nieuwe versie en geen bericht");
    const nieuw = cur.body.replace("Je krijgt binnen 14 dagen antwoord.", "Je krijgt binnen 7 dagen antwoord.");
    r = await api("PUT", "/v1/admin/juridisch/voorwaarden", { body: nieuw, announce: true, summary: "Je krijgt nu binnen 7 dagen antwoord op een klacht" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.changed, r.json.document.version, r.json.document.history.map((h: any) => h.version)], [true, 2, [2, 1]]);
    assert.equal(r.json.announcement.title, "Algemene voorwaarden gewijzigd");
    assert.match(r.json.announcement.body, new RegExp(`^We hebben onze algemene voorwaarden bijgewerkt \\(versie 2, \\d+ [a-z]+ 20\\d\\d\\)\\. Je krijgt nu binnen 7 dagen antwoord op een klacht\\. Je leest de nieuwe tekst op ${PUBLIC.replace(/\./g, "\\.")}/voorwaarden\\.`));
    assert.ok(r.json.announcement.endsAt - Date.now() > 29 * 86400_000, "30 dagen zichtbaar");
    // Een klant ziet het bericht in de app.
    db.prepare("INSERT INTO customers (id, email, created_at) VALUES ('c1', 'klant@x.test', ?)").run(Date.now());
    const ct = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, customer_id, expires_at, created_at) VALUES (?, 'c1', ?, ?)").run(sha256(ct), Date.now() + 3600_000, Date.now());
    const ann = (await (await fetch(`${PUBLIC}/v1/announcements`, { headers: { authorization: `Bearer ${ct}` } })).json() as any).announcements as any[];
    assert.deepEqual(ann.map((a) => [a.title, a.severity]), [["Algemene voorwaarden gewijzigd", "info"]]);
    // Pagina's: de nieuwste, en de vorige met een verwijzing naar de huidige.
    const page = await api("GET", "/voorwaarden", undefined, "", true);
    assert.ok(page.text.includes("binnen 7 dagen") && page.text.includes("Versie 2") && page.text.includes(`<a href="/voorwaarden?versie=1">versie 1`));
    const old = await api("GET", "/voorwaarden?versie=1", undefined, "", true);
    assert.ok(old.text.includes("Dit is een eerdere versie.") && old.text.includes("binnen 14 dagen") && old.text.includes("Versie 1"));
    assert.equal((await api("GET", "/voorwaarden?versie=9", undefined, "", true)).status, 404);
    // Logboek.
    const log = db.prepare("SELECT action, target, detail FROM audit WHERE action = 'juridisch-change' ORDER BY id").all() as { target: string; detail: string }[];
    assert.deepEqual(log.map((x) => [x.target, JSON.parse(x.detail)]), [
      ["voorwaarden", { version: 1, announced: false }], ["privacy", { version: 1, announced: false }], ["verwerkersovereenkomst", { version: 1, announced: false }], ["voorwaarden", { version: 2, announced: true }],
    ]);
  });

  await t.test("de documenten gaan mee in de back-up van de Dienst (zelfde database)", async () => {
    const saved = new Map<string, Buffer>();
    const store = { put: async (k: string, b: Buffer) => { saved.set(k, b); } };
    const { name } = await makeBackup(db, dir, store as never, backupKey(Buffer.from(SECRET, "hex")));
    const packed = JSON.parse(zlib.gunzipSync(await decryptBuffer(backupKey(Buffer.from(SECRET, "hex")), saved.get(name)!)).toString("utf8"));
    const f = path.join(dir, "terug.sqlite");
    fs.writeFileSync(f, Buffer.from(packed.files["dienst.sqlite"], "base64"));
    const copy = new Database(f, { readonly: true });
    const rows = copy.prepare("SELECT kind, version FROM legal_docs ORDER BY kind, version").all();
    copy.close();
    assert.deepEqual(rows, [{ kind: "privacy", version: 1 }, { kind: "verwerkersovereenkomst", version: 1 }, { kind: "voorwaarden", version: 1 }, { kind: "voorwaarden", version: 2 }]);
  });

  await t.test("de regel voor de lijst via /v1/status/lijst (beheertoken), met de links naar voorwaarden en privacy", async () => {
    assert.equal((await api("GET", "/v1/status/lijst", undefined, "")).status, 401);
    assert.equal((await api("GET", "/v1/status/lijst", undefined, `Beheer ${"0".repeat(64)}`)).status, 401);
    const r = await api("GET", "/v1/status/lijst", undefined, `Beheer ${beheerToken(Buffer.from(SECRET, "hex"))}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.entry, { naam: "Eigen Cloud Dienst", url: PUBLIC, land: "NL", contact: "hallo@vanes.test", omschrijving: "", sleutel: cfg.providerPublicKey });
    assert.deepEqual([r.json.opLijst, r.json.voorwaarden], [false, { termsUrl: `${PUBLIC}/voorwaarden`, privacyUrl: `${PUBLIC}/privacy` }]);
    assert.deepEqual((await api("GET", "/v1/admin/lijst")).json, r.json, "zelfde als in het beheer");
  });
});
