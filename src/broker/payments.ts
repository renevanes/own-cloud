/**
 * Mollie: eerste betaling (iDEAL e.d.) → machtiging → maandelijkse incasso. De webhook vertelt alleen
 * een id; de echte status halen we altijd zelf op bij Mollie.
 */
import { type OrderRow, getOrder, getCustomer, setStatus, event } from "./db.js";
import { type Ctx, bundleOf, setStep, withLock, todayNl, addMonths } from "./context.js";
import { provisionOrder } from "./provision.js";
import { trySend } from "./mail.js";

const FAILED = ["failed", "canceled", "expired", "charged_back"];

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

export async function handleWebhook(ctx: Ctx, paymentId: string) {
  if (!/^tr_[A-Za-z0-9]+$/.test(paymentId)) return;
  const p = await ctx.apis.mollie.getPayment(paymentId);
  const order = findOrder(ctx, p);
  if (!order) { event(ctx.db, null, "webhook-unknown", { id: paymentId }); return; }
  const cust = getCustomer(ctx.db, order.customer_id)!;
  if (p.customerId && cust.mollie_customer_id && p.customerId !== cust.mollie_customer_id) { event(ctx.db, order.id, "webhook-mismatch", { id: paymentId }); return; }

  ctx.db.prepare(`INSERT INTO payments (id, order_id, status, sequence_type, subscription_id, amount, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
    .run(p.id, order.id, p.status, p.sequenceType ?? null, p.subscriptionId ?? null, p.amount?.value ?? null, Date.now());

  const isFirst = !p.subscriptionId && p.id === order.mollie_payment_id;
  let startProvisioning = false;
  await withLock(order.id, async () => {
    const o = getOrder(ctx.db, order.id)!;
    if (isFirst) {
      if (p.status === "paid" && o.status === "awaiting_payment") {
        ctx.db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, next_attempt_at = 0 WHERE id = ?").run(Date.now(), o.id);
        setStep(ctx.db, o.id, "payment", "done", "Betaald; je machtiging voor de maandelijkse incasso staat");
        event(ctx.db, o.id, "paid", { id: p.id });
      } else if (FAILED.includes(p.status) && o.status === "awaiting_payment") {
        setStep(ctx.db, o.id, "payment", "fail", "De betaling is niet gelukt. Bestel opnieuw om het nog eens te proberen.");
      }
      if (p.status === "paid") {
        try { await ensureSubscription(ctx, o.id); }
        catch (e) { event(ctx.db, o.id, "subscription-error", (e as Error).message); } // de achtergrondlus probeert het opnieuw
        startProvisioning = ["paid", "provisioning"].includes(getOrder(ctx.db, o.id)!.status);
      }
      return;
    }
    // Maandelijkse incasso
    if (p.status === "paid") {
      event(ctx.db, o.id, "recurring-paid", { id: p.id });
      if (o.status === "payment_problem") setStatus(ctx.db, o.id, o.kit_enc ? "ready" : "provisioning");
    } else if (FAILED.includes(p.status)) {
      event(ctx.db, o.id, "recurring-failed", { id: p.id, status: p.status });
      if (["ready", "provisioning", "paid"].includes(o.status)) {
        setStatus(ctx.db, o.id, "payment_problem", "De maandelijkse incasso is niet gelukt");
        await trySend(ctx.mail, cust.email, "Je betaling voor Eigen Cloud is niet gelukt",
          `Hallo,\n\nDe maandelijkse incasso voor ${o.domain} is niet gelukt. Je cloud blijft gewoon werken.\n\nKijk of er genoeg saldo op je rekening staat. We nemen contact met je op om de betaling alsnog te regelen.\n\nGroet,\nEigen Cloud Dienst`);
        await trySend(ctx.mail, ctx.cfg.adminEmail, `Incasso mislukt: ${o.domain}`,
          `Betaling ${p.id} (${p.status}) voor bestelling ${o.id} (${o.domain}, ${cust.email}).\nOpschorten na de wachttijd: npm run dienst:cli -- opschorten ${o.id}`);
      }
    }
  });
  if (startProvisioning) await provisionOrder(ctx, order.id);
}
