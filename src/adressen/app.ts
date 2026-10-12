/**
 * Centrale adressendienst: geeft gratis namen (naam.<ADRES_ZONE>) uit aan aanbieders op de lijst.
 * Per naam een eigen zone in het centrale deSEC-account, een verwijzing (NS/DS) in de gedeelde zone en een
 * deSEC-token dat alleen in die zone mag schrijven. De klant krijgt een overdrachtscode waarmee een andere
 * aanbieder de naam kan overnemen. Zie ADRESSEN.md.
 */
import crypto from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { AdresConfig } from "./config.js";
import { type AdresDb, type NaamRow, openAdresDb, getNaam, log } from "./db.js";
import { CentralDesec } from "./desec.js";
import { type KnownProvider, ProviderList } from "./providers.js";
import { MAX_SKEW_MS, REPLAY_MS, normDienstUrl, verifySignature } from "./sign.js";
import { parseFreeName } from "./labels.js";
import { ApiError } from "../broker/apis.js";
import { RateLimit } from "../broker/codes.js";
import { NAMESERVERS } from "../broker/config.js";

export class AdresError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AdresCtx { cfg: AdresConfig; db: AdresDb; desec: CentralDesec; providers: ProviderList }
export interface IssuedName { naam: string; zone: string; token: string; overdrachtscode: string }

