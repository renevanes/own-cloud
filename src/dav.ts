import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import ICAL from "ical.js";
import { db } from "./db.js";
import { requireAuth, tokenFrom, tokenUser, uid } from "./auth.js";
import { findLogin, getUser } from "./users.js";
import { resourceAccess, resourceOwner } from "./sharing.js";
import { exportIcs, importIcs } from "./calendar/ics.js";
import type { EventRow } from "./calendar/recurrence.js";
import { expand } from "./calendar/recurrence.js";
import { object, string, integer } from "./apiContract.js";
import { checkRevision, revisionTag } from "./security/preconditions.js";
import { davFilterMatches } from "./davFilter.js";

const xml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const digest = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const etag = (s: string) => `"${digest(s)}"`;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
function parseXml(s: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(s) || s.length > 2 * 1024 * 1024) throw Object.assign(new Error("Ongeldig XML-verzoek"), { statusCode: 400 });
  try { if (s && XMLValidator.validate(s) !== true) throw new Error(); return s ? parser.parse(s) : {}; } catch { throw Object.assign(new Error("Ongeldig XML-verzoek"), { statusCode: 400 }); }
}
function find(value: any, key: string, depth = 0): any[] {
  if (!value || typeof value !== "object" || depth > 20) return [];
  return Object.entries(value).flatMap(([k, v]) => k === key ? (Array.isArray(v) ? v : [v]) : find(v, key, depth + 1));
}
const multi = (responses: string[], token?: string) => `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">${responses.join("")}${token ? `<D:sync-token>${xml(token)}</D:sync-token>` : ""}</D:multistatus>`;
const response = (href: string, props: string) => `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const missing = (href: string) => `<D:response><D:href>${xml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
const prop = (name: string, value: unknown) => `<${name}>${xml(value)}</${name}>`;

export function parseVCard(data: string, fallbackId: string = crypto.randomUUID()) {
  if (data.length > 256 * 1024 || data.includes("\0") || !/^BEGIN:VCARD\r?\n/i.test(data) || !/\r?\nEND:VCARD\s*$/i.test(data)) throw Object.assign(new Error("Ongeldig contactbestand"), { statusCode: 400 });
  const unfolded = data.replace(/\r?\n[ \t]/g, "");
  const field = (name: string) => new RegExp(`^(?:[^:;.]+\\.)?${name}(?:;[^:]*)?:(.*)$`, "im").exec(unfolded)?.[1]?.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1") ?? "";
  const name = field("FN");
  if (!name || name.length > 1000 || !["3.0", "4.0"].includes(field("VERSION"))) throw Object.assign(new Error("Contact heeft een naam en vCard-versie 3 of 4 nodig"), { statusCode: 400 });
  const id = field("UID") || fallbackId;
  if (id.length > 500 || /[\r\n\0]/.test(id)) throw Object.assign(new Error("Ongeldig contactnummer"), { statusCode: 400 });
  const normalized = data.replace(/\r?\n/g, "\r\n");
  return { uid: id, name, email: field("EMAIL").slice(0, 320), phone: field("TEL").slice(0, 100), data: field("UID") ? normalized : normalized.replace(/^END:VCARD/im, `UID:${vescape(id)}\r\nEND:VCARD`) };
}
const vescape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, (c) => "\\" + c);
export function composeVCard(id: string, name: string, email = "", phone = "") {
  return ["BEGIN:VCARD", "VERSION:4.0", `UID:${vescape(id)}`, `FN:${vescape(name)}`, ...(email ? [`EMAIL:${vescape(email)}`] : []), ...(phone ? [`TEL:${vescape(phone)}`] : []), "END:VCARD", ""].join("\r\n");
}

