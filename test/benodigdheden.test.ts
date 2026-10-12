/**
 * "Wat je nodig hebt" om aanbieder te worden (src/console/benodigdheden.ts), tegen nep-aanbieders (fake-nodig.ts):
 * de lijst met statussen, Scaleway met één sleutel (opnieuw proberen maakt niets dubbel, de eigen sleutel weggooien
 * alleen met toestemming), Mollie, deSEC (account en tokens met rechten), waar de DNS staat (DoH, binair), nameservers en
 * DNSSEC bij Openprovider, een domein kopen (alleen met akkoord en de juiste prijs), mail via Scaleway TEM, de IP-lijst
 * bij Openprovider, de Openprovider-DNS-adapter en de controle vanaf de Dienst zelf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fakeNodig, PERSONAL, ORG, USER } from "./helpers/fake-nodig.js";

const f = await fakeNodig();
Object.assign(process.env, f.env, { EIGEN_GITHUB_API: `${f.base}/github` });
const aan = await import("../src/console/aanbieder.js");
const nodig = await import("../src/console/benodigdheden.js");
const doh = await import("../src/console/doh.js");
const { getAdapter } = await import("../src/cluster/adapters.js");
const { resetOpTokens } = await import("../src/cluster/adapters/openprovider.js");
const { serverOffers, storeOffers, dnsOffers } = await import("../src/console/catalog.js");

test.after(() => f.close());

export function newConfig(): any {
  return { cluster: "eigen", nodeId: "beheer", kind: "data", masterKey: "00".repeat(32), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], stores: [], providers: {}, dns: [], image: {}, appEnv: {}, policy: {}, console: { step: "sleutel", done: false, keyConfirmed: true, alleenDienst: true } };
}
const deps = { save: () => {}, sleep: async () => {}, serverOffers: () => serverOffers(), storeOffers: () => storeOffers(), dnsOffers: () => dnsOffers() };
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };
const statuses = (r: { items: { id: string; status: string }[] }) => Object.fromEntries(r.items.map((x) => [x.id, x.status]));

test("DoH: vraag en antwoord in het binaire DNS-formaat, IPv6 zoals RFC 5952, aanbieders herkennen", () => {
  assert.equal(doh.encodeQuery("Esape.NL.", "NS").toString("hex"), "000001000001000000000000" + "056573617065026e6c00" + "00020001");
  assert.equal(doh.ipv6Text(Buffer.from("20010db8000000000000000000000001", "hex")), "2001:db8::1");
  assert.equal(doh.ipv6Text(Buffer.from("20010db8000100000001000000000001", "hex")), "2001:db8:1:0:1::1");
  assert.equal(doh.ipv6Text(Buffer.from("00000000000000000000000000000000", "hex")), "::");
  assert.equal(doh.ipv6Text(Buffer.from("20010db8000000010000000000000000", "hex")), "2001:db8:0:1::");
  assert.deepEqual([doh.nsProvider(["ns0.transip.net"]), doh.nsProvider(["NS1.deSEC.io."]), doh.nsProvider(["x.example"]), doh.nsProvider(["hydrogen.ns.hetzner.com"])], ["TransIP", "deSEC", null, "Hetzner"]);
  assert.equal(doh.nsMatch(["ns1.desec.io", "ns2.desec.org"], ["NS2.desec.org."]), true);
  assert.equal(doh.nsMatch(["ns1.desec.io"], []), false);
});

test("DoH tegen een resolver: eerste kapot, tweede antwoordt; NXDOMAIN; A, AAAA en DS", async () => {
  f.reset();
  f.st.dns.set("esape.nl", { NS: ["ns0.transip.net", "ns1.transip.nl"], A: ["192.0.2.1"], AAAA: ["2001:db8::5"], DS: ["12345 13 2 aabbccdd"] });
  assert.deepEqual(await doh.dohLookup("esape.nl", "NS"), { rcode: 0, values: ["ns0.transip.net", "ns1.transip.nl"] });
  assert.deepEqual(await doh.dohLookup("esape.nl", "AAAA"), { rcode: 0, values: ["2001:db8::5"] });
  assert.deepEqual(await doh.dohLookup("esape.nl", "DS"), { rcode: 0, values: ["12345 13 2 aabbccdd"] });
  assert.deepEqual(await doh.dohLookup("nergens.nl", "NS"), { rcode: 3, values: [] });
  assert.ok(f.st.calls.some((x) => x.startsWith("GET /doh-kapot")), "eerst de eerste resolver");
});

test("Wat je nodig hebt: van niets tot alles klaar", { timeout: 60_000 }, async (t) => {
  f.reset();
  nodig.resetNodigCache();
  resetOpTokens();
  const reach0 = aan.aanbiederNet.reach;
  aan.aanbiederNet.reach = () => f.dienst;
  t.after(() => { aan.aanbiederNet.reach = reach0; });
  const c = newConfig();

  // Een lege kluis: niets geregeld, wel de uitleg en de kosten.
  let l = await nodig.benodigdheden(c, true);
  assert.deepEqual(l.items.map((x) => x.id), ["domein", "dns", "server", "scaleway", "mollie", "mail", "desec", "openprovider", "adressendienst", "voorwaarden", "lijst"]);
  assert.ok(l.items.every((x) => x.status === "open"));
  assert.deepEqual([l.klaar, l.totaal], [0, 8]);
  assert.deepEqual(l.items[0], { id: "domein", label: "Domein", status: "open", uitleg: "Het adres van je Dienst, bijvoorbeeld dienst.jouwbedrijf.nl. Je klanten en de app vinden je daar.", kosten: "ongeveer € 10 per jaar", detail: "Nog geen adres gekozen", optioneel: false, actie: { label: "Regelen", soort: "paneel", doel: "domein" } });
  assert.equal(l.items.find((x) => x.id === "voorwaarden")!.actie.soort, "hub");

  // Adres en bedrijf; het domein staat nog bij TransIP.
  aan.saveBedrijf(c, { name: "ESAPE", email: "rene@esape.nl" });
  aan.saveAdres(c, { url: "dienst.esape.nl" });
  f.st.dns.set("esape.nl", { NS: ["ns0.transip.net", "ns1.transip.nl", "ns2.transip.eu"] });
  l = await nodig.benodigdheden(c, true);
  assert.equal(l.items[0].status, "ok");
  assert.equal(l.items[0].detail, "dienst.esape.nl, esape.nl is geregistreerd");

  // ── Scaleway: één persoonlijke sleutel ──
  assert.equal(await err(nodig.scaleway(c, { accessKey: "SCW123", secretKey: "x" }, deps)), "De toegangssleutel begint met SCW en heeft 20 tekens");
  const r1 = await nodig.scaleway(c, { accessKey: PERSONAL.access, secretKey: PERSONAL.secret }, deps);
  assert.deepEqual(r1.steps.map((s) => s.label), ["Je sleutel werkt", "Applicatie eigen-cloud-dienst", "Rechten: projecten, sleutels, servers, opslag en mail", "Eigen sleutel voor je Dienst", "Je eigen sleutel is weggegooid"]);
  assert.equal(r1.org, ORG);
  assert.equal(r1.verwijderd, true);
  assert.deepEqual(f.st.scw.applications.map((x) => x.name), ["eigen-cloud-dienst"]);
  assert.equal(f.st.scw.policies.length, 1);
  assert.deepEqual(f.st.scw.policies[0].rules, [
    { permission_set_names: ["ProjectManager", "IAMManager"], organization_id: ORG },
    { permission_set_names: ["InstancesFullAccess", "ObjectStorageFullAccess", "TransactionalEmailFullAccess"], organization_id: ORG },
  ]);
  assert.equal(f.st.scw.policies[0].application_id, f.st.scw.applications[0].id);
  assert.ok(!f.st.scw.keys.some((k) => k.access_key === PERSONAL.access), "persoonlijke sleutel weg");
  const a = c.console.aanbieder;
  const appKey = f.st.scw.keys.find((k) => k.application_id === f.st.scw.applications[0].id);
  assert.equal(a.accounts.scalewaySecretKey, appKey.secret_key);
  assert.equal(a.accounts.scalewayOrgId, ORG);
  assert.equal(a.checked.scaleway, true);
  assert.deepEqual(a.scw.personal, { accessKey: "••••••••0001", deleted: true });

  // Opnieuw (met een nieuwe eigen sleutel, en de rechten intussen aangepast): niets dubbel, rechten weer goed, sleutel blijft.
  f.st.scw.keys.push({ access_key: "SCWPERSONAL000000002", secret_key: "22222222-2222-3333-4444-555555555555", user_id: USER });
  f.st.scw.policies[0].rules = [{ permission_set_names: ["ProjectManager"], organization_id: ORG }];
  const nKeys = f.st.scw.keys.length;
  const r2 = await nodig.scaleway(c, { accessKey: "scwpersonal000000002", secretKey: " 22222222-2222-3333-4444-555555555555 ", verwijderen: false }, deps);
  assert.equal(r2.verwijderd, false);
  assert.equal(r2.steps.at(-1)!.label, "Je eigen sleutel blijft bestaan");
  assert.equal(r2.steps[3].detail, "Bestond al en werkt");
  assert.deepEqual([f.st.scw.applications.length, f.st.scw.policies.length, f.st.scw.keys.length], [1, 1, nKeys]);
  assert.equal(f.st.scw.policies[0].rules.length, 2, "rechten hersteld");
  assert.ok(f.st.calls.includes("PUT /scw/iam/v1alpha1/rules"));
  assert.equal(a.accounts.scalewaySecretKey, appKey.secret_key);

  // ── Mollie ──
  assert.equal(await err(nodig.mollie(c, { key: "geen-sleutel" })), "Een Mollie-sleutel begint met test_ of live_");
  assert.equal(await err(nodig.mollie(c, { key: "test_onbekend" })), "Mollie accepteert deze sleutel niet");
  let m = await nodig.mollie(c, { key: "test_abc123" });
  assert.equal(m.mode, "test");
  assert.deepEqual(m.todo.map((x) => x.tekst), ["iDEAL staat nog niet aan: zet het aan in je Mollie-dashboard.", "SEPA-incasso staat nog niet aan: zet het aan in je Mollie-dashboard. Dat is nodig voor de maandelijkse betaling."]);
  assert.equal(m.links.dashboard, "https://my.mollie.com/dashboard/org_1/settings/profiles/pfl_1");
  assert.deepEqual(m.profiel, { naam: "ESAPE", website: "https://esape.nl", status: "unverified" });
  f.st.mollie.first = ["ideal", "creditcard"];
  f.st.mollie.recurring = ["directdebit"];
  m = await nodig.mollie(c, { key: "live_xyz789" });
  assert.deepEqual(m.todo.map((x) => x.tekst), ["Mollie heeft je account nog niet goedgekeurd. Rond de aanmelding af in je Mollie-dashboard."]);
  f.st.mollie.status = "verified";
  m = await nodig.mollie(c, {});
  assert.deepEqual([m.mode, m.todo, m.test], ["live", [], null]);
  assert.equal(a.accounts.mollieKey, "live_xyz789");

  // ── deSEC: account laten maken, tokens met de juiste rechten ──
  assert.equal(await err(nodig.desecRegister(c, { captchaId: "cap-1", solution: "fout" })), "De tekens uit het plaatje kloppen niet. Probeer het met een nieuw plaatje.");
  assert.deepEqual(await nodig.desecRegister(c, { captchaId: "cap-1", solution: " abc " }), { ok: true, email: "rene@esape.nl" });
  assert.deepEqual(await nodig.desecFinish(c, {}), { ok: false, pending: true, email: "rene@esape.nl", tokens: [] });
  l = await nodig.benodigdheden(c);
  assert.equal(l.items.find((x) => x.id === "desec")!.detail, "Klik op de link in de mail aan rene@esape.nl");
  f.st.desec.confirmed = true;
  assert.deepEqual(await nodig.desecFinish(c, { adressen: true }), { ok: true, pending: false, email: "rene@esape.nl", tokens: ["dienst", "adressen"] });
  const [td, ta] = f.st.desec.tokens.slice(1);
  assert.deepEqual([td.name, td.perm_create_domain, td.perm_delete_domain, td.perm_manage_tokens], ["eigen-cloud-dienst", true, true, false]);
  assert.deepEqual([ta.name, ta.perm_create_domain, ta.perm_delete_domain, ta.perm_manage_tokens], ["eigen-cloud-adressen", true, true, true]);
  assert.equal(a.accounts.desecToken, td.token);
  assert.equal(a.checked.desec, true);
  assert.deepEqual(await nodig.desecFinish(c, { adressen: true }), { ok: true, pending: false, email: "rene@esape.nl", tokens: [] }, "nog eens: niets nieuws");

  // ── DNS bij deSEC; het domein staat bij TransIP en (nog) niet bij Openprovider ──
  await aan.saveDns(c, { provider: "desec", zone: "esape.nl" }, deps);
  assert.ok(f.st.desec.zones.has("esape.nl"));
  let d = await nodig.domein(c, {});
  assert.deepEqual([d.zone, d.geregistreerd, d.bij, d.goed, d.kanDelegeren, d.doel!.naam, d.ds], ["esape.nl", true, "TransIP", false, false, "deSEC", ["12345 13 2 aabbccdd"]]);
  assert.equal(d.uitleg, "Log in bij de partij waar je esape.nl hebt gekocht (de DNS staat nu bij TransIP), zoek de nameservers van het domein en vervang ze door ns1.desec.io en ns2.desec.org. Zet daar ook DNSSEC aan met de DS-gegevens hieronder. Het kan een paar uur duren voordat iedereen het ziet.");
  l = await nodig.benodigdheden(c, true);
  assert.equal(l.items[1].detail, "esape.nl staat nog bij TransIP; zet de nameservers op deSEC");

  // ── Openprovider koppelen (nog geen server: IP-lijst niet aangeraakt) ──
  assert.equal(await err(nodig.openprovider(c, {}, deps)), "Vul je Openprovider-gebruikersnaam en wachtwoord in");
  let o = await nodig.openprovider(c, { gebruiker: "vanes", wachtwoord: "fout" }, deps);
  assert.deepEqual([o.ok, a.checked.openprovider], [false, false]);
  resetOpTokens();
  o = await nodig.openprovider(c, { gebruiker: "vanes", wachtwoord: "geheim" }, deps);
  assert.deepEqual([o.ok, o.ip.status, o.dienst], [true, "geen-server", null]);
  f.st.op.domains.push({ id: 501, domain: { name: "esape", extension: "nl" }, name_servers: [{ name: "ns0.transip.net" }] });
  d = await nodig.domein(c, {});
  assert.deepEqual([d.openprovider.domeinId, d.kanDelegeren], [501, true]);
  const del = await nodig.delegeren(c, {}, deps);
  assert.deepEqual(del.steps.map((s) => s.label), ["Nameservers op deSEC gezet", "DNSSEC aangezet"]);
  const opd = f.st.op.domains[0];
  assert.deepEqual([opd.name_servers, opd.is_dnssec_enabled, opd.dnssec_keys], [[{ name: "ns1.desec.io" }, { name: "ns2.desec.org" }], true, [{ flags: 257, protocol: 3, alg: 13, pub_key: "QUJDREVG" }]]);
  d = await nodig.domein(c, {});
  assert.deepEqual([d.bij, d.goed, d.dnssec, d.kanDelegeren, d.uitleg], ["deSEC", true, true, false, null]);
  l = await nodig.benodigdheden(c, true);
  assert.equal(statuses(l).dns, "ok");

  // ── Gedeelde zone van de adressendienst kopen (eerst nog vrij) ──
  d = await nodig.domein(c, { voor: "adressen", zone: "eigencloud.nl" });
  assert.deepEqual([d.geregistreerd, d.openprovider.vrij, d.openprovider.prijs, d.uitleg], [false, true, { valuta: "EUR", bedrag: "7.50" }, "eigencloud.nl is nog vrij. Je kunt het hieronder kopen bij Openprovider."]);
  const houder = { voornaam: "Rene", achternaam: "van Es", straat: "Blaak", huisnummer: "10", postcode: "3011 TA", plaats: "Rotterdam", telefoon: "+31 6 12345678" };
  assert.equal(await err(nodig.kopen(c, { voor: "adressen", zone: "eigencloud.nl", prijs: "7.50", houder }, deps)), "Bevestig eerst dat je het domein wilt kopen");
  assert.equal(await err(nodig.kopen(c, { voor: "adressen", zone: "eigencloud.nl", prijs: "6.00", akkoord: true, houder }, deps)), "De prijs is veranderd: nu € 7,50 per jaar. Kijk opnieuw en bevestig.");
  assert.equal(await err(nodig.kopen(c, { voor: "adressen", zone: "eigencloud.nl", prijs: "7.50", akkoord: true, houder: { ...houder, telefoon: "" } }, deps)), "Vul de gegevens van de houder in: telefoonnummer");
  assert.equal(f.st.op.domains.length, 1, "nog niets gekocht");
  const k = await nodig.kopen(c, { voor: "adressen", zone: "eigencloud.nl", prijs: "7.50", akkoord: true, houder }, deps);
  assert.deepEqual(k.steps.map((s) => s.label), ["Houder aangemaakt bij Openprovider", "eigencloud.nl gekocht"]);
  const bought = f.st.op.domains[1];
  assert.deepEqual([bought.owner_handle, bought.period, bought.autorenew, bought.name_servers, bought.is_dnssec_enabled], [f.st.op.customers[0].handle, 1, "on", [{ name: "ns1.desec.io" }, { name: "ns2.desec.org" }], true]);
  assert.deepEqual(f.st.op.customers[0].phone, { country_code: "+31", area_code: "6", subscriber_number: "12345678" });
  assert.ok(f.st.desec.zones.has("eigencloud.nl"), "zone bij deSEC aangemaakt (met het token van de adressendienst)");
  assert.equal(await err(nodig.kopen(c, { voor: "adressen", zone: "eigencloud.nl", prijs: "7.50", akkoord: true }, deps)), "eigencloud.nl is niet (meer) vrij");
  // Een premium-domein (andere prijs): de app laat geen prijs zien en koopt het niet.
  d = await nodig.domein(c, { voor: "adressen", zone: "duur.nl" });
  assert.deepEqual([d.openprovider.vrij, d.openprovider.premium, d.openprovider.prijs, d.uitleg], [true, true, null, "duur.nl is nog vrij, maar het is een premium-domein met een hogere prijs. Koop het als je wilt in het controlepaneel van Openprovider."]);
  assert.equal(await err(nodig.kopen(c, { voor: "adressen", zone: "duur.nl", prijs: "9.00", akkoord: true, houder }, deps)), "duur.nl is een premium-domein met een andere prijs. Koop het in het controlepaneel van Openprovider.");
  assert.equal(f.st.op.domains.length, 2, "premium niet gekocht");

  // ── Mail van de Dienst via Scaleway ──
  assert.equal(await err(nodig.mail(c, { manier: "cloud" }, deps)), "Je eigen cloud verstuurt nog geen mail");
  let ml = await nodig.mail(c, { manier: "scaleway" }, deps);
  const proj = f.st.scw.projects[0];
  assert.equal(proj.name, "eigen-cloud-dienst");
  assert.deepEqual([ml.manier, ml.domein, ml.status, ml.afzender, ml.werkt, ml.smtp], ["scaleway", "dienst.esape.nl", "pending", "noreply@dienst.esape.nl", true, `smtp://${proj.id}@127.0.0.1:${f.smtpPort}`]);
  assert.deepEqual(ml.records, [
    { naam: "dienst.esape.nl", type: "TXT", waarde: "v=spf1 include:_spf.tem.scaleway.com -all", gezet: true },
    { naam: `${proj.id}._domainkey.dienst.esape.nl`, type: "TXT", waarde: "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq", gezet: true },
    { naam: "_dmarc.dienst.esape.nl", type: "TXT", waarde: "v=DMARC1; p=none", gezet: true },
  ]);
  assert.ok(f.st.calls.includes("PUT /desec/domains/esape.nl/rrsets/"));
  assert.ok(f.st.calls.some((x) => /^POST \/scw\/transactional-email\/.*\/check$/.test(x)));
  assert.deepEqual(f.smtpAuth, [proj.id]);
  l = await nodig.benodigdheden(c);
  assert.deepEqual([statuses(l).mail, l.items.find((x) => x.id === "mail")!.detail], ["bijna", "Wacht tot Scaleway je maildomein heeft goedgekeurd"]);
  f.st.scw.tem[0].status = "checked";
  ml = await nodig.mailStatus(c, deps);
  assert.equal(ml.status, "checked");
  assert.equal(f.st.scw.tem.length, 1);
  ml = await nodig.mail(c, { manier: "scaleway" }, deps);
  assert.equal(f.st.scw.tem.length, 1, "opnieuw: hetzelfde maildomein");

  // ── De Dienst draait: IP-adres bij Openprovider, voorwaarden, op de lijst ──
  a.hosting = { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", monthly: 7.99 };
  a.backup = { provider: "scaleway", endpoint: "https://s3.fr-par.scw.cloud", region: "fr-par", bucket: "b" };
  a.server = { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", serverId: "s1", ipv4: "198.51.100.7", createdAt: 1 };
  a.secret = "ab".repeat(32);
  a.lastHealth = { at: 1, reachable: true, version: "1.15", uptime: 5, lastBackupAt: 1, backup: "aan", closing: false };
  o = await nodig.openprovider(c, {}, deps);
  assert.deepEqual([o.ip.status, o.ip.uitleg, f.st.op.allow], ["toegevoegd", "De app heeft 198.51.100.7 op de lijst gezet.", ["203.0.113.5", "198.51.100.7"]]);
  // De rest van de contactpersoon gaat ongewijzigd mee; alleen-lezen velden (zoals last_login_at) niet.
  assert.deepEqual(f.st.op.contactPut, { api_access_enabled: true, email: "rene@esape.nl", name: { first_name: "Rene", last_name: "van Es" }, rcp_client_ip_list: { allow: [], deny: [] }, role: "admin", api_client_ip_list: { allow: ["203.0.113.5", "198.51.100.7"], deny: [] } });
  assert.deepEqual(o.dienst && { ok: o.dienst.ok, detail: o.dienst.detail }, { ok: true, detail: "De server van je Dienst kan bij Openprovider" });
  o = await nodig.openprovider(c, {}, deps);
  assert.equal(o.ip.status, "staat-erop");
  f.st.op.allow = [];
  o = await nodig.openprovider(c, {}, deps);
  assert.deepEqual([o.ip.status, f.st.op.allow], ["open", []], "geen lijst: niets toevoegen");
  f.st.dienst.opCheck = { ok: false, detail: "Openprovider laat de server van je Dienst niet inloggen: zet het IP-adres van de server op de lijst" };
  const oc = await nodig.openproviderCheck(c, deps);
  assert.equal(oc.dienst!.ok, false);

  l = await nodig.benodigdheden(c, true);
  assert.deepEqual(statuses(l), { domein: "ok", dns: "ok", server: "ok", scaleway: "ok", mollie: "ok", mail: "ok", desec: "ok", openprovider: "bijna", adressendienst: "open", voorwaarden: "bijna", lijst: "open" });
  const det = (x: typeof l, id: string) => x.items.find((y) => y.id === id)!.detail;
  assert.deepEqual([det(l, "voorwaarden"), det(l, "lijst")], ["Nog niet gepubliceerd", "Nog niet op de lijst"]);
  // Een voorstel op GitHub (github.ts) dat nog open is; en een regel met een oude sleutel.
  c.console.github = { voorstel: { nummer: 12, url: "https://github.com/renevanes/own-cloud/pull/12", titel: "ESAPE", status: "open", repo: "x/own-cloud", branch: "b", at: 1, samengevoegdOp: null } };
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([statuses(l).lijst, det(l, "lijst")], ["bijna", "Voorstel #12 wacht op de beheerders"]);
  f.st.dienst.lijst = { opLijst: true, sleutelKlopt: false };
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([statuses(l).lijst, det(l, "lijst")], ["bijna", "Je regel staat erop, maar met een andere sleutel"]);
  // Voorwaarden: alleen de voorwaarden gepubliceerd.
  f.st.dienst.termsUrl = "https://dienst.esape.nl/voorwaarden";
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([statuses(l).voorwaarden, det(l, "voorwaarden")], ["bijna", "Je privacyverklaring ontbreekt nog"]);
  // Een Dienst die niet antwoordt: de lijst wacht niet langer dan nodigNet.waitMs.
  const reach1 = aan.aanbiederNet.reach;
  // A remote unroutable IP can hang until the TCP timeout inside a container.
  // Reject connections locally so this tests an unavailable service consistently.
  const unavailable = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => unavailable.close(() => resolve())));
  aan.aanbiederNet.reach = () => `http://127.0.0.1:${(unavailable.address() as net.AddressInfo).port}`;
  const w0 = nodig.nodigNet.waitMs;
  nodig.nodigNet.waitMs = 300;
  const t0 = Date.now();
  l = await nodig.benodigdheden(c, true);
  assert.ok(Date.now() - t0 < 3000, "kort gewacht");
  // (De openbare lijst is wel te lezen: daar staat het adres van de Dienst; de sleutel is zonder de Dienst niet na te gaan.)
  assert.deepEqual([statuses(l).voorwaarden, det(l, "voorwaarden"), statuses(l).lijst, det(l, "lijst")], ["bijna", "Je Dienst is nu niet bereikbaar", "ok", "Je Dienst staat op de lijst"]);
  nodig.nodigNet.waitMs = w0;
  aan.aanbiederNet.reach = reach1;
  assert.equal(l.items.find((x) => x.id === "server")!.kosten, "€ 7,99 per maand");
  f.st.dienst.termsUrl = "https://dienst.esape.nl/voorwaarden";
  f.st.dienst.privacyUrl = "https://dienst.esape.nl/privacy";
  f.st.dienst.lijst = { opLijst: true, sleutelKlopt: true };
  f.st.dienst.opCheck = { ok: true, detail: "De server van je Dienst kan bij Openprovider" };
  await nodig.openproviderCheck(c, deps);
  l = await nodig.benodigdheden(c);
  assert.equal(statuses(l).voorwaarden, "bijna", "uit het geheugen (een minuut)");
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([statuses(l).voorwaarden, statuses(l).lijst, statuses(l).openprovider, l.klaar, l.totaal], ["ok", "ok", "ok", 8, 8]);
  // Geen geheimen in het antwoord.
  const json = JSON.stringify(l);
  for (const s of [a.accounts.scalewaySecretKey, "live_xyz789", a.accounts.desecToken, "geheim"]) assert.ok(!json.includes(s));

  // Alles ingevuld (ook Openprovider en de adressendienst): het opstartscript van de server past nog in 32 KiB (Hetzner).
  a.backup = { ...a.backup, accessKey: "SCWBACKUP0000000000", secretKey: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" };
  a.adressen = { zone: "eigencloud.nl", desecToken: a.desecAccount.adressenToken, host: "adressen.esape.nl" };
  a.company = { ...a.company, address: ["Blaak 10", "3011 TA Rotterdam"], kvk: "12345678", vat: "NL001234567B01" };
  const ud = aan.serverUserData(c, a);
  assert.ok(ud.length < 32 * 1024, `user-data ${ud.length} bytes`);
});

test("Openprovider-DNS: zone maken, records zetten, vervangen en weghalen", async () => {
  f.reset();
  resetOpTokens();
  const ad = getAdapter("openprovider")!;
  const fields = { username: "vanes", password: "geheim" };
  assert.deepEqual(await ad.dns!.connect(fields, "vanes.nl"), { nameservers: ["ns1.openprovider.nl", "ns2.openprovider.be", "ns3.openprovider.eu"] });
  assert.ok(f.st.op.zones.has("vanes.nl"));
  const dns = ad.dns!.create("t", fields, "vanes.nl");
  await dns.setRecords("dienst", "A", ["192.0.2.10"], 300);
  await dns.setRecords("", "MX", ["10 mail.vanes.nl."], 3600);
  await dns.setRecords("", "TXT", ['"v=spf1 " "-all"'], 3600);
  assert.deepEqual(f.st.op.zones.get("vanes.nl"), [
    { name: "dienst.vanes.nl", type: "A", ttl: 900, value: "192.0.2.10" },
    { name: "vanes.nl", type: "MX", ttl: 3600, value: "mail.vanes.nl", prio: 10 },
    { name: "vanes.nl", type: "TXT", ttl: 3600, value: "v=spf1 -all" },
  ]);
  const before = f.st.calls.length;
  await dns.setRecords("dienst", "A", ["192.0.2.10"], 300);
  assert.equal(f.st.calls.slice(before).filter((x) => x.startsWith("PUT")).length, 0, "zelfde waarde: niets wijzigen");
  await dns.setRecords("dienst", "A", ["192.0.2.11"], 300);
  await dns.setRecords("", "MX", [], 3600);
  assert.deepEqual(f.st.op.zones.get("vanes.nl")!.map((r) => `${r.name} ${r.type} ${r.value}`), ["vanes.nl TXT v=spf1 -all", "dienst.vanes.nl A 192.0.2.11"]);
  assert.equal(await (async () => { try { await ad.dns!.connect({ username: "x", password: "y" }, "vanes.nl"); return null; } catch (e) { return (e as Error).message; } })(), "Openprovider laat deze gebruiker niet inloggen. Klopt het wachtwoord, staat API-toegang aan, en mag dit IP-adres erbij?");
  const chk = await ad.dns!.check!(fields, "vanes.nl");
  assert.deepEqual(chk.map((x) => [x.id, x.ok]), [["login", true], ["zone", true], ["rights", null]]);
});

test("De Dienst: kan de server bij Openprovider? (alleen met het beheertoken)", async (t) => {
  f.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodig-dienst-"));
  const { loadConfig } = await import("../src/broker/config.js");
  const { createBroker } = await import("../src/broker/app.js");
  const SECRET = "cd".repeat(32);
  const broker = await createBroker(loadConfig({
    BROKER_DATA_DIR: dir, BROKER_SECRET: SECRET, BROKER_PUBLIC_URL: "http://127.0.0.1:1",
    OPENPROVIDER_USERNAME: "vanes", OPENPROVIDER_PASSWORD: "geheim", OPENPROVIDER_URL: `${f.base}/op`, BROKER_LIST_URL: "uit",
  }));
  t.after(async () => { await broker.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = async (auth?: string) => { const r = await broker.app.inject({ method: "GET", url: "/v1/status/check/openprovider", headers: auth ? { authorization: auth } : {} }); return { status: r.statusCode, json: r.json() }; };
  assert.equal((await get()).status, 401);
  const ok = `Beheer ${aan.beheerToken(SECRET)}`;
  assert.deepEqual(await get(ok), { status: 200, json: { ok: true, ingesteld: true, detail: "De server van je Dienst kan bij Openprovider" } });
  f.st.op.pass = "ander";
  f.st.op.token = "op-token-2";
  assert.deepEqual((await get(ok)).json, { ok: false, ingesteld: true, detail: "Openprovider laat de server van je Dienst niet inloggen: zet het IP-adres van de server op de lijst" });
});
