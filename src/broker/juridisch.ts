/**
 * Voorwaarden, privacyverklaring en verwerkersovereenkomst van de aanbieder, gehost door de Dienst zelf:
 * - openbaar op /voorwaarden, /privacy en /verwerkersovereenkomst (eenvoudige HTML in de huisstijl; ?versie=N voor een
 *   eerdere versie), en GET /v1/juridisch (wat er gepubliceerd is, voor de console);
 * - in het beheer (pagina Voorwaarden en privacy, recht "brand"): een voorbeeld laten maken uit de gegevens van de Dienst
 *   (bedrijf, bundels en prijzen, de partijen waar alles echt staat), bewerken, bekijken en publiceren. Elke keer opslaan
 *   is een nieuwe versie in de tabel legal_docs (zelfde database, dus vanzelf in de back-up). Met `announce` krijgen klanten
 *   een bericht in de app (het gewone berichtensysteem).
 * Zolang de aanbieder geen eigen link heeft (Huisstijl of BROKER_TERMS_URL/BROKER_PRIVACY_URL), wijzen termsUrl en
 * privacyUrl in /v1/info en /v1/brand naar deze pagina's (zie getBrand in brand.ts).
 *
 * De voorbeeldteksten beschrijven wat de software echt doet (zie BROKER.md): opzeggen via het Mollie-abonnement, 30 dagen
 * bewaren na het einde, alleen technische gegevens voor medewerkers, subverwerkers uit de instellingen van deze Dienst.
 * Het is een voorbeeld, geen juridisch advies: het beheer zegt dat er ook bij.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "./context.js";
import { getBrand, hostedDoc } from "./brand.js";
import { adapters, getAdapter } from "../cluster/adapters.js";
import { type StaffRow, audit, getStaff } from "./staff.js";
import { createAnnouncement, announcementView } from "./support.js";
import { UserError } from "./billing.js";

export const SOORTEN = ["voorwaarden", "privacy", "verwerkersovereenkomst"] as const;
export type Soort = (typeof SOORTEN)[number];
export const TITELS: Record<Soort, string> = { voorwaarden: "Algemene voorwaarden", privacy: "Privacyverklaring", verwerkersovereenkomst: "Verwerkersovereenkomst" };
export const isSoort = (k: string): k is Soort => (SOORTEN as readonly string[]).includes(k);

export interface DocRow { kind: Soort; version: number; body: string; created_at: number; created_by: string | null; announcement_id: string | null }

const MAX_BODY = 200_000;
/** Zolang staat een bericht over gewijzigde voorwaarden in de app. */
export const ANNOUNCE_MS = 30 * 86400_000;

export const currentDoc = (ctx: Ctx, kind: Soort) => ctx.db.prepare("SELECT * FROM legal_docs WHERE kind = ? ORDER BY version DESC LIMIT 1").get(kind) as DocRow | undefined;
const docVersion = (ctx: Ctx, kind: Soort, v: number) => ctx.db.prepare("SELECT * FROM legal_docs WHERE kind = ? AND version = ?").get(kind, v) as DocRow | undefined;
const history = (ctx: Ctx, kind: Soort) => (ctx.db.prepare("SELECT version, created_at FROM legal_docs WHERE kind = ? ORDER BY version DESC").all(kind) as { version: number; created_at: number }[])
  .map((r) => ({ version: r.version, at: r.created_at }));

// ───────── Opmaak ─────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
/** 12 oktober 2026 (Nederlandse tijd). */
export function dateNl(ms: number) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
const euro = (v: string) => `€ ${v.replace(".", ",")}`;
const LANDEN: Record<string, string> = { NL: "Nederland", FR: "Frankrijk", PL: "Polen", DE: "Duitsland", FI: "Finland", CH: "Zwitserland", BE: "België", LU: "Luxemburg", AT: "Oostenrijk", IT: "Italië", ES: "Spanje", SE: "Zweden" };
const land = (cc: string) => LANDEN[cc] ?? cc;
/** "a", "a en b", "a, b en c". */
const opsomming = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} en ${xs.at(-1)}`);
const hostOf = (u: string | null | undefined) => { try { return u ? new URL(u).hostname : null; } catch { return null; } };

/** Tekst in de opmaak van de editor: `[tekst](https://…)`, losse https-links en e-mailadressen, `**vet**`, `[vul in: …]`. */
function inline(text: string) {
  const RE = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|\[(vul in:[^\]\n]*)\]|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<]*[^\s<.,;:!?)])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  return esc(text).replace(RE, (m, lt, lu, todo, bold, url, mail) => {
    if (lt) return `<a href="${lu}">${lt}</a>`;
    if (todo) return `<mark>[${todo}]</mark>`;
    if (bold) return `<strong>${bold}</strong>`;
    if (url) return `<a href="${url}">${url}</a>`;
    if (mail) return `<a href="mailto:${mail}">${mail}</a>`;
    return m;
  });
}

