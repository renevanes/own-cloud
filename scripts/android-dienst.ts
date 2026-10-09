/**
 * Hulpdienst voor android/core/test.sh: de Eigen Cloud Dienst (src/broker) met nep-Mollie, -Openprovider,
 * -deSEC en -Scaleway en een nep-mailserver, zodat de Java-console de hele dienst-route kan doorlopen.
 * Schrijft {url, control} naar het opgegeven bestand. Bedieningsadres:
 *   GET  <control>/mails          → ontvangen mails
 *   POST <control>/pay?order=<id> → betaling op "betaald" zetten en de webhook sturen
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { smtpSink, fakeUpstream } from "../test/helpers/broker-fakes.js";
import { freePort } from "../test/helpers/cluster.js";

const out = process.argv[2];
const smtp = await smtpSink();
const up = fakeUpstream();
const U = `http://127.0.0.1:${await up.listening}`;
const port = await freePort();
const PUBLIC = `http://127.0.0.1:${port}`;
const broker = await createBroker(loadConfig({
  BROKER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dienst-java-")), BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC,
  MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
  OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
  DESEC_TOKEN: "desec-dienst", DESEC_URL: `${U}/desec`,
  SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
  BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: "Eigen Cloud Dienst <dienst@dienst.test>",
  BROKER_ADMIN_EMAIL: "beheer@dienst.test", BROKER_LOOP_MS: "20",
}));
await broker.app.listen({ port, host: "127.0.0.1" });

const control = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/mails") return res.end(JSON.stringify(smtp.mails));
  if (u.pathname === "/pay") {
    const pay = [...up.st.mollie.payments.values()].find((p) => p.metadata?.orderId === u.searchParams.get("order"));
    if (!pay) { res.statusCode = 404; return res.end("{}"); }
    pay.status = "paid";
    await fetch(`${PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${pay.id}` });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.statusCode = 404;
  res.end("{}");
});
const cport = await freePort();
control.listen(cport, "127.0.0.1");
fs.writeFileSync(out, JSON.stringify({ url: PUBLIC, control: `http://127.0.0.1:${cport}`, pid: process.pid }));
const stop = async () => { control.close(); await broker.close(); await up.close(); await smtp.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
