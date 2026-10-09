import Database from "better-sqlite3";
import { paths } from "./config.js";

export const db = new Database(paths.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ───────────── Mail ─────────────
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  message_id    TEXT,                 -- Message-ID header (dedup bij import)
  thread_key    TEXT,                 -- voor gesprekweergave
  folder        TEXT NOT NULL DEFAULT 'inbox', -- inbox | sent | archive | trash | spam | drafts
  labels        TEXT NOT NULL DEFAULT '[]',     -- JSON-array (Gmail-labels bij import)
  from_addr     TEXT,
  from_name     TEXT,
  to_addrs      TEXT,                 -- JSON
  cc_addrs      TEXT,                 -- JSON
  subject       TEXT,
  snippet       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  date          INTEGER NOT NULL,     -- unix ms
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_starred    INTEGER NOT NULL DEFAULT 0,
  raw_path      TEXT,                 -- origineel .eml op schijf
  size          INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_msgid ON messages(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_key);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename    TEXT,
  mime        TEXT,
  size        INTEGER,
  path        TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_addr, from_name, body_text, content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, body_text)
  VALUES (new.id, new.subject, new.from_addr, new.from_name, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF subject, from_addr, from_name, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, body_text)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.body_text);
  INSERT INTO messages_fts(rowid, subject, from_addr, from_name, body_text)
  VALUES (new.id, new.subject, new.from_addr, new.from_name, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_addr, from_name, body_text)
  VALUES ('delete', old.id, old.subject, old.from_addr, old.from_name, old.body_text);
END;

-- ───────────── Agenda ─────────────
CREATE TABLE IF NOT EXISTS calendars (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  color  TEXT NOT NULL DEFAULT '#3b82f6'
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  uid          TEXT NOT NULL UNIQUE,      -- iCal UID (dedup bij import)
  calendar_id  INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  location     TEXT,
  start        INTEGER NOT NULL,          -- unix ms
  end          INTEGER NOT NULL,          -- unix ms
  all_day      INTEGER NOT NULL DEFAULT 0,
  tz           TEXT,                      -- IANA-tijdzone van het origineel
  rrule        TEXT,                      -- RFC 5545 RRULE, zonder 'RRULE:'
  exdates      TEXT NOT NULL DEFAULT '[]',-- JSON-array van unix ms
  reminder_min INTEGER,                   -- herinnering X minuten vooraf
  updated      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_range ON events(start, end);

-- ───────────── Foto's ─────────────
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,       -- dedup
  filename    TEXT NOT NULL,
  mime        TEXT,
  size        INTEGER,
  width       INTEGER,
  height      INTEGER,
  taken_at    INTEGER NOT NULL,           -- unix ms (EXIF, Takeout-JSON of bestandsdatum)
  lat         REAL,
  lon         REAL,
  camera      TEXT,
  description TEXT,
  is_video    INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  path        TEXT NOT NULL,
  thumb_path  TEXT,
  added       INTEGER NOT NULL,
  deleted_at  INTEGER                   -- prullenbak (zacht verwijderd)
);
CREATE INDEX IF NOT EXISTS photos_taken ON photos(taken_at DESC);

CREATE TABLE IF NOT EXISTS albums (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS album_photos (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (album_id, photo_id)
);
`);

// Migratie oudere databases
const photoCols = (db.prepare("PRAGMA table_info(photos)").all() as { name: string }[]).map((c) => c.name);
if (!photoCols.includes("deleted_at")) db.exec("ALTER TABLE photos ADD COLUMN deleted_at INTEGER");

// ───────────── Cluster-register (gerepliceerd) ─────────────
db.exec(`
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  kind        TEXT NOT NULL,                -- data | witness
  provider    TEXT NOT NULL,
  region      TEXT,
  country     TEXT,
  size        TEXT,
  server_id   TEXT,
  ipv4        TEXT,
  ipv6        TEXT,
  cluster_url TEXT,
  api_url     TEXT,
  status      TEXT NOT NULL,                -- provisioning | syncing | ready | removing | removed | failed
  join_token_hash TEXT,
  monthly_cost REAL,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL,
  last_error  TEXT
);
CREATE TABLE IF NOT EXISTS cluster_jobs (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL,
  params   TEXT NOT NULL DEFAULT '{}',
  state    TEXT NOT NULL DEFAULT '{}',
  status   TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  after    TEXT,                            -- wacht op deze job
  error    TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cluster_events (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info',
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);
`);

if (!db.prepare("SELECT 1 FROM calendars LIMIT 1").get() && process.env.EIGEN_ROLE !== "replica") {
  try { db.prepare("INSERT INTO calendars (name, color) VALUES (?, ?)").run("Persoonlijk", "#3b82f6"); } catch { /* replica: komt via replicatie */ }
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
export function setSetting(key: string, value: string) {
  if (getSetting(key) === value) return;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