/**
 * De tekst als HTML: `#`/`##`/`###` koppen, `-` of `*` opsommingen, `1.` genummerde lijsten, lege regel = nieuwe alinea
 * (een enkele regelovergang blijft een regelovergang). Alles wordt eerst ge-escaped: HTML in de tekst werkt niet.
 */
export function renderBody(body: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`);
    para = []; list = null;
  };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else if (list) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else para.push(line.trim());
  }
  flush();
  return out.join("\n");
}

/** De openbare pagina (of een voorbeeld in het beheer) in de huisstijl van de Dienst. */
export function renderPage(ctx: Ctx, kind: Soort, doc: { body: string; version: number | null; at: number | null }, opts: { older?: boolean } = {}) {
  const b = getBrand(ctx);
  const accent = b.accentColor && /^#[0-9a-f]{6}$/i.test(b.accentColor) ? b.accentColor : "#3f6f4a";
  const meta = doc.version === null ? "Voorbeeld — nog niet gepubliceerd" : `Versie ${doc.version} · laatst gewijzigd op ${dateNl(doc.at!)}`;
  let html = renderBody(doc.body);
  const metaHtml = `<p class="meta">${esc(meta)}</p>`;
  html = /^<h1>/.test(html) ? html.replace("</h1>", `</h1>\n${metaHtml}`) : `<h1>${esc(TITELS[kind])}</h1>\n${metaHtml}\n${html}`;
  const others = SOORTEN.filter((k) => k !== kind && currentDoc(ctx, k)).map((k) => `<a href="/${k}">${esc(TITELS[k])}</a>`);
  const co = ctx.cfg.company;
  const contact = [co.name ?? b.name, b.contact.email ? `<a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a>` : "", co.kvk ? `KvK ${esc(co.kvk)}` : ""].filter(Boolean);
  const hist = doc.version === null ? [] : history(ctx, kind);
  const logo = b.logoUrl ? `<img src="${esc(new URL(b.logoUrl).pathname + new URL(b.logoUrl).search)}" alt="">` : "";
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITELS[kind])} — ${esc(b.name)}</title><meta name="theme-color" content="${accent}">
<style>
@font-face{font-family:"Atkinson Hyperlegible";font-weight:400;font-display:swap;src:url("/beheer/fonts/atkinson-hyperlegible-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"Atkinson Hyperlegible";font-weight:700;font-display:swap;src:url("/beheer/fonts/atkinson-hyperlegible-latin-700-normal.woff2") format("woff2")}
:root{--bg:#f3f5f2;--panel:#fbfcfa;--line:#d9e1db;--text:#1d2a2f;--muted:#5b6b70;--accent:${accent};--mark:#f6ead2}
@media (prefers-color-scheme:dark){:root{--bg:#121a1c;--panel:#18232a;--line:#2a3a42;--text:#e4ece8;--muted:#9db0ad;--accent:color-mix(in srgb,${accent} 45%,#ffffff);--mark:#3a2e14}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.6 "Atkinson Hyperlegible",system-ui,sans-serif;background:var(--bg);color:var(--text)}
header{border-top:4px solid var(--accent);border-bottom:1px solid var(--line);background:var(--panel)}
header div{max-width:46rem;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:12px;min-height:64px}
header img{max-height:36px;max-width:140px}header b{font-size:19px;overflow-wrap:anywhere}
main{max-width:46rem;margin:0 auto;padding:30px 20px 56px}
h1{font-size:30px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:21px;line-height:1.3;margin:34px 0 8px}h3{font-size:18px;margin:24px 0 6px}
.meta{color:var(--muted);font-size:15px;margin:0 0 26px}p,ul,ol{margin:0 0 14px}ul,ol{padding-left:24px}li{margin:5px 0}
a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}strong{font-weight:700}
mark{background:var(--mark);color:inherit;padding:0 3px;border-radius:3px}
.old{background:var(--mark);padding:10px 14px;border-radius:8px;margin:0 0 22px;font-size:15px}
footer{border-top:1px solid var(--line);margin-top:44px;padding-top:16px;color:var(--muted);font-size:15px}
footer nav{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0 0 10px}footer p{margin:0 0 6px}
@media (max-width:480px){body{font-size:16px}h1{font-size:26px}h2{font-size:19px}main{padding-top:22px}}
@media print{body{background:#fff;color:#000}header{background:none}footer nav,.old a{display:none}a{color:inherit}}
</style></head><body>
<header><div>${logo}<b>${esc(b.name)}</b></div></header>
<main>
${opts.older ? `<p class="old">Dit is een eerdere versie. <a href="/${kind}">Naar de huidige versie</a></p>\n` : ""}${html}
<footer>${others.length ? `<nav>${others.join("")}</nav>` : ""}<p>${contact.join(" · ")}</p>${hist.length > 1 ? `<p>Eerdere versies: ${hist.filter((x) => x.version !== doc.version).map((x) => `<a href="/${kind}?versie=${x.version}">versie ${x.version} (${esc(dateNl(x.at))})</a>`).join(", ")}</p>` : ""}</footer>
</main></body></html>`;
}

