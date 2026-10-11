/**
 * Eigen Cloud Dienst: de HTTP-API voor de app en de beheerconsole, de Mollie-webhook en de DNS-proxy.
 * De hoofdsleutel van een klant komt hier nooit; de dienst regelt alleen de accounts eromheen.
 */
import crypto from "node:crypto";
import dnsp from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { type BrokerConfig, NAMESERVERS } from "./config.js";
import { makeApis, ApiError, type Apis } from "./apis.js";
import { makeMailer, type Mailer } from "./mail.js";
import { openDb, Secrets, sha256, type CustomerRow, type OrderRow, type DomainMode, getOrder, getCustomer, event } from "./db.js";
import { type Ctx, bundleOf, initSteps, getSteps } from "./context.js";
import { type Registrant, parsePhone, readKit, splitDomain, provisionDue, desecFor } from "./provision.js";
import { parseFreeName } from "../adressen/labels.js";
import { handleWebhook, ensureSubscription } from "./payments.js";
import { cancelOrder } from "./ops.js";
import { runGuard } from "./guard.js";
import { UserError, billingView, changeBundle, startMandateChange, startSettle, resumeSubscription, domainAuthCode, setExtraUsers } from "./billing.js";
import { type InvoiceRow, readInvoice, renderInvoiceHtml } from "./invoice.js";
import { RateLimit, EMAIL, issueCode, checkCode } from "./codes.js";
import { getBrand, loadOfferingFromDb, publicBundle } from "./brand.js";
import { registerStaffAuth, ensureOwner } from "./staff.js";
import { registerAdmin } from "./admin.js";
import { registerCustomerSupport, checkHealth, useInvite, SupportError, getInvite, inviteState } from "./support.js";
import { DienstBackup, beheerToken } from "./backup.js";
import { dnsRelease, dnsBack } from "./overstap.js";
import { VERSION } from "../version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** De beheerpagina's (web-dienst/) en de lettertypes (web/fonts/), vanuit src/broker of dist/broker. */
const WEB_DIENST = path.resolve(here, "../../web-dienst");
const WEB_FONTS = path.resolve(here, "../../web/fonts");

// ───────── Kleine hulpjes ─────────

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const normDomain = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.]+$/, "");

const httpError = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

function orderSummary(o: OrderRow) {
  return { id: o.id, bundle: o.bundle, domain: o.domain, domainMode: o.domain_mode, status: o.status, createdAt: new Date(o.created_at).toISOString(), endsAt: o.ends_at };
}

async function nsDelegated(domain: string) {
  try {
    const r = new dnsp.Resolver({ timeout: 1500, tries: 1 });
    const ns = (await r.resolveNs(domain)).map((n) => n.toLowerCase().replace(/\.$/, ""));
    return NAMESERVERS.every((n) => ns.includes(n));
  } catch { return false; }
}

