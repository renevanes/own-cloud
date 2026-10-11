/**
 * Instellingen van de Eigen Cloud Dienst (de "broker"): alles komt uit omgevingsvariabelen, zodat
 * tests elke aanbieder naar een nep-server kunnen laten wijzen. Zie BROKER.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backupTarget, type BackupTarget } from "./backup.js";

export interface Money { currency: "EUR"; value: string }

export interface BundlePlacement { provider: "scaleway"; region: string; size: string; country: string; kind: "data" | "witness" }

export interface Bundle {
  id: string;
  title: string;
  description: string;
  monthly: Money;
  /** users: aantal gebruikers (gezinsleden) in de cloud dat bij de bundel hoort. */
  includes: { dataServers: number; witnesses: number; storageGb: number; mail: boolean; domain: boolean; users: number };
  /** Prijs per extra gebruiker per maand (incl. btw); null = geen extra gebruikers te koop. */
  extraUserMonthly: Money | null;
  placement: BundlePlacement[];
  storage: { region: "nl-ams" | "fr-par"; purpose: "replica" | "backup" }[];
}

/** Geschatte kosten bij Scaleway per maand (excl. btw), om naast de prijs van de klant te zetten. */
export interface CostTable { servers: Record<string, string>; storageGbMonthly: string }

export interface BrokerConfig {
  dataDir: string;
  port: number;
  host: string;
  /** Welke proxy's het echte IP-adres mogen doorgeven (X-Forwarded-For). */
  trustProxy: string;
  publicUrl: string;
  /** Zone van de dienst voor gratis adressen (BROKER_FREE_ZONE, bijv. "eigencloud.nl" → naam.eigencloud.nl); null = uit. */
  freeZone: string | null;
  /**
   * Centrale adressendienst (BROKER_ADRES_URL): gratis adressen komen dan uit de gedeelde zone van die dienst
   * in plaats van uit BROKER_FREE_ZONE, zodat de klant zijn adres houdt als hij overstapt. Zie ADRESSEN.md.
   */
  adresUrl: string | null;
  /** Ed25519-sleutel van deze aanbieder (aanbieder.key in de datamap); ondertekent verzoeken aan de adressendienst. */
  providerKey: crypto.KeyObject;
  /** De publieke sleutel daarvan (base64 SPKI) voor "sleutel" in aanbieders.json. */
  providerPublicKey: string;
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
  /** Eerste eigenaar (BROKER_OWNER_EMAIL): wordt bij het starten als medewerker met rol eigenaar aangemaakt. */
  ownerEmail: string | null;
  /** Standaardnaam van de aanbieder (BROKER_BRAND_NAME); in het beheer aan te passen. */
  brandName: string;
  costs: CostTable;
  /** Gezondheid van clouds: na hoeveel ms ongezond / zonder melding komt er automatisch een bericht. */
  health: { unhealthyMs: number; silentMs: number };
  /** Eigen back-up van de Dienst (BROKER_BACKUP_*), alleen samen met BROKER_SECRET; null = uit. */
  backup: BackupTarget | null;
  backupEveryMs: number;
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
    includes: { dataServers: 2, witnesses: 1, storageGb: 100, mail: true, domain: true, users: 2 },
    extraUserMonthly: { currency: "EUR", value: "2.50" },
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
    includes: { dataServers: 3, witnesses: 1, storageGb: 500, mail: true, domain: true, users: 5 },
    extraUserMonthly: { currency: "EUR", value: "2.00" },
    placement: [
      { provider: "scaleway", region: "nl-ams-1", size: "DEV1-M", country: "NL", kind: "data" },
      { provider: "scaleway", region: "nl-ams-2", size: "PLAY2-MICRO", country: "NL", kind: "data" },
      { provider: "scaleway", region: "fr-par-1", size: "DEV1-M", country: "FR", kind: "data" },
      { provider: "scaleway", region: "pl-waw-1", size: "DEV1-S", country: "PL", kind: "witness" },
    ],
    storage: [{ region: "nl-ams", purpose: "replica" }, { region: "fr-par", purpose: "backup" }],
  },
];

