/**
 * Kosten en budget: de rekenregels (src/cluster/costs.ts), de instellingen voor het cluster, de controle "Kosten"
 * met één melding, en GET /api/costs + POST /api/costs/budget in de beheerconsole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "kosten-"));
process.env.EIGEN_CONSOLE_LOCAL = "1";
process.env.EIGEN_VAULT = path.join(base, "kluis.json");
process.env.DATA_DIR = path.join(base, "data");

const costs = await import("../src/cluster/costs.js");
const consoleCosts = await import("../src/console/costs.js");
const { consoleSettings } = await import("../src/cluster/admin.js");
const { isMailNoticeDue } = await import("../src/health.js");
const { registerAdapter } = await import("../src/cluster/adapters.js");
const { storeOffers } = await import("../src/console/catalog.js");
const { ClusterService } = await import("../src/cluster/service.js");

test("rekenregels: servers, opslag, onbekend en afronden", () => {
  const e = costs.estimate(
    [{ provider: "scaleway", monthly: 6.42 }, { provider: "scaleway", monthly: 0.1 }, { provider: "exoscale", monthly: null }],
    [
      { name: "scaleway-nl-ams", provider: "scaleway", bytes: 10e9, pricePerGbMonth: 0.01606 },
      { name: "hetzner-fsn1", provider: "hetzner", bytes: 1e9, pricePerGbMonth: null },
      { name: "nas", provider: null, bytes: null, pricePerGbMonth: null },
    ],
    (id) => id.toUpperCase(),
  );
  assert.deepEqual(e.providers.map((p) => [p.id, p.name, p.servers, p.storage, p.bytes, p.total, p.source]), [
    ["scaleway", "SCALEWAY", 6.52, 0.16, 10e9, 6.68, "geschat"],
    ["exoscale", "EXOSCALE", null, 0, 0, 0, "geschat"],
    ["hetzner", "HETZNER", 0, null, 1e9, 0, "geschat"],
    ["nas", "NAS", 0, null, null, 0, "geschat"],
  ]);
  assert.equal(e.total, 6.68);
  assert.equal(e.complete, false);
  assert.equal(costs.estimate([], [], (x) => x).complete, true);

  assert.equal(costs.storeOfferId("scaleway-nl-ams-backup", ["scaleway", "scale"]), "scaleway");
  assert.equal(costs.storeOfferId("eigen-nas", ["scaleway"]), null);
  const prices = costs.serverPrices({ hetzner: { fsn1: { data: { size: "cx23", monthly: 4.51 }, witness: { size: "cx23", monthly: 4.51 } } }, exoscale: { x: { data: { size: "s", monthly: null } } } });
  assert.deepEqual(prices, { "hetzner/fsn1/cx23": 4.51 });
  assert.equal(costs.serverPrice(prices, { provider: "hetzner", region: "fsn1", size: "cx23" }), 4.51);
  assert.equal(costs.serverPrice(prices, { provider: "hetzner", region: "fsn1", size: "cx23", monthly_cost: 4.99 }), 4.99);
  assert.equal(costs.serverPrice(prices, { provider: "hetzner", region: "nbg1", size: "cx23" }), null);

  assert.deepEqual([25, "25,50", " 7.5 ", "0", "-1", "1e3", "abc", "", null].map(costs.parseBudget), [25, 25.5, 7.5, null, null, null, null, null, null]);
});

test("lijstprijzen: Scaleway nagekeken, de rest onbekend (null)", () => {
  const p = Object.fromEntries(storeOffers().map((o) => [o.id, o.pricePerGbMonth]));
  assert.equal(p.scaleway, 0.01606);
  for (const id of ["hetzner", "upcloud", "exoscale", "ovh", "custom"]) assert.equal(p[id], null, id);
});

test("draaiende servers: wakker, slapend, onbereikbaar", () => {
  const live = { leader: true, nodes: [
    { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", status: "ready", monthly_cost: null },
    { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", status: "failed", monthly_cost: null },
    { provider: "manual", region: null, size: null, status: "ready" },
  ] };
  assert.deepEqual(consoleCosts.runningServers({ manifest: null, live }), { sleeping: false, nodes: [{ provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", monthly_cost: null }] });
  const manifest = { state: "asleep", topology: [{ kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S" }] } as never;
  assert.deepEqual(consoleCosts.runningServers({ manifest, live: null }), { sleeping: true, nodes: [] });
  assert.equal(consoleCosts.runningServers({ manifest: { ...(manifest as object), state: "awake" } as never, live: null }).nodes.length, 1);
});

test("instellingen voor het cluster: budget_month en cost_servers", () => {
  const c = { dns: [], console: { budget: 25.5, catalog: { scaleway: { "nl-ams-1": { data: { size: "DEV1-S", monthly: 6.42 } } } } } } as never;
  const s = consoleSettings(c);
  assert.equal(s.budget_month, "25.5");
  assert.equal(s.cost_servers, JSON.stringify({ "scaleway/nl-ams-1/DEV1-S": 6.42 }));
  assert.equal(consoleSettings({ dns: [], console: {} } as never).budget_month, "", "geen budget: leeg (wist een eerder budget)");
});

test("controle Kosten: aandachtspunt boven het budget, één melding", () => {
  const over = costs.costCheck({ total: 30.4, complete: true, budget: 25 });
  assert.equal(over.status, "warn");
  assert.equal(over.group, "Kosten");
  assert.match(over.detail, /€ 30,40 per maand; je budget is € 25,00/);
  const ok = costs.costCheck({ total: 20, complete: false, budget: 25 });
  assert.equal(ok.status, "ok");
  assert.match(ok.detail, /prijs onbekend/);
  assert.deepEqual(isMailNoticeDue({ costs: "ok" }, [over]).worse.map((c) => c.id), ["costs"], "eerste keer: melden");
  assert.equal(isMailNoticeDue({ costs: "warn" }, [over]).worse.length, 0, "daarna niet opnieuw");
  assert.deepEqual(isMailNoticeDue({ costs: "warn" }, [ok]).fixed.map((c) => c.id), ["costs"], "weer binnen budget");
});

test("cluster: schatting tegen het budget (refreshCosts), opslag eens per 6 uur gemeten", async () => {
  let lists = 0;
  const settings: Record<string, string> = { budget_month: "5", cost_servers: JSON.stringify({ "scaleway/nl-ams-1/DEV1-S": 6.42 }) };
  const fake = {
    getSetting: (k: string) => settings[k],
    nodes: () => [
      { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", monthly_cost: null },
      { provider: "manual", region: "x", size: "y", monthly_cost: null },
    ],
    stores: [{ name: "scaleway-nl-ams", list: async () => { lists++; return [{ key: "a", size: 2e9 }, { key: "b", size: 1e9 }]; } }],
    storeBytes: new Map(),
    costs: null as unknown,
  };
  const refresh = (ClusterService.prototype as unknown as { refreshCosts(this: typeof fake): Promise<void> }).refreshCosts;
  await refresh.call(fake);
  assert.deepEqual(fake.costs, { total: 6.47, complete: true, budget: 5 });
  await refresh.call(fake);
  assert.equal(lists, 1, "bytes uit de cache");
  settings.budget_month = "";
  await refresh.call(fake);
  assert.equal(fake.costs, null, "zonder budget geen controle");
});

test("beheerconsole: GET /api/costs en het budget", async () => {
  // Testopslag met een prijs (1000 euro per GB, zodat een klein bestand al meetelt).
  const undo = registerAdapter({ id: "localfs", name: "Testopslag", owner: "Test", home: "NL", signupUrl: "", keyHelp: "", fields: [], testOnly: true,
    storage: { name: "Testopslag", regions: [{ id: "nl", label: "Lokaal", country: "NL", endpoint: "" }], keyHelp: "", pricePerGbMonth: 1000 } });
  try {
    const { buildConsole } = await import("../src/console/server.js");
    const app = await buildConsole();
    let cookie = "";
    const c = async (method: string, url: string, body?: unknown) => {
      const r = await app.inject({ method: method as "GET", url, payload: body as never, headers: cookie ? { cookie } : {} });
      const sc = r.headers["set-cookie"];
      if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
      return { status: r.statusCode, json: r.json() };
    };
    assert.equal((await c("GET", "/api/costs")).status, 401);
    assert.equal((await c("POST", "/api/setup/create", { domain: "kosten.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" })).status, 200);
    const st = await c("POST", "/api/stores", { offer: "localfs", region: "nl", purpose: "replica" });
    assert.equal(st.json.ok, true, JSON.stringify(st.json));
    fs.writeFileSync(path.join(base, "opslag", "localfs-nl", "foto.bin"), Buffer.alloc(20_000));

    let k = (await c("GET", "/api/costs?fresh=1")).json;
    assert.deepEqual(k.providers, [{ id: "localfs", name: "Testopslag", servers: 0, storage: 0.02, bytes: 20_000, total: 0.02, source: "geschat" }]);
    assert.equal(k.total, 0.02);
    assert.equal(k.budget, null);
    assert.equal(k.overBudget, false);
    assert.equal(k.sleeping, false);
    assert.equal(typeof k.updatedAt, "number");

    assert.equal((await c("POST", "/api/costs/budget", { budget: "abc" })).status, 400);
    assert.deepEqual((await c("POST", "/api/costs/budget", { budget: "0,01" })).json, { ok: true, budget: 0.01 });
    k = (await c("GET", "/api/costs")).json;
    assert.equal(k.budget, 0.01);
    assert.equal(k.overBudget, true);
    assert.deepEqual((await c("POST", "/api/costs/budget", { budget: null })).json, { ok: true, budget: null });
    assert.equal((await c("GET", "/api/costs")).json.budget, null);
    await app.close();
  } finally {
    undo();
  }
});
