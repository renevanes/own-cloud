import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";

const SESSION_DAYS = 30;

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

export function setPassword(password: string) {
  if (password.length < 10) throw new Error("Wachtwoord moet minimaal 10 tekens zijn.");
  setSetting("password_hash", hashPassword(password));
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

/** Token = "<verloopt-ms>.<handtekening>" — bruikbaar als cookie én als Bearer-token (Android-app). */
export function createToken(): string {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return req.cookies?.session;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!verifyToken(tokenFrom(req))) return reply.code(401).send({ error: "Niet ingelogd" });
}

// Eenvoudige rem op inlogpogingen.
const attempts = new Map<string, { n: number; until: number }>();

export function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>("/api/login", async (req, reply) => {
    const a = attempts.get(req.ip);
    if (a && a.until > Date.now()) return reply.code(429).send({ error: "Te veel pogingen, probeer het later opnieuw." });

    const stored = getSetting("password_hash");
    if (!stored) return reply.code(503).send({ error: "Nog geen wachtwoord ingesteld. Draai: npm run set-password" });
    if (!req.body?.password || !verifyPassword(req.body.password, stored)) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(req.ip, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 });
      return reply.code(401).send({ error: "Onjuist wachtwoord" });
    }
    attempts.delete(req.ip);
    const token = createToken();
    reply.setCookie("session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return { token };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireAuth }, async () => ({ ok: true, mailFrom: config.mailFrom }));
}
