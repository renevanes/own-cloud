/**
 * Maakt vaste testgegevens ("golden fixtures") voor de Java-kern van de Android-app:
 * de Java-tests controleren dat ze exact dezelfde uitkomst geven als deze TypeScript-code.
 * Gebruik: npx tsx scripts/golden.ts [uitvoerbestand]   (standaard android/core/build/golden.json)
 */
process.env.TZ = "UTC";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { transformSync } from "esbuild";
import { deriveKey, seal, sealJson } from "../src/cluster/crypto.js";
import { sealMsg } from "../src/cluster/transport.js";
import { keysFor, DEFAULT_POLICY, type ClusterConfig } from "../src/cluster/config.js";
import { S3Store } from "../src/cluster/stores.js";
import { userData, caddyfile, dienstUserData, dienstCheckScript, updaterScript } from "../src/cluster/cloudinit.js";
import { adminProof, consoleSettings } from "../src/cluster/admin.js";
import * as aanbieder from "../src/console/aanbieder.js";
import * as costs from "../src/console/costs.js";
import { parseBudget } from "../src/cluster/costs.js";
import { getAdapter } from "../src/cluster/adapters.js";
import { buildPresets, pickSize, fetchSizes, SERVER_OFFERS, serverOffers, storeOffers, type SizeOption, type RegionInfo } from "../src/console/catalog.js";
import { hashPassword } from "../src/auth.js";
import { isSecretField } from "../src/cluster/adapters.js";
import { parseMx, unquoteTxt } from "../src/cluster/adapters/http.js";
import { exoSign } from "../src/cluster/adapters/exoscale.js";
import { ovhSign } from "../src/cluster/adapters/ovh.js";
import { ScalewayDns } from "../src/cluster/adapters/scaleway.js";

const root = path.resolve(import.meta.dirname, "..");
const outFile = path.resolve(process.argv[2] ?? path.join(root, "android/core/build/golden.json"));
const b64 = (b: Buffer) => b.toString("base64");

const masterKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const master = Buffer.from(masterKey, "hex");
const keys = keysFor({ masterKey });

// ───────── 1. HKDF ─────────
const purposes = ["cluster", "db", "blobs", "manifest", "admin", "bootstrap", "vault", "", "ü-€-😀/x"];
const derived = Object.fromEntries(purposes.map((p) => [p, deriveKey(master, p).toString("hex")]));
const derived16 = deriveKey(master, "kort", 16).toString("hex");
const derived64 = deriveKey(master, "lang", 64).toString("hex");

// ───────── 2. Versleuteling ─────────
const plains = ["", "hallo", "ü-€-😀 \u0000 einde", "x".repeat(5000)];
const seals: { purpose: string; aad: string | null; plain: string; sealed: string }[] = [];
for (const purpose of ["cluster", "manifest"]) {
  for (const aad of [null, "rpc", "admin-config", "ü"]) {
    for (const p of plains) seals.push({ purpose, aad, plain: b64(Buffer.from(p)), sealed: b64(seal(deriveKey(master, purpose), p, aad ?? undefined)) });
  }
}

