/**
 * Back-up van de Dienst zelf (voor een Dienst die vanuit de app is opgezet, maar ook bruikbaar met Docker):
 * elk uur een online kopie van de database (SQLite backup-API) plus `aanbieder.key` en `bundles.json`, versleuteld
 * met een sleutel afgeleid van BROKER_SECRET, naar een eigen S3-bucket (BROKER_BACKUP_*). Start de Dienst met een
 * lege datamap, dan zet hij eerst de nieuwste back-up terug. Zie BROKER.md, "Back-up van de Dienst".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type Database from "better-sqlite3";
import { decryptBuffer, deriveKey, encryptBuffer } from "../cluster/crypto.js";
import { S3Store, type ObjectStore } from "../cluster/stores.js";

export interface BackupTarget { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string }

const PREFIX = "dienst/";
/** Bestanden uit de datamap die naast de database meegaan (als ze er zijn). */
const EXTRA_FILES = ["aanbieder.key", "bundles.json"];

/** Uit de omgeving; null als er geen back-up is ingesteld. */
export function backupTarget(env: NodeJS.ProcessEnv): BackupTarget | null {
  const t = { endpoint: env.BROKER_BACKUP_ENDPOINT ?? "", region: env.BROKER_BACKUP_REGION || "fr-par", bucket: env.BROKER_BACKUP_BUCKET ?? "", accessKey: env.BROKER_BACKUP_ACCESS_KEY ?? "", secretKey: env.BROKER_BACKUP_SECRET_KEY ?? "" };
  if (!t.endpoint && !t.bucket) return null;
  if (!/^https?:\/\//.test(t.endpoint) || !t.bucket || !t.accessKey || !t.secretKey) throw new Error("BROKER_BACKUP_ENDPOINT, _BUCKET, _ACCESS_KEY en _SECRET_KEY horen bij elkaar");
  return t;
}

/** Sleutel voor de back-ups, afgeleid van BROKER_SECRET (de console van de aanbieder kent die ook). */
export const backupKey = (secret: Buffer) => deriveKey(secret, "dienst-backup");
/** Token waarmee de console van de aanbieder de Dienst laat overdragen (laatste back-up, daarna niets meer schrijven). */
export const beheerToken = (secret: Buffer) => deriveKey(secret, "dienst-beheer").toString("hex");

export function backupStore(t: BackupTarget): ObjectStore {
  return new S3Store({ name: "dienst-backup", type: "s3", purpose: "backup", endpoint: t.endpoint, region: t.region, bucket: t.bucket, accessKey: t.accessKey, secretKey: t.secretKey });
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
/** "dienst/20261011T120000Z-ab12.enc" → tijdstip in ms (of NaN). */
export function backupTime(key: string) {
  const m = /^dienst\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Eén back-up maken en wegschrijven. `adressenDb`: de database van de adressendienst op dezelfde server
 * (BROKER_BACKUP_ADRESSEN); die gaat als "adressen.sqlite" mee, ook via de online back-up van SQLite.
 */
export async function makeBackup(db: Database.Database, dataDir: string, store: ObjectStore, key: Buffer, now = Date.now(), adressenDb: string | null = null) {
  const tmp = path.join(dataDir, `.backup-${crypto.randomBytes(4).toString("hex")}.sqlite`);
  const tmpA = `${tmp}.adressen`;
  try {
    await db.backup(tmp);
    const files: Record<string, string> = { "dienst.sqlite": fs.readFileSync(tmp).toString("base64") };
    for (const f of EXTRA_FILES) {
      const p = path.join(dataDir, f);
      if (fs.existsSync(p)) files[f] = fs.readFileSync(p).toString("base64");
    }
    if (adressenDb && fs.existsSync(adressenDb)) {
      const { default: Sqlite } = await import("better-sqlite3");
      const adb = new Sqlite(adressenDb, { fileMustExist: true });
      try { await adb.backup(tmpA); } finally { adb.close(); }
      files["adressen.sqlite"] = fs.readFileSync(tmpA).toString("base64");
    }
    const packed = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, at: now, files })));
    const name = `${PREFIX}${stamp(now)}-${crypto.randomBytes(2).toString("hex")}.enc`;
    await store.put(name, await encryptBuffer(key, packed));
    return { name, at: now };
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmpA, { force: true });
  }
}

export async function latestBackup(store: ObjectStore): Promise<{ key: string; at: number } | null> {
  const list = (await store.list(PREFIX)).map((o) => ({ key: o.key, at: backupTime(o.key) })).filter((o) => Number.isFinite(o.at));
  list.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return list.at(-1) ?? null;
}

