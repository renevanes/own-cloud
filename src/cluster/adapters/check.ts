/**
 * "Sleutels controleren": nagaan of de inloggegevens bij een aanbieder werken en genoeg mogen, met ALLEEN lezende
 * verzoeken (GET of HEAD). Er wordt nooit iets aangemaakt of gewijzigd.
 *
 * Elke controle is één regel in een lijstje: { id, label, ok, detail } met ok = true (✓), false (✗, detail zegt wat
 * je waar moet aanpassen) of null (? — niet te zien via de API, of niet gecontroleerd omdat inloggen al mislukte).
 * De teksten zijn Nederlands, in gewone taal, en precies gelijk aan die van de Java-kern (KeyCheck.java): de console
 * en de Android-app tonen hetzelfde lijstje.
 *
 * Adapters geven een `check` bij servers en/of DNS (zie types.ts); opslag is generiek S3 (checkStorage hieronder).
 */
import type { ProviderAdapter } from "./types.js";
import { S3Store, type StoreConfig } from "../stores.js";

export interface KeyCheck {
  id: string;
  label: string;
  /** true = in orde, false = niet in orde (detail zegt wat te doen), null = onbekend of niet gecontroleerd. */
  ok: boolean | null;
  detail: string;
}

export const row = (id: string, label: string, ok: boolean | null, detail = ""): KeyCheck => ({ id, label, ok, detail });

export const NOT_CHECKED = "Niet gecontroleerd, want inloggen lukt niet";
export const RIGHTS_HIDDEN = "Kan de aanbieder niet laten zien; blijkt bij het starten";

export const L = {
  login: "Inloggen lukt",
  servers: "Servers bekijken",
  sizes: "Formaten en prijzen ophalen",
  rights: "Rechten voor servers maken",
  project: "Project bekijken",
  zone: "DNS-zone bekijken",
  zones: "DNS-zones bekijken",
  dnsRights: "Rechten om DNS te wijzigen",
};

export type Look = { status: number; text: string; json: any };

/**
 * Eén lezend verzoek. Gooit nooit: zonder verbinding is de status 0 en de tekst de foutmelding.
 * `method` is alleen GET of HEAD.
 */