const sampleConfig = {
  cluster: "vanes", nodeId: "beheer", kind: "data", masterKey, clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], domain: "vanes.nl",
  stores: [{ name: "scaleway-nl-ams", type: "s3", purpose: "replica", country: "NL", endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams", bucket: "vanes-data-abc123", accessKey: "SCW123", secretKey: "geheim/+=" }],
  providers: { hetzner: { token: "tok\"en" } }, dns: [{ type: "desec", name: "desec", token: "t", zone: "vanes.nl" }],
  image: { ref: "ghcr.io/renevanes/eigen-cloud:latest", caddyRef: "ghcr.io/renevanes/eigen-caddy:latest" },
  appEnv: { MAIL_DOMAINS: "vanes.nl", MAIL_FROM: "rene@vanes.nl" }, policy: { ...DEFAULT_POLICY, placement: [{ provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", country: "NL", kind: "data" }] },
  console: { step: "klaar", done: true, keyConfirmed: true, alertEmail: "rene@example.org", price: 4.51, ratio: 0.5 },
};
const sealJsonCases = [
  { aad: "manifest", value: { cluster: "vanes", state: "awake", term: 3, lastSeq: 1234, updated: 1760000000000, leader: "n-abc", nodes: [{ id: "n-abc", kind: "data", provider: "scaleway", region: "nl-ams-1", country: "NL", ipv4: "51.15.0.1", clusterUrl: null, status: "ready" }], topology: [{ kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S" }], lastDrill: null } },
  { aad: "admin-config", value: sampleConfig },
];
const sealJsonOut = sealJsonCases.map((c) => ({ ...c, sealed: b64(sealJson(keys.manifest!, c.value, c.aad)) }));

const rpcMsg = { type: "status", nested: { ü: [1, 2.5, "x\"y"] } };
const rpc = { msg: rpcMsg, sealed: b64(sealMsg(keys.cluster, rpcMsg)) };

const joinToken = "f".repeat(16) + "0123456789abcdef".repeat(3);
const bootstrapValue = { ...sampleConfig, nodeId: "n-123456", bootstrapLeader: true, bootstrapTerm: 0, seeds: [] };
const bootstrap = { joinToken, value: bootstrapValue, sealed: b64(sealJson(deriveKey(Buffer.from(joinToken, "hex"), "bootstrap"), bootstrapValue, "bootstrap")) };

// ───────── 3. JSON ─────────
const jsonInputs = [
  `{"a":1,"b":[1,2,{"c":"x"}],"d":null,"e":true,"f":false}`,
  ` { "a" : [ 1 , 2 ] ,\n\t"b":{} , "c" : [ ] } `,
  `"\\u0000\\u0001\\u001f\\u007f\\u0080\\u2028\\u2029\\ufeff"`,
  `"\\ud800"`, `"\\udc00abc"`, `"a\\ud83d\\ude00b"`, `"\\ude00\\ud83d"`, `"😀é/\\/\\\\"`,
  `"\\b\\f\\n\\r\\t\\"\\\\"`,
  `[0,-0,1.5,1e21,1e-7,123456789012345678901234,0.1,100,1E2,2.5e-3,-1.2345678901234567e+300,5e-324,1.7976931348623157e308,9007199254740993,0.000001,1e-6,123e-20,1.0,-0.0,1e400,4.51,0.5,0.30000000000000004,1e20,1.5e21,-12.75,9007199254740992,-9007199254740993,123456.789e3]`,
  `{"b":1,"2":2,"1":3,"a":{"10":1,"9":2,"x":3,"01":4,"4294967294":5,"4294967295":6,"-1":7}}`,
  `{"a":1,"b":2,"a":3}`,
  `{"__proto__":{"x":1},"constructor":2}`,
  `[[[[[[[[[["diep"]]]]]]]]]]`,
  `{"emoji":"🐌","nl":"Wachtwoordzin klopt niet — één","ctrl":"\\u0007\\u001b","tab":"a\\tb"}`,
  `""`, `0`, `-1`, `null`, `true`, `"x"`, `[]`, `{}`,
];
const json = jsonInputs.map((input) => ({ input, expected: JSON.stringify(JSON.parse(input)), pretty: JSON.stringify(JSON.parse(input), null, 2) }));

// ───────── 4. S3 ─────────
const presignStores = [
  { name: "p", type: "s3", purpose: "replica", endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams", bucket: "b-1", accessKey: "AK/1", secretKey: "s+e/c=r" },
  { name: "p2", type: "s3", purpose: "backup", endpoint: "http://127.0.0.1:9000", bucket: "data", accessKey: "minio", secretKey: "minio123", prefix: "pre/fix/" },
  { name: "p3", type: "s3", purpose: "replica", endpoint: "https://fsn1.your-objectstorage.com:443", region: "fsn1", bucket: "virt", accessKey: "A", secretKey: "S", pathStyle: false },
];
const presignKeys = ["bootstrap/n-1.enc", "a b/c+d=é!'()*~.txt", "x/ü/😀", "", "images/eigen-cloud.tar.gz", "dubbel//slash/"];
const now = new Date("2026-10-09T12:34:56.789Z");
// Lege sleutel bij een opslag met prefix: de TS-versie zet de prefix ook voor bucket-verzoeken (bug); Java niet.
const samePrefixBehaviour = (cfg: { prefix?: string }, key: string) => !(cfg.prefix && key === "");
const presign = presignStores.flatMap((cfg) => presignKeys.filter((key) => samePrefixBehaviour(cfg, key)).map((key) => ({ cfg, key, seconds: 7200, now: now.getTime(), url: new S3Store(cfg as never).presignGet(key, 7200, now) })));

// Header-ondertekening (privé-methode, met vaste tijd).
const RealDate = Date;
function withFixedDate<T>(t: number, fn: () => T): T {
  class FixedDate extends RealDate { constructor(...a: unknown[]) { if (a.length) super(...(a as [number])); else super(t); } static now() { return t; } }
  globalThis.Date = FixedDate as DateConstructor;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}
const signCases = [
  { method: "GET", key: "manifest.enc", query: {}, extra: {} },
  { method: "PUT", key: "a b/ü.txt", query: {}, extra: { "content-length": "11" } },
  { method: "GET", key: "", query: { "list-type": "2", prefix: "test/", "continuation-token": "1/abc==" }, extra: {} },
  { method: "PUT", key: "", query: { versioning: "" }, extra: { "content-length": "10", "content-md5": "abc==", "content-type": "application/xml" } },
  { method: "PUT", key: "", query: {}, extra: { "content-length": "0", "x-amz-bucket-object-lock-enabled": "true" } },
  { method: "HEAD", key: "x", query: {}, extra: {} },
];
const sign = presignStores.flatMap((cfg) => signCases.filter((c) => samePrefixBehaviour(cfg, c.key)).map((c) => ({ cfg, ...c, now: now.getTime(),
  result: withFixedDate(now.getTime(), () => (new S3Store(cfg as never) as unknown as { sign: (m: string, k: string, q: Record<string, string>, e: Record<string, string>) => { url: string; headers: Record<string, string> } }).sign(c.method, c.key, c.query, c.extra)) })));

// ───────── 6. cloud-init ─────────
const ccBase = { ...sampleConfig } as unknown as ClusterConfig;
const userDataCases = [
  { cfg: ccBase, opts: { nodeId: "n-a1b2c3", kind: "data" as const, bootstrapUrl: "https://s3.nl-ams.scw.cloud/b/bootstrap/n-a1b2c3.enc?X-Amz-Expires=7200&X-Amz-Signature=abc", joinToken: "ab".repeat(32) } },
  { cfg: { ...ccBase, domain: undefined, clusterPort: 7000, image: { url: "https://example.org/app.tar.gz" } } as unknown as ClusterConfig, opts: { nodeId: "w-1", kind: "witness" as const, bootstrapUrl: "file:///tmp/x", joinToken: "t" } },
  { cfg: { ...ccBase, image: { ref: "eigen-cloud:1", caddyUrl: "https://cfg/caddy.tgz" } } as unknown as ClusterConfig, opts: { nodeId: "n-2", kind: "data" as const, bootstrapUrl: "https://x/y?z=1&a=2", joinToken: "jt", imageUrl: "https://img/app.tgz", caddyUrl: "https://img/caddy.tgz" } },
  { cfg: { ...ccBase, image: {} } as unknown as ClusterConfig, opts: { nodeId: "n-3", kind: "data" as const, bootstrapUrl: "u", joinToken: "j", imageUrl: "" } },
];
const userDataOut = userDataCases.map((c) => ({ ...c, out: userData(c.cfg, c.opts) }));
const caddyCases = [
  ccBase,
  { ...ccBase, dns: [{ type: "file", name: "f" }, { type: "hetzner", name: "h", token: "htok" }] },
  { ...ccBase, dns: [] },
  { ...ccBase, domain: undefined },
  { ...ccBase, dns: [{ type: "desec", name: "d" }] },
  // Adapter-raamwerk: alleen adapters met een Caddy-module (deSEC, Hetzner, Scaleway, OVHcloud) én complete velden
  // geven DNS-01; de eerste telt. Exoscale: HTTP-01.
  { ...ccBase, dns: [{ type: "ovh", name: "o", zone: "vanes.nl", fields: { appKey: "a", appSecret: "s", consumerKey: "c" } }] },
  { ...ccBase, dns: [{ type: "scaleway", name: "s", fields: { secretKey: "k" } }, { type: "exoscale", name: "e", fields: { apiKey: "EXO1", apiSecret: "x" } }] },
  { ...ccBase, dns: [{ type: "exoscale", name: "e", fields: { apiKey: "EXO1" } }, { type: "hetzner", name: "h", token: "ht", fields: { extra: "1" } }, { type: "desec", name: "d", token: "dt" }] },
  { ...ccBase, dns: [{ type: "onbekend", name: "x", token: "t" }, { type: "desec", name: "dienst", token: "dt", api: "https://dienst/dns" }] },
  { ...ccBase, dns: [{ type: "hetzner", name: "h" }] },
  { ...ccBase, dns: [{ type: "scaleway", name: "s", fields: { secretKey: "k", organizationId: "org-1" } }, { type: "hetzner", name: "h", token: "ht" }] },
  { ...ccBase, dns: [{ type: "scaleway", name: "s", fields: { secretKey: "k" } }, { type: "ovh", name: "o", fields: { appKey: "a", appSecret: "s" } }, { type: "desec", name: "d", token: "dt" }] },
  { ...ccBase, dns: [{ type: "exoscale", name: "e", fields: { apiKey: "EXO1", apiSecret: "x" } }] },
] as unknown as ClusterConfig[];
const caddyOut = caddyCases.map((cfg) => ({ cfg, out: caddyfile(cfg) }));

// ───────── 8. Catalogus ─────────
const regions = Object.fromEntries(SERVER_OFFERS.map((o) => [o.id, o.regions]));
const sz = (size: string, ramGb: number, cpus: number, monthly: number | null): SizeOption => ({ size, label: `${cpus} vCPU, ${ramGb} GB`, ramGb, cpus, monthly });
const sizeSets: Record<string, SizeOption[]> = {
  scaleway: [sz("STARDUST1-S", 1, 1, 0.1), sz("DEV1-S", 2, 2, 6.42), sz("DEV1-M", 4, 3, 12.84), sz("PLAY2-PICO", 2, 1, null)],
  hetzner: [sz("cx23", 4, 2, 4.51), sz("cx33", 8, 4, 7.25), sz("cpx11", 2, 2, 5.18)],
  upcloud: [sz("1xCPU-1GB", 1, 1, null), sz("1xCPU-2GB", 2, 1, null), sz("2xCPU-4GB", 4, 2, null)],
  tiny: [sz("a", 0.25, 1, 1), sz("b", 0.5, 1, 2)],
  exoscale: [sz("standard.micro", 0.5, 1, null), sz("standard.small", 2, 2, null), sz("standard.medium", 4, 2, null)],
  ovh: [sz("d2-2", 2, 1, 7.3), sz("d2-4", 4, 2, null), sz("b3-8", 8, 2, 29.2)],
};
const pickCases = Object.entries(sizeSets).flatMap(([name, sizes]) => (["data", "witness"] as const).map((kind) => ({ name, sizes, kind, result: pickSize(sizes, kind) ?? null })));

type Avail = { provider: string; region: RegionInfo; data?: SizeOption; witness?: SizeOption };
const avail = (provider: string, sizesName = provider, filter?: (r: RegionInfo) => boolean): Avail[] =>
  regions[provider].filter((r) => !filter || filter(r)).map((region) => ({ provider, region, data: pickSize(sizeSets[sizesName], "data"), witness: pickSize(sizeSets[sizesName], "witness") }));
const scenarios: Record<string, Avail[]> = {
  alles: [...avail("scaleway"), ...avail("hetzner"), ...avail("upcloud")],
  hetzner: avail("hetzner"),
  scaleway: avail("scaleway"),
  upcloud: avail("upcloud"),
  "scaleway+hetzner": [...avail("scaleway"), ...avail("hetzner")],
  "hetzner+upcloud": [...avail("hetzner"), ...avail("upcloud")],
  "een-nl": avail("scaleway", "scaleway", (r) => r.id === "nl-ams-1"),
  "nl+fi": [...avail("scaleway", "scaleway", (r) => r.country === "NL"), ...avail("hetzner", "hetzner", (r) => r.country === "FI")],
  "zonder-witness": [...avail("scaleway"), ...avail("hetzner")].map((a) => ({ ...a, witness: undefined })),
  leeg: [],
  // Gemengde aanbieders uit het adapter-raamwerk (Exoscale en OVHcloud, met en zonder prijzen).
  exoscale: avail("exoscale"),
  ovh: avail("ovh"),
  "exoscale+ovh": [...avail("exoscale"), ...avail("ovh")],
  "scaleway+exoscale": [...avail("scaleway"), ...avail("exoscale")],
  "ovh+hetzner+scaleway": [...avail("ovh"), ...avail("hetzner"), ...avail("scaleway")],
  alle: [...avail("scaleway"), ...avail("hetzner"), ...avail("upcloud"), ...avail("exoscale"), ...avail("ovh")],
  "nl-alleen-scaleway+ovh": [...avail("scaleway", "scaleway", (r) => r.country === "NL"), ...avail("ovh")],
};
const presets = Object.entries(scenarios).map(([name, available]) => ({ name, available, presets: buildPresets(available) }));

// fetchSizes tegen vaste API-antwoorden.
const apiResponses = {
  hetzner: { server_types: [
    { name: "cx23", cores: 2, memory: 4, architecture: "x86", deprecation: null, prices: [{ location: "fsn1", price_monthly: { gross: "4.5100" } }, { location: "hel1", price_monthly: { gross: "4.5100" } }] },
    { name: "cx11", cores: 1, memory: 2, architecture: "x86", deprecation: { announced: "2024" }, prices: [{ location: "fsn1", price_monthly: { gross: "3.2900" } }] },
    { name: "cax11", cores: 2, memory: 4, architecture: "arm", deprecation: null, prices: [{ location: "fsn1", price_monthly: { gross: "3.7900" } }] },
    { name: "cpx11", cores: 2, memory: 2, architecture: "x86", prices: [{ location: "fsn1", price_monthly: { gross: "5.1800" } }] },
    { name: "cx53", cores: 16, memory: 32, architecture: "x86", prices: [{ location: "nbg1", price_monthly: { gross: "35.0000" } }] },
    { name: "half", cores: 1, memory: 0.5, architecture: "x86", prices: [{ location: "fsn1", price_monthly: { gross: "1.0000" } }] },
  ] },
  scaleway: { servers: {
    "DEV1-S": { arch: "x86_64", ncpus: 2, ram: 2147483648, monthly_price: 6.42, hourly_price: 0.0088 },
    "DEV1-M": { arch: "x86_64", ncpus: 3, ram: 4294967296, hourly_price: 0.0176 },
    "STARDUST1-S": { arch: "x86_64", ncpus: 1, ram: 1073741824, hourly_price: 0.00015 },
    "PRO2-XXS": { arch: "x86_64", ncpus: 2, ram: 8589934592 },
    "AMP2-C1": { arch: "arm64", ncpus: 1, ram: 2147483648, monthly_price: 5 },
    "ENT1-S": { arch: "x86_64", ncpus: 8, ram: 34359738368, monthly_price: 200 },
    "play2-nano": { arch: "x86_64", ncpus: 2, ram: 3221225472, monthly_price: 0 },
    "GP1-XS": { arch: "x86_64", ncpus: 4, ram: 17179869184, monthly_price: null, hourly_price: 0.091 },
  } },
  upcloud: { plans: { plan: [
    { name: "2xCPU-4GB", core_number: 2, memory_amount: 4096 },
    { name: "1xCPU-1GB", core_number: 1, memory_amount: 1024 },
    { name: "DEV-1xCPU-1GB", core_number: 1, memory_amount: 1024 },
    { name: "1xCPU-2GB", core_number: 1, memory_amount: 2048 },
    { name: "4xCPU-4GB", core_number: 4, memory_amount: 4096 },
    { name: "1xCPU-1GB", core_number: 1, memory_amount: 1536 },
  ] } },
  exoscale: { "instance-types": [
    { id: "it-micro", family: "standard", size: "micro", cpus: 1, memory: 536870912, authorized: true, zones: ["at-vie-1", "ch-gva-2"] },
    { id: "it-tiny", family: "standard", size: "tiny", cpus: 1, memory: 1073741824, authorized: true },
    { id: "it-small", family: "standard", size: "small", cpus: 2, memory: 2147483648, authorized: true, zones: ["at-vie-1", "ch-gva-2"] },
    { id: "it-medium", family: "standard", size: "medium", cpus: 2, memory: 4294967296, zones: ["at-vie-1", "ch-gva-2"] },
    { id: "it-medium4", family: "standard", size: "medium-4", cpus: 4, memory: 4294967296, authorized: true },
    { id: "it-odd", family: "standard", size: "odd", cpus: 2, memory: 3000000000, authorized: true },
    { id: "it-large", family: "standard", size: "large", cpus: 4, memory: 8589934592, authorized: false },
    { id: "it-gpu", family: "gpu", size: "small", cpus: 12, memory: 60129542144, authorized: true },
    { id: "it-ch", family: "standard", size: "huge", cpus: 8, memory: 34359738368, authorized: true, zones: ["ch-gva-2"] },
  ] },
  ovhTime: 1760000000,
  ovhFlavors: [
    { id: "fl-d2-2", name: "d2-2", ram: 2, vcpus: 1, osType: "linux", available: true, planCodes: { hourly: "d2-2.consumption", monthly: "d2-2.monthly" } },
    { id: "fl-b3-8", name: "b3-8", ram: 8, vcpus: 2, osType: "linux", available: true, planCodes: { hourly: "b3-8.consumption" } },
    { id: "fl-d2-4", name: "d2-4", ram: 4, vcpus: 2, osType: "linux", available: true, planCodes: { hourly: "onbekend" } },
    { id: "fl-c3-4", name: "C3-4", ram: 4, vcpus: 2, available: true, planCodes: { hourly: "c3-4.consumption", monthly: null } },
    { id: "fl-r3-16", name: "r3-16", ram: 16, vcpus: 2, osType: "linux", planCodes: { hourly: null } },
    { id: "fl-win", name: "win-b2-7", ram: 7, vcpus: 2, osType: "windows", available: true },
    { id: "fl-gpu", name: "t1-45", ram: 45, vcpus: 8, osType: "linux", available: true },
    { id: "fl-weg", name: "d2-8", ram: 8, vcpus: 4, osType: "linux", available: false },
  ],
  ovhCatalog: { addons: [
    { planCode: "d2-2.consumption", pricings: [{ price: 1000000 }, { price: 5 }] },
    { planCode: "b3-8.consumption", pricings: [{ price: 4000000 }] },
    { planCode: "c3-4.consumption", pricings: [{ price: 2345678 }] },
    { planCode: "leeg", pricings: [] },
  ] },
};
const realFetch = globalThis.fetch;
const fetchSizesOut: { provider: string; region: string; result: unknown }[] = [];
globalThis.fetch = (async (url: string) => {
  const u = String(url);
  const body = u.includes("hetzner") ? apiResponses.hetzner : u.includes("scaleway") ? apiResponses.scaleway : u.includes("exoscale") ? apiResponses.exoscale
    : u.includes("/auth/time") ? apiResponses.ovhTime : u.includes("/order/catalog/") ? apiResponses.ovhCatalog : u.includes("ovh") ? apiResponses.ovhFlavors : apiResponses.upcloud;
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;
/** Inloggegevens voor alle aanbieders tegelijk (elke adapter pakt de zijne). */
const sizeCfg = { token: "t", secretKey: "s", apiKey: "EXOk", apiSecret: "geheim", appKey: "ak", appSecret: "as", consumerKey: "ck", projectId: "p" };
for (const [provider, region] of [["hetzner", "fsn1"], ["hetzner", "nbg1"], ["hetzner", "hel1"], ["scaleway", "nl-ams-1"], ["upcloud", "nl-ams1"], ["exoscale", "at-vie-1"], ["exoscale", "ch-gva-2"], ["exoscale", "de-fra-1"], ["ovh", "GRA11"], ["local", "ams"], ["onbekend", "x"], ["desec", "x"]]) {
  fetchSizesOut.push({ provider, region, result: await fetchSizes(provider, sizeCfg, region) });
}

// DNS: notatie (TXT/MX) en de verzoeken van Scaleway DNS (één PATCH per naam en type).
const dnsValues = ['"v=spf1 a:mail.vanes.nl -all"', '"v=DKIM1; k=rsa; p=AAA" "BBB"', '"a"  "b" "c"', "zonder aanhalingstekens", '""', '"\\"x\\""', "10 mail.vanes.nl.", " 20  mx.example.org ", "mail.vanes.nl.", "0 .", "abc 10 x"];
const dnsFormat = dnsValues.map((v) => ({ value: v, unquoted: unquoteTxt(v), mx: parseMx(v) }));
const scwBodies: unknown[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => { scwBodies.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as typeof fetch;
const scwCalls: [string, string, string[], number][] = [
  ["", "MX", ["10 mail.vanes.nl.", "20 backup.vanes.nl"], 3600],
  ["", "TXT", ['"v=spf1 a:mail.vanes.nl -all"'], 3600],
  ["eigen._domainkey", "TXT", ['"v=DKIM1; k=rsa; p=AAA" "BBB"'], 300],
  ["cloud", "A", ["192.0.2.1", "192.0.2.2"], 60],
  ["cloud", "AAAA", [], 300],
  ["mail", "AAAA", ["2001:db8::1"], 300],
];
const scwDns = new ScalewayDns("scw", { secretKey: "sk", zone: "vanes.nl" });
for (const [sub, type, values, ttl] of scwCalls) await scwDns.setRecords(sub, type, values, ttl);
const scalewayDns = scwCalls.map(([sub, type, values, ttl], i) => ({ sub, type, values, ttl, body: scwBodies[i] }));

// Ondertekening van Exoscale en OVHcloud (Java moet precies dezelfde headers maken).
const signatures = {
  exo: [
    ["GET", "https://api-de-fra-1.exoscale.com/v2/template?visibility=public", ""],
    ["POST", "https://api-ch-gva-2.exoscale.com/v2/instance", JSON.stringify({ name: "eigen-n-1", "user-data": "IyEvYmluL2Jhc2g=", labels: { cluster: "é" } })],
    ["GET", "https://api-at-vie-1.exoscale.com/v2/instance?b=2&a=1&c=x%20y", ""],
    ["DELETE", "https://api-bg-sof-1.exoscale.com/v2/instance/abc-123", ""],
    ["get", "http://127.0.0.1:8080/exo/ch-dk-2/v2/dns-domain/d-1/record?z=%C3%BC&a=", ""],
  ].map(([method, url, body]) => ({ method, url, body, key: "EXOabc", secret: "geheim-ü", expires: 1760000600, header: exoSign(method, url, body, "EXOabc", "geheim-ü", 1760000600) })),
  ovh: [
    ["GET", "https://eu.api.ovh.com/1.0/cloud/project/p-1/instance", ""],
    ["POST", "https://eu.api.ovh.com/1.0/domain/zone/vanes.nl/record", JSON.stringify({ fieldType: "TXT", subDomain: "", target: '"v=spf1 -all"', ttl: 3600 })],
    ["get", "https://eu.api.ovh.com/1.0/domain/zone/vanes.nl/record?fieldType=A&subDomain=cloud", ""],
  ].map(([method, url, body]) => ({ method, url, body, appSecret: "as-ü", consumerKey: "ck", ts: 1760000123, signature: ovhSign("as-ü", "ck", method, url, body, 1760000123) })),
};

// Welke velden geheim zijn (maskeren in de console).
const secretFields = [["ovh", "appKey"], ["ovh", "appSecret"], ["ovh", "consumerKey"], ["ovh", "projectId"], ["exoscale", "apiKey"], ["exoscale", "apiSecret"], ["scaleway", "secretKey"], ["scaleway", "projectId"],
  ["hetzner", "token"], ["upcloud", "token"], ["desec", "token"], ["custom", "x"], ["local", "baseDir"], ["onbekend", "password"], ["onbekend", "Consumer"], ["onbekend", "naam"], ["hetzner", "image"]]
  .map(([adapter, key]) => ({ adapter, key, secret: isSecretField(adapter, key) }));
globalThis.fetch = realFetch;

// ───────── Console: herstelblad en checklist (niet geëxporteerd → uit de bron halen) ─────────
const src = fs.readFileSync(path.join(root, "src/console/server.ts"), "utf8");
const start = src.indexOf("function checklist(");
const end = src.indexOf("if (process.argv[1]");
if (start < 0 || end < 0) throw new Error("checklist/recoverySheet niet gevonden in server.ts");
const js = transformSync(src.slice(start, end), { loader: "ts" }).code;
const sheetTime = Date.UTC(2026, 9, 9, 10, 0, 0);
class SheetDate extends RealDate { constructor(...a: unknown[]) { if (a.length) super(...(a as [number])); else super(sheetTime); } }
const consoleFns = new Function("Date", `${js}\nreturn { checklist, recoverySheet };`)(SheetDate) as {
  checklist: (c: unknown) => unknown; recoverySheet: (c: unknown, g: string[], check: string) => string;
};
const groups = (c: { masterKey: string }) => c.masterKey.match(/.{8}/g)!;
const check = (c: { masterKey: string }) => crypto.createHash("sha256").update(c.masterKey).digest("hex").slice(0, 6);
const sheetConfigs = [
  sampleConfig,
  { ...sampleConfig, domain: undefined, cluster: "eigen<&>\"", stores: [] },
  { ...sampleConfig, stores: [{ name: "fs<1>", type: "fs", purpose: "replica", dir: "/data/\"x\"" }] },
];
const sheets = sheetConfigs.map((c) => ({ cfg: c, html: consoleFns.recoverySheet(c, groups(c), check(c)) }));
const dateText = new RealDate(sheetTime).toLocaleDateString("nl-NL", { dateStyle: "long" });
const dates = Array.from({ length: 12 }, (_, m) => { const t = Date.UTC(2025 + (m % 3), m, 1 + m * 2, 23, 30); return { t, text: new RealDate(t).toLocaleDateString("nl-NL", { dateStyle: "long" }) }; });
const checklistConfigs = [
  sampleConfig,
  { ...sampleConfig, stores: [...sampleConfig.stores, { name: "h-backup", type: "s3", purpose: "backup", country: "DE" }], console: { ...sampleConfig.console, dnsMode: "desec", mailRelay: "smtp://x" } },
  { ...sampleConfig, stores: [], policy: { ...DEFAULT_POLICY }, console: { step: "sleutel", done: false, keyConfirmed: false } },
  { ...sampleConfig, stores: [{ name: "a", purpose: "backup" }, { name: "b", purpose: "backup" }] },
];
const checklists = checklistConfigs.map((c) => ({ cfg: c, out: consoleFns.checklist(c) }));

// ───────── Kluis en wachtwoord ─────────
const pbkdf2 = [
  { pass: "correct horse battery staple", salt: "AAECAwQFBgcICQoLDA0ODw==", iter: 1000 },
  { pass: "Wachtwoordzin met één ü en 😀", salt: "8J+YgPCfmIDwn5iA8J+YgA==", iter: 310000 },
  { pass: "ﬁ composé Å", salt: "AAAAAAAAAAAAAAAAAAAAAA==", iter: 2 },
].map((c) => ({ ...c, key: crypto.pbkdf2Sync(c.pass.normalize("NFKC"), Buffer.from(c.salt, "base64"), c.iter, 32, "sha256").toString("hex") }));
const scryptSalt = "00112233445566778899aabbccddeeff";
const realRandom = crypto.randomBytes;
(crypto as { randomBytes: unknown }).randomBytes = (n: number) => (n === 16 ? Buffer.from(scryptSalt, "hex") : realRandom(n));
const passwords = ["geheim-wachtwoord", "één 😀 ü", "x"].map((p) => ({ password: p, salt: scryptSalt, hash: hashPassword(p) }));
(crypto as { randomBytes: unknown }).randomBytes = realRandom;

// ───────── Ondertekening (voorbeeld van TS, Java moet hetzelfde geven bij gelijke ts) ─────────
const proofPayloads = [{ type: "snapshot", params: {} }, { type: "spawn", params: { kind: "witness", n: 1.5, list: [null, true, "é\n"] } }];
const proofs = proofPayloads.map((p) => ({ payload: p, ts: 1760000000123, mac: (() => {
  const r = withFixedDate(1760000000123, () => adminProof(masterKey, p));
  return r.mac;
})() }));

// ───────── Aanbieder: de server van een Dienst, DNS-records en de JSON van /api/aanbieder ─────────
const aanbiederState = {
  step: "klaar", url: "https://dienst.vanes.nl",
  company: { name: "Rene's \"Diensten\" <bv>", address: ["Blaak 10", "3011 TA Rotterdam"], kvk: "12345678", vat: "NL001234567B01", email: "rene@elders.example" },
  accounts: { scalewaySecretKey: "12345678-aaaa-bbbb-cccc-1234567890ab", scalewayOrgId: "87654321-dddd-eeee-ffff-ba0987654321", mollieKey: "live_abcDEF123", desecToken: "desec-tok", openproviderUser: "rene", openproviderPass: "op wacht'woord", adresUrl: "https://adressen.eigencloud.nl" },
  checked: { scaleway: true, mollie: true, desec: true, smtp: true, openprovider: false, adres: true },
  projectId: "proj-1", secret: "ab".repeat(32), createdAt: 1760000000000,
  backup: { endpoint: "https://s3.fr-par.scw.cloud", region: "fr-par", bucket: "vanes-dienst-backup-abc123", accessKey: "SCWBACKUP", secretKey: "backup-geheim", applicationId: "app-1", policyId: "pol-1" },
  server: { provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", serverId: "nl-ams-1/srv-1/ip-1", ipv4: "192.0.2.10", createdAt: 1760000001000 },
  lastHealth: { at: 1760000002000, reachable: true, version: "1.9.0.4", uptime: 120, lastBackupAt: 1760000001500, backup: "aan", closing: false },
};
const withA = (a: unknown, extra: Record<string, unknown> = {}) => ({ ...sampleConfig, ...extra, console: { ...sampleConfig.console, mailRelay: "smtp://proj:geheim@smtp.tem.scaleway.com:587", extraDns: [{ sub: "x._domainkey", type: "TXT", value: "v=DKIM1" }], ...(a ? { aanbieder: a } : {}) } });
const aanbiederConfigs = [
  withA(aanbiederState),
  withA({ ...aanbiederState, accounts: { ...aanbiederState.accounts, smtpUrl: "smtps://post%40vanes.nl:x@mail.vanes.nl", mailFrom: "dienst@vanes.nl", openproviderUser: undefined, adresUrl: undefined }, company: { ...aanbiederState.company, kvk: "", vat: "", address: [] } }),
  withA({ ...aanbiederState, url: "https://dienst.andersdomein.nl", dnsRemove: ["oud"] }),
  withA({ ...aanbiederState, server: null, removed: true, lastHealth: null, retired: ["nl-ams-1/srv-1/ip-1"] }),
  withA({ step: "accounts", company: aanbiederState.company }),
  withA(null),
  withA({ ...aanbiederState, server: { ...aanbiederState.server, ipv6: "2001:db8::1" } }, { domain: undefined }),
  withA({ ...aanbiederState, dnsRemove: ["dienst", "oud"], server: { ...aanbiederState.server, ipv6: "2001:db8::1" } }, { image: { ref: "eigen-cloud:latest", caddyRef: "ghcr.io/x/caddy@sha256:" + "c".repeat(64) } }),
  // Server bij Hetzner, back-ups bij een andere aanbieder (UpCloud), een vervangen Scaleway-server nog op te ruimen.
  withA({ ...aanbiederState, hosting: { provider: "hetzner", region: "fsn1", size: "cx23", monthly: 4.51 }, keys: { hetzner: { token: "hetzner-geheim" } },
    backup: { provider: "upcloud", endpoint: "https://europe-1.upcloudobjects.com", region: "europe-1", country: "NL", bucket: "b-1", accessKey: "UPAK", secretKey: "up-geheim" },
    server: { provider: "hetzner", region: "fsn1", size: "cx23", serverId: "42", ipv4: "192.0.2.20", ipv6: "2001:db8::2", createdAt: 1760000003000 }, retired: [{ provider: "scaleway", serverId: "nl-ams-1/srv-1/ip-1" }] }),
  // Gekozen maar nog niet opgezet: Exoscale, back-ups bij Scaleway (sleutel maakt de console), prijs onbekend.
  withA({ step: "opzetten", company: aanbiederState.company, url: "https://dienst.vanes.nl", hosting: { provider: "exoscale", region: "ch-gva-2", size: "standard.small", monthly: null },
    backup: { provider: "scaleway", endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams", country: "NL" } }),
  // Oude kluis halverwege: stap opzetten zonder keuze gaat terug naar "server".
  withA({ step: "opzetten", company: aanbiederState.company, url: "https://dienst.vanes.nl" }),
  // Eigen S3-opslag (custom) met een onbekende regio.
  withA({ ...aanbiederState, backup: { provider: "custom", endpoint: "https://s3.eigen.example", region: "us-east-1", country: "", bucket: "b-2", accessKey: "a", secretKey: "s" } }),
];
const offers = { serverOffers: () => serverOffers(), storeOffers: () => storeOffers() };
const clean = (x: unknown) => JSON.parse(JSON.stringify(x));
const aanbiederOut = aanbiederConfigs.map((cfg) => {
  const c = clean(cfg);
  // De kluis zoals hij was (oude vorm); view werkt hem bij, Java moet dat net zo doen.
  const before = clean(c);
  const view = aanbieder.view(c, offers);
  const a = c.console.aanbieder;
  let ud: string | null = null;
  try { ud = a?.server ? aanbieder.serverUserData(c, a) : null; } catch (e) { ud = `FOUT ${(e as Error).message}`; }
  return { cfg: before, view, migrated: a ?? null, settings: consoleSettings(c), userData: ud };
});
const dienstInits = [
  { host: "dienst.vanes.nl", email: "rene@elders.example", env: [["A", "x y 'z' \\n $HOME"], ["B_2", ""]], appImage: "ghcr.io/renevanes/eigen-cloud:latest", caddyImage: "ghcr.io/renevanes/eigen-caddy:latest", appRef: "ghcr.io/renevanes/eigen-cloud:latest", caddyRef: "ghcr.io/renevanes/eigen-caddy:latest" },
  { host: "d.example.org", email: "a@b.c", env: [], appImage: "eigen-cloud:1", caddyImage: "caddy:2", appRef: "eigen-cloud:1", caddyRef: "caddy:2" },
] as const;
const dienstUserDataOut = dienstInits.map((o) => ({ o, out: dienstUserData(o as never) }));
const urlCases = ["dienst.vanes.nl", " HTTPS://Dienst.Vanes.NL/ ", "http://dienst.vanes.nl", "https://dienst.vanes.nl/pad", "https://dienst.vanes.nl:8443", "https://u:p@d.nl", "localhost", "https://d.nl?x=1"]
  .map((input) => { try { return { input, out: aanbieder.cleanUrl(input) }; } catch (e) { return { input, error: (e as Error).message }; } });
const smtpCases = ["smtp://user%40x.nl:geheim@smtp.example.org:587", "smtps://mail.example.org", "smtp://127.0.0.1:2525", "", "geen url"].map((input) => ({ input, out: aanbieder.smtpDisplay(input) }));

// ───────── Kosten en budget (src/cluster/costs.ts, src/console/costs.ts) ─────────
const costCatalog = {
  scaleway: { "nl-ams-1": { data: { size: "DEV1-S", label: "2 vCPU, 2 GB", ramGb: 2, cpus: 2, monthly: 6.42 }, witness: { size: "STARDUST1-S", label: "1 vCPU, 1 GB", ramGb: 1, cpus: 1, monthly: 0.1 } } },
  hetzner: { fsn1: { data: { size: "cx23", label: "2 vCPU, 4 GB", ramGb: 4, cpus: 2, monthly: 4.51 } } },
  exoscale: { "ch-gva-2": { data: { size: "standard.small", label: "2 vCPU, 2 GB", ramGb: 2, cpus: 2, monthly: null } } },
};
const costStores = [
  { name: "scaleway-nl-ams", type: "s3", purpose: "replica", country: "NL", endpoint: "https://s3.nl-ams.scw.cloud", region: "nl-ams", bucket: "b1", accessKey: "a", secretKey: "s" },
  { name: "scaleway-fr-par-backup", type: "s3", purpose: "backup", country: "FR", endpoint: "https://s3.fr-par.scw.cloud", region: "fr-par", bucket: "b2", accessKey: "a", secretKey: "s" },
  { name: "hetzner-fsn1", type: "s3", purpose: "replica", country: "DE", endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1", bucket: "b3", accessKey: "a", secretKey: "s" },
  { name: "nas-thuis", type: "fs", purpose: "backup", dir: "/x" },
];
const costCfg = (consolePart: Record<string, unknown>, stores: unknown[] = costStores) => clean({ ...sampleConfig, stores, console: { ...sampleConfig.console, ...consolePart } });
const liveNodes = [
  { id: "n-1", kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", status: "ready", monthly_cost: null },
  { id: "n-2", kind: "data", provider: "hetzner", region: "fsn1", size: "cx23", status: "ready", monthly_cost: 4.99 },
  { id: "n-3", kind: "witness", provider: "scaleway", region: "nl-ams-1", size: "STARDUST1-S", status: "syncing", monthly_cost: null },
  { id: "n-4", kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S", status: "failed", monthly_cost: null },
  { id: "n-5", kind: "witness", provider: "manual", region: null, size: null, status: "ready", monthly_cost: null },
];
const costCases = [
  { name: "wakker", cfg: costCfg({ catalog: costCatalog, budget: 10 }), st: { manifest: null, live: { leader: true, nodes: liveNodes } }, bytes: { "scaleway-nl-ams": 12_345_678_901, "scaleway-fr-par-backup": 3e9, "hetzner-fsn1": 1e9, "nas-thuis": 5 } },
  { name: "boven budget", cfg: costCfg({ catalog: costCatalog, budget: 7.5 }, costStores.slice(0, 2)), st: { manifest: null, live: { leader: true, nodes: liveNodes.slice(0, 1) } }, bytes: { "scaleway-nl-ams": 987_654_321_000, "scaleway-fr-par-backup": 0 } },
  { name: "slaapt", cfg: costCfg({ catalog: costCatalog }), st: { manifest: { state: "asleep", topology: [{ kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S" }] }, live: null }, bytes: { "scaleway-nl-ams": 2e9, "scaleway-fr-par-backup": 1e9, "hetzner-fsn1": null } },
  { name: "onbereikbaar", cfg: costCfg({ catalog: costCatalog, budget: "12,5" }), st: { manifest: { state: "awake", topology: [{ kind: "data", provider: "scaleway", region: "nl-ams-1", size: "DEV1-S" }, { kind: "data", provider: "exoscale", region: "ch-gva-2", size: "standard.small" }] }, live: null }, bytes: {} },
  { name: "nieuw", cfg: costCfg({}, []), st: { manifest: null, live: null }, bytes: {} },
];
const costOffers = { stores: storeOffers(), nameOf: (id: string) => getAdapter(id)?.name ?? id };
const costsOut = {
  compute: costCases.map((x) => ({ ...x, out: costs.compute(x.cfg as never, x.st as never, x.bytes as never, costOffers) })),
  settings: [costCfg({ catalog: costCatalog, budget: 25.5 }), costCfg({ budget: 0 }), costCfg({ catalog: {} })].map((c) => ({ cfg: c, out: consoleSettings(c) })),
  budget: [25, "25", "25,50", " 12.345 ", "0", "-3", "abc", "", null, 1e6].map((input) => ({ input, out: parseBudget(input) })),
};

const out = {
  generated: new RealDate().toISOString(),
  masterKey, derived, derived16, derived64, seals, sealJson: sealJsonOut, rpc, bootstrap,
  json, presign, sign, userData: userDataOut, caddyfile: caddyOut,
  pickSize: pickCases, presets, apiResponses, fetchSizes: fetchSizesOut, dnsFormat, scalewayDns, signatures, secretFields,
  sheets, sheetDateText: dateText, dates, checklists, pbkdf2, passwords, proofs, sampleConfig,
  aanbieder: aanbiederOut, costs: costsOut, dienstUserData: dienstUserDataOut, dienstCheckScript: dienstCheckScript(), updaterScript: updaterScript(), cleanUrl: urlCases, smtpDisplay: smtpCases,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`Golden fixtures: ${path.relative(process.cwd(), outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} kB)`);
