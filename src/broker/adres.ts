/**
 * Client voor de centrale adressendienst (BROKER_ADRES_URL). Elk verzoek is ondertekend met de sleutel van
 * deze aanbieder (aanbieder.key); de adressendienst kent ons aan "url" + "sleutel" in aanbieders.json.
 */
import type crypto from "node:crypto";
import { ApiError, call } from "./apis.js";
import type { Ctx } from "./context.js";
import { signHeaders } from "../adressen/sign.js";

export interface AdresIssued { naam: string; zone: string; token: string; overdrachtscode: string }

export class AdresClient {
  private zone: string | null = null;
  constructor(private c: { url: string; dienst: string; key: crypto.KeyObject }) {}

  private async req(method: string, p: string, body?: unknown): Promise<any> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = signHeaders(this.c.key, this.c.dienst, method, p, raw);
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await call("Adressendienst", `${this.c.url}${p}`, { method, headers, raw: body === undefined ? undefined : raw });
    return r.json;
  }

  /** De gedeelde zone (bijv. "eigencloud.nl"); na de eerste keer onthouden. */
  async zoneName(): Promise<string> {
    if (this.zone) return this.zone;
    const r = await call("Adressendienst", `${this.c.url}/v1/info`, {});
    const z = String(r.json?.zone ?? "").toLowerCase();
    if (!z) throw new ApiError("Adressendienst", 502, "Adressendienst gaf geen zone terug");
    this.zone = z;
    return z;
  }
  async check(label: string): Promise<{ naam: string; vrij: boolean }> { return this.req("GET", `/v1/naam/${encodeURIComponent(label)}`); }
  create(label: string, ref: string): Promise<AdresIssued> { return this.req("POST", "/v1/namen", { label, ref }); }
  transfer(naam: string, overdrachtscode: string, ref: string): Promise<AdresIssued> {
    return this.req("POST", `/v1/namen/${encodeURIComponent(naam)}/overdragen`, { overdrachtscode, ref });
  }
  async verify(naam: string, overdrachtscode: string): Promise<boolean> {
    return !!(await this.req("POST", `/v1/namen/${encodeURIComponent(naam)}/controle`, { overdrachtscode }))?.geldig;
  }
  release(naam: string): Promise<{ naam: string; vrijVanaf: string }> { return this.req("DELETE", `/v1/namen/${encodeURIComponent(naam)}`); }

  // Beheer van de adressendienst op dezelfde server (alleen voor de Dienst die hij als "lokaal" kent).
  beheerStatus(): Promise<any> { return this.req("GET", "/v1/beheer/status"); }
  beheerNamen(): Promise<any> { return this.req("GET", "/v1/beheer/namen"); }
  beheerLogboek(naam?: string): Promise<any> { return this.req("GET", `/v1/beheer/logboek${naam ? `?naam=${encodeURIComponent(naam)}` : ""}`); }
  beheerAanbieders(): Promise<any> { return this.req("GET", "/v1/beheer/aanbieders"); }
  beheerVrijgeven(naam: string): Promise<{ naam: string; vrijVanaf: string }> { return this.req("POST", `/v1/beheer/namen/${encodeURIComponent(naam)}/vrijgeven`, {}); }
}

/** Een regel uit aanbieders.json (zie BROKER.md, "De lijst van aanbieders"). */
export interface LijstRegel { naam?: string; url?: string; sleutel?: string; standaard?: boolean; adressen?: string; [k: string]: unknown }

export async function fetchLijst(url: string): Promise<LijstRegel[]> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`lijst van aanbieders: HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("lijst van aanbieders: verwacht een JSON-lijst");
  return j.filter((x) => x && typeof x === "object") as LijstRegel[];
}

/**
 * Welke adressendienst hoort bij deze Dienst volgens de lijst: alleen als hij er zelf op staat met zijn eigen sleutel
 * (anders weigert de adressendienst hem toch), het adres uit "adressen" van de standaardregel (https). Anders null.
 */
export function adresUitLijst(lijst: LijstRegel[], publicUrl: string, publicKey: string): string | null {
  const norm = (u: unknown) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const self = lijst.find((x) => norm(x.url) === norm(publicUrl));
  if (!self || String(self.sleutel ?? "").trim() !== publicKey) return null;
  const std = lijst.find((x) => x.standaard === true);
  const a = typeof std?.adressen === "string" ? std.adressen.trim().replace(/\/+$/, "") : "";
  try { return a && new URL(a).protocol === "https:" ? a : null; } catch { return null; }
}

/**
 * De adressendienst uit de lijst halen en gebruiken (alleen als BROKER_ADRES_URL niet is gezet). Lukt ophalen niet,
 * dan blijft het zoals het was. Geeft het adres dat nu geldt (of null).
 */
export async function discoverAdres(ctx: Ctx): Promise<string | null> {
  const cfg = ctx.cfg;
  if (cfg.adresFromEnv || !cfg.listUrl) return cfg.adresUrl;
  let url: string | null;
  try { url = adresUitLijst(await fetchLijst(cfg.listUrl), cfg.publicUrl, cfg.providerPublicKey); }
  catch { return cfg.adresUrl; }
  if (url !== cfg.adresUrl) {
    cfg.adresUrl = url;
    ctx.apis.adres = url ? new AdresClient({ url, dienst: cfg.publicUrl, key: cfg.providerKey }) : null;
    console.log(url ? `[dienst] gratis adressen via de adressendienst ${url} (uit de lijst van aanbieders)` : "[dienst] geen adressendienst meer uit de lijst van aanbieders");
  }
  return url;
}
