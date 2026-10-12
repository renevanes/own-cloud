/**
 * Het adapter-raamwerk: elke cloudaanbieder is één `ProviderAdapter`-object in src/cluster/adapters/<id>.ts en staat
 * in de registry (src/cluster/adapters.ts). Een adapter beschrijft wat de aanbieder kan — servers, opslag (S3) en/of
 * DNS — met pure gegevens (velden, regio's, uitleg) plus de code om die dingen te doen.
 *
 * De gegevens-delen (alles behalve functies) gaan ongewijzigd naar de console, de Android-app (catalog.json) en de
 * documentatie. Houd ze dus Nederlands, in gewone taal, en zonder geheimen.
 *
 * Zie PROVIDERS.md voor het stappenplan om een aanbieder toe te voegen.
 */
import type { KeyCheck } from "./check.js";
export type { KeyCheck } from "./check.js";

// ───────── Servers ─────────

export interface CreateSpec {
  cluster: string;
  nodeId: string;
  kind: "data" | "witness";
  region: string;
  size: string;
  userData: string;
  /** Alleen local-provider: extra omgeving voor het proces. */
  env?: Record<string, string>;
}

export interface ServerInfo {
  serverId: string;
  ipv4?: string;
  ipv6?: string;
  monthlyCost?: number;
  country?: string;
  /** Overschrijft de standaard http://<ipv4>:7946 (local-provider). */
  clusterUrl?: string;
  apiUrl?: string;
}

/** Wat het cluster met servers bij een aanbieder doet. */
export interface Provider {
  readonly name: string;
  /** Server maken met het cloud-init-script `userData` en labels/namen waarmee `list` hem terugvindt. */
  create(spec: CreateSpec): Promise<ServerInfo>;
  /** Server (en wat erbij hoort, zoals een los IP-adres) verwijderen. Bestaat hij al niet meer: geen fout. */
  destroy(serverId: string): Promise<void>;
  /** Alle servers van dit cluster (om vergeten servers op te ruimen). Een fout bij inloggen moet een fout geven. */
  list(cluster: string): Promise<{ serverId: string; nodeId: string }[]>;
  /** Reverse DNS (PTR) van de IP-adressen zetten, als de aanbieder dat via de API kan. */
  setPtr?(server: ServerInfo, hostname: string): Promise<void>;
  /**
   * Het cloud-init-script (met geheimen) bij de aanbieder weghalen zodra de server draait, als de aanbieder het via
   * de API laat lezen en wissen (Scaleway). Bestaat de server niet meer: geen fout.
   */
  clearUserData?(serverId: string): Promise<void>;
  country(region: string): string;
}

export interface SizeOption { size: string; label: string; ramGb: number; cpus: number; monthly: number | null }

export interface RegionInfo { id: string; label: string; country: string; city: string }

// ───────── Opslag ─────────

export interface StorageRegion { id: string; label: string; country: string; endpoint: string }

// ───────── DNS ─────────

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT";

export interface DnsProvider {
  readonly name: string;
  /**
   * Zet alle records van één naam en type (vervangt wat er stond). `values` in zonebestand-notatie:
   * A/AAAA een adres, MX "10 mail.voorbeeld.nl.", TXT tussen aanhalingstekens (lange waarden als "…" "…").
   * Een lege lijst haalt de records weg.
   */
  setRecords(sub: string, type: DnsRecordType, values: string[], ttl: number): Promise<void>;
}

// ───────── Adapter ─────────

/** Een invoerveld voor inloggegevens (de console toont het, de kluis bewaart het). */
export interface Field {
  key: string;
  label: string;
  /** Geheim: gemaskeerd tonen, nooit in logboeken. */
  secret?: boolean;
  help?: string;
  /** Mag leeg blijven. */
  optional?: boolean;
  placeholder?: string;
}

export interface ServersCapability {
  regions: RegionInfo[];
  /** Een Provider met de ingevulde velden (config.providers[id]). */
  create(fields: Record<string, string>): Provider;
  /** Live formaten en prijzen in een regio (prijs per maand in euro, of null als onbekend). */
  fetchSizes(fields: Record<string, string>, region: string): Promise<SizeOption[]>;
  /**
   * "Sleutels controleren": ALLEEN lezende verzoeken (nooit iets maken of wijzigen). Geeft een lijstje controles
   * (inloggen, servers bekijken, prijzen, rechten …; zie check.ts). Zonder check gebruikt de console een algemene
   * controle (servers opsommen en formaten ophalen).
   */
  check?(fields: Record<string, string>): Promise<KeyCheck[]>;
}

