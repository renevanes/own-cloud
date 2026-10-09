import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HetznerProvider, ScalewayProvider, UpCloudProvider } from "../src/cluster/providers.js";
import { DesecDns, HetznerDns } from "../src/cluster/dns.js";
import { userData } from "../src/cluster/cloudinit.js";
import { DEFAULT_POLICY, type ClusterConfig } from "../src/cluster/config.js";
import { S3Store } from "../src/cluster/stores.js";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

function mock(routes: [RegExp, (c: Call) => { status?: number; json?: unknown }][]) {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? "GET", url: String(url), headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: typeof init.body === "string" ? (init.body.startsWith("{") || init.body.startsWith("[") ? JSON.parse(init.body) : init.body) : undefined };
    calls.push(c);
    const r = routes.find(([re]) => re.test(`${c.method} ${c.url}`));
    if (!r) return new Response("niet gemockt", { status: 500 });
    const out = r[1](c);
    const st = out.status ?? 200;
    return new Response(st === 204 ? null : JSON.stringify(out.json ?? {}), { status: st });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

test("Hetzner: server met cloud-init, labels, IPv4+IPv6, prijs en PTR", async () => {
  mock([
    [/POST .*\/v1\/servers$/, () => ({ status: 201, json: { server: { id: 42, public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: { ip: "2a01:4f8::/64" } }, server_type: { prices: [{ location: "fsn1", price_monthly: { gross: "4.5100" } }] } } } })],
    [/POST .*change_dns_ptr/, () => ({ status: 201, json: {} })],
    [/DELETE .*\/servers\/42/, () => ({ json: {} })],
    [/GET .*label_selector/, () => ({ json: { servers: [{ id: 42, labels: { node: "n-1" } }], meta: { pagination: { next_page: null } } } })],
  ]);
  const p = new HetznerProvider({ token: "tok" });
  const info = await p.create({ cluster: "eigen", nodeId: "n-1", kind: "data", region: "fsn1", size: "cx23", userData: "#!/bin/bash" });
  assert.deepEqual(info, { serverId: "42", ipv4: "1.2.3.4", ipv6: "2a01:4f8::1", monthlyCost: 4.51, country: "DE" });
  const body = calls[0].body as Record<string, any>;
  assert.equal(calls[0].headers.authorization, "Bearer tok");
  assert.equal(body.location, "fsn1");
  assert.equal(body.user_data, "#!/bin/bash");
  assert.deepEqual(body.labels, { cluster: "eigen", node: "n-1", kind: "data" });
  await p.setPtr(info, "mail.jouwdomein.nl");
  assert.equal(calls.filter((c) => c.url.includes("change_dns_ptr")).length, 2);
  assert.deepEqual(await p.list("eigen"), [{ serverId: "42", nodeId: "n-1" }]);
  await p.destroy("42");
  assert.equal(p.country("hel1"), "FI");
});

test("Scaleway: IP, image, server, cloud-init, aanzetten; bij fout IP vrijgeven", async () => {
  mock([
    [/POST .*\/ips$/, () => ({ json: { ip: { id: "ip-1", address: "51.15.0.1" } } })],
    [/GET .*local-images/, () => ({ json: { local_images: [{ id: "img-1" }] } })],
    [/POST .*\/servers$/, () => ({ json: { server: { id: "srv-1" } } })],
    [/PATCH .*user_data\/cloud-init/, () => ({ status: 204 })],
    [/POST .*\/action$/, () => ({ status: 202, json: {} })],
  ]);
  const p = new ScalewayProvider({ secretKey: "sk", projectId: "proj" });
  const info = await p.create({ cluster: "eigen", nodeId: "n-2", kind: "data", region: "nl-ams-1", size: "DEV1-S", userData: "#!/bin/bash" });
  assert.deepEqual(info, { serverId: "nl-ams-1/srv-1/ip-1", ipv4: "51.15.0.1", country: "NL" });
  const srv = calls.find((c) => c.url.endsWith("/servers"))!.body as Record<string, any>;
  assert.equal(srv.image, "img-1");
  assert.deepEqual(srv.public_ips, ["ip-1"]);
  assert.equal(calls.find((c) => c.url.includes("cloud-init"))!.body, "#!/bin/bash");
  assert.equal(calls.at(-1)!.body && (calls.at(-1)!.body as any).action, "poweron");

  mock([
    [/POST .*\/ips$/, () => ({ json: { ip: { id: "ip-9", address: "x" } } })],
    [/GET .*local-images/, () => ({ json: { local_images: [] } })],
    [/DELETE .*\/ips\/ip-9/, () => ({ status: 204 })],
  ]);
  await assert.rejects(p.create({ cluster: "eigen", nodeId: "n-3", kind: "data", region: "nl-ams-1", size: "DEV1-S", userData: "" }), /geen image/);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/ips/ip-9")), "IP wordt opgeruimd");
});

