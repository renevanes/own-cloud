import crypto from "node:crypto";
import { request } from "undici";
import { open, seal } from "./crypto.js";

/**
 * Node-tot-node berichten: JSON, versleuteld én geauthenticeerd met de clustersleutel (AES-GCM).
 * Bevat tijdstempel + nonce; berichten ouder dan 60 s of eerder gezien worden geweigerd.
 */

const seen = new Map<string, number>();
function remember(nonce: string) {
  const now = Date.now();
  if (seen.size > 20000) for (const [k, t] of seen) if (now - t > 120_000) seen.delete(k);
  if (seen.has(nonce)) return false;
  seen.set(nonce, now);
  return true;
}

export function sealMsg(key: Buffer, msg: unknown): Buffer {
  return seal(key, JSON.stringify({ ts: Date.now(), n: crypto.randomBytes(12).toString("base64"), m: msg }), "rpc");
}

export function openMsg<T>(key: Buffer, buf: Buffer): T {
  const { ts, n, m } = JSON.parse(open(key, buf, "rpc").toString("utf8")) as { ts: number; n: string; m: T };
  if (Math.abs(Date.now() - ts) > 60_000) throw new Error("Bericht verlopen (klok gelijkzetten?)");
  if (!remember(n)) throw new Error("Bericht al eerder ontvangen");
  return m;
}

export async function rpc<T>(key: Buffer, url: string, msg: unknown, timeoutMs: number): Promise<T> {
  const r = await request(url.replace(/\/$/, "") + "/cluster/rpc", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: sealMsg(key, msg),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await r.body.arrayBuffer());
  if (r.statusCode !== 200) throw new Error(`RPC ${url}: ${r.statusCode} ${buf.toString("utf8").slice(0, 200)}`);
  return openMsg<T>(key, buf);
}

/** Korte, ondertekende token voor GET-verzoeken (bestanden ophalen bij de leider). */
export function signGet(key: Buffer, p: string) {
  const ts = Date.now();
  const mac = crypto.createHmac("sha256", key).update(`${ts}:${p}`).digest("base64url");
  return `${ts}.${mac}`;
}
export function verifyGet(key: Buffer, p: string, token: string | undefined) {
  if (!token) return false;
  const [ts, mac] = token.split(".");
  if (!ts || !mac || Math.abs(Date.now() - Number(ts)) > 60_000) return false;
  const good = crypto.createHmac("sha256", key).update(`${ts}:${p}`).digest("base64url");
  return mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good));
}
