/**
 * Catalogus van Europese aanbieders voor de installatie-assistent.
 * Formaten en prijzen worden waar mogelijk live bij de aanbieder opgehaald; anders indicatief.
 */
import type { Placement } from "../cluster/config.js";
import { scwApi } from "../cluster/providers.js";

export interface RegionInfo { id: string; label: string; country: string; city: string }

export interface StoreOffer {
  id: string;
  name: string;
  owner: string;
  regions: { id: string; label: string; country: string; endpoint: string }[];
  customEndpoint?: boolean;
  help: string;
  signupUrl: string;
}

export interface ServerOffer {
  id: "hetzner" | "scaleway" | "upcloud" | "local";
  name: string;
  owner: string;
  /** Land van de eigenaar (rechtsgebied). */
  home: string;
  regions: RegionInfo[];
  fields: { key: string; label: string; secret?: boolean; help?: string }[];
  signupUrl: string;
}

export const STORE_OFFERS: StoreOffer[] = [
  {
    id: "hetzner", name: "Hetzner Object Storage", owner: "Hetzner Online GmbH (Duitsland)",
    regions: [
      { id: "fsn1", label: "Falkenstein", country: "DE", endpoint: "https://fsn1.your-objectstorage.com" },
      { id: "nbg1", label: "Neurenberg", country: "DE", endpoint: "https://nbg1.your-objectstorage.com" },
      { id: "hel1", label: "Helsinki", country: "FI", endpoint: "https://hel1.your-objectstorage.com" },
    ],
    help: "Cloud Console → je project → Object Storage → S3-sleutels aanmaken.", signupUrl: "https://console.hetzner.com",
  },
  {
    id: "scaleway", name: "Scaleway Object Storage", owner: "Scaleway SAS (Frankrijk)",
    regions: [
      { id: "nl-ams", label: "Amsterdam", country: "NL", endpoint: "https://s3.nl-ams.scw.cloud" },
      { id: "fr-par", label: "Parijs", country: "FR", endpoint: "https://s3.fr-par.scw.cloud" },
      { id: "pl-waw", label: "Warschau", country: "PL", endpoint: "https://s3.pl-waw.scw.cloud" },
    ],
    help: "Console → IAM → API-sleutels. Toegangssleutel en geheime sleutel.", signupUrl: "https://console.scaleway.com",
  },
  {
    id: "exoscale", name: "Exoscale SOS", owner: "Exoscale (Zwitserland, A1 Telekom Austria)",
    regions: [
      { id: "de-fra-1", label: "Frankfurt", country: "DE", endpoint: "https://sos-de-fra-1.exo.io" },
      { id: "at-vie-1", label: "Wenen", country: "AT", endpoint: "https://sos-at-vie-1.exo.io" },
      { id: "ch-gva-2", label: "Genève", country: "CH", endpoint: "https://sos-ch-gva-2.exo.io" },
    ],
    help: "Portal → IAM → API-sleutel met rechten op Object Storage.", signupUrl: "https://portal.exoscale.com",
  },
  {
    id: "upcloud", name: "UpCloud Object Storage", owner: "UpCloud Ltd (Finland)",
    regions: [{ id: "europe-1", label: "Eigen endpoint (zie UpCloud-console)", country: "FI", endpoint: "" }],
    customEndpoint: true,
    help: "Maak een Object Storage-instantie; kopieer de endpoint-URL en een toegangssleutel.", signupUrl: "https://hub.upcloud.com",
  },
  {
    id: "custom", name: "Eigen opslag (NAS, MinIO, Garage)", owner: "Jijzelf",
    regions: [{ id: "eigen", label: "Eigen endpoint", country: "NL", endpoint: "" }],
    customEndpoint: true,
    help: "Elke S3-compatibele opslag, bijvoorbeeld een NAS thuis. Ideaal als extra back-up op een eigen plek.", signupUrl: "",
  },
];

