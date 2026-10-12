/**
 * "Op de lijst" vanuit de app, met een voorstel (pull request) op GitHub. De aanbieder koppelt één keer GitHub met een
 * klassiek token (recht public_repo; de app geeft een link waarmee GitHub het formulier al invult). Daarna:
 * - de regel van de Dienst komt van de Dienst zelf (GET /v1/status/lijst met het beheertoken, zoals /v1/status/overzicht);
 * - zonder schrijfrechten op renevanes/own-cloud: een fork (POST /repos/{repo}/forks, bijwerken met merge-upstream),
 *   met schrijfrechten (de beheerders): een branch in de repository zelf;
 * - de branch komt op de nieuwste main, aanbieders.json krijgt de regel (zelfde url = vervangen, de rest blijft staan,
 *   JSON met 2 spaties zoals het bestand) en er komt een pull request (of het open voorstel wordt bijgewerkt);
 * - de status (open, samengevoegd, gesloten) en of de regel in de openbare lijst staat; de beheerders kunnen het
 *   voorstel zelf samenvoegen (merge via de API; de CI draait zoals altijd).
 * Alles staat in de kluis onder console.github (het token alleen daar, nooit in een antwoord).
 * De Android-app heeft hetzelfde in Java (android/core GitHub.java); de JSON van de routes is gelijk.
 *
 * GitHub REST (api.github.com, versie 2022-11-28): GET /user (kop X-OAuth-Scopes), GET /repos/{o}/{r} (permissions.push),
 * POST /repos/{o}/{r}/forks, POST /repos/{o}/{r}/merge-upstream, GET /repos/{o}/{r}/git/ref/heads/{b},
 * POST /repos/{o}/{r}/git/refs, PATCH /repos/{o}/{r}/git/refs/heads/{b}, GET en PUT /repos/{o}/{r}/contents/{pad},
 * GET en POST /repos/{o}/{r}/pulls, GET /repos/{o}/{r}/pulls/{n}, PUT /repos/{o}/{r}/pulls/{n}/merge.
 */
import type { AdminConfig } from "./vault.js";
import { aanbiederNet, beheerToken, type AanbiederState } from "./aanbieder.js";
import { AANBIEDERS_URL } from "./extras.js";

