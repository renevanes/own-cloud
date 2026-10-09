import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { requireAuth, setPassword, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { mailSettings, sendNotice } from "./mail/send.js";
import * as health from "./health.js";
import { runtime } from "./cluster/runtime.js";

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

function publicBase(req: FastifyRequest) {
  const d = health.domain();
  if (runtime.enabled && d) return `https://cloud.${d}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

export function settingsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/api/settings", async (req) => {
    const { from, relay } = mailSettings();
    return {
      mailFrom: from,
      domain: health.domain(),
      relay: maskRelay(relay),
      spfExtra: getSetting("spf_extra") ?? "",
      alertEmail: getSetting("alert_email") ?? "",
      dkim: { selector: health.dkimSelector(), hasKey: !!health.dkimPublic() },
      icalUrl: config.icalToken ? `${publicBase(req)}/ical/${config.icalToken}/agenda.ics` : null,
      cluster: runtime.enabled,
    };
  });

  app.put<{ Body: { mailFrom?: string; relay?: { host: string; port: number; user?: string; password?: string; secure?: boolean } | null; spfExtra?: string; alertEmail?: string } }>("/api/settings", async (req, reply) => {
    const b = req.body ?? {};
    if (b.mailFrom !== undefined) {
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(b.mailFrom)) return reply.code(400).send({ error: "Dat is geen geldig e-mailadres" });
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

  app.post<{ Body: { current: string; next: string } }>("/api/settings/password", async (req, reply) => {
    const stored = getSetting("password_hash");
    if (!stored || !verifyPassword(req.body?.current ?? "", stored)) return reply.code(400).send({ error: "Je huidige wachtwoord klopt niet" });
    try { setPassword(req.body.next ?? ""); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    return { ok: true };
  });

  app.post<{ Body: { to?: string } }>("/api/settings/test-mail", async (req, reply) => {
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
    if (!config.icalToken) return reply.code(404).send();
    const svg = await QRCode.toString(`${publicBase(req)}/ical/${config.icalToken}/agenda.ics`, { type: "svg", margin: 1, color: { dark: "#1d2a2fff", light: "#00000000" } });
    reply.header("content-type", "image/svg+xml");
    return svg;
  });

  // ───────── Gezondheid ─────────

  app.get<{ Querystring: { fresh?: string } }>("/api/health", async (req) => {
    if (!cache || Date.now() - cache.at > 30_000 || req.query.fresh) {
      cache = { at: Date.now(), checks: await health.runChecks(clusterHealth.info?.() ?? null) };
    }
    return { checks: cache.checks, summary: health.summarize(cache.checks), checkedAt: cache.at };
  });

  app.post<{ Body: { action: string } }>("/api/health/fix", async (req, reply) => {
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
