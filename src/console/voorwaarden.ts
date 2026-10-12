/**
 * "Voorwaarden en privacy" in Je dienst: wat de Dienst zelf host (GET /v1/juridisch: voorwaarden, privacyverklaring,
 * verwerkersovereenkomst met versie en datum) en welke links de app laat zien (GET /v1/brand: termsUrl, privacyUrl).
 * Maken en wijzigen gebeurt in het beheer van de Dienst (pagina Voorwaarden en privacy, zie src/broker/juridisch.ts).
 * De Android-app heeft hetzelfde in Java (android/core DienstVoorwaarden.java); de JSON is gelijk.
 */
import type { AdminConfig } from "./vault.js";
import { aanbiederNet, type AanbiederState } from "./aanbieder.js";

export const DOCUMENTEN: [string, string][] = [["voorwaarden", "Algemene voorwaarden"], ["privacy", "Privacyverklaring"], ["verwerkersovereenkomst", "Verwerkersovereenkomst"]];

async function get(url: string): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  let j: any = null;
  try { j = await r.json(); } catch { /* geen JSON */ }
  return { status: r.status, json: j };
}

/** GET /api/aanbieder/juridisch */
export async function status(c: AdminConfig) {
  const a = (c.console as { aanbieder?: AanbiederState }).aanbieder;
  if (!a?.url || !a.server) throw new Error("Er draait nog geen Dienst");
  const base = aanbiederNet.reach(a.url);
  const leeg = (fout: string, bereikbaar: boolean) => ({ bereikbaar, documenten: DOCUMENTEN.map(([soort, titel]) => ({ soort, titel, versie: null, gewijzigd: null, url: null })), termsUrl: null, privacyUrl: null, fout });
  let j: { status: number; json: any }, b: { status: number; json: any };
  try { [j, b] = await Promise.all([get(`${base}/v1/juridisch`), get(`${base}/v1/brand`)]); }
  catch { return leeg("Je Dienst is nu niet bereikbaar", false); }
  if (b.status !== 200 || !b.json) return leeg(`Je Dienst antwoordt ${b.status}`, false);
  const docs: any[] = j.status === 200 && Array.isArray(j.json?.documents) ? j.json.documents : [];
  return {
    bereikbaar: true,
    documenten: DOCUMENTEN.map(([soort, titel]) => {
      const d = docs.find((x) => x?.kind === soort);
      return { soort, titel, versie: typeof d?.version === "number" ? d.version : null, gewijzigd: typeof d?.updatedAt === "number" ? d.updatedAt : null, url: typeof d?.url === "string" ? d.url : null };
    }),
    termsUrl: typeof b.json.termsUrl === "string" ? b.json.termsUrl : null,
    privacyUrl: typeof b.json.privacyUrl === "string" ? b.json.privacyUrl : null,
    fout: j.status === 404 ? "Je Dienst kan dit nog niet: hij werkt zichzelf vannacht bij (zie Updates)." : null,
  };
}
