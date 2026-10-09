import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { seal, open } from "../cluster/crypto.js";

export type OrderStatus = "awaiting_payment" | "paid" | "provisioning" | "ready" | "failed" | "payment_problem" | "cancelled" | "suspended";
export type DomainMode = "register" | "transfer" | "own";

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
  `);
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
