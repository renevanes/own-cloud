import type Database from "better-sqlite3";

type DB = Database.Database;

/**
 * Schema voor meerdere gebruikers (gezin en extra gebruikers).
 *
 * Alleen DDL: deze functie schrijft nooit rijen. Daardoor kan hij veilig op elke node draaien (ook op een volger,
 * waar schrijven geblokkeerd is) en vóór het toepassen van wijzigingen bij herstel uit een back-up.
 *
 * - messages, calendars: kolom user_id via ALTER TABLE ... ADD COLUMN met DEFAULT 1 (bestaande rijen → eigenaar).
 * - events, photos, albums: tabel opnieuw opbouwen (lokaal, zonder triggers), omdat de oude UNIQUE-beperking op
 *   uid / sha256 / name per gebruiker moet gelden. Rij-id's blijven gelijk, er komt niets in de changelog.
 * - users: nieuwe tabel. De eigenaar (id 1) staat er niet in: zijn wachtwoord en adres staan zoals altijd in
 *   settings (password_hash, mail_from), zodat bestaande clouds, de console en set-password blijven werken.
 *
 * Idempotent: een tweede keer doet niets.
 */
export function migrateUserSchema(db: DB) {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
  const exists = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY,          -- 2, 3, …  (1 = eigenaar, niet in deze tabel)
      localpart      TEXT UNIQUE,                  -- deel vóór de @; NULL na verwijderen
      name           TEXT NOT NULL,
      password_hash  TEXT,
      status         TEXT NOT NULL DEFAULT 'active', -- invited | active | disabled | removed
      invite_hash    TEXT,                         -- sha256 van de uitnodigingscode
      invite_expires INTEGER,
      session_gen    INTEGER NOT NULL DEFAULT 0,   -- ophogen = alle sessies van deze gebruiker ongeldig
      created        INTEGER NOT NULL,
      updated        INTEGER NOT NULL
    );
  `);

  if (exists("messages") && !cols("messages").includes("user_id")) db.exec("ALTER TABLE messages ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
  if (exists("calendars") && !cols("calendars").includes("user_id")) db.exec("ALTER TABLE calendars ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
  if (exists("messages")) {
    db.exec(`
      DROP INDEX IF EXISTS messages_msgid;
      CREATE UNIQUE INDEX IF NOT EXISTS messages_user_msgid ON messages(user_id, message_id) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_user_folder_date ON messages(user_id, folder, date DESC);
      CREATE INDEX IF NOT EXISTS messages_msgid_any ON messages(message_id);
    `);
  }
  if (exists("calendars")) db.exec("CREATE INDEX IF NOT EXISTS calendars_user ON calendars(user_id)");

  const rebuild: { table: string; create: string; indexes: string }[] = [
    {
      table: "events",
      create: `CREATE TABLE events_new (
        id           INTEGER PRIMARY KEY,
        uid          TEXT NOT NULL,
        calendar_id  INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        description  TEXT,
        location     TEXT,
        start        INTEGER NOT NULL,
        end          INTEGER NOT NULL,
        all_day      INTEGER NOT NULL DEFAULT 0,
        tz           TEXT,
        rrule        TEXT,
        exdates      TEXT NOT NULL DEFAULT '[]',
        reminder_min INTEGER,
        updated      INTEGER NOT NULL,
        user_id      INTEGER NOT NULL DEFAULT 1,
        UNIQUE (user_id, uid)
      )`,
      indexes: `CREATE INDEX IF NOT EXISTS events_range ON events(start, end);
        CREATE INDEX IF NOT EXISTS events_user_range ON events(user_id, start, end);`,
    },
    {
      table: "photos",
      create: `CREATE TABLE photos_new (
        id          INTEGER PRIMARY KEY,
        sha256      TEXT NOT NULL,
        filename    TEXT NOT NULL,
        mime        TEXT,
        size        INTEGER,
        width       INTEGER,
        height      INTEGER,
        taken_at    INTEGER NOT NULL,
        lat         REAL,
        lon         REAL,
        camera      TEXT,
        description TEXT,
        is_video    INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        path        TEXT NOT NULL,
        thumb_path  TEXT,
        added       INTEGER NOT NULL,
        deleted_at  INTEGER,
        user_id     INTEGER NOT NULL DEFAULT 1,
        UNIQUE (user_id, sha256)
      )`,
      indexes: `CREATE INDEX IF NOT EXISTS photos_taken ON photos(taken_at DESC);
        CREATE INDEX IF NOT EXISTS photos_user_taken ON photos(user_id, taken_at DESC);
        CREATE INDEX IF NOT EXISTS photos_path ON photos(path);`,
    },
    {
      table: "albums",
      create: `CREATE TABLE albums_new (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 1,
        UNIQUE (user_id, name)
      )`,
      indexes: "",
    },
  ];

  const todo = rebuild.filter((r) => exists(r.table) && !cols(r.table).includes("user_id"));
  if (todo.length) {
    // Volgens de SQLite-procedure voor schemawijzigingen: zonder foreign keys, alles in één transactie.
    const fk = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const r of todo) {
          const old = cols(r.table);
          db.exec(`DROP TABLE IF EXISTS ${r.table}_new`);
          db.exec(r.create);
          const keep = old.map((c) => `"${c}"`).join(", ");
          db.exec(`INSERT INTO ${r.table}_new (${keep}) SELECT ${keep} FROM ${r.table}`);
          db.exec(`DROP TABLE ${r.table}`);
          db.exec(`ALTER TABLE ${r.table}_new RENAME TO ${r.table}`);
        }
      })();
    } finally {
      if (fk) db.pragma("foreign_keys = ON");
    }
  }
  for (const r of rebuild) if (exists(r.table) && r.indexes) db.exec(r.indexes);
}
