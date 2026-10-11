/**
 * deSEC met het token van het centrale account (ADRES_DESEC_TOKEN). Dat token moet zones mogen maken en
 * verwijderen én tokens mogen beheren (perm_manage_tokens). Zie ADRESSEN.md voor wat wel en niet getest is.
 */
import { ApiError, call } from "../broker/apis.js";

export type Rrset = { subname: string; type: string; ttl: number; records: string[] };
export type Policy = { domain: string | null; subname: string | null; type: string | null; perm_write: boolean };

export class CentralDesec {
  constructor(private c: { token: string; url: string }) {}
  private h() { return { authorization: `Token ${this.c.token}` }; }
  private req(method: string, p: string, body?: unknown) { return call("deSEC", `${this.c.url}${p}`, { method, headers: this.h(), body }).then((r) => r.json); }

  async getZone(name: string): Promise<any | null> {
    try { return await this.req("GET", `/domains/${name}/`); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  }
  createZone(name: string) { return this.req("POST", "/domains/", { name }); }
  async deleteZone(name: string) {
    try { await this.req("DELETE", `/domains/${name}/`); return true; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e; }
  }
  putRrsets(zone: string, rrsets: Rrset[]) { return this.req("PUT", `/domains/${zone}/rrsets/`, rrsets); }

  /** Nieuw token zonder beheerrechten. Het geheim (`token`) geeft deSEC maar één keer terug. */
  async createToken(name: string): Promise<{ id: string; token: string }> {
    const t = await this.req("POST", "/auth/tokens/", { name, perm_manage_tokens: false, perm_create_domain: false, perm_delete_domain: false });
    if (!t?.id || !t?.token) throw new ApiError("deSEC", 502, "deSEC gaf geen token terug");
    return { id: String(t.id), token: String(t.token) };
  }
  async deleteToken(id: string) {
    try { await this.req("DELETE", `/auth/tokens/${encodeURIComponent(id)}/`); return true; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e; }
  }
  addPolicy(tokenId: string, p: Policy) { return this.req("POST", `/auth/tokens/${encodeURIComponent(tokenId)}/policies/rrsets/`, p); }

  /**
   * Token dat alleen in zone `zone` mag schrijven: eerst de standaardregel (alles alleen lezen), dan
   * schrijven in die ene zone. Lukt een regel niet, dan gaat het token meteen weer weg.
   */
  async scopedToken(zone: string, name: string) {
    const t = await this.createToken(name);
    try {
      await this.addPolicy(t.id, { domain: null, subname: null, type: null, perm_write: false });
      await this.addPolicy(t.id, { domain: zone, subname: null, type: null, perm_write: true });
    } catch (e) {
      await this.deleteToken(t.id).catch(() => {});
      throw e;
    }
    return t;
  }
}