const MONEY = /^\d+\.\d{2}$/;

/** Controleert en vult een bundel aan (ook voor bundels uit het beheer). Gooit een Error met een leesbare melding. */
export function normalizeBundle(b: any, where = "bundel"): Bundle {
  if (!b || typeof b !== "object") throw new Error(`${where}: verwacht een bundel`);
  if (!b.id || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(b.id)) || !b.title || !b.monthly?.value || !MONEY.test(String(b.monthly.value)))
    throw new Error(`${where}: bundel ${b.id ?? "?"} mist id (kleine letters, cijfers, streepjes), titel of prijs (bijv. "24.95")`);
  if (!Array.isArray(b.placement) || !b.placement.length || !Array.isArray(b.storage) || !b.storage.length) throw new Error(`${where}: bundel ${b.id} mist placement of storage`);
  const inc = b.includes ?? {};
  const int = (v: unknown, d: number) => (v === undefined || v === null ? d : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
  const includes = {
    dataServers: int(inc.dataServers, b.placement.filter((p: any) => p.kind === "data").length),
    witnesses: int(inc.witnesses, b.placement.filter((p: any) => p.kind === "witness").length),
    storageGb: int(inc.storageGb, 0), mail: inc.mail !== false, domain: inc.domain !== false,
    users: int(inc.users, 1),
  };
  if (Object.values(includes).some((v) => typeof v === "number" && Number.isNaN(v))) throw new Error(`${where}: bundel ${b.id}: aantallen moeten hele getallen zijn`);
  if (includes.users < 1) throw new Error(`${where}: bundel ${b.id}: minstens 1 gebruiker`);
  const extra = b.extraUserMonthly?.value ?? (typeof b.extraUserMonthly === "string" ? b.extraUserMonthly : null);
  if (extra !== null && extra !== undefined && !MONEY.test(String(extra))) throw new Error(`${where}: bundel ${b.id}: prijs per extra gebruiker als "2.50"`);
  for (const p of b.placement) {
    if (!p?.region || !p?.size || !["data", "witness"].includes(p.kind)) throw new Error(`${where}: bundel ${b.id}: elke server heeft region, size en kind (data of witness)`);
  }
  return {
    id: String(b.id), title: String(b.title), description: String(b.description ?? ""),
    monthly: { currency: "EUR", value: String(b.monthly.value) },
    includes,
    extraUserMonthly: extra ? { currency: "EUR", value: String(extra) } : null,
    placement: b.placement.map((p: any) => ({ provider: "scaleway", region: String(p.region), size: String(p.size), country: String(p.country ?? ""), kind: p.kind })),
    storage: b.storage.map((x: any) => ({ region: x.region, purpose: x.purpose })),
  };
}

/** Voorbeeldprijzen bij Scaleway (excl. btw, per maand). Plaatshouders: stel ze zelf in via bundles.json ("costs"). */
export const DEFAULT_COSTS: CostTable = {
  servers: { "DEV1-S": "4.50", "DEV1-M": "8.50", "DEV1-L": "17.00", "PLAY2-PICO": "4.00", "PLAY2-NANO": "6.00", "PLAY2-MICRO": "5.50", "GP1-XS": "55.00" },
  storageGbMonthly: "0.015",
};

function readBundlesFile(dataDir: string): any {
  const f = path.join(dataDir, "bundles.json");
  return fs.existsSync(f) ? { f, raw: JSON.parse(fs.readFileSync(f, "utf8")) } : null;
}

function loadBundles(dataDir: string): Bundle[] {
  const file = readBundlesFile(dataDir);
  if (!file) return DEFAULT_BUNDLES.map((b) => structuredClone(b));
  const { f, raw } = file;
  const list: any[] = Array.isArray(raw) ? raw : raw.bundles;
  if (!Array.isArray(list) || !list.length) throw new Error(`${f}: verwacht een lijst met bundels`);
  return list.map((b) => normalizeBundle(b, f));
}

