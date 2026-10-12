/**
 * "Wat je nodig hebt" om zelf aanbieder te worden, en het regelen ervan vanuit de app.
 *
 * Uitgangspunt: wat via een API kan, doet de app. Wat juridisch of fysiek de persoon bij het bedrijf vraagt (een account
 * openen met je naam, betaalgegevens, een ID-controle bij Mollie) wordt een begeleide stap: de app opent de juiste
 * pagina, en ziet daarna zelf dat het gelukt is (hooguit één geplakte sleutel).
 *
 *  - Lijst met status per onderdeel (GET /api/aanbieder/benodigdheden): goedkoop, netwerkcontroles kort en bewaard.
 *  - Scaleway: één persoonlijke sleutel plakken; de app maakt een IAM-applicatie "eigen-cloud-dienst" met precies de
 *    rechten die de Dienst nodig heeft, een sleutel daarvoor, zoekt het organisatie-ID op en gooit (met toestemming) de
 *    persoonlijke sleutel weg.
 *  - Mollie: sleutel controleren, profiel en betaalmethoden lezen, en zeggen wat er nog aan moet.
 *  - deSEC: account laten maken (zoals bij een cloud), met een token dat zones mag maken en weghalen, en desgewenst een
 *    token voor de adressendienst dat tokens mag beheren.
 *  - Domein en DNS: waar staat de DNS (opzoeken via DoH, doh.ts), nameservers en DNSSEC goedzetten bij Openprovider,
 *    een domein kopen bij Openprovider (met bevestiging en de prijs).
 *  - Mail van de Dienst via Scaleway Transactional Email: maildomein, SPF/DKIM/DMARC via de DNS-koppeling, SMTP.
 *  - Openprovider: het IP-adres van de server op de lijst, en controleren vanaf de server zelf.
 *
 * De Android-app doet hetzelfde in Java (android/core Benodigdheden.java); de JSON van de routes is gelijk.
 */
import crypto from "node:crypto";
import type { AdminConfig } from "./vault.js";
import * as aan from "./aanbieder.js";
import { DESEC_URL, desecError, scw, scwKeys, temDomain, TEM_DOMAINS, SCW_SIGNUP_URL, SCW_KEYS_URL } from "./extras.js";
import { temRecords, txtRecord } from "../tem.js";
import { getAdapter } from "../cluster/adapters.js";
import { OpenproviderApi, OpError, splitDomain } from "../cluster/adapters/openprovider.js";
import { dohLookup, nsMatch, nsProvider } from "./doh.js";
import { parsePhone, parseDnskey } from "../broker/provision.js";
import * as voorwaarden from "./voorwaarden.js";
import * as github from "./github.js";
import * as G from "./gratis.js";
import { serverOffers as catalogServerOffers, type ServerOffer } from "./catalog.js";

// ───────── Toestand ─────────

/** Wat dit onderdeel bewaart in console.aanbieder, naast wat aanbieder.ts al heeft. Nooit geheimen in een antwoord. */
export interface NodigState {
  /** Scaleway: de IAM-applicatie, policy en sleutel van de Dienst (door de app gemaakt), en de geplakte eigen sleutel. */
  scw?: { org?: string; applicationId?: string; policyId?: string; accessKey?: string; personal?: { accessKey: string; deleted: boolean } };
  /** Laatste controle bij Mollie. */
  mollie?: MollieInfo;
  /** deSEC-account dat de app maakte (wachtwoord voor nieuwe tokens) en de tokens die het daarmee maakte. */
  desecAccount?: { email: string; password: string; at: number; tokenId?: string; adressenToken?: string; adressenTokenId?: string };
  /** Mail van de Dienst via Scaleway Transactional Email. */
  mail?: { manier: "scaleway" | "cloud" | "smtp"; domein?: string; projectId?: string; temDomainId?: string; status?: string; records?: MailRec[]; checkAt?: number; at?: number };
  /** Openprovider: IP-lijst van de API-gebruiker en de controle vanaf de server van de Dienst. */
  openprovider?: { contactId?: number; check?: { at: number; ok: boolean; detail: string } };
  /** Klant-handle bij Openprovider voor domeinen die de aanbieder zelf koopt. */
  opHandle?: string;
}
export interface MollieInfo { at: number; mode: "test" | "live"; profiel: { naam: string; website: string; status: string } | null; methoden: { eerste: string[]; terugkerend: string[] }; todo: { tekst: string; link: string | null }[] }
export interface MailRec { naam: string; type: "TXT"; waarde: string; gezet: boolean }

type A = aan.AanbiederState & NodigState;
type Step = { label: string; ok: boolean; detail?: string };
const fail = (msg: string, steps?: Step[]) => Object.assign(new Error(msg), { steps });
const mask = (v?: string) => (v ? "•".repeat(8) + v.slice(-4) : "");
const sleep0 = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZONE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const DESEC_NS = ["ns1.desec.io", "ns2.desec.org"];

export interface NodigDeps extends aan.Deps {}

/** Hoe de console de Dienst bereikt (tests: een lokale server); zelfde als in aanbieder.ts. */
const reach = (url: string) => aan.aanbiederNet.reach(url);

// ───────── Bewaarde netwerkcontroles ─────────

const cache = new Map<string, { at: number; v: unknown }>();
/** Alleen voor tests: alles opnieuw nagaan. */
export function resetNodigCache() { cache.clear(); }
/** Een controle hooguit eens per minuut (een mislukte: na 20 seconden opnieuw), tenzij `fresh`. */
async function cached<T>(key: string, fresh: boolean, fn: () => Promise<T>, good: (v: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < (good(hit.v as T) ? 60_000 : 20_000)) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Hoe lang de lijst op één controle wacht; wat later klaar is, staat de volgende keer in het geheugen. */
export const nodigNet = { waitMs: 6000 };
/** Hooguit `ms` wachten; daarna null (de controle loopt door en vult het geheugen). */
const within = <T>(p: Promise<T>, ms = nodigNet.waitMs) => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms).unref?.())]);

async function getJson(url: string, headers: Record<string, string> = {}, ms = 4000): Promise<{ status: number; json: any }> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    const t = await r.text();
    let j: any = null;
    try { j = t ? JSON.parse(t) : null; } catch { /* geen JSON */ }
    return { status: r.status, json: j };
  } catch { return { status: 0, json: null }; }
}

// ───────── De lijst ─────────

type Status = "ok" | "bijna" | "open";
export interface Item {
  id: string; label: string; status: Status; uitleg: string; kosten: string | null; detail: string; optioneel: boolean;
  actie: { label: string; soort: "paneel" | "stap" | "hub"; doel: string };
  /** Alleen bij "Zo gratis mogelijk beginnen": de gratis route voor dit onderdeel. */
  route?: string;
}

const item = (id: string, label: string, status: Status, uitleg: string, kosten: string | null, detail: string, optioneel: boolean, soort: Item["actie"]["soort"], doel: string): Item =>
  ({ id, label, status, uitleg, kosten, detail, optioneel, actie: { label: soort === "hub" ? "Bekijken" : status === "ok" ? "Wijzigen" : "Regelen", soort, doel } });

/** € 7,99 (zoals toFixed(2) met een komma). */
const euro = (n: number) => `€ ${n.toFixed(2).replace(".", ",")}`;
const hostOf = (url?: string | null) => { try { return url ? new URL(url).hostname : null; } catch { return null; } };

/**
 * De lijst met alles wat een aanbieder nodig heeft, met de status van nu. `fresh`: netwerkcontroles niet uit het geheugen.
 * Voorwaarden en Op de lijst: dezelfde controles als GET /api/aanbieder/juridisch (voorwaarden.ts) en
 * GET /api/aanbieder/lijst (github.ts), zodat de lijst en die onderdelen hetzelfde zeggen.
 */
