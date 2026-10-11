// Eigen Cloud Dienst — beheer voor medewerkers van de aanbieder. Gewoon JavaScript, geen bouwstap.
// Praat met /v1/admin/… met "Authorization: Staff <token>". Zie BROKER.md (Beheer door de aanbieder).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const root = $("#root");

// ───────── Opmaak ─────────

const euro = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "object" ? Number(v.value) : Number(v);
  const neg = n < 0;
  const [w, c] = Math.abs(n).toFixed(2).split(".");
  return `${neg ? "-" : ""}€ ${w.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${c}`;
};
const dt = (ms) => (ms ? new Date(ms).toLocaleString("nl-NL", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (ms) => (ms ? new Date(ms).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" }) : "—");
const dateStr = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" }) : "—");
const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const monthName = (m) => { const [y, mm] = m.split("-").map(Number); return `${MONTHS[mm - 1]} ${y}`; };
const bytes = (n) => {
  if (n === null || n === undefined) return "—";
  const u = ["B", "kB", "MB", "GB", "TB"];
  let i = 0, x = n;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x.toFixed(i ? 1 : 0).replace(".", ",")} ${u[i]}`;
};
const STATUS_CLASS = { ready: "ok", awaiting_payment: "", paid: "", provisioning: "", failed: "bad", payment_problem: "warn", cancelled: "", suspended: "warn" };
const statusChip = (status, label) => `<span class="chip ${STATUS_CLASS[status] ?? ""}">${esc(label ?? status)}</span>`;
const healthDot = (h) => (!h ? `<span class="dot" title="Nog geen melding"></span>` : h.flagged ? `<span class="dot bad" title="Probleem"></span>` : h.healthy ? `<span class="dot ok" title="Gezond"></span>` : `<span class="dot warn" title="Niet gezond"></span>`);
const ROLE_LABELS = { eigenaar: "Eigenaar", beheer: "Beheer", support: "Support", financien: "Financiën" };
const ROLE_TEXT = {
  eigenaar: "Alles, ook medewerkers, huisstijl en het logboek.",
  beheer: "Klanten en clouds, aanbod, uitnodigingen, berichten en hulpvragen.",
  support: "Klanten en clouds inzien en hulpvragen beantwoorden.",
  financien: "Betalingen, facturen, achterstanden, terugbetalen en omzet.",
};
const SEVERITY = { info: "Info", onderhoud: "Onderhoud", storing: "Storing" };
const KIND = { first: "Eerste betaling", recurring: "Maandelijks", settle: "Achterstand", mandate: "Betaalmethode", other: "Overig" };
const PAY_STATUS = { paid: "Betaald", open: "Open", pending: "Bezig", failed: "Mislukt", canceled: "Geannuleerd", expired: "Verlopen", charged_back: "Teruggeboekt", authorized: "Goedgekeurd" };
const AUDIT = {
  login: "Ingelogd", logout: "Uitgelogd", "second-factor-add": "Tweede stap ingesteld", "second-factor-remove": "Tweede stap verwijderd",
  "staff-add": "Medewerker toegevoegd", "staff-role": "Rol gewijzigd", "staff-remove": "Medewerker verwijderd", "staff-reset-second-factor": "Tweede stap gewist",
  "order-suspend": "Opgeschort", "order-resume": "Hervat", "order-cancel": "Opgezegd", "order-retry": "Opnieuw geprobeerd", "order-cleanup": "Opgeruimd",
  refund: "Terugbetaald", "bundle-add": "Bundel toegevoegd", "bundle-change": "Bundel gewijzigd", "bundle-delete": "Bundel verwijderd",
  "brand-change": "Huisstijl gewijzigd", "brand-logo": "Logo gewijzigd", "brand-logo-delete": "Logo verwijderd",
  "invite-create": "Uitnodiging gemaakt", "invite-revoke": "Uitnodiging ingetrokken",
  "ticket-reply": "Hulpvraag beantwoord", "ticket-close": "Hulpvraag gesloten", "ticket-reopen": "Hulpvraag heropend",
  "announcement-create": "Bericht geplaatst", "announcement-end": "Bericht beëindigd",
};

// ───────── Sessie en API ─────────

const KEY = "eigen-dienst-staff";
let token = null;
try { token = sessionStorage.getItem(KEY); } catch { /* geen opslag */ }
let me = null; // { staff, permissions, brand }
const can = (p) => !!me?.permissions?.includes(p);

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Staff ${token}`;
  let r;
  try { r = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }); }
  catch { throw new Error("De dienst is niet bereikbaar. Controleer je verbinding."); }
  if (opts.raw) { if (!r.ok) throw new Error(`Mislukt (${r.status})`); return r; }
  let j = null;
  try { j = await r.json(); } catch { /* geen JSON */ }
  if (r.status === 401 && token && !opts.login) { setToken(null); me = null; renderLogin(); throw new Error("Je bent uitgelogd. Log opnieuw in."); }
  if (!r.ok) throw new Error(j?.error ?? `Mislukt (${r.status})`);
  return j;
}
function setToken(t) {
  token = t;
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* */ }
}

// ───────── Kleine hulpjes voor de pagina ─────────

let toastTimer = null;
function toast(text, err = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast show${err ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, err ? 6000 : 3000);
}
function confirmDlg(title, text, yes = "Ja", danger = false) {
  const d = $("#confirm");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmYes").textContent = yes;
  $("#confirmYes").className = `btn ${danger ? "danger" : "primary"}`;
  d.returnValue = "";
  d.showModal();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }));
}
/** Knop tijdelijk uit tijdens een handeling; fouten als melding. */
async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Even geduld…"; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); return undefined; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
/** Dialoog met velden; geeft de ingevulde waarden terug, of null bij annuleren. */
function formDlg(title, text, fields, yes) {
  const d = $("#formDlg");
  $("#formDlgTitle").textContent = title;
  $("#formDlgText").textContent = text;
  $("#formDlgFields").innerHTML = fields;
  $("#formDlgYes").textContent = yes;
  d.returnValue = "";
  d.showModal();
  $("#formDlgFields input")?.focus();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "yes" ? formObj($("#formDlgForm")) : null), { once: true }));
}
const formObj = (f) => Object.fromEntries(new FormData(f).entries());
const loading = () => { root.innerHTML = `<p class="muted">Laden…</p>`; };
const errorBox = (e) => `<div class="note bad">${esc(e.message ?? e)}</div>`;
function setMsg(el, text, ok = false) { if (el) { el.textContent = text; el.className = `msg ${ok ? "ok" : "err"}`; } }
const dateInput = (ms) => { if (!ms) return ""; const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// ───────── Brug met de app (toestelsleutel achter de vingerafdruk) ─────────
// Zie BROKER.md: window.EigenNative.dienstKey(origin) en .dienstSign(challenge, origin).
// Antwoord: direct een tekst, een Promise, of later window.eigenDienstKey(waarde, fout) / window.eigenDienstSigned(waarde, fout).

const NATIVE = window.EigenNative ?? null;
const hasBridge = () => !!(NATIVE && typeof NATIVE.dienstKey === "function" && typeof NATIVE.dienstSign === "function");
function nativeCall(fn, callback, args) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[callback];
      if (error || !value) reject(new Error(error || "Afgebroken")); else resolve(String(value));
    };
    const timer = setTimeout(() => finish(null, "De app gaf geen antwoord"), 120_000);
    window[callback] = (value, error) => finish(value, error);
    try {
      const r = NATIVE[fn](...args);
      if (r && typeof r.then === "function") r.then((v) => finish(v, null), (e) => finish(null, e?.message ?? String(e)));
      else if (typeof r === "string" && r) finish(r, null);
    } catch (e) { finish(null, e.message); }
  });
}
const deviceKey = () => nativeCall("dienstKey", "eigenDienstKey", [location.origin]);
const deviceSign = (challenge) => nativeCall("dienstSign", "eigenDienstSigned", [challenge, location.origin]);
const deviceLabel = () => { try { return NATIVE?.deviceName?.() || "Telefoon"; } catch { return "Telefoon"; } };

// ───────── Huisstijl in de balk ─────────

function applyBrand(b) {
  if (!b) return;
  $("#brandName").textContent = b.name;
  document.title = `Beheer — ${b.name}`;
  const logo = $("#brandLogo");
  if (b.logoUrl) logo.innerHTML = `<img src="${esc(new URL(b.logoUrl).pathname + new URL(b.logoUrl).search)}" alt="">`;
  if (b.accentColor) { $("meta[name=theme-color]").content = b.accentColor; logo.querySelector("svg")?.style.setProperty("stroke", b.accentColor); }
}

// ───────── Inloggen ─────────

let login = { email: "", pending: null, next: null, methods: [] };

