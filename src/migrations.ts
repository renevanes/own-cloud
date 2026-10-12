import type Database from "better-sqlite3";

/** DDL runs before replication on every node and before replaying restored entries. */
export const SCHEMA_CAPABILITY = "review-v1";
export function migrateFeatures(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
  const migrations = [{ id: 1, name: "Veilige accounts en uitbreidingen", sql: `
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, generation INTEGER NOT NULL, created INTEGER NOT NULL,
      expires INTEGER NOT NULL, last_used INTEGER NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, expires);
    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id INTEGER PRIMARY KEY, secret TEXT, pending TEXT, last_step INTEGER NOT NULL DEFAULT -1,
      recovery TEXT NOT NULL DEFAULT '[]', updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_credentials (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      scopes TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT, phone TEXT,
      vcard TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contacts_user ON contacts(user_id, name);
    CREATE TABLE IF NOT EXISTS dav_resources (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, data TEXT NOT NULL, etag TEXT NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(user_id, calendar_id, filename)
    );
    CREATE TABLE IF NOT EXISTS resource_shares (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      UNIQUE(kind, resource_id, member_id)
    );
    CREATE INDEX IF NOT EXISTS resource_shares_member ON resource_shares(member_id, status);
    CREATE TABLE IF NOT EXISTS mail_drafts (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, mail TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_outbox (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, request_hash TEXT NOT NULL, mail TEXT NOT NULL,
      raw_path TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      updated INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT, sent_id INTEGER, UNIQUE(user_id, request_hash)
    );
    CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(status, next_attempt);
    CREATE TABLE IF NOT EXISTS mail_delivery (
      outbox_id TEXT NOT NULL REFERENCES mail_outbox(id) ON DELETE CASCADE, address TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated INTEGER NOT NULL,
      PRIMARY KEY(outbox_id, address)
    );
    CREATE TABLE IF NOT EXISTS mail_rules (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, field TEXT NOT NULL, pattern TEXT NOT NULL,
      folder TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_uploads (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
      received INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_chunks (
      upload_id TEXT NOT NULL REFERENCES import_uploads(id) ON DELETE CASCADE, offset INTEGER NOT NULL,
      path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(upload_id, offset)
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, uploads TEXT NOT NULL, status TEXT NOT NULL,
      progress TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      finished INTEGER, cancelled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS import_jobs_user ON import_jobs(user_id, created);
    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, tag TEXT NOT NULL,
      PRIMARY KEY(photo_id, tag)
    );
    CREATE TABLE IF NOT EXISTS photo_text (
      photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE, text TEXT NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_operations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL,
      request_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _resource_reservations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL
    );
  ` }, { id: 2, name: "DAV-adressen en mailcontroles", sql: `
    CREATE TABLE IF NOT EXISTS dav_collections (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, slug TEXT NOT NULL,
      calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, UNIQUE(user_id,slug)
    );
    CREATE TABLE IF NOT EXISTS mail_security (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL, score REAL, action TEXT, details TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS contact_resources (
      id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
      filename TEXT NOT NULL, UNIQUE(user_id,filename)
    );
  ` }, { id: 3, name: "Fotoverwerking", sql: `
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY, photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_jobs_due ON media_jobs(status, created);
  ` }, { id: 4, name: "Opslaggebruik van postvak uit", sql: `
    ALTER TABLE mail_outbox ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
  ` }];
  for (const m of migrations) {
    if (db.prepare("SELECT 1 FROM _schema_migrations WHERE id = ?").get(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO _schema_migrations VALUES (?, ?)").run(m.id, m.name);
    })();
  }
}