const PAID_PAGE = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Betaling ontvangen</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1c2430;background:#f7f8fa}
h1{font-size:1.6rem}p{font-size:1.1rem}@media (prefers-color-scheme:dark){body{background:#12161c;color:#e7ebf0}}</style></head>
<body><h1>Betaling ontvangen</h1><p>Dank je wel! Ga terug naar de app of je beheerconsole. Je cloud wordt nu klaargezet; dat duurt meestal een paar minuten.</p>
<p>Zie je hier een fout? Dan is de betaling misschien nog niet verwerkt. Even wachten en de app opnieuw openen helpt meestal.</p></body></html>`;

// ───────── De app ─────────

export interface Broker {
  app: ReturnType<typeof Fastify>;
  ctx: Ctx;
  /** Wacht tot al het achtergrondwerk (webhooks, klaarzetten) klaar is. */
  idle(): Promise<void>;
  /** Eén ronde van de achtergrondlus: ontbrekende abonnementen en klaarzetten. */
  runLoop(): Promise<void>;
  startLoops(): void;
  close(): Promise<void>;
  /** Eigen back-up van de Dienst (BROKER_BACKUP_*), of null. */
  backup: DienstBackup | null;
}

export async function createBroker(cfg: BrokerConfig, deps: { apis?: Apis; mail?: Mailer } = {}): Promise<Broker> {
  const db = openDb(cfg.dataDir);
  const pending = new Set<Promise<unknown>>();
  const ctx: Ctx = {
    cfg, db, secrets: new Secrets(cfg.secret), apis: deps.apis ?? makeApis(cfg), mail: deps.mail ?? makeMailer(cfg),
    track(p) { pending.add(p); void p.catch((e) => console.error(`[dienst] ${(e as Error).message}`)).finally(() => pending.delete(p)); },
  };
  // Aanbod uit het beheer gaat voor bundles.json; de eerste eigenaar uit BROKER_OWNER_EMAIL.
  loadOfferingFromDb(ctx);
  if (cfg.ownerEmail) {
    const r = ensureOwner(ctx, cfg.ownerEmail, "BROKER_OWNER_EMAIL");
    if (r.created) console.log(`[dienst] eigenaar ${cfg.ownerEmail} aangemaakt; inloggen op ${cfg.publicUrl}/beheer`);
  }

  // Alleen een proxy op dezelfde machine of in het eigen (Docker-)netwerk mag het IP-adres van de bezoeker doorgeven.
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, bodyLimit: 1024 * 1024 });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error("[dienst]", err);
    reply.code(status).send({ error: status < 500 ? "Dit verzoek klopt niet" : "Er ging iets mis aan onze kant. Probeer het later opnieuw." });
  });
  app.setNotFoundHandler((_req, reply) => httpError(reply, 404, "Niet gevonden"));

  // ── Status en overdragen (voor de console van de aanbieder die deze Dienst opzette) ──
  const backup = cfg.backup ? new DienstBackup(cfg.backup, cfg.secret, db, cfg.dataDir, cfg.backupEveryMs) : null;
  const startedAt = Date.now();
  /** Na het overdragen (server wordt vervangen of verwijderd) schrijft deze server niets meer. */
  let closing = false;
  app.addHook("onRequest", async (req, reply) => {
    if (closing && !(req.method === "GET" && req.url.split("?")[0] === "/v1/status")) {
      return reply.code(503).header("retry-after", "300").send({ error: "De dienst verhuist naar een nieuwe server. Probeer het over een paar minuten opnieuw." });
    }
  });
  /** Openbaar en zonder gegevens: versie, hoe lang hij draait en wanneer de laatste back-up was. */
  app.get("/v1/status", async () => ({
    version: VERSION(), uptime: Math.round((Date.now() - startedAt) / 1000),
    lastBackupAt: backup?.lastBackupAt ?? null, backup: backup ? backup.status() : "uit", closing,
  }));
  app.post("/v1/status/handover", async (req, reply) => {
    const want = Buffer.from(`Beheer ${beheerToken(cfg.secret)}`);
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return httpError(reply, 401, "Geen toegang");
    closing = true;
    try {
      const r = backup ? await backup.handover() : null;
      return { ok: true, lastBackupAt: r?.at ?? backup?.lastBackupAt ?? null, backup: !!backup };
    } catch (e) {
      closing = false;
      backup?.start();
      return httpError(reply, 502, `Laatste back-up mislukt: ${(e as Error).message}`);
    }
  });

  const limits = {
    startEmail: new RateLimit(5, 60 * 60_000),
    startIp: new RateLimit(20, 60 * 60_000),
    verifyIp: new RateLimit(30, 15 * 60_000),
    checkIp: new RateLimit(30, 60_000),
    ordersCustomer: new RateLimit(10, 60 * 60_000),
    checkoutCustomer: new RateLimit(10, 60 * 60_000),
    authcodeCustomer: new RateLimit(10, 60 * 60_000),
  };

  /**
   * Zone voor gratis adressen: die van de centrale adressendienst (BROKER_ADRES_URL) of de eigen BROKER_FREE_ZONE.
   * null = uit, of de adressendienst is nog niet bereikbaar geweest.
   */
  const freeZone = async (): Promise<string | null> => {
    if (!ctx.apis.adres) return cfg.freeZone;
    try { return await ctx.apis.adres.zoneName(); }
    catch (e) { console.error(`[dienst] adressendienst: ${(e as Error).message}`); return null; }
  };
  if (ctx.apis.adres) void freeZone();
  /** Gratis adres: "vanes" of "vanes.<zone>" → volledige naam; null als het geen gratis adres is (of het uit staat). */
  const freeName = (raw: unknown, z: string | null): { domain: string; label: string } | { error: string } | null => {
    if (!z) return null;
    const p = parseFreeName(normDomain(raw), z);
    return p && !("error" in p) ? { domain: p.naam, label: p.label } : p;
  };
  /** Vrij als er geen lopende bestelling voor is en de naam (zone) nog niet bestaat; met de adressendienst vraagt die het na. */
  const freeAvailable = async (domain: string, label: string) => {
    if (db.prepare("SELECT 1 FROM orders WHERE domain = ? AND status NOT IN ('awaiting_payment','failed')").get(domain)) return false;
    if (ctx.apis.adres) return (await ctx.apis.adres.check(label)).vrij;
    return !(await ctx.apis.desec.getZone(domain));
  };
  /** Met de adressendienst maar zonder zone (dienst onbereikbaar) en een naam zonder punt: dan liever eerlijk melden. */
  const adresDown = (raw: unknown, z: string | null) => !!ctx.apis.adres && !z && !normDomain(raw).includes(".");

  const auth = (req: FastifyRequest): CustomerRow | null => {
    const m = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const s = db.prepare("SELECT customer_id, expires_at FROM sessions WHERE token_hash = ?").get(sha256(m[1].toLowerCase())) as { customer_id: string; expires_at: number } | undefined;
    if (!s || s.expires_at < Date.now()) return null;
    return getCustomer(db, s.customer_id) ?? null;
  };
  const needAuth = (req: FastifyRequest, reply: FastifyReply) => {
    const c = auth(req);
    if (!c) { httpError(reply, 401, "Log eerst in"); return null; }
    return c;
  };
  const ownOrder = (c: CustomerRow, id: string) => {
    const o = getOrder(db, id);
    return o && o.customer_id === c.id ? o : null;
  };

  // ── Info ──
  app.get("/v1/info", async () => {
    const brand = getBrand(ctx);
    return {
      name: brand.name,
      bundles: cfg.bundles.map(publicBundle),
      termsUrl: brand.termsUrl,
      privacyUrl: brand.privacyUrl,
      freeZone: await freeZone(),
      brand,
    };
  });

  // ── Inloggen met een code per mail ──
  app.post<{ Body: { email?: string } }>("/v1/auth/start", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return httpError(reply, 400, "Vul een geldig e-mailadres in");
    if (!limits.startIp.ok(req.ip) || !limits.startEmail.ok(email)) return httpError(reply, 429, "Je hebt al een paar codes aangevraagd. Wacht even en probeer het dan opnieuw.");
    const code = issueCode(db, ctx.secrets, email);
    try {
      await ctx.mail.send(email, `Je inlogcode: ${code}`, `Hallo,\n\nJe inlogcode voor Eigen Cloud Dienst is:\n\n    ${code}\n\nDe code is 15 minuten geldig. Heb je niets aangevraagd? Dan kun je deze mail negeren.\n\nGroet,\nEigen Cloud Dienst`);
    } catch (e) {
      console.error(`[dienst] inlogcode versturen mislukt: ${(e as Error).message}`);
      return httpError(reply, 502, "We konden je de code nu niet mailen. Probeer het zo opnieuw.");
    }
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Body: { email?: string; code?: string } }>("/v1/auth/verify", async (req, reply) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!limits.verifyIp.ok(req.ip)) return httpError(reply, 429, "Te veel pogingen. Wacht even en probeer het dan opnieuw.");
    const checked = checkCode(db, ctx.secrets, email, req.body?.code);
    if (!checked.ok) return httpError(reply, checked.status, checked.error);
    let c = db.prepare("SELECT * FROM customers WHERE email = ?").get(email) as CustomerRow | undefined;
    if (!c) {
      const id = crypto.randomBytes(6).toString("hex");
      db.prepare("INSERT INTO customers (id, email, created_at) VALUES (?, ?, ?)").run(id, email, Date.now());
      c = getCustomer(db, id)!;
      event(db, null, "customer-created", { id });
    }
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, customer_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256(token), c.id, Date.now() + 90 * 86400_000, Date.now());
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    return { token, customer: { id: c.id, email: c.email } };
  });

  // ── Domein controleren ──
  app.get<{ Querystring: { name?: string } }>("/v1/domains/check", async (req, reply) => {
    const z = await freeZone();
    if (adresDown(req.query.name, z)) return httpError(reply, 502, "De adressendienst is nu even niet bereikbaar. Probeer het zo opnieuw.");
    const sub = freeName(req.query.name, z);
    if (sub) {
      if ("error" in sub) return httpError(reply, 400, sub.error);
      if (!limits.checkIp.ok(req.ip)) return httpError(reply, 429, "Even rustig aan: probeer het over een minuut opnieuw.");
      try { return { domain: sub.domain, available: await freeAvailable(sub.domain, sub.label), price: null, free: true }; }
      catch (e) { console.error(`[dienst] adrescheck: ${(e as Error).message}`); return httpError(reply, 502, "De controle werkt nu even niet. Probeer het zo opnieuw."); }
    }
    const domain = normDomain(req.query.name);
    if (!DOMAIN.test(domain)) return httpError(reply, 400, "Dat is geen geldige domeinnaam (bijvoorbeeld: jouwnaam.nl)");
    if (!limits.checkIp.ok(req.ip)) return httpError(reply, 429, "Even rustig aan: probeer het over een minuut opnieuw.");
    try {
      const { name, extension } = splitDomain(domain);
      const r = await ctx.apis.openprovider.check(name, extension);
      return { domain, available: r.available, price: r.price };
    } catch (e) {
      console.error(`[dienst] domeincheck: ${(e as Error).message}`);
      return httpError(reply, 502, "De domeincontrole werkt nu even niet. Probeer het zo opnieuw.");
    }
  });

  // ── Bestellen ──
  app.post<{ Body: any }>("/v1/orders", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const b: any = req.body ?? {};
    const bundle = bundleOf(ctx, String(b.bundle ?? ""));
    if (!bundle) return httpError(reply, 400, "Kies een bundel");
    if (b.acceptTerms !== true) return httpError(reply, 400, "Ga akkoord met de voorwaarden om te bestellen");
    const mode = b.domain?.mode as DomainMode;
    if (!["register", "transfer", "own", "sub"].includes(mode)) return httpError(reply, 400, "Kies of je een nieuwe domeinnaam wilt, er een verhuist of je eigen domeinnaam houdt");
    let domain: string;
    const z = await freeZone();
    // Overstappen met een gratis adres: de overdrachtscode van de klant (uit het pakket bij de vorige aanbieder).
    const rawTransfer = b.domain?.transferCode ?? b.transferCode;
    const transferCode = typeof rawTransfer === "string" ? rawTransfer.trim() : "";
    if (transferCode && (mode !== "sub" || !ctx.apis.adres)) return httpError(reply, 400, "Een overdrachtscode hoort bij een gratis adres van de adressendienst; die gebruikt deze dienst niet");
    if (transferCode && !/^[A-Za-z0-9-]{16,40}$/.test(transferCode)) return httpError(reply, 400, "Deze overdrachtscode klopt niet");
    if (mode === "sub") {
      if (adresDown(b.domain?.name, z)) return httpError(reply, 502, "De adressendienst is nu even niet bereikbaar. Probeer het zo opnieuw.");
      const sub = freeName(b.domain?.name, z);
      if (!sub) return httpError(reply, 400, "Gratis adressen staan uit bij deze dienst");
      if ("error" in sub) return httpError(reply, 400, sub.error);
      domain = sub.domain;
      try {
        if (transferCode) {
          if (!(await ctx.apis.adres!.verify(domain, transferCode))) return httpError(reply, 400, "Deze overdrachtscode klopt niet bij dit adres");
        } else if (!(await freeAvailable(domain, sub.label))) return httpError(reply, 409, `${domain} is al in gebruik. Kies een andere naam.`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return httpError(reply, 404, `${domain} is niet in gebruik; bestel het als nieuw gratis adres`);
        if (e instanceof ApiError && e.status === 429) return httpError(reply, 429, "Te veel pogingen. Probeer het later opnieuw.");
        console.error(`[dienst] adrescheck: ${(e as Error).message}`);
        return httpError(reply, 502, "De controle werkt nu even niet. Probeer het zo opnieuw.");
      }
    } else {
      domain = normDomain(b.domain?.name);
      if (!DOMAIN.test(domain)) return httpError(reply, 400, "Dat is geen geldige domeinnaam (bijvoorbeeld: jouwnaam.nl)");
      if (z && (domain === z || domain.endsWith(`.${z}`))) return httpError(reply, 400, "Kies voor een adres van de dienst de optie Gratis adres");
    }
    const authCode = typeof b.domain?.authCode === "string" ? b.domain.authCode.trim() : "";
    if (mode === "transfer" && !authCode) return httpError(reply, 400, "Vul de verhuiscode (autorisatiecode) van je huidige registrar in");
    let registrant: Registrant | undefined;
    if (mode === "register" || mode === "transfer") {
      const r = b.registrant ?? {};
      const need: [keyof Registrant, string][] = [["firstName", "voornaam"], ["lastName", "achternaam"], ["street", "straat"], ["number", "huisnummer"], ["zipcode", "postcode"], ["city", "plaats"], ["country", "land"], ["phone", "telefoonnummer"], ["email", "e-mailadres"]];
      const missing = need.filter(([k]) => !String(r[k] ?? "").trim()).map(([, l]) => l);
      if (missing.length) return httpError(reply, 400, `Vul de gegevens van de houder van het domein aan: ${missing.join(", ")}`);
      if (!/^[A-Za-z]{2}$/.test(String(r.country).trim())) return httpError(reply, 400, "Land als landcode van twee letters, bijvoorbeeld NL");
      if (!EMAIL.test(String(r.email).trim())) return httpError(reply, 400, "Het e-mailadres van de houder klopt niet");
      if (!parsePhone(String(r.phone))) return httpError(reply, 400, "Het telefoonnummer klopt niet. Bijvoorbeeld: +31 6 12345678");
      registrant = Object.fromEntries(Object.entries(r).filter(([k]) => ["firstName", "lastName", "company", "street", "number", "zipcode", "city", "country", "phone", "email"].includes(k)).map(([k, v]) => [k, String(v ?? "").trim()])) as unknown as Registrant;
      registrant.country = registrant.country.toUpperCase();
    }
    const taken = db.prepare("SELECT 1 FROM orders WHERE domain = ? AND status NOT IN ('awaiting_payment','cancelled','failed')").get(domain);
    if (taken) return httpError(reply, 409, "Voor dit domein loopt al een abonnement");
    const inviteRaw = typeof b.invite === "string" ? b.invite.trim() : "";
    if (inviteRaw && !inviteState(getInvite(ctx, inviteRaw)).valid) return httpError(reply, 400, `${inviteState(getInvite(ctx, inviteRaw)).reason}. Bestel zonder code of vraag een nieuwe aan.`);
    if (!limits.ordersCustomer.ok(c.id)) return httpError(reply, 429, "Je hebt net al een paar bestellingen geplaatst. Probeer het later opnieuw.");
    if (mode === "register") {
      try {
        const { name, extension } = splitDomain(domain);
        if (!(await ctx.apis.openprovider.check(name, extension)).available) return httpError(reply, 409, "Dit domein is niet (meer) vrij. Kies een andere naam, of verhuis het als het al van jou is.");
      } catch (e) {
        console.error(`[dienst] domeincheck: ${(e as Error).message}`);
        return httpError(reply, 502, "De domeincontrole werkt nu even niet. Probeer het zo opnieuw.");
      }
    }

    let inviteCode: string | null = null;
    if (inviteRaw) {
      try { inviteCode = useInvite(ctx, inviteRaw); }
      catch (e) { if (e instanceof SupportError) return httpError(reply, e.status, e.message); throw e; }
    }
    const id = crypto.randomBytes(8).toString("hex");
    // Gratis adres via de adressendienst: vastleggen bij de bestelling, ook als de instelling later verandert.
    const state = mode === "sub" && ctx.apis.adres ? { adres: "centraal" } : {};
    db.prepare("INSERT INTO orders (id, customer_id, bundle, domain, domain_mode, status, amount, input_enc, state, created_at, invite_code) VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?)")
      .run(id, c.id, bundle.id, domain, mode, bundle.monthly.value, ctx.secrets.seal({ registrant, authCode: authCode || undefined, transferCode: transferCode || undefined }, `input:${id}`), JSON.stringify(state), Date.now(), inviteCode);
    initSteps(db, id, mode);
    try {
      let mcid = c.mollie_customer_id;
      if (!mcid) {
        const mc = await ctx.apis.mollie.createCustomer(registrant ? `${registrant.firstName} ${registrant.lastName}` : c.email, c.email);
        mcid = mc.id as string;
        db.prepare("UPDATE customers SET mollie_customer_id = ? WHERE id = ?").run(mcid, c.id);
      }
      const p = await ctx.apis.mollie.createPayment({
        amount: { currency: "EUR", value: bundle.monthly.value },
        description: `Eigen Cloud ${bundle.title} — ${domain}`,
        redirectUrl: `${cfg.publicUrl}/betaald?order=${id}`,
        webhookUrl: `${cfg.publicUrl}/v1/mollie/webhook`,
        customerId: mcid,
        sequenceType: "first",
        locale: "nl_NL",
        metadata: { orderId: id },
      });
      const checkoutUrl = p?._links?.checkout?.href;
      if (!p?.id || !checkoutUrl) throw new Error("Mollie gaf geen betaallink terug");
      db.prepare("UPDATE orders SET mollie_payment_id = ? WHERE id = ?").run(p.id, id);
      setImmediateStep(id);
      event(db, id, "order-created", { bundle: bundle.id, mode, ...(inviteCode ? { invite: inviteCode } : {}), ...(transferCode ? { adres: "overnemen" } : {}) });
      return { orderId: id, checkoutUrl };
    } catch (e) {
      console.error(`[dienst] betaling aanmaken: ${(e as Error).message}`);
      db.prepare("DELETE FROM steps WHERE order_id = ?").run(id);
      db.prepare("DELETE FROM orders WHERE id = ?").run(id);
      if (inviteCode) db.prepare("UPDATE invites SET uses = MAX(uses - 1, 0) WHERE code = ?").run(inviteCode);
      return httpError(reply, 502, "Betalen lukt nu even niet. Probeer het zo opnieuw.");
    }
  });
  const setImmediateStep = (id: string) => db.prepare("UPDATE steps SET state = 'busy', detail = 'Wacht op je betaling' WHERE order_id = ? AND id = 'payment'").run(id);

  app.get<{ Params: { id: string } }>("/v1/orders/:id", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const o = ownOrder(c, req.params.id);
    if (!o) return httpError(reply, 404, "Deze bestelling bestaat niet");
    return { id: o.id, bundle: o.bundle, domain: o.domain, domainMode: o.domain_mode, status: o.status, steps: getSteps(db, o.id), ...(o.error ? { error: o.error } : {}), endsAt: o.ends_at };
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id/kit", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const o = ownOrder(c, req.params.id);
    if (!o) return httpError(reply, 404, "Deze bestelling bestaat niet");
    if (o.status === "suspended") return httpError(reply, 409, "Je abonnement is opgeschort. Neem contact met ons op.");
    // Ook bij een betalingsprobleem blijft het pakket beschikbaar: de cloud draait gewoon door.
    if (!["ready", "payment_problem"].includes(o.status) || !o.kit_enc) return httpError(reply, 409, "Je cloud is nog niet klaar. Even geduld.");
    const kit = readKit(ctx, o)!;
    kit.delegated = o.domain_mode === "register" || o.domain_mode === "sub" ? true : await nsDelegated(o.domain);
    return kit;
  });

  app.get("/v1/me", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const orders = db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC").all(c.id) as OrderRow[];
    return { customer: { id: c.id, email: c.email }, orders: orders.map(orderSummary) };
  });

  app.post<{ Params: { id: string } }>("/v1/orders/:id/cancel", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const o = ownOrder(c, req.params.id);
    if (!o) return httpError(reply, 404, "Deze bestelling bestaat niet");
    try {
      const r = await cancelOrder(ctx, o.id);
      return { ok: true, endsAt: r.endsAt };
    } catch (e) {
      console.error(`[dienst] opzeggen ${o.id}: ${(e as Error).message}`);
      return httpError(reply, 502, "Opzeggen lukt nu even niet. Probeer het zo opnieuw.");
    }
  });

  // ── Abonnement en betalingen zelf regelen ──
  /** Voert een klanthandeling uit op een eigen bestelling; UserError → nette melding, de rest → 502. */
  const selfService = <T>(name: string, fail: string, fn: (o: OrderRow) => Promise<T>, limit?: RateLimit) =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const c = needAuth(req, reply); if (!c) return;
      const o = ownOrder(c, req.params.id);
      if (!o) return httpError(reply, 404, "Deze bestelling bestaat niet");
      if (limit && !limit.ok(c.id)) return httpError(reply, 429, "Je hebt dit net al een paar keer gedaan. Probeer het later opnieuw.");
      try {
        return await fn(o);
      } catch (e) {
        if (e instanceof UserError) return httpError(reply, e.status, e.message);
        console.error(`[dienst] ${name} ${o.id}: ${(e as Error).message}`);
        event(db, o.id, `${name}-error`, (e as Error).message);
        return httpError(reply, 502, fail);
      }
    };

  app.get("/v1/orders/:id/billing", selfService("billing", "Je abonnement kan nu even niet worden opgehaald. Probeer het zo opnieuw.", (o) => billingView(ctx, o)));
  app.post<{ Params: { id: string }; Body: { bundle?: string } }>("/v1/orders/:id/bundle", (req, reply) =>
    selfService("bundle", "Je bundel wisselen lukt nu even niet. Probeer het zo opnieuw.", (o) => changeBundle(ctx, o.id, String(req.body?.bundle ?? "")))(req, reply));
  app.post("/v1/orders/:id/payment-method", selfService("payment-method", "Je betaalmethode wijzigen lukt nu even niet. Probeer het zo opnieuw.", (o) => startMandateChange(ctx, o.id), limits.checkoutCustomer));
  app.post("/v1/orders/:id/settle", selfService("settle", "Betalen lukt nu even niet. Probeer het zo opnieuw.", (o) => startSettle(ctx, o.id), limits.checkoutCustomer));
  app.post("/v1/orders/:id/resume", selfService("resume", "Je abonnement voortzetten lukt nu even niet. Probeer het zo opnieuw.", (o) => resumeSubscription(ctx, o.id)));
  app.post<{ Params: { id: string }; Body: { count?: number } }>("/v1/orders/:id/users", (req, reply) =>
    selfService("users", "Het aantal gebruikers aanpassen lukt nu even niet. Probeer het zo opnieuw.", (o) => setExtraUsers(ctx, o.id, req.body?.count))(req, reply));
  // Overstappen: DNS-zone vrijgeven voor de nieuwe aanbieder, of terughalen als het overstappen misging.
  app.post<{ Params: { id: string }; Body: { overstap?: boolean } }>("/v1/orders/:id/dns-vrijgeven", (req, reply) =>
    selfService("dns-vrijgeven", "Je DNS vrijgeven lukt nu even niet. Probeer het zo opnieuw.", (o) => dnsRelease(ctx, o.id, req.body ?? {}))(req, reply));
  app.post<{ Params: { id: string }; Body: { transferCode?: string } }>("/v1/orders/:id/dns-terug", (req, reply) =>
    selfService("dns-terug", "Je DNS terugzetten lukt nu even niet. Probeer het zo opnieuw.", (o) => dnsBack(ctx, o.id, req.body ?? {}))(req, reply));
  app.get("/v1/orders/:id/authcode", selfService("authcode", "De verhuiscode opvragen lukt nu even niet. Probeer het zo opnieuw.", (o) => domainAuthCode(ctx, o.id), limits.authcodeCustomer));

  app.get<{ Params: { id: string } }>("/v1/invoices/:id", async (req, reply) => {
    const c = needAuth(req, reply); if (!c) return;
    const row = /^[0-9a-f]{16}$/.test(req.params.id) ? (db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) as InvoiceRow | undefined) : undefined;
    if (!row || row.customer_id !== c.id) return httpError(reply, 404, "Deze factuur bestaat niet");
    return reply.type("text/html; charset=utf-8").header("cache-control", "private, no-store").send(renderInvoiceHtml(readInvoice(ctx, row)));
  });

  // ── Mollie ──
  app.post<{ Body: { id?: string } }>("/v1/mollie/webhook", async (req, reply) => {
    const id = String((req.body as any)?.id ?? "");
    if (id) ctx.track(handleWebhook(ctx, id));
    return reply.code(200).send("");
  });

  app.get("/betaald", async (_req, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(PAID_PAGE));

  // ── DNS-proxy: het cluster praat "deSEC" met zijn eigen token, wij met het echte (of dat van het gratis adres) ──
  const proxy = async (req: FastifyRequest<{ Params: { zone: string; "*"?: string } }>, reply: FastifyReply) => {
    const zone = req.params.zone.toLowerCase();
    const sub = req.params["*"] ?? "";
    const m = /^Token ([0-9a-f]{64})$/i.exec(req.headers.authorization ?? "");
    if (!m) return httpError(reply, 403, "Geen geldige DNS-toegang");
    const o = db.prepare("SELECT * FROM orders WHERE dns_token_hash = ?").get(sha256(m[1].toLowerCase())) as OrderRow | undefined;
    if (!o || o.domain !== zone || o.status === "suspended") return httpError(reply, 403, "Deze DNS-toegang hoort niet bij dit domein");
    if (!DOMAIN.test(zone) || sub.includes("..") || !(sub === "" ? req.method === "GET" : sub.startsWith("rrsets/"))) return httpError(reply, 403, "Dit deel van de DNS-zone is niet toegankelijk");
    const q = req.url.indexOf("?");
    const query = q >= 0 ? req.url.slice(q) : "";
    const body = req.body === undefined || req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body);
    try {
      const r = await desecFor(ctx, o).forward(req.method, `/domains/${zone}/${sub}${query}`, body);
      const text = await r.text();
      reply.code(r.status);
      if (r.status === 204 || !text) return reply.send();
      return reply.type(r.headers.get("content-type") ?? "application/json").send(text);
    } catch (e) {
      return httpError(reply, 502, `DNS-dienst niet bereikbaar: ${(e as Error).message}`);
    }
  };
  app.route({ method: ["GET", "PUT", "PATCH", "POST", "DELETE"], url: "/v1/desec/domains/:zone/*", handler: proxy });

  // ── acme-dns (voor Caddy's certificaten): alleen het TXT-record _acme.<domein>, de laatste twee waarden ──
  app.post<{ Body: { subdomain?: string; txt?: string } }>("/v1/acme-dns/update", async (req, reply) => {
    const user = String(req.headers["x-api-user"] ?? ""), key = String(req.headers["x-api-key"] ?? "").toLowerCase();
    const o = /^[0-9a-f]{64}$/.test(key) ? (db.prepare("SELECT * FROM orders WHERE dns_token_hash = ?").get(sha256(key)) as OrderRow | undefined) : undefined;
    if (!o || o.id !== user || o.status === "suspended") return httpError(reply, 401, "Geen geldige toegang");
    const txt = String(req.body?.txt ?? "");
    if (req.body?.subdomain !== "_acme" || !/^[A-Za-z0-9_-]{43}$/.test(txt)) return httpError(reply, 400, "Ongeldig verzoek");
    try {
      const desec = desecFor(ctx, o);
      const cur = (await desec.getRrset(o.domain, "_acme", "TXT")) as { records?: string[] } | null;
      const keep = (cur?.records ?? []).filter((r) => r !== `"${txt}"`).slice(-1);
      await desec.putRrsets(o.domain, [{ subname: "_acme", type: "TXT", ttl: 3600, records: [...keep, `"${txt}"`] }]);
      return { txt };
    } catch (e) {
      return httpError(reply, 502, `DNS-dienst niet bereikbaar: ${(e as Error).message}`);
    }
  });
  app.get("/v1/desec/domains/:zone/", proxy);

  // ── Aanbieder: medewerkers, beheer-API, hulpvragen, berichten, gezondheid ──
  registerStaffAuth(app, ctx, httpError);
  registerAdmin(app, ctx, httpError);
  registerCustomerSupport(app, ctx, httpError, needAuth);

  // ── Beheerpagina's (/beheer) ──
  if (fs.existsSync(WEB_DIENST)) {
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.url.startsWith("/beheer")) {
        reply.header("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob: data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
        reply.header("x-content-type-options", "nosniff");
        reply.header("referrer-policy", "no-referrer");
        reply.header("cache-control", "no-cache");
      }
      return payload;
    });
    app.get("/beheer", async (_req, reply) => reply.redirect("/beheer/"));
    await app.register(fastifyStatic, { root: WEB_DIENST, prefix: "/beheer/", decorateReply: false });
    if (fs.existsSync(WEB_FONTS)) await app.register(fastifyStatic, { root: WEB_FONTS, prefix: "/beheer/fonts/", decorateReply: false });
  }

  // ── Achtergrond ──
  const timers: NodeJS.Timeout[] = [];
  let looping = false;
  const loop = async () => {
    if (looping) return;
    looping = true;
    try {
      // Gemiste webhook (bijv. Mollie kon ons even niet bereiken)? Open eerste betalingen af en toe zelf nakijken.
      const now = Date.now();
      const open = db.prepare("SELECT id, mollie_payment_id FROM orders WHERE status = 'awaiting_payment' AND mollie_payment_id IS NOT NULL AND created_at BETWEEN ? AND ? AND next_attempt_at <= ?")
        .all(now - 48 * 3600_000, now - 2 * 60_000, now) as { id: string; mollie_payment_id: string }[];
      for (const o of open) {
        db.prepare("UPDATE orders SET next_attempt_at = ? WHERE id = ?").run(now + 5 * 60_000, o.id);
        await handleWebhook(ctx, o.mollie_payment_id).catch((e) => event(db, o.id, "payment-poll-error", (e as Error).message));
      }
      const noSub = db.prepare("SELECT id FROM orders WHERE paid_at IS NOT NULL AND mollie_subscription_id IS NULL AND status NOT IN ('cancelled','awaiting_payment')").all() as { id: string }[];
      for (const { id } of noSub) await ensureSubscription(ctx, id).catch((e) => event(db, id, "subscription-error", (e as Error).message));
      await provisionDue(ctx);
      await checkHealth(ctx).catch((e) => console.error(`[dienst] gezondheid: ${(e as Error).message}`));
    } finally { looping = false; }
  };

  return {
    app, ctx, backup,
    runLoop: loop,
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
    startLoops() {
      timers.push(setInterval(() => ctx.track(loop()), cfg.loopMs));
      timers.push(setInterval(() => ctx.track(runGuard(ctx)), cfg.guardMs));
      ctx.track(loop());
      backup?.start();
    },
    async close() {
      for (const t of timers) clearInterval(t);
      await app.close();
      while (pending.size) await Promise.allSettled([...pending]);
      // Bij stoppen (bijv. een update) nog één back-up, behalve na het overdragen.
      if (backup?.started && !backup.retired) { backup.stop(); await backup.run().catch(() => {}); }
      db.close();
    },
  };
}
