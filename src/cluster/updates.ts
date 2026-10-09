/**
 * Servers bijwerken naar de nieuwste versie, één voor één ("rolling update"):
 *  - de leider kijkt elke 6 uur of er een nieuwe versie is (in de image-registry, of EIGEN_RELEASE_URL);
 *  - volgens je instelling (automatisch 's nachts, alleen melden, of uit) start hij een update-job;
 *  - eerst de witness, dan de andere dataservers, de leider zelf als laatste (na het overdragen van de leiding);
 *  - per server: bijwerken op de plek zelf (zelfde IP-adres, geen gegevens kopiëren) als de server dat kan,
 *    anders vervangen door een nieuwe server met de nieuwe versie;
 *  - komt een server niet gezond terug, dan zet die zelf de vorige versie terug en stopt de update.
 */
import fs from "node:fs";
import path from "node:path";
import { request } from "undici";
import { config } from "../config.js";
import { VERSION, compareVersions } from "../version.js";
import { rpc } from "./transport.js";
import type { ClusterService, NodeRow } from "./service.js";

export interface Release { version: string; image: string; caddyImage?: string | null; checked?: number }
export interface NodeInfo { version: string; updater: boolean; result: UpdateResult | null }
export interface UpdateResult { id: string; version: string; ok: boolean; rolledBack: boolean; saved?: boolean; error: string | null; at: number }
export type UpdateMode = "auto" | "melden" | "uit";

// ───────── Op elke node ─────────

const file = (name: string) => path.join(config.dataDir, name);

export function localNodeInfo(): NodeInfo {
  let result: UpdateResult | null = null;
  try { result = JSON.parse(fs.readFileSync(file("update-result.json"), "utf8")); } catch { /* nog geen update gehad */ }
  return { version: VERSION(), updater: fs.existsSync(file("updater.json")), result };
}