// ───────── Voorbeeldteksten uit de gegevens van de Dienst ─────────

/** De landen waar de clouds van klanten staan (servers en opslag van alle bundels, Scaleway). */
function cloudLanden(ctx: Ctx) {
  const scw = getAdapter("scaleway");
  const cc: string[] = [];
  for (const b of ctx.cfg.bundles) {
    for (const p of b.placement) cc.push(p.country || scw?.servers?.regions.find((r) => r.id === p.region)?.country || "");
    for (const s of b.storage) cc.push(scw?.storage?.regions.find((r) => r.id === s.region)?.country ?? "");
  }
  return [...new Set(cc.filter(Boolean))].map(land);
}

/** Per bundel: waar de servers, de werkkopie en de back-up staan (in gewone taal). */
function plekken(ctx: Ctx) {
  const scw = getAdapter("scaleway");
  const city = (region: string) => scw?.servers?.regions.find((r) => r.id === region)?.city ?? region;
  const store = (region: string) => scw?.storage?.regions.find((r) => r.id === region)?.label ?? region;
  return ctx.cfg.bundles.map((b) => {
    const n = new Map<string, number>();
    for (const p of b.placement) n.set(city(p.region), (n.get(city(p.region)) ?? 0) + 1);
    const servers = opsomming([...n].map(([c, k]) => (k > 1 ? `${c} (${k}×)` : c)));
    const rep = b.storage.find((s) => s.purpose === "replica"), bk = b.storage.find((s) => s.purpose === "backup");
    return `- **${b.title}**: servers in ${servers}${rep ? `; je gegevens in ${store(rep.region)}` : ""}${bk ? `, de back-up in ${store(bk.region)}` : ""}.`;
  });
}

/** Wie/wat een S3-endpoint is: de aanbieder uit de registry (met plek), of alleen de hostnaam. */
function storageOwner(endpoint: string) {
  const host = hostOf(endpoint);
  for (const a of adapters()) {
    const r = a.storage?.regions.find((x) => hostOf(x.endpoint) === host);
    if (r) return { naam: a.owner, plek: `${r.label}, ${land(r.country)}` };
  }
  return { naam: host ?? endpoint, plek: null };
}

export interface Subverwerker { naam: string; doel: string[] }

/**
 * De partijen die deze Dienst echt gebruikt (uit zijn instellingen): Scaleway voor de clouds van klanten, de server en
 * de back-ups van de Dienst, de mailserver, Mollie, deSEC, Openprovider en de gratis-adressendienst.
 */
export function subverwerkers(ctx: Ctx): Subverwerker[] {
  const cfg = ctx.cfg;
  const map = new Map<string, Subverwerker>();
  const add = (naam: string, doel: string) => {
    let s = map.get(naam);
    if (!s) map.set(naam, (s = { naam, doel: [] }));
    if (!s.doel.includes(doel)) s.doel.push(doel);
  };
  const scw = getAdapter("scaleway")?.owner ?? "Scaleway SAS (Frankrijk)";
  const landen = cloudLanden(ctx);
  add(scw, `de servers, de opslag en het versturen van mail van je cloud, in een eigen project per klant${landen.length ? ` (in ${opsomming(landen)})` : ""}`);
  if (cfg.hosting) {
    const a = getAdapter(cfg.hosting.provider);
    const r = a?.servers?.regions.find((x) => x.id === cfg.hosting!.region);
    add(a?.owner ?? cfg.hosting.provider, `de server van onze dienst${r ? ` (${r.city}, ${land(r.country)})` : ""}`);
  } else add("[vul in: partij waar de server van de dienst staat]", "de server van onze dienst");
  if (cfg.backup) {
    const o = storageOwner(cfg.backup.endpoint);
    add(o.naam, `versleutelde back-ups van de database van onze dienst${o.plek ? ` (${o.plek})` : ""}`);
  }
  if (cfg.smtpUrl) {
    const host = hostOf(cfg.smtpUrl) ?? "";
    // scwtem://…: de HTTPS-koppeling van Scaleway Transactional Email (zie mail.ts).
    add(cfg.smtpUrl.startsWith("scwtem:") || /(^|\.)(scw\.cloud|scaleway\.com)$/.test(host) ? scw : `de mailserver ${host}`, "het versturen van inlogcodes, facturen en meldingen per mail");
  }
  if (cfg.mollie.apiKey) add("Mollie B.V. (Nederland)", "de betalingen (iDEAL, SEPA-incasso en creditcard)");
  if (cfg.desec.token) add(getAdapter("desec")?.owner ?? "deSEC e.V. (Duitsland)", "de DNS van je domein, met DNSSEC");
  if (cfg.openprovider.username) add("Openprovider (Nederland)", "het registreren en verhuizen van domeinnamen; de gegevens van de houder gaan naar het register van de extensie (bij .nl: SIDN)");
  // Draait de adressendienst op deze server (BROKER_ADRES_PUBLIEK), dan zijn wij dat zelf.
  if (cfg.adresUrl && !cfg.adressenPubliek) add(`de gratis-adressendienst van het Eigen Cloud-project (${hostOf(cfg.adresUrl) ?? cfg.adresUrl})`, "de naam van je gratis adres en bij welke aanbieder die hoort; de DNS van dat adres staat bij deSEC");
  return [...map.values()];
}