test("UpCloud: template opzoeken, server in Amsterdam met user_data", async () => {
  mock([
    [/GET .*\/storage\/template/, () => ({ json: { storages: { storage: [{ title: "Ubuntu Server 24.04 LTS (Noble Numbat)", uuid: "tpl-1" }] } } })],
    [/POST .*\/1\.3\/server$/, () => ({ status: 202, json: { server: { uuid: "u-1", ip_addresses: { ip_address: [{ access: "public", family: "IPv4", address: "94.237.0.1" }, { access: "utility", family: "IPv4", address: "10.0.0.1" }] } } } })],
  ]);
  const p = new UpCloudProvider({ token: "ut" });
  const info = await p.create({ cluster: "eigen", nodeId: "n-4", kind: "witness", region: "nl-ams1", size: "1xCPU-1GB", userData: "#!/bin/bash" });
  assert.equal(info.serverId, "u-1");
  assert.equal(info.ipv4, "94.237.0.1");
  assert.equal(info.country, "NL");
  const body = calls[1].body as any;
  assert.equal(body.server.zone, "nl-ams1");
  assert.equal(body.server.storage_devices.storage_device[0].storage, "tpl-1");
  assert.equal(body.server.user_data, "#!/bin/bash");
});

test("DNS: deSEC (bulk PUT, min. TTL) en Hetzner (set_records, anders aanmaken)", async () => {
  mock([[/PUT .*desec\.io/, () => ({ json: [] })]]);
  await new DesecDns("d", { token: "t", zone: "jouwdomein.nl" }).setRecords("mail", "A", ["1.2.3.4", "5.6.7.8"], 300);
  assert.equal(calls[0].headers.authorization, "Token t");
  assert.deepEqual(calls[0].body, [{ subname: "mail", type: "A", ttl: 3600, records: ["1.2.3.4", "5.6.7.8"] }]);

  mock([
    [/POST .*set_records/, () => ({ status: 404 })],
    [/POST .*\/zones\/jouwdomein\.nl\/rrsets$/, () => ({ status: 201, json: {} })],
  ]);
  await new HetznerDns("h", { token: "t", zone: "jouwdomein.nl" }).setRecords("cloud", "A", ["1.2.3.4"], 300);
  assert.deepEqual(calls[1].body, { name: "cloud", type: "A", ttl: 300, records: [{ value: "1.2.3.4" }] });
});

test("cloud-init bevat geen geheimen", () => {
  const cfg: ClusterConfig = {
    cluster: "eigen", nodeId: "x", kind: "data", masterKey: "a".repeat(64), clusterPort: 7946, advertise: { clusterUrl: "" }, seeds: [], domain: "jouwdomein.nl",
    stores: [{ name: "s", type: "s3", purpose: "replica", endpoint: "https://s3.nl-ams.scw.cloud", bucket: "b", accessKey: "AKIA-GEHEIM", secretKey: "S3-GEHEIM" }],
    providers: { hetzner: { token: "HETZNER-GEHEIM" } }, dns: [{ type: "desec", name: "d", token: "DNS-GEHEIM", zone: "jouwdomein.nl" }],
    image: { ref: "eigen-cloud:1" }, appEnv: { SMTP_RELAY: "smtps://user:RELAY-GEHEIM@x" }, policy: DEFAULT_POLICY,
  };
  const store = new S3Store(cfg.stores[0]);
  const ud = userData(cfg, { nodeId: "n-9", kind: "data", bootstrapUrl: store.presignGet("bootstrap/n-9.enc", 7200), joinToken: "eenmalig" });
  for (const secret of ["a".repeat(64), "S3-GEHEIM", "HETZNER-GEHEIM", "DNS-GEHEIM", "RELAY-GEHEIM"]) assert.ok(!ud.includes(secret), `lekt ${secret}`);
  assert.match(ud, /X-Amz-Expires=7200/);
  assert.match(ud, /JOIN_TOKEN=eenmalig/);
});
