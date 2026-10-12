import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import type { FastifyInstance } from "fastify";
import { db, getSetting } from "../db.js";
import { requireAuth, requireOwner, uid } from "../auth.js";
import { object, string } from "../apiContract.js";
import { boundedWork } from "../work.js";

export interface Scan { status: "off" | "ok" | "unavailable"; score: number | null; action: string | null; details: string[] }
export async function scanMail(raw: Buffer, connection: { ip?: string; helo?: string; sender?: string; recipients?: string[] } = {}): Promise<Scan> {
  const url = getSetting("rspamd_url") ?? process.env.RSPAMD_URL;
  if (!url) return { status: "off", score: null, action: null, details: [] };
  try {
    return await boundedWork("spam-scan", 2, async () => {
      const target = new URL("checkv2", url.endsWith("/") ? url : url + "/");
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Ongeldig adres");
      const response = await fetch(target, { method: "POST", body: new Uint8Array(raw), signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "message/rfc822", ...(connection.ip ? { IP: connection.ip } : {}), ...(connection.helo ? { Helo: connection.helo.replace(/[\r\n]/g, "") } : {}),
          ...(connection.sender ? { From: connection.sender.replace(/[\r\n]/g, "") } : {}), ...(connection.recipients?.length ? { Rcpt: connection.recipients.map((r) => r.replace(/[\r\n,]/g, "")).join(",") } : {}) } });
      if (!response.ok) throw new Error("Spamcontrole niet beschikbaar");
      if (!response.body) throw new Error("Leeg antwoord");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 256 * 1024) { await reader.cancel(); throw new Error("Antwoord te groot"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { score?: number; action?: string; symbols?: Record<string, unknown> };
      return { status: "ok" as const, score: Number.isFinite(result.score) ? Number(result.score) : null, action: String(result.action ?? "no action").slice(0, 80), details: Object.keys(result.symbols ?? {}).slice(0, 100) };
    });
  } catch { return { status: "unavailable", score: null, action: null, details: ["Spamcontrole niet beschikbaar; bericht wel bewaard"] }; }
}

export async function filteredFolder(raw: Buffer, userId: number, scan: Scan): Promise<"inbox" | "archive" | "spam" | "trash"> {
  if (scan.status === "ok" && (["reject", "add header", "rewrite subject"].includes(scan.action ?? "") || (scan.score ?? 0) >= Number(getSetting("spam_threshold") ?? 6))) return "spam";
  const rules = db.prepare("SELECT field,pattern,folder FROM mail_rules WHERE user_id=? AND enabled=1 ORDER BY created,id").all(userId) as { field: string; pattern: string; folder: "inbox" | "archive" | "spam" | "trash" }[];
  if (!rules.length) return "inbox";
  const m = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  const fields: Record<string, string> = { from: m.from?.text ?? "", to: Array.isArray(m.to) ? m.to.map((a) => a.text).join(", ") : m.to?.text ?? "", subject: m.subject ?? "" };
  return rules.find((r) => fields[r.field]?.toLowerCase().includes(r.pattern.toLowerCase()))?.folder ?? "inbox";
}

export function filterRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/mail/rules", async (req) => db.prepare("SELECT id,field,pattern,folder,enabled FROM mail_rules WHERE user_id=? ORDER BY created,id").all(uid(req)));
  app.post<{ Body: { field: string; pattern: string; folder: string } }>("/api/mail/rules", {
    schema: { body: object({ field: { enum: ["from", "to", "subject"] }, pattern: { ...string(200), minLength: 1 }, folder: { enum: ["inbox", "archive", "spam", "trash"] } }, ["field", "pattern", "folder"]) },
  }, async (req, reply) => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM mail_rules WHERE user_id=?").get(uid(req)) as { n: number }).n;
    if (count >= 100) return reply.code(400).send({ error: "Maximaal 100 mailregels" });
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO mail_rules (id,user_id,field,pattern,folder,created) VALUES (?,?,?,?,?,?)").run(id, uid(req), req.body.field, req.body.pattern, req.body.folder, Date.now());
    return { ok: true, id };
  });
  app.delete<{ Params: { id: string } }>("/api/mail/rules/:id", async (req) => { db.prepare("DELETE FROM mail_rules WHERE id=? AND user_id=?").run(req.params.id, uid(req)); return { ok: true }; });
  app.get("/api/mail/filter", async (req) => ({ configured: !!(getSetting("rspamd_url") ?? process.env.RSPAMD_URL), threshold: Number(getSetting("spam_threshold") ?? 6), ...(uid(req) === 1 ? { url: getSetting("rspamd_url") ?? process.env.RSPAMD_URL ?? "" } : {}) }));
  app.put<{ Body: { url: string; threshold: number } }>("/api/mail/filter", {
    preHandler: requireOwner, schema: { body: object({ url: string(2000), threshold: { type: "number", minimum: 0, maximum: 100 } }, ["url", "threshold"]) },
  }, async (req, reply) => {
    if (req.body.url) { try { const u = new URL(req.body.url); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error(); } catch { return reply.code(400).send({ error: "Gebruik een geldig http- of https-adres van je spamcontrole" }); } }
    db.transaction(() => { setSetting("rspamd_url", req.body.url); setSetting("spam_threshold", String(req.body.threshold)); })(); return { ok: true };
  });
}

function setSetting(key: string, value: string) { db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