export interface StorageCapability {
  /** Naam in de keuzelijst, bijv. "Hetzner Object Storage". */
  name: string;
  /** S3-endpoints per regio (https). Bij `customEndpoint` vult de gebruiker het endpoint zelf in. */
  regions: StorageRegion[];
  customEndpoint?: boolean;
  /** Waar maak je de S3-sleutels aan (Nederlands). */
  keyHelp: string;
  /** Anders dan de signupUrl van de adapter (leeg = geen). */
  signupUrl?: string;
  /**
   * Lijstprijs in euro per GB (10^9 bytes) per maand voor wat er in de bucket staat, of null (of weggelaten) als we
   * hem niet betrouwbaar weten; de console toont dan "onbekend". Zie `priceInfo` voor btw, bron en datum.
   * Gebruikt voor de kostenschatting (src/cluster/costs.ts); uitgaand verkeer telt daarin niet mee.
   */
  pricePerGbMonth?: number | null;
  priceInfo?: StoragePriceInfo;
}

export interface StoragePriceInfo {
  /** Afgerekend in stappen van zoveel GB, met minstens één stap (UpCloud: per 250 GB). */
  stepGb?: number;
  /** "excl" = exclusief btw; "onbekend" = de prijslijst zegt het niet. */
  vat: "excl" | "onbekend";
  /** Datum waarop de prijs op de prijslijst is nagekeken (JJJJ-MM-DD). */
  checked: string;
  /** Waar de prijs staat. */
  source: string;
  /** Toelichting (Nederlands). */
  note?: string;
}

export interface DnsCapability {
  /** Anders dan de naam van de adapter, bijv. "Hetzner DNS". */
  name?: string;
  /** Velden voor DNS; standaard dezelfde als voor servers (`fields` van de adapter). */
  fields?: Field[];
  /** Waar maak je het token aan en wat moet er al klaarstaan (Nederlands). Standaard de keyHelp van de adapter. */
  keyHelp?: string;
  /**
   * Controleren dat de sleutel werkt en de zone bestaat (of aanmaken als de aanbieder dat kan).
   * Geeft de nameservers die de gebruiker bij zijn registrar moet invullen. Fouten in gewone taal.
   */
  connect(fields: Record<string, string>, zone: string): Promise<{ nameservers: string[] }>;
  /** De DnsProvider waarmee het cluster records bijwerkt. */
  create(name: string, fields: Record<string, string>, zone: string): DnsProvider;
  /**
   * "Sleutels controleren" voor DNS: ALLEEN lezen (anders dan connect maakt dit nooit een zone aan). `zone` kan
   * leeg zijn; controleer dan alleen het inloggen en het bekijken van zones.
   */
  check?(fields: Record<string, string>, zone: string): Promise<KeyCheck[]>;
  /**
   * Regel voor Caddy (DNS-01-certificaten), bijv. `dns hetzner <token>`. Alleen als de module in
   * Dockerfile.caddy zit; anders weglaten (Caddy gebruikt dan HTTP-01, zie PROVIDERS.md).
   * Geeft "" als er een veld ontbreekt; dan probeert caddyfile() de volgende DNS-koppeling.
   */
  caddy?(fields: Record<string, string>): string;
}

/** Optioneel: een "snelle route" waarbij de console met één sleutel alles regelt (nu alleen Scaleway). */
export interface QuickCapability {
  title: string;
  signupUrl: string;
  keysUrl: string;
}

export interface ProviderAdapter {
  /** Korte, unieke id (kleine letters): sleutel in config.providers, dns[].type, placement.provider. */
  id: string;
  /** Merknaam, bijv. "Hetzner Cloud". */
  name: string;
  /** Bedrijf en land, bijv. "Hetzner Online GmbH (Duitsland)". */
  owner: string;
  /** Land van het bedrijf (rechtsgebied), ISO-code. */
  home: string;
  /** Waar je een account maakt (leeg = niet van toepassing). */
  signupUrl: string;
  /** Waar maak je de API-sleutel en welke rechten zijn nodig (Nederlands, gewone taal). */
  keyHelp: string;
  /** Inloggegevens voor servers (en standaard ook voor DNS). */
  fields: Field[];
  servers?: ServersCapability;
  storage?: StorageCapability;
  dns?: DnsCapability;
  quick?: QuickCapability;
  /** Alleen in tests (EIGEN_CONSOLE_LOCAL=1) zichtbaar in de console. */
  testOnly?: boolean;
}
