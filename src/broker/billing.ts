/**
 * Zelf je abonnement regelen: overzicht (betalingen, facturen, machtiging), bundel wisselen, betaalmethode
 * wijzigen, achterstand betalen, opzegging terugdraaien en de verhuiscode van je domein opvragen.
 */
import { type OrderRow, type PaymentRow, getOrder, getCustomer, orderState, patchState, event } from "./db.js";
import { type Ctx, bundleOf, withLock, todayNl, paidThrough } from "./context.js";
import { saveKit } from "./provision.js";
import { trySend } from "./mail.js";
import { FAILED } from "./payments.js";
import { toCents, fromCents, euro, dateNl } from "./invoice.js";

/** Fout met een status en een Nederlandse melding voor de klant. */
export class UserError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const short = (o: OrderRow) => o.id.slice(0, 8);
export const subscriptionDescription = (title: string, o: OrderRow) => `Eigen Cloud ${title} — ${o.domain} (${short(o)})`;

/** Middernacht (Nederlandse tijd) van een datum, in ms. */
export function nlMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  for (const h of [1, 2, 0, 3]) {
    const t = Date.UTC(y, m - 1, d) - h * 3600_000;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", hourCycle: "h23" }).format(new Date(t));
    if (todayNl(new Date(t)) === date && Number(parts) === 0) return t;
  }
  return Date.UTC(y, m - 1, d);
}

/** "NL** **** **** 1234", "Visa •••• 4242" of de naam van de betaalmethode. */
export function mandateLabel(m: any): string {
  const d = m?.details ?? {};
  if (m?.method === "directdebit" && d.consumerAccount) {
    const iban = String(d.consumerAccount).replace(/\s/g, "");
    return `${iban.slice(0, 2)}** **** **** ${iban.slice(-4)}`;
  }
  if (m?.method === "creditcard" && (d.cardNumber || d.cardLabel)) {
    const last4 = String(d.cardNumber ?? "").replace(/\D/g, "").slice(-4);
    return [d.cardLabel ?? "Creditcard", last4 ? `•••• ${last4}` : ""].filter(Boolean).join(" ");
  }
  if (m?.method === "paypal") return d.consumerAccount ? `PayPal (${d.consumerAccount})` : "PayPal";
  return { directdebit: "SEPA-incasso", creditcard: "Creditcard" }[m?.method as string] ?? String(m?.method ?? "Onbekend");
}

/** De nieuwste geldige (of nog te bevestigen) machtiging; bij voorkeur die van het abonnement. */
export function pickMandate(mandates: any[], preferId?: string | null) {
  const usable = mandates.filter((m) => m.status === "valid" || m.status === "pending");
  const pref = preferId ? usable.find((m) => m.id === preferId) : undefined;
  if (pref) return pref;
  return [...usable].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || (a.status === "valid" ? -1 : 1))[0] ?? null;
}

const transferable = (o: OrderRow) => (o.domain_mode === "register" || o.domain_mode === "transfer") && (o.status === "ready" || o.status === "cancelled");
const canResume = (o: OrderRow) => o.status === "cancelled" && !!o.paid_at && !!o.ends_at && o.ends_at > todayNl() && !!o.kit_enc && !orderState(o).cleanedAt;

/** Mislukte incasso's die nog niet alsnog betaald zijn. */
function unsettled(ctx: Ctx, orderId: string) {
  return (ctx.db.prepare(`SELECT * FROM payments WHERE order_id = ? AND kind = 'recurring' AND settled_by IS NULL AND status IN (${FAILED.map(() => "?").join(",")}) ORDER BY created_at`)
    .all(orderId, ...FAILED) as PaymentRow[]);
}

function outstandingOf(ctx: Ctx, o: OrderRow) {
  if (o.status !== "payment_problem") return null;
  const rows = unsettled(ctx, o.id);
  const cents = rows.reduce((n, r) => n + toCents(r.amount ?? o.amount), 0);
  return cents > 0 ? { cents, rows } : null;
}

// ───────── Overzicht ─────────

