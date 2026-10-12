import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { seal, open } from "../cluster/crypto.js";

export type OrderStatus = "awaiting_payment" | "paid" | "provisioning" | "ready" | "failed" | "payment_problem" | "cancelled" | "suspended";
/** sub = gratis adres onder de zone van de dienst (naam.<BROKER_FREE_ZONE>). */
export type DomainMode = "register" | "transfer" | "own" | "sub";

export interface OrderRow {
  id: string;
  customer_id: string;
  bundle: string;
  domain: string;
  domain_mode: DomainMode;
  status: OrderStatus;
  error: string | null;
  amount: string;
  /** Versleuteld: registrant + autorisatiecode. */
  input_enc: Buffer | null;
  mollie_payment_id: string | null;
  mollie_subscription_id: string | null;
  subscription_start: string | null;
  /** Niet-geheime id's van aangemaakte onderdelen (JSON). */
  state: string;
  /** Versleuteld: API-sleutel, DNS-token (JSON). */
  secrets_enc: Buffer | null;
  /** Versleuteld: het pakket voor de console. */
  kit_enc: Buffer | null;
  dns_token_hash: string | null;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  paid_at: number | null;
  cancelled_at: number | null;
  ends_at: string | null;
  /** Extra gebruikers bovenop de bundel (gekocht door de klant). */
  extra_users: number;
  /** Uitnodigingscode waarmee besteld is. */
  invite_code: string | null;
}

/** Soort betaling: eerste betaling, maandelijkse incasso, betaalmethode wijzigen (€ 0,01) of achterstand betalen. */
export type PaymentKind = "first" | "recurring" | "mandate" | "settle" | "other";

export interface PaymentRow {
  id: string; order_id: string; status: string; sequence_type: string | null; subscription_id: string | null;
  amount: string | null; updated_at: number; kind: PaymentKind | null; method: string | null; description: string | null;
  created_at: number | null; paid_at: number | null; period_start: string | null;
  /** Bij een betaling van een achterstand: JSON-lijst met de mislukte incasso's die ermee betaald worden. */
  covers: string | null;
  /** Bij een mislukte incasso: de betaling waarmee hij alsnog betaald is. */
  settled_by: string | null;
  /** Bijwerkingen (bijv. machtiging omzetten) zijn uitgevoerd. */
  done_at: number | null;
}

export interface CustomerRow { id: string; email: string; mollie_customer_id: string | null; created_at: number }

