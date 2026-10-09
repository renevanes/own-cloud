/**
 * Beheer-CLI. Draait op je eigen laptop (of telefoon via Termux) met een beheerconfiguratie (eigen.json):
 * hoofdsleutel, opslag en API-tokens van aanbieders. Bewaar dat bestand in je wachtwoordmanager.
 *
 *   eigen init <cluster> <domein>         maak beheerconfiguratie + hoofdsleutel
 *   eigen key                              toon hoofdsleutel om op papier te bewaren
 *   eigen status                           lees het manifest uit de opslag (ook als alles slaapt)
 *   eigen wake [provider region size]      maak een eerste node uit de back-up; het cluster vult zichzelf aan
 *   eigen restore <bestand> [--until ISO] [--store naam]   database herstellen (ook naar een tijdstip)
 *   eigen drill                            brandoefening lokaal: herstel uit elke opslag en controleer
 *   eigen first-node                       zet een bestaande losse server om naar de eerste clusternode
 *   eigen job <type> [json]                job starten via de API (EIGEN_URL + EIGEN_PASSWORD)
 *   eigen provider-test <naam>             test inloggegevens van een aanbieder (lijst servers)
 *   eigen upload-images <app.tar.gz> [caddy.tar.gz]   images in je eigen opslag zetten (zie scripts/build-images.sh)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deriveKey, openJson, randomKeyHex, sealJson } from "./crypto.js";
import { DEFAULT_POLICY, keysFor, loadClusterConfig, writeClusterConfig, type ClusterConfig } from "./config.js";
import { makeStore } from "./stores.js";
import { restoreFromStore, restoreFromAny, listChain } from "./backup.js";
import { makeProvider } from "./providers.js";
import { imageUrls, userData } from "./cloudinit.js";

const cfgFile = process.env.EIGEN_CONFIG ?? "eigen.json";
const [cmd, ...args] = process.argv.slice(2);

function load(): ClusterConfig {
  if (!fs.existsSync(cfgFile)) throw new Error(`${cfgFile} niet gevonden (maak er een met: eigen init)`);
  return loadClusterConfig(cfgFile);
}

async function readManifest(c: ClusterConfig) {
  const keys = keysFor(c);
  let best: Record<string, any> | null = null;
  for (const s of c.stores.map(makeStore)) {
    try {
      const buf = await s.getBuffer("manifest.enc");
      if (!buf) continue;
      const m = openJson<Record<string, any>>(keys.manifest!, buf, "manifest");
      if (!best || m.updated > best.updated) best = { ...m, _store: s.name };
    } catch (e) {
      console.warn(`  ${s.name}: ${(e as Error).message}`);
    }
  }
  return best;
}

async function probeCluster(c: ClusterConfig, m: Record<string, any>): Promise<string[]> {
  const { rpc } = await import("./transport.js");
  const keys = keysFor(c);
  const urls: { id: string; url: string }[] = (m.nodes ?? []).filter((n: { status: string }) => n.status !== "removed").map((n: { id: string; ipv4: string; clusterUrl?: string }) => ({ id: n.id, url: n.clusterUrl ?? `http://${n.ipv4}:${c.clusterPort}` }));
  const alive: string[] = [];
  await Promise.all(urls.map(async ({ id, url }) => {
    try { await rpc(keys.cluster, url, { type: "status" }, 3000); alive.push(id); } catch { /* weg */ }
  }));
  return alive;
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString("nl-NL");
}

