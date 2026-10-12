/**
 * Het adapter-raamwerk: registry, Exoscale en OVHcloud tegen nagebootste API's (die de handtekening van elk verzoek
 * zelf narekenen volgens de documentatie van de aanbieder), en een voorbeeld van hoe je een eigen aanbieder toevoegt.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "adapters-"));
process.env.EIGEN_VAULT = path.join(base, "kluis.json");
delete process.env.EIGEN_CONSOLE_LOCAL;

const { adapters, getAdapter, registerAdapter } = await import("../src/cluster/adapters.js");
const { makeProvider } = await import("../src/cluster/providers.js");
const { makeDns } = await import("../src/cluster/dns.js");
const { exoTiming, EXO_ZONES } = await import("../src/cluster/adapters/exoscale.js");
const { ovhTiming, OVH_ACCESS_RULES } = await import("../src/cluster/adapters/ovh.js");
const catalog = await import("../src/console/catalog.js");
const { caddyfile } = await import("../src/cluster/cloudinit.js");
const { catalogJson } = await import("../scripts/export-catalog.js");
import type { ProviderAdapter, Provider, CreateSpec } from "../src/cluster/adapters/types.js";
import type { ClusterConfig } from "../src/cluster/config.js";

exoTiming.pollMs = 0;
ovhTiming.pollMs = 0;

// ───────── Nep-HTTP ─────────

type Req = { method: string; url: URL; headers: Headers; body: string };
type Res = { status?: number; json?: unknown };
const realFetch = globalThis.fetch;
let log: Req[] = [];
function fake(handler: (r: Req) => Res) {
  log = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const r: Req = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers as HeadersInit), body: typeof init.body === "string" ? init.body : "" };
    log.push(r);
    const out = handler(r);
    const st = out.status ?? 200;
    return new Response(st === 204 ? null : JSON.stringify(out.json ?? {}), { status: st, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });
const json = (r: Req) => (r.body ? JSON.parse(r.body) : undefined);

// ───────── Exoscale: handtekening volgens https://openapi-v2.exoscale.com/topic/topic-api-request-signature ─────────

const EXO_KEY = "EXO29147e9f89102b7ac1e88514", EXO_SECRET = "geheim-exo";

/** Onafhankelijk nagerekend uit de documentatie: bericht van 5 regels, HMAC-SHA256 met het geheim, base64. */
function exoCheck(r: Req): string | null {
  const m = /^EXO2-HMAC-SHA256 credential=([^,]+)(?:,signed-query-args=([^,]*))?,expires=(\d+),signature=(\S+)$/.exec(r.headers.get("authorization") ?? "");
  if (!m) return "geen EXO2-header";
  const [, cred, args, expires, sig] = m;
  if (cred !== EXO_KEY) return "verkeerde sleutel";
  if (Number(expires) < Date.now() / 1000) return "verlopen";
  const names = args ? args.split(";") : [];
  if ([...names].sort().join(";") !== [...r.url.searchParams.keys()].sort().join(";")) return "signed-query-args klopt niet";
  const msg = `${r.method} ${r.url.pathname}\n${r.body}\n${names.map((n) => r.url.searchParams.get(n)).join("")}\n\n${expires}`;
  const want = crypto.createHmac("sha256", EXO_SECRET).update(msg).digest("base64");
  return sig === want ? null : "handtekening klopt niet";
}