function shell(loggedIn) {
  $("#nav").hidden = !loggedIn;
  $(".shell").classList.toggle("solo", !loggedIn);
  $("#logoutBtn").hidden = !loggedIn;
  $("#meLink").hidden = !loggedIn;
}

function renderLogin(step = "email", extra = {}) {
  shell(false);
  const bridge = hasBridge();
  const card = (inner) => { root.innerHTML = `<div class="login">${inner}</div>`; root.focus(); };
  if (step === "email") {
    card(`<h1>Inloggen</h1><p class="lead">Voor medewerkers. Je krijgt een code per mail; daarna vragen we je vingerafdruk of de code uit je authenticator-app.</p>
      <form class="panel fields" id="f"><label>E-mailadres<input name="email" type="email" autocomplete="username" required value="${esc(login.email)}"></label>
      <button class="btn primary big">Stuur me een code</button><p class="msg" id="m"></p></form>`);
    $("#f input").focus();
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      login.email = formObj(e.target).email.trim().toLowerCase();
      await busy($("#f button"), async () => { await api("/v1/admin/auth/start", { body: { email: login.email }, login: true }); renderLogin("code"); });
    };
  } else if (step === "code") {
    card(`<h1>Kijk in je mail</h1><p class="lead">We hebben een code van 6 cijfers gestuurd naar <b>${esc(login.email)}</b>. Alleen medewerkers krijgen een code.</p>
      <form class="panel fields" id="f"><label>Code<input name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required></label>
      <button class="btn primary big">Verder</button><p class="msg" id="m"></p>
      <button type="button" class="link" id="back">Ander e-mailadres</button></form>`);
    $("#f input").focus();
    $("#back").onclick = () => renderLogin("email");
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      await busy($("#f button"), async () => {
        try {
          const r = await api("/v1/admin/auth/verify", { body: { email: login.email, code: formObj(e.target).code }, login: true });
          Object.assign(login, { pending: r.pending, next: r.next, methods: r.methods });
          renderLogin(r.next === "enrol" ? "enrol" : "second");
        } catch (err) { setMsg($("#m"), err.message); }
      });
    };
  } else if (step === "second") {
    const dev = login.methods.includes("device") && bridge;
    const totp = login.methods.includes("totp");
    card(`<h1>Bevestig dat jij het bent</h1><p class="lead">${dev ? "Gebruik je vingerafdruk" : ""}${dev && totp ? " of " : ""}${totp ? `${dev ? "de" : "Vul de"} code uit je authenticator-app${dev ? "" : " in"}` : ""}.</p>
      ${dev ? `<button class="btn primary big" id="fp">Inloggen met vingerafdruk</button>` : ""}
      ${totp ? `<form class="panel fields" id="f"><label>Code uit je authenticator-app<input name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        <button class="btn ${dev ? "" : "primary"} big">Inloggen</button></form>` : ""}
      ${!dev && !totp ? `<div class="note warn">Je hebt alleen je telefoon als tweede stap ingesteld. Open dit beheer in de Eigen Cloud-app op die telefoon, of vraag de eigenaar om je tweede stap te wissen.</div>` : ""}
      <p class="msg" id="m"></p><button type="button" class="link" id="back">Opnieuw beginnen</button>`);
    $("#back").onclick = () => renderLogin("email");
    if (dev) $("#fp").onclick = () => busy($("#fp"), async () => {
      try {
        const { challenge } = await api("/v1/admin/auth/challenge", { body: { pending: login.pending }, login: true });
        const signature = await deviceSign(challenge);
        let publicKey;
        try { publicKey = await deviceKey(); } catch { publicKey = undefined; }
        loggedIn(await api("/v1/admin/auth/device", { body: { pending: login.pending, signature, publicKey }, login: true }));
      } catch (err) { setMsg($("#m"), err.message); }
    });
    if (totp) {
      if (!dev) $("#f input").focus();
      $("#f").onsubmit = async (e) => {
        e.preventDefault();
        await busy($("#f button"), async () => {
          try { loggedIn(await api("/v1/admin/auth/totp", { body: { pending: login.pending, code: formObj(e.target).code }, login: true })); }
          catch (err) { setMsg($("#m"), err.message); if (/verlopen/.test(err.message)) setTimeout(() => renderLogin("email"), 1500); }
        });
      };
    }
  } else if (step === "enrol") {
    card(`<h1>Stel je tweede stap in</h1><p class="lead">Dit doe je één keer. Daarna log je in met je e-mail én deze tweede stap, zodat niemand met alleen je mail bij het beheer kan.</p>
      <div class="fields">
        ${bridge ? `<button class="choice" id="useDevice"><b>Vingerafdruk van deze telefoon</b><span class="muted">De app maakt een sleutel die alleen met jouw vingerafdruk werkt.</span></button>` : ""}
        <button class="choice" id="useTotp"><b>Authenticator-app</b><span class="muted">Bijvoorbeeld Aegis, Google Authenticator of 1Password: die geeft elke 30 seconden een nieuwe code.</span></button>
      </div><p class="msg" id="m"></p><button type="button" class="link" id="back">Opnieuw beginnen</button>`);
    $("#back").onclick = () => renderLogin("email");
    if (bridge) $("#useDevice").onclick = () => busy($("#useDevice"), async () => {
      try {
        const publicKey = await deviceKey();
        const { challenge } = await api("/v1/admin/auth/challenge", { body: { pending: login.pending }, login: true });
        const signature = await deviceSign(challenge);
        loggedIn(await api("/v1/admin/auth/enrol/device", { body: { pending: login.pending, publicKey, signature, label: deviceLabel() }, login: true }));
      } catch (err) { setMsg($("#m"), err.message); }
    });
    $("#useTotp").onclick = () => busy($("#useTotp"), async () => {
      try { renderLogin("totp", await api("/v1/admin/auth/enrol/totp", { body: { pending: login.pending }, login: true })); }
      catch (err) { setMsg($("#m"), err.message); }
    });
  } else if (step === "totp") {
    card(`<h1>Authenticator-app koppelen</h1>
      <ol class="fields" style="padding-left:20px">
        <li>Scan deze code met je authenticator-app${NATIVE ? `, of <a class="link" href="${esc(extra.uri)}">open hem direct</a>` : ""}.
          <div class="qr" style="margin-top:8px"><img alt="QR-code voor je authenticator-app" src="data:image/svg+xml;utf8,${encodeURIComponent(extra.qrSvg)}"></div></li>
        <li>Lukt scannen niet? Typ dan deze sleutel over:<div class="secret" style="margin-top:6px">${esc(extra.secret.replace(/(.{4})/g, "$1 ").trim())}</div></li>
        <li>Vul de code van 6 cijfers in die de app nu laat zien.</li>
      </ol>
      <form class="panel fields" id="f"><label>Code<input name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <button class="btn primary big">Koppelen en inloggen</button><p class="msg" id="m"></p></form>`);
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      await busy($("#f button"), async () => {
        try { loggedIn(await api("/v1/admin/auth/enrol/totp/confirm", { body: { pending: login.pending, code: formObj(e.target).code }, login: true })); }
        catch (err) { setMsg($("#m"), err.message); }
      });
    };
  }
}

async function loggedIn(r) {
  setToken(r.token);
  login = { email: "", pending: null, next: null, methods: [] };
  await start();
}

$("#logoutBtn").onclick = async () => {
  try { await api("/v1/admin/auth/logout", { body: {} }); } catch { /* */ }
  setToken(null); me = null;
  location.hash = "#/overzicht";
  renderLogin();
};

// ───────── Navigatie ─────────

const PAGES = [
  { id: "overzicht", label: "Overzicht", perm: "announcements.read" },
  { id: "klanten", label: "Klanten", perm: "customers.read" },
  { id: "hulpvragen", label: "Hulpvragen", perm: "tickets", count: "openTickets" },
  { id: "berichten", label: "Berichten", perm: "announcements.read" },
  { id: "geld", label: "Geld", perm: "money" },
  { id: "kosten", label: "Kosten", perm: "costs" },
  { id: "aanbod", label: "Aanbod", perm: "offering" },
  { id: "uitnodigingen", label: "Uitnodigingen", perm: "invites" },
  { id: "huisstijl", label: "Huisstijl", perm: "brand" },
  { id: "medewerkers", label: "Medewerkers", perm: "staff" },
  { id: "logboek", label: "Logboek", perm: "audit" },
];
let counts = {};
function renderNav(current) {
  const parent = { klant: "klanten", hulpvraag: "hulpvragen" }[current] ?? current;
  $("#nav").innerHTML = PAGES.filter((p) => can(p.perm)).map((p) =>
    `<a href="#/${p.id}"${p.id === parent ? ' aria-current="page"' : ""}>${esc(p.label)}${p.count && counts[p.count] ? `<span class="count">${counts[p.count]}</span>` : ""}</a>`).join("");
}

