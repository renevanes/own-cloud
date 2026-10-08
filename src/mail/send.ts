import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { storeRawMessage } from "./store.js";

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

function dkimOptions() {
  if (!config.dkimKeyFile || !fs.existsSync(config.dkimKeyFile)) return undefined;
  return {
    domainName: config.mailFrom.split("@")[1],
    keySelector: config.dkimSelector,
    privateKey: fs.readFileSync(config.dkimKeyFile, "utf8"),
  };
}

/** Stelt het bericht samen (met DKIM-handtekening als er een sleutel is). */
async function compose(mail: OutgoingMail): Promise<Buffer> {
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await builder.sendMail({
    from: config.mailFrom,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    attachments: mail.attachments,
    messageId: `<${crypto.randomUUID()}@${config.hostname}>`,
    dkim: dkimOptions(),
  });
  return info.message as Buffer;
}

/** Aflevering rechtstreeks bij de MX-server van elk ontvangend domein. */
async function deliverDirect(raw: Buffer, recipients: string[]) {
  const byDomain = new Map<string, string[]>();
  for (const r of recipients) {
    const d = r.split("@")[1].toLowerCase();
    byDomain.set(d, [...(byDomain.get(d) ?? []), r]);
  }
  const errors: string[] = [];
  for (const [domain, rcpts] of byDomain) {
    let mxs = (await dns.resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
    if (!mxs.length) mxs = [domain];
    let ok = false;
    for (const host of mxs) {
      try {
        const t = nodemailer.createTransport({ host, port: 25, name: config.hostname, secure: false, tls: { rejectUnauthorized: false }, connectionTimeout: 20000 });
        await t.sendMail({ envelope: { from: config.mailFrom, to: rcpts }, raw });
        ok = true;
        break;
      } catch (e) {
        errors.push(`${host}: ${(e as Error).message}`);
      }
    }
    if (!ok) throw new Error(`Aflevering aan ${domain} mislukt — ${errors.join("; ")}`);
  }
}

export async function sendMail(mail: OutgoingMail): Promise<number | null> {
  const raw = await compose(mail);
  const recipients = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])];
  if (!recipients.length) throw new Error("Geen ontvangers");

  if (config.smtpRelay) {
    const relay = nodemailer.createTransport(config.smtpRelay);
    await relay.sendMail({ envelope: { from: config.mailFrom, to: recipients }, raw });
  } else {
    await deliverDirect(raw, recipients);
  }
  return storeRawMessage(raw, { folder: "sent", isRead: true });
}
