/**
 * Ondertekening tussen een Eigen Cloud Dienst (aanbieder) en de centrale adressendienst. Zie ADRESSEN.md.
 *
 *   x-dienst:       adres van de Dienst, precies zoals in aanbieders.json ("url")
 *   x-tijd:         Unix-tijd in milliseconden
 *   x-handtekening: base64(Ed25519-handtekening over "<METHOD>\n<pad met query>\n<x-tijd>\n<sha256-hex van de body>")
 *
 * De publieke sleutel staat als "sleutel" (base64 van de SPKI-DER) bij de aanbieder in aanbieders.json.
 */
import crypto from "node:crypto";

/** Hoe ver de klok van een Dienst mag afwijken. */
export const MAX_SKEW_MS = 5 * 60_000;
/** Zo lang onthoudt de adressendienst handtekeningen (tegen opnieuw afspelen); ruim boven 2× de afwijking. */
export const REPLAY_MS = 10 * 60_000;

export const sha256hex = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex");

export function signingString(method: string, pathAndQuery: string, tijd: string, body: string | Buffer) {
  return `${method.toUpperCase()}\n${pathAndQuery}\n${tijd}\n${sha256hex(body)}`;
}

/** Adres van een Dienst zonder slash aan het eind en met kleine letters in schema en host. */
export function normDienstUrl(raw: string): string {
  const v = String(raw ?? "").trim();
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return v.replace(/\/+$/, "").toLowerCase(); }
}

export function signHeaders(key: crypto.KeyObject, dienst: string, method: string, pathAndQuery: string, body: string = "", now = Date.now()): Record<string, string> {
  const tijd = String(now);
  const sig = crypto.sign(null, Buffer.from(signingString(method, pathAndQuery, tijd, body)), key).toString("base64");
  return { "x-dienst": dienst, "x-tijd": tijd, "x-handtekening": sig };
}

export function verifySignature(pub: crypto.KeyObject, method: string, pathAndQuery: string, tijd: string, body: string | Buffer, sigB64: string): boolean {
  try {
    const sig = Buffer.from(sigB64, "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(signingString(method, pathAndQuery, tijd, body)), pub, sig);
  } catch { return false; }
}

/** "MCowBQYDK2VwAyEA…" (base64 SPKI-DER) → publieke Ed25519-sleutel, of null als het geen Ed25519-sleutel is. */
export function parsePublicKey(b64: unknown): crypto.KeyObject | null {
  if (typeof b64 !== "string" || !b64.trim()) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(b64.trim(), "base64"), format: "der", type: "spki" });
    return k.asymmetricKeyType === "ed25519" ? k : null;
  } catch { return null; }
}

/** Publieke sleutel als base64 SPKI-DER (voor "sleutel" in aanbieders.json). */
export function publicKeyB64(key: crypto.KeyObject): string {
  return crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}
