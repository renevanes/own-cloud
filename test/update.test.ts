/**
 * Servers bijwerken, één voor één, met echte processen (lokale aanbieder): nieuwe versie gevonden → witness,
 * dataserver, leider (na overdracht) → alles op de nieuwe versie, gegevens intact. Daarna een kapotte versie:
 * de eerste server zet zichzelf terug, de update stopt, de rest blijft op de goede versie.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { api, killAll, readDb, startFirstNode, waitFor, nodeDirs } from "./helpers/cluster.js";
import { compareVersions } from "../src/version.js";
import { parseRef } from "../src/cluster/updates.js";
import { updatePrefix as prefixFromCloudinit, userData } from "../src/cluster/cloudinit.js";

const root = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-"));
const PW = "slakkenhuis-geheim";
const releaseFile = path.join(base, "release.json");
const digest = (n: number) => "sha256:" + String(n).repeat(64).slice(0, 64);
const release = (version: string, n: number) => fs.writeFileSync(releaseFile, JSON.stringify({ version, image: `ghcr.io/test/eigen-cloud@${digest(n)}`, caddyImage: `ghcr.io/test/eigen-caddy@${digest(n + 1)}` }));

test("hulpjes: versies vergelijken, image-verwijzingen, updater in cloud-init", () => {
  assert.equal(compareVersions("1.0.0.9", "1.0.0.10"), -1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.0.0-dev", "1.0.1"), null);
  assert.deepEqual(parseRef("ghcr.io/renevanes/eigen-cloud:latest"), { registry: "ghcr.io", repo: "renevanes/eigen-cloud", tag: "latest", digest: null });
  assert.equal(parseRef(`ghcr.io/a/b@${digest(3)}`)?.digest, digest(3));
  assert.equal(prefixFromCloudinit("ghcr.io/renevanes/eigen-cloud:latest"), "ghcr.io/renevanes/");
  assert.equal(prefixFromCloudinit("eigen-cloud:latest"), null);
  const ud = userData({ cluster: "c", clusterPort: 7946, domain: "x.nl", image: { ref: "ghcr.io/renevanes/eigen-cloud:latest" }, dns: [] } as never,
    { nodeId: "n1", kind: "data", bootstrapUrl: "https://s/x", joinToken: "t", appImage: `ghcr.io/renevanes/eigen-cloud@${digest(5)}` });
  assert.match(ud, new RegExp(`image: ghcr\\.io/renevanes/eigen-cloud@${digest(5)}  # eigen-app`));
  assert.match(ud, /docker pull ghcr\.io\/renevanes\/eigen-cloud@sha256/);
  assert.match(ud, /printf '%s\\n' 'ghcr\.io\/renevanes\/' > \/opt\/eigen\/update-allowed/);
  assert.match(ud, /PathModified=\/opt\/eigen\/data\/update-request\.json/);
});

test("servers bijwerken: rollend, leider als laatste, en terugzetten bij een kapotte versie", { skip: process.env.SKIP_CLUSTER === "1", timeout: 600_000 }, async (t) => {
  release("1.0.0.1", 1);
  Object.assign(process.env, {
    EIGEN_VERSION: "1.0.0.1", EIGEN_LOCAL_UPDATER: "1", EIGEN_RELEASE_URL: `file://${releaseFile}`, EIGEN_RELEASE_CHECK_MS: "3000",
    EIGEN_UPDATE_HEALTH_MS: "15000", EIGEN_BROKEN_VERSION: "1.0.0.3", EIGEN_UPDATE_TIMEOUT_MS: "120000",
  });
  const h = await startFirstNode(base, { autoReplaceAfterMin: 1 });
  t.after(() => { if (!process.env.KEEP) killAll(h); });
  const leaderApi = `http://127.0.0.1:${h.first.http}`;
  await waitFor("3 nodes klaar", () => (readDb(path.join(h.first.dir, "data"), (db) => db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'ready'").get() as { n: number })?.n ?? 0) === 3, 120_000, 1000);
  execFileSync(process.execPath, ["--import", "tsx", "src/setPassword.ts", PW], { cwd: root, env: { ...process.env, DATA_DIR: path.join(h.first.dir, "data") } });
  const token = (await waitFor("inloggen", async () => { const r = await api(leaderApi, "/api/login", { method: "POST", body: { password: PW } }); return r.status === 200 && r; })).json.token as string;
  // Via welke node dan ook: schrijfacties gaan vanzelf naar de leider.
  const anyApi = async (p: string, opts: { method?: string; body?: unknown } = {}) => {
    for (const dir of Object.values(nodeDirs(h))) {
      const log = path.join(path.dirname(dir), "node.log");
      const m = fs.existsSync(log) ? [...fs.readFileSync(log, "utf8").matchAll(/web (\d+)/g)].pop() : null;
      const url = dir.includes("/first/") ? leaderApi : m ? `http://127.0.0.1:${m[1]}` : null;
      if (!url) continue;
      const r = await api(url, p, { ...opts, token }).catch(() => null);
      if (r && r.status < 500) return r;
    }
    throw new Error("geen node bereikbaar");
  };
  const status = async () => (await anyApi("/api/cluster/status")).json;

  const ev = await anyApi("/api/events", { method: "POST", body: { title: "Vóór de update", start: Date.UTC(2026, 10, 3, 9), end: Date.UTC(2026, 10, 3, 10) } });
  assert.equal(ev.status, 200, ev.text);

  await t.test("alle servers op 1.0.0.1; meldingsstand", async () => {
    const st = await waitFor("versies bekend", async () => { const s = await status(); return Object.values(s.update.nodes).every((n: any) => n.version === "1.0.0.1" && n.updater) && Object.keys(s.update.nodes).length === 3 && s; }, 60_000, 1000);
    assert.equal(st.update.available, null);
    const r = await anyApi("/api/cluster/update", { method: "POST", body: { mode: "melden" } });
    assert.equal(r.json.update.mode, "melden");
    assert.equal((await anyApi("/api/cluster/update", { method: "POST", body: { mode: "soms" } })).status, 400);
  });

  await t.test("nieuwe versie: gemeld, niet vanzelf geïnstalleerd", async () => {
    release("1.0.0.2", 2);
    const r = await anyApi("/api/cluster/update", { method: "POST", body: { check: true } });
    assert.equal(r.json.update.available, "1.0.0.2");
    await new Promise((res) => setTimeout(res, 5000));
    const st = await status();
    assert.ok(!st.jobs.some((j: any) => j.type === "update"), "in meldingsstand geen automatische update");
    assert.ok(st.events.some((e: any) => /1\.0\.0\.2 is beschikbaar/.test(e.message)));
  });

  await t.test("nu bijwerken: één voor één, leider als laatste", async () => {
    const before = await status();
    const oldLeader = before.leader;
    const r = await anyApi("/api/cluster/update", { method: "POST", body: { now: true } });
    assert.equal(r.status, 200, r.text);
    const st = await waitFor("alles op 1.0.0.2", async () => {
      const s = await status().catch(() => null);
      return s && Object.values(s.update.nodes).length === 3 && Object.values(s.update.nodes).every((n: any) => n.version === "1.0.0.2") && s.jobs.find((j: any) => j.type === "update")?.status === "done" && s;
    }, 240_000, 2000);
    assert.notEqual(st.leader, oldLeader, "leiding is overgedragen om de oude leider bij te werken");
    assert.equal(st.nodes.filter((n: any) => n.status === "ready").length, 3, "geen server vervangen: op de plek zelf bijgewerkt");
    const msgs = st.events.map((e: any) => e.message).reverse();
    const order = msgs.filter((m: string) => /draait nu versie 1\.0\.0\.2/.test(m)).map((m: string) => m.split(" ")[0]);
    const kinds = Object.fromEntries(st.nodes.map((n: any) => [n.id, n.kind]));
    assert.equal(kinds[order[0]], "witness", `witness eerst (volgorde: ${order.join(", ")})`);
    assert.equal(order.at(-1), oldLeader, "de oude leider als laatste");
    assert.ok(msgs.some((m: string) => /Alle servers draaien nu versie 1\.0\.0\.2/.test(m)));
    const evs = (await anyApi(`/api/events?from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2026, 10, 30)}`)).json;
    assert.deepEqual(evs.map((e: any) => e.title), ["Vóór de update"], "gegevens intact");
    assert.equal(st.update.available, null);
  });

  await t.test("kapotte versie: eerste server zet zichzelf terug, update stopt", async () => {
    release("1.0.0.3", 4);
    const r = await anyApi("/api/cluster/update", { method: "POST", body: { now: true } });
    assert.equal(r.status, 200, r.text);
    const st = await waitFor("update mislukt", async () => {
      const s = await status().catch(() => null);
      return s && s.jobs.find((j: any) => j.type === "update" && j.status === "failed") && s;
    }, 180_000, 2000);
    assert.equal(st.update.failed?.version, "1.0.0.3");
    const back = await waitFor("terug op 1.0.0.2", async () => { const s = await status().catch(() => null); return s && Object.values(s.update.nodes).every((n: any) => n.version === "1.0.0.2") && s.nodes.filter((n: any) => n.status === "ready").length === 3 && s; }, 60_000, 2000);
    assert.equal(back.update.available, "1.0.0.3", "nog steeds beschikbaar, maar niet automatisch opnieuw");
    const hc = await anyApi("/api/health?fresh=1");
    const sw = hc.json.checks.find((c: any) => c.id === "software");
    assert.equal(sw?.status, "warn");
    assert.match(sw.detail, /lukte niet/);
  });
});
