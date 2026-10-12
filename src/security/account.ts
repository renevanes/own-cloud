import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, getSetting, setSetting } from "../db.js";
import { config } from "../config.js";
import { createToken, passwordHashOf, requireAuth, setSessionCookie, uid, verifyPassword } from "../auth.js";
import { getUser, OWNER_ID } from "../users.js";
import { seal, open } from "../cluster/crypto.js";
import { base32Encode, otpauthUri, verifyTotp } from "./totp.js";
import { object, string } from "../apiContract.js";
import { checkRateLimit } from "./rateLimit.js";
import QRCode from "qrcode";

type Mfa = { user_id: number; secret: string | null; pending: string | null; last_step: number; recovery: string; updated: number };
const key = () => crypto.createHash("sha256").update(`mfa:${config.sessionSecret}`).digest();
const encrypt = (s: Buffer, userId: number) => seal(key(), s, `mfa:${userId}`).toString("base64");
const decrypt = (s: string, userId: number) => open(key(), Buffer.from(s, "base64"), `mfa:${userId}`);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const mfa = (id: number) => db.prepare("SELECT * FROM user_mfa WHERE user_id = ?").get(id) as Mfa | undefined;
export const hasMfa = (id: number) => !!mfa(id)?.secret;

/** TOTP counters and recovery codes are consumed transactionally, including after failover. */
export function secondFactor(id: number, code: string) {
  return db.transaction(() => {
    const row = mfa(id);
    if (!row?.secret) return true;
    const step = verifyTotp(decrypt(row.secret, id), code, row.last_step);
    if (step !== null) { db.prepare("UPDATE user_mfa SET last_step = ?, updated = ? WHERE user_id = ?").run(step, Date.now(), id); return true; }
    const recovery = JSON.parse(row.recovery) as string[];
    const candidate = hash(code.trim().toLowerCase());
    const at = recovery.findIndex((x) => x.length === candidate.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(candidate)));
    if (at < 0) return false;
    recovery.splice(at, 1);
    db.prepare("UPDATE user_mfa SET recovery = ?, updated = ? WHERE user_id = ?").run(JSON.stringify(recovery), Date.now(), id);
    return true;
  })();
}

export function revokeAll(id: number) {
  db.transaction(() => {
    if (id === OWNER_ID) setSetting("owner_session_gen", String(getUser(id)!.sessionGen + 1));
    else db.prepare("UPDATE users SET session_gen = session_gen + 1, updated = ? WHERE id = ?").run(Date.now(), id);
    db.prepare("UPDATE auth_sessions SET revoked = 1 WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM app_credentials WHERE user_id = ?").run(id);
  })();
}

