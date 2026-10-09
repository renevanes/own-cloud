/**
 * Lokale SMTP-servers voor de Java-tests van de Android-kern (SmtpTest).
 * Gebruik: npx tsx scripts/android-smtp-server.ts <info.json>
 * Schrijft {plain, loginOnly, starttls, messages} naar info.json zodra alles luistert; ontvangen berichten
 * komen als JSON-regels in het bestand `messages`. Stopt bij SIGTERM/SIGINT.
 */
import fs from "node:fs";
import path from "node:path";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";

const info = path.resolve(process.argv[2] ?? "smtp-info.json");
const messages = info.replace(/\.json$/, "") + "-messages.jsonl";
fs.writeFileSync(messages, "");

function start(opts: Partial<SMTPServerOptions>): Promise<{ server: SMTPServer; port: number }> {
  const server = new SMTPServer({
    logger: false,
    allowInsecureAuth: true,
    authMethods: ["PLAIN", "LOGIN"],
    onAuth(auth, _s, cb) {
      if (auth.username === "rene@vanes.nl" && auth.password === "geheim wachtwoord/é") cb(null, { user: auth.username });
      else cb(new Error("Invalid username or password"));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        fs.appendFileSync(messages, JSON.stringify({ user: session.user, from: session.envelope.mailFrom && session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString("utf8") }) + "\n");
        cb();
      });
    },
    ...opts,
  });
  return new Promise((res, rej) => {
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => res({ server, port: (server.server.address() as { port: number }).port }));
  });
}

const plain = await start({ disabledCommands: ["STARTTLS"] });
const loginOnly = await start({ disabledCommands: ["STARTTLS"], authMethods: ["LOGIN"] });
const starttls = await start({}); // zelfondertekend certificaat van smtp-server: Java moet dat weigeren
fs.writeFileSync(info, JSON.stringify({ plain: plain.port, loginOnly: loginOnly.port, starttls: starttls.port, messages }));

const stop = () => { for (const s of [plain, loginOnly, starttls]) s.server.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
