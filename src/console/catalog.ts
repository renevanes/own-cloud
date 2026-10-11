/**
 * Catalogus van Europese aanbieders voor de installatie-assistent — afgeleid uit de registry
 * (src/cluster/adapters.ts). Formaten en prijzen worden waar mogelijk live bij de aanbieder opgehaald.
 * Alles hier is pure data en gaat ook als catalog.json naar de Android-app (scripts/export-catalog.ts).
 */
import type { Placement } from "../cluster/config.js";
import { adapters, getAdapter } from "../cluster/adapters.js";
import type { Field, ProviderAdapter, RegionInfo, SizeOption, StorageRegion } from "../cluster/adapters/types.js";

export type { RegionInfo, SizeOption } from "../cluster/adapters/types.js";

export interface StoreOffer {
  id: string;
  name: string;
  owner: string;
  home?: string;
  regions: StorageRegion[];
  customEndpoint?: boolean;
  help: string;
  signupUrl: string;
}

export interface ServerOffer {
  id: string;
  name: string;
  owner: string;
  /** Land van de eigenaar (rechtsgebied). */
  home: string;
  regions: RegionInfo[];
  fields: Field[];
  signupUrl: string;
  /** Waar maak je de sleutel en welke rechten zijn nodig. */
  keyHelp?: string;
}

export interface DnsOffer {
  id: string;
  name: string;
  owner: string;
  home: string;
  fields: Field[];
  keyHelp: string;
  signupUrl: string;
  /** Dezelfde sleutel als bij Servers van deze aanbieder: is die al gekoppeld, dan hoeft er niets ingevuld. */
  sharesKeyWith?: string;
}

const visible = (a: ProviderAdapter, withTest: boolean) => withTest || !a.testOnly;

export function storeOfferOf(a: ProviderAdapter): StoreOffer {
  const s = a.storage!;
  return {
    id: a.id, name: s.name, owner: a.owner, home: a.home, regions: s.regions.map((r) => ({ ...r })),
    ...(s.customEndpoint ? { customEndpoint: true } : {}), help: s.keyHelp, signupUrl: s.signupUrl ?? a.signupUrl,
  };
}

export function serverOfferOf(a: ProviderAdapter): ServerOffer {
  return { id: a.id, name: a.name, owner: a.owner, home: a.home, regions: a.servers!.regions.map((r) => ({ ...r })), fields: a.fields.map((f) => ({ ...f })), signupUrl: a.signupUrl, keyHelp: a.keyHelp };
}

export function dnsOfferOf(a: ProviderAdapter): DnsOffer {
  const d = a.dns!;
  const fields = d.fields ?? a.fields;
  const shares = !!a.servers && fields.every((f) => a.fields.some((x) => x.key === f.key));
  return {
    id: a.id, name: d.name ?? a.name, owner: a.owner, home: a.home, fields: fields.map((f) => ({ ...f })), keyHelp: d.keyHelp ?? a.keyHelp, signupUrl: a.signupUrl,
    ...(shares ? { sharesKeyWith: a.id } : {}),
  };
}

/** Opslag-aanbiedingen uit de registry (met `withTest` ook testaanbieders). */
export const storeOffers = (withTest = false): StoreOffer[] => adapters().filter((a) => a.storage && visible(a, withTest)).map(storeOfferOf);
/** Server-aanbiedingen uit de registry. */
export const serverOffers = (withTest = false): ServerOffer[] => adapters().filter((a) => a.servers && visible(a, withTest)).map(serverOfferOf);
/** DNS-aanbiedingen uit de registry (handmatig beheer is geen aanbieder; de console voegt dat zelf toe). */
export const dnsOffers = (withTest = false): DnsOffer[] => adapters().filter((a) => a.dns && visible(a, withTest)).map(dnsOfferOf);

/** Momentopname van de ingebouwde aanbieders (bestaande namen; gebruik bij voorkeur de functies hierboven). */
export const STORE_OFFERS: StoreOffer[] = storeOffers();
export const SERVER_OFFERS: ServerOffer[] = serverOffers();