export function accountSecurityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", async (req) => { if (["POST", "PUT"].includes(req.method)) checkRateLimit(`security:${uid(req)}`); });
  const sensitive = object({ password: string(1024), code: string(100) }, ["password"]);
  const confirm = (id: number, b: { password?: string; code?: string }) => {
    const stored = passwordHashOf(id);
    return !!stored && verifyPassword(b.password ?? "", stored) && secondFactor(id, b.code ?? "");
  };
  const fresh = (id: number, reply: Parameters<typeof setSessionCookie>[0]) => {
    const token = createToken(getUser(id)!); setSessionCookie(reply, token); return token;
  };
  app.get("/api/security", async (req) => {
    const row = mfa(uid(req));
    return { mfa: !!row?.secret, recoveryCodes: row ? (JSON.parse(row.recovery) as string[]).length : 0,
      sessions: db.prepare("SELECT id,label,created,last_used AS lastUsed,expires FROM auth_sessions WHERE user_id = ? AND revoked = 0 AND generation = ? AND expires > ? ORDER BY created DESC").all(uid(req), getUser(uid(req))!.sessionGen, Date.now())
        .map((s: any) => ({ ...s, current: s.id === req.sessionId })),
      credentials: db.prepare("SELECT id,label,scopes,created,expires FROM app_credentials WHERE user_id = ? AND generation = ? AND expires > ?").all(uid(req), getUser(uid(req))!.sessionGen, Date.now()) };
  });
  app.delete<{ Params: { id: string } }>("/api/security/sessions/:id", async (req, reply) => {
    const r = db.prepare("UPDATE auth_sessions SET revoked = 1 WHERE id = ? AND user_id = ?").run(req.params.id, uid(req));
    if (!r.changes) return reply.code(404).send({ error: "Niet gevonden" });
    return { ok: true };
  });
  app.post("/api/security/sessions/revoke-others", async (req, reply) => {
    revokeAll(uid(req)); return { ok: true, token: fresh(uid(req), reply) };
  });
  app.post<{ Body: { password: string; code?: string } }>("/api/security/mfa/enrol", { schema: { body: sensitive } }, async (req, reply) => {
    const id = uid(req);
    if (!confirm(id, req.body)) return reply.code(400).send({ error: "Controleer je wachtwoord en tweede inlogcode" });
    const secret = crypto.randomBytes(20);
    db.prepare("INSERT INTO user_mfa (user_id,pending,updated) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET pending=excluded.pending,updated=excluded.updated")
      .run(id, encrypt(secret, id), Date.now());
    const text = base32Encode(secret);
    const uri = otpauthUri("Eigen Cloud", getUser(id)!.address, text);
    return { secret: text, uri, qr: await QRCode.toDataURL(uri) };
  });
  app.post<{ Body: { code: string } }>("/api/security/mfa/confirm", { schema: { body: object({ code: string(6) }, ["code"]) } }, async (req, reply) => {
    const id = uid(req), row = mfa(id);
    if (!row?.pending || Date.now() - row.updated > 10 * 60_000) return reply.code(400).send({ error: "Begin opnieuw met instellen" });
    const step = verifyTotp(decrypt(row.pending, id), req.body.code, -1);
    if (step === null) return reply.code(400).send({ error: "Die code klopt niet" });
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(8).toString("hex"));
    db.transaction(() => {
      db.prepare("UPDATE user_mfa SET secret=pending,pending=NULL,last_step=?,recovery=?,updated=? WHERE user_id=?").run(step, JSON.stringify(codes.map(hash)), Date.now(), id);
      revokeAll(id);
    })();
    return { ok: true, recoveryCodes: codes, token: fresh(id, reply) };
  });
  app.post<{ Body: { password: string; code?: string } }>("/api/security/mfa/disable", { schema: { body: sensitive } }, async (req, reply) => {
    const id = uid(req);
    if (!confirm(id, req.body)) return reply.code(400).send({ error: "Controleer je wachtwoord en tweede inlogcode" });
    db.transaction(() => { db.prepare("DELETE FROM user_mfa WHERE user_id = ?").run(id); revokeAll(id); })();
    return { ok: true, token: fresh(id, reply) };
  });
  app.post<{ Body: { password: string; code?: string; label: string; scopes: string[] } }>("/api/security/credentials", {
    schema: { body: object({ password: string(1024), code: string(100), label: string(80), scopes: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["caldav", "carddav"] } } }, ["password", "label", "scopes"]) },
  }, async (req, reply) => {
    const id = uid(req);
    if (!confirm(id, req.body)) return reply.code(400).send({ error: "Controleer je wachtwoord en tweede inlogcode" });
    const token = `app-${crypto.randomBytes(32).toString("base64url")}`;
    const credentialId = crypto.randomUUID();
    db.prepare("INSERT INTO app_credentials VALUES (?,?,?,?,?,?,?,?)").run(credentialId, id, hash(token), req.body.label, JSON.stringify(req.body.scopes), Date.now(), Date.now() + 365 * 864e5, getUser(id)!.sessionGen);
    return { id: credentialId, password: token, username: getUser(id)!.address };
  });
  app.delete<{ Params: { id: string } }>("/api/security/credentials/:id", async (req, reply) => {
    const r = db.prepare("DELETE FROM app_credentials WHERE id = ? AND user_id = ?").run(req.params.id, uid(req));
    return r.changes ? { ok: true } : reply.code(404).send({ error: "Niet gevonden" });
  });
}