export async function benodigdheden(c: AdminConfig, fresh = false, deps: { save: () => void; serverOffers?: () => ServerOffer[] } = { save: () => {} }) {
  const a = (aan.intern.existing(c) ?? { step: "bedrijf" }) as A & G.GratisState;
  const acc = a.accounts ?? {}, ch = a.checked ?? {};
  const host = hostOf(a.url);
  const zone = a.dns?.zone ?? aan.defaultZone(host);
  const live = !!a.server && !a.removed && !!a.url;
  const gratis = G.modus(c) === "gratis";
  const offers = deps.serverOffers ?? (() => catalogServerOffers());
  const [ns, aRec, adrNs, jur, lijst, na, tegoed] = await Promise.all([
    zone ? cached(`ns:${zone}`, fresh, () => dohLookup(zone, "NS"), (v) => v !== null) : null,
    host && a.dnsHandmatig && a.server?.ipv4 ? cached(`a:${host}`, fresh, () => dohLookup(host, "A"), (v) => v !== null) : null,
    a.adressen ? cached(`ns:${a.adressen.zone}`, fresh, () => dohLookup(a.adressen!.zone, "NS"), (v) => v !== null) : null,
    live ? within(cached(`juridisch:${a.url}`, fresh, () => voorwaarden.status(c).catch(() => null), (v) => !!v?.bereikbaar)) : null,
    live && a.secret ? within(cached(`lijst:${a.url}`, fresh, () => github.view(c, deps).catch(() => null), (v) => !!v && !v.dienstFout && !v.lijstFout)) : null,
    gratis ? within(G.prijsNa(c, a, { fresh, offers })) : null,
    within(G.verversTegoed(c, fresh)),
  ]);
  if (tegoed) deps.save();
  const items: Item[] = [];

  // Domein
  {
    const uitleg = "Het adres van je Dienst, bijvoorbeeld dienst.jouwbedrijf.nl. Je klanten en de app vinden je daar.";
    if (!host || !zone) items.push(item("domein", "Domein", "open", uitleg, "ongeveer € 10 per jaar", "Nog geen adres gekozen", false, "paneel", "domein"));
    else if (ns && ns.rcode === 3) items.push(item("domein", "Domein", "bijna", uitleg, "ongeveer € 10 per jaar", `${zone} lijkt nog niet geregistreerd`, false, "paneel", "domein"));
    else if (ns && ns.values.length) items.push(item("domein", "Domein", "ok", uitleg, "ongeveer € 10 per jaar", `${host}, ${zone} is geregistreerd`, false, "paneel", "domein"));
    else items.push(item("domein", "Domein", "bijna", uitleg, "ongeveer € 10 per jaar", `${host}; kon niet nagaan of ${zone} bestaat`, false, "paneel", "domein"));
  }
  // DNS
  {
    const uitleg = "Zorgt dat het adres naar je server wijst. Met een DNS-aanbieder zet de app de records zelf.";
    const kosten = "gratis bij deSEC";
    const keuze = a.dns?.provider ?? (a.dnsHandmatig ? "handmatig" : aan.dnsInfo(c).mode === "cloud" ? "cloud" : null);
    if (!host || !keuze) items.push(item("dns", "DNS voor dat domein", "open", uitleg, kosten, "Nog niet gekozen wie de DNS doet", false, "paneel", "dns"));
    else if (keuze === "cloud") items.push(item("dns", "DNS voor dat domein", "ok", uitleg, kosten, "Je eigen cloud zet het record", false, "paneel", "dns"));
    else if (keuze === "handmatig") {
      const okA = !!aRec && !!a.server?.ipv4 && aRec.values.includes(a.server.ipv4);
      items.push(item("dns", "DNS voor dat domein", okA ? "ok" : "bijna", uitleg, kosten, okA ? `${host} wijst naar je server` : "Je zet het record zelf", false, "paneel", "dns"));
    } else {
      const d = a.dns!, naam = aan.intern.dnsName(d.provider);
      const want = d.nameservers ?? [];
      if (d.error) items.push(item("dns", "DNS voor dat domein", "bijna", uitleg, kosten, d.error, false, "paneel", "dns"));
      else if (!want.length || (ns && nsMatch(ns.values, want))) items.push(item("dns", "DNS voor dat domein", "ok", uitleg, kosten, `${d.zone} staat bij ${naam}`, false, "paneel", "dns"));
      else {
        const nu = ns ? nsProvider(ns.values) : null;
        items.push(item("dns", "DNS voor dat domein", "bijna", uitleg, kosten, nu ? `${d.zone} staat nog bij ${nu}; zet de nameservers op ${naam}` : `Zet de nameservers van ${d.zone} op ${naam}`, false, "paneel", "dns"));
      }
    }
  }
  // Server en back-ups
  {
    const uitleg = "Een eigen server voor je Dienst, met elk uur een versleutelde back-up.";
    const kosten = a.hosting?.monthly != null ? `${euro(a.hosting.monthly)} per maand` : "vanaf ongeveer € 5 per maand";
    if (!a.hosting || !a.backup) items.push(item("server", "Server en back-ups", "open", uitleg, kosten, "Nog niet gekozen waar", false, "stap", "server"));
    else if (!a.server) items.push(item("server", "Server en back-ups", "bijna", uitleg, kosten, a.removed ? "Je Dienst is verwijderd" : "Gekozen, nog niet opgezet", false, "stap", "server"));
    else if (a.lastHealth?.reachable) items.push(item("server", "Server en back-ups", "ok", uitleg, kosten, a.lastHealth.lastBackupAt ? "Draait, met back-ups" : "Draait", false, "stap", "server"));
    else items.push(item("server", "Server en back-ups", "bijna", uitleg, kosten, "Opgezet, nog niet bereikbaar", false, "stap", "server"));
  }
  // Scaleway
  {
    const uitleg = "Hiermee zet je Dienst voor elke klant een eigen project op, met servers, opslag en mail.";
    const kosten = "wat je klanten gebruiken (zit in je prijs)";
    if (!acc.scalewaySecretKey) items.push(item("scaleway", "Scaleway voor klantclouds", "open", uitleg, kosten, "Nog geen sleutel", false, "paneel", "scaleway"));
    else if (ch.scaleway !== true) items.push(item("scaleway", "Scaleway voor klantclouds", "bijna", uitleg, kosten, "De sleutel werkt nog niet", false, "paneel", "scaleway"));
    else items.push(item("scaleway", "Scaleway voor klantclouds", "ok", uitleg, kosten, a.scw?.applicationId ? "Eigen sleutel voor je Dienst (eigen-cloud-dienst)" : "Sleutel werkt", false, "paneel", "scaleway"));
  }
  // Mollie
  {
    const uitleg = "Voor de betalingen van je klanten: eerst iDEAL, daarna elke maand een automatische incasso.";
    const kosten = "geen vaste kosten; per betaling een klein bedrag";
    const m = a.mollie;
    if (!acc.mollieKey) items.push(item("mollie", "Mollie", "open", uitleg, kosten, "Nog geen sleutel", false, "paneel", "mollie"));
    else if (ch.mollie !== true) items.push(item("mollie", "Mollie", "bijna", uitleg, kosten, "Mollie accepteert de sleutel niet", false, "paneel", "mollie"));
    else if (m && m.todo.length) items.push(item("mollie", "Mollie", "bijna", uitleg, kosten, m.todo[0].tekst, false, "paneel", "mollie"));
    else if (acc.mollieKey.startsWith("test_")) items.push(item("mollie", "Mollie", "bijna", uitleg, kosten, "Testsleutel: betalingen zijn nep", false, "paneel", "mollie"));
    else items.push(item("mollie", "Mollie", "ok", uitleg, kosten, "Live: echte betalingen", false, "paneel", "mollie"));
  }
  // Mail van je Dienst
  {
    const uitleg = "Voor inlogcodes, facturen en meldingen aan je klanten.";
    const kosten = "meestal gratis";
    const smtp = aan.intern.smtpOf(c, a);
    if (!smtp) items.push(item("mail", "Mail van je Dienst", "open", uitleg, kosten, "Nog geen mailserver", false, "paneel", "mail"));
    else if (ch.smtp !== true) items.push(item("mail", "Mail van je Dienst", "bijna", uitleg, kosten, "Inloggen bij de mailserver lukt niet", false, "paneel", "mail"));
    else if (a.mail?.manier === "scaleway" && a.mail.status !== "checked") items.push(item("mail", "Mail van je Dienst", "bijna", uitleg, kosten, "Wacht tot Scaleway je maildomein heeft goedgekeurd", false, "paneel", "mail"));
    else items.push(item("mail", "Mail van je Dienst", "ok", uitleg, kosten, a.mail?.manier === "scaleway" ? `Via Scaleway, als ${acc.mailFrom ?? ""}` : "Mail versturen werkt", false, "paneel", "mail"));
  }
  // deSEC
  {
    const uitleg = "De DNS van de domeinen van je klanten. Gratis, open source, uit Berlijn.";
    const kosten = "gratis (een donatie is netjes)";
    if (!acc.desecToken && !a.desecAccount) items.push(item("desec", "deSEC voor klantdomeinen", "open", uitleg, kosten, "Nog geen account", false, "paneel", "desec"));
    else if (!acc.desecToken) items.push(item("desec", "deSEC voor klantdomeinen", "bijna", uitleg, kosten, `Klik op de link in de mail aan ${a.desecAccount!.email}`, false, "paneel", "desec"));
    else if (ch.desec !== true) items.push(item("desec", "deSEC voor klantdomeinen", "bijna", uitleg, kosten, "deSEC accepteert het token niet", false, "paneel", "desec"));
    else items.push(item("desec", "deSEC voor klantdomeinen", "ok", uitleg, kosten, "Token werkt", false, "paneel", "desec"));
  }
  // Openprovider (optioneel)
  {
    const uitleg = "Alleen nodig als klanten via jou een domein kopen.";
    const kosten = "domeinen tegen inkoopprijs, van je tegoed";
    const chk = a.openprovider?.check;
    if (!acc.openproviderUser) items.push(item("openprovider", "Openprovider", "open", uitleg, kosten, "Niet gekoppeld (optioneel)", true, "paneel", "openprovider"));
    else if (ch.openprovider !== true) items.push(item("openprovider", "Openprovider", "bijna", uitleg, kosten, "Inloggen lukt niet vanaf dit apparaat", true, "paneel", "openprovider"));
    else if (live && chk && !chk.ok) items.push(item("openprovider", "Openprovider", "bijna", uitleg, kosten, chk.detail, true, "paneel", "openprovider"));
    else if (live && !chk) items.push(item("openprovider", "Openprovider", "bijna", uitleg, kosten, "Nog niet gecontroleerd vanaf de server van je Dienst", true, "paneel", "openprovider"));
    else items.push(item("openprovider", "Openprovider", "ok", uitleg, kosten, live ? "Werkt, ook vanaf je server" : "Inloggen werkt", true, "paneel", "openprovider"));
  }
  // Gratis-adressendienst (optioneel, alleen voor de beheerders van het project)
  {
    const uitleg = "Alleen voor de beheerders van het project: gratis adressen (naam.eigencloud.nl) voor klanten van alle aanbieders.";
    const kosten = "ongeveer € 10 per jaar voor het domein";
    if (!a.adressen) items.push(item("adressendienst", "Gratis-adressendienst", "open", uitleg, kosten, "Draait niet (optioneel)", true, "paneel", "adressendienst"));
    else if (adrNs && nsMatch(adrNs.values, DESEC_NS)) items.push(item("adressendienst", "Gratis-adressendienst", "ok", uitleg, kosten, `${a.adressen.zone} staat bij deSEC`, true, "paneel", "adressendienst"));
    else items.push(item("adressendienst", "Gratis-adressendienst", "bijna", uitleg, kosten, adrNs?.rcode === 3 ? `${a.adressen.zone} lijkt nog niet geregistreerd` : `Zet de nameservers van ${a.adressen.zone} op deSEC`, true, "paneel", "adressendienst"));
  }
  // Voorwaarden en privacy (alleen status, zoals GET /api/aanbieder/juridisch)
  {
    const uitleg = "Je klanten lezen je voorwaarden en privacyverklaring voordat ze bestellen.";
    const terms = jur?.termsUrl, privacy = jur?.privacyUrl;
    if (!live) items.push(item("voorwaarden", "Voorwaarden en privacy", "open", uitleg, null, "Na het opzetten van je Dienst", false, "hub", "voorwaarden"));
    else if (!jur || !jur.bereikbaar) items.push(item("voorwaarden", "Voorwaarden en privacy", "bijna", uitleg, null, "Je Dienst is nu niet bereikbaar", false, "hub", "voorwaarden"));
    else if (terms && privacy) items.push(item("voorwaarden", "Voorwaarden en privacy", "ok", uitleg, null, "Staan online", false, "hub", "voorwaarden"));
    else items.push(item("voorwaarden", "Voorwaarden en privacy", "bijna", uitleg, null, !terms && !privacy ? "Nog niet gepubliceerd" : !terms ? "Je voorwaarden ontbreken nog" : "Je privacyverklaring ontbreekt nog", false, "hub", "voorwaarden"));
  }
  // Op de lijst (alleen status, zoals GET /api/aanbieder/lijst)
  {
    const uitleg = "Dan kunnen mensen je Dienst in de app kiezen, en krijgt hij gratis adressen.";
    const v = lijst, pr = v?.voorstel;
    const L = (status: Status, detail: string) => items.push(item("lijst", "Op de lijst", status, uitleg, "gratis", detail, true, "hub", "lijst"));
    if (!live) L("open", "Na het opzetten van je Dienst");
    else if (!v) L("bijna", "Kon niet nagaan of je Dienst op de lijst staat");
    else if (v.opLijst && (!v.regel || v.sleutelKlopt)) L("ok", "Je Dienst staat op de lijst");
    else if (v.opLijst) L("bijna", "Je regel staat erop, maar met een andere sleutel");
    else if (pr?.status === "open") L("bijna", `Voorstel #${pr.nummer} wacht op de beheerders`);
    else if (pr?.status === "samengevoegd") L("bijna", "Samengevoegd; de openbare lijst wordt zo bijgewerkt");
    else if (v.lijstFout) L("bijna", "Kon de openbare lijst nu niet lezen");
    else L("open", pr?.status === "gesloten" ? `Voorstel #${pr.nummer} is gesloten; meld je opnieuw aan` : "Nog niet op de lijst");
  }
  // De proef op starttegoed loopt af of het tegoed is bijna op: dat staat bij de server (ook bij Standaard).
  const pv = G.proefView(a);
  if (pv?.waarschuwing) {
    const i = items.findIndex((x) => x.id === "server");
    items[i] = { ...items[i], status: "bijna", detail: pv.waarschuwing, actie: { ...items[i].actie, label: "Regelen" } };
  }
  const lijstUit = gratis ? items.map((x) => gratisItem(x, { a, host, ns, na, pv, scwOk: ch.scaleway === true && !!acc.scalewaySecretKey })) : items;
  if (gratis && a.gratisAdres && host === a.gratisAdres.naam && !a.gratisAdres.klaar && ns && nsMatch(ns.values, DESEC_NS)) { a.gratisAdres.klaar = true; deps.save(); }
  const nodig = lijstUit.filter((x) => !x.optioneel);
  return {
    items: lijstUit, klaar: nodig.filter((x) => x.status === "ok").length, totaal: nodig.length, links: LINKS, at: Date.now(),
    modus: G.modus(c),
    kosten: gratis ? gratisKosten(a, na, pv) : null,
    waarschuwing: pv?.waarschuwing ? { titel: pv.titel, tekst: pv.waarschuwing, provider: pv.provider } : null,
    proefAanbieders: gratis ? proefAanbieders(offers) : null,
  };
}

