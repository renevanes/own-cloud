import fs from "node:fs";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { db, getSetting, setSetting } from "../db.js";
import { storeRawMessage } from "../mail/store.js";
import { mailSettings } from "../mail/send.js";
import { gmailLabelListToOptions } from "../import/gmail.js";
import { importIcs } from "../calendar/ics.js";
import { ensureLocal } from "../blobs.js";
import { isNotLeader } from "../cluster/fence.js";
import { runtime } from "../cluster/runtime.js";

/**
 * Gmail-koppeling.
 *  - "naast"   (proefperiode): mail komt nog bij Google binnen; wij halen hem op via IMAP (eenrichtings,
 *               Gmail → Eigen Cloud), volgen Google-agenda's via hun geheime iCal-adres en kunnen via
 *               smtp.gmail.com versturen.
 *  - "vangnet" (na overstappen): elke nieuwe mail in Eigen Cloud wordt naar Gmail gekopieerd (label "Eigen Cloud").
 * Alle voortgang staat in de gerepliceerde settings-tabel, zodat een nieuwe clusterleider verder gaat waar de vorige stopte.
 */

export type GmailMode = "uit" | "naast" | "vangnet";
export interface FollowedCalendar { name: string; url: string }
export interface GmailStatus {
  lastRun: number | null;
  lastOk: number | null;
  error: string | null;
  counts: { imported: number; copied: number; calendars: number; events: number };
  initialSync: { done: number; total: number } | null;
  calendarErrors: string[];
}

export const LABEL = "Eigen Cloud";
export const CAL_PREFIX = "Google: ";
const BATCH = 100;
const ROUND_BUDGET_MS = 40_000;

// ───────── Instellingen ─────────

const json = <T>(key: string, fallback: T): T => {
  try { const v = getSetting(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};

export function gmailConfig() {
  const m = getSetting("gmail_mode");
  return {
    mode: (m === "naast" || m === "vangnet" ? m : "uit") as GmailMode,
    address: getSetting("gmail_address") ?? "",
    password: getSetting("gmail_password") ?? "",
    sendViaGmail: getSetting("gmail_send") === "1",
    calendars: json<FollowedCalendar[]>("gmail_calendars", []),
    copySent: getSetting("gmail_copy_sent") === "1",
    copyToInbox: getSetting("gmail_copy_inbox") === "1",
  };
}

export function readStatus(): GmailStatus {
  const s = json<Partial<GmailStatus>>("gmail_status", {});
  return {
    lastRun: s.lastRun ?? null, lastOk: s.lastOk ?? null, error: s.error ?? null,
    counts: { imported: 0, copied: 0, calendars: 0, events: 0, ...(s.counts ?? {}) },
    initialSync: s.initialSync ?? null, calendarErrors: s.calendarErrors ?? [],
  };
}
function writeStatus(s: GmailStatus) { setSetting("gmail_status", JSON.stringify(s)); }

export function imapTarget() {
  return {
    host: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.GMAIL_IMAP_PORT || 993),
    secure: process.env.GMAIL_IMAP_SECURE !== "0",
  };
}

/** Google laat het app-wachtwoord zien als "abcd efgh ijkl mnop"; spaties tellen niet mee. */
export const cleanPassword = (p: string) => p.replace(/\s+/g, "");

// ───────── Uitgaande mail via Gmail ─────────

/** Zet uitgaande mail via smtp.gmail.com aan; de vorige relay en afzender worden onthouden. */
export function enableSendViaGmail(address: string, password: string) {
  if (getSetting("gmail_prev_send") === undefined) {
    setSetting("gmail_prev_send", JSON.stringify({ relay: getSetting("mail_relay") ?? null, from: getSetting("mail_from") ?? null }));
    setSetting("gmail_own_from", mailSettings().from);
  }
  setSetting("mail_relay", `smtps://${encodeURIComponent(address)}:${encodeURIComponent(password)}@smtp.gmail.com:465`);
  setSetting("mail_from", address);
}

/** Zet de relay en afzender van vóór "versturen via Gmail" terug. */
export function restoreSendSettings() {
  const raw = getSetting("gmail_prev_send");
  if (raw === undefined) return;
  const prev = JSON.parse(raw) as { relay: string | null; from: string | null };
  const put = (key: string, v: string | null) => (v === null ? db.prepare("DELETE FROM settings WHERE key = ?").run(key) : setSetting(key, v));
  db.transaction(() => {
    put("mail_relay", prev.relay);
    put("mail_from", prev.from);
    db.prepare("DELETE FROM settings WHERE key IN ('gmail_prev_send', 'gmail_own_from')").run();
  })();
}

// ───────── Agenda-adressen ─────────

/** Alleen het geheime iCal-adres van Google Agenda (https://calendar.google.com/...). */
export function validCalendarUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (process.env.GMAIL_TEST_ALLOW_LOCAL === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
  return u.protocol === "https:" && u.hostname === "calendar.google.com" && !u.username && !u.password && (!u.port || u.port === "443");
}

/** Het geheime deel van het adres verbergen. */
export function maskCalendarUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").map((p) => (/^private-/.test(p) ? "private-••••" : p));
    let path = parts.join("/");
    if (path === u.pathname) path = path.replace(/[^/]{8,}(?=\/[^/]*$)/, (s) => s.slice(0, 4) + "••••");
    return `${u.protocol}//${u.host}${path}`;
  } catch { return "••••"; }
}

