import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, getSetting } from "./db.js";
import { config } from "./config.js";
import { storageUsage } from "./users.js";

const pools = new Map<string, { active: number; waiting: (() => void)[] }>();
export async function boundedWork<T>(name: string, limit: number, fn: () => Promise<T>, maxWaiting = 32): Promise<T> {
  let pool = pools.get(name);
  if (!pool) pools.set(name, (pool = { active: 0, waiting: [] }));
  if (pool.active >= limit) {
    if (pool.waiting.length >= maxWaiting) throw Object.assign(new Error("Er is veel werk tegelijk. Probeer het later opnieuw."), { statusCode: 429 });
    await new Promise<void>((resolve) => pool!.waiting.push(resolve));
  } else pool.active++;
  try { return await fn(); } finally {
    const next = pool.waiting.shift();
    if (next) next(); else pool.active--;
  }
}

export function reserveSpace(userId: number, bytes: number, lifetimeMs = 30 * 60_000, existingData = false) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Object.assign(new Error("Ongeldige bestandsgrootte"), { statusCode: 400 });
  const id = crypto.randomUUID();
  const resize = db.transaction((amount: number) => {
    if (!Number.isSafeInteger(amount) || amount < 0) throw Object.assign(new Error("Ongeldige bestandsgrootte"), { statusCode: 400 });
    db.prepare("DELETE FROM _resource_reservations WHERE expires < ?").run(Date.now());
    const total = (db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM _resource_reservations WHERE id<>?").get(id) as { n: number }).n;
    const mine = (db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM _resource_reservations WHERE user_id=? AND id<>?").get(userId, id) as { n: number }).n;
    const disk = fs.statfsSync(config.dataDir);
    const free = disk.bavail * disk.bsize;
    const quota = Number(getSetting(`storage_limit:${userId}`) ?? getSetting("storage_limit_bytes") ?? 0);
    if (amount + total + 64 * 1024 * 1024 > free || (!existingData && quota > 0 && (storageUsage().get(userId)?.total ?? 0) + mine + amount > quota)) {
      throw Object.assign(new Error("Niet genoeg vrije opslagruimte voor dit bestand"), { statusCode: 507 });
    }
    db.prepare("INSERT INTO _resource_reservations VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,expires=excluded.expires").run(id, userId, amount, Date.now() + lifetimeMs);
  });
  resize(bytes);
  return Object.assign(() => db.prepare("DELETE FROM _resource_reservations WHERE id=?").run(id), { resize });
}

export function fsyncFile(file: string) {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let directory = path.dirname(file);
  const inside = !path.relative(config.dataDir, directory).startsWith("..");
  for (;;) {
    const dir = fs.openSync(directory, "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    if (!inside || directory === config.dataDir || directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
}
