/**
 * Bewaker: telt elk uur de draaiende servers per klantproject. Meer dan de bundel (+1 reserve voor
 * zelfherstel en verhuizen) → melding aan beheerder en klant (hooguit één keer per dag).
 * Alleen met BROKER_ENFORCE=1 worden de nieuwste extra servers uitgezet.
 */
import { type OrderRow, orderState, event, getCustomer } from "./db.js";
import { type Ctx, bundleOf, todayNl } from "./context.js";
import { trySend } from "./mail.js";

export interface GuardFinding { orderId: string; domain: string; running: number; allowed: number; poweredOff: string[] }

export async function runGuard(ctx: Ctx): Promise<GuardFinding[]> {
  const orders = ctx.db.prepare("SELECT * FROM orders WHERE status IN ('ready','payment_problem','provisioning')").all() as OrderRow[];
  const findings: GuardFinding[] = [];
  for (const o of orders) {
    const st = orderState(o);
    const b = bundleOf(ctx, o.bundle);
    if (!st.projectId || !b) continue;
    try {
      const zones = [...new Set(b.placement.map((p) => p.region))];
      const running: { zone: string; id: string; name: string; created: string }[] = [];
      for (const zone of zones) {
        for (const s of await ctx.apis.scaleway.servers(zone, st.projectId)) {
          if (s.state === "running" || s.state === "starting") running.push({ zone, id: s.id, name: s.name, created: s.creation_date ?? "" });
        }
      }
      const allowed = b.includes.dataServers + b.includes.witnesses + 1;
      if (running.length <= allowed) continue;
      const f: GuardFinding = { orderId: o.id, domain: o.domain, running: running.length, allowed, poweredOff: [] };
      if (ctx.cfg.enforce) {
        const extra = [...running].sort((a, b2) => b2.created.localeCompare(a.created)).slice(0, running.length - allowed);
        for (const s of extra) {
          await ctx.apis.scaleway.serverAction(s.zone, s.id, "poweroff");
          f.poweredOff.push(`${s.zone}/${s.id}`);
        }
      }
      event(ctx.db, o.id, "guard-too-many", f);
      findings.push(f);
      const key = `guard-mail:${todayNl()}`;
      const already = ctx.db.prepare("SELECT 1 FROM events WHERE order_id = ? AND kind = ?").get(o.id, key);
      if (!already) {
        event(ctx.db, o.id, key);
        const cust = getCustomer(ctx.db, o.customer_id)!;
        const what = f.poweredOff.length ? `We hebben ${f.poweredOff.length} van de nieuwste servers uitgezet.` : "Er is niets uitgezet.";
        await trySend(ctx.mail, ctx.cfg.adminEmail, `Te veel servers: ${o.domain}`,
          `Bestelling ${o.id} (${o.domain}) heeft ${f.running} draaiende servers; de bundel staat ${allowed} toe (inclusief 1 reserve).\n${what}`);
        await trySend(ctx.mail, cust.email, "Je cloud gebruikt meer servers dan je bundel",
          `Hallo,\n\nVoor ${o.domain} draaien nu ${f.running} servers, terwijl je bundel er ${allowed} toestaat (inclusief 1 reserve voor herstel en verhuizen). ${what}\n\nKijk in je beheerconsole of er een server is blijven hangen, of neem contact met ons op als je meer nodig hebt.\n\nGroet,\nEigen Cloud Dienst`);
      }
    } catch (e) {
      event(ctx.db, o.id, "guard-error", (e as Error).message);
    }
  }
  return findings;
}
