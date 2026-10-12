import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { requireAuth, uid } from "./auth.js";
import { findLogin, getUser } from "./users.js";
import { integer, object, string } from "./apiContract.js";

export type SharedKind = "calendar" | "album";
export function resourceOwner(kind: SharedKind, id: unknown): number | null {
  const table = kind === "calendar" ? "calendars" : "albums";
  return (db.prepare(`SELECT user_id FROM ${table} WHERE id=?`).get(id) as { user_id: number } | undefined)?.user_id ?? null;
}
export function resourceAccess(kind: SharedKind, id: unknown, userId: number, write = false) {
  const owner = resourceOwner(kind, id);
  if (owner === null) return false;
  if (owner === userId) return true;
  const row = db.prepare("SELECT role FROM resource_shares WHERE kind=? AND resource_id=? AND member_id=? AND status='accepted'").get(kind, id, userId) as { role: string } | undefined;
  return !!row && (!write || row.role === "write");
}
export const calendarAccessSql = (alias: string) => `(${alias}.user_id = ? OR EXISTS (SELECT 1 FROM resource_shares rs WHERE rs.kind='calendar' AND rs.resource_id=${alias}.calendar_id AND rs.member_id=? AND rs.status='accepted'))`;
export function accessiblePhoto(id: unknown, userId: number) {
  return !!db.prepare(`SELECT 1 FROM photos p WHERE p.id=? AND (p.user_id=? OR (p.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM album_photos ap JOIN albums a ON a.id=ap.album_id WHERE ap.photo_id=p.id AND (
      a.user_id=? OR EXISTS (SELECT 1 FROM resource_shares s WHERE s.kind='album' AND s.resource_id=a.id AND s.member_id=? AND s.status='accepted')))))`).get(id, userId, userId, userId);
}

export function sharingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/sharing", async (req) => db.prepare("SELECT * FROM resource_shares WHERE owner_id=? OR member_id=? ORDER BY created DESC").all(uid(req), uid(req)).map((s: any) => ({
    ...s, owner: getUser(s.owner_id)?.name, member: getUser(s.member_id)?.name,
    name: (db.prepare(`SELECT name FROM ${s.kind === "calendar" ? "calendars" : "albums"} WHERE id=?`).get(s.resource_id) as { name: string } | undefined)?.name ?? "Verwijderd",
  })));
  app.post<{ Body: { kind: SharedKind; resourceId: number; member: string; role: "read" | "write" } }>("/api/sharing", {
    schema: { body: object({ kind: { enum: ["calendar", "album"] }, resourceId: integer(1), member: string(320), role: { enum: ["read", "write"] } }, ["kind", "resourceId", "member", "role"]) },
  }, async (req, reply) => {
    const b = req.body, owner = uid(req);
    if (resourceOwner(b.kind, b.resourceId) !== owner) return reply.code(403).send({ error: "Alleen de eigenaar kan dit delen" });
    const member = findLogin(b.member);
    if (!member || member.id === owner || member.status !== "active") return reply.code(400).send({ error: "Kies een actieve andere gebruiker van deze cloud" });
    const previous = db.prepare("SELECT id FROM resource_shares WHERE kind=? AND resource_id=? AND member_id=?").get(b.kind, b.resourceId, member.id) as { id: string } | undefined;
    const id = previous?.id ?? crypto.randomUUID();
    db.prepare("INSERT INTO resource_shares VALUES (?,?,?,?,?,?,'invited',?) ON CONFLICT(kind,resource_id,member_id) DO UPDATE SET role=excluded.role,status='invited'")
      .run(id, b.kind, b.resourceId, owner, member.id, b.role, Date.now());
    return { ok: true, id };
  });
  app.post<{ Params: { id: string }; Body: { accept: boolean } }>("/api/sharing/:id/respond", { schema: { body: object({ accept: { type: "boolean" } }, ["accept"]) } }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM resource_shares WHERE id=? AND member_id=? AND status='invited'").get(req.params.id, uid(req)) as any;
    if (!row || resourceOwner(row.kind, row.resource_id) !== row.owner_id || getUser(row.owner_id)?.status !== "active") return reply.code(404).send({ error: "Uitnodiging bestaat niet meer" });
    db.prepare("UPDATE resource_shares SET status=? WHERE id=?").run(req.body.accept ? "accepted" : "declined", row.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/sharing/:id", async (req, reply) => {
    const r = db.prepare("DELETE FROM resource_shares WHERE id=? AND (owner_id=? OR member_id=?)").run(req.params.id, uid(req), uid(req));
    return r.changes ? { ok: true } : reply.code(404).send({ error: "Niet gevonden" });
  });
}
