/** Kleine HTTP-hulpjes voor adapters (alles via globalThis.fetch, zodat tests een nep-API kunnen inprikken). */

export async function api(url: string, init: RequestInit & { okStatus?: number[] } = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok && !(init.okStatus ?? []).includes(r.status)) throw new Error(`${init.method ?? "GET"} ${url} → ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, json: text ? JSON.parse(text) : {} };
}

/** GET voor prijzen en formaten (korter wachten; fout als "<status> <tekst>"). */
export async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Zonebestand-notatie → ruwe waarde: `"a" "b"` → `ab`. */
export const unquoteTxt = (v: string) => v.replace(/"\s*"/g, "").replace(/^"|"$/g, "");

/** "10 mail.voorbeeld.nl." → { priority: 10, host: "mail.voorbeeld.nl" } */
export function parseMx(v: string) {
  const m = /^(\d+)\s+(\S+?)\.?$/.exec(v.trim());
  return m ? { priority: Number(m[1]), host: m[2] } : { priority: 10, host: v.trim().replace(/\.$/, "") };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
