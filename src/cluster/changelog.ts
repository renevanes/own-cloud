import type Database from "better-sqlite3";

type DB = Database.Database;

/**
 * Logische replicatie op SQLite-niveau.
 *
 * - Elke wijziging in een gebruikerstabel wordt door triggers vastgelegd in _changelog (seq, term, ts, tabel, op, data).
 * - Fencing: schrijven mag alleen als _repl_meta.lease_until in de toekomst ligt (tijd-gebaseerd, in SQL zelf).
 *   Een node die zijn leiderschap kwijt is — ook als hij een tijd bevroren was — kan dus nooit meer schrijven,
 *   ook niet via een ander proces (import-CLI, set-password) op dezelfde database.
 * - Volgers passen entries toe met applying=1; dan vuren de capture- en fence-triggers niet.
 */

export interface Entry {
  seq: number;
  term: number;
  ts: number;
  tbl: string;
  op: "I" | "U" | "D";
  data: string; // JSON
}

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
/** Lokale tabellen die niet gerepliceerd worden. */
const LOCAL = new Set(["blob_queue"]);

interface TableInfo { name: string; cols: string[]; pk: string[] }
const infoCache = new WeakMap<DB, Map<string, TableInfo>>();

export function replicatedTables(db: DB): TableInfo[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith("_") && !n.startsWith("sqlite_") && !n.includes("_fts") && !LOCAL.has(n));
  return names.map((name) => tableInfo(db, name));
}

function tableInfo(db: DB, name: string): TableInfo {
  let cache = infoCache.get(db);
  if (!cache) infoCache.set(db, (cache = new Map()));
  let t = cache.get(name);
  if (!t) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[];
    if (!cols.length) throw new Error(`Onbekende tabel ${name}`);
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    if (!pk.length) throw new Error(`Tabel ${name} heeft geen primaire sleutel en kan niet gerepliceerd worden`);
    t = { name, cols: cols.map((c) => c.name), pk };
    cache.set(name, t);
  }
  return t;
}