function loadCosts(dataDir: string): CostTable {
  const file = readBundlesFile(dataDir);
  const c = file && !Array.isArray(file.raw) ? file.raw.costs : null;
  if (!c) return structuredClone(DEFAULT_COSTS);
  const servers = { ...DEFAULT_COSTS.servers };
  for (const [k, v] of Object.entries(c.servers ?? {})) {
    if (!MONEY.test(String(v))) throw new Error(`${file.f}: costs.servers.${k} als "4.50"`);
    servers[k] = String(v);
  }
  const gb = c.storageGbMonthly === undefined ? DEFAULT_COSTS.storageGbMonthly : String(c.storageGbMonthly);
  if (!/^\d+(\.\d+)?$/.test(gb)) throw new Error(`${file.f}: costs.storageGbMonthly als "0.015"`);
  return { servers, storageGbMonthly: gb };
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

/** Leest de Ed25519-sleutel van de aanbieder, of maakt hem eenmalig in de datamap (alleen leesbaar voor de eigenaar). */
export function loadProviderKey(dataDir: string): crypto.KeyObject {
  const f = path.join(dataDir, "aanbieder.key");
  if (!fs.existsSync(f)) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    try { fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const key = crypto.createPrivateKey(fs.readFileSync(f, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${f}: geen Ed25519-sleutel`);
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const dataDir = path.resolve(env.BROKER_DATA_DIR || "./data-dienst");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = Number(env.BROKER_PORT || 4100);
  const trim = (u: string) => u.replace(/\/+$/, "");
  const providerKey = loadProviderKey(dataDir);
  return {
    dataDir,
    port,
    host: env.BROKER_HOST || "0.0.0.0",
    trustProxy: env.BROKER_TRUST_PROXY || "loopback,uniquelocal",
    publicUrl: trim(env.BROKER_PUBLIC_URL || `http://localhost:${port}`),
    freeZone: env.BROKER_FREE_ZONE ? env.BROKER_FREE_ZONE.trim().toLowerCase().replace(/^\.|\.$/g, "") : null,
    adresUrl: env.BROKER_ADRES_URL ? trim(env.BROKER_ADRES_URL.trim()) : null,
    providerKey,
    providerPublicKey: crypto.createPublicKey(providerKey).export({ type: "spki", format: "der" }).toString("base64"),
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
    ownerEmail: env.BROKER_OWNER_EMAIL?.trim().toLowerCase() || null,
    brandName: env.BROKER_BRAND_NAME?.trim() || "Eigen Cloud Dienst",
    costs: loadCosts(dataDir),
    health: {
      unhealthyMs: Number(env.BROKER_HEALTH_UNHEALTHY_MS || 15 * 60_000),
      silentMs: Number(env.BROKER_HEALTH_SILENT_MS || 6 * 3600_000),
    },
    backup: backupTarget(env),
    backupEveryMs: Number(env.BROKER_BACKUP_EVERY_MS || 3_600_000),
  };
}

/**
 * BROKER_ENV_FILE: instellingen uit een bestand met regels `NAAM=waarde` (letterlijk, zonder aanhalingstekens; lege
 * regels en # worden overgeslagen). Wat al in de omgeving staat, gaat voor. Zo hoeft er niets te worden ge-escaped.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env) {
  const f = env.BROKER_ENV_FILE;
  if (!f) return 0;
  let n = 0;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || line.startsWith("#")) continue;
    if (env[m[1]] === undefined) { env[m[1]] = m[2]; n++; }
  }
  return n;
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
  if (c.backup && !env.BROKER_SECRET) out.push("BROKER_SECRET (zonder deze sleutel maakt de Dienst geen back-ups)");
  return out;
}