function calendarId(user: number, slug: string): number | null {
  const alias = (db.prepare("SELECT calendar_id FROM dav_collections WHERE user_id=? AND slug=?").get(user, slug) as { calendar_id: number } | undefined)?.calendar_id;
  if (alias) return alias;
  if (/^[1-9]\d*$/.test(slug)) return Number(slug);
  return (db.prepare("SELECT calendar_id FROM dav_collections WHERE user_id=? AND slug=?").get(user, slug) as { calendar_id: number } | undefined)?.calendar_id ?? null;
}
function calendarResources(cal: number) {
  const rows = db.prepare("SELECT * FROM events WHERE calendar_id=? ORDER BY uid").all(cal) as EventRow[];
  const groups = new Map<string, EventRow[]>();
  for (const e of rows) { const id = e.uid.split("#")[0]; const list = groups.get(id) ?? []; list.push(e); groups.set(id, list); }
  const mappings = db.prepare("SELECT filename,data,updated FROM dav_resources WHERE calendar_id=?").all(cal) as { filename: string; data: string; updated: number }[];
  return [...groups].map(([id, events]) => {
    const mapping = mappings.find((r) => calendarUid(r.data) === id);
    const data = mapping && mapping.updated >= Math.max(...events.map((e) => e.updated ?? e.start)) ? mapping.data : exportIcs(events);
    return { id, filename: mapping?.filename ?? `${digest(id)}.ics`, data, etag: etag(data), updated: Math.max(...events.map((e) => e.updated ?? e.start)), events };
  });
}
function calendarUid(data: string) {
  try {
    const root = new ICAL.Component(ICAL.parse(data));
    const events = root.getAllSubcomponents("vevent");
    const uids = [...new Set(events.map((e) => String(e.getFirstPropertyValue("uid") ?? "")))];
    if (uids.length !== 1 || !uids[0] || uids[0].length > 500 || /[\r\n#\0]/.test(uids[0])) return null;
    return uids[0];
  } catch { return null; }
}
function matches(req: FastifyRequest, current?: string) {
  const match = req.headers["if-match"], none = req.headers["if-none-match"];
  if (match && (!current || (match !== "*" && !String(match).split(/,\s*/).includes(current)))) return false;
  if (none && current && (none === "*" || String(none).split(/,\s*/).includes(current))) return false;
  return true;
}
function collectionProps(name: string, kind: "calendar" | "addressbook", tag: string) {
  return `<D:resourcetype><D:collection/><${kind === "calendar" ? "C:calendar" : "A:addressbook"}/></D:resourcetype>${prop("D:displayname", name)}${prop("CS:getctag", tag)}<D:supported-report-set><D:supported-report><D:report><${kind === "calendar" ? "C:calendar-query" : "A:addressbook-query"}/></D:report></D:supported-report><D:supported-report><D:report><${kind === "calendar" ? "C:calendar-multiget" : "A:addressbook-multiget"}/></D:report></D:supported-report></D:supported-report-set>${kind === "calendar" ? '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' : '<A:supported-address-data><A:address-data-type content-type="text/vcard" version="4.0"/><A:address-data-type content-type="text/vcard" version="3.0"/></A:supported-address-data>'}`;
}

async function davUser(req: FastifyRequest, reply: FastifyReply) {
  const session = tokenUser(tokenFrom(req));
  if (session !== null) return { id: session, scopes: ["caldav", "carddav"] };
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ") && h.length < 2048) {
    const credential = Buffer.from(h.slice(6), "base64").toString("utf8"), colon = credential.indexOf(":");
    const user = colon > 0 ? findLogin(credential.slice(0, colon)) : null;
    const row = user && db.prepare("SELECT * FROM app_credentials WHERE hash=? AND user_id=?").get(digest(credential.slice(colon + 1)), user.id) as any;
    if (row && user?.status === "active" && row.expires > Date.now() && row.generation === user.sessionGen) return { id: user.id, scopes: JSON.parse(row.scopes) as string[] };
  }
  reply.code(401).header("WWW-Authenticate", 'Basic realm="Eigen Cloud", charset="UTF-8"').send("Gebruik een app-wachtwoord uit Account → Andere agenda- en contact-apps.");
  return null;
}

export async function davRoutes(app: FastifyInstance) {
  for (const type of ["application/xml", "text/xml", "text/calendar", "text/vcard", "text/x-vcard"]) {
    app.addContentTypeParser(type, { parseAs: "string" }, (_r, b, done) => done(null, b));
  }
  app.get("/.well-known/caldav", async (_req, reply) => reply.redirect("/dav/", 301));
  app.get("/.well-known/carddav", async (_req, reply) => reply.redirect("/dav/", 301));
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("DAV", "1, calendar-access, addressbook").header("Allow", "OPTIONS, GET, HEAD, PROPFIND, REPORT, PUT, DELETE, MKCALENDAR").header("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const user = await davUser(req, reply); if (!user) return;
    let p: string[];
    try { p = decodeURIComponent(req.url.split("?")[0]).split("/").filter(Boolean); } catch { return reply.code(400).send("Ongeldig adres"); }
    if (p.some((x) => x === "." || x === "..") || p.length > 5) return reply.code(404).send();
    if (p.length > 2 && Number(p[2]) !== user.id) return reply.code(403).send();
    if (req.headers.depth && !["0", "1"].includes(String(req.headers.depth))) return reply.code(403).send("Kies diepte 0 of 1");
    const body = typeof req.body === "string" ? req.body : "";
    const report = ["PROPFIND", "REPORT", "MKCALENDAR"].includes(req.method) ? parseXml(body) : {};
    const principal = `/dav/principals/${user.id}/`;
    const homes = `${user.scopes.includes("caldav") ? `<C:calendar-home-set><D:href>/dav/calendars/${user.id}/</D:href></C:calendar-home-set>` : ""}${user.scopes.includes("carddav") ? `<A:addressbook-home-set><D:href>/dav/addressbooks/${user.id}/</D:href></A:addressbook-home-set>` : ""}`;
    if (p.length === 1 || p[1] === "principals") {
      if (req.method !== "PROPFIND") return reply.code(405).send();
      return reply.code(207).type("application/xml; charset=utf-8").send(multi([response(req.url.split("?")[0], `<D:resourcetype><D:collection/><D:principal/></D:resourcetype><D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal><D:principal-URL><D:href>${principal}</D:href></D:principal-URL>${homes}${prop("D:displayname", getUser(user.id)!.name)}`)]));
    }
    const isCalendar = p[1] === "calendars", isBook = p[1] === "addressbooks";
    if ((!isCalendar && !isBook) || !user.scopes.includes(isCalendar ? "caldav" : "carddav")) return reply.code(403).send();
    if (p.length === 3) {
      if (req.method !== "PROPFIND") return reply.code(405).send();
      const home = `/dav/${p[1]}/${user.id}/`;
      const responses = [response(home, `<D:resourcetype><D:collection/></D:resourcetype>${prop("D:displayname", isCalendar ? "Agenda's" : "Contacten")}`)];
      if (req.headers.depth !== "0") {
        if (isCalendar) {
          const calendars = db.prepare("SELECT id,name FROM calendars c WHERE user_id=? OR EXISTS (SELECT 1 FROM resource_shares s WHERE s.kind='calendar' AND s.resource_id=c.id AND s.member_id=? AND s.status='accepted')").all(user.id, user.id) as { id: number; name: string }[];
          for (const c of calendars) responses.push(response(`${home}${c.id}/`, collectionProps(c.name, "calendar", digest(JSON.stringify(calendarResources(c.id).map((r) => [r.filename, r.etag]))))));
        } else responses.push(response(`${home}contacts/`, collectionProps("Contacten", "addressbook", digest(JSON.stringify(db.prepare("SELECT id,revision FROM contacts WHERE user_id=? ORDER BY id").all(user.id))))));
      }
      return reply.code(207).type("application/xml; charset=utf-8").send(multi(responses));
    }
    if (!p[3] || !/^[A-Za-z0-9_-]{1,100}$/.test(p[3])) return reply.code(404).send();
    let cal = isCalendar ? calendarId(user.id, p[3]) : null;
    if (req.method === "MKCALENDAR" && isCalendar && p.length === 4) {
      if (cal !== null && resourceOwner("calendar", cal) !== null) return reply.code(405).send();
      const name = String(find(report, "displayname")[0] ?? p[3]).slice(0, 120);
      cal = db.transaction(() => {
        const id = Number(db.prepare("INSERT INTO calendars (name,color,user_id) VALUES (?,'#3f6f4a',?)").run(name, user.id).lastInsertRowid);
        db.prepare("INSERT INTO dav_collections VALUES (?,?,?,?)").run(crypto.randomUUID(), user.id, p[3], id); return id;
      })();
      return reply.code(201).header("Location", `/dav/calendars/${user.id}/${cal}/`).send();
    }
    if (isCalendar && (!cal || !resourceAccess("calendar", cal, user.id, !["GET", "HEAD", "PROPFIND", "REPORT"].includes(req.method)))) return reply.code(404).send();
    if (isBook && p[3] !== "contacts") return reply.code(404).send();
    const collection = `/dav/${p[1]}/${user.id}/${p[3]}/`;
    const resources = isCalendar ? calendarResources(cal!) : (db.prepare("SELECT c.*,r.filename FROM contacts c LEFT JOIN contact_resources r ON r.id=c.id WHERE c.user_id=? ORDER BY c.id").all(user.id) as any[]).map((c) => ({ id: c.id, filename: c.filename ?? `${c.id}.vcf`, data: c.vcard, etag: etag(c.vcard), updated: c.updated }));
    if (p.length === 4) {
      if (req.method === "DELETE" && isCalendar) {
        if (resourceOwner("calendar", cal) !== user.id) return reply.code(403).send();
        const count = (db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE user_id=?").get(user.id) as { n: number }).n;
        if (count < 2) return reply.code(409).send("Je laatste agenda kan niet worden verwijderd");
        db.transaction(() => { db.prepare("DELETE FROM resource_shares WHERE kind='calendar' AND resource_id=?").run(cal); db.prepare("DELETE FROM calendars WHERE id=?").run(cal); })();
        return reply.code(204).send();
      }
      if (!["PROPFIND", "REPORT"].includes(req.method)) return reply.code(405).send();
      if (find(report, "sync-collection").length) return reply.code(403).type("application/xml").send('<D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>');
      const responses: string[] = [];
      if (req.method === "PROPFIND") responses.push(response(collection, collectionProps(isCalendar ? (db.prepare("SELECT name FROM calendars WHERE id=?").get(cal) as { name: string }).name : "Contacten", isCalendar ? "calendar" : "addressbook", digest(JSON.stringify(resources.map((r) => [r.filename, r.etag]))))));
      const hrefs = find(report, "href").map(String);
      let selected = resources;
      if (hrefs.length) selected = resources.filter((r) => hrefs.some((h) => new URL(h, "http://dav.invalid").pathname === collection + encodeURIComponent(r.filename)));
      if (req.method === "REPORT") selected = selected.filter((r) => davFilterMatches(r.data, isCalendar, find(report, "filter")[0]));
      const range = find(report, "time-range")[0];
      if (isCalendar && range) {
        const stamp = (s: string) => Date.parse(s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
        const from = range["@_start"] ? stamp(range["@_start"]) : Date.now() - 366 * 864e5;
        const to = range["@_end"] ? stamp(range["@_end"]) : from + 366 * 864e5;
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * 864e5) return reply.code(400).send("Ongeldige periode");
        selected = selected.filter((r) => (r as ReturnType<typeof calendarResources>[number]).events.some((e) => expand(e, from, to).length));
      }
      if (selected.length > 10_000) return reply.code(507).send("Kies een kleinere verzameling");
      if (req.method === "REPORT" || req.headers.depth !== "0") for (const r of selected) responses.push(response(collection + encodeURIComponent(r.filename), `${prop("D:getetag", r.etag)}${prop("D:getcontenttype", isCalendar ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8")}${prop("D:getcontentlength", Buffer.byteLength(r.data))}<D:resourcetype/>${req.method === "REPORT" ? prop(isCalendar ? "C:calendar-data" : "A:address-data", r.data) : ""}`));
      for (const h of hrefs) if (!selected.some((r) => new URL(h, "http://dav.invalid").pathname === collection + encodeURIComponent(r.filename))) responses.push(missing(h));
      return reply.code(207).type("application/xml; charset=utf-8").send(multi(responses));
    }
    const filename = p[4];
    if (filename.length > 200 || /[\x00-\x1f\\/<>]/.test(filename) || !(isCalendar ? /\.ics$/i : /\.vcf$/i).test(filename)) return reply.code(404).send();
    const resource = resources.find((r) => r.filename === filename);
    if (req.method === "PROPFIND") return resource ? reply.code(207).type("application/xml; charset=utf-8").send(multi([response(collection + filename, `${prop("D:getetag", resource.etag)}${prop("D:getcontenttype", isCalendar ? "text/calendar" : "text/vcard")}<D:resourcetype/>`)])) : reply.code(404).send();
    if (["GET", "HEAD"].includes(req.method)) {
      if (!resource) return reply.code(404).send();
      if (req.headers["if-none-match"] === resource.etag) return reply.code(304).send();
      return reply.header("ETag", resource.etag).type(isCalendar ? "text/calendar; charset=utf-8" : "text/vcard; charset=utf-8").send(resource.data);
    }
    if (!["PUT", "DELETE"].includes(req.method)) return reply.code(405).send();
    if (!matches(req, resource?.etag)) {
      if (req.method === "PUT" && resource?.data === body) return reply.code(204).header("ETag", resource.etag).send();
      return reply.code(412).send("Dit bestand is intussen gewijzigd. Haal het eerst opnieuw op.");
    }
    if (req.method === "DELETE") {
      if (!resource) return reply.code(404).send();
      db.transaction(() => {
        if (isCalendar) {
          for (const e of (resource as ReturnType<typeof calendarResources>[number]).events) db.prepare("DELETE FROM events WHERE id=? AND calendar_id=?").run(e.id, cal);
          db.prepare("DELETE FROM dav_resources WHERE calendar_id=? AND filename=?").run(cal, filename);
        } else db.prepare("DELETE FROM contacts WHERE id=? AND user_id=?").run(resource.id, user.id);
      })();
      return reply.code(204).send();
    }
    if (resource && !req.headers["if-match"]) return reply.code(428).send("Gebruik If-Match om een gewijzigd bestand te bewaren");
    let savedData = body;
    if (isCalendar) {
      const id = calendarUid(body);
      if (!id) return reply.code(400).send("Een bestand moet één afspraak met een vaste UID bevatten");
      if (resource && resource.id !== id) return reply.code(409).send("De UID kan niet worden gewijzigd");
      if (!resource && resources.some((r) => r.id === id)) return reply.code(409).send("Deze afspraak heeft al een ander adres");
      const owner = resourceOwner("calendar", cal)!;
      const conflict = db.prepare("SELECT calendar_id FROM events WHERE uid=? AND user_id=? AND calendar_id!=?").get(id, owner, cal);
      if (conflict) return reply.code(409).send("Deze afspraak bestaat al in een andere agenda");
      db.transaction(() => {
        if (resource) for (const e of (resource as ReturnType<typeof calendarResources>[number]).events) db.prepare("DELETE FROM events WHERE id=? AND calendar_id=?").run(e.id, cal);
        const result = importIcs(body, cal!, owner);
        if (result.skipped || !(result.added + result.updated)) throw Object.assign(new Error("Afspraak bevat ongeldige gegevens"), { statusCode: 400 });
        const mapping = `${cal}:${filename}`;
        db.prepare("INSERT INTO dav_resources VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,etag=excluded.etag,updated=excluded.updated")
          .run(mapping, owner, cal, filename, body, etag(body), Date.now());
      })();
    } else {
      const parsed = parseVCard(body, filename.slice(0, -4));
      if (resources.some((r) => r.filename !== filename && parseVCard(r.data).uid === parsed.uid)) return reply.code(409).send("Dit contact heeft al een ander adres");
      savedData = parsed.data;
      const id = resource?.id ?? crypto.randomUUID();
      db.transaction(() => {
        db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,vcard=excluded.vcard,revision=contacts.revision+1,updated=excluded.updated")
          .run(id, user.id, parsed.name, parsed.email, parsed.phone, parsed.data, Date.now());
        db.prepare("INSERT INTO contact_resources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename").run(id, user.id, filename);
      })();
    }
    return reply.code(resource ? 204 : 201).header("ETag", etag(savedData)).send();
  };
  app.route({ method: ["OPTIONS", "GET", "HEAD", "PROPFIND", "REPORT", "PUT", "DELETE", "MKCALENDAR"] as any, url: "/dav/*", bodyLimit: 2 * 1024 * 1024, handler: handle });
  app.get("/dav", async (_req, reply) => reply.redirect("/dav/"));
}

export function contactRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.get("/api/contacts", async (req) => db.prepare("SELECT id,name,email,phone,revision,updated FROM contacts WHERE user_id=? ORDER BY name").all(uid(req)));
  app.get("/api/contacts/export.vcf", async (req, reply) => {
    reply.type("text/vcard; charset=utf-8").header("Content-Disposition", 'attachment; filename="contacten.vcf"');
    return (db.prepare("SELECT vcard FROM contacts WHERE user_id=? ORDER BY name").all(uid(req)) as { vcard: string }[]).map((c) => c.vcard).join("");
  });
  app.post<{ Body: { name: string; email?: string; phone?: string } }>("/api/contacts", { schema: { body: object({ name: { ...string(1000), minLength: 1 }, email: string(320), phone: string(100) }, ["name"]) } }, async (req) => {
    const id = crypto.randomUUID(), b = req.body;
    db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?,1,?)").run(id, uid(req), b.name, b.email ?? "", b.phone ?? "", composeVCard(id, b.name, b.email, b.phone), Date.now()); return { id };
  });
  app.put<{ Params: { id: string }; Body: { name: string; email?: string; phone?: string; revision: number } }>("/api/contacts/:id", { schema: { body: object({ name: { ...string(1000), minLength: 1 }, email: string(320), phone: string(100), revision: integer(1) }, ["name", "revision"]) } }, async (req, reply) => {
    const b = req.body;
    const current = db.prepare("SELECT vcard,revision FROM contacts WHERE id=? AND user_id=?").get(req.params.id, uid(req)) as { vcard: string; revision: number } | undefined;
    if (!current) return reply.code(404).send({ error: "Niet gevonden" });
    checkRevision(req, revisionTag("contact", req.params.id, current.revision));
    let card = current.vcard.replace(/\r?\n[ \t]/g, "");
    for (const [field, value] of [["FN", b.name], ["EMAIL", b.email ?? ""], ["TEL", b.phone ?? ""]]) {
      const pattern = new RegExp(`^((?:[^:;.]+\\.)?${field}(?:;[^:]*)?):[^\\r\\n]*\\r?\\n`, "im");
      card = pattern.test(card) ? card.replace(pattern, (_line, prefix: string) => `${prefix}:${vescape(value!)}\r\n`) : card.replace(/END:VCARD/i, `${field}:${vescape(value!)}\r\nEND:VCARD`);
    }
    const r = db.prepare("UPDATE contacts SET name=?,email=?,phone=?,vcard=?,revision=revision+1,updated=? WHERE id=? AND user_id=? AND revision=?")
      .run(b.name, b.email ?? "", b.phone ?? "", card, Date.now(), req.params.id, uid(req), b.revision);
    return r.changes ? { ok: true, revision: b.revision + 1 } : reply.code(409).send({ error: "Contact is gewijzigd of bestaat niet meer" });
  });
  app.delete<{ Params: { id: string } }>("/api/contacts/:id", async (req, reply) => {
    const current = db.prepare("SELECT revision FROM contacts WHERE id=? AND user_id=?").get(req.params.id, uid(req)) as { revision: number } | undefined;
    if (!current) return reply.code(404).send({ error: "Niet gevonden" });
    checkRevision(req, revisionTag("contact", req.params.id, current.revision));
    db.prepare("DELETE FROM contacts WHERE id=? AND user_id=?").run(req.params.id, uid(req)); return { ok: true };
  });
}
