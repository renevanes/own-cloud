/**
 * Gebruikers van deze cloud (gezin en extra gebruikers).
 *
 * De eigenaar is altijd gebruiker 1 en staat níet in de tabel users: zijn wachtwoord en adres staan zoals altijd in
 * settings (password_hash, mail_from). Daardoor werkt een bestaande cloud na het bijwerken precies als voorheen.
 * Extra gebruikers (id 2, 3, …) staan in users. Verwijderde gebruikers blijven als lege rij staan (status 'removed'),
 * zodat een id nooit opnieuw wordt uitgedeeld en oude sessies nooit bij een nieuwe gebruiker terechtkomen.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, getSetting } from "./db.js";
import { ownAddress } from "./mail/send.js";
import { runtime } from "./cluster/runtime.js";

export const OWNER_ID = 1;

export type UserStatus = "invited" | "active" | "disabled" | "removed";

export interface UserRow {
  id: number; localpart: string | null; name: string; password_hash: string | null; status: UserStatus;
  invite_hash: string | null; invite_expires: number | null; session_gen: number; created: number; updated: number;
}

export interface User {
  id: number;
  name: string;
  address: string;
  localpart: string;
  owner: boolean;
  status: UserStatus;
  sessionGen: number;
}

export function mailDomain(): string {
  return (ownAddress().split("@")[1] ?? config.mailDomains[0] ?? "").toLowerCase();
}

function ownerUser(): User {
  const address = ownAddress().toLowerCase();
  const localpart = address.split("@")[0] ?? "";
  const name = getSetting("owner_name") || (localpart ? localpart[0].toUpperCase() + localpart.slice(1) : "Eigenaar");
  return { id: OWNER_ID, name, address, localpart, owner: true, status: "active", sessionGen: Number(getSetting("owner_session_gen") ?? 0) };
}

function fromRow(r: UserRow): User {
  return { id: r.id, name: r.name, address: r.localpart ? `${r.localpart}@${mailDomain()}` : "", localpart: r.localpart ?? "", owner: false, status: r.status, sessionGen: r.session_gen };
}

export function userRow(id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUser(id: number): User | null {
  if (id === OWNER_ID) return ownerUser();
  const r = userRow(id);
  return r && r.status !== "removed" ? fromRow(r) : null;
}

/** Alle gebruikers (zonder verwijderde), eigenaar eerst. */
export function listUsers(): User[] {
  const rows = db.prepare("SELECT * FROM users WHERE status != 'removed' ORDER BY id").all() as UserRow[];
  return [ownerUser(), ...rows.map(fromRow)];
}

export function hasExtraUsers(): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE status != 'removed' LIMIT 1").get();
}

/**
 * Bij wie hoort een adres? Een extra gebruiker op zijn eigen adres; alles wat verder op onze domeinen binnenkomt
 * gaat zoals altijd naar de eigenaar (catch-all). null = niet aannemen (uitgeschakelde gebruiker of vreemd domein).
 */
export function recipientUser(address: string): number | null {
  const [local, domain] = address.toLowerCase().trim().split("@");
  if (!local || !domain || !config.mailDomains.includes(domain)) return null;
  const r = db.prepare("SELECT id, status FROM users WHERE localpart = ?").get(local.replace(/\+.*$/, "")) as { id: number; status: UserStatus } | undefined;
  if (!r) return OWNER_ID;
  if (r.status === "disabled") return null;
  return r.id;
}

/** Inloggen met naam, deel vóór de @ of het hele adres. */
export function findLogin(login: string): User | null {
  const l = login.trim().toLowerCase();
  if (!l) return null;
  const owner = ownerUser();
  if (l === owner.address || l === owner.localpart || l === owner.name.toLowerCase()) return owner;
  const local = l.includes("@") ? (l.endsWith("@" + mailDomain()) || config.mailDomains.includes(l.split("@")[1]) ? l.split("@")[0] : null) : l;
  const rows = db.prepare("SELECT * FROM users WHERE status != 'removed'").all() as UserRow[];
  const r = rows.find((x) => x.localpart === local) ?? (!l.includes("@") ? rows.find((x) => x.name.toLowerCase() === l) : undefined);
  return r ? fromRow(r) : null;
}

// ───────── Limiet ─────────

/** Maximum aantal gebruikers (inclusief de eigenaar) uit de instelling max_users; 0 = onbeperkt. */
export function maxUsers(): number {
  const n = Number(getSetting("max_users") ?? "0");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Telt mee voor de limiet: iedereen behalve verwijderde gebruikers (ook uitgeschakelde en uitgenodigde). */
export function countUsers(): number {
  return 1 + (db.prepare("SELECT COUNT(*) AS n FROM users WHERE status != 'removed'").get() as { n: number }).n;
}

export function limitMessage(n: number) {
  return `Je abonnement heeft ruimte voor ${n} ${n === 1 ? "gebruiker" : "gebruikers"}. Extra gebruikers regel je bij je abonnement.`;
}

// ───────── Opslag ─────────

export interface Usage { mail: number; photos: number; total: number }

export function storageUsage(): Map<number, Usage> {
  const out = new Map<number, Usage>();
  const get = (id: number) => { let u = out.get(id); if (!u) out.set(id, (u = { mail: 0, photos: 0, total: 0 })); return u; };
  for (const r of db.prepare("SELECT user_id, COALESCE(SUM(size), 0) AS n FROM messages GROUP BY user_id").all() as { user_id: number; n: number }[]) get(r.user_id).mail += r.n;
  for (const r of db.prepare("SELECT m.user_id, COALESCE(SUM(a.size), 0) AS n FROM attachments a JOIN messages m ON m.id = a.message_id GROUP BY m.user_id").all() as { user_id: number; n: number }[]) get(r.user_id).mail += r.n;
  for (const r of db.prepare("SELECT user_id, COALESCE(SUM(size), 0) AS n FROM photos GROUP BY user_id").all() as { user_id: number; n: number }[]) get(r.user_id).photos += r.n;
  for (const r of db.prepare("SELECT user_id, COALESCE(SUM(length(CAST(mail AS BLOB))),0) AS n FROM mail_drafts GROUP BY user_id").all() as { user_id: number; n: number }[]) get(r.user_id).mail += r.n;
  for (const r of db.prepare("SELECT user_id, COALESCE(SUM(received),0) AS n FROM import_uploads GROUP BY user_id").all() as { user_id: number; n: number }[]) get(r.user_id).mail += r.n;
  for (const r of db.prepare("SELECT user_id, COALESCE(SUM(size),0) AS n FROM mail_outbox GROUP BY user_id").all() as { user_id: number; n: number }[]) get(r.user_id).mail += r.n;
  for (const u of out.values()) u.total = u.mail + u.photos;
  return out;
}

// ───────── Uitnodigingen ─────────

export const INVITE_DAYS = 7;
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export function newInviteCode() {
  return crypto.randomBytes(24).toString("base64url");
}
export function userByInvite(code: string): UserRow | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null;
  const r = db.prepare("SELECT * FROM users WHERE invite_hash = ?").get(sha256(code)) as UserRow | undefined;
  if (!r || r.status === "removed" || r.status === "disabled" || !r.invite_expires || r.invite_expires < Date.now()) return null;
  return r;
}

