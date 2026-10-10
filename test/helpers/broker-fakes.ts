/** Nep-mailserver en nep-Mollie/-Openprovider/-deSEC/-Scaleway voor de tests van de Eigen Cloud Dienst. */
import http from "node:http";
import { SMTPServer } from "smtp-server";

// ───────── Nep-mailserver ─────────

export type Mail = { to: string[]; data: string };
export async function smtpSink() {
  const mails: Mail[] = [];
  const server = new SMTPServer({
    logger: false, authOptional: true, disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString("utf8") }); cb(); });
    },
  });
  const port = await new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.server.address() as { port: number }).port)));
  return { mails, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ───────── Nep-aanbieders ─────────

/** Een machtiging zoals Mollie die teruggeeft (GET /customers/{id}/mandates). */
export function fakeMandate(id: string, customerId: string, kind: "directdebit" | "creditcard", status = "valid") {
  return {
    resource: "mandate", id, customerId, mode: "test", status, method: kind, createdAt: new Date().toISOString(),
    signatureDate: new Date().toISOString().slice(0, 10), mandateReference: null,
    details: kind === "directdebit"
      ? { consumerName: "R. van Es", consumerAccount: "NL55INGB0001234567", consumerBic: "INGBNL2A" }
      : { cardHolder: "R. van Es", cardNumber: "4242", cardLabel: "Visa", cardFingerprint: "fp_abc", cardExpiryDate: "2029-12-31" },
  };
}

export type Call = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any };

