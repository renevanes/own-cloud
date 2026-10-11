import fs from "node:fs";
import type { DnsConfig } from "./config.js";
import { getAdapter } from "./adapters.js";
import type { DnsProvider } from "./adapters/types.js";

/**
 * DNS bij meerdere aanbieders tegelijk. Zet bij je registrar de NS-records van beide aanbieders;
 * de app houdt de zones gelijk. Beheerde records: cloud.<domein> en mail.<domein> → alle gezonde data-nodes.
 * De DNS-adapters staan in src/cluster/adapters/ (alles met een `dns`-onderdeel in de registry).
 */
export type { DnsProvider } from "./adapters/types.js";
export { DesecDns } from "./adapters/desec.js";
export { HetznerDns } from "./adapters/hetzner.js";
export { ScalewayDns } from "./adapters/scaleway.js";
export { ExoscaleDns } from "./adapters/exoscale.js";
export { OvhDns } from "./adapters/ovh.js";

/** Schrijft records naar een JSON-bestand (tests / handmatig beheer). */
export class FileDns implements DnsProvider {
  constructor(readonly name: string, private file: string) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
    data[`${sub}/${type}`] = { values: [...values].sort(), ttl };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }
}

/** Alle inloggegevens van een DNS-koppeling als één veldenlijst (token/api staan om historische redenen los). */
export function dnsFields(c: DnsConfig): Record<string, string> {
  return { ...(c.fields ?? {}), ...(c.token ? { token: c.token } : {}), ...(c.api ? { api: c.api } : {}) };
}

export function makeDns(c: DnsConfig): DnsProvider {
  if (c.type === "file") return new FileDns(c.name, c.file!);
  const a = getAdapter(c.type);
  // Onbekend (bijv. een adapter die deze versie nog niet kent): pas bij gebruik een fout, zodat de rest doorloopt.
  if (!a?.dns) return { name: c.name, setRecords: async () => { throw new Error(`Onbekende DNS-aanbieder ${c.type}`); } };
  return a.dns.create(c.name, dnsFields(c), c.zone!);
}