/**
 * De nieuwste back-up in een (lege) datamap zetten; "adressen.sqlite" naar `adressenDb` (als die er is). dienst.sqlite
 * komt als laatste: de adressendienst op dezelfde server wacht daarop (ADRES_WACHT_OP) voordat hij start.
 */
export async function restoreLatest(store: ObjectStore, key: Buffer, dataDir: string, adressenDb: string | null = null) {
  const last = await latestBackup(store);
  if (!last) return null;
  const buf = await store.getBuffer(last.key);
  if (!buf) return null;
  const pack = JSON.parse(zlib.gunzipSync(await decryptBuffer(key, buf)).toString("utf8")) as { v: number; at: number; files: Record<string, string> };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = (name: string) => (name === "dienst.sqlite" || EXTRA_FILES.includes(name) ? path.join(dataDir, name) : name === "adressen.sqlite" && adressenDb ? adressenDb : null);
  const names = Object.keys(pack.files).sort((a, b) => Number(a === "dienst.sqlite") - Number(b === "dienst.sqlite"));
  for (const name of names) {
    const to = target(name);
    if (!to) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    const tmp = `${to}.herstel`;
    fs.writeFileSync(tmp, Buffer.from(pack.files[name], "base64"), { mode: 0o600 });
    fs.renameSync(tmp, to);
  }
  return { name: last.key, at: pack.at };
}

/** Bewaren: alles van de laatste 48 uur, daarna de nieuwste per dag tot 30 dagen. De rest gaat weg. */
export function toPrune(keys: string[], now = Date.now()) {
  const items = keys.map((k) => ({ k, at: backupTime(k) })).filter((x) => Number.isFinite(x.at)).sort((a, b) => b.at - a.at);
  const days = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    const age = now - x.at;
    if (age < 48 * 3600_000) continue;
    const day = new Date(x.at).toISOString().slice(0, 10);
    if (age < 30 * 86400_000 && !days.has(day)) { days.add(day); continue; }
    out.push(x.k);
  }
  return out;
}

/** Bij het starten met een lege datamap: de nieuwste back-up terugzetten (vóór loadConfig, dat anders een nieuwe sleutel maakt). */
export async function restoreIfEmpty(env: NodeJS.ProcessEnv) {
  const target = backupTarget(env);
  if (!target) return null;
  const dataDir = path.resolve(env.BROKER_DATA_DIR || "./data-dienst");
  if (fs.existsSync(path.join(dataDir, "dienst.sqlite"))) return null;
  const secret = secretOf(env);
  if (!secret) throw new Error("Back-up terugzetten kan alleen met BROKER_SECRET");
  return restoreLatest(backupStore(target), backupKey(secret), dataDir, env.BROKER_BACKUP_ADRESSEN || null);
}

export function secretOf(env: NodeJS.ProcessEnv): Buffer | null {
  if (!env.BROKER_SECRET) return null;
  const k = Buffer.from(env.BROKER_SECRET.trim(), "hex");
  return k.length === 32 ? k : null;
}

/** De lopende back-ups van één Dienst. */
export class DienstBackup {
  lastBackupAt: number | null = null;
  failing = false;
  /** Na het overdragen: geen back-ups meer (een nieuwe server neemt het over). */
  retired = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly store: ObjectStore;
  private readonly key: Buffer;

  constructor(target: BackupTarget, secret: Buffer, private db: Database.Database, private dataDir: string, private everyMs: number, private adressenDb: string | null = null) {
    this.store = backupStore(target);
    this.key = backupKey(secret);
  }

  started = false;

  /** Meteen een back-up, daarna elke everyMs. */
  start() {
    if (this.retired) return;
    this.started = true;
    void this.run().catch(() => {});
    this.timer = setInterval(() => void this.run().catch(() => {}), this.everyMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Nu een back-up (wacht op een lopende). */
  async run() {
    if (this.retired) return null;
    if (this.running) await this.running.catch(() => {});
    const p = (async () => {
      try {
        const r = await makeBackup(this.db, this.dataDir, this.store, this.key, Date.now(), this.adressenDb);
        this.lastBackupAt = r.at;
        this.failing = false;
        const old = toPrune((await this.store.list(PREFIX)).map((o) => o.key));
        for (const k of old) await this.store.delete(k).catch(() => {});
        return r;
      } catch (e) {
        this.failing = true;
        console.error(`[dienst] back-up mislukt: ${(e as Error).message}`);
        throw e;
      }
    })();
    this.running = p;
    try { return await p; } finally { if (this.running === p) this.running = null; }
  }

  /** Laatste back-up, daarna niets meer: de server wordt vervangen of verwijderd. */
  async handover() {
    this.stop();
    const r = await this.run();
    this.retired = true;
    return r;
  }

  status(): "aan" | "fout" { return this.failing ? "fout" : "aan"; }
}