/** Gegevens die in alle drie de teksten terugkomen. */
function gegevens(ctx: Ctx) {
  const b = getBrand(ctx), co = ctx.cfg.company;
  const naam = co.name ?? b.name;
  const email = b.contact.email ?? ctx.cfg.adminEmail ?? ctx.cfg.ownerEmail;
  const url = (k: Soort) => (k === "voorwaarden" ? b.termsUrl : k === "privacy" ? b.privacyUrl : null) ?? `${ctx.cfg.publicUrl}/${k}`;
  return {
    naam, email: email ?? "[vul in: e-mailadres]",
    adres: co.address.length ? co.address : ["[vul in: adres]"],
    kvk: co.kvk ?? "[vul in: KvK-nummer]", btw: co.vat,
    telefoon: b.contact.phone, website: b.contact.website, dienst: ctx.cfg.publicUrl, url,
    gratis: !!(ctx.cfg.adresUrl || ctx.cfg.freeZone),
    openprovider: !!ctx.cfg.openprovider.username,
  };
}

const wieWijZijn = (g: ReturnType<typeof gegevens>) => [
  g.naam, ...g.adres, `KvK-nummer: ${g.kvk}`, ...(g.btw ? [`Btw-nummer: ${g.btw}`] : []), `E-mail: ${g.email}`,
  ...(g.telefoon ? [`Telefoon: ${g.telefoon}`] : []), ...(g.website ? [`Website: ${g.website}`] : []),
].join("\n");