// ───────── Foutmeldingen ─────────

export function friendlyError(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; code?: string; responseText?: string; message?: string; serverResponseCode?: string };
  const text = `${err?.responseText ?? ""} ${err?.message ?? ""} ${err?.serverResponseCode ?? ""}`;
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|LOGIN failed/i.test(text))
    return "Gmail accepteert dit app-wachtwoord niet. Maak een nieuw app-wachtwoord aan op myaccount.google.com/apppasswords en vul het hier in (spaties mogen).";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(err?.code ?? ""))
    return `Gmail is niet bereikbaar (${err.code}). Controleer de internetverbinding van je server en probeer het later opnieuw.`;
  return (err?.responseText || err?.message || String(e)).slice(0, 300);
}

// ───────── IMAP ─────────

export async function connectGmail(address: string, password: string): Promise<ImapFlow> {
  const t = imapTarget();
  const client = new ImapFlow({
    host: t.host, port: t.port, secure: t.secure, doSTARTTLS: t.secure ? undefined : false,
    auth: { user: address, pass: cleanPassword(password) },
    logger: false, disableAutoIdle: true, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 120_000,
    clientInfo: { name: "Eigen Cloud" },
  } as ConstructorParameters<typeof ImapFlow>[0]);
  client.on("error", () => { /* wordt via de lopende opdracht gemeld */ });
  await client.connect();
  return client;
}

async function findAllMail(client: ImapFlow) {
  const boxes = await client.list();
  const all = boxes.find((b) => b.specialUse === "\\All");
  return { boxes, all };
}

const NO_ALL_MAIL = "De map 'Alle e-mail' is niet zichtbaar via IMAP. Zet in Gmail bij Instellingen → Labels 'Alle e-mail' op 'Weergeven in IMAP'.";

