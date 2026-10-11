import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db, getSetting, setSetting } from "./db.js";
import { OWNER_ID, getUser, findLogin, hasExtraUsers, userByInvite, userRow, type User } from "./users.js";

const SESSION_DAYS = 30;

declare module "fastify" {
  interface FastifyRequest {
    /** Ingelogde gebruiker (gezet door requireAuth). 1 = eigenaar. */
    userId?: number;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function checkPasswordRules(password: string) {
  if (password.length < 10) throw new Error("Wachtwoord moet minimaal 10 tekens zijn.");
}

/** Wachtwoord van de eigenaar (zoals altijd in settings). */
export function setPassword(password: string) {
  checkPasswordRules(password);
  setSetting("password_hash", hashPassword(password));
}

/** Wachtwoord van een willekeurige gebruiker. Bij een extra gebruiker worden ook zijn andere sessies ongeldig. */
export function setUserPassword(userId: number, password: string, opts: { keepSessions?: boolean } = {}) {
  checkPasswordRules(password);
  if (userId === OWNER_ID) return setPassword(password);
  db.prepare(`UPDATE users SET password_hash = ?, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
    invite_hash = NULL, invite_expires = NULL, session_gen = session_gen + ?, updated = ? WHERE id = ?`)
    .run(hashPassword(password), opts.keepSessions ? 0 : 1, Date.now(), userId);
}

export function passwordHashOf(userId: number): string | undefined {
  if (userId === OWNER_ID) return getSetting("password_hash");
  return userRow(userId)?.password_hash ?? undefined;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

/**
 * Token = "<verloopt-ms>.<handtekening>" voor de eigenaar (ongewijzigd, dus bestaande sessies en de Android-app
 * blijven werken), en "<verloopt-ms>.<id>-<generatie>.<handtekening>" voor een extra gebruiker.
 * Bruikbaar als cookie én als Bearer-token. Het eerste deel is altijd de verlooptijd (de app leest die).
 */
export function createToken(user: Pick<User, "id" | "sessionGen"> = { id: OWNER_ID, sessionGen: 0 }): string {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  if (user.id === OWNER_ID) return `${exp}.${sign(exp)}`;
  const who = `${user.id}-${user.sessionGen}`;
  return `${exp}.${who}.${sign(`${exp}.${who}`)}`;
}

/** Geeft het gebruikers-id van een geldig token, of null. */
export function tokenUser(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  const exp = parts[0];
  let payload: string, sig: string, who: string | null = null;
  if (parts.length === 2) { payload = exp; sig = parts[1]; }
  else if (parts.length === 3) { who = parts[1]; payload = `${exp}.${who}`; sig = parts[2]; }
  else return null;
  if (!exp || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (!(Number(exp) > Date.now())) return null;
  if (who === null) return OWNER_ID;
  const m = /^(\d+)-(\d+)$/.exec(who);
  if (!m) return null;
  const id = Number(m[1]);
  const r = userRow(id);
  if (!r || r.status !== "active" || r.session_gen !== Number(m[2])) return null;
  return id;
}

export function verifyToken(token: string | undefined): boolean {
  return tokenUser(token) !== null;
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return req.cookies?.session;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const id = tokenUser(tokenFrom(req));
  if (id === null) return reply.code(401).send({ error: "Niet ingelogd" });
  req.userId = id;
}

/** Alleen voor de eigenaar: beheer van de cloud, servers, domein en gebruikers. */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (req.userId === undefined) {
    const r = await requireAuth(req, reply);
    if (r) return r;
  }
  if (req.userId !== OWNER_ID) return reply.code(403).send({ error: "Dit kan alleen de eigenaar van de cloud." });
}

/** Ingelogde gebruiker van dit verzoek (na requireAuth). */
export function uid(req: FastifyRequest): number {
  if (req.userId === undefined) throw Object.assign(new Error("Niet ingelogd"), { statusCode: 401 });
  return req.userId;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie("session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

// Eenvoudige rem op inlogpogingen.
const attempts = new Map<string, { n: number; until: number }>();

export function authRoutes(app: FastifyInstance) {
  /** Voor het inlogscherm: is er meer dan één gebruiker (dan ook om je adres vragen)? */
  app.get("/api/login/info", async () => ({ multiUser: hasExtraUsers() }));

  app.post<{ Body: { password?: string; user?: string; email?: string } }>("/api/login", async (req, reply) => {
    const a = attempts.get(req.ip);
    if (a && a.until > Date.now()) return reply.code(429).send({ error: "Te veel pogingen, probeer het later opnieuw." });
    const fail = (error: string) => {
      const n = (a?.n ?? 0) + 1;
      attempts.set(req.ip, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 });
      return reply.code(401).send({ error });
    };

    const login = String(req.body?.user ?? req.body?.email ?? "").trim();
    // Zonder naam of adres: de eigenaar (zoals voorheen, met alleen een wachtwoord).
    const user = login ? findLogin(login) : getUser(OWNER_ID);
    if (user?.id === OWNER_ID && !getSetting("password_hash")) return reply.code(503).send({ error: "Nog geen wachtwoord ingesteld. Draai: npm run set-password" });
    const stored = user ? passwordHashOf(user.id) : undefined;
    const password = String(req.body?.password ?? "");
    if (!user || !stored || !password || !verifyPassword(password, stored)) return fail(login ? "Onjuist adres of wachtwoord" : "Onjuist wachtwoord");
    if (user.status === "disabled") return reply.code(403).send({ error: "Je account is uitgeschakeld. Vraag de eigenaar van de cloud om hulp." });
    if (user.status !== "active") return fail("Onjuist adres of wachtwoord");
    attempts.delete(req.ip);
    const token = createToken(user);
    setSessionCookie(reply, token);
    return { token };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireAuth }, async (req) => {
    const u = getUser(uid(req))!;
    return { ok: true, mailFrom: u.address, user: { id: u.id, name: u.name, address: u.address, owner: u.owner } };
  });

  // ───────── Uitnodiging: wachtwoord kiezen via een eenmalige link ─────────

  const expired = "Deze uitnodiging is verlopen of al gebruikt. Vraag de eigenaar om een nieuwe.";
  app.get<{ Params: { code: string } }>("/api/invite/:code", async (req, reply) => {
    const r = userByInvite(req.params.code);
    if (!r) return reply.code(404).send({ error: expired });
    const u = getUser(r.id)!;
    return { name: u.name, address: u.address };
  });

  app.post<{ Params: { code: string }; Body: { password?: string } }>("/api/invite/:code", async (req, reply) => {
    const r = userByInvite(req.params.code);
    if (!r) return reply.code(404).send({ error: expired });
    try { setUserPassword(r.id, String(req.body?.password ?? "")); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const u = getUser(r.id)!;
    const token = createToken(u);
    setSessionCookie(reply, token);
    return { ok: true, token, user: { id: u.id, name: u.name, address: u.address } };
  });
}
