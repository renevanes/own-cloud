/**
 * Beheer-API voor medewerkers van de aanbieder (/v1/admin/…), met rechtencontrole per rol en een logboek van
 * elke handeling. Plus de openbare huisstijl (/v1/brand). Zie BROKER.md voor het overzicht.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type OrderRow, type PaymentRow, getOrder, getCustomer, orderState, event, setStatus } from "./db.js";
import { type Ctx, bundleOf, getSteps, todayNl } from "./context.js";
import type { Bundle } from "./config.js";
import { ApiError } from "./apis.js";
import { UserError, billingView, outstandingOf, unsettled } from "./billing.js";
import { suspendOrder, resumeOrder, cancelOrder, retryOrder, cleanupOrder, projectServers, releaseAdres } from "./ops.js";
import { isCentral } from "./provision.js";
import { runGuard } from "./guard.js";
import { type LijstRegel, fetchLijst } from "./adres.js";
import { DEFAULT_LIST_URL } from "./config.js";
import { type InvoiceRow, readInvoice, renderInvoiceHtml, toCents, fromCents, vatSplit } from "./invoice.js";
import { readKit } from "./provision.js";
import { getBrand, updateBrand, saveLogo, getLogo, putBundle, deleteBundle, publicBundle, saveCosts, LOGO_MAX, hostedDoc, ownLinks } from "./brand.js";
import { placementOptions, placementSizes, checkPlacement, checkStorage, fillCosts } from "./placement.js";
import { registerJuridisch } from "./juridisch.js";
import { operationsOverview } from "./operations.js";
import {
  type Perm, type Role, type StaffRow, ROLES, ROLE_LABELS, PERMISSIONS, can, StaffError, staffFromRequest, staffView, audit,
  addStaff, setRole, removeStaff, resetSecondFactor, getStaff, mailInvite,
} from "./staff.js";
import {
  SupportError, type InviteRow, type AnnouncementRow, type TicketRow, type HealthRow, createInvite, inviteView, normCode,
  createAnnouncement, endAnnouncement, announcementView, ticketView, staffReply, healthView, TICKET_STATUS,
} from "./support.js";

type HttpError = (reply: FastifyReply, status: number, error: string) => unknown;

export const STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "Wacht op betaling", paid: "Betaald", provisioning: "Wordt klaargezet", ready: "Klaar",
  failed: "Mislukt", payment_problem: "Betalingsprobleem", cancelled: "Opgezegd", suspended: "Opgeschort",
};

// ───────── Kosten ─────────

/** Geschatte maandkosten bij Scaleway (excl. btw) volgens de servers en opslag van de bundel. */
export function estimateCost(ctx: Ctx, b: Bundle | undefined) {
  if (!b) return null;
  const table = ctx.cfg.costs;
  const counts = new Map<string, number>();
  for (const p of b.placement) counts.set(p.size, (counts.get(p.size) ?? 0) + 1);
  const lines = [...counts].map(([size, count]) => {
    const each = table.servers[size];
    return { size, count, each: each ?? null, monthly: each ? fromCents(toCents(each) * count) : null };
  });
  const storageCents = Math.round(b.includes.storageGb * Number(table.storageGbMonthly) * 100 * b.storage.length);
  const total = lines.reduce((n, l) => n + (l.monthly ? toCents(l.monthly) : 0), 0) + storageCents;
  return { lines, storage: { gb: b.includes.storageGb, copies: b.storage.length, monthly: fromCents(storageCents) }, total: fromCents(total), unknownSizes: lines.filter((l) => !l.each).map((l) => l.size) };
}

function priceAndMargin(ctx: Ctx, amount: string, b: Bundle | undefined) {
  const cost = estimateCost(ctx, b);
  const incl = toCents(amount);
  const { excl, vat } = vatSplit(incl, ctx.cfg.vatPercent);
  return {
    price: { incl: fromCents(incl), excl: fromCents(excl), vat: fromCents(vat) },
    cost,
    margin: cost ? fromCents(excl - toCents(cost.total)) : null,
  };
}

// ───────── Weergaven ─────────

const healthOf = (ctx: Ctx, id: string) => ctx.db.prepare("SELECT * FROM health WHERE order_id = ?").get(id) as HealthRow | undefined;

