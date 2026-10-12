/**
 * Kosten op het overzicht van de beheerconsole (GET /api/costs) en het budget (POST /api/costs/budget).
 * De rekenregels staan in src/cluster/costs.ts; Costs.java in de Android-app doet precies hetzelfde.
 *
 * Draaiende servers: van de leider (live), slaapt de cloud dan geen (servers kosten dan niets, opslag wel), is hij
 * onbereikbaar dan de servers uit het manifest (die staan waarschijnlijk nog aan). Opslaggebruik: de bytes in elke
 * bucket, hooguit eens per uur opnieuw gemeten.
 */
import { estimate, parseBudget, serverPrice, serverPrices, storeOfferId, type CostNode } from "../cluster/costs.js";
import { makeStore } from "../cluster/stores.js";
import type { Manifest } from "../cluster/admin.js";
import type { AdminConfig } from "./vault.js";
import type { StoreOffer } from "./catalog.js";

const measured = new Map<string, { at: number; bytes: number | null }>();
const MEASURE_MS = 3600e3;

/** Alleen voor tests: metingen vergeten. */
export function forgetMeasurements() { measured.clear(); }

/** De servers die nu geld kosten, en of de cloud slaapt. */
export function runningServers(st: { manifest: Manifest | null; live: any }): { sleeping: boolean; nodes: CostNode[] } {
  if (st.live?.leader) {
    const nodes = ((st.live.nodes ?? []) as (CostNode & { status?: string })[]).filter((n) => n.status !== "removed" && n.status !== "failed" && n.provider !== "manual");
    return { sleeping: false, nodes: nodes.map((n) => ({ provider: n.provider, region: n.region ?? null, size: n.size ?? null, monthly_cost: n.monthly_cost ?? null })) };
  }
  if (st.manifest?.state === "asleep") return { sleeping: true, nodes: [] };
  return { sleeping: false, nodes: (st.manifest?.topology ?? []).filter((t) => t.provider !== "manual").map((t) => ({ provider: t.provider, region: t.region, size: t.size, monthly_cost: null })) };
}

async function storeBytes(c: AdminConfig, fresh: boolean) {
  await Promise.all(c.stores.map(async (s) => {
    const m = measured.get(s.name);
    if (m && !fresh && Date.now() - m.at < MEASURE_MS) return;
    const bytes = await makeStore(s).list("").then((l) => l.reduce((a, o) => a + o.size, 0), () => null);
    measured.set(s.name, { at: Date.now(), bytes });
  }));
}

/**
 * De kosten voor de console uit de configuratie, de clusterstatus en de gemeten bytes per opslag (naam → bytes of
 * null). Puur; Costs.compute in de Android-app geeft precies hetzelfde (golden test).
 */
export function compute(c: AdminConfig, st: { manifest: Manifest | null; live: any }, bytes: Record<string, number | null>, offers: { stores: StoreOffer[]; nameOf: (id: string) => string }) {
  const { sleeping, nodes } = runningServers(st);
  const prices = serverPrices(c.console.catalog);
  const ids = offers.stores.map((o) => o.id);
  const e = estimate(
    nodes.map((n) => ({ provider: n.provider, monthly: serverPrice(prices, n) })),
    c.stores.map((s) => {
      const provider = storeOfferId(s.name, ids);
      return { name: s.name, provider, bytes: bytes[s.name] ?? null, pricePerGbMonth: offers.stores.find((o) => o.id === provider)?.pricePerGbMonth ?? null };
    }),
    offers.nameOf,
  );
  const budget = parseBudget(c.console.budget ?? null);
  return { providers: e.providers, total: e.total, complete: e.complete, sleeping, budget, overBudget: budget !== null && e.total > budget };
}

export async function view(c: AdminConfig, st: { manifest: Manifest | null; live: any }, offers: { stores: StoreOffer[]; nameOf: (id: string) => string }, fresh = false) {
  await storeBytes(c, fresh);
  const bytes = Object.fromEntries(c.stores.map((s) => [s.name, measured.get(s.name)?.bytes ?? null]));
  const times = c.stores.map((s) => measured.get(s.name)?.at ?? Date.now());
  return { ...compute(c, st, bytes, offers), updatedAt: times.length ? Math.min(...times) : Date.now() };
}

/** Budget zetten (euro per maand); leeg, 0 of null haalt het weg. */
export function setBudget(c: AdminConfig, v: unknown) {
  if (v === null || v === undefined || v === "" || v === 0 || v === "0") { delete c.console.budget; return { ok: true, budget: null }; }
  const b = parseBudget(v);
  if (b === null || b > 100000) throw new Error("Vul een bedrag in euro per maand in, bijvoorbeeld 25");
  c.console.budget = b;
  return { ok: true, budget: b };
}
