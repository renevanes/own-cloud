import type { DnsProvider, ProviderAdapter } from "./types.js";

/** Basisadres van deSEC (in tests een nepserver via EIGEN_DESEC_URL). */
export const desecApi = () => (process.env.EIGEN_DESEC_URL ?? "https://desec.io/api/v1").replace(/\/$/, "");

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

/** Alleen DNS: gratis, open source, non-profit (Berlijn). De console kan ook zelf een account aanmaken. */
export const desec: ProviderAdapter = {
  id: "desec",
  name: "deSEC",
  owner: "deSEC e.V. (Duitsland, non-profit)",
  home: "DE",
  signupUrl: "https://desec.io",
  keyHelp: 'Al een account op desec.io? Maak een token onder "Token Management" en plak het hier.',
  fields: [{ key: "token", label: "API-token", secret: true }],
  dns: {
    name: "deSEC (gratis, open source, Berlijn)",
    async connect(fields, zone) {
      const base = (fields.api || desecApi()).replace(/\/+$/, "");
      const h = { authorization: `Token ${fields.token}`, "content-type": "application/json" };
      const r = await fetch(`${base}/domains/${zone}/`, { headers: h });
      if (r.status === 401 || r.status === 403) throw new Error("deSEC accepteert dit token niet");
      if (r.status === 404) {
        if (zone.endsWith(".dedyn.io")) throw new Error(`${zone} bestaat (nog) niet bij deSEC. Maak het account opnieuw aan met een andere naam.`);
        const cr = await fetch(`${base}/domains/`, { method: "POST", headers: h, body: JSON.stringify({ name: zone }) });
        if (!cr.ok) throw new Error(`Domein toevoegen bij deSEC mislukt: ${(await cr.text()).slice(0, 200)}`);
      }
      return { nameservers: ["ns1.desec.io", "ns2.desec.org"] };
    },
    create: (name, f, zone) => new DesecDns(name, { token: f.token, zone, api: f.api }),
    caddy: (f) => `dns desec {\n\t\t\ttoken ${f.token}\n\t\t}`,
  },
};
