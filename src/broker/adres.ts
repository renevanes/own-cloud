/**
 * Client voor de centrale adressendienst (BROKER_ADRES_URL). Elk verzoek is ondertekend met de sleutel van
 * deze aanbieder (aanbieder.key); de adressendienst kent ons aan "url" + "sleutel" in aanbieders.json.
 */
import type crypto from "node:crypto";
import { ApiError, call } from "./apis.js";
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
}