/** Verzoek voor de updater op deze server (zie updaterScript in cloudinit.ts). */
export function writeUpdateRequest(req: { id: string; app: string; caddy?: string | null; version: string; saveApp?: string | null; saveCaddy?: string | null }) {
  if (!fs.existsSync(file("updater.json"))) throw new Error("deze server kan zichzelf niet bijwerken");
  const tmp = file("update-request.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(req), { mode: 0o600 });
  fs.renameSync(tmp, file("update-request.json"));
}

// ───────── Nieuwste versie opzoeken ─────────

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** "ghcr.io/renevanes/eigen-cloud:latest" → registry, repository, tag. */
export function parseRef(ref: string) {
  const m = /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/([a-z0-9._/-]+?)(?::([A-Za-z0-9._-]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(ref);
  if (!m) return null;
  return { registry: m[1], repo: m[2], tag: m[3] ?? "latest", digest: m[4] ?? null };
}

async function registryGet(url: string, accept: string, token: { v?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  for (let i = 0; i < 2; i++) {
    let r = await request(url, { headers: { accept, ...(token.v ? { authorization: `Bearer ${token.v}` } : {}) }, headersTimeout: 15_000, bodyTimeout: 15_000 });
    // Blobs staan vaak elders (omleiding); daar geen token meesturen.
    for (let hop = 0; hop < 3 && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location; hop++) {
      await r.body.dump();
      r = await request(new URL(String(r.headers.location), url).toString(), { headers: { accept }, headersTimeout: 15_000, bodyTimeout: 15_000 });
    }
    const body = await r.body.text();
    if (r.statusCode === 401 && !token.v) {
      // Anoniem token halen volgens WWW-Authenticate (werkt voor openbare pakketten op ghcr.io, Docker Hub, …).
      const h = String(r.headers["www-authenticate"] ?? "");
      const realm = /realm="([^"]+)"/.exec(h)?.[1], service = /service="([^"]+)"/.exec(h)?.[1], scope = /scope="([^"]+)"/.exec(h)?.[1];
      if (!realm) return { status: 401, headers: r.headers, body };
      const t = await request(`${realm}?${new URLSearchParams({ ...(service ? { service } : {}), ...(scope ? { scope } : {}) })}`, { headersTimeout: 15_000 });
      const tj = (await t.body.json().catch(() => ({}))) as { token?: string; access_token?: string };
      token.v = tj.token ?? tj.access_token;
      if (!token.v) return { status: 401, headers: r.headers, body };
      continue;
    }
    return { status: r.statusCode, headers: r.headers, body };
  }
  throw new Error("registry weigert toegang");
}

/** Vaste verwijzing (repo@sha256:…) en versie (label org.opencontainers.image.version) van een tag. */
export async function resolveImage(ref: string): Promise<{ pinned: string; version: string | null }> {
  const p = parseRef(ref);
  if (!p) throw new Error(`onbekende image-verwijzing ${ref}`);
  const token: { v?: string } = {};
  const base = `https://${p.registry}/v2/${p.repo}`;
  const top = await registryGet(`${base}/manifests/${p.digest ?? p.tag}`, ACCEPT, token);
  if (top.status === 401) throw new Error(`${p.registry} geeft geen toegang tot ${p.repo}. Staat het pakket op openbaar?`);
  if (top.status !== 200) throw new Error(`${p.registry} antwoordt ${top.status} voor ${p.repo}:${p.tag}`);
  const digest = String(top.headers["docker-content-digest"] ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("registry gaf geen digest terug");
  let manifest = JSON.parse(top.body) as { manifests?: { digest: string; platform?: { os: string; architecture: string } }[]; config?: { digest: string } };
  if (manifest.manifests) {
    const pick = manifest.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") ?? manifest.manifests.find((m) => m.platform?.os !== "unknown");
    if (!pick) throw new Error("geen bruikbaar platform in het image");
    const sub = await registryGet(`${base}/manifests/${pick.digest}`, ACCEPT, token);
    manifest = JSON.parse(sub.body);
  }
  let version: string | null = null;
  if (manifest.config?.digest) {
    const cfg = await registryGet(`${base}/blobs/${manifest.config.digest}`, "application/json", token);
    try { version = (JSON.parse(cfg.body) as { config?: { Labels?: Record<string, string> } }).config?.Labels?.["org.opencontainers.image.version"] ?? null; } catch { /* geen labels */ }
  }
  return { pinned: `${p.registry}/${p.repo}@${digest}`, version };
}

/** Nieuwste uitgave: uit EIGEN_RELEASE_URL (JSON, ook file://) of uit de registry van het geconfigureerde image. */
export async function latestRelease(svc: ClusterService): Promise<Release> {
  const src = process.env.EIGEN_RELEASE_URL;
  if (src) {
    const text = src.startsWith("file://") ? fs.readFileSync(src.slice(7), "utf8") : await (await request(src, { headersTimeout: 15_000 })).body.text();
    const j = JSON.parse(text) as Release;
    if (!j.version || !j.image) throw new Error("onvolledige release-informatie");
    return j;
  }
  const appRef = svc.cfg.image.ref;
  if (!appRef) throw new Error("geen image ingesteld");
  const app = await resolveImage(appRef.replace(/@sha256:[0-9a-f]{64}$/, ":latest"));
  if (!app.version) throw new Error("het image heeft geen versielabel");
  const caddyRef = (svc.cfg.image as { caddyRef?: string }).caddyRef;
  const caddy = caddyRef ? await resolveImage(caddyRef.replace(/@sha256:[0-9a-f]{64}$/, ":latest")) : null;
  return { version: app.version, image: app.pinned, caddyImage: caddy?.pinned ?? null };
}

// ───────── Instellingen en toestand (in de gerepliceerde settings-tabel) ─────────

const j = <T>(s: string | undefined): T | null => { try { return s ? (JSON.parse(s) as T) : null; } catch { return null; } };

export function updateMode(svc: ClusterService): UpdateMode {
  const m = svc.getSetting("update_mode");
  return m === "melden" || m === "uit" ? m : "auto";
}
/** Venster voor automatische updates, uren in Nederlandse tijd: "3-5" = tussen 03:00 en 05:00. */
export function updateWindow(svc: ClusterService): [number, number] {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(svc.getSetting("update_window") ?? "3-5");
  return m ? [Number(m[1]), Number(m[2])] : [3, 5];
}
export function inWindow(win: [number, number], now = new Date()) {
  const h = Number(new Intl.DateTimeFormat("nl-NL", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Amsterdam" }).format(now));
  return win[0] <= win[1] ? h >= win[0] && h < win[1] : h >= win[0] || h < win[1];
}

export const nodeInfos = (svc: ClusterService) => j<Record<string, NodeInfo & { at: number }>>(svc.getSetting("node_info")) ?? {};
export const latestKnown = (svc: ClusterService) => j<Release>(svc.getSetting("release_latest"));
export const updateTarget = (svc: ClusterService) => j<Release>(svc.getSetting("update_target"));
export const imageTar = (svc: ClusterService) => j<{ version: string }>(svc.getSetting("image_tar"));

function setSetting(svc: ClusterService, key: string, value: unknown) {
  svc.db!.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value == null ? "" : typeof value === "string" ? value : JSON.stringify(value));
}

/** Versie per server ophalen (leider). Schrijft alleen bij een verandering, om de replicatie rustig te houden. */
export async function pollNodeInfo(svc: ClusterService) {
  const cur = nodeInfos(svc);
  const next: Record<string, NodeInfo & { at: number }> = {};
  for (const n of svc.nodes("status IN ('syncing','ready')")) {
    const info = n.id === svc.self.id ? localNodeInfo() : await fetchNodeInfo(svc, n).catch(() => null);
    next[n.id] = info ? { ...info, at: Date.now() } : cur[n.id] ?? { version: "?", updater: false, result: null, at: 0 };
  }
  const strip = (o: Record<string, { version: string; updater: boolean; result: unknown }>) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [v.version, v.updater, v.result]])));
  if (strip(next) !== strip(cur)) setSetting(svc, "node_info", next);
  return next;
}

