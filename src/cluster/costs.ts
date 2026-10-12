/**
 * Kosten en budget: een schatting van wat de draaiende cloud per maand kost, per aanbieder en in totaal.
 *
 *   servers  = de maandprijs per server: wat de aanbieder bij het aanmaken gaf (nodes.monthly_cost), anders de prijs
 *              van dat formaat uit de catalogus van de console (instelling cost_servers, "aanbieder/regio/formaat").
 *              Slaapt de cloud, dan zijn er geen servers en kosten die niets.
 *   opslag   = bytes in de bucket (10^9 bytes = 1 GB) × de lijstprijs per GB per maand van die aanbieder
 *              (StorageCapability.pricePerGbMonth). Onbekende prijs: null ("onbekend"); telt dan niet mee.
 *   uitgaand verkeer telt niet mee (bij gewoon gebruik klein en vaak inbegrepen).
 *
 * Pure functies: de console (src/console/costs.ts, en Costs.java in de Android-app) en het cluster
 * (gezondheidscontrole "Kosten", src/cluster/service.ts) rekenen hiermee op dezelfde manier.
 */
import type { Check } from "../health.js";

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** "€ 12,30" */
export const euro = (n: number) => "€ " + n.toFixed(2).replace(".", ",");

type SizePrice = { size?: string; monthly?: number | null } | undefined;

/**
 * Maandprijzen per "aanbieder/regio/formaat" uit de catalogus van de console (console.catalog: per aanbieder en regio
 * het gekozen formaat voor data en witness). Alleen bekende prijzen. Gaat als instelling cost_servers naar het cluster.
 */
export function serverPrices(catalog: Record<string, Record<string, { data?: SizePrice; witness?: SizePrice }>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [provider, regions] of Object.entries(catalog ?? {})) {
    for (const [region, picks] of Object.entries(regions ?? {})) {
      for (const s of [picks?.data, picks?.witness]) {
        if (s?.size && typeof s.monthly === "number") out[`${provider}/${region}/${s.size}`] = s.monthly;
      }
    }
  }
  return out;
}

export interface CostNode { provider: string; region?: string | null; size?: string | null; monthly_cost?: number | null }

/** Maandprijs van één server: wat de aanbieder opgaf, anders de catalogusprijs, anders null (onbekend). */
export function serverPrice(prices: Record<string, number>, n: CostNode): number | null {
  if (typeof n.monthly_cost === "number") return n.monthly_cost;
  const p = prices[`${n.provider}/${n.region ?? ""}/${n.size ?? ""}`];
  return typeof p === "number" ? p : null;
}

/**
 * Bij welke aanbieder een opslag hoort: de console noemt hem "<aanbieder>-<regio>[-backup]". Het langste
 * passende id wint; geen: null.
 */
export function storeOfferId(storeName: string, ids: string[]): string | null {
  let best: string | null = null;
  for (const id of ids) if (storeName.startsWith(`${id}-`) && (!best || id.length > best.length)) best = id;
  return best;
}

export interface ProviderCost {
  id: string;
  name: string;
  /** Servers per maand (0 als er geen draaien), of null als van een server de prijs onbekend is. */
  servers: number | null;
  /** Opslag per maand (0 zonder opslag), of null als de prijs of het gebruik onbekend is. */
  storage: number | null;
  /** Bytes in de opslag van deze aanbieder (null: niet te meten). */
  bytes: number | null;
  /** Wat bekend is, opgeteld. */
  total: number;
  source: "geschat" | "aanbieder";
}

export interface Estimate { providers: ProviderCost[]; total: number; complete: boolean }

/**
 * De schatting. `servers`: de draaiende servers met hun maandprijs (of null); `stores`: per opslag de aanbieder (of
 * null: dan geldt de opslagnaam als aanbieder), de bytes en de prijs per GB per maand. Volgorde: eerst de aanbieders
 * van servers, dan die van opslag, in de volgorde waarin ze voorkomen.
 */
export function estimate(
  servers: { provider: string; monthly: number | null }[],
  stores: { name: string; provider: string | null; bytes: number | null; pricePerGbMonth: number | null }[],
  nameOf: (id: string) => string,
): Estimate {
  const map = new Map<string, { servers: number | null; storage: number | null; bytes: number | null }>();
  const get = (id: string) => {
    let p = map.get(id);
    if (!p) { p = { servers: 0, storage: 0, bytes: 0 }; map.set(id, p); }
    return p;
  };
  for (const s of servers) {
    const p = get(s.provider);
    p.servers = s.monthly === null || p.servers === null ? null : p.servers + s.monthly;
  }
  for (const s of stores) {
    const p = get(s.provider ?? s.name);
    p.bytes = s.bytes === null || p.bytes === null ? null : p.bytes + s.bytes;
    p.storage = s.bytes === null || s.pricePerGbMonth === null || p.storage === null ? null : p.storage + (s.bytes / 1e9) * s.pricePerGbMonth;
  }
  let total = 0;
  let complete = true;
  const providers: ProviderCost[] = [];
  for (const [id, p] of map) {
    const sv = p.servers === null ? null : r2(p.servers);
    const st = p.storage === null ? null : r2(p.storage);
    if (sv === null || st === null) complete = false;
    const t = r2((sv ?? 0) + (st ?? 0));
    total += t;
    providers.push({ id, name: nameOf(id), servers: sv, storage: st, bytes: p.bytes, total: t, source: "geschat" });
  }
  return { providers, total: r2(total), complete };
}

/** Budget uit een instelling of invoer: een positief bedrag (op centen), anders null (geen budget). */
export function parseBudget(v: unknown): number | null {
  const t = typeof v === "string" ? v.trim() : "";
  const n = typeof v === "number" ? v : /^\d+([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? r2(n) : null;
}

/** De gezondheidscontrole "Kosten" (alleen met een budget). Boven het budget: aandachtspunt (één melding per mail). */
export function costCheck(c: { total: number; complete: boolean; budget: number }): Check {
  const over = c.total > c.budget;
  const unknown = c.complete ? "" : " Van een deel is de prijs onbekend; dat telt niet mee.";
  return {
    id: "costs", group: "Kosten", title: "Kosten binnen je budget", status: over ? "warn" : "ok",
    detail: over
      ? `Geschat ${euro(c.total)} per maand; je budget is ${euro(c.budget)}. In de beheerconsole zie je bij Kosten wat elke aanbieder kost.${unknown}`
      : `Geschat ${euro(c.total)} per maand, binnen je budget van ${euro(c.budget)}.${unknown}`,
  };
}
