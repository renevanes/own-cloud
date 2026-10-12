import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireAuth, uid } from "../auth.js";
import { getUser } from "../users.js";
import { blobWritten, ensureLocal, relData } from "../blobs.js";
import { runtime } from "../cluster/runtime.js";
import { boundedWork, fsyncFile, reserveSpace } from "../work.js";
import { compose, deliverPrepared, senderFor, type OutgoingMail } from "./send.js";
import { storeRawMessage } from "./store.js";
import { mailInput, object, string } from "../apiContract.js";
import { checkRevision, revisionTag } from "../security/preconditions.js";

type Outbox = { id: string; user_id: number; mail: string; raw_path: string; status: string; created: number; updated: number; attempts: number; error: string | null; sent_id: number | null };
type Delivery = { address: string; status: string; attempts: number; error: string | null };
const running = new Map<string, Promise<void>>();
const address = (s: string) => {
  const clean = (/<([^<>]+)>$/.exec(s.trim())?.[1] ?? s.trim()).toLowerCase();
  if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(clean)) throw Object.assign(new Error("Controleer het e-mailadres van de ontvanger"), { statusCode: 400 });
  return clean;
};
export async function enqueueMail(mail: OutgoingMail, userId: number, operationKey: string = crypto.randomUUID()) {
  const recipients = [...new Set([...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].map(address))];
  if (!recipients.length || recipients.length > 100) throw Object.assign(new Error("Kies tussen 1 en 100 ontvangers"), { statusCode: 400 });
  const hash = crypto.createHash("sha256").update(operationKey).digest("hex");
  const existing = db.prepare("SELECT id,status,sent_id FROM mail_outbox WHERE user_id=? AND request_hash=?").get(userId, hash) as { id: string; status: string; sent_id: number | null } | undefined;
  if (existing) return existing;
  const from = senderFor(userId).from;
  const messageId = `<${crypto.randomUUID()}@${config.hostname}>`;
  const raw = await boundedWork("mail-compose", 2, () => compose(mail, from, messageId));
  if (raw.length > config.maxMessageBytes) throw Object.assign(new Error("Bericht is te groot"), { statusCode: 413 });
  const release = reserveSpace(userId, raw.length);
  try {
    if (getUser(userId)?.status !== "active") throw Object.assign(new Error("Dit account is niet meer actief"), { statusCode: 401 });
    const sha = crypto.createHash("sha256").update(raw).digest("hex");
    const file = path.join(config.dataDir, "mail", "outbox", sha + ".eml");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw, { mode: 0o600 }); fsyncFile(file);
    const id = crypto.randomUUID(), now = Date.now();
    db.transaction(() => {
      db.prepare("INSERT INTO mail_outbox (id,user_id,request_hash,mail,raw_path,message_id,status,created,updated,size) VALUES (?,?,?,?,?,?,'queued',?,?,?)")
        .run(id, userId, hash, JSON.stringify({ from, to: mail.to, cc: mail.cc, subject: mail.subject }), relData(file), messageId, now, now, raw.length);
      const ins = db.prepare("INSERT INTO mail_delivery (outbox_id,address,status,updated) VALUES (?,?,'pending',?)");
      for (const recipient of recipients) ins.run(id, recipient, now);
      blobWritten(relData(file));
    })();
    return { id, status: "queued", sent_id: null };
  } finally { release(); }
}

