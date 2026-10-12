/** Instellingen van de centrale adressendienst (gratis adressen naam.<ADRES_ZONE>). Zie ADRESSEN.md. */
import fs from "node:fs";
import path from "node:path";

export interface AdresConfig {
  /** De gedeelde zone, bijv. "eigencloud.nl". */
  zone: string;
  desec: { token: string; url: string };
  port: number;
  host: string;
  dataDir: string;
  /** Lijst van aanbieders: https-adres of een bestand op schijf. */
  listUrl: string;
  /** Hoe lang de lijst van aanbieders bewaard wordt voor hij opnieuw wordt opgehaald. */
  listCacheMs: number;
  publicUrl: string;
  trustProxy: string;
  /** Na vrijgeven is een naam zo lang niet opnieuw uit te geven. */
  quarantineMs: number;
  /**
   * De Dienst op dezelfde server (ADRES_LOKAAL_DIENST + ADRES_LOKAAL_SLEUTEL, gezet door de console): die vertrouwt
   * de adressendienst ook als hij (nog) niet op de lijst staat, en alleen die mag het beheer (/v1/beheer/…) gebruiken.
   */
  lokaal: { dienst: string; keyFile: string } | null;
  /** Wachten tot dit bestand bestaat voor het starten (de Dienst zet eerst de back-up terug, ook die van ons). */
  waitFor: string | null;
}

export const DEFAULT_LIST_URL = "https://raw.githubusercontent.com/renevanes/own-cloud/main/aanbieders.json";

export function loadAdresConfig(env: NodeJS.ProcessEnv = process.env): AdresConfig {
  const dataDir = path.resolve(env.ADRES_DATA_DIR || "./data-adressen");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = Number(env.ADRES_PORT || 4200);
  const trim = (u: string) => u.replace(/\/+$/, "");
  return {
    zone: (env.ADRES_ZONE ?? "").trim().toLowerCase().replace(/^\.|\.$/g, ""),
    desec: { token: env.ADRES_DESEC_TOKEN || "", url: trim(env.ADRES_DESEC_URL || "https://desec.io/api/v1") },
    port,
    host: env.ADRES_HOST || "0.0.0.0",
    dataDir,
    listUrl: env.ADRES_LIST_URL || DEFAULT_LIST_URL,
    listCacheMs: Number(env.ADRES_LIST_CACHE_MS || 5 * 60_000),
    publicUrl: trim(env.ADRES_PUBLIC_URL || `http://localhost:${port}`),
    trustProxy: env.ADRES_TRUST_PROXY || "loopback,uniquelocal",
    quarantineMs: 30 * 86400_000,
    lokaal: env.ADRES_LOKAAL_DIENST && env.ADRES_LOKAAL_SLEUTEL ? { dienst: trim(env.ADRES_LOKAAL_DIENST.trim()), keyFile: env.ADRES_LOKAAL_SLEUTEL } : null,
    waitFor: env.ADRES_WACHT_OP || null,
  };
}

export function missingAdresSettings(c: AdresConfig): string[] {
  const out: string[] = [];
  if (!c.zone) out.push("ADRES_ZONE");
  if (!c.desec.token) out.push("ADRES_DESEC_TOKEN");
  return out;
}