// ───────── Zo gratis mogelijk beginnen ─────────

const U_DOMEIN_GRATIS = "Het adres van je Dienst. Gratis: een naam als jouwbedrijf.dedyn.io bij deSEC. Een eigen domein kan later altijd.";
const U_SERVER_GRATIS = "Een eigen server voor je Dienst, met elk uur een versleutelde back-up. Gratis te proberen met starttegoed bij UpCloud of Exoscale; daarna verhuist de app je Dienst met één tik naar een betaalde server.";

/** Een regel met een andere status (de knop past zich aan) en de gratis route erbij. */
function opnieuw(x: Item, patch: Partial<Item>, route: string): Item {
  const status = patch.status ?? x.status;
  const soort = patch.actie?.soort ?? x.actie.soort;
  const label = soort === "hub" ? "Bekijken" : status === "ok" ? "Wijzigen" : "Regelen";
  return { ...x, ...patch, actie: { label, soort, doel: patch.actie?.doel ?? x.actie.doel }, route };
}

type GCtx = { a: A & G.GratisState; host: string | null; ns: { rcode: number; values: string[] } | null; na: { bedrag: number; vanaf: boolean } | null; pv: ReturnType<typeof G.proefView>; scwOk: boolean };

/** Bij "Zo gratis mogelijk beginnen": per onderdeel de gratis route, wat het kost en (domein, server) een andere status. */
function gratisItem(x: Item, g: GCtx): Item {
  const { a, host, ns, pv } = g;
  const dedyn = G.isDedyn(host);
  const deSec = !!ns && nsMatch(ns.values, DESEC_NS);
  switch (x.id) {
    case "domein":
      if (!host) return opnieuw(x, { uitleg: U_DOMEIN_GRATIS, kosten: "gratis", detail: "Nog geen naam gekozen" }, "Gratis adres bij deSEC");
      if (dedyn) return opnieuw(x, { uitleg: U_DOMEIN_GRATIS, kosten: "gratis", status: deSec ? "ok" : "bijna", detail: deSec ? `${host} staat bij deSEC` : `deSEC zet ${host} klaar; dat duurt meestal een paar minuten` }, "Gratis adres bij deSEC");
      return opnieuw(x, { uitleg: U_DOMEIN_GRATIS }, "Eigen domein");
    case "dns":
      if (!host) return opnieuw(x, { kosten: "gratis", detail: "Kies eerst een adres (hierboven)" }, "Gratis bij deSEC");
      if (dedyn && a.dns?.zone === host && !a.dns.error) return opnieuw(x, { kosten: "gratis", status: deSec ? "ok" : "bijna", detail: deSec ? `${host} staat bij deSEC; de app zet de records` : "De app zet de records zodra deSEC je adres heeft klaargezet" }, "Gratis bij deSEC");
      return opnieuw(x, { kosten: "gratis bij deSEC" }, "Gratis bij deSEC");
    case "server": {
      const na = G.naTekst(g.na);
      const backup = a.backup?.provider === "scaleway" ? ` · back-ups ${G.BACKUP_KOSTEN}` : "";
      const kosten = pv?.actief ? (pv.eindTekst && !pv.verlopen ? `gratis tot ${pv.eindTekst}, daarna ${na}${backup}` : `gratis tot je starttegoed op is, daarna ${na}${backup}`)
        : !a.hosting ? `gratis met starttegoed, daarna ${na}` : x.kosten;
      const paneel = { label: "", soort: "paneel" as const, doel: "server" };
      if (!a.hosting || !a.backup) return opnieuw(x, { uitleg: U_SERVER_GRATIS, kosten, detail: "Kies UpCloud of Exoscale om gratis te proberen", actie: paneel }, "Gratis proberen met starttegoed");
      if (pv?.actief && !pv.waarschuwing && x.status === "ok") {
        const info = [pv.eindTekst ? `tot ${pv.eindTekst}` : null, pv.tegoedTekst ? `tegoed ${pv.tegoedTekst}` : null].filter(Boolean).join(", ");
        return opnieuw(x, { uitleg: U_SERVER_GRATIS, kosten, detail: `Draait op starttegoed bij ${pv.naam}${info ? ` (${info})` : ""}`, actie: paneel }, "Gratis proberen met starttegoed");
      }
      return opnieuw(x, { uitleg: U_SERVER_GRATIS, kosten, actie: paneel }, pv?.actief ? "Gratis proberen met starttegoed" : "Betaalde server");
    }
    case "scaleway":
      return opnieuw(x, { kosten: "gratis account; je betaalt alleen wat je klanten gebruiken (zit in je prijs)", ...(x.status === "open" ? { detail: "Nog geen sleutel. Een account is gratis; Scaleway vraagt wel een betaalmethode" } : {}) }, "Gratis account");
    case "mollie":
      return opnieuw(x, { kosten: "gratis account; geen vaste kosten, per betaling een klein bedrag (zit in je prijs)" }, "Gratis account");
    case "mail":
      return opnieuw(x, { kosten: G.MAIL_KOSTEN, ...(x.status === "open" ? { detail: g.scwOk ? "Nog geen mail; regel het via Scaleway" : "Regel eerst Scaleway (gratis account)" } : {}) }, "Gratis via Scaleway");
    case "openprovider":
      return opnieuw(x, x.status === "open" ? { detail: "Niet nodig met een gratis adres (optioneel)" } : {}, "Niet nodig om te beginnen");
    case "adressendienst":
      return opnieuw(x, !a.adressen ? { detail: "Niet nodig: hiervoor heb je een eigen domein nodig (optioneel)" } : {}, "Niet nodig");
    case "voorwaarden":
      return opnieuw(x, { kosten: "gratis" }, "Gratis");
    default:
      return opnieuw(x, {}, "Gratis");
  }
}

