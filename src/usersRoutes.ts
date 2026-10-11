/**
 * Gebruikers beheren (alleen de eigenaar) en je eigen account (iedereen).
 */
import type { FastifyInstance } from "fastify";
import { db, setSetting } from "./db.js";
import { hashPassword, checkPasswordRules, requireAuth, requireOwner, setUserPassword, uid } from "./auth.js";
import {
  INVITE_DAYS, OWNER_ID, countUsers, defaultCalendar, deleteUserData, getUser, limitMessage, listUsers, mailDomain, maxUsers,
  newInviteCode, sha256, storageUsage, userRow, usersBlocked,
} from "./users.js";
import { publicBase } from "./settingsRoutes.js";
import { VERSION } from "./version.js";

const LOCALPART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/** Adressen die bij de eigenaar blijven (meldingen van andere mailservers, DMARC-rapporten, …). */
const RESERVED = new Set(["postmaster", "abuse", "hostmaster", "webmaster", "mailer-daemon", "noreply", "no-reply", "dmarc", "root", "admin", "security"]);

export function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const view = () => {
    const usage = storageUsage();
    const rows = new Map((db.prepare("SELECT id, invite_expires, created FROM users").all() as { id: number; invite_expires: number | null; created: number }[]).map((r) => [r.id, r]));
    const max = maxUsers();
    const count = countUsers();
    const blocked = usersBlocked();
    return {
      domain: mailDomain(),
      max,
      count,
      canAdd: !blocked && (!max || count < max),
      reason: blocked ?? (max && count >= max ? limitMessage(max) : null),
      users: listUsers().map((u) => ({
        id: u.id, name: u.name, address: u.address, owner: u.owner, status: u.status,
        inviteExpires: u.status === "invited" ? rows.get(u.id)?.invite_expires ?? null : null,
        created: rows.get(u.id)?.created ?? null,
        storage: usage.get(u.id) ?? { mail: 0, photos: 0, total: 0 },
      })),
    };
  };

  // ───────── Beheer (eigenaar) ─────────

  app.get("/api/users", { preHandler: requireOwner }, async () => view());

  app.post<{ Body: { name?: string; localpart?: string; password?: string; invite?: boolean } }>("/api/users", { preHandler: requireOwner }, async (req, reply) => {
    const bad = (error: string, code = 400) => reply.code(code).send({ error });
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    let localpart = String(req.body?.localpart ?? "").trim().toLowerCase();
    if (localpart.includes("@")) {
      const [l, d] = localpart.split("@");
      if (d !== mailDomain()) return bad(`Het adres moet eindigen op @${mailDomain()}`);
      localpart = l;
    }
    if (!name) return bad("Vul een naam in");
    if (!LOCALPART.test(localpart)) return bad("Kies een adres met alleen kleine letters, cijfers, punt, streepje of liggend streepje");
    if (RESERVED.has(localpart)) return bad(`${localpart}@${mailDomain()} is gereserveerd voor meldingen aan de eigenaar. Kies een ander adres.`);
    if (localpart === getUser(OWNER_ID)!.localpart || db.prepare("SELECT 1 FROM users WHERE localpart = ?").get(localpart)) return bad(`${localpart}@${mailDomain()} is al in gebruik`);
    const blocked = usersBlocked();
    if (blocked) return bad(blocked, 409);
    const max = maxUsers();
    if (max && countUsers() >= max) return bad(limitMessage(max), 409);
    const password = req.body?.password ? String(req.body.password) : "";
    if (!password && !req.body?.invite) return bad("Kies een eerste wachtwoord of maak een uitnodigingslink");
    if (password) { try { checkPasswordRules(password); } catch (e) { return bad((e as Error).message); } }

    const code = password ? null : newInviteCode();
    const now = Date.now();
    const id = db.transaction(() => {
      const next = Math.max(OWNER_ID, (db.prepare("SELECT MAX(id) AS m FROM users").get() as { m: number | null }).m ?? 0) + 1;
      db.prepare(`INSERT INTO users (id, localpart, name, password_hash, status, invite_hash, invite_expires, session_gen, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(next, localpart, name, password ? hashPassword(password) : null, password ? "active" : "invited",
        code ? sha256(code) : null, code ? now + INVITE_DAYS * 864e5 : null, now, now);
      defaultCalendar(next);
      return next;
    })();
    const u = getUser(id)!;
    return { user: { id: u.id, name: u.name, address: u.address, status: u.status }, inviteUrl: code ? `${publicBase(req)}/?uitnodiging=${code}` : null };
  });

  const target = (id: string) => {
    const n = Number(id);
    if (n === OWNER_ID) return { error: "Dit is je eigen account. Dat regel je bij Account." };
    const r = Number.isInteger(n) ? userRow(n) : undefined;
    if (!r || r.status === "removed") return { error: "Deze gebruiker bestaat niet" };
    return { row: r };
  };

  /** Nieuw wachtwoord instellen, of een nieuwe uitnodigingslink waarmee de gebruiker zelf een wachtwoord kiest. */
  app.post<{ Params: { id: string }; Body: { password?: string } }>("/api/users/:id/reset", { preHandler: requireOwner }, async (req, reply) => {
    const t = target(req.params.id);
    if (!t.row) return reply.code(400).send({ error: t.error });
    if (req.body?.password) {
      try { setUserPassword(t.row.id, String(req.body.password)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      return { ok: true, inviteUrl: null };
    }
    const code = newInviteCode();
    db.prepare(`UPDATE users SET password_hash = NULL, status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'invited' END,
      invite_hash = ?, invite_expires = ?, session_gen = session_gen + 1, updated = ? WHERE id = ?`).run(sha256(code), Date.now() + INVITE_DAYS * 864e5, Date.now(), t.row.id);
    return { ok: true, inviteUrl: `${publicBase(req)}/?uitnodiging=${code}` };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; disabled?: boolean } }>("/api/users/:id", { preHandler: requireOwner }, async (req, reply) => {
    const t = target(req.params.id);
    if (!t.row) return reply.code(400).send({ error: t.error });
    const b = req.body ?? {};
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 60);
      if (!name) return reply.code(400).send({ error: "Vul een naam in" });
      db.prepare("UPDATE users SET name = ?, updated = ? WHERE id = ?").run(name, Date.now(), t.row.id);
    }
    if (b.disabled === true && t.row.status !== "disabled") {
      db.prepare("UPDATE users SET status = 'disabled', session_gen = session_gen + 1, updated = ? WHERE id = ?").run(Date.now(), t.row.id);
    } else if (b.disabled === false && t.row.status === "disabled") {
      db.prepare("UPDATE users SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END, updated = ? WHERE id = ?").run(Date.now(), t.row.id);
    }
    return { ok: true, user: view().users.find((u) => u.id === t.row!.id) };
  });

  /** Verwijderen: alle mail, agenda's en foto's van deze gebruiker. Ter bevestiging moet het adres meekomen. */
  app.delete<{ Params: { id: string }; Body: { confirm?: string } }>("/api/users/:id", { preHandler: requireOwner }, async (req, reply) => {
    const t = target(req.params.id);
    if (!t.row) return reply.code(400).send({ error: t.error });
    const u = getUser(t.row.id)!;
    const confirm = String(req.body?.confirm ?? "").trim().toLowerCase();
    if (confirm !== u.address && confirm !== u.localpart) return reply.code(400).send({ error: `Typ ter bevestiging het adres ${u.address}` });
    const deleted = deleteUserData(u.id);
    db.prepare(`UPDATE users SET status = 'removed', localpart = NULL, name = '', password_hash = NULL, invite_hash = NULL, invite_expires = NULL,
      session_gen = session_gen + 1, updated = ? WHERE id = ?`).run(Date.now(), u.id);
    return { ok: true, deleted };
  });

  // ───────── Eigen account (iedereen) ─────────

  app.get("/api/account", async (req) => {
    const u = getUser(uid(req))!;
    return { id: u.id, name: u.name, address: u.address, owner: u.owner, storage: storageUsage().get(u.id) ?? { mail: 0, photos: 0, total: 0 } };
  });

  app.put<{ Body: { name?: string } }>("/api/account", async (req, reply) => {
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: "Vul een naam in" });
    const id = uid(req);
    if (id === OWNER_ID) setSetting("owner_name", name);
    else db.prepare("UPDATE users SET name = ?, updated = ? WHERE id = ?").run(name, Date.now(), id);
    return { ok: true };
  });

  /** Voor de aanbieder (later: gezondheidsrapport). Alleen cijfers, geen inhoud. */
  app.get("/api/admin/summary", { preHandler: requireOwner }, async () => {
    let storageUsedBytes = 0;
    for (const u of storageUsage().values()) storageUsedBytes += u.total;
    return { users: countUsers(), storageUsedBytes, version: VERSION() };
  });
}
