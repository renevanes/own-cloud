/**
 * Mollie: eerste betaling (iDEAL e.d.) → machtiging → maandelijkse incasso. De webhook vertelt alleen
 * een id; de echte status halen we altijd zelf op bij Mollie.
 */
import { type OrderRow, type PaymentKind, getOrder, getCustomer, setStatus, event } from "./db.js";
import { type Ctx, bundleOf, setStep, withLock, todayNl, addMonths } from "./context.js";
import { provisionOrder } from "./provision.js";
import { trySend } from "./mail.js";
import { invoicePayment, periodStartFor } from "./invoice.js";

export const FAILED = ["failed", "canceled", "expired", "charged_back"];

/** Maakt het maandabonnement aan (één keer; ook na een onderbroken poging). */
export async function ensureSubscription(ctx: Ctx, orderId: string) {
  const o = getOrder(ctx.db, orderId);
  if (!o || o.mollie_subscription_id || !o.paid_at || ["cancelled", "awaiting_payment"].includes(o.status)) return;
  const cust = getCustomer(ctx.db, o.customer_id)!;
  if (!cust.mollie_customer_id) return;
  const b = bundleOf(ctx, o.bundle);
  // Bestaat er al een (bijv. aangemaakt vlak voor een crash)? Dan die gebruiken.
  const list = await ctx.apis.mollie.req("GET", `/customers/${encodeURIComponent(cust.mollie_customer_id)}/subscriptions?limit=250`);
  const existing = (list?._embedded?.subscriptions ?? []).find((s: any) => s.metadata?.orderId === o.id && s.status !== "canceled");
  const startDate = addMonths(todayNl(new Date(o.paid_at)), 1);
  const sub = existing ?? await ctx.apis.mollie.createSubscription(cust.mollie_customer_id, {
    amount: { currency: "EUR", value: o.amount },
    interval: "1 month",
    description: `Eigen Cloud ${b?.title ?? o.bundle} — ${o.domain} (${o.id.slice(0, 8)})`,
    webhookUrl: `${ctx.cfg.publicUrl}/v1/mollie/webhook`,
    startDate,
    metadata: { orderId: o.id },
  });
  ctx.db.prepare("UPDATE orders SET mollie_subscription_id = ?, subscription_start = ? WHERE id = ?").run(sub.id, sub.startDate ?? startDate, o.id);
  event(ctx.db, o.id, "subscription", { id: sub.id, startDate: sub.startDate ?? startDate });
}

function findOrder(ctx: Ctx, p: any): OrderRow | undefined {
  if (p.subscriptionId) {
    const o = ctx.db.prepare("SELECT * FROM orders WHERE mollie_subscription_id = ?").get(p.subscriptionId) as OrderRow | undefined;
    if (o) return o;
  }
  const byPayment = ctx.db.prepare("SELECT * FROM orders WHERE mollie_payment_id = ?").get(p.id) as OrderRow | undefined;
  if (byPayment) return byPayment;
  return p.metadata?.orderId ? getOrder(ctx.db, String(p.metadata.orderId)) : undefined;
}

/** Welke soort betaling is dit? (De metadata zetten we zelf; Mollie geeft hem ongewijzigd terug.) */
function kindOf(p: any, o: OrderRow): PaymentKind {
  const purpose = p.metadata?.purpose;
  if (purpose === "mandate") return "mandate";
  if (purpose === "settle") return "settle";
  if (p.subscriptionId) return "recurring";
  if (p.id === o.mollie_payment_id) return "first";
  return "other";
}