/** Het eerlijke totaal bovenaan bij "Zo gratis mogelijk beginnen". */
function gratisKosten(a: A & G.GratisState, na: { bedrag: number; vanaf: boolean; provider: string | null; naam: string | null } | null, pv: ReturnType<typeof G.proefView>) {
  const proef = !a.hosting || !!pv?.actief;
  const tekst = proef ? `€ 0 per maand tot je starttegoed op is; daarna ${G.naTekst(na)} voor de server (zonder btw)`
    : a.hosting?.monthly != null ? `Ongeveer ${G.euro(a.hosting.monthly)} per maand voor de server (zonder btw)` : "Wat de server kost, zegt deze aanbieder niet vooraf";
  const regels = [
    ...(a.backup?.provider === "scaleway" || (!a.backup && pv?.provider !== "exoscale") ? [`Back-ups bij Scaleway: ${G.BACKUP_KOSTEN}.`] : []),
    `Mail: ${G.MAIL_KOSTEN}.`,
    "Scaleway en Mollie: geen vaste kosten. Je betaalt per betaling en wat je klanten gebruiken; dat zit in je prijzen.",
  ];
  return { tekst, na: proef ? na : null, regels, buiten: "Buiten de app: je bedrijf inschrijven bij de KvK kost eenmalig een bedrag; Mollie werkt alleen met een ingeschreven bedrijf." };
}

/** De aanbieders met starttegoed, met wat ze zeggen en de velden voor de sleutel. */
function proefAanbieders(offers: () => ServerOffer[]) {
  const list = offers();
  return G.PROEF_IDS.map((id) => {
    const o = list.find((x) => x.id === id);
    const p = G.PROEF[id];
    return { id, naam: p.naam, aanmelden: p.aanmelden, wat: p.wat, tijdens: p.tijdens, einde: p.einde, backup: p.backupUitleg, bron: p.bron, keyHelp: o?.keyHelp ?? "", fields: o?.fields ?? [] };
  });
}

// ───────── Scaleway: één sleutel, de app regelt de rest ─────────

export const SCW_APP = "eigen-cloud-dienst";
/**
 * De rechten van de Dienst (scaleway.com/en/docs/iam/policies-permissions/permission-sets/, bron in
 * github.com/scaleway/docs-content): ProjectManager en IAMManager gelden voor de organisatie ("Scoped by Organization");
 * InstancesFullAccess, ObjectStorageFullAccess en TransactionalEmailFullAccess voor projecten ("Scoped by Project"). Een
 * regel heeft óf project_ids óf organization_id (scaleway-sdk-go RuleSpecs); `organization_id` bij een projectrecht = alle
 * projecten van de organisatie (Terraform scaleway_iam_policy: "this can be used to create a rule for all projects in an
 * organization"). Met IAMManager kan de Dienst zijn klanten rechten geven die hij zelf niet heeft (bijv.
 * BlockStorageFullAccess, SCW_PERMISSION_SETS in src/broker/config.ts).
 */
export const SCW_RULES = (org: string) => [
  { permission_set_names: ["ProjectManager", "IAMManager"], organization_id: org },
  { permission_set_names: ["InstancesFullAccess", "ObjectStorageFullAccess", "TransactionalEmailFullAccess"], organization_id: org },
];
export const SCW_IAM_URL = "https://console.scaleway.com/iam/api-keys";

/** Hebben de regels van de policy (GET /iam/v1alpha1/rules) alle rechten, voor de hele organisatie? */
function rulesOk(rules: any[], org: string) {
  const have = new Set<string>();
  for (const r of rules ?? []) if (r?.organization_id === org) for (const n of r.permission_set_names ?? []) have.add(String(n));
  return SCW_RULES(org).every((r) => r.permission_set_names.every((n) => have.has(n)));
}

/**
 * Met één persoonlijke sleutel van Scaleway (toegangssleutel + geheime sleutel) alles klaarzetten. IAM-API
 * (github.com/scaleway/scaleway-sdk-go api/iam/v1alpha1/iam_sdk.go, nagekeken 12-10-2026): GET /api-keys/{access_key}
 * (user_id of application_id, default_project_id), GET /users/{id} of /applications/{id} (organization_id),
 * GET /applications?organization_id=&name=, POST /applications, GET /policies?organization_id=&application_ids=,
 * POST /policies {rules}, GET /rules?policy_id=, PUT /rules {policy_id, rules}, POST /api-keys {application_id,
 * default_project_id, description}, DELETE /api-keys/{access_key}. Opnieuw proberen maakt niets dubbel.
 */
export async function scaleway(c: AdminConfig, b: { accessKey?: string; secretKey?: string; verwijderen?: boolean }, deps: Pick<NodigDeps, "save" | "sleep">) {
  const a = aan.intern.state(c) as A;
  const steps: Step[] = [];
  const { accessKey, secretKey } = scwKeys(b);
  try {
    let k: any;
    try { k = await scw("GET", `/iam/v1alpha1/api-keys/${encodeURIComponent(accessKey)}`, secretKey); }
    catch (e) {
      const s = (e as { status?: number }).status;
      if (s === 403 || s === 404) throw new Error("Deze sleutel kan zichzelf niet bekijken. Maak de sleutel aan voor jezelf (IAM → API-sleutels → 'Mezelf'), als eigenaar van de organisatie.");
      throw e;
    }
    if (k?.secret_key && k.secret_key !== secretKey) throw new Error("Deze geheime sleutel hoort niet bij deze toegangssleutel");
    const owner = k?.user_id ? await scw("GET", `/iam/v1alpha1/users/${encodeURIComponent(k.user_id)}`, secretKey)
      : k?.application_id ? await scw("GET", `/iam/v1alpha1/applications/${encodeURIComponent(k.application_id)}`, secretKey) : null;
    const org = String(owner?.organization_id ?? "");
    if (!UUID.test(org)) throw new Error("Kon de organisatie van deze sleutel niet vinden");
    steps.push({ label: "Je sleutel werkt", ok: true, detail: `Organisatie ${org}` });
    const st = (a.scw = a.scw?.org === org ? a.scw : { org });
    const q = encodeURIComponent(org);
    // De applicatie van de Dienst (bestaat hij al, dan die).
    if (!st.applicationId) {
      const list = await scw("GET", `/iam/v1alpha1/applications?organization_id=${q}&name=${SCW_APP}`, secretKey);
      st.applicationId = (list?.applications ?? []).find((x: { name: string }) => x.name === SCW_APP)?.id
        ?? (await scw("POST", "/iam/v1alpha1/applications", secretKey, { name: SCW_APP, organization_id: org, description: "Eigen Cloud Dienst: klantprojecten, sleutels, servers, opslag en mail" }))?.id;
      if (!st.applicationId) throw new Error("Scaleway gaf geen applicatie-id terug");
      deps.save();
    }
    steps.push({ label: `Applicatie ${SCW_APP}`, ok: true });
    // De policy met precies de rechten van de Dienst.
    if (!st.policyId) {
      const list = await scw("GET", `/iam/v1alpha1/policies?organization_id=${q}&application_ids=${encodeURIComponent(st.applicationId)}`, secretKey);
      st.policyId = (list?.policies ?? []).find((p: { application_id?: string }) => p.application_id === st.applicationId)?.id;
      if (!st.policyId) {
        st.policyId = (await scw("POST", "/iam/v1alpha1/policies", secretKey, { name: SCW_APP, description: "Rechten van de Eigen Cloud Dienst", organization_id: org, application_id: st.applicationId, rules: SCW_RULES(org) }))?.id;
        if (!st.policyId) throw new Error("Scaleway gaf geen policy-id terug");
      }
      deps.save();
    }
    const rules = await scw("GET", `/iam/v1alpha1/rules?policy_id=${encodeURIComponent(st.policyId)}`, secretKey);
    if (!rulesOk(rules?.rules ?? [], org)) await scw("PUT", "/iam/v1alpha1/rules", secretKey, { policy_id: st.policyId, rules: SCW_RULES(org) });
    steps.push({ label: "Rechten: projecten, sleutels, servers, opslag en mail", ok: true });
    // Een sleutel voor de applicatie (een werkende bewaarde houden we).
    const acc = (a.accounts ??= {});
    let reuse = false;
    if (st.accessKey && acc.scalewaySecretKey && acc.scalewayOrgId === org) {
      reuse = await scw("GET", `/iam/v1alpha1/api-keys/${encodeURIComponent(st.accessKey)}`, secretKey).then((x) => x?.application_id === st.applicationId, () => false);
    }
    if (!reuse) {
      const nk = await scw("POST", "/iam/v1alpha1/api-keys", secretKey, { application_id: st.applicationId, description: "Eigen Cloud Dienst (gemaakt door de app)", ...(k?.default_project_id ? { default_project_id: k.default_project_id } : {}) });
      if (!nk?.access_key || !nk?.secret_key) throw new Error("Scaleway gaf geen sleutel terug");
      st.accessKey = nk.access_key;
      acc.scalewaySecretKey = nk.secret_key;
      acc.scalewayOrgId = org;
      deps.save();
    }
    // Een nieuwe sleutel werkt soms pas na een paar seconden.
    let works = false;
    for (let i = 0; i < 5 && !works; i++) {
      if (i) await (deps.sleep ?? sleep0)(3000);
      works = (await aan.intern.checkScaleway(acc.scalewaySecretKey!, org)).ok;
    }
    (a.checked ??= {}).scaleway = works;
    if (!works) throw new Error("De nieuwe sleutel werkt nog niet. Probeer het over een minuut opnieuw; wat al klaarstaat, blijft staan.");
    steps.push({ label: "Eigen sleutel voor je Dienst", ok: true, detail: reuse ? "Bestond al en werkt" : "Gemaakt en gecontroleerd" });
    // De geplakte persoonlijke sleutel weggooien (met toestemming; standaard aan).
    let verwijderd = false;
    if (k?.user_id && accessKey !== st.accessKey) {
      if (b.verwijderen !== false) {
        const del = (key: string) => scw("DELETE", `/iam/v1alpha1/api-keys/${encodeURIComponent(accessKey)}`, key).then(() => true, (e) => (e as { status?: number }).status === 404);
        verwijderd = (await del(acc.scalewaySecretKey!)) || (await del(secretKey));
        steps.push(verwijderd ? { label: "Je eigen sleutel is weggegooid", ok: true }
          : { label: "Je eigen sleutel weggooien lukte niet", ok: false, detail: "Gooi hem zelf weg in de Scaleway-console (IAM → API-sleutels)" });
      } else steps.push({ label: "Je eigen sleutel blijft bestaan", ok: true, detail: "Gooi hem weg in de Scaleway-console als je hem niet meer nodig hebt" });
      st.personal = { accessKey: mask(accessKey), deleted: verwijderd };
    }
    deps.save();
    return { ok: true, steps, org, applicatie: SCW_APP, verwijderd };
  } catch (e) {
    deps.save();
    throw fail((e as Error).message, steps);
  }
}