function orderListView(ctx: Ctx, o: OrderRow & { email?: string }) {
  const b = bundleOf(ctx, o.bundle);
  const h = healthOf(ctx, o.id);
  return {
    id: o.id, customer: { id: o.customer_id, email: o.email ?? getCustomer(ctx.db, o.customer_id)?.email ?? null },
    domain: o.domain, domainMode: o.domain_mode, bundle: o.bundle, bundleTitle: b?.title ?? o.bundle,
    status: o.status, statusLabel: STATUS_LABELS[o.status] ?? o.status, amount: o.amount, extraUsers: o.extra_users,
    users: (b?.includes.users ?? 1) + o.extra_users,
    createdAt: o.created_at, paidAt: o.paid_at, endsAt: o.ends_at, inviteCode: o.invite_code,
    health: h ? { healthy: !!h.healthy, flagged: !!h.flagged_at, reportedAt: h.reported_at, version: h.version } : null,
    openTickets: (ctx.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE order_id = ? AND status = 'open'").get(o.id) as { n: number }).n,
  };
}

function actionsFor(o: OrderRow) {
  return {
    suspend: ["ready", "payment_problem", "provisioning"].includes(o.status),
    resume: o.status === "suspended",
    cancel: o.status !== "cancelled",
    retry: ["failed", "provisioning"].includes(o.status),
    cleanup: o.status === "cancelled" && !orderState(o).cleanedAt,
    /** Gratis adres van de adressendienst teruggeven (alleen na opzeggen, als het nog van ons is). */
    adres: o.status === "cancelled" && isCentral(o) && !orderState(o).adresReleasedAt,
    /** Achterstand buiten de dienst om betaald: met de hand afboeken. */
    afboeken: o.status === "payment_problem",
  };
}

const monthOf = (ms: number) => todayNl(new Date(ms)).slice(0, 7);

/** Omzet per maand (NL-tijd): betaalde betalingen incl./excl./btw, min terugbetalingen. Nieuwste maand eerst. */
export function revenueMonths(ctx: Ctx, months: number) {
  const db = ctx.db;
  const map = new Map<string, { incl: number; excl: number; vat: number; refunded: number; count: number }>();
  const get = (m: string) => { let x = map.get(m); if (!x) { x = { incl: 0, excl: 0, vat: 0, refunded: 0, count: 0 }; map.set(m, x); } return x; };
  const pays = db.prepare("SELECT amount, paid_at, updated_at FROM payments WHERE status = 'paid' AND COALESCE(kind, 'first') IN ('first','recurring','settle')").all() as { amount: string | null; paid_at: number | null; updated_at: number }[];
  for (const p of pays) {
    const cents = toCents(p.amount ?? "0");
    const { excl, vat } = vatSplit(cents, ctx.cfg.vatPercent);
    const m = get(monthOf(p.paid_at ?? p.updated_at));
    m.incl += cents; m.excl += excl; m.vat += vat; m.count++;
  }
  for (const r of db.prepare("SELECT amount, created_at FROM refunds").all() as { amount: string; created_at: number }[]) get(monthOf(r.created_at)).refunded += toCents(r.amount);
  return [...map].sort((a, b) => b[0].localeCompare(a[0])).slice(0, months)
    .map(([month, x]) => ({ month, incl: fromCents(x.incl), excl: fromCents(x.excl), vat: fromCents(x.vat), refunded: fromCents(x.refunded), net: fromCents(x.incl - x.refunded), count: x.count }));
}

/**
 * Kerncijfers voor de console van de aanbieder ("Je dienst" → Overzicht), via GET /v1/status/overzicht met het
 * beheertoken: alleen aantallen en bedragen, geen namen of adressen van klanten.
 */
export function dienstOverzicht(ctx: Ctx) {
  const n = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
  const month = todayNl().slice(0, 7);
  const m = revenueMonths(ctx, 1).find((r) => r.month === month);
  return {
    klanten: n("SELECT COUNT(*) AS n FROM customers"),
    actief: n("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','provisioning','ready','payment_problem')"),
    achterstanden: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'payment_problem'"),
    openHulpvragen: n("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'"),
    omzetMaand: { month, net: m?.net ?? "0.00", count: m?.count ?? 0 },
    bundels: ctx.cfg.bundles.length,
  };
}

/**
 * De regel van deze Dienst voor de openbare lijst van aanbieders (aanbieders.json), met zijn sleutel. Bestaat de lijst al,
 * dan neemt de regel land, omschrijving en (voor de beheerders) "standaard" daaruit over, en komt de hele nieuwe lijst mee
 * om in één keer op GitHub te plakken. Plus de links naar voorwaarden en privacy (de beheerders kijken daarnaar).
 * Voor het beheer (GET /v1/admin/lijst) en de console die deze Dienst opzette (GET /v1/status/lijst, beheertoken), die
 * er met GitHub een voorstel van maakt (src/console/github.ts).
 */
export async function lijstView(ctx: Ctx) {
  const b = getBrand(ctx);
  const norm = (u: unknown) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();
  let lijst: LijstRegel[] | null = null;
  try { lijst = await fetchLijst(process.env.EIGEN_AANBIEDERS_URL || ctx.cfg.listUrl || DEFAULT_LIST_URL); } catch { /* lijst niet bereikbaar */ }
  const cur = lijst?.find((a) => norm(a.url) === norm(ctx.cfg.publicUrl)) ?? null;
  const adressen = ctx.cfg.adressenPubliek ?? (typeof cur?.adressen === "string" ? cur.adressen : null);
  const entry: LijstRegel = {
    naam: b.name, url: ctx.cfg.publicUrl, land: typeof cur?.land === "string" ? cur.land : "NL", contact: b.contact.email ?? (typeof cur?.contact === "string" ? cur.contact : ""),
    omschrijving: typeof cur?.omschrijving === "string" ? cur.omschrijving : "", sleutel: ctx.cfg.providerPublicKey,
    ...(cur?.standaard === true ? { standaard: true } : {}), ...(adressen ? { adressen } : {}),
  };
  const nieuweLijst = lijst ? (cur ? lijst.map((a) => (a === cur ? entry : a)) : [...lijst, entry]) : null;
  const same = !!cur && JSON.stringify(cur) === JSON.stringify(entry);
  return {
    entry, opLijst: !!cur, actueel: same, sleutelKlopt: !!cur && cur.sleutel === ctx.cfg.providerPublicKey,
    nieuweLijst: nieuweLijst ? `${JSON.stringify(nieuweLijst, null, 2)}\n` : null,
    adressendienst: ctx.cfg.adressenPubliek, adresUrl: ctx.cfg.adresUrl,
    voorwaarden: { termsUrl: b.termsUrl, privacyUrl: b.privacyUrl },
    editUrl: "https://github.com/renevanes/own-cloud/edit/main/aanbieders.json",
  };
}

// ───────── Routes ─────────

export function registerAdmin(app: FastifyInstance, ctx: Ctx, httpError: HttpError) {
  const db = ctx.db;

  /** Handler met inlogcontrole, rechtencontrole en nette foutmeldingen. */
  const admin = <R extends { Params?: any; Body?: any; Querystring?: any }>(perm: Perm, fn: (s: StaffRow, req: FastifyRequest<R>, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest<R>, reply: FastifyReply) => {
      const s = staffFromRequest(ctx, req);
      if (!s) return httpError(reply, 401, "Log eerst in");
      if (!can(s.role, perm)) return httpError(reply, 403, `Dit kan niet met jouw rol (${ROLE_LABELS[s.role]})`);
      try {
        return await fn(s, req, reply);
      } catch (e) {
        if (e instanceof UserError || e instanceof StaffError || e instanceof SupportError) return httpError(reply, e.status, e.message);
        if (e instanceof ApiError) return httpError(reply, 502, `${e.service} gaf een fout: ${e.message}`);
        console.error(`[dienst] beheer ${req.method} ${req.url}: ${(e as Error).message}`);
        return httpError(reply, 500, "Er ging iets mis aan onze kant. Probeer het later opnieuw.");
      }
    };
  /** Fouten bij het controleren van invoer (gewone Error) → 400. */
  const input = <T>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof Error && !(e instanceof ApiError)) throw new UserError(400, e.message); throw e; } };
  const needOrder = (id: string) => { const o = getOrder(db, id); if (!o) throw new UserError(404, "Deze bestelling bestaat niet"); return o; };

  // ── Openbaar: huisstijl ──
  app.get("/v1/brand", async () => getBrand(ctx));
  app.get("/v1/brand/logo", async (_req, reply) => {
    const l = getLogo(db);
    if (!l) return httpError(reply, 404, "Geen logo");
    return reply.type(l.type).header("cache-control", "public, max-age=3600").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox").send(l.data);
  });

  // ── Overzicht ──
  // Aanmelden voor de openbare lijst van aanbieders (zie lijstView); de console doet hetzelfde via /v1/status/lijst.
  app.get("/v1/admin/lijst", admin("brand", async () => lijstView(ctx)));
  // Voorwaarden, privacyverklaring en verwerkersovereenkomst (openbaar en in het beheer), zie juridisch.ts.
  registerJuridisch(app, ctx, admin);

  // ── Adressendienst op deze server (alleen als de console hem hier opzette; zie ADRESSEN.md) ──
  const adresBeheer = () => {
    if (!ctx.cfg.adressenPubliek || !ctx.apis.adres) throw new UserError(404, "Op deze server draait geen adressendienst");
    return ctx.apis.adres;
  };
  const adresCall = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw new UserError(e.status === 404 ? 404 : 409, e.message);
      throw e;
    }
  };
  app.get("/v1/admin/adressendienst", admin("adressen", async () => {
    const a = adresBeheer();
    const [status, namen, aanbieders] = await Promise.all([adresCall(() => a.beheerStatus()), adresCall(() => a.beheerNamen()), adresCall(() => a.beheerAanbieders()).catch((e) => ({ error: (e as Error).message }))]);
    return { publicUrl: ctx.cfg.adressenPubliek, status, namen: namen.namen, aanbieders };
  }));
  app.get<{ Querystring: { naam?: string } }>("/v1/admin/adressendienst/logboek", admin("adressen", async (_s, req) => adresCall(() => adresBeheer().beheerLogboek(req.query.naam || undefined))));
  app.post<{ Params: { naam: string }; Body: { sure?: boolean } }>("/v1/admin/adressendienst/namen/:naam/vrijgeven", admin("adressen", async (s, req) => {
    const a = adresBeheer();
    if (req.body?.sure !== true) throw new UserError(400, "Bevestig dat je deze naam wilt vrijgeven");
    const r = await adresCall(() => a.beheerVrijgeven(req.params.naam));
    audit(ctx, s, "adres-vrijgeven", r.naam, { vrijVanaf: r.vrijVanaf });
    return r;
  }));

  app.get("/v1/admin/overview", admin("announcements.read", async (s) => {
    const out: Record<string, unknown> = { staff: staffView(ctx, s), permissions: PERMISSIONS[s.role] };
    if (can(s.role, "customers.read")) {
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all() as { status: string; n: number }[];
      out.orders = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      out.statusLabels = STATUS_LABELS;
      out.customers = (db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n;
    }
    if (can(s.role, "money")) {
      const month = todayNl().slice(0, 7);
      out.revenueThisMonth = revenue(1).find((r) => r.month === month) ?? { month, incl: "0.00", excl: "0.00", vat: "0.00", refunded: "0.00", net: "0.00", count: 0 };
      out.arrears = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'payment_problem'").get() as { n: number }).n;
    }
    if (can(s.role, "tickets")) out.openTickets = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'").get() as { n: number }).n;
    if (can(s.role, "health")) {
      out.unhealthy = (db.prepare("SELECT h.*, o.domain FROM health h JOIN orders o ON o.id = h.order_id WHERE h.flagged_at IS NOT NULL OR (h.healthy = 0 AND o.status IN ('ready','payment_problem')) ORDER BY h.reported_at").all() as (HealthRow & { domain: string })[])
        .map((h) => ({ orderId: h.order_id, domain: h.domain, ...healthView(h) }));
    }
    out.operations = operationsOverview(ctx, s.role, (o) => priceAndMargin(ctx, o.amount, bundleOf(ctx, o.bundle)));
    return out;
  }));

  // ── Klanten en bestellingen ──
  app.get<{ Querystring: { q?: string; status?: string; health?: string; limit?: string; offset?: string } }>("/v1/admin/customers", admin("customers.read", async (_s, req) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (q) { where.push("(c.email LIKE ? OR o.domain LIKE ? OR o.id LIKE ? OR o.invite_code = ?)"); args.push(`%${q}%`, `%${q}%`, `${q}%`, normCode(q)); }
    if (req.query.status) {
      const list = String(req.query.status).split(",").filter((x) => x in STATUS_LABELS);
      if (list.length) { where.push(`o.status IN (${list.map(() => "?").join(",")})`); args.push(...list); }
    }
    if (req.query.health === "problem") where.push("o.id IN (SELECT order_id FROM health WHERE flagged_at IS NOT NULL OR healthy = 0)");
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sql = `SELECT o.*, c.email FROM orders o JOIN customers c ON c.id = o.customer_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.created_at DESC`;
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args) as { n: number }).n;
    const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...args, limit, offset) as (OrderRow & { email: string })[];
    return { total, orders: rows.map((o) => orderListView(ctx, o)), statusLabels: STATUS_LABELS };
  }));

  app.get<{ Params: { id: string } }>("/v1/admin/orders/:id", admin("customers.read", async (s, req) => {
    const o = needOrder(req.params.id);
    const st = orderState(o);
    const b = bundleOf(ctx, o.bundle);
    let billing: unknown = null;
    if (can(s.role, "money") || can(s.role, "customers.act")) {
      try { billing = await billingView(ctx, o); } catch (e) { billing = { error: (e as Error).message }; }
    }
    const kit = o.kit_enc ? readKit(ctx, o) : null;
    const events = db.prepare("SELECT kind, detail, at FROM events WHERE order_id = ? ORDER BY id DESC LIMIT 100").all(o.id) as { kind: string; detail: string | null; at: number }[];
    const tickets = (db.prepare("SELECT * FROM tickets WHERE order_id = ? OR customer_id = ? ORDER BY updated_at DESC").all(o.id, o.customer_id) as TicketRow[])
      .map((t) => ({ id: t.id, subject: t.subject, status: t.status, statusLabel: TICKET_STATUS[t.status], updatedAt: t.updated_at }));
    const others = (db.prepare("SELECT o.*, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.customer_id = ? AND o.id <> ? ORDER BY o.created_at DESC").all(o.customer_id, o.id) as (OrderRow & { email: string })[]).map((x) => orderListView(ctx, x));
    return {
      order: { ...orderListView(ctx, o), error: o.error, subscriptionStart: o.subscription_start, cancelledAt: o.cancelled_at },
      steps: getSteps(db, o.id),
      events: events.map((e) => ({ kind: e.kind, detail: e.detail, at: e.at })),
      technical: {
        projectId: st.projectId ?? null, applicationId: st.applicationId ?? null, apiKey: st.apiKeyAccess ?? null, mailDomain: st.temDomainId ?? null,
        openproviderDomain: st.opDomainId ?? null, mollieSubscription: o.mollie_subscription_id, kitReady: !!kit, kitUsers: kit?.users ?? null,
        placement: b?.placement ?? [], cleanedAt: st.cleanedAt ?? null,
      },
      health: healthView(healthOf(ctx, o.id)),
      billing,
      ...(can(s.role, "costs") ? { costs: priceAndMargin(ctx, o.amount, b) } : {}),
      tickets: can(s.role, "tickets") ? tickets : undefined,
      otherOrders: others,
      actions: can(s.role, "customers.act") ? actionsFor(o) : null,
    };
  }));

  const orderAction = (name: string, run: (o: OrderRow, body: any) => Promise<unknown>) =>
    admin<{ Params: { id: string }; Body: any }>("customers.act", async (s, req) => {
      const o = needOrder(req.params.id);
      let result: unknown;
      try { result = await run(o, req.body ?? {}); }
      catch (e) { if (e instanceof Error && !(e instanceof ApiError) && !(e instanceof UserError)) throw new UserError(409, e.message); throw e; }
      const body = (req.body ?? {}) as any;
      audit(ctx, s, `order-${name}`, o.id, { domain: o.domain, ...(body.sure !== undefined ? { sure: !!body.sure } : {}) });
      event(db, o.id, `staff-${name}`, { by: s.email });
      return { ok: true, result, order: orderListView(ctx, getOrder(db, o.id)!) };
    });
  app.post("/v1/admin/orders/:id/suspend", orderAction("suspend", (o) => {
    if (!actionsFor(o).suspend) throw new UserError(409, `Opschorten kan niet bij status '${STATUS_LABELS[o.status]}'`);
    return suspendOrder(ctx, o.id);
  }));
  app.post("/v1/admin/orders/:id/resume", orderAction("resume", (o) => resumeOrder(ctx, o.id)));
  app.post("/v1/admin/orders/:id/cancel", orderAction("cancel", (o) => {
    if (o.status === "cancelled") throw new UserError(409, "Deze bestelling is al opgezegd");
    return cancelOrder(ctx, o.id);
  }));
  app.post("/v1/admin/orders/:id/retry", orderAction("retry", (o) => retryOrder(ctx, o.id)));
  app.post("/v1/admin/orders/:id/cleanup", orderAction("cleanup", (o, body) => cleanupOrder(ctx, o.id, body.sure === true)));
  app.post("/v1/admin/orders/:id/adres-vrijgeven", orderAction("adres", (o, body) => releaseAdres(ctx, o.id, body.sure === true)));
  // Een achterstand die buiten de dienst om is betaald (bijv. per bankoverschrijving): mislukte incasso's afboeken.
  app.post<{ Params: { id: string }; Body: { note?: string } }>("/v1/admin/orders/:id/afboeken", admin("money", async (s, req) => {
    const o = needOrder(req.params.id);
    const rows = unsettled(ctx, o.id);
    if (!rows.length) throw new UserError(409, "Er staat niets open");
    const note = String(req.body?.note ?? "").trim().slice(0, 200);
    const by = `hand:${s.email}`;
    for (const r of rows) db.prepare("UPDATE payments SET settled_by = ? WHERE id = ? AND settled_by IS NULL").run(by, r.id);
    if (o.status === "payment_problem") setStatus(db, o.id, o.kit_enc ? "ready" : "provisioning");
    event(db, o.id, "settled-by-hand", { by: s.email, payments: rows.map((r) => r.id), ...(note ? { note } : {}) });
    audit(ctx, s, "order-afboeken", o.id, { domain: o.domain, payments: rows.length, ...(note ? { note } : {}) });
    return { ok: true, settled: rows.length, order: orderListView(ctx, getOrder(db, o.id)!) };
  }));
  // De bewaker nu laten kijken (anders elk uur vanzelf).
  app.post("/v1/admin/bewaker", admin("customers.act", async (s) => {
    const findings = await runGuard(ctx);
    audit(ctx, s, "bewaker", null, { findings: findings.length });
    return { findings, enforce: ctx.cfg.enforce };
  }));

  app.get<{ Params: { id: string } }>("/v1/admin/orders/:id/servers", admin("costs", async (_s, req) => {
    const o = needOrder(req.params.id);
    const st = orderState(o);
    const b = bundleOf(ctx, o.bundle);
    const servers = st.projectId ? await projectServers(ctx, o) : [];
    const running = servers.filter((x) => x.state === "running" || x.state === "starting");
    const actualCents = running.reduce((n, x) => n + (x.type && ctx.cfg.costs.servers[x.type] ? toCents(ctx.cfg.costs.servers[x.type]) : 0), 0);
    return {
      projectId: st.projectId ?? null, servers,
      allowed: b ? b.includes.dataServers + b.includes.witnesses + 1 : null,
      running: running.length,
      runningCost: running.some((x) => x.type) ? fromCents(actualCents) : null,
      ...priceAndMargin(ctx, o.amount, b),
    };
  }));

  app.get("/v1/admin/costs", admin("costs", async () => {
    const rows = db.prepare("SELECT o.*, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status IN ('ready','payment_problem','provisioning','paid','suspended') ORDER BY o.created_at DESC").all() as (OrderRow & { email: string })[];
    let price = 0, cost = 0;
    const list = rows.map((o) => {
      const pm = priceAndMargin(ctx, o.amount, bundleOf(ctx, o.bundle));
      price += toCents(pm.price.excl); cost += pm.cost ? toCents(pm.cost.total) : 0;
      return { id: o.id, domain: o.domain, email: o.email, bundle: o.bundle, status: o.status, ...pm };
    });
    return { orders: list, totals: { priceExcl: fromCents(price), cost: fromCents(cost), margin: fromCents(price - cost) }, table: ctx.cfg.costs };
  }));

  // ── Geld ──
  const refundedCents = (paymentId: string) => (db.prepare("SELECT COALESCE(SUM(CAST(ROUND(CAST(amount AS REAL) * 100) AS INTEGER)), 0) AS c FROM refunds WHERE payment_id = ?").get(paymentId) as { c: number }).c;

  app.get<{ Querystring: { status?: string; orderId?: string; limit?: string; offset?: string } }>("/v1/admin/payments", admin("money", async (_s, req) => {
    const where: string[] = ["COALESCE(p.kind, 'first') IN ('first','recurring','settle')"];
    const args: unknown[] = [];
    if (req.query.status) { where.push("p.status = ?"); args.push(String(req.query.status)); }
    if (req.query.orderId) { where.push("p.order_id = ?"); args.push(String(req.query.orderId)); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = db.prepare(`SELECT p.*, o.domain, c.email, i.id AS invoice_id, i.number AS invoice_number FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id
      LEFT JOIN invoices i ON i.payment_id = p.id WHERE ${where.join(" AND ")} ORDER BY COALESCE(p.paid_at, p.created_at, p.updated_at) DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as (PaymentRow & { domain: string; email: string; invoice_id: string | null; invoice_number: string | null })[];
    return {
      payments: rows.map((p) => ({
        id: p.id, orderId: p.order_id, domain: p.domain, email: p.email, status: p.status, kind: p.kind, method: p.method,
        amount: p.amount, description: p.description, createdAt: p.created_at, paidAt: p.paid_at, settledBy: p.settled_by,
        invoice: p.invoice_id ? { id: p.invoice_id, number: p.invoice_number } : null,
        refunded: fromCents(refundedCents(p.id)),
        refundable: p.status === "paid" ? fromCents(Math.max(0, toCents(p.amount ?? "0") - refundedCents(p.id))) : "0.00",
      })),
    };
  }));

  app.get<{ Querystring: { orderId?: string } }>("/v1/admin/invoices", admin("money", async (_s, req) => {
    const rows = (req.query.orderId
      ? db.prepare("SELECT i.*, o.domain, c.email FROM invoices i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = i.customer_id WHERE i.order_id = ? ORDER BY i.year DESC, i.seq DESC").all(String(req.query.orderId))
      : db.prepare("SELECT i.*, o.domain, c.email FROM invoices i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = i.customer_id ORDER BY i.year DESC, i.seq DESC LIMIT 1000").all()) as (InvoiceRow & { domain: string; email: string })[];
    return { invoices: rows.map((r) => ({ id: r.id, number: r.number, date: r.date, amount: r.amount, orderId: r.order_id, paymentId: r.payment_id, domain: r.domain, email: r.email })) };
  }));

  app.get<{ Params: { id: string } }>("/v1/admin/invoices/:id", admin("money", async (_s, req, reply) => {
    const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) as InvoiceRow | undefined;
    if (!row) throw new UserError(404, "Deze factuur bestaat niet");
    return reply.type("text/html; charset=utf-8").header("cache-control", "private, no-store").send(renderInvoiceHtml(readInvoice(ctx, row)));
  }));

  app.get("/v1/admin/arrears", admin("money", async () => {
    const rows = db.prepare("SELECT o.*, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'payment_problem' ORDER BY o.created_at").all() as (OrderRow & { email: string })[];
    return {
      orders: rows.map((o) => {
        const out = outstandingOf(ctx, o);
        const failed = unsettled(ctx, o.id);
        return {
          id: o.id, domain: o.domain, email: o.email, status: o.status, outstanding: out ? fromCents(out.cents) : "0.00",
          since: failed[0]?.created_at ?? null, failedPayments: failed.map((p) => ({ id: p.id, amount: p.amount, status: p.status, createdAt: p.created_at })),
        };
      }),
    };
  }));

  app.post<{ Params: { id: string }; Body: { amount?: string; description?: string } }>("/v1/admin/payments/:id/refund", admin("refund", async (s, req) => {
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(req.params.id) as PaymentRow | undefined;
    if (!p) throw new UserError(404, "Deze betaling bestaat niet");
    if (p.status !== "paid") throw new UserError(409, "Alleen een betaalde betaling kan worden terugbetaald");
    const left = toCents(p.amount ?? "0") - refundedCents(p.id);
    if (left <= 0) throw new UserError(409, "Deze betaling is al helemaal terugbetaald");
    const amount = req.body?.amount === undefined || req.body?.amount === null || req.body?.amount === "" ? fromCents(left) : String(req.body.amount).replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || toCents(amount) <= 0) throw new UserError(400, "Vul een bedrag in, bijvoorbeeld 24.95");
    if (toCents(amount) > left) throw new UserError(409, `Er kan hooguit ${fromCents(left)} worden terugbetaald`);
    const description = String(req.body?.description ?? "").trim().slice(0, 140) || `Terugbetaling ${p.description ?? p.id}`.slice(0, 140);
    const value = fromCents(toCents(amount));
    const r = await ctx.apis.mollie.createRefund(p.id, { amount: { currency: "EUR", value }, description });
    const id = String(r?.id ?? `re_local_${crypto.randomBytes(4).toString("hex")}`);
    db.prepare("INSERT INTO refunds (id, payment_id, order_id, amount, status, description, staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, p.id, p.order_id, value, r?.status ?? null, description, s.id, Date.now());
    audit(ctx, s, "refund", p.id, { orderId: p.order_id, amount: value, refund: id });
    event(db, p.order_id, "refund", { payment: p.id, amount: value, refund: id, by: s.email });
    return { ok: true, refund: { id, amount: value, status: r?.status ?? null } };
  }));

  const revenue = (months: number) => revenueMonths(ctx, months);
  app.get<{ Querystring: { months?: string } }>("/v1/admin/revenue", admin("money", async (_s, req) => ({
    vatPercent: ctx.cfg.vatPercent, months: revenue(Math.min(Math.max(Number(req.query.months) || 12, 1), 120)),
  })));

  // ── Aanbod ──
  app.get("/v1/admin/bundles", admin("offering", async () => ({
    bundles: ctx.cfg.bundles.map((b) => ({ ...b, ...priceAndMargin(ctx, b.monthly.value, b), orders: (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE bundle = ? AND status NOT IN ('cancelled','failed','awaiting_payment')").get(b.id) as { n: number }).n })),
    costs: ctx.cfg.costs, vatPercent: ctx.cfg.vatPercent,
  })));
  // Waar de servers van een bundel komen: regio's van Scaleway (uit de registry) met de formaten en live prijzen.
  app.get("/v1/admin/placement", admin("offering", async () => placementOptions(ctx)));
  app.put<{ Params: { id: string }; Body: any }>("/v1/admin/bundles/:id", admin("offering", async (s, req) => {
    const before = bundleOf(ctx, req.params.id);
    const body = (req.body ?? {}) as any;
    const raw: any = { ...(before ?? {}), ...body, id: req.params.id, includes: { ...(before?.includes ?? {}), ...(body.includes ?? {}) } };
    if (body.placement !== undefined) {
      // Nieuwe plek van de servers: controleren (regio's, formaten, genoeg geheugen), aantallen in "includes" mee.
      const sizes = await placementSizes(ctx).catch(() => null);
      raw.placement = input(() => checkPlacement(body.placement, sizes));
      raw.includes = { ...raw.includes, dataServers: raw.placement.filter((p: any) => p.kind === "data").length, witnesses: raw.placement.filter((p: any) => p.kind === "witness").length };
      if (sizes) fillCosts(ctx, raw.placement, sizes);
    }
    if (body.storage !== undefined) raw.storage = input(() => checkStorage(body.storage));
    if (!body.placement && before) raw.placement = before.placement;
    if (!body.storage && before) raw.storage = before.storage;
    if (body.extraUserMonthly === null || body.extraUserMonthly === "") raw.extraUserMonthly = null;
    const b = input(() => putBundle(ctx, raw));
    audit(ctx, s, before ? "bundle-change" : "bundle-add", b.id, { monthly: b.monthly.value, ...(before && before.monthly.value !== b.monthly.value ? { was: before.monthly.value } : {}), users: b.includes.users, extraUserMonthly: b.extraUserMonthly?.value ?? null });
    return { bundle: publicBundle(b) };
  }));
  app.delete<{ Params: { id: string } }>("/v1/admin/bundles/:id", admin("offering", async (s, req) => {
    input(() => deleteBundle(ctx, req.params.id));
    audit(ctx, s, "bundle-delete", req.params.id);
    return { ok: true };
  }));

  // ── Huisstijl ──
  // Geschatte kosten per serverformaat en per GB opslag (voor de marge); gaan voor bundles.json.
  app.put<{ Body: any }>("/v1/admin/costs", admin("offering", async (s, req) => {
    const c = input(() => saveCosts(ctx, req.body ?? {}));
    audit(ctx, s, "costs-change", null, c);
    return { costs: c };
  }));

  // brand = wat klanten zien; own = de eigen links uit Huisstijl (leeg = de standaard of de pagina's van de Dienst zelf).
  app.get("/v1/admin/brand", admin("brand", async () => ({
    brand: getBrand(ctx), own: ownLinks(ctx),
    defaults: { name: ctx.cfg.brandName, termsUrl: ctx.cfg.termsUrl ?? hostedDoc(ctx, "voorwaarden"), privacyUrl: ctx.cfg.privacyUrl ?? hostedDoc(ctx, "privacy") },
  })));
  app.put<{ Body: any }>("/v1/admin/brand", admin("brand", async (s, req) => {
    const brand = input(() => updateBrand(ctx, req.body ?? {}));
    audit(ctx, s, "brand-change", null, req.body);
    return { brand };
  }));
  app.put<{ Body: { type?: string; data?: string; dataUrl?: string } }>("/v1/admin/brand/logo", admin("brand", async (s, req) => {
    let type = String(req.body?.type ?? ""), b64 = String(req.body?.data ?? "");
    const m = /^data:([a-z+/]+);base64,(.*)$/s.exec(String(req.body?.dataUrl ?? ""));
    if (m) { type = m[1]; b64 = m[2]; }
    if (b64.length > Math.ceil(LOGO_MAX / 3) * 4 + 8) throw new UserError(400, "Het logo is te groot (hooguit 200 KB)");
    input(() => saveLogo(db, type, Buffer.from(b64, "base64")));
    audit(ctx, s, "brand-logo", null, { type });
    return { brand: getBrand(ctx) };
  }));
  app.delete("/v1/admin/brand/logo", admin("brand", async (s) => {
    db.prepare("DELETE FROM files WHERE key = 'logo'").run();
    audit(ctx, s, "brand-logo-delete");
    return { brand: getBrand(ctx) };
  }));

  // ── Uitnodigingscodes ──
  app.get("/v1/admin/invites", admin("invites", async () => ({
    invites: (db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as InviteRow[]).map((i) => inviteView(ctx, i)),
  })));
  app.post<{ Body: any }>("/v1/admin/invites", admin("invites", async (s, req) => {
    const i = createInvite(ctx, s, req.body);
    audit(ctx, s, "invite-create", i.code, { label: i.label, bundle: i.bundle, maxUses: i.max_uses, expiresAt: i.expires_at });
    return { invite: inviteView(ctx, i) };
  }));
  app.delete<{ Params: { code: string } }>("/v1/admin/invites/:code", admin("invites", async (s, req) => {
    const r = db.prepare("UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL").run(Date.now(), normCode(req.params.code));
    if (!r.changes) throw new UserError(404, "Deze code bestaat niet of is al ingetrokken");
    audit(ctx, s, "invite-revoke", normCode(req.params.code));
    return { ok: true };
  }));

  // ── Hulpvragen ──
  const needTicket = (id: string) => { const t = db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined; if (!t) throw new UserError(404, "Deze hulpvraag bestaat niet"); return t; };
  app.get<{ Querystring: { status?: string; q?: string } }>("/v1/admin/tickets", admin("tickets", async (_s, req) => {
    const st = String(req.query.status ?? "active");
    const where: string[] = [];
    const args: unknown[] = [];
    if (st === "active") where.push("t.status IN ('open','answered')");
    else if (["open", "answered", "closed"].includes(st)) { where.push("t.status = ?"); args.push(st); }
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (q) { where.push("(t.subject LIKE ? OR c.email LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
    const rows = db.prepare(`SELECT t.* FROM tickets t JOIN customers c ON c.id = t.customer_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 500`).all(...args) as TicketRow[];
    return { tickets: rows.map((t) => { const v = ticketView(ctx, t, true); return { ...v, messages: undefined, count: v.messages.length, lastMessage: v.messages[v.messages.length - 1] ?? null }; }) };
  }));
  app.get<{ Params: { id: string } }>("/v1/admin/tickets/:id", admin("tickets", async (_s, req) => ticketView(ctx, needTicket(req.params.id), true)));
  app.post<{ Params: { id: string }; Body: any }>("/v1/admin/tickets/:id/messages", admin("tickets", async (s, req) => {
    const t = await staffReply(ctx, s, needTicket(req.params.id), req.body);
    audit(ctx, s, "ticket-reply", t.id, { close: (req.body as any)?.close === true });
    return ticketView(ctx, t, true);
  }));
  for (const [path, status, action] of [["close", "closed", "ticket-close"], ["reopen", "open", "ticket-reopen"]] as const) {
    app.post<{ Params: { id: string } }>(`/v1/admin/tickets/:id/${path}`, admin("tickets", async (s, req) => {
      const t = needTicket(req.params.id);
      db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), t.id);
      audit(ctx, s, action, t.id);
      return ticketView(ctx, needTicket(t.id), true);
    }));
  }

  // ── Berichten ──
  app.get<{ Querystring: { state?: string } }>("/v1/admin/announcements", admin("announcements.read", async (_s, req) => {
    const rows = db.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 500").all() as AnnouncementRow[];
    const list = rows.map((a) => announcementView(a, true));
    const want = String(req.query.state ?? "");
    return { announcements: want ? list.filter((a) => a.state === want) : list };
  }));
  app.post<{ Body: any }>("/v1/admin/announcements", admin("announcements", async (s, req) => {
    const a = createAnnouncement(ctx, s, req.body);
    audit(ctx, s, "announcement-create", a.id, { title: a.title, severity: a.severity, orderIds: a.order_ids ? JSON.parse(a.order_ids) : "iedereen" });
    return { announcement: announcementView(a, true) };
  }));
  app.post<{ Params: { id: string } }>("/v1/admin/announcements/:id/end", admin("announcements", async (s, req) => {
    if (!endAnnouncement(ctx, req.params.id)) throw new UserError(404, "Dit bericht bestaat niet of is al beëindigd");
    // Een automatisch bericht met de hand beëindigd: de vlag blijft tot de cloud weer gezond is, zonder nieuw bericht.
    audit(ctx, s, "announcement-end", req.params.id);
    return { announcement: announcementView(db.prepare("SELECT * FROM announcements WHERE id = ?").get(req.params.id) as AnnouncementRow, true) };
  }));

  // ── Gezondheid ──
  app.get("/v1/admin/health", admin("health", async () => {
    const rows = db.prepare("SELECT o.id, o.domain, o.status, c.email, h.* FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN health h ON h.order_id = o.id WHERE o.status IN ('ready','payment_problem','suspended') OR h.order_id IS NOT NULL ORDER BY (h.flagged_at IS NULL), (h.healthy = 1), o.domain").all() as (HealthRow & { id: string; domain: string; status: string; email: string })[];
    return { clouds: rows.map((r) => ({ orderId: r.id, domain: r.domain, email: r.email, status: r.status, statusLabel: STATUS_LABELS[r.status], health: r.order_id ? healthView(r) : null })) };
  }));

  // ── Medewerkers (eigenaar) ──
  app.get("/v1/admin/staff", admin("staff", async () => ({
    staff: (db.prepare("SELECT * FROM staff ORDER BY created_at").all() as StaffRow[]).map((x) => staffView(ctx, x)),
    roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r], permissions: PERMISSIONS[r] })),
  })));
  app.post<{ Body: { email?: string; role?: Role; name?: string } }>("/v1/admin/staff", admin("staff", async (s, req) => {
    const n = addStaff(ctx, s, String(req.body?.email ?? ""), req.body?.role as Role, req.body?.name);
    audit(ctx, s, "staff-add", n.email, { role: n.role });
    await mailInvite(ctx, n, s);
    return { staff: staffView(ctx, n) };
  }));
  app.patch<{ Params: { id: string }; Body: { role?: Role } }>("/v1/admin/staff/:id", admin("staff", async (s, req) => {
    const { before, after } = setRole(ctx, req.params.id, req.body?.role as Role);
    audit(ctx, s, "staff-role", after.email, { from: before.role, to: after.role });
    return { staff: staffView(ctx, after) };
  }));
  app.delete<{ Params: { id: string } }>("/v1/admin/staff/:id", admin("staff", async (s, req) => {
    const gone = removeStaff(ctx, req.params.id);
    audit(ctx, s, "staff-remove", gone.email, { role: gone.role });
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/v1/admin/staff/:id/reset", admin("staff", async (s, req) => {
    const x = getStaff(ctx, req.params.id);
    if (!x) throw new UserError(404, "Deze medewerker bestaat niet");
    resetSecondFactor(ctx, x.id);
    audit(ctx, s, "staff-reset-second-factor", x.email);
    return { staff: staffView(ctx, getStaff(ctx, x.id)!) };
  }));

  // ── Logboek (eigenaar) ──
  app.get<{ Querystring: { limit?: string; before?: string; staff?: string; action?: string } }>("/v1/admin/audit", admin("audit", async (_s, req) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (req.query.before) { where.push("id < ?"); args.push(Number(req.query.before)); }
    if (req.query.staff) { where.push("staff_email = ?"); args.push(String(req.query.staff).toLowerCase()); }
    if (req.query.action) { where.push("action LIKE ?"); args.push(`${req.query.action}%`); }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = db.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as { id: number; at: number; staff_id: string | null; staff_email: string | null; action: string; target: string | null; detail: string | null }[];
    return { entries: rows.map((r) => ({ id: r.id, at: r.at, staff: r.staff_email, action: r.action, target: r.target, detail: r.detail ? safeJson(r.detail) : null })) };
  }));
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