async function start() {
  if (!token) return renderLogin();
  try { me = await api("/v1/admin/me"); }
  catch (e) { if (token) root.innerHTML = `<div class="login">${errorBox(e)}<button class="btn" id="again">Opnieuw proberen</button></div>`, $("#again").onclick = start; return; }
  shell(true);
  applyBrand(me.brand);
  $("#meLink").textContent = me.staff.name || me.staff.email;
  route();
}

window.addEventListener("hashchange", () => { if (me) route(); });

async function route() {
  const [, page = "overzicht", arg] = location.hash.replace(/^#/, "").split("?")[0].split("/");
  const known = { overzicht, klanten, klant, hulpvragen, hulpvraag, berichten, geld, kosten, aanbod, uitnodigingen, huisstijl, medewerkers, logboek, account };
  const fn = known[page] ?? overzicht;
  renderNav(page);
  loading();
  try { await fn(decodeURIComponent(arg ?? "")); }
  catch (e) { if (me) root.innerHTML = errorBox(e); }
  root.focus({ preventScroll: true });
}
const rerender = () => route();

// ───────── Overzicht ─────────

async function overzicht() {
  const o = await api("/v1/admin/overview");
  counts.openTickets = o.openTickets ?? 0;
  renderNav("overzicht");
  const order = ["ready", "provisioning", "paid", "awaiting_payment", "payment_problem", "suspended", "failed", "cancelled"];
  const card = (href, label, big, cls = "", sub = "") => `<${href ? `a href="${href}"` : "div"} class="card ${cls}"><span class="muted">${esc(label)}</span><span class="big">${big}</span>${sub ? `<small class="muted">${sub}</small>` : ""}</${href ? "a" : "div"}>`;
  let html = `<h1>Overzicht</h1><p class="lead">Goedendag${me.staff.name ? ` ${esc(me.staff.name)}` : ""}. Je bent ingelogd als ${esc(ROLE_LABELS[me.staff.role])}.</p><div class="cards">`;
  if (o.revenueThisMonth) html += card("#/geld/omzet", "Omzet deze maand", euro(o.revenueThisMonth.net), "", `${o.revenueThisMonth.count} betaling${o.revenueThisMonth.count === 1 ? "" : "en"}, incl. btw`);
  if (o.arrears !== undefined) html += card("#/geld/achterstand", "Achterstanden", o.arrears, o.arrears ? "warn" : "");
  if (o.openTickets !== undefined) html += card("#/hulpvragen", "Open hulpvragen", o.openTickets, o.openTickets ? "warn" : "");
  if (o.unhealthy) html += card("#/klanten?health=problem", "Clouds met een probleem", o.unhealthy.length, o.unhealthy.length ? "bad" : "");
  html += `</div>`;
  if (o.orders) {
    html += `<h2>Klanten per status</h2><div class="cards">${order.filter((s) => o.orders[s]).map((s) => card(`#/klanten?status=${s}`, o.statusLabels[s], o.orders[s])).join("") || `<p class="empty">Nog geen bestellingen.</p>`}</div>`;
  }
  if (o.unhealthy?.length) {
    html += `<h2>Clouds met een probleem</h2><ul class="list">${o.unhealthy.map((h) => `<li><a href="#/klant/${esc(h.orderId)}"><span class="title">${healthDot(h)}${esc(h.domain)}</span>
      <span class="sub">${h.flagReason === "silent" ? `Niets gehoord sinds ${dt(h.reportedAt)}` : `Niet gezond sinds ${dt(h.unhealthySince)}`}${h.problems?.length ? ` — ${esc(h.problems.join("; "))}` : ""}</span>
      <span class="end">${h.flagged ? `<span class="chip bad">Klant ziet een bericht</span>` : `<span class="chip warn">Nog binnen de wachttijd</span>`}</span></a></li>`).join("")}</ul>`;
  }
  root.innerHTML = html;
}

// ───────── Klanten ─────────

async function klanten() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const params = new URLSearchParams();
  for (const k of ["q", "status", "health"]) if (q.get(k)) params.set(k, q.get(k));
  const r = await api(`/v1/admin/customers?${params}`);
  const opts = Object.entries(r.statusLabels).map(([k, v]) => `<option value="${k}"${q.get("status") === k ? " selected" : ""}>${esc(v)}</option>`).join("");
  root.innerHTML = `<h1>Klanten</h1><p class="lead">${r.total} bestelling${r.total === 1 ? "" : "en"}. Zoek op e-mailadres, domein, ordernummer of uitnodigingscode.</p>
    <form class="row" id="f" role="search">
      <label>Zoeken<input name="q" type="search" value="${esc(q.get("q") ?? "")}" placeholder="bijv. vanes.nl"></label>
      <label>Status<select name="status"><option value="">Alle</option>${opts}</select></label>
      <label class="check" style="flex:0 0 auto;align-self:center"><input type="checkbox" name="health" value="problem"${q.get("health") ? " checked" : ""}> Alleen problemen</label>
      <button class="btn">Zoeken</button>
    </form>
    <ul class="list" style="margin-top:16px">${r.orders.map((o) => `<li><a href="#/klant/${esc(o.id)}">
      <span class="title">${healthDot(o.health)}${esc(o.domain)}</span>
      <span class="sub">${esc(o.customer.email)} · ${esc(o.bundleTitle)} · ${o.users} gebruiker${o.users === 1 ? "" : "s"}${o.openTickets ? ` · ${o.openTickets} open hulpvraag` : ""}</span>
      <span class="end">${statusChip(o.status, o.statusLabel)}<small class="muted">${euro(o.amount)} p/m</small></span></a></li>`).join("") || `<li class="empty">Niets gevonden.</li>`}</ul>`;
  $("#f").onsubmit = (e) => {
    e.preventDefault();
    const v = formObj(e.target);
    const p = new URLSearchParams(Object.entries(v).filter(([, x]) => x));
    location.hash = `#/klanten${p.toString() ? `?${p}` : ""}`;
  };
}