// ───────── Mollie ─────────

/** Mollie-dashboard (zonder link uit het profiel), API-sleutels en aanmelden. */
export const MOLLIE_LINKS = { dashboard: "https://my.mollie.com/dashboard", sleutels: "https://my.mollie.com/dashboard/developers/api-keys", aanmelden: "https://my.mollie.com/dashboard/signup" };

/**
 * De Mollie-sleutel controleren en uitlezen wat er nog moet. Met een API-sleutel kan (docs.mollie.com, en de officiële
 * client github.com/mollie/mollie-api-node): GET /v2/profiles/me (naam, website, status unverified/verified/blocked,
 * _links.dashboard) en GET /v2/methods?sequenceType=first|recurring (welke methoden aan staan voor een eerste betaling
 * met machtiging en voor de maandelijkse incasso). De voortgang van de aanmelding (GET /v2/onboarding/me) vraagt een
 * OAuth- of organisatietoken; die leest de app dus niet.
 */
export async function mollie(c: AdminConfig, b: { key?: string }) {
  const a = aan.intern.state(c) as A;
  const acc = (a.accounts ??= {});
  if (b.key !== undefined && b.key !== null && !String(b.key).startsWith("••")) {
    const v = String(b.key).trim();
    if (!/^(test|live)_[A-Za-z0-9]+$/.test(v)) throw new Error("Een Mollie-sleutel begint met test_ of live_");
    acc.mollieKey = v;
  }
  const key = acc.mollieKey;
  if (!key) throw new Error("Vul je Mollie-sleutel in");
  const h = { authorization: `Bearer ${key}` };
  const prof = await getJson(`${aan.MOLLIE_URL()}/profiles/me`, h, 15_000);
  (a.checked ??= {}).mollie = prof.status === 200;
  if (prof.status === 401 || prof.status === 403) throw new Error("Mollie accepteert deze sleutel niet");
  if (prof.status !== 200) throw new Error(prof.status ? `Mollie antwoordt ${prof.status}` : "Mollie is niet bereikbaar");
  const ids = async (seq: string) => (((await getJson(`${aan.MOLLIE_URL()}/methods?sequenceType=${seq}`, h, 15_000)).json?._embedded?.methods ?? []) as { id: string }[]).map((m) => String(m.id));
  const [eerste, terugkerend] = await Promise.all([ids("first"), ids("recurring")]);
  const mode: "test" | "live" = key.startsWith("live_") ? "live" : "test";
  const p = prof.json ?? {};
  const dashboard = typeof p?._links?.dashboard?.href === "string" ? p._links.dashboard.href : MOLLIE_LINKS.dashboard;
  const todo: MollieInfo["todo"] = [];
  if (p.status === "blocked") todo.push({ tekst: "Je Mollie-profiel is geblokkeerd. Neem contact op met Mollie.", link: dashboard });
  else if (mode === "live" && p.status !== "verified") todo.push({ tekst: "Mollie heeft je account nog niet goedgekeurd. Rond de aanmelding af in je Mollie-dashboard.", link: dashboard });
  if (!eerste.includes("ideal")) todo.push({ tekst: "iDEAL staat nog niet aan: zet het aan in je Mollie-dashboard.", link: dashboard });
  if (!terugkerend.includes("directdebit")) todo.push({ tekst: "SEPA-incasso staat nog niet aan: zet het aan in je Mollie-dashboard. Dat is nodig voor de maandelijkse betaling.", link: dashboard });
  const info: MollieInfo = { at: Date.now(), mode, profiel: { naam: String(p.name ?? ""), website: String(p.website ?? ""), status: String(p.status ?? "") }, methoden: { eerste, terugkerend }, todo };
  a.mollie = info;
  return {
    ok: true, mode, profiel: info.profiel, methoden: info.methoden, todo,
    test: mode === "test" ? "Je gebruikt de testsleutel: betalingen zijn nep. Zet de live-sleutel erin zodra Mollie je account heeft goedgekeurd; daarna Wijzigingen toepassen." : null,
    links: { ...MOLLIE_LINKS, dashboard },
    onboarding: "Hoe ver je aanmelding bij Mollie is, laat Mollie alleen aan gekoppelde apps zien (OAuth); kijk daarvoor in je Mollie-dashboard.",
    pending: !!a.server,
  };
}

// ───────── deSEC: account en tokens ─────────

