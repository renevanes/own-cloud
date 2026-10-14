import type { FastifyInstance } from "fastify";
import { requireAuth } from "./auth.js";
import { CONTRACT_VERSION } from "./apiContract.js";
import { SCHEMA_CAPABILITY } from "./migrations.js";
import { runtime } from "./cluster/runtime.js";

export function capabilityRoutes(app: FastifyInstance) {
  app.get("/api/capabilities", { preHandler: requireAuth }, async () => ({
    contractVersion: CONTRACT_VERSION, schemaCapability: SCHEMA_CAPABILITY, writeBlocked: runtime.featuresBlocked(),
    features: ["revocable-sessions", "totp", "recovery-codes", "outbox", "drafts", "spam-rules", "caldav", "carddav", "sharing", "export", "photo-tags", "local-ocr", "offline", "photo-upload-meta"],
    limits: { mailRecipients: 100, mailBytes: 50 * 1024 ** 2, uploadFiles: 50, archiveEntries: 100000, calendarDays: 400, offlineBytes: 100 * 1024 ** 2, offlineOperations: 50 },
  }));
}
