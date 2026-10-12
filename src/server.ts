import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import "./db.js";
import { authRoutes, requireAuth, requireOwner } from "./auth.js";
import { mailRoutes } from "./mail/routes.js";
import { calendarRoutes } from "./calendar/routes.js";
import { photoRoutes } from "./photos/routes.js";
import { runtime } from "./cluster/runtime.js";
import { proxyTo } from "./cluster/proxy.js";
import { isNotLeader } from "./cluster/fence.js";
import { clusterRoutes } from "./cluster/routes.js";
import { settingsRoutes } from "./settingsRoutes.js";
import { importRoutes, drainImports } from "./import/routes.js";
import { timeMachineRoutes } from "./cluster/timemachine.js";
import { gmailRoutes } from "./gmail/routes.js";
import { appDistRoutes } from "./appDist.js";
import { usersRoutes } from "./usersRoutes.js";
import { installApiSchemas, ownerOnly } from "./apiContract.js";
import { installOperations } from "./operations.js";
import { accountSecurityRoutes } from "./security/account.js";
import { outboxRoutes, drainOutbox } from "./mail/outbox.js";
import { sharingRoutes } from "./sharing.js";
import { filterRoutes } from "./mail/filter.js";
import { contactRoutes, davRoutes } from "./dav.js";
import { exportRoutes } from "./export.js";
import { photoToolRoutes, drainMedia } from "./photos/tools.js";
import { resourceRoutes } from "./resourceRoutes.js";
import { capabilityRoutes } from "./capabilities.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV === "production", bodyLimit: 60 * 1024 * 1024, trustProxy: ["loopback", "linklocal", "uniquelocal"],
    ajv: { customOptions: { removeAdditional: false } } });
  installApiSchemas(app);
  for (const method of ["PROPFIND", "REPORT", "MKCALENDAR"]) app.addHttpMethod(method, { hasBody: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 50 } });
  installOperations(app);
  await app.register(fastifyStatic, { root: path.resolve(here, "../web"), prefix: "/" });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (_r, body, done) => done(null, body));

  // Cluster: API-verzoeken op een niet-leider gaan door naar de leider.
  app.addHook("onRequest", async (req, reply) => {
    if (!runtime.enabled || req.headers["x-eigen-proxied"]) return;
    const url = req.url;
    if (!(url.startsWith("/api/") || url.startsWith("/ical/") || url.startsWith("/dav/")) || url.startsWith("/api/cluster/local")) return;
    const target = runtime.leaderApiUrl();
    if (target) return proxyTo(target, runtime.apiServername, req, reply);
  });
  app.addHook("preValidation", async (req, reply) => {
    if (runtime.featuresBlocked() && ((!["GET", "HEAD"].includes(req.method) && /^\/api\/(security|sharing|contacts|import|settings\/password|photos\/\d+\/(tags|ocr)|mail\/(send|outbox|drafts|rules|filter))/.test(req.url)) || ["PUT", "DELETE", "MKCALENDAR"].includes(req.method) && req.url.startsWith("/dav/"))) {
      return reply.code(503).header("Retry-After", "30").send({ error: runtime.featuresBlocked() });
    }
  });
  app.addHook("onRequest", async (req, reply) => {
    if (ownerOnly(req.routeOptions.url ?? req.url.split("?")[0], req.method)) return requireOwner(req, reply);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.url.startsWith("/api/") && !/^\/api\/(?:login|invite)(?:\/|\?|$)/.test(req.url)) return requireAuth(req, reply);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (isNotLeader(err)) return reply.code(503).header("retry-after", "3").send({ error: "Even geduld: het cluster wisselt van leider. Probeer het zo opnieuw." });
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    if (code >= 500) console.error(err);
    return reply.code(code).send({ error: code >= 500 && code !== 507 ? "Er ging iets mis aan onze kant. Probeer het later opnieuw." : (err as Error).message });
  });

  app.addHook("onSend", async (req, reply, payload) => {
    // Bevestig alleen metadata én bestanden met een tweede duurzame kopie (node of objectopslag).
    if (runtime.enabled && ["POST", "PUT", "PATCH", "DELETE", "MKCALENDAR"].includes(req.method) && reply.statusCode < 400 && !(await runtime.waitDurable())) {
      reply.code(503).header("Retry-After", "3").header("Content-Type", "application/json");
      reply.removeHeader("Content-Length");
      payload = JSON.stringify({ error: "Je wijziging is nog niet veilig bevestigd. Probeer hetzelfde verzoek opnieuw.", uncertain: true, operationId: req.headers["idempotency-key"] ?? req.id });
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
    if (req.url.startsWith("/api/") || req.url.startsWith("/ical/")) reply.header("Cache-Control", "no-store");
    if (req.url.startsWith("/api/")) reply.header("X-Eigen-Api-Version", "1");
    return payload;
  });

  authRoutes(app);
  capabilityRoutes(app);
  calendarRoutes(app);
  await app.register(async (s) => mailRoutes(s));
  await app.register(async (s) => photoRoutes(s));
  await app.register(async (s) => clusterRoutes(s));
  await app.register(async (s) => settingsRoutes(s));
  await app.register(async (s) => importRoutes(s));
  await app.register(async (s) => timeMachineRoutes(s));
  await app.register(async (s) => gmailRoutes(s));
  await app.register(async (s) => appDistRoutes(s));
  await app.register(async (s) => usersRoutes(s));
  await app.register(async (s) => accountSecurityRoutes(s));
  await app.register(async (s) => outboxRoutes(s));
  await app.register(async (s) => sharingRoutes(s));
  await app.register(async (s) => filterRoutes(s));
  await app.register(async (s) => contactRoutes(s));
  await app.register(davRoutes);
  await app.register(async (s) => exportRoutes(s));
  await app.register(async (s) => photoToolRoutes(s));
  await app.register(async (s) => resourceRoutes(s));
  const outboxTimer = setInterval(() => void drainOutbox().catch((e) => console.error("postvak uit:", (e as Error).message)), 10_000);
  outboxTimer.unref();
  app.addHook("onClose", async () => { clearInterval(outboxTimer); });
  const importTimer = setInterval(() => void drainImports().catch((e) => console.error("import:", (e as Error).message)), 10_000);
  importTimer.unref(); app.addHook("onClose", async () => { clearInterval(importTimer); });
  const mediaTimer = setInterval(() => void drainMedia().catch((e) => console.error("fotoverwerking:", (e as Error).message)), 10_000);
  mediaTimer.unref(); app.addHook("onClose", async () => { clearInterval(mediaTimer); });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

