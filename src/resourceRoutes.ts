import type { FastifyInstance } from "fastify";
import { db, getSetting, setSetting } from "./db.js";
import { requireOwner } from "./auth.js";
import { integer, object } from "./apiContract.js";
import fs from "node:fs";
import { config } from "./config.js";
export function resourceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireOwner);
  app.get("/api/admin/resources", async () => {
    const disk = fs.statfsSync(config.dataDir);
    return { defaultLimitBytes: Number(getSetting("storage_limit_bytes") ?? 0), freeBytes: disk.bavail * disk.bsize,
      userLimits: db.prepare("SELECT key,value FROM settings WHERE key LIKE 'storage_limit:%'").all(),
      imports: db.prepare("SELECT user_id,status,COUNT(*) AS count FROM import_jobs WHERE status IN ('queued','running','paused') GROUP BY user_id,status").all(),
      outbox: db.prepare("SELECT status,COUNT(*) AS count FROM mail_outbox WHERE status!='sent' GROUP BY status").all() };
  });
  app.put<{ Body: { bytes: number; userId?: number } }>("/api/admin/resources", { schema: { body: object({ bytes: integer(), userId: integer(1) }, ["bytes"]) } }, async (req) => {
    setSetting(req.body.userId ? `storage_limit:${req.body.userId}` : "storage_limit_bytes", String(req.body.bytes)); return { ok: true };
  });
}