/** Verbindingstest voor de knop "Verbinding testen". */
export async function testConnection(address: string, password: string) {
  const client = await connectGmail(address, password);
  try {
    const { boxes, all } = await findAllMail(client);
    if (!all) throw new Error(NO_ALL_MAIL);
    const st = await client.status(all.path, { messages: true });
    return { ok: true as const, mailboxes: boxes.length, allMail: all.path, total: st ? st.messages ?? 0 : 0 };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const bracket = (id: string | undefined | null) => (id ? (id.startsWith("<") ? id : `<${id}>`) : null);

interface ImapState { uidValidity: string; lastUid: number; modseq?: string }

/** Haalt nieuwe berichten uit 'Alle e-mail' op (in porties), en neemt gelezen/ster-wijzigingen over. */
async function pullMail(client: ImapFlow, status: GmailStatus, deadline: number) {
  const { all } = await findAllMail(client);
  if (!all) throw new Error(NO_ALL_MAIL);
  const lock = await client.getMailboxLock(all.path, { readOnly: true });
  try {
    const box = client.mailbox;
    if (!box) throw new Error("Kon 'Alle e-mail' niet openen");
    const uidValidity = String(box.uidValidity);
    let state = json<ImapState | null>("gmail_imap_state", null);
    if (!state || state.uidValidity !== uidValidity) {
      // Nieuw of door Gmail opnieuw genummerd: vanaf het begin (dubbele berichten worden overgeslagen).
      state = { uidValidity, lastUid: 0 };
      setSetting("gmail_imap_state", JSON.stringify(state));
    }
    const prevModseq = state.modseq;

    // Gelezen/ster-wijzigingen sinds de vorige ronde (alleen als de server CONDSTORE heeft).
    if (prevModseq && box.highestModseq && String(box.highestModseq) !== prevModseq && state.lastUid > 0) {
      // Alleen de mailbox van de eigenaar: de Gmail-koppeling is van hem.
      const upd = db.prepare("UPDATE messages SET is_read = ?, is_starred = ? WHERE message_id = ? AND user_id = 1 AND (is_read != ? OR is_starred != ?)");
      for await (const m of client.fetch(`1:${state.lastUid}`, { uid: true, flags: true, envelope: true }, { uid: true, changedSince: BigInt(prevModseq) })) {
        const id = bracket(m.envelope?.messageId);
        if (!id || !m.flags) continue;
        const read = m.flags.has("\\Seen") ? 1 : 0;
        const star = m.flags.has("\\Flagged") ? 1 : 0;
        upd.run(read, star, id, read, star);
      }
    }
    const nowModseq = box.highestModseq ? String(box.highestModseq) : undefined;

    for (;;) {
      const found = (await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || [];
      const pending = found.filter((u) => u > state!.lastUid).sort((a, b) => a - b);
      const total = box.exists ?? 0;
      status.initialSync = { done: Math.max(0, total - pending.length), total };
      if (!pending.length) break;
      const batch = pending.slice(0, BATCH);
      const msgs: FetchMessageObject[] = [];
      for await (const m of client.fetch(batch.join(","), { uid: true, source: true, flags: true, labels: true }, { uid: true })) msgs.push(m);
      msgs.sort((a, b) => a.uid - b.uid);
      try {
        for (const m of msgs) {
          if (m.source) {
            const opts = gmailLabelListToOptions([...(m.labels ?? [])]);
            opts.isRead = !!m.flags?.has("\\Seen");
            opts.isStarred = !!m.flags?.has("\\Flagged") || [...(m.labels ?? [])].includes("\\Starred");
            try {
              if (await storeRawMessage(m.source, opts)) status.counts.imported++;
            } catch (e) {
              if (isNotLeader(e)) throw e;
              console.error(`gmail: bericht uid ${m.uid} overgeslagen:`, (e as Error).message);
            }
          }
          state.lastUid = m.uid;
        }
        // Ontbrekende UIDs in deze portie (bijv. net verwijderd) niet opnieuw proberen.
        state.lastUid = Math.max(state.lastUid, batch[batch.length - 1]);
      } finally {
        setSetting("gmail_imap_state", JSON.stringify(state));
      }
      status.initialSync = { done: Math.max(0, total - pending.length + batch.length), total };
      if (Date.now() > deadline) break;
    }
    if (nowModseq) {
      state.modseq = nowModseq;
      setSetting("gmail_imap_state", JSON.stringify(state));
    }
  } finally {
    lock.release();
  }
}

// ───────── Vangnet: kopie naar Gmail ─────────

async function hasMessageId(client: ImapFlow, mailbox: string, msgid: string): Promise<boolean> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    const query = client.capabilities.has("X-GM-EXT-1") ? { gmraw: `rfc822msgid:${msgid.replace(/^<|>$/g, "")}` } : { header: { "message-id": msgid } };
    const r = await client.search(query, { uid: true });
    return !!r && r.length > 0;
  } finally {
    lock.release();
  }
}

async function pushMail(client: ImapFlow, cfg: ReturnType<typeof gmailConfig>, status: GmailStatus, deadline: number) {
  const start = Number(getSetting("gmail_vangnet_start") ?? 0);
  let last = Math.max(start, Number(getSetting("gmail_vangnet_last") ?? 0));
  const { boxes, all } = await findAllMail(client);
  let target = "INBOX";
  if (!cfg.copyToInbox) {
    const label = boxes.find((b) => b.path === LABEL);
    if (!label) await client.mailboxCreate(LABEL).catch((e) => { if (!/ALREADYEXISTS|exists/i.test(String((e as { responseText?: string }).responseText ?? e))) throw e; });
    target = LABEL;
  }
  // Ontvangen mail (ook als je hem al gearchiveerd hebt), en desgewenst je verzonden mail.
  const folders = cfg.copySent ? ["inbox", "archive", "sent"] : ["inbox", "archive"];
  const q = db.prepare(`SELECT id, message_id, raw_path, date, is_read, is_starred FROM messages WHERE id > ? AND user_id = 1 AND folder IN (${folders.map(() => "?").join(",")}) ORDER BY id LIMIT 25`);
  for (;;) {
    const rows = q.all(last, ...folders) as { id: number; message_id: string | null; raw_path: string | null; date: number; is_read: number; is_starred: number }[];
    if (!rows.length) break;
    for (const r of rows) {
      // Al in Gmail (bijv. na een leiderwissel of een eerdere poging)? Dan niet nog eens.
      const exists = r.message_id && ((all && (await hasMessageId(client, all.path, r.message_id))) || (await hasMessageId(client, target, r.message_id)));
      if (!exists) {
        const file = r.raw_path ? await ensureLocal(r.raw_path) : null;
        if (!file) throw new Error(`Origineel van bericht ${r.id} is (nog) niet beschikbaar`);
        const flags = [...(r.is_read ? ["\\Seen"] : []), ...(r.is_starred ? ["\\Flagged"] : [])];
        const res = await client.append(target, fs.readFileSync(file), flags, new Date(r.date));
        if (target === "INBOX" && res && res.uid && client.capabilities.has("X-GM-EXT-1")) {
          const lock = await client.getMailboxLock("INBOX");
          try { await client.messageFlagsAdd(String(res.uid), [LABEL], { uid: true, useLabels: true }); } catch { /* label is bijzaak */ } finally { lock.release(); }
        }
        status.counts.copied++;
      }
      last = r.id;
      setSetting("gmail_vangnet_last", String(last));
    }
    if (Date.now() > deadline) break;
  }
}

// ───────── Google Agenda volgen ─────────

function calendarIds(): Record<string, number> { return json<Record<string, number>>("gmail_cal_ids", {}); }

function deleteCalendar(id: number) {
  db.transaction(() => {
    db.prepare("DELETE FROM events WHERE calendar_id = ?").run(id);
    db.prepare("DELETE FROM calendars WHERE id = ?").run(id);
  })();
}

/** Agenda's die niet meer gevolgd worden, opruimen (alleen de door deze koppeling gemaakte). */
export function pruneCalendars(followed: FollowedCalendar[]) {
  const ids = calendarIds();
  const keep = new Set(followed.map((c) => c.name));
  let changed = false;
  for (const [name, id] of Object.entries(ids)) {
    if (keep.has(name)) continue;
    deleteCalendar(id);
    delete ids[name];
    changed = true;
  }
  if (changed) setSetting("gmail_cal_ids", JSON.stringify(ids));
}

async function syncCalendars(cfg: ReturnType<typeof gmailConfig>, status: GmailStatus) {
  pruneCalendars(cfg.calendars);
  const ids = calendarIds();
  status.calendarErrors = [];
  let events = 0;
  let ok = 0;
  for (const c of cfg.calendars) {
    try {
      if (!validCalendarUrl(c.url)) throw new Error("ongeldig adres");
      const res = await fetch(c.url, { signal: AbortSignal.timeout(30_000), redirect: "follow", headers: { accept: "text/calendar" } });
      if (!res.ok) throw new Error(res.status === 404 ? "Google kent dit adres niet (meer). Is het geheime adres opnieuw ingesteld?" : `Google antwoordde ${res.status}`);
      const text = await res.text();
      if (!text.includes("BEGIN:VCALENDAR")) throw new Error("dit is geen agenda (iCal)");
      let id = ids[c.name];
      if (!id || !db.prepare("SELECT 1 FROM calendars WHERE id = ? AND user_id = 1").get(id)) {
        id = Number(db.prepare("INSERT INTO calendars (name, color) VALUES (?, ?)").run(CAL_PREFIX + c.name, "#2f6f8f").lastInsertRowid);
        ids[c.name] = id;
        setSetting("gmail_cal_ids", JSON.stringify(ids));
      }
      const t0 = Date.now() - 1;
      importIcs(text, id);
      // Alles wat niet (meer) in de feed stond, is in Google verwijderd.
      db.prepare("DELETE FROM events WHERE calendar_id = ? AND updated < ?").run(id, t0);
      events += (db.prepare("SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?").get(id) as { n: number }).n;
      ok++;
    } catch (e) {
      if (isNotLeader(e)) throw e;
      status.calendarErrors.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  status.counts.calendars = ok;
  status.counts.events = events;
}

// ───────── Eén ronde ─────────

/** Het cluster haakt hierop in (bijv. DNS bijwerken als de stand verandert). */
export const gmailHooks: { changed?: () => void } = {};

let running: Promise<void> | null = null;
let again = false;

export const isRunning = () => !!running;

/**
 * Eén synchronisatieronde. Idempotent en gooit nooit: fouten komen in gmail_status.
 * Schrijft alleen op de leider; verliest deze node het leiderschap, dan stopt de ronde stil.
 */
export async function gmailRound(): Promise<void> {
  const cfg = gmailConfig();
  if (cfg.mode === "uit") return;
  if (runtime.enabled && !runtime.isLeader()) return;
  const status = readStatus();
  const started = Date.now();
  const deadline = started + ROUND_BUDGET_MS;
  const errors: string[] = [];
  try {
    if (!cfg.address || !cfg.password) {
      errors.push("Vul je Gmail-adres en een app-wachtwoord in.");
    } else {
      let client: ImapFlow | null = null;
      try {
        client = await connectGmail(cfg.address, cfg.password);
        if (cfg.mode === "naast") await pullMail(client, status, deadline);
        else await pushMail(client, cfg, status, deadline);
      } catch (e) {
        if (isNotLeader(e)) throw e;
        errors.push(friendlyError(e));
      } finally {
        if (client) await client.logout().catch(() => client!.close());
      }
    }
    if (cfg.mode === "naast" && cfg.calendars.length) await syncCalendars(cfg, status);
    else if (cfg.mode === "naast") { pruneCalendars([]); status.counts.calendars = 0; status.counts.events = 0; status.calendarErrors = []; }
    if (status.calendarErrors.length) errors.push(`Agenda: ${status.calendarErrors.join("; ")}`);
    status.lastRun = started;
    status.error = errors.length ? errors.join(" · ") : null;
    if (!errors.length) status.lastOk = Date.now();
    writeStatus(status);
  } catch (e) {
    if (isNotLeader(e)) return; // een andere node neemt het over
    console.error("gmail:", e);
    try { writeStatus({ ...status, lastRun: started, error: friendlyError(e) }); } catch { /* geen leider meer */ }
  }
}

/** Start een ronde zonder te wachten; loopt er al een, dan volgt er direct nog één. */
export function kickGmail(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await gmailRound(); } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}
