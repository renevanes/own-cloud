import type { BrokerConfig, Bundle } from "./config.js";
import type { Apis } from "./apis.js";
import type { Mailer } from "./mail.js";
import { type Db, type OrderRow, Secrets } from "./db.js";

export interface Ctx {
  cfg: BrokerConfig;
  db: Db;
  secrets: Secrets;
  apis: Apis;
  mail: Mailer;
  /** Achtergrondwerk bijhouden (zodat tests en afsluiten erop kunnen wachten). */
  track(p: Promise<unknown>): void;
}

export interface StepView { id: string; label: string; state: "wait" | "busy" | "done" | "fail"; detail?: string }

export function bundleOf(ctx: Ctx, id: string): Bundle | undefined { return ctx.cfg.bundles.find((b) => b.id === id); }

const STEP_LABELS = (mode: OrderRow["domain_mode"]): [string, string][] => [
  ["payment", "Betaling"],
  ["dns-zone", "DNS-zone aanmaken"],
  ["domain", mode === "register" ? "Domeinnaam registreren" : mode === "transfer" ? "Domeinnaam verhuizen" : "Je eigen domeinnaam koppelen"],
  ["scaleway-project", "Eigen project bij Scaleway"],
  ["scaleway-iam", "Toegangssleutel voor jouw servers"],
  ["mail", "Mail versturen instellen"],
  ["dns-token", "Toegang tot je DNS"],
  ["ready", "Klaar om te starten"],
];

export function initSteps(db: Db, orderId: string, mode: OrderRow["domain_mode"]) {
  const ins = db.prepare("INSERT OR IGNORE INTO steps (order_id, id, pos, label, state, updated_at) VALUES (?, ?, ?, ?, 'wait', ?)");
  STEP_LABELS(mode).forEach(([id, label], i) => ins.run(orderId, id, i, label, Date.now()));
}

export function setStep(db: Db, orderId: string, id: string, state: StepView["state"], detail?: string | null) {
  db.prepare("UPDATE steps SET state = ?, detail = ?, updated_at = ? WHERE order_id = ? AND id = ?").run(state, detail ?? null, Date.now(), orderId, id);
}

export function getSteps(db: Db, orderId: string): StepView[] {
  return (db.prepare("SELECT id, label, state, detail FROM steps WHERE order_id = ? ORDER BY pos").all(orderId) as StepView[])
    .map((s) => (s.detail ? s : { id: s.id, label: s.label, state: s.state }));
}

// Eén ding tegelijk per bestelling: webhook, achtergrondlus en CLI lopen elkaar dan niet voor de voeten.
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

/** Datum (JJJJ-MM-DD) in Nederlandse tijd. */
export function todayNl(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Zelfde dag n maanden later; bestaat die dag niet (31 jan → feb), dan de laatste dag van die maand. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Tot wanneer is er betaald? De eerstvolgende incassodatum na vandaag (start + k maanden). */
export function paidThrough(subscriptionStart: string | null, today = todayNl()): string {
  if (!subscriptionStart) return today;
  let k = 0;
  while (addMonths(subscriptionStart, k) <= today && k < 1200) k++;
  return addMonths(subscriptionStart, k);
}
