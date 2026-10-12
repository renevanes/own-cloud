/**
 * Instellingen wijzigen zonder nieuwe server. De console van de aanbieder (die de Dienst opzette) stuurt de nieuwe
 * omgeving naar POST /v1/status/instellingen (met het beheertoken, zoals bij overdragen). De Dienst bewaart die
 * versleuteld in zijn database (en dus in zijn back-up) en start opnieuw; bij het starten gaan ze vóór dienst.env, tenzij
 * dienst.env nieuwer is (BROKER_ENV_AT: wanneer de console het bestand voor deze server schreef). Zie BROKER.md.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { deriveKey, open, seal } from "../cluster/crypto.js";
import { getSetting, setSetting } from "./db.js";

/** Wat de console zo mag wijzigen. Adres, BROKER_SECRET en de back-upplek horen bij de server: die blijven. */
export const INSTELBAAR = [
  "BROKER_OWNER_EMAIL", "BROKER_ADMIN_EMAIL", "BROKER_BRAND_NAME", "BROKER_MAIL_FROM",
  "BROKER_COMPANY_NAME", "BROKER_COMPANY_ADDRESS", "BROKER_COMPANY_KVK", "BROKER_COMPANY_VAT", "BROKER_VAT_PERCENT", "BROKER_ENFORCE",
  "MOLLIE_API_KEY", "DESEC_TOKEN", "SCW_SECRET_KEY", "SCW_ORGANIZATION_ID", "BROKER_SMTP_URL", "OPENPROVIDER_USERNAME", "OPENPROVIDER_PASSWORD",
  "BROKER_ADRES_URL", "BROKER_ADRES_PUBLIEK",
] as const;
const AAD = "dienst-instellingen";
const keyOf = (secret: Buffer) => deriveKey(secret, AAD);

interface Stored { at: number; sealed: string }

/** Controleren en versleuteld bewaren. Alleen bekende namen, waarden op één regel. */
export function saveOverride(db: Database.Database, secret: Buffer, at: number, env: Record<string, unknown>) {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("at ontbreekt");
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!(INSTELBAAR as readonly string[]).includes(k)) throw new Error(`${k} kan zo niet worden gewijzigd`);
    if (typeof v !== "string" || /[\r\n]/.test(v) || v.length > 2000) throw new Error(`${k}: één regel tekst`);
    clean[k] = v;
  }
  const prev = getSetting<Stored>(db, "instellingen");
  if (prev && prev.at >= at) throw new Error("Er zijn al nieuwere instellingen");
  setSetting(db, "instellingen", { at, sealed: seal(keyOf(secret), JSON.stringify(clean), AAD).toString("base64") } satisfies Stored);
  return Object.keys(clean);
}

/**
 * Bij het starten (na het terugzetten van een back-up, vóór loadConfig): bewaarde instellingen toepassen als ze nieuwer
 * zijn dan dienst.env. Alle namen uit INSTELBAAR worden dan vervangen (wat ontbreekt, valt weg). Geeft het tijdstip, of null.
 */
export function applyOverride(env: NodeJS.ProcessEnv = process.env): number | null {
  if (!env.BROKER_SECRET) return null;
  const secret = Buffer.from(env.BROKER_SECRET.trim(), "hex");
  if (secret.length !== 32) return null;
  const f = path.join(path.resolve(env.BROKER_DATA_DIR || "./data-dienst"), "dienst.sqlite");
  if (!fs.existsSync(f)) return null;
  let stored: Stored | null = null;
  // Alleen lezen; de Dienst opent de database daarna zelf.
  const db = new Database(f, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    if (hasTable) stored = getSetting<Stored>(db as never, "instellingen");
  } finally { db.close(); }
  if (!stored || stored.at <= Number(env.BROKER_ENV_AT || 0)) return null;
  const vals = JSON.parse(open(keyOf(secret), Buffer.from(stored.sealed, "base64"), AAD).toString("utf8")) as Record<string, string>;
  for (const k of INSTELBAAR) {
    if (typeof vals[k] === "string") env[k] = vals[k];
    else delete env[k];
  }
  return stored.at;
}
