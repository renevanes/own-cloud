import path from "node:path";
import fs from "node:fs";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Ontbrekende omgevingsvariabele: ${name}`);
  return v;
}

export function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret.trim().length < 32 || /^verander-mij|^change-?me|^dev$/i.test(secret.trim()))) {
    throw new Error("Stel SESSION_SECRET in op een willekeurig geheim van minimaal 32 tekens voordat je de server start.");
  }
  return secret || "verander-mij-dev";
}

export const config = {
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  httpPort: Number(env("HTTP_PORT", "3000")),
  /** Poort waarop inkomende mail binnenkomt (25 in productie). */
  smtpPort: Number(env("SMTP_PORT", "2525")),
  /** Domein(en) waarvoor deze server mail accepteert, kommagescheiden. */
  mailDomains: env("MAIL_DOMAINS", "example.nl").split(",").map((d) => d.trim().toLowerCase()),
  /** Afzenderadres voor uitgaande mail. */
  mailFrom: env("MAIL_FROM", "rene@example.nl"),
  /** Hostnaam van deze server (voor HELO/EHLO en Message-ID). */
  hostname: env("HOSTNAME_FQDN", "mail.example.nl"),
  /**
   * Uitgaande mail. Leeg = direct afleveren via MX (vereist open poort 25 bij Hetzner).
   * Anders een relay-URL, bijv. smtps://USER:PASS@email-smtp.eu-west-1.amazonaws.com:465
   */
  smtpRelay: process.env.SMTP_RELAY || "",
  dkimSelector: process.env.DKIM_SELECTOR || "eigen",
  dkimKeyFile: process.env.DKIM_KEY_FILE || "",
  /** Geheim voor sessiecookies. */
  sessionSecret: sessionSecret(),
  /** Token voor de privé iCal-feed (abonneren vanaf telefoon). */
  icalToken: process.env.ICAL_TOKEN || "",
  maxMessageBytes: 50 * 1024 * 1024,
};

export const paths = {
  db: path.join(config.dataDir, "eigen-cloud.sqlite"),
  mailRaw: path.join(config.dataDir, "mail", "raw"),
  mailAttachments: path.join(config.dataDir, "mail", "attachments"),
  photoOriginals: path.join(config.dataDir, "photos", "originals"),
  photoThumbs: path.join(config.dataDir, "photos", "thumbs"),
};

for (const p of Object.values(paths).slice(1)) fs.mkdirSync(p, { recursive: true });