function exoFake() {
  const st = {
    sgs: [] as { id: string; name: string; rules: unknown[] }[],
    instances: new Map<string, { id: string; zone: string; labels: Record<string, string>; body: any }>(),
    ops: new Map<string, string>(),
    domains: [{ id: "dom-1", "unicode-name": "vanes.nl" }] as { id: string; "unicode-name": string }[],
    records: [
      { id: "r-ns", name: "", type: "NS", content: "ns1.exoscale.ch", ttl: 3600, "system-record": true },
      { id: "r-1", name: "cloud", type: "A", content: "1.1.1.1", ttl: 300 },
      { id: "r-2", name: "cloud", type: "A", content: "2.2.2.2", ttl: 300 },
    ] as any[],
    n: 0,
  };
  const op = (ref: string) => { const id = `op-${++st.n}`; st.ops.set(id, ref); return { id, state: "pending", reference: { id: ref } }; };
  fake((r) => {
    const host = /^api-([a-z0-9-]+)\.exoscale\.com$/.exec(r.url.hostname);
    if (!host || !EXO_ZONES.includes(host[1])) return { status: 404, json: { message: "onbekende zone" } };
    const why = exoCheck(r);
    if (why) return { status: 403, json: { message: why } };
    const zone = host[1], p = r.url.pathname.replace(/^\/v2/, ""), k = `${r.method} ${p}`;
    let mm: RegExpExecArray | null;
    if (k === "GET /template") {
      assert.equal(r.url.searchParams.get("visibility"), "public");
      return { json: { templates: [
        { id: "tpl-oud", name: "Linux Ubuntu 24.04 LTS 64-bit", "created-at": "2024-05-01T00:00:00Z", zones: EXO_ZONES },
        { id: "tpl-nieuw", name: "Linux Ubuntu 24.04 LTS 64-bit", "created-at": "2025-06-01T00:00:00Z", zones: EXO_ZONES },
        { id: "tpl-22", name: "Linux Ubuntu 22.04 LTS 64-bit", "created-at": "2026-01-01T00:00:00Z" },
      ] } };
    }
    if (k === "GET /instance-type") return { json: { "instance-types": [
      { id: "it-micro", family: "standard", size: "micro", cpus: 1, memory: 512 * 1024 ** 2, authorized: true, zones: EXO_ZONES },
      { id: "it-small", family: "standard", size: "small", cpus: 2, memory: 2 * 1024 ** 3, authorized: true, zones: EXO_ZONES },
      { id: "it-medium", family: "standard", size: "medium", cpus: 2, memory: 4 * 1024 ** 3, authorized: true, zones: EXO_ZONES },
      { id: "it-large", family: "standard", size: "large", cpus: 4, memory: 8 * 1024 ** 3, authorized: false, zones: EXO_ZONES },
      { id: "it-gpu", family: "gpu", size: "small", cpus: 12, memory: 56 * 1024 ** 3, authorized: true, zones: ["ch-gva-2"] },
      { id: "it-ch", family: "standard", size: "huge", cpus: 8, memory: 32 * 1024 ** 3, authorized: true, zones: ["ch-gva-2"] },
    ] } };
    if (k === "GET /security-group") return { json: { "security-groups": st.sgs.map(({ id, name }) => ({ id, name })) } };
    if (k === "POST /security-group") { const g = { id: `sg-${++st.n}`, name: json(r).name, rules: [] }; st.sgs.push(g); return { json: op(g.id) }; }
    if ((mm = /^POST \/security-group\/([^/]+)\/rules$/.exec(k))) { st.sgs.find((g) => g.id === mm![1])!.rules.push(json(r)); return { json: op(mm[1]) }; }
    if ((mm = /^GET \/operation\/(.+)$/.exec(k))) return { json: { id: mm[1], state: "success", reference: { id: st.ops.get(mm[1]) } } };
    if (k === "POST /instance") {
      const b = json(r);
      const i = { id: `inst-${++st.n}`, zone, labels: b.labels, body: b };
      st.instances.set(i.id, i);
      return { json: op(i.id) };
    }
    if (k === "GET /instance") return { json: { instances: [...st.instances.values()].filter((i) => i.zone === zone).map((i) => ({ id: i.id, name: i.body.name, labels: i.labels })) } };
    if ((mm = /^GET \/instance\/(.+)$/.exec(k))) return { json: { id: mm[1], "public-ip": "194.182.0.7", "ipv6-address": "2a04:c43::7" } };
    if ((mm = /^DELETE \/instance\/(.+)$/.exec(k))) return st.instances.delete(mm[1]) ? { json: op(mm[1]) } : { status: 404, json: {} };
    if ((mm = /^POST \/reverse-dns\/instance\/(.+)$/.exec(k))) return { json: op(mm[1]) };
    // DNS
    if (k === "GET /dns-domain") return { json: { "dns-domains": st.domains } };
    if (k === "POST /dns-domain") { const d = { id: `dom-${++st.n}`, "unicode-name": json(r)["unicode-name"] }; st.domains.push(d); return { json: op(d.id) }; }
    if ((mm = /^GET \/dns-domain\/([^/]+)\/record$/.exec(k))) return { json: { "dns-domain-records": st.records } };
    if ((mm = /^POST \/dns-domain\/([^/]+)\/record$/.exec(k))) { const rec = { id: `r-${++st.n}`, ...json(r) }; st.records.push(rec); return { json: op(rec.id) }; }
    if ((mm = /^PUT \/dns-domain\/([^/]+)\/record\/(.+)$/.exec(k))) { Object.assign(st.records.find((x) => x.id === mm![2]), json(r)); return { json: op(mm[2]) }; }
    if ((mm = /^DELETE \/dns-domain\/([^/]+)\/record\/(.+)$/.exec(k))) { st.records = st.records.filter((x) => x.id !== mm![2]); return { json: op(mm[2]) }; }
    return { status: 500, json: { message: `niet nagebootst: ${k}` } };
  });
  return st;
}

test("Exoscale: ondertekende verzoeken, server maken met user-data, opsommen, PTR, verwijderen", async () => {
  const st = exoFake();
  const p = makeProvider("exoscale", { apiKey: EXO_KEY, apiSecret: EXO_SECRET });
  const info = await p.create({ cluster: "eigen", nodeId: "n-1a2b3c", kind: "data", region: "de-fra-1", size: "standard.small", userData: "#!/bin/bash\necho hoi" });
  const id = [...st.instances.keys()][0];
  assert.deepEqual(info, { serverId: `de-fra-1/${id}`, ipv4: "194.182.0.7", ipv6: "2a04:c43::7", country: "DE" });
  assert.ok(log.every((r) => r.url.hostname === "api-de-fra-1.exoscale.com"), "alles in de zone van de server");
  assert.ok(log.some((r) => r.url.search === "?visibility=public" && /signed-query-args=visibility,/.test(r.headers.get("authorization")!)), "query-parameters worden meeondertekend");
  const inst = [...st.instances.values()][0].body;
  assert.equal(Buffer.from(inst["user-data"], "base64").toString(), "#!/bin/bash\necho hoi");
  assert.deepEqual(inst["instance-type"], { id: "it-small" });
  assert.deepEqual(inst.template, { id: "tpl-nieuw" }, "nieuwste Ubuntu 24.04");
  assert.deepEqual(inst.labels, { cluster: "eigen", node: "n-1a2b3c", kind: "data" });
  assert.equal(inst["ipv6-enabled"], true);
  assert.equal(st.sgs.length, 1, "security group eenmalig aangemaakt");
  assert.equal(st.sgs[0].rules.length, 4);
  assert.deepEqual(inst["security-groups"], [{ id: st.sgs[0].id }]);

  // Tweede server: security group wordt hergebruikt.
  const p2 = makeProvider("exoscale", { apiKey: EXO_KEY, apiSecret: EXO_SECRET });
  await p2.create({ cluster: "ander", nodeId: "n-9", kind: "witness", region: "de-fra-1", size: "standard.micro", userData: "x" });
  assert.equal(st.sgs.length, 1);

  assert.deepEqual(await p.list("eigen"), [{ serverId: `de-fra-1/${id}`, nodeId: "n-1a2b3c" }]);
  await p.setPtr!(info, "mail.vanes.nl");
  assert.deepEqual(json(log.at(-1)!), { "domain-name": "mail.vanes.nl" });
  await p.destroy(info.serverId);
  await p.destroy(info.serverId); // al weg: geen fout
  assert.deepEqual(await p.list("eigen"), []);
  await assert.rejects(p.create({ cluster: "eigen", nodeId: "n-2", kind: "data", region: "de-fra-1", size: "standard.reuze", userData: "x" }), /bestaat niet/);

  // Verkeerd geheim: de nep-API weigert (403) en inloggen controleren faalt.
  await assert.rejects(makeProvider("exoscale", { apiKey: EXO_KEY, apiSecret: "fout" }).list("eigen"), /403/);
});