export function installReplication(db: DB) {
  db.pragma("recursive_triggers = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      seq  INTEGER PRIMARY KEY AUTOINCREMENT,
      term INTEGER NOT NULL,
      ts   INTEGER NOT NULL,
      tbl  TEXT NOT NULL,
      op   TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _repl_meta (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      term        INTEGER NOT NULL DEFAULT 0,  -- term van de huidige leider (voor nieuwe entries)
      applying    INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,  -- unix ms; daarna is schrijven geblokkeerd
      last_term   INTEGER NOT NULL DEFAULT 0   -- term van de laatste entry (als _changelog leeg is)
    );
    INSERT OR IGNORE INTO _repl_meta (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS blob_queue (rel TEXT PRIMARY KEY, added INTEGER NOT NULL);
  `);

  const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_r%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name);
  const sql: string[] = existing.map((n) => `DROP TRIGGER IF EXISTS "${n}";`);
  const notApplying = "(SELECT applying FROM _repl_meta WHERE id = 1) = 0";
  for (const t of replicatedTables(db)) {
    const obj = (alias: string, cols: string[]) => `json_object(${cols.map((c) => `'${c}', ${alias}."${c}"`).join(", ")})`;
    for (const ev of ["INSERT", "UPDATE", "DELETE"]) {
      sql.push(`CREATE TRIGGER "_rf_${t.name}_${ev[0]}" BEFORE ${ev} ON "${t.name}"
        WHEN ${notApplying} AND (SELECT lease_until FROM _repl_meta WHERE id = 1) <= ${NOW_MS}
        BEGIN SELECT RAISE(ABORT, 'NOT_LEADER: deze node mag nu niet schrijven'); END;`);
    }
    const capture = (ev: string, op: string, data: string) =>
      `CREATE TRIGGER "_rc_${t.name}_${op}" AFTER ${ev} ON "${t.name}" WHEN ${notApplying}
        BEGIN INSERT INTO _changelog (term, ts, tbl, op, data)
        VALUES ((SELECT term FROM _repl_meta WHERE id = 1), ${NOW_MS}, '${t.name}', '${op}', ${data}); END;`;
    sql.push(capture("INSERT", "I", obj("NEW", t.cols)));
    sql.push(capture("UPDATE", "U", obj("NEW", t.cols)));
    sql.push(capture("DELETE", "D", obj("OLD", t.pk)));
  }
  db.exec(sql.join("\n"));
  infoCache.delete(db);
}

export function removeReplicationTriggers(db: DB) {
  const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_r%' ESCAPE '\\'").all() as { name: string }[]).map((r) => r.name);
  db.exec(existing.map((n) => `DROP TRIGGER IF EXISTS "${n}";`).join("\n"));
}

// ───────── Status ─────────

export function lastSeq(db: DB): number {
  const r = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_changelog'").get() as { seq: number } | undefined;
  return r?.seq ?? 0;
}

export function lastSeqTerm(db: DB): { seq: number; term: number } {
  const seq = lastSeq(db);
  const t = db.prepare("SELECT term FROM _changelog WHERE seq = ?").get(seq) as { term: number } | undefined;
  return { seq, term: t?.term ?? (db.prepare("SELECT last_term FROM _repl_meta WHERE id = 1").get() as { last_term: number }).last_term };
}

export function termAt(db: DB, seq: number): number | null {
  if (seq === 0) return 0;
  const r = db.prepare("SELECT term FROM _changelog WHERE seq = ?").get(seq) as { term: number } | undefined;
  if (r) return r.term;
  const last = lastSeqTerm(db);
  return seq === last.seq ? last.term : null;
}

export function firstSeq(db: DB): number {
  const r = db.prepare("SELECT MIN(seq) AS s FROM _changelog").get() as { s: number | null };
  return r.s ?? lastSeq(db) + 1;
}

export function entriesAfter(db: DB, after: number, maxCount = 500, maxBytes = 8 * 1024 * 1024): Entry[] {
  const rows = db.prepare("SELECT seq, term, ts, tbl, op, data FROM _changelog WHERE seq > ? ORDER BY seq LIMIT ?").all(after, maxCount) as Entry[];
  let bytes = 0;
  const out: Entry[] = [];
  for (const r of rows) {
    bytes += r.data.length;
    if (out.length && bytes > maxBytes) break;
    out.push(r);
  }
  return out;
}

export function setTerm(db: DB, term: number) {
  db.prepare("UPDATE _repl_meta SET term = ? WHERE id = 1").run(term);
}
export function setLease(db: DB, until: number) {
  db.prepare("UPDATE _repl_meta SET lease_until = ? WHERE id = 1").run(Math.floor(until));
}
export function getLease(db: DB): number {
  return (db.prepare("SELECT lease_until FROM _repl_meta WHERE id = 1").get() as { lease_until: number }).lease_until;
}

/** Zorgt dat nieuwe lokale entries na `seq` doornummeren (na herstel of bij leiderwissel). */
export function ensureSequence(db: DB, seq: number) {
  const cur = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_changelog'").get() as { seq: number } | undefined;
  if (!cur) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('_changelog', ?)").run(seq);
  else if (cur.seq < seq) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = '_changelog'").run(seq);
}

/** Verwijdert oude entries, maar houdt altijd de laatste (voor term-informatie). */
export function trim(db: DB, belowSeq: number) {
  const last = lastSeqTerm(db);
  db.prepare("DELETE FROM _changelog WHERE seq < ? AND seq < ?").run(belowSeq, last.seq);
  db.prepare("UPDATE _repl_meta SET last_term = ? WHERE id = 1").run(last.term);
}

// ───────── Toepassen ─────────

const stmtCache = new WeakMap<DB, Map<string, Database.Statement>>();
function stmt(db: DB, sql: string) {
  let m = stmtCache.get(db);
  if (!m) stmtCache.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

function applyOne(db: DB, e: Entry) {
  const t = tableInfo(db, e.tbl);
  const data = JSON.parse(e.data) as Record<string, unknown>;
  const pkWhere = t.pk.map((c) => `"${c}" = ?`).join(" AND ");
  const pkVals = t.pk.map((c) => data[c] as unknown);
  if (e.op === "D") {
    stmt(db, `DELETE FROM "${t.name}" WHERE ${pkWhere}`).run(...(pkVals as never[]));
    return;
  }
  const cols = t.cols.filter((c) => c in data);
  const vals = cols.map((c) => data[c]);
  const nonPk = cols.filter((c) => !t.pk.includes(c));
  if (e.op === "I") {
    const upd = nonPk.length ? `DO UPDATE SET ${nonPk.map((c) => `"${c}" = excluded."${c}"`).join(", ")}` : "DO NOTHING";
    stmt(db, `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
      ON CONFLICT (${t.pk.map((c) => `"${c}"`).join(", ")}) ${upd}`).run(...(vals as never[]));
  } else {
    if (!nonPk.length) return;
    stmt(db, `UPDATE "${t.name}" SET ${nonPk.map((c) => `"${c}" = ?`).join(", ")} WHERE ${pkWhere}`)
      .run(...(nonPk.map((c) => data[c]) as never[]), ...(pkVals as never[]));
  }
}

export class ConflictError extends Error {}

/**
 * Past entries toe die direct op de lokale log aansluiten. Entries die al toegepast zijn (zelfde seq en term) worden overgeslagen.
 * Gooit ConflictError als de lokale log afwijkt (bijv. een oud-leider met niet-gerepliceerde schrijfacties).
 * Geeft de nieuwe laatste seq terug.
 */
export function applyEntries(db: DB, prevSeq: number, prevTerm: number, entries: Entry[], onApplied?: (e: Entry) => void): number {
  const last = lastSeqTerm(db);
  if (prevSeq > last.seq) return -1; // gat: leider moet eerder beginnen
  const localPrevTerm = termAt(db, prevSeq);
  if (localPrevTerm !== null && localPrevTerm !== prevTerm) throw new ConflictError(`Log wijkt af op seq ${prevSeq}`);
  // Alles wat we lokaal hebben na prevSeq moet gelijk zijn aan wat de leider stuurt.
  if (last.seq > prevSeq) {
    const incoming = new Map(entries.map((e) => [e.seq, e.term]));
    for (let s = prevSeq + 1; s <= last.seq; s++) {
      const lt = termAt(db, s);
      if (lt === null) continue;
      if (incoming.get(s) !== lt) throw new ConflictError(`Lokale entry ${s} (term ${lt}) komt niet overeen met de leider`);
    }
  }
  const fresh = entries.filter((e) => e.seq > last.seq);
  if (!fresh.length) return last.seq;
  if (fresh[0].seq !== last.seq + 1) return -1;

  const insertLog = stmt(db, "INSERT INTO _changelog (seq, term, ts, tbl, op, data) VALUES (?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("UPDATE _repl_meta SET applying = 1 WHERE id = 1").run();
    try {
      for (const e of fresh) {
        applyOne(db, e);
        insertLog.run(e.seq, e.term, e.ts, e.tbl, e.op, e.data);
      }
    } finally {
      db.prepare("UPDATE _repl_meta SET applying = 0, last_term = ? WHERE id = 1").run(fresh[fresh.length - 1].term);
    }
  })();
  if (onApplied) for (const e of fresh) onApplied(e);
  return fresh[fresh.length - 1].seq;
}

/** Kolommen die naar bestanden in DATA_DIR verwijzen (om ontbrekende bestanden op te halen). */
export const BLOB_COLUMNS: Record<string, string[]> = {
  messages: ["raw_path"],
  attachments: ["path"],
  photos: ["path", "thumb_path"],
  mail_outbox: ["raw_path"],
  import_chunks: ["path"],
};

export function blobRefs(e: Entry): string[] {
  const cols = BLOB_COLUMNS[e.tbl];
  if (!cols || e.op === "D") return [];
  const d = JSON.parse(e.data) as Record<string, unknown>;
  return cols.map((c) => d[c]).filter((v): v is string => typeof v === "string" && !v.startsWith("/"));
}
