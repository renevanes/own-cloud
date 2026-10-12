/**
 * Aanbieder worden "zo gratis mogelijk": de keuze bovenaan "Wat je nodig hebt" (console.aanbiederModus, "gratis" of
 * "standaard"; zonder waarde = standaard), en wat daarbij hoort:
 *
 *  - Gratis adres bij deSEC: <naam>.dedyn.io, gemaakt met het deSEC-account van de Dienst (POST /api/v1/domains/). Het
 *    adres van de Dienst is dan die naam zelf (bijv. esape.dedyn.io), de DNS staat meteen bij deSEC.
 *  - Een server op starttegoed bij UpCloud of Exoscale (`proef`), met het kleinste geschikte formaat daar; back-ups bij
 *    dezelfde aanbieder als de console dat zelf kan regelen (Exoscale: dezelfde sleutel werkt voor Object Storage),
 *    anders bij Scaleway (een paar MB: minder dan € 0,01 per maand).
 *  - Het tegoed en de einddatum, met een waarschuwing 3 dagen voor het einde of als er minder dan 20% tegoed over is, en
 *    "Verhuizen naar een betaalde server": het goedkoopste geschikte formaat bij de gekoppelde aanbieders, via het
 *    gewone opnieuw opzetten (laatste back-up, nieuwe server zet hem terug, DNS om, oude server weg).
 *
 * Nagekeken op 12-10-2026 (zie ook BROKER.md, "Gratis beginnen"):
 *  - deSEC: namen direct onder dedyn.io, één per account; een bezette naam geeft 400 (desec.readthedocs.io/en/latest/dns/domains.html).
 *  - UpCloud: proef van 7 dagen vanaf het activeren (met een creditcard die niet wordt belast), hooguit 2 processors en
 *    4 GB, naar buiten alleen poort 80, 443, 53 en 123 (SMTP dicht); na de proef gaat alles weg tenzij je minstens € 10
 *    stort (upcloud.com/docs/getting-started/free-trial/ en …/upgrading/). Een actiepagina noemt 30 dagen met € 500
 *    tegoed (upcloud.com/get-started). GET /1.3/account geeft `credits`, in centen (upcloud-cli,
 *    internal/commands/account/show.go: "Credits are returned in cents").
 *  - Exoscale: € 20 (of CHF 20) tegoed na het aanmelden, met een opgeslagen creditcard en achteraf betalen; geen vaste
 *    geldigheid genoemd (community.exoscale.com/platform/quick-start/). GET /v2/live-balance → {balance, currency}
 *    (BETA; openapi-v2.exoscale.com/operation/operation-get-live-balance). Wat een positief of negatief saldo betekent,
 *    staat er niet bij: de console toont het als "volgens Exoscale".
 *  - Scaleway Transactional Email: 300 mails per organisatie per maand gratis, daarna € 0,25 per 1.000
 *    (scaleway.com/en/pricing/managed-services/); een betaalmethode is nodig voordat je iets bestelt (creditcard met een
 *    controle van € 1 die terugkomt, of SEPA met identiteitscontrole; scaleway.com/en/docs/billing/how-to/add-payment-method/).
 *
 * De Android-app doet hetzelfde in Java (android/core Gratis.java); de JSON is gelijk.
 */
import crypto from "node:crypto";
import type { AdminConfig } from "./vault.js";
import * as aan from "./aanbieder.js";
import { DESEC_URL, desecError } from "./extras.js";
import { fetchSizes, pickSize, serverOffers as catalogServerOffers, type ServerOffer, type SizeOption } from "./catalog.js";
import { upcApi, upcAuth } from "../cluster/adapters/upcloud.js";
import { exoBase, exoSign } from "../cluster/adapters/exoscale.js";
import { dohLookup, nsMatch } from "./doh.js";

export type Modus = "gratis" | "standaard";
export type ProefId = "upcloud" | "exoscale";

