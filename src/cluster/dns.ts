import fs from "node:fs";
import type { DnsConfig } from "./config.js";

/**
 * DNS bij meerdere aanbieders tegelijk. Zet bij je registrar de NS-records van beide aanbieders;
 * de app houdt de zones gelijk. Beheerde records: cloud.<domein> en mail.<domein> → alle gezonde data-nodes.
 */
export interface DnsProvider {
  readonly name: string;
  setRecords(sub: string, type: "A" | "AAAA" | "MX" | "TXT", values: string[], ttl: number): Promise<void>;
}

export class DesecDns implements DnsProvider {
  /** `api`: andere basis-URL, bijv. de DNS-proxy van de Eigen Cloud Dienst. */
  constructor(readonly name: string, private cfg: { token: string; zone: string; api?: string }) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    // deSEC hanteert standaard een minimale TTL van 3600 s; dat is prima omdat failover niet van DNS afhangt.
    const api = (this.cfg.api || "https://desec.io/api/v1").replace(/\/+$/, "");
    const r = await fetch(`${api}/domains/${this.cfg.zone}/rrsets/`, {
      method: "PUT",
      headers: { authorization: `Token ${this.cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify([{ subname: sub, type, ttl: Math.max(ttl, 3600), records: values }]),
    });
    if (!r.ok) throw new Error(`deSEC ${sub}/${type}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

/** Hetzner DNS via de Cloud API (zones/rrsets). Controleer of je zone al naar de Cloud Console is gemigreerd. */
export class HetznerDns implements DnsProvider {
  constructor(readonly name: string, private cfg: { token: string; zone: string }) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const base = `https://api.hetzner.cloud/v1/zones/${this.cfg.zone}/rrsets`;
    const h = { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
    const name = sub || "@";
    if (!values.length) {
      const r = await fetch(`${base}/${name}/${type}`, { method: "DELETE", headers: h });
      if (!r.ok && r.status !== 404) throw new Error(`Hetzner DNS delete ${name}/${type}: ${r.status}`);
      return;
    }
    const records = values.map((value) => ({ value }));
    let r = await fetch(`${base}/${name}/${type}/actions/set_records`, { method: "POST", headers: h, body: JSON.stringify({ records }) });
    if (r.status === 404) r = await fetch(base, { method: "POST", headers: h, body: JSON.stringify({ name, type, ttl, records }) });
    if (!r.ok) throw new Error(`Hetzner DNS ${name}/${type}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

/** Schrijft records naar een JSON-bestand (tests / handmatig beheer). */
export class FileDns implements DnsProvider {
  constructor(readonly name: string, private file: string) {}
  async setRecords(sub: string, type: string, values: string[], ttl: number) {
    const data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {};
    data[`${sub}/${type}`] = { values: [...values].sort(), ttl };
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
  }
}

export function makeDns(c: DnsConfig): DnsProvider {
  if (c.type === "desec") return new DesecDns(c.name, { token: c.token!, zone: c.zone!, api: c.api });
  if (c.type === "hetzner") return new HetznerDns(c.name, { token: c.token!, zone: c.zone! });
  return new FileDns(c.name, c.file!);
}
