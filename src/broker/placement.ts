/**
 * Waar de servers en opslag van een bundel komen ("Aanbod en prijzen" in het beheer). De Dienst zet clouds van klanten
 * op bij Scaleway (src/broker/provision.ts), dus de keuzes komen uit de Scaleway-adapter in de registry: regio's
 * (src/cluster/adapters/scaleway.ts) met de formaten en live prijzen (`fetchSizes`, met SCW_SECRET_KEY van de Dienst).
 * Controle bij het bewaren: bekende regio's en formaten, minstens twee servers met gegevens (≥ 2 GB geheugen) en een
 * witness, en de werkkopie en back-up op verschillende plekken.
 */
import { getAdapter } from "../cluster/adapters.js";
import type { SizeOption } from "../cluster/adapters/types.js";
import type { Ctx } from "./context.js";
import type { BundlePlacement } from "./config.js";
import { setSetting } from "./db.js";

/** Te vervangen in tests: formaten en prijzen in een regio. */
export const placementNet = {
  sizes: (secretKey: string, region: string, api: string): Promise<SizeOption[]> => getAdapter("scaleway")!.servers!.fetchSizes({ secretKey, api }, region),
};

const MAX_SERVERS = 9;
const CACHE_MS = 10 * 60_000;
let cache: { at: number; key: string; sizes: Record<string, SizeOption[]> } | null = null;

const scw = () => getAdapter("scaleway")!;
export const serverRegions = () => scw().servers!.regions;
export const storageRegions = () => scw().storage!.regions;

/** Formaten per regio (10 minuten bewaard). Gooit een fout als de Dienst geen Scaleway-sleutel heeft of niets krijgt. */
export async function placementSizes(ctx: Ctx): Promise<Record<string, SizeOption[]>> {
  const key = ctx.cfg.scaleway.secretKey;
  if (!key) throw new Error("De Dienst heeft geen Scaleway-sleutel");
  if (cache && cache.key === `${ctx.cfg.scaleway.url} ${key}` && Date.now() - cache.at < CACHE_MS) return cache.sizes;
  const out: Record<string, SizeOption[]> = {};
  let any = false;
  await Promise.all(serverRegions().map(async (r) => {
    try { out[r.id] = await placementNet.sizes(key, r.id, ctx.cfg.scaleway.url); any = true; } catch { /* deze regio niet */ }
  }));
  if (!any) throw new Error("Prijzen ophalen bij Scaleway lukt niet");
  cache = { at: Date.now(), key: `${ctx.cfg.scaleway.url} ${key}`, sizes: out };
  return out;
}

/** Voor de editor: regio's met formaten en prijzen (of een foutmelding), en de plekken voor opslag. */
export async function placementOptions(ctx: Ctx) {
  let sizes: Record<string, SizeOption[]> | null = null, error: string | null = null;
  try { sizes = await placementSizes(ctx); } catch (e) { error = (e as Error).message; }
  return {
    provider: "scaleway", name: scw().name, error,
    regions: serverRegions().map((r) => ({ id: r.id, label: r.label, city: r.city, country: r.country, sizes: sizes?.[r.id] ?? null })),
    storage: storageRegions().map((r) => ({ id: r.id, label: r.label, country: r.country })),
    rules: { minData: 2, minWitness: 1, max: MAX_SERVERS, dataRamGb: 2 },
  };
}

/**
 * Een lijst servers controleren en netjes maken: [{region, size, kind}] → BundlePlacement (land uit de regio). Met
 * `sizes` (live formaten) ook of het formaat in die regio bestaat en of een server met gegevens genoeg geheugen heeft.
 */
export function checkPlacement(raw: unknown, sizes: Record<string, SizeOption[]> | null): BundlePlacement[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Kies minstens drie servers: twee met gegevens en een witness");
  if (raw.length > MAX_SERVERS) throw new Error(`Hooguit ${MAX_SERVERS} servers per bundel`);
  const out = raw.map((p: any, i: number) => {
    const n = `Server ${i + 1}`;
    const kind = p?.kind === "witness" ? "witness" : p?.kind === "data" ? "data" : null;
    if (!kind) throw new Error(`${n}: kies "gegevens" of "witness"`);
    const r = serverRegions().find((x) => x.id === String(p?.region ?? ""));
    if (!r) throw new Error(`${n}: kies een regio van Scaleway`);
    const size = String(p?.size ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,30}$/.test(size)) throw new Error(`${n}: kies een formaat`);
    const known = sizes?.[r.id];
    if (known) {
      const s = known.find((x) => x.size.toUpperCase() === size);
      if (!s) throw new Error(`${n}: formaat ${size} bestaat niet in ${r.label}`);
      if (kind === "data" && s.ramGb < 2) throw new Error(`${n}: een server met gegevens heeft minstens 2 GB geheugen nodig (${size} heeft ${s.ramGb} GB)`);
    }
    return { provider: "scaleway" as const, region: r.id, size, country: r.country, kind } satisfies BundlePlacement;
  });
  if (out.filter((p) => p.kind === "data").length < 2) throw new Error("Een bundel heeft minstens twee servers met gegevens nodig");
  if (!out.some((p) => p.kind === "witness")) throw new Error("Een bundel heeft een witness nodig: die beslist mee bij een storing");
  return out;
}

/** Werkkopie (replica) en back-up: elk één keer, op een plek van Scaleway Object Storage, niet op dezelfde plek. */
export function checkStorage(raw: unknown): { region: string; purpose: "replica" | "backup" }[] {
  if (!Array.isArray(raw)) throw new Error("Kies waar de opslag komt");
  const out = raw.map((x: any) => {
    const r = storageRegions().find((y) => y.id === String(x?.region ?? ""));
    if (!r) throw new Error("Kies een plek voor de opslag");
    if (x?.purpose !== "replica" && x?.purpose !== "backup") throw new Error("Opslag is een werkkopie of een back-up");
    return { region: r.id, purpose: x.purpose as "replica" | "backup" };
  });
  const rep = out.filter((x) => x.purpose === "replica"), bk = out.filter((x) => x.purpose === "backup");
  if (rep.length !== 1 || bk.length !== 1) throw new Error("Kies één plek voor de werkkopie en één voor de back-up");
  if (rep[0].region === bk[0].region) throw new Error("Zet de back-up op een andere plek dan de werkkopie");
  return [rep[0], bk[0]];
}

/** Ontbrekende formaten in de kostentabel aanvullen met de live prijs (voor de marge in het beheer). */
export function fillCosts(ctx: Ctx, placement: BundlePlacement[], sizes: Record<string, SizeOption[]>) {
  let changed = false;
  const servers = { ...ctx.cfg.costs.servers };
  for (const p of placement) {
    if (servers[p.size]) continue;
    const s = sizes[p.region]?.find((x) => x.size.toUpperCase() === p.size);
    if (s?.monthly != null) { servers[p.size] = s.monthly.toFixed(2); changed = true; }
  }
  if (!changed) return;
  ctx.cfg.costs = { ...ctx.cfg.costs, servers };
  setSetting(ctx.db, "costs", ctx.cfg.costs);
}
