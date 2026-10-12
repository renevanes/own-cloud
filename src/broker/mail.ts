import nodemailer, { type Transporter } from "nodemailer";
import type { BrokerConfig } from "./config.js";

export interface Mailer { send(to: string, subject: string, text: string): Promise<void> }

/**
 * Mail via de HTTPS-koppeling van Scaleway Transactional Email in plaats van SMTP: `scwtem://<project-id>:<sleutel>@<regio>`.
 * Een proefserver (bijv. bij UpCloud) laat alleen de webpoorten 80 en 443 naar buiten toe; SMTP (25, 465, 587, 2587)
 * kan daar niet. API: POST /transactional-email/v1alpha1/regions/{regio}/emails met X-Auth-Token en
 * {from: {email, name}, to: [{email}], subject, text, project_id} (scaleway.com/en/developers/api/transactional-email/,
 * nagekeken 12-10-2026).
 */
export const TEM_SCHEME = "scwtem:";

/** "Naam <adres>" of "adres" → {email, name?}. */
export function parseFrom(from: string) {
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  if (m) return m[1] ? { email: m[2], name: m[1].replace(/^"|"$/g, "") } : { email: m[2] };
  return { email: from.trim() };
}

/** Eén mail via de HTTPS-koppeling van Scaleway TEM. */
export async function temSend(url: string, apiBase: string, from: string, to: string, subject: string, text: string) {
  const u = new URL(url);
  const project = decodeURIComponent(u.username), key = decodeURIComponent(u.password), region = u.hostname || "fr-par";
  const r = await fetch(`${apiBase.replace(/\/+$/, "")}/transactional-email/v1alpha1/regions/${encodeURIComponent(region)}/emails`, {
    method: "POST",
    headers: { "x-auth-token": key, "content-type": "application/json" },
    body: JSON.stringify({ from: parseFrom(from), to: [{ email: to }], subject, text, project_id: project }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`Scaleway Transactional Email antwoordt ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
}

export function makeMailer(c: BrokerConfig): Mailer {
  let t: Transporter | null = null;
  return {
    async send(to, subject, text) {
      if (!c.smtpUrl) {
        // Zonder SMTP (alleen bij ontwikkelen) komt de mail in het logboek.
        console.log(`[dienst] (geen BROKER_SMTP_URL) mail aan ${to}: ${subject}\n${text}`);
        return;
      }
      if (c.smtpUrl.startsWith(`${TEM_SCHEME}//`)) return temSend(c.smtpUrl, c.scaleway.url, c.mailFrom, to, subject, text);
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
