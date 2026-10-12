/**
 * "Zo gratis mogelijk beginnen" (src/console/gratis.ts en de gratis regels in benodigdheden.ts), tegen nep-aanbieders
 * (fake-nodig.ts): de keuze (Standaard blijft precies zoals het was), de gratis route en kosten per onderdeel met het
 * eerlijke totaal, een gratis adres bij deSEC (vrij, bezet, één per account, het maken duurt even), een server op
 * starttegoed bij UpCloud (back-ups bij Scaleway) en Exoscale (back-ups bij Exoscale), het tegoed en de einddatum met
 * de waarschuwingen, verhuizen naar de goedkoopste betaalde server (laatste back-up, nieuwe server, DNS om, proefserver
 * weg), en de mail via de HTTPS-koppeling van Scaleway (ook in de Dienst zelf).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNodig, PERSONAL } from "./helpers/fake-nodig.js";
import { fakeS3 } from "./helpers/fake-s3.js";

const f = await fakeNodig();
Object.assign(process.env, f.env);
const aan = await import("../src/console/aanbieder.js");
const nodig = await import("../src/console/benodigdheden.js");
const G = await import("../src/console/gratis.js");
const { serverOffers, storeOffers, dnsOffers } = await import("../src/console/catalog.js");
const { makeMailer } = await import("../src/broker/mail.js");

const s3 = fakeS3();
const s3url = `http://127.0.0.1:${await s3.listening}`;
test.after(async () => { await f.close(); await s3.close(); });

const NU = Date.UTC(2026, 9, 12, 10, 0);
const DAG = 86_400_000;
const deps = { save: () => {}, sleep: async () => {}, serverOffers: () => serverOffers(), storeOffers: () => storeOffers(), dnsOffers: () => dnsOffers() };
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as Error).message; } };
const rij = (l: { items: { id: string }[] }, id: string) => l.items.find((x) => x.id === id) as any;
const DESEC = { NS: ["ns1.desec.io", "ns2.desec.org"] };

function newConfig(): any {
  return { cluster: "eigen", nodeId: "beheer", kind: "data", masterKey: "00".repeat(32), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], stores: [], providers: {}, dns: [], image: {}, appEnv: {}, policy: {}, console: { step: "sleutel", done: false, keyConfirmed: true, alleenDienst: true } };
}

test("Zo gratis mogelijk beginnen: adres, proefserver, waarschuwingen en verhuizen", { timeout: 60_000 }, async (t) => {
  f.reset();
  nodig.resetNodigCache();
  G.resetGratisCache();
  G.gratisNet.now = () => NU;
  const reach0 = aan.aanbiederNet.reach;
  aan.aanbiederNet.reach = () => f.dienst;
  t.after(() => { aan.aanbiederNet.reach = reach0; G.gratisNet.now = () => Date.now(); });
  const c = newConfig();

  // ── Standaard (geen keuze): precies zoals het was ──
  let l: any = await nodig.benodigdheden(c, true);
  assert.equal(l.modus, "standaard");
  assert.deepEqual([l.kosten, l.waarschuwing, l.proefAanbieders], [null, null, null]);
  assert.deepEqual(l.items[0], { id: "domein", label: "Domein", status: "open", uitleg: "Het adres van je Dienst, bijvoorbeeld dienst.jouwbedrijf.nl. Je klanten en de app vinden je daar.", kosten: "ongeveer € 10 per jaar", detail: "Nog geen adres gekozen", optioneel: false, actie: { label: "Regelen", soort: "paneel", doel: "domein" } });
  assert.ok(l.items.every((x: any) => !("route" in x)), "geen gratis route bij Standaard");
  assert.equal(rij(l, "server").actie.soort, "stap");
  assert.equal(aan.view(c, deps).modus, "standaard");

  // ── De keuze ──
  assert.equal(await err(Promise.resolve().then(() => G.setModus(c, { modus: "duur" }))), "Kies hoe je wilt beginnen");
  assert.deepEqual(G.setModus(c, { modus: "gratis" }), { ok: true, modus: "gratis" });
  assert.equal(c.console.aanbiederModus, "gratis");
  l = await nodig.benodigdheden(c, true);
  assert.equal(l.modus, "gratis");
  assert.deepEqual(l.items.map((x: any) => [x.id, x.route]), [["domein", "Gratis adres bij deSEC"], ["dns", "Gratis bij deSEC"], ["server", "Gratis proberen met starttegoed"], ["scaleway", "Gratis account"], ["mollie", "Gratis account"],
    ["mail", "Gratis via Scaleway"], ["desec", "Gratis"], ["openprovider", "Niet nodig om te beginnen"], ["adressendienst", "Niet nodig"], ["voorwaarden", "Gratis"], ["lijst", "Gratis"]]);
  assert.deepEqual([rij(l, "domein").kosten, rij(l, "domein").detail], ["gratis", "Nog geen naam gekozen"]);
  assert.deepEqual([rij(l, "server").status, rij(l, "server").kosten, rij(l, "server").detail, rij(l, "server").actie], ["open", "gratis met starttegoed, daarna vanaf ongeveer € 6,00 per maand", "Kies UpCloud of Exoscale om gratis te proberen", { label: "Regelen", soort: "paneel", doel: "server" }]);
  assert.equal(rij(l, "mail").kosten, "gratis tot 300 mails per maand, daarna € 0,25 per 1.000 (volgens Scaleway)");
  assert.equal(rij(l, "adressendienst").detail, "Niet nodig: hiervoor heb je een eigen domein nodig (optioneel)");
  assert.equal(rij(l, "scaleway").detail, "Nog geen sleutel. Een account is gratis; Scaleway vraagt wel een betaalmethode");
  assert.equal(l.kosten.tekst, "€ 0 per maand tot je starttegoed op is; daarna vanaf ongeveer € 6,00 per maand voor de server (zonder btw)");
  assert.deepEqual(l.kosten.na, { bedrag: 6, vanaf: true, provider: null, naam: null });
  assert.deepEqual(l.proefAanbieders.map((x: any) => [x.id, x.fields.map((y: any) => y.key)]), [["upcloud", ["token"]], ["exoscale", ["apiKey", "apiSecret"]]]);
  assert.deepEqual([l.klaar, l.totaal], [0, 8], "zelfde onderdelen tellen mee");

  // ── Gratis adres bij deSEC ──
  aan.saveBedrijf(c, { name: "ESAPE", email: "rene@esape.nl" });
  assert.match(await err(G.gratisAdres(c, { naam: "esape" }, deps)) ?? "", /^Maak eerst je gratis deSEC-account/);
  const a = c.console.aanbieder;
  a.accounts = { desecToken: "desec-bestaand" };
  a.checked = { desec: true };
  f.st.dns.set("bezet.dedyn.io", { NS: ["ns1.desec.io", "ns2.desec.org"] });
  assert.equal(await err(G.gratisAdres(c, { naam: "-fout" }, deps)), "Kies een naam van letters, cijfers en streepjes (niet aan het begin of eind), bijvoorbeeld jouwbedrijf");
  let g: any = await G.gratisAdres(c, { naam: "bezet" }, deps);
  assert.deepEqual([g.naam, g.status], ["bezet.dedyn.io", "bezet"]);
  g = await G.gratisAdres(c, { naam: "https://Esape.dedyn.io/" }, deps);
  assert.deepEqual([g.naam, g.status, g.uitleg], ["esape.dedyn.io", "vrij", "esape.dedyn.io is vrij."]);
  assert.equal(await err(G.gratisAdres(c, { naam: "bezet", maken: true }, deps)), "bezet.dedyn.io is al bezet. Kies een andere naam.");
  // Het maken duurt even, en daarna staat de naam nog niet meteen in de DNS.
  f.st.dedyn.traagMs = 300;
  g = await G.gratisAdres(c, { naam: "esape", maken: true }, deps);
  assert.deepEqual([g.status, g.url, g.gebruikt], ["wacht", "https://esape.dedyn.io", true]);
  assert.match(g.uitleg, /deSEC zet hem nu klaar in dedyn\.io; dat duurt meestal een paar minuten/);
  assert.equal(a.url, "https://esape.dedyn.io");
  assert.deepEqual([a.dns.provider, a.dns.zone, a.dns.nameservers, a.gratisAdres.klaar], ["desec", "esape.dedyn.io", ["ns1.desec.io", "ns2.desec.org"], false]);
  assert.equal(aan.defaultZone("esape.dedyn.io"), "esape.dedyn.io");
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([rij(l, "domein").status, rij(l, "domein").detail], ["bijna", "deSEC zet esape.dedyn.io klaar; dat duurt meestal een paar minuten"]);
  assert.deepEqual([rij(l, "dns").status, rij(l, "dns").detail], ["bijna", "De app zet de records zodra deSEC je adres heeft klaargezet"]);
  // deSEC geeft één gratis adres per account.
  g = await G.gratisAdres(c, { naam: "nogeen", maken: true }, deps);
  assert.deepEqual([g.status, g.ander], ["ander", "esape.dedyn.io"]);
  assert.ok(!f.st.desec.zones.has("nogeen.dedyn.io"));
  // Klaar zodra de naam in de DNS staat.
  g = await G.gratisAdres(c, {}, deps);
  assert.equal(g.status, "wacht");
  f.st.dns.set("esape.dedyn.io", DESEC);
  g = await G.gratisAdres(c, {}, deps);
  assert.deepEqual([g.status, a.gratisAdres.klaar], ["klaar", true]);
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([rij(l, "domein").status, rij(l, "domein").detail, rij(l, "dns").status, rij(l, "dns").detail], ["ok", "esape.dedyn.io staat bij deSEC", "ok", "esape.dedyn.io staat bij deSEC; de app zet de records"]);

  // ── Scaleway (voor de klanten en de mail); daarmee is er een prijs voor "daarna" ──
  await nodig.scaleway(c, { accessKey: PERSONAL.access, secretKey: PERSONAL.secret }, deps);
  l = await nodig.benodigdheden(c, true);
  assert.equal(rij(l, "server").kosten, "gratis met starttegoed, daarna ongeveer € 6,42 per maand");
  assert.equal(l.kosten.tekst, "€ 0 per maand tot je starttegoed op is; daarna ongeveer € 6,42 per maand voor de server (zonder btw)");
  assert.deepEqual(l.kosten.na, { bedrag: 6.42, vanaf: false, provider: "scaleway", naam: "Scaleway" });

  // ── Server op starttegoed bij UpCloud; back-ups bij Scaleway ──
  assert.match(await err(G.proef(c, { provider: "upcloud", fields: { token: "fout" } }, deps)) ?? "", /^Inloggen bij UpCloud lukt niet/);
  let p: any = await G.proef(c, { provider: "upcloud", fields: { token: "upc-token" } }, deps);
  assert.deepEqual([p.hosting.provider, p.hosting.region, p.hosting.size, p.backup.provider, p.backup.region, p.backup.auto], ["upcloud", "nl-ams1", "1xCPU-2GB", "scaleway", "fr-par", true]);
  assert.equal(p.backupUitleg, G.PROEF.upcloud.backupUitleg);
  assert.deepEqual([p.proef.eind, p.proef.eindBron, p.proef.eindTekst, p.proef.eindDatum, p.proef.dagenOver], [NU + 7 * DAG, "geschat", "ongeveer 19 oktober", "2026-10-19", 7]);
  assert.deepEqual([p.proef.tegoed.bedrag, p.proef.startTegoed, p.proef.tegoedTekst, p.proef.waarschuwing, p.proef.actief], [500, 500, "€ 500,00 van € 500,00", null, true]);
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([rij(l, "server").status, rij(l, "server").detail, rij(l, "server").kosten], ["bijna", "Gekozen, nog niet opgezet", "gratis tot ongeveer 19 oktober, daarna ongeveer € 6,42 per maand · back-ups minder dan € 0,01 per maand"]);
  assert.deepEqual(l.kosten.regels, ["Back-ups bij Scaleway: minder dan € 0,01 per maand.", "Mail: gratis tot 300 mails per maand, daarna € 0,25 per 1.000 (volgens Scaleway).", "Scaleway en Mollie: geen vaste kosten. Je betaalt per betaling en wat je klanten gebruiken; dat zit in je prijzen."]);
  // De einddatum zelf invullen (en weer laten schatten).
  assert.equal(await err(G.proef(c, { eind: "19-10-2026" }, deps)), "Vul de datum in als 2026-10-19");
  p = await G.proef(c, { eind: "2026-10-26" }, deps);
  assert.deepEqual([p.proef.eindTekst, p.proef.eindBron], ["26 oktober", "ingevuld"]);
  p = await G.proef(c, { eind: "" }, deps);
  assert.deepEqual([p.proef.eindTekst, p.proef.eindBron], ["ongeveer 19 oktober", "geschat"]);

  // ── Mail via de HTTPS-koppeling van Scaleway (de proefserver laat geen SMTP toe) ──
  const ml: any = await nodig.mail(c, { manier: "scaleway" }, deps);
  const proj = f.st.scw.projects[0].id;
  assert.deepEqual([ml.manier, ml.domein, ml.werkt, ml.smtp, ml.afzender], ["scaleway", "esape.dedyn.io", true, `scwtem://${proj}@fr-par`, "noreply@esape.dedyn.io"]);
  assert.match(a.accounts.smtpUrl, new RegExp(`^scwtem://${proj}:[0-9a-f-]{36}@fr-par$`));
  assert.deepEqual(ml.records.map((x: any) => [x.naam, x.gezet]), [["esape.dedyn.io", true], [`${proj}._domainkey.esape.dedyn.io`, true], ["_dmarc.esape.dedyn.io", true]]);
  assert.equal(f.smtpAuth.length, 0, "geen SMTP");
  // De Dienst zelf verstuurt zo ook mail.
  await makeMailer({ smtpUrl: a.accounts.smtpUrl, scaleway: { url: `${f.base}/scw` }, mailFrom: "ESAPE <noreply@esape.dedyn.io>" } as never).send("klant@voorbeeld.nl", "Je inlogcode", "123456");
  assert.deepEqual(f.st.temSent, [{ from: { email: "noreply@esape.dedyn.io", name: "ESAPE" }, to: [{ email: "klant@voorbeeld.nl" }], subject: "Je inlogcode", text: "123456", project_id: proj }]);
  const bad = await aan.intern.checkSmtp(`scwtem://${proj}:00000000-0000-0000-0000-000000000000@fr-par`);
  assert.deepEqual([bad.ok, bad.detail], [false, "Scaleway accepteert deze sleutel niet voor mail"]);

  // ── De Dienst draait op de proefserver ──
  f.st.upc.servers.push({ uuid: "upc-1", state: "started", labels: { label: [{ key: "cluster", value: "eigen-cloud-dienst" }] } });
  a.server = { provider: "upcloud", region: "nl-ams1", size: "1xCPU-2GB", serverId: "upc-1", ipv4: "198.51.100.9", createdAt: NU };
  a.backup = { provider: "custom", endpoint: s3url, region: "us-east-1", bucket: "dienst-b", accessKey: "k", secretKey: "s" };
  a.secret = "ab".repeat(32);
  a.lastHealth = { at: NU, reachable: true, version: "1.17", uptime: 5, lastBackupAt: NU, backup: "aan", closing: false };
  a.mollie = { at: 1, mode: "live", profiel: null, methoden: { eerste: [], terugkerend: [] }, todo: [] };
  a.accounts.mollieKey = "live_xyz789";
  a.checked.mollie = true;
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([rij(l, "server").status, rij(l, "server").detail], ["ok", "Draait op starttegoed bij UpCloud (tot ongeveer 19 oktober, tegoed € 500,00 van € 500,00)"]);
  assert.equal(l.waarschuwing, null);

  // Het tegoed is bijna op (minder dan 20%): waarschuwing in de lijst en in Je dienst.
  f.st.upc.credits = 8000;
  l = await nodig.benodigdheden(c, true);
  const W1 = "Je starttegoed bij UpCloud is bijna op (nog € 80,00). Daarna haalt UpCloud je server weg, tenzij je minstens € 10 stort. Verhuis je Dienst op tijd naar een betaalde server.";
  assert.deepEqual(l.waarschuwing, { titel: "Starttegoed bijna op", tekst: W1, provider: "upcloud" });
  assert.deepEqual([rij(l, "server").status, rij(l, "server").detail, rij(l, "server").actie.label], ["bijna", W1, "Regelen"]);
  assert.deepEqual([(aan.view(c, deps) as any).proef.waarschuwing, (aan.view(c, deps) as any).proef.procent], [W1, 16]);
  // Drie dagen voor het einde, en daarna.
  f.st.upc.credits = 45000;
  G.gratisNet.now = () => NU + 5 * DAG;
  l = await nodig.benodigdheden(c, true);
  assert.equal(l.waarschuwing.tekst, "Je proefperiode bij UpCloud loopt over 2 dagen af (ongeveer 19 oktober). Daarna haalt UpCloud je server weg, tenzij je minstens € 10 stort. Verhuis je Dienst op tijd naar een betaalde server.");
  assert.equal(l.waarschuwing.titel, "Proefperiode bijna voorbij");
  G.gratisNet.now = () => NU + 7 * DAG + 60_000;
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([l.waarschuwing.titel, l.waarschuwing.tekst], ["Proefperiode voorbij", "Je proefperiode bij UpCloud is voorbij. Daarna haalt UpCloud je server weg, tenzij je minstens € 10 stort. Verhuis je Dienst nu naar een betaalde server."]);
  assert.equal(rij(l, "server").kosten, "gratis tot je starttegoed op is, daarna ongeveer € 6,42 per maand", "back-ups staan hier (in de test) in een eigen opslag");
  // Ook bij Standaard staat de waarschuwing erbij.
  G.setModus(c, { modus: "standaard" });
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([l.waarschuwing?.titel, rij(l, "server").status, rij(l, "server").actie.soort, "route" in rij(l, "server")], ["Proefperiode voorbij", "bijna", "stap", false]);
  G.setModus(c, { modus: "gratis" });

  // ── Verhuizen naar de goedkoopste betaalde server ──
  f.st.scwSizes["fr-par-1"] = 6.5;
  let v: any = await G.verhuizen(c, {}, deps);
  assert.deepEqual(v.kandidaten.map((x: any) => [x.provider, x.region, x.size, x.monthly]), [["scaleway", "nl-ams-1", "DEV1-S", 6.42]], "UpCloud (de proef) telt niet mee");
  assert.deepEqual([v.keuze.naam, v.keuze.city, v.keuze.sizeLabel, v.backup, v.uitleg], ["Scaleway", "Amsterdam", "2 vCPU, 2 GB", "De back-ups blijven waar ze staan.", null]);
  assert.equal(await err(G.verhuizen(c, { provider: "ovh", region: "x", akkoord: true }, deps)), "Kies een gekoppelde aanbieder voor je nieuwe server");
  v = await G.verhuizen(c, { provider: "scaleway", region: "nl-ams-1", akkoord: true }, deps);
  assert.deepEqual(v.steps.map((x: any) => [x.label, x.ok]), [
    ["Project eigen-cloud-dienst bij Scaleway", true], ["Back-upopslag bij Eigen opslag (NAS, MinIO, Garage) (127.0.0.1), 30 dagen niet te wissen", true], ["Laatste back-up van de huidige server", true],
    ["Server bij Scaleway in Amsterdam (DEV1-S)", true], ["De vorige server wordt opgeruimd", true], ["esape.dedyn.io wijst naar 192.0.2.10", true]]);
  assert.deepEqual([v.replaced, v.verhuisd, a.server.provider, a.server.region, a.server.size, a.hosting.monthly], [true, true, "scaleway", "nl-ams-1", "DEV1-S", 6.42]);
  assert.ok(f.st.calls.includes("PUT /desec/domains/esape.dedyn.io/rrsets/"), "DNS om");
  await aan.cleanupRetired(c, deps);
  assert.deepEqual([f.st.upc.servers.length, a.retired], [0, undefined], "proefserver weg bij UpCloud");
  assert.ok(f.st.calls.includes("POST /upc/server/upc-1/stop") && f.st.calls.some((x) => x.startsWith("DELETE /upc/server/upc-1")));
  l = await nodig.benodigdheden(c, true);
  assert.deepEqual([l.waarschuwing, rij(l, "server").route, rij(l, "server").kosten, l.kosten.tekst], [null, "Betaalde server", "€ 6,42 per maand", "Ongeveer € 6,42 per maand voor de server (zonder btw)"]);
  assert.deepEqual([(aan.view(c, deps) as any).proef.actief, (aan.view(c, deps) as any).proef.verhuisd, (aan.view(c, deps) as any).proef.waarschuwing], [false, true, null]);
});

test("Zo gratis mogelijk: Exoscale met back-ups bij Exoscale, saldo en einddatum", async (t) => {
  f.reset();
  G.resetGratisCache();
  G.gratisNet.now = () => NU;
  t.after(() => { G.gratisNet.now = () => Date.now(); });
  const c = newConfig();
  G.setModus(c, { modus: "gratis" });
  aan.saveBedrijf(c, { name: "ESAPE", email: "rene@esape.nl" });
  assert.match(await err(G.proef(c, { provider: "exoscale", fields: { apiKey: "EXOfout", apiSecret: "s" } }, deps)) ?? "", /^Inloggen bij Exoscale lukt niet/);
  const p: any = await G.proef(c, { provider: "exoscale", fields: { apiKey: "EXOtest", apiSecret: "geheim" } }, deps);
  assert.deepEqual([p.hosting.region, p.hosting.size, p.backup.provider, p.backup.region], ["de-fra-1", "standard.small", "exoscale", "de-fra-1"]);
  const a = c.console.aanbieder;
  assert.deepEqual([a.backup.endpoint, a.backup.accessKey, a.backup.secretKey], ["https://sos-de-fra-1.exo.io", "EXOtest", "geheim"]);
  assert.deepEqual([p.proef.eind, p.proef.eindTekst, p.proef.tegoedTekst, p.proef.startTegoed], [null, null, "€ 20,00 van € 20,00", 20]);
  let l: any = await nodig.benodigdheden(c, true);
  assert.equal(rij(l, "server").kosten, "gratis tot je starttegoed op is, daarna vanaf ongeveer € 6,00 per maand");
  assert.deepEqual(l.kosten.regels.length, 2, "geen back-ups bij Scaleway");
  // Het saldo zakt onder de 20%.
  a.server = { provider: "exoscale", region: "de-fra-1", size: "standard.small", serverId: "de-fra-1/i-1", ipv4: "198.51.100.20", createdAt: NU };
  f.st.exo.balance = 3;
  l = await nodig.benodigdheden(c, true);
  assert.equal(l.waarschuwing.tekst, "Je starttegoed bij Exoscale is bijna op (nog € 3,00). Daarna betaal je Exoscale met je creditcard. Verhuis je Dienst op tijd naar een betaalde server.");
  // Zelf een einddatum invullen.
  const e: any = await G.proef(c, { eind: "2026-10-20" }, deps);
  assert.deepEqual([e.proef.eindTekst, e.proef.dagenOver], ["20 oktober", 9]);
  // Zonder andere aanbieder: eerst koppelen.
  const v: any = await G.verhuizen(c, {}, deps);
  assert.deepEqual([v.keuze, v.backup, v.uitleg], [null, "De back-ups blijven bij Exoscale; die plek ligt vast.", "Koppel eerst een aanbieder voor een betaalde server, bijvoorbeeld Scaleway (die heb je al voor de clouds van je klanten)."]);
});
