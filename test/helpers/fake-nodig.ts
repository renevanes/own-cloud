/**
 * Nep-aanbieders voor "Wat je nodig hebt" (src/console/benodigdheden.ts): Scaleway (IAM, projecten, TEM), Mollie,
 * deSEC (account, tokens, zones), Openprovider (inloggen, DNS-zones, domeinen, klanten, contactpersonen), een
 * DNS-over-HTTPS-resolver (RFC 8484, binair), de Dienst zelf (/v1/brand, /v1/juridisch, /v1/status/lijst,
 * /v1/status/check/…) en de openbare lijst van aanbieders (/lijst, zoals aanbieders.json op GitHub), plus een
 * SMTP-server met inloggen (zoals smtp.tem.scaleway.com). Eén server, met een voorvoegsel per aanbieder. Voor "Zo gratis
 * mogelijk beginnen" (gratis.ts) ook: UpCloud (/upc: tegoed, formaten, servers weghalen), Exoscale (/exo/<zone>: saldo,
 * formaten), Scaleway-formaten met prijzen en servers maken, mail via de HTTPS-koppeling, en dedyn.io-namen bij deSEC.
 * Wordt gebruikt door test/benodigdheden.test.ts en (via scripts/android-nodig.ts) door de Java-test.
 */
import http from "node:http";
import { SMTPServer } from "smtp-server";

export const ORG = "0rg00000-1111-2222-3333-444444444444".replace("0rg", "0a0");
export const USER = "u0000000-1111-2222-3333-444444444444".replace("u", "0");
export const PERSONAL = { access: "SCWPERSONAL000000001", secret: "11111111-2222-3333-4444-555555555555" };
export const DEFAULT_PROJECT = "9a9a9a9a-0000-1111-2222-333333333333";
/** Het adres en de sleutel van de nep-Dienst (zoals in aanbieders.json). */
export const DIENST_URL = "https://dienst.esape.nl";
export const DIENST_SLEUTEL = "MCowBQYDK2VwAyEA-nep-sleutel";

type Rec = { NS?: string[]; A?: string[]; AAAA?: string[]; DS?: string[]; nx?: boolean };

/** Een echt plaatje met "ABC" (de oplossing van de nep-captcha), zodat het ook in schermafbeeldingen klopt. */
const CAPTCHA_PNG = "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";

export function initialState() {
  return {
    n: 0,
    scw: {
      keys: [{ access_key: PERSONAL.access, secret_key: PERSONAL.secret, user_id: USER, default_project_id: DEFAULT_PROJECT }] as any[],
      applications: [] as any[], policies: [] as any[], projects: [] as any[], tem: [] as any[],
      /** Hoe vaak een nieuwe sleutel nog geweigerd wordt (een nieuwe sleutel werkt bij Scaleway soms pas na een paar seconden). */
      newKeyDelay: 1, refused: new Map<string, number>(),
    },
    mollie: { keys: new Set(["test_abc123", "live_xyz789"]), status: "unverified", first: ["creditcard"], recurring: [] as string[] },
    desec: { confirmed: false, password: "", email: "", tokens: [{ token: "desec-bestaand", id: "t0", perm_manage_tokens: false }] as any[], zones: new Map<string, { keys: any[] }>(), captcha: "abc" },
    op: {
      user: "vanes", pass: "geheim", token: "op-token",
      zones: new Map<string, any[]>(), domains: [] as any[], customers: [] as any[], allow: ["203.0.113.5"] as string[], deny: [] as string[],
      prices: new Map<string, number>([["eigencloud.nl", 7.5], ["nieuw-voorbeeld.nl", 8.25], ["duur.nl", 9.0]]),
      /** Premium-domeinen (andere prijs dan price.reseller). */
      premium: new Set<string>(["duur.nl"]),
      /** Het laatste PUT /contacts/{id} (om te zien dat de rest van de contactpersoon meegaat). */
      contactPut: null as any,
    },
    dns: new Map<string, Rec>(),
    /** UpCloud: token, servers, tegoed in centen (GET /1.3/account → credits). */
    upc: { token: "upc-token", credits: 50000 as number, servers: [] as any[] },
    /** Exoscale: sleutel en saldo (GET /v2/live-balance), servers per zone. */
    exo: { key: "EXOtest", balance: 20 as number, currency: "EUR", instances: [] as any[] },
    /** Scaleway-formaten per zone (GET /instance/v1/zones/{zone}/products/servers) en servers. */
    scwSizes: { "nl-ams-1": 6.42 } as Record<string, number>,
    scwServers: [] as any[], scwIps: [] as any[], temSent: [] as any[],
    /** deSEC, gratis adressen (dedyn.io): bezette namen, hoe lang het maken duurt, en of ze al in de DNS staan. */
    dedyn: { bezet: new Set<string>(["bezet.dedyn.io"]), traagMs: 0, metEen: true },
    /** De Dienst: links naar voorwaarden en privacy, staat hij op de openbare lijst (met de goede sleutel), Openprovider-controle. */
    dienst: { termsUrl: null as string | null, privacyUrl: null as string | null, lijst: { opLijst: false, sleutelKlopt: null as boolean | null }, opCheck: { ok: true, detail: "De server van je Dienst kan bij Openprovider" } },
    calls: [] as string[],
  };
}
export type NodigState = ReturnType<typeof initialState>;

