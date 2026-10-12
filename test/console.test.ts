/**
 * De beheerconsole van begin tot eind: assistent → eerste node → cluster vult zichzelf aan → app werkt →
 * slapen → wekken → herstellen op een "nieuwe computer" met alleen de sleutel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "console-"));
process.env.EIGEN_CONSOLE_LOCAL = "1";
process.env.EIGEN_VAULT = path.join(base, "kluis.json");
process.env.CLUSTER_FAST = "1";
process.env.DATA_DIR = path.join(base, "console-data"); // niet gebruikt door de console zelf

const { buildConsole } = await import("../src/console/server.js");

type App = Awaited<ReturnType<typeof buildConsole>>;
function client(app: App) {
  let cookie = "";
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), text: r.body };
  };
}
const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v as T; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error("Timeout: " + what);
};
const killAll = () => {
  const f = path.join(base, "servers", "servers.json");
  if (!fs.existsSync(f)) return;
  for (const s of Object.values(JSON.parse(fs.readFileSync(f, "utf8"))) as { pid: number }[]) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* */ } }
};

test("beheerconsole: van niets naar een draaiende cloud, slapen, wekken en herstellen", { skip: process.env.SKIP_CLUSTER === "1", timeout: 600_000 }, async (t) => {
  t.after(() => { if (!process.env.KEEP) killAll(); });
  const app = await buildConsole();
  const c = client(app);

  await t.test("assistent: kluis, sleutel, opslag, servers, DNS, mail", async () => {
    assert.equal((await c("GET", "/api/state")).json.vault, false);
    let r = await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", appPassword: "kort", passphrase: "x".repeat(12) });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /10 tekens/);
    r = await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@vanes.test", passphrase: "vier losse woorden hier" });
    assert.match(r.json.error, /buiten je eigen domein/);
    r = await c("POST", "/api/setup/create", { domain: "https://Vanes.test/", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" });
    assert.equal(r.status, 200, r.text);
    const kluis = fs.readFileSync(process.env.EIGEN_VAULT!, "utf8");
    assert.ok(!kluis.includes("vanes.test") && !kluis.includes("rene@"), "kluis is versleuteld");

    const key = (await c("GET", "/api/key")).json;
    assert.equal(key.groups.length, 8);
    assert.equal((await c("POST", "/api/key/confirm", { g3: "fout", g7: key.groups[6] })).status, 400);
    assert.equal((await c("POST", "/api/key/confirm", { g3: key.groups[2], g7: key.groups[6] })).status, 200);
    const sheet = await c("GET", "/api/recovery-sheet");
    assert.ok(key.groups.every((g: string) => sheet.text.includes(g)));

    r = await c("POST", "/api/stores", { offer: "localfs", region: "nl", purpose: "replica" });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    r = await c("POST", "/api/stores", { offer: "localfs", region: "nl", purpose: "backup" });
    assert.equal(r.json.ok, true);
    assert.equal((await c("GET", "/api/config")).json.stores.length, 2);

    r = await c("POST", "/api/providers", { id: "local", fields: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.regions.length, 3);
    const { presets } = (await c("GET", "/api/presets")).json;
    assert.deepEqual(presets.map((p: { id: string; placement: unknown[] }) => [p.id, p.placement.length > 0]), [["nl", false], ["buren", true], ["europa", true]]);
    assert.match(presets[0].missing, /Amsterdam/);
    r = await c("POST", "/api/presets/choose", { id: "europa" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.preset.countries.sort(), ["DE", "FI", "NL"]);

    assert.equal((await c("POST", "/api/dns", { mode: "manual" })).status, 200);
    assert.equal((await c("POST", "/api/mail", { relay: null })).status, 200);
    const list = (await c("GET", "/api/checklist")).json;
    assert.ok(list.filter((x: { required: boolean }) => x.required).every((x: { ok: boolean }) => x.ok));
  });

  let appUrl = "";
  await t.test("starten: eerste node, daarna vult het cluster zichzelf aan tot 2 data + witness", async () => {
    const r = await c("POST", "/api/launch");
    assert.equal(r.status, 200, r.text);
    const l = await waitFor("opstarten klaar", async () => { const x = (await c("GET", "/api/launch")).json; return x?.done && x; }, 180_000);
    assert.ok(l.steps.every((s: { state: string }) => s.state === "done"), JSON.stringify(l.steps));
    const st = await waitFor("status wakker", async () => { const s = (await c("GET", "/api/status")).json; return s.state === "awake" && s.live?.nodes?.filter((n: { status: string }) => n.status === "ready").length === 3 && s; });
    assert.deepEqual([...new Set(st.live.nodes.map((n: { country: string }) => n.country))].sort(), ["DE", "FI", "NL"]);
    appUrl = st.appUrl;
    // Inloggen in de cloud met het wachtwoord uit de assistent; begininstellingen zijn overgenomen
    const login = await fetch(`${appUrl}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mijn-cloud-wachtwoord" }) });
    assert.equal(login.status, 200);
    const { token } = (await login.json()) as { token: string };
    const s = await (await fetch(`${appUrl}/api/settings`, { headers: { authorization: `Bearer ${token}` } })).json() as { alertEmail: string; mailFrom: string };
    assert.equal(s.alertEmail, "rene@elders.example");
    assert.equal(s.mailFrom, "rene@vanes.test");
    // Een afspraak maken om straks na het wekken terug te zien
    const ev = await fetch(`${appUrl}/api/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "Gemaakt via console-test", start: Date.UTC(2026, 10, 1, 9), end: Date.UTC(2026, 10, 1, 10) }) });
    assert.equal(ev.status, 200);
  });

  await t.test("instelling na de start wordt naar het cluster gestuurd", async () => {
    const r = await c("POST", "/api/mail", { relay: null, spfExtra: "include:spf.test.example" });
    assert.equal(r.status, 200);
    const login = await fetch(`${appUrl}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mijn-cloud-wachtwoord" }) });
    const { token } = (await login.json()) as { token: string };
    await waitFor("spf_extra in cluster", async () => {
      const s = await (await fetch(`${appUrl}/api/settings`, { headers: { authorization: `Bearer ${token}` } })).json() as { spfExtra: string };
      return s.spfExtra === "include:spf.test.example";
    }, 30_000);
  });

  await t.test("kosten: draaiende servers van de leider, budget gaat mee naar het cluster", async () => {
    const k = (await c("GET", "/api/costs")).json;
    assert.equal(k.sleeping, false);
    const local = k.providers.find((p: { id: string }) => p.id === "local");
    assert.ok(local && local.servers === 0, JSON.stringify(k.providers));
    assert.equal((await c("POST", "/api/costs/budget", { budget: 20 })).status, 200);
  });

  await t.test("back-up testen en laten slapen vanuit de console", async () => {
    assert.equal((await c("POST", "/api/action", { type: "drill" })).status, 200);
    await waitFor("brandoefening klaar", async () => (await c("GET", "/api/status")).json.live?.lastDrill, 60_000);
    assert.equal((await c("POST", "/api/action", { type: "sleep" })).status, 200);
    await waitFor("slaapt", async () => (await c("GET", "/api/status")).json.state === "asleep", 120_000);
    const k = (await c("GET", "/api/costs")).json;
    assert.equal(k.sleeping, true, "slapend: servers kosten niets, opslag telt nog");
    assert.ok(k.providers.every((p: { servers: number | null }) => p.servers === 0), JSON.stringify(k.providers));
    assert.ok(k.providers.some((p: { bytes: number | null }) => (p.bytes ?? 0) > 0), "opslag gemeten");
  });

  await t.test("wakker maken: data terug", async () => {
    assert.equal((await c("POST", "/api/wake")).status, 200);
    const st = await waitFor("weer wakker", async () => { const s = (await c("GET", "/api/status")).json; return s.state === "awake" && s.live?.nodes?.filter((n: { status: string }) => n.status === "ready").length === 3 && s; }, 180_000);
    const url = st.appUrl;
    const login = await waitFor("inloggen na wekken", async () => { const r = await fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "mijn-cloud-wachtwoord" }) }); return r.status === 200 && r; }, 30_000);
    const { token } = (await login.json()) as { token: string };
    const evs = await (await fetch(`${url}/api/events?from=${Date.UTC(2026, 9, 1)}&to=${Date.UTC(2026, 11, 1)}`, { headers: { authorization: `Bearer ${token}` } })).json() as { title: string }[];
    assert.deepEqual(evs.map((e) => e.title), ["Gemaakt via console-test"]);
  });

  await t.test("op slot en ontgrendelen; herstellen op een nieuwe computer met alleen sleutel + opslag", async () => {
    const key = (await c("GET", "/api/key")).json.groups.join(" ");
    const cfg = (await c("GET", "/api/config")).json;
    assert.equal((await c("POST", "/api/lock")).status, 200);
    assert.equal((await c("GET", "/api/config")).status, 401);
    assert.equal((await c("POST", "/api/unlock", { passphrase: "verkeerd" })).status, 401);
    assert.equal((await c("POST", "/api/unlock", { passphrase: "vier losse woorden hier" })).status, 200);

    // "Nieuwe computer": andere kluis
    process.env.EIGEN_VAULT = path.join(base, "nieuwe-computer", "kluis.json");
    const { buildConsole: build2 } = await import(`../src/console/server.js?nieuw=${Date.now()}`);
    const app2 = await build2();
    const c2 = client(app2);
    const replica = cfg.stores.find((s: { purpose: string }) => s.purpose === "replica");
    let r = await c2("POST", "/api/setup/recover", { masterKey: "0".repeat(64), passphrase: "nieuwe wachtwoordzin", store: { name: "x", type: "fs", purpose: "replica", dir: replica.dir } });
    assert.match(r.json.error, /past niet/);
    r = await c2("POST", "/api/setup/recover", { masterKey: key, passphrase: "nieuwe wachtwoordzin", store: { name: "x", type: "fs", purpose: "replica", dir: replica.dir } });
    assert.equal(r.status, 200, r.text);
    const st = await waitFor("status via herstelde console", async () => { const s = (await c2("GET", "/api/status")).json; return s.state === "awake" && s; }, 30_000);
    assert.equal(st.domain, "vanes.test");
    await app2.close();
  });

  await app.close();
});