export function fakeUpstream() {
  const calls: Call[] = [];
  const st = {
    n: 0,
    mollie: { customers: [] as any[], payments: new Map<string, any>(), subscriptions: [] as any[], mandates: [] as any[], refunds: [] as any[], failRefund: false },
    op: { token: "op-token-1", tokenValid: true, domains: [] as any[], customers: [] as any[], rejectNext: new Set<string>(), authcodeFailOnce: false },
    desec: { zones: new Map<string, { name: string; keys: any[]; rrsets: Map<string, any> }>() },
    scw: { projects: [] as any[], applications: [] as any[], policies: [] as any[], apiKeys: [] as any[], tem: [] as any[], servers: [] as any[], failNext: new Set<string>() },
  };
  const id = (p: string) => `${p}${++st.n}`;

  const handle = (c: Call): [number, unknown] => {
    const p = c.path;
    let m: RegExpExecArray | null;
    // Mollie
    if (p.startsWith("/mollie/")) {
      if (c.headers.authorization !== "Bearer test_mollie") return [401, { title: "Unauthorized", detail: "Missing authentication" }];
      const q = p.slice(7);
      if (c.method === "POST" && q === "/customers") { const x = { id: id("cst_"), ...c.body }; st.mollie.customers.push(x); return [201, x]; }
      if (c.method === "POST" && q === "/payments") {
        const x = { resource: "payment", id: id("tr_"), mode: "test", status: "open", createdAt: new Date().toISOString(), description: c.body.description, method: c.body.method ?? null, sequenceType: c.body.sequenceType ?? "oneoff", customerId: c.body.customerId, amount: c.body.amount, metadata: c.body.metadata, _links: { checkout: { href: `https://mollie.test/checkout/${st.n}` } } };
        st.mollie.payments.set(x.id, x); return [201, x];
      }
      if (c.method === "GET" && (m = /^\/payments\/([^/]+)$/.exec(q))) { const x = st.mollie.payments.get(m[1]); return x ? [200, x] : [404, { title: "Not Found", detail: "No payment exists with token " + m[1] }]; }
      if ((m = /^\/customers\/([^/]+)\/subscriptions$/.exec(q))) {
        if (c.method === "GET") return [200, { count: 0, _embedded: { subscriptions: st.mollie.subscriptions.filter((s) => s.customerId === m![1]) } }];
        if (c.method === "POST") {
          const cust = st.mollie.mandates.filter((x) => x.customerId === m![1] && ["valid", "pending"].includes(x.status));
          const x = { resource: "subscription", id: id("sub_"), customerId: m[1], status: "active", createdAt: new Date().toISOString(), nextPaymentDate: c.body.startDate, mandateId: c.body.mandateId ?? cust[cust.length - 1]?.id ?? null, ...c.body };
          st.mollie.subscriptions.push(x); return [201, x];
        }
      }
      if ((m = /^\/customers\/([^/]+)\/subscriptions\/([^/]+)$/.exec(q))) {
        const x = st.mollie.subscriptions.find((s) => s.id === m![2] && s.customerId === m![1]);
        if (!x) return [404, { title: "Not Found", detail: "The subscription does not exist" }];
        if (c.method === "GET") return [200, x];
        if (c.method === "DELETE") { x.status = "canceled"; delete x.nextPaymentDate; return [200, x]; }
        if (c.method === "PATCH") {
          if (x.status !== "active") return [422, { title: "Unprocessable Entity", detail: "The subscription is not active" }];
          if (c.body.mandateId && !st.mollie.mandates.some((md) => md.id === c.body.mandateId && md.customerId === m![1])) return [422, { title: "Unprocessable Entity", detail: "The mandate does not exist" }];
          Object.assign(x, c.body); return [200, x];
        }
      }
      if (c.method === "GET" && (m = /^\/customers\/([^/]+)\/mandates$/.exec(q))) {
        const list = st.mollie.mandates.filter((x) => x.customerId === m![1]);
        return [200, { count: list.length, _embedded: { mandates: [...list].reverse() } }];
      }
      if (c.method === "POST" && (m = /^\/payments\/([^/]+)\/refunds$/.exec(q))) {
        const pay = st.mollie.payments.get(m[1]); if (!pay) return [404, { title: "Not Found" }];
        if (st.mollie.failRefund) return [422, { title: "Unprocessable Entity", detail: "Insufficient balance" }];
        const x = { resource: "refund", id: id("re_"), paymentId: m[1], status: "pending", amount: c.body.amount, description: c.body.description };
        st.mollie.refunds.push(x); return [201, x];
      }
    }
    // Openprovider
    if (p.startsWith("/op/")) {
      const q = p.slice(3);
      if (q === "/auth/login") {
        if (c.body.username !== "rene" || c.body.password !== "op-geheim") return [401, { code: 196, desc: "Authentication failed" }];
        st.op.token = `op-token-${++st.n}`; st.op.tokenValid = true; return [200, { code: 0, data: { token: st.op.token, reseller_id: 1 } }];
      }
      if (c.headers.authorization !== `Bearer ${st.op.token}` || !st.op.tokenValid) return [401, { code: 196, desc: "Authentication failed" }];
      if (q === "/domains/check") {
        const d = c.body.domains[0];
        const free = d.name !== "bezet";
        return [200, { code: 0, data: { results: [{ domain: `${d.name}.${d.extension}`, status: free ? "free" : "active", ...(free ? { price: { product: { price: 9.95, currency: "EUR" }, reseller: { price: 6.5, currency: "EUR" } } } : {}) }] } }];
      }
      if (q === "/domains" && c.method === "GET") return [200, { code: 0, data: { results: st.op.domains.filter((d) => `${d.domain.name}.${d.domain.extension}` === c.query.get("full_name")), total: 0 } }];
      if ((m = /^\/domains\/(\d+)\/authcode(\/reset)?$/.exec(q))) {
        const d = st.op.domains.find((x) => String(x.id) === m![1]);
        if (!d) return [404, { code: 320, desc: "Domain not found" }];
        if (!m[2] && st.op.authcodeFailOnce) { st.op.authcodeFailOnce = false; return [200, { code: 399, desc: "Auth code not available" }]; }
        if (m[2]) d.authCode = `Nieuw-${d.id}-Xy7#`;
        d.authCode ??= `Ab3-${d.id}-Qz9!`;
        return [200, { code: 0, data: { auth_code: d.authCode, type: "internal" } }];
      }
      if (q === "/customers" && c.method === "POST") { const h = `RV${String(++st.n).padStart(6, "0")}-NL`; st.op.customers.push({ handle: h, ...c.body }); return [200, { code: 0, data: { handle: h } }]; }
      if (q === "/domains" && c.method === "POST") {
        if (st.op.rejectNext.delete(c.body.domain.name)) return [400, { code: 346, desc: "Domain name is not valid", data: "" }];
        const x = { id: 1000 + ++st.n, status: c.body.auth_code ? "REQ" : "ACT", ...c.body }; st.op.domains.push(x); return [200, { code: 0, data: { id: x.id, status: x.status } }];
      }
    }
    // deSEC
    if (p.startsWith("/desec/")) {
      if (c.headers.authorization !== "Token desec-dienst") return [401, { detail: "Invalid token." }];
      const q = p.slice(6);
      if (c.method === "POST" && q === "/domains/") {
        if (st.desec.zones.has(c.body.name)) return [409, { detail: "exists" }];
        const z = { name: c.body.name, keys: [{ dnskey: "257 3 13 mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+GqJxpVXckHAeF+KkxLbxILfDLUT0rAK9iUzy1L53eKGQ==", ds: ["12345 13 2 abcdef"], flags: 257, keytype: "csk", managed: true }], rrsets: new Map() };
        st.desec.zones.set(z.name, z); return [201, { name: z.name, keys: z.keys, minimum_ttl: 3600 }];
      }
      if ((m = /^\/domains\/([^/]+)\/(.*)$/.exec(q))) {
        const z = st.desec.zones.get(m[1]);
        if (!z) return [404, { detail: "Not found." }];
        const rest = m[2];
        if (rest === "" && c.method === "GET") return [200, { name: z.name, keys: z.keys }];
        if (rest === "rrsets/" && c.method === "GET") return [200, [...z.rrsets.values()]];
        if (rest === "rrsets/" && (c.method === "PUT" || c.method === "PATCH")) {
          for (const r of c.body) { const k = `${r.subname}/${r.type}`; if (!r.records.length) z.rrsets.delete(k); else z.rrsets.set(k, { ...r, name: `${r.subname ? r.subname + "." : ""}${z.name}.` }); }
          return [200, c.body];
        }
        if ((m = /^rrsets\/([^/]*)\/([A-Z]+)\/$/.exec(rest))) {
          const k = `${m[1] === "@" ? "" : m[1]}/${m[2]}`;
          if (c.method === "GET") return z.rrsets.has(k) ? [200, z.rrsets.get(k)] : [404, { detail: "Not found." }];
          if (c.method === "DELETE") { z.rrsets.delete(k); return [204, null]; }
        }
      }
    }
    // Scaleway
    if (p.startsWith("/scw/")) {
      if (c.headers["x-auth-token"] !== "scw-org-geheim") return [401, { message: "authentication is denied", type: "denied_authentication" }];
      const q = p.slice(4);
      const fail = [...st.scw.failNext].find((f) => q.startsWith(f) && c.method === "POST");
      if (fail) { st.scw.failNext.delete(fail); return [503, { message: "service unavailable" }]; }
      if (q === "/account/v3/projects") {
        if (c.method === "GET") return [200, { projects: st.scw.projects.filter((x) => x.name === c.query.get("name")), total_count: 0 }];
        const x = { id: `proj-${++st.n}`, ...c.body }; st.scw.projects.push(x); return [200, x];
      }
      if ((m = /^\/account\/v3\/projects\/([^/]+)$/.exec(q)) && c.method === "DELETE") return [400, { message: "project is not empty" }];
      for (const [kind, list] of [["applications", st.scw.applications], ["policies", st.scw.policies]] as const) {
        if (q === `/iam/v1alpha1/${kind}`) {
          if (c.method === "GET") return [200, { [kind]: list.filter((x) => (c.query.get("name") ? x.name === c.query.get("name") : true) && (c.query.get("application_id") ? x.application_id === c.query.get("application_id") : true)) }];
          const x = { id: `${kind.slice(0, 3)}-${++st.n}`, ...c.body }; list.push(x); return [200, x];
        }
        if ((m = new RegExp(`^/iam/v1alpha1/${kind}/([^/]+)$`).exec(q)) && c.method === "DELETE") {
          const i = list.findIndex((x) => x.id === m![1]); if (i < 0) return [404, {}]; list.splice(i, 1);
          if (kind === "applications") st.scw.apiKeys = st.scw.apiKeys.filter((k) => k.application_id !== m![1]);
          return [204, null];
        }
      }
      if (q === "/iam/v1alpha1/api-keys") {
        if (c.method === "GET") return [200, { api_keys: st.scw.apiKeys.filter((k) => k.application_id === c.query.get("application_id")).map(({ secret_key, ...k }) => k) }];
        const n = ++st.n;
        const x = { access_key: `SCWAK${String(n).padStart(15, "0")}`, secret_key: `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`, ...c.body }; st.scw.apiKeys.push(x); return [200, x];
      }
      if ((m = /^\/iam\/v1alpha1\/api-keys\/([^/]+)$/.exec(q)) && c.method === "DELETE") {
        const i = st.scw.apiKeys.findIndex((k) => k.access_key === m![1]); if (i < 0) return [404, {}]; st.scw.apiKeys.splice(i, 1); return [204, null];
      }
      const tem = "/transactional-email/v1alpha1/regions/fr-par/domains";
      if (q === tem) {
        if (c.method === "GET") return [200, { domains: st.scw.tem.filter((d) => d.project_id === c.query.get("project_id") && d.name === c.query.get("name")) }];
        const d = c.body.domain_name;
        const x = { id: `tem-${++st.n}`, name: d, project_id: c.body.project_id, status: "pending",
          records: { spf: { name: d, value: "v=spf1 include:_spf.tem.scaleway.com -all" }, dkim: { name: `${c.body.project_id}._domainkey.${d}`, value: "v=DKIM1; h=sha256; k=rsa; p=" + "A".repeat(392) + "IDAQAB" }, dmarc: { name: `_dmarc.${d}`, value: "v=DMARC1; p=none" }, mx: { name: d, value: "blackhole.tem.scaleway.com" } } };
        st.scw.tem.push(x); return [200, x];
      }
      if ((m = new RegExp(`^${tem}/([^/]+)(/check|/revoke)?$`).exec(q))) {
        const d = st.scw.tem.find((x) => x.id === m![1]); if (!d) return [404, {}];
        if (m[2] === "/revoke") d.status = "revoked";
        return [200, d];
      }
      if ((m = /^\/instance\/v1\/zones\/([^/]+)\/servers$/.exec(q)) && c.method === "GET") return [200, { servers: st.scw.servers.filter((s) => s.zone === m![1] && s.project === c.query.get("project")) }];
      if ((m = /^\/instance\/v1\/zones\/([^/]+)\/servers\/([^/]+)\/action$/.exec(q))) {
        const s = st.scw.servers.find((x) => x.id === m![2]); if (!s) return [404, {}];
        if (c.body.action === "poweroff") s.state = "stopped";
        return [202, { task: { id: "t" } }];
      }
    }
    return [599, { detail: `nep-server kent ${c.method} ${p} niet` }];
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const raw = Buffer.concat(chunks).toString("utf8");
      const c: Call = { method: req.method!, path: u.pathname, query: u.searchParams, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      calls.push(c);
      const [status, body] = handle(c);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 204 || body === null ? undefined : JSON.stringify(body));
    });
  });
  const listening = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  const count = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)).length;
  return { calls, st, listening, count, close: () => new Promise<void>((r) => server.close(() => r())) };
}

