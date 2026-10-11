/**
 * Hulpdienst voor android/core/test.sh: de Eigen Cloud Dienst (src/broker) met nep-Mollie, -Openprovider,
 * -deSEC en -Scaleway en een nep-mailserver, zodat de Java-console de hele dienst-route kan doorlopen.
 * Schrijft {url, control} naar het opgegeven bestand. Bedieningsadres:
 *   GET  <control>/mails          → ontvangen mails
 *   POST <control>/pay?order=<id> → betaling op "betaald" zetten en de webhook sturen
 *   GET  <control>/aanbieders.json → openbare lijst van aanbieders (met deze dienst, een ongeldige en een andere)
 *   POST <control>/brand           → huisstijl wijzigen ({name, accentColor, contact, …}; logoPng = base64 van een PNG)
 *   POST <control>/invite          → uitnodigingscode maken (door de eigenaar) → {code}
 *   POST <control>/announcement    → bericht van de aanbieder ({title, body, severity})
 *   POST <control>/staff-reply     → antwoord van de aanbieder op een hulpvraag ({ticket, message})
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/broker/config.js";
import { createBroker } from "../src/broker/app.js";
import { smtpSink, fakeUpstream } from "../test/helpers/broker-fakes.js";
import { freePort } from "../test/helpers/cluster.js";
import { updateBrand, saveLogo } from "../src/broker/brand.js";
import { ensureOwner } from "../src/broker/staff.js";
import { createInvite, createAnnouncement, staffReply } from "../src/broker/support.js";

const out = process.argv[2];
const smtp = await smtpSink();
const up = fakeUpstream();
// Gratis adressen onder de zone van de dienst
up.st.desec.zones.set("eigencloud.test", { name: "eigencloud.test", keys: [], rrsets: new Map() });
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
  BROKER_ADMIN_EMAIL: "beheer@dienst.test", BROKER_LOOP_MS: "20", BROKER_FREE_ZONE: "eigencloud.test", BROKER_OWNER_EMAIL: "eigenaar@dienst.test",
}));
await broker.app.listen({ port, host: "127.0.0.1" });

const readBody = async (req: http.IncomingMessage): Promise<any> => {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(p as Buffer);
  const t = Buffer.concat(parts).toString("utf8");
  return t ? JSON.parse(t) : {};
};
const owner = () => ensureOwner(broker.ctx, "eigenaar@dienst.test", "test").staff;

const control = http.createServer(async (req, res) => {
  const u = new URL(req.url!, "http://x");
  res.setHeader("content-type", "application/json");
  try {
    if (u.pathname === "/aanbieders.json") return res.end(JSON.stringify([{ naam: "Dienst Test", url: PUBLIC, land: "NL" }, { naam: "Kapot", url: "ftp://nee" }, { naam: "Ander", url: "https://ander.example" }]));
    if (req.method === "POST" && u.pathname === "/brand") {
      const b = await readBody(req);
      if (b.logoPng) saveLogo(broker.ctx.db, "image/png", Buffer.from(b.logoPng, "base64"));
      delete b.logoPng;
      return res.end(JSON.stringify(updateBrand(broker.ctx, b)));
    }
    if (req.method === "POST" && u.pathname === "/invite") {
      const i = createInvite(broker.ctx, owner(), await readBody(req));
      return res.end(JSON.stringify({ code: i.code }));
    }
    if (req.method === "POST" && u.pathname === "/announcement") {
      const a = createAnnouncement(broker.ctx, null, await readBody(req));
      return res.end(JSON.stringify({ id: a.id }));
    }
    if (req.method === "POST" && u.pathname === "/staff-reply") {
      const b = await readBody(req);
      const t = broker.ctx.db.prepare("SELECT * FROM tickets WHERE id = ?").get(String(b.ticket)) as any;
      if (!t) { res.statusCode = 404; return res.end("{}"); }
      await staffReply(broker.ctx, owner(), t, { message: b.message });
      return res.end(JSON.stringify({ ok: true }));
    }
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: (e as Error).message }));
  }
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
