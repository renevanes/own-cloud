/**
 * Inlogcodes per mail (klanten én medewerkers) en eenvoudige snelheidslimieten.
 * Een code is 6 cijfers, 15 minuten geldig, hooguit 5 pogingen; alleen een HMAC ervan staat in de database.
 */
import crypto from "node:crypto";
import type { Db, Secrets } from "./db.js";

export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  ok(key: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.clear();
    return true;
  }
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Maakt een nieuwe code voor `key` (bijv. het e-mailadres, of "staff:<e-mailadres>") en geeft hem terug. */
export function issueCode(db: Db, secrets: Secrets, key: string): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare("INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0")
    .run(key, secrets.hmac(`${key}:${code}`), Date.now() + 15 * 60_000);
  return code;
}

export type CodeResult = { ok: true } | { ok: false; status: number; error: string };

/** Controleert een code (eenmalig). Na 5 foute pogingen vervalt hij. */
export function checkCode(db: Db, secrets: Secrets, key: string, rawCode: unknown): CodeResult {
  const code = String(rawCode ?? "").replace(/\s/g, "");
  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(key) as { code_hash: string; expires_at: number; attempts: number } | undefined;
  if (!row || row.expires_at < Date.now()) return { ok: false, status: 400, error: "Deze code is verlopen. Vraag een nieuwe aan." };
  if (row.attempts >= 5) { db.prepare("DELETE FROM login_codes WHERE email = ?").run(key); return { ok: false, status: 429, error: "Te vaak een verkeerde code. Vraag een nieuwe aan." }; }
  const want = Buffer.from(row.code_hash, "hex");
  const got = Buffer.from(secrets.hmac(`${key}:${code}`), "hex");
  if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(want, got)) {
    const attempts = row.attempts + 1;
    if (attempts >= 5) db.prepare("DELETE FROM login_codes WHERE email = ?").run(key);
    else db.prepare("UPDATE login_codes SET attempts = ? WHERE email = ?").run(attempts, key);
    return attempts >= 5
      ? { ok: false, status: 429, error: "Te vaak een verkeerde code. Vraag een nieuwe aan." }
      : { ok: false, status: 400, error: "Die code klopt niet. Kijk nog eens goed in je mail." };
  }
  db.prepare("DELETE FROM login_codes WHERE email = ?").run(key);
  return { ok: true };
}