async function main() {
  switch (cmd) {
    case "init": {
      const [cluster = "eigen", domain = "jouwdomein.nl"] = args;
      if (fs.existsSync(cfgFile)) throw new Error(`${cfgFile} bestaat al`);
      const c: ClusterConfig = {
        cluster, nodeId: "beheer", kind: "data", masterKey: randomKeyHex(), clusterPort: 7946,
        advertise: { clusterUrl: "" }, seeds: [], domain,
        stores: [
          { name: "hetzner-fsn", type: "s3", purpose: "replica", country: "DE", endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1", bucket: `${cluster}-replica`, accessKey: "", secretKey: "" },
          { name: "scaleway-ams", type: "s3", purpose: "replica", country: "NL", endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams", bucket: `${cluster}-replica`, accessKey: "", secretKey: "" },
          { name: "backup-upcloud", type: "s3", purpose: "backup", country: "FI", endpoint: "https://<jouw-id>.upcloudobjects.com", region: "europe-1", bucket: `${cluster}-backup`, accessKey: "", secretKey: "" },
        ],
        providers: { hetzner: { token: "" }, scaleway: { secretKey: "", projectId: "" }, upcloud: { token: "" } },
        dns: [{ type: "desec", name: "desec", token: "", zone: domain }],
        image: { url: "", ref: "eigen-cloud:latest" },
        appEnv: { MAIL_DOMAINS: domain, MAIL_FROM: `rene@${domain}`, HOSTNAME_FQDN: `mail.${domain}`, NODE_ENV: "production" },
        policy: {
          ...DEFAULT_POLICY,
          placement: [
            { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", country: "NL", kind: "data" },
            { provider: "hetzner", region: "fsn1", size: "cx23", country: "DE", kind: "data" },
            { provider: "upcloud", region: "fi-hel1", size: "1xCPU-1GB", country: "FI" },
            { provider: "hetzner", region: "hel1", size: "cx23", country: "FI", kind: "witness" },
          ],
        },
      };
      writeClusterConfig(cfgFile, c);
      console.log(`✅ ${cfgFile} aangemaakt. Vul de opslag- en API-gegevens in.\n`);
      console.log("Bewaar deze hoofdsleutel ook op papier (zonder sleutel is de back-up onleesbaar):\n");
      console.log("  " + c.masterKey!.match(/.{1,8}/g)!.join(" ") + "\n");
      break;
    }
    case "key": {
      const c = load();
      console.log(c.masterKey!.match(/.{1,8}/g)!.join(" "));
      const check = crypto.createHash("sha256").update(c.masterKey!).digest("hex").slice(0, 8);
      console.log(`controlegetal: ${check}`);
      break;
    }
    case "status": {
      const c = load();
      const m = await readManifest(c);
      if (!m) return console.log("Geen manifest gevonden in de opslag.");
      console.log(`Cluster ${m.cluster}: ${m.state === "asleep" ? "😴 slaapt" : "🐌 wakker"} (bijgewerkt ${fmt(m.updated)}, uit ${m._store})`);
      console.log(`Leider ${m.leader}, term ${m.term}, seq ${m.lastSeq}`);
      for (const n of m.nodes) console.log(`  ${n.id.padEnd(10)} ${n.kind.padEnd(8)} ${n.provider}/${n.region ?? "-"} (${n.country ?? "?"}) ${n.ipv4 ?? ""} ${n.status}`);
      if (m.lastDrill) console.log(`Laatste brandoefening: ${fmt(m.lastDrill.ts)} — ${m.lastDrill.message}`);
      for (const s of c.stores.map(makeStore)) {
        const chain = await listChain(s).catch(() => null);
        console.log(`  opslag ${s.name} (${s.purpose}): ${chain ? `${chain.snapshots.length} snapshots, ${chain.segments.length} segmenten` : "onbereikbaar"}`);
      }
      break;
    }
    case "wake": {
      const c = load();
      const m = await readManifest(c);
      if (m && m.state !== "asleep") {
        // Nooit een tweede leider starten naast een levend cluster: eerst alle bekende nodes proberen.
        const alive = await probeCluster(c, m);
        if (alive.length) throw new Error(`Het cluster is wakker (${alive.join(", ")} bereikbaar). Wekken is niet nodig.`);
        if (!args.includes("--force")) throw new Error(`Manifest zegt 'wakker' maar geen enkele node reageert (laatst bijgewerkt ${fmt(m.updated)}). Weet je zeker dat alles weg is? Gebruik dan: eigen wake --force`);
        console.warn("⚠️  Geen node bereikbaar; geforceerd wekken.");
      }
      const first = m?.topology?.find((t: { kind: string }) => t.kind === "data");
      const pos = args.filter((a) => !a.startsWith("--"));
      const [provider = first?.provider, region = first?.region, size = first?.size] = pos;
      if (!provider || !region || !size) throw new Error("Geef aanbieder, regio en grootte op: eigen wake hetzner fsn1 cx23");
      const keys = keysFor(c);
      const nodeId = `n-${crypto.randomBytes(3).toString("hex")}`;
      const token = crypto.randomBytes(32).toString("hex");
      const store = c.stores.map(makeStore).find((s) => s.purpose === "replica")!;
      const key = `bootstrap/${nodeId}.enc`;
      const prov = makeProvider(provider, c.providers[provider]);
      console.log(`⏰ Wekken: ${nodeId} bij ${provider}/${region} (${size})…`);
      const info = await prov.create({ cluster: c.cluster, nodeId, kind: "data", region, size, userData: userData(c, { nodeId, kind: "data", bootstrapUrl: store.presignGet(key, 7200), joinToken: token, ...(await imageUrls(store)) }) });
      const nodeCfg: ClusterConfig = {
        ...c, nodeId, kind: "data", bootstrapLeader: true, bootstrapTerm: (m?.term ?? 0) + 1, joinToken: undefined, seeds: [],
        advertise: { clusterUrl: info.clusterUrl ?? `http://${info.ipv4}:${c.clusterPort}`, apiUrl: info.apiUrl ?? `https://${info.ipv4}`, ipv4: info.ipv4, ipv6: info.ipv6 },
        selfInfo: { provider, region, size, serverId: info.serverId, country: info.country ?? prov.country(region) },
      };
      await store.put(key, sealJson(deriveKey(Buffer.from(token, "hex"), "bootstrap"), nodeCfg, "bootstrap"));
      if (c.domain && prov.setPtr) await prov.setPtr(info, `mail.${c.domain}`).catch(() => {});
      console.log(`✅ Server ${info.serverId} (${info.ipv4}) start op, herstelt de data en vult het cluster daarna zelf aan volgens het beleid.`);
      void keys;
      break;
    }
    case "restore": {
      const c = load();
      const dest = args[0];
      if (!dest) throw new Error("Gebruik: eigen restore <bestand> [--until 2026-10-09T14:00] [--store naam]");
      const until = args.includes("--until") ? Date.parse(args[args.indexOf("--until") + 1]) : undefined;
      const storeName = args.includes("--store") ? args[args.indexOf("--store") + 1] : undefined;
      const keys = keysFor(c);
      const stores = c.stores.map(makeStore).filter((s) => !storeName || s.name === storeName);
      const r = storeName ? await restoreFromStore(stores[0], keys.db!, dest, { until }) : await restoreFromAny(stores, keys.db!, dest, { until });
      if (!r) throw new Error("Herstel mislukt: geen bruikbare snapshot");
      console.log(`✅ Hersteld naar ${dest}: seq ${r.seq} (snapshot ${r.snapshot} + ${r.applied} wijzigingen, tot ${r.lastTs ? fmt(r.lastTs) : "?"})`);
      break;
    }
    case "drill": {
      const c = load();
      const keys = keysFor(c);
      let ok = true;
      for (const s of c.stores.map(makeStore)) {
        const tmp = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "drill-"));
        try {
          const r = await restoreFromStore(s, keys.db!, path.join(tmp, "x.sqlite"));
          console.log(`  ${r ? "✓" : "✗"} ${s.name}: ${r ? `seq ${r.seq}, tot ${r.lastTs ? fmt(r.lastTs) : "?"}` : "geen snapshot"}`);
          ok &&= !!r;
        } catch (e) {
          ok = false;
          console.log(`  ✗ ${s.name}: ${(e as Error).message}`);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case "first-node": {
      // Maakt van een bestaande losse server (deze map) de eerste clusternode.
      const c = load();
      const ip = args[0];
      if (!ip) throw new Error("Gebruik: eigen first-node <publiek-ip> (draai in de map van de server, met DATA_DIR)");
      const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
      const nodeCfg: ClusterConfig = {
        ...c, nodeId: `n-${crypto.randomBytes(3).toString("hex")}`, kind: "data", bootstrapLeader: true, seeds: [],
        advertise: { clusterUrl: `http://${ip}:${c.clusterPort}`, apiUrl: `https://${ip}`, ipv4: ip }, selfInfo: { provider: "manual" },
      };
      writeClusterConfig(path.join(dataDir, "cluster.json"), nodeCfg);
      console.log(`✅ ${path.join(dataDir, "cluster.json")} geschreven. Herstart de app; hij wordt leider en vult het cluster aan.`);
      break;
    }
    case "job": {
      const url = process.env.EIGEN_URL, pw = process.env.EIGEN_PASSWORD;
      if (!url || !pw) throw new Error("Zet EIGEN_URL en EIGEN_PASSWORD");
      const login = await fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
      const { token } = (await login.json()) as { token: string };
      const r = await fetch(`${url}/api/cluster/jobs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ type: args[0], params: JSON.parse(args[1] ?? "{}") }) });
      console.log(await r.text());
      break;
    }
    case "upload-images": {
      const c = load();
      const [app, caddy] = args;
      for (const s of c.stores.map(makeStore).filter((x) => x.purpose === "replica")) {
        if (app) await s.put("images/eigen-cloud.tar.gz", fs.createReadStream(app), fs.statSync(app).size);
        if (caddy) await s.put("images/eigen-caddy.tar.gz", fs.createReadStream(caddy), fs.statSync(caddy).size);
        console.log(`✅ images in ${s.name}`);
      }
      break;
    }
    case "provider-test": {
      const c = load();
      const name = args[0];
      const servers = await makeProvider(name, c.providers[name]).list(c.cluster);
      console.log(`✅ ${name}: inloggen werkt, ${servers.length} server(s) van cluster ${c.cluster}`);
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?\n?/, "").replace(/^ \* ?/gm, ""));
  }
}

main().catch((e) => {
  console.error("❌ " + (e as Error).message);
  process.exit(1);
});
