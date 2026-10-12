/**
 * Nep-GitHub (REST, zoals api.github.com) voor "Op de lijst" (src/console/github.ts en android/core GitHub.java):
 * gebruikers met tokens en scopes, de repository renevanes/own-cloud met aanbieders.json, forks (die eerst even niet
 * klaar zijn), refs, contents, pull requests en samenvoegen, plus de openbare lijst (zoals raw.githubusercontent.com)
 * op /raw/aanbieders.json. Bediening voor de tests op /_control/…:
 *   POST /_control/merge?n=<nr>  (samenvoegen zoals in de webinterface)   POST /_control/close?n=<nr>
 *   POST /_control/revoke?token=<t>                                       GET  /_control/state → {main, calls, prs}
 */
import crypto from "node:crypto";
import http from "node:http";

export const REPO = "renevanes/own-cloud";
export interface FakeUser { login: string; scopes: string | null }

export function fakeGithub(initialList: string, users: Record<string, FakeUser>) {
  const commits = new Map<string, string>(); // sha → inhoud van aanbieders.json
  const commit = (content: string) => { const sha = crypto.createHash("sha1").update(`${content}${crypto.randomBytes(4).toString("hex")}`).digest("hex"); commits.set(sha, content); return sha; };
  const blob = (content: string) => crypto.createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
  const repos = new Map<string, { branches: Map<string, string>; forkReadyAfter: number }>();
  repos.set(REPO, { branches: new Map([["main", commit(initialList)]]), forkReadyAfter: 0 });
  interface Pr { number: number; title: string; body: string; head: string; headRepo: string; branch: string; base: string; state: "open" | "closed"; merged: boolean; merged_at: string | null; maintainer_can_modify: boolean }
  const prs: Pr[] = [];
  const calls: string[] = [];
  const revoked = new Set<string>();
  let base = "";

  const send = (res: http.ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(json === undefined ? "" : JSON.stringify(json));
  };
  const prView = (p: Pr) => ({ number: p.number, title: p.title, body: p.body, state: p.state, merged: p.merged, merged_at: p.merged_at, html_url: `https://github.com/${REPO}/pull/${p.number}`, head: { ref: p.branch, label: p.head }, base: { ref: p.base }, maintainer_can_modify: p.maintainer_can_modify });
  const merge = (p: Pr) => {
    const up = repos.get(REPO)!;
    up.branches.set("main", commit(commits.get(repos.get(p.headRepo)!.branches.get(p.branch)!)!));
    Object.assign(p, { state: "closed", merged: true, merged_at: new Date().toISOString() });
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const raw = Buffer.concat(parts).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const p = u.pathname;
    if (p.startsWith("/_control/")) {
      const pr = prs.find((x) => x.number === Number(u.searchParams.get("n")));
      if (p === "/_control/merge" && pr) { merge(pr); return send(res, 200, prView(pr)); }
      if (p === "/_control/close" && pr) { Object.assign(pr, { state: "closed" }); return send(res, 200, prView(pr)); }
      if (p === "/_control/revoke") { revoked.add(u.searchParams.get("token") ?? ""); return send(res, 200, { ok: true }); }
      if (p === "/_control/state") return send(res, 200, { main: commits.get(repos.get(REPO)!.branches.get("main")!), calls, prs: prs.map(prView), repos: [...repos.keys()] });
      return send(res, 404, { message: "Not Found" });
    }
    if (p === "/raw/aanbieders.json") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(commits.get(repos.get(REPO)!.branches.get("main")!)); }
    calls.push(`${req.method} ${p}${u.search}`);
    const token = /^(?:Bearer|token) (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const user = revoked.has(token) ? undefined : users[token];
    if (req.headers["user-agent"] !== "Eigen-Cloud") return send(res, 403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header" });
    if (token && !user) return send(res, 401, { message: "Bad credentials" });
    if (req.method === "GET" && p === "/user") {
      if (!user) return send(res, 401, { message: "Requires authentication" });
      return send(res, 200, { login: user.login, name: null, html_url: `https://github.com/${user.login}` }, user.scopes === null ? {} : { "x-oauth-scopes": user.scopes });
    }
    let m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return send(res, 404, { message: "Not Found" });
    const full = m[1], rest = m[2] ?? "";
    const repo = repos.get(full);
    if (!repo) return send(res, 404, { message: "Not Found" });
    const canWrite = !!user && (full === REPO ? user.login === "renevanes" : full.startsWith(`${user.login}/`));
    if (req.method === "GET" && rest === "") return send(res, 200, { full_name: full, default_branch: "main", fork: full !== REPO, permissions: { admin: canWrite, maintain: canWrite, push: canWrite, triage: canWrite, pull: true } });
    if (req.method === "POST" && rest === "/forks" && full === REPO) {
      if (!user) return send(res, 401, { message: "Requires authentication" });
      const name = `${user.login}/own-cloud`;
      // Een nieuwe fork is pas na twee keer kijken klaar (GitHub maakt hem op de achtergrond).
      if (!repos.has(name)) repos.set(name, { branches: new Map([["main", repo.branches.get("main")!]]), forkReadyAfter: 2 });
      return send(res, 202, { full_name: name, owner: { login: user.login }, fork: true });
    }
    if (req.method === "POST" && rest === "/merge-upstream") {
      if (!canWrite) return send(res, 403, { message: "Forbidden" });
      repo.branches.set(String(body.branch), repos.get(REPO)!.branches.get("main")!);
      return send(res, 200, { message: "Successfully fetched and fast-forwarded from upstream", merge_type: "fast-forward", base_branch: `${REPO.split("/")[0]}:main` });
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && req.method === "GET") {
      if (repo.forkReadyAfter > 0) { repo.forkReadyAfter--; return send(res, 409, { message: "Git Repository is empty." }); }
      const sha = repo.branches.get(m[1]);
      return sha ? send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : send(res, 404, { message: "Not Found" });
    }
    if (rest === "/git/refs" && req.method === "POST") {
      if (!canWrite) return send(res, 403, { message: "Resource not accessible by personal access token" });
      const name = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      if (repo.branches.has(name)) return send(res, 422, { message: "Reference already exists" });
      if (!commits.has(body.sha)) return send(res, 422, { message: "Object does not exist" });
      repo.branches.set(name, body.sha);
      return send(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === "PATCH") {
      if (!canWrite) return send(res, 403, { message: "Forbidden" });
      if (!repo.branches.has(m[1])) return send(res, 422, { message: "Reference does not exist" });
      if (body.force !== true) return send(res, 422, { message: "Update is not a fast forward" });
      repo.branches.set(m[1], body.sha);
      return send(res, 200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    if (rest === "/contents/aanbieders.json" && req.method === "GET") {
      const sha = repo.branches.get(u.searchParams.get("ref") ?? "main");
      if (!sha) return send(res, 404, { message: "No commit found for the ref" });
      const content = commits.get(sha)!;
      return send(res, 200, { name: "aanbieders.json", path: "aanbieders.json", sha: blob(content), encoding: "base64", content: Buffer.from(content).toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (rest === "/contents/aanbieders.json" && req.method === "PUT") {
      if (!canWrite) return send(res, 403, { message: "Resource not accessible by personal access token" });
      const branch = String(body.branch ?? "main");
      const cur = repo.branches.get(branch);
      if (!cur) return send(res, 404, { message: "Branch not found" });
      if (body.sha !== blob(commits.get(cur)!)) return send(res, 409, { message: "aanbieders.json does not match " + body.sha });
      if (typeof body.message !== "string" || !body.message) return send(res, 422, { message: "message wanted" });
      const sha = commit(Buffer.from(String(body.content), "base64").toString("utf8"));
      repo.branches.set(branch, sha);
      calls.push(`commit ${full}:${branch} ${body.message}`);
      return send(res, 200, { content: { sha: blob(commits.get(sha)!) }, commit: { sha, message: body.message } });
    }
    if (rest === "/pulls" && req.method === "GET" && full === REPO) {
      const state = u.searchParams.get("state") ?? "open", head = u.searchParams.get("head");
      return send(res, 200, prs.filter((x) => (state === "all" || x.state === state) && (!head || x.head === head || `${REPO.split("/")[0]}:${x.head}` === head)).map(prView));
    }
    if (rest === "/pulls" && req.method === "POST" && full === REPO) {
      if (!user) return send(res, 401, { message: "Requires authentication" });
      const head = String(body.head ?? "");
      const [owner, branch] = head.includes(":") ? head.split(":") : [REPO.split("/")[0], head];
      const headRepo = owner === REPO.split("/")[0] ? REPO : `${owner}/own-cloud`;
      if (!repos.get(headRepo)?.branches.has(branch)) return send(res, 422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] });
      if (prs.some((x) => x.state === "open" && x.headRepo === headRepo && x.branch === branch)) return send(res, 422, { message: "A pull request already exists" });
      const pr: Pr = { number: prs.length + 1, title: String(body.title), body: String(body.body ?? ""), head, headRepo, branch, base: String(body.base), state: "open", merged: false, merged_at: null, maintainer_can_modify: body.maintainer_can_modify === true };
      prs.push(pr);
      return send(res, 201, prView(pr));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest)) && req.method === "GET" && full === REPO) {
      const pr = prs.find((x) => x.number === Number(m![1]));
      return pr ? send(res, 200, prView(pr)) : send(res, 404, { message: "Not Found" });
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && req.method === "PUT" && full === REPO) {
      const pr = prs.find((x) => x.number === Number(m![1]));
      if (!pr) return send(res, 404, { message: "Not Found" });
      if (!canWrite) return send(res, 403, { message: "Must have admin rights to Repository." });
      if (pr.state !== "open") return send(res, 405, { message: "Pull Request is not mergeable" });
      calls.push(`merge ${pr.number} ${body.merge_method} ${body.commit_title}`);
      merge(pr);
      return send(res, 200, { sha: repos.get(REPO)!.branches.get("main"), merged: true, message: "Pull Request successfully merged" });
    }
    return send(res, 404, { message: "Not Found" });
  });
  const listening = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; base = `http://127.0.0.1:${port}`; resolve(port); }));
  return {
    listening, get base() { return base; },
    main: () => commits.get(repos.get(REPO)!.branches.get("main")!)!,
    calls, prs, repos,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