/** Een voorbeeldtekst (Nederlands) uit de gegevens van deze Dienst. */
export function voorbeeld(ctx: Ctx, kind: Soort): string {
  const g = gegevens(ctx);
  const subs = subverwerkers(ctx).map((s) => `- **${s.naam}**: ${opsomming(s.doel)}.`);
  const landen = cloudLanden(ctx);
  const vat = String(ctx.cfg.vatPercent).replace(".", ",");
  if (kind === "voorwaarden") {
    const bundels = ctx.cfg.bundles.map((b) => {
      const u = b.includes.users;
      const extra = b.extraUserMonthly ? `, extra gebruiker ${euro(b.extraUserMonthly.value)} per maand` : "";
      return `- **${b.title}**: ${euro(b.monthly.value)} per maand. ${b.description ? `${b.description.replace(/\.?\s*$/, ".")} ` : ""}${u} gebruiker${u === 1 ? "" : "s"} inbegrepen${extra}.`;
    });
    return `# Algemene voorwaarden van ${g.naam}

Deze voorwaarden gelden voor elk Eigen Cloud-abonnement dat je bij ons afsluit, in de Eigen Cloud-app of de beheerconsole. Door te bestellen ga je ermee akkoord.

## 1. Wie wij zijn
${wieWijZijn(g)}

## 2. Wat we leveren
Met een abonnement regelen wij alles wat je cloud nodig heeft en wat geld kost:
- een eigen project bij Scaleway, alleen voor jou, met de servers, de opslag en het versturen van mail;
- de DNS van je adres, met DNSSEC;
${g.openprovider ? "- als je dat kiest: een domeinnaam op jouw naam (registreren of verhuizen);\n" : ""}${g.gratis ? "- als je dat kiest: een gratis adres, zonder eigen domeinnaam;\n" : ""}- een abonnement en facturen die je zelf beheert in de app.

De app of de beheerconsole op jouw apparaat bouwt daarmee je cloud. Alles wat in je cloud staat (mail, agenda, foto's) is versleuteld met jouw hoofdsleutel. Die sleutel wordt op jouw apparaat gemaakt en komt nooit bij ons: wij kunnen je gegevens niet lezen.

## 3. Bundels en prijzen
${bundels.join("\n")}

Alle prijzen zijn per maand en inclusief ${vat}% btw. Verandert een prijs, dan geldt de nieuwe prijs voor nieuwe bestellingen. Je houdt je eigen bedrag tot je zelf van bundel wisselt of gebruikers bijkoopt; dan geldt de prijs van dat moment.

Van bundel wisselen en gebruikers bijkopen doe je in de app. Het nieuwe bedrag geldt vanaf de volgende betaling; we rekenen niet naar rato terug of bij.

## 4. Betalen
Je betaalt de eerste maand bij het bestellen, via Mollie (bijvoorbeeld met iDEAL). Daarna schrijven we elke maand automatisch af met de machtiging die je daarbij geeft. Bij elke betaling krijg je een factuur per mail; je vindt ze ook in de app.

Lukt een maandelijkse afschrijving niet, dan krijg je een mail en zie je het openstaande bedrag in de app. Daar betaal je het in één keer. Je cloud blijft intussen gewoon werken. Is het na 14 dagen nog niet betaald, dan mogen we je abonnement opschorten: de servers gaan uit en de toegang wordt ingetrokken, maar je gegevens blijven bewaard. Na betaling zetten we alles weer aan.

## 5. Looptijd en opzeggen
Je abonnement loopt per maand en is elke maand opzegbaar. Je zegt op in de app. Er wordt daarna niets meer afgeschreven en alles blijft werken tot het einde van de maand waarvoor je betaald hebt. Tot die datum kun je de opzegging in de app terugdraaien.

Na die datum bewaren we je cloud nog 30 dagen, zodat je alles kunt meenemen. Daarna verwijderen we de toegang, de servers en de opslag. Back-ups staan 30 dagen vast en verdwijnen daarna.

Je domeinnaam blijft van jou: in de app vraag je een verhuiscode aan om hem naar een andere partij te verhuizen.${g.gratis ? " Een gratis adres neem je met je overdrachtscode mee naar een andere aanbieder." : ""}

## 6. Bedenktijd
Ben je consument, dan mag je binnen 14 dagen na je bestelling zonder opgave van reden afzien van je abonnement. Mail ons daarvoor. We betalen je dan terug wat je betaald hebt, min de kosten van wat we al voor je geregeld hebben (bijvoorbeeld een geregistreerde domeinnaam).

## 7. Wat we van jou vragen
- Bewaar je herstelsleutel goed. Zonder die sleutel kan niemand je gegevens terughalen, ook wij niet.
- Gebruik je cloud niet voor spam, malware of iets anders wat niet mag. Bij misbruik mogen we je cloud opschorten.
- Zorg dat je e-mailadres klopt en, als je een domeinnaam via ons hebt, de gegevens van de houder.

## 8. Beschikbaarheid en onderhoud
We doen ons best om alles goed te laten werken. Je cloud draait op meerdere servers op verschillende plekken, zodat hij blijft werken als er één uitvalt. Onderhoud en storingen melden we in de app. Een garantie dat alles altijd werkt, geven we niet.

## 9. Aansprakelijkheid
Zijn wij aansprakelijk voor schade, dan hooguit tot het bedrag dat je ons in de 3 maanden daarvoor betaald hebt. Dat geldt niet bij opzet of grove nalatigheid. We zijn niet aansprakelijk als je je gegevens niet meer kunt openen omdat je je herstelsleutel kwijt bent.

## 10. Privacy
Hoe we met je persoonsgegevens omgaan, staat in onze privacyverklaring: ${g.url("privacy")}. Voor wat er in je cloud staat zijn wij verwerker; daarvoor geldt onze verwerkersovereenkomst: ${g.url("verwerkersovereenkomst")}.

## 11. Wijzigingen
We kunnen deze voorwaarden wijzigen. Een belangrijke wijziging melden we vooraf in de app. Ben je het er niet mee eens, dan kun je opzeggen voordat de wijziging ingaat.

## 12. Klachten en geschillen
Heb je een klacht, mail ons dan op ${g.email}. Je krijgt binnen 14 dagen antwoord. Op deze voorwaarden is het Nederlandse recht van toepassing. Komen we er samen niet uit, dan kun je naar de bevoegde rechter.
`;
  }
  if (kind === "privacy") {
    return `# Privacyverklaring van ${g.naam}

${g.naam} is verantwoordelijk voor de persoonsgegevens in deze verklaring: de gegevens die we nodig hebben voor je abonnement. Vragen? Mail ons op ${g.email}.

## 1. Wie wij zijn
${wieWijZijn(g)}

## 2. Wat er in je cloud staat, kunnen wij niet lezen
Je mail, agenda en foto's staan in je eigen cloud, versleuteld met jouw hoofdsleutel. Die sleutel wordt op jouw apparaat gemaakt en komt nooit bij ons. Onze medewerkers zien alleen technische gegevens: of je cloud werkt, hoeveel opslag hij gebruikt, welke versie draait, op hoeveel servers, en wat hij kost. Nooit de inhoud. Voor wat er in je cloud staat zijn wij verwerker en ben jij verantwoordelijk; zie onze verwerkersovereenkomst: ${g.url("verwerkersovereenkomst")}.

## 3. Welke gegevens, waarvoor en hoe lang
- **E-mailadres**: om in te loggen met een code per mail, en voor je abonnement, facturen, hulpvragen en berichten. Zolang je klant bent; daarna zolang we je facturen moeten bewaren.
- **Inlogcodes en sessies**: alleen als hash opgeslagen. Een code is 15 minuten geldig, een sessie 90 dagen.
${g.openprovider ? "- **Gegevens van de houder** van je domeinnaam (naam, adres, telefoon, e-mail), als je via ons een domeinnaam registreert of verhuist. Het register van de extensie vraagt daarom (bij .nl: SIDN). We bewaren ze versleuteld, zolang de domeinnaam via ons loopt.\n" : ""}- **Betalingen**: Mollie verwerkt je betaling. Wij bewaren per betaling het bedrag, de datum, de status en de betaalmethode (bijvoorbeeld de laatste cijfers van je rekening). Facturen bewaren we 7 jaar, omdat de wet dat vraagt.
- **Je adres en je bestelling**: je domeinnaam of gratis adres, je bundel, de uitnodigingscode waarmee je bestelde, en wat we voor je hebben aangemaakt (zoals je project bij Scaleway). Plus een logboek van wat er met je bestelling gebeurt, zoals betaald of klaargezet.
- **Technische meldingen van je cloud**: versie, gezond of niet, korte probleemmeldingen, opslaggebruik, het aantal gebruikers en servers. Zo kunnen we je waarschuwen bij een storing. We bewaren alleen de laatste melding.
- **Hulpvragen**: wat je ons vraagt en wat we antwoorden.
- **IP-adres**: alleen even in het geheugen, om te veel pogingen (misbruik) tegen te houden. We slaan het niet op.

We gebruiken deze gegevens om onze overeenkomst met jou uit te voeren. Facturen bewaren we omdat de wet dat vraagt. Misbruik tegengaan doen we omdat we daar een gerechtvaardigd belang bij hebben.

## 4. Met wie we gegevens delen
We verkopen je gegevens nooit en gebruiken ze niet voor reclame. Voor onze dienst werken we met deze partijen (subverwerkers), allemaal met servers in Europa:
${subs.join("\n")}

## 5. Hoe we je gegevens beveiligen
- Elke klant heeft een eigen project bij Scaleway, met een sleutel die alleen in dat project werkt.
- Geheimen, zoals toegangssleutels${g.openprovider ? " en de gegevens van de houder" : ""}, staan versleuteld opgeslagen (AES-256-GCM).
- Medewerkers loggen in met een code per mail én hun vingerafdruk of een authenticator-app. Elke handeling in het beheer komt in een logboek.
- De database van onze dienst gaat elk uur versleuteld naar een back-up. Die back-ups bewaren we 30 dagen.

## 6. Na je abonnement
Na het einde van je abonnement bewaren we je cloud nog 30 dagen. Daarna verwijderen we de toegang, de servers en de opslag. Facturen en betalingen bewaren we 7 jaar, omdat de wet dat vraagt. Je domeinnaam en de DNS blijven staan tot je de domeinnaam verhuist of hij afloopt.${g.gratis ? " Een gratis adres blijft staan zolang je het nog kunt meenemen, of tot je vraagt het vrij te geven." : ""}

## 7. Je rechten
Je mag je gegevens inzien, laten verbeteren of verwijderen, en je gegevens meenemen. Je mag ook bezwaar maken of vragen om minder met je gegevens te doen. Mail ons daarvoor op ${g.email}; je krijgt binnen een maand antwoord. Ben je niet tevreden over hoe we met je gegevens omgaan, dan kun je een klacht indienen bij de Autoriteit Persoonsgegevens (https://autoriteitpersoonsgegevens.nl).

## 8. Cookies
Onze dienst gebruikt geen cookies voor reclame of om je te volgen.

## 9. Wijzigingen
Als we deze verklaring wijzigen, zie je dat aan de datum en het versienummer bovenaan. Een belangrijke wijziging melden we in de app.
`;
  }
  const inhoudSubs = subverwerkers(ctx).filter((s) => /Scaleway|deSEC|adressendienst/.test(s.naam)).map((s) => `- **${s.naam}**: ${opsomming(s.doel)}.`);
  return `# Verwerkersovereenkomst

Deze verwerkersovereenkomst hoort bij de algemene voorwaarden van ${g.naam} ("wij", de verwerker). Hij geldt voor iedereen die bij ons een Eigen Cloud-abonnement heeft ("jij", de verwerkingsverantwoordelijke). Door te bestellen ga je ermee akkoord.

## 1. Waar het over gaat
Jij bepaalt wat er in je cloud staat: mail, agenda, contacten, foto's en andere bestanden van jou en van de gebruikers die je toevoegt. Daarin kunnen persoonsgegevens van anderen staan. Wij leveren de servers, de opslag, de DNS en het versturen van mail waarop je cloud draait. Daarmee verwerken wij die gegevens in jouw opdracht, alleen om je cloud te laten werken, en voor niets anders.

## 2. Wat wij wel en niet kunnen zien
Alles in je cloud is versleuteld met jouw hoofdsleutel. Die wordt op jouw apparaat gemaakt en komt nooit bij ons. Wij kunnen de inhoud dus niet lezen, gebruiken of aan anderen geven. Onze medewerkers zien alleen technische gegevens: of je cloud werkt, hoeveel opslag hij gebruikt, welke versie draait, het aantal gebruikers en servers, en wat hij kost.

## 3. Waar de gegevens staan
Je cloud draait bij Scaleway, in een eigen project alleen voor jou${landen.length ? `, in ${opsomming(landen)}` : ""}:
${plekken(ctx).join("\n")}

Je gegevens gaan niet naar landen buiten de Europese Economische Ruimte.

## 4. Subverwerkers
Je geeft ons toestemming om deze partijen in te schakelen:
${inhoudSubs.join("\n")}

Willen we een nieuwe subverwerker inschakelen, dan melden we dat minstens 30 dagen vooraf in de app. Ben je het er niet mee eens, dan kun je opzeggen.

## 5. Beveiliging
- Elke klant heeft een eigen project bij Scaleway, met een sleutel die alleen in dat project werkt.
- Je cloud draait op meerdere servers op verschillende plekken. Er zijn versleutelde back-ups die 30 dagen niet te wissen zijn.
- De sleutels die wij voor je bewaren staan versleuteld opgeslagen (AES-256-GCM).
- Medewerkers loggen in met een code per mail én hun vingerafdruk of een authenticator-app. Elke handeling in het beheer komt in een logboek.

## 6. Geheimhouding
Iedereen die voor ons werkt en de technische gegevens van je cloud kan zien, moet die geheimhouden.

## 7. Datalekken
Ontdekken we een beveiligingsprobleem dat jouw gegevens kan raken, dan melden we dat zonder onnodige vertraging en uiterlijk 48 uur nadat we het ontdekten, per mail en in de app. We vertellen wat we weten en wat we eraan doen. Jij beslist of je het meldt bij de Autoriteit Persoonsgegevens en aan de mensen om wie het gaat; wij helpen je daarbij.

## 8. Hulp bij rechten van betrokkenen
Je beheert de inhoud van je cloud zelf: je kunt gegevens inzien, verbeteren, verwijderen en meenemen. Heb je daarbij onze hulp nodig, dan helpen we je.

## 9. Einde van de overeenkomst
Deze overeenkomst loopt zolang je abonnement loopt. Daarna bewaren we je cloud nog 30 dagen, zodat je alles kunt meenemen. Daarna verwijderen we de toegang, de servers en de opslag. Back-ups staan 30 dagen vast en verdwijnen daarna.

## 10. Controle
Je mag ons vragen hoe we ons aan deze afspraken houden. We geven je de informatie die je daarvoor nodig hebt.

## 11. Aansprakelijkheid
Voor deze overeenkomst geldt dezelfde aansprakelijkheid als in onze algemene voorwaarden: ${g.url("voorwaarden")}.

## 12. Contact
${g.naam}, ${g.email}.
`;
}

