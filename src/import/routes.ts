import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAuth, uid } from "../auth.js";
import { OWNER_ID } from "../users.js";
import { config } from "../config.js";
import { newProgress, processTakeout, type ImportProgress } from "./takeout.js";

/**
 * Importeren vanuit de browser. Bestanden komen in blokken binnen (hervatbaar na een verbroken verbinding),
 * daarna wordt alles in één keer verwerkt met zichtbare voortgang.
 */

interface UploadMeta { id: string; name: string; size: number; received: number; created: number }

/** Uploads per gebruiker: de eigenaar in import/ (zoals voorheen), anderen in import/u<id>/. */
const dir = (userId: number) => {
  const d = userId === OWNER_ID ? path.join(config.dataDir, "import") : path.join(config.dataDir, "import", `u${userId}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const metaFile = (u: number, id: string) => path.join(dir(u), `${id}.json`);
const partFile = (u: number, id: string) => path.join(dir(u), `${id}.part`);
const readMeta = (u: number, id: string): UploadMeta | null => {
  if (!/^[a-f0-9]{16}$/.test(id) || !fs.existsSync(metaFile(u, id))) return null;
  return JSON.parse(fs.readFileSync(metaFile(u, id), "utf8"));
};
const writeMeta = (u: number, m: UploadMeta) => fs.writeFileSync(metaFile(u, m.id), JSON.stringify(m));
const listUploads = (u: number): UploadMeta[] =>
  fs.readdirSync(dir(u)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir(u), f), "utf8")) as UploadMeta).sort((a, b) => a.created - b.created);

type Job = { running: boolean; progress: ImportProgress; error: string | null; startedAt: number; finishedAt: number | null };
const jobs = new Map<number, Job>();

export function importRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/import/uploads", async (req) => listUploads(uid(req)));

  app.post<{ Body: { name: string; size: number } }>("/api/import/uploads", async (req, reply) => {
    const u = uid(req);
    const { name, size } = req.body ?? ({} as never);
    if (!name || !(size > 0)) return reply.code(400).send({ error: "Naam en grootte zijn verplicht" });
    if (!/\.(zip|mbox|ics)$/i.test(name)) return reply.code(400).send({ error: "Alleen .zip (Google Takeout), .mbox of .ics" });
    const free = fs.statfsSync(config.dataDir);
    if (free.bavail * free.bsize < size * 2.2) return reply.code(507).send({ error: `Niet genoeg schijfruimte: nodig ±${Math.ceil((size * 2.2) / 1e9)} GB` });
    const existing = listUploads(u).find((u) => u.name === name && u.size === size);
    if (existing) return existing; // hervatten
    const m: UploadMeta = { id: crypto.randomBytes(8).toString("hex"), name: path.basename(name), size, received: 0, created: Date.now() };
    fs.writeFileSync(partFile(u, m.id), "");
    writeMeta(u, m);
    return m;
  });

  app.put<{ Params: { id: string }; Querystring: { offset: string } }>("/api/import/uploads/:id", async (req, reply) => {
    const u = uid(req);
    const m = readMeta(u, req.params.id);
    if (!m) return reply.code(404).send({ error: "Onbekende upload" });
    const offset = Number(req.query.offset);
    if (offset !== m.received) return reply.code(409).send({ error: "Verkeerde positie", received: m.received });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "Leeg blok" });
    if (m.received + body.length > m.size) return reply.code(400).send({ error: "Meer data dan aangekondigd" });
    fs.appendFileSync(partFile(u, m.id), body);
    m.received += body.length;
    writeMeta(u, m);
    return { received: m.received, done: m.received === m.size };
  });

  app.delete<{ Params: { id: string } }>("/api/import/uploads/:id", async (req, reply) => {
    const u = uid(req);
    const m = readMeta(u, req.params.id);
    if (!m) return reply.code(404).send();
    fs.rmSync(partFile(u, m.id), { force: true });
    fs.rmSync(metaFile(u, m.id), { force: true });
    return { ok: true };
  });

  app.post<{ Body: { ids?: string[] } }>("/api/import/start", async (req, reply) => {
    const u = uid(req);
    if (jobs.get(u)?.running) return reply.code(409).send({ error: "Er loopt al een import" });
    const all = listUploads(u);
    const chosen = (req.body?.ids?.length ? all.filter((u) => req.body.ids!.includes(u.id)) : all);
    if (!chosen.length) return reply.code(400).send({ error: "Upload eerst je bestanden" });
    const unfinished = chosen.filter((u) => u.received < u.size);
    if (unfinished.length) return reply.code(400).send({ error: `Nog niet compleet: ${unfinished.map((u) => u.name).join(", ")}` });

    const current: Job = { running: true, progress: newProgress(), error: null, startedAt: Date.now(), finishedAt: null };
    jobs.set(u, current);
    void (async () => {
      try {
        await processTakeout(chosen.map((x) => ({ path: partFile(u, x.id), name: x.name })), dir(u), current.progress, () => {}, u);
        for (const x of chosen) { fs.rmSync(partFile(u, x.id), { force: true }); fs.rmSync(metaFile(u, x.id), { force: true }); }
      } catch (e) {
        current.error = (e as Error).message.includes("NOT_LEADER")
          ? "Het cluster wisselde van leider tijdens de import. Start opnieuw; wat al binnen is wordt overgeslagen."
          : (e as Error).message;
      } finally {
        current.running = false;
        current.finishedAt = Date.now();
      }
    })();
    return { ok: true };
  });

  app.get("/api/import/status", async (req) => jobs.get(uid(req)) ?? { running: false, progress: null, error: null });
}
