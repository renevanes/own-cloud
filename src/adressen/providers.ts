/** De lijst van aanbieders (aanbieders.json): wie mag namen aanvragen, met welke publieke sleutel. */
import type crypto from "node:crypto";
import fs from "node:fs";
import { normDienstUrl, parsePublicKey } from "./sign.js";

export interface Aanbieder { naam: string; url: string; land?: string; contact?: string; omschrijving?: string; sleutel?: string }
export interface KnownProvider { naam: string; url: string; key: crypto.KeyObject | null }

export class ProviderList {
  private cache: { at: number; map: Map<string, KnownProvider> } | null = null;
  private loading: Promise<Map<string, KnownProvider>> | null = null;
  constructor(private source: string, private cacheMs: number) {}

  private async fetchRaw(): Promise<Aanbieder[]> {
    let raw: unknown;
    if (/^https?:\/\//i.test(this.source)) {
      const r = await fetch(this.source, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`lijst van aanbieders: HTTP ${r.status}`);
      raw = await r.json();
    } else raw = JSON.parse(fs.readFileSync(this.source, "utf8"));
    if (!Array.isArray(raw)) throw new Error("lijst van aanbieders: verwacht een JSON-lijst");
    return raw as Aanbieder[];
  }

  /** Haalt de lijst (opnieuw) op. Mislukt dat, dan blijft de vorige lijst gelden. */
  async refresh(): Promise<Map<string, KnownProvider>> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const map = new Map<string, KnownProvider>();
        for (const a of await this.fetchRaw()) {
          if (!a || typeof a.url !== "string" || !a.url) continue;
          map.set(normDienstUrl(a.url), { naam: String(a.naam ?? a.url), url: a.url, key: parsePublicKey(a.sleutel) });
        }
        this.cache = { at: Date.now(), map };
        return map;
      } catch (e) {
        console.error(`[adressen] ${(e as Error).message}`);
        if (this.cache) { this.cache.at = Date.now() - this.cacheMs + 60_000; return this.cache.map; }
        throw e;
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  async all(): Promise<Map<string, KnownProvider>> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.map;
    return this.refresh();
  }

  /** Aanbieder met dit adres; staat hij er niet in, dan wordt de lijst (hooguit eens per minuut) opnieuw opgehaald. */
  async lookup(url: string): Promise<KnownProvider | null> {
    const k = normDienstUrl(url);
    const hit = (await this.all()).get(k);
    if (hit) return hit;
    if (this.cache && Date.now() - this.cache.at > 60_000) return (await this.refresh()).get(k) ?? null;
    return null;
  }
}
