/**
 * Beheer van de Eigen Cloud Dienst vanaf de opdrachtregel.
 *   npm run dienst:cli -- klanten
 *   npm run dienst:cli -- order <id>
 *   npm run dienst:cli -- opnieuw <id>
 *   npm run dienst:cli -- opschorten <id>
 *   npm run dienst:cli -- hervatten <id>
 *   npm run dienst:cli -- opruimen <id> [--zeker]
 *   npm run dienst:cli -- bewaker
 *   npm run dienst:cli -- facturen [<id>]
 *   npm run dienst:cli -- eigenaar <e-mailadres>
 *   npm run dienst:cli -- medewerkers
 *   npm run dienst:cli -- tweede-stap-wissen <e-mailadres>
 * Gebruikt dezelfde omgevingsvariabelen (en datamap) als de dienst zelf.
 */
import { loadConfig } from "./config.js";
import { createBroker } from "./app.js";
import { type OrderRow, type CustomerRow, getOrder, orderState } from "./db.js";
import { getSteps } from "./context.js";
import { retryOrder, suspendOrder, resumeOrder, cleanupOrder } from "./ops.js";
import { runGuard } from "./guard.js";
import { type InvoiceRow, euro } from "./invoice.js";
import { type StaffRow, ensureOwner, staffByEmail, resetSecondFactor, audit, staffView, ROLE_LABELS } from "./staff.js";

const STATUS: Record<string, string> = {
  awaiting_payment: "wacht op betaling", paid: "betaald", provisioning: "wordt klaargezet", ready: "klaar",
  failed: "mislukt", payment_problem: "betalingsprobleem", cancelled: "opgezegd", suspended: "opgeschort",
};
const STATE: Record<string, string> = { wait: "  ", busy: "… ", done: "✓ ", fail: "✗ " };
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) : "-");

const [cmd, arg, ...rest] = process.argv.slice(2);
const broker = await createBroker(loadConfig());
const { ctx } = broker;
const need = () => {
  const o = arg ? getOrder(ctx.db, arg) : undefined;
  if (!o) { console.error(arg ? `Bestelling ${arg} bestaat niet.` : "Geef het nummer van de bestelling op."); process.exit(1); }
  return o;
};

