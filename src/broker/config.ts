/**
 * Instellingen van de Eigen Cloud Dienst (de "broker"): alles komt uit omgevingsvariabelen, zodat
 * tests elke aanbieder naar een nep-server kunnen laten wijzen. Zie BROKER.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Money { currency: "EUR"; value: string }

export interface BundlePlacement { provider: "scaleway"; region: string; size: string; country: string; kind: "data" | "witness" }

export interface Bundle {
  id: string;
  title: string;
  description: string;
  monthly: Money;
  includes: { dataServers: number; witnesses: number; storageGb: number; mail: boolean; domain: boolean };
  placement: BundlePlacement[];
  storage: { region: "nl-ams" | "fr-par"; purpose: "replica" | "backup" }[];
}

export interface BrokerConfig {
  dataDir: string;
  port: number;
  host: string;
  /** Welke proxy's het echte IP-adres mogen doorgeven (X-Forwarded-For). */
  trustProxy: string;
  publicUrl: string;
  /** Zone van de dienst voor gratis adressen (BROKER_FREE_ZONE, bijv. "eigencloud.nl" → naam.eigencloud.nl); null = uit. */
  freeZone: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  mollie: { apiKey: string; url: string };
  openprovider: { username: string; password: string; url: string };
  desec: { token: string; url: string };
  scaleway: { secretKey: string; organizationId: string; url: string; permissionSets: string[] };
  smtpUrl: string | null;
  mailFrom: string;
  adminEmail: string | null;
  /** Sleutel (32 bytes) waarmee geheimen in de database versleuteld worden. */
  secret: Buffer;
  loopMs: number;
  guardMs: number;
  enforce: boolean;
  bundles: Bundle[];
  /** Btw-percentage op de facturen (BROKER_VAT_PERCENT, standaard 21). */
  vatPercent: number;
  /** Jouw bedrijfsgegevens op de facturen. Zonder naam: facturen tonen een duidelijke waarschuwing. */
  company: { name: string | null; address: string[]; kvk: string | null; vat: string | null };
}

export const NAMESERVERS = ["ns1.desec.io", "ns2.desec.org"];

/** Namen die niet als gratis adres uitgedeeld worden (van de dienst zelf, of verwarrend). */
export const RESERVED_LABELS = new Set(["www", "mail", "cloud", "api", "dienst", "admin", "beheer", "app", "ns1", "ns2", "smtp", "imap", "_acme", "status", "help", "support", "info", "test"]);

/** Voorbeeldbundels. De prijzen zijn plaatshouders: stel ze zelf in via bundles.json. */
export const DEFAULT_BUNDLES: Bundle[] = [
  {
    id: "compleet",
    title: "Compleet",
    description: "Twee servers met al je gegevens en een kleine witness, 100 GB opslag, je eigen domein, DNS en verzending van mail.",
    monthly: { currency: "EUR", value: "24.95" },
    includes: { dataServers: 2, witnesses: 1, storageGb: 100, mail: true, domain: true },
    placement: [
      { provider: "scaleway", region: "nl-ams-1", size: "DEV1-M", country: "NL", kind: "data" },
      { provider: "scaleway", region: "nl-ams-2", size: "PLAY2-MICRO", country: "NL", kind: "data" },
      { provider: "scaleway", region: "fr-par-1", size: "DEV1-S", country: "FR", kind: "witness" },
    ],
    storage: [{ region: "nl-ams", purpose: "replica" }, { region: "fr-par", purpose: "backup" }],
  },
  {
    id: "ruim",
    title: "Ruim",
    description: "Drie servers met al je gegevens verspreid over twee landen, een witness in een derde land en 500 GB opslag. Plus domein, DNS en mail.",
    monthly: { currency: "EUR", value: "39.95" },
    includes: { dataServers: 3, witnesses: 1, storageGb: 500, mail: true, domain: true },
    placement: [
      { provider: "scaleway", region: "nl-ams-1", size: "DEV1-M", country: "NL", kind: "data" },
      { provider: "scaleway", region: "nl-ams-2", size: "PLAY2-MICRO", country: "NL", kind: "data" },
      { provider: "scaleway", region: "fr-par-1", size: "DEV1-M", country: "FR", kind: "data" },
      { provider: "scaleway", region: "pl-waw-1", size: "DEV1-S", country: "PL", kind: "witness" },
    ],
    storage: [{ region: "nl-ams", purpose: "replica" }, { region: "fr-par", purpose: "backup" }],
  },
];

function loadBundles(dataDir: string): Bundle[] {
  const f = path.join(dataDir, "bundles.json");
  if (!fs.existsSync(f)) return DEFAULT_BUNDLES;
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const list: Bundle[] = Array.isArray(raw) ? raw : raw.bundles;
  if (!Array.isArray(list) || !list.length) throw new Error(`${f}: verwacht een lijst met bundels`);
  for (const b of list) {
    if (!b.id || !b.title || !b.monthly?.value || !/^\d+\.\d{2}$/.test(b.monthly.value)) throw new Error(`${f}: bundel ${b.id ?? "?"} mist id, titel of prijs (bijv. "24.95")`);
    if (!b.placement?.length || !b.storage?.length) throw new Error(`${f}: bundel ${b.id} mist placement of storage`);
    b.monthly.currency = "EUR";
  }
  return list;
}

