import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SMTPServer } from "smtp-server";
import { config } from "../config.js";
import { deliverInbound, withEnvelope } from "./inbound.js";
import { recipientUser } from "../users.js";
import { runtime } from "../cluster/runtime.js";
import { isNotLeader } from "../cluster/fence.js";
import { reserveSpace } from "../work.js";

/**
 * Ontvangt inkomende mail (MX) voor de geconfigureerde domeinen.
 * Accepteert alleen ontvangers op eigen domeinen → geen open relay.
 */
export function startSmtpServer() {
  let receiving = 0;
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
    maxClients: 100,
    socketTimeout: 120_000,

    onRcptTo(address, _session, cb) {
      if (runtime.sleeping()) {
        const err = new Error("Tijdelijk niet beschikbaar, probeer later opnieuw") as Error & { responseCode: number };
        err.responseCode = 451;
        return cb(err);
      }
      const domain = address.address.split("@")[1]?.toLowerCase();
      if (!domain || !config.mailDomains.includes(domain)) {
        const err = new Error("Relay niet toegestaan") as Error & { responseCode: number };
        err.responseCode = 550;
        return cb(err);
      }
      if (recipientUser(address.address) === null) {
        const err = new Error("Dit adres is niet actief") as Error & { responseCode: number };
        err.responseCode = 550;
        return cb(err);
      }
      cb();
    },

    onData(stream, session, cb) {
      if (receiving >= 2) { stream.resume(); return cb(Object.assign(new Error("Tijdelijk druk, probeer later"), { responseCode: 451 })); }
      receiving++;
      void (async () => {
        const releases: ReturnType<typeof reserveSpace>[] = [];
        let tmp: string | undefined;
        try {
          const users = new Set(session.envelope.rcptTo.map((r) => recipientUser(r.address) ?? 1));
          for (const id of users) releases.push(reserveSpace(id, 0));
          tmp = fs.mkdtempSync(path.join(config.dataDir, ".smtp-"));
          const file = path.join(tmp, "incoming.eml");
          let bytes = 0, reserved = 0;
          const budget = new Transform({ transform(chunk, _encoding, callback) {
            try {
              bytes += chunk.length;
              if (bytes > config.maxMessageBytes) throw Object.assign(new Error("Bericht te groot"), { responseCode: 552 });
              if (bytes > reserved) { reserved = Math.min(config.maxMessageBytes, bytes + 1024 ** 2); for (const release of releases) release.resize(reserved); }
              callback(null, chunk);
            } catch (e) { callback(e as Error); }
          } });
          await pipeline(stream, budget, fs.createWriteStream(file, { mode: 0o600 }));
          if (stream.sizeExceeded) throw Object.assign(new Error("Bericht te groot"), { responseCode: 552 });
          const clean = (s: string) => String(s ?? "").replace(/[\r\n]/g, "");
          const header = `Received: from ${clean(session.clientHostname)} ([${clean(session.remoteAddress)}]) by ${config.hostname}; ${new Date().toUTCString()}\r\n`;
          // De ontvangers (envelop) gaan mee, zodat elke gebruiker zijn eigen kopie krijgt; ook via de secundaire MX.
          const raw = withEnvelope(Buffer.concat([Buffer.from(header), fs.readFileSync(file)]), session.envelope.rcptTo.map((r) => r.address));
          if (runtime.enabled && !runtime.isLeader()) {
            // Secundaire MX: veilig op schijf, wordt doorgegeven aan de leider.
            if (!(await runtime.spool(raw))) throw new Error("Wachten op de primaire MX");
            return cb();
          }
          try {
            await deliverInbound(raw, { ip: session.remoteAddress, helo: session.clientHostname, sender: session.envelope.mailFrom && session.envelope.mailFrom.address || "", recipients: session.envelope.rcptTo.map((r) => r.address) });
            if (runtime.enabled && !(await runtime.waitDurable())) throw new Error("Bericht nog niet duurzaam bevestigd");
          } catch (e) {
            if (!runtime.enabled || !isNotLeader(e)) throw e;
            if (!(await runtime.spool(raw))) throw new Error("Wachten op de primaire MX");
          }
          cb();
        } catch (e) {
          console.error("Opslaan inkomende mail mislukt:", e);
          const err = new Error("Tijdelijke fout, probeer later") as Error & { responseCode: number };
          err.responseCode = (e as { responseCode?: number }).responseCode === 552 ? 552 : 451;
          if (err.responseCode === 552) err.message = "Bericht te groot";
          stream.resume();
          cb(err);
        } finally {
          for (const release of releases) release();
          if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
          receiving--;
        }
      })();
    },
  });

  server.on("error", (e) => console.error("SMTP-fout:", e.message));
  server.listen(config.smtpPort, () => console.log(`📨 SMTP luistert op poort ${config.smtpPort} voor ${config.mailDomains.join(", ")}`));
  return server;
}
