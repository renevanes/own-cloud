/**
 * Nep-deSEC voor de zonelimiet (src/console/zonelimiet.ts en android/core ZoneLimiet.java): token "adres-tok" mag
 * de accountgegevens lezen (limit_domains 15), "dienst-tok" niet (403); 502 zones verdeeld over twee bladzijden
 * (500 + 2, met de kop Link zoals deSEC). Elk ander token: 401.
 */
import http from "node:http";

export function fakeDesecLimiet() {
  const srv = http.createServer((req, res) => {
    const tok = req.headers.authorization;
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (tok !== "Token adres-tok" && tok !== "Token dienst-tok") return json(401, { detail: "Invalid token." });
    if (req.url === "/auth/account/") {
      if (tok === "Token dienst-tok") return json(403, { detail: "You do not have permission to perform this action." });
      return json(200, { created: "2026-01-01T00:00:00Z", domains_under_management: 502, email: "rene@esape.nl", id: "x", limit_domains: 15, outreach_preference: true, secure_domains: 3 });
    }
    if (req.url === "/domains/?cursor=") return json(200, Array.from({ length: 500 }, (_, i) => ({ name: `n${i}.eigencloud.nl` })), { link: `<${base}/domains/?cursor=>; rel="first", <${base}/domains/?cursor=p2>; rel="next"` });
    if (req.url === "/domains/?cursor=p2") return json(200, [{ name: "eigencloud.nl" }, { name: "x.eigencloud.nl" }], { link: `<${base}/domains/?cursor=>; rel="first", <${base}/domains/?cursor=>; rel="prev"` });
    return json(404, { detail: "Not found." });
  });
  const listening = new Promise<string>((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
  return { listening, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