/** Een deSEC-account voor de Dienst (POST /auth/, desec.readthedocs.io/en/latest/auth/account.html); de mail bevestigt het. */
export async function desecRegister(c: AdminConfig, b: { captchaId?: string; solution?: string; email?: string }) {
  const a = aan.intern.state(c) as A;
  const email = String(b.email || a.company?.email || c.console.alertEmail || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new Error("Vul een e-mailadres in voor het deSEC-account");
  const password = crypto.randomBytes(18).toString("base64url");
  let r: Response;
  try {
    r = await fetch(`${DESEC_URL()}/auth/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, captcha: { id: b.captchaId, solution: String(b.solution ?? "").trim() }, outreach_preference: false }), signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error("deSEC is niet bereikbaar"); }
  if (r.status !== 202 && !r.ok) throw new Error(desecError(await r.json().catch(() => null)));
  a.desecAccount = { email, password, at: Date.now() };
  return { ok: true, email };
}

async function desecPost(path: string, token: string, body: unknown) {
  const r = await fetch(`${DESEC_URL()}${path}`, { method: "POST", headers: { authorization: `Token ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null) as any;
  if (!r.ok) throw new Error(desecError(j));
  return j;
}

/**
 * Na het klikken op de bevestigingslink: inloggen (POST /auth/login/) en tokens maken (POST /auth/tokens/,
 * desec.readthedocs.io/en/latest/auth/tokens.html): voor de Dienst een token dat zones mag maken en weghalen
 * (perm_create_domain, perm_delete_domain), en met `adressen` ook een token voor de adressendienst dat ook tokens mag
 * beheren (perm_manage_tokens). `pending` = nog niet bevestigd.
 */
export async function desecFinish(c: AdminConfig, b: { adressen?: boolean }) {
  const a = aan.intern.state(c) as A;
  const acc = a.desecAccount;
  if (!acc) throw new Error("Maak eerst het deSEC-account aan");
  let login: Response;
  try {
    login = await fetch(`${DESEC_URL()}/auth/login/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: acc.email, password: acc.password }), signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error("deSEC is niet bereikbaar"); }
  if (login.status === 401 || login.status === 403) {
    if (Date.now() - acc.at > 12 * 3_600_000) throw new Error("De bevestigingslink is verlopen. Maak het account opnieuw aan.");
    return { ok: false, pending: true, email: acc.email, tokens: [] as string[] };
  }
  const lt = (await login.json().catch(() => null) as any)?.token;
  if (!login.ok || !lt) throw new Error("Inloggen bij deSEC mislukt");
  const made: string[] = [];
  const accounts = (a.accounts ??= {});
  if (!accounts.desecToken) {
    const t = await desecPost("/auth/tokens/", lt, { name: "eigen-cloud-dienst", perm_create_domain: true, perm_delete_domain: true, perm_manage_tokens: false });
    if (!t?.token) throw new Error("Token maken bij deSEC mislukt");
    accounts.desecToken = t.token;
    acc.tokenId = t.id;
    made.push("dienst");
  }
  if (b.adressen && !acc.adressenToken) {
    const t = await desecPost("/auth/tokens/", lt, { name: "eigen-cloud-adressen", perm_create_domain: true, perm_delete_domain: true, perm_manage_tokens: true });
    if (!t?.token) throw new Error("Token voor de adressendienst maken bij deSEC mislukt");
    acc.adressenToken = t.token;
    acc.adressenTokenId = t.id;
    if (a.adressen) a.adressen.desecToken = t.token;
    made.push("adressen");
  }
  (a.checked ??= {}).desec = (await aan.intern.checkDesec(accounts.desecToken!)).ok;
  return { ok: true, pending: false, email: acc.email, tokens: made };
}

// ───────── Domein en DNS ─────────

type Voor = "dienst" | "adressen";
const opOf = (a: A) => (a.accounts?.openproviderUser && a.accounts.openproviderPass ? new OpenproviderApi({ username: a.accounts.openproviderUser, password: a.accounts.openproviderPass }) : null);

/** Om welk domein het gaat en waar de DNS moet staan (de DNS-koppeling van de Dienst, of deSEC voor de gedeelde zone). */
function doel(c: AdminConfig, a: A, b: { voor?: string; zone?: string }) {
  const voor: Voor = b.voor === "adressen" ? "adressen" : "dienst";
  const raw = String(b.zone ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/.]+$/, "");
  const zone = raw || (voor === "adressen" ? a.adressen?.zone : a.dns?.zone ?? aan.defaultZone(hostOf(a.url))) || "";
  if (!ZONE.test(zone)) throw new Error(voor === "adressen" ? "Vul de gedeelde zone in, zoals eigencloud.nl" : "Kies eerst het adres van je Dienst");
  const target = voor === "adressen" ? { id: "desec", naam: "deSEC", nameservers: [...DESEC_NS] }
    : a.dns && a.dns.zone === zone ? { id: a.dns.provider, naam: aan.intern.dnsName(a.dns.provider), nameservers: a.dns.nameservers ?? [] } : null;
  const token = voor === "adressen" ? a.adressen?.desecToken ?? a.desecAccount?.adressenToken : a.dns?.provider === "desec" ? a.dns.fields.token : undefined;
  return { voor, zone, target, token };
}

/** De DNSSEC-sleutels van een zone bij deSEC (GET /domains/{zone}/ → keys[].dnskey en .ds); [] als dat niet lukt. */
async function desecKeys(zone: string, token?: string) {
  if (!token) return { dnskeys: [] as string[], ds: [] as string[] };
  const r = await getJson(`${DESEC_URL()}/domains/${encodeURIComponent(zone)}/`, { authorization: `Token ${token}` }, 15_000);
  const keys = (r.json?.keys ?? []) as { dnskey?: string; ds?: string[] }[];
  return { dnskeys: keys.map((k) => String(k.dnskey ?? "")).filter(Boolean), ds: keys.flatMap((k) => k.ds ?? []).map(String) };
}

/** Het domein bij Openprovider (GET /domains?full_name=), of null. */
async function opDomain(op: OpenproviderApi, zone: string) {
  const j = await op.req("GET", `/domains?full_name=${encodeURIComponent(zone)}&limit=1`);
  const d = ((j?.data?.results ?? []) as any[]).find((x) => `${x.domain?.name}.${x.domain?.extension}` === zone || x.full_name === zone);
  return d ? { id: Number(d.id), nameservers: ((d.name_servers ?? []) as { name?: string }[]).map((n) => String(n.name ?? "").toLowerCase()).filter(Boolean) } : null;
}

/**
 * Vrij en de prijs (POST /domains/check met with_price → data.results[0]: status free/active, price.reseller/product,
 * is_premium); de prijs zonder btw, zoals Openprovider hem rekent. Een premium-domein heeft een andere prijs
 * (premium.price.create): dat koopt de app niet, daarvoor geeft hij geen prijs.
 */
async function opCheckDomain(op: OpenproviderApi, zone: string) {
  const j = await op.req("POST", "/domains/check", { domains: [splitDomain(zone)], with_price: true });
  const res = (Array.isArray(j?.data) ? j.data[0] : j?.data?.results?.[0]) ?? {};
  const premium = res.is_premium === true;
  const p = premium ? null : res.price?.reseller ?? res.price?.product ?? null;
  return { vrij: res.status === "free", premium, prijs: p && p.price !== undefined && p.price !== null ? { valuta: String(p.currency ?? "EUR"), bedrag: Number(p.price).toFixed(2) } : null };
}

/**
 * Waar staat de DNS van het domein, en staat hij waar hij moet staan? Nameservers via DoH (doh.ts). Met Openprovider
 * erbij ook: staat het domein in je Openprovider-account (dan kan de app de nameservers goedzetten), of is het nog vrij
 * en wat kost het.
 */
export async function domein(c: AdminConfig, b: { voor?: string; zone?: string }) {
  const a = (aan.intern.existing(c) ?? { step: "bedrijf" }) as A;
  const { voor, zone, target, token } = doel(c, a, b);
  const ns = await dohLookup(zone, "NS");
  const registered = ns === null ? null : ns.values.length > 0 ? true : ns.rcode === 3 ? false : null;
  const bij = ns ? nsProvider(ns.values) : null;
  const goed = target && ns ? (target.nameservers.length ? nsMatch(ns.values, target.nameservers) : null) : null;
  const keys = target?.id === "desec" ? await desecKeys(zone, token) : { dnskeys: [], ds: [] };
  const dsNu = keys.ds.length ? await dohLookup(zone, "DS") : null;
  const dnssec = keys.ds.length ? !!dsNu && dsNu.values.some((v) => keys.ds.map((x) => x.toLowerCase()).includes(v)) : null;
  const op = opOf(a);
  let opInfo: { gekoppeld: boolean; domeinId: number | null; vrij: boolean | null; premium: boolean; prijs: { valuta: string; bedrag: string } | null; fout: string | null } = { gekoppeld: !!op, domeinId: null, vrij: null, premium: false, prijs: null, fout: null };
  if (op) {
    try {
      const d = await opDomain(op, zone);
      opInfo = { ...opInfo, domeinId: d?.id ?? null };
      if (!d && registered !== true) opInfo = { ...opInfo, ...(await opCheckDomain(op, zone)) };
    } catch (e) { opInfo = { ...opInfo, fout: (e as Error).message }; }
  }
  const kanDelegeren = !!(op && opInfo.domeinId && target && target.nameservers.length && (goed === false || (dnssec === false)));
  let uitleg: string | null = null;
  if (registered === false) {
    uitleg = opInfo.vrij && opInfo.premium ? `${zone} is nog vrij, maar het is een premium-domein met een hogere prijs. Koop het als je wilt in het controlepaneel van Openprovider.`
      : opInfo.vrij && opInfo.prijs ? `${zone} is nog vrij. Je kunt het hieronder kopen bij Openprovider.`
      : `${zone} lijkt nog niet geregistreerd. Koop het bij een registrar naar keuze, bijvoorbeeld Openprovider.`;
  }
  else if (target && goed === false) {
    uitleg = `Log in bij de partij waar je ${zone} hebt gekocht${bij ? ` (de DNS staat nu bij ${bij})` : ""}, zoek de nameservers van het domein en vervang ze door ${target.nameservers.join(" en ")}.`
      + (keys.ds.length ? " Zet daar ook DNSSEC aan met de DS-gegevens hieronder." : "") + " Het kan een paar uur duren voordat iedereen het ziet.";
  } else if (dnssec === false) uitleg = `De nameservers kloppen. Zet bij de partij waar je ${zone} hebt gekocht nog DNSSEC aan met de DS-gegevens hieronder.`;
  return {
    zone, voor, geregistreerd: registered, nameservers: ns?.values ?? [], bij, doel: target, goed, ds: keys.ds, dnssec,
    openprovider: opInfo, kanDelegeren, uitleg,
  };
}

/**
 * Nameservers (en bij deSEC de DNSSEC-sleutels) zetten bij Openprovider: PUT /domains/{id} met name_servers,
 * is_dnssec_enabled en dnssec_keys. Voor de gedeelde zone van de adressendienst maakt de app de zone bij deSEC eerst aan.
 */
export async function delegeren(c: AdminConfig, b: { voor?: string; zone?: string }, deps: Pick<NodigDeps, "save">) {
  const a = aan.intern.state(c) as A;
  const { zone, target, token, voor } = doel(c, a, b);
  const op = opOf(a);
  if (!op) throw new Error("Koppel eerst Openprovider");
  if (!target?.nameservers.length) throw new Error("Kies eerst wie de DNS van dit domein doet");
  const steps: Step[] = [];
  try {
    if (voor === "adressen") {
      if (!token) throw new Error("Er is nog geen deSEC-token voor de adressendienst");
      await getAdapter("desec")!.dns!.connect({ token }, zone);
      steps.push({ label: `${zone} staat bij deSEC`, ok: true });
    }
    const d = await opDomain(op, zone);
    if (!d) throw new Error(`${zone} staat niet in je Openprovider-account`);
    const keys = target.id === "desec" ? (await desecKeys(zone, token)).dnskeys.map(parseDnskey).filter(Boolean) : [];
    await op.req("PUT", `/domains/${d.id}`, { name_servers: target.nameservers.map((name) => ({ name })), ...(keys.length ? { is_dnssec_enabled: true, dnssec_keys: keys } : {}) });
    steps.push({ label: `Nameservers op ${target.naam} gezet`, ok: true, detail: target.nameservers.join(", ") });
    if (keys.length) steps.push({ label: "DNSSEC aangezet", ok: true });
    deps.save();
    return { ok: true, steps };
  } catch (e) { throw fail((e as Error).message, steps); }
}

export interface Houder { voornaam?: string; achternaam?: string; straat?: string; huisnummer?: string; postcode?: string; plaats?: string; land?: string; telefoon?: string; email?: string; bedrijf?: string }

/**
 * Een domein kopen bij Openprovider (eigen account van de aanbieder). Alleen met `akkoord` en de prijs die de app liet
 * zien; is die intussen anders, dan eerst opnieuw bevestigen. Houder: de klant-handle van de aanbieder (eerder gemaakt
 * of op e-mailadres gevonden), anders een nieuwe met de ingevulde gegevens (POST /customers, zoals de Dienst doet).
 */
export async function kopen(c: AdminConfig, b: { voor?: string; zone?: string; prijs?: string; akkoord?: boolean; houder?: Houder }, deps: Pick<NodigDeps, "save">) {
  const a = aan.intern.state(c) as A;
  const { zone, target, token, voor } = doel(c, a, b);
  const op = opOf(a);
  if (!op) throw new Error("Koppel eerst Openprovider");
  if (b.akkoord !== true) throw new Error("Bevestig eerst dat je het domein wilt kopen");
  const steps: Step[] = [];
  try {
    const chk = await opCheckDomain(op, zone);
    if (!chk.vrij) throw new Error(`${zone} is niet (meer) vrij`);
    if (chk.premium) throw new Error(`${zone} is een premium-domein met een andere prijs. Koop het in het controlepaneel van Openprovider.`);
    if (!chk.prijs || chk.prijs.bedrag !== String(b.prijs ?? "")) throw new Error(`De prijs is veranderd: nu ${chk.prijs ? `€ ${chk.prijs.bedrag.replace(".", ",")}` : "onbekend"} per jaar. Kijk opnieuw en bevestig.`);
    let handle = a.opHandle;
    const email = String(b.houder?.email || a.company?.email || "").trim().toLowerCase();
    if (!handle && email) {
      const j = await op.req("GET", `/customers?email_pattern=${encodeURIComponent(email)}&limit=1`);
      handle = j?.data?.results?.[0]?.handle;
    }
    if (!handle) {
      const h = b.houder ?? {};
      const need: [keyof Houder, string][] = [["voornaam", "voornaam"], ["achternaam", "achternaam"], ["straat", "straat"], ["huisnummer", "huisnummer"], ["postcode", "postcode"], ["plaats", "plaats"], ["telefoon", "telefoonnummer"]];
      const missing = need.filter(([k]) => !String(h[k] ?? "").trim()).map(([, l]) => l);
      if (missing.length) throw new Error(`Vul de gegevens van de houder in: ${missing.join(", ")}`);
      const phone = parsePhone(String(h.telefoon));
      if (!phone) throw new Error("Het telefoonnummer klopt niet; schrijf het als +31 6 12345678");
      const first = String(h.voornaam).trim();
      const initials = `${first.split(/\s+/).map((p) => p[0]?.toUpperCase()).filter(Boolean).join(".")}.`;
      const r = await op.req("POST", "/customers", {
        name: { first_name: first, last_name: String(h.achternaam).trim(), initials },
        address: { street: String(h.straat).trim(), number: String(h.huisnummer).trim(), zipcode: String(h.postcode).trim(), city: String(h.plaats).trim(), country: String(h.land || "NL").trim().toUpperCase() },
        phone, email, ...(h.bedrijf || a.company?.name ? { company_name: String(h.bedrijf || a.company?.name) } : {}),
      });
      handle = r?.data?.handle;
      if (!handle) throw new Error("Openprovider gaf geen houder terug");
      steps.push({ label: "Houder aangemaakt bij Openprovider", ok: true, detail: handle });
    }
    a.opHandle = handle;
    deps.save();
    if (voor === "adressen" && token) await getAdapter("desec")!.dns!.connect({ token }, zone);
    const keys = target?.id === "desec" ? (await desecKeys(zone, token)).dnskeys.map(parseDnskey).filter(Boolean) : [];
    const d = await op.req("POST", "/domains", {
      domain: splitDomain(zone), period: 1, autorenew: "on",
      owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle,
      ...(target?.nameservers.length ? { name_servers: target.nameservers.map((name) => ({ name })) } : {}),
      ...(keys.length ? { is_dnssec_enabled: true, dnssec_keys: keys } : {}),
    });
    const id = d?.data?.id;
    if (!id) throw new Error("Openprovider gaf geen domein-id terug");
    steps.push({ label: `${zone} gekocht`, ok: true, detail: `€ ${chk.prijs.bedrag.replace(".", ",")} per jaar, verlengt elk jaar vanzelf` });
    deps.save();
    return { ok: true, steps, zone, id: Number(id) };
  } catch (e) { throw fail((e as Error).message, steps); }
}

// ───────── Mail van de Dienst ─────────

/** SMTP van Scaleway TEM (scaleway.com/en/docs/transactional-email/reference-content/smtp-configuration/). Tests: EIGEN_TEM_SMTP. */
export const temSmtp = () => process.env.EIGEN_TEM_SMTP || "smtp.tem.scaleway.com:587";
/** Mail via de HTTPS-koppeling van Scaleway TEM: scwtem://<project-id>:<sleutel>@fr-par (src/broker/mail.ts). */
export const TEM_API_SCHEME = "scwtem:";

/** Zet de mailrecords bij de eigen DNS-koppeling (als het maildomein onder die zone valt); anders blijven ze voor jou. */
async function publishMail(a: A, recs: MailRec[]) {
  const d = a.dns;
  if (!d) return recs;
  const ad = getAdapter(d.provider);
  const dns = ad?.dns?.create("dienst-mail", d.fields, d.zone);
  const out: MailRec[] = [];
  for (const r of recs) {
    const sub = r.naam === d.zone ? "" : r.naam.endsWith(`.${d.zone}`) ? r.naam.slice(0, -(d.zone.length + 1)) : null;
    let gezet = false;
    if (dns && sub !== null) { try { await dns.setRecords(sub, "TXT", [txtRecord(r.waarde)], 3600); gezet = true; } catch { gezet = false; } }
    out.push({ ...r, gezet });
  }
  return out;
}

/** Wat de console over de mail laat zien (zonder wachtwoord). */
function mailView(c: AdminConfig, a: A) {
  const m = a.mail;
  const smtp = aan.intern.smtpOf(c, a);
  return {
    manier: m?.manier ?? (a.accounts?.smtpUrl ? "smtp" : c.console.mailRelay ? "cloud" : null),
    domein: m?.domein ?? null, status: m?.status ?? null, records: m?.records ?? [],
    smtp: aan.smtpDisplay(smtp), afzender: a.accounts?.mailFrom ?? null, werkt: a.checked?.smtp === true,
    cloudRelay: !!c.console.mailRelay, pending: !!a.server,
  };
}

/**
 * De mail van de Dienst regelen. `scaleway`: het adres van de Dienst (dienst.jouwbedrijf.nl) als maildomein bij Scaleway
 * Transactional Email in het project eigen-cloud-dienst (POST/GET …/domains, …/check), SPF, DKIM en DMARC via de
 * DNS-koppeling (alleen namen onder dat adres, zodat de mail van je eigen domein niet verandert), en de SMTP-instellingen
 * (gebruiker = project-ID, wachtwoord = de sleutel van de Dienst). `cloud`: via de mail van je eigen cloud. `smtp`: een
 * eigen mailserver.
 */
export async function mail(c: AdminConfig, b: { manier?: string; smtpUrl?: string; mailFrom?: string }, deps: Pick<NodigDeps, "save">) {
  const a = aan.intern.state(c) as A;
  const acc = (a.accounts ??= {});
  const ch = (a.checked ??= {});
  if (b.manier === "cloud") {
    if (!c.console.mailRelay) throw new Error("Je eigen cloud verstuurt nog geen mail");
    delete acc.smtpUrl;
    a.mail = { manier: "cloud" };
    ch.smtp = (await aan.intern.checkSmtp(c.console.mailRelay)).ok;
    deps.save();
    return mailView(c, a);
  }
  if (b.manier === "smtp") {
    const url = String(b.smtpUrl ?? "").trim();
    if (!url && !acc.smtpUrl) throw new Error("Vul een mailserver in, bijv. smtp://gebruiker:wachtwoord@server:587");
    if (url) acc.smtpUrl = url;
    if (b.mailFrom !== undefined && String(b.mailFrom).trim()) {
      const f = String(b.mailFrom).trim();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f)) throw new Error("Het afzenderadres is geen geldig e-mailadres");
      acc.mailFrom = f;
    }
    a.mail = { manier: "smtp" };
    const chk = await aan.intern.checkSmtp(acc.smtpUrl!);
    ch.smtp = chk.ok;
    deps.save();
    return { ...mailView(c, a), detail: chk.detail };
  }
  if (b.manier !== "scaleway") throw new Error("Kies hoe je Dienst mail verstuurt");
  const key = acc.scalewaySecretKey, org = acc.scalewayOrgId;
  if (!key || !org || ch.scaleway !== true) throw new Error("Regel eerst Scaleway (hierboven): de mail gaat met dezelfde sleutel");
  const host = hostOf(a.url);
  if (!host) throw new Error("Kies eerst het adres van je Dienst");
  const projectId = await aan.intern.ensureProject(a, key, org);
  deps.save();
  const dom = await temDomain(key, projectId, host, a.mail?.domein === host ? a.mail.temDomainId : undefined);
  const rec = temRecords(dom, projectId);
  const want: MailRec[] = [
    { naam: host, type: "TXT", waarde: `v=spf1 ${rec.spfExtra || "include:_spf.tem.scaleway.com"} -all`, gezet: false },
    ...(rec.dkim ? [{ naam: rec.dkim.name.replace(/\.$/, "").endsWith(host) ? rec.dkim.name.replace(/\.$/, "") : `${rec.dkim.name}.${host}`, type: "TXT" as const, waarde: rec.dkim.value, gezet: false }] : []),
    { naam: `_dmarc.${host}`, type: "TXT", waarde: rec.dmarc?.value ?? "v=DMARC1; p=none", gezet: false },
  ];
  const records = await publishMail(a, want);
  // Zo gratis mogelijk: via de HTTPS-koppeling van Scaleway (scwtem://, zie src/broker/mail.ts). Een proefserver (UpCloud)
  // laat naar buiten alleen de webpoorten toe; SMTP kan daar niet. Standaard: SMTP zoals altijd.
  const url = G.modus(c) === "gratis" ? `${TEM_API_SCHEME}//${encodeURIComponent(projectId)}:${encodeURIComponent(key)}@fr-par`
    : `smtp://${encodeURIComponent(projectId)}:${encodeURIComponent(key)}@${temSmtp()}`;
  acc.smtpUrl = url;
  acc.mailFrom = `noreply@${host}`;
  await scw("POST", `${TEM_DOMAINS}/${dom.id}/check`, key, {}).catch(() => null);
  a.mail = { manier: "scaleway", domein: host, projectId, temDomainId: dom.id, status: String(dom.status ?? ""), records, checkAt: Date.now(), at: Date.now() };
  ch.smtp = (await aan.intern.checkSmtp(url)).ok;
  deps.save();
  return mailView(c, a);
}

/** De mail nog eens nagaan: bij Scaleway de status van het maildomein (en hooguit eens per 5 minuten opnieuw laten controleren). */
export async function mailStatus(c: AdminConfig, deps: Pick<NodigDeps, "save">) {
  const a = (aan.intern.existing(c) ?? { step: "bedrijf" }) as A;
  const m = a.mail, key = a.accounts?.scalewaySecretKey;
  if (m?.manier === "scaleway" && m.temDomainId && key) {
    try {
      const dom = await scw("GET", `${TEM_DOMAINS}/${m.temDomainId}`, key);
      m.status = String(dom?.status ?? m.status ?? "");
      if (m.status !== "checked" && Date.now() - (m.checkAt ?? 0) > 5 * 60_000) {
        m.checkAt = Date.now();
        await scw("POST", `${TEM_DOMAINS}/${m.temDomainId}/check`, key, {}).catch(() => null);
      }
      deps.save();
    } catch { /* volgende keer */ }
  }
  return mailView(c, a);
}

// ───────── Openprovider: IP-adres van de server ─────────

export const OP_PANEL_URL = "https://cp.openprovider.eu";

/** De controle vanaf de server van de Dienst (GET /v1/status/check/openprovider met het beheertoken). */
async function dienstOpCheck(a: A) {
  if (!a.server || !a.url || !a.secret) return null;
  const r = await getJson(`${reach(a.url)}/v1/status/check/openprovider`, { authorization: `Beheer ${aan.beheerToken(a.secret)}` }, 20_000);
  if (r.status === 404) return { at: Date.now(), ok: false, detail: "Je Dienst kent deze controle nog niet; wacht tot hij is bijgewerkt" };
  if (r.status !== 200 || !r.json) return { at: Date.now(), ok: false, detail: "Je Dienst is nu niet bereikbaar" };
  return { at: Date.now(), ok: !!r.json.ok, detail: String(r.json.detail ?? "") };
}

/** Velden van een contactpersoon die PUT /contacts/{id} kent (contactUpdateContactRequest), behalve id. */
export const CONTACT_KEEP = ["additional_data", "address", "api_access_enabled", "auth_type", "comments", "company_name", "email", "inn", "is_active", "kpp", "locale", "name", "phone", "rcp_client_ip_list", "role", "type", "vat"];

/**
 * Openprovider koppelen en het IP-adres van de server op de lijst zetten. De IP-lijst hoort bij de API-gebruiker:
 * GET /contacts?username_pattern= (→ data.results[].api_client_ip_list, "API access IP whitelist / blacklist") en
 * PUT /contacts/{id} met api_client_ip_list {allow, deny} (swagger.json op de branch v1beta van
 * github.com/openprovider/api-documentation; rcp_client_ip_list is de lijst voor het controlepaneel en blijft zoals hij
 * is). Is de lijst leeg (alles mag), dan verandert de app niets: één adres toevoegen zou alle andere (ook dit apparaat)
 * buitensluiten. Daarna controleert de server van de Dienst zelf (GET /v1/status/check/openprovider).
 */
export async function openprovider(c: AdminConfig, b: { gebruiker?: string; wachtwoord?: string }, deps: Pick<NodigDeps, "save">) {
  const a = aan.intern.state(c) as A;
  const acc = (a.accounts ??= {});
  const u = String(b.gebruiker ?? "").trim(), p = String(b.wachtwoord ?? "");
  if (u) acc.openproviderUser = u;
  if (p && !p.startsWith("••")) acc.openproviderPass = p;
  if (!acc.openproviderUser || !acc.openproviderPass) throw new Error("Vul je Openprovider-gebruikersnaam en wachtwoord in");
  const op = opOf(a)!;
  const ch = (a.checked ??= {});
  let login: { ok: boolean; detail: string };
  try { await op.login(); login = { ok: true, detail: "Inloggen werkt" }; }
  catch (e) { login = { ok: false, detail: (e as Error).message }; }
  ch.openprovider = login.ok;
  const ips = [a.server?.ipv4, a.server?.ipv6].filter((x): x is string => !!x);
  let ip: { adressen: string[]; status: "geen-server" | "open" | "staat-erop" | "toegevoegd" | "handmatig"; uitleg: string } = { adressen: ips, status: "geen-server", uitleg: "Zodra je Dienst draait, zet de app het IP-adres van de server op de lijst." };
  const st = (a.openprovider ??= {});
  if (login.ok && ips.length) {
    try {
      const j = await op.req("GET", `/contacts?username_pattern=${encodeURIComponent(acc.openproviderUser)}&limit=10`);
      const me = ((j?.data?.results ?? []) as any[]).find((x) => String(x.username ?? "").toLowerCase() === acc.openproviderUser!.toLowerCase());
      if (!me?.id) throw new Error("Kon je API-gebruiker niet vinden");
      st.contactId = Number(me.id);
      const allow = ((me.api_client_ip_list?.allow ?? []) as string[]).map(String), deny = ((me.api_client_ip_list?.deny ?? []) as string[]).map(String);
      const missing = ips.filter((x) => !allow.includes(x));
      if (!allow.length) ip = { adressen: ips, status: "open", uitleg: "Je API-gebruiker heeft geen IP-lijst: elk adres mag. De app laat dat zo." };
      else if (!missing.length) ip = { adressen: ips, status: "staat-erop", uitleg: "Het IP-adres van je server staat op de lijst." };
      else {
        // Alles wat de contactpersoon al had gaat mee terug (of PUT alleen de meegestuurde velden wijzigt, staat niet in de
        // documentatie); alleen de IP-lijst voor de API krijgt het adres van de server erbij.
        const body: Record<string, unknown> = Object.fromEntries(CONTACT_KEEP.filter((k) => me[k] !== undefined && me[k] !== null).map((k) => [k, me[k]]));
        body.api_client_ip_list = { allow: [...allow, ...missing], deny };
        await op.req("PUT", `/contacts/${me.id}`, body);
        ip = { adressen: ips, status: "toegevoegd", uitleg: `De app heeft ${missing.join(" en ")} op de lijst gezet.` };
      }
    } catch (e) {
      ip = { adressen: ips, status: "handmatig", uitleg: `Zet ${ips.join(" en ")} zelf op de lijst: Openprovider → Account → Contactpersonen → je naam → API → toegestane IP-adressen. (${(e as Error).message})` };
    }
  }
  if (login.ok && a.server) st.check = (await dienstOpCheck(a)) ?? undefined;
  deps.save();
  return { ok: login.ok, login, ip, dienst: st.check ?? null, link: OP_PANEL_URL, pending: !!a.server };
}

/** Alleen nagaan (vanaf de server van de Dienst): kan die bij Openprovider? */
export async function openproviderCheck(c: AdminConfig, deps: Pick<NodigDeps, "save">) {
  const a = (aan.intern.existing(c) ?? { step: "bedrijf" }) as A;
  const r = await dienstOpCheck(a);
  if (r) { (a.openprovider ??= {}).check = r; deps.save(); }
  return { dienst: r, ip: [a.server?.ipv4, a.server?.ipv6].filter(Boolean), link: OP_PANEL_URL };
}

/** Links voor de begeleide stappen (aanmelden en sleutels), voor de console. */
export const LINKS = { scaleway: { aanmelden: SCW_SIGNUP_URL, sleutels: SCW_KEYS_URL }, mollie: MOLLIE_LINKS, openprovider: OP_PANEL_URL, desec: "https://desec.io" };