/** A crashed 'sending' intent is held for user review: SMTP cannot promise exactly-once delivery. */
export async function processOutbox(id: string) {
  const active = running.get(id);
  if (active) return active;
  const work = boundedWork("outbox", 2, async () => {
    if (!runtime.isLeader()) return;
    const row = db.prepare("SELECT * FROM mail_outbox WHERE id=?").get(id) as Outbox | undefined;
    if (!row || !["queued", "retry", "processing"].includes(row.status)) return;
    if (getUser(row.user_id)?.status !== "active") return;
    const file = await ensureLocal(row.raw_path); if (!file) return;
    const raw = fs.readFileSync(file), info = JSON.parse(row.mail) as { from: string };
    const deliveries = db.prepare("SELECT address,status,attempts,error FROM mail_delivery WHERE outbox_id=?").all(id) as Delivery[];
    for (const d of deliveries) {
      if (!runtime.isLeader() || getUser(row.user_id)?.status !== "active" || !db.prepare("SELECT 1 FROM mail_outbox WHERE id=?").get(id)) return;
      if (d.status === "sending") { db.prepare("UPDATE mail_delivery SET status='uncertain',error='Versturen werd onderbroken; controleer de ontvanger',updated=? WHERE outbox_id=? AND address=?").run(Date.now(), id, d.address); continue; }
      if (!["pending", "retry"].includes(d.status)) continue;
      db.transaction(() => {
        db.prepare("UPDATE mail_outbox SET status='processing',updated=?,attempts=attempts+1 WHERE id=?").run(Date.now(), id);
        db.prepare("UPDATE mail_delivery SET status='sending',attempts=attempts+1,updated=? WHERE outbox_id=? AND address=?").run(Date.now(), id, d.address);
      })();
      if (runtime.enabled && !(await runtime.waitDurable())) {
        if (runtime.isLeader()) db.prepare("UPDATE mail_delivery SET status='retry',error='Wachten op een veilige kopie',updated=? WHERE outbox_id=? AND address=?").run(Date.now(), id, d.address);
        return;
      }
      try {
        await deliverPrepared(raw, d.address, info.from, row.user_id);
        db.prepare("UPDATE mail_delivery SET status='sent',error=NULL,updated=? WHERE outbox_id=? AND address=?").run(Date.now(), id, d.address);
      } catch (e) {
        if (!runtime.isLeader()) return;
        const err = e as Error & { responseCode?: number; code?: string; command?: string };
        // A connection loss after DATA has an unknown outcome; never retry it automatically.
        const beforeConnection = ["EDNS", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(err.code ?? "");
        const status = err.responseCode && err.responseCode >= 500 ? "failed" : err.responseCode || beforeConnection ? "retry" : "uncertain";
        db.prepare("UPDATE mail_delivery SET status=?,error=?,updated=? WHERE outbox_id=? AND address=?").run(status, err.message.slice(0, 1000), Date.now(), id, d.address);
      }
    }
    if (!runtime.isLeader() || !db.prepare("SELECT 1 FROM mail_outbox WHERE id=?").get(id)) return;
    const all = db.prepare("SELECT status FROM mail_delivery WHERE outbox_id=?").all(id) as { status: string }[];
    const status = all.every((x) => x.status === "sent") ? "sent" : all.some((x) => x.status === "uncertain") ? "uncertain" : all.some((x) => ["pending", "retry"].includes(x.status)) ? "retry" : "failed";
    let sentId = row.sent_id;
    if (all.some((x) => x.status === "sent") && !sentId) sentId = await storeRawMessage(raw, { folder: "sent", isRead: true, userId: row.user_id });
    db.prepare("UPDATE mail_outbox SET status=?,sent_id=COALESCE(sent_id,?),updated=?,next_attempt=? WHERE id=?")
      .run(status, sentId, Date.now(), Date.now() + Math.min(6 * 3600e3, 30_000 * 2 ** Math.min(row.attempts, 10)), id);
  });
  running.set(id, work);
  try { await work; } finally { running.delete(id); }
}

export async function drainOutbox() {
  if (!runtime.isLeader()) return;
  const rows = db.prepare("SELECT id FROM mail_outbox WHERE status IN ('queued','retry','processing') AND next_attempt<=? ORDER BY created LIMIT 20").all(Date.now()) as { id: string }[];
  for (const row of rows) await processOutbox(row.id);
}

export function outboxRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/mail/outbox", async (req) => db.prepare("SELECT id,status,created,updated,attempts,error,sent_id,mail FROM mail_outbox WHERE user_id=? ORDER BY created DESC LIMIT 100").all(uid(req))
    .map((r: any) => ({ ...r, mail: JSON.parse(r.mail), deliveries: db.prepare("SELECT address,status,error FROM mail_delivery WHERE outbox_id=?").all(r.id) })));
  app.post<{ Params: { id: string } }>("/api/mail/outbox/:id/retry", async (req, reply) => {
    const row = db.prepare("SELECT * FROM mail_outbox WHERE id=? AND user_id=?").get(req.params.id, uid(req)) as Outbox | undefined;
    if (!row) return reply.code(404).send({ error: "Niet gevonden" });
    if (row.status === "uncertain" || row.status === "processing") return reply.code(409).send({ error: "Controleer eerst welke ontvangers het bericht hebben gekregen" });
    db.transaction(() => {
      db.prepare("UPDATE mail_delivery SET status='pending' WHERE outbox_id=? AND status IN ('retry','failed')").run(row.id);
      db.prepare("UPDATE mail_outbox SET status='queued',next_attempt=0 WHERE id=?").run(row.id);
    })();
    await processOutbox(row.id); return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { address: string; delivered: boolean } }>("/api/mail/outbox/:id/resolve", {
    schema: { body: object({ address: string(320), delivered: { type: "boolean" } }, ["address", "delivered"]) },
  }, async (req, reply) => {
    const row = db.prepare("SELECT id FROM mail_outbox WHERE id=? AND user_id=?").get(req.params.id, uid(req));
    if (!row) return reply.code(404).send({ error: "Niet gevonden" });
    const result = db.prepare("UPDATE mail_delivery SET status=?,error=NULL WHERE outbox_id=? AND address=? AND status='uncertain'")
      .run(req.body.delivered ? "sent" : "pending", req.params.id, req.body.address);
    if (!result.changes) return reply.code(409).send({ error: "Deze ontvanger wacht niet op controle" });
    db.prepare("UPDATE mail_outbox SET status='queued',next_attempt=0 WHERE id=?").run(req.params.id); return { ok: true };
  });
  app.get("/api/mail/drafts", async (req) => db.prepare("SELECT id,mail,updated FROM mail_drafts WHERE user_id=? ORDER BY updated DESC").all(uid(req)).map((r: any) => ({ ...r, mail: JSON.parse(r.mail) })));
  app.put<{ Params: { id: string }; Body: any }>("/api/mail/drafts/:id", { schema: { body: mailInput } }, async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(req.params.id)) return reply.code(400).send({ error: "Ongeldig conceptnummer" });
    const row = db.prepare("SELECT user_id,updated,length(CAST(mail AS BLOB)) AS size FROM mail_drafts WHERE id=?").get(req.params.id) as { user_id: number; updated: number; size: number } | undefined;
    if (row && row.user_id !== uid(req)) return reply.code(404).send({ error: "Niet gevonden" });
    checkRevision(req, row ? revisionTag("draft", req.params.id, row.updated) : null);
    const updated = Math.max(Date.now(), (row?.updated ?? 0) + 1);
    const mail = JSON.stringify(req.body);
    const release = reserveSpace(uid(req), Math.max(0, Buffer.byteLength(mail) - (row?.size ?? 0)));
    try { db.prepare("INSERT INTO mail_drafts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET mail=excluded.mail,updated=excluded.updated").run(req.params.id, uid(req), mail, updated); } finally { release(); }
    return { ok: true, id: req.params.id, updated };
  });
  app.delete<{ Params: { id: string } }>("/api/mail/drafts/:id", async (req) => { db.prepare("DELETE FROM mail_drafts WHERE id=? AND user_id=?").run(req.params.id, uid(req)); return { ok: true }; });
}