// ───────── Overdrachtscode ─────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // geen 0/O, 1/I: makkelijk over te typen
/** 20 tekens (100 bits) in groepjes van vier: "ABCD-EFGH-JKLM-NPQR-STUV". */
export function newTransferCode() {
  const chars = Array.from({ length: 20 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  return chars.match(/.{4}/g)!.join("-");
}
const normCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCode = (s: unknown) => crypto.createHash("sha256").update(normCode(s)).digest("hex");
function codeMatches(row: NaamRow, code: unknown) {
  if (!row.code_hash || normCode(code).length !== 20) return false;
  return crypto.timingSafeEqual(Buffer.from(hashCode(code), "hex"), Buffer.from(row.code_hash, "hex"));
}

// ───────── Eén ding tegelijk per naam ─────────

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// ───────── De handelingen (ook voor de CLI) ─────────

export function isFree(ctx: AdresCtx, label: string, now = Date.now()) {
  const row = getNaam(ctx.db, label);
  if (!row) return true;
  return row.status === "vrijgegeven" && now - (row.released_at ?? 0) >= ctx.cfg.quarantineMs;
}

/** Zone van de naam aanmaken (of de bestaande ophalen) en de verwijzing in de gedeelde zone zetten. */
async function ensureZone(ctx: AdresCtx, row: NaamRow, fresh: boolean) {
  const { desec, cfg } = ctx;
  let z = await desec.getZone(row.naam);
  if (z && fresh) throw new AdresError(409, `${row.naam} bestaat al bij deSEC zonder dat de adressendienst hem kent; ruim hem eerst op`);
  if (!z) {
    try { z = await desec.createZone(row.naam); }
    catch (e) {
      if (!(e instanceof ApiError && (e.status === 409 || e.status === 400))) throw e;
      z = await desec.getZone(row.naam);
      if (!z) throw new AdresError(409, `${row.naam} kan niet worden aangemaakt: ${e.message}`);
    }
  }
  const ds = ((z?.keys ?? []) as any[]).flatMap((k) => k.ds ?? []).filter(Boolean) as string[];
  await desec.putRrsets(cfg.zone, [
    { subname: row.label, type: "NS", ttl: 3600, records: NAMESERVERS.map((n) => `${n}.`) },
    ...(ds.length ? [{ subname: row.label, type: "DS", ttl: 3600, records: ds }] : []),
  ]);
}

/** Oud token intrekken, nieuw token (alleen deze zone) en nieuwe overdrachtscode voor `dienst`. */
async function issue(ctx: AdresCtx, row: NaamRow, dienst: string, ref: string | null): Promise<IssuedName> {
  if (row.token_id) {
    await ctx.desec.deleteToken(row.token_id);
    ctx.db.prepare("UPDATE namen SET token_id = NULL, updated_at = ? WHERE label = ?").run(Date.now(), row.label);
  }
  const t = await ctx.desec.scopedToken(row.naam, `adres ${row.naam}`);
  const code = newTransferCode();
  ctx.db.prepare("UPDATE namen SET dienst = ?, ref = ?, token_id = ?, code_hash = ?, status = 'actief', released_at = NULL, updated_at = ? WHERE label = ?")
    .run(dienst, ref, t.id, hashCode(code), Date.now(), row.label);
  return { naam: row.naam, zone: row.naam, token: t.token, overdrachtscode: code };
}

/** Nieuwe naam voor `dienst`. Dezelfde aanvraag (zelfde Dienst en ref) nog eens: nieuw token en nieuwe code. */
export function createName(ctx: AdresCtx, dienst: string, label: string, ref: string | null): Promise<IssuedName> {
  return withLock(label, async () => {
    const naam = `${label}.${ctx.cfg.zone}`;
    let row = getNaam(ctx.db, label);
    if (row?.status === "vrijgegeven") {
      if (!isFree(ctx, label)) {
        const from = new Date((row.released_at ?? 0) + ctx.cfg.quarantineMs).toISOString().slice(0, 10);
        throw new AdresError(409, `${naam} is net vrijgegeven en vanaf ${from} weer beschikbaar`);
      }
      ctx.db.prepare("DELETE FROM namen WHERE label = ?").run(label);
      row = undefined;
    }
    let fresh = false;
    if (row) {
      if (row.dienst !== dienst || (row.ref ?? null) !== ref) throw new AdresError(409, `${naam} is al in gebruik`);
    } else {
      const now = Date.now();
      ctx.db.prepare("INSERT INTO namen (label, naam, dienst, ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'bezig', ?, ?)").run(label, naam, dienst, ref, now, now);
      row = getNaam(ctx.db, label)!;
      fresh = true;
    }
    try { await ensureZone(ctx, row, fresh); }
    catch (e) {
      if (fresh && e instanceof AdresError) ctx.db.prepare("DELETE FROM namen WHERE label = ?").run(label);
      throw e;
    }
    const out = await issue(ctx, getNaam(ctx.db, label)!, dienst, ref);
    log(ctx.db, dienst, fresh ? "aangemaakt" : "opnieuw-uitgegeven", naam, ref ? { ref } : undefined);
    return out;
  });
}

const failedCodes = new RateLimit(10, 60 * 60_000);

function needActive(ctx: AdresCtx, label: string) {
  const row = getNaam(ctx.db, label);
  if (!row || row.status !== "actief") throw new AdresError(404, `${label}.${ctx.cfg.zone} is niet in gebruik`);
  return row;
}

/** Controleert een overdrachtscode zonder iets te veranderen. */
export function checkTransferCode(ctx: AdresCtx, dienst: string, label: string, code: unknown) {
  const row = needActive(ctx, label);
  if (!failedCodes.ok(`peek:${dienst}:${label}`)) throw new AdresError(429, "Te veel pogingen. Probeer het later opnieuw.");
  return codeMatches(row, code);
}

/** Naam overdragen aan `dienst` met de overdrachtscode van de klant. */
export function transferName(ctx: AdresCtx, dienst: string, label: string, code: unknown, ref: string | null): Promise<IssuedName> {
  return withLock(label, async () => {
    const row = needActive(ctx, label);
    // Opnieuw proberen na een onderbroken overdracht: de code is dan al vernieuwd, maar de naam is al van deze Dienst.
    const repeat = !!ref && row.dienst === dienst && row.ref === ref;
    if (!repeat && !codeMatches(row, code)) {
      if (!failedCodes.ok(label)) throw new AdresError(429, "Te veel pogingen. Probeer het later opnieuw.");
      log(ctx.db, dienst, "overdracht-geweigerd", row.naam);
      throw new AdresError(403, "De overdrachtscode klopt niet");
    }
    const from = row.dienst;
    const out = await issue(ctx, row, dienst, ref);
    log(ctx.db, dienst, repeat ? "opnieuw-uitgegeven" : "overgedragen", row.naam, { van: from, naar: dienst, ...(ref ? { ref } : {}) });
    return out;
  });
}

/** Naam vrijgeven: token weg, verwijzing weg, zone weg. `dienst` null = beheer (CLI). */
export function releaseName(ctx: AdresCtx, dienst: string | null, label: string, who = dienst ?? "beheer") {
  return withLock(label, async () => {
    const row = getNaam(ctx.db, label);
    if (!row || row.status === "vrijgegeven") throw new AdresError(404, `${label}.${ctx.cfg.zone} is niet in gebruik`);
    if (dienst !== null && row.dienst !== dienst) throw new AdresError(403, "Dit adres hoort bij een andere aanbieder");
    if (row.token_id) await ctx.desec.deleteToken(row.token_id);
    await ctx.desec.putRrsets(ctx.cfg.zone, [
      { subname: row.label, type: "NS", ttl: 3600, records: [] },
      { subname: row.label, type: "DS", ttl: 3600, records: [] },
    ]);
    await ctx.desec.deleteZone(row.naam);
    const now = Date.now();
    ctx.db.prepare("UPDATE namen SET status = 'vrijgegeven', token_id = NULL, code_hash = NULL, ref = NULL, released_at = ?, updated_at = ? WHERE label = ?").run(now, now, label);
    log(ctx.db, who, "vrijgegeven", row.naam, { was: row.dienst });
    return { naam: row.naam, vrijVanaf: new Date(now + ctx.cfg.quarantineMs).toISOString() };
  });
}

// ───────── HTTP ─────────

export interface Adressen { app: ReturnType<typeof Fastify>; ctx: AdresCtx; close(): Promise<void> }

export async function createAdressen(cfg: AdresConfig): Promise<Adressen> {
  const db = openAdresDb(cfg.dataDir);
  const ctx: AdresCtx = { cfg, db, desec: new CentralDesec(cfg.desec), providers: new ProviderList(cfg.listUrl, cfg.listCacheMs, cfg.lokaal) };
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, bodyLimit: 16 * 1024 });

  // De handtekening gaat over de body zoals verstuurd: die bewaren we naast de geparste JSON.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error("Ongeldige JSON"), { statusCode: 400 }), undefined); }
  });
  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    if (err instanceof AdresError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ApiError) {
      console.error(`[adressen] ${err.message}`);
      return reply.code(502).send({ error: `deSEC werkt nu even niet: ${err.message}` });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error("[adressen]", err);
    return reply.code(status).send({ error: status < 500 ? "Dit verzoek klopt niet" : "Er ging iets mis bij de adressendienst" });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Niet gevonden" }));

  const limits = { checkIp: new RateLimit(60, 60_000), dienst: new RateLimit(600, 60_000) };

  /** Controleert de handtekening; geeft de aanbieder (genormaliseerd adres) terug, of gooit. */
  const authenticate = async (req: FastifyRequest): Promise<{ dienst: string; provider: KnownProvider }> => {
    const h = (n: string) => { const v = req.headers[n]; return typeof v === "string" ? v.trim() : ""; };
    const dienstHdr = h("x-dienst"), tijd = h("x-tijd"), sig = h("x-handtekening");
    if (!dienstHdr || !tijd || !sig) throw new AdresError(401, "Dit verzoek is niet ondertekend");
    const t = Number(tijd);
    if (!/^\d{10,16}$/.test(tijd) || Math.abs(Date.now() - t) > MAX_SKEW_MS) throw new AdresError(401, "De klok van de Dienst wijkt te veel af (meer dan 5 minuten)");
    let provider: KnownProvider | null;
    try { provider = await ctx.providers.lookup(dienstHdr); }
    catch { throw new AdresError(503, "De lijst van aanbieders is nu niet op te halen"); }
    if (!provider) throw new AdresError(403, "Deze aanbieder staat niet op de lijst van aanbieders");
    if (!provider.key) throw new AdresError(403, "Deze aanbieder heeft geen (geldige) sleutel in de lijst van aanbieders");
    const raw = ((req as any).rawBody as string | undefined) ?? "";
    if (!verifySignature(provider.key, req.method, req.url, tijd, raw, sig)) throw new AdresError(401, "De handtekening klopt niet");
    const now = Date.now();
    db.prepare("DELETE FROM handtekeningen WHERE at < ?").run(now - REPLAY_MS);
    try { db.prepare("INSERT INTO handtekeningen (sig, at) VALUES (?, ?)").run(sig, now); }
    catch { throw new AdresError(401, "Dit verzoek is al eens gedaan"); }
    const dienst = normDienstUrl(provider.url);
    if (!limits.dienst.ok(dienst)) throw new AdresError(429, "Te veel verzoeken. Probeer het zo opnieuw.");
    return { dienst, provider };
  };

  const labelOf = (raw: unknown) => {
    const p = parseFreeName(raw, cfg.zone);
    if (!p) throw new AdresError(400, `Alleen namen onder ${cfg.zone}`);
    if ("error" in p) throw new AdresError(400, p.error);
    return p;
  };
  const refOf = (raw: unknown) => {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || raw.length > 100) throw new AdresError(400, "ref: hooguit 100 tekens");
    return raw;
  };

  app.get("/v1/info", async () => ({ zone: cfg.zone, nameservers: NAMESERVERS }));

  app.get<{ Params: { label: string } }>("/v1/naam/:label", async (req, reply) => {
    // Ondertekend (een Dienst): geen limiet per IP. Anders wel.
    if (req.headers["x-handtekening"]) await authenticate(req);
    else if (!limits.checkIp.ok(req.ip)) return reply.code(429).send({ error: "Even rustig aan: probeer het over een minuut opnieuw." });
    const { label, naam } = labelOf(req.params.label);
    return { naam, vrij: isFree(ctx, label) };
  });

  app.post<{ Body: { label?: string; ref?: string } }>("/v1/namen", async (req) => {
    const { dienst } = await authenticate(req);
    const { label } = labelOf(req.body?.label);
    return createName(ctx, dienst, label, refOf(req.body?.ref));
  });

  app.post<{ Params: { naam: string }; Body: { overdrachtscode?: string; ref?: string } }>("/v1/namen/:naam/overdragen", async (req) => {
    const { dienst } = await authenticate(req);
    const { label } = labelOf(req.params.naam);
    return transferName(ctx, dienst, label, req.body?.overdrachtscode, refOf(req.body?.ref));
  });

  app.post<{ Params: { naam: string }; Body: { overdrachtscode?: string } }>("/v1/namen/:naam/controle", async (req) => {
    const { dienst } = await authenticate(req);
    const { label, naam } = labelOf(req.params.naam);
    return { naam, geldig: checkTransferCode(ctx, dienst, label, req.body?.overdrachtscode) };
  });

  app.delete<{ Params: { naam: string } }>("/v1/namen/:naam", async (req) => {
    const { dienst } = await authenticate(req);
    const { label } = labelOf(req.params.naam);
    return releaseName(ctx, dienst, label);
  });

  // ── Beheer, alleen door de Dienst op dezelfde server (de beheerder van de adressendienst, via /beheer in de app) ──
  const beheer = async (req: FastifyRequest) => {
    const { dienst } = await authenticate(req);
    if (!ctx.providers.isLocal(dienst)) throw new AdresError(403, "Alleen de Dienst op deze server mag de adressendienst beheren");
    return dienst;
  };
  app.get("/v1/beheer/status", async (req) => {
    await beheer(req);
    let zoneOk: boolean | null = null;
    try { zoneOk = !!(await ctx.desec.getZone(cfg.zone)); } catch { zoneOk = null; }
    const count = (st: string) => (db.prepare("SELECT COUNT(*) AS n FROM namen WHERE status = ?").get(st) as { n: number }).n;
    return { zone: cfg.zone, zoneOk, publicUrl: cfg.publicUrl, namen: { actief: count("actief"), bezig: count("bezig"), vrijgegeven: count("vrijgegeven") } };
  });
  app.get("/v1/beheer/namen", async (req) => {
    await beheer(req);
    const rows = db.prepare("SELECT * FROM namen ORDER BY naam").all() as NaamRow[];
    return { namen: rows.map((r) => ({
      naam: r.naam, status: r.status, dienst: r.dienst, ref: r.ref, createdAt: r.created_at, updatedAt: r.updated_at, releasedAt: r.released_at,
      vrijVanaf: r.status === "vrijgegeven" ? (r.released_at ?? 0) + cfg.quarantineMs : null,
    })) };
  });
  app.get<{ Querystring: { naam?: string } }>("/v1/beheer/logboek", async (req) => {
    await beheer(req);
    const naam = req.query.naam ? labelOf(req.query.naam).naam : null;
    const rows = (naam
      ? db.prepare("SELECT * FROM logboek WHERE naam = ? ORDER BY id DESC LIMIT 200").all(naam)
      : db.prepare("SELECT * FROM logboek ORDER BY id DESC LIMIT 100").all()) as { at: number; dienst: string | null; actie: string; naam: string | null; detail: string | null }[];
    return { logboek: rows.map((r) => ({ at: r.at, dienst: r.dienst, actie: r.actie, naam: r.naam, detail: r.detail })) };
  });
  app.get("/v1/beheer/aanbieders", async (req) => {
    await beheer(req);
    let map: Map<string, KnownProvider>;
    try { map = await ctx.providers.refresh(); } catch { throw new AdresError(503, "De lijst van aanbieders is nu niet op te halen"); }
    const n = (url: string) => (db.prepare("SELECT COUNT(*) AS n FROM namen WHERE dienst = ? AND status != 'vrijgegeven'").get(normDienstUrl(url)) as { n: number }).n;
    return { lijst: cfg.listUrl, aanbieders: [...map.values()].map((p) => ({ naam: p.naam, url: p.url, sleutel: !!p.key, namen: n(p.url) })) };
  });
  app.post<{ Params: { naam: string } }>("/v1/beheer/namen/:naam/vrijgeven", async (req) => {
    const who = await beheer(req);
    const { label } = labelOf(req.params.naam);
    return releaseName(ctx, null, label, `beheer (${who})`);
  });

  return {
    app, ctx,
    async close() { await app.close(); db.close(); },
  };
}
