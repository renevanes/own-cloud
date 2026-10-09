/**
 * End-to-end: echte processen, lokale "aanbieder", bestands-opslag. Doorloopt de hele levenscyclus van de slak.
 * Duurt ±2–3 minuten. Overslaan met SKIP_CLUSTER=1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { api, killAll, nodeDirs, pidOf, readDb, servers, startFirstNode, waitFor, type Harness } from "./helpers/cluster.js";
import { keysFor } from "../src/cluster/config.js";
import { openJson } from "../src/cluster/crypto.js";
import { restoreFromStore } from "../src/cluster/backup.js";
import { FsStore } from "../src/cluster/stores.js";

const root = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "slak-"));
const PW = "slakkenhuis-geheim";

type NodeRow = { id: string; kind: string; status: string; api_url: string; cluster_url: string; provider: string };

function registry(h: Harness, via?: string): NodeRow[] {
  const dirs = nodeDirs(h);
  for (const id of via ? [via] : Object.keys(dirs)) {
    try {
      const rows = readDb(dirs[id], (db) => db.prepare("SELECT * FROM nodes").all() as NodeRow[]);
      if (rows) return rows;
    } catch { /* volgende */ }
  }
  return [];
}

function alive(pid: number | undefined) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Levende nodes met hun API-adres (uit de procesadministratie van de lokale aanbieder). */
function liveApis(h: Harness): { id: string; apiUrl: string }[] {
  const out: { id: string; apiUrl: string }[] = [];
  for (const s of Object.values(servers(h.base))) {
    const log = path.join(s.dir, "node.log");
    const m = fs.existsSync(log) ? /web (\d+)/.exec(fs.readFileSync(log, "utf8")) : null;
    if (m && alive(s.pid)) out.push({ id: s.nodeId, apiUrl: `http://127.0.0.1:${m[1]}` });
  }
  if (alive(h.first.pid)) out.push({ id: "n-first", apiUrl: `http://127.0.0.1:${h.first.http}` });
  return out;
}

async function localStatus(apiUrl: string, token: string) {
  return (await api(apiUrl, "/api/cluster/local", { token }).catch(() => null))?.json;
}

/** Zoekt de huidige leider door alle levende data-nodes te vragen. */
async function findLeader(h: Harness, token: string): Promise<NodeRow> {
  return waitFor("leider", async () => {
    for (const n of liveApis(h)) {
      const s = await localStatus(n.apiUrl, token);
      if (s?.role === "leader" && s.leaseUntil > Date.now()) return { id: n.id, api_url: n.apiUrl, kind: "data" } as NodeRow;
    }
    return null;
  }, 30_000);
}