// ───────── Opslaan en publiceren ─────────

function docView(ctx: Ctx, kind: Soort) {
  const d = currentDoc(ctx, kind);
  const by = d?.created_by ? getStaff(ctx, d.created_by) : undefined;
  return {
    kind, title: TITELS[kind], url: `${ctx.cfg.publicUrl}/${kind}`, published: !!d,
    version: d?.version ?? null, updatedAt: d?.created_at ?? null, updatedBy: by ? (by.name || by.email) : null,
    body: d?.body ?? "", history: history(ctx, kind),
  };
}

const cleanBody = (raw: unknown) => {
  const body = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
  if (body.length < 20) throw new UserError(400, "De tekst is te kort");
  if (body.length > MAX_BODY) throw new UserError(400, "De tekst is te lang (hooguit 200.000 tekens)");
  return `${body}\n`;
};

/**
 * Een nieuwe versie bewaren en publiceren. Ongewijzigd: geen nieuwe versie (en geen bericht). `announce`: alle klanten
 * krijgen een bericht in de app (30 dagen), met `summary` als korte uitleg.
 */
export function saveDoc(ctx: Ctx, by: StaffRow | null, kind: Soort, raw: { body?: unknown; announce?: unknown; summary?: unknown }) {
  const body = cleanBody(raw.body);
  const cur = currentDoc(ctx, kind);
  if (cur && cur.body === body) return { changed: false, announcement: null };
  const version = (cur?.version ?? 0) + 1;
  const now = Date.now();
  let announcement: ReturnType<typeof announcementView> | null = null;
  let annId: string | null = null;
  if (raw.announce === true && cur) {
    const summary = String(raw.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const what = TITELS[kind].toLowerCase();
    const a = createAnnouncement(ctx, by, {
      title: `${TITELS[kind]} gewijzigd`,
      body: `We hebben onze ${what} bijgewerkt (versie ${version}, ${dateNl(now)}).${summary ? ` ${summary.replace(/\.?$/, ".")}` : ""} Je leest de nieuwe tekst op ${ctx.cfg.publicUrl}/${kind}. Heb je vragen, neem dan contact met ons op.`,
      severity: "info", endsAt: now + ANNOUNCE_MS,
    });
    annId = a.id;
    announcement = announcementView(a, true);
  }
  ctx.db.prepare("INSERT INTO legal_docs (kind, version, body, created_at, created_by, announcement_id) VALUES (?, ?, ?, ?, ?, ?)").run(kind, version, body, now, by?.id ?? null, annId);
  return { changed: true, announcement };
}

// ───────── Routes ─────────

/** De handler van registerAdmin (inlogcontrole, rechten, nette foutmeldingen). */
type AdminHandler = <R extends { Params?: any; Body?: any; Querystring?: any }>(perm: "brand", fn: (s: StaffRow, req: FastifyRequest<R>, reply: FastifyReply) => Promise<unknown>) =>
  (req: FastifyRequest<R>, reply: FastifyReply) => Promise<unknown>;

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function registerJuridisch(app: FastifyInstance, ctx: Ctx, admin: AdminHandler) {
  const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).type("text/html; charset=utf-8")
    .header("content-security-policy", PAGE_CSP).header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer")
    .header("cache-control", "no-cache").send(body);
  const need = (k: string) => { if (!isSoort(k)) throw new UserError(404, "Dit document bestaat niet"); return k; };

  // ── Openbaar ──
  for (const kind of SOORTEN) {
    app.get<{ Querystring: { versie?: string } }>(`/${kind}`, async (req, reply) => {
      const cur = currentDoc(ctx, kind);
      const v = req.query.versie ? Number(req.query.versie) : null;
      const d = v && cur && v !== cur.version ? docVersion(ctx, kind, v) : cur;
      if (!d) {
        const b = getBrand(ctx);
        return html(reply, 404, `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(TITELS[kind])} — ${esc(b.name)}</title>
<style>body{font:17px/1.55 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 20px;color:#1d2a2f;background:#f3f5f2}@media (prefers-color-scheme:dark){body{background:#121a1c;color:#e4ece8}}</style></head>
<body><h1>${esc(TITELS[kind])}</h1><p>${v && cur ? "Deze versie bestaat niet." : `${esc(b.name)} heeft dit document nog niet gepubliceerd.`}${b.contact.email ? ` Vragen? Mail <a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a>.` : ""}</p></body></html>`);
      }
      return html(reply, 200, renderPage(ctx, kind, { body: d.body, version: d.version, at: d.created_at }, { older: d !== cur }));
    });
  }
  /** Wat er gepubliceerd is (voor "Je dienst" in de console en de app). */
  app.get("/v1/juridisch", async () => ({
    documents: SOORTEN.filter((k) => currentDoc(ctx, k)).map((k) => { const d = currentDoc(ctx, k)!; return { kind: k, title: TITELS[k], url: `${ctx.cfg.publicUrl}/${k}`, version: d.version, updatedAt: d.created_at }; }),
  }));

  // ── Beheer (recht "brand", zoals de huisstijl) ──
  app.get("/v1/admin/juridisch", admin("brand", async () => {
    const b = getBrand(ctx);
    const own = (k: "termsUrl" | "privacyUrl", kind: Soort) => !!b[k] && b[k] !== hostedDoc(ctx, kind);
    return {
      documents: SOORTEN.map((k) => docView(ctx, k)),
      termsUrl: b.termsUrl, privacyUrl: b.privacyUrl,
      own: { termsUrl: own("termsUrl", "voorwaarden"), privacyUrl: own("privacyUrl", "privacy") },
    };
  }));
  app.get<{ Params: { kind: string } }>("/v1/admin/juridisch/:kind/voorbeeld", admin("brand", async (_s, req) => {
    const kind = need(req.params.kind);
    return { kind, body: voorbeeld(ctx, kind), subverwerkers: subverwerkers(ctx) };
  }));
  app.post<{ Params: { kind: string }; Body: { body?: string } }>("/v1/admin/juridisch/:kind/weergave", admin("brand", async (_s, req, reply) => {
    const kind = need(req.params.kind);
    return html(reply, 200, renderPage(ctx, kind, { body: cleanBody(req.body?.body), version: null, at: null }));
  }));
  app.put<{ Params: { kind: string }; Body: { body?: string; announce?: boolean; summary?: string } }>("/v1/admin/juridisch/:kind", admin("brand", async (s, req) => {
    const kind = need(req.params.kind);
    const r = saveDoc(ctx, s, kind, req.body ?? {});
    const doc = docView(ctx, kind);
    if (r.changed) audit(ctx, s, "juridisch-change", kind, { version: doc.version, announced: !!r.announcement });
    return { document: doc, changed: r.changed, announcement: r.announcement };
  }));
}