async function klant(id) {
  const d = await api(`/v1/admin/orders/${encodeURIComponent(id)}`);
  const o = d.order;
  const h = d.health;
  const a = d.actions;
  let html = `<p><a class="link" href="#/klanten">← Alle klanten</a></p>
    <h1>${esc(o.domain)}</h1><p class="lead">${statusChip(o.status, o.statusLabel)} ${o.error ? `<span class="muted">${esc(o.error)}</span>` : ""}</p>`;
  if (a) {
    const btns = [
      a.suspend && `<button class="btn" data-act="suspend">Opschorten</button>`,
      a.resume && `<button class="btn primary" data-act="resume">Hervatten</button>`,
      a.retry && `<button class="btn primary" data-act="retry">Opnieuw proberen</button>`,
      a.cancel && `<button class="btn danger" data-act="cancel">Opzeggen</button>`,
      a.cleanup && `<button class="btn danger" data-act="cleanup">Opruimen…</button>`,
    ].filter(Boolean);
    if (btns.length) html += `<div class="actions">${btns.join("")}</div>`;
  }
  html += `<div class="split"><section><h2>Klant en abonnement</h2><dl class="facts">
    <dt>Klant</dt><dd>${esc(o.customer.email)}</dd>
    <dt>Bundel</dt><dd>${esc(o.bundleTitle)}</dd>
    <dt>Maandbedrag</dt><dd>${euro(o.amount)} (incl. btw)</dd>
    <dt>Gebruikers</dt><dd>${o.users}${o.extraUsers ? ` (waarvan ${o.extraUsers} extra)` : ""}</dd>
    <dt>Besteld</dt><dd>${dt(o.createdAt)}</dd>
    <dt>Betaald</dt><dd>${dt(o.paidAt)}</dd>
    ${o.endsAt ? `<dt>Loopt tot</dt><dd>${dateStr(o.endsAt)}</dd>` : ""}
    ${o.inviteCode ? `<dt>Uitnodiging</dt><dd class="mono">${esc(o.inviteCode)}</dd>` : ""}
    <dt>Bestelling</dt><dd class="mono">${esc(o.id)}</dd>
  </dl></section><section><h2>Gezondheid van de cloud</h2>`;
  if (!h) html += `<p class="muted">De cloud heeft zich nog niet gemeld. Dat gebeurt zodra de klant hem gestart heeft.</p>`;
  else html += `<p>${healthDot(h)}<b>${h.flagged ? (h.flagReason === "silent" ? "Meldt zich niet meer" : "Probleem") : h.healthy ? "Gezond" : "Niet gezond"}</b></p>
    ${h.problems.length ? `<div class="note ${h.flagged ? "bad" : "warn"}">${h.problems.map(esc).join("<br>")}</div>` : ""}
    <dl class="facts"><dt>Laatste melding</dt><dd>${dt(h.reportedAt)}</dd><dt>Versie</dt><dd>${esc(h.version ?? "—")}</dd>
    <dt>Opslag in gebruik</dt><dd>${bytes(h.storageUsedBytes)}</dd><dt>Gebruikers</dt><dd>${h.users ?? "—"}</dd>
    <dt>Servers</dt><dd>${h.nodes.map((n) => `${esc(n.id)} (${esc(n.region)}): ${esc(n.status)}`).join("<br>") || "—"}</dd></dl>`;
  html += `<p class="hint">Je ziet alleen techniek. Mail, agenda en foto's van de klant kan de dienst niet lezen.</p></section></div>`;

  if (d.costs) {
    const c = d.costs;
    html += `<h2>Kosten en marge</h2><dl class="facts"><dt>Prijs excl. btw</dt><dd>${euro(c.price.excl)}</dd>
      <dt>Geschatte kosten</dt><dd>${c.cost ? euro(c.cost.total) : "onbekend"}${c.cost?.unknownSizes?.length ? ` <small class="muted">(geen prijs voor ${esc(c.cost.unknownSizes.join(", "))})</small>` : ""}</dd>
      <dt>Marge</dt><dd class="${c.margin && Number(c.margin) < 0 ? "neg" : ""}">${euro(c.margin)}</dd></dl>
      <div class="actions"><button class="btn small" id="servers">Servers bij Scaleway bekijken</button></div><div id="serverList"></div>`;
  }
  html += `<h2>Klaarzetten</h2><ol class="progress">${d.steps.map((s) => `<li class="${esc(s.state)}"><span class="pip" aria-hidden="true"></span><span>${esc(s.label)}</span>${s.detail ? `<span class="det">${esc(s.detail)}</span>` : ""}</li>`).join("")}</ol>`;
  const t = d.technical;
  html += `<h2>Techniek</h2><dl class="facts"><dt>Scaleway-project</dt><dd class="mono">${esc(t.projectId ?? "—")}</dd><dt>Toegangssleutel</dt><dd class="mono">${esc(t.apiKey ?? "—")}</dd>
    <dt>Maildomein</dt><dd class="mono">${esc(t.mailDomain ?? "—")}</dd><dt>Pakket</dt><dd>${t.kitReady ? `klaar (${t.kitUsers} gebruikers)` : "nog niet"}</dd>
    <dt>Plaatsing</dt><dd>${t.placement.map((p) => `${esc(p.size)} in ${esc(p.region)} (${p.kind === "witness" ? "witness" : "gegevens"})`).join("<br>")}</dd></dl>`;

  if (d.billing && !d.billing.error) {
    const b = d.billing;
    html += `<h2>Betalingen</h2>${b.outstanding ? `<div class="note warn">Openstaand: ${euro(b.outstanding)}</div>` : ""}
      <p class="muted">${b.mandate ? `Betaalmethode: ${esc(b.mandate.label)}. ` : ""}${b.nextPaymentDate ? `Volgende incasso: ${dateStr(b.nextPaymentDate)}.` : ""}</p>
      <ul class="list">${b.payments.map((p) => `<li><div class="item"><span class="title">${euro(p.amount)} · ${esc(PAY_STATUS[p.status] ?? p.status)}</span><span class="sub">${dateStr(p.date)} · ${esc(p.description)}</span>
        <span class="end">${p.invoiceId && can("money") ? `<button class="btn small" data-invoice="${esc(p.invoiceId)}">Factuur</button>` : ""}${p.status === "paid" && can("refund") ? `<button class="btn small" data-refund="${esc(p.id)}" data-amount="${esc(p.amount.value)}">Terugbetalen</button>` : ""}</span></div></li>`).join("") || `<li class="empty">Nog geen betalingen.</li>`}</ul>`;
  } else if (d.billing?.error) html += `<h2>Betalingen</h2>${errorBox(d.billing.error)}`;

  if (d.tickets?.length) html += `<h2>Hulpvragen</h2><ul class="list">${d.tickets.map((x) => `<li><a href="#/hulpvraag/${esc(x.id)}"><span class="title">${esc(x.subject)}</span><span class="sub">${dt(x.updatedAt)}</span><span class="end"><span class="chip ${x.status === "open" ? "warn" : ""}">${esc(x.statusLabel)}</span></span></a></li>`).join("")}</ul>`;
  if (d.otherOrders.length) html += `<h2>Andere bestellingen van deze klant</h2><ul class="list">${d.otherOrders.map((x) => `<li><a href="#/klant/${esc(x.id)}"><span class="title">${esc(x.domain)}</span><span class="sub">${esc(x.bundleTitle)}</span><span class="end">${statusChip(x.status, x.statusLabel)}</span></a></li>`).join("")}</ul>`;
  html += `<h2>Gebeurtenissen</h2><ul class="events">${d.events.slice(0, 40).map((e) => `<li><time>${dt(e.at)}</time>${esc(e.kind)}${e.detail ? ` <code>${esc(e.detail.slice(0, 200))}</code>` : ""}</li>`).join("") || `<li class="muted">Nog niets.</li>`}</ul>`;
  root.innerHTML = html;

  const ACT = {
    suspend: ["Opschorten?", `De toegangssleutel van ${o.domain} wordt ingetrokken en de servers gaan uit. De gegevens blijven bewaard. De klant krijgt een mail.`, "Opschorten", true],
    resume: ["Hervatten?", "De klant krijgt een nieuwe sleutel; de app zet de servers weer aan.", "Hervatten", false],
    retry: ["Opnieuw proberen?", "Het klaarzetten gaat verder bij de stap die misging.", "Opnieuw proberen", false],
    cancel: ["Opzeggen?", `Het abonnement van ${o.domain} stopt meteen bij Mollie. Alles blijft werken tot het einde van de betaalde maand. De klant krijgt een mail.`, "Opzeggen", true],
  };
  $$("[data-act]").forEach((btn) => btn.onclick = async () => {
    const act = btn.dataset.act;
    if (act === "cleanup") return cleanup(o, btn);
    const [title, text, yes, danger] = ACT[act];
    if (!(await confirmDlg(title, text, yes, danger))) return;
    await busy(btn, async () => { await api(`/v1/admin/orders/${o.id}/${act}`, { body: {} }); toast("Gedaan"); rerender(); });
  });
  $$("[data-invoice]").forEach((btn) => btn.onclick = () => showInvoice(btn.dataset.invoice, btn));
  $$("[data-refund]").forEach((btn) => btn.onclick = () => refund(btn.dataset.refund, btn.dataset.amount, btn));
  const sv = $("#servers");
  if (sv) sv.onclick = () => busy(sv, async () => {
    const s = await api(`/v1/admin/orders/${o.id}/servers`);
    $("#serverList").innerHTML = `<p class="muted">${s.running} draaiend, ${s.allowed ?? "?"} toegestaan (bundel + 1 reserve)${s.runningCost ? `; draaiend ca. ${euro(s.runningCost)} per maand` : ""}.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Naam</th><th>Zone</th><th>Soort</th><th>Status</th></tr></thead><tbody>
      ${s.servers.map((x) => `<tr><td>${esc(x.name || x.id)}</td><td>${esc(x.zone)}</td><td>${esc(x.type ?? "—")}</td><td>${esc(x.state)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Geen servers in dit project.</td></tr>`}</tbody></table></div>`;
  });
}

async function cleanup(o, btn) {
  const plan = await busy(btn, () => api(`/v1/admin/orders/${o.id}/cleanup`, { body: {} }));
  if (!plan) return;
  const text = `Dit gebeurt:\n• ${plan.result.plan.join("\n• ")}\n\nDaarna zelf doen:\n• ${plan.result.manual.join("\n• ")}`;
  if (!(await confirmDlg(`${o.domain} opruimen?`, text, "Opruimen", true))) return;
  await busy(btn, async () => { await api(`/v1/admin/orders/${o.id}/cleanup`, { body: { sure: true } }); toast("Opgeruimd"); rerender(); });
}

async function showInvoice(id, btn) {
  await busy(btn, async () => {
    const r = await api(`/v1/admin/invoices/${encodeURIComponent(id)}`, { raw: true });
    $("#viewerFrame").srcdoc = await r.text();
    $("#viewer").showModal();
  });
}

async function refund(paymentId, max, btn) {
  const v = await formDlg("Terugbetalen", `Via Mollie terug naar de klant. Hooguit ${euro(max)}. Dit kan niet ongedaan worden gemaakt.`,
    `<label>Bedrag in € <small>(leeg = alles wat nog kan)</small><input name="amount" inputmode="decimal" placeholder="${esc(String(max).replace(".", ","))}"></label>
     <label>Omschrijving voor de klant <small>(mag leeg)</small><input name="description" maxlength="140"></label>`, "Terugbetalen");
  if (!v) return;
  const { amount, description } = v;
  await busy(btn, async () => {
    const r = await api(`/v1/admin/payments/${encodeURIComponent(paymentId)}/refund`, { body: { amount: amount || undefined, description: description || undefined } });
    toast(`${euro(r.refund.amount)} wordt terugbetaald`);
    rerender();
  });
}

// ───────── Hulpvragen ─────────

async function hulpvragen() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const status = q.get("status") ?? "active";
  const r = await api(`/v1/admin/tickets?status=${encodeURIComponent(status)}`);
  const tabs = [["active", "Lopend"], ["open", "Wacht op ons"], ["answered", "Beantwoord"], ["closed", "Gesloten"], ["all", "Alle"]];
  root.innerHTML = `<h1>Hulpvragen</h1><p class="lead">Vragen van klanten uit de app. Je antwoord gaat per mail naar de klant en staat in de app.</p>
    <nav class="tabs" aria-label="Filter">${tabs.map(([k, l]) => `<a href="#/hulpvragen?status=${k}"${k === status ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <ul class="list">${r.tickets.map((t) => `<li><a href="#/hulpvraag/${esc(t.id)}"><span class="title">${esc(t.subject)}</span>
      <span class="sub">${esc(t.customer.email)}${t.domain ? ` · ${esc(t.domain)}` : ""} · ${dt(t.updatedAt)} · ${t.count} bericht${t.count === 1 ? "" : "en"}</span>
      <span class="end"><span class="chip ${t.status === "open" ? "warn" : t.status === "answered" ? "ok" : ""}">${esc(t.statusLabel)}</span></span></a></li>`).join("") || `<li class="empty">Geen hulpvragen.</li>`}</ul>`;
}

async function hulpvraag(id) {
  const t = await api(`/v1/admin/tickets/${encodeURIComponent(id)}`);
  root.innerHTML = `<p><a class="link" href="#/hulpvragen">← Alle hulpvragen</a></p><h1>${esc(t.subject)}</h1>
    <p class="lead"><span class="chip ${t.status === "open" ? "warn" : ""}">${esc(t.statusLabel)}</span> ${esc(t.customer.email)}${t.orderId ? ` · <a class="link" href="#/klant/${esc(t.orderId)}">${esc(t.domain ?? t.orderId)}</a>` : ""}</p>
    <ul class="thread">${t.messages.map((m) => `<li class="${m.from}"><span class="who">${esc(m.name)} · ${dt(m.at)}</span>${esc(m.body)}</li>`).join("")}</ul>
    <form class="panel fields" id="f"><label>Je antwoord<textarea name="message" required maxlength="5000"></textarea></label>
      <div class="row"><button class="btn primary" name="go" value="send">Versturen</button><button class="btn" name="go" value="close">Versturen en sluiten</button>
      <span class="grow"></span>${t.status === "closed" ? `<button type="button" class="btn small" id="reopen">Heropenen</button>` : `<button type="button" class="btn small" id="close">Sluiten zonder antwoord</button>`}</div></form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const close = e.submitter?.value === "close";
    await busy(e.submitter, async () => { await api(`/v1/admin/tickets/${t.id}/messages`, { body: { message: formObj(e.target).message, close } }); toast("Verstuurd"); rerender(); });
  };
  const c = $("#close"), ro = $("#reopen");
  if (c) c.onclick = () => busy(c, async () => { await api(`/v1/admin/tickets/${t.id}/close`, { body: {} }); rerender(); });
  if (ro) ro.onclick = () => busy(ro, async () => { await api(`/v1/admin/tickets/${t.id}/reopen`, { body: {} }); rerender(); });
}

