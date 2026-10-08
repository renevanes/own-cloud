import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import "./db.js";
import { authRoutes } from "./auth.js";
import { mailRoutes } from "./mail/routes.js";
import { calendarRoutes } from "./calendar/routes.js";
import { photoRoutes } from "./photos/routes.js";
import { startSmtpServer } from "./mail/smtp.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV === "production", bodyLimit: 60 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 500 } });
  await app.register(fastifyStatic, { root: path.resolve(here, "../web"), prefix: "/" });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "SAMEORIGIN");
  });

  authRoutes(app);
  calendarRoutes(app);
  await app.register(async (s) => mailRoutes(s));
  await app.register(async (s) => photoRoutes(s));
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = await buildApp();
  await app.listen({ port: config.httpPort, host: "0.0.0.0" });
  console.log(`🌐 Web/API op http://localhost:${config.httpPort}`);
  if (process.env.DISABLE_SMTP !== "1") startSmtpServer();
}
