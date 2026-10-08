import fs from "node:fs";
import { SMTPServer } from "smtp-server";
import { config } from "../config.js";
import { storeRawMessage } from "./store.js";

/**
 * Ontvangt inkomende mail (MX) voor de geconfigureerde domeinen.
 * Accepteert alleen ontvangers op eigen domeinen → geen open relay.
 */
export function startSmtpServer() {
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  const tls = certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)
    ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
    : null;

  const server = new SMTPServer({
    name: config.hostname,
    banner: "eigen-cloud ESMTP",
    authOptional: true,
    disabledCommands: tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
    ...(tls ?? {}),
    size: config.maxMessageBytes,
    logger: false,

    onRcptTo(address, _session, cb) {
      const domain = address.address.split("@")[1]?.toLowerCase();
      if (!domain || !config.mailDomains.includes(domain)) {
        const err = new Error("Relay niet toegestaan") as Error & { responseCode: number };
        err.responseCode = 550;
        return cb(err);
      }
      cb();
    },

    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", async () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          const err = new Error("Bericht te groot") as Error & { responseCode: number };
          err.responseCode = 552;
          return cb(err);
        }
        try {
          const header = `Received: from ${session.clientHostname} ([${session.remoteAddress}]) by ${config.hostname}; ${new Date().toUTCString()}\r\n`;
          await storeRawMessage(Buffer.concat([Buffer.from(header), ...chunks]), { folder: "inbox" });
          cb();
        } catch (e) {
          console.error("Opslaan inkomende mail mislukt:", e);
          const err = new Error("Tijdelijke fout, probeer later") as Error & { responseCode: number };
          err.responseCode = 451;
          cb(err);
        }
      });
    },
  });

  server.on("error", (e) => console.error("SMTP-fout:", e.message));
  server.listen(config.smtpPort, () => console.log(`📨 SMTP luistert op poort ${config.smtpPort} voor ${config.mailDomains.join(", ")}`));
  return server;
}
