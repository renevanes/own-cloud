import nodemailer, { type Transporter } from "nodemailer";
import type { BrokerConfig } from "./config.js";

export interface Mailer { send(to: string, subject: string, text: string): Promise<void> }

export function makeMailer(c: BrokerConfig): Mailer {
  let t: Transporter | null = null;
  return {
    async send(to, subject, text) {
      if (!c.smtpUrl) {
        // Zonder SMTP (alleen bij ontwikkelen) komt de mail in het logboek.
        console.log(`[dienst] (geen BROKER_SMTP_URL) mail aan ${to}: ${subject}\n${text}`);
        return;
      }
      t ??= nodemailer.createTransport(c.smtpUrl);
      await t.sendMail({ from: c.mailFrom, to, subject, text });
    },
  };
}

/** Mail versturen zonder dat een mislukte mail de rest stopt. */
export async function trySend(m: Mailer, to: string | null | undefined, subject: string, text: string) {
  if (!to) return;
  try { await m.send(to, subject, text); } catch (e) { console.error(`[dienst] mail aan ${to} mislukt: ${(e as Error).message}`); }
}