// ───────── Berichten ─────────

async function berichten() {
  const r = await api("/v1/admin/announcements");
  let customers = [];
  if (can("announcements") && can("customers.read")) customers = (await api("/v1/admin/customers?status=ready,payment_problem,provisioning,suspended&limit=500")).orders;
  const STATE = { actief: "ok", gepland: "", afgelopen: "" };
  root.innerHTML = `<h1>Berichten</h1><p class="lead">Berichten verschijnen in de app van je klanten: onderhoud, storingen of gewoon nieuws. Automatische berichten bij een ongezonde cloud staan hier ook.</p>
    ${can("announcements") ? `<details class="panel"${r.announcements.length ? "" : " open"}><summary><b>Nieuw bericht</b></summary>
      <form class="fields" id="f" style="margin-top:12px">
        <label>Titel<input name="title" required maxlength="140"></label>
        <label>Tekst<textarea name="body" required maxlength="5000"></textarea></label>
        <fieldset class="row" style="border:0;padding:0;margin:0"><legend class="hint">Soort</legend>
          ${Object.entries(SEVERITY).map(([k, l], i) => `<label class="check" style="flex:0 0 auto"><input type="radio" name="severity" value="${k}"${i === 0 ? " checked" : ""}> ${l}</label>`).join("")}</fieldset>
        <div class="row"><label>Vanaf <small>(leeg = meteen)</small><input type="datetime-local" name="startsAt"></label><label>Tot <small>(leeg = tot je het beëindigt)</small><input type="datetime-local" name="endsAt"></label></div>
        <fieldset style="border:0;padding:0;margin:0" class="fields"><legend class="hint">Voor wie</legend>
          <label class="check"><input type="radio" name="audience" value="all" checked> Alle klanten</label>
          <label class="check"><input type="radio" name="audience" value="orders"> Alleen bepaalde klanten</label>
          <div class="picklist" id="pick" hidden>${customers.map((o) => `<label class="check"><input type="checkbox" name="order" value="${esc(o.id)}"> ${esc(o.domain)} <small class="muted">${esc(o.customer.email)}</small></label>`).join("") || `<span class="muted">Geen actieve klanten.</span>`}</div>
        </fieldset>
        <div class="row"><button class="btn primary">Plaatsen</button></div><p class="msg" id="m"></p>
      </form></details>` : ""}
    <h2>Alle berichten</h2>
    <ul class="list">${r.announcements.map((a) => `<li><div class="item"><span class="title">${esc(a.title)} ${a.auto ? `<span class="chip">automatisch</span>` : ""}</span>
      <span class="sub">${esc(SEVERITY[a.severity])} · ${a.orderIds ? `${a.orderIds.length} klant${a.orderIds.length === 1 ? "" : "en"}` : "alle klanten"} · ${dt(a.startsAt ?? a.createdAt)}${a.endsAt ? ` tot ${dt(a.endsAt)}` : ""}<br>${esc(a.body.slice(0, 240))}</span>
      <span class="end"><span class="chip ${STATE[a.state]}">${esc(a.state)}</span>${a.state !== "afgelopen" && can("announcements") ? `<button class="btn small" data-end="${esc(a.id)}">Beëindigen</button>` : ""}</span></div></li>`).join("") || `<li class="empty">Nog geen berichten.</li>`}</ul>`;
  const f = $("#f");
  if (f) {
    $$("input[name=audience]", f).forEach((x) => x.onchange = () => { $("#pick").hidden = formObj(f).audience !== "orders"; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const v = formObj(f);
      const body = { title: v.title, body: v.body, severity: v.severity, startsAt: v.startsAt ? new Date(v.startsAt).getTime() : null, endsAt: v.endsAt ? new Date(v.endsAt).getTime() : null };
      if (v.audience === "orders") { body.audience = "orders"; body.orderIds = $$("input[name=order]:checked", f).map((x) => x.value); }
      await busy(f.querySelector("button.primary"), async () => {
        try { await api("/v1/admin/announcements", { body }); toast("Bericht geplaatst"); rerender(); } catch (err) { setMsg($("#m"), err.message); }
      });
    };
  }
  $$("[data-end]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Bericht beëindigen?", "Klanten zien het bericht dan niet meer.", "Beëindigen"))) return;
    await busy(b, async () => { await api(`/v1/admin/announcements/${b.dataset.end}/end`, { body: {} }); rerender(); });
  });
}

// ───────── Geld ─────────