/** Wat de gratis route bewaart in console.aanbieder (naast aanbieder.ts en benodigdheden.ts). */
export interface GratisState {
  /** Het gratis adres bij deSEC (bijv. esape.dedyn.io); `klaar` zodra het in de DNS te zien is. */
  gratisAdres?: { naam: string; at: number; klaar: boolean };
  /**
   * De server op starttegoed: bij welke aanbieder, wanneer gekoppeld, tot wanneer (ingevuld of geschat), het laatst
   * gelezen tegoed en het tegoed bij het begin; `verhuisd` = naar een betaalde server verhuisd.
   */
  proef?: { provider: ProefId; at: number; eind: number | null; eindBron: "ingevuld" | "geschat" | null; tegoed?: { bedrag: number; valuta: string; at: number } | null; startTegoed?: number | null; verhuisd?: number };
}
type A = aan.AanbiederState & GratisState;

/** Tests: een vaste klok. */
export const gratisNet = { now: () => Date.now() };
const now = () => gratisNet.now();
export const DAG = 86_400_000;
const DESEC_NS = ["ns1.desec.io", "ns2.desec.org"];
export const DEDYN = "dedyn.io";

/** Is dit een gratis adres van deSEC (naam.dedyn.io)? */
export const isDedyn = (host: string | null | undefined) => !!host && host.endsWith(`.${DEDYN}`) && host.split(".").length === 3;

/** Wat de aanbieders met starttegoed zeggen (nagekeken op 12-10-2026; bronnen hierboven). */
export const PROEF: Record<ProefId, { naam: string; aanmelden: string; wat: string; tijdens: string; einde: string; eindeKort: string; dagen: number | null; startTegoed: number | null; backup: "scaleway" | "zelf"; backupUitleg: string; bron: string }> = {
  upcloud: {
    naam: "UpCloud",
    aanmelden: "https://hub.upcloud.com",
    wat: "Volgens UpCloud: elk nieuw account krijgt een gratis proefperiode van 7 dagen (met een actie soms langer, bijvoorbeeld 30 dagen met € 500 tegoed). Je bevestigt je identiteit met een creditcard; UpCloud belast die niet.",
    tijdens: "Tijdens de proef: hooguit 2 processors en 4 GB geheugen, en naar buiten alleen de webpoorten (80 en 443). Mail via SMTP kan dan niet; je Dienst verstuurt mail daarom via de webkoppeling van Scaleway.",
    einde: "Na de proef haalt UpCloud weg wat je hebt gemaakt, tenzij je vóór het einde minstens € 10 stort. Verhuis je Dienst daarom op tijd naar een betaalde server; de app doet dat met één tik.",
    eindeKort: "Daarna haalt UpCloud je server weg, tenzij je minstens € 10 stort.",
    dagen: 7,
    startTegoed: null,
    backup: "scaleway",
    backupUitleg: "Opslag bij UpCloud moet je met de hand aanmaken, en verdwijnt na de proef. Daarom komen de back-ups bij Scaleway: minder dan € 0,01 per maand, en ze blijven bestaan.",
    bron: "https://upcloud.com/docs/getting-started/free-trial/",
  },
  exoscale: {
    naam: "Exoscale",
    aanmelden: "https://portal.exoscale.com/register",
    wat: "Volgens Exoscale: € 20 tegoed (of CHF 20) direct na het aanmelden. Je slaat een creditcard op en kiest achteraf betalen; de kaart wordt pas belast als je meer gebruikt dan het tegoed.",
    tijdens: "Maak bij IAM een rol met Compute en Object Storage (SOS), en een API-sleutel met die rol. Met dezelfde sleutel komen de back-ups ook bij Exoscale, betaald van je tegoed.",
    einde: "Is het tegoed op, dan draait je server gewoon door en betaal je met je creditcard. Hoe lang het tegoed geldig is, zegt Exoscale niet precies. Verhuizen naar een goedkopere server kan altijd met één tik.",
    eindeKort: "Daarna betaal je Exoscale met je creditcard.",
    dagen: null,
    startTegoed: 20,
    backup: "zelf",
    backupUitleg: "De back-ups komen bij Exoscale (Object Storage), met dezelfde sleutel: betaald van je tegoed, daarna een klein bedrag voor een paar MB.",
    bron: "https://community.exoscale.com/platform/quick-start/",
  },
};
export const PROEF_IDS: ProefId[] = ["upcloud", "exoscale"];

