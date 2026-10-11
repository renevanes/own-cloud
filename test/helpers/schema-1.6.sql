-- Schema van de cloud t/m versie 1.6 (één gebruiker), uit src/db.ts. Voor migratietests.
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
  color  TEXT NOT NULL DEFAULT '#3f6f4a'
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