async function geld(tab) {
  tab = tab || "betalingen";
  const tabs = [["betalingen", "Betalingen"], ["facturen", "Facturen"], ["achterstand", "Achterstanden"], ["omzet", "Omzet"]];
  let html = `<h1>Geld</h1><nav class="tabs" aria-label="Onderdeel">${tabs.map(([k, l]) => `<a href="#/geld/${k}"${k === tab ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
  if (tab === "betalingen") {
    const r = await api("/v1/admin/payments?limit=300");
    html += `<p class="lead">Eerste betalingen, maandelijkse incasso's en betaalde achterstanden (zonder de controlebetalingen van € 0,01).</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Datum</th><th>Klant</th><th>Soort</th><th>Status</th><th class="num">Bedrag</th><th class="num">Terug</th><th></th></tr></thead><tbody>
      ${r.payments.map((p) => `<tr><td>${dt(p.paidAt ?? p.createdAt)}</td><td><a class="link" href="#/klant/${esc(p.orderId)}">${esc(p.domain)}</a><br><small class="muted">${esc(p.email)}</small></td>
        <td>${esc(KIND[p.kind] ?? p.kind ?? "")}</td><td>${esc(PAY_STATUS[p.status] ?? p.status)}${p.settledBy ? "<br><small class=muted>alsnog betaald</small>" : ""}</td>
        <td class="num">${euro(p.amount)}</td><td class="num">${Number(p.refunded) ? euro(p.refunded) : ""}</td>
        <td>${p.invoice ? `<button class="btn small" data-invoice="${esc(p.invoice.id)}">${esc(p.invoice.number)}</button> ` : ""}${Number(p.refundable) > 0 && can("refund") ? `<button class="btn small" data-refund="${esc(p.id)}" data-amount="${esc(p.refundable)}">Terugbetalen</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Nog geen betalingen.</td></tr>`}
      </tbody></table></div>`;
  } else if (tab === "facturen") {
    const r = await api("/v1/admin/invoices");
    html += `<p class="lead">Alle facturen, nieuwste eerst. Neem ze mee in je boekhouding.</p><ul class="list">${r.invoices.map((i) => `<li><div class="item"><span class="title">${esc(i.number)} · ${euro(i.amount)}</span>
      <span class="sub">${dateStr(i.date)} · ${esc(i.domain)} · ${esc(i.email)}</span><span class="end"><button class="btn small" data-invoice="${esc(i.id)}">Bekijken</button></span></div></li>`).join("") || `<li class="empty">Nog geen facturen.</li>`}</ul>`;
  } else if (tab === "achterstand") {
    const r = await api("/v1/admin/arrears");
    html += `<p class="lead">Klanten bij wie een maandelijkse incasso is mislukt. De cloud blijft werken; de klant kan zelf betalen in de app. Opschorten doe je bij de klant.</p>
      <ul class="list">${r.orders.map((o) => `<li><a href="#/klant/${esc(o.id)}"><span class="title">${esc(o.domain)}</span><span class="sub">${esc(o.email)} · sinds ${dt(o.since)} · ${o.failedPayments.length} mislukte incasso${o.failedPayments.length === 1 ? "" : "'s"}</span>
      <span class="end"><span class="chip warn">${euro(o.outstanding)}</span></span></a></li>`).join("") || `<li class="empty">Geen achterstanden.</li>`}</ul>`;
  } else {
    const r = await api("/v1/admin/revenue?months=24");
    html += `<p class="lead">Ontvangen per maand (op de dag van betalen), met de btw (${String(r.vatPercent).replace(".", ",")}%) apart en min terugbetalingen.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Maand</th><th class="num">Betalingen</th><th class="num">Incl. btw</th><th class="num">Btw</th><th class="num">Excl. btw</th><th class="num">Terugbetaald</th><th class="num">Netto</th></tr></thead><tbody>
      ${r.months.map((m) => `<tr><td>${monthName(m.month)}</td><td class="num">${m.count}</td><td class="num">${euro(m.incl)}</td><td class="num">${euro(m.vat)}</td><td class="num">${euro(m.excl)}</td><td class="num">${Number(m.refunded) ? euro(m.refunded) : ""}</td><td class="num"><b>${euro(m.net)}</b></td></tr>`).join("") || `<tr><td colspan="7" class="muted">Nog geen omzet.</td></tr>`}
      </tbody></table></div>`;
  }
  root.innerHTML = html;
  $$("[data-invoice]").forEach((b) => b.onclick = () => showInvoice(b.dataset.invoice, b));
  $$("[data-refund]").forEach((b) => b.onclick = () => refund(b.dataset.refund, b.dataset.amount, b));
}

async function kosten() {
  const r = await api("/v1/admin/costs");
  root.innerHTML = `<h1>Kosten</h1><p class="lead">Geschatte maandkosten bij Scaleway per klant (servers en opslag van de bundel, excl. btw) naast wat de klant betaalt (excl. btw). Dit is een schatting: de echte factuur van Scaleway kan afwijken.</p>
    <div class="cards"><div class="card"><span class="muted">Prijs, samen</span><span class="big">${euro(r.totals.priceExcl)}</span></div>
      <div class="card"><span class="muted">Kosten, samen</span><span class="big">${euro(r.totals.cost)}</span></div>
      <div class="card ${Number(r.totals.margin) < 0 ? "bad" : ""}"><span class="muted">Marge per maand</span><span class="big">${euro(r.totals.margin)}</span></div></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Klant</th><th>Bundel</th><th class="num">Prijs excl.</th><th class="num">Kosten</th><th class="num">Marge</th></tr></thead><tbody>
    ${r.orders.map((o) => `<tr><td><a class="link" href="#/klant/${esc(o.id)}">${esc(o.domain)}</a></td><td>${esc(o.bundle)}</td><td class="num">${euro(o.price.excl)}</td><td class="num">${o.cost ? euro(o.cost.total) : "?"}</td><td class="num ${Number(o.margin) < 0 ? "neg" : ""}">${euro(o.margin)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nog geen actieve klanten.</td></tr>`}
    </tbody></table></div>
    <h2>Prijzen die we aannemen</h2><p class="hint">Aan te passen in bundles.json (onderdeel "costs"), zie BROKER.md.</p>
    <dl class="facts">${Object.entries(r.table.servers).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${euro(v)} per maand</dd>`).join("")}<dt>Opslag</dt><dd>€ ${esc(String(r.table.storageGbMonthly).replace(".", ","))} per GB per maand (per kopie)</dd></dl>`;
}

// ───────── Aanbod ─────────

async function aanbod() {
  const r = await api("/v1/admin/bundles");
  const bundleForm = (b) => `<form class="panel fields bundle" data-id="${esc(b.id)}">
    <div class="row"><h3 style="margin:0">${esc(b.title)}</h3><span class="grow"></span><small class="muted">${b.orders} actieve klant${b.orders === 1 ? "" : "en"}</small></div>
    <div class="row"><label>Naam<input name="title" value="${esc(b.title)}" required maxlength="60"></label><label>Prijs per maand (€, incl. btw)<input name="monthly" value="${esc(b.monthly.value)}" inputmode="decimal" required></label></div>
    <label>Omschrijving<textarea name="description" maxlength="400" style="min-height:70px">${esc(b.description)}</textarea></label>
    <div class="row"><label>Gebruikers inbegrepen<input name="users" type="number" min="1" max="1000" value="${b.includes.users}"></label>
      <label>Prijs per extra gebruiker (€ p/m, leeg = niet te koop)<input name="extra" value="${esc(b.extraUserMonthly?.value ?? "")}" inputmode="decimal"></label>
      <label>Opslag (GB)<input name="storageGb" type="number" min="0" value="${b.includes.storageGb}"></label></div>
    <p class="hint">Servers: ${b.placement.map((p) => `${esc(p.size)} (${esc(p.region)})`).join(", ")}. Geschatte kosten ${b.cost ? euro(b.cost.total) : "onbekend"} per maand; marge ${euro(b.margin)} excl. btw.</p>
    <div class="row"><button class="btn primary">Opslaan</button>${b.orders ? "" : `<button type="button" class="btn danger" data-del="${esc(b.id)}">Verwijderen</button>`}</div><p class="msg"></p></form>`;
  root.innerHTML = `<h1>Aanbod</h1><p class="lead">Je bundels en prijzen. Een nieuwe prijs geldt voor nieuwe bestellingen; bestaande klanten houden hun bedrag tot ze zelf van bundel wisselen of gebruikers bijkopen.</p>
    <div class="fields">${r.bundles.map(bundleForm).join("")}</div>
    <h2>Nieuwe bundel</h2><form class="panel fields" id="nb">
      <div class="row"><label>Code <small>(kleine letters, bijv. gezin)</small><input name="id" pattern="[a-z0-9][a-z0-9-]{0,31}" required></label><label>Naam<input name="title" required></label><label>Prijs (€ p/m)<input name="monthly" required inputmode="decimal"></label></div>
      <div class="row"><label>Gebruikers<input name="users" type="number" min="1" value="1"></label><label>Prijs extra gebruiker<input name="extra" inputmode="decimal"></label>
        <label>Servers en opslag zoals<select name="like">${r.bundles.map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join("")}</select></label></div>
      <div class="row"><button class="btn primary">Toevoegen</button></div><p class="msg" id="nbm"></p></form>`;
  const money = (v) => String(v ?? "").trim().replace(",", ".").replace(/^(\d+)$/, "$1.00").replace(/^(\d+\.\d)$/, "$10");
  $$("form.bundle").forEach((f) => f.onsubmit = async (e) => {
    e.preventDefault();
    const v = formObj(f);
    const body = { title: v.title, description: v.description, monthly: { value: money(v.monthly) }, includes: { users: Number(v.users), storageGb: Number(v.storageGb) }, extraUserMonthly: v.extra.trim() ? { value: money(v.extra) } : null };
    await busy(f.querySelector("button.primary"), async () => {
      try { await api(`/v1/admin/bundles/${f.dataset.id}`, { method: "PUT", body }); toast("Opgeslagen"); rerender(); } catch (err) { setMsg(f.querySelector(".msg"), err.message); }
    });
  });
  $$("[data-del]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Bundel verwijderen?", "Nieuwe klanten kunnen hem dan niet meer kiezen.", "Verwijderen", true))) return;
    await busy(b, async () => { await api(`/v1/admin/bundles/${b.dataset.del}`, { method: "DELETE" }); rerender(); });
  });
  $("#nb").onsubmit = async (e) => {
    e.preventDefault();
    const v = formObj(e.target);
    const like = r.bundles.find((b) => b.id === v.like);
    const body = { title: v.title, description: "", monthly: { value: money(v.monthly) }, includes: { ...like.includes, users: Number(v.users) }, extraUserMonthly: v.extra.trim() ? { value: money(v.extra) } : null, placement: like.placement, storage: like.storage };
    await busy(e.submitter, async () => {
      try { await api(`/v1/admin/bundles/${encodeURIComponent(v.id)}`, { method: "PUT", body }); toast("Toegevoegd"); rerender(); } catch (err) { setMsg($("#nbm"), err.message); }
    });
  };
}