export async function fetchNodeInfo(svc: ClusterService, n: NodeRow): Promise<NodeInfo> {
  if (!n.cluster_url) throw new Error("geen adres");
  return rpc<NodeInfo>(svc.keys.cluster, n.cluster_url, { type: "nodeInfo" }, 3000);
}

/** Elke 6 uur (leider): nieuwste versie opzoeken en zo nodig een update starten of melden. */
export async function checkForUpdates(svc: ClusterService, opts: { force?: boolean } = {}) {
  const mode = updateMode(svc);
  if (mode === "uit" && !opts.force) return null;
  let rel: Release;
  try {
    rel = { ...(await latestRelease(svc)), checked: Date.now() };
    setSetting(svc, "release_latest", rel);
    setSetting(svc, "release_error", "");
  } catch (e) {
    setSetting(svc, "release_error", (e as Error).message);
    return null;
  }
  await maybeStartUpdate(svc);
  return rel;
}

/** Is er een nieuwere versie dan wat er draait? */
export function updateAvailable(svc: ClusterService): Release | null {
  const rel = latestKnown(svc);
  if (!rel) return null;
  const infos = nodeInfos(svc);
  const versions = svc.nodes("status = 'ready'").map((n) => (n.id === svc.self.id ? VERSION() : infos[n.id]?.version ?? "?"));
  // Bijwerken als een server een oudere versie draait (ontwikkelversies "…-dev" en onbekende laten we met rust).
  return versions.some((v) => compareVersions(v, rel.version) === -1) ? rel : null;
}

export function openUpdateJob(svc: ClusterService) {
  return svc.db!.prepare("SELECT id, state FROM cluster_jobs WHERE type = 'update' AND status IN ('pending','running')").get() as { id: string; state: string } | undefined;
}

export async function maybeStartUpdate(svc: ClusterService) {
  const rel = updateAvailable(svc);
  if (!rel || openUpdateJob(svc) || svc.getSetting("cluster_mode") === "sleeping") return;
  const mode = updateMode(svc);
  const failed = j<{ version: string }>(svc.getSetting("update_failed"));
  if (mode === "auto" && failed?.version !== rel.version && inWindow(updateWindow(svc))) {
    const { createJob } = await import("./jobs.js");
    createJob(svc, "update", { version: rel.version, image: rel.image, caddyImage: rel.caddyImage ?? null, auto: true });
  } else if (svc.getSetting("update_announced") !== rel.version) {
    setSetting(svc, "update_announced", rel.version);
    svc.event("update", mode === "auto"
      ? `Versie ${rel.version} is beschikbaar; je servers worden tussen ${updateWindow(svc).join(":00 en ")}:00 bijgewerkt`
      : `Versie ${rel.version} is beschikbaar. Bijwerken kan onder "Waar draai ik"`);
  }
}