try {
  switch (cmd) {
    case "klanten": {
      const customers = ctx.db.prepare("SELECT * FROM customers ORDER BY created_at").all() as CustomerRow[];
      if (!customers.length) console.log("Nog geen klanten.");
      for (const c of customers) {
        console.log(`${c.email}  (klant ${c.id}, sinds ${when(c.created_at)})`);
        const orders = ctx.db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at").all(c.id) as OrderRow[];
        if (!orders.length) console.log("    geen bestellingen");
        for (const o of orders) {
          const inv = ctx.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM invoices WHERE order_id = ?").get(o.id) as { n: number; total: number };
          const money = `${euro(o.amount)} p/m`.padEnd(14);
          const invoices = inv.n ? `  ${inv.n} factu${inv.n === 1 ? "ur" : "ren"}, ${euro(Math.round(inv.total * 100))} betaald` : "";
          console.log(`    ${o.id}  ${o.domain.padEnd(28)} ${o.bundle.padEnd(10)} ${money} ${STATUS[o.status] ?? o.status}${o.ends_at ? ` (tot ${o.ends_at})` : ""}${invoices}`);
        }
      }
      break;
    }
    case "order": {
      const o = need();
      const c = ctx.db.prepare("SELECT email FROM customers WHERE id = ?").get(o.customer_id) as { email: string };
      const st = orderState(o);
      console.log(`Bestelling ${o.id}`);
      console.log(`  Klant:       ${c.email} (${o.customer_id})`);
      console.log(`  Domein:      ${o.domain} (${{ register: "registreren", transfer: "verhuizen", own: "eigen domein", sub: "gratis adres" }[o.domain_mode]})`);
      console.log(`  Bundel:      ${o.bundle}, € ${o.amount.replace(".", ",")} per maand`);
      console.log(`  Status:      ${STATUS[o.status] ?? o.status}${o.error ? ` — ${o.error}` : ""}`);
      console.log(`  Besteld:     ${when(o.created_at)}   betaald: ${when(o.paid_at)}   opgezegd: ${when(o.cancelled_at)}${o.ends_at ? ` (loopt tot ${o.ends_at})` : ""}`);
      console.log(`  Mollie:      betaling ${o.mollie_payment_id ?? "-"}, abonnement ${o.mollie_subscription_id ?? "-"} vanaf ${o.subscription_start ?? "-"}`);
      console.log(`  Scaleway:    project ${st.projectId ?? "-"}, applicatie ${st.applicationId ?? "-"}, sleutel ${st.apiKeyAccess ?? "-"}, maildomein ${st.temDomainId ?? "-"}`);
      console.log(`  Openprovider: klant ${st.opHandle ?? "-"}, domein ${st.opDomainId ?? "-"}`);
      console.log("  Stappen:");
      for (const s of getSteps(ctx.db, o.id)) console.log(`    ${STATE[s.state]}${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
      const events = ctx.db.prepare("SELECT kind, detail, at FROM events WHERE order_id = ? ORDER BY id DESC LIMIT 10").all(o.id) as { kind: string; detail: string | null; at: number }[];
      if (events.length) {
        console.log("  Laatste gebeurtenissen:");
        for (const e of events) console.log(`    ${when(e.at)}  ${e.kind}${e.detail ? `  ${e.detail.slice(0, 160)}` : ""}`);
      }
      break;
    }
    case "opnieuw": {
      const o = need();
      const status = await retryOrder(ctx, o.id);
      console.log(`Opnieuw geprobeerd: ${STATUS[status ?? ""] ?? status}.`);
      for (const s of getSteps(ctx.db, o.id)) console.log(`  ${STATE[s.state]}${s.label}${s.detail ? ` — ${s.detail}` : ""}`);
      break;
    }
    case "opschorten": {
      const o = need();
      for (const l of await suspendOrder(ctx, o.id)) console.log(`  ${l}`);
      console.log(`Bestelling ${o.id} is opgeschort. De klant heeft een mail gekregen.`);
      break;
    }
    case "hervatten": {
      const o = need();
      const st = await resumeOrder(ctx, o.id);
      console.log(`Bestelling ${o.id} hervat (${STATUS[st]}). Nieuwe sleutel staat in het pakket; de console van de klant haalt die op.`);
      break;
    }
    case "opruimen": {
      const o = need();
      const sure = rest.includes("--zeker") || arg === "--zeker";
      const r = await cleanupOrder(ctx, o.id, sure);
      if (!sure) {
        console.log("Dit zou er gebeuren (voer uit met --zeker):");
        for (const l of r.plan) console.log(`  - ${l}`);
      } else for (const l of r.done) console.log(`  ✓ ${l}`);
      console.log("Zelf doen:");
      for (const l of r.manual) console.log(`  - ${l}`);
      break;
    }
    case "bewaker": {
      const f = await runGuard(ctx);
      if (!f.length) console.log("Geen enkele klant gebruikt meer servers dan zijn bundel.");
      for (const x of f) console.log(`  ${x.orderId} ${x.domain}: ${x.running} draaiend, ${x.allowed} toegestaan${x.poweredOff.length ? `; uitgezet: ${x.poweredOff.join(", ")}` : ""}`);
      break;
    }
    case "facturen": {
      if (!ctx.cfg.company.name) console.warn("Let op: BROKER_COMPANY_NAME is niet ingesteld. Facturen tonen dan \"Bedrijfsgegevens ontbreken\". Zie BROKER.md.\n");
      if (arg && !getOrder(ctx.db, arg)) { console.error(`Bestelling ${arg} bestaat niet.`); process.exit(1); }
      const rows = (arg
        ? ctx.db.prepare("SELECT i.*, o.domain FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.order_id = ? ORDER BY i.year, i.seq").all(arg)
        : ctx.db.prepare("SELECT i.*, o.domain FROM invoices i JOIN orders o ON o.id = i.order_id ORDER BY i.year, i.seq").all()) as (InvoiceRow & { domain: string })[];
      if (!rows.length) console.log("Nog geen facturen.");
      let total = 0;
      for (const r of rows) {
        total += Math.round(Number(r.amount) * 100);
        console.log(`  ${r.number}  ${r.date}  ${euro(r.amount).padStart(12)}  ${r.order_id}  ${r.domain}`);
      }
      if (rows.length) console.log(`  ${rows.length} factu${rows.length === 1 ? "ur" : "ren"}, samen ${euro(total)} (incl. ${ctx.cfg.vatPercent}% btw)`);
      break;
    }
    case "eigenaar": {
      if (!arg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(arg)) { console.error("Geef het e-mailadres van de eigenaar op."); process.exit(1); }
      const r = ensureOwner(ctx, arg, "opdrachtregel");
      console.log(r.created
        ? `${r.staff.email} is nu eigenaar. Inloggen: ${ctx.cfg.publicUrl}/beheer (code per mail, daarna vingerafdruk of authenticator-app instellen).`
        : `${r.staff.email} is eigenaar.`);
      break;
    }
    case "medewerkers": {
      const list = ctx.db.prepare("SELECT * FROM staff ORDER BY created_at").all() as StaffRow[];
      if (!list.length) console.log("Nog geen medewerkers. Maak de eerste eigenaar met: eigenaar <e-mailadres>");
      for (const s of list) {
        const v = staffView(ctx, s);
        const second = [v.totp ? "authenticator-app" : "", v.devices.length ? `${v.devices.length} toestel${v.devices.length === 1 ? "" : "len"}` : ""].filter(Boolean).join(" + ") || "nog niet ingesteld";
        console.log(`  ${s.email.padEnd(32)} ${ROLE_LABELS[s.role].padEnd(10)} tweede stap: ${second}; laatst ingelogd: ${when(s.last_login_at)}`);
      }
      break;
    }
    case "tweede-stap-wissen": {
      const s = arg ? staffByEmail(ctx, arg) : undefined;
      if (!s) { console.error(arg ? `${arg} is geen medewerker.` : "Geef het e-mailadres op."); process.exit(1); }
      resetSecondFactor(ctx, s.id);
      audit(ctx, null, "staff-reset-second-factor", s.email, { how: "opdrachtregel" });
      console.log(`Authenticator-app en toestellen van ${s.email} gewist; bij de volgende keer inloggen stelt hij ze opnieuw in.`);
      break;
    }
    default:
      console.log(`Gebruik: npm run dienst:cli -- <opdracht>

  klanten               alle klanten met hun bestellingen
  order <id>            details en stappen van een bestelling
  opnieuw <id>          mislukt klaarzetten opnieuw proberen
  opschorten <id>       sleutel intrekken en servers uitzetten (bijv. na wanbetaling)
  hervatten <id>        nieuwe sleutel; de klant kan weer starten
  opruimen <id> [--zeker]  na opzegging: IAM en maildomein weghalen
  bewaker               nu controleren op te veel servers
  facturen [<id>]       alle facturen (of die van één bestelling)
  eigenaar <e-mail>     eerste (of extra) eigenaar maken voor het beheer
  medewerkers           alle medewerkers met hun rol
  tweede-stap-wissen <e-mail>  telefoon kwijt: vingerafdruk en authenticator-app opnieuw laten instellen`);
  }
} catch (e) {
  console.error(`Mislukt: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await broker.close();
}