// ───────── Uitnodigingen ─────────

async function uitnodigingen() {
  const [r, offer] = await Promise.all([api("/v1/admin/invites"), can("offering") ? api("/v1/admin/bundles") : Promise.resolve({ bundles: [] })]);
  root.innerHTML = `<h1>Uitnodigingen</h1><p class="lead">Geef een code aan nieuwe klanten. Met de code komen ze in de app bij jou uit, met jouw huisstijl; je ziet bij elke klant met welke code hij kwam.</p>
    <form class="panel fields" id="f"><div class="row"><label>Waarvoor <small>(alleen voor jezelf)</small><input name="label" maxlength="80" placeholder="bijv. Buurtvereniging"></label>
      ${offer.bundles.length ? `<label>Bundel voorselecteren<select name="bundle"><option value="">Geen</option>${offer.bundles.map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join("")}</select></label>` : ""}</div>
      <div class="row"><label>Hoe vaak te gebruiken <small>(leeg = onbeperkt)</small><input name="maxUses" type="number" min="1"></label><label>Geldig tot <small>(leeg = altijd)</small><input name="expiresAt" type="date"></label></div>
      <div class="row"><button class="btn primary">Code maken</button></div><p class="msg" id="m"></p></form>
    <h2>Codes</h2><ul class="list">${r.invites.map((i) => `<li><div class="item"><span class="title mono" style="font-size:17px">${esc(i.display)}</span>
      <span class="sub">${i.label ? `${esc(i.label)} · ` : ""}${i.uses}${i.maxUses ? ` van ${i.maxUses}` : ""} keer gebruikt · ${i.orders} bestelling${i.orders === 1 ? "" : "en"}${i.bundle ? ` · bundel ${esc(i.bundle)}` : ""}${i.expiresAt ? ` · tot ${day(i.expiresAt)}` : ""}</span>
      <span class="end">${i.valid ? `<span class="chip ok">Geldig</span>` : `<span class="chip">${esc(i.reason?.replace(/^Deze code is /, "") ?? "Ongeldig")}</span>`}
      <span class="row" style="gap:6px"><button class="btn small" data-copy="${esc(i.display)}">Kopiëren</button>${!i.revokedAt ? `<button class="btn small danger" data-revoke="${esc(i.code)}">Intrekken</button>` : ""}</span></span></div></li>`).join("") || `<li class="empty">Nog geen codes.</li>`}</ul>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const v = formObj(e.target);
    const body = { label: v.label, bundle: v.bundle || undefined, maxUses: v.maxUses ? Number(v.maxUses) : undefined, expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T23:59:59`).getTime() : undefined };
    await busy(e.submitter, async () => {
      try { const x = await api("/v1/admin/invites", { body }); toast(`Code ${x.invite.display} gemaakt`); rerender(); } catch (err) { setMsg($("#m"), err.message); }
    });
  };
  $$("[data-copy]").forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Gekopieerd"); } catch { toast(b.dataset.copy); } });
  $$("[data-revoke]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Code intrekken?", "Nieuwe klanten kunnen hem dan niet meer gebruiken. Bestaande klanten merken er niets van.", "Intrekken", true))) return;
    await busy(b, async () => { await api(`/v1/admin/invites/${b.dataset.revoke}`, { method: "DELETE" }); rerender(); });
  });
}

// ───────── Huisstijl ─────────

async function huisstijl() {
  const { brand: b, defaults } = await api("/v1/admin/brand");
  root.innerHTML = `<h1>Huisstijl</h1><p class="lead">Zo zien je klanten jou in de app: naam, logo, kleur en hoe ze je bereiken.</p>
    <form class="panel fields" id="f">
      <label>Naam van je bedrijf of dienst<input name="name" value="${esc(b.name)}" maxlength="80" placeholder="${esc(defaults.name)}"></label>
      <label>Accentkleur<span class="row" style="align-items:center"><input type="color" id="pick" value="${esc(b.accentColor ?? "#3f6f4a")}"><input name="accentColor" id="hex" value="${esc(b.accentColor ?? "")}" placeholder="#3f6f4a" maxlength="7" style="flex:1 1 120px"></span><small>Kies een kleur waar witte tekst goed op leesbaar is.</small></label>
      <div class="row"><label>E-mail voor klanten<input name="email" type="email" value="${esc(b.contact.email ?? "")}"></label><label>Telefoon<input name="phone" type="tel" value="${esc(b.contact.phone ?? "")}"></label></div>
      <label>Website<input name="website" type="url" value="${esc(b.contact.website ?? "")}" placeholder="https://"></label>
      <div class="row"><label>Algemene voorwaarden<input name="termsUrl" type="url" value="${esc(b.termsUrl ?? "")}" placeholder="${esc(defaults.termsUrl ?? "https://")}"></label>
        <label>Privacyverklaring<input name="privacyUrl" type="url" value="${esc(b.privacyUrl ?? "")}" placeholder="${esc(defaults.privacyUrl ?? "https://")}"></label></div>
      <div class="row"><button class="btn primary">Opslaan</button></div><p class="msg" id="m"></p></form>
    <h2>Logo</h2><div class="panel fields">
      ${b.logoUrl ? `<img class="logo-preview" alt="Huidig logo" src="${esc(new URL(b.logoUrl).pathname + new URL(b.logoUrl).search)}">` : `<p class="muted">Nog geen logo.</p>`}
      <label>PNG of SVG, hooguit 200 KB<input type="file" id="logo" accept="image/png,image/svg+xml"></label>
      <div class="row">${b.logoUrl ? `<button class="btn danger" id="dellogo" type="button">Logo verwijderen</button>` : ""}</div><p class="msg" id="lm"></p></div>`;
  $("#pick").oninput = () => { $("#hex").value = $("#pick").value; };
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const v = formObj(e.target);
    const body = { name: v.name, accentColor: v.accentColor, termsUrl: v.termsUrl, privacyUrl: v.privacyUrl, contact: { email: v.email, phone: v.phone, website: v.website } };
    await busy(e.submitter, async () => {
      try { const r = await api("/v1/admin/brand", { method: "PUT", body }); applyBrand(r.brand); setMsg($("#m"), "Opgeslagen", true); } catch (err) { setMsg($("#m"), err.message); }
    });
  };
  $("#logo").onchange = () => {
    const file = $("#logo").files[0];
    if (!file) return;
    if (file.size > 200 * 1024) return setMsg($("#lm"), "Het logo is te groot (hooguit 200 KB)");
    const rd = new FileReader();
    rd.onload = async () => {
      try { const r = await api("/v1/admin/brand/logo", { method: "PUT", body: { dataUrl: rd.result } }); applyBrand(r.brand); toast("Logo opgeslagen"); rerender(); }
      catch (err) { setMsg($("#lm"), err.message); }
    };
    rd.readAsDataURL(file);
  };
  const del = $("#dellogo");
  if (del) del.onclick = () => busy(del, async () => { await api("/v1/admin/brand/logo", { method: "DELETE" }); location.reload(); });
}

// ───────── Medewerkers ─────────