export function openDb(dataDir: string) {
  const db = new Database(path.join(dataDir, "dienst.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, mollie_customer_id TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), bundle TEXT NOT NULL, domain TEXT NOT NULL,
      domain_mode TEXT NOT NULL, status TEXT NOT NULL, error TEXT, amount TEXT NOT NULL, input_enc BLOB,
      mollie_payment_id TEXT, mollie_subscription_id TEXT, subscription_start TEXT,
      state TEXT NOT NULL DEFAULT '{}', secrets_enc BLOB, kit_enc BLOB, dns_token_hash TEXT UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, paid_at INTEGER, cancelled_at INTEGER, ends_at TEXT);
    CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS orders_domain ON orders(domain);
    CREATE TABLE IF NOT EXISTS steps (
      order_id TEXT NOT NULL REFERENCES orders(id), id TEXT NOT NULL, pos INTEGER NOT NULL, label TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (order_id, id));
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL, sequence_type TEXT, subscription_id TEXT,
      amount TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, kind TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, year INTEGER NOT NULL, seq INTEGER NOT NULL,
      order_id TEXT NOT NULL, customer_id TEXT NOT NULL, payment_id TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL, amount TEXT NOT NULL, data_enc BLOB NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (year, seq));
    CREATE INDEX IF NOT EXISTS invoices_order ON invoices(order_id);
  `);
  // Nieuwere kolommen bij een bestaande database.
  const cols = new Set((db.prepare("PRAGMA table_info(payments)").all() as { name: string }[]).map((c) => c.name));
  const add: [string, string][] = [
    ["kind", "TEXT"], ["method", "TEXT"], ["description", "TEXT"], ["created_at", "INTEGER"], ["paid_at", "INTEGER"],
    ["period_start", "TEXT"], ["covers", "TEXT"], ["settled_by", "TEXT"], ["done_at", "INTEGER"],
  ];
  const fresh = !cols.has("kind");
  for (const [name, type] of add) if (!cols.has(name)) db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${type}`);
  if (fresh) db.exec("UPDATE payments SET kind = CASE WHEN subscription_id IS NOT NULL THEN 'recurring' ELSE 'first' END, created_at = COALESCE(created_at, updated_at) WHERE kind IS NULL");
  const orderCols = new Set((db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name));
  if (!orderCols.has("extra_users")) db.exec("ALTER TABLE orders ADD COLUMN extra_users INTEGER NOT NULL DEFAULT 0");
  if (!orderCols.has("invite_code")) db.exec("ALTER TABLE orders ADD COLUMN invite_code TEXT");
  // Aanbieder: medewerkers, instellingen, uitnodigingen, hulpvragen, berichten, gezondheid, terugbetalingen.
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL,
      totp_enc BLOB, totp_pending_enc BLOB, totp_last_step INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE IF NOT EXISTS staff_keys (
      id TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE, public_key TEXT NOT NULL,
      label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
    CREATE TABLE IF NOT EXISTS staff_sessions (
      token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS staff_pending (
      token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      challenge TEXT, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, staff_id TEXT, staff_email TEXT,
      action TEXT NOT NULL, target TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY, label TEXT, bundle TEXT, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), order_id TEXT, subject TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS tickets_customer ON tickets(customer_id);
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id), author TEXT NOT NULL,
      staff_id TEXT, body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, severity TEXT NOT NULL,
      starts_at INTEGER, ends_at INTEGER, order_ids TEXT, auto INTEGER NOT NULL DEFAULT 0,
      created_by TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS health (
      order_id TEXT PRIMARY KEY REFERENCES orders(id), reported_at INTEGER NOT NULL, version TEXT, healthy INTEGER NOT NULL,
      problems TEXT NOT NULL, storage_used_bytes INTEGER, users INTEGER, nodes TEXT NOT NULL,
      unhealthy_since INTEGER, flagged_at INTEGER, flag_reason TEXT, announcement_id TEXT);
    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, order_id TEXT NOT NULL, amount TEXT NOT NULL, status TEXT,
      description TEXT, staff_id TEXT, created_at INTEGER NOT NULL);
  `);
  // Voorwaarden, privacyverklaring en verwerkersovereenkomst (src/broker/juridisch.ts): elke keer opslaan is een nieuwe
  // versie; de hoogste versie is gepubliceerd. Gaat vanzelf mee in de back-up (zelfde database).
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_docs (
      kind TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
      created_by TEXT, announcement_id TEXT, PRIMARY KEY (kind, version));
  `);
  if (!(db.prepare("PRAGMA table_info(health)").all() as { name: string }[]).some((c) => c.name === "recovery"))
    db.exec("ALTER TABLE health ADD COLUMN recovery TEXT NOT NULL DEFAULT '{}'");
  return db;
}

export type Db = ReturnType<typeof openDb>;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class Secrets {
  constructor(private key: Buffer) {}
  seal(obj: unknown, aad: string): Buffer { return seal(this.key, JSON.stringify(obj), aad); }
  open<T>(buf: Buffer | null, aad: string): T | null { return buf ? JSON.parse(open(this.key, buf, aad).toString("utf8")) : null; }
  hmac(s: string) { return crypto.createHmac("sha256", this.key).update(s).digest("hex"); }
}

/** Instelling (JSON) uit de database, of null. */
export function getSetting<T>(db: Db, key: string): T | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : null;
}
export function setSetting(db: Db, key: string, value: unknown) {
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, JSON.stringify(value), Date.now());
}

export function event(db: Db, orderId: string | null, kind: string, detail?: unknown) {
  db.prepare("INSERT INTO events (order_id, kind, detail, at) VALUES (?, ?, ?, ?)").run(orderId, kind, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail), Date.now());
}

export const getOrder = (db: Db, id: string) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
export const getCustomer = (db: Db, id: string) => db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as CustomerRow | undefined;

export function orderState<T = Record<string, any>>(o: OrderRow): T { return JSON.parse(o.state || "{}"); }

export function patchState(db: Db, id: string, patch: Record<string, unknown>) {
  const o = getOrder(db, id)!;
  const s = { ...orderState(o), ...patch };
  db.prepare("UPDATE orders SET state = ? WHERE id = ?").run(JSON.stringify(s), id);
  return s;
}

export function setStatus(db: Db, id: string, status: OrderStatus, error: string | null = null) {
  db.prepare("UPDATE orders SET status = ?, error = ? WHERE id = ?").run(status, error, id);
}