// ───────── De update-job ─────────

type S = Record<string, any>;

/** Volgorde: witnesses, dan de andere dataservers, de leider als laatste. */
function plan(svc: ClusterService) {
  const ready = svc.nodes("status = 'ready'");
  return [
    ...ready.filter((n) => n.kind === "witness"),
    ...ready.filter((n) => n.kind === "data" && n.id !== svc.self.id),
    ...ready.filter((n) => n.id === svc.self.id),
  ].map((n) => n.id);
}

function versionOf(svc: ClusterService, n: NodeRow) {
  return n.id === svc.self.id ? VERSION() : nodeInfos(svc)[n.id]?.version;
}

export async function updateStep(svc: ClusterService, p: S, s: S): Promise<{ state?: S; done?: boolean; fail?: string } | void> {
  const db = svc.db!;
  const node = (id: string) => db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  const timeout = Number(process.env.EIGEN_UPDATE_TIMEOUT_MS ?? 20 * 60_000);

  if (!s.step) {
    if (svc.getSetting("cluster_mode") === "sleeping") return { fail: "je cloud slaapt" };
    const pol = svc.policy();
    const ready = svc.nodes("status = 'ready'");
    const unreachable = ready.filter((n) => n.id !== svc.self.id && Date.now() - (svc.raft.peers.get(n.id)?.lastContact ?? 0) > 30_000);
    if (ready.filter((n) => n.kind === "data").length < Math.min(2, pol.minDataNodes) || unreachable.length) {
      return { fail: "niet alle servers zijn gezond; de update is uitgesteld" };
    }
    setSetting(svc, "update_target", { version: p.version, image: p.image, caddyImage: p.caddyImage ?? null });
    setSetting(svc, "update_failed", "");
    svc.event("update", `Je servers worden bijgewerkt naar versie ${p.version}, één voor één`);
    return { state: { step: "next", queue: plan(svc), done: [] } };
  }

  if (s.step === "next") {
    const queue: string[] = [...s.queue];
    while (queue.length) {
      const n = node(queue[0]);
      if (!n || n.status !== "ready") { queue.shift(); continue; }
      if (versionOf(svc, n) === p.version) { queue.shift(); continue; }
      break;
    }
    if (!queue.length) {
      setSetting(svc, "update_announced", "");
      svc.event("update", `Alle servers draaien nu versie ${p.version}`);
      return { done: true, state: { ...s, queue, current: null } };
    }
    const n = node(queue[0])!;
    if (n.id === svc.self.id) {
      // De leider zelf: eerst de leiding overdragen aan een dataserver die al bijgewerkt is.
      const infos = nodeInfos(svc);
      const target = svc.nodes("status = 'ready' AND kind = 'data'").filter((x) => x.id !== svc.self.id)
        .sort((a, b) => Number(infos[b.id]?.version === p.version) - Number(infos[a.id]?.version === p.version))[0];
      if (!target) return { fail: "geen andere dataserver om de leiding aan over te dragen" };
      svc.event("update", `Leiding naar ${target.id}, zodat ook deze server bijgewerkt kan worden`);
      await svc.raft.transferTo(target.id);
      return { state: { ...s, queue } }; // de nieuwe leider gaat verder met deze job
    }
    let info: NodeInfo | null = null;
    try { info = await fetchNodeInfo(svc, n); } catch { /* onbereikbaar: vervangen */ }
    if (info?.updater) {
      const reqId = `${p.version}-${n.id}-${Date.now().toString(36)}`;
      // Eén dataserver bewaart de nieuwe images ook in je eigen opslag, zodat je niet van de registry afhangt.
      const store = svc.stores.find((x) => x.purpose === "replica") ?? svc.stores[0];
      const save = n.kind === "data" && !s.saved && store?.presignPut && store.config.type !== "fs";
      if (save) setSetting(svc, "image_tar", "");
      await rpc(svc.keys.cluster, n.cluster_url!, {
        type: "applyUpdate", id: reqId, app: p.image, caddy: p.caddyImage ?? null, version: p.version,
        saveApp: save ? store!.presignPut!("images/eigen-cloud.tar.gz", 3600) : null,
        saveCaddy: save ? store!.presignPut!("images/eigen-caddy.tar.gz", 3600) : null,
      }, 5000);
      svc.event("update", `${n.id} wordt bijgewerkt (op de plek zelf)`);
      return { state: { ...s, queue, step: "waiting", current: n.id, reqId, saving: !!save, started: Date.now() } };
    }
    // Oudere server zonder updater (of onbereikbaar): vervangen door een nieuwe met de nieuwe versie.
    const { createJob } = await import("./jobs.js");
    const move = createJob(svc, "move", { nodeId: n.id, kind: n.kind, to: { provider: n.provider, region: n.region, size: n.size, country: n.country ?? undefined, kind: n.kind } });
    svc.event("update", `${n.id} wordt vervangen door een server met versie ${p.version}`);
    return { state: { ...s, queue, step: "moving", current: n.id, move } };
  }

  if (s.step === "waiting") {
    const n = node(s.current);
    if (!n || n.status === "removed") return { state: { ...s, step: "next", queue: s.queue.slice(1) } };
    const info = await fetchNodeInfo(svc, n).catch(() => null);
    const res = info?.result ?? null;
    if (info && res && res.id === s.reqId && !res.ok) {
      setSetting(svc, "update_failed", { version: p.version, node: n.id, error: res.error, at: Date.now() });
      svc.event("update", `Bijwerken van ${n.id} naar ${p.version} mislukt: ${res.error}. De andere servers blijven op de huidige versie.`, "error");
      return { fail: `${n.id}: ${res.error}` };
    }
    if (info && info.version === p.version && (!s.saving || res?.id === s.reqId)) {
      if (s.saving && res?.saved) setSetting(svc, "image_tar", { version: p.version });
      const infos = nodeInfos(svc);
      infos[n.id] = { ...info, at: Date.now() };
      setSetting(svc, "node_info", infos);
      svc.event("update", `${n.id} draait nu versie ${p.version}`);
      return { state: { ...s, step: "next", queue: s.queue.slice(1), saved: s.saved || (s.saving && !!res?.saved), current: null } };
    }
    if (Date.now() - s.started > timeout) {
      setSetting(svc, "update_failed", { version: p.version, node: n.id, error: "duurde te lang", at: Date.now() });
      return { fail: `${n.id} kwam niet binnen ${Math.round(timeout / 60_000)} minuten terug met versie ${p.version}` };
    }
    return;
  }

  if (s.step === "moving") {
    const child = db.prepare("SELECT status FROM cluster_jobs WHERE id = ?").get(s.move) as { status: string } | undefined;
    if (child?.status === "failed") {
      setSetting(svc, "update_failed", { version: p.version, node: s.current, error: "vervangen mislukt", at: Date.now() });
      return { fail: `vervangen van ${s.current} mislukt` };
    }
    if (child?.status === "done") return { state: { ...s, step: "next", queue: s.queue.slice(1), current: null } };
  }
}

/** Overzicht voor de schermen. */
export function updateSummary(svc: ClusterService) {
  const infos = nodeInfos(svc);
  const job = openUpdateJob(svc);
  return {
    current: VERSION(),
    latest: latestKnown(svc),
    available: updateAvailable(svc)?.version ?? null,
    mode: updateMode(svc),
    window: updateWindow(svc),
    checkError: svc.getSetting("release_error") || null,
    failed: j<{ version: string; node: string; error: string; at: number }>(svc.getSetting("update_failed")),
    running: job ? { id: job.id, current: j<S>(job.state)?.current ?? null } : null,
    nodes: Object.fromEntries(svc.nodes("status IN ('syncing','ready')").map((n) => [n.id, { version: n.id === svc.self.id ? VERSION() : infos[n.id]?.version ?? null, updater: n.id === svc.self.id ? localNodeInfo().updater : infos[n.id]?.updater ?? null }])),
  };
}