test("de slak: vermenigvuldigen, repliceren, failover, zelfherstel, fencing, back-up, slapen en wekken", { skip: process.env.SKIP_CLUSTER === "1", timeout: 600_000 }, async (t) => {
  const h = await startFirstNode(base, { autoReplaceAfterMin: 0.4 });
  let token = "";
  t.after(() => { if (!process.env.KEEP) killAll(h); });

  await t.test("1. vermenigvuldigt zichzelf tot 2 data-nodes + 1 witness", async () => {
    await waitFor("3 nodes klaar", () => registry(h, "n-first").filter((r) => r.status === "ready").length === 3, 90_000, 1000);
    const dns = JSON.parse(fs.readFileSync(path.join(base, "dns.json"), "utf8"));
    assert.deepEqual(dns["mail/A"].values, ["127.0.0.1"]);
    assert.deepEqual(dns["/MX"].values, ["10 mail.test.nl."]);
  });

  const rows = registry(h, "n-first");
  const follower = rows.find((r) => r.kind === "data" && r.id !== "n-first")!;
  const leaderApi = `http://127.0.0.1:${h.first.http}`;

  await t.test("2. wachtwoord op leider, inloggen via volger (doorgestuurd)", async () => {
    execFileSync(process.execPath, ["--import", "tsx", "src/setPassword.ts", PW], { cwd: root, env: { ...process.env, DATA_DIR: path.join(h.first.dir, "data") } });
    const r = await waitFor("login via volger", async () => { const x = await api(follower.api_url, "/api/login", { method: "POST", body: { password: PW } }); return x.status === 200 && x; });
    token = r.json.token;
    assert.ok(token);
  });

  const start = Date.parse("2026-11-02T09:00:00+01:00");
  let eventCreatedAt = 0;
  await t.test("3. schrijven via volger komt bij leider en terug op volger", async () => {
    await new Promise((r) => setTimeout(r, 50));
    eventCreatedAt = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    const r = await api(follower.api_url, "/api/events", { method: "POST", token, body: { title: "Tandarts", start, end: start + 3600e3 } });
    assert.equal(r.status, 200, r.text);
    // Semi-synchroon: na het antwoord staat het al op de volger
    const onFollower = readDb(nodeDirs(h)[follower.id], (db) => db.prepare("SELECT title FROM events WHERE title = 'Tandarts'").get());
    assert.ok(onFollower, "staat direct op de volger");
  });

  let photoRel = "";
  await t.test("4. foto-upload: bestand wordt naar volger en opslag gekopieerd (versleuteld)", async () => {
    const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#e76f51" } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.append("file", new Blob([img], { type: "image/jpeg" }), "slak.jpg");
    const r = await fetch(leaderApi + "/api/photos/upload", { method: "POST", body: fd, headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    photoRel = readDb(path.join(h.first.dir, "data"), (db) => (db.prepare("SELECT path FROM photos").get() as { path: string }).path)!;
    await waitFor("foto op volger", () => fs.existsSync(path.join(nodeDirs(h)[follower.id], photoRel)), 20_000);
    await waitFor("foto in opslag", () => fs.existsSync(path.join(base, "store-backup", "blobs", photoRel)), 20_000);
    const stored = fs.readFileSync(path.join(base, "store-backup", "blobs", photoRel));
    assert.ok(!stored.includes(img.subarray(0, 64)), "opgeslagen bestand is versleuteld");
  });

  await t.test("5. secundaire MX: mail naar de volger komt bij de leider aan", async () => {
    const followerSmtp = Number(/SMTP luistert op poort (\d+)/.exec(fs.readFileSync(path.join(path.dirname(nodeDirs(h)[follower.id]), "node.log"), "utf8"))![1]);
    const tr = nodemailer.createTransport({ host: "127.0.0.1", port: followerSmtp, secure: false, ignoreTLS: true });
    await tr.sendMail({ from: "jos@elders.nl", to: "rene@test.nl", subject: "Via MX2", text: "hallo slak" });
    await waitFor("mail bij leider", () => readDb(path.join(h.first.dir, "data"), (db) => db.prepare("SELECT 1 FROM messages WHERE subject = 'Via MX2'").get()), 20_000);
  });

  let newLeader!: NodeRow;
  await t.test("6. failover: leider valt weg → volger wordt leider dankzij witness, schrijven werkt", async () => {
    process.kill(-h.first.pid, "SIGKILL");
    newLeader = await findLeader(h, token);
    assert.equal(newLeader.id, follower.id);
    const r = await waitFor("schrijven op nieuwe leider", async () => {
      const x = await api(newLeader.api_url, "/api/events", { method: "POST", token, body: { title: "Na failover", start, end: start + 1800e3 } });
      return x.status === 200 && x;
    }, 20_000);
    assert.equal(r.status, 200);
    const events = await api(newLeader.api_url, `/api/events?from=${start - 864e5}&to=${start + 864e5}`, { token });
    assert.deepEqual(events.json.map((e: { title: string }) => e.title).sort(), ["Na failover", "Tandarts"]);
  });

  await t.test("7. zelfherstel: vervangt de weggevallen node automatisch", async () => {
    await waitFor("vervanger klaar en oude node verwijderd", () => {
      const r = registry(h, newLeader.id);
      const first = r.find((x) => x.id === "n-first");
      return first?.status === "removed" && r.filter((x) => x.kind === "data" && x.status === "ready").length === 2;
    }, 120_000, 1000);
  });

  await t.test("8. split-brain onmogelijk: bevroren leider met niet-gerepliceerde schrijfactie herstelt zichzelf", async () => {
    const leader = await findLeader(h, token);
    const pid = pidOf(h, leader.id)!;
    const dbFile = path.join(nodeDirs(h)[leader.id], "eigen-cloud.sqlite");
    process.kill(-pid, "SIGSTOP");
    let other: { id: string; apiUrl: string };
    try {
      // Binnen de lease mag nog geschreven worden: deze wijziging bereikt het cluster nooit (verweesd).
      const db = new Database(dbFile);
      db.prepare("INSERT INTO settings (key, value) VALUES ('verweesd', 'ja')").run();
      other = await waitFor("nieuwe leider tijdens bevriezing", async () => {
        for (const n of liveApis(h).filter((x) => x.id !== leader.id)) {
          const s = await localStatus(n.apiUrl, token);
          if (s?.role === "leader") return n;
        }
        return null;
      }, 30_000);
      // Lease verlopen: de bevroren leider kan niets meer schrijven, ook niet via een ander proces.
      assert.throws(() => db.prepare("INSERT INTO settings (key, value) VALUES ('split', 'brain')").run(), /NOT_LEADER/);
      db.close();
      const w = await waitFor("schrijven op nieuwe leider", async () => {
        const x = await api(other.apiUrl, "/api/events", { method: "POST", token, body: { title: "Tijdens bevriezing", start, end: start + 600e3 } });
        return x.status === 200 && x;
      }, 20_000);
      assert.equal(w.status, 200);
    } finally {
      try { process.kill(-pid, "SIGCONT"); } catch { /* al vervangen */ }
    }
    // Oude leider ziet het conflict, bewaart zijn oude database en herstelt vanaf de opslag.
    const dataDir = nodeDirs(h)[leader.id];
    await waitFor("oude database bewaard", () => fs.existsSync(path.join(dataDir, "orphans")) && fs.readdirSync(path.join(dataDir, "orphans")).length > 0, 30_000);
    await waitFor("oude leider bijgewerkt en zonder verweesde wijziging", () => readDb(dataDir, (db) =>
      !!db.prepare("SELECT 1 FROM events WHERE title = 'Tijdens bevriezing'").get() && !db.prepare("SELECT 1 FROM settings WHERE key = 'verweesd'").get()), 40_000);
    const onLeader = readDb(nodeDirs(h)[other!.id], (db) => db.prepare("SELECT 1 FROM settings WHERE key = 'verweesd'").get());
    assert.equal(onLeader, undefined, "verweesde schrijfactie is nergens in het cluster terechtgekomen");
    await waitFor("oude leider is volger", async () => (await localStatus(leader.api_url, token))?.role === "follower", 20_000);
  });

  await t.test("9. back-up: herstel uit de back-upopslag, ook naar een eerder tijdstip", async () => {
    const keys = keysFor(h.cfg);
    const store = new FsStore(h.cfg.stores[1]);
    await waitFor("segmenten bijgewerkt", async () => {
      const out = path.join(base, "restore-now.sqlite");
      const r = await restoreFromStore(store, keys.db!, out);
      return r && readDb(base, () => true) !== undefined && new Database(out, { readonly: true }).prepare("SELECT 1 FROM events WHERE title = 'Na failover'").get();
    }, 20_000);
    const out = path.join(base, "restore-pit.sqlite");
    await restoreFromStore(store, keys.db!, out, { until: eventCreatedAt });
    const pit = new Database(out, { readonly: true });
    assert.equal(pit.prepare("SELECT COUNT(*) AS n FROM events WHERE title = 'Tandarts'").get().n, 0, "tijdstip vóór de afspraak");
    assert.ok(pit.prepare("SELECT 1 FROM settings WHERE key = 'password_hash'").get(), "wachtwoord was er al");
    pit.close();
  });

  await t.test("10. brandoefening via de API slaagt voor beide opslagplaatsen", async () => {
    const leader = await findLeader(h, token);
    const r = await api(leader.api_url, "/api/cluster/jobs", { method: "POST", token, body: { type: "drill" } });
    assert.equal(r.status, 200, r.text);
    const ev = await waitFor("drill-resultaat", async () => {
      const s = await api(leader.api_url, "/api/cluster/status", { token });
      return s.json?.events?.find((e: { kind: string }) => e.kind === "drill");
    }, 30_000);
    assert.match(ev.message, /geslaagd/, ev.message);
  });

  await t.test("10a. tijdmachine: verwijderde afspraak en foto terughalen", async () => {
    const leader = await findLeader(h, token);
    const evs = (await api(leader.api_url, `/api/events?from=${start - 864e5}&to=${start + 864e5}`, { token })).json;
    const tandarts = evs.find((e: { title: string }) => e.title === "Tandarts");
    const photo = (await api(leader.api_url, "/api/photos", { token })).json[0];
    await new Promise((r) => setTimeout(r, 1500)); // zeker na de laatste wijziging
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await api(leader.api_url, `/api/events/${tandarts.id}`, { method: "DELETE", token })).status, 200);
    assert.equal((await api(leader.api_url, `/api/photos/${photo.id}`, { method: "DELETE", token })).status, 200);
    const info = (await api(leader.api_url, "/api/timemachine", { token })).json;
    assert.equal(info.available, true);
    const prev = await waitFor("voorbeeld", async () => {
      const r = await api(leader.api_url, "/api/timemachine/preview", { method: "POST", token, body: { at: before } });
      return r.status === 200 && r.json.counts.events >= 1 && r.json.counts.photos >= 1 && r.json;
    }, 30_000);
    const ev = prev.items.events.find((e: { title: string }) => e.title === "Tandarts");
    assert.equal(ev.reason, "verwijderd");
    const ph = prev.items.photos.find((p: { id: number }) => p.id === photo.id);
    assert.equal(ph.reason, "in prullenbak");
    const thumb = await fetch(`${leader.api_url}/api/timemachine/${prev.id}/photos/${photo.id}/thumb`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(thumb.status, 200);
    const r = await api(leader.api_url, "/api/timemachine/restore", { method: "POST", token, body: { id: prev.id, events: [ev.uid], photos: [ph.id] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.restored, { messages: 0, events: 1, photos: 1 });
    const after = (await api(leader.api_url, `/api/events?from=${start - 864e5}&to=${start + 864e5}`, { token })).json;
    assert.ok(after.some((e: { title: string }) => e.title === "Tandarts"));
    assert.equal((await api(leader.api_url, "/api/photos", { token })).json.length, 1, "foto uit de prullenbak terug");
  });

  await t.test("10b. verhuizen van de leider zelf: overdracht, nieuwe node, oude weg — zonder dataverlies", async () => {
    const leader = await findLeader(h, token);
    const r = await api(leader.api_url, "/api/cluster/jobs", { method: "POST", token, body: { type: "move", params: { nodeId: leader.id, to: { provider: "local", region: "ams", size: "s", country: "NL" } } } });
    assert.equal(r.status, 200, r.text);
    await waitFor("oude leider weg", () => !alive(pidOf(h, leader.id)), 90_000, 500);
    const nl = await findLeader(h, token);
    assert.notEqual(nl.id, leader.id);
    const w = await waitFor("schrijven na verhuizing", async () => {
      const x = await api(nl.api_url, "/api/events", { method: "POST", token, body: { title: "Na verhuizing", start: start + 7200e3, end: start + 9000e3 } });
      return x.status === 200 && x;
    }, 20_000);
    assert.equal(w.status, 200);
    const events = await api(nl.api_url, `/api/events?from=${start - 864e5}&to=${start + 864e5}`, { token });
    assert.deepEqual(events.json.map((e: { title: string }) => e.title).sort(), ["Na failover", "Na verhuizing", "Tandarts", "Tijdens bevriezing"]);
    await waitFor("weer 2 data-nodes + witness", async () => {
      const s = await api(nl.api_url, "/api/cluster/status", { token });
      return (s.json?.nodes ?? []).filter((n: { status: string }) => n.status === "ready").length === 3;
    }, 60_000, 1000);
  });

  await t.test("11. slapen: alles weggeschreven, alle servers weg, manifest 'asleep'", async () => {
    const leader = await findLeader(h, token);
    const r = await api(leader.api_url, "/api/cluster/jobs", { method: "POST", token, body: { type: "sleep" } });
    assert.equal(r.status, 200);
    await waitFor("alle processen weg", () => Object.values(servers(base)).every((s) => !alive(s.pid)) && Object.keys(servers(base)).length === 0, 60_000, 500);
    const keys = keysFor(h.cfg);
    const m = openJson<{ state: string; topology: unknown[] }>(keys.manifest!, fs.readFileSync(path.join(base, "store-replica", "manifest.enc")), "manifest");
    assert.equal(m.state, "asleep");
    assert.equal(m.topology.length, 3);
  });

  await t.test("12. wekken met de CLI: data terug, cluster vult zichzelf weer aan", async () => {
    const eigenCfg = path.join(base, "eigen.json");
    fs.writeFileSync(eigenCfg, JSON.stringify({ ...h.cfg, bootstrapLeader: false }));
    const out = spawnSync(process.execPath, ["--import", "tsx", "src/cluster/cli.ts", "wake"], { cwd: root, env: { ...process.env, EIGEN_CONFIG: eigenCfg, CLUSTER_FAST: "1" }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    const woke = await waitFor("gewekte node", () => Object.values(servers(base))[0], 10_000);
    const apiUrl = await waitFor("api van gewekte node", () => {
      const log = fs.existsSync(path.join(woke.dir, "node.log")) ? fs.readFileSync(path.join(woke.dir, "node.log"), "utf8") : "";
      const m = /web (\d+)/.exec(log);
      return m && `http://127.0.0.1:${m[1]}`;
    }, 30_000);
    const login = await waitFor("inloggen na wekken", async () => { const x = await api(apiUrl, "/api/login", { method: "POST", body: { password: PW } }); return x.status === 200 && x; }, 30_000);
    const tk = login.json.token;
    const events = await api(apiUrl, `/api/events?from=${start - 864e5}&to=${start + 864e5}`, { token: tk });
    assert.deepEqual(events.json.map((e: { title: string }) => e.title).sort(), ["Na failover", "Na verhuizing", "Tandarts", "Tijdens bevriezing"]);
    const photo = (await api(apiUrl, "/api/photos", { token: tk })).json[0];
    const orig = await fetch(`${apiUrl}/api/photos/${photo.id}/original`, { headers: { authorization: `Bearer ${tk}` } });
    assert.equal(orig.status, 200, "foto wordt uit de opslag teruggehaald");
    await waitFor("weer 2 data-nodes + witness", async () => {
      const s = await api(apiUrl, "/api/cluster/status", { token: tk });
      const ready = (s.json?.nodes ?? []).filter((n: { status: string }) => n.status === "ready");
      return ready.length === 3;
    }, 120_000, 1000);
  });
});