export async function billingView(ctx: Ctx, o: OrderRow) {
  const cust = getCustomer(ctx.db, o.customer_id)!;
  const b = bundleOf(ctx, o.bundle);
  let nextPaymentDate: string | null = null;
  let mandate: { method: string; label: string; status: string } | null = null;
  let subMandateId: string | null = null;
  const active = o.mollie_subscription_id && !["cancelled", "awaiting_payment"].includes(o.status);
  if (active && cust.mollie_customer_id) {
    try {
      const sub = await ctx.apis.mollie.getSubscription(cust.mollie_customer_id, o.mollie_subscription_id!);
      subMandateId = sub?.mandateId ?? null;
      if (sub?.status === "active") nextPaymentDate = sub.nextPaymentDate ?? null;
    } catch (e) {
      event(ctx.db, o.id, "billing-subscription-error", (e as Error).message);
      nextPaymentDate = paidThrough(o.subscription_start);
    }
  }
  if (cust.mollie_customer_id && o.paid_at) {
    try {
      const m = pickMandate(await ctx.apis.mollie.mandates(cust.mollie_customer_id), subMandateId);
      if (m) mandate = { method: String(m.method), label: mandateLabel(m), status: String(m.status) };
    } catch (e) { event(ctx.db, o.id, "billing-mandate-error", (e as Error).message); }
  }
  const rows = ctx.db.prepare("SELECT p.*, i.id AS invoice_id FROM payments p LEFT JOIN invoices i ON i.payment_id = p.id WHERE p.order_id = ? AND COALESCE(p.kind, 'first') IN ('first','recurring','settle') ORDER BY COALESCE(p.paid_at, p.created_at, p.updated_at) DESC, p.rowid DESC")
    .all(o.id) as (PaymentRow & { invoice_id: string | null })[];
  const out = outstandingOf(ctx, o);
  return {
    orderId: o.id,
    status: o.status,
    domain: o.domain,
    bundle: { id: o.bundle, title: b?.title ?? o.bundle, monthly: { currency: "EUR", value: o.amount } },
    nextPaymentDate,
    endsAt: o.status === "cancelled" && o.ends_at ? nlMidnight(o.ends_at) : null,
    mandate,
    payments: rows.map((r) => ({
      id: r.id,
      date: todayNl(new Date(r.paid_at ?? r.created_at ?? r.updated_at)),
      amount: { currency: "EUR", value: r.amount ?? o.amount },
      status: r.status,
      description: r.description ?? (r.kind === "settle" ? "Achterstallige betaling" : `Eigen Cloud ${b?.title ?? o.bundle} — ${o.domain}`),
      invoiceId: r.invoice_id,
    })),
    outstanding: out ? { currency: "EUR", value: fromCents(out.cents) } : null,
    bundles: ctx.cfg.bundles.map((x) => ({ id: x.id, title: x.title, monthly: x.monthly, current: x.id === o.bundle })),
    canResume: canResume(o),
    domainTransferable: transferable(o),
  };
}

// ───────── Bundel wisselen ─────────

export async function changeBundle(ctx: Ctx, orderId: string, bundleId: string) {
  return withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    const b = bundleOf(ctx, bundleId);
    if (!b) throw new UserError(400, "Deze bundel bestaat niet");
    if (b.id === o.bundle) throw new UserError(400, "Je hebt deze bundel al");
    if (o.status !== "ready") throw new UserError(409, "Je kunt je bundel alleen wisselen als je cloud klaar is en je betalingen in orde zijn");
    const cust = getCustomer(ctx.db, o.customer_id)!;
    if (!o.mollie_subscription_id || !cust.mollie_customer_id) throw new UserError(409, "Je abonnement wordt nog aangemaakt. Probeer het zo opnieuw.");
    const sub = await ctx.apis.mollie.updateSubscription(cust.mollie_customer_id, o.mollie_subscription_id, {
      amount: { currency: "EUR", value: b.monthly.value },
      description: subscriptionDescription(b.title, o),
    });
    const effective: string = sub?.nextPaymentDate ?? paidThrough(o.subscription_start);
    const from = o.bundle;
    ctx.db.prepare("UPDATE orders SET bundle = ?, amount = ? WHERE id = ?").run(b.id, b.monthly.value, o.id);
    // Het pakket meteen bijwerken: de console mag de extra servers direct bouwen (de bewaker kijkt naar de nieuwe bundel).
    saveKit(ctx, o.id);
    event(ctx.db, o.id, "bundle-changed", { from, to: b.id, effective });
    await trySend(ctx.mail, cust.email, `Je bundel is gewijzigd naar ${b.title}`,
      `Hallo,\n\nJe bundel voor ${o.domain} is nu ${b.title}. Je kunt de nieuwe mogelijkheden meteen gebruiken.\n\nVanaf ${dateNl(effective)} betaal je ${euro(b.monthly.value)} per maand. Er wordt niets extra of terug verrekend voor de lopende maand.\n\nGroet,\nEigen Cloud Dienst`);
    return { ok: true, bundle: { id: b.id, title: b.title, monthly: b.monthly }, effective };
  });
}

