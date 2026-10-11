/**
 * Contact tussen aanbieder en klant: uitnodigingscodes, hulpvragen, berichten (storingen, onderhoud) en de
 * technische gezondheid die clouds zelf melden. Van een cloud bewaren we alleen techniek (versie, gezond, problemen,
 * opslaggebruik, aantal gebruikers, servers) — nooit mail, agenda of foto's.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type CustomerRow, type OrderRow, getOrder, getCustomer, event, sha256 } from "./db.js";
import { type Ctx, bundleOf } from "./context.js";
import { trySend } from "./mail.js";
import { RateLimit } from "./codes.js";
import { getBrand, publicBundle } from "./brand.js";
import { type StaffRow, getStaff } from "./staff.js";

export class SupportError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const when = (ms: number) => new Date(ms).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

// ───────── Uitnodigingscodes ─────────

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // geen 0/O en 1/I
export const normCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
export const showCode = (c: string) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

export interface InviteRow { code: string; label: string | null; bundle: string | null; max_uses: number | null; uses: number; expires_at: number | null; created_by: string | null; created_at: number; revoked_at: number | null }

export function createInvite(ctx: Ctx, by: StaffRow, body: any): InviteRow {
  const label = String(body?.label ?? "").trim().slice(0, 80) || null;
  const bundle = body?.bundle ? String(body.bundle) : null;
  if (bundle && !bundleOf(ctx, bundle)) throw new SupportError(400, "Deze bundel bestaat niet");
  let maxUses: number | null = null;
  if (body?.maxUses !== undefined && body?.maxUses !== null && body?.maxUses !== "") {
    maxUses = Number(body.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000) throw new SupportError(400, "Hoe vaak de code te gebruiken is: een heel getal vanaf 1");
  }
  let expiresAt: number | null = null;
  if (body?.expiresAt) {
    expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : Date.parse(String(body.expiresAt));
    if (!Number.isFinite(expiresAt)) throw new SupportError(400, "De einddatum klopt niet");
  }
  let code = "";
  for (let i = 0; i < 10; i++) {
    code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
    if (!ctx.db.prepare("SELECT 1 FROM invites WHERE code = ?").get(code)) break;
  }
  ctx.db.prepare("INSERT INTO invites (code, label, bundle, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(code, label, bundle, maxUses, expiresAt, by.id, Date.now());
  return ctx.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow;
}

export function inviteState(i: InviteRow | undefined, now = Date.now()): { valid: boolean; reason?: string } {
  if (!i) return { valid: false, reason: "Deze code bestaat niet" };
  if (i.revoked_at) return { valid: false, reason: "Deze code is ingetrokken" };
  if (i.expires_at && i.expires_at <= now) return { valid: false, reason: "Deze code is verlopen" };
  if (i.max_uses !== null && i.uses >= i.max_uses) return { valid: false, reason: "Deze code is al zo vaak gebruikt als mocht" };
  return { valid: true };
}

export const getInvite = (ctx: Ctx, code: unknown) => ctx.db.prepare("SELECT * FROM invites WHERE code = ?").get(normCode(code)) as InviteRow | undefined;

/** Bij een bestelling: code controleren en meetellen. Geeft de genormaliseerde code terug. */
export function useInvite(ctx: Ctx, code: unknown): string {
  const tx = ctx.db.transaction(() => {
    const i = getInvite(ctx, code);
    const st = inviteState(i);
    if (!st.valid) throw new SupportError(400, `${st.reason}. Bestel zonder code of vraag een nieuwe aan.`);
    ctx.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(i!.code);
    return i!.code;
  });
  return tx.immediate();
}

