/**
 * Zonelimiet bij deSEC (Je dienst → Adressendienst): elk gratis adres is een eigen zone in het deSEC-account van de
 * gedeelde zone, en elke klant met een eigen domein een zone in het deSEC-account van de Dienst. deSEC heeft een limiet
 * per account; een hogere vraag je per mail aan support@desec.io (vanaf het e-mailadres van het account). De mail stelt
 * de console zelf op (web-console/console.js); hier alleen wat deSEC laat zien:
 * - GET /api/v1/auth/account/ → email en limit_domains (alleen met een token dat tokens mag beheren, anders 403);
 * - GET /api/v1/domains/?cursor= → het aantal zones (per 500, de volgende bladzijde in de kop Link, rel="next").
 * De Android-app heeft hetzelfde in Java (android/core ZoneLimiet.java); de JSON is gelijk.
 */
import type { AdminConfig } from "./vault.js";
import type { AanbiederState } from "./aanbieder.js";
import { DESEC_URL } from "./extras.js";

export const DESEC_SUPPORT = "support@desec.io";

/** De volgende bladzijde uit een Link-kop: <https://…>; rel="next" */
export function nextLink(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/** GET /api/aanbieder/zonelimiet?welke=adressen|dienst */
export async function zonelimiet(c: AdminConfig, welke: string) {
  const a = (c.console as { aanbieder?: AanbiederState }).aanbieder;
  const w = welke === "adressen" ? "adressen" : "dienst";
  const token = w === "adressen" ? a?.adressen?.desecToken : a?.accounts?.desecToken;
  if (!a || !token) throw new Error(w === "adressen" ? "De gratis-adressendienst draait niet op de server van je Dienst" : "Er is nog geen deSEC-token (Accounts en sleutels)");
  const h = { authorization: `Token ${token}`, accept: "application/json" };
  const get = async (url: string) => {
    try { return await fetch(url, { headers: h, signal: AbortSignal.timeout(10_000) }); }
    catch { throw new Error("deSEC is nu niet bereikbaar"); }
  };
  const fouten: string[] = [];
  let account: string | null = null, limiet: number | null = null, zones: number | null = null;
  try {
    const r = await get(`${DESEC_URL()}/auth/account/`);
    if (r.status === 401) throw new Error("deSEC accepteert dit token niet");
    if (r.status === 403) fouten.push("Dit token mag de accountgegevens niet lezen; deSEC laat de limiet dan niet zien.");
    else if (!r.ok) fouten.push(`deSEC antwoordt ${r.status} op de accountgegevens.`);
    else {
      const j = (await r.json().catch(() => { throw new Error("deSEC gaf geen geldige accountgegevens"); })) as { email?: unknown; limit_domains?: unknown };
      account = typeof j.email === "string" ? j.email : null;
      limiet = typeof j.limit_domains === "number" ? j.limit_domains : null;
    }
    let url: string | null = `${DESEC_URL()}/domains/?cursor=`;
    let n = 0;
    for (let page = 0; url && page < 100; page++) {
      const d: Response = await get(url);
      if (d.status === 401 || d.status === 403) throw new Error("deSEC accepteert dit token niet");
      if (!d.ok) throw new Error(`deSEC antwoordt ${d.status} op de lijst met zones`);
      const list = await d.json().catch(() => { throw new Error("deSEC gaf geen geldige lijst met zones"); });
      n += Array.isArray(list) ? list.length : 0;
      url = nextLink(d.headers.get("link"));
    }
    zones = n;
  } catch (e) { fouten.push((e as Error).message.replace(/\.?$/, ".")); }
  return { welke: w, zone: w === "adressen" ? a.adressen!.zone : null, account, zones, limiet, support: DESEC_SUPPORT, fout: fouten.length ? fouten.join(" ") : null };
}