const ms = (s: unknown) => { const t = typeof s === "string" ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

export async function handleWebhook(ctx: Ctx, paymentId: string) {
  if (!/^tr_[A-Za-z0-9]+$/.test(paymentId)) return;
  const p = await ctx.apis.mollie.getPayment(paymentId);
  const order = findOrder(ctx, p);
  if (!order) { event(ctx.db, null, "webhook-unknown", { id: paymentId }); return; }
  const cust = getCustomer(ctx.db, order.customer_id)!;
  if (p.customerId && cust.mollie_customer_id && p.customerId !== cust.mollie_customer_id) { event(ctx.db, order.id, "webhook-mismatch", { id: paymentId }); return; }

  const kind = kindOf(p, order);
  const createdAt = ms(p.createdAt) ?? Date.now();
  const paidAt = p.status === "paid" ? ms(p.paidAt) ?? Date.now() : null;
  const periodStart = kind === "recurring" ? periodStartFor(order.subscription_start, todayNl(new Date(createdAt))) : null;
  ctx.db.prepare(`INSERT INTO payments (id, order_id, status, sequence_type, subscription_id, amount, updated_at, kind, method, description, created_at, paid_at, period_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, method = COALESCE(excluded.method, payments.method),
      paid_at = COALESCE(payments.paid_at, excluded.paid_at), kind = COALESCE(payments.kind, excluded.kind),
      description = COALESCE(payments.description, excluded.description), period_start = COALESCE(payments.period_start, excluded.period_start),
      amount = COALESCE(payments.amount, excluded.amount), subscription_id = COALESCE(payments.subscription_id, excluded.subscription_id)`)
    .run(p.id, order.id, p.status, p.sequenceType ?? null, p.subscriptionId ?? null, p.amount?.value ?? null, Date.now(), kind, p.method ?? null, p.description ?? null, createdAt, paidAt, periodStart);

  let startProvisioning = false;
  await withLock(order.id, async () => {
    const o = getOrder(ctx.db, order.id)!;
    if (kind === "first") {
      if (p.status === "paid" && o.status === "awaiting_payment") {
        ctx.db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, next_attempt_at = 0 WHERE id = ?").run(Date.now(), o.id);
        setStep(ctx.db, o.id, "payment", "done", "Betaald; je machtiging voor de maandelijkse incasso staat");
        event(ctx.db, o.id, "paid", { id: p.id });
      } else if (FAILED.includes(p.status) && o.status === "awaiting_payment") {
        setStep(ctx.db, o.id, "payment", "fail", "De betaling is niet gelukt. Bestel opnieuw om het nog eens te proberen.");
      }
      if (p.status === "paid") {
        await invoicePayment(ctx, getOrder(ctx.db, o.id)!, p.id).catch((e) => event(ctx.db, o.id, "invoice-error", (e as Error).message));
        try { await ensureSubscription(ctx, o.id); }
        catch (e) { event(ctx.db, o.id, "subscription-error", (e as Error).message); } // de achtergrondlus probeert het opnieuw
        startProvisioning = ["paid", "provisioning"].includes(getOrder(ctx.db, o.id)!.status);
      }
      return;
    }
    if (kind === "mandate") { if (p.status === "paid") await mandatePaid(ctx, o, p); return; }
    if (kind === "settle") { if (p.status === "paid") await settlePaid(ctx, o, p); return; }
    if (kind !== "recurring") { event(ctx.db, o.id, "webhook-other", { id: p.id, status: p.status }); return; }
    // Maandelijkse incasso
    if (p.status === "paid") {
      event(ctx.db, o.id, "recurring-paid", { id: p.id });
      if (o.status === "payment_problem") setStatus(ctx.db, o.id, o.kit_enc ? "ready" : "provisioning");
      await invoicePayment(ctx, o, p.id).catch((e) => event(ctx.db, o.id, "invoice-error", (e as Error).message));
    } else if (FAILED.includes(p.status)) {
      event(ctx.db, o.id, "recurring-failed", { id: p.id, status: p.status });
      if (["ready", "provisioning", "paid"].includes(o.status)) {
        setStatus(ctx.db, o.id, "payment_problem", "De maandelijkse incasso is niet gelukt");
        await trySend(ctx.mail, cust.email, "Je betaling voor Eigen Cloud is niet gelukt",
          `Hallo,\n\nDe maandelijkse incasso voor ${o.domain} is niet gelukt. Je cloud blijft gewoon werken.\n\nJe kunt het bedrag zelf betalen in de app, onder Abonnement. Daar kun je ook je betaalmethode wijzigen. Lukt dat niet? Neem dan contact met ons op.\n\nGroet,\nEigen Cloud Dienst`);
        await trySend(ctx.mail, ctx.cfg.adminEmail, `Incasso mislukt: ${o.domain}`,
          `Betaling ${p.id} (${p.status}) voor bestelling ${o.id} (${o.domain}, ${cust.email}).\nOpschorten na de wachttijd: npm run dienst:cli -- opschorten ${o.id}`);
      }
    }
  });
  if (startProvisioning) await provisionOrder(ctx, order.id);
}

const isDone = (ctx: Ctx, id: string) => !!(ctx.db.prepare("SELECT done_at FROM payments WHERE id = ?").get(id) as { done_at: number | null } | undefined)?.done_at;
const markDone = (ctx: Ctx, id: string) => ctx.db.prepare("UPDATE payments SET done_at = ? WHERE id = ?").run(Date.now(), id);

/** Nieuwe machtiging (€ 0,01 betaald): abonnement erop zetten, het centje terugstorten, klant mailen. */
async function mandatePaid(ctx: Ctx, o: OrderRow, p: any) {
  if (isDone(ctx, p.id)) return;
  const cust = getCustomer(ctx.db, o.customer_id)!;
  if (!p.mandateId) { event(ctx.db, o.id, "mandate-missing", { id: p.id }); return; }
  if (o.mollie_subscription_id && cust.mollie_customer_id) {
    try {
      await ctx.apis.mollie.updateSubscription(cust.mollie_customer_id, o.mollie_subscription_id, { mandateId: p.mandateId });
    } catch (e) {
      // Niet als klaar markeren: een volgende webhook (of nakijken) probeert het opnieuw.
      event(ctx.db, o.id, "mandate-update-error", (e as Error).message);
      await trySend(ctx.mail, ctx.cfg.adminEmail, `Betaalmethode wijzigen mislukt: ${o.domain}`,
        `Machtiging ${p.mandateId} (betaling ${p.id}) kon niet aan abonnement ${o.mollie_subscription_id} worden gekoppeld:\n${(e as Error).message}`);
      return;
    }
  }
  try { await ctx.apis.mollie.createRefund(p.id, { amount: p.amount ?? { currency: "EUR", value: "0.01" }, description: "Betaalmethode gewijzigd: we storten de cent terug" }); }
  catch (e) { event(ctx.db, o.id, "mandate-refund-error", (e as Error).message); }
  markDone(ctx, p.id);
  event(ctx.db, o.id, "mandate-changed", { payment: p.id, mandate: p.mandateId });
  await trySend(ctx.mail, cust.email, "Je betaalmethode is gewijzigd",
    `Hallo,\n\nJe betaalmethode voor ${o.domain} is gewijzigd. De volgende maandelijkse betaling gaat via je nieuwe betaalmethode.\n\nDe € 0,01 van de controlebetaling storten we terug.\n\nHeb je dit niet zelf gedaan? Neem dan meteen contact met ons op.\n\nGroet,\nEigen Cloud Dienst`);
}

/** Achterstand betaald: mislukte incasso's afboeken, weer "klaar", factuur. */
async function settlePaid(ctx: Ctx, o: OrderRow, p: any) {
  const row = ctx.db.prepare("SELECT covers FROM payments WHERE id = ?").get(p.id) as { covers: string | null };
  if (!isDone(ctx, p.id)) {
    const ids: string[] = row.covers ? JSON.parse(row.covers) : [];
    for (const id of ids) ctx.db.prepare("UPDATE payments SET settled_by = ? WHERE id = ? AND settled_by IS NULL").run(p.id, id);
    if (o.status === "payment_problem") setStatus(ctx.db, o.id, o.kit_enc ? "ready" : "provisioning");
    markDone(ctx, p.id);
    event(ctx.db, o.id, "settled", { id: p.id, covers: ids });
  }
  await invoicePayment(ctx, getOrder(ctx.db, o.id)!, p.id).catch((e) => event(ctx.db, o.id, "invoice-error", (e as Error).message));
}
