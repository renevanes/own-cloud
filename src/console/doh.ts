/**
 * DNS opzoeken via DNS-over-HTTPS (RFC 8484, het binaire DNS-bericht met GET ?dns=…), bij Europese resolvers die geen
 * IP-adressen van gebruikers bewaren:
 *  - Quad9 zonder blokkeerlijst (stichting in Zwitserland): https://dns10.quad9.net/dns-query — docs.quad9.net/services/
 *    (9.9.9.10, "No threat blocking"; zo telt een domein op een blokkeerlijst niet als "bestaat niet") en
 *    quad9.net/support/faq ("Quad9 does not store IP address data of clients");
 *  - DNS4EU, onversleuteld/ongefilterd (Whalebone, Tsjechië, EU): https://unfiltered.joindns4.eu/dns-query —
 *    joindns4.eu/for-public (IP-adres geanonimiseerd voordat er iets wordt gelogd).
 * JSON (application/dns-json) staat bij Quad9 niet in de documentatie; daarom het standaardformaat (RFC 8484).
 *
 * De console (dit bestand) en de Android-app (android/core Doh.java) doen precies hetzelfde, zodat "waar staat de DNS
 * van dit domein" op de computer en de telefoon hetzelfde antwoord geeft. Andere resolvers (tests): EIGEN_DOH_URLS,
 * met komma's gescheiden.
 */

export const DOH_DEFAULT = ["https://dns10.quad9.net/dns-query", "https://unfiltered.joindns4.eu/dns-query"];
export const dohUrls = () => (process.env.EIGEN_DOH_URLS ? process.env.EIGEN_DOH_URLS.split(",").map((x) => x.trim()).filter(Boolean) : DOH_DEFAULT);
/** Hoe lang de console op één resolver wacht. */
export const DOH_TIMEOUT_MS = 4000;

export type DohType = "A" | "AAAA" | "NS" | "DS";
const TYPES: Record<DohType, number> = { A: 1, NS: 2, AAAA: 28, DS: 43 };

/** De vraag als DNS-bericht (id 0, recursie gewenst, één vraag, klasse IN). */
export function encodeQuery(name: string, type: DohType): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts: Buffer[] = [Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of labels) {
    const b = Buffer.from(l.toLowerCase(), "ascii");
    if (b.length > 63) throw new Error("Te lange naam");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0, TYPES[type] >> 8, TYPES[type] & 255, 0, 1]));
  return Buffer.concat(parts);
}

/** Een naam uit het bericht lezen (met verwijzingen, RFC 1035 4.1.4); geeft de naam en waar het veld eindigt. */
function readName(m: Buffer, at: number): [string, number] {
  const labels: string[] = [];
  let pos = at, end = -1, jumps = 0;
  for (;;) {
    if (pos >= m.length) throw new Error("Kapot DNS-antwoord");
    const len = m[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= m.length || ++jumps > 20) throw new Error("Kapot DNS-antwoord");
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | m[pos + 1];
      continue;
    }
    if (len === 0) { if (end < 0) end = pos + 1; break; }
    labels.push(m.subarray(pos + 1, pos + 1 + len).toString("latin1"));
    pos += 1 + len;
  }
  return [labels.join(".").toLowerCase(), end];
}