async function medewerkers() {
  const r = await api("/v1/admin/staff");
  root.innerHTML = `<h1>Medewerkers</h1><p class="lead">Wie mag wat. Iedereen logt in met een code per mail én een vingerafdruk of authenticator-app.</p>
    <ul class="list">${r.staff.map((s) => `<li><div class="item"><span class="title">${esc(s.name || s.email)}${s.id === me.staff.id ? " (jij)" : ""}</span>
      <span class="sub">${esc(s.email)} · ${s.totp || s.devices.length ? [s.totp ? "authenticator-app" : "", s.devices.length ? `${s.devices.length} toestel${s.devices.length === 1 ? "" : "len"}` : ""].filter(Boolean).join(" + ") : "nog niet ingelogd"}${s.lastLoginAt ? ` · laatst ${dt(s.lastLoginAt)}` : ""}</span>
      <span class="end"><select data-role="${esc(s.id)}" aria-label="Rol van ${esc(s.email)}">${r.roles.map((x) => `<option value="${x.id}"${x.id === s.role ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
      <span class="row" style="gap:6px"><button class="btn small" data-reset="${esc(s.id)}" data-email="${esc(s.email)}">Tweede stap wissen</button><button class="btn small danger" data-remove="${esc(s.id)}" data-email="${esc(s.email)}">Verwijderen</button></span></span></div></li>`).join("")}</ul>
    <h2>Iemand uitnodigen</h2><form class="panel fields" id="f">
      <div class="row"><label>E-mailadres<input name="email" type="email" required></label><label>Naam <small>(mag leeg)</small><input name="name" maxlength="80"></label></div>
      <fieldset style="border:0;padding:0;margin:0" class="fields"><legend class="hint">Rol</legend>${r.roles.map((x, i) => `<label class="check"><input type="radio" name="role" value="${x.id}"${i === 2 ? " checked" : ""}> <span><b>${esc(x.label)}</b> — <span class="muted">${esc(ROLE_TEXT[x.id])}</span></span></label>`).join("")}</fieldset>
      <div class="row"><button class="btn primary">Uitnodigen</button></div><p class="msg" id="m"></p></form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      try { await api("/v1/admin/staff", { body: formObj(e.target) }); toast("Uitgenodigd; er is een mail verstuurd"); rerender(); } catch (err) { setMsg($("#m"), err.message); }
    });
  };
  $$("[data-role]").forEach((sel) => sel.onchange = async () => {
    try { await api(`/v1/admin/staff/${sel.dataset.role}`, { method: "PATCH", body: { role: sel.value } }); toast("Rol gewijzigd"); if (sel.dataset.role === me.staff.id) return start(); }
    catch (err) { toast(err.message, true); }
    rerender();
  });
  $$("[data-remove]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Medewerker verwijderen?", `${b.dataset.email} kan dan meteen niet meer in het beheer.`, "Verwijderen", true))) return;
    await busy(b, async () => { await api(`/v1/admin/staff/${b.dataset.remove}`, { method: "DELETE" }); rerender(); });
  });
  $$("[data-reset]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Tweede stap wissen?", `Telefoon kwijt? ${b.dataset.email} wordt uitgelogd en stelt bij de volgende keer inloggen opnieuw een vingerafdruk of authenticator-app in.`, "Wissen", true))) return;
    await busy(b, async () => { await api(`/v1/admin/staff/${b.dataset.reset}/reset`, { body: {} }); toast("Gewist"); rerender(); });
  });
}

// ───────── Logboek ─────────

async function logboek() {
  let before = null;
  root.innerHTML = `<h1>Logboek</h1><p class="lead">Alles wat medewerkers in het beheer doen: wie, wat en wanneer.</p><ul class="events" id="log"></ul><p><button class="btn" id="more">Meer laden</button></p>`;
  const more = async () => {
    const r = await api(`/v1/admin/audit?limit=100${before ? `&before=${before}` : ""}`);
    $("#log").insertAdjacentHTML("beforeend", r.entries.map((e) => `<li><time>${dt(e.at)}</time><b>${esc(e.staff ?? "systeem")}</b> — ${esc(AUDIT[e.action] ?? e.action)}${e.target ? ` <span class="mono">${esc(e.target)}</span>` : ""}${e.detail ? ` <code>${esc(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 300)}</code>` : ""}</li>`).join(""));
    if (r.entries.length) before = r.entries[r.entries.length - 1].id;
    $("#more").hidden = r.entries.length < 100;
    if (!$("#log").children.length) $("#log").innerHTML = `<li class="muted">Nog niets.</li>`;
  };
  $("#more").onclick = () => busy($("#more"), more);
  await more();
}

// ───────── Mijn account ─────────

async function account() {
  const { staff: s } = await api("/v1/admin/me");
  me.staff = s;
  root.innerHTML = `<h1>Mijn account</h1><p class="lead">${esc(s.email)} · ${esc(ROLE_LABELS[s.role])}</p>
    <form class="panel row" id="nf"><label>Naam <small>(klanten zien je voornaam bij antwoorden)</small><input name="name" value="${esc(s.name ?? "")}" maxlength="80"></label><button class="btn">Opslaan</button></form>
    <h2>Tweede stap</h2>
    <ul class="list">
      <li><div class="item"><span class="title">Authenticator-app</span><span class="sub">${s.totp ? "Ingesteld" : "Niet ingesteld"}</span>
        <span class="end">${s.totp ? `<button class="btn small danger" id="totpOff">Uitzetten</button>` : `<button class="btn small" id="totpOn">Instellen</button>`}</span></div></li>
      ${s.devices.map((d) => `<li><div class="item"><span class="title">${esc(d.label ?? "Toestel")}</span><span class="sub">Gekoppeld ${dt(d.createdAt)}${d.lastUsedAt ? ` · laatst ${dt(d.lastUsedAt)}` : ""}</span>
        <span class="end"><button class="btn small danger" data-dev="${esc(d.id)}">Ontkoppelen</button></span></div></li>`).join("")}
    </ul>
    ${hasBridge() ? `<p><button class="btn" id="addDev">Deze telefoon koppelen (vingerafdruk)</button></p>` : `<p class="hint">Een telefoon koppel je door dit beheer te openen in de Eigen Cloud-app.</p>`}
    <div id="totpBox"></div>`;
  $("#nf").onsubmit = async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => { const r = await api("/v1/admin/me/name", { body: formObj(e.target) }); me.staff = r.staff; $("#meLink").textContent = r.staff.name || r.staff.email; toast("Opgeslagen"); });
  };
  const on = $("#totpOn"), off = $("#totpOff"), add = $("#addDev");
  if (on) on.onclick = () => busy(on, async () => {
    const t = await api("/v1/admin/me/totp", { body: {} });
    $("#totpBox").innerHTML = `<div class="panel fields"><div class="qr"><img alt="QR-code voor je authenticator-app" src="data:image/svg+xml;utf8,${encodeURIComponent(t.qrSvg)}"></div>
      <div class="secret">${esc(t.secret.replace(/(.{4})/g, "$1 ").trim())}</div>
      <form class="row" id="tf"><label>Code uit de app<input name="code" class="code-input" inputmode="numeric" maxlength="6" required></label><button class="btn primary">Bevestigen</button></form><p class="msg" id="tm"></p></div>`;
    $("#tf").onsubmit = async (e) => {
      e.preventDefault();
      await busy(e.submitter, async () => { try { await api("/v1/admin/me/totp/confirm", { body: formObj(e.target) }); toast("Authenticator-app ingesteld"); rerender(); } catch (err) { setMsg($("#tm"), err.message); } });
    };
  });
  if (off) off.onclick = async () => {
    if (!(await confirmDlg("Authenticator-app uitzetten?", "Je logt daarna alleen nog in met je gekoppelde telefoon.", "Uitzetten", true))) return;
    await busy(off, async () => { await api("/v1/admin/me/totp", { method: "DELETE" }); rerender(); });
  };
  if (add) add.onclick = () => busy(add, async () => {
    const publicKey = await deviceKey();
    const { challenge } = await api("/v1/admin/me/device/challenge", { body: {} });
    const signature = await deviceSign(challenge);
    await api("/v1/admin/me/device", { body: { publicKey, signature, label: deviceLabel() } });
    toast("Telefoon gekoppeld");
    rerender();
  });
  $$("[data-dev]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDlg("Toestel ontkoppelen?", "Met dit toestel kun je dan niet meer inloggen.", "Ontkoppelen", true))) return;
    await busy(b, async () => { await api(`/v1/admin/me/device/${b.dataset.dev}`, { method: "DELETE" }); rerender(); });
  });
}

// ───────── Start ─────────

fetch("/v1/brand").then((r) => r.json()).then(applyBrand).catch(() => {});
start();
