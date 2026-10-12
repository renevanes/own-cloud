/**
 * "Op de lijst" via GitHub vanuit de app (src/console/github.ts), tegen een nep-GitHub en twee echte Diensten
 * (test/helpers/lijst-scenario.ts): GitHub koppelen (tokens en meldingen), aanmelden met een fork, een open voorstel
 * bijwerken, samengevoegd/gesloten, later de regel bijwerken, de beheerders (branch in de repository zelf en zelf
 * samenvoegen), een ingetrokken token en ontkoppelen. De Java-kern doet hetzelfde scenario (GitHubTest).
 * Plus: zonelimiet bij deSEC (src/console/zonelimiet.ts) en de status van voorwaarden en privacy (voorwaarden.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminConfig } from "../src/console/vault.js";
import * as github from "../src/console/github.js";
import { aanbiederNet } from "../src/console/aanbieder.js";
import { zonelimiet, nextLink } from "../src/console/zonelimiet.js";
import * as voorwaarden from "../src/console/voorwaarden.js";
import { startLijstScenario, TOKENS } from "./helpers/lijst-scenario.js";
import { REPO } from "./helpers/fake-github.js";
import { fakeDesecLimiet } from "./helpers/fake-desec-limiet.js";

const initial = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../aanbieders.json"), "utf8");
const err = async (p: Promise<unknown> | (() => unknown)) => { try { await (typeof p === "function" ? p() : p); return ""; } catch (e) { return (e as Error).message; } };
const server = { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", serverId: "s1", createdAt: 1 };

test("lijst samenvoegen: regel vervangen of erbij, beheerdersvelden, opmaak zoals het bestand", () => {
  const list = JSON.parse(initial);
  const entry = { naam: "Ünïcode € B.V.", url: "https://Dienst.Elders.example/", land: "DE", contact: "", omschrijving: "a \"b\"", sleutel: "MCow", standaard: true };
  const add = github.mergeLijst(list, entry);
  assert.equal(add.nieuw, true);
  assert.equal(add.tekst, `${JSON.stringify([...list, { naam: "Ünïcode € B.V.", url: "https://Dienst.Elders.example/", land: "DE", contact: "", omschrijving: "a \"b\"", sleutel: "MCow" }], null, 2)}\n`, "standaard zet alleen een beheerder");
  assert.ok(add.tekst.startsWith(initial.slice(0, initial.lastIndexOf("}") + 1)), "de bestaande regels blijven precies zoals ze waren");
  const upd = github.mergeLijst(JSON.parse(add.tekst), { naam: "Nieuw", url: "https://dienst.elders.example", land: "NL", contact: "x@y.z", omschrijving: "", sleutel: "S2" });
  assert.equal(upd.nieuw, false);
  assert.deepEqual(JSON.parse(upd.tekst).map((x: any) => x.naam), ["ESAPE", "Nieuw"]);
  // Bestaande regel van de standaardaanbieder: standaard en adressen blijven, extra velden van de beheerders ook.
  assert.deepEqual(github.mergeRegel({ naam: "Oud", url: "u", standaard: true, adressen: "https://a.example", opmerking: "x", land: "NL" }, { naam: "ESAPE", url: "u", land: "BE", sleutel: "k" }),
    { naam: "ESAPE", url: "u", land: "BE", sleutel: "k", opmerking: "x", standaard: true, adressen: "https://a.example" });
  assert.deepEqual(github.mergeRegel(null, { naam: "A", url: "u", adressen: "https://b.example", standaard: true }), { naam: "A", url: "u", adressen: "https://b.example" });
  assert.deepEqual([github.branchFor("https://dienst.esape.nl"), github.branchFor("https://Dienst.Vanes.test:8443/x")], ["aanbieder-dienst-esape-nl", "aanbieder-dienst-vanes-test-8443"]);
  assert.equal(github.TOKEN_URL, "https://github.com/settings/tokens/new?scopes=public_repo&description=Eigen%20Cloud");
});

test("op de lijst via GitHub: koppelen, fork, voorstel, bijwerken, samenvoegen", { timeout: 60_000 }, async (t) => {
  const s = await startLijstScenario();
  const reach0 = aanbiederNet.reach;
  process.env.EIGEN_GITHUB_API = s.gh.base;
  github.githubNet.pollMs = 5;
  aanbiederNet.reach = (url) => (url === s.vanes.url ? s.vanes.reach : url === s.esape.url ? s.esape.reach : url);
  t.after(async () => { aanbiederNet.reach = reach0; delete process.env.EIGEN_GITHUB_API; delete process.env.EIGEN_AANBIEDERS_URL; await s.close(); });
  const cfgFor = (d: { url: string; secret: string }) => ({ console: { aanbieder: { step: "klaar", url: d.url, secret: d.secret, server } } }) as unknown as AdminConfig;
  let saves = 0;
  const deps = { save: () => { saves++; } };
  const c = cfgFor(s.vanes);
  const gstate = () => (c.console as any).github;

  await t.test("GitHub koppelen: alleen een klassiek token met public_repo", async () => {
    assert.equal(await err(github.koppelen(c, { token: " " })), "Plak het token dat je op GitHub hebt gemaakt");
    assert.equal(await err(github.koppelen(c, { token: TOKENS.fijn })), "Dit is een fijnmazig token. Maak met de link in de app een klassiek token (met public_repo): alleen daarmee kan de app een fork en een voorstel maken.");
    assert.equal(await err(github.koppelen(c, { token: "geen token!" })), "Dit lijkt geen GitHub-token. Kopieer het token helemaal (het begint meestal met ghp_).");
    assert.equal(await err(github.koppelen(c, { token: TOKENS.onbekend })), "GitHub accepteert dit token niet. Kopieer het opnieuw, of maak een nieuw token.");
    assert.equal(await err(github.koppelen(c, { token: TOKENS.zonder })), "Dit token mist het recht public_repo. Maak met de link in de app een nieuw token: dan staat dat vinkje al aan.");
    assert.equal(await err(github.koppelen(c, { token: TOKENS.oauthloos })), "Dit is geen klassiek token. Maak met de link in de app een klassiek token (met public_repo).");
    assert.equal(gstate()?.token, undefined, "niets bewaard bij een fout");
    assert.deepEqual(await github.koppelen(c, { token: ` ${TOKENS.ander} ` }), { ok: true, login: "vanes-diensten", beheerder: false });
    assert.equal(gstate().token, TOKENS.ander);
  });

  await t.test("vóór het aanmelden: de regel van de Dienst, nog niet op de lijst", async () => {
    const v = await github.view(c, deps);
    assert.deepEqual(v.github, { gekoppeld: true, login: "vanes-diensten", beheerder: false });
    assert.deepEqual(v.regel, { naam: "Van Es", url: "https://dienst.vanes.test", land: "NL", contact: "hallo@vanes.test", omschrijving: "", sleutel: s.vanes.publicKey });
    assert.deepEqual([v.opLijst, v.sleutelKlopt, v.actueel, v.voorstel, v.dienstFout, v.lijstFout, v.voorwaarden], [false, false, false, null, null, null, { termsUrl: null, privacyUrl: null }]);
    assert.deepEqual([v.tokenUrl, v.repo, v.editUrl], [github.TOKEN_URL, REPO, "https://github.com/renevanes/own-cloud/edit/main/aanbieders.json"]);
    assert.ok(!JSON.stringify(v).includes(TOKENS.ander), "nooit het token in een antwoord");
  });

  await t.test("aanmelden: fork, branch, aanbieders.json bijgewerkt en een voorstel", async () => {
    assert.equal(await err(github.aanmelden(c, { land: "België", omschrijving: "x" })), "Land als landcode van twee letters, bijvoorbeeld NL");
    assert.equal(await err(github.aanmelden(c, { land: "NL", omschrijving: "x".repeat(141) })), "Houd de omschrijving kort: hooguit 140 tekens");
    s.gh.calls.length = 0;
    const r = await github.aanmelden(c, { land: "nl", omschrijving: "  Eigen Cloud   vanuit Rotterdam " });
    assert.deepEqual({ ...r, voorstel: { ...r.voorstel, at: 0 } }, {
      ok: true, gewijzigd: true, bericht: "Je voorstel staat op GitHub. De beheerders van het project kijken ernaar.",
      voorstel: { nummer: 1, url: "https://github.com/renevanes/own-cloud/pull/1", titel: "Aanbieder toevoegen: Van Es", status: "open", at: 0, samengevoegdOp: null },
    });
    const flow = s.gh.calls.filter((x) => !x.startsWith("GET /repos/vanes-diensten/own-cloud/git/ref/heads/main"));
    assert.deepEqual(flow, [
      "GET /repos/renevanes/own-cloud", "GET /repos/renevanes/own-cloud/git/ref/heads/main", "GET /repos/renevanes/own-cloud/contents/aanbieders.json?ref=main",
      "POST /repos/renevanes/own-cloud/forks", "POST /repos/vanes-diensten/own-cloud/merge-upstream",
      "GET /repos/vanes-diensten/own-cloud/git/ref/heads/aanbieder-dienst-vanes-test", "POST /repos/vanes-diensten/own-cloud/git/refs",
      "GET /repos/vanes-diensten/own-cloud/contents/aanbieders.json?ref=aanbieder-dienst-vanes-test", "PUT /repos/vanes-diensten/own-cloud/contents/aanbieders.json",
      "commit vanes-diensten/own-cloud:aanbieder-dienst-vanes-test aanbieders.json: Van Es toevoegen",
      "GET /repos/renevanes/own-cloud/pulls?state=open&head=vanes-diensten%3Aaanbieder-dienst-vanes-test", "POST /repos/renevanes/own-cloud/pulls",
    ]);
    assert.equal(s.gh.calls.filter((x) => x === "GET /repos/vanes-diensten/own-cloud/git/ref/heads/main").length, 3, "gewacht tot de fork klaar was");
    const pr = s.gh.prs[0];
    assert.deepEqual([pr.head, pr.base, pr.maintainer_can_modify, pr.title], ["vanes-diensten:aanbieder-dienst-vanes-test", "main", true, "Aanbieder toevoegen: Van Es"]);
    assert.match(pr.body, /^Van Es \(https:\/\/dienst\.vanes\.test\) vraagt om op de lijst van aanbieders te komen\.\n\nGemaakt met de Eigen Cloud-app \(Je dienst → Op de lijst\)\.\n\n- Adres van de Dienst: https:\/\/dienst\.vanes\.test\n- Contact: hallo@vanes\.test\n- Land: NL\n- Voorwaarden: nog niet ingesteld\n- Privacyverklaring: nog niet ingesteld\n\nVoor de beheerders: controleer of de Dienst antwoordt \(https:\/\/dienst\.vanes\.test\/v1\/info\)/);
    const want = `${JSON.stringify([...JSON.parse(initial), { naam: "Van Es", url: "https://dienst.vanes.test", land: "NL", contact: "hallo@vanes.test", omschrijving: "Eigen Cloud vanuit Rotterdam", sleutel: s.vanes.publicKey }], null, 2)}\n`;
    const state = await (await fetch(`${s.gh.base}/_control/state`)).json() as any;
    assert.equal(state.main, initial, "main blijft zoals hij was tot de beheerders samenvoegen");
    const branch = await (await fetch(`${s.gh.base}/repos/vanes-diensten/own-cloud/contents/aanbieders.json?ref=aanbieder-dienst-vanes-test`, { headers: { "user-agent": "Eigen-Cloud" } })).json() as any;
    assert.equal(Buffer.from(branch.content, "base64").toString("utf8"), want);
    assert.deepEqual(gstate().regel, { land: "NL", omschrijving: "Eigen Cloud vanuit Rotterdam" }, "onthouden voor de volgende keer");
  });

  await t.test("het open voorstel bijwerken: zelfde branch en voorstel", async () => {
    s.gh.calls.length = 0;
    const r = await github.aanmelden(c, { land: "NL", omschrijving: "Vanuit Rotterdam" });
    assert.deepEqual([r.gewijzigd, r.voorstel!.nummer, r.bericht], [true, 1, "Je voorstel is bijgewerkt."]);
    assert.ok(s.gh.calls.includes("PATCH /repos/vanes-diensten/own-cloud/git/refs/heads/aanbieder-dienst-vanes-test"), "branch opnieuw op de nieuwste main");
    assert.ok(!s.gh.calls.includes("POST /repos/renevanes/own-cloud/pulls"), "geen tweede voorstel");
    assert.equal(s.gh.prs.length, 1);
    const v = await github.view(c, deps);
    assert.deepEqual([v.voorstel!.status, v.opLijst, v.regel!.omschrijving], ["open", false, "Vanuit Rotterdam"]);
  });

  await t.test("samengevoegd door de beheerders: status en op de lijst", async () => {
    await fetch(`${s.gh.base}/_control/merge?n=1`, { method: "POST" });
    const before = saves;
    const v = await github.view(c, deps);
    assert.deepEqual([v.voorstel!.status, typeof v.voorstel!.samengevoegdOp, v.opLijst, v.sleutelKlopt, v.actueel], ["samengevoegd", "number", true, true, true]);
    assert.equal(saves, before + 1, "nieuwe status bewaard");
    const r = await github.aanmelden(c, { land: "NL", omschrijving: "Vanuit Rotterdam" });
    assert.deepEqual([r.ok, r.gewijzigd, r.bericht, r.voorstel!.status], [true, false, "Je regel staat al zo op de lijst.", "samengevoegd"]);
  });

  await t.test("later bijwerken: nieuw voorstel dat de regel vervangt; gesloten zonder samenvoegen", async () => {
    const r = await github.aanmelden(c, { land: "NL", omschrijving: "Nu ook in Utrecht" });
    assert.deepEqual([r.voorstel!.nummer, r.voorstel!.titel, r.voorstel!.status], [2, "Aanbieder bijwerken: Van Es", "open"]);
    assert.match(s.gh.prs[1].body, /^Van Es \(https:\/\/dienst\.vanes\.test\) werkt zijn regel op de lijst van aanbieders bij\./);
    const branch = await (await fetch(`${s.gh.base}/repos/vanes-diensten/own-cloud/contents/aanbieders.json?ref=aanbieder-dienst-vanes-test`, { headers: { "user-agent": "Eigen-Cloud" } })).json() as any;
    const list = JSON.parse(Buffer.from(branch.content, "base64").toString("utf8"));
    assert.deepEqual(list.map((x: any) => [x.naam, x.omschrijving]), [["ESAPE", JSON.parse(initial)[0].omschrijving], ["Van Es", "Nu ook in Utrecht"]]);
    await fetch(`${s.gh.base}/_control/close?n=2`, { method: "POST" });
    const v = await github.view(c, deps);
    assert.deepEqual([v.voorstel!.status, v.voorstel!.samengevoegdOp, v.opLijst, v.sleutelKlopt, v.actueel], ["gesloten", null, true, true, false]);
  });

  await t.test("zelf samenvoegen kan alleen met schrijfrechten", async () => {
    assert.equal(await err(github.samenvoegen(c, { confirm: true })), "Er is geen open voorstel");
    await github.aanmelden(c, { land: "NL", omschrijving: "Nu ook in Utrecht en Gouda" });
    assert.equal(await err(github.samenvoegen(c, {})), "Bevestig dat je het voorstel zelf wilt samenvoegen");
    assert.equal(await err(github.samenvoegen(c, { confirm: true })), "Alleen de beheerders van het project kunnen een voorstel zelf samenvoegen");
  });

  await t.test("de beheerders: branch in de repository zelf, standaard en adressen blijven, zelf samenvoegen", async () => {
    const e = cfgFor(s.esape);
    assert.deepEqual(await github.koppelen(e, { token: TOKENS.rene }), { ok: true, login: "renevanes", beheerder: true });
    let v = await github.view(e, deps);
    const omschrijving = JSON.parse(initial)[0].omschrijving;
    assert.deepEqual(v.regel, { naam: "ESAPE", url: "https://dienst.esape.nl", land: "NL", contact: "support@esape.nl", omschrijving, sleutel: s.esape.publicKey, standaard: true, adressen: "https://adressen.esape.nl" });
    assert.deepEqual([v.github.beheerder, v.opLijst, v.sleutelKlopt, v.actueel], [true, true, false, false]);
    s.gh.calls.length = 0;
    const r = await github.aanmelden(e, { land: "NL", omschrijving });
    assert.deepEqual([r.voorstel!.nummer, r.voorstel!.titel], [4, "Aanbieder bijwerken: ESAPE"]);
    assert.ok(!s.gh.calls.some((x) => x.includes("/forks") || x.includes("merge-upstream")), "geen fork nodig");
    assert.ok(s.gh.calls.includes("POST /repos/renevanes/own-cloud/git/refs"));
    assert.equal(s.gh.prs[3].head, "aanbieder-dienst-esape-nl");
    assert.equal(await err(github.samenvoegen(e, {})), "Bevestig dat je het voorstel zelf wilt samenvoegen");
    const m = await github.samenvoegen(e, { confirm: true });
    assert.deepEqual([m.ok, m.voorstel.status, typeof m.voorstel.samengevoegdOp], [true, "samengevoegd", "number"]);
    assert.ok(s.gh.calls.includes("merge 4 squash Aanbieder bijwerken: ESAPE (#4)"));
    const main = JSON.parse(s.gh.main());
    assert.deepEqual(Object.keys(main[0]), ["naam", "url", "land", "contact", "omschrijving", "sleutel", "standaard", "adressen"]);
    assert.deepEqual([main[0].sleutel, main[0].standaard, main[1].naam, main[1].omschrijving], [s.esape.publicKey, true, "Van Es", "Vanuit Rotterdam"]);
    v = await github.view(e, deps);
    assert.deepEqual([v.voorstel!.status, v.opLijst, v.sleutelKlopt, v.actueel], ["samengevoegd", true, true, true]);
    assert.equal(await err(github.samenvoegen(e, { confirm: true })), "Er is geen open voorstel");

    // Token ingetrokken op GitHub; daarna ontkoppelen.
    await fetch(`${s.gh.base}/_control/revoke?token=${TOKENS.rene}`, { method: "POST" });
    assert.equal(await err(github.aanmelden(e, { land: "NL", omschrijving: "Anders" })), "GitHub accepteert je token niet meer. Koppel GitHub opnieuw.");
    assert.deepEqual(github.ontkoppelen(e), { ok: true });
    v = await github.view(e, deps);
    assert.deepEqual([v.github, v.voorstel!.status], [{ gekoppeld: false, login: null, beheerder: false }, "samengevoegd"]);
    assert.equal(await err(github.aanmelden(e, { land: "NL", omschrijving: "Anders" })), "Koppel eerst GitHub");
  });

  await t.test("zonder Dienst of als de Dienst niet antwoordt", async () => {
    assert.equal(await err(github.view({ console: {} } as unknown as AdminConfig, deps)), "Er draait nog geen Dienst");
    const weg = cfgFor({ url: "https://weg.example", secret: "55".repeat(32) });
    aanbiederNet.reach = () => "http://127.0.0.1:9";
    const v = await github.view(weg, deps);
    aanbiederNet.reach = (url) => (url === s.vanes.url ? s.vanes.reach : url === s.esape.url ? s.esape.reach : url);
    assert.deepEqual([v.regel, v.dienstFout, v.opLijst], [null, "Je Dienst is nu niet bereikbaar. Probeer het zo opnieuw.", false]);
  });

  await t.test("voorwaarden en privacy: wat de Dienst host en welke links de app laat zien", async () => {
    let r = await voorwaarden.status(c);
    assert.deepEqual(r, { bereikbaar: true, termsUrl: null, privacyUrl: null, fout: null, documenten: [
      { soort: "voorwaarden", titel: "Algemene voorwaarden", versie: null, gewijzigd: null, url: null },
      { soort: "privacy", titel: "Privacyverklaring", versie: null, gewijzigd: null, url: null },
      { soort: "verwerkersovereenkomst", titel: "Verwerkersovereenkomst", versie: null, gewijzigd: null, url: null },
    ] });
    const { saveDoc, voorbeeld } = await import("../src/broker/juridisch.js");
    saveDoc(s.vanes.broker.ctx, null, "voorwaarden", { body: voorbeeld(s.vanes.broker.ctx, "voorwaarden") });
    r = await voorwaarden.status(c);
    assert.deepEqual([r.termsUrl, r.privacyUrl, r.documenten[0].versie, r.documenten[0].url, typeof r.documenten[0].gewijzigd], ["https://dienst.vanes.test/voorwaarden", null, 1, "https://dienst.vanes.test/voorwaarden", "number"]);
    aanbiederNet.reach = () => "http://127.0.0.1:9";
    r = await voorwaarden.status(c);
    aanbiederNet.reach = (url) => (url === s.vanes.url ? s.vanes.reach : url);
    assert.deepEqual([r.bereikbaar, r.fout, r.documenten.length], [false, "Je Dienst is nu niet bereikbaar", 3]);
  });
});

test("zonelimiet bij deSEC: aantal zones (met bladzijden) en de limiet van het account", { timeout: 20_000 }, async (t) => {
  const d = fakeDesecLimiet();
  process.env.EIGEN_DESEC_URL = await d.listening;
  t.after(async () => { delete process.env.EIGEN_DESEC_URL; await d.close(); });
  const c = { console: { aanbieder: { step: "klaar", url: "https://dienst.esape.nl", accounts: { desecToken: "dienst-tok" }, adressen: { zone: "eigencloud.nl", desecToken: "adres-tok", host: "adressen.esape.nl" } } } } as unknown as AdminConfig;
  assert.deepEqual(await zonelimiet(c, "adressen"), { welke: "adressen", zone: "eigencloud.nl", account: "rene@esape.nl", zones: 502, limiet: 15, support: "support@desec.io", fout: null });
  assert.deepEqual(await zonelimiet(c, "dienst"), { welke: "dienst", zone: null, account: null, zones: 502, limiet: null, support: "support@desec.io", fout: "Dit token mag de accountgegevens niet lezen; deSEC laat de limiet dan niet zien." });
  (c.console as any).aanbieder.accounts.desecToken = "fout";
  assert.deepEqual(await zonelimiet(c, "x"), { welke: "dienst", zone: null, account: null, zones: null, limiet: null, support: "support@desec.io", fout: "deSEC accepteert dit token niet." });
  delete (c.console as any).aanbieder.adressen;
  assert.equal(await err(zonelimiet(c, "adressen")), "De gratis-adressendienst draait niet op de server van je Dienst");
  assert.equal(await err(zonelimiet({ console: {} } as unknown as AdminConfig, "dienst")), "Er is nog geen deSEC-token (Accounts en sleutels)");
  assert.deepEqual([nextLink('<https://desec.io/api/v1/domains/?cursor=>; rel="first", <https://desec.io/api/v1/domains/?cursor=abc>; rel="next"'), nextLink(null), nextLink('<x>; rel="prev"')], ["https://desec.io/api/v1/domains/?cursor=abc", null, null]);
});
