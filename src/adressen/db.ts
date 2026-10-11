/** Database van de adressendienst (adressen.sqlite in ADRES_DATA_DIR). */
import path from "node:path";
import Database from "better-sqlite3";

/** bezig = aanvraag onderbroken (wordt bij opnieuw proberen afgemaakt), actief, vrijgegeven (in quarantaine). */
export type NaamStatus = "bezig" | "actief" | "vrijgegeven";

export interface NaamRow {
  label: string;
  naam: string;
  /** Adres van de Dienst die de naam nu beheert. */
  dienst: string | null;
  /** Eigen kenmerk van die Dienst (bijv. het bestelnummer): maakt opnieuw aanvragen veilig. */
  ref: string | null;
  /** Id van het deSEC-token dat alleen in deze zone mag schrijven. */
  token_id: string | null;
  /** sha256 van de overdrachtscode van de klant. */
  code_hash: string | null;
  status: NaamStatus;
  created_at: number;
  updated_at: number;
  released_at: number | null;
}

export function openAdresDb(dataDir: string) {
  const db = new Database(path.join(dataDir, "adressen.sqlite"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS namen (
      label TEXT PRIMARY KEY, naam TEXT NOT NULL, dienst TEXT, ref TEXT, token_id TEXT, code_hash TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, released_at INTEGER);
    CREATE TABLE IF NOT EXISTS logboek (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, dienst TEXT, actie TEXT NOT NULL, naam TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS logboek_naam ON logboek(naam);
    CREATE TABLE IF NOT EXISTS handtekeningen (sig TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
  return db;
}

export type AdresDb = ReturnType<typeof openAdresDb>;

export const getNaam = (db: AdresDb, label: string) => db.prepare("SELECT * FROM namen WHERE label = ?").get(label) as NaamRow | undefined;

export function log(db: AdresDb, dienst: string | null, actie: string, naam: string | null, detail?: unknown) {
  db.prepare("INSERT INTO logboek (at, dienst, actie, naam, detail) VALUES (?, ?, ?, ?, ?)")
    .run(Date.now(), dienst, actie, naam, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail));
}
