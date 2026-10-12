import type { Ctx } from "./context.js";
import { bundleOf } from "./context.js";
import type { OrderRow } from "./db.js";
import { can, type Role } from "./staff.js";
import { healthView, type HealthRow } from "./support.js";

/** A read-only operational view. Each section uses the existing staff permission for its source data. */
export function operationsOverview(ctx: Ctx, role: Role, price: (o: OrderRow) => unknown) {
  const out: Record<string, unknown> = {}, cutoff = Date.now() - ctx.cfg.health.silentMs;
  if (can(role, "health")) {
    const rows = ctx.db.prepare(`SELECT h.*, o.id, o.domain, o.status, o.created_at FROM orders o LEFT JOIN health h ON h.order_id=o.id
      WHERE o.status IN ('ready','payment_problem','suspended') ORDER BY o.domain`).all() as (HealthRow & { id: string; domain: string; status: string; created_at: number })[];
    out.clouds = rows.map((r) => ({ orderId: r.id, domain: r.domain, status: r.status, stale: (r.reported_at ?? r.created_at) < cutoff, neverReported: !r.reported_at, ...healthView(r.reported_at ? r : undefined) }));
    out.staleReports = rows.filter((r) => (r.reported_at ?? r.created_at) < cutoff).length;
    out.unverifiedRecovery = rows.filter((r) => !healthView(r.reported_at ? r : undefined)?.recovery?.verified).length;
  }
  if (can(role, "customers.act")) out.failedOperations = ctx.db.prepare("SELECT id AS orderId,domain,status,error,attempts,next_attempt_at AS nextAttempt FROM orders WHERE status='failed' OR (status='provisioning' AND error IS NOT NULL) ORDER BY created_at LIMIT 100").all();
  if (can(role, "money")) out.reconciliation = ctx.db.prepare(`SELECT p.id,p.order_id AS orderId,o.domain,p.status,p.amount,p.updated_at AS updatedAt,
      CASE WHEN p.done_at IS NULL THEN 'payment-effects' ELSE 'invoice' END AS pending
      FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN invoices i ON i.payment_id=p.id
      WHERE p.status='paid' AND (p.done_at IS NULL OR (i.id IS NULL AND p.kind IN ('first','recurring','settle'))) ORDER BY p.updated_at LIMIT 100`).all();
  if (can(role, "costs")) out.margins = (ctx.db.prepare("SELECT * FROM orders WHERE status IN ('ready','payment_problem') ORDER BY domain LIMIT 500").all() as OrderRow[]).map((o) => ({ orderId: o.id, domain: o.domain, bundle: bundleOf(ctx, o.bundle)?.title ?? o.bundle, estimate: price(o) }));
  return out;
}
