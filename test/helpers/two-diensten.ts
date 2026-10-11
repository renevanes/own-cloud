/**
 * Twee aanbieders (Dienst A en B) met de centrale adressendienst, tegen één nep-upstream (Mollie, Openprovider,
 * deSEC, Scaleway): voor de tests van overstappen. A gebruikt deSEC-account "dienst", B account "b".
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/broker/config.js";
import { createBroker, type Broker } from "../../src/broker/app.js";
import { loadAdresConfig } from "../../src/adressen/config.js";
import { createAdressen } from "../../src/adressen/app.js";
import { freePort } from "./cluster.js";
import { smtpSink, fakeUpstream, fakeMandate } from "./broker-fakes.js";

export const ZONE = "eigencloud.test";

export async function twoDiensten() {
  const up = fakeUpstream();
  const U = `http://127.0.0.1:${await up.listening}`;
  up.desecAccount("desec-centraal", "centraal");
  up.desecAccount("desec-b", "b");
  up.st.desec.zones.set(ZONE, { name: ZONE, account: "centraal", keys: [], rrsets: new Map() });
  const cleanup: (() => Promise<unknown> | void)[] = [];
  const adresDir = fs.mkdtempSync(path.join(os.tmpdir(), "adressen-"));
  const adresPort = await freePort();
  const ADRES = `http://127.0.0.1:${adresPort}`;
  const list = path.join(adresDir, "aanbieders.json");

  const dienst = async (naam: string, desecToken: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dienst-${naam}-`));
    const smtp = await smtpSink();
    const port = await freePort();
    const PUBLIC = `http://127.0.0.1:${port}`;
    const cfg = loadConfig({
      BROKER_DATA_DIR: dir, BROKER_PORT: String(port), BROKER_PUBLIC_URL: PUBLIC, BROKER_ADRES_URL: `${ADRES}/`,
      MOLLIE_API_KEY: "test_mollie", MOLLIE_API_URL: `${U}/mollie`,
      OPENPROVIDER_USERNAME: "rene", OPENPROVIDER_PASSWORD: "op-geheim", OPENPROVIDER_URL: `${U}/op`,
      DESEC_TOKEN: desecToken, DESEC_URL: `${U}/desec`,
      SCW_SECRET_KEY: "scw-org-geheim", SCW_ORGANIZATION_ID: "org-1", SCW_API_URL: `${U}/scw`,
      BROKER_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, BROKER_MAIL_FROM: `Dienst ${naam} <dienst@${naam}.test>`, BROKER_LOOP_MS: "20",
      BROKER_BRAND_NAME: `Aanbieder ${naam.toUpperCase()}`,
    });
    cleanup.push(() => smtp.close(), () => fs.rmSync(dir, { recursive: true, force: true }));
    return { naam, cfg, PUBLIC, smtp, broker: null as unknown as Broker };
  };
  const A = await dienst("a", "desec-dienst");
  const B = await dienst("b", "desec-b");
  fs.writeFileSync(list, JSON.stringify([
    { naam: "Aanbieder A", url: A.PUBLIC, sleutel: A.cfg.providerPublicKey },
    { naam: "Aanbieder B", url: B.PUBLIC, sleutel: B.cfg.providerPublicKey },
  ]));
  const svc = await createAdressen(loadAdresConfig({
    ADRES_ZONE: ZONE, ADRES_DESEC_TOKEN: "desec-centraal", ADRES_DESEC_URL: `${U}/desec`,
    ADRES_PORT: String(adresPort), ADRES_DATA_DIR: adresDir, ADRES_LIST_URL: list,
  }));
  await svc.app.listen({ port: adresPort, host: "127.0.0.1" });
  cleanup.push(() => fs.rmSync(adresDir, { recursive: true, force: true }), () => svc.close());
  for (const d of [A, B]) {
    d.broker = await createBroker(d.cfg);
    await d.broker.app.listen({ port: d.cfg.port, host: "127.0.0.1" });
    d.broker.startLoops();
    cleanup.push(() => d.broker.close());
  }
  type D = typeof A;
  const api = async (d: D | string, method: string, p: string, body?: unknown, token?: string) => {
    const base = typeof d === "string" ? d : d.PUBLIC;
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  /** De nieuwste inlogcode die naar dit adres is gestuurd (en weghalen). */
  const code = async (d: D, email: string) => {
    let m; for (let i = 0; i < 200 && !m; i++) { m = d.smtp.mails.find((x) => x.to.includes(email) && /inlogcode: \d{6}/.test(x.data)); if (!m) await new Promise((res) => setTimeout(res, 25)); }
    assert.ok(m, `inlogcode voor ${email}`);
    d.smtp.mails.splice(d.smtp.mails.indexOf(m!), 1);
    return /inlogcode: (\d{6})/.exec(m!.data)![1];
  };
  const login = async (d: D, email: string) => {
    assert.equal((await api(d, "POST", "/v1/auth/start", { email })).status, 202);
    return (await api(d, "POST", "/v1/auth/verify", { email, code: await code(d, email) })).json.token as string;
  };
  /** Betaling op "betaald" zetten en de webhook sturen. */
  const pay = async (d: D, orderId: string) => {
    const p = [...up.st.mollie.payments.values()].find((x) => x.metadata.orderId === orderId)!;
    const mdt = `mdt_${orderId}`;
    Object.assign(p, { status: "paid", mandateId: mdt, method: "ideal", paidAt: new Date().toISOString() });
    up.st.mollie.mandates.push(fakeMandate(mdt, p.customerId, "directdebit"));
    await fetch(`${d.PUBLIC}/v1/mollie/webhook`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${p.id}` });
  };
  const order = async (d: D, id: string, token: string) => (await api(d, "GET", `/v1/orders/${id}`, undefined, token)).json;
  const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error(`Timeout: ${what}`); await new Promise((r) => setTimeout(r, 40)); }
  };
  const close = async () => { for (const f of cleanup.reverse()) await f(); await up.close(); };
  return { up, U, A, B, svc, api, code, login, pay, order, until, close };
}

export const REGISTRANT = { firstName: "Rene", lastName: "van Es", street: "Coolsingel", number: "40", zipcode: "3011 AD", city: "Rotterdam", country: "NL", phone: "+31 6 12345678", email: "rene@elders.test" };