/** Leest BROKER_SECRET, of maakt eenmalig een sleutel in de datamap (alleen leesbaar voor de eigenaar). */
function loadSecret(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  if (env.BROKER_SECRET) {
    const k = Buffer.from(env.BROKER_SECRET.trim(), "hex");
    if (k.length !== 32) throw new Error("BROKER_SECRET moet 32 bytes zijn (64 hex-tekens)");
    return k;
  }
  const f = path.join(dataDir, "geheim.key");
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const dataDir = path.resolve(env.BROKER_DATA_DIR || "./data-dienst");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = Number(env.BROKER_PORT || 4100);
  const trim = (u: string) => u.replace(/\/+$/, "");
  return {
    dataDir,
    port,
    host: env.BROKER_HOST || "0.0.0.0",
    trustProxy: env.BROKER_TRUST_PROXY || "loopback,uniquelocal",
    publicUrl: trim(env.BROKER_PUBLIC_URL || `http://localhost:${port}`),
    freeZone: env.BROKER_FREE_ZONE ? env.BROKER_FREE_ZONE.trim().toLowerCase().replace(/^\.|\.$/g, "") : null,
    termsUrl: env.BROKER_TERMS_URL || null,
    privacyUrl: env.BROKER_PRIVACY_URL || null,
    mollie: { apiKey: env.MOLLIE_API_KEY || "", url: trim(env.MOLLIE_API_URL || "https://api.mollie.com/v2") },
    openprovider: { username: env.OPENPROVIDER_USERNAME || "", password: env.OPENPROVIDER_PASSWORD || "", url: trim(env.OPENPROVIDER_URL || "https://api.openprovider.eu/v1beta") },
    desec: { token: env.DESEC_TOKEN || "", url: trim(env.DESEC_URL || "https://desec.io/api/v1") },
    scaleway: {
      secretKey: env.SCW_SECRET_KEY || "",
      organizationId: env.SCW_ORGANIZATION_ID || "",
      url: trim(env.SCW_API_URL || "https://api.scaleway.com"),
      permissionSets: (env.SCW_PERMISSION_SETS || "InstancesFullAccess,BlockStorageFullAccess,ObjectStorageFullAccess,TransactionalEmailFullAccess").split(",").map((s) => s.trim()).filter(Boolean),
    },
    smtpUrl: env.BROKER_SMTP_URL || null,
    mailFrom: env.BROKER_MAIL_FROM || "Eigen Cloud Dienst <noreply@localhost>",
    adminEmail: env.BROKER_ADMIN_EMAIL || null,
    secret: loadSecret(env, dataDir),
    loopMs: Number(env.BROKER_LOOP_MS || 30_000),
    guardMs: Number(env.BROKER_GUARD_MS || 3_600_000),
    enforce: env.BROKER_ENFORCE === "1",
    bundles: loadBundles(dataDir),
    vatPercent: loadVat(env.BROKER_VAT_PERCENT),
    company: {
      name: env.BROKER_COMPANY_NAME?.trim() || null,
      // Meerdere regels: een echte regelovergang of "\n" in de variabele.
      address: (env.BROKER_COMPANY_ADDRESS ?? "").replace(/\\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean),
      kvk: env.BROKER_COMPANY_KVK?.trim() || null,
      vat: env.BROKER_COMPANY_VAT?.trim() || null,
    },
  };
}

function loadVat(v: string | undefined): number {
  if (v === undefined || v.trim() === "") return 21;
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("BROKER_VAT_PERCENT moet een getal tussen 0 en 100 zijn (bijv. 21)");
  return n;
}

/** Wat ontbreekt er nog voor echt gebruik? (Wordt bij het starten gemeld, niet afgedwongen.) */
export function missingSettings(c: BrokerConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (!c.mollie.apiKey) out.push("MOLLIE_API_KEY");
  if (!c.openprovider.username || !c.openprovider.password) out.push("OPENPROVIDER_USERNAME/OPENPROVIDER_PASSWORD");
  if (!c.desec.token) out.push("DESEC_TOKEN");
  if (!c.scaleway.secretKey || !c.scaleway.organizationId) out.push("SCW_SECRET_KEY/SCW_ORGANIZATION_ID");
  if (!c.smtpUrl) out.push("BROKER_SMTP_URL");
  if (!env.BROKER_PUBLIC_URL) out.push("BROKER_PUBLIC_URL");
  if (!c.company.name) out.push("BROKER_COMPANY_NAME (en BROKER_COMPANY_ADDRESS/_KVK/_VAT) voor de facturen");
  return out;
}