/**
 * Als er nog geen prijs bekend is: de goedkoopste betaalde server met 2 GB die we nagekeken hebben (12-10-2026):
 * UpCloud Starter 2 GB € 6 per maand zonder lokale belasting (upcloud.com/pricing), Scaleway DEV1-S € 0,00898 per uur
 * zonder btw (≈ € 6,55; scaleway.com/en/pricing/virtual-instances). De console zegt dan "vanaf ongeveer".
 */
export const VANAF = 6;

/** Scaleway TEM: 300 mails per maand gratis, daarna € 0,25 per 1.000 (zie boven). */
export const MAIL_KOSTEN = "gratis tot 300 mails per maand, daarna € 0,25 per 1.000 (volgens Scaleway)";
export const BACKUP_KOSTEN = "minder dan € 0,01 per maand";

// ───────── Opmaak ─────────

/** € 7,99 */
export const euro = (n: number) => `€ ${n.toFixed(2).replace(".", ",")}`;
const geld = (n: number, valuta: string) => (valuta === "EUR" ? euro(n) : `${valuta} ${n.toFixed(2).replace(".", ",")}`);
const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** Jaar, maand en dag in Nederland. */
function ymd(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}
/** "19 oktober" (met het jaar erbij als dat niet dit jaar is). */
export function datum(ms: number) {
  const d = ymd(ms), n = ymd(now());
  return `${d.d} ${MAANDEN[d.m - 1]}${d.y !== n.y ? ` ${d.y}` : ""}`;
}
/** "2026-10-19" (voor een datumveld). */
export function isoDatum(ms: number) {
  const d = ymd(ms);
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}
/** "2026-10-19" → die dag om 12:00 UTC; ongeldig: een fout. */
function parseDatum(v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : NaN;
  if (!m || !Number.isFinite(ms) || isoDatum(ms) !== v.trim()) throw new Error("Vul de datum in als 2026-10-19");
  return ms;
}

// ───────── De keuze ─────────

type Con = AdminConfig["console"] & { aanbiederModus?: string };

/** "gratis" of "standaard" (zonder keuze: standaard, zoals het altijd was). */
export function modus(c: AdminConfig): Modus {
  return (c.console as Con).aanbiederModus === "gratis" ? "gratis" : "standaard";
}

export function setModus(c: AdminConfig, b: { modus?: string }) {
  if (b.modus !== "gratis" && b.modus !== "standaard") throw new Error("Kies hoe je wilt beginnen");
  (c.console as Con).aanbiederModus = b.modus;
  return { ok: true, modus: b.modus as Modus };
}

// ───────── Starttegoed ─────────

/** De proef zoals de console hem laat zien (zonder netwerk; het tegoed is het laatst gelezen bedrag). */
export function proefView(a: A | null) {
  const p = a?.proef;
  const info = p ? PROEF[p.provider] : undefined;
  if (!a || !p || !info) return null;
  const t = now();
  const plek = a.server ? a.server.provider : a.removed ? null : a.hosting?.provider ?? null;
  const actief = plek === p.provider;
  const dagenOver = p.eind != null ? Math.ceil((p.eind - t) / DAG) : null;
  const tg = p.tegoed ?? null;
  const start = p.startTegoed ?? null;
  const procent = tg && start ? Math.max(0, Math.min(100, Math.round((tg.bedrag / start) * 100))) : null;
  const verlopen = p.eind != null && t >= p.eind;
  const eindTekst = p.eind != null ? `${p.eindBron === "geschat" ? "ongeveer " : ""}${datum(p.eind)}` : null;
  let soort: "verlopen" | "dagen" | "tegoed" | null = null;
  let waarschuwing: string | null = null;
  if (actief) {
    if (verlopen) { soort = "verlopen"; waarschuwing = `Je proefperiode bij ${info.naam} is voorbij. ${info.eindeKort} Verhuis je Dienst nu naar een betaalde server.`; }
    else if (dagenOver !== null && dagenOver <= 3) { soort = "dagen"; waarschuwing = `Je proefperiode bij ${info.naam} loopt ${dagenOver <= 1 ? "binnen een dag" : `over ${dagenOver} dagen`} af (${eindTekst}). ${info.eindeKort} Verhuis je Dienst op tijd naar een betaalde server.`; }
    else if (tg && (tg.bedrag <= 0 || (procent !== null && procent < 20))) { soort = "tegoed"; waarschuwing = `Je starttegoed bij ${info.naam} is bijna op (nog ${geld(Math.max(0, tg.bedrag), tg.valuta)}). ${info.eindeKort} Verhuis je Dienst op tijd naar een betaalde server.`; }
  }
  const titel = soort === "verlopen" ? "Proefperiode voorbij" : soort === "dagen" ? "Proefperiode bijna voorbij" : soort === "tegoed" ? "Starttegoed bijna op" : null;
  return {
    provider: p.provider, naam: info.naam, actief, verhuisd: !!p.verhuisd && !actief,
    eind: p.eind, eindBron: p.eindBron, eindTekst, eindDatum: p.eind != null ? isoDatum(p.eind) : null, dagenOver,
    tegoed: tg ? { bedrag: tg.bedrag, valuta: tg.valuta, at: tg.at } : null, startTegoed: start, procent,
    tegoedTekst: tg ? `${geld(tg.bedrag, tg.valuta)}${start ? ` van ${geld(start, tg.valuta)}` : ""}` : null,
    verlopen, soort, titel, waarschuwing,
    wat: info.wat, tijdens: info.tijdens, einde: info.einde, bron: info.bron, aanmelden: info.aanmelden,
  };
}