/** IPv6 zoals in RFC 5952: kleine letters, de langste reeks nullen (minstens twee groepen, de eerste bij gelijk) als "::". */
export function ipv6Text(b: Uint8Array): string {
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

export interface DohAnswer {
  /** 0 = gevonden (of geen records van dit type), 3 = bestaat niet (NXDOMAIN), anders een fout bij de resolver. */
  rcode: number;
  /** De waarden van het gevraagde type: A/AAAA een adres, NS een naam (kleine letters, zonder punt), DS "tag alg type digest". */
  values: string[];
}

/** Een antwoordbericht uitlezen; alleen records van het gevraagde type tellen. */
export function decodeAnswer(m: Buffer, type: DohType): DohAnswer {
  if (m.length < 12) throw new Error("Kapot DNS-antwoord");
  const rcode = m[3] & 0x0f;
  const qd = m.readUInt16BE(4), an = m.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(m, pos)[1] + 4;
  const values: string[] = [];
  for (let i = 0; i < an; i++) {
    pos = readName(m, pos)[1];
    if (pos + 10 > m.length) throw new Error("Kapot DNS-antwoord");
    const t = m.readUInt16BE(pos), len = m.readUInt16BE(pos + 8);
    const rd = pos + 10;
    if (rd + len > m.length) throw new Error("Kapot DNS-antwoord");
    if (t === TYPES[type]) {
      if (t === 1 && len === 4) values.push(`${m[rd]}.${m[rd + 1]}.${m[rd + 2]}.${m[rd + 3]}`);
      else if (t === 28 && len === 16) values.push(ipv6Text(m.subarray(rd, rd + 16)));
      else if (t === 2) values.push(readName(m, rd)[0]);
      else if (t === 43 && len > 4) values.push(`${m.readUInt16BE(rd)} ${m[rd + 2]} ${m[rd + 3]} ${m.subarray(rd + 4, rd + len).toString("hex")}`);
    }
    pos = rd + len;
  }
  return { rcode, values };
}

/**
 * Opzoeken bij de eerste resolver die antwoordt (anders de volgende). null als geen enkele resolver een bruikbaar
 * antwoord gaf (geen internet, of alles geblokkeerd).
 */
export async function dohLookup(name: string, type: DohType): Promise<DohAnswer | null> {
  const q = encodeQuery(name, type).toString("base64url");
  for (const base of dohUrls()) {
    try {
      const r = await fetch(`${base}${base.includes("?") ? "&" : "?"}dns=${q}`, { headers: { accept: "application/dns-message" }, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) });
      if (!r.ok) continue;
      const a = decodeAnswer(Buffer.from(await r.arrayBuffer()), type);
      // SERVFAIL e.d.: misschien weet de volgende resolver het wel.
      if (a.rcode !== 0 && a.rcode !== 3) continue;
      return a;
    } catch { /* volgende resolver */ }
  }
  return null;
}

/** Bekende DNS-aanbieders, herkend aan hun nameservers (achtervoegsel → naam). */
const NS_NAMES: [RegExp, string][] = [
  [/(^|\.)desec\.(io|org)$/, "deSEC"],
  [/(^|\.)openprovider\.(nl|be|eu|com)$/, "Openprovider"],
  [/(^|\.)transip\.(net|nl|eu)$/, "TransIP"],
  [/(^|\.)hetzner\.(com|de)$/, "Hetzner"],
  [/(^|\.)dom\.scw\.cloud$/, "Scaleway"],
  [/(^|\.)(ovh\.net|ovh\.ca|anycast\.me)$/, "OVHcloud"],
  [/(^|\.)exoscale\.(ch|com|io|net)$/, "Exoscale"],
  [/(^|\.)cloudflare\.com$/, "Cloudflare"],
  [/(^|\.)domaincontrol\.com$/, "GoDaddy"],
  [/(^|\.)registrar-servers\.com$/, "Namecheap"],
  [/(^|\.)gandi\.net$/, "Gandi"],
  [/(^|\.)versio\.(nl|eu)$/, "Versio"],
  [/(^|\.)strato\.(de|nl)$/, "Strato"],
  [/(^|\.)mijndomein\.nl$/, "Mijndomein"],
  [/(^|\.)hostnet\.nl$/, "Hostnet"],
  [/(^|\.)antagonist\.nl$/, "Antagonist"],
  [/(^|\.)vimexx\.nl$/, "Vimexx"],
  [/(^|\.)one\.com$/, "one.com"],
  [/(^|\.)(ui-dns\.(com|org|de|biz)|ionos\.\w+)$/, "IONOS"],
  [/(^|\.)hostinger\.\w+$/, "Hostinger"],
  [/(^|\.)awsdns-\d+\.\w+$/, "Amazon"],
  [/(^|\.)azure-dns\.\w+$/, "Microsoft Azure"],
  [/(^|\.)(googledomains\.com|google\.com)$/, "Google"],
];

/** Naam van de DNS-aanbieder bij deze nameservers (de eerste die we herkennen), of null. */
export function nsProvider(ns: string[]): string | null {
  for (const n of ns) for (const [re, name] of NS_NAMES) if (re.test(n.toLowerCase().replace(/\.$/, ""))) return name;
  return null;
}

/** Staan alle verwachte nameservers (hoofdletters en punt aan het eind maken niet uit) bij het domein? */
export function nsMatch(have: string[], want: string[]) {
  const norm = (x: string) => x.toLowerCase().replace(/\.$/, "");
  const h = new Set(have.map(norm));
  return want.length > 0 && want.every((w) => h.has(norm(w)));
}
