/**
 * Facturen: elke echte betaling (eerste betaling, maandelijkse incasso, betaalde achterstand) krijgt een
 * factuur met een doorlopend nummer per jaar (EC-2026-0001, zonder gaten). Alle gegevens worden bij het
 * maken vastgelegd (versleuteld, want er staan adresgegevens in), zodat een factuur later nooit verandert.
 */
import crypto from "node:crypto";
import { type OrderRow, type PaymentRow, getCustomer } from "./db.js";
import { type Ctx, bundleOf, todayNl, addMonths } from "./context.js";
import { readInput } from "./provision.js";
import { trySend } from "./mail.js";

// ───────── Geld en datums ─────────

export const toCents = (v: string | number) => Math.round(Number(v) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);

/** Bedrag inclusief btw → exclusief + btw (afgerond op centen; samen altijd precies het bedrag inclusief). */
export function vatSplit(inclCents: number, percent: number) {
  const excl = Math.round((inclCents * 100) / (100 + percent));
  return { excl, vat: inclCents - excl };
}

/** 2495 of "24.95" → "€ 24,95"; 123456 → "€ 1.234,56". */
export function euro(v: number | string) {
  const cents = typeof v === "number" ? v : toCents(v);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}€ ${whole},${String(abs % 100).padStart(2, "0")}`;
}

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** "2026-10-10" → "10 oktober 2026". */
export function dateNl(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export function minusDay(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day - 1)).toISOString().slice(0, 10);
}

/** Periode van een maand vanaf `start`: "10 oktober – 9 november 2026" (of met twee jaartallen over de jaargrens). */
export function periodLabel(start: string) {
  const end = minusDay(addMonths(start, 1));
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye] = end.split("-").map(Number);
  const from = ys === ye ? `${ds} ${MONTHS[ms - 1]}` : dateNl(start);
  return `${from} – ${dateNl(end)}`;
}

export const monthLabel = (d: string) => { const [y, m] = d.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };

/** Het begin van de abonnementsperiode waarin `date` valt (start + k maanden). */
export function periodStartFor(subscriptionStart: string | null, date: string) {
  if (!subscriptionStart || date < subscriptionStart) return date;
  let k = 0;
  while (addMonths(subscriptionStart, k + 1) <= date && k < 1200) k++;
  return addMonths(subscriptionStart, k);
}

const METHODS: Record<string, string> = {
  ideal: "iDEAL", directdebit: "SEPA-incasso", creditcard: "creditcard", bancontact: "Bancontact", paypal: "PayPal",
  banktransfer: "overboeking", belfius: "Belfius", kbc: "KBC/CBC", eps: "EPS", giropay: "giropay", sofort: "SOFORT",
  applepay: "Apple Pay", in3: "in3", klarna: "Klarna", przelewy24: "Przelewy24", trustly: "Trustly", twint: "TWINT",
};
export const methodLabel = (m: string | null | undefined) => (m ? METHODS[m] ?? m : null);

const COUNTRIES: Record<string, string> = { NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", LU: "Luxemburg", GB: "Verenigd Koninkrijk" };

// ───────── Factuur maken ─────────

export interface InvoiceData {
  number: string;
  date: string;
  orderId: string;
  paymentId: string;
  description: string;
  period: string | null;
  currency: "EUR";
  amountIncl: string;
  vatPercent: number;
  amountExcl: string;
  vatAmount: string;
  paidOn: string | null;
  method: string | null;
  seller: { name: string; address: string[]; kvk: string | null; vat: string | null } | null;
  customer: { name: string | null; company: string | null; address: string[]; email: string };
}

export interface InvoiceRow { id: string; number: string; year: number; seq: number; order_id: string; customer_id: string; payment_id: string; date: string; amount: string; data_enc: Buffer; created_at: number }

export const readInvoice = (ctx: Ctx, row: InvoiceRow) => ctx.secrets.open<InvoiceData>(row.data_enc, `invoice:${row.id}`)!;

/** Omschrijving en periode voor de factuurregel. */
function invoiceLine(ctx: Ctx, o: OrderRow, pay: PaymentRow): { description: string; period: string | null } {
  const title = bundleOf(ctx, o.bundle)?.title ?? o.bundle;
  const base = `Eigen Cloud ${title} — ${o.domain}`;
  const paidDay = todayNl(new Date(pay.paid_at ?? Date.now()));
  if (pay.kind === "settle") {
    const ids: string[] = pay.covers ? JSON.parse(pay.covers) : [];
    const rows = ids.map((id) => ctx.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined).filter(Boolean) as PaymentRow[];
    const periods = rows.map((r) => (r.period_start ? periodLabel(r.period_start) : null)).filter(Boolean) as string[];
    return { description: `Achterstallige betaling ${base}`, period: periods.length ? periods.join("; ") : monthLabel(paidDay) };
  }
  if (pay.kind === "first") return { description: base, period: periodLabel(paidDay) };
  if (pay.period_start) return { description: base, period: periodLabel(pay.period_start) };
  return { description: base, period: monthLabel(paidDay) };
}

/**
 * Maakt (één keer) de factuur voor een betaalde betaling. Het nummer wordt in dezelfde transactie toegekend
 * als de factuur wordt opgeslagen, dus er ontstaan geen gaten; dezelfde betaling twee keer geeft dezelfde factuur.
 */
export function createInvoice(ctx: Ctx, o: OrderRow, pay: PaymentRow): { row: InvoiceRow; created: boolean } {
  const db = ctx.db;
  const cust = getCustomer(db, o.customer_id)!;
  const reg = readInput(ctx, o).registrant;
  const line = invoiceLine(ctx, o, pay);
  const incl = toCents(pay.amount ?? o.amount);
  const { excl, vat } = vatSplit(incl, ctx.cfg.vatPercent);
  const c = ctx.cfg.company;
  const date = todayNl();
  const year = Number(date.slice(0, 4));
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT * FROM invoices WHERE payment_id = ?").get(pay.id) as InvoiceRow | undefined;
    if (existing) return { row: existing, created: false };
    const seq = ((db.prepare("SELECT MAX(seq) AS n FROM invoices WHERE year = ?").get(year) as { n: number | null }).n ?? 0) + 1;
    const id = crypto.randomBytes(8).toString("hex");
    const number = `EC-${year}-${String(seq).padStart(4, "0")}`;
    const data: InvoiceData = {
      number, date, orderId: o.id, paymentId: pay.id,
      description: line.description, period: line.period,
      currency: "EUR", amountIncl: fromCents(incl), vatPercent: ctx.cfg.vatPercent, amountExcl: fromCents(excl), vatAmount: fromCents(vat),
      paidOn: pay.paid_at ? todayNl(new Date(pay.paid_at)) : date,
      method: methodLabel(pay.method),
      seller: c.name ? { name: c.name, address: c.address, kvk: c.kvk, vat: c.vat } : null,
      customer: {
        name: reg ? `${reg.firstName} ${reg.lastName}`.trim() : null,
        company: reg?.company || null,
        address: reg ? [`${reg.street} ${reg.number}`.trim(), `${reg.zipcode} ${reg.city}`.trim(), ...(reg.country && reg.country !== "NL" ? [COUNTRIES[reg.country] ?? reg.country] : [])] : [],
        email: cust.email,
      },
    };
    db.prepare("INSERT INTO invoices (id, number, year, seq, order_id, customer_id, payment_id, date, amount, data_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, number, year, seq, o.id, o.customer_id, pay.id, date, fromCents(incl), ctx.secrets.seal(data, `invoice:${id}`), Date.now());
    return { row: db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow, created: true };
  });
  return tx.immediate();
}

/** Factuur maken en de klant een korte mail sturen (alleen de eerste keer). */
export async function invoicePayment(ctx: Ctx, o: OrderRow, paymentId: string) {
  const pay = ctx.db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId) as PaymentRow | undefined;
  if (!pay || pay.status !== "paid" || !["first", "recurring", "settle"].includes(pay.kind ?? "")) return null;
  const { row, created } = createInvoice(ctx, o, pay);
  if (created) {
    const cust = getCustomer(ctx.db, o.customer_id)!;
    await trySend(ctx.mail, cust.email, `Factuur ${row.number}`,
      `Hallo,\n\nWe hebben je betaling van ${euro(row.amount)} voor ${o.domain} ontvangen. Dank je wel!\n\nDe factuur (${row.number}) staat voor je klaar in de app, onder Abonnement. Daar kun je hem bekijken en afdrukken.\n\nGroet,\nEigen Cloud Dienst`);
  }
  return row;
}

// ───────── Factuur als HTML ─────────

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const pct = (n: number) => `${String(n).replace(".", ",")}%`;

export function renderInvoiceHtml(d: InvoiceData): string {
  const lines = (arr: (string | null | undefined)[]) => arr.filter(Boolean).map((l) => `${esc(l)}<br>`).join("");
  const seller = d.seller
    ? `<strong>${esc(d.seller.name)}</strong><br>${lines(d.seller.address)}${d.seller.kvk ? `KvK ${esc(d.seller.kvk)}<br>` : ""}${d.seller.vat ? `Btw-nummer ${esc(d.seller.vat)}<br>` : ""}`
    : `<span class="warn">Bedrijfsgegevens ontbreken (stel BROKER_COMPANY_* in)</span>`;
  const cust = d.customer;
  const customer = `${cust.company ? `<strong>${esc(cust.company)}</strong><br>${lines([cust.name])}` : cust.name ? `<strong>${esc(cust.name)}</strong><br>` : ""}${lines(cust.address)}${esc(cust.email)}`;
  const paid = `Betaald op ${esc(dateNl(d.paidOn ?? d.date))}${d.method ? ` via ${esc(d.method)}` : ""}. Je hoeft niets meer te betalen.`;
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factuur ${esc(d.number)}</title>
<style>
  :root { --ink:#1c2430; --muted:#5b6675; --line:#d9dee5; --bg:#ffffff; --page:#f2f4f7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .sheet { background:var(--bg); max-width:210mm; min-height:297mm; margin:24px auto; padding:18mm 16mm; box-shadow:0 1px 4px rgba(0,0,0,.12); }
  header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:12mm; }
  h1 { font-size:30px; margin:0 0 4px; letter-spacing:.5px; }
  .muted { color:var(--muted); }
  .seller { text-align:right; }
  .parties { display:flex; justify-content:space-between; gap:24px; margin-bottom:10mm; }
  .label { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); margin-bottom:4px; }
  table { width:100%; border-collapse:collapse; }
  .meta td { padding:2px 12px 2px 0; }
  .lines th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); border-bottom:2px solid var(--ink); padding:6px 0; }
  .lines td { padding:10px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .num { text-align:right; white-space:nowrap; }
  .totals { width:auto; margin-left:auto; margin-top:6mm; min-width:70mm; }
  .totals td { padding:4px 0 4px 16px; }
  .totals tr.total td { border-top:2px solid var(--ink); font-weight:700; font-size:17px; padding-top:8px; }
  .paid { margin-top:10mm; padding:10px 14px; border-left:4px solid #2e7d4f; background:#eef7f1; }
  .warn { display:inline-block; padding:6px 10px; background:#fff4e5; border:1px solid #f0b46a; color:#7a4100; }
  .print { position:fixed; right:16px; bottom:16px; font:inherit; padding:10px 16px; border-radius:8px; border:0; background:#1c2430; color:#fff; cursor:pointer; }
  @media (max-width:600px) { .sheet { margin:0; padding:20px 16px; min-height:0; box-shadow:none; } header, .parties { flex-direction:column; } .seller { text-align:left; } }
  @page { size:A4; margin:16mm; }
  @media print { body { background:#fff; } .sheet { margin:0; padding:0; box-shadow:none; max-width:none; min-height:0; } .print { display:none; } .paid { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style></head>
<body><main class="sheet">
<header>
  <div><h1>Factuur</h1><div class="muted">${esc(d.number)}</div></div>
  <div class="seller">${seller}</div>
</header>
<section class="parties">
  <div><div class="label">Aan</div>${customer}</div>
  <table class="meta" style="width:auto">
    <tr><td class="muted">Factuurnummer</td><td>${esc(d.number)}</td></tr>
    <tr><td class="muted">Factuurdatum</td><td>${esc(dateNl(d.date))}</td></tr>
    <tr><td class="muted">Bestelling</td><td>${esc(d.orderId)}</td></tr>
  </table>
</section>
<table class="lines">
  <thead><tr><th>Omschrijving</th><th class="num">Bedrag excl. btw</th></tr></thead>
  <tbody><tr><td>${esc(d.description)}${d.period ? `<br><span class="muted">${esc(d.period)}</span>` : ""}</td><td class="num">${euro(d.amountExcl)}</td></tr></tbody>
</table>
<table class="totals">
  <tr><td>Totaal excl. btw</td><td class="num">${euro(d.amountExcl)}</td></tr>
  <tr><td>Btw ${pct(d.vatPercent)}</td><td class="num">${euro(d.vatAmount)}</td></tr>
  <tr class="total"><td>Totaal incl. btw</td><td class="num">${euro(d.amountIncl)}</td></tr>
</table>
<p class="paid">${paid}</p>
</main>
<button class="print" onclick="window.print()">Afdrukken</button>
</body></html>`;
}