const b32 = (n: number) => String(n).padStart(12, "0");

// ───────── DNS-berichten (binair) ─────────

function encName(name: string) {
  const parts: Buffer[] = [];
  for (const l of name.replace(/\.$/, "").split(".").filter(Boolean)) { const b = Buffer.from(l); parts.push(Buffer.from([b.length]), b); }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function rdata(type: number, v: string) {
  if (type === 1) return Buffer.from(v.split(".").map(Number));
  if (type === 28) {
    const [head, tail] = v.includes("::") ? v.split("::") : [v, ""];
    const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((x) => parseInt(x, 16));
    const b = Buffer.alloc(16); groups.forEach((g, i) => b.writeUInt16BE(g, i * 2)); return b;
  }
  if (type === 2) return encName(v);
  if (type === 43) { const [tag, alg, dt, hex] = v.split(" "); const b = Buffer.alloc(4); b.writeUInt16BE(Number(tag)); b[2] = Number(alg); b[3] = Number(dt); return Buffer.concat([b, Buffer.from(hex, "hex")]); }
  return Buffer.alloc(0);
}
export function dnsAnswer(query: Buffer, st: NodigState) {
  let pos = 12; const labels: string[] = [];
  while (query[pos]) { labels.push(query.subarray(pos + 1, pos + 1 + query[pos]).toString()); pos += 1 + query[pos]; }
  const qtype = query.readUInt16BE(pos + 1);
  const question = query.subarray(12, pos + 5);
  const name = labels.join(".").toLowerCase();
  const rec = st.dns.get(name);
  const key = ({ 1: "A", 2: "NS", 28: "AAAA", 43: "DS" } as Record<number, keyof Rec>)[qtype];
  const vals = rec && !rec.nx && key ? ((rec[key] as string[] | undefined) ?? []) : [];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8180 | (rec?.nx || !rec ? 3 : 0), 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(vals.length, 6);
  const answers = vals.map((v) => {
    const rd = rdata(qtype, v);
    const fixed = Buffer.alloc(12); fixed.writeUInt16BE(0xc00c, 0); fixed.writeUInt16BE(qtype, 2); fixed.writeUInt16BE(1, 4); fixed.writeUInt32BE(300, 6); fixed.writeUInt16BE(rd.length, 10);
    return Buffer.concat([fixed, rd]);
  });
  return Buffer.concat([head, question, ...answers]);
}

// ───────── De server ─────────

export async function fakeNodig() {
  let st = initialState();
  const smtpAuth: string[] = [];
  const smtp = new SMTPServer({ logger: false, disabledCommands: ["STARTTLS"], allowInsecureAuth: true, authMethods: ["PLAIN", "LOGIN"],
    onAuth(auth, _s, cb) { smtpAuth.push(String(auth.username)); return st.scw.projects.some((p) => p.id === auth.username) || auth.username === "relay" ? cb(null, { user: auth.username }) : cb(new Error("Ongeldig")); } });
  const smtpPort = await new Promise<number>((res) => smtp.listen(0, "127.0.0.1", () => res((smtp.server.address() as { port: number }).port)));

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const m0 = /^\/(scw|mollie|desec|op|doh|doh-kapot|dienst|lijst|upc|exo)(\/.*)?$/.exec(u.pathname);
      const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(j === null ? "" : JSON.stringify(j)); };
      if (!m0) return send(404, { error: "onbekend" });
      const [, who, rest = "/"] = m0;
      const p = rest, q = u.searchParams, method = req.method ?? "GET";
      st.calls.push(`${method} /${who}${p}${u.search}`);
      const h = (n: string) => String(req.headers[n] ?? "");
      let m: RegExpExecArray | null;
      // De openbare lijst van aanbieders (aanbieders.json)
      if (who === "lijst") return send(200, [{ naam: "Ander", url: "https://dienst.ander.nl", land: "NL", contact: "a@ander.nl", omschrijving: "", sleutel: "ANDER" },
        ...(st.dienst.lijst.opLijst ? [{ naam: "ESAPE", url: DIENST_URL, land: "NL", contact: "rene@esape.nl", omschrijving: "", sleutel: st.dienst.lijst.sleutelKlopt === false ? "OUDE-SLEUTEL" : DIENST_SLEUTEL }] : [])]);
      // DoH
      if (who === "doh-kapot") return send(500, {});
      if (who === "doh") {
        if (h("accept") !== "application/dns-message") return send(400, {});
        const ans = dnsAnswer(Buffer.from(q.get("dns") ?? "", "base64url"), st);
        res.writeHead(200, { "content-type": "application/dns-message" }); return res.end(ans);
      }
      // UpCloud (/1.3): inloggen, servers, formaten en het tegoed (in centen)
      if (who === "upc") {
        if (h("authorization") !== `Bearer ${st.upc.token}`) return send(401, { error: { error_code: "AUTHENTICATION_FAILED", error_message: "Authentication failed" } });
        if (p === "/account") return send(200, { account: { credits: st.upc.credits, username: "rene", resource_limits: { cores: 2, memory: 4096 } } });
        if (p === "/server" && method === "GET") return send(200, { servers: { server: st.upc.servers.filter((x) => !q.get("label") || x.labels.label.some((l: any) => `${l.key}=${l.value}` === q.get("label"))) } });
        if (p === "/plan") return send(200, { plans: { plan: [
          { name: "1xCPU-1GB", core_number: 1, memory_amount: 1024 }, { name: "1xCPU-2GB", core_number: 1, memory_amount: 2048 },
          { name: "2xCPU-4GB", core_number: 2, memory_amount: 4096 }, { name: "DEV-1xCPU-1GB-10GB", core_number: 1, memory_amount: 1024 },
        ] } });
        if (p === "/storage/template") return send(200, { storages: { storage: [{ uuid: "tpl-noble", title: "Ubuntu Server 24.04 LTS (Noble Numbat)" }] } });
        if (p === "/server" && method === "POST") {
          const x = { uuid: `upc-${++st.n}`, state: "started", title: body.server.title, zone: body.server.zone, plan: body.server.plan, labels: body.server.labels,
            ip_addresses: { ip_address: [{ access: "public", family: "IPv4", address: `198.51.100.${30 + st.upc.servers.length}` }] } };
          st.upc.servers.push(x); return send(202, { server: x });
        }
        if ((m = /^\/server\/([^/]+)\/stop$/.exec(p)) && method === "POST") { const x = st.upc.servers.find((y) => y.uuid === m![1]); if (!x) return send(404, {}); x.state = "stopped"; return send(200, { server: x }); }
        if ((m = /^\/server\/([^/]+)$/.exec(p))) {
          const i = st.upc.servers.findIndex((y) => y.uuid === m![1]);
          if (i < 0) return send(404, { error: { error_code: "SERVER_NOT_FOUND" } });
          if (method === "DELETE") { st.upc.servers.splice(i, 1); return send(204, null); }
          return send(200, { server: st.upc.servers[i] });
        }
        return send(599, { error: `nep-UpCloud kent ${method} ${p} niet` });
      }
      // Exoscale (/v2 per zone: /exo/<zone>/…): servers, formaten en het saldo
      if (who === "exo") {
        if (!/^EXO2-HMAC-SHA256 credential=EXOtest,/.test(h("authorization"))) return send(403, { message: "Invalid request signature" });
        const mz = /^\/([a-z0-9-]+)(\/.*)$/.exec(p);
        if (!mz) return send(404, {});
        const [, zone, ep] = mz;
        if (ep === "/live-balance") return send(200, { balance: st.exo.balance, currency: st.exo.currency });
        if (ep === "/instance" && method === "GET") return send(200, { instances: st.exo.instances.filter((x) => x.zone === zone) });
        if (ep === "/instance-type") return send(200, { "instance-types": [
          { id: "t-micro", family: "standard", size: "micro", cpus: 1, memory: 536870912, authorized: true },
          { id: "t-small", family: "standard", size: "small", cpus: 2, memory: 2147483648, authorized: true },
          { id: "t-medium", family: "standard", size: "medium", cpus: 2, memory: 4294967296, authorized: true },
        ] });
        if ((m = /^\/instance\/([^/]+)$/.exec(ep)) && method === "DELETE") { st.exo.instances = st.exo.instances.filter((x) => x.id !== m![1]); return send(200, { id: "op", state: "success" }); }
        return send(599, { message: `nep-Exoscale kent ${method} ${ep} niet` });
      }
      // Scaleway
      if (who === "scw") {
        const key = st.scw.keys.find((k) => k.secret_key === h("x-auth-token"));
        if (key) {
          const left = st.scw.refused.get(key.secret_key) ?? 0;
          if (left > 0 && p === "/account/v3/projects") { st.scw.refused.set(key.secret_key, left - 1); return send(401, { message: "authentication is denied" }); }
        }
        if (!key) return send(401, { message: "authentication is denied" });
        if ((m = /^\/iam\/v1alpha1\/api-keys\/([^/]+)$/.exec(p))) {
          const k = st.scw.keys.find((x) => x.access_key === m![1]);
          if (!k) return send(404, { message: "not found" });
          if (method === "DELETE") { st.scw.keys = st.scw.keys.filter((x) => x !== k); return send(204, null); }
          const { secret_key, ...pub } = k; void secret_key; return send(200, pub);
        }
        if (p === "/iam/v1alpha1/api-keys" && method === "POST") {
          const n = ++st.n;
          const k = { access_key: `SCWAPP${String(n).padStart(14, "0")}`, secret_key: `aaaaaaaa-bbbb-cccc-dddd-${b32(n)}`, application_id: body.application_id, default_project_id: body.default_project_id ?? DEFAULT_PROJECT, description: body.description };
          st.scw.keys.push(k); st.scw.refused.set(k.secret_key, st.scw.newKeyDelay);
          return send(200, k);
        }
        if ((m = /^\/iam\/v1alpha1\/users\/([^/]+)$/.exec(p))) return m[1] === USER ? send(200, { id: USER, organization_id: ORG, email: "rene@esape.nl", type: "owner" }) : send(404, {});
        if ((m = /^\/iam\/v1alpha1\/applications\/([^/]+)$/.exec(p))) { const a = st.scw.applications.find((x) => x.id === m![1]); return a ? send(200, a) : send(404, {}); }
        if (p === "/iam/v1alpha1/applications") {
          if (method === "GET") return send(200, { applications: st.scw.applications.filter((x) => x.organization_id === q.get("organization_id") && (!q.get("name") || x.name === q.get("name"))) });
          const a = { id: `app-${++st.n}`, ...body }; st.scw.applications.push(a); return send(200, a);
        }
        if (p === "/iam/v1alpha1/policies") {
          // Zoals de echte API: filteren op application_ids (application_id kent hij niet).
          if (method === "GET") return send(200, { policies: st.scw.policies.filter((x) => !q.get("application_ids") || x.application_id === q.get("application_ids")).map(({ rules, ...x }) => (void rules, x)) });
          const pol = { id: `pol-${++st.n}`, ...body }; st.scw.policies.push(pol); return send(200, (({ rules, ...x }) => (void rules, x))(pol));
        }
        if (p === "/iam/v1alpha1/rules") {
          const pol = st.scw.policies.find((x) => x.id === (method === "GET" ? q.get("policy_id") : body?.policy_id));
          if (!pol) return send(404, {});
          if (method === "PUT") pol.rules = body.rules;
          return send(200, { rules: pol.rules ?? [] });
        }
        if (p === "/account/v3/projects") {
          if (method === "GET") return send(200, { projects: st.scw.projects.filter((x) => !q.get("name") || x.name === q.get("name")), total_count: st.scw.projects.length });
          const x = { id: `proj${String(++st.n).padStart(4, "0")}-0000-1111-2222-333333333333`, ...body }; st.scw.projects.push(x); return send(200, x);
        }
        // Instances: formaten met prijzen per zone, en servers maken (zoals ScalewayProvider.create)
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/products\/servers$/.exec(p))) {
          const dev = st.scwSizes[m[1]] ?? 6.57;
          return send(200, { servers: {
            "STARDUST1-S": { ncpus: 1, ram: 1073741824, arch: "x86_64", monthly_price: 0.11 },
            "DEV1-S": { ncpus: 2, ram: 2147483648, arch: "x86_64", monthly_price: dev },
            "PLAY2-PICO": { ncpus: 1, ram: 2147483648, arch: "x86_64", monthly_price: 10.44 },
            "DEV1-M": { ncpus: 3, ram: 4294967296, arch: "x86_64", monthly_price: 14.75 },
          } });
        }
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/ips$/.exec(p)) && method === "POST") { const x = { id: `ip-${++st.n}`, address: `192.0.2.${10 + st.scwIps.length}`, zone: m[1] }; st.scwIps.push(x); return send(201, { ip: x }); }
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/ips\/([^/]+)$/.exec(p)) && method === "DELETE") { st.scwIps = st.scwIps.filter((x) => x.id !== m![2]); return send(204, null); }
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/servers$/.exec(p))) {
          if (method === "GET") return send(200, { servers: st.scwServers.filter((x) => x.zone === m![1]) });
          const x = { id: `srv-${++st.n}`, zone: m[1], state: "stopped", ...body, public_ips: (body.public_ips ?? []).map((i: string) => ({ id: i })) }; st.scwServers.push(x); return send(201, { server: x });
        }
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/servers\/([^/]+)\/user_data\/([^/]+)$/.exec(p))) return send(204, null);
        if ((m = /^\/instance\/v1\/zones\/([^/]+)\/servers\/([^/]+)\/action$/.exec(p))) { const x = st.scwServers.find((y) => y.id === m![2]); if (!x) return send(404, {}); x.state = body.action === "poweron" ? "running" : x.state; return send(202, { task: { id: "t" } }); }
        if (p === "/marketplace/v2/local-images") return send(200, { local_images: [{ id: `img-${q.get("zone")}`, label: q.get("image_label") }] });
        if (p === "/transactional-email/v1alpha1/regions/fr-par/emails" && method === "POST") { st.temSent.push(body); return send(200, { emails: [{ id: `mail-${st.temSent.length}` }] }); }
        const tem = "/transactional-email/v1alpha1/regions/fr-par/domains";
        if (p === tem) {
          if (method === "GET") return send(200, { domains: st.scw.tem.filter((d) => d.project_id === q.get("project_id") && (!q.get("name") || d.name === q.get("name"))) });
          const d = body.domain_name;
          const x = { id: `tem-${++st.n}`, name: d, project_id: body.project_id, status: "pending",
            records: { spf: { name: d, value: "v=spf1 include:_spf.tem.scaleway.com -all" }, dkim: { name: `${body.project_id}._domainkey.${d}`, value: "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq" }, dmarc: { name: `_dmarc.${d}`, value: "v=DMARC1; p=none" } } };
          st.scw.tem.push(x); return send(200, x);
        }
        if ((m = new RegExp(`^${tem}/([^/]+)(/check)?$`).exec(p))) { const d = st.scw.tem.find((x) => x.id === m![1]); return d ? send(200, d) : send(404, {}); }
        return send(599, { message: `nep-Scaleway kent ${method} ${p} niet` });
      }
      // Mollie
      if (who === "mollie") {
        const key = h("authorization").replace(/^Bearer /, "");
        if (!st.mollie.keys.has(key)) return send(401, { status: 401, title: "Unauthorized Request" });
        const mode = key.startsWith("live_") ? "live" : "test";
        if (p === "/profiles/me") return send(200, { resource: "profile", id: "pfl_1", mode, name: "ESAPE", website: "https://esape.nl", status: st.mollie.status, _links: { dashboard: { href: "https://my.mollie.com/dashboard/org_1/settings/profiles/pfl_1", type: "text/html" } } });
        if (p === "/methods") return send(200, { count: 1, _embedded: { methods: (q.get("sequenceType") === "recurring" ? st.mollie.recurring : st.mollie.first).map((id) => ({ resource: "method", id, description: id })) } });
        return send(599, {});
      }
      // deSEC
      if (who === "desec") {
        if (p === "/captcha/" && method === "POST") return send(200, { id: "cap-1", challenge: CAPTCHA_PNG, kind: "image" });
        if (p === "/auth/" && method === "POST") {
          if (body?.captcha?.solution !== st.desec.captcha) return send(400, { captcha: ["Wrong captcha"] });
          st.desec.email = body.email; st.desec.password = body.password; return send(202, { detail: "Welcome!" });
        }
        if (p === "/auth/login/" && method === "POST") {
          if (!st.desec.confirmed || body?.email !== st.desec.email || body?.password !== st.desec.password) return send(403, { detail: "Invalid credentials" });
          return send(200, { id: "login", token: "desec-login-token" });
        }
        const tok = h("authorization").replace(/^Token /, "");
        const known = tok === "desec-login-token" ? { perm_manage_tokens: true } : st.desec.tokens.find((t) => t.token === tok);
        if (!known) return send(401, { detail: "Invalid token." });
        if (p === "/auth/tokens/" && method === "POST") {
          if (!known.perm_manage_tokens) return send(403, {});
          const t = { id: `tok-${++st.n}`, token: `desec-${body.name}-${st.n}`, ...body }; st.desec.tokens.push(t); return send(201, t);
        }
        if (p === "/domains/" && method === "GET") return send(200, [...st.desec.zones.keys()].map((name) => ({ name })));
        if (p === "/domains/" && method === "POST") {
          const name = String(body?.name ?? "");
          if (name.endsWith(".dedyn.io")) {
            // Zoals deSEC: één naam direct onder dedyn.io per account; een bezette naam geeft 400. Het maken kan even duren.
            if (st.dedyn.bezet.has(name)) return send(400, { name: ["This domain name conflicts with an existing zone, or is disallowed by policy."] });
            if (st.dedyn.metEen && [...st.desec.zones.keys()].some((z) => z.endsWith(".dedyn.io"))) return send(400, { detail: "You reached the maximum number of domains allowed for your account." });
            return void setTimeout(() => { st.desec.zones.set(name, { keys: [{ dnskey: "257 3 13 QUJDREVG", ds: ["12345 13 2 aabbccdd"], managed: true }] }); send(201, { name }); }, st.dedyn.traagMs);
          }
          st.desec.zones.set(name, { keys: [{ dnskey: "257 3 13 QUJDREVG", ds: ["12345 13 2 aabbccdd"], managed: true }] }); return send(201, { name });
        }
        if ((m = /^\/domains\/([^/]+)\/$/.exec(p))) { const z = st.desec.zones.get(m[1]); return z ? send(200, { name: m[1], keys: z.keys }) : send(404, { detail: "Not found." }); }
        if ((m = /^\/domains\/([^/]+)\/rrsets\/$/.exec(p)) && method === "PUT") return send(200, body);
        return send(599, {});
      }
      // Openprovider
      if (who === "op") {
        if (p === "/auth/login" && method === "POST") return body?.username === st.op.user && body?.password === st.op.pass ? send(200, { code: 0, data: { token: st.op.token, reseller_id: 1 } }) : send(200, { code: 196, desc: "Authentication/Authorization Failed" });
        if (h("authorization") !== `Bearer ${st.op.token}`) return send(401, { code: 196, desc: "Authentication/Authorization Failed" });
        if ((m = /^\/dns\/zones\/([^/]+)\/records$/.exec(p))) { const z = st.op.zones.get(m[1]); return z ? send(200, { code: 0, data: { results: z.filter((r) => !q.get("type") || r.type === q.get("type")), total: z.length } }) : send(404, { code: 871, desc: "Zone not found" }); }
        if ((m = /^\/dns\/zones\/([^/]+)$/.exec(p))) {
          const z = st.op.zones.get(m[1]);
          if (!z) return send(404, { code: 871, desc: "Zone not found" });
          if (method === "PUT") {
            for (const r of body?.records?.remove ?? []) { const i = z.findIndex((x) => x.name === (r.name ? `${r.name}.${m![1]}` : m![1]) && x.type === r.type && x.value === r.value); if (i >= 0) z.splice(i, 1); }
            for (const r of body?.records?.add ?? []) z.push({ ...r, name: r.name ? `${r.name}.${m[1]}` : m[1] });
            return send(200, { code: 0, data: { success: true } });
          }
          return send(200, { code: 0, data: { name: m[1], records: z } });
        }
        if (p === "/dns/zones" && method === "POST") { const n = `${body.domain.name}.${body.domain.extension}`; st.op.zones.set(n, []); return send(200, { code: 0, data: { id: 1, success: true } }); }
        if (p === "/domains" && method === "GET") return send(200, { code: 0, data: { results: st.op.domains.filter((d) => `${d.domain.name}.${d.domain.extension}` === q.get("full_name")), total: 0 } });
        if (p === "/domains" && method === "POST") {
          const d = { id: 1000 + (++st.n), ...body }; st.op.domains.push(d);
          const n = `${body.domain.name}.${body.domain.extension}`;
          st.dns.set(n, { NS: (body.name_servers ?? []).map((x: { name: string }) => x.name) });
          return send(200, { code: 0, data: { id: d.id, status: "ACT" } });
        }
        if ((m = /^\/domains\/(\d+)$/.exec(p)) && method === "PUT") {
          const d = st.op.domains.find((x) => String(x.id) === m![1]); if (!d) return send(404, { code: 320, desc: "Domain not found" });
          Object.assign(d, body);
          const n = `${d.domain.name}.${d.domain.extension}`;
          st.dns.set(n, { ...(st.dns.get(n) ?? {}), NS: (body.name_servers ?? []).map((x: { name: string }) => x.name), ...(body.is_dnssec_enabled ? { DS: ["12345 13 2 aabbccdd"] } : {}) });
          return send(200, { code: 0, data: { status: "ACT" } });
        }
        if (p === "/domains/check" && method === "POST") {
          const d = body.domains[0], n = `${d.name}.${d.extension}`, price = st.op.prices.get(n), premium = st.op.premium.has(n);
          return send(200, { code: 0, data: { results: [{ domain: n, status: price !== undefined && !st.op.domains.some((x) => `${x.domain.name}.${x.domain.extension}` === n) ? "free" : "active", is_premium: premium,
            ...(price !== undefined ? { price: { reseller: { currency: "EUR", price } } } : {}), ...(premium ? { premium: { currency: "EUR", price: { create: 2500, renew: 2500 } } } : {}) }] } });
        }
        if (p === "/customers" && method === "GET") return send(200, { code: 0, data: { results: st.op.customers.filter((x) => x.email === q.get("email_pattern")), total: 0 } });
        if (p === "/customers" && method === "POST") { const x = { handle: `VE${String(++st.n).padStart(6, "0")}-NL`, ...body }; st.op.customers.push(x); return send(200, { code: 0, data: { handle: x.handle } }); }
        if (p === "/contacts" && method === "GET") return send(200, { code: 0, data: { results: [{ id: 77, username: st.op.user, email: "rene@esape.nl", name: { first_name: "Rene", last_name: "van Es" }, role: "admin", api_access_enabled: true,
          last_login_at: "2026-10-01 10:00:00", api_client_ip_list: { allow: st.op.allow, deny: st.op.deny }, rcp_client_ip_list: { allow: [], deny: [] } }], total: 1 } });
        if ((m = /^\/contacts\/(\d+)$/.exec(p)) && method === "PUT") { st.op.contactPut = body; st.op.allow = body.api_client_ip_list.allow; st.op.deny = body.api_client_ip_list.deny; return send(200, { code: 0, data: { success: true } }); }
        return send(599, { code: 1, desc: `nep-Openprovider kent ${method} ${p} niet` });
      }
      // De Dienst
      if (who === "dienst") {
        if (p === "/v1/brand") return send(200, { name: "ESAPE", termsUrl: st.dienst.termsUrl, privacyUrl: st.dienst.privacyUrl });
        if (p === "/v1/status") return send(200, { version: "1.17", uptime: 7200, lastBackupAt: Date.now() - 600_000, backup: "aan", closing: false });
        if (p === "/v1/juridisch") return send(200, { documents: st.dienst.termsUrl ? [{ kind: "voorwaarden", title: "Algemene voorwaarden", url: st.dienst.termsUrl, version: 1, updatedAt: 1760000000000 }] : [] });
        if (!/^Beheer [0-9a-f]{64}$/.test(h("authorization"))) return send(401, { error: "Geen toegang" });
        if (p === "/v1/status/lijst") return send(200, { entry: { naam: "ESAPE", url: DIENST_URL, land: "NL", contact: "rene@esape.nl", omschrijving: "", sleutel: DIENST_SLEUTEL }, opLijst: st.dienst.lijst.opLijst, voorwaarden: { termsUrl: st.dienst.termsUrl, privacyUrl: st.dienst.privacyUrl } });
        if (p === "/v1/status/check/openprovider") return send(200, { ...st.dienst.opCheck, ingesteld: true });
        if (p === "/v1/status/handover" && method === "POST") return send(200, { ok: true, lastBackupAt: 1760000000000 });
        if (p === "/v1/status/overzicht") return send(200, { klanten: 3, actief: 2, omzetMaand: { net: 23.98, count: 2 }, openHulpvragen: 0, achterstanden: 0 });
        return send(404, { error: "Niet gevonden" });
      }
      return send(404, {});
    });
  });
  const port = await new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as { port: number }).port)));
  const base = `http://127.0.0.1:${port}`;
  return {
    get st() { return st; },
    reset() { st = initialState(); smtpAuth.length = 0; },
    base, smtpPort, smtpAuth,
    env: { EIGEN_SCW_API: `${base}/scw`, EIGEN_MOLLIE_URL: `${base}/mollie`, EIGEN_DESEC_URL: `${base}/desec`, EIGEN_OPENPROVIDER_URL: `${base}/op`, EIGEN_DOH_URLS: `${base}/doh-kapot,${base}/doh`, EIGEN_TEM_SMTP: `127.0.0.1:${smtpPort}`, EIGEN_AANBIEDERS_URL: `${base}/lijst`,
      EIGEN_UPCLOUD_API: `${base}/upc`, EIGEN_EXO_API: `${base}/exo/{zone}` },
    dienst: `${base}/dienst`,
    close: () => Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => smtp.close(() => r()))]),
  };
}
