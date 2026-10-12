import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { createToken, passwordHashOf, requireAuth, requireOwner, setSessionCookie, setUserPassword, uid, verifyPassword } from "./auth.js";
import { OWNER_ID, getUser, recipientUser } from "./users.js";
import { icalTokenFor } from "./calendar/routes.js";
import { getSetting, setSetting } from "./db.js";
import { mailSettings, sendNotice } from "./mail/send.js";
import * as health from "./health.js";
import { runtime } from "./cluster/runtime.js";
import { secondFactor } from "./security/account.js";
import { checkRateLimit } from "./security/rateLimit.js";

/** Koppeling naar het cluster (alleen gezet in clustermodus). */
export const clusterHealth: {
  info?: () => health.ClusterInfo;
  fix?: (action: string) => Promise<string>;
  round?: () => Promise<health.Check[]>;
} = {};

let cache: { at: number; checks: health.Check[] } | null = null;

function maskRelay(url: string | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || (u.protocol === "smtps:" ? 465 : 587)), user: decodeURIComponent(u.username), hasPassword: !!u.password, secure: u.protocol === "smtps:" };
  } catch { return null; }
}

export function publicBase(req: FastifyRequest) {
  const d = health.domain();
  if (runtime.enabled && d) return `https://cloud.${d}`;
  const proto = req.protocol;
  return `${proto}://${req.headers.host}`;
}

export function settingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  const icalUrl = (req: FastifyRequest) => {
    const t = icalTokenFor(uid(req));
    return t ? `${publicBase(req)}/ical/${t}/agenda.ics` : null;
  };

  app.get("/api/settings", async (req) => {
    const me = getUser(uid(req))!;
    // Extra gebruikers zien alleen wat over henzelf gaat; de rest is beheer van de cloud (eigenaar).
    if (!me.owner) return { owner: false, mailFrom: me.address, domain: health.domain(), icalUrl: icalUrl(req), cluster: runtime.enabled };
    const { from, relay } = mailSettings();
    return {
      owner: true,
      mailFrom: from,
      domain: health.domain(),
      relay: maskRelay(relay),
      spfExtra: getSetting("spf_extra") ?? "",
      alertEmail: getSetting("alert_email") ?? "",
      dkim: { selector: health.dkimSelector(), hasKey: !!health.dkimPublic() },
      icalUrl: icalUrl(req),
      cluster: runtime.enabled,
      // Tijdelijk versturen via Gmail (Instellingen → Gmail): dan is je eigen adres apart bewaard.
      gmailSend: getSetting("gmail_prev_send") !== undefined ? { ownFrom: getSetting("gmail_own_from") ?? null } : null,
    };
  });

  app.put<{ Body: { mailFrom?: string; relay?: { host: string; port: number; user?: string; password?: string; secure?: boolean } | null; spfExtra?: string; alertEmail?: string } }>("/api/settings", { preHandler: requireOwner }, async (req, reply) => {
    const b = req.body ?? {};
    if (b.mailFrom !== undefined) {
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(b.mailFrom)) return reply.code(400).send({ error: "Dat is geen geldig e-mailadres" });
      const taken = recipientUser(b.mailFrom.trim());
      if (taken !== null && taken !== OWNER_ID) return reply.code(400).send({ error: "Dat adres is van een andere gebruiker in je cloud" });
      setSetting("mail_from", b.mailFrom.trim());
    }
    if (b.alertEmail !== undefined) {
      if (b.alertEmail && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(b.alertEmail)) return reply.code(400).send({ error: "Dat is geen geldig e-mailadres" });
      setSetting("alert_email", b.alertEmail.trim());
    }
    if (b.spfExtra !== undefined) setSetting("spf_extra", b.spfExtra.trim());
    if (b.relay === null) setSetting("mail_relay", "");
    else if (b.relay) {
      const old = maskRelay(mailSettings().relay);
      let pass = b.relay.password;
      if (!pass && old?.hasPassword) pass = decodeURIComponent(new URL(mailSettings().relay!).password);
      const proto = b.relay.secure ? "smtps" : "smtp";
      const auth = b.relay.user ? `${encodeURIComponent(b.relay.user)}:${encodeURIComponent(pass ?? "")}@` : "";
      setSetting("mail_relay", `${proto}://${auth}${b.relay.host}:${b.relay.port}`);
    }
    cache = null;
    return { ok: true };
  });

  /** Je eigen wachtwoord wijzigen (iedereen). Je krijgt meteen een nieuwe sessie. */
  app.post<{ Body: { current: string; next: string; code?: string } }>("/api/settings/password", async (req, reply) => {
    const id = uid(req);
    checkRateLimit(`password:${id}`);
    const stored = passwordHashOf(id);
    if (!stored || !verifyPassword(req.body?.current ?? "", stored)) return reply.code(400).send({ error: "Je huidige wachtwoord klopt niet" });
    if (!secondFactor(id, req.body.code ?? "")) return reply.code(400).send({ error: "Vul een geldige tweede inlogcode of herstelcode in" });
    try { setUserPassword(id, req.body.next ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const token = createToken(getUser(id)!);
    setSessionCookie(reply, token);
    return { ok: true, token };
  });

  app.post<{ Body: { to?: string } }>("/api/settings/test-mail", { preHandler: requireOwner }, async (req, reply) => {
    const to = req.body?.to || getSetting("alert_email");
    if (!to) return reply.code(400).send({ error: "Vul eerst een adres in" });
    try {
      await sendNotice(to, "Testbericht van Eigen Cloud", "Dit is een testbericht. Komt het aan, dan werkt het versturen van mail.");
      return { ok: true, to };
    } catch (e) {
      return reply.code(502).send({ error: `Versturen mislukt: ${(e as Error).message}` });
    }
  });

  app.get("/api/settings/ical-qr", async (req, reply) => {
    const url = icalUrl(req);
    if (!url) return reply.code(404).send();
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#1d2a2fff", light: "#00000000" } });
    reply.header("content-type", "image/svg+xml");
    return svg;
  });

  // ───────── Gezondheid ─────────

  /**
   * Gezondheid. De eigenaar ziet alle controles; een extra gebruiker alleen de samenvatting (ok / let op / probleem),
   * zodat de telefoon-app ook bij hem kan melden dat de cloud hapert, zonder technische details van de servers.
   */
  app.get<{ Querystring: { fresh?: string } }>("/api/health", async (req) => {
    const owner = uid(req) === OWNER_ID;
    if (!cache || Date.now() - cache.at > 30_000 || (req.query.fresh && owner)) {
      cache = { at: Date.now(), checks: await health.runChecks(clusterHealth.info?.() ?? null) };
    }
    return { checks: owner ? cache.checks : [], summary: health.summarize(cache.checks), checkedAt: cache.at };
  });

  app.post<{ Body: { action: string } }>("/api/health/fix", { preHandler: requireOwner }, async (req, reply) => {
    const action = req.body?.action;
    try {
      let message: string;
      if (clusterHealth.fix) message = await clusterHealth.fix(action);
      else if (action === "dkim:generate") { health.generateDkim(); message = "DKIM-sleutel gemaakt. Zet het record hieronder in je DNS."; }
      else return reply.code(400).send({ error: "Dit kan alleen automatisch als je cloud via de beheerconsole draait" });
      cache = null;
      return { ok: true, message };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
