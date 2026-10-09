import fs from "node:fs";
import { deriveKey, parseKey } from "./crypto.js";
import type { StoreConfig } from "./stores.js";

export interface Member {
  id: string;
  kind: "data" | "witness";
  clusterUrl: string; // http://ip:7946 — versleutelde node-tot-node berichten
  apiUrl?: string; // https://ip — webapp/API (voor doorsturen naar de leider)
  voter: boolean;
}

export interface Placement {
  provider: string;
  region: string;
  size: string;
  country?: string;
  /** alleen voor deze soort node */
  kind?: "data" | "witness";
}

export interface Policy {
  /** Gewenst aantal data-nodes (incl. leider). 2 = leider + warme stand-by. */
  minDataNodes: number;
  /** Aantal witnesses (alleen stemmen, geen data). 1 maakt automatische failover mogelijk met 2 data-nodes. */
  witnesses: number;
  /** Zelf nodes bijmaken/vervangen. */
  autoHeal: boolean;
  /** Na hoeveel minuten onbereikbaar een node vervangen wordt. */
  autoReplaceAfterMin: number;
  /** Waar nieuwe nodes mogen komen, in volgorde van voorkeur. */
  placement: Placement[];
  snapshotEveryHours: number;
  retentionDays: number;
  drillEveryDays: number;
  segmentEverySec: number;
}

export interface DnsConfig {
  type: "desec" | "hetzner" | "file";
  name: string;
  token?: string;
  zone?: string;
  file?: string; // type file: voor tests
  /** deSEC: andere basis-URL (bijv. de DNS-proxy van de Eigen Cloud Dienst); standaard https://desec.io/api/v1 */
  api?: string;
  /** acme-dns-account voor certificaten (bij de Eigen Cloud Dienst; Caddy-module acmedns). */
  acme?: { username: string; password: string; subdomain: string; server_url: string };
}

export interface ClusterConfig {
  cluster: string;
  nodeId: string;
  kind: "data" | "witness";
  /** Hoofdsleutel (hex) — alleen op data-nodes en je eigen beheer-CLI. */
  masterKey?: string;
  /** Clustersleutel (hex) — voor witnesses die de hoofdsleutel niet krijgen. */
  clusterKey?: string;
  clusterPort: number;
  advertise: { clusterUrl: string; apiUrl?: string; ipv4?: string; ipv6?: string };
  seeds: Member[];
  /** Start als enige leider (eerste node, of wakker worden). */
  bootstrapLeader?: boolean;
  /** Term waarmee een wekkende leider moet beginnen (hoger dan alles van vóór het slapen). */
  bootstrapTerm?: number;
  joinToken?: string;
  /** Domein, bijv. jouwdomein.nl; records cloud.<domein> en mail.<domein> worden beheerd. */
  domain?: string;
  /** Servernaam voor TLS bij doorsturen naar de leider (bijv. cloud.jouwdomein.nl). */
  apiServername?: string;
  stores: StoreConfig[];
  providers: Record<string, Record<string, string>>;
  dns: DnsConfig[];
  image: { url?: string; ref?: string };
  /** Over deze server zelf (aanbieder, server-id) — nodig om zichzelf op te heffen bij slapen. */
  selfInfo?: { provider?: string; region?: string | null; size?: string | null; serverId?: string | null; country?: string | null };
  /** Eenmalig over te nemen instellingen bij de allereerste start (wachtwoord-hash, meldadres, relay …). */
  initialSettings?: Record<string, string>;
  /** Extra omgevingsvariabelen voor de app (MAIL_DOMAINS, MAIL_FROM, SMTP_RELAY, …). */
  appEnv: Record<string, string>;
  policy: Policy;
}

export const DEFAULT_POLICY: Policy = {
  minDataNodes: 2,
  witnesses: 1,
  autoHeal: true,
  autoReplaceAfterMin: 15,
  placement: [],
  snapshotEveryHours: 24,
  retentionDays: 30,
  drillEveryDays: 7,
  segmentEverySec: 5,
};

export function loadClusterConfig(file: string): ClusterConfig {
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as ClusterConfig;
  c.policy = { ...DEFAULT_POLICY, ...(c.policy ?? {}) };
  c.seeds ??= [];
  c.stores ??= [];
  c.providers ??= {};
  c.dns ??= [];
  c.image ??= {};
  c.appEnv ??= {};
  return c;
}

export function writeClusterConfig(file: string, c: ClusterConfig) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface Keys {
  master?: Buffer;
  cluster: Buffer;
  db?: Buffer;
  blobs?: Buffer;
  manifest?: Buffer;
}

export function keysFor(c: Pick<ClusterConfig, "masterKey" | "clusterKey">): Keys {
  if (c.masterKey) {
    const m = parseKey(c.masterKey);
    return { master: m, cluster: deriveKey(m, "cluster"), db: deriveKey(m, "db"), blobs: deriveKey(m, "blobs"), manifest: deriveKey(m, "manifest") };
  }
  if (c.clusterKey) return { cluster: parseKey(c.clusterKey) };
  throw new Error("Geen sleutel in clusterconfiguratie");
}

/** Tijden (ms). LEASE < STICKY < ELECTION_MIN is essentieel: een oude leider stopt met schrijven vóórdat er een nieuwe gekozen kan worden. */
export function timings() {
  const fast = process.env.CLUSTER_FAST === "1";
  return fast
    ? { heartbeat: 150, lease: 1500, sticky: 2200, electionMin: 2500, electionMax: 3500, rpcTimeout: 1000 }
    : { heartbeat: 500, lease: 4000, sticky: 6000, electionMin: 7000, electionMax: 10000, rpcTimeout: 2500 };
}