/**
 * Het tegoed lezen bij de aanbieder (alleen lezen): UpCloud GET /1.3/account → credits (centen), Exoscale
 * GET /v2/live-balance → balance. Lukt het niet, dan blijft het vorige bedrag staan. Geeft true als er iets nieuws is.
 */
export async function leesTegoed(a: A): Promise<boolean> {
  const p = a.proef;
  const f = p ? a.keys?.[p.provider] : undefined;
  if (!p || !f) return false;
  try {
    let bedrag: number, valuta = "EUR";
    if (p.provider === "upcloud") {
      const r = await fetch(`${upcApi()}/account`, { headers: { authorization: upcAuth(f) }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return false;
      const cents = Number(((await r.json()) as { account?: { credits?: unknown } })?.account?.credits);
      if (!Number.isFinite(cents)) return false;
      bedrag = Math.round(cents) / 100;
    } else {
      const url = `${exoBase("ch-gva-2")}/live-balance`;
      const r = await fetch(url, { headers: { authorization: exoSign("GET", url, "", f.apiKey ?? "", f.apiSecret ?? "", Math.floor(Date.now() / 1000) + 600) }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return false;
      const j = (await r.json()) as { balance?: unknown; currency?: unknown };
      const b = Number(j?.balance);
      if (!Number.isFinite(b)) return false;
      bedrag = Math.round(b * 100) / 100;
      valuta = String(j?.currency || "EUR").toUpperCase();
    }
    p.tegoed = { bedrag, valuta, at: now() };
    const basis = PROEF[p.provider].startTegoed ?? 0;
    p.startTegoed = Math.max(bedrag, p.startTegoed ?? basis);
    return true;
  } catch { return false; }
}

/** Het tegoed opnieuw lezen als dat langer dan 10 minuten geleden is (of `fresh`). */
export async function verversTegoed(c: AdminConfig, fresh: boolean) {
  const a = aan.intern.existing(c) as A | null;
  const p = a?.proef;
  if (!a || !p || !proefView(a)?.actief) return false;
  if (!fresh && p.tegoed && now() - p.tegoed.at < 10 * 60_000) return false;
  return leesTegoed(a);
}

// ───────── De goedkoopste betaalde server ─────────

export interface Kandidaat { provider: string; naam: string; region: string; regionLabel: string; city: string; country: string; size: string; sizeLabel: string; monthly: number | null }

const sizeCache = new Map<string, { at: number; v: SizeOption | null }>();
/** Alleen voor tests. */
export function resetGratisCache() { sizeCache.clear(); }

/** De gekoppelde aanbieders met servers en hun inloggegevens (Scaleway: de sleutel bij Accounts). */
function gekoppeld(c: AdminConfig, a: A) {
  const out: [string, Record<string, string>][] = [];
  if (a.accounts?.scalewaySecretKey && a.checked?.scaleway === true) out.push(["scaleway", { secretKey: a.accounts.scalewaySecretKey, projectId: a.projectId ?? "" }]);
  const ids = [...new Set([...Object.keys(c.providers ?? {}), ...Object.keys(a.keys ?? {})])].filter((x) => x !== "scaleway");
  for (const id of ids) out.push([id, { ...(c.providers?.[id] ?? {}), ...(a.keys?.[id] ?? {}) }]);
  return out;
}

/**
 * Per gekoppelde aanbieder (behalve `zonder`) de goedkoopste regio met het kleinste geschikte formaat (≥ 2 GB, zoals bij
 * Server en back-ups), goedkoopste eerst; onbekende prijzen achteraan. Formaten worden 10 minuten bewaard.
 */
export async function kandidaten(c: AdminConfig, a: A, o: { fresh?: boolean; zonder?: string | null; offers?: () => ServerOffer[] } = {}): Promise<Kandidaat[]> {
  const offers = (o.offers ?? (() => catalogServerOffers()))();
  const lijst = gekoppeld(c, a).filter(([id]) => id !== o.zonder && offers.some((x) => x.id === id));
  const per = await Promise.all(lijst.map(async ([id, fields]) => {
    const offer = offers.find((x) => x.id === id)!;
    const sleutel = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 12);
    const rs = await Promise.all(offer.regions.map(async (r) => {
      const k = `${id}/${r.id}/${sleutel}`;
      const hit = sizeCache.get(k);
      let s: SizeOption | null;
      if (!o.fresh && hit && Date.now() - hit.at < 10 * 60_000) s = hit.v;
      else {
        try { s = pickSize(await fetchSizes(id, fields, r.id), "data") ?? null; } catch { s = null; }
        sizeCache.set(k, { at: Date.now(), v: s });
      }
      return s ? { provider: id, naam: offer.name, region: r.id, regionLabel: r.label, city: r.city, country: r.country, size: s.size, sizeLabel: s.label, monthly: s.monthly } : null;
    }));
    const ok = rs.filter((x): x is Kandidaat => !!x);
    return ok.sort((x, y) => (x.monthly ?? Infinity) - (y.monthly ?? Infinity))[0] ?? null;
  }));
  const order = (id: string) => offers.findIndex((x) => x.id === id);
  return per.filter((x): x is Kandidaat => !!x).sort((x, y) => (x.monthly ?? Infinity) - (y.monthly ?? Infinity) || order(x.provider) - order(y.provider));
}

/**
 * Wat de server ongeveer kost als het starttegoed op is: de goedkoopste bekende prijs bij de gekoppelde aanbieders
 * (behalve die van de proef), anders de catalogus van je cloud, anders VANAF ("vanaf").
 */
export async function prijsNa(c: AdminConfig, a: A, o: { fresh?: boolean; offers?: () => ServerOffer[] } = {}) {
  const zonder = a.proef?.provider ?? null;
  const k = (await kandidaten(c, a, { ...o, zonder })).find((x) => x.monthly !== null);
  if (k) return { bedrag: k.monthly!, vanaf: false, provider: k.provider, naam: k.naam };
  let best: { bedrag: number; provider: string } | null = null;
  for (const [p, regions] of Object.entries(c.console.catalog ?? {})) {
    if (p === zonder) continue;
    for (const picks of Object.values(regions ?? {})) {
      const m = picks?.data?.monthly;
      if (typeof m === "number" && (!best || m < best.bedrag)) best = { bedrag: m, provider: p };
    }
  }
  const offers = (o.offers ?? (() => catalogServerOffers()))();
  if (best) return { bedrag: best.bedrag, vanaf: false, provider: best.provider, naam: offers.find((x) => x.id === best!.provider)?.name ?? best.provider };
  return { bedrag: VANAF, vanaf: true, provider: null, naam: null };
}

export const naTekst = (na: { bedrag: number; vanaf: boolean } | null) => (na ? `${na.vanaf ? "vanaf ongeveer" : "ongeveer"} ${euro(na.bedrag)} per maand` : "een paar euro per maand");

// ───────── Gratis adres bij deSEC ─────────

/** "Esape", "esape.dedyn.io" of "https://esape.dedyn.io/" → "esape"; anders een fout. */
function naamOf(raw: unknown) {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "").replace(/\.dedyn\.io$/, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v)) throw new Error("Kies een naam van letters, cijfers en streepjes (niet aan het begin of eind), bijvoorbeeld jouwbedrijf");
  return v;
}

async function desecReq(method: string, path: string, token: string, body?: unknown, ms = 20_000) {
  const r = await fetch(`${DESEC_URL()}${path}`, { method, headers: { authorization: `Token ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  const t = await r.text();
  let j: unknown = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = null; }
  return { status: r.status, ok: r.ok, json: j as any, text: t };
}

/** De zones in dit deSEC-account (eerste bladzijde is genoeg voor de vraag of er al een dedyn.io-naam is). */
async function desecZones(token: string) {
  const r = await desecReq("GET", "/domains/", token);
  if (r.status === 401 || r.status === 403) throw new Error("deSEC accepteert het token van je Dienst niet");
  if (!r.ok) throw new Error(`deSEC antwoordt ${r.status}`);
  return ((Array.isArray(r.json) ? r.json : []) as { name?: string }[]).map((x) => String(x.name ?? ""));
}

/** Staat de naam al in de DNS (bij deSEC)? true/false, of null als dat niet na te gaan is. */
async function inDns(fqdn: string) {
  const ns = await dohLookup(fqdn, "NS");
  return ns === null ? null : nsMatch(ns.values, DESEC_NS) ? true : ns.values.length ? "anders" as const : false;
}

/**
 * Het gratis adres: `{naam}` alleen nagaan (vrij, bezet, al van jou), `{naam, maken: true}` maken bij deSEC en gebruiken
 * als adres van je Dienst, met de DNS bij deSEC (zoals de DNS-koppeling bij Wat je nodig hebt). deSEC geeft één
 * dedyn.io-naam per account. Daarna zet deSEC de naam in dedyn.io; dat kan even duren (`status: "wacht"`): de console
 * kijkt dan elke 15 seconden opnieuw.
 */
export async function gratisAdres(c: AdminConfig, b: { naam?: string; maken?: boolean }, deps: aan.Deps) {
  const a = aan.intern.state(c) as A;
  const naam = naamOf(b.naam ?? a.gratisAdres?.naam);
  const fqdn = `${naam}.${DEDYN}`;
  const token = a.accounts?.desecToken;
  if (!token) throw new Error("Maak eerst je gratis deSEC-account (bij deSEC, verderop in de lijst). Daarmee maakt de app het adres.");
  let zones: string[];
  try { zones = await desecZones(token); } catch (e) { if ((e as Error).name === "TimeoutError") throw new Error("deSEC reageert nu niet. Probeer het zo opnieuw."); throw e; }
  const ander = zones.find((z) => isDedyn(z) && z !== fqdn) ?? null;
  const vanJou = zones.includes(fqdn);
  const hostNu = () => { try { return a.url ? new URL(a.url).hostname : null; } catch { return null; } };
  const host = hostNu();
  const view = (status: string, uitleg: string, extra: Record<string, unknown> = {}) => ({ ok: true, naam: fqdn, status, uitleg, ander, gebruikt: hostNu() === fqdn, pending: !!a.server && hostNu() === fqdn && aan.wijzigingen(c, a) === "opnieuw", ...extra });
  if (!vanJou && ander) return view("ander", `Je deSEC-account heeft al een gratis adres: ${ander}. deSEC geeft één gratis adres per account. Gebruik dat adres, of haal het eerst weg bij deSEC.`);
  if (!b.maken) {
    if (vanJou) {
      const d = await inDns(fqdn);
      if (d === true && a.gratisAdres?.naam === fqdn && !a.gratisAdres.klaar) { a.gratisAdres.klaar = true; deps.save(); }
      return host === fqdn
        ? view(d === true ? "klaar" : "wacht", d === true ? `${fqdn} werkt en staat bij deSEC.` : `deSEC zet ${fqdn} nu klaar. Dat duurt meestal een paar minuten; de app kijkt vanzelf.`)
        : view("van-jou", `${fqdn} is van jou (in je deSEC-account). Kies "Maak dit adres" om het te gebruiken.`);
    }
    const d = await inDns(fqdn);
    return d === null ? view("onbekend", `Kon niet nagaan of ${fqdn} vrij is. Probeer het gewoon; is hij bezet, dan zegt deSEC dat.`)
      : d === false ? view("vrij", `${fqdn} is vrij.`)
      : view("bezet", `${fqdn} is al bezet. Kies een andere naam.`);
  }
  if (!vanJou) {
    let r;
    try { r = await desecReq("POST", "/domains/", token, { name: fqdn }, 60_000); }
    catch {
      // Kwam het antwoord niet, dan kan het adres toch gemaakt zijn.
      const z = await desecZones(token).catch(() => [] as string[]);
      if (!z.includes(fqdn)) throw new Error("deSEC reageert nu niet. Probeer het zo opnieuw; als het adres toch is gemaakt, ziet de app dat vanzelf.");
      r = { status: 201, ok: true, json: null, text: "" };
    }
    if (r.status === 401 || r.status === 403) throw new Error("deSEC accepteert het token van je Dienst niet");
    if (r.status === 429) throw new Error("deSEC vraagt even te wachten. Probeer het over een minuut opnieuw.");
    if (!r.ok) {
      const t = r.text.toLowerCase();
      if (r.status === 409 || /conflict|unavailable|already|taken|exists/.test(t)) throw new Error(`${fqdn} is al bezet. Kies een andere naam.`);
      if (/limit|one domain|maximum|exceed/.test(t)) throw new Error("deSEC geeft één gratis adres per account, en je account heeft er al een.");
      throw new Error(`deSEC: ${desecError(r.json)}`);
    }
  }
  // Gebruiken: het adres van je Dienst wordt de naam zelf, de DNS staat bij deSEC (records zet de console zelf).
  a.gratisAdres = { naam: fqdn, at: now(), klaar: a.gratisAdres?.naam === fqdn ? a.gratisAdres.klaar : false };
  aan.saveAdres(c, { url: fqdn });
  deps.save();
  await aan.saveDns(c, { provider: "desec", zone: fqdn }, deps);
  const d = await inDns(fqdn);
  if (d === true) a.gratisAdres.klaar = true;
  deps.save();
  return view(d === true ? "klaar" : "wacht", d === true ? `${fqdn} is gemaakt en werkt.` : `${fqdn} is gemaakt. deSEC zet hem nu klaar in dedyn.io; dat duurt meestal een paar minuten. De app kijkt vanzelf.`, { url: `https://${fqdn}` });
}

// ───────── Server op starttegoed ─────────

/** Volgorde van de regio's bij een proef: zo dichtbij mogelijk. */
const LANDEN = ["NL", "DE", "BE", "FR", "AT", "CH", "FI", "SE", "PL", "BG"];

/**
 * `{provider, fields?}`: de sleutel van UpCloud of Exoscale koppelen (zoals Server en back-ups), de regio die het
 * dichtst bij is met het kleinste geschikte formaat kiezen, en de back-ups (als die nog geen vaste plek hebben) bij
 * dezelfde aanbieder zetten als de console dat zelf kan (Exoscale), anders bij Scaleway. `{eind}`: de einddatum van de
 * proef (2026-10-19; leeg = weer geschat). Daarna het tegoed lezen.
 */
export async function proef(c: AdminConfig, b: { provider?: string; fields?: Record<string, unknown>; eind?: string | null }, deps: aan.Deps) {
  const a = aan.intern.state(c) as A;
  if (!b.provider) {
    if (!a.proef) throw new Error("Kies eerst UpCloud of Exoscale");
    if (b.eind === undefined) throw new Error("Vul de einddatum in");
    const info = PROEF[a.proef.provider];
    if (b.eind === null || String(b.eind).trim() === "") Object.assign(a.proef, info.dagen ? { eind: a.proef.at + info.dagen * DAG, eindBron: "geschat" } : { eind: null, eindBron: null });
    else Object.assign(a.proef, { eind: parseDatum(String(b.eind)), eindBron: "ingevuld" });
    deps.save();
    return { ok: true, proef: proefView(a) };
  }
  const id = b.provider as ProefId;
  const info = PROEF[id];
  if (!info) throw new Error("Kies UpCloud of Exoscale");
  const r = await aan.saveServer(c, { provider: id, fields: b.fields }, deps) as { regions?: { region: string; country: string; size?: string; error?: string }[] };
  const ok = (r.regions ?? []).filter((x) => !x.error && x.size);
  const rank = (x: { country: string }) => { const i = LANDEN.indexOf(x.country); return i < 0 ? LANDEN.length : i; };
  const kies = [...ok].sort((x, y) => rank(x) - rank(y))[0];
  if (!kies) throw new Error(`Bij ${info.naam} lukt het ophalen van de formaten niet. Probeer het zo opnieuw.`);
  await aan.saveServer(c, { provider: id, region: kies.region }, deps);
  let backupUitleg: string;
  if (a.backup?.bucket) backupUitleg = "De back-ups blijven waar ze al staan; die plek ligt vast.";
  else if (info.backup === "zelf" && id === "exoscale") {
    const f = a.keys?.exoscale ?? {};
    aan.saveBackup(c, { provider: "exoscale", region: kies.region, accessKey: f.apiKey, secretKey: f.apiSecret }, deps);
    backupUitleg = info.backupUitleg;
  } else {
    aan.saveBackup(c, { provider: "scaleway", region: aan.BACKUP_REGION }, deps);
    backupUitleg = info.backupUitleg;
  }
  const t = now();
  const zelfde = a.proef?.provider === id;
  a.proef = {
    provider: id, at: zelfde ? a.proef!.at : t,
    eind: zelfde ? a.proef!.eind : info.dagen ? t + info.dagen * DAG : null,
    eindBron: zelfde ? a.proef!.eindBron : info.dagen ? "geschat" : null,
    tegoed: zelfde ? a.proef!.tegoed ?? null : null, startTegoed: zelfde ? a.proef!.startTegoed ?? null : null,
  };
  if (b.eind) Object.assign(a.proef, { eind: parseDatum(String(b.eind)), eindBron: "ingevuld" });
  deps.save();
  await leesTegoed(a);
  deps.save();
  const v = aan.view(c, deps);
  return { ok: true, provider: id, hosting: v.started ? v.hosting : null, backup: v.started ? v.backup : null, backupUitleg, proef: proefView(a) };
}

// ───────── Verhuizen naar een betaalde server ─────────

/**
 * Zonder `akkoord`: het goedkoopste geschikte formaat bij de gekoppelde aanbieders (niet die van de proef), en de rest
 * als keuze. Met `{provider, region, akkoord: true}`: die plek kiezen (zoals Server en back-ups) en opnieuw opzetten:
 * laatste back-up, nieuwe server die hem terugzet, adres naar de nieuwe server, de proefserver weg.
 */
export async function verhuizen(c: AdminConfig, b: { provider?: string; region?: string; akkoord?: boolean }, deps: aan.Deps) {
  const a = aan.intern.state(c) as A;
  if (!a.server) throw new Error("Er draait nog geen Dienst om te verhuizen");
  const zonder = proefView(a)?.actief ? a.proef!.provider : a.server.provider;
  const k = await kandidaten(c, a, { fresh: true, zonder, offers: deps.serverOffers });
  if (!b.akkoord) {
    const backup = a.backup?.provider && a.backup.provider === zonder
      ? `De back-ups blijven bij ${PROEF[zonder as ProefId]?.naam ?? zonder}; die plek ligt vast.`
      : "De back-ups blijven waar ze staan.";
    return {
      ok: true, keuze: k[0] ?? null, kandidaten: k, backup,
      uitleg: k.length ? null : "Koppel eerst een aanbieder voor een betaalde server, bijvoorbeeld Scaleway (die heb je al voor de clouds van je klanten).",
    };
  }
  const keus = k.find((x) => x.provider === b.provider && (!b.region || x.region === b.region));
  if (!keus) throw new Error("Kies een gekoppelde aanbieder voor je nieuwe server");
  await aan.saveServer(c, { provider: keus.provider, region: keus.region }, deps);
  deps.save();
  const r = await aan.opzetten(c, deps);
  if (a.proef) a.proef.verhuisd = now();
  deps.save();
  return { ...r, verhuisd: true };
}
