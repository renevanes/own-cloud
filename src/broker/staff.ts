/**
 * Medewerkers van de aanbieder: rollen, inloggen in twee stappen (code per mail, daarna verplicht een
 * authenticator-app (TOTP) of een toestelsleutel van de telefoon) en het logboek van alle beheerhandelingen.
 *
 * Toestelsleutel: de app maakt een ECDSA P-256-sleutelpaar in de Android Keystore (achter de vingerafdruk) en
 * geeft de publieke sleutel (SPKI, base64). Inloggen = de dienst stuurt een willekeurige uitdaging; de app
 * ondertekent `eigen-dienst-login:<uitdaging>` met SHA256withECDSA en de dienst controleert dat hier.
 */
import crypto from "node:crypto";
import QRCode from "qrcode";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sha256 } from "./db.js";
import type { Ctx } from "./context.js";
import { RateLimit, EMAIL, issueCode, checkCode } from "./codes.js";
import { trySend } from "./mail.js";
import { getBrand } from "./brand.js";

// ───────── Rollen en rechten ─────────

export const ROLES = ["eigenaar", "beheer", "support", "financien"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { eigenaar: "Eigenaar", beheer: "Beheer", support: "Support", financien: "Financiën" };

export type Perm =
  | "customers.read" | "customers.act" | "costs" | "money" | "refund" | "offering" | "invites"
  | "announcements.read" | "announcements" | "tickets" | "health" | "staff" | "brand" | "audit" | "adressen";

const ALL: Perm[] = ["customers.read", "customers.act", "costs", "money", "refund", "offering", "invites", "announcements.read", "announcements", "tickets", "health", "staff", "brand", "audit", "adressen"];

export const PERMISSIONS: Record<Role, Perm[]> = {
  eigenaar: ALL,
  beheer: ["customers.read", "customers.act", "costs", "offering", "invites", "announcements.read", "announcements", "tickets", "health"],
  support: ["customers.read", "announcements.read", "tickets", "health"],
  financien: ["customers.read", "costs", "money", "refund", "announcements.read"],
};

export const can = (role: Role, p: Perm) => PERMISSIONS[role]?.includes(p) ?? false;

export interface StaffRow {
  id: string; email: string; name: string | null; role: Role;
  totp_enc: Buffer | null; totp_pending_enc: Buffer | null; totp_last_step: number;
  invited_by: string | null; created_at: number; last_login_at: number | null;
}

export const getStaff = (ctx: Ctx, id: string) => ctx.db.prepare("SELECT * FROM staff WHERE id = ?").get(id) as StaffRow | undefined;
export const staffByEmail = (ctx: Ctx, email: string) => ctx.db.prepare("SELECT * FROM staff WHERE email = ?").get(email.trim().toLowerCase()) as StaffRow | undefined;
const ownerCount = (ctx: Ctx) => (ctx.db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'eigenaar'").get() as { n: number }).n;
const keysOf = (ctx: Ctx, staffId: string) => ctx.db.prepare("SELECT id, public_key, label, created_at, last_used_at FROM staff_keys WHERE staff_id = ? ORDER BY created_at").all(staffId) as { id: string; public_key: string; label: string | null; created_at: number; last_used_at: number | null }[];

export function staffView(ctx: Ctx, s: StaffRow) {
  return {
    id: s.id, email: s.email, name: s.name, role: s.role, roleLabel: ROLE_LABELS[s.role],
    totp: !!s.totp_enc, devices: keysOf(ctx, s.id).map((k) => ({ id: k.id, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
    createdAt: s.created_at, lastLoginAt: s.last_login_at,
  };
}

// ───────── Logboek ─────────

export function audit(ctx: Ctx, who: StaffRow | null, action: string, target?: string | null, detail?: unknown) {
  ctx.db.prepare("INSERT INTO audit (at, staff_id, staff_email, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(Date.now(), who?.id ?? null, who?.email ?? null, action, target ?? null, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail));
}

// ───────── Medewerkers beheren ─────────

export class StaffError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function addStaff(ctx: Ctx, by: StaffRow | null, emailRaw: string, role: Role, name?: string | null) {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new StaffError(400, "Vul een geldig e-mailadres in");
  if (!ROLES.includes(role)) throw new StaffError(400, "Kies een rol: eigenaar, beheer, support of financien");
  if (staffByEmail(ctx, email)) throw new StaffError(409, "Deze persoon is al medewerker");
  const id = crypto.randomBytes(6).toString("hex");
  ctx.db.prepare("INSERT INTO staff (id, email, name, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, email, name ? String(name).trim().slice(0, 80) || null : null, role, by?.id ?? null, Date.now());
  return getStaff(ctx, id)!;
}

/** Eigenaar maken (opdrachtregel of BROKER_OWNER_EMAIL): nieuw, of een bestaande medewerker de rol eigenaar geven. */
export function ensureOwner(ctx: Ctx, email: string, how: string) {
  const existing = staffByEmail(ctx, email);
  if (existing) {
    if (existing.role === "eigenaar") return { staff: existing, created: false };
    ctx.db.prepare("UPDATE staff SET role = 'eigenaar' WHERE id = ?").run(existing.id);
    audit(ctx, null, "staff-role", existing.email, { from: existing.role, to: "eigenaar", how });
    return { staff: getStaff(ctx, existing.id)!, created: false };
  }
  const s = addStaff(ctx, null, email, "eigenaar");
  audit(ctx, null, "staff-add", s.email, { role: "eigenaar", how });
  return { staff: s, created: true };
}

export function setRole(ctx: Ctx, id: string, role: Role) {
  const s = getStaff(ctx, id);
  if (!s) throw new StaffError(404, "Deze medewerker bestaat niet");
  if (!ROLES.includes(role)) throw new StaffError(400, "Kies een rol: eigenaar, beheer, support of financien");
  if (s.role === "eigenaar" && role !== "eigenaar" && ownerCount(ctx) <= 1) throw new StaffError(409, "Er moet altijd minstens één eigenaar zijn");
  ctx.db.prepare("UPDATE staff SET role = ? WHERE id = ?").run(role, id);
  return { before: s, after: getStaff(ctx, id)! };
}

export function removeStaff(ctx: Ctx, id: string) {
  const s = getStaff(ctx, id);
  if (!s) throw new StaffError(404, "Deze medewerker bestaat niet");
  if (s.role === "eigenaar" && ownerCount(ctx) <= 1) throw new StaffError(409, "De laatste eigenaar kan niet weg");
  ctx.db.prepare("DELETE FROM staff WHERE id = ?").run(id); // sleutels, sessies en lopende aanmeldingen gaan mee (cascade)
  return s;
}

/** Tweede stap wissen (telefoon kwijt): bij de volgende keer inloggen moet de medewerker opnieuw instellen. */
export function resetSecondFactor(ctx: Ctx, id: string) {
  ctx.db.prepare("UPDATE staff SET totp_enc = NULL, totp_pending_enc = NULL, totp_last_step = 0 WHERE id = ?").run(id);
  ctx.db.prepare("DELETE FROM staff_keys WHERE staff_id = ?").run(id);
  ctx.db.prepare("DELETE FROM staff_sessions WHERE staff_id = ?").run(id);
}

// ───────── TOTP (RFC 6238, HMAC-SHA1, 6 cijfers, 30 seconden) ─────────

import { base32Encode, base32Decode, hotp, totpStep, totpCode, verifyTotp, otpauthUri } from "../security/totp.js";
export { base32Encode, base32Decode, hotp, totpStep, totpCode, verifyTotp, otpauthUri } from "../security/totp.js";

// ───────── Toestelsleutel (ECDSA P-256) ─────────

export const signedMessage = (challenge: string) => `eigen-dienst-login:${challenge}`;

/** SPKI (base64) → publieke sleutel; alleen EC P-256. */
export function parseDeviceKey(spkiB64: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: Buffer.from(String(spkiB64 ?? ""), "base64"), format: "der", type: "spki" }); }
  catch { throw new StaffError(400, "De toestelsleutel is niet leesbaar"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new StaffError(400, "De toestelsleutel moet een P-256-sleutel zijn");
  return key;
}

/** Handtekening (DER of 64 bytes r‖s, base64) over `eigen-dienst-login:<challenge>` controleren. */
export function verifyDeviceSignature(key: crypto.KeyObject, challenge: string, sigB64: string): boolean {
  const sig = Buffer.from(String(sigB64 ?? ""), "base64");
  if (sig.length < 8 || sig.length > 80) return false;
  try { return crypto.verify("sha256", Buffer.from(signedMessage(challenge)), { key, dsaEncoding: sig.length === 64 ? "ieee-p1363" : "der" }, sig); }
  catch { return false; }
}

// ───────── Sessies ─────────

export const STAFF_IDLE_MS = 12 * 3600_000;
const PENDING_MS = 10 * 60_000;

/** De ingelogde medewerker bij `Authorization: Staff <token>` (en de sessie verlengen), of null. */
export function staffFromRequest(ctx: Ctx, req: FastifyRequest): StaffRow | null {
  const m = /^Staff ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "");
  if (!m) return null;
  const h = sha256(m[1].toLowerCase());
  const s = ctx.db.prepare("SELECT staff_id, last_used_at FROM staff_sessions WHERE token_hash = ?").get(h) as { staff_id: string; last_used_at: number } | undefined;
  if (!s) return null;
  if (Date.now() - s.last_used_at > STAFF_IDLE_MS) { ctx.db.prepare("DELETE FROM staff_sessions WHERE token_hash = ?").run(h); return null; }
  ctx.db.prepare("UPDATE staff_sessions SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), h);
  return getStaff(ctx, s.staff_id) ?? null;
}

function newSession(ctx: Ctx, s: StaffRow, how: string, ip: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  ctx.db.prepare("INSERT INTO staff_sessions (token_hash, staff_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(sha256(token), s.id, now, now);
  ctx.db.prepare("DELETE FROM staff_sessions WHERE last_used_at < ?").run(now - STAFF_IDLE_MS);
  ctx.db.prepare("UPDATE staff SET last_login_at = ? WHERE id = ?").run(now, s.id);
  audit(ctx, s, "login", null, { how, ip });
  const fresh = getStaff(ctx, s.id)!;
  return { token, staff: staffView(ctx, fresh), permissions: PERMISSIONS[fresh.role] };
}

// ───────── Routes: inloggen en eigen account ─────────

type HttpError = (reply: FastifyReply, status: number, error: string) => unknown;

export function registerStaffAuth(app: FastifyInstance, ctx: Ctx, httpError: HttpError) {
  const db = ctx.db;
  const limits = {
    startEmail: new RateLimit(5, 60 * 60_000),
    startIp: new RateLimit(20, 60 * 60_000),
    verifyIp: new RateLimit(30, 15 * 60_000),
    secondIp: new RateLimit(30, 15 * 60_000),
  };
  const codeKey = (email: string) => `staff ${email}`; // met spatie: kan nooit een klantadres zijn

  const pendingOf = (raw: unknown) => {
    const t = String(raw ?? "");
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const p = db.prepare("SELECT * FROM staff_pending WHERE token_hash = ?").get(sha256(t)) as { token_hash: string; staff_id: string; challenge: string | null; expires_at: number; attempts: number } | undefined;
    if (!p || p.expires_at < Date.now()) return null;
    const s = getStaff(ctx, p.staff_id);
    return s ? { p, s } : null;
  };
  const failAttempt = (hash: string, attempts: number) => {
    if (attempts + 1 >= 5) db.prepare("DELETE FROM staff_pending WHERE token_hash = ?").run(hash);
    else db.prepare("UPDATE staff_pending SET attempts = attempts + 1 WHERE token_hash = ?").run(hash);
  };
  const expired = (reply: FastifyReply) => httpError(reply, 401, "Je aanmelding is verlopen. Begin opnieuw met je e-mailadres.");
  const brandName = () => getBrand(ctx).name;

  // Stap 1: code per mail. Altijd 202 (ook voor onbekende adressen), zodat niemand kan uitzoeken wie medewerker is.
  app.post<{ Body: { email?: string } }>("/v1/admin/auth/start", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return httpError(reply, 400, "Vul een geldig e-mailadres in");
    if (!limits.startIp.ok(req.ip) || !limits.startEmail.ok(email)) return httpError(reply, 429, "Je hebt al een paar codes aangevraagd. Wacht even en probeer het dan opnieuw.");
    const s = staffByEmail(ctx, email);
    if (s) {
      const code = issueCode(db, ctx.secrets, codeKey(email));
      try {
        await ctx.mail.send(email, `Je inlogcode voor het beheer: ${code}`, `Hallo,\n\nJe inlogcode voor het beheer van ${brandName()} is:\n\n    ${code}\n\nDe code is 15 minuten geldig. Daarna vragen we nog je vingerafdruk of de code uit je authenticator-app.\n\nHeb je niets aangevraagd? Dan kun je deze mail negeren.\n\nGroet,\n${brandName()}`);
      } catch (e) {
        console.error(`[dienst] inlogcode medewerker versturen mislukt: ${(e as Error).message}`);
        return httpError(reply, 502, "We konden je de code nu niet mailen. Probeer het zo opnieuw.");
      }
    }
    return reply.code(202).send({ ok: true });
  });

  // Stap 1b: code controleren → tijdelijke aanmelding; daarna verplicht de tweede stap.
  app.post<{ Body: { email?: string; code?: string } }>("/v1/admin/auth/verify", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!limits.verifyIp.ok(req.ip)) return httpError(reply, 429, "Te veel pogingen. Wacht even en probeer het dan opnieuw.");
    const r = checkCode(db, ctx.secrets, codeKey(email), req.body?.code);
    if (!r.ok) return httpError(reply, r.status, r.error);
    const s = staffByEmail(ctx, email);
    if (!s) return httpError(reply, 400, "Deze code is verlopen. Vraag een nieuwe aan.");
    const pending = crypto.randomBytes(32).toString("hex");
    db.prepare("DELETE FROM staff_pending WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO staff_pending (token_hash, staff_id, expires_at) VALUES (?, ?, ?)").run(sha256(pending), s.id, Date.now() + PENDING_MS);
    const devices = keysOf(ctx, s.id).length;
    const methods = [...(s.totp_enc ? ["totp"] : []), ...(devices ? ["device"] : [])];
    return { pending, next: methods.length ? "second" : "enrol", methods, staff: { email: s.email, name: s.name, role: s.role } };
  });

  // Uitdaging voor de toestelsleutel (inloggen of instellen). Elke uitdaging is eenmalig.
  app.post<{ Body: { pending?: string } }>("/v1/admin/auth/challenge", async (req, reply) => {
    const x = pendingOf(req.body?.pending);
    if (!x) return expired(reply);
    const challenge = crypto.randomBytes(32).toString("base64url");
    db.prepare("UPDATE staff_pending SET challenge = ? WHERE token_hash = ?").run(challenge, x.p.token_hash);
    return { challenge, message: signedMessage(challenge) };
  });

  // Tweede stap: authenticator-code.
  app.post<{ Body: { pending?: string; code?: string } }>("/v1/admin/auth/totp", async (req, reply) => {
    if (!limits.secondIp.ok(req.ip)) return httpError(reply, 429, "Te veel pogingen. Wacht even en probeer het dan opnieuw.");
    const x = pendingOf(req.body?.pending);
    if (!x) return expired(reply);
    const secret = ctx.secrets.open<string>(x.s.totp_enc, `totp:${x.s.id}`);
    if (!secret) return httpError(reply, 409, "Je hebt nog geen authenticator-app ingesteld");
    const step = verifyTotp(base32Decode(secret), String(req.body?.code ?? "").replace(/\s/g, ""), x.s.totp_last_step);
    if (step === null) { failAttempt(x.p.token_hash, x.p.attempts); return httpError(reply, 400, "Die code klopt niet. Kijk in je authenticator-app en probeer het opnieuw."); }
    db.prepare("UPDATE staff SET totp_last_step = ? WHERE id = ?").run(step, x.s.id);
    db.prepare("DELETE FROM staff_pending WHERE token_hash = ?").run(x.p.token_hash);
    return newSession(ctx, x.s, "totp", req.ip);
  });

  // Tweede stap: toestelsleutel (vingerafdruk).
  app.post<{ Body: { pending?: string; signature?: string; publicKey?: string } }>("/v1/admin/auth/device", async (req, reply) => {
    if (!limits.secondIp.ok(req.ip)) return httpError(reply, 429, "Te veel pogingen. Wacht even en probeer het dan opnieuw.");
    const x = pendingOf(req.body?.pending);
    if (!x) return expired(reply);
    const challenge = x.p.challenge;
    if (!challenge) return httpError(reply, 400, "Vraag eerst een uitdaging aan");
    db.prepare("UPDATE staff_pending SET challenge = NULL WHERE token_hash = ?").run(x.p.token_hash);
    // Eerst de sleutel die de app noemt (als die er is), daarna de andere sleutels van deze medewerker.
    const keys = keysOf(ctx, x.s.id).sort((a, b) => Number(b.public_key === req.body?.publicKey) - Number(a.public_key === req.body?.publicKey));
    const hit = keys.find((k) => { try { return verifyDeviceSignature(parseDeviceKey(k.public_key), challenge, String(req.body?.signature ?? "")); } catch { return false; } });
    if (!hit) { failAttempt(x.p.token_hash, x.p.attempts); return httpError(reply, 400, "Je vingerafdruk kon niet worden gecontroleerd. Probeer het opnieuw of gebruik je authenticator-app."); }
    db.prepare("UPDATE staff_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), hit.id);
    db.prepare("DELETE FROM staff_pending WHERE token_hash = ?").run(x.p.token_hash);
    return newSession(ctx, x.s, "device", req.ip);
  });

  // Eerste keer: authenticator-app instellen (geheim + otpauth://-adres), daarna bevestigen met een code.
  const startTotp = async (s: StaffRow) => {
    const secret = base32Encode(crypto.randomBytes(20));
    db.prepare("UPDATE staff SET totp_pending_enc = ? WHERE id = ?").run(ctx.secrets.seal(secret, `totp-pending:${s.id}`), s.id);
    const uri = otpauthUri(brandName(), s.email, secret);
    // QR-code als SVG, zodat het beheer hem zonder extra bibliotheek kan tonen.
    const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, uri, qrSvg };
  };
  const confirmTotp = (s: StaffRow, code: string): boolean => {
    const secret = ctx.secrets.open<string>(s.totp_pending_enc, `totp-pending:${s.id}`);
    if (!secret) throw new StaffError(409, "Begin eerst met instellen");
    const step = verifyTotp(base32Decode(secret), code.replace(/\s/g, ""), 0);
    if (step === null) return false;
    db.prepare("UPDATE staff SET totp_enc = ?, totp_pending_enc = NULL, totp_last_step = ? WHERE id = ?").run(ctx.secrets.seal(secret, `totp:${s.id}`), step, s.id);
    return true;
  };
  const addDevice = (s: StaffRow, publicKey: string, challenge: string, signature: string, label: unknown) => {
    const key = parseDeviceKey(publicKey);
    if (!verifyDeviceSignature(key, challenge, signature)) throw new StaffError(400, "De handtekening van je toestel klopt niet. Probeer het opnieuw.");
    const spki = key.export({ format: "der", type: "spki" }).toString("base64");
    if (db.prepare("SELECT 1 FROM staff_keys WHERE public_key = ?").get(spki)) throw new StaffError(409, "Dit toestel is al gekoppeld");
    const id = crypto.randomBytes(6).toString("hex");
    db.prepare("INSERT INTO staff_keys (id, staff_id, public_key, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, s.id, spki, String(label ?? "").trim().slice(0, 60) || "Telefoon", Date.now(), Date.now());
    return id;
  };
  /** Instellen bij de eerste aanmelding mag alleen zolang er nog géén tweede stap is (anders: eerst inloggen). */
  const enrolling = (req: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
    const x = pendingOf((req.body as any)?.pending);
    if (!x) { expired(reply); return null; }
    if (x.s.totp_enc || keysOf(ctx, x.s.id).length) { httpError(reply, 409, "Je hebt al een tweede stap ingesteld. Log daarmee in."); return null; }
    return x;
  };

  app.post<{ Body: { pending?: string } }>("/v1/admin/auth/enrol/totp", async (req, reply) => {
    const x = enrolling(req, reply); if (!x) return;
    return startTotp(x.s);
  });
  app.post<{ Body: { pending?: string; code?: string } }>("/v1/admin/auth/enrol/totp/confirm", async (req, reply) => {
    if (!limits.secondIp.ok(req.ip)) return httpError(reply, 429, "Te veel pogingen. Wacht even en probeer het dan opnieuw.");
    const x = enrolling(req, reply); if (!x) return;
    try {
      if (!confirmTotp(x.s, String(req.body?.code ?? ""))) { failAttempt(x.p.token_hash, x.p.attempts); return httpError(reply, 400, "Die code klopt niet. Kijk in je authenticator-app en probeer het opnieuw."); }
    } catch (e) { if (e instanceof StaffError) return httpError(reply, e.status, e.message); throw e; }
    audit(ctx, x.s, "second-factor-add", x.s.email, { method: "totp" });
    db.prepare("DELETE FROM staff_pending WHERE token_hash = ?").run(x.p.token_hash);
    return newSession(ctx, getStaff(ctx, x.s.id)!, "totp", req.ip);
  });
  app.post<{ Body: { pending?: string; publicKey?: string; signature?: string; label?: string } }>("/v1/admin/auth/enrol/device", async (req, reply) => {
    const x = enrolling(req, reply); if (!x) return;
    const challenge = x.p.challenge;
    if (!challenge) return httpError(reply, 400, "Vraag eerst een uitdaging aan");
    db.prepare("UPDATE staff_pending SET challenge = NULL WHERE token_hash = ?").run(x.p.token_hash);
    try { addDevice(x.s, String(req.body?.publicKey ?? ""), challenge, String(req.body?.signature ?? ""), req.body?.label); }
    catch (e) { if (e instanceof StaffError) { failAttempt(x.p.token_hash, x.p.attempts); return httpError(reply, e.status, e.message); } throw e; }
    audit(ctx, x.s, "second-factor-add", x.s.email, { method: "device" });
    db.prepare("DELETE FROM staff_pending WHERE token_hash = ?").run(x.p.token_hash);
    return newSession(ctx, x.s, "device", req.ip);
  });

  // ── Ingelogd: eigen account ──
  const me = (req: FastifyRequest, reply: FastifyReply) => {
    const s = staffFromRequest(ctx, req);
    if (!s) { httpError(reply, 401, "Log eerst in"); return null; }
    return s;
  };
  const challenges = new Map<string, { challenge: string; until: number }>();

  app.get("/v1/admin/me", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    return { staff: staffView(ctx, s), permissions: PERMISSIONS[s.role], brand: getBrand(ctx), adressendienst: !!ctx.cfg.adressenPubliek };
  });
  app.post("/v1/admin/auth/logout", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    const m = /^Staff ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "")!;
    db.prepare("DELETE FROM staff_sessions WHERE token_hash = ?").run(sha256(m[1].toLowerCase()));
    audit(ctx, s, "logout");
    return { ok: true };
  });
  app.post<{ Body: { name?: string } }>("/v1/admin/me/name", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    db.prepare("UPDATE staff SET name = ? WHERE id = ?").run(String(req.body?.name ?? "").trim().slice(0, 80) || null, s.id);
    return { staff: staffView(ctx, getStaff(ctx, s.id)!) };
  });
  app.post("/v1/admin/me/totp", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    return startTotp(s);
  });
  app.post<{ Body: { code?: string } }>("/v1/admin/me/totp/confirm", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    try { if (!confirmTotp(s, String(req.body?.code ?? ""))) return httpError(reply, 400, "Die code klopt niet. Kijk in je authenticator-app en probeer het opnieuw."); }
    catch (e) { if (e instanceof StaffError) return httpError(reply, e.status, e.message); throw e; }
    audit(ctx, s, "second-factor-add", s.email, { method: "totp" });
    return { staff: staffView(ctx, getStaff(ctx, s.id)!) };
  });
  app.delete("/v1/admin/me/totp", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    if (!keysOf(ctx, s.id).length) return httpError(reply, 409, "Koppel eerst een toestel, anders kun je niet meer inloggen");
    db.prepare("UPDATE staff SET totp_enc = NULL, totp_pending_enc = NULL WHERE id = ?").run(s.id);
    audit(ctx, s, "second-factor-remove", s.email, { method: "totp" });
    return { staff: staffView(ctx, getStaff(ctx, s.id)!) };
  });
  app.post("/v1/admin/me/device/challenge", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    const challenge = crypto.randomBytes(32).toString("base64url");
    challenges.set(s.id, { challenge, until: Date.now() + 5 * 60_000 });
    return { challenge, message: signedMessage(challenge) };
  });
  app.post<{ Body: { publicKey?: string; signature?: string; label?: string } }>("/v1/admin/me/device", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    const c = challenges.get(s.id);
    challenges.delete(s.id);
    if (!c || c.until < Date.now()) return httpError(reply, 400, "Vraag eerst een uitdaging aan");
    try { addDevice(s, String(req.body?.publicKey ?? ""), c.challenge, String(req.body?.signature ?? ""), req.body?.label); }
    catch (e) { if (e instanceof StaffError) return httpError(reply, e.status, e.message); throw e; }
    audit(ctx, s, "second-factor-add", s.email, { method: "device" });
    return { staff: staffView(ctx, getStaff(ctx, s.id)!) };
  });
  app.delete<{ Params: { id: string } }>("/v1/admin/me/device/:id", async (req, reply) => {
    const s = me(req, reply); if (!s) return;
    const k = keysOf(ctx, s.id).find((x) => x.id === req.params.id);
    if (!k) return httpError(reply, 404, "Dit toestel bestaat niet");
    if (!s.totp_enc && keysOf(ctx, s.id).length <= 1) return httpError(reply, 409, "Stel eerst een authenticator-app in of koppel een ander toestel, anders kun je niet meer inloggen");
    db.prepare("DELETE FROM staff_keys WHERE id = ?").run(k.id);
    audit(ctx, s, "second-factor-remove", s.email, { method: "device", label: k.label });
    return { staff: staffView(ctx, getStaff(ctx, s.id)!) };
  });
}

/** Mail aan een nieuwe medewerker. */
export async function mailInvite(ctx: Ctx, s: StaffRow, by: StaffRow | null) {
  const b = getBrand(ctx);
  await trySend(ctx.mail, s.email, `Je bent medewerker bij ${b.name}`,
    `Hallo,\n\n${by ? (by.name || by.email) : "De eigenaar"} heeft je toegevoegd als medewerker (${ROLE_LABELS[s.role]}) bij ${b.name}.\n\nInloggen kan in de Eigen Cloud-app (onderdeel Aanbieder) of op ${ctx.cfg.publicUrl}/beheer met je e-mailadres. De eerste keer stel je je vingerafdruk of een authenticator-app in; die heb je daarna elke keer nodig.\n\nGroet,\n${b.name}`);
}