export function inviteView(ctx: Ctx, i: InviteRow) {
  const by = i.created_by ? getStaff(ctx, i.created_by) : undefined;
  return {
    code: i.code, display: showCode(i.code), label: i.label, bundle: i.bundle, maxUses: i.max_uses, uses: i.uses,
    expiresAt: i.expires_at, createdAt: i.created_at, createdBy: by?.email ?? null, revokedAt: i.revoked_at,
    link: `${ctx.cfg.publicUrl}/v1/invite/${i.code}`, ...inviteState(i),
    orders: (ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE invite_code = ?").get(i.code) as { n: number }).n,
  };
}

// ───────── Berichten ─────────

export type Severity = "info" | "onderhoud" | "storing";
export const SEVERITIES: Severity[] = ["info", "onderhoud", "storing"];

export interface AnnouncementRow { id: string; title: string; body: string; severity: Severity; starts_at: number | null; ends_at: number | null; order_ids: string | null; auto: number; created_by: string | null; created_at: number; ended_at: number | null }

export function createAnnouncement(ctx: Ctx, by: StaffRow | null, body: any, auto = false): AnnouncementRow {
  const title = String(body?.title ?? "").trim().slice(0, 140);
  const text = String(body?.body ?? "").trim().slice(0, 5000);
  if (!title || !text) throw new SupportError(400, "Vul een titel en een tekst in");
  const severity = (body?.severity ?? "info") as Severity;
  if (!SEVERITIES.includes(severity)) throw new SupportError(400, "Kies het soort bericht: info, onderhoud of storing");
  const t = (v: unknown) => (v === undefined || v === null || v === "" ? null : typeof v === "number" ? v : Date.parse(String(v)));
  const startsAt = t(body?.startsAt), endsAt = t(body?.endsAt);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) throw new SupportError(400, "De begin- of eindtijd klopt niet");
  if (startsAt && endsAt && endsAt <= startsAt) throw new SupportError(400, "De eindtijd ligt vóór de begintijd");
  let orderIds: string[] | null = null;
  if (body?.audience === "orders" || Array.isArray(body?.orderIds)) {
    orderIds = [...new Set((Array.isArray(body?.orderIds) ? body.orderIds : []).map(String))] as string[];
    if (!orderIds.length) throw new SupportError(400, "Kies voor wie het bericht is");
    const unknown = orderIds.filter((id) => !getOrder(ctx.db, id));
    if (unknown.length) throw new SupportError(400, `Onbekende bestelling: ${unknown.join(", ")}`);
  }
  const id = crypto.randomBytes(8).toString("hex");
  ctx.db.prepare("INSERT INTO announcements (id, title, body, severity, starts_at, ends_at, order_ids, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, title, text, severity, startsAt, endsAt, orderIds ? JSON.stringify(orderIds) : null, auto ? 1 : 0, by?.id ?? null, Date.now());
  return ctx.db.prepare("SELECT * FROM announcements WHERE id = ?").get(id) as AnnouncementRow;
}

export function endAnnouncement(ctx: Ctx, id: string) {
  const r = ctx.db.prepare("UPDATE announcements SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(Date.now(), id);
  return r.changes > 0;
}

export const announcementActive = (a: AnnouncementRow, now = Date.now()) => !a.ended_at && (!a.starts_at || a.starts_at <= now) && (!a.ends_at || a.ends_at > now);

export function announcementView(a: AnnouncementRow, forStaff = false) {
  const now = Date.now();
  return {
    id: a.id, title: a.title, body: a.body, severity: a.severity, startsAt: a.starts_at, endsAt: a.ends_at,
    auto: !!a.auto, createdAt: a.created_at,
    ...(forStaff ? {
      orderIds: a.order_ids ? JSON.parse(a.order_ids) : null, endedAt: a.ended_at,
      state: a.ended_at || (a.ends_at && a.ends_at <= now) ? "afgelopen" : a.starts_at && a.starts_at > now ? "gepland" : "actief",
    } : {}),
  };
}

/** Actieve berichten voor een klant: voor iedereen, of voor één van zijn bestellingen. */
export function announcementsFor(ctx: Ctx, customerId: string) {
  const mine = new Set((ctx.db.prepare("SELECT id FROM orders WHERE customer_id = ?").all(customerId) as { id: string }[]).map((o) => o.id));
  const rows = ctx.db.prepare("SELECT * FROM announcements WHERE ended_at IS NULL ORDER BY created_at DESC").all() as AnnouncementRow[];
  return rows.filter((a) => announcementActive(a) && (!a.order_ids || (JSON.parse(a.order_ids) as string[]).some((id) => mine.has(id))));
}

// ───────── Hulpvragen ─────────

export interface TicketRow { id: string; customer_id: string; order_id: string | null; subject: string; status: "open" | "answered" | "closed"; created_at: number; updated_at: number }
interface MessageRow { id: number; ticket_id: string; author: "customer" | "staff"; staff_id: string | null; body: string; at: number }

export const TICKET_STATUS: Record<TicketRow["status"], string> = { open: "Wacht op antwoord", answered: "Beantwoord", closed: "Gesloten" };

const cleanText = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

export function ticketView(ctx: Ctx, t: TicketRow, forStaff = false) {
  const brand = getBrand(ctx).name;
  const msgs = ctx.db.prepare("SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id").all(t.id) as MessageRow[];
  const cust = forStaff ? getCustomer(ctx.db, t.customer_id) : undefined;
  return {
    id: t.id, subject: t.subject, status: t.status, statusLabel: TICKET_STATUS[t.status], orderId: t.order_id,
    createdAt: t.created_at, updatedAt: t.updated_at,
    ...(forStaff ? { customer: { id: t.customer_id, email: cust?.email ?? null }, domain: t.order_id ? getOrder(ctx.db, t.order_id)?.domain ?? null : null } : {}),
    messages: msgs.map((m) => {
      const s = m.staff_id ? getStaff(ctx, m.staff_id) : undefined;
      return {
        from: m.author, body: m.body, at: m.at,
        name: m.author === "customer" ? (forStaff ? cust?.email ?? "Klant" : "Jij") : forStaff ? s?.name || s?.email || "Medewerker" : s?.name ? `${s.name} (${brand})` : brand,
      };
    }),
  };
}

const staffInbox = (ctx: Ctx) => {
  const list = (ctx.db.prepare("SELECT email FROM staff WHERE role IN ('eigenaar','beheer','support')").all() as { email: string }[]).map((r) => r.email);
  if (ctx.cfg.adminEmail) list.push(ctx.cfg.adminEmail.toLowerCase());
  return [...new Set(list)];
};

async function notifyStaff(ctx: Ctx, t: TicketRow, cust: CustomerRow, text: string, isNew: boolean) {
  const subject = `${isNew ? "Nieuwe hulpvraag" : "Reactie op hulpvraag"}: ${t.subject}`;
  const body = `${cust.email} schreef${t.order_id ? ` (bestelling ${t.order_id})` : ""}:\n\n${text}\n\nBeantwoorden in het beheer: ${ctx.cfg.publicUrl}/beheer/#/hulpvraag/${t.id}`;
  for (const to of staffInbox(ctx)) await trySend(ctx.mail, to, subject, body);
}

export async function createTicket(ctx: Ctx, cust: CustomerRow, body: any) {
  const subject = cleanText(body?.subject, 140).replace(/\n/g, " ");
  const message = cleanText(body?.message, 5000);
  if (!subject || !message) throw new SupportError(400, "Vul een onderwerp en je vraag in");
  let orderId: string | null = null;
  if (body?.orderId) {
    const o = getOrder(ctx.db, String(body.orderId));
    if (!o || o.customer_id !== cust.id) throw new SupportError(404, "Deze bestelling bestaat niet");
    orderId = o.id;
  }
  const id = crypto.randomBytes(8).toString("hex");
  const now = Date.now();
  ctx.db.prepare("INSERT INTO tickets (id, customer_id, order_id, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)").run(id, cust.id, orderId, subject, now, now);
  ctx.db.prepare("INSERT INTO ticket_messages (ticket_id, author, body, at) VALUES (?, 'customer', ?, ?)").run(id, message, now);
  const t = ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow;
  await notifyStaff(ctx, t, cust, message, true);
  return t;
}

export async function customerReply(ctx: Ctx, cust: CustomerRow, t: TicketRow, body: any) {
  const message = cleanText(body?.message, 5000);
  if (!message) throw new SupportError(400, "Schrijf eerst je bericht");
  const now = Date.now();
  ctx.db.prepare("INSERT INTO ticket_messages (ticket_id, author, body, at) VALUES (?, 'customer', ?, ?)").run(t.id, message, now);
  ctx.db.prepare("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?").run(now, t.id);
  await notifyStaff(ctx, t, cust, message, false);
  return ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(t.id) as TicketRow;
}

export async function staffReply(ctx: Ctx, s: StaffRow, t: TicketRow, body: any) {
  const message = cleanText(body?.message, 5000);
  if (!message) throw new SupportError(400, "Schrijf eerst je antwoord");
  const now = Date.now();
  const close = body?.close === true;
  ctx.db.prepare("INSERT INTO ticket_messages (ticket_id, author, staff_id, body, at) VALUES (?, 'staff', ?, ?, ?)").run(t.id, s.id, message, now);
  ctx.db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(close ? "closed" : "answered", now, t.id);
  const cust = getCustomer(ctx.db, t.customer_id)!;
  const brand = getBrand(ctx).name;
  await trySend(ctx.mail, cust.email, `Antwoord op je vraag: ${t.subject}`,
    `Hallo,\n\n${s.name ? `${s.name} van ${brand}` : brand} heeft je vraag beantwoord:\n\n${message}\n\nJe kunt reageren in de Eigen Cloud-app, onder Hulp.\n\nGroet,\n${brand}`);
  return ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(t.id) as TicketRow;
}

// ───────── Gezondheid van clouds ─────────

export interface HealthRow {
  order_id: string; reported_at: number; version: string | null; healthy: number; problems: string; storage_used_bytes: number | null;
  users: number | null; nodes: string; unhealthy_since: number | null; flagged_at: number | null; flag_reason: string | null; announcement_id: string | null;
}

/** Alleen deze technische velden worden bewaard; al het andere in de melding wordt genegeerd. */
export function sanitizeHealth(b: any) {
  if (!b || typeof b !== "object") throw new SupportError(400, "Verwacht een JSON-object");
  if (typeof b.healthy !== "boolean") throw new SupportError(400, "healthy moet true of false zijn");
  const s = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max);
  const num = (v: unknown) => (v === undefined || v === null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : null);
  const problems = Array.isArray(b.problems) ? b.problems.slice(0, 20).map((p: unknown) => s(p, 200)).filter(Boolean) : [];
  const nodes = Array.isArray(b.nodes) ? b.nodes.slice(0, 20).map((n: any) => ({ id: s(n?.id, 64), region: s(n?.region, 32), status: s(n?.status, 32) })) : [];
  return { version: b.version === undefined ? null : s(b.version, 40), healthy: b.healthy as boolean, problems, storageUsedBytes: num(b.storageUsedBytes), users: num(b.users), nodes };
}

export function recordHealth(ctx: Ctx, o: OrderRow, h: ReturnType<typeof sanitizeHealth>) {
  const prev = ctx.db.prepare("SELECT * FROM health WHERE order_id = ?").get(o.id) as HealthRow | undefined;
  const now = Date.now();
  const since = h.healthy ? null : prev && !prev.healthy && prev.unhealthy_since ? prev.unhealthy_since : now;
  ctx.db.prepare(`INSERT INTO health (order_id, reported_at, version, healthy, problems, storage_used_bytes, users, nodes, unhealthy_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET reported_at = excluded.reported_at, version = excluded.version,
    healthy = excluded.healthy, problems = excluded.problems, storage_used_bytes = excluded.storage_used_bytes, users = excluded.users,
    nodes = excluded.nodes, unhealthy_since = excluded.unhealthy_since`)
    .run(o.id, now, h.version, h.healthy ? 1 : 0, JSON.stringify(h.problems), h.storageUsedBytes, h.users, JSON.stringify(h.nodes), since);
  if (prev && !!prev.healthy !== h.healthy) event(ctx.db, o.id, h.healthy ? "health-ok" : "health-problem", h.problems.slice(0, 5));
}

export function healthView(r: HealthRow | undefined) {
  if (!r) return null;
  return {
    reportedAt: r.reported_at, version: r.version, healthy: !!r.healthy, problems: JSON.parse(r.problems) as string[],
    storageUsedBytes: r.storage_used_bytes, users: r.users, nodes: JSON.parse(r.nodes) as { id: string; region: string; status: string }[],
    unhealthySince: r.unhealthy_since, flagged: !!r.flagged_at, flaggedAt: r.flagged_at, flagReason: r.flag_reason,
  };
}

/**
 * Automatische berichten: ongezond langer dan cfg.health.unhealthyMs, of (na minstens één melding) langer dan
 * cfg.health.silentMs niets gehoord terwijl de cloud klaar is → bericht aan die klant en een vlag in het beheer.
 * Weer gezond (of niet meer actief) → bericht beëindigen.
 */
export async function checkHealth(ctx: Ctx, onlyOrder?: string) {
  const now = Date.now();
  const rows = (onlyOrder
    ? ctx.db.prepare("SELECT h.*, o.status AS order_status, o.domain AS domain FROM health h JOIN orders o ON o.id = h.order_id WHERE h.order_id = ?").all(onlyOrder)
    : ctx.db.prepare("SELECT h.*, o.status AS order_status, o.domain AS domain FROM health h JOIN orders o ON o.id = h.order_id").all()) as (HealthRow & { order_status: string; domain: string })[];
  const { unhealthyMs, silentMs } = ctx.cfg.health;
  for (const r of rows) {
    const active = ["ready", "payment_problem"].includes(r.order_status);
    let reason: "unhealthy" | "silent" | null = null;
    if (active && !r.healthy && r.unhealthy_since && now - r.unhealthy_since >= unhealthyMs) reason = "unhealthy";
    else if (r.order_status === "ready" && now - r.reported_at >= silentMs) reason = "silent";
    if (reason && !r.flagged_at) {
      const a = reason === "unhealthy"
        ? createAnnouncement(ctx, null, {
          title: "Je cloud heeft een probleem", severity: "storing", orderIds: [r.order_id],
          body: `Sinds ${when(r.unhealthy_since!)} werkt je cloud (${r.domain}) niet helemaal zoals het hoort. We zijn op de hoogte en kijken ernaar. Je gegevens zijn veilig.${JSON.parse(r.problems).length ? `\n\nWat we zien: ${(JSON.parse(r.problems) as string[]).join("; ")}` : ""}`,
        }, true)
        : createAnnouncement(ctx, null, {
          title: "We horen niets van je cloud", severity: "storing", orderIds: [r.order_id],
          body: `Je cloud (${r.domain}) heeft zich sinds ${when(r.reported_at)} niet meer gemeld. Misschien staan je servers uit of is er een storing. Open de app om te kijken; we kijken ook mee.`,
        }, true);
      ctx.db.prepare("UPDATE health SET flagged_at = ?, flag_reason = ?, announcement_id = ? WHERE order_id = ?").run(now, reason, a.id, r.order_id);
      event(ctx.db, r.order_id, "health-flagged", { reason, announcement: a.id });
      await trySend(ctx.mail, ctx.cfg.adminEmail, `${reason === "unhealthy" ? "Ongezonde cloud" : "Cloud meldt zich niet"}: ${r.domain}`,
        `Bestelling ${r.order_id} (${r.domain}): ${reason === "unhealthy" ? `ongezond sinds ${when(r.unhealthy_since!)}` : `laatste melding ${when(r.reported_at)}`}. De klant ziet een automatisch bericht. Zie ${ctx.cfg.publicUrl}/beheer/#/klant/${r.order_id}`);
    } else if (!reason && r.flagged_at) {
      if (r.announcement_id) endAnnouncement(ctx, r.announcement_id);
      ctx.db.prepare("UPDATE health SET flagged_at = NULL, flag_reason = NULL, announcement_id = NULL WHERE order_id = ?").run(r.order_id);
      event(ctx.db, r.order_id, "health-unflagged", { was: r.flag_reason });
    }
  }
}

// ───────── Routes voor klanten en clouds ─────────

type HttpError = (reply: FastifyReply, status: number, error: string) => unknown;
type NeedAuth = (req: FastifyRequest, reply: FastifyReply) => CustomerRow | null;

export function registerCustomerSupport(app: FastifyInstance, ctx: Ctx, httpError: HttpError, needAuth: NeedAuth) {
  const db = ctx.db;
  const limits = { tickets: new RateLimit(10, 60 * 60_000), replies: new RateLimit(60, 60 * 60_000), health: new RateLimit(120, 60 * 60_000), invite: new RateLimit(30, 60_000) };
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof SupportError) return httpError(reply, e.status, e.message);
    throw e;
  };

  // ── Huisstijl en uitnodigingen (openbaar) ──
  app.get<{ Params: { code: string } }>("/v1/invite/:code", async (req, reply) => {
    if (!limits.invite.ok(req.ip)) return httpError(reply, 429, "Even rustig aan: probeer het over een minuut opnieuw.");
    const i = getInvite(ctx, req.params.code);
    const st = inviteState(i);
    const b = st.valid && i?.bundle ? bundleOf(ctx, i.bundle) : undefined;
    return { valid: st.valid, ...(st.valid ? { code: i!.code } : { reason: st.reason }), brand: getBrand(ctx), ...(b ? { bundle: publicBundle(b) } : {}) };
  });

  // ── Hulpvragen ──
  const ownTicket = (c: CustomerRow, id: string) => {
    const t = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
    return t && t.customer_id === c.id ? t : null;
  };
  app.get("/v1/tickets", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const rows = db.prepare("SELECT * FROM tickets WHERE customer_id = ? ORDER BY updated_at DESC").all(c.id) as TicketRow[];
    return { tickets: rows.map((t) => { const v = ticketView(ctx, t); return { ...v, messages: undefined, lastMessage: v.messages[v.messages.length - 1] ?? null }; }) };
  });
  app.post<{ Body: any }>("/v1/tickets", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    if (!limits.tickets.ok(c.id)) return httpError(reply, 429, "Je hebt net al een paar vragen gesteld. Probeer het later opnieuw.");
    try { return ticketView(ctx, await createTicket(ctx, c, req.body)); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string } }>("/v1/tickets/:id", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const t = ownTicket(c, req.params.id);
    if (!t) return httpError(reply, 404, "Deze hulpvraag bestaat niet");
    return ticketView(ctx, t);
  });
  app.post<{ Params: { id: string }; Body: any }>("/v1/tickets/:id/messages", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const t = ownTicket(c, req.params.id);
    if (!t) return httpError(reply, 404, "Deze hulpvraag bestaat niet");
    if (!limits.replies.ok(c.id)) return httpError(reply, 429, "Even rustig aan: probeer het zo opnieuw.");
    try { return ticketView(ctx, await customerReply(ctx, c, t, req.body)); } catch (e) { return fail(reply, e); }
  });

  // ── Berichten ──
  app.get("/v1/announcements", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    return { announcements: announcementsFor(ctx, c.id).map((a) => announcementView(a)) };
  });

  // ── Gezondheid: de cloud meldt zich met zijn DNS-token (zoals bij de DNS-proxy) ──
  app.post<{ Params: { id: string }; Body: any }>("/v1/orders/:id/health", async (req, reply) => {
    const m = /^Token ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "");
    const o = m ? (db.prepare("SELECT * FROM orders WHERE dns_token_hash = ?").get(sha256(m[1].toLowerCase())) as OrderRow | undefined) : undefined;
    if (!o || o.id !== req.params.id || o.status === "suspended") return httpError(reply, 403, "Geen geldige toegang");
    if (!limits.health.ok(o.id)) return httpError(reply, 429, "Te veel meldingen; eens per minuut is genoeg");
    let h;
    try { h = sanitizeHealth(req.body); } catch (e) { return fail(reply, e); }
    recordHealth(ctx, o, h);
    await checkHealth(ctx, o.id);
    return { ok: true, next: 300 };
  });
}