// ───────── Betalen in de checkout van Mollie ─────────

function recordPayment(ctx: Ctx, o: OrderRow, p: any, kind: "mandate" | "settle", covers?: string[]) {
  ctx.db.prepare(`INSERT INTO payments (id, order_id, status, sequence_type, subscription_id, amount, updated_at, kind, description, created_at, covers)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .run(p.id, o.id, p.status ?? "open", p.sequenceType ?? null, p.amount?.value ?? null, Date.now(), kind, p.description ?? null, Date.now(), covers ? JSON.stringify(covers) : null);
}

/** Nieuwe machtiging: een betaling van € 0,01 (die we na afloop terugstorten). */
export async function startMandateChange(ctx: Ctx, orderId: string) {
  const o = getOrder(ctx.db, orderId)!;
  const cust = getCustomer(ctx.db, o.customer_id)!;
  if (!["ready", "payment_problem", "provisioning", "paid"].includes(o.status) || !o.mollie_subscription_id || !cust.mollie_customer_id)
    throw new UserError(409, "Je kunt je betaalmethode alleen wijzigen bij een lopend abonnement");
  const p = await ctx.apis.mollie.createPayment({
    amount: { currency: "EUR", value: "0.01" },
    description: `Betaalmethode wijzigen ${short(o)}`,
    redirectUrl: `${ctx.cfg.publicUrl}/betaald?order=${o.id}`,
    webhookUrl: `${ctx.cfg.publicUrl}/v1/mollie/webhook`,
    customerId: cust.mollie_customer_id,
    sequenceType: "first",
    locale: "nl_NL",
    metadata: { orderId: o.id, purpose: "mandate" },
  });
  const checkoutUrl = p?._links?.checkout?.href;
  if (!p?.id || !checkoutUrl) throw new Error("Mollie gaf geen betaallink terug");
  recordPayment(ctx, o, p, "mandate");
  event(ctx.db, o.id, "mandate-change-started", { id: p.id });
  return { checkoutUrl: checkoutUrl as string };
}

/** Achterstand in één keer betalen (eenmalige betaling, geen incasso). */
export async function startSettle(ctx: Ctx, orderId: string) {
  const o = getOrder(ctx.db, orderId)!;
  const out = outstandingOf(ctx, o);
  if (!out) throw new UserError(409, "Er staat niets open");
  const cust = getCustomer(ctx.db, o.customer_id)!;
  const p = await ctx.apis.mollie.createPayment({
    amount: { currency: "EUR", value: fromCents(out.cents) },
    description: `Openstaand bedrag Eigen Cloud ${o.domain} (${short(o)})`,
    redirectUrl: `${ctx.cfg.publicUrl}/betaald?order=${o.id}`,
    webhookUrl: `${ctx.cfg.publicUrl}/v1/mollie/webhook`,
    ...(cust.mollie_customer_id ? { customerId: cust.mollie_customer_id } : {}),
    sequenceType: "oneoff",
    locale: "nl_NL",
    metadata: { orderId: o.id, purpose: "settle" },
  });
  const checkoutUrl = p?._links?.checkout?.href;
  if (!p?.id || !checkoutUrl) throw new Error("Mollie gaf geen betaallink terug");
  recordPayment(ctx, o, p, "settle", out.rows.map((r) => r.id));
  event(ctx.db, o.id, "settle-started", { id: p.id, amount: fromCents(out.cents) });
  return { checkoutUrl: checkoutUrl as string };
}

// ───────── Opzegging terugdraaien ─────────

export async function resumeSubscription(ctx: Ctx, orderId: string) {
  return withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (!canResume(o)) throw new UserError(409, "Je abonnement kan niet meer worden voortgezet. Bestel opnieuw om weer te beginnen.");
    const cust = getCustomer(ctx.db, o.customer_id)!;
    if (!cust.mollie_customer_id) throw new UserError(409, "Je abonnement kan niet meer worden voortgezet. Bestel opnieuw om weer te beginnen.");
    const mandate = pickMandate(await ctx.apis.mollie.mandates(cust.mollie_customer_id));
    if (!mandate) throw new UserError(409, "We hebben geen geldige machtiging meer van je. Bestel opnieuw om weer te beginnen.");
    const b = bundleOf(ctx, o.bundle);
    const startDate = o.ends_at!;
    const sub = await ctx.apis.mollie.createSubscription(cust.mollie_customer_id, {
      amount: { currency: "EUR", value: o.amount },
      interval: "1 month",
      // Uniek per klant: ook naast het opgezegde abonnement van deze bestelling.
      description: `${subscriptionDescription(b?.title ?? o.bundle, o)} vanaf ${startDate}`,
      webhookUrl: `${ctx.cfg.publicUrl}/v1/mollie/webhook`,
      startDate,
      mandateId: mandate.id,
      metadata: { orderId: o.id },
    });
    ctx.db.prepare("UPDATE orders SET mollie_subscription_id = ?, subscription_start = ?, status = 'ready', error = NULL, ends_at = NULL, cancelled_at = NULL WHERE id = ?")
      .run(sub.id, sub.startDate ?? startDate, o.id);
    event(ctx.db, o.id, "subscription-resumed", { id: sub.id, startDate, mandate: mandate.id });
    await trySend(ctx.mail, cust.email, "Je abonnement loopt weer door",
      `Hallo,\n\nFijn dat je blijft! Je abonnement voor ${o.domain} loopt weer door. De volgende betaling van ${euro(o.amount)} wordt op ${dateNl(startDate)} afgeschreven.\n\nGroet,\nEigen Cloud Dienst`);
    await trySend(ctx.mail, ctx.cfg.adminEmail, `Opzegging teruggedraaid: ${o.domain}`, `Bestelling ${o.id} (${cust.email}) loopt weer; nieuw abonnement ${sub.id} vanaf ${startDate}.`);
    return { ok: true, status: "ready" as const, nextPaymentDate: (sub.nextPaymentDate ?? startDate) as string };
  });
}

// ───────── Domein meenemen ─────────

export async function domainAuthCode(ctx: Ctx, orderId: string) {
  const o = getOrder(ctx.db, orderId)!;
  if (o.domain_mode === "own") throw new UserError(409, "Dit domein staat niet bij ons geregistreerd. Je beheert het zelf bij je eigen registrar.");
  if (o.domain_mode === "sub") throw new UserError(409, "Een gratis adres van de dienst kun je niet verhuizen. Wil je je eigen domein? Neem dan een domein en zet je mail daarnaartoe over.");
  if (!transferable(o)) throw new UserError(409, "Een verhuiscode kun je opvragen als je cloud klaar is of als je hebt opgezegd");
  const st = orderState(o);
  let id = st.opDomainId as number | undefined;
  if (!id) {
    id = (await ctx.apis.openprovider.findDomainId(o.domain)) ?? undefined;
    if (!id) throw new UserError(409, "Je domein staat (nog) niet bij ons geregistreerd. Is de verhuizing al klaar?");
    patchState(ctx.db, o.id, { opDomainId: id });
  }
  const authCode = await ctx.apis.openprovider.authCode(id);
  event(ctx.db, o.id, "authcode-requested");
  return { domain: o.domain, authCode };
}

