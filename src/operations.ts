import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { tokenFrom, tokenUser, requireAuth, uid } from "./auth.js";
import { runtime } from "./cluster/runtime.js";

declare module "fastify" { interface FastifyRequest { operationId?: string; } }
export function installOperations(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !req.url.startsWith("/api/") || req.isMultipart()) return;
    if (/^\/api\/(?:login|logout|invite|security|settings\/password)(?:\/|\?|$)/.test(req.url)) return;
    if (Buffer.isBuffer(req.body)) return;
    if (runtime.featuresBlocked()) return;
    const key = req.headers["idempotency-key"] ?? crypto.randomUUID();
    req.headers["idempotency-key"] = key;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return reply.code(400).send({ error: "Ongeldig verzoeknummer" });
    const user = tokenUser(tokenFrom(req));
    if (user === null) return;
    const id = crypto.createHash("sha256").update(`${user}:${key}`).digest("hex");
    const hash = crypto.createHash("sha256").update(JSON.stringify([req.method, req.url, req.body, req.headers["if-match"] ?? null, req.headers["if-none-match"] ?? null])).digest("hex");
    const previous = db.prepare("SELECT * FROM api_operations WHERE id = ?").get(id) as { request_hash: string; status: number; response: string | null } | undefined;
    if (previous) {
      if (previous.request_hash !== hash) return reply.code(409).send({ error: "Dit verzoeknummer hoort bij een andere wijziging" });
      if (!previous.status) return reply.code(409).send({ error: "Deze wijziging loopt nog of is onderbroken. Controleer de uitkomst voordat je opnieuw begint.", uncertain: true, operationId: key });
      return reply.code(previous.status).header("Idempotency-Replayed", "true").header("Content-Type", "application/json").send(previous.response);
    }
    db.prepare("INSERT INTO api_operations (id,user_id,method,url,request_hash,status,created) VALUES (?,?,?,?,?,0,?)").run(id, user, req.method, req.url, hash, Date.now());
    req.operationId = id;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.operationId && (typeof payload === "string" || Buffer.isBuffer(payload))) {
      if ([429, 507].includes(reply.statusCode)) {
        // Budget checks reject work before its intent is stored. A retry with the same
        // key must be allowed after storage or queue capacity has become available.
        db.prepare("DELETE FROM api_operations WHERE id=?").run(req.operationId);
        return payload;
      }
      db.prepare("UPDATE api_operations SET status = ?, response = ? WHERE id = ?").run(reply.statusCode, String(payload), req.operationId);
    }
    return payload;
  });
  app.get<{ Params: { id: string } }>("/api/operations/:id", { preHandler: requireAuth }, async (req, reply) => {
    const id = crypto.createHash("sha256").update(`${uid(req)}:${req.params.id}`).digest("hex");
    const row = db.prepare("SELECT method,url,status,created FROM api_operations WHERE id = ? AND user_id = ?").get(id, uid(req));
    return row ?? reply.code(404).send({ error: "Niet gevonden" });
  });
}
