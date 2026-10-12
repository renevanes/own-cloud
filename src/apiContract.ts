import type { FastifyInstance } from "fastify";
import { requireOwner } from "./auth.js";

export const CONTRACT_VERSION = 1;
export const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
export const string = (maxLength = 1000) => ({ type: "string", maxLength });
export const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const list = (items: unknown, maxItems = 500) => ({ type: "array", items, maxItems });
const boolean = { type: "boolean" };
const nullableText = { anyOf: [string(64_000), { type: "null" }] };
const date = integer(-2_208_988_800_000, 7_258_118_400_000);
const event = { title: string(1000), description: nullableText, location: nullableText, start: date, end: date,
  calendar_id: integer(1), all_day: boolean, tz: { anyOf: [string(100), { type: "null" }] }, rrule: nullableText, reminder_min: { anyOf: [integer(0, 525600), { type: "null" }] } };
export const mailInput = object({ to: { anyOf: [string(4000), list(string(320), 100)] }, cc: list(string(320), 100), bcc: list(string(320), 100),
  subject: string(10000), text: string(2_000_000), html: string(2_000_000), replyToId: integer(1),
  attachments: list(object({ filename: string(255), base64: string(70_000_000), contentType: string(255) }, ["filename", "base64"]), 50) });
export const API_SCHEMAS: Record<string, Record<string, unknown>> = {
  "POST /api/login": { body: object({ password: string(1024), user: string(320), email: string(320), code: string(100) }, ["password"]) },
  "POST /api/mail/send": { body: mailInput },
  "PATCH /api/mail/messages/:id": { body: object({ folder: { enum: ["inbox", "sent", "archive", "trash", "spam", "drafts"] }, is_read: boolean, is_starred: boolean }) },
  "POST /api/events": { body: object(event, ["title", "start", "end"]) },
  "GET /api/events": { querystring: object({ from: date, to: date, q: string(1000) }, ["from", "to"]) },
  "DELETE /api/events/:id": { querystring: object({ occurrence: date }) },
  "POST /api/calendar/import": { body: object({ ics: { ...string(10 * 1024 ** 2), minLength: 1 }, calendar_id: integer(1) }, ["ics"]) },
  "PATCH /api/events/:id": { body: object(event) },
  "POST /api/calendars": { body: object({ name: string(120), color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } }, ["name"]) },
  "PATCH /api/calendars/:id": { body: object({ name: { ...string(120), minLength: 1 }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } }) },
  "POST /api/albums": { body: object({ name: string(120) }, ["name"]) },
  "POST /api/albums/:id/photos": { body: object({ photo_ids: list(integer(1)) }, ["photo_ids"]) },
  "PATCH /api/photos/:id": { body: object({ is_favorite: boolean, description: string(64000), taken_at: date }) },
  "POST /api/settings/password": { body: object({ current: string(1024), next: string(1024), code: string(100) }, ["current", "next"]) },
  "PUT /api/account": { body: object({ name: string(60) }, ["name"]) },
  "POST /api/users": { body: object({ name: string(60), localpart: string(320), password: string(1024), invite: boolean }, ["name", "localpart"]) },
  "POST /api/users/:id/reset": { body: object({ password: string(1024) }) },
  "PATCH /api/users/:id": { body: object({ name: string(60), disabled: boolean }) },
  "DELETE /api/users/:id": { body: object({ confirm: string(320) }, ["confirm"]) },
  "POST /api/invite/:code": { body: object({ password: string(1024) }, ["password"]) },
  "PUT /api/settings": { body: object({ mailFrom: string(320), alertEmail: string(320), spfExtra: string(2000), relay: { anyOf: [object({ host: { ...string(255), minLength: 1 }, port: integer(1, 65535), user: string(320), password: string(1024), secure: { type: "boolean" } }, ["host", "port"]), { type: "null" }] } }) },
  "POST /api/settings/test-mail": { body: object({ to: string(320) }) },
  "POST /api/health/fix": { body: object({ action: string(120) }, ["action"]) },
  "PUT /api/gmail": { body: object({ mode: { enum: ["uit", "naast", "vangnet"] }, address: string(320), password: string(1024), sendViaGmail: { type: "boolean" }, copySent: { type: "boolean" }, copyToInbox: { type: "boolean" }, calendars: list(object({ url: string(2000), name: string(120) }, ["url", "name"]), 100) }) },
  "POST /api/gmail/test": { body: object({ address: string(320), password: string(1024) }) },
  "POST /api/import/uploads": { body: object({ name: string(255), size: integer(1, 1024 * 1024 * 1024 * 1024) }, ["name", "size"]) },
  "POST /api/import/start": { body: object({ ids: list({ type: "string", pattern: "^[0-9a-f]{16}$" }, 100) }) },
  "GET /api/mail/messages": { querystring: object({ folder: string(30), q: string(1000), label: string(1000), starred: string(5), before: integer(), beforeId: integer(1), limit: integer(1, 200) }) },
  "GET /api/photos": { querystring: object({ before: date, beforeId: integer(1), limit: integer(1, 500), album: integer(1), favorites: string(5), videos: string(5), q: string(1000), trash: string(5), tag: string(120) }) },
};

export function ownerOnly(path: string, method: string) {
  return /^\/api\/(?:users|admin|gmail|cluster)(?:\/|$)/.test(path) || path === "/api/health/fix" || method === "PUT" && ["/api/settings", "/api/mail/filter"].includes(path) || path === "/api/settings/test-mail";
}
export function installApiSchemas(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    if (/^\/api\/(?:login|invite|security|settings\/password)(?:\/|$)/.test(route.url)) route.bodyLimit = 16 * 1024;
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    const schema = API_SCHEMAS[`${method} ${route.url}`];
    if (schema) route.schema = { ...schema, ...route.schema };
  });
  app.addHook("preValidation", async (req, reply) => {
    const path = req.routeOptions.url ?? "";
    if (ownerOnly(path, req.method)) {
      const denied = await requireOwner(req, reply);
      if (denied) return denied;
    }
    if (/^\/api\/(mail\/messages|mail\/attachments|photos|albums|events|calendars|users)\/:id(?:\/|$)/.test(path)) {
      const id = (req.params as { id?: unknown }).id;
      if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return reply.code(400).send({ error: "Ongeldig nummer" });
    }
  });
}