// ───────── Cluster: pas extra gebruikers als alle servers het kennen ─────────

/** Reden waarom er (nog) geen gebruikers bij kunnen, of null. */
export function usersBlocked(): string | null {
  return runtime.usersBlocked();
}

// ───────── Verwijderen ─────────

/** Verwijdert alle gegevens van een gebruiker (mail, agenda, foto's, albums). Bestanden alleen als niemand anders ze gebruikt. */
export function deleteUserData(userId: number) {
  if (userId === OWNER_ID) throw new Error("De eigenaar kan niet worden verwijderd");
  const files = [
    ...(db.prepare("SELECT raw_path AS p FROM messages WHERE user_id = ? AND raw_path IS NOT NULL").all(userId) as { p: string }[]),
    ...(db.prepare("SELECT a.path AS p FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.user_id = ?").all(userId) as { p: string }[]),
    ...(db.prepare("SELECT path AS p FROM photos WHERE user_id = ?").all(userId) as { p: string }[]),
    ...(db.prepare("SELECT thumb_path AS p FROM photos WHERE user_id = ? AND thumb_path IS NOT NULL").all(userId) as { p: string }[]),
    ...(db.prepare("SELECT raw_path AS p FROM mail_outbox WHERE user_id = ?").all(userId) as { p: string }[]),
    ...(db.prepare("SELECT c.path AS p FROM import_chunks c JOIN import_uploads u ON u.id = c.upload_id WHERE u.user_id = ?").all(userId) as { p: string }[]),
  ].map((r) => r.p);
  const counts = db.transaction(() => {
    db.prepare("DELETE FROM resource_shares WHERE owner_id = ? OR member_id = ?").run(userId, userId);
    for (const table of ["auth_sessions", "user_mfa", "app_credentials", "contacts", "mail_drafts", "mail_outbox", "mail_rules", "import_jobs", "import_uploads", "api_operations", "_resource_reservations"])
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    db.prepare("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE user_id = ?)").run(userId);
    const c = {
      messages: db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId).changes,
      events: db.prepare("DELETE FROM events WHERE user_id = ?").run(userId).changes,
      calendars: db.prepare("DELETE FROM calendars WHERE user_id = ?").run(userId).changes,
      photos: 0,
      albums: 0,
    };
    db.prepare("DELETE FROM album_photos WHERE album_id IN (SELECT id FROM albums WHERE user_id = ?) OR photo_id IN (SELECT id FROM photos WHERE user_id = ?)").run(userId, userId);
    c.albums = db.prepare("DELETE FROM albums WHERE user_id = ?").run(userId).changes;
    c.photos = db.prepare("DELETE FROM photos WHERE user_id = ?").run(userId).changes;
    return c;
  })();
  removeUnreferencedFiles(files);
  return counts;
}

/** Lokale bestanden weghalen die door geen enkele rij meer gebruikt worden (inhoud-adressen kunnen gedeeld zijn). */
export function removeUnreferencedFiles(rels: string[]) {
  const used = (p: string) =>
    !!db.prepare("SELECT 1 FROM messages WHERE raw_path = ? LIMIT 1").get(p) ||
    !!db.prepare("SELECT 1 FROM attachments WHERE path = ? LIMIT 1").get(p) ||
    !!db.prepare("SELECT 1 FROM mail_outbox WHERE raw_path = ? LIMIT 1").get(p) ||
    !!db.prepare("SELECT 1 FROM import_chunks WHERE path = ? LIMIT 1").get(p) ||
    !!db.prepare("SELECT 1 FROM photos WHERE path = ? OR thumb_path = ? LIMIT 1").get(p, p);
  for (const p of new Set(rels)) {
    if (!p || path.isAbsolute(p) || p.includes("..") || used(p)) continue;
    fs.rmSync(path.join(config.dataDir, p), { force: true });
  }
}

/** Eerste agenda van een gebruiker (maakt er een als hij er nog geen heeft). */
export function defaultCalendar(userId: number): number {
  const r = db.prepare("SELECT id FROM calendars WHERE user_id = ? ORDER BY id LIMIT 1").get(userId) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare("INSERT INTO calendars (name, color, user_id) VALUES (?, ?, ?)").run("Persoonlijk", "#3f6f4a", userId).lastInsertRowid);
}