export const SERVER_OFFERS: ServerOffer[] = [
  {
    id: "scaleway", name: "Scaleway", owner: "Scaleway SAS (Frankrijk)", home: "FR",
    regions: [
      { id: "nl-ams-1", label: "Amsterdam 1", country: "NL", city: "Amsterdam" },
      { id: "nl-ams-2", label: "Amsterdam 2", country: "NL", city: "Amsterdam" },
      { id: "nl-ams-3", label: "Amsterdam 3", country: "NL", city: "Amsterdam" },
      { id: "fr-par-1", label: "Parijs 1", country: "FR", city: "Parijs" },
      { id: "pl-waw-1", label: "Warschau 1", country: "PL", city: "Warschau" },
    ],
    fields: [{ key: "secretKey", label: "Geheime API-sleutel", secret: true }, { key: "projectId", label: "Project-ID" }],
    signupUrl: "https://console.scaleway.com",
  },
  {
    id: "hetzner", name: "Hetzner Cloud", owner: "Hetzner Online GmbH (Duitsland)", home: "DE",
    regions: [
      { id: "fsn1", label: "Falkenstein", country: "DE", city: "Falkenstein" },
      { id: "nbg1", label: "Neurenberg", country: "DE", city: "Neurenberg" },
      { id: "hel1", label: "Helsinki", country: "FI", city: "Helsinki" },
    ],
    fields: [{ key: "token", label: "API-token (lezen en schrijven)", secret: true }],
    signupUrl: "https://console.hetzner.com",
  },
  {
    id: "upcloud", name: "UpCloud", owner: "UpCloud Ltd (Finland)", home: "FI",
    regions: [
      { id: "nl-ams1", label: "Amsterdam", country: "NL", city: "Amsterdam" },
      { id: "de-fra1", label: "Frankfurt", country: "DE", city: "Frankfurt" },
      { id: "fi-hel1", label: "Helsinki", country: "FI", city: "Helsinki" },
      { id: "se-sto1", label: "Stockholm", country: "SE", city: "Stockholm" },
    ],
    fields: [{ key: "token", label: "API-token", secret: true }],
    signupUrl: "https://hub.upcloud.com",
  },
];

export interface SizeOption { size: string; label: string; ramGb: number; cpus: number; monthly: number | null }

/** Live formaten en prijzen. */
export async function fetchSizes(provider: string, cfg: Record<string, string>, region: string): Promise<SizeOption[]> {
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<any>;
  };
  if (provider === "hetzner") {
    const j = await get("https://api.hetzner.cloud/v1/server_types?per_page=50", { authorization: `Bearer ${cfg.token}` });
    return (j.server_types as any[])
      .filter((t) => !t.deprecation && t.architecture === "x86" && t.prices?.some((p: any) => p.location === region))
      .map((t) => ({ size: t.name, label: `${t.cores} vCPU, ${t.memory} GB`, ramGb: t.memory, cpus: t.cores, monthly: Number(t.prices.find((p: any) => p.location === region).price_monthly.gross) }))
      .sort((a, b) => (a.monthly ?? 0) - (b.monthly ?? 0));
  }
  if (provider === "scaleway") {
    const j = await get(`${scwApi()}/instance/v1/zones/${region}/products/servers?per_page=100`, { "x-auth-token": cfg.secretKey });
    return Object.entries(j.servers as Record<string, any>)
      .filter(([name, s]) => /^(DEV1|PLAY2|PRO2|GP1|STARDUST|POP2)/i.test(name) && s.arch === "x86_64")
      .map(([name, s]) => ({ size: name, label: `${s.ncpus} vCPU, ${Math.round(s.ram / 1024 ** 3)} GB`, ramGb: Math.round(s.ram / 1024 ** 3), cpus: s.ncpus, monthly: s.monthly_price ?? (s.hourly_price ? Math.round(s.hourly_price * 730 * 100) / 100 : null) }))
      .sort((a, b) => (a.monthly ?? 999) - (b.monthly ?? 999));
  }
  if (provider === "upcloud") {
    const j = await get("https://api.upcloud.com/1.3/plan", { authorization: `Bearer ${cfg.token}` });
    return (j.plans.plan as any[])
      .filter((p) => /^\d+xCPU-\d+GB$/.test(p.name))
      .map((p) => ({ size: p.name, label: `${p.core_number} vCPU, ${p.memory_amount / 1024} GB`, ramGb: p.memory_amount / 1024, cpus: p.core_number, monthly: null }))
      .sort((a, b) => a.ramGb - b.ramGb || a.cpus - b.cpus);
  }
  if (provider === "local") return [{ size: "s", label: "proces op deze computer", ramGb: 4, cpus: 1, monthly: 0 }];
  return [];
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
