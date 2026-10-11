import type { FastifyInstance } from "fastify";
import { requireOwner } from "../auth.js";
import { db, setSetting } from "../db.js";
import {
  cleanPassword, enableSendViaGmail, friendlyError, gmailConfig, gmailHooks, isRunning, kickGmail, maskCalendarUrl,
  pruneCalendars, readStatus, restoreSendSettings, testConnection, validCalendarUrl, type FollowedCalendar, type GmailMode,
} from "./sync.js";

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

interface PutBody {
  mode?: GmailMode;
  address?: string;
  password?: string;
  sendViaGmail?: boolean;
  calendars?: FollowedCalendar[];
  copySent?: boolean;
  copyToInbox?: boolean;
}

function view() {
  const c = gmailConfig();
  return {
    mode: c.mode,
    address: c.address,
    hasPassword: !!c.password,
    sendViaGmail: c.sendViaGmail,
    calendars: c.calendars.map((x) => ({ name: x.name, url: maskCalendarUrl(x.url) })),
    copySent: c.copySent,
    copyToInbox: c.copyToInbox,
    status: { ...readStatus(), running: isRunning() },
  };
}

export function gmailRoutes(app: FastifyInstance) {
  // De Gmail-koppeling hoort bij de eigenaar (zijn adres, MX van het domein, versturen via Gmail).
  app.addHook("preHandler", requireOwner);

  app.get("/api/gmail", async () => view());

  app.put<{ Body: PutBody }>("/api/gmail", async (req, reply) => {
    const b = req.body ?? {};
    const cur = gmailConfig();
    const bad = (error: string) => reply.code(400).send({ error });

    if (b.mode !== undefined && !["uit", "naast", "vangnet"].includes(b.mode)) return bad("Onbekende stand");
    const mode = b.mode ?? cur.mode;
    const address = b.address !== undefined ? b.address.trim().toLowerCase() : cur.address;
    if (b.address !== undefined && address && !EMAIL.test(address)) return bad("Dat is geen geldig Gmail-adres");
    const password = b.password ? cleanPassword(b.password) : cur.password;
    if (b.password && password.length < 8) return bad("Een app-wachtwoord van Google heeft 16 letters");
    if (mode !== "uit" && (!address || !password)) return bad("Vul je Gmail-adres en een app-wachtwoord in");

    let calendars = cur.calendars;
    if (b.calendars !== undefined) {
      if (!Array.isArray(b.calendars) || b.calendars.length > 30) return bad("Te veel agenda's");
      const names = new Set<string>();
      calendars = [];
      for (const c of b.calendars) {
        const name = String(c?.name ?? "").trim().slice(0, 60);
        let url = String(c?.url ?? "").trim();
        if (!name && !url) continue;
        if (!name) return bad("Geef elke agenda een naam");
        if (names.has(name.toLowerCase())) return bad(`De naam '${name}' komt twee keer voor`);
        names.add(name.toLowerCase());
        // Ongewijzigd (gemaskeerd) adres: het bewaarde adres houden.
        if (url.includes("••••")) {
          const known = cur.calendars.find((k) => maskCalendarUrl(k.url) === url);
          if (!known) return bad(`Vul het geheime adres van '${name}' opnieuw in`);
          url = known.url;
        }
        if (!validCalendarUrl(url)) return bad(`Het adres van '${name}' is geen geheim iCal-adres van Google Agenda (het begint met https://calendar.google.com/)`);
        calendars.push({ name, url });
      }
    }

    const sendViaGmail = b.sendViaGmail ?? cur.sendViaGmail;
    db.transaction(() => {
      if (mode === "vangnet" && cur.mode !== "vangnet") {
        // Alleen mail die vanaf nu binnenkomt gaat naar Gmail.
        const max = (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages").get() as { n: number }).n;
        setSetting("gmail_vangnet_start", String(max));
        setSetting("gmail_vangnet_last", String(max));
      }
      setSetting("gmail_mode", mode);
      setSetting("gmail_address", address);
      if (password) setSetting("gmail_password", password);
      setSetting("gmail_send", sendViaGmail ? "1" : "0");
      setSetting("gmail_calendars", JSON.stringify(calendars));
      if (b.copySent !== undefined) setSetting("gmail_copy_sent", b.copySent ? "1" : "0");
      if (b.copyToInbox !== undefined) setSetting("gmail_copy_inbox", b.copyToInbox ? "1" : "0");
      if (mode === "naast" && sendViaGmail) enableSendViaGmail(address, password);
      else restoreSendSettings();
      if (b.calendars !== undefined) pruneCalendars(calendars);
      if (mode !== cur.mode || address !== cur.address || b.password) {
        const st = readStatus();
        setSetting("gmail_status", JSON.stringify({ ...st, error: null, lastOk: mode === cur.mode ? st.lastOk : null }));
      }
    })();
    if (mode !== cur.mode) gmailHooks.changed?.();
    if (mode !== "uit") void kickGmail();
    return view();
  });

  app.post<{ Body: { address?: string; password?: string } }>("/api/gmail/test", async (req, reply) => {
    const cur = gmailConfig();
    const address = (req.body?.address || cur.address).trim().toLowerCase();
    const password = req.body?.password ? cleanPassword(req.body.password) : cur.password;
    if (!address || !EMAIL.test(address)) return reply.code(400).send({ error: "Vul eerst je Gmail-adres in" });
    if (!password) return reply.code(400).send({ error: "Vul eerst een app-wachtwoord in" });
    try {
      return await testConnection(address, password);
    } catch (e) {
      return reply.code(400).send({ ok: false, error: friendlyError(e) });
    }
  });

  app.post<{ Querystring: { wait?: string } }>("/api/gmail/sync", async (req, reply) => {
    if (gmailConfig().mode === "uit") return reply.code(400).send({ error: "De Gmail-koppeling staat uit" });
    const p = kickGmail();
    if (req.query.wait) await p;
    return { ok: true, status: { ...readStatus(), running: isRunning() } };
  });

}