export async function look(url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Look> {
  try {
    const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
    return { status: r.status, text, json };
  } catch (e) {
    // fetch zegt alleen "fetch failed"; de oorzaak (DNS, geweigerd, tijd verstreken) staat in cause.
    const cause = (e as { cause?: { message?: string } })?.cause?.message;
    return { status: 0, text: `${String((e as Error)?.message ?? e)}${cause ? ` (${cause})` : ""}`, json: null };
  }
}

export const good = (s: number) => s >= 200 && s < 300;

/** Uitleg bij een onverwacht antwoord (of geen verbinding). */
export function failText(r: { status: number; text: string }) {
  const t = r.text.trim().slice(0, 120);
  if (r.status === 0) return `Geen verbinding met de aanbieder: ${t}`;
  return `De aanbieder antwoordde met fout ${r.status}${t ? `: ${t}` : ""}`;
}

/** Inloggen mislukt: die regel ✗, de rest "niet gecontroleerd". */
export function loginFailed(detail: string, rest: [string, string][]): KeyCheck[] {
  return [row("login", L.login, false, detail), ...rest.map(([id, label]) => row(id, label, null, NOT_CHECKED))];
}

/**
 * Voor een aanbieder zonder eigen `servers.check`: inloggen (servers opsommen, zoals bij koppelen) en de formaten in
 * de eerste regio ophalen. Ook dat is alleen lezen.
 */
export async function genericServersCheck(a: ProviderAdapter, fields: Record<string, string>, cluster: string): Promise<KeyCheck[]> {
  try {
    await a.servers!.create(fields).list(cluster);
  } catch (e) {
    return loginFailed((e as Error).message.replace(/https?:\/\/\S+/, "").slice(0, 160), [["sizes", L.sizes], ["rights", L.rights]]);
  }
  const out = [row("login", L.login, true)];
  try {
    const sizes = await a.servers!.fetchSizes(fields, a.servers!.regions[0]?.id ?? "");
    out.push(row("sizes", L.sizes, true, `${sizes.length} formaten`));
  } catch (e) {
    out.push(row("sizes", L.sizes, false, (e as Error).message.slice(0, 160)));
  }
  out.push(row("rights", L.rights, null, RIGHTS_HIDDEN));
  return out;
}

/** Een rechtenregel als "GET /cloud/project/*" dekt een pad als "/cloud/project/abc/instance" (* = alles). */
export function ruleCovers(rules: { method?: string; path?: string }[], method: string, path: string) {
  return rules.some((r) => r.method === method && typeof r.path === "string"
    && new RegExp("^" + r.path.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(path));
}

// ───────── Opslag (S3, voor elke aanbieder gelijk) ─────────

/**
 * Opslag controleren: de lijst met buckets opvragen (inloggen), de eigen bucket bekijken (HEAD) en één bestandsnaam
 * opvragen. Schrijven test de console pas bij het koppelen (een klein testbestand); dat hoort hier niet.
 */
export async function checkStorage(cfg: StoreConfig): Promise<KeyCheck[]> {
  const s = new S3Store(cfg);
  const bucket = cfg.bucket ?? "";
  const rest: [string, string][] = bucket ? [["bucket", "Bucket bekijken"], ["objects", "Bestanden bekijken"]] : [];
  const b = await s.probe("buckets").catch((e: Error) => ({ status: 0, code: e.message, count: 0 }));
  const out: KeyCheck[] = [];
  if (good(b.status)) out.push(row("login", L.login, true, `Buckets: ${b.count}`));
  else if (b.code === "InvalidAccessKeyId") return loginFailed("De opslag herkent deze toegangssleutel niet. Kopieer hem opnieuw of maak een nieuwe.", rest);
  else if (b.code === "SignatureDoesNotMatch") return loginFailed("De geheime sleutel hoort niet bij deze toegangssleutel. Kopieer hem opnieuw.", rest);
  else if (b.status === 403) out.push(row("login", L.login, null, "Deze sleutel mag de lijst met buckets niet opvragen. Dat is niet erg als hij wel bij de eigen bucket kan."));
  else return loginFailed(failText({ status: b.status, text: b.code }), rest);
  if (!bucket) return out;
  const h = await s.probe("bucket").catch((e: Error) => ({ status: 0, code: e.message, count: 0 }));
  if (good(h.status)) out.push(row("bucket", "Bucket bekijken", true, `${bucket} gevonden`));
  else if (h.status === 404) out.push(row("bucket", "Bucket bekijken", null, `${bucket} bestaat nog niet; de console maakt hem aan bij het koppelen.`));
  else if (h.status === 403) out.push(row("bucket", "Bucket bekijken", false, `Geen toegang tot ${bucket}. Bestaat hij al bij iemand anders, of mag de sleutel er niet bij?`));
  else if (h.status === 301) out.push(row("bucket", "Bucket bekijken", false, `${bucket} staat in een andere regio dan deze opslag.`));
  else out.push(row("bucket", "Bucket bekijken", false, failText({ status: h.status, text: h.code })));
  if (!good(h.status)) { out.push(row("objects", "Bestanden bekijken", null, "Niet gecontroleerd, want de bucket is niet te bekijken")); return out; }
  const o = await s.probe("objects").catch((e: Error) => ({ status: 0, code: e.message, count: 0 }));
  if (good(o.status)) out.push(row("objects", "Bestanden bekijken", true));
  else if (o.status === 403) out.push(row("objects", "Bestanden bekijken", false, "De sleutel mag de bestanden in deze bucket niet bekijken. Geef hem lees- en schrijfrechten op de bucket."));
  else out.push(row("objects", "Bestanden bekijken", false, failText({ status: o.status, text: o.code })));
  return out;
}