export const GITHUB_API = () => (process.env.EIGEN_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
export const LIJST_REPO = "renevanes/own-cloud";
export const LIJST_PAD = "aanbieders.json";
/** Nieuw klassiek token met het vinkje public_repo al aan (GitHub vult scopes en description in). */
export const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=public_repo&description=Eigen%20Cloud";
/** Te vervangen in tests: hoe lang de app wacht tot een nieuwe fork klaar is. */
export const githubNet = { pollMs: 2000, polls: 30 };

export interface Voorstel { nummer: number; url: string; titel: string; status: "open" | "samengevoegd" | "gesloten"; repo: string; branch: string; at: number; samengevoegdOp: number | null }
export interface GithubState { token?: string; login?: string; at?: number; beheerder?: boolean; regel?: { land: string; omschrijving: string }; voorstel?: Voorstel }

const state = (c: AdminConfig) => ((c.console as { github?: GithubState }).github ??= {});
const dienstOf = (c: AdminConfig) => (c.console as { aanbieder?: AanbiederState }).aanbieder ?? null;
type Regel = Record<string, unknown>;

// ───────── GitHub ─────────

interface GhRes { status: number; json: any; scopes: string | null }

async function gh(token: string | undefined, method: string, path: string, body?: unknown): Promise<GhRes> {
  let r: Response;
  try {
    r = await fetch(`${GITHUB_API()}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Eigen-Cloud",
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error("GitHub is nu niet bereikbaar. Probeer het zo opnieuw."); }
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { /* geen JSON */ }
  return { status: r.status, json: j, scopes: r.headers.get("x-oauth-scopes") };
}

/** Een leesbare fout voor een antwoord dat niet lukte. */
function ghFail(r: GhRes, what: string): Error {
  if (r.status === 401) return new Error("GitHub accepteert je token niet meer. Koppel GitHub opnieuw.");
  const msg = typeof r.json?.message === "string" ? r.json.message : "";
  if (r.status === 403 && /rate limit/i.test(msg)) return new Error("GitHub laat even geen verzoeken meer toe. Probeer het over een uur opnieuw.");
  if (r.status === 403 || r.status === 404) return new Error(`${what}: dit mag niet met je token (GitHub antwoordt ${r.status}). Maak een nieuw token met de link in de app.`);
  return new Error(`${what}: GitHub antwoordt ${r.status}${msg ? ` (${msg})` : ""}`);
}

const ok = (r: GhRes) => r.status >= 200 && r.status < 300;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ───────── De lijst ─────────

const norm = (u: unknown) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * De regel zoals hij op de lijst komt: de velden van de Dienst (in die volgorde), daarna velden die de beheerders aan de
 * bestaande regel gaven, en als laatste "standaard" (alleen van de bestaande regel; zet alleen een beheerder) en
 * "adressen" (van de Dienst als de adressendienst daar draait, anders van de bestaande regel).
 */
export function mergeRegel(cur: Regel | null, entry: Regel): Regel {
  const out: Regel = {};
  for (const [k, v] of Object.entries(entry)) if (k !== "standaard" && k !== "adressen") out[k] = v;
  if (cur) for (const [k, v] of Object.entries(cur)) if (!(k in out) && k !== "standaard" && k !== "adressen") out[k] = v;
  if (cur?.standaard === true) out.standaard = true;
  const adressen = typeof entry.adressen === "string" && entry.adressen ? entry.adressen : typeof cur?.adressen === "string" ? cur.adressen : null;
  if (adressen) out.adressen = adressen;
  return out;
}

/** De nieuwe aanbieders.json: dezelfde url vervangen (de rest blijft staan), anders achteraan; 2 spaties zoals het bestand. */
export function mergeLijst(lijst: unknown[], entry: Regel): { tekst: string; nieuw: boolean } {
  const i = lijst.findIndex((x) => !!x && typeof x === "object" && !Array.isArray(x) && norm((x as Regel).url) === norm(entry.url));
  const next = [...lijst];
  if (i >= 0) next[i] = mergeRegel(next[i] as Regel, entry); else next.push(mergeRegel(null, entry));
  return { tekst: `${JSON.stringify(next, null, 2)}\n`, nieuw: i < 0 };
}

/** dienst.esape.nl → aanbieder-dienst-esape-nl */
export function branchFor(url: string) {
  let host = url;
  try { host = new URL(url).host; } catch { /* zoals het is */ }
  return `aanbieder-${host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}`;
}

/** De regel van de Dienst (GET /v1/status/lijst met het beheertoken). */
async function dienstRegel(a: AanbiederState): Promise<{ entry: Regel; voorwaarden: { termsUrl: string | null; privacyUrl: string | null } | null }> {
  let r: Response;
  try { r = await fetch(`${aanbiederNet.reach(a.url!)}/v1/status/lijst`, { headers: { authorization: `Beheer ${beheerToken(a.secret!)}` }, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("Je Dienst is nu niet bereikbaar. Probeer het zo opnieuw."); }
  const j: any = await r.json().catch(() => null);
  if (r.status === 404) throw new Error("Je Dienst kent dit nog niet: werk hem eerst bij (Updates), of zet je regel met de hand op de lijst.");
  if (!r.ok || !j?.entry || typeof j.entry !== "object") throw new Error(`Je Dienst gaf zijn regel niet (${r.status})`);
  return { entry: j.entry, voorwaarden: j.voorwaarden ?? null };
}

/** Land en omschrijving zoals de aanbieder ze invulde (bewaard voor de volgende keer). */
function withOverrides(entry: Regel, g: GithubState): Regel {
  if (!g.regel) return entry;
  return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, k === "land" ? g.regel!.land : k === "omschrijving" ? g.regel!.omschrijving : v]));
}

function cleanRegel(b: { land?: unknown; omschrijving?: unknown }) {
  const land = String(b.land ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(land)) throw new Error("Land als landcode van twee letters, bijvoorbeeld NL");
  const omschrijving = String(b.omschrijving ?? "").replace(/\s+/g, " ").trim();
  if (omschrijving.length > 140) throw new Error("Houd de omschrijving kort: hooguit 140 tekens");
  return { land, omschrijving };
}

const voorstelView = (v: Voorstel) => ({ nummer: v.nummer, url: v.url, titel: v.titel, status: v.status, at: v.at, samengevoegdOp: v.samengevoegdOp });

/** Status van het voorstel bij GitHub bijwerken; true als er iets veranderde. */
async function refreshVoorstel(g: GithubState): Promise<boolean> {
  const v = g.voorstel;
  if (!v || v.status !== "open") return false;
  const r = await gh(g.token, "GET", `/repos/${LIJST_REPO}/pulls/${v.nummer}`);
  if (!ok(r)) return false;
  const status = r.json?.merged === true || r.json?.merged_at ? "samengevoegd" : r.json?.state === "closed" ? "gesloten" : "open";
  if (status === v.status) return false;
  v.status = status;
  v.samengevoegdOp = status === "samengevoegd" ? (Date.parse(r.json.merged_at) || Date.now()) : null;
  return true;
}

function needDienst(c: AdminConfig) {
  const a = dienstOf(c);
  if (!a?.url || !a.secret || !a.server) throw new Error("Er draait nog geen Dienst");
  return a;
}

// ───────── Routes ─────────

/** GET /api/aanbieder/lijst: koppeling, de regel van de Dienst, of hij op de openbare lijst staat en het voorstel. */
export async function view(c: AdminConfig, deps: { save: () => void }) {
  const a = needDienst(c);
  const g = state(c);
  let regel: Regel | null = null, voorwaarden: { termsUrl: string | null; privacyUrl: string | null } | null = null, dienstFout: string | null = null;
  try { const r = await dienstRegel(a); regel = withOverrides(r.entry, g); voorwaarden = r.voorwaarden; } catch (e) { dienstFout = (e as Error).message; }
  let cur: Regel | null = null, lijstFout: string | null = null;
  try {
    let r: Response;
    try { r = await fetch(AANBIEDERS_URL(), { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } }); }
    catch { throw new Error("niet bereikbaar"); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json().catch(() => null);
    if (!Array.isArray(list)) throw new Error("geen lijst");
    // Zoeken op het adres dat de Dienst zelf opgeeft (BROKER_PUBLIC_URL); zonder antwoord van de Dienst: dat uit de kluis.
    const url = regel?.url ?? a.url;
    cur = (list.find((x: unknown) => !!x && typeof x === "object" && norm((x as Regel).url) === norm(url)) as Regel | undefined) ?? null;
  } catch (e) { lijstFout = `De openbare lijst is nu niet te lezen (${(e as Error).message})`; }
  if (await refreshVoorstel(g).catch(() => false)) deps.save();
  return {
    github: { gekoppeld: !!g.token, login: g.token ? g.login ?? null : null, beheerder: !!g.token && !!g.beheerder },
    tokenUrl: TOKEN_URL, repo: LIJST_REPO,
    regel, dienstFout, voorwaarden,
    opLijst: !!cur, sleutelKlopt: !!cur && !!regel && cur.sleutel === regel.sleutel,
    actueel: !!cur && !!regel && JSON.stringify(mergeRegel(cur, regel)) === JSON.stringify(cur),
    lijstFout,
    voorstel: g.voorstel ? voorstelView(g.voorstel) : null,
    editUrl: `https://github.com/${LIJST_REPO}/edit/main/${LIJST_PAD}`,
  };
}

/** POST /api/github/koppelen {token}: controleren (klassiek token met public_repo of repo) en bewaren in de kluis. */
export async function koppelen(c: AdminConfig, b: { token?: unknown }) {
  const token = String(b.token ?? "").trim();
  if (!token) throw new Error("Plak het token dat je op GitHub hebt gemaakt");
  if (token.startsWith("github_pat_")) throw new Error("Dit is een fijnmazig token. Maak met de link in de app een klassiek token (met public_repo): alleen daarmee kan de app een fork en een voorstel maken.");
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error("Dit lijkt geen GitHub-token. Kopieer het token helemaal (het begint meestal met ghp_).");
  const u = await gh(token, "GET", "/user");
  if (u.status === 401) throw new Error("GitHub accepteert dit token niet. Kopieer het opnieuw, of maak een nieuw token.");
  if (!ok(u) || typeof u.json?.login !== "string") throw ghFail(u, "Inloggen bij GitHub");
  if (u.scopes === null) throw new Error("Dit is geen klassiek token. Maak met de link in de app een klassiek token (met public_repo).");
  const scopes = u.scopes.split(",").map((x) => x.trim());
  if (!scopes.includes("public_repo") && !scopes.includes("repo")) throw new Error("Dit token mist het recht public_repo. Maak met de link in de app een nieuw token: dan staat dat vinkje al aan.");
  const repo = await gh(token, "GET", `/repos/${LIJST_REPO}`);
  if (!ok(repo)) throw ghFail(repo, "De lijst van aanbieders lezen");
  const g = state(c);
  Object.assign(g, { token, login: u.json.login, at: Date.now(), beheerder: repo.json?.permissions?.push === true });
  return { ok: true, login: g.login, beheerder: g.beheerder };
}

/** POST /api/github/ontkoppelen: het token weg uit de kluis (het voorstel en je regel blijven). */
export function ontkoppelen(c: AdminConfig) {
  const g = state(c);
  delete g.token; delete g.login; delete g.at; delete g.beheerder;
  return { ok: true };
}

/**
 * POST /api/aanbieder/lijst/aanmelden {land, omschrijving}: de regel van de Dienst op de lijst zetten (of bijwerken) met
 * een voorstel op GitHub. Staat de regel er al precies zo, dan gebeurt er niets.
 */
export async function aanmelden(c: AdminConfig, b: { land?: unknown; omschrijving?: unknown }) {
  const a = needDienst(c);
  const g = state(c);
  if (!g.token) throw new Error("Koppel eerst GitHub");
  g.regel = cleanRegel(b);
  const { entry: raw, voorwaarden } = await dienstRegel(a);
  const entry = withOverrides(raw, g);
  const t = g.token;

  const repo = await gh(t, "GET", `/repos/${LIJST_REPO}`);
  if (!ok(repo)) throw ghFail(repo, "De lijst van aanbieders lezen");
  const base = String(repo.json?.default_branch ?? "main");
  const push = repo.json?.permissions?.push === true;
  g.beheerder = push;
  const ref = await gh(t, "GET", `/repos/${LIJST_REPO}/git/ref/heads/${base}`);
  if (!ok(ref)) throw ghFail(ref, "De lijst van aanbieders lezen");
  const baseSha = String(ref.json?.object?.sha ?? "");
  const file = await gh(t, "GET", `/repos/${LIJST_REPO}/contents/${LIJST_PAD}?ref=${encodeURIComponent(base)}`);
  if (!ok(file)) throw ghFail(file, "De lijst van aanbieders lezen");
  const huidig = Buffer.from(String(file.json?.content ?? ""), "base64").toString("utf8");
  let lijst: unknown;
  try { lijst = JSON.parse(huidig); } catch { throw new Error("De lijst van aanbieders op GitHub is nu geen geldige JSON; probeer het later opnieuw"); }
  if (!Array.isArray(lijst)) throw new Error("De lijst van aanbieders op GitHub is nu geen lijst; probeer het later opnieuw");
  const { tekst, nieuw } = mergeLijst(lijst, entry);
  if (tekst === huidig) return { ok: true, gewijzigd: false, voorstel: g.voorstel ? voorstelView(g.voorstel) : null, bericht: "Je regel staat al zo op de lijst." };
  const open = g.voorstel?.status === "open" ? g.voorstel : null;

  // Waar de wijziging komt: een branch in de repository zelf (beheerders), anders in je fork.
  let target = LIJST_REPO, owner = LIJST_REPO.split("/")[0];
  if (!push) {
    const f = await gh(t, "POST", `/repos/${LIJST_REPO}/forks`, { default_branch_only: true });
    if (!ok(f) || typeof f.json?.full_name !== "string") throw ghFail(f, "Een fork maken");
    target = f.json.full_name;
    owner = String(f.json.owner?.login ?? g.login ?? target.split("/")[0]);
    // Een fork maken gaat op de achtergrond: wachten tot hij er is.
    let ready = false;
    for (let i = 0; i < githubNet.polls && !ready; i++) {
      ready = ok(await gh(t, "GET", `/repos/${target}/git/ref/heads/${base}`));
      if (!ready) await sleep(githubNet.pollMs);
    }
    if (!ready) throw new Error("GitHub is nog bezig met je fork. Probeer het over een paar minuten opnieuw.");
    await gh(t, "POST", `/repos/${target}/merge-upstream`, { branch: base }).catch(() => null);
  }
  const branch = branchFor(String(entry.url));
  const exists = ok(await gh(t, "GET", `/repos/${target}/git/ref/heads/${branch}`));
  const mk = exists
    ? await gh(t, "PATCH", `/repos/${target}/git/refs/heads/${branch}`, { sha: baseSha, force: true })
    : await gh(t, "POST", `/repos/${target}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  if (!ok(mk)) {
    if (!push && mk.status === 422) throw new Error("Je fork op GitHub loopt achter en kon niet vanzelf worden bijgewerkt. Kies op GitHub bij je fork Sync fork en probeer het opnieuw.");
    throw ghFail(mk, "Een branch maken");
  }
  const naam = String(entry.naam ?? "");
  const titel = `${nieuw ? "Aanbieder toevoegen" : "Aanbieder bijwerken"}: ${naam}`;
  const cur = await gh(t, "GET", `/repos/${target}/contents/${LIJST_PAD}?ref=${encodeURIComponent(branch)}`);
  if (!ok(cur)) throw ghFail(cur, "De lijst in je branch lezen");
  const put = await gh(t, "PUT", `/repos/${target}/contents/${LIJST_PAD}`, {
    message: `aanbieders.json: ${naam} ${nieuw ? "toevoegen" : "bijwerken"}`, content: Buffer.from(tekst, "utf8").toString("base64"), sha: cur.json?.sha, branch,
  });
  if (!ok(put)) throw ghFail(put, "De lijst bijwerken");
  const head = push ? branch : `${owner}:${branch}`;
  const found = await gh(t, "GET", `/repos/${LIJST_REPO}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  let pr = ok(found) && Array.isArray(found.json) && found.json.length ? found.json[0] : null;
  if (!pr) {
    const v = voorwaarden;
    const body = [
      nieuw ? `${naam} (${entry.url}) vraagt om op de lijst van aanbieders te komen.` : `${naam} (${entry.url}) werkt zijn regel op de lijst van aanbieders bij.`,
      "", "Gemaakt met de Eigen Cloud-app (Je dienst → Op de lijst).", "",
      `- Adres van de Dienst: ${entry.url}`, `- Contact: ${entry.contact || "nog niet ingevuld"}`, `- Land: ${entry.land ?? ""}`,
      `- Voorwaarden: ${v?.termsUrl ?? "nog niet ingesteld"}`, `- Privacyverklaring: ${v?.privacyUrl ?? "nog niet ingesteld"}`,
      "", `Voor de beheerders: controleer of de Dienst antwoordt (${entry.url}/v1/info) en of contact, voorwaarden en privacyverklaring kloppen (zie CONTRIBUTING.md).`,
    ].join("\n");
    const created = await gh(t, "POST", `/repos/${LIJST_REPO}/pulls`, { title: titel, head, base, body, maintainer_can_modify: true });
    if (!ok(created)) throw ghFail(created, "Het voorstel maken");
    pr = created.json;
  }
  g.voorstel = { nummer: Number(pr.number), url: String(pr.html_url), titel: String(pr.title ?? titel), status: "open", repo: target, branch, at: Date.now(), samengevoegdOp: null };
  return { ok: true, gewijzigd: true, voorstel: voorstelView(g.voorstel), bericht: open && open.nummer === g.voorstel.nummer ? "Je voorstel is bijgewerkt." : "Je voorstel staat op GitHub. De beheerders van het project kijken ernaar." };
}

/** POST /api/aanbieder/lijst/samenvoegen {confirm: true}: alleen voor de beheerders van het project (schrijfrechten). */
export async function samenvoegen(c: AdminConfig, b: { confirm?: unknown }) {
  const g = state(c);
  if (!g.token) throw new Error("Koppel eerst GitHub");
  const v = g.voorstel;
  if (!v || v.status !== "open") throw new Error("Er is geen open voorstel");
  if (b.confirm !== true) throw new Error("Bevestig dat je het voorstel zelf wilt samenvoegen");
  const repo = await gh(g.token, "GET", `/repos/${LIJST_REPO}`);
  if (!ok(repo)) throw ghFail(repo, "De repository lezen");
  if (repo.json?.permissions?.push !== true) { g.beheerder = false; throw new Error("Alleen de beheerders van het project kunnen een voorstel zelf samenvoegen"); }
  const r = await gh(g.token, "PUT", `/repos/${LIJST_REPO}/pulls/${v.nummer}/merge`, { merge_method: "squash", commit_title: `${v.titel} (#${v.nummer})` });
  if (r.status === 405) throw new Error(`GitHub kan dit voorstel nu niet samenvoegen${r.json?.message ? `: ${r.json.message}` : ""}`);
  if (r.status === 409) throw new Error("Het voorstel is intussen gewijzigd. Vernieuw en probeer het opnieuw.");
  if (!ok(r) || r.json?.merged !== true) throw ghFail(r, "Samenvoegen");
  v.status = "samengevoegd";
  v.samengevoegdOp = Date.now();
  return { ok: true, voorstel: voorstelView(v) };
}
