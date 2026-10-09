/**
 * De Android-app vanaf je eigen cloud downloaden (eerste installatie), ook als de code op GitHub privé is.
 * De APK zit in het server-image (map app-dist/, gevuld door de CI). Alleen voor ingelogde gebruikers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth.js";

const dir = () => process.env.APP_DIST_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app-dist");

export function appDistRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/app/update.json", async (_req, reply) => {
    const f = path.join(dir(), "update.json");
    if (!fs.existsSync(f)) return reply.code(404).send({ error: "Deze server heeft geen app-download" });
    return JSON.parse(fs.readFileSync(f, "utf8"));
  });
  app.get("/app/eigen-cloud.apk", async (_req, reply) => {
    const f = path.join(dir(), "eigen-cloud.apk");
    if (!fs.existsSync(f)) return reply.code(404).send({ error: "Deze server heeft geen app-download" });
    reply.header("content-type", "application/vnd.android.package-archive");
    reply.header("content-disposition", 'attachment; filename="eigen-cloud.apk"');
    reply.header("content-length", fs.statSync(f).size);
    return reply.send(fs.createReadStream(f));
  });
}
