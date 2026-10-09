import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import "./db.js";
import { authRoutes } from "./auth.js";
import { mailRoutes } from "./mail/routes.js";
import { calendarRoutes } from "./calendar/routes.js";
import { photoRoutes } from "./photos/routes.js";
import { runtime } from "./cluster/runtime.js";
import { proxyTo } from "./cluster/proxy.js";
import { isNotLeader } from "./cluster/fence.js";
import { clusterRoutes } from "./cluster/routes.js";
import { settingsRoutes } from "./settingsRoutes.js";
import { importRoutes } from "./import/routes.js";
import { timeMachineRoutes } from "./cluster/timemachine.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV === "production", bodyLimit: 60 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 500 } });
  await app.register(fastifyStatic, { root: path.resolve(here, "../web"), prefix: "/" });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 20 * 1024 * 1024 }, (_r, body, done) => done(null, body));

  // Cluster: API-verzoeken op een niet-leider gaan door naar de leider.
  app.addHook("onRequest", async (req, reply) => {
    if (!runtime.enabled || req.headers["x-eigen-proxied"]) return;
    const url = req.url;
    if (!(url.startsWith("/api/") || url.startsWith("/ical/")) || url.startsWith("/api/cluster/local")) return;
    const target = runtime.leaderApiUrl();
    if (target) return proxyTo(target, runtime.apiServername, req, reply);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (isNotLeader(err)) return reply.code(503).header("retry-after", "3").send({ error: "Even geduld: het cluster wisselt van leider. Probeer het zo opnieuw." });
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    if (code >= 500) console.error(err);
    return reply.code(code).send({ error: (err as Error).message });
  });

  app.addHook("onSend", async (req, reply) => {
    // Schrijfactie pas bevestigen als hij ook op een tweede data-node staat (max. 3 s wachten).
    if (runtime.enabled && req.method !== "GET" && req.method !== "HEAD" && reply.statusCode < 400 && runtime.isLeader()) await runtime.waitDurable();
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "SAMEORIGIN");
  });

  authRoutes(app);
  calendarRoutes(app);
  await app.register(async (s) => mailRoutes(s));
  await app.register(async (s) => photoRoutes(s));
  await app.register(async (s) => clusterRoutes(s));
  await app.register(async (s) => settingsRoutes(s));
  await app.register(async (s) => importRoutes(s));
  await app.register(async (s) => timeMachineRoutes(s));
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