/** Live formaten en prijzen bij een aanbieder in een regio ([] als de aanbieder geen servers heeft). */
export async function fetchSizes(provider: string, cfg: Record<string, string>, region: string): Promise<SizeOption[]> {
  const a = getAdapter(provider);
  if (!a?.servers) return [];
  return a.servers.fetchSizes(cfg, region);
}

/** Kleinste geschikte formaat: data ≥ 2 GB geheugen, witness zo klein mogelijk. */
export function pickSize(sizes: SizeOption[], kind: "data" | "witness") {
  const ok = sizes.filter((s) => (kind === "data" ? s.ramGb >= 2 : s.ramGb >= 0.5));
  return [...ok].sort((a, b) => (a.monthly ?? a.ramGb * 3) - (b.monthly ?? b.ramGb * 3))[0];
}

export interface Preset { id: string; title: string; description: string; placement: Placement[]; monthly: number | null; countries: string[]; missing?: string }

/** Drie keuzes op basis van de aanbieders die de gebruiker heeft gekoppeld. */
export function buildPresets(available: { provider: string; region: RegionInfo; data?: SizeOption; witness?: SizeOption }[]): Preset[] {
  const byCountry = (c: string) => available.filter((a) => a.region.country === c);
  const mk = (id: string, title: string, description: string, picks: ({ provider: string; region: RegionInfo; data?: SizeOption; witness?: SizeOption } | undefined)[], need: string) => {
    const [d1, d2, w] = picks;
    if (!d1 || !d2 || !w || !d1.data || !d2.data || !w.witness) return { id, title, description, placement: [], monthly: null, countries: [], missing: need };
    const placement: Placement[] = [
      { provider: d1.provider, region: d1.region.id, size: d1.data.size, country: d1.region.country, kind: "data" },
      { provider: d2.provider, region: d2.region.id, size: d2.data.size, country: d2.region.country, kind: "data" },
      { provider: w.provider, region: w.region.id, size: w.witness.size, country: w.region.country, kind: "witness" },
    ];
    const prices = [d1.data.monthly, d2.data.monthly, w.witness.monthly];
    return { id, title, description, placement, monthly: prices.every((p) => p !== null) ? Math.round(prices.reduce((a, b) => a! + b!, 0)! * 100) / 100 : null, countries: [...new Set(placement.map((p) => p.country!))] };
  };
  const distinct = (list: typeof available, avoid: (typeof available)[number][]) =>
    list.find((a) => !avoid.some((x) => x.provider === a.provider)) ?? list.find((a) => !avoid.some((x) => x.provider === a.provider && x.region.id === a.region.id));

  const nl = byCountry("NL");
  const nl1 = nl[0];
  const nl2 = distinct(nl, nl1 ? [nl1] : []);
  const nlw = distinct(nl, [nl1, nl2].filter(Boolean) as typeof available) ?? nl.find((a) => a !== nl1 && a !== nl2);

  const neighbours = available.filter((a) => ["DE", "BE"].includes(a.region.country));
  const nb = distinct(neighbours, nl1 ? [nl1] : []) ?? neighbours[0];
  const far = available.filter((a) => !["NL", "DE", "BE"].includes(a.region.country));
  const w2 = distinct(far, [nl1, nb].filter(Boolean) as typeof available) ?? distinct(neighbours, [nl1, nb].filter(Boolean) as typeof available) ?? nlw;
  const w3 = distinct(far, [nl1, nb].filter(Boolean) as typeof available) ?? far[0];

  return [
    mk("nl", "Alles in Nederland", "Beide data-servers en de witness in Amsterdam, verdeeld over aparte datacenters. Kortste afstand, geen data over de grens.", [nl1, nl2, nlw], "Koppel een aanbieder met Amsterdam (Scaleway of UpCloud)"),
    mk("buren", "Nederland en Duitsland", "Data in Amsterdam en Duitsland, de witness ergens anders. Valt een land of aanbieder weg, dan draait de rest door.", [nl1, nb, w2], "Koppel een aanbieder in Nederland én een in Duitsland"),
    mk("europa", "Spreid over Europa", "Drie landen en zo veel mogelijk verschillende aanbieders. Het meest bestand tegen grote storingen.", [nl1 ?? neighbours[0], nb, w3], "Koppel aanbieders in minstens drie landen (bijv. Scaleway + Hetzner)"),
  ];
}