test("Exoscale: formaten (standard, toegestaan, in de zone) zonder prijs", async () => {
  exoFake();
  const sizes = await catalog.fetchSizes("exoscale", { apiKey: EXO_KEY, apiSecret: EXO_SECRET }, "at-vie-1");
  assert.deepEqual(sizes.map((s) => [s.size, s.ramGb, s.cpus, s.monthly]), [["standard.micro", 0.5, 1, null], ["standard.small", 2, 2, null], ["standard.medium", 4, 2, null]]);
  assert.equal(catalog.pickSize(sizes, "data")!.size, "standard.small");
  assert.equal(catalog.pickSize(sizes, "witness")!.size, "standard.micro");
});

test("Exoscale DNS: zone klaarzetten, records bijwerken op hun plek (upsert), MX/TXT-notatie, weghalen", async () => {
  const st = exoFake();
  const a = getAdapter("exoscale")!;
  const f = { apiKey: EXO_KEY, apiSecret: EXO_SECRET };
  assert.deepEqual((await a.dns!.connect(f, "vanes.nl")).nameservers.length, 4);
  assert.ok(!log.some((r) => r.method === "POST"), "bestaande zone niet opnieuw aangemaakt");
  await a.dns!.connect(f, "nieuw.nl");
  assert.ok(st.domains.some((d) => d["unicode-name"] === "nieuw.nl"), "zone aangemaakt");

  const dns = makeDns({ type: "exoscale", name: "exo", zone: "vanes.nl", fields: f });
  log = [];
  await dns.setRecords("cloud", "A", ["2.2.2.2", "3.3.3.3"], 300);
  const calls = log.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url.pathname.split("/").slice(-1)[0]}`);
  assert.deepEqual(calls, ["PUT r-1"], "2.2.2.2 blijft staan, 1.1.1.1 wordt 3.3.3.3");
  assert.deepEqual(st.records.filter((r) => r.name === "cloud").map((r) => r.content).sort(), ["2.2.2.2", "3.3.3.3"]);

  await dns.setRecords("", "MX", ["10 mail.vanes.nl."], 3600);
  await dns.setRecords("", "TXT", ['"v=spf1 a:mail.vanes.nl -all"'], 3600);
  await dns.setRecords("eigen._domainkey", "TXT", ['"v=DKIM1; k=rsa; p=AAA" "BBB"'], 3600);
  assert.deepEqual(st.records.find((r) => r.type === "MX"), { id: st.records.find((r) => r.type === "MX").id, name: "", type: "MX", content: "mail.vanes.nl", ttl: 3600, priority: 10 });
  assert.equal(st.records.find((r) => r.type === "TXT" && r.name === "").content, "v=spf1 a:mail.vanes.nl -all");
  assert.equal(st.records.find((r) => r.name === "eigen._domainkey").content, "v=DKIM1; k=rsa; p=AAABBB");

  log = [];
  await dns.setRecords("", "MX", ["10 mail.vanes.nl."], 3600);
  assert.ok(!log.some((r) => r.method !== "GET"), "niets veranderd: niets geschreven");
  await dns.setRecords("cloud", "A", [], 300);
  assert.ok(!st.records.some((r) => r.name === "cloud"));
  assert.ok(st.records.some((r) => r.type === "NS"), "systeemrecords blijven staan");
});

// ───────── OVHcloud: "$1$" + sha1(AS+CK+METHOD+URL+BODY+TS) ─────────

const OVH = { appKey: "ak-123", appSecret: "as-geheim", consumerKey: "ck-456", projectId: "proj-789" };
const OVH_SKEW = 137; // de klok van OVH loopt voor: de adapter moet /auth/time gebruiken

function ovhCheck(r: Req): string | null {
  if (r.headers.get("x-ovh-application") !== OVH.appKey) return "verkeerde application key";
  if (r.headers.get("x-ovh-consumer") !== OVH.consumerKey) return "verkeerde consumer key";
  const ts = Number(r.headers.get("x-ovh-timestamp"));
  if (Math.abs(ts - (Math.floor(Date.now() / 1000) + OVH_SKEW)) > 5) return "tijd klopt niet";
  const want = "$1$" + crypto.createHash("sha1").update(`${OVH.appSecret}+${OVH.consumerKey}+${r.method}+${r.url.href}+${r.body}+${ts}`).digest("hex");
  return r.headers.get("x-ovh-signature") === want ? null : "handtekening klopt niet";
}

function ovhFake() {
  const st = {
    instances: new Map<string, any>(),
    records: [
      { id: 1, subDomain: "cloud", fieldType: "A", target: "9.9.9.9", ttl: 300 },
      { id: 2, subDomain: "", fieldType: "TXT", target: '"oud"', ttl: 3600 },
      { id: 3, subDomain: "www", fieldType: "TXT", target: '"blijft"', ttl: 3600 },
    ] as any[],
    refreshes: 0, n: 100, polls: 0,
  };
  fake((r) => {
    if (r.url.origin !== "https://eu.api.ovh.com" || !r.url.pathname.startsWith("/1.0/")) return { status: 404 };
    const p = r.url.pathname.slice(4), k = `${r.method} ${p}`;
    if (k === "GET /auth/time") return { json: Math.floor(Date.now() / 1000) + OVH_SKEW };
    if (k === "GET /order/catalog/public/cloud") return { json: { addons: [{ planCode: "d2-2.consumption", pricings: [{ price: 1000000 }] }, { planCode: "b3-8.consumption", pricings: [{ price: 4000000 }] }] } };
    const why = ovhCheck(r);
    if (why) return { status: 403, json: { message: why } };
    let mm: RegExpExecArray | null;
    const pr = "/cloud/project/proj-789";
    if (k === `GET ${pr}/image`) {
      assert.match(r.url.searchParams.get("region") ?? "", /^(GRA11|DE1)$/);
      assert.equal(r.url.searchParams.get("osType"), "linux");
      return { json: [{ id: "img-22", name: "Ubuntu 22.04" }, { id: "img-24", name: "Ubuntu 24.04" }, { id: "img-24w", name: "Ubuntu 24.04 - Docker" }] };
    }
    if (k === `GET ${pr}/flavor`) return { json: [
      { id: "fl-d2-2", name: "d2-2", ram: 2, vcpus: 1, osType: "linux", available: true, planCodes: { hourly: "d2-2.consumption", monthly: "d2-2.monthly" } },
      { id: "fl-b3-8", name: "b3-8", ram: 8, vcpus: 2, osType: "linux", available: true, planCodes: { hourly: "b3-8.consumption" } },
      { id: "fl-d2-4", name: "d2-4", ram: 4, vcpus: 2, osType: "linux", available: true, planCodes: { hourly: "onbekend" } },
      { id: "fl-win", name: "win-b2-7", ram: 7, vcpus: 2, osType: "windows", available: true },
      { id: "fl-gpu", name: "t1-45", ram: 45, vcpus: 8, osType: "linux", available: true },
      { id: "fl-weg", name: "d2-8", ram: 8, vcpus: 4, osType: "linux", available: false },
    ] };
    if (k === `POST ${pr}/instance`) {
      const b = json(r);
      const i = { id: `i-${++st.n}`, name: b.name, region: b.region, status: "BUILD", ipAddresses: [], body: b };
      st.instances.set(i.id, i);
      return { json: i };
    }
    if (k === `GET ${pr}/instance`) return { json: [...st.instances.values()].map(({ body, ...i }) => i) };
    if ((mm = /^GET \/cloud\/project\/proj-789\/instance\/(.+)$/.exec(k))) {
      const i = st.instances.get(mm[1]);
      if (++st.polls >= 2) Object.assign(i, { status: "ACTIVE", ipAddresses: [{ ip: "10.0.0.5", type: "private", version: 4 }, { ip: "51.38.0.9", type: "public", version: 4 }, { ip: "2001:41d0::9", type: "public", version: 6 }] });
      const { body, ...rest } = i;
      return { json: rest };
    }
    if ((mm = /^DELETE \/cloud\/project\/proj-789\/instance\/(.+)$/.exec(k))) return st.instances.delete(mm[1]) ? { json: null } : { status: 404, json: { message: "weg" } };
    // DNS
    if (k === "GET /domain/zone/vanes.nl") return { json: { name: "vanes.nl", nameServers: ["dns11.ovh.net", "ns11.ovh.net"] } };
    if (k === "GET /domain/zone/elders.nl") return { status: 404, json: { message: "niet gevonden" } };
    if (k === "GET /domain/zone/vanes.nl/record") {
      const t = r.url.searchParams.get("fieldType"), sub = r.url.searchParams.get("subDomain");
      return { json: st.records.filter((x) => x.fieldType === t && (sub === null || x.subDomain === sub)).map((x) => x.id) };
    }
    if ((mm = /^GET \/domain\/zone\/vanes\.nl\/record\/(\d+)$/.exec(k))) return { json: { zone: "vanes.nl", ...st.records.find((x) => x.id === Number(mm![1])) } };
    if ((mm = /^DELETE \/domain\/zone\/vanes\.nl\/record\/(\d+)$/.exec(k))) { st.records = st.records.filter((x) => x.id !== Number(mm![1])); return { json: null }; }
    if (k === "POST /domain/zone/vanes.nl/record") { const rec = { id: ++st.n, ...json(r) }; st.records.push(rec); return { json: rec }; }
    if (k === "POST /domain/zone/vanes.nl/refresh") { st.refreshes++; return { json: null }; }
    return { status: 500, json: { message: `niet nagebootst: ${k}` } };
  });
  return st;
}

test("OVHcloud: servertijd, ondertekening, instance met user-data, wachten op IP, opsommen op naam, verwijderen", async () => {
  const st = ovhFake();
  const p = makeProvider("ovh", OVH);
  const info = await p.create({ cluster: "eigen", nodeId: "n-a1b2c3", kind: "data", region: "GRA11", size: "d2-2", userData: "#!/bin/bash\necho hoi" });
  assert.deepEqual(info, { serverId: "i-101", ipv4: "51.38.0.9", ipv6: "2001:41d0::9", country: "FR" });
  assert.equal(log.filter((r) => r.url.pathname === "/1.0/auth/time").length, 1, "servertijd één keer opgevraagd");
  const b = st.instances.get("i-101").body;
  assert.deepEqual(b, { name: "eigen-n-a1b2c3", region: "GRA11", flavorId: "fl-d2-2", imageId: "img-24", userData: "#!/bin/bash\necho hoi", monthlyBilling: false });

  await p.create({ cluster: "eigen-x", nodeId: "n-1", kind: "witness", region: "DE1", size: "d2-2", userData: "x" });
  st.instances.set("i-hand", { id: "i-hand", name: "eigen-mijn-eigen-server", body: {} });
  assert.deepEqual(await p.list("eigen"), [{ serverId: "i-101", nodeId: "n-a1b2c3" }], "andere clusters en handgemaakte servers blijven buiten beeld");
  assert.deepEqual(await p.list("eigen-x"), [{ serverId: "i-102", nodeId: "n-1" }]);
  assert.equal(p.country("DE1"), "DE");
  assert.equal(p.country("WAW1"), "PL");
  assert.equal(p.country("UK1"), "GB");
  await p.destroy("i-101");
  await p.destroy("i-101");
  assert.deepEqual(await p.list("eigen"), []);
  assert.equal(p.setPtr, undefined, "PTR niet via de API");

  await assert.rejects(makeProvider("ovh", { ...OVH, appSecret: "fout" }).list("eigen"), /403/);
  assert.throws(() => makeProvider("ovh", { ...OVH, projectId: "" }), /project-ID/);
});

test("OVHcloud: formaten en prijzen uit de openbare catalogus", async () => {
  ovhFake();
  const sizes = await catalog.fetchSizes("ovh", OVH, "GRA11");
  assert.deepEqual(sizes.map((s) => [s.size, s.ramGb, s.cpus, s.monthly]), [["d2-2", 2, 1, 7.3], ["d2-4", 4, 2, null], ["b3-8", 8, 2, 29.2]]);
  assert.ok(!log.find((r) => r.url.pathname.includes("/order/catalog"))!.headers.has("x-ovh-signature"), "catalogus zonder sleutel");
  assert.equal(catalog.pickSize(sizes, "data")!.size, "d2-2");
});

test("OVHcloud DNS: zone controleren, records vervangen (alleen de juiste naam), verversen, niets doen als het al klopt", async () => {
  const st = ovhFake();
  const a = getAdapter("ovh")!;
  assert.deepEqual(await a.dns!.connect(OVH, "vanes.nl"), { nameservers: ["dns11.ovh.net", "ns11.ovh.net"] });
  await assert.rejects(a.dns!.connect(OVH, "elders.nl"), /staat niet bij OVHcloud/);
  await assert.rejects(a.dns!.connect({ ...OVH, consumerKey: "fout" }, "vanes.nl"), /accepteert deze sleutels niet/);

  const dns = makeDns({ type: "ovh", name: "ovh", zone: "vanes.nl", fields: { appKey: OVH.appKey, appSecret: OVH.appSecret, consumerKey: OVH.consumerKey } });
  await dns.setRecords("cloud", "A", ["1.2.3.4", "5.6.7.8"], 300);
  assert.deepEqual(st.records.filter((r) => r.subDomain === "cloud").map((r) => r.target).sort(), ["1.2.3.4", "5.6.7.8"]);
  assert.equal(st.refreshes, 1);
  await dns.setRecords("", "TXT", ['"v=spf1 a:mail.vanes.nl -all"'], 3600);
  assert.deepEqual(st.records.filter((r) => r.fieldType === "TXT").map((r) => [r.subDomain, r.target]).sort(), [["", '"v=spf1 a:mail.vanes.nl -all"'], ["www", '"blijft"']]);
  await dns.setRecords("", "MX", ["10 mail.vanes.nl."], 3600);
  assert.equal(st.records.find((r) => r.fieldType === "MX").target, "10 mail.vanes.nl.");
  const before = st.refreshes;
  await dns.setRecords("cloud", "A", ["5.6.7.8", "1.2.3.4"], 300);
  assert.equal(st.refreshes, before, "al goed: geen wijziging en geen verversing");
  assert.ok(!log.some((r) => r.method === "DELETE" && r.url.pathname.endsWith("/record/3")));
});

test("OVHcloud: de rechtenlijst voor de consumer key dekt elk verzoek van de adapter", () => {
  const rules = OVH_ACCESS_RULES("proj-789", "vanes.nl");
  const covered = (method: string, p: string) => rules.some((r) => r.method === method && (r.path === p || (r.path.endsWith("/*") && p.startsWith(r.path.slice(0, -1)))));
  for (const [m, p] of [
    ["GET", "/cloud/project/proj-789/image"], ["GET", "/cloud/project/proj-789/flavor"], ["POST", "/cloud/project/proj-789/instance"],
    ["GET", "/cloud/project/proj-789/instance"], ["GET", "/cloud/project/proj-789/instance/i-1"], ["DELETE", "/cloud/project/proj-789/instance/i-1"],
    ["GET", "/domain/zone/vanes.nl"], ["GET", "/domain/zone/vanes.nl/record"], ["GET", "/domain/zone/vanes.nl/record/1"],
    ["POST", "/domain/zone/vanes.nl/record"], ["DELETE", "/domain/zone/vanes.nl/record/1"], ["POST", "/domain/zone/vanes.nl/refresh"],
  ]) assert.ok(covered(m, p), `${m} ${p}`);
});

// ───────── Scaleway DNS ─────────

test("Scaleway DNS: zone controleren, records zetten (set) en weghalen (delete)", async () => {
  const bodies: any[] = [];
  fake((r) => {
    if (r.headers.get("x-auth-token") !== "sk") return { status: 401, json: {} };
    if (r.method === "GET" && r.url.pathname === "/domain/v2beta1/dns-zones") return { json: { dns_zones: r.url.searchParams.get("dns_zone") === "vanes.nl" ? [{ domain: "vanes.nl", subdomain: "", ns: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"], project_id: "proj-1" }] : [] } };
    if (r.method === "GET" && r.url.pathname === "/account/v3/projects/proj-1") return { json: { id: "proj-1", organization_id: "org-1" } };
    if (r.method === "PATCH" && r.url.pathname === "/domain/v2beta1/dns-zones/vanes.nl/records") { bodies.push(json(r)); return { json: { records: [] } }; }
    return { status: 500 };
  });
  const a = getAdapter("scaleway")!;
  const f: Record<string, string> = { secretKey: "sk" };
  assert.deepEqual(await a.dns!.connect(f, "vanes.nl"), { nameservers: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"] });
  assert.equal(f.organizationId, "org-1", "organisatie-ID opgezocht (voor Caddy DNS-01)");
  const given: Record<string, string> = { secretKey: "sk", organizationId: "eigen" };
  await a.dns!.connect(given, "vanes.nl");
  assert.equal(given.organizationId, "eigen", "ingevuld organisatie-ID blijft");
  await assert.rejects(a.dns!.connect({ secretKey: "sk" }, "elders.nl"), /Domains and DNS/);
  await assert.rejects(a.dns!.connect({ secretKey: "fout" }, "vanes.nl"), /accepteert deze sleutel niet/);
  const dns = makeDns({ type: "scaleway", name: "scw", zone: "vanes.nl", fields: { secretKey: "sk" } });
  await dns.setRecords("", "MX", ["10 mail.vanes.nl."], 3600);
  await dns.setRecords("", "TXT", ['"v=spf1 a:mail.vanes.nl -all"'], 3600);
  await dns.setRecords("cloud", "AAAA", [], 300);
  assert.deepEqual(bodies, [
    { changes: [{ set: { id_fields: { name: "", type: "MX" }, records: [{ name: "", type: "MX", ttl: 3600, data: "mail.vanes.nl.", priority: 10 }] } }], return_all_records: false },
    { changes: [{ set: { id_fields: { name: "", type: "TXT" }, records: [{ name: "", type: "TXT", ttl: 3600, data: "v=spf1 a:mail.vanes.nl -all" }] } }], return_all_records: false },
    { changes: [{ delete: { id_fields: { name: "cloud", type: "AAAA" } } }], return_all_records: false },
  ]);
});

// ───────── Registry ─────────

test("registry: elke adapter is compleet, id's uniek, opslag via https, DNS en servers te maken", () => {
  const all = adapters();
  const ids = all.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "id's uniek");
  for (const id of ["scaleway", "hetzner", "upcloud", "exoscale", "ovh"]) assert.ok(getAdapter(id)?.servers, `${id} heeft servers`);
  for (const id of ["scaleway", "hetzner", "upcloud", "exoscale", "ovh", "custom"]) assert.ok(getAdapter(id)?.storage, `${id} heeft opslag`);
  for (const id of ["desec", "hetzner", "scaleway", "exoscale", "ovh"]) assert.ok(getAdapter(id)?.dns, `${id} heeft DNS`);
  assert.ok(!getAdapter("upcloud")!.dns, "UpCloud heeft geen DNS");
  for (const a of all) {
    assert.match(a.id, /^[a-z][a-z0-9-]*$/, a.id);
    assert.ok(a.name && a.owner, `${a.id}: naam en eigenaar`);
    assert.match(a.home, /^[A-Z]{2}$/, `${a.id}: land`);
    assert.ok(a.servers || a.storage || a.dns, `${a.id}: kan iets`);
    if ((a.servers || a.dns) && !a.testOnly) {
      assert.ok(a.keyHelp.length > 20, `${a.id}: uitleg waar de sleutel vandaan komt`);
      assert.match(a.signupUrl, /^https:\/\//, `${a.id}: aanmeldlink`);
    }
    const keys = [...a.fields, ...(a.dns?.fields ?? [])].map((f) => f.key);
    for (const f of [...a.fields, ...(a.dns?.fields ?? [])]) assert.ok(f.key && f.label, `${a.id}: veld met sleutel en label`);
    assert.equal(new Set(a.fields.map((f) => f.key)).size, a.fields.length, `${a.id}: velden uniek`);
    if (a.dns?.fields) for (const f of a.dns.fields) assert.ok(keys.includes(f.key));
    for (const r of a.servers?.regions ?? []) assert.ok(r.id && r.label && r.city && /^[A-Z]{2}$/.test(r.country), `${a.id}/${r.id}`);
    if (a.storage) {
      assert.ok(a.storage.regions.length && a.storage.keyHelp, `${a.id}: opslag`);
      for (const r of a.storage.regions) {
        assert.match(r.country, /^[A-Z]{2}$/);
        if (a.storage.customEndpoint) assert.ok(r.endpoint === "" || r.endpoint.startsWith("https://"));
        else assert.match(r.endpoint, /^https:\/\/[a-z0-9.-]+$/, `${a.id}/${r.id}: https-endpoint`);
      }
    }
    // Maken zonder netwerk (alleen de constructor).
    const fields = Object.fromEntries([...a.fields, ...(a.dns?.fields ?? [])].map((f) => [f.key, "x"]));
    if (a.servers && !a.testOnly) assert.equal(typeof makeProvider(a.id, fields).create, "function");
    if (a.dns) assert.equal(typeof makeDns({ type: a.id, name: a.id, zone: "vanes.nl", token: "x", fields }).setRecords, "function");
  }
  assert.throws(() => makeProvider("bestaatniet", {}), /Onbekende aanbieder/);
});

test("registry → catalogus, catalog.json en Caddy", () => {
  assert.deepEqual(catalog.serverOffers().map((o) => o.id), ["scaleway", "hetzner", "upcloud", "exoscale", "ovh"]);
  assert.ok(!catalog.serverOffers().some((o) => o.id === "local"), "testaanbieder niet zichtbaar");
  assert.ok(catalog.serverOffers(true).some((o) => o.id === "local"));
  assert.deepEqual(catalog.dnsOffers().map((o) => [o.id, o.sharesKeyWith ?? null]), [["desec", null], ["scaleway", "scaleway"], ["hetzner", "hetzner"], ["exoscale", "exoscale"], ["ovh", "ovh"], ["openprovider", null]]);
  const j = catalogJson();
  assert.deepEqual(JSON.parse(JSON.stringify(j)), j, "pure data");
  assert.equal(j.version, 2);
  assert.ok(j.stores.find((s) => s.id === "ovh")!.regions.some((r) => r.endpoint === "https://s3.gra.io.cloud.ovh.net"));
  assert.ok(j.stores.find((s) => s.id === "exoscale")!.regions.length === 7);
  assert.deepEqual(j.adapters.find((a) => a.id === "ovh")!.capabilities, { servers: true, storage: true, dns: true, quick: false });

  const cfg = (dns: ClusterConfig["dns"]) => ({ domain: "vanes.nl", dns }) as unknown as ClusterConfig;
  assert.match(caddyfile(cfg([{ type: "hetzner", name: "h", token: "htok" }]))!, /tls \{\n\t\tdns hetzner htok\n\t\}/);
  assert.match(caddyfile(cfg([{ type: "file", name: "f" }, { type: "desec", name: "d", token: "dt" }]))!, /dns desec \{\n\t\t\ttoken dt\n\t\t\}/);
  assert.doesNotMatch(caddyfile(cfg([{ type: "ovh", name: "o", fields: { appKey: "a" } }]))!, /tls/, "OVH zonder alle sleutels: HTTP-01");
  assert.doesNotMatch(caddyfile(cfg([{ type: "exoscale", name: "e", fields: { apiKey: "EXO1", apiSecret: "x" } }]))!, /tls/, "Exoscale: geen Caddy-module, HTTP-01");
  assert.match(caddyfile(cfg([{ type: "ovh", name: "o", fields: { appKey: "ak", appSecret: "as", consumerKey: "ck" } }]))!,
    /tls \{\n\t\tdns ovh \{\n\t\t\tendpoint ovh-eu\n\t\t\tapplication_key ak\n\t\t\tapplication_secret as\n\t\t\tconsumer_key ck\n\t\t\}\n\t\}/);
  assert.match(caddyfile(cfg([{ type: "scaleway", name: "s", fields: { secretKey: "sk", organizationId: "org-1" } }]))!,
    /tls \{\n\t\tdns scaleway \{\n\t\t\tsecret_key sk\n\t\t\torganization_id org-1\n\t\t\}\n\t\}/);
  // Scaleway zonder organisatie-ID telt niet mee: de volgende koppeling met een complete Caddy-regel wint.
  assert.match(caddyfile(cfg([{ type: "scaleway", name: "s", fields: { secretKey: "sk" } }, { type: "hetzner", name: "h", token: "htok" }]))!, /dns hetzner htok/);
});

// ───────── Zo voeg je een aanbieder toe ─────────

/**
 * Voorbeeld: een (nagebootste) aanbieder "voorbeeld" met servers, opslag en DNS. In het echt zet je dit object in
 * src/cluster/adapters/voorbeeld.ts en voeg je het toe aan de lijst in src/cluster/adapters.ts; hier registreren
 * we het tijdens de test. Daarna ziet de console het overal vanzelf.
 */
class VoorbeeldProvider implements Provider {
  readonly name = "voorbeeld";
  static servers = new Map<string, { nodeId: string; cluster: string }>();
  constructor(private cfg: { token: string }) { if (!cfg.token) throw new Error("token ontbreekt"); }
  country(region: string) { return region.startsWith("ams") ? "NL" : "DE"; }
  async create(s: CreateSpec) { const id = `vb-${VoorbeeldProvider.servers.size + 1}`; VoorbeeldProvider.servers.set(id, { nodeId: s.nodeId, cluster: s.cluster }); return { serverId: id, ipv4: "192.0.2.1", country: this.country(s.region) }; }
  async destroy(id: string) { VoorbeeldProvider.servers.delete(id); }
  async list(cluster: string) {
    if (this.cfg.token !== "goed") throw new Error("401 token onjuist");
    return [...VoorbeeldProvider.servers].filter(([, v]) => v.cluster === cluster).map(([serverId, v]) => ({ serverId, nodeId: v.nodeId }));
  }
}
const dnsLog: string[] = [];
const voorbeeld: ProviderAdapter = {
  id: "voorbeeld", name: "Voorbeeld Cloud", owner: "Voorbeeld BV (Nederland)", home: "NL", signupUrl: "https://voorbeeld.example",
  keyHelp: "Voorbeeld-console → Instellingen → API-token (lezen en schrijven).",
  fields: [{ key: "token", label: "API-token", secret: true }],
  servers: {
    regions: [
      { id: "ams-a", label: "Amsterdam A", country: "NL", city: "Amsterdam" },
      { id: "ams-b", label: "Amsterdam B", country: "NL", city: "Amsterdam" },
      { id: "ams-c", label: "Amsterdam C", country: "NL", city: "Amsterdam" },
      { id: "fra", label: "Frankfurt", country: "DE", city: "Frankfurt" },
    ],
    create: (f) => new VoorbeeldProvider(f as never),
    fetchSizes: async () => [{ size: "klein", label: "1 vCPU, 1 GB", ramGb: 1, cpus: 1, monthly: 3 }, { size: "midden", label: "2 vCPU, 4 GB", ramGb: 4, cpus: 2, monthly: 6 }],
  },
  storage: { name: "Voorbeeld Opslag", regions: [{ id: "ams", label: "Amsterdam", country: "NL", endpoint: "https://s3.ams.voorbeeld.example" }], keyHelp: "Voorbeeld-console → Opslag → sleutels." },
  dns: {
    async connect(f) { if (f.token !== "goed") throw new Error("Voorbeeld accepteert dit token niet"); return { nameservers: ["ns1.voorbeeld.example", "ns2.voorbeeld.example"] }; },
    create: (name, f, zone) => ({ name, setRecords: async (sub, type, values) => { dnsLog.push(`${zone} ${sub}/${type}=${values.join(",")} (${f.token})`); } }),
  },
};

test("een eigen aanbieder toevoegen: registreren en hij staat overal in de console", async (t) => {
  const unregister = registerAdapter(voorbeeld);
  t.after(unregister);
  assert.ok(catalog.serverOffers().some((o) => o.id === "voorbeeld"));
  assert.ok(catalog.storeOffers().some((o) => o.id === "voorbeeld"));
  assert.ok(catalog.dnsOffers().some((o) => o.id === "voorbeeld" && o.sharesKeyWith === "voorbeeld"));

  const { buildConsole } = await import("../src/console/server.js");
  const app = await buildConsole();
  t.after(() => app.close());
  let cookie = "";
  const c = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), text: r.body };
  };

  const state = (await c("GET", "/api/state")).json;
  assert.ok(state.offers.servers.some((o: { id: string }) => o.id === "voorbeeld"), "servers-stap");
  assert.ok(state.offers.stores.some((o: { id: string }) => o.id === "voorbeeld"), "opslag-stap");
  assert.ok(state.offers.dns.some((o: { id: string }) => o.id === "voorbeeld"), "DNS-stap");
  assert.ok(state.offers.dns.some((o: { id: string }) => o.id === "ovh") && state.offers.servers.some((o: { id: string }) => o.id === "exoscale"));

  assert.equal((await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", alertEmail: "rene@elders.example", passphrase: "vier losse woorden hier" })).status, 200);
  let r = await c("POST", "/api/providers", { id: "voorbeeld", fields: { token: "fout" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Inloggen bij Voorbeeld Cloud lukt niet/);
  r = await c("POST", "/api/providers", { id: "voorbeeld", fields: { token: "goed" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.regions.map((x: { region: string; data: { size: string } }) => [x.region, x.data.size]), [["ams-a", "midden"], ["ams-b", "midden"], ["ams-c", "midden"], ["fra", "midden"]]);
  assert.equal((await c("GET", "/api/config")).json.providers.voorbeeld.token, "••••••••goed", "geheim veld gemaskeerd");

  // Verspreiding met alleen deze aanbieder: alles in Nederland kan (twee data-servers van € 6, een witness van € 3).
  const { presets } = (await c("GET", "/api/presets")).json;
  const nl = presets.find((p: { id: string }) => p.id === "nl");
  assert.deepEqual(nl.placement.map((p: { provider: string; region: string; kind: string }) => `${p.provider}/${p.region}/${p.kind}`), ["voorbeeld/ams-a/data", "voorbeeld/ams-b/data", "voorbeeld/ams-c/witness"]);
  assert.equal(nl.monthly, 15);

  // DNS met dezelfde sleutel als bij Servers: niets invullen.
  r = await c("POST", "/api/dns", { mode: "voorbeeld" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.ns, ["ns1.voorbeeld.example", "ns2.voorbeeld.example"]);
  const conf = (await c("GET", "/api/config")).json;
  assert.equal(conf.dnsMode, "voorbeeld");
  assert.equal(conf.dns[0].token, "••••••••goed");
  await makeDns({ type: "voorbeeld", name: "vb", zone: "vanes.test", token: "goed" }).setRecords("cloud", "A", ["192.0.2.1"], 300);
  assert.deepEqual(dnsLog, ["vanes.test cloud/A=192.0.2.1 (goed)"]);

  // Een onbekende of testaanbieder kan niet als DNS gekozen worden.
  assert.equal((await c("POST", "/api/dns", { mode: "local" })).status, 400);
  assert.equal((await c("POST", "/api/dns", { mode: "exoscale" })).status, 400, "zonder sleutel");
});
