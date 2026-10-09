import type { FastifyReply, FastifyRequest } from "fastify";
import { Agent, request } from "undici";

const agents = new Map<string, Agent>();
function agentFor(servername?: string) {
  const k = servername ?? "";
  let a = agents.get(k);
  if (!a) agents.set(k, (a = new Agent({ connect: servername ? { servername } : {} })));
  return a;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host"]);

/**
 * Stuurt een API-verzoek door naar de leider. Gebeurt vóór het inlezen van de body, zodat ook uploads (multipart) werken.
 * In productie: https://<ip-van-leider> met TLS-servernaam cloud.<domein> (geldig certificaat via DNS-01).
 */
export async function proxyTo(target: string, servername: string | undefined, req: FastifyRequest, reply: FastifyReply) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  if (servername) headers.host = servername;
  headers["x-forwarded-for"] = req.ip;
  headers["x-eigen-proxied"] = "1";
  reply.hijack();
  try {
    const r = await request(target.replace(/\/$/, "") + req.url, {
      method: req.method as "GET",
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.raw,
      dispatcher: agentFor(servername),
      headersTimeout: 30_000,
      bodyTimeout: 0,
    });
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v as string | string[];
    reply.raw.writeHead(r.statusCode, out);
    for await (const chunk of r.body) reply.raw.write(chunk);
    reply.raw.end();
  } catch (e) {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(503, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: "Leider tijdelijk onbereikbaar, probeer het zo opnieuw" }));
    } else reply.raw.destroy(e as Error);
  }
}
