// Eigen Cloud — beheerconsole
import { europeMap, MAP_CSS } from "/shared/europe.js";
import { renderNodig, regelVenster, NODIG_CSS } from "./nodig.js";
document.head.insertAdjacentHTML("beforeend", `<style>${MAP_CSS}${NODIG_CSS}</style>`);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const root = $("#root");
/** Vlag bij een landcode (NL → 🇳🇱), voor elk land dat een aanbieder opgeeft. */
const FLAGS = new Proxy({}, { get: (_t, cc) => (typeof cc === "string" && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : undefined) });
const eurStr = (m) => (m ? "€ " + String(m.value).replace(".", ",") : "");
const eur = (n) => (n == null ? "prijs onbekend" : "€ " + Number(n).toFixed(2).replace(".", ","));
const time = (ms) => {
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `vandaag ${hm}`;
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return `gisteren ${hm}`;
  return `${d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" })} ${hm}`;
};
/** "Scaleway Amsterdam" in plaats van "scaleway nl-ams-1". */
function placeName(n) {
  const o = state?.offers?.servers.find((x) => x.id === n.provider);
  const r = o?.regions.find((x) => x.id === n.region);
  return `${o?.name.replace(/ Cloud$/, "") ?? n.provider}${r ? " " + r.city : n.region ? " " + n.region : ""}`;
}

// In de Android-app is er geen webserver: de console praat via een brug met de Java-kern op de telefoon.
const NATIVE = window.EigenNative ?? null;
const DEVICE = NATIVE ? "deze telefoon" : "deze computer";
const pending = new Map();
let seq = 0;
window.__eigenReply = (id, status, text) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
  p({ status, ok: status >= 200 && status < 300, json, statusText: "Mislukt" });
};
function nativeFetch(method, path, body) {
  return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); NATIVE.call(id, method, path, body ? JSON.stringify(body) : ""); });
}

async function api(path, opts = {}) {
  let r, j;
  if (NATIVE) {
    r = await nativeFetch(opts.method ?? "GET", path, opts.body);
    j = r.json;
  } else {
    r = await fetch(path, { method: opts.method ?? "GET", headers: opts.body ? { "content-type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    j = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  }
  if (r.status === 401 && path !== "/api/unlock" && path !== "/api/unlock/biometric") {
    // Op slot (verlopen of in een andere browser geopend): slotscherm tonen, niet opnieuw proberen.
    if (state) { state.unlocked = false; clearInterval(timer); $("#lockBtn").hidden = true; renderLock(); }
    throw new Error("De kluis is op slot");
  }
  if (!r.ok) throw Object.assign(new Error(j?.error ?? r.statusText), { data: j });
  return j;
}

if (NATIVE) {
  document.documentElement.classList.add("phone");
  // Links die op een computer een nieuw tabblad openen, regelt de app zelf.
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (href === "/api/recovery-sheet") { e.preventDefault(); NATIVE.printRecoverySheet(); }
    else if (a.dataset.cloud !== undefined) { e.preventDefault(); NATIVE.openCloud(a.href); }
    else if (/^https?:/.test(href)) { e.preventDefault(); NATIVE.openUrl(a.href); }
  }, true);
}

let state = null, config = null, timer = null, dienstTimer = null, aanbiederTimer = null, overstapTimer = null;

const BASE_STEPS = [
  { id: "jij", label: "Jij en je adres" },
  { id: "sleutel", label: "Herstelsleutel" },
  { id: "regelen", label: "Waar je cloud draait" },
  { id: "opslag", label: "Opslag voor back-ups" },
  { id: "servers", label: "Servers" },
  { id: "domein", label: "Domein koppelen" },
  { id: "mail", label: "Mail versturen" },
  { id: "starten", label: "Starten" },
];
/** Met één sleutel of via de dienst regelt de console opslag, servers en mail zelf: die stappen vallen dan weg. */
let STEPS = BASE_STEPS;
function stepsFor(c) {
  const auto = c?.quick || c?.dienst?.applied;
  return BASE_STEPS.filter((x) => !(auto && ["opslag", "servers", "mail"].includes(x.id)));
}
const nextOf = (id) => STEPS[STEPS.findIndex((s) => s.id === id) + 1]?.id ?? "starten";
const prevOf = (id) => STEPS[STEPS.findIndex((s) => s.id === id) - 1]?.id ?? null;

async function boot() {
  // Eerst (hooguit anderhalve seconde) de lijst van aanbieders: dan weet de eerste stap of er een aanbieder antwoordt.
  await Promise.race([api("/api/aanbieders").catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
  state = await api("/api/state");
  render();
}

/** "#aanbieder" en "#aanbieder/<onderdeel>": aanbieder worden, of "Je dienst" met al zijn onderdelen. */
const isDienstHash = (h) => h === "aanbieder" || h.startsWith("aanbieder/");

async function render() {
  clearInterval(timer);
  clearTimeout(dienstTimer);
  clearInterval(aanbiederTimer);
  clearTimeout(overstapTimer);
  $("#lockBtn").hidden = !state.unlocked;
  const hash = location.hash.slice(1);
  if (!state.vault) { $("#dienstLink").hidden = true; return isDienstHash(hash) ? renderAanbiederCreate() : renderStart(); }
  if (!state.unlocked) { $("#dienstLink").hidden = true; return renderLock(); }
  config = await api("/api/config");
  STEPS = stepsFor(config);
  void updateDienstLink();
  // De herstelsleutel bekijken of controleren (ook vanaf de herinnering op het overzicht).
  if (hash === "sleutelcontrole" || hash === "herstelsleutel") return stepKey(!!config.alleenDienst, hash === "sleutelcontrole" ? "check" : "show");
  if (config.alleenDienst) {
    // Kluis alleen voor een Dienst: eerst de herstelsleutel, daarna "Je dienst". "#jij": toch een eigen cloud erbij.
    if (state.step === "sleutel") return stepKey(true);
    if (hash === "jij") return renderCreate(true);
    return renderHub(isDienstHash(hash) ? hash : "aanbieder");
  }
  if (isDienstHash(hash)) return renderHub(hash);
  if (state.done && !STEPS.some((s) => s.id === hash)) return renderDash();
  renderStep(STEPS.some((s) => s.id === hash) ? hash : state.step ?? "sleutel");
}

/** Naar een adres binnen de console; ook als je er al bent (dan komt er geen hashchange). */
function goHash(h) {
  if (location.hash.slice(1) === h) render(); else location.hash = h;
}

/** De link bovenin: "Aanbieder worden", of "<naam> beheren" zodra je Dienst er is. */
async function updateDienstLink() {
  const l = $("#dienstLink");
  try {
    const a = await api("/api/aanbieder");
    l.textContent = a.hub ? `${a.company?.name || "Je dienst"} beheren` : a.started ? "Je dienst opzetten" : "Aanbieder worden";
    l.title = l.textContent;
    // Zonder eigen cloud is "Je dienst" het beginscherm; dan alleen bij "Eigen cloud maken" een weg terug.
    l.hidden = !!config?.alleenDienst && location.hash.slice(1) !== "jij";
    rememberDienst(a);
  } catch { l.hidden = true; }
}

/** De app onthoudt je eigen Dienst (adres en naam) voor het startscherm: "<naam> beheren". */
function rememberDienst(a) {
  try { NATIVE?.rememberDienst?.(a?.hub ? a.url ?? "" : "", a?.hub ? a.company?.name ?? "" : "", config?.alleenDienst ? "1" : ""); } catch { /* oude app */ }
}

$("#lockBtn").onclick = async () => { await api("/api/lock", { method: "POST" }); location.hash = ""; boot(); };
window.addEventListener("hashchange", () => { if (state?.unlocked || (state && !state.vault)) render(); });

function formMsg(form, text, ok = false) {
  const m = $(".msg", form);
  m.textContent = text;
  m.className = "msg " + (ok ? "ok" : "err");
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Bezig…";
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = label; }
}

// ═════════ Sleutels controleren ═════════

/** Het lijstje van "Sleutels controleren": ✓ in orde, ✕ niet in orde (met wat je moet doen), ? onbekend. */
const checkItems = (checks) => checks.map((x) => `<li class="${x.ok === true ? "" : x.ok === false ? "bad" : "unknown"}">${esc(x.label)}${x.detail ? `<small>${esc(x.detail)}</small>` : ""}</li>`).join("");

/**
 * Knop "Sleutels controleren": <button data-check-kind="servers|dns|storage" data-check-id="…" data-check-title="…"
 * data-check-box="#id">. Alleen lezen bij de aanbieder; het resultaat komt in het vak `data-check-box`.
 */
const checkButton = (kind, id, title, box = "#checkBox") => `<button type="button" class="link" data-check-kind="${esc(kind)}" data-check-id="${esc(id)}" data-check-title="${esc(title)}" data-check-box="${esc(box)}">Sleutels controleren</button>`;
document.addEventListener("click", async (e) => {
  const btn = e.target.closest?.("[data-check-kind]");
  if (!btn) return;
  const box = $(btn.dataset.checkBox);
  if (!box) return;
  try {
    const r = await busy(btn, () => api("/api/check", { method: "POST", body: { kind: btn.dataset.checkKind, id: btn.dataset.checkId } }));
    const bad = r.checks.some((x) => x.ok === false);
    box.innerHTML = `<div class="panel"><b>Sleutels van ${esc(btn.dataset.checkTitle)}</b><ul class="results">${checkItems(r.checks)}</ul>
      <p class="muted" style="margin:0"><small>${bad ? "Pas aan wat met ✕ is gemarkeerd en koppel daarna opnieuw." : "Alleen gekeken, niets veranderd. Met ? kan de aanbieder het niet laten zien; dat blijkt bij het starten."}</small></p></div>`;
  } catch (err) { box.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; }
});

// ═════════ Start, slot, herstel ═════════

function renderStart() {
  root.innerHTML = `<section class="center">
    <h1>Je eigen cloud, op jouw plek in Europa.</h1>
    <p class="lead">Mail, agenda en foto's op servers die jij kiest. Deze console helpt je in een paar stappen op weg.</p>
    <div class="choices">
      <button class="choice" id="new"><b>Nieuwe Eigen Cloud maken</b><span class="muted">Ongeveer een kwartier, plus het wachten op een export van Google als je wilt overstappen.</span></button>
      <button class="choice" id="recover"><b>Ik heb al een Eigen Cloud</b><span class="muted">Op een nieuwe ${NATIVE ? "telefoon" : "computer"}, of na een storing: herstellen met je herstelsleutel. Ook voor het beheer van je Dienst.</span></button>
      <button class="choice" id="provider"><b>Aanbieder worden</b><span class="muted">Draai je eigen Eigen Cloud Dienst, met je eigen naam en prijzen. Mensen nemen dan bij jou een cloud. Een eigen cloud is niet nodig.</span></button>
    </div></section>`;
  $("#new").onclick = () => renderCreate();
  $("#recover").onclick = renderRecover;
  $("#provider").onclick = () => goHash("aanbieder");
}

/** Aanbieder worden zonder eigen cloud: eerst een kluis op dit toestel (daarna de herstelsleutel, dan de stappen). */
function renderAanbiederCreate() {
  root.innerHTML = `<section class="center">
    <h1>Aanbieder worden</h1>
    <p class="lead">Met een eigen Eigen Cloud Dienst nemen mensen bij jou een cloud, met jouw naam en prijzen. Ze betalen via jouw Mollie.</p>
    <div class="panel" style="margin:0 0 22px"><b>Wat je nodig hebt</b>
      <ul class="results" style="margin:0">
        <li>Een domein voor je Dienst, bijvoorbeeld dienst.jouwbedrijf.nl</li>
        <li>Accounts bij Scaleway (voor de clouds van je klanten), Mollie en deSEC</li>
        <li>Een mailserver voor inlogcodes en facturen</li>
        <li>Ongeveer een half uur</li>
      </ul>
      <small class="muted">Een eigen cloud is niet nodig. Die kun je later altijd nog maken.</small></div>
    <form class="fields" id="f">
      <h2 style="margin:0">Kluis op ${DEVICE}</h2>
      <p class="muted" style="margin:0">De console bewaart de sleutels van je Dienst versleuteld op ${DEVICE}. Kies een wachtwoordzin die je nergens anders gebruikt, bijvoorbeeld vier losse woorden.</p>
      <div class="row"><label>Wachtwoordzin<input type="password" name="pass" minlength="12" autocomplete="new-password" required></label>
      <label>Nog een keer<input type="password" name="pass2" minlength="12" autocomplete="new-password" required></label></div>
      <p class="msg"></p>
      <div class="actions" style="margin:0"><button class="btn primary">Verder</button><button type="button" class="btn quiet" id="back">Terug</button></div>
    </form></section>`;
  $("#back").onclick = () => { location.hash = ""; renderStart(); };
  const f = $("#f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.pass.value !== f.pass2.value) return formMsg(f, "De wachtwoordzinnen zijn niet gelijk");
    try {
      await busy($("button.primary", f), () => api("/api/setup/aanbieder", { method: "POST", body: { passphrase: f.pass.value } }));
      location.hash = "aanbieder";
      boot();
    } catch (err) { formMsg(f, err.message); }
  };
}

function renderLock() {
  const bio = state?.biometric ?? {};
  root.innerHTML = `<section class="center">
    <h1>Welkom terug</h1>
    <p class="lead">Ontgrendel de kluis met je wachtwoordzin${bio.enrolled ? ", je vingerafdruk of je gezicht" : ""}.</p>
    ${bio.enrolled ? `<p><button class="btn primary big" id="bio">Ontgrendelen met vingerafdruk</button></p>` : ""}
    <form class="fields" id="f">
      <label>Wachtwoordzin<input type="password" name="pass" autocomplete="current-password" required ${bio.enrolled ? "" : "autofocus"}></label>
      ${bio.available && !bio.enrolled ? `<label class="check"><input type="checkbox" name="enroll" checked> Voortaan ontgrendelen met vingerafdruk of gezicht</label>` : ""}
      <p class="msg"></p>
      <div><button class="btn ${bio.enrolled ? "" : "primary"}">Ontgrendelen</button></div>
    </form>
    <p style="margin-top:28px"><button class="link quiet" id="forgot">Wachtwoordzin vergeten?</button></p></section>`;
  $("#forgot").onclick = () => {
    const dlg = document.createElement("dialog");
    dlg.className = "confirm";
    dlg.innerHTML = `<h2>Wachtwoordzin vergeten</h2>
      <p>De wachtwoordzin is nergens anders bewaard; ook wij kunnen hem niet terughalen. Je kunt de kluis op ${DEVICE} wissen en daarna opnieuw beginnen of herstellen.</p>
      <p>Draait je cloud al? Dan blijft hij gewoon draaien. Met je <b>herstelsleutel</b> (op je herstelblad) zet je het beheer daarna terug via <i>Ik heb al een Eigen Cloud</i>.</p>
      <p class="msg"></p>
      <div class="row"><button class="btn danger" data-r="wipe">Kluis wissen</button><button class="btn quiet" data-r="cancel">Annuleren</button></div>`;
    document.body.append(dlg);
    dlg.showModal();
    dlg.onclick = async (e) => {
      const r = e.target.dataset?.r;
      if (r === "cancel") { dlg.close(); dlg.remove(); }
      if (r === "wipe") {
        try { await busy(e.target, () => api("/api/vault/forget", { method: "POST", body: { confirm: true } })); dlg.close(); dlg.remove(); location.hash = ""; boot(); }
        catch (err) { const m = dlg.querySelector(".msg"); m.textContent = err.message; m.className = "msg err"; }
      }
    };
  };
  $("#bio")?.addEventListener("click", async (e) => {
    try { await busy(e.target, () => api("/api/unlock/biometric", { method: "POST" })); boot(); }
    catch (err) { formMsg($("#f"), err.message); }
  });
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy($("button", e.target), () => api("/api/unlock", { method: "POST", body: { passphrase: e.target.pass.value } }));
      if (e.target.enroll?.checked) await api("/api/biometric/enroll", { method: "POST" }).catch(() => {});
      boot();
    }
    catch (err) { formMsg(e.target, err.message); }
  };
  if (bio.enrolled && bio.auto) $("#bio").click();
}

function wizardShell(current, inner) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return `<div class="wizard"><ol class="trail" aria-label="Stappen">
    ${STEPS.map((s, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}" ${i === idx ? 'aria-current="step"' : ""}>
      <span class="pip">${i < idx ? "✓" : ""}</span>${i < idx && (s.id !== "jij" || state?.vault) ? `<a href="#${s.id}">${s.label}</a>` : `<span class="t">${s.label}</span>`}</li>`).join("")}
  </ol><section class="pane">${inner}
    ${state?.vault && !state.done && !config?.alleenDienst ? `<nav class="wiz-nav">${idx > 0 ? `<button type="button" class="link" data-wiz="prev">Vorige stap</button>` : "<span></span>"}<button type="button" class="link quiet" data-wiz="reset">Opnieuw beginnen</button></nav>` : ""}
  </section></div>`;
}

// Vorige stap en opnieuw beginnen werken in elke stap (niet via root.onclick: dat gebruiken de stappen zelf).
document.addEventListener("click", (e) => {
  const w = e.target.closest?.("[data-wiz]")?.dataset.wiz;
  if (!w) return;
  e.preventDefault();
  clearTimeout(dienstTimer);
  if (w === "prev") { const cur = location.hash.slice(1) || state.step; const p = prevOf(cur); if (p) location.hash = p; }
  if (w === "reset") resetDialog();
});

function resetDialog() {
  const hasCloud = config?.stores?.some((s) => s.type === "s3") || !!config?.quick;
  const dlg = document.createElement("dialog");
  dlg.className = "confirm";
  dlg.innerHTML = `<h2>Opnieuw beginnen?</h2>
    <p>Alles wat je in de assistent hebt ingevuld, wordt van ${DEVICE} gewist, ook je herstelsleutel. Je begint daarna bij de eerste stap met een nieuwe sleutel.</p>
    ${hasCloud ? `<p>Wat al bij de aanbieder is aangemaakt (opslag${config?.quick ? " en het maildomein" : ""}), kan de console ook opruimen. Servers zijn er nog niet: die komen pas bij Starten.</p>` : ""}
    <p class="msg"></p>
    <div class="row">${hasCloud ? `<button class="btn danger" data-r="clean">Wissen en opruimen</button><button class="btn" data-r="local">Alleen hier wissen</button>` : `<button class="btn danger" data-r="local">Wissen</button>`}<button class="btn quiet" data-r="cancel">Annuleren</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.onclick = async (e) => {
    const r = e.target.dataset?.r;
    if (!r) return;
    if (r === "cancel") { dlg.close(); dlg.remove(); return; }
    try {
      const res = await busy(e.target, () => api("/api/setup/reset", { method: "POST", body: { cleanup: r === "clean" } }));
      if (res.left?.length) {
        dlg.innerHTML = `<h2>Gewist</h2><p>Een paar dingen bij de aanbieder konden niet weg:</p><ul>${res.left.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <p class="muted">Een back-up is 30 dagen beschermd tegen wissen. Hij kost vrijwel niets; daarna kun je hem in de console van de aanbieder verwijderen.</p><div class="row"><button class="btn primary" data-r="ok">Verder</button></div>`;
        dlg.onclick = (ev) => { if (ev.target.dataset?.r) { dlg.close(); dlg.remove(); location.hash = ""; boot(); } };
        return;
      }
      dlg.close(); dlg.remove(); location.hash = ""; boot();
    } catch (err) { const m = dlg.querySelector(".msg"); m.textContent = err.message; m.className = "msg err"; }
  };
  dlg.addEventListener("cancel", () => dlg.remove());
}

const DOMAIN_HINTS = {
  own: "Straks zet je bij de partij waar je domein staat de nameservers om. De console vertelt precies wat je moet invullen.",
  buy: "De Eigen Cloud Dienst registreert hem voor je; de kosten zitten in je abonnement.",
  free: "Gratis van deSEC (open source, non-profit, Berlijn). Prima om te beginnen. Voor mail is een eigen domein beter: sommige ontvangers vertrouwen gratis adressen minder.",
};

/** Stap "Jij en je adres". `upgrade`: je hebt al een kluis voor je Dienst; er komt een eigen cloud bij (geen nieuwe kluis). */
function renderCreate(upgrade = false) {
  root.innerHTML = wizardShell("jij", `
    ${upgrade ? `<p><a class="link" href="#aanbieder">Terug naar je dienst</a></p>` : ""}
    <h1>Jij en je adres</h1>
    <p class="lead">Je cloud krijgt een eigen adres op internet. Daaraan hangen je mailadres en de link naar je cloud.</p>
    <form class="fields" id="f">
      <fieldset class="radios">
        <label class="check"><input type="radio" name="domainMode" value="own" checked> Ik heb een eigen domein</label>
        ${state.dienst ? `<label class="check"><input type="radio" name="domainMode" value="buy"> Nieuw domein kopen</label>` : ""}
        <label class="check"><input type="radio" name="domainMode" value="free"> Gratis adres</label>
      </fieldset>
      <label><span id="domTitle">Domeinnaam</span><div class="suffix"><input name="domain" placeholder="vanes.nl" autocomplete="off" autocapitalize="off" required><span id="domSuffix" hidden>.dedyn.io</span></div><small id="domHint"></small></label>
      <p class="msg" id="avail" style="margin:-6px 0 0"></p>
      <label>Je e-mailadres<div class="suffix"><input name="mailbox" placeholder="rene" autocapitalize="off" required><span id="at">@…</span></div></label>
      <label>Wachtwoord om in je cloud in te loggen<input type="password" name="appPassword" minlength="10" autocomplete="new-password" required><small>Minstens 10 tekens. Dit gebruik je dagelijks, ook op je telefoon.</small></label>
      <label>Meldingen bij problemen naar<input type="email" name="alertEmail" placeholder="een adres bij een andere aanbieder"><small id="alertHint">Kies een adres buiten je nieuwe domein, zodat een melding ook aankomt als je mail stuk is.</small></label>
      ${upgrade ? "" : `<h2>Kluis van deze console</h2>
      <p class="muted" style="margin:0">De console bewaart je sleutels en API-tokens versleuteld op ${DEVICE}. Kies een wachtwoordzin die je nergens anders gebruikt, bijvoorbeeld vier losse woorden.</p>
      <div class="row"><label>Wachtwoordzin<input type="password" name="pass" minlength="12" autocomplete="new-password" required></label>
      <label>Nog een keer<input type="password" name="pass2" minlength="12" autocomplete="new-password" required></label></div>`}
      <p class="msg"></p>
      <div class="next"><button class="btn primary">Verder</button></div>
    </form>`);
  const f = $("#f");
  const full = () => { const v = f.domain.value.trim().toLowerCase(); return f.domainMode.value === "free" ? (v ? v.replace(/\.dedyn\.io$/, "") + ".dedyn.io" : "") : v; };
  let checkTimer = null;
  const upd = () => {
    const m = f.domainMode.value;
    $("#domTitle").textContent = m === "free" ? "Kies een naam" : "Domeinnaam";
    f.domain.placeholder = m === "free" ? "vanes" : "vanes.nl";
    $("#domSuffix").hidden = m !== "free";
    $("#domHint").textContent = DOMAIN_HINTS[m];
    f.alertEmail.required = m === "free";
    $("#alertHint").textContent = m === "free" ? "Nodig: hiermee maakt de console je gratis deSEC-account aan. Gebruik een adres buiten je nieuwe domein." : "Kies een adres buiten je nieuwe domein, zodat een melding ook aankomt als je mail stuk is.";
    $("#at").textContent = "@" + (full() || "…");
    $("#avail").textContent = "";
    clearTimeout(checkTimer);
    if (m === "buy" && /\.[a-z]{2,}$/.test(full())) {
      checkTimer = setTimeout(async () => {
        try {
          const r = await api(`/api/dienst/check?name=${encodeURIComponent(full())}`);
          if (!$("#avail")) return; // intussen verder gegaan
          $("#avail").textContent = r.available ? `✓ ${r.domain} is vrij${r.price ? ` (${eurStr(r.price)} per jaar, zit in je abonnement)` : ""}` : `✕ ${r.domain} is al bezet. Heb jij hem? Kies dan "Ik heb een eigen domein".`;
          $("#avail").className = "msg " + (r.available ? "ok" : "err");
        } catch (err) { if ($("#avail")) { $("#avail").textContent = err.message; $("#avail").className = "msg err"; } }
      }, 500);
    }
  };
  f.onchange = upd;
  f.domain.oninput = upd;
  upd();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { domain: f.domain.value, domainMode: f.domainMode.value, mailbox: f.mailbox.value, appPassword: f.appPassword.value, alertEmail: f.alertEmail.value };
    if (upgrade) {
      try {
        const r = await busy($("button.primary", f), () => api("/api/setup/cloud", { method: "POST", body }));
        state.step = r.step;
        location.hash = r.step;
        boot();
      } catch (err) { formMsg(f, err.message); }
      return;
    }
    if (f.pass.value !== f.pass2.value) return formMsg(f, "De wachtwoordzinnen zijn niet gelijk");
    try {
      await busy($("button.primary", f), () => api("/api/setup/create", { method: "POST", body: { ...body, passphrase: f.pass.value } }));
      location.hash = "sleutel";
      boot();
    } catch (err) { formMsg(f, err.message); }
  };
}

function storeFields(offers, prefix = "") {
  return `<label>Aanbieder<select name="${prefix}offer">${offers.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select></label>
    <label>Locatie<select name="${prefix}region"></select></label>
    <label class="ep" hidden>Endpoint-URL<input name="${prefix}endpoint" placeholder="https://…"></label>
    <div class="row creds"><label>Toegangssleutel<input name="${prefix}accessKey" autocomplete="off"></label><label>Geheime sleutel<input type="password" name="${prefix}secretKey" autocomplete="off"></label></div>`;
}

function wireStoreFields(form, offers) {
  const upd = () => {
    const o = offers.find((x) => x.id === form.offer.value);
    form.region.innerHTML = o.regions.map((r) => `<option value="${r.id}">${FLAGS[r.country] ?? ""} ${esc(r.label)}</option>`).join("");
    $(".ep", form).hidden = !o.customEndpoint;
    $(".creds", form).hidden = o.id === "localfs";
  };
  form.offer.onchange = upd;
  upd();
}

function renderRecover() {
  const offers = state.offers.stores;
  root.innerHTML = `<section class="center" style="max-width:620px">
    <h1>Herstellen met je sleutel</h1>
    <p class="lead">Met je herstelsleutel en de toegang tot één opslag haalt de console alle instellingen terug.</p>
    ${state.dienst ? `<p><button type="button" class="btn" id="viaDienst">Herstellen via de Eigen Cloud Dienst</button><br><small>Heb je een pakket bij de dienst? Dan heb je alleen je e-mailadres en je herstelsleutel nodig.</small></p>` : ""}
    <form class="fields" id="f">
      <label>Herstelsleutel<input name="key" placeholder="8 groepen van 8 tekens" autocomplete="off" required><small>Spaties maken niet uit.</small></label>
      <h2 style="margin:8px 0 0">Een opslag waar je back-ups staan</h2>
      ${storeFields(offers)}
      <label>Bucket<input name="bucket"><small>Weet je het niet meer? Laat leeg, dan zoekt de console zelf.</small></label>
      <h2 style="margin:8px 0 0">Nieuwe kluis op ${DEVICE}</h2>
      <label>Wachtwoordzin<input type="password" name="pass" minlength="12" required></label>
      <p class="msg"></p>
      <div><button class="btn primary">Herstellen</button> <button type="button" class="link" id="back">Terug</button></div>
    </form></section>`;
  const f = $("#f");
  wireStoreFields(f, offers);
  $("#back").onclick = renderStart;
  if ($("#viaDienst")) $("#viaDienst").onclick = renderRecoverDienst;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const o = offers.find((x) => x.id === f.offer.value), r = o.regions.find((x) => x.id === f.region.value);
    if (o.id === "localfs" && !f.bucket.value) return formMsg(f, "Vul de map in waar je back-ups staan");
    const store = o.id === "localfs"
      ? { name: "herstel", type: "fs", purpose: "replica", dir: f.bucket.value }
      : { name: "herstel", type: "s3", purpose: "replica", endpoint: o.customEndpoint ? f.endpoint.value : r.endpoint, region: r.id, bucket: f.bucket.value, accessKey: f.accessKey.value, secretKey: f.secretKey.value };
    try { await busy($("button", f), () => api("/api/setup/recover", { method: "POST", body: { masterKey: f.key.value, passphrase: f.pass.value, store } })); location.hash = ""; boot(); }
    catch (err) { formMsg(f, err.message); }
  };
}

function renderRecoverDienst() {
  root.innerHTML = `<section class="center" style="max-width:620px">
    <h1>Herstellen via de Eigen Cloud Dienst</h1>
    <p class="lead">De dienst weet waar je opslag staat. Jouw gegevens kan hij niet lezen: daarvoor is je herstelsleutel nodig.</p>
    <form class="fields" id="f1">
      <label>E-mailadres van je pakket<input type="email" name="email" autocomplete="email" required></label>
      <p class="msg"></p>
      <div><button class="btn primary">Stuur code</button> <button type="button" class="link" id="back">Terug</button></div>
    </form>
    <form class="fields" id="f2" hidden>
      <label>Code uit de e-mail<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
      <p class="msg"></p>
      <div><button class="btn primary">Bevestigen</button></div>
    </form>
    <form class="fields" id="f3" hidden>
      <label>Herstelsleutel<input name="key" placeholder="8 groepen van 8 tekens" autocomplete="off" required><small>Spaties maken niet uit.</small></label>
      <label>Nieuwe wachtwoordzin voor ${DEVICE}<input type="password" name="pass" minlength="12" required></label>
      <p class="msg"></p>
      <div><button class="btn primary">Herstellen</button></div>
    </form></section>`;
  const f1 = $("#f1"), f2 = $("#f2"), f3 = $("#f3");
  $("#back").onclick = renderRecover;
  f1.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", f1), () => api("/api/recover/dienst/login", { method: "POST", body: { email: f1.email.value } })); f1.hidden = true; f2.hidden = false; f2.code.focus(); }
    catch (err) { formMsg(f1, err.message); }
  };
  f2.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", f2), () => api("/api/recover/dienst/verify", { method: "POST", body: { code: f2.code.value } })); f2.hidden = true; f3.hidden = false; f3.key.focus(); }
    catch (err) { formMsg(f2, err.message); }
  };
  f3.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", f3), () => api("/api/setup/recover-dienst", { method: "POST", body: { masterKey: f3.key.value, passphrase: f3.pass.value } })); location.hash = ""; boot(); }
    catch (err) { formMsg(f3, err.message); }
  };
}

// ═════════ Stappen ═════════

async function go(step) {
  await api("/api/step", { method: "POST", body: { step } });
  state.step = step;
  location.hash = step;
}

function renderStep(id) {
  const fn = ({ jij: stepJij, sleutel: () => stepKey(), regelen: stepRegelen, opslag: stepStores, servers: stepServers, domein: stepDns, mail: stepMail, starten: stepLaunch, klaar: renderDash })[id] ?? stepKey;
  fn();
}

/**
 * De herstelsleutel: eerst opschrijven of afdrukken (`mode` "show"), dan zonder sleutel in beeld één groep invullen ("check").
 * `dienst`: kluis alleen voor een Dienst (daarna naar "Je dienst").
 */
async function stepKey(dienst = false, mode = "show") {
  const k = await api("/api/key");
  const wrap = (inner) => { root.innerHTML = dienst || state.done ? `<section class="center keypage">${inner}</section>` : wizardShell("sleutel", inner); };
  if (mode === "check") return keyCheck(dienst, k, wrap);
  wrap(`
    <h1>Je herstelsleutel</h1>
    <p class="lead">${dienst ? "Hiermee haal je het beheer van je Dienst terug op een ander toestel. De console bewaart een versleutelde kopie bij de back-ups van je Dienst; alleen deze sleutel opent hem." : "Alles wat je cloud opslaat, wordt hiermee versleuteld. Zonder deze sleutel kan niemand je back-ups lezen — ook jij niet."}</p>
    <div class="key">${k.groups.map((g, i) => `<div>${g}<small>groep ${i + 1}</small></div>`).join("")}</div>
    <p class="muted">Controlegetal ${k.check}</p>
    <div class="note">Druk het herstelblad af of schrijf de sleutel over, en bewaar het op twee plekken: thuis bij je belangrijke papieren en bij iemand die je vertrouwt. Niet als foto op je telefoon.</div>
    <p class="muted"><small>Geen printer bij de hand? Kies bij afdrukken voor "Opslaan als PDF" en druk hem later af.</small></p>
    <div class="next"><a class="btn primary" href="/api/recovery-sheet" target="_blank" rel="noopener">Herstelblad afdrukken</a><button class="btn" id="kNext">${k.confirmed ? "Verder" : "Ik heb hem opgeschreven"}</button></div>`);
  $("#kNext").onclick = () => (k.confirmed ? afterKey(dienst) : goHash("sleutelcontrole"));
}

/** Even controleren: de sleutel is niet in beeld; de server kiest welke groep we vragen. */
function keyCheck(dienst, k, wrap) {
  const ask = k.ask;
  wrap(`
    <h1>Even controleren</h1>
    <p class="lead">Pak je herstelblad of je briefje erbij. Wat staat er bij groep ${ask}?</p>
    <form class="fields" id="f" novalidate>
      <label>Groep ${ask}<input name="v" class="keyinput" maxlength="8" inputmode="text" enterkeyhint="done" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" aria-describedby="kmsg"><small>8 tekens: cijfers en de letters a tot en met f.</small></label>
      <p class="msg" id="kmsg" role="status"></p>
      <p id="kBackRow" hidden><button type="button" class="link" id="kBack">Sleutel nog eens bekijken</button></p>
      <div class="next"><button class="btn primary">Controleren</button>${k.confirmed ? "" : `<button type="button" class="link quiet" id="kLater">Later controleren</button>`}</div>
    </form>`);
  const f = $("#f"), inp = f.v, msg = $("#kmsg");
  const clean = (x) => x.replace(/\s/g, "").toLowerCase().replace(/o/g, "0").replace(/[il]/g, "1").slice(0, 8);
  let busyCheck = false;
  const check = async () => {
    if (busyCheck) return;
    if (clean(inp.value).length < 8) { msg.textContent = "Vul alle 8 tekens van de groep in."; msg.className = "msg err"; inp.focus(); return; }
    busyCheck = true;
    try {
      await api("/api/key/confirm", { method: "POST", body: { group: ask, value: inp.value } });
      msg.textContent = "Klopt. Je herstelsleutel is goed bewaard.";
      msg.className = "msg ok";
      $("#kBackRow").hidden = true;
      inp.disabled = true;
      $(".next", f).style.visibility = "hidden";
      setTimeout(() => afterKey(dienst), 900);
    } catch (err) {
      busyCheck = false;
      msg.textContent = err.message;
      msg.className = "msg err";
      $("#kBackRow").hidden = false;
      inp.select();
    }
  };
  inp.addEventListener("paste", (e) => {
    e.preventDefault();
    inp.value = clean((e.clipboardData ?? window.clipboardData).getData("text"));
    inp.dispatchEvent(new Event("input"));
  });
  inp.addEventListener("input", () => {
    const v = clean(inp.value);
    if (v !== inp.value) inp.value = v;
    if (v.length < 8 && msg.className.includes("err")) { msg.textContent = ""; msg.className = "msg"; }
    if (v.length === 8) check();
  });
  f.onsubmit = (e) => { e.preventDefault(); check(); };
  $("#kBack").onclick = async () => { await api("/api/key/new-group", { method: "POST" }).catch(() => {}); goHash("herstelsleutel"); };
  $("#kLater")?.addEventListener("click", async (e) => {
    try { await busy(e.target, () => api("/api/key/later", { method: "POST" })); config = await api("/api/config"); afterKey(dienst); }
    catch (err) { msg.textContent = err.message; msg.className = "msg err"; }
  });
  inp.focus();
}

/** Na de herstelsleutel verder: in de stappen naar "Waar draait je cloud?", bij een Dienst-kluis naar "Je dienst", anders terug naar het overzicht. */
async function afterKey(dienst) {
  if (dienst) {
    if (state.step === "sleutel") { await api("/api/step", { method: "POST", body: { step: "dienst" } }); state.step = "dienst"; }
    return goHash("aanbieder");
  }
  if (state.done) return goHash("");
  if (state.step === "sleutel") return go("regelen");
  goHash(state.step);
}

/** Herinnering op het overzicht en bij "Je dienst" zolang de herstelsleutel niet gecontroleerd is. */
const keyReminder = () => config && config.keyCheck && config.keyCheck !== "ok" ? `<div class="panel keyremind">
    <div><b>Herstelsleutel nog niet gecontroleerd</b><br><span class="muted">Pak je herstelblad erbij en vul één groep in. Zo weet je zeker dat je ${config.alleenDienst ? "het beheer van je Dienst" : "je cloud"} altijd kunt terughalen.</span></div>
    <div><a class="btn" href="#sleutelcontrole">Nu controleren</a></div></div>` : "";

// ═════════ Zelf of via de Eigen Cloud Dienst ═════════

let dienstInfoCache = null, lastCheckout = null;

/** Huisstijl van de gekozen aanbieder toepassen (accentkleur), of terug naar de standaard. */
function applyBrand(brand) {
  const ok = brand?.accentColor && /^#[0-9a-f]{6}$/i.test(brand.accentColor);
  if (ok) document.documentElement.style.setProperty("--accent", brand.accentColor);
  else document.documentElement.style.removeProperty("--accent");
}
const brandLine = (b) => b?.name ? `<div class="byline">${b.logo ? `<img src="${esc(b.logo)}" alt="" class="blogo">` : ""}<span>Aangeboden door <b>${esc(b.name)}</b>${b.contact?.email ? ` · <a href="mailto:${esc(b.contact.email)}">${esc(b.contact.email)}</a>` : ""}${b.contact?.phone ? ` · ${esc(b.contact.phone)}` : ""}</span></div>` : "";

let aanbiederKeuze = false;
async function stepRegelen() {
  if (config.dienst?.orderId) return dienstProgress();
  // Uitnodigingslink geopend op de telefoon? Dan die aanbieder meteen kiezen.
  const inv = (() => { try { return NATIVE?.pendingInvite ? JSON.parse(NATIVE.pendingInvite()) : null; } catch { return null; } })();
  if (inv?.dienst && inv.code) {
    try { await api("/api/dienst/select", { method: "POST", body: { url: inv.dienst, invite: inv.code } }); config = await api("/api/config"); }
    catch (err) { alert(`De uitnodiging werkt niet: ${err.message}`); }
    NATIVE.clearInvite?.();
  }
  const { aanbieders: list } = await api("/api/aanbieders").catch(() => ({ aanbieders: [] }));
  // Een aanbieder die (nog) niet antwoordt, tonen we wel maar kiezen we nooit vanzelf.
  const usable = list.filter((a) => a.bereikbaar !== false);
  const waiting = list.filter((a) => a.bereikbaar === false);
  if (list.length > 1 && usable.length && !config.dienst?.url && !aanbiederKeuze) return chooseAanbieder(list);
  aanbiederKeuze = false;
  const chosen = config.dienst?.url || usable[0]?.url || null;
  dienstInfoCache = chosen ? await api(`/api/aanbieder/brand?url=${encodeURIComponent(chosen)}`).catch(() => null) : null;
  applyBrand(dienstInfoCache);
  const info = dienstInfoCache;
  const q = config.quick === "scaleway";
  const dienstHtml = info ? `<section class="dienst">
      <h2>${q ? esc(info.name) : `${esc(info.name)} regelt alles`}</h2>
      ${brandLine(info)}
      ${list.length > 1 && usable.length && !config.dienst?.orderId ? `<p style="margin:0 0 10px"><button class="link" id="otherAanbieder">Andere aanbieder kiezen</button></p>` : ""}
      <p class="muted" style="margin:0 0 12px">Geen account en geen sleutels: servers en opslag in Amsterdam en Parijs, ${info.freeZone ? `een gratis adres (naam.${esc(info.freeZone)}) of je eigen domein` : "je domein"}, DNS en mail. Eén bedrag per maand, betalen met iDEAL, maandelijks opzegbaar. Je kunt later alles meenemen naar je eigen accounts.</p>
      <div class="presets">${info.bundles.map((b) => `<button class="preset" data-bundle="${esc(b.id)}">
        <b>${esc(b.title)}</b><span class="price">${eurStr(b.monthly)} per maand</span><p>${esc(b.description)}</p>
        <p><small>${b.includes.dataServers} dataservers en ${b.includes.witnesses} witness · ${b.includes.storageGb} GB opslag${b.includes.domain ? " · domein" : ""}${b.includes.mail ? " · mail-relay" : ""}</small></p></button>`).join("")}</div>
    </section>` : !usable.length && waiting.length ? `<p class="note">${esc(waiting.map((a) => a.naam).join(", "))} ${waiting.length === 1 ? "is" : "zijn"} nog niet beschikbaar. Regel het voorlopig zelf hieronder; overstappen naar een aanbieder kan later altijd.</p>`
    : state.dienst ? `<p class="note warn">De Eigen Cloud Dienst is nu niet bereikbaar. Je kunt het ook zelf regelen.</p>` : "";
  const quickHtml = `<section class="quick" id="quick">
      <h2>${q ? "✓ Alles staat klaar bij Scaleway" : info ? "Of zelf, met één sleutel bij Scaleway" : "Eén sleutel, de app regelt de rest"}</h2>
      ${q ? `<p class="muted">Opslag in Amsterdam en Parijs, servers in Amsterdam${config.mailRelay ? " en mail via Scaleway" : ""}. Je betaalt Scaleway rechtstreeks.</p>
        <div class="next"><button class="btn primary" id="qnext">Verder</button><button class="link" id="qagain">Andere sleutel gebruiken</button></div>`
      : quickForm()}
    </section>`;
  root.innerHTML = wizardShell("regelen", `
    <h1>Waar draait je cloud?</h1>
    <p class="lead">Je cloud heeft servers, opslag voor back-ups en een manier om mail te versturen nodig. ${info ? "Dat kunnen wij voor je regelen, of de app zet het klaar bij een aanbieder van jezelf." : "De app zet dat zelf voor je klaar."} Je gegevens zijn altijd versleuteld met jouw sleutel${info ? "; ook de dienst kan ze niet lezen" : ""}.</p>
    ${q ? quickHtml + dienstHtml : dienstHtml + quickHtml}
    <p class="advanced"><button class="link" id="zelf">Zelf per onderdeel kiezen</button> <span class="muted">— voor wie aanbieders wil combineren (${esc([...new Set([...state.offers.servers, ...state.offers.stores].map((o) => o.name.split(" ")[0]))].join(", "))})</span></p>`);
  $("#zelf").onclick = async () => { if (q) await api("/api/quick/off", { method: "POST" }); config = await api("/api/config"); go("opslag"); };
  $("#otherAanbieder")?.addEventListener("click", () => chooseAanbieder(list));
  root.onclick = async (e) => {
    const b = e.target.closest?.("[data-bundle]")?.dataset.bundle;
    if (!b) return;
    // De standaardaanbieder zonder expliciete keuze: nu vastleggen bij welke aanbieder je bestelt.
    if (!config.dienst?.url && info?.url) { try { await api("/api/dienst/select", { method: "POST", body: { url: info.url } }); config = await api("/api/config"); } catch { /* standaard blijft */ } }
    dienstLogin(b);
  };
  if (q) {
    $("#qnext").onclick = () => go(nextOf("regelen"));
    $("#qagain").onclick = () => { $("#quick").innerHTML = `<h2>Een andere sleutel van Scaleway</h2>${quickForm()}`; wireQuick(); };
  } else wireQuick();
}

/** Eén aanbieder in een keuzelijst; een aanbieder die nog niet antwoordt, is te zien maar niet te kiezen. */
function aanbiederChoice(a, i, p) {
  const off = a.bereikbaar === false;
  return `<button class="choice aanbieder" data-i="${i}"${off ? " disabled aria-disabled=\"true\"" : ""}><span class="alogo" id="${p}logo${i}"></span><span><b>${esc(a.naam)}</b><span class="muted">${esc([a.land, a.omschrijving].filter(Boolean).join(" · "))}</span><span class="muted aprice" id="${p}price${i}">${off ? "Nog niet beschikbaar" : ""}</span></span></button>`;
}
/** Logo en "vanaf"-prijs ophalen voor de aanbieders die antwoorden. */
function aanbiederBrands(list, p) {
  list.forEach(async (a, i) => {
    if (a.bereikbaar === false) return;
    try {
      const b = await api(`/api/aanbieder/brand?url=${encodeURIComponent(a.url)}`);
      if (b.logo && $(`#${p}logo${i}`)) $(`#${p}logo${i}`).innerHTML = `<img src="${esc(b.logo)}" alt="">`;
      const from = (b.bundles ?? []).map((x) => Number(x.monthly?.value)).filter((n) => n > 0).sort((x, y) => x - y)[0];
      if (from && $(`#${p}price${i}`)) $(`#${p}price${i}`).textContent = `vanaf ${eurStr({ currency: "EUR", value: from.toFixed(2) })} per maand`;
    } catch { if ($(`#${p}price${i}`)) $(`#${p}price${i}`).textContent = "nu niet bereikbaar"; }
  });
}

/** Kiezen uit de aanbieders op de openbare lijst, of met een uitnodigingscode. */
function chooseAanbieder(list) {
  root.innerHTML = wizardShell("regelen", `
    <h1>Kies een aanbieder</h1>
    <p class="lead">Een aanbieder regelt je servers, opslag, adres en mail, voor een vast bedrag per maand. Je gegevens blijven versleuteld met jouw sleutel; ook de aanbieder kan ze niet lezen. Je kunt later overstappen.</p>
    <div class="choices" id="alist">${list.map((a, i) => aanbiederChoice(a, i, "a")).join("")}</div>
    <form class="fields" id="cf" style="margin-top:22px"><label>Heb je een uitnodigingscode?<div class="paste"><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="bijv. ABCD-1234"><button class="btn">Gebruiken</button></div></label><p class="msg"></p></form>
    <p class="advanced"><button class="link" id="zelfKiezen">Zelf regelen, zonder aanbieder</button></p>`);
  aanbiederBrands(list, "a");
  $("#alist").onclick = async (e) => {
    const i = e.target.closest?.("[data-i]:not([disabled])")?.dataset.i;
    if (i === undefined) return;
    try { await api("/api/dienst/select", { method: "POST", body: { url: list[Number(i)].url } }); config = await api("/api/config"); stepRegelen(); }
    catch (err) { formMsg($("#cf"), err.message); }
  };
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    for (const a of list.filter((x) => x.bereikbaar !== false)) {
      const r = await api(`/api/aanbieder/invite?url=${encodeURIComponent(a.url)}&code=${encodeURIComponent(code)}`).catch(() => null);
      if (r?.valid) {
        try { await api("/api/dienst/select", { method: "POST", body: { url: a.url, invite: code } }); config = await api("/api/config"); return stepRegelen(); }
        catch (err) { return formMsg(e.target, err.message); }
      }
    }
    formMsg(e.target, "Deze code kennen we bij geen enkele aanbieder. Gebruik de link uit je uitnodiging, of kies hierboven.");
  };
  $("#zelfKiezen").onclick = () => { aanbiederKeuze = true; stepRegelen(); };
}

function quickForm() {
  return `<p class="muted" style="margin-top:0">Je maakt zelf een account aan; de app doet de rest. Bij Scaleway (Frankrijk, datacenters in Amsterdam en Parijs) staat straks alles: opslag, servers en mail. Je betaalt hen rechtstreeks, meestal tussen de 15 en 25 euro per maand.</p>
    <ol class="guide">
      <li><b>Maak een account bij Scaleway.</b> Daarvoor heb je je naam en een betaalmethode nodig; dat kan de app niet voor je doen.
        <div><button type="button" class="btn" data-open="${esc(state.scaleway.signup)}">Account maken</button> <span class="muted">Heb je er al een? Dan kun je deze stap overslaan.</span></div></li>
      <li><b>Maak een API-sleutel.</b> Kies <i>Generate API key</i>, laat hem voor jezelf gelden (je eigen gebruiker) en bij <i>Object Storage</i> voor je standaardproject. Kopieer de twee sleutels die Scaleway dan één keer laat zien.
        <div><button type="button" class="btn" data-open="${esc(state.scaleway.keys)}">Sleutelpagina openen</button></div></li>
      <li><b>Kom terug.</b> ${NATIVE ? "De app vult gekopieerde sleutels vanzelf in." : "Plak de sleutels hieronder."}</li>
    </ol>
    <form class="fields" id="qf">
      <label>Toegangssleutel (access key)<div class="paste"><input name="accessKey" placeholder="SCW…" autocomplete="off" autocapitalize="characters" spellcheck="false" required><button type="button" class="btn" data-paste>Plakken</button></div></label>
      <label>Geheime sleutel (secret key)<div class="paste"><input name="secretKey" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false" required><button type="button" class="btn" data-paste>Plakken</button></div></label>
      <details class="adv"><summary>Project kiezen (meestal niet nodig)</summary><label>Project-ID<input name="projectId" autocomplete="off" spellcheck="false" placeholder="leeg = het standaardproject van de sleutel"></label></details>
      <ul class="results" id="qres"></ul>
      <p class="msg"></p>
      <div class="next"><button class="btn primary big">Alles klaarzetten</button></div>
    </form>`;
}

const SCW_ACCESS = /SCW[A-Z0-9]{17}/, SCW_SECRET = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Gekopieerde sleutels herkennen en in het juiste veld zetten. Geeft true als er iets is ingevuld. */
function fillKeys(f, text) {
  if (!text || !f?.isConnected) return false;
  let hit = false;
  const a = SCW_ACCESS.exec(text.toUpperCase()), sec = SCW_SECRET.exec(text);
  if (a && f.accessKey.value !== a[0]) { f.accessKey.value = a[0]; hit = true; }
  if (sec && f.secretKey.value.toLowerCase() !== sec[0].toLowerCase()) { f.secretKey.value = sec[0].toLowerCase(); hit = true; }
  if (hit) formMsg(f, f.accessKey.value && f.secretKey.value ? "Beide sleutels zijn ingevuld." : "Ingevuld. Kopieer nu ook de andere sleutel.", true);
  return hit;
}

async function readClipboard() {
  if (NATIVE?.clipboard) return NATIVE.clipboard();
  try { return await navigator.clipboard.readText(); } catch { return ""; }
}

let quickWatch = null;
function wireQuick() {
  const f = $("#qf");
  root.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => (NATIVE ? NATIVE.openUrl(b.dataset.open) : window.open(b.dataset.open, "_blank", "noopener")));
  f.querySelectorAll("[data-paste]").forEach((b) => b.onclick = async () => {
    const t = await readClipboard();
    if (!fillKeys(f, t)) {
      const input = b.previousElementSibling;
      if (t) input.value = t.trim(); else formMsg(f, "Het klembord is leeg, of de browser geeft het niet. Plak met lang drukken in het veld.");
    }
  });
  f.accessKey.addEventListener("paste", (e) => { if (fillKeys(f, e.clipboardData?.getData("text"))) e.preventDefault(); });
  f.secretKey.addEventListener("paste", (e) => { if (fillKeys(f, e.clipboardData?.getData("text"))) e.preventDefault(); });
  // Terug uit de Scaleway-console: in de app het klembord bekijken (in een browser zou dat elke keer om toestemming vragen).
  if (NATIVE?.clipboard) {
    window.removeEventListener("focus", quickWatch);
    document.removeEventListener("visibilitychange", quickWatch);
    quickWatch = () => { if (document.visibilityState === "visible" && $("#qf")) fillKeys($("#qf"), NATIVE.clipboard()); };
    window.addEventListener("focus", quickWatch);
    document.addEventListener("visibilitychange", quickWatch);
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    const res = $("#qres");
    res.innerHTML = `<li class="busy">Bezig: sleutel controleren, opslag aanmaken, servers en prijzen ophalen, mail aanmelden…</li>`;
    try {
      const r = await busy($("button.primary", f), () => api("/api/quick/scaleway", { method: "POST", body: { accessKey: f.accessKey.value, secretKey: f.secretKey.value, projectId: f.projectId.value } }));
      res.innerHTML = resultItems(r.steps);
      config = await api("/api/config");
      STEPS = stepsFor(config);
      setTimeout(() => stepRegelen(), 1600);
    } catch (err) {
      res.innerHTML = resultItems(err.data?.steps ?? []);
      formMsg(f, err.message);
    }
  };
}

const resultItems = (steps) => steps.map((x) => `<li class="${x.ok ? "" : "bad"}">${esc(x.label)}${x.detail ? `<small>${esc(x.detail)}</small>` : ""}</li>`).join("");

/** Stap 1 opnieuw, nadat de kluis er al is: alleen het adres kan nog anders. */
function stepJij() {
  root.innerHTML = wizardShell("jij", `
    <h1>Jij en je adres</h1>
    <p class="lead">Je adres is nu <b>${esc(config.domain)}</b> (mail: ${esc(config.mailFrom ?? "")}). Je kunt het hier nog veranderen.</p>
    <form class="fields" id="f">
      <fieldset class="radios">
        <label class="check"><input type="radio" name="domainMode" value="own"> Ik heb een eigen domein</label>
        ${state.dienst ? `<label class="check"><input type="radio" name="domainMode" value="buy"> Nieuw domein kopen</label>` : ""}
        <label class="check"><input type="radio" name="domainMode" value="free"> Gratis adres</label>
      </fieldset>
      <label><span id="domTitle">Domeinnaam</span><div class="suffix"><input name="domain" autocomplete="off" autocapitalize="off" required><span id="domSuffix" hidden>.dedyn.io</span></div><small id="domHint"></small></label>
      <p class="msg"></p>
      <div class="next"><button class="btn primary">Verder</button></div>
    </form>
    <p class="muted"><small>Je wachtwoord en meldadres pas je later aan in je cloud, bij Instellingen. Wil je je wachtwoordzin of herstelsleutel anders, kies dan Opnieuw beginnen.</small></p>`);
  const f = $("#f");
  const mode = config.domainMode ?? "own";
  (f.querySelector(`[value="${mode}"]`) ?? f.querySelector('[value="own"]')).checked = true;
  f.domain.value = mode === "free" ? config.domain.replace(/\.dedyn\.io$/, "") : config.domain;
  const upd = () => { const m = f.domainMode.value; $("#domTitle").textContent = m === "free" ? "Kies een naam" : "Domeinnaam"; $("#domSuffix").hidden = m !== "free"; $("#domHint").textContent = DOMAIN_HINTS[m]; };
  f.onchange = upd;
  upd();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", f), () => api("/api/setup/domain", { method: "POST", body: { domain: f.domain.value, domainMode: f.domainMode.value } })); go("sleutel"); }
    catch (err) { formMsg(f, err.message); }
  };
}

function dienstShell(inner) {
  root.innerHTML = wizardShell("regelen", `${inner}<p style="margin-top:22px"><button class="link" id="dienstBack">Terug naar de keuze</button></p>`);
  $("#dienstBack").onclick = () => { clearTimeout(dienstTimer); stepRegelen(); };
}

function dienstLogin(bundle) {
  if (config.dienst?.loggedIn) return dienstOrder(bundle);
  dienstShell(`
    <h1>Inloggen bij de dienst</h1>
    <p class="lead">We sturen je een code van zes cijfers. Een wachtwoord heb je niet nodig.</p>
    <form class="fields" id="f"><label>E-mailadres<input type="email" name="email" required value="${esc(config.dienst?.email ?? config.alertEmail ?? "")}"></label>
      <p class="msg"></p><div><button class="btn primary">Stuur de code</button></div></form>
    <form class="fields" id="g" hidden><label>Code uit de mail<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>
      <p class="msg"></p><div><button class="btn primary">Inloggen</button> <button type="button" class="link" id="again">Andere code sturen</button></div></form>`);
  const f = $("#f"), g = $("#g");
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", f), () => api("/api/dienst/login", { method: "POST", body: { email: f.email.value } })); f.hidden = true; g.hidden = false; g.code.focus(); formMsg(g, `De code is verstuurd naar ${f.email.value}.`, true); }
    catch (err) { formMsg(f, err.message); }
  };
  $("#again").onclick = () => { g.hidden = true; f.hidden = false; };
  g.onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("button", g), () => api("/api/dienst/verify", { method: "POST", body: { code: g.code.value } })); config = await api("/api/config"); dienstOrder(bundle); }
    catch (err) { formMsg(g, err.message); }
  };
}

function dienstOrder(bundle) {
  const info = dienstInfoCache;
  const b = info?.bundles.find((x) => x.id === bundle);
  const mode = config.domainMode;
  if (mode === "free" || (mode === "sub" && !config.domain?.endsWith(`.${info?.freeZone}`))) {
    const zone = info?.freeZone;
    const label = (config.domain ?? "").split(".")[0];
    dienstShell(`
      <h1>Kies je adres</h1>
      <p class="lead">${zone ? `Neem een gratis adres van de dienst, of een eigen domein zoals vanes.nl.` : `Bij de dienst hoort een eigen domein, zoals vanes.nl, in plaats van ${esc(config.domain)}. De registratie zit in je abonnement.`}</p>
      <form class="fields" id="f">
        ${zone ? `<fieldset class="radios">
          <label class="check"><input type="radio" name="kind" value="sub" checked> Gratis adres van de dienst</label>
          <label class="check"><input type="radio" name="kind" value="domain"> Eigen domein</label>
        </fieldset>` : `<input type="hidden" name="kind" value="domain">`}
        <label class="sub"><span>Naam</span><div class="suffix"><input name="label" value="${esc(label)}" autocapitalize="off" autocomplete="off"><span>.${esc(zone ?? "")}</span></div><small>Je mail wordt dan bijvoorbeeld ${esc(config.mailFrom?.split("@")[0] ?? "post")}@<b id="subPreview">${esc(label)}.${esc(zone ?? "")}</b></small></label>
        <label class="dom">Domeinnaam<input name="domain" placeholder="vanes.nl" autocapitalize="off"></label>
        <label class="check dom"><input type="checkbox" name="mine"> Dit domein heb ik al</label>
        <p class="msg"></p><div><button class="btn primary">Verder</button></div></form>`);
    const f = $("#f");
    const upd = () => { const sub = f.kind.value === "sub"; $(".sub", f).hidden = !sub; $$(".dom", f).forEach((x) => (x.hidden = sub)); f.domain.required = !sub; f.label.required = sub; if ($("#subPreview")) $("#subPreview").textContent = `${f.label.value.trim().toLowerCase() || "naam"}.${zone}`; };
    f.oninput = upd; f.onchange = upd; upd();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        if (f.kind.value === "sub") {
          const r = await api(`/api/dienst/check?name=${encodeURIComponent(f.label.value)}`);
          if (!r.available) return formMsg(f, `${r.domain} is al in gebruik. Kies een andere naam.`);
          await busy($("button", f), () => api("/api/setup/domain", { method: "POST", body: { domain: r.domain, domainMode: "sub" } }));
        } else {
          if (!f.mine.checked) {
            const r = await api(`/api/dienst/check?name=${encodeURIComponent(f.domain.value)}`);
            if (!r.available) return formMsg(f, `${r.domain} is al bezet. Kies een andere naam, of vink aan dat hij van jou is.`);
          }
          await busy($("button", f), () => api("/api/setup/domain", { method: "POST", body: { domain: f.domain.value, domainMode: f.mine.checked ? "own" : "buy" } }));
        }
        config = await api("/api/config");
        dienstOrder(bundle);
      } catch (err) { formMsg(f, err.message); }
    };
    return;
  }
  const countries = { NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", LU: "Luxemburg" };
  dienstShell(`
    <h1>${esc(b?.title ?? "Abonnement")} — ${eurStr(b?.monthly)} per maand</h1>
    <p class="lead">${mode === "sub" ? "Ga akkoord met de voorwaarden" : "Nog een paar gegevens"}, dan reken je af met iDEAL. Daarna wordt alles voor ${esc(config.domain)} klaargezet.</p>
    <form class="fields" id="f">
      ${mode === "sub" ? `<input type="hidden" name="dmode" value="sub"><p class="note" style="margin:0">Je adres wordt <b>${esc(config.domain)}</b>. Geen domein nodig, geen gegevens voor een register. <button type="button" class="link" id="otherName">Andere naam</button></p>`
      : mode === "own" ? `<fieldset class="radios">
          <label class="check"><input type="radio" name="dmode" value="transfer" checked> Domein verhuizen naar de dienst (dan regelt de dienst ook de verlenging)</label>
          <label class="check"><input type="radio" name="dmode" value="own"> Domein blijft waar hij staat; ik zet zelf de nameservers om</label>
        </fieldset>
        <label class="auth">Verhuiscode (auth-code)<input name="authCode" autocomplete="off"><small>Vraag je op bij de partij waar je domein nu staat.</small></label>`
      : `<input type="hidden" name="dmode" value="register"><p class="note" style="margin:0">${esc(config.domain)} wordt op jouw naam geregistreerd.</p>`}
      <div class="reg">
        <h2 style="margin:6px 0 0">Houder van het domein</h2>
        <p class="muted" style="margin:0"><small>Verplicht voor elke domeinregistratie; deze gegevens gaan naar het register (bij .nl: SIDN).</small></p>
        <div class="row"><label>Voornaam<input name="firstName" autocomplete="given-name"></label><label>Achternaam<input name="lastName" autocomplete="family-name"></label></div>
        <label>Bedrijf (optioneel)<input name="company" autocomplete="organization"></label>
        <div class="row"><label>Straat<input name="street" autocomplete="address-line1"></label><label style="flex:0 0 110px">Nummer<input name="number"></label></div>
        <div class="row"><label style="flex:0 0 140px">Postcode<input name="zipcode" autocomplete="postal-code"></label><label>Plaats<input name="city" autocomplete="address-level2"></label></div>
        <div class="row"><label>Land<select name="country">${Object.entries(countries).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label><label>Telefoon<input name="phone" type="tel" autocomplete="tel" placeholder="+31 6 12345678"></label></div>
        <label>E-mailadres<input name="email" type="email" value="${esc(config.dienst?.email ?? config.alertEmail ?? "")}"></label>
      </div>
      <label class="check"><input type="checkbox" name="terms" required><span>Ik ga akkoord met de ${info?.termsUrl ? `<a href="${esc(info.termsUrl)}" target="_blank" rel="noopener">voorwaarden</a>` : "voorwaarden"}${info?.privacyUrl ? ` en de <a href="${esc(info.privacyUrl)}" target="_blank" rel="noopener">privacyverklaring</a>` : ""}</span></label>
      <p class="msg"></p>
      <div class="next"><button class="btn primary big">Afrekenen met iDEAL</button></div>
    </form>`);
  const f = $("#f");
  const upd = () => {
    const m = f.dmode.value;
    const auth = $(".auth", f); if (auth) auth.hidden = m !== "transfer";
    $(".reg", f).hidden = m === "own" || m === "sub";
    $$(".reg input:not([name=company])", f).forEach((i) => (i.required = m !== "own" && m !== "sub"));
  };
  f.onchange = upd;
  upd();
  $("#otherName")?.addEventListener("click", async () => { await api("/api/setup/domain", { method: "POST", body: { domain: `${(config.domain ?? "naam").split(".")[0]}.dedyn.io`, domainMode: "free" } }); config = await api("/api/config"); dienstOrder(bundle); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const m = f.dmode.value;
    const registrant = Object.fromEntries(["firstName", "lastName", "company", "street", "number", "zipcode", "city", "country", "phone", "email"].map((k) => [k, f[k].value.trim()]));
    try {
      const r = await busy($("button", f), () => api("/api/dienst/order", { method: "POST", body: { bundle, mode: m, authCode: f.authCode?.value, registrant, acceptTerms: f.terms.checked } }));
      lastCheckout = r.checkoutUrl;
      config = await api("/api/config");
      openCheckout(r.checkoutUrl);
      dienstProgress();
    } catch (err) { formMsg(f, err.message); }
  };
}

async function dienstProgress() {
  clearTimeout(dienstTimer);
  let st;
  try { st = await api("/api/dienst/status"); }
  catch (err) { dienstShell(`<h1>De dienst</h1><p class="note warn">${esc(err.message)}</p><div><button class="btn" id="retry">Opnieuw</button></div>`); $("#retry").onclick = dienstProgress; return; }
  const title = { awaiting_payment: "Wacht op je betaling", paid: "Betaling ontvangen", provisioning: "Alles wordt klaargezet", ready: "Alles staat klaar", failed: "Er ging iets mis", payment_problem: "Probleem met de betaling", cancelled: "Opgezegd", suspended: "Opgeschort" }[st.status] ?? "De dienst";
  const lead = st.status === "awaiting_payment" ? "Rond de betaling af in het venster van Mollie. Daarna gaat het hier vanzelf verder."
    : st.status === "ready" ? (config.dienst?.applied ? "Opslag, servers, DNS en mail zijn gekoppeld. Je kunt je cloud starten." : "De opslag wordt nu op jouw sleutel ingesteld…")
    : st.status === "failed" ? `${esc(st.error ?? "")} De dienst probeert het opnieuw of neemt contact met je op; je betaling is niet verloren.`
    : "Domein, DNS, servers en opslag worden aangemaakt. Dit duurt meestal een paar minuten.";
  dienstShell(`<h1>${title}</h1><p class="lead">${lead}</p>
    ${st.steps?.length ? launchView(st) : ""}
    ${st.status === "awaiting_payment" && lastCheckout ? `<p><a class="btn" href="${esc(lastCheckout)}" target="_blank" rel="noopener">Naar de betaalpagina</a></p>` : ""}
    <p class="msg" id="dmsg"></p>
    ${st.status === "ready" && config.dienst?.applied ? `<div class="next"><button class="btn primary" id="nx">Verder</button></div>` : ""}`);
  $("#nx")?.addEventListener("click", () => go(nextOf("regelen")));
  if (st.status === "ready" && !config.dienst?.applied) {
    try { await api("/api/dienst/apply", { method: "POST" }); config = await api("/api/config"); return dienstProgress(); }
    catch (err) { $("#dmsg").textContent = err.message; $("#dmsg").className = "msg err"; dienstTimer = setTimeout(dienstProgress, 15000); return; }
  }
  if (!["ready", "cancelled", "suspended"].includes(st.status)) dienstTimer = setTimeout(dienstProgress, 3000);
}

function storeVerdict(stores) {
  const countries = new Set(stores.map((s) => s.country));
  const backup = stores.some((s) => s.purpose === "backup");
  if (!stores.length) return { good: false, text: "Koppel minstens één opslag. Aanbevolen: een werkkopie en een back-up, bij verschillende aanbieders in verschillende landen." };
  if (stores.length >= 2 && countries.size >= 2 && backup) return { good: true, text: `Goed verspreid: ${stores.length} plekken in ${countries.size} landen, met een onveranderbare back-up.` };
  if (!backup) return { good: false, text: "Voeg nog een back-up toe (die kan niemand wissen, ook een indringer niet)." };
  return { good: false, text: "Zet de back-up bij voorkeur in een ander land dan de werkkopie." };
}

function stepStores() {
  const offers = state.offers.stores;
  const v = storeVerdict(config.stores);
  root.innerHTML = wizardShell("opslag", `
    <h1>Opslag voor back-ups</h1>
    <p class="lead">Je cloud schrijft elke wijziging versleuteld weg naar opslag buiten je servers. Daaruit kan hij zich altijd herstellen, ook als alle servers weg zijn.</p>
    ${config.stores.length ? `<ul class="items">${config.stores.map((s) => `<li><span class="flag">${FLAGS[s.country] ?? "🗄️"}</span><b>${esc(s.name)}</b>
      <span class="sub">${s.purpose === "backup" ? "Back-up, onveranderbaar" : "Werkkopie"} · ${esc(s.bucket ?? s.dir ?? "")}</span>
      <span class="end">${s.type === "s3" ? `${checkButton("storage", s.name, s.name)} ` : ""}<button class="link" data-del="${esc(s.name)}">Verwijderen</button></span></li>`).join("")}</ul>` : ""}
    <div id="checkBox"></div>
    <p class="verdict ${v.good ? "good" : ""}">${esc(v.text)}</p>
    <form class="panel" id="f">
      <b>Opslag toevoegen</b>
      ${storeFields(offers)}
      <fieldset class="radios">
        <label class="check"><input type="radio" name="purpose" value="replica" ${config.stores.some((s) => s.purpose === "replica") ? "" : "checked"}> Werkkopie</label>
        <label class="check"><input type="radio" name="purpose" value="backup" ${config.stores.some((s) => s.purpose === "replica") ? "checked" : ""}> Back-up (onveranderbaar)</label>
      </fieldset>
      <p class="muted" id="help" style="margin:0"></p>
      <ul class="results" id="res"></ul>
      <p class="msg"></p>
      <div><button class="btn">Koppelen en testen</button></div>
    </form>
    <div class="next"><button class="btn primary" id="nx" ${config.stores.some((s) => s.purpose === "replica") ? "" : "disabled"}>Verder</button></div>`);
  const f = $("#f");
  wireStoreFields(f, offers);
  const help = () => { const o = offers.find((x) => x.id === f.offer.value); $("#help").innerHTML = `${esc(o.help)} ${o.signupUrl ? `<a href="${o.signupUrl}" target="_blank" rel="noopener">Naar ${esc(o.name.split(" ")[0])}</a>` : ""}`; };
  f.offer.addEventListener("change", help);
  help();
  f.onsubmit = async (e) => {
    e.preventDefault();
    $("#res").innerHTML = "";
    try {
      const r = await busy($("button", f), () => api("/api/stores", { method: "POST", body: { offer: f.offer.value, region: f.region.value, endpoint: f.endpoint.value, accessKey: f.accessKey.value, secretKey: f.secretKey.value, purpose: f.purpose.value } }));
      $("#res").innerHTML = r.steps.map((s) => `<li class="${s.ok ? "" : /Versiebeheer|Onveranderbaar/.test(s.label) ? "meh" : "bad"}">${esc(s.label)}${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</li>`).join("");
      if (r.ok) { config = await api("/api/config"); setTimeout(stepStores, 1200); }
      else formMsg(f, "Niet gelukt. Controleer de gegevens hierboven.");
    } catch (err) { formMsg(f, err.message); }
  };
  root.onclick = async (e) => {
    const del = e.target.dataset?.del;
    if (del && confirm(`${del} loskoppelen? Bestaande back-ups in die opslag blijven staan.`)) { await api(`/api/stores/${encodeURIComponent(del)}`, { method: "DELETE" }); config = await api("/api/config"); stepStores(); }
  };
  $("#nx").onclick = () => go("servers");
}

async function stepServers() {
  const offers = state.offers.servers;
  const { presets, chosen } = await api("/api/presets");
  root.innerHTML = wizardShell("servers", `
    <h1>Servers</h1>
    <p class="lead">Koppel één of meer Europese aanbieders. Daarna kies je hoe je cloud verspreid wordt; de prijzen komen rechtstreeks van de aanbieder.</p>
    <ul class="items">${offers.map((o) => `<li><span class="flag" title="Rechtsgebied">${FLAGS[o.home] ?? ""}</span>
      <b>${esc(o.name)}</b><span class="sub">${esc(o.owner)} · servers in ${[...new Set(o.regions.map((r) => `${FLAGS[r.country] ?? ""} ${r.city}`))].map(esc).join(", ")}</span>
      <span class="end">${config.providers[o.id] ? `<span class="muted">✓ gekoppeld</span> ${checkButton("servers", o.id, o.name, "#linkForm")} <button class="link" data-unlink="${o.id}">Loskoppelen</button>` : `<button class="btn" data-link="${o.id}">Koppelen</button>`}</span></li>`).join("")}</ul>
    <div id="linkForm"></div>
    <h2>Hoe wil je je cloud verspreiden?</h2>
    <div class="presets">${presets.map((p) => `<button class="preset" data-preset="${p.id}" aria-pressed="${chosen === p.id}" ${p.placement.length ? "" : "disabled"}>
      <div class="mini">${europeMap(p.placement.map((x, i) => ({ id: `${x.kind}${i}`, kind: x.kind, provider: x.provider, region: x.region, status: "ready", isLeader: i === 0 })), { label: p.title })}</div>
      <b>${esc(p.title)}</b>
      ${p.placement.length ? `<span class="price">${p.monthly != null ? eur(p.monthly) + " per maand" : "prijs deels onbekend"}</span><p>${esc(p.description)}</p>` : `<p>${esc(p.missing)}</p>`}
    </button>`).join("")}</div>
    <p class="muted"><small>Plus opslagkosten (meestal enkele euro's per maand). Twee data-servers houden elkaar bij; de witness beslist mee bij een storing.</small></p>
    <p class="msg" id="pmsg"></p>
    <div class="next"><button class="btn primary" id="nx" ${chosen ? "" : "disabled"}>Verder</button></div>`);
  root.onclick = async (e) => {
    const link = e.target.dataset?.link, unlink = e.target.dataset?.unlink, preset = e.target.closest?.("[data-preset]")?.dataset.preset;
    if (link) {
      const o = offers.find((x) => x.id === link);
      $("#linkForm").innerHTML = `<form class="panel" id="lf"><b>${esc(o.name)} koppelen</b>
        ${o.keyHelp ? `<p class="muted" style="margin:0">${esc(o.keyHelp)}</p>` : ""}
        ${fieldInputs(o.fields)}
        ${o.signupUrl ? `<p class="muted" style="margin:0">Nog geen account? <a href="${esc(o.signupUrl)}" target="_blank" rel="noopener">Naar ${esc(o.name)}</a>.</p>` : ""}
        <ul class="results" id="lres"></ul><p class="msg"></p><div><button class="btn">Koppelen en prijzen ophalen</button></div></form>`;
      const lf = $("#lf");
      lf.onsubmit = async (ev) => {
        ev.preventDefault();
        const fields = Object.fromEntries(o.fields.map((fl) => [fl.key, lf[fl.key].value]));
        try {
          const r = await busy($("button", lf), () => api("/api/providers", { method: "POST", body: { id: o.id, fields } }));
          $("#lres").innerHTML = r.regions.map((x) => { const reg = o.regions.find((y) => y.id === x.region); return `<li class="${x.error ? "bad" : ""}">${esc(reg.label)}: ${x.error ? esc(x.error) : `${esc(x.data.size)} ${eur(x.data.monthly)}`}</li>`; }).join("");
          config = await api("/api/config");
          setTimeout(stepServers, 1200);
        } catch (err) {
          formMsg(lf, err.message);
          // Wat er precies niet klopt (alleen gelezen bij de aanbieder).
          if (err.data?.checks) $("#lres").innerHTML = checkItems(err.data.checks);
        }
      };
      lf.querySelector("input")?.focus();
    }
    if (unlink) { await api(`/api/providers/${unlink}`, { method: "DELETE" }); config = await api("/api/config"); stepServers(); }
    if (preset) {
      try { await api("/api/presets/choose", { method: "POST", body: { id: preset } }); stepServers(); }
      catch (err) { $("#pmsg").textContent = err.message; $("#pmsg").className = "msg err"; }
    }
  };
  $("#nx").onclick = () => go("domein");
}

async function stepDns() {
  const d = config.domain;
  if (config.dnsMode === "dienst") {
    root.innerHTML = wizardShell("domein", `
      <h1>Domein koppelen</h1>
      <p class="lead">De Eigen Cloud Dienst beheert de DNS van ${esc(d)}. Je cloud zet er straks zelf de juiste records in.</p>
      <div id="nsBox"></div>
      <div class="next"><button class="btn primary" id="nx">Verder</button></div>`);
    api("/api/dns/check").then((r) => nsPanel(r, d, "de dienst")).catch(() => {});
    $("#nx").onclick = () => go(nextOf("domein"));
    return;
  }
  const free = config.domainMode === "free";
  // Alle aanbieders met DNS komen uit de registry (state.offers.dns); "zelf regelen" is altijd mogelijk.
  const offers = state.offers.dns ?? [];
  const cur = config.dnsMode && config.dnsMode !== "dienst" ? config.dnsMode : offers[0]?.id ?? "manual";
  const whoOf = (id) => offers.find((o) => o.id === id)?.name.replace(/ \(.*\)$/, "") ?? id;
  const dnsLinked = offers.some((o) => o.id === config.dnsMode);
  root.innerHTML = wizardShell("domein", `
    <h1>Domein koppelen</h1>
    <p class="lead">${free ? `${esc(d)} komt van deSEC: gratis, open source en zonder reclame. De console maakt het account voor je aan; jij hoeft alleen een plaatje over te typen en een link in je mail aan te klikken.`
      : `Je cloud zet zelf de juiste DNS-records voor ${esc(d)}: waar de site en je mail te vinden zijn, en de beveiliging van je mail. Daarvoor heeft hij toegang nodig tot je DNS.`}</p>
    ${free ? "" : `<form class="fields" id="f">
      <fieldset class="radios">
        ${offers.map((o, i) => `<label class="check"><input type="radio" name="mode" value="${esc(o.id)}" ${cur === o.id ? "checked" : ""}> ${FLAGS[o.home] ?? ""} ${esc(o.name)}${i === 0 && o.id === "desec" ? " — aanbevolen" : ""}${o.sharesKeyWith && config.providers[o.sharesKeyWith] ? ` <span class="muted">(sleutel al gekoppeld)</span>` : ""}</label>`).join("")}
        <label class="check"><input type="radio" name="mode" value="manual" ${cur === "manual" ? "checked" : ""}> Ik regel DNS zelf</label>
      </fieldset>
      <p class="desecNew" style="margin:0"><button type="button" class="btn" id="newDesec">Nog geen deSEC-account? Laat de console er een maken</button></p>
      <div class="dnsFields"></div>
      <p class="muted hint" style="margin:0"></p>
      <ul class="results" id="dres"></ul>
      <p class="msg"></p>
      <div><button class="btn">Koppelen</button>${dnsLinked ? ` ${checkButton("dns", config.dnsMode, whoOf(config.dnsMode), "#dnsCheck")}` : ""}</div>
    </form>
    <div id="dnsCheck"></div>`}
    <div id="signup"></div>
    <div id="nsBox"></div>
    <div class="next"><button class="btn primary" id="nx" ${config.dnsMode ? "" : "disabled"}>Verder</button></div>`);
  const done = (r) => { $("#nx").disabled = false; nsPanel(r, d, "deSEC"); };
  if (free) {
    if (config.dnsMode === "desec") api("/api/dns/check").then((r) => nsPanel({ ...r, delegated: true }, d, "deSEC")).catch(() => {});
    else desecSignup($("#signup"), done);
  } else {
    const f = $("#f");
    const upd = () => {
      const m = f.mode.value;
      const o = offers.find((x) => x.id === m);
      const prev = config.dns.find((x) => x.type === m);
      // Al gekoppeld (voor DNS, of dezelfde sleutel bij Servers): velden mogen leeg blijven.
      const known = !!prev || !!(o?.sharesKeyWith && config.providers[o.sharesKeyWith]);
      $(".dnsFields", f).innerHTML = o ? fieldInputs(o.fields, { optional: known, placeholder: (k) => prev?.[k] ?? prev?.fields?.[k] ?? config.providers[o.id]?.[k] ?? "" }) : "";
      $(".desecNew", f).hidden = m !== "desec" || !!config.dnsMode;
      $(".hint", f).innerHTML = o ? `${esc(o.keyHelp)}${known && !prev ? " Je sleutel van Servers wordt gebruikt; je hoeft niets in te vullen." : ""}${o.signupUrl ? ` <a href="${esc(o.signupUrl)}" target="_blank" rel="noopener">Naar ${esc(whoOf(o.id))}</a>` : ""}` : "";
      $("form#f > div > button", f).textContent = m === "manual" ? "Opslaan" : "Koppelen";
    };
    f.onchange = (e) => { if (e.target.name === "mode") upd(); };
    upd();
    $("#newDesec").onclick = () => { $(".desecNew", f).hidden = true; desecSignup($("#signup"), done); };
    if (config.dnsMode && config.dnsMode !== "manual") api("/api/dns/check").then((r) => nsPanel(r, d, whoOf(config.dnsMode))).catch(() => {});
    f.onsubmit = async (e) => {
      e.preventDefault();
      const m = f.mode.value;
      const o = offers.find((x) => x.id === m);
      const fields = Object.fromEntries((o?.fields ?? []).map((fl) => [fl.key, f[fl.key]?.value ?? ""]));
      $("#dres").innerHTML = "";
      try {
        const r = await busy($("form#f > div > button", f), () => api("/api/dns", { method: "POST", body: { mode: m, token: fields.token, fields } }));
        config = await api("/api/config");
        formMsg(f, m === "manual" ? "Opgeslagen." : "Gekoppeld.", true);
        $("#nx").disabled = false;
        if (m === "manual") $("#nsBox").innerHTML = `<div class="note">Na het starten laat je cloud onder <b>Instellingen → Gezondheid</b> precies zien welke records je moet zetten.</div>`;
        else nsPanel(r, d, whoOf(m));
      } catch (err) {
        formMsg(f, err.message);
        if (err.data?.checks) $("#dres").innerHTML = checkItems(err.data.checks);
      }
    };
  }
  $("#nx").onclick = () => go(nextOf("domein"));
}

/** Invoervelden voor inloggegevens van een aanbieder (uit de registry: label, geheim, uitleg, optioneel). */
function fieldInputs(fields, { optional = false, placeholder = () => "" } = {}) {
  return fields.map((fl) => `<label>${esc(fl.label)}<input name="${esc(fl.key)}" ${fl.secret ? 'type="password"' : ""} autocomplete="off" spellcheck="false" ${optional || fl.optional ? "" : "required"} placeholder="${esc(placeholder(fl.key) || fl.placeholder || "")}">${fl.help ? `<small>${esc(fl.help)}</small>` : ""}</label>`).join("");
}

/** Waar je domein naar moet wijzen, en of dat al zo is. */
function nsPanel(r, d, who) {
  if (!r?.ns) return;
  $("#nsBox").innerHTML = `<div class="panel"><b>${r.delegated ? `✓ ${esc(d)} wijst naar ${esc(who)}` : "Nog één ding bij je registrar"}</b>
    ${r.delegated ? "" : `<p style="margin:0">Log in bij de partij waar je ${esc(d)} hebt geregistreerd en vervang de nameservers door:</p><div class="ns">${r.ns.map((n) => `<code>${esc(n)}</code>`).join("")}</div>
    <p class="muted" style="margin:0"><small>Dat kan tot een dag duren. Je kunt intussen gewoon verder; je cloud controleert het zelf.</small></p><div><button class="btn" id="chk">Nu controleren</button></div>`}</div>`;
  $("#chk")?.addEventListener("click", async (e) => { const c = await busy(e.target, () => api("/api/dns/check")); nsPanel(c, d, who); });
}

/** Een deSEC-account aanmaken: plaatje overtypen, link in de mail aanklikken, klaar. */
async function desecSignup(box, done) {
  const free = config.domainMode === "free";
  if (config.desec && !config.dnsMode) return desecWait(box, done);
  box.innerHTML = `<form class="panel" id="cf"><b>Gratis account bij deSEC</b>
    <label>E-mailadres voor je deSEC-account<input type="email" name="email" required value="${esc(config.desec?.email ?? config.alertEmail ?? "")}"><small>deSEC stuurt hier een bevestigingslink naartoe. Gebruik een adres buiten ${esc(config.domain)}.</small></label>
    <div class="captcha"><img id="cimg" alt="Plaatje met tekens"><button type="button" class="link" id="cnew">Ander plaatje</button></div>
    <label>Tekens uit het plaatje<input name="solution" autocomplete="off" autocapitalize="characters" required></label>
    <p class="msg"></p><div><button class="btn primary">Account aanmaken</button></div></form>`;
  const f = $("#cf", box);
  let capId = null;
  const load = async () => {
    try { const c = await api("/api/desec/captcha", { method: "POST" }); capId = c.id; $("#cimg").src = `data:image/png;base64,${c.challenge}`; f.solution.value = ""; }
    catch (err) { formMsg(f, err.message); }
  };
  $("#cnew").onclick = load;
  await load();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(f.querySelector("button.primary"), () => api("/api/desec/register", { method: "POST", body: { captchaId: capId, solution: f.solution.value, email: f.email.value } }));
      config = await api("/api/config");
      desecWait(box, done);
    } catch (err) { formMsg(f, err.message); load(); }
  };
  void free;
}

function desecWait(box, done) {
  const free = config.domainMode === "free";
  box.innerHTML = `<div class="panel"><b>Kijk in je mail</b>
    <p style="margin:0">deSEC heeft een bevestigingslink gestuurd naar <b>${esc(config.desec?.email ?? "")}</b>. Klik erop en kom daarna hier terug.</p>
    <p class="msg" id="wmsg"></p>
    <div><button class="btn primary" id="clicked">Ik heb op de link geklikt</button> <button class="link" id="redo">Opnieuw beginnen</button></div>
    ${free ? `<form class="fields" id="rename" hidden><p style="margin:0">Zegt deSEC dat ${esc(config.domain)} al bezet is? Kies dan een andere naam en maak het account opnieuw aan.</p>
      <label>Nieuwe naam<div class="suffix"><input name="name" required autocapitalize="off"><span>.dedyn.io</span></div></label><div><button class="btn">Andere naam gebruiken</button></div></form>` : ""}</div>`;
  const msg = $("#wmsg", box);
  $("#clicked").onclick = async (e) => {
    try {
      const r = await busy(e.target, () => api("/api/desec/finish", { method: "POST" }));
      if (r.pending) { msg.textContent = "Nog niet bevestigd. Duurt het lang? Kijk ook in je spammap."; msg.className = "msg err"; const rn = $("#rename", box); if (rn) rn.hidden = false; return; }
      config = await api("/api/config");
      box.innerHTML = `<p class="msg ok">✓ Account aangemaakt en gekoppeld.</p>`;
      done(r);
    } catch (err) { msg.textContent = err.message; msg.className = "msg err"; }
  };
  $("#redo").onclick = () => { config.desec = null; desecSignup(box, done); };
  const rn = $("#rename", box);
  if (rn) rn.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/setup/domain", { method: "POST", body: { domain: rn.name.value, domainMode: "free" } });
      config = await api("/api/config");
      config.desec = null;
      stepDns();
    } catch (err) { msg.textContent = err.message; msg.className = "msg err"; }
  };
}

const RELAYS = {
  scaleway: { host: "smtp.tem.scaleway.com", port: 465, secure: true, label: "Scaleway TEM (Frankrijk)" },
  brevo: { host: "smtp-relay.brevo.com", port: 587, secure: false, spf: "include:spf.brevo.com", label: "Brevo (Frankrijk)" },
  custom: { label: "Eigen relay" },
};

function stepMail() {
  const r = config.mailRelay;
  const cur = !r ? "scaleway" : r.host === RELAYS.scaleway.host ? "scaleway" : r.host === RELAYS.brevo.host ? "brevo" : "custom";
  root.innerHTML = wizardShell("mail", `
    <h1>Mail versturen</h1>
    <p class="lead">Mail ontvangen doen je servers zelf. Voor versturen raden we een Europese relay aan: dan komt je mail goed aan, ook direct na een verhuizing naar een nieuwe server.</p>
    <form class="fields" id="f">
      <label>Relay<select name="preset">${Object.entries(RELAYS).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <div class="row"><label>Server<input name="host" required></label><label style="flex:0 0 110px">Poort<input name="port" type="number" required></label></div>
      <div class="row"><label>Gebruikersnaam<input name="user" autocomplete="off"></label><label>Wachtwoord<input name="password" type="password" autocomplete="off" ${r ? 'placeholder="ongewijzigd"' : ""}></label></div>
      <label class="check"><input type="checkbox" name="secure"> Versleuteld vanaf het begin (poort 465)</label>
      <label>Extra SPF-regel<input name="spf" placeholder="bijv. include:spf.brevo.com"><small>Je relay vermeldt welke regel er in je DNS bij moet; je cloud zet hem er zelf in.</small></label>
      ${config.alertEmail ? `<label class="check"><input type="checkbox" name="test" checked> Stuur een testbericht naar ${esc(config.alertEmail)}</label>` : ""}
      <p class="msg"></p>
      <div><button class="btn">Testen en opslaan</button></div>
    </form>
    <div class="next"><button class="btn primary" id="nx" ${config.mailRelay ? "" : "disabled"}>Verder</button><button class="link" id="skip">Overslaan, rechtstreeks versturen</button></div>`);
  const f = $("#f");
  const fill = (k, force) => { const p = RELAYS[k]; if (p.host && (force || !r)) { f.host.value = p.host; f.port.value = p.port; f.secure.checked = p.secure; f.spf.value = p.spf ?? ""; } };
  if (r) { f.host.value = r.host; f.port.value = r.port; f.user.value = r.user; f.secure.checked = r.secure; f.spf.value = config.spfExtra; }
  fill(cur, false);
  f.preset.onchange = () => fill(f.preset.value, true);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await busy($("button", f), () => api("/api/mail", { method: "POST", body: { relay: { host: f.host.value, port: Number(f.port.value), user: f.user.value, password: f.password.value, secure: f.secure.checked }, spfExtra: f.spf.value, sendTest: !!f.test?.checked } }));
      formMsg(f, res.tested ? `Werkt. Kijk of het testbericht aankomt bij ${config.alertEmail}.` : "Werkt.", true);
      config = await api("/api/config");
      $("#nx").disabled = false;
    } catch (err) { formMsg(f, err.message); }
  };
  $("#skip").onclick = async () => { await api("/api/mail", { method: "POST", body: { relay: null } }); go("starten"); };
  $("#nx").onclick = () => go("starten");
}

async function stepLaunch() {
  const list = await api("/api/checklist");
  const { presets, chosen } = await api("/api/presets");
  const p = presets.find((x) => x.id === chosen);
  const ready = list.every((x) => !x.required || x.ok);
  root.innerHTML = wizardShell("starten", `
    <h1>Klaar om te starten</h1>
    <p class="lead">Eén server wordt nu aangemaakt. Zodra die draait, maakt je cloud zelf de tweede server en de witness erbij${p ? `, volgens "${esc(p.title)}"` : ""}.</p>
    <ul class="results">${list.map((x) => `<li class="${x.ok ? "" : x.required ? "bad" : "meh"}">${esc(x.label)}${!x.ok && !x.required ? `<small>${x.id === "sleutel" ? "Kan later; op het overzicht staat een herinnering." : "Kan later ook, via Instellingen in je cloud."}</small>` : ""}</li>`).join("")}</ul>
    ${p ? `<div class="panel"><div style="display:grid;grid-template-columns:140px 1fr;gap:16px;align-items:center"><div>${europeMap(p.placement.map((x, i) => ({ id: String(i), kind: x.kind, provider: x.provider, region: x.region, status: "ready", isLeader: i === 0 })))}</div>
      <div><b>${esc(config.domain)}</b><br><span class="muted">${p.placement.map((x) => `${FLAGS[x.country] ?? ""} ${x.kind === "witness" ? "witness" : "data"} bij ${x.provider}`).join("<br>")}</span><br><b>${p.monthly != null ? eur(p.monthly) + " per maand" : ""}</b></div></div></div>` : ""}
    <p class="msg" id="lmsg"></p>
    <div class="next"><button class="btn primary big" id="go" ${ready ? "" : "disabled"}>Start mijn cloud</button></div>`);
  $("#go").onclick = async (e) => {
    try { await busy(e.target, () => api("/api/launch", { method: "POST" })); state.done = true; location.hash = ""; renderDash(); }
    catch (err) { $("#lmsg").textContent = err.message; $("#lmsg").className = "msg err"; }
  };
}

// ═════════ Dashboard ═════════

function launchView(l) {
  return `<ol class="progress">${l.steps.map((s) => `<li class="${s.state}"><span class="pip">${s.state === "done" ? "✓" : s.state === "fail" ? "!" : ""}</span><span class="lbl">${esc(s.label)}</span>${s.detail ? `<span class="det">${esc(s.detail)}</span>` : ""}</li>`).join("")}</ol>`;
}

/** Afrekenen bij Mollie: in de app zelf (en daarna vanzelf terug), op de computer in een nieuw tabblad. */
function openCheckout(url) {
  if (NATIVE?.openPay) NATIVE.openPay(url);
  else if (NATIVE) NATIVE.openUrl(url);
  else window.open(url, "_blank", "noopener");
}
window.__eigenPaid = () => { if (config?.dienst?.orderId) (document.querySelector("#abo") ? renderAbo() : dienstProgress()); };

async function showInvoice(id) {
  const { html } = await api(`/api/dienst/invoice?id=${encodeURIComponent(id)}`);
  if (NATIVE?.printHtml) return NATIVE.printHtml(`Factuur ${id}`, html);
  const dlg = document.createElement("dialog");
  dlg.className = "invoice";
  dlg.innerHTML = `<iframe title="Factuur"></iframe><div class="row"><button class="btn primary" id="ip">Afdrukken of opslaan als pdf</button><button class="btn" id="ic">Sluiten</button></div>`;
  document.body.append(dlg);
  dlg.querySelector("iframe").srcdoc = html;
  dlg.querySelector("#ip").onclick = () => dlg.querySelector("iframe").contentWindow.print();
  dlg.querySelector("#ic").onclick = () => { dlg.close(); dlg.remove(); };
  dlg.showModal();
}

const PAY_STATUS = { paid: "betaald", failed: "mislukt", open: "open", pending: "bezig", expired: "verlopen", canceled: "afgebroken" };
const day = (d) => new Date(typeof d === "number" ? d : d + "T12:00:00").toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });

/** Abonnement bij de Eigen Cloud Dienst: pakket, betaalmethode, betalingen en facturen, opzeggen. */
async function renderAbo(msg) {
  const box = $("#abo");
  if (!box) return;
  if (config?.overstap) return renderOverstap();
  let b;
  try { b = await api("/api/dienst/billing"); }
  catch (err) { box.innerHTML = `<h2>Abonnement</h2><p class="msg err">${esc(err.message)}</p>`; return; }
  const problem = b.status === "payment_problem";
  const cancelled = b.status === "cancelled";
  const [brand, ann] = await Promise.all([api("/api/dienst/brand").catch(() => null), api("/api/dienst/announcements").catch(() => ({ announcements: [] }))]);
  applyBrand(brand);
  const users = b.users ?? null;
  box.innerHTML = `${(ann.announcements ?? []).map((a) => `<div class="note ${a.severity === "storing" ? "warn" : ""} bericht"><b>${esc(a.title)}</b>${a.body ? `<br>${esc(a.body)}` : ""}${a.startsAt || a.endsAt ? `<br><small class="muted">${a.startsAt ? "Vanaf " + day(a.startsAt) : ""}${a.endsAt ? " tot " + day(a.endsAt) : ""}</small>` : ""}</div>`).join("")}
    <h2>Abonnement</h2>
    ${brandLine(brand)}
    <div class="panel abo">
      <div><b>${esc(b.bundle.title)}</b> · ${eurStr(b.bundle.monthly)} per maand<br>
        <span class="muted">${cancelled ? (b.endsAt ? `Opgezegd; loopt tot ${day(b.endsAt)}` : "Opgezegd") : b.nextPaymentDate ? `Volgende betaling ${day(b.nextPaymentDate)}` : ""}${b.mandate ? ` · ${esc(b.mandate.label ?? b.mandate.method)}` : ""}</span></div>
      ${problem ? `<p class="note warn" style="margin:0">De laatste betaling is niet gelukt${b.outstanding ? ` (${eurStr(b.outstanding)} staat open)` : ""}. Je cloud draait gewoon door; reken het openstaande bedrag af of kies een andere betaalmethode.</p>
        <div><button class="btn primary" data-a="settle">Nu betalen</button></div>` : ""}
      <div class="actions" style="margin:0">
        ${!cancelled ? `<button class="btn" data-a="bundle">Ander pakket</button><button class="btn" data-a="payment-method">Betaalmethode wijzigen</button>` : ""}
        ${b.canResume ? `<button class="btn primary" data-a="resume">Toch doorgaan</button>` : ""}
        ${b.domainTransferable ? `<button class="btn" data-a="authcode">Verhuiscode domein</button>` : ""}
        ${!cancelled ? `<button class="btn" data-a="overstap">Overstappen</button>` : ""}
        ${users && users.extraUserMonthly && !cancelled ? `<button class="btn" data-a="users">Gebruikers</button>` : ""}
        <button class="btn" data-a="help">Hulp vragen</button>
        ${!cancelled ? `<button class="btn danger" data-a="cancel">Opzeggen</button>` : ""}
      </div>
      ${users ? (() => { const n = (users.included ?? 1) + (users.extra ?? 0); return `<p class="muted" style="margin:0"><small>Ruimte voor ${n} ${n === 1 ? "gebruiker" : "gebruikers"} in je cloud${users.extra ? ` (waarvan ${users.extra} bijgekocht)` : ""}.</small></p>`; })() : ""}
      <div id="aboExtra"></div>
      <p class="msg ${msg?.ok ? "ok" : msg ? "err" : ""}" id="amsg">${esc(msg?.text ?? "")}</p>
    </div>
    ${b.payments?.length ? `<h2>Betalingen</h2><ul class="items">${b.payments.map((p) => `<li><span class="flag">${p.status === "paid" ? "✓" : p.status === "failed" ? "✕" : "·"}</span>
      <b>${eurStr(p.amount)}</b><span class="sub">${day(p.date)} · ${esc(PAY_STATUS[p.status] ?? p.status)}${p.description ? " · " + esc(p.description) : ""}</span>
      <span class="end">${p.invoiceId ? `<button class="link" data-invoice="${esc(p.invoiceId)}">Factuur</button>` : ""}</span></li>`).join("")}</ul>` : ""}`;
  const extra = $("#aboExtra"), amsg = $("#amsg");
  const fail = (err) => { amsg.textContent = err.message; amsg.className = "msg err"; };
  box.onclick = async (e) => {
    const inv = e.target.closest?.("[data-invoice]")?.dataset.invoice;
    if (inv) return showInvoice(inv).catch(fail);
    const a = e.target.closest?.("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "users") {
      const price = users.extraUserMonthly;
      extra.innerHTML = `<form class="fields" id="uf"><label>Extra gebruikers bovenop de ${users.included} in je pakket<input type="number" name="count" min="0" max="50" value="${users.extra ?? 0}"></label>
        <p class="muted" style="margin:0"><small>${eurStr(price)} per extra gebruiker per maand. Je kunt ze meteen toevoegen in je cloud (Instellingen → Gebruikers).</small></p>
        <div><button class="btn primary">Opslaan</button></div></form>`;
      $("#uf").onsubmit = async (ev) => {
        ev.preventDefault();
        try { const r = await busy($("#uf button"), () => api("/api/dienst/users", { method: "POST", body: { count: Number($("#uf").count.value) } })); config = await api("/api/config"); renderAbo({ ok: true, text: `Je cloud heeft nu ruimte voor ${r.maxUsers} gebruikers.` }); }
        catch (err) { fail(err); }
      };
      return;
    }
    if (a === "help") return helpPanel(extra, fail);
    if (a === "overstap") return overstapKiezen(box);
    if (a === "bundle") {
      extra.innerHTML = `<form class="fields" id="bf"><fieldset class="radios">${b.bundles.map((x) => `<label class="check"><input type="radio" name="bundle" value="${esc(x.id)}" ${x.current ? "checked" : ""}> ${esc(x.title)} — ${eurStr(x.monthly)} per maand${x.current ? " (nu)" : ""}</label>`).join("")}</fieldset>
        <p class="muted" style="margin:0"><small>Meer servers kun je meteen gebruiken; het nieuwe bedrag geldt vanaf de volgende betaling.</small></p>
        <div><button class="btn primary">Pakket wijzigen</button></div></form>`;
      $("#bf").onsubmit = async (ev) => {
        ev.preventDefault();
        try { const r = await busy($("#bf button"), () => api("/api/dienst/bundle", { method: "POST", body: { bundle: $("#bf").bundle.value } })); config = await api("/api/config"); renderAbo({ ok: true, text: `Gewijzigd naar ${r.bundle.title}; het nieuwe bedrag geldt vanaf ${day(r.effective)}. Je cloud past het aantal servers zelf aan.` }); }
        catch (err) { fail(err); }
      };
      return;
    }
    if (a === "cancel" && !confirm("Je abonnement opzeggen?\n\nJe cloud blijft werken tot het einde van de betaalde periode. Daarna gaan de servers uit; je gegevens blijven nog 30 dagen bewaard. Tot die datum kun je het terugdraaien.")) return;
    try {
      const r = await busy(e.target, () => api(a === "authcode" ? "/api/dienst/authcode" : `/api/dienst/${a}`, a === "authcode" ? {} : { method: "POST" }));
      if (r.checkoutUrl) { openCheckout(r.checkoutUrl); amsg.textContent = "Rond de betaling af; daarna wordt dit vanzelf bijgewerkt."; amsg.className = "msg ok"; return; }
      if (a === "authcode") { extra.innerHTML = `<p style="margin:0">Verhuiscode voor <b>${esc(r.domain)}</b>:</p><div class="ns"><code>${esc(r.authCode)}</code></div><p class="muted" style="margin:0"><small>Geef deze code aan je nieuwe registrar. Het verhuizen kost daar meestal een jaar registratie.</small></p>`; return; }
      renderAbo({ ok: true, text: a === "cancel" ? `Opgezegd. Je cloud loopt door tot ${r.endsAt ? day(r.endsAt) : "het einde van de periode"}.` : a === "resume" ? "Je abonnement loopt weer door." : "Gelukt." });
    } catch (err) { fail(err); }
  };
}

// ═════════ Overstappen naar een andere aanbieder of naar zelf beheren ═════════

const mbStr = (b) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} kB` : b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1).replace(".", ",")} GB`);

/** Kiezen waar je cloud heen gaat: een andere aanbieder van de lijst, of zelf beheren. */
async function overstapKiezen(box) {
  const { aanbieders: all, gekozen } = await api("/api/aanbieders").catch(() => ({ aanbieders: [] }));
  const cur = gekozen ?? state.aanbieder ?? null;
  const list = all.filter((a) => a.url !== cur && a.url !== config.dienst?.url);
  box.innerHTML = `<h2>Overstappen</h2><div class="panel">
    <p style="margin:0">Je cloud verhuist met al je mail, agenda's en foto's. Hij gaat daarvoor even slapen, je gegevens gaan versleuteld naar de nieuwe plek en daar wordt hij weer wakker. Je huidige abonnement wordt daarna opgezegd.</p>
    <div class="choices" id="olist">${list.map((a, i) => aanbiederChoice(a, i, "o")).join("")}
      <button class="choice" data-zelf="1"><span><b>Zelf beheren</b><span class="muted">Met je eigen account bij Scaleway (één sleutel) en je eigen DNS bij deSEC. Je betaalt Scaleway rechtstreeks.</span></span></button></div>
    <p class="msg" id="omsg"></p>
    <div><button class="link" id="oback">Terug naar je abonnement</button></div></div>`;
  aanbiederBrands(list, "o");
  $("#oback").onclick = () => renderAbo();
  $("#olist").onclick = async (e) => {
    const el = e.target.closest?.("[data-i]:not([disabled]),[data-zelf]");
    if (!el) return;
    const naar = el.dataset.zelf ? "zelf" : list[Number(el.dataset.i)].url;
    try {
      await busy(el, () => api("/api/overstap/start", { method: "POST", body: { naar } }));
      config = await api("/api/config");
      renderOverstap();
    } catch (err) { $("#omsg").textContent = err.message; $("#omsg").className = "msg err"; }
  };
}

/** Wat er gebeurt en hoe lang je cloud offline is. */
function overstapUitleg(v) {
  const naar = v.naar === "zelf" ? "je eigen account bij Scaleway" : esc(v.naarNaam);
  const min = v.schatting?.minuten;
  const dns = v.van.central
    ? `<li>Je adres <b>${esc(v.van.domain)}</b> gaat mee met de overdrachtscode; er verandert niets aan. Zodra ${naar} klaarstaat, beheert ${naar} je adres al: zet daarna niet te lang over.</li>`
    : v.van.mode === "own"
      ? `<li>Je domein <b>${esc(v.van.domain)}</b> blijft bij je eigen registrar. De DNS verhuist naar ${naar}; de nameservers blijven hetzelfde. <b>Gebruik je DNSSEC?</b> Haal dan vóór het overzetten bij je registrar de DS-records weg; na het overzetten krijg je de nieuwe om in te vullen. Anders is je domein tussendoor voor sommige netwerken onbereikbaar.</li>`
      : v.naar === "zelf"
        ? `<li>Je domein <b>${esc(v.van.domain)}</b> staat geregistreerd via ${esc(v.van.naam)}. De DNS komt in je eigen deSEC-account; DNSSEC gaat bij het register even uit. Daarna krijg je de verhuiscode om je domein naar een registrar naar keuze te verhuizen.</li>`
        : `<li>Je domein <b>${esc(v.van.domain)}</b> verhuist met de verhuiscode naar ${naar}. DNSSEC gaat even uit en ${naar} zet het daarna weer aan.</li>`;
  return `<ul class="results">
    <li>Je cloud gaat slapen bij ${esc(v.van.naam)}: alles wordt versleuteld weggeschreven en gecontroleerd.</li>
    <li>Je gegevens gaan versleuteld naar ${naar}${v.schatting ? ` (${v.schatting.objects} bestanden, ${mbStr(v.schatting.bytes)})` : ""}. Laat ${DEVICE} aan staan en verbonden tot het klaar is.</li>
    <li>Daarna wordt je cloud wakker bij ${naar} en zegt de console je abonnement bij ${esc(v.van.naam)} op. Je oude opslag ruimt ${esc(v.van.naam)} daarna op.</li>
    ${dns}
    <li><b>Je cloud is ${min ? `ongeveer ${min} minuten` : "een tijdje"} offline.</b> Mail die in die tijd binnenkomt, wordt door de afzenders later opnieuw aangeboden.</li>
  </ul>`;
}

/** Het overstappen zelf: inloggen en bestellen bij de nieuwe aanbieder, betalen, overzetten, en de voortgang. */
async function renderOverstap(msg) {
  const box = $("#abo");
  if (!box) return;
  clearTimeout(overstapTimer);
  let v;
  try { v = await api("/api/overstap"); } catch (err) { box.innerHTML = `<h2>Overstappen</h2><p class="msg err">${esc(err.message)}</p>`; return; }
  if (!v.actief) { config = await api("/api/config"); return renderAbo(); }
  const brand = v.naar !== "zelf" ? await api(`/api/aanbieder/brand?url=${encodeURIComponent(v.naar)}`).catch(() => null) : null;
  const title = v.stap === "klaar" ? `Je cloud draait nu ${v.naar === "zelf" ? "in je eigen account" : `bij ${esc(v.naarNaam)}`}` : v.naar === "zelf" ? "Overstappen naar zelf beheren" : `Overstappen naar ${esc(v.naarNaam)}`;
  const stop = ["inloggen", "bestellen", "betalen", "zelf", "gereed"].includes(v.stap) ? `<p style="margin:0"><button class="link" id="oStop">Stoppen met overstappen</button></p>` : "";
  let inner = "";
  if (v.stap === "inloggen") {
    inner = `${overstapUitleg(v)}<form class="fields" id="of"><label>Je e-mailadres voor ${esc(v.naarNaam)}<input type="email" name="email" required value="${esc(v.email ?? config.alertEmail ?? "")}"></label><div><button class="btn primary">Stuur de code</button></div></form>
      <form class="fields" id="og" hidden><label>Code uit de mail<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label><div><button class="btn primary">Inloggen</button></div></form>`;
  } else if (v.stap === "bestellen") {
    const reg = v.van.mode === "register" || v.van.mode === "transfer";
    inner = `${overstapUitleg(v)}<form class="fields" id="of"><fieldset class="radios">${(brand?.bundles ?? []).map((x, i) => `<label class="check"><input type="radio" name="bundle" value="${esc(x.id)}" ${i === 0 ? "checked" : ""}> ${esc(x.title)} — ${eurStr(x.monthly)} per maand</label>`).join("")}</fieldset>
      ${reg ? `<div class="reg"><h3 style="margin:0">Houder van het domein</h3><p class="muted" style="margin:0"><small>Nodig om je domein te verhuizen.</small></p>
        <div class="row"><label>Voornaam<input name="firstName" required></label><label>Achternaam<input name="lastName" required></label></div>
        <label>Bedrijf (optioneel)<input name="company"></label>
        <div class="row"><label>Straat<input name="street" required></label><label style="flex:0 0 110px">Nummer<input name="number" required></label></div>
        <div class="row"><label style="flex:0 0 140px">Postcode<input name="zipcode" required></label><label>Plaats<input name="city" required></label></div>
        <div class="row"><label>Land<input name="country" value="NL" maxlength="2" required></label><label>Telefoon<input name="phone" type="tel" placeholder="+31 6 12345678" required></label></div>
        <label>E-mailadres<input name="email" type="email" required value="${esc(v.email ?? "")}"></label></div>` : ""}
      <label class="check"><input type="checkbox" name="terms" required><span>Ik ga akkoord met de ${brand?.termsUrl ? `<a href="${esc(brand.termsUrl)}" target="_blank" rel="noopener">voorwaarden</a>` : "voorwaarden"} van ${esc(v.naarNaam)}</span></label>
      <div><button class="btn primary">Afrekenen met iDEAL</button></div></form>`;
  } else if (v.stap === "betalen") {
    const s = v.bestelling;
    inner = `<p style="margin:0">${!s || s.status === "awaiting_payment" ? "Rond de betaling af. Daarna zet " + esc(v.naarNaam) + " alles voor je klaar." : s.status === "failed" ? `Er ging iets mis bij ${esc(v.naarNaam)}: ${esc(s.error ?? "")}` : `${esc(v.naarNaam)} zet alles voor je klaar.`}</p>
      ${s?.steps?.length ? launchView(s) : ""}
      ${v.checkoutUrl && (!s || s.status === "awaiting_payment") ? `<p><button class="btn" id="oPay">Naar de betaalpagina</button></p>` : ""}`;
  } else if (v.stap === "zelf") {
    inner = `${overstapUitleg(v)}<form class="fields" id="of">
      <p class="muted" style="margin:0">Maak bij Scaleway een API-sleutel voor jezelf (zie <button type="button" class="link" data-open="${esc(state.scaleway.keys)}">de sleutelpagina</button>) en bij deSEC een token dat domeinen mag aanmaken (<button type="button" class="link" data-open="https://desec.io/tokens">tokens bij deSEC</button>).</p>
      <label>Toegangssleutel (access key)<input name="accessKey" placeholder="SCW…" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
      <label>Geheime sleutel (secret key)<input name="secretKey" type="password" autocomplete="off" spellcheck="false" required></label>
      <details class="adv"><summary>Project kiezen (meestal niet nodig)</summary><label>Project-ID<input name="projectId" autocomplete="off" spellcheck="false"></label></details>
      <label>Token van deSEC<input name="desecToken" autocomplete="off" spellcheck="false" required></label>
      <div><button class="btn primary">Controleren</button></div></form>`;
  } else if (v.stap === "gereed") {
    inner = `${overstapUitleg(v)}<p class="note" style="margin:0">${v.naar === "zelf" ? "Je sleutels werken." : `${esc(v.naarNaam)} staat klaar${v.bestelling?.status === "ready" ? "" : " en wacht op je DNS"}.`} Kies een rustig moment: tijdens het overzetten is je cloud offline.</p>
      <div><button class="btn primary big" id="oNu">Nu overzetten</button></div>`;
  } else if (v.stap === "klaar") {
    const k = v.klaar ?? {};
    inner = `<p style="margin:0">Je mail, agenda's en foto's zijn mee. Je abonnement bij ${esc(v.van.naam)} is opgezegd${k.endsAt ? ` (loopt af op ${day(k.endsAt)})` : ""}; zij ruimen je oude opslag op.</p>
      ${k.ds?.length ? `<p class="note warn" style="margin:0"><b>Nog één ding:</b> zet bij je registrar de nieuwe DNSSEC-gegevens (DS-records) voor ${esc(v.van.domain)}:</p><div class="ns">${k.ds.map((x) => `<code>${esc(x)}</code>`).join("")}</div>` : ""}
      ${k.authCode ? `<p style="margin:0">Verhuiscode voor <b>${esc(v.van.domain)}</b> (om je domein bij ${esc(v.van.naam)} weg te halen):</p><div class="ns"><code>${esc(k.authCode)}</code></div>` : ""}
      <div><button class="btn primary" id="oClose">Sluiten</button></div>`;
  } else if (v.stap === "teruggezet") {
    inner = `<p style="margin:0">Je cloud draait weer bij ${esc(v.van.naam)}, met al je gegevens.${v.klaar?.ds?.length ? "" : ""}</p>
      ${v.klaar?.ds?.length ? `<p class="note warn" style="margin:0">Zet bij je registrar deze DNSSEC-gegevens (DS-records):</p><div class="ns">${v.klaar.ds.map((x) => `<code>${esc(x)}</code>`).join("")}</div>` : ""}
      <div><button class="btn primary" id="oClose">Sluiten</button></div>`;
  } else {
    // overzetten, mislukt, terug
    inner = `${launchView({ steps: v.stappen })}
      ${v.fout ? `<p class="note warn" style="margin:0">${esc(v.fout)}</p>
        <div class="actions" style="margin:0">${v.stap === "mislukt" ? `<button class="btn primary" id="oNu">Opnieuw proberen</button>` : ""}${v.kanTerug ? `<button class="btn" id="oTerug">Terug naar ${esc(v.van.naam)}</button>` : ""}</div>` : `<p class="muted" style="margin:0"><small>Laat ${DEVICE} aan staan tot het klaar is. Je kunt dit scherm sluiten; de console gaat verder waar hij was.</small></p>`}`;
  }
  box.innerHTML = `<h2>${title}</h2>${brandLine(brand)}<div class="panel">${inner}${stop}<p class="msg ${msg?.ok ? "ok" : msg ? "err" : ""}" id="omsg">${esc(msg?.text ?? "")}</p></div>`;
  const fail = (err) => { $("#omsg").textContent = err.message; $("#omsg").className = "msg err"; };
  box.onclick = null;
  box.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => (NATIVE ? NATIVE.openUrl(b.dataset.open) : window.open(b.dataset.open, "_blank", "noopener")));
  $("#oStop")?.addEventListener("click", async (e) => {
    if (!confirm(v.orderId ? `Stoppen met overstappen?\n\nJe bestelling bij ${v.naarNaam} wordt opgezegd. Je cloud blijft bij ${v.van.naam}.` : "Stoppen met overstappen?")) return;
    try { await busy(e.target, () => api("/api/overstap/stoppen", { method: "POST" })); config = await api("/api/config"); renderAbo(); } catch (err) { fail(err); }
  });
  $("#oClose")?.addEventListener("click", async (e) => { try { await busy(e.target, () => api("/api/overstap/stoppen", { method: "POST" })); config = await api("/api/config"); renderDash(); } catch (err) { fail(err); } });
  $("#oPay")?.addEventListener("click", () => openCheckout(v.checkoutUrl));
  $("#oNu")?.addEventListener("click", async (e) => {
    if (!confirm(`Nu overzetten?\n\nJe cloud gaat slapen en is ${v.schatting?.minuten ? `ongeveer ${v.schatting.minuten} minuten` : "een tijdje"} offline. Daarna draait hij ${v.naar === "zelf" ? "in je eigen account" : `bij ${v.naarNaam}`}.`)) return;
    try { await busy(e.target, () => api("/api/overstap/nu", { method: "POST", body: { confirm: true } })); renderOverstap(); } catch (err) { fail(err); }
  });
  $("#oTerug")?.addEventListener("click", async (e) => {
    if (!confirm(`Terug naar ${v.van.naam}?\n\nJe cloud wordt weer wakker bij ${v.van.naam}, met je gegevens van vóór het overstappen.`)) return;
    try { await busy(e.target, () => api("/api/overstap/terug", { method: "POST" })); renderOverstap(); } catch (err) { fail(err); }
  });
  const f = $("#of"), g = $("#og");
  if (f && v.stap === "inloggen") {
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await busy($("button", f), () => api("/api/overstap/login", { method: "POST", body: { email: f.email.value } })); f.hidden = true; g.hidden = false; g.code.focus(); }
      catch (err) { fail(err); }
    };
    g.onsubmit = async (e) => {
      e.preventDefault();
      try { await busy($("button", g), () => api("/api/overstap/verify", { method: "POST", body: { code: g.code.value } })); renderOverstap(); }
      catch (err) { fail(err); }
    };
  }
  if (f && v.stap === "bestellen") {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const reg = f.firstName ? Object.fromEntries(["firstName", "lastName", "company", "street", "number", "zipcode", "city", "country", "phone", "email"].map((k) => [k, f[k].value.trim()])) : undefined;
      try {
        const r = await busy($("button.primary", f), () => api("/api/overstap/order", { method: "POST", body: { bundle: f.bundle?.value, acceptTerms: f.terms.checked, ...(reg ? { registrant: reg } : {}) } }));
        openCheckout(r.checkoutUrl);
        renderOverstap();
      } catch (err) { fail(err); }
    };
  }
  if (f && v.stap === "zelf") {
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await busy($("button.primary", f), () => api("/api/overstap/zelf", { method: "POST", body: { accessKey: f.accessKey.value, secretKey: f.secretKey.value, projectId: f.projectId.value, desecToken: f.desecToken.value } })); renderOverstap({ ok: true, text: "Je sleutels werken." }); }
      catch (err) { fail(err); }
    };
  }
  // Bijwerken zolang er iets loopt (betalen, klaarzetten, overzetten, terug).
  if (["betalen", "overzetten", "terug"].includes(v.stap) && !v.fout) overstapTimer = setTimeout(() => { if ($("#abo")) renderOverstap(); }, 2500);
}

/** Hulpvragen aan je aanbieder: nieuwe vraag, eerdere vragen en antwoorden. */
async function helpPanel(box, fail) {
  let list;
  try { list = (await api("/api/dienst/tickets")).tickets ?? []; } catch (err) { return fail(err); }
  const STATUS = { open: "wacht op antwoord", beantwoord: "beantwoord", answered: "beantwoord", closed: "gesloten", gesloten: "gesloten" };
  box.innerHTML = `<form class="fields" id="tf"><h3 style="margin:0">Nieuwe vraag</h3>
      <label>Onderwerp<input name="subject" maxlength="120" required></label>
      <label>Je vraag<textarea name="message" rows="4" maxlength="5000" required></textarea></label>
      <div><button class="btn primary">Versturen</button></div></form>
    ${list.length ? `<h3>Eerdere vragen</h3><ul class="items">${list.map((t) => `<li><b>${esc(t.subject)}</b><span class="sub">${esc(t.statusLabel ?? STATUS[t.status] ?? t.status ?? "")}${t.updatedAt ? " · " + day(t.updatedAt) : ""}</span><span class="end"><button class="link" data-t="${esc(t.id)}">Openen</button></span></li>`).join("")}</ul>` : ""}
    <div id="tview"></div>`;
  $("#tf").onsubmit = async (e) => {
    e.preventDefault();
    try { await busy($("#tf button"), () => api("/api/dienst/tickets", { method: "POST", body: { subject: e.target.subject.value, message: e.target.message.value } })); helpPanel(box, fail); }
    catch (err) { fail(err); }
  };
  box.querySelectorAll("[data-t]").forEach((btn) => btn.onclick = async () => {
    try {
      const t = await api(`/api/dienst/ticket?id=${encodeURIComponent(btn.dataset.t)}`);
      $("#tview").innerHTML = `<div class="panel"><b>${esc(t.subject)}</b>${(t.messages ?? []).map((m) => `<div class="tmsg ${m.from === "customer" ? "me" : ""}"><small class="muted">${esc(m.name ?? (m.from === "customer" ? "Jij" : "Aanbieder"))} · ${day(m.at)}</small><p>${esc(m.body ?? "")}</p></div>`).join("")}
        <form class="fields" id="rf"><label>Reageren<textarea name="message" rows="3" required></textarea></label><div><button class="btn">Versturen</button></div></form></div>`;
      $("#rf").onsubmit = async (e) => {
        e.preventDefault();
        try { await busy($("#rf button"), () => api("/api/dienst/ticket/reply", { method: "POST", body: { id: t.id, message: e.target.message.value } })); btn.click(); }
        catch (err) { fail(err); }
      };
    } catch (err) { fail(err); }
  });
}


// ═════════ Aanbieder worden: je eigen Eigen Cloud Dienst ═════════

const A_STEPS = [["bedrijf", "Bedrijf"], ["accounts", "Accounts"], ["adres", "Adres"], ["server", "Server en back-ups"], ["opzetten", "Opzetten"]];
const A_HELP = {
  scaleway: `Hiermee zet je Dienst de clouds van je klanten op. Het makkelijkst: plak één eigen sleutel, de app maakt dan een sleutel met alleen de rechten die je Dienst nodig heeft.`,
  scalewayHand: `Maak in de Scaleway-console onder IAM een applicatie "eigen-cloud-dienst" met de rechten ProjectManager, IAMManager, InstancesFullAccess, ObjectStorageFullAccess en TransactionalEmailFullAccess, en maak daarvoor een API-sleutel. Het organisatie-ID staat bij Organisatie → Instellingen. De server van je Dienst zelf mag ook bij een andere aanbieder staan. <a href="https://console.scaleway.com/iam/applications" target="_blank" rel="noopener">IAM openen</a>`,
  mollie: `Voor de betalingen van je klanten. Begin met de testsleutel (test_…); later zet je hier de live-sleutel. <a href="https://my.mollie.com/dashboard/developers/api-keys" target="_blank" rel="noopener">Sleutels bij Mollie</a>`,
  desec: `Voor de DNS van je klanten. Nog geen account? Laat de app er een maken, met een token dat zones mag maken en weghalen. Of maak bij deSEC zelf een token dat domeinen mag aanmaken. <a href="https://desec.io/tokens" target="_blank" rel="noopener">Tokens bij deSEC</a>`,
  smtp: `Voor inlogcodes, facturen en meldingen. Leeg laten = via de mail van je eigen cloud.`,
  smtpZelf: `Voor inlogcodes, facturen en meldingen, bijvoorbeeld Scaleway Transactional Email of de SMTP-server van je mailprovider: smtp://gebruiker:wachtwoord@server:587. Of laat de app het bij Scaleway regelen.`,
  dns: `Op dit adres vinden je klanten je Dienst. Kies wie het in de DNS zet. Met een DNS-aanbieder doet de console het zelf, ook als je server later een ander IP-adres krijgt.`,
  openprovider: `Alleen nodig als klanten via jou een domein kopen. Zet bij Openprovider het IP-adres van je server op de lijst. <a href="https://cp.openprovider.eu" target="_blank" rel="noopener">Openprovider</a>`,
  adres: `Gratis adressen (naam.eigencloud.nl) voor je klanten, via de centrale adressendienst. Leeg laten = vanzelf: staat je Dienst op de lijst van aanbieders, dan gebruikt hij de adressendienst van het project.`,
  adressen: `Alleen voor de beheerders van het open-sourceproject. De gratis-adressendienst geeft klanten van <b>alle</b> aanbieders een gratis adres (bijvoorbeeld vanes.eigencloud.nl) dat ze houden als ze van aanbieder wisselen. Hij draait mee op de server van je Dienst. Je hebt nodig: een eigen domein voor die adressen, bij deSEC (de "gedeelde zone", bijvoorbeeld eigencloud.nl), en een deSEC-token van dat account dat tokens mag beheren. Vraag deSEC om een hogere zonelimiet: elk gratis adres is een zone. <a href="https://desec.io/tokens" target="_blank" rel="noopener">Tokens bij deSEC</a>`,
};

/** Het beheer van je Dienst openen, eventueel meteen op een pagina (…/beheer#/klanten). In de app: met vingerafdruk. */
function openBeheer(url) {
  if (NATIVE?.openDienst) NATIVE.openDienst(url);
  else if (NATIVE) NATIVE.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

async function aStep(step) {
  await api("/api/aanbieder/stap", { method: "POST", body: { step } });
  renderAanbieder();
}

/** Op het overzicht: "Aanbieder worden", de stappen, of "Je dienst" met status en knoppen. */
async function renderAanbieder(msg) {
  const box = $("#aanbieder");
  if (!box) return;
  clearInterval(aanbiederTimer);
  let a;
  try { a = await api("/api/aanbieder"); } catch { return; }
  rememberDienst(a);
  if (!a.started || location.hash.slice(1).startsWith("aanbieder/nodig")) {
    // Eerste scherm (en #aanbieder/nodig tijdens de stappen): wat je nodig hebt, met per onderdeel "Regelen".
    box.innerHTML = `${a.started ? `<p style="margin:0"><button type="button" class="link" id="aBack">Terug naar de stappen</button></p>` : `<div class="panel"><p style="margin:0">Draai zelf een Eigen Cloud Dienst: mensen nemen dan bij jou een cloud, met jouw prijzen en jouw naam, en betalen via je eigen Mollie. De console zet de Dienst op een eigen server bij een Europese aanbieder naar keuze, maakt elk uur een back-up en houdt hem bij.</p></div>`}
      <h2 class="astep">Wat je nodig hebt</h2><div id="nodigBox"></div>`;
    $("#aBack")?.addEventListener("click", () => goHash("aanbieder"));
    renderNodig($("#nodigBox"), nodigCtx(a), { start: !a.started, open: location.hash.split("/")[2] ?? null });
    return;
  }
  if (a.step === "klaar" && a.hub) return renderHub(isDienstHash(location.hash.slice(1)) ? location.hash.slice(1) : "aanbieder", msg);
  if (a.step === "klaar") a.step = "opzetten";
  const i = A_STEPS.findIndex(([id]) => id === a.step);
  const head = `<ol class="atrail" aria-label="Stappen">${A_STEPS.map(([, l], k) => `<li class="${k < i ? "done" : k === i ? "now" : ""}" ${k === i ? 'aria-current="step"' : ""}><span class="pip">${k < i ? "✓" : k + 1}</span><span class="t">${esc(l)}</span></li>`).join("")}</ol>
    <h2 class="astep">Stap ${i + 1} van ${A_STEPS.length}: ${esc(A_STEPS[i][1])}</h2><p class="muted" style="margin:0"><a class="link" href="#aanbieder/nodig">Wat je nodig hebt</a></p>`;
  const nav = (canNext, nextLabel = "Volgende") => `<div class="actions" style="margin:0"><button type="button" class="btn" id="aPrev">${i > 0 ? "Vorige" : a.server || a.removed ? "Terug" : "Stoppen"}</button><button class="btn primary" ${canNext === false ? "disabled" : ""}>${nextLabel}</button></div>`;
  const wire = () => {
    $("#aPrev").onclick = () => {
      if (i === 0 && !a.server && !a.removed && !confirm("Stoppen met aanbieder worden? Wat je hebt ingevuld, wordt vergeten.")) return;
      (i > 0 ? aStep(A_STEPS[i - 1][0]) : aStep(a.server || a.removed ? "klaar" : "uit")).catch((e) => formMsg($("#af"), e.message));
    };
  };
  const co = a.company ?? {};
  if (a.step === "bedrijf") {
    box.innerHTML = `${head}<form class="fields panel" id="af"><p class="muted" style="margin:0">Deze gegevens komen op de facturen aan je klanten. De eigenaar krijgt de eerste inlogcode voor het beheer van je Dienst.</p>
      <label>Bedrijfsnaam<input name="name" required value="${esc(co.name ?? "")}"></label>
      <label>Adres<textarea name="address" rows="2" placeholder="Blaak 10&#10;3011 TA Rotterdam">${esc((co.address ?? []).join("\n"))}</textarea></label>
      <div class="row"><label>KvK-nummer<input name="kvk" inputmode="numeric" value="${esc(co.kvk ?? "")}"></label><label>Btw-nummer<input name="vat" placeholder="NL001234567B01" value="${esc(co.vat ?? "")}"></label></div>
      <label>E-mailadres van de eigenaar<input type="email" name="email" required value="${esc(co.email ?? a.defaultEmail ?? "")}"></label>
      <div class="row"><label>Btw-percentage op je facturen<input name="vatPercent" inputmode="decimal" value="${esc(co.vatPercent ?? "21")}"><small>Je prijzen zijn inclusief deze btw.</small></label></div>
      <label class="check"><input type="checkbox" name="enforce" ${co.enforce ? "checked" : ""}> Extra servers van klanten echt uitzetten<small>De Dienst kijkt elk uur of een klant meer servers draait dan zijn bundel toestaat. Uit: je krijgt alleen een melding.</small></label>
      <p class="msg"></p>${nav()}</form>`;
    wire();
    $("#af").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try { await busy($("button.primary", f), () => api("/api/aanbieder/bedrijf", { method: "POST", body: { name: f.elements.name.value, address: f.address.value, kvk: f.kvk.value, vat: f.vat.value, email: f.email.value, vatPercent: f.vatPercent.value, enforce: f.enforce.checked } })); await aStep("accounts"); }
      catch (err) { formMsg(f, err.message); }
    };
    return;
  }
  if (a.step === "accounts") {
    const ac = a.accounts ?? {};
    const field = (name, label, value, extra = "") => `<label>${label}<input name="${name}" value="${esc(value ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" ${extra}></label>`;
    box.innerHTML = `${head}<form class="fields panel" id="af"><p class="muted" style="margin:0">Je Dienst gebruikt je eigen accounts. Elke sleutel wordt meteen gecontroleerd; ze worden versleuteld in je kluis bewaard.</p>
      <h3 style="margin:0">Scaleway</h3><small class="muted">${A_HELP.scaleway}</small>
      ${regelKnop("scaleway", ac.scalewaySecretKey ? "Opnieuw regelen met één sleutel" : "Regel het met één sleutel")}
      <details ${ac.scalewaySecretKey ? "open" : ""}><summary>Of vul de sleutel van de Dienst zelf in</summary><div class="fields" style="margin-top:10px"><small class="muted">${A_HELP.scalewayHand}</small>
      <div class="row">${field("scalewaySecretKey", "Geheime sleutel", ac.scalewaySecretKey, 'placeholder="8-4-4-4-12 tekens"')}${field("scalewayOrgId", "Organisatie-ID", ac.scalewayOrgId)}</div></div></details>
      <h3 style="margin:0">Mollie</h3><small class="muted">${A_HELP.mollie}</small>
      ${field("mollieKey", "API-sleutel", ac.mollieKey, 'placeholder="test_…"')}
      ${regelKnop("mollie", "Nagaan wat er bij Mollie nog aan moet")}
      <h3 style="margin:0">deSEC</h3><small class="muted">${A_HELP.desec}</small>
      ${ac.desecToken ? "" : regelKnop("desec", "Nog geen deSEC-account? Laat de app er een maken")}
      ${field("desecToken", "Token", ac.desecToken)}
      <h3 style="margin:0">Mail versturen</h3><small class="muted">${config?.mailRelay ? A_HELP.smtp : A_HELP.smtpZelf}</small>
      ${regelKnop("mail", "Regel de mail via Scaleway")}
      ${config?.mailRelay ? `<label class="check"><input type="checkbox" name="smtpCloud" ${!ac.smtp || ac.smtpFromCloud ? "checked" : ""}> Via de mail van mijn eigen cloud${ac.smtpFromCloud ? ` (${esc(ac.smtp)})` : ""}</label>` : ""}
      <div class="row">${field("smtpUrl", "Andere mailserver", "", `placeholder="${ac.smtp && !ac.smtpFromCloud ? `Nu ${esc(ac.smtp)}; leeg = zo laten` : "smtp://gebruiker:wachtwoord@smtp.tem.scaleway.com:587"}"`)}${field("mailFrom", "Afzender", ac.mailFrom, 'type="email"')}</div>
      <details ${ac.openproviderUser || ac.adresUrl ? "open" : ""}><summary>Optioneel: domeinen verkopen en gratis adressen</summary><div class="fields" style="margin-top:10px">
        <small class="muted">${A_HELP.openprovider}</small>
        <div class="row">${field("openproviderUser", "Openprovider-gebruiker", ac.openproviderUser)}${field("openproviderPass", "Wachtwoord", ac.openproviderPass, 'type="password"')}</div>
        <small class="muted">${A_HELP.adres}</small>
        ${field("adresUrl", "Adressendienst", ac.adresUrl, 'placeholder="https://adressen.eigencloud.nl"')}
      </div></details>
      <ul class="results" id="aChecks"></ul>
      <p class="msg"></p>${nav(undefined, a.ready.accounts ? "Controleren en verder" : "Controleren")}</form>`;
    wire();
    wireRegel($("#af"), a, () => renderAanbieder());
    $("#af").smtpUrl.oninput = (e) => { if (e.target.value.trim() && $("#af").smtpCloud) $("#af").smtpCloud.checked = false; };
    $("#af").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = Object.fromEntries(["scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "mailFrom", "openproviderUser", "openproviderPass", "adresUrl"].map((n) => [n, f[n].value]));
      // Mailserver: leeg laten = de bewaarde houden (het wachtwoord staat er niet in het scherm bij).
      if (f.smtpCloud?.checked && !f.smtpUrl.value.trim()) body.smtpUrl = "";
      else if (f.smtpUrl.value.trim()) body.smtpUrl = f.smtpUrl.value;
      try {
        const r = await busy($("button.primary", f), () => api("/api/aanbieder/accounts", { method: "POST", body }));
        $("#aChecks").innerHTML = resultItems(r.checks);
        if (r.ok) { formMsg(f, "Alles werkt.", true); setTimeout(() => aStep("adres").catch(() => {}), 900); }
        else formMsg(f, "Nog niet alles werkt; pas aan wat rood is en controleer opnieuw.");
      } catch (err) { formMsg(f, err.message); }
    };
    return;
  }
  if (a.step === "adres") {
    box.innerHTML = `${head}<form class="fields panel" id="af"><p class="muted" style="margin:0">Op dit adres vinden je klanten en de app je Dienst, en log je in op het beheer.</p>
      <label>Adres van je Dienst<input name="url" value="${esc(a.url ?? a.defaultUrl ?? "")}" placeholder="dienst.jouwbedrijf.nl" autocapitalize="off" spellcheck="false" required></label>
      ${a.server ? `<p class="note warn" style="margin:0">Een nieuw adres gaat pas in na <b>Opnieuw opzetten</b>.</p>` : ""}
      <div id="aDns" class="fields"></div>
      <details ${a.adressen ? "open" : ""}><summary>Ook de gratis-adressendienst draaien</summary><div class="fields" style="margin-top:10px">
        <small class="muted">${A_HELP.adressen}</small>
        <label class="check"><input type="checkbox" name="adrAan" ${a.adressen ? "checked" : ""}> Ja, draai de gratis-adressendienst op de server van mijn Dienst</label>
        <div class="row"><label>Gedeelde zone<input name="adrZone" value="${esc(a.adressen?.zone ?? "")}" placeholder="eigencloud.nl" autocapitalize="off" spellcheck="false"></label>
          <label>deSEC-token voor die zone<input name="adrToken" value="${esc(a.adressen?.desecToken ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false"></label></div>
        <label>Adres van de adressendienst<input name="adrHost" value="${esc(a.adressen?.host ?? a.defaultAdressenHost ?? "")}" autocapitalize="off" spellcheck="false"><small>Dit adres komt in de DNS op dezelfde manier als dat van je Dienst. Andere Diensten vinden het via de lijst van aanbieders ("adressen" op de standaardregel).</small></label>
        ${a.server ? `<p class="note warn" style="margin:0">Aan- of uitzetten gaat in na <b>Opnieuw opzetten</b>.</p>` : ""}
        <ul class="results" id="adrChecks"></ul>
      </div></details>
      <p class="msg"></p>${nav()}</form>`;
    wire();
    const dnsUi = dnsChooser($("#aDns"), a, $("#af").url);
    $("#af").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await busy($("button.primary", f), async () => {
          await api("/api/aanbieder/adres", { method: "POST", body: { url: f.url.value } });
          await dnsUi.save();
          if (f.adrAan.checked) {
            const r = await api("/api/aanbieder/adressen", { method: "POST", body: { zone: f.adrZone.value, desecToken: f.adrToken.value, host: f.adrHost.value } });
            $("#adrChecks").innerHTML = resultItems(r.checks);
            if (!r.ok) throw new Error("De adressendienst kan zo nog niet: pas aan wat rood is.");
          } else if (a.adressen) await api("/api/aanbieder/adressen", { method: "POST", body: { aan: false } });
        });
        await aStep("server");
      } catch (err) { formMsg(f, err.message); }
    };
    return;
  }
  if (a.step === "server") return aanbiederServer(box, a, head, nav, wire);
  // opzetten
  const missing = [!a.ready.bedrijf && "je bedrijfsgegevens", !a.ready.accounts && "je accounts", !a.ready.adres && "het adres", !a.ready.server && "de server en back-ups"].filter(Boolean);
  const h = a.hosting ?? {}, bk = a.backup ?? {};
  const moved = a.server && (a.server.provider !== h.provider || a.server.region !== h.region);
  box.innerHTML = `${head}<form class="fields panel" id="af">
    <p style="margin:0">${a.server ? `Je Dienst krijgt een <b>nieuwe server</b>${moved ? ` bij ${esc(h.name)} in ${esc(h.city)}` : ""} met de nieuwe instellingen. De huidige server maakt eerst een laatste back-up; de nieuwe zet die terug. Een paar minuten is de Dienst niet bereikbaar.` : `De console zet een server op bij <b>${esc(h.name ?? "")}</b> in ${esc(h.city ?? "")} (${esc(h.size ?? "")}${h.monthly != null ? `, ${eur(h.monthly)} per maand` : ""}) en bewaart de back-ups bij <b>${esc(bk.name ?? "")}</b> (${esc(bk.regionLabel ?? "")}).${h.provider === "scaleway" || bk.auto ? " Bij Scaleway komt dat in een eigen project <b>eigen-cloud-dienst</b>." : ""} De Dienst staat daarna op <b>${esc(a.url ?? "")}</b>.`}</p>
    <p class="muted" style="margin:0"><small>Elk uur een versleutelde back-up, 30 dagen niet te wissen. De server werkt zichzelf 's nachts bij naar de nieuwste versie en zet de vorige terug als dat misgaat.</small></p>
    ${missing.length ? `<p class="note warn" style="margin:0">Nog niet klaar: ${esc(missing.join(", "))}.</p>` : ""}
    ${a.server && a.wijzigingen !== "opnieuw" && !missing.length ? `<p class="note" style="margin:0">Alleen bedrijfsgegevens, sleutels of mail gewijzigd? Dan is een nieuwe server niet nodig: <button type="button" class="link" id="aApply2">wijzigingen toepassen</button> (de Dienst start even opnieuw).</p>` : ""}
    <ul class="results" id="aSteps"></ul>
    <p class="msg"></p>${nav(!missing.length, a.server ? "Opnieuw opzetten" : "Dienst opzetten")}</form>`;
  wire();
  $("#aApply2")?.addEventListener("click", async (e) => {
    try {
      const r = await busy(e.target, () => api("/api/aanbieder/toepassen", { method: "POST" }));
      await api("/api/aanbieder/stap", { method: "POST", body: { step: "klaar" } });
      renderAanbieder({ ok: true, text: r.restart ? "Toegepast. Je Dienst start nu opnieuw met de nieuwe instellingen." : "Toegepast." });
    } catch (err) { formMsg($("#af"), err.message); }
  });
  $("#af").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await busy($("button.primary", f), () => api("/api/aanbieder/opzetten", { method: "POST" }));
      $("#aSteps").innerHTML = resultItems(r.steps);
      setTimeout(() => renderAanbieder({ ok: true, text: r.replaced ? "De nieuwe server start op; over een paar minuten is je Dienst weer bereikbaar." : "Je Dienst start op. Dat duurt meestal 3 à 5 minuten." }), 1500);
    } catch (err) { if (err.data?.steps) $("#aSteps").innerHTML = resultItems(err.data.steps); formMsg(f, err.message); }
  };
}

/** Stap "Server en back-ups": aanbieder en regio (live prijzen, kleinste geschikte formaat) en de plek van de back-ups. */
function aanbiederServer(box, a, head, nav, wire) {
  const servers = state.offers.servers ?? [];
  const stores = (state.offers.stores ?? []).filter((o) => o.id !== "localfs");
  const linked = (config?.stores ?? []).filter((s) => s.type === "s3");
  const h = a.hosting, bk = a.backup;
  const hasKey = (id) => id === "scaleway" || !!config?.providers?.[id] || (a.hostingKeys ?? []).includes(id);
  box.innerHTML = `${head}<form class="fields panel" id="af">
    <p class="muted" style="margin:0">Kies waar de server van je Dienst draait en waar de back-ups komen. Dat mag bij verschillende aanbieders. Je kunt het later wijzigen met <b>Opnieuw opzetten</b>.</p>
    <h3 style="margin:0">Server</h3>
    <label>Aanbieder<select name="provider">${servers.map((o) => `<option value="${esc(o.id)}" ${o.id === (h?.provider ?? "scaleway") ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
    <div id="aKeys" class="fields"></div>
    <div><button type="button" class="btn" id="aPrices">Regio's en prijzen ophalen</button></div>
    <div id="aRegions" class="fields"></div>
    <h3 style="margin:0">Back-ups</h3>
    ${bk?.bucket ? `<p style="margin:0">De back-ups staan in <b>${esc(bk.bucket)}</b> bij ${esc(bk.name)} (${esc(bk.regionLabel)}). Die plek blijft hetzelfde, zodat een nieuwe server ze terug kan zetten.</p>`
      : `<label>Waar<select name="bwhere">${linked.map((s) => `<option value="store:${esc(s.name)}">Gekoppelde opslag van je cloud: ${esc(s.name)}</option>`).join("")}${stores.map((o) => `<option value="${esc(o.id)}" ${o.id === (bk?.provider ?? "scaleway") ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
      <div id="aBackup" class="fields"></div>`}
    <p class="msg"></p>${nav()}</form>`;
  wire();
  const f = $("#af");
  const offer = () => servers.find((o) => o.id === f.provider.value);
  const now = () => (h && h.provider === f.provider.value ? `<p class="muted" style="margin:0">Nu gekozen: ${esc(h.name)}, ${esc(h.regionLabel)} (${esc(h.size)}, ${esc(eur(h.monthly))} per maand)</p>` : "");
  const keys = () => {
    const o = offer();
    $("#aKeys").innerHTML = !o ? "" : o.id === "scaleway"
      ? `<small class="muted">Met je Scaleway-sleutel van stap 2, in een eigen project eigen-cloud-dienst.</small>`
      : `${o.keyHelp ? `<small class="muted">${esc(o.keyHelp)}</small>` : ""}${fieldInputs(o.fields, { optional: hasKey(o.id), placeholder: () => (hasKey(o.id) ? "Bewaard; leeg laten = zo laten" : "") })}`;
    $("#aRegions").innerHTML = now();
  };
  keys();
  f.provider.onchange = keys;
  const fields = () => Object.fromEntries($$("#aKeys input").map((i) => [i.name, i.value]));
  $("#aPrices").onclick = async (e) => {
    try {
      const r = await busy(e.target, () => api("/api/aanbieder/server", { method: "POST", body: { provider: f.provider.value, fields: fields() } }));
      const pick = h?.provider === f.provider.value ? h.region : r.regions.find((x) => !x.error)?.region;
      $("#aRegions").innerHTML = r.regions.map((x) => `<label class="check"><input type="radio" name="region" value="${esc(x.region)}" ${x.error ? "disabled" : x.region === pick ? "checked" : ""}> ${FLAGS[x.country] ?? ""} ${esc(x.label)} <small class="muted">${x.error ? esc(x.error) : `${esc(x.sizeLabel)} (${esc(x.size)}), ${esc(eur(x.monthly))} per maand`}</small></label>`).join("");
      formMsg(f, "");
    } catch (err) { formMsg(f, err.message); }
  };
  const backupForm = () => {
    const w = f.bwhere?.value;
    if (!w) return;
    if (w.startsWith("store:")) { $("#aBackup").innerHTML = `<small class="muted">Met de sleutels van deze opslag. De Dienst krijgt er een eigen bucket, 30 dagen niet te wissen.</small>`; return; }
    const o = stores.find((x) => x.id === w);
    const same = bk?.provider === o.id;
    $("#aBackup").innerHTML = `<small class="muted">${esc(o.help ?? "")}</small>
      ${o.regions.length > 1 ? `<label>Locatie<select name="bRegion">${o.regions.map((r) => `<option value="${esc(r.id)}" ${same && r.id === bk.region ? "selected" : ""}>${FLAGS[r.country] ?? ""} ${esc(r.label)}</option>`).join("")}</select></label>` : `<input type="hidden" name="bRegion" value="${esc(o.regions[0]?.id ?? "")}">`}
      ${o.customEndpoint ? `<label>Endpoint<input name="bEndpoint" placeholder="https://…" autocomplete="off" spellcheck="false"></label>` : ""}
      ${o.id === "scaleway" ? `<small class="muted">Sleutels leeg laten: de console maakt zelf een sleutel die alleen opslag in het project eigen-cloud-dienst mag.</small>` : ""}
      <div class="row"><label>Toegangssleutel<input name="bAccess" autocomplete="off" spellcheck="false" ${same ? 'placeholder="Bewaard; leeg laten = zo laten"' : ""}></label><label>Geheime sleutel<input name="bSecret" type="password" autocomplete="off" ${same ? 'placeholder="Bewaard; leeg laten = zo laten"' : ""}></label></div>`;
  };
  backupForm();
  if (f.bwhere) f.bwhere.onchange = backupForm;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const region = $("input[name=region]:checked", f)?.value;
    try {
      await busy($("button.primary", f), async () => {
        if (region) await api("/api/aanbieder/server", { method: "POST", body: { provider: f.provider.value, region, fields: fields() } });
        else if (!h || h.provider !== f.provider.value) throw new Error("Haal eerst de regio's en prijzen op en kies een regio");
        const w = f.bwhere?.value;
        if (!w) return;
        if (w.startsWith("store:")) return api("/api/aanbieder/backup", { method: "POST", body: { store: w.slice(6) } });
        // Zelfde plek en geen nieuwe sleutels: laten zoals het is.
        if (bk?.provider === w && (w !== "scaleway" || bk.region === f.bRegion.value) && !f.bAccess.value.trim() && !f.bSecret.value.trim() && !f.bEndpoint?.value.trim()) return;
        return api("/api/aanbieder/backup", { method: "POST", body: { provider: w, region: f.bRegion.value, endpoint: f.bEndpoint?.value ?? "", accessKey: f.bAccess.value, secretKey: f.bSecret.value } });
      });
      await aStep("opzetten");
    } catch (err) { formMsg(f, err.message); }
  };
}

// ═════════ Je dienst: één plek voor alles ═════════

/** Korte uitleg per onderdeel van "Je dienst" (de onderdelen zelf komen uit GET /api/aanbieder → hub). */
const HUB_TEXT = {
  overzicht: "Status, versie, klanten en omzet",
  bedrijf: "Naam, adres, KvK, btw en contact",
  accounts: "Mollie, deSEC, Scaleway, Openprovider en mail",
  aanbod: "Bundels, prijzen en waar de servers staan",
  huisstijl: "Naam, logo, kleur en contact",
  voorwaarden: "Voorwaarden, privacy en verwerkersovereenkomst",
  medewerkers: "Wie mag wat in het beheer",
  klanten: "Zoeken, opschorten, hervatten en opruimen",
  hulpvragen: "Vragen van je klanten beantwoorden",
  berichten: "Meldingen en storingen aan je klanten",
  adressendienst: "Gratis adressen voor alle aanbieders",
  lijst: "Je regel op de lijst van aanbieders, via GitHub",
  server: "Plek, adres, DNS, back-ups en hersteltest",
  kosten: "Wat je Dienst en je klanten kosten",
  updates: "Versie en automatisch bijwerken",
};
/** Waar de gegevens van een onderdeel staan. */
const WAAR = { console: "In je kluis", dienst: "In het beheer", beide: "Hier en in het beheer" };
HUB_TEXT.nodig = "Alles om aanbieder te zijn, met wat nog moet";

/** Wat nodig.js van de console gebruikt (zie renderNodig). */
function nodigCtx(a) {
  return { api, esc, busy, formMsg, resultItems, openBeheer, NATIVE, readClipboard, fillKeys, dnsChooser, config, a, aStep, goHash,
    openUrl: (u) => (NATIVE ? NATIVE.openUrl(u) : window.open(u, "_blank", "noopener")) };
}

/** Knop "Laat de app het regelen" bij een account (stap Accounts, Je dienst → Accounts en sleutels): opent het paneel uit Wat je nodig hebt. */
const regelKnop = (id, label) => `<div><button type="button" class="btn" data-regel="${esc(id)}">${esc(label)}</button></div>`;
function wireRegel(form, a, onDone) {
  form.querySelectorAll("[data-regel]").forEach((b) => b.onclick = () => regelVenster(b.dataset.regel, nodigCtx(a), onDone));
}

/** Je dienst → Wat je nodig hebt: dezelfde lijst als bij het opzetten. */
function hubNodig(pane, a) {
  pane.innerHTML = `${sectionHead(a, "nodig")}<div id="nodigBox"></div>`;
  renderNodig($("#nodigBox"), nodigCtx(a), { open: location.hash.split("/")[2] ?? null });
}
let lastChecks = null;

const cloudLater = () => `<p class="muted cloudlater"><small>Ook zelf een cloud voor je mail, agenda en foto's? <a href="#jij">Eigen cloud maken</a></small></p>`;

/** Wat er nog niet op de Dienst staat, met de knop om het toe te passen (of naar Opnieuw opzetten). */
function pendingBar(a) {
  const label = (id) => a.hub.find((x) => x.id === id)?.label ?? id;
  const others = a.pending.filter((x) => x !== "server");
  if (a.wijzigingen === "toepassen") return `<div class="note pendingbar"><div><b>Nog niet op je Dienst</b><br><small>${others.length ? `Gewijzigd: ${esc(others.map(label).join(", "))}. ` : "Je hebt instellingen gewijzigd. "}Je Dienst start daarvoor even opnieuw, zonder nieuwe server.</small></div><button class="btn primary" id="hApply">Wijzigingen toepassen</button></div>`;
  if (a.wijzigingen === "opnieuw") return `<div class="note warn pendingbar"><div><b>Nieuwe server nodig</b><br><small>Je hebt het adres, de plek van de server of de adressendienst gewijzigd${others.length ? ` (en ${esc(others.map(label).join(", "))})` : ""}. Dat gaat in met Opnieuw opzetten.</small></div><a class="btn" href="#aanbieder/server">Bekijken</a></div>`;
  return "";
}

/** "#aanbieder" / "#aanbieder/<onderdeel>": nog niet opgezet → de stappen; daarna "Je dienst" met alle onderdelen. */
async function renderHub(hash, msg) {
  clearInterval(aanbiederTimer);
  const section = hash.split("/")[1] ?? "";
  let a;
  try { a = await api("/api/aanbieder"); } catch (err) { root.innerHTML = `<section class="center"><p class="msg err">${esc(err.message)}</p></section>`; return; }
  rememberDienst(a);
  const back = config?.alleenDienst ? "" : `<a class="link" href="#">${state.done ? "Naar je cloud" : "Terug naar je cloud opzetten"}</a>`;
  if (!a.hub || a.step !== "klaar") {
    const exists = a.server || a.removed;
    root.innerHTML = `<div class="hubwrap setup"><header class="hubhead"><div><h1>${exists ? "Je dienst wijzigen" : a.started ? "Je dienst opzetten" : "Aanbieder worden"}</h1>
        ${a.started ? "" : `<p class="lead">Je eigen Eigen Cloud Dienst, met je eigen naam en prijzen. Een eigen cloud is niet nodig.</p>`}</div>
        <div class="actions" style="margin:0">${exists ? `<button class="btn" id="hBack">Terug naar je dienst</button>` : ""}${back}</div></header>
      ${config?.alleenDienst ? keyReminder() : ""}<div id="aanbieder"></div>${config?.alleenDienst && !a.started ? cloudLater() : ""}</div>`;
    $("#hBack")?.addEventListener("click", () => aStep("klaar").catch(() => {}));
    return renderAanbieder(msg);
  }
  const cur = section === "nodig" || a.hub.some((x) => x.id === section && x.waar !== "dienst") ? section : "overzicht";
  // "Wat je nodig hebt" staat in de console zelf (niet in de onderdelen van de server): na het Overzicht.
  a.hub = [...a.hub.slice(0, 1), { id: "nodig", label: "Wat je nodig hebt", waar: "console", link: null, pending: false }, ...a.hub.slice(1)];
  const host = (a.url ?? "").replace(/^https:\/\//, "");
  root.innerHTML = `<div class="hubwrap">
    <header class="hubhead">
      <div><small class="muted">Je dienst</small><h1>${esc(a.company?.name ?? "Je dienst")}</h1><span class="muted">${esc(host)}${a.server ? "" : " · verwijderd"}</span></div>
      <div class="actions" style="margin:0">${a.server ? `<button class="btn primary" id="hOpen">Beheer openen</button>` : ""}${back}</div>
    </header>
    ${pendingBar(a)}
    <p class="msg ${msg?.ok ? "ok" : msg ? "err" : ""}" id="hmsg">${esc(msg?.text ?? "")}</p>
    <div class="hub">
      <nav class="hubnav" aria-label="Onderdelen van je dienst">${a.hub.map((x) => x.waar === "dienst"
        ? `<button type="button" class="hubitem" data-link="${esc(x.link ?? "")}" ${x.link ? "" : "disabled"}>${esc(x.label)}<span class="ext" aria-label="opent het beheer">↗</span></button>`
        : `<a class="hubitem${x.id === cur ? " now" : ""}" href="#aanbieder/${esc(x.id)}" ${x.id === cur ? 'aria-current="page"' : ""}>${esc(x.label)}${x.pending ? `<i class="dot" title="Nog niet toegepast"></i>` : ""}</a>`).join("")}</nav>
      <section class="hubpane" id="hubPane"></section>
    </div></div>`;
  $("#hOpen")?.addEventListener("click", () => openBeheer(a.beheerUrl));
  root.querySelectorAll(".hubnav [data-link]").forEach((b) => b.onclick = () => openBeheer(b.dataset.link));
  $("#hApply")?.addEventListener("click", async (e) => {
    try {
      const r = await busy(e.target, () => api("/api/aanbieder/toepassen", { method: "POST" }));
      renderHub(hash, { ok: true, text: r.restart ? "Toegepast. Je Dienst start nu opnieuw met de nieuwe instellingen (een halve minuut)." : "Toegepast. De nieuwe instellingen gaan in bij de volgende herstart van je Dienst." });
    } catch (err) { hubMsg(err.message); }
  });
  const pane = $("#hubPane");
  const fn = { overzicht: hubOverzicht, nodig: hubNodig, bedrijf: hubBedrijf, accounts: hubAccounts, adressendienst: hubAdressen, voorwaarden: hubVoorwaarden, lijst: hubLijst, server: hubServer, kosten: hubKosten, updates: hubUpdates }[cur] ?? hubOverzicht;
  fn(pane, a);
  // Op de telefoon: het gekozen onderdeel in beeld schuiven.
  root.querySelector(".hubitem.now")?.scrollIntoView?.({ block: "nearest", inline: "center" });
}

function hubMsg(text, ok = false) {
  const m = $("#hmsg");
  if (!m) return;
  m.textContent = text;
  m.className = "msg " + (ok ? "ok" : "err");
  m.scrollIntoView({ block: "nearest" });
}

const sectionHead = (a, id, extra = "") => {
  const x = a.hub.find((y) => y.id === id);
  return `<h2 class="hubtitle">${esc(x?.label ?? id)}${x?.pending ? ` <span class="chip">nog niet toegepast</span>` : ""}</h2><p class="muted hubsub">${esc(HUB_TEXT[id] ?? "")} · ${esc(WAAR[x?.waar] ?? "")}${extra}</p>`;
};

/** De status van de Dienst (bereikbaar, versie, back-up, DNS, adressendienst). */
function statusList(a, s) {
  const dot = !s ? "" : s.reachable ? (s.closing ? "verhuist" : "bereikbaar") : "niet bereikbaar";
  const dnsHint = (d) => d.error ? d.error : d.mode === "eigen" ? "De console zet dit record; DNS-wijzigingen kunnen tot een uur duren." : d.mode === "cloud" ? "Je cloud zet dit record zelf; DNS-wijzigingen kunnen tot een uur duren." : `Zet bij je DNS een A-record: ${d.host} → ${d.want ?? ""}`;
  return `<ul class="results">
    <li class="${s?.reachable ? "" : "meh"}">${esc((a.url ?? "").replace(/^https:\/\//, ""))} ${esc(dot)}${s?.version ? `<small>Versie ${esc(s.version)}${s.uptime != null ? ` · draait ${s.uptime < 3600 ? Math.max(1, Math.round(s.uptime / 60)) + " minuten" : Math.round(s.uptime / 3600) + " uur"}` : ""}</small>` : s?.error ? `<small>${esc(s.error === "Nog niet bereikbaar" ? "Even geduld, of kijk of de server draait" : s.error)}${a.server?.createdAt && Date.now() - a.server.createdAt < 15 * 60_000 ? " — de server start nog op" : ""}</small>` : ""}</li>
    <li class="${s?.lastBackupAt ? (s.backup === "fout" ? "bad" : "") : "meh"}">Back-up${s?.lastBackupAt ? `: ${time(s.lastBackupAt)}` : ": nog geen"}${s?.backup === "fout" ? "<small>De laatste poging mislukte</small>" : ""}</li>
    ${s?.dns ? `<li class="${s.dns.ok && !s.dns.error ? "" : s.dns.error ? "bad" : "meh"}">${esc(s.dns.host)} wijst ${s.dns.ok ? "naar je server" : s.dns.have?.length ? `naar ${esc(s.dns.have.join(", "))}` : "nog nergens heen"}${s.dns.ok && !s.dns.error ? "" : `<small>${esc(dnsHint(s.dns))}</small>`}</li>` : ""}
    ${s?.adressen ? `<li class="${s.adressen.ok ? "" : "meh"}">Gratis-adressendienst ${esc(s.adressen.url.replace(/^https:\/\//, ""))} ${s.adressen.reachable ? (s.adressen.ok ? "werkt" : `geeft zone ${esc(s.adressen.zone ?? "")}`) : "niet bereikbaar"}${s.adressen.error ? `<small>${esc(s.adressen.error)}</small>` : ""}</li>` : ""}
  </ul>`;
}

/** Kerncijfers uit de Dienst (GET /v1/status/overzicht via de console). */
function cards(o) {
  if (!o) return `<p class="muted wide" style="margin:0"><small>Kerncijfers verschijnen zodra je Dienst bereikbaar is.</small></p>`;
  const card = (label, big, sub = "") => `<div class="card"><span class="muted">${esc(label)}</span><b>${esc(big)}</b>${sub ? `<small class="muted">${esc(sub)}</small>` : ""}</div>`;
  return card("Klanten", String(o.actief ?? 0), `${o.klanten ?? 0} account${o.klanten === 1 ? "" : "s"}`)
    + card("Omzet deze maand", eur(Number(o.omzetMaand?.net ?? 0)), `${o.omzetMaand?.count ?? 0} betaling${o.omzetMaand?.count === 1 ? "" : "en"}, incl. btw`)
    + card("Open hulpvragen", String(o.openHulpvragen ?? 0))
    + card("Achterstanden", String(o.achterstanden ?? 0));
}

const tile = (x) => x.waar === "dienst"
  ? `<button type="button" class="tile" data-link="${esc(x.link ?? "")}" ${x.link ? "" : "disabled"}><b>${esc(x.label)} <span class="ext">↗</span></b><small>${esc(HUB_TEXT[x.id] ?? "")}</small></button>`
  : `<a class="tile" href="#aanbieder/${esc(x.id)}"><b>${esc(x.label)}${x.pending ? `<i class="dot" title="Nog niet toegepast"></i>` : ""}</b><small>${esc(HUB_TEXT[x.id] ?? "")}</small></a>`;

function hubOverzicht(pane, a) {
  pane.innerHTML = `${sectionHead(a, "overzicht")}
    ${keyReminder()}
    <div id="aStatus">${a.lastHealth ? statusList(a, a.lastHealth) : `<p class="muted" style="margin:0">Status ophalen…</p>`}</div>
    <div class="cards" id="hCards">${cards(null)}</div>
    <h2 class="hubtitle small">Alles voor je dienst</h2>
    <p class="muted hubsub">Met ↗ open je het beheer van je Dienst op die pagina${NATIVE ? " (met je vingerafdruk)" : ""}.</p>
    <div class="tiles">${a.hub.filter((x) => x.id !== "overzicht").map(tile).join("")}</div>
    ${config?.alleenDienst ? cloudLater() : ""}`;
  pane.querySelectorAll(".tiles [data-link]").forEach((b) => b.onclick = () => openBeheer(b.dataset.link));
  if (!a.server) { $("#aStatus").innerHTML = `<p style="margin:0">Je Dienst is verwijderd. De back-ups staan nog in <b>${esc(a.backup?.bucket ?? "je opslag")}</b>; met <a href="#aanbieder/server">Opnieuw opzetten</a> komt alles terug op een nieuwe server.</p>`; return; }
  const refresh = async () => {
    try {
      const s = await api("/api/aanbieder/status");
      if (!$("#aStatus")) return;
      $("#aStatus").innerHTML = statusList(a, s);
      $("#hCards").innerHTML = cards(s.overzicht);
    } catch { /* volgende keer */ }
  };
  refresh();
  aanbiederTimer = setInterval(refresh, 30_000);
}

/** Opslaan en "Je dienst" opnieuw tonen (met wat er nu nog toegepast moet worden). */
const savedMsg = (a) => ({ ok: true, text: a.server ? "Opgeslagen. Pas het toe met Wijzigingen toepassen (bovenaan)." : "Opgeslagen." });

function hubBedrijf(pane, a) {
  const co = a.company ?? {};
  pane.innerHTML = `${sectionHead(a, "bedrijf")}
    <form class="fields" id="hf"><p class="muted" style="margin:0">Deze gegevens komen op de facturen aan je klanten. De eigenaar krijgt de inlogcode voor het beheer.</p>
      <label>Bedrijfsnaam<input name="name" required value="${esc(co.name ?? "")}"><small>Ook de naam van je Dienst in de app en in mails.</small></label>
      <label>Adres<textarea name="address" rows="2" placeholder="Blaak 10&#10;3011 TA Rotterdam">${esc((co.address ?? []).join("\n"))}</textarea></label>
      <div class="row"><label>KvK-nummer<input name="kvk" inputmode="numeric" value="${esc(co.kvk ?? "")}"></label><label>Btw-nummer<input name="vat" placeholder="NL001234567B01" value="${esc(co.vat ?? "")}"></label></div>
      <label>E-mailadres van de eigenaar<input type="email" name="email" required value="${esc(co.email ?? "")}"><small>Krijgt meldingen en logt in op het beheer.</small></label>
      <div class="row"><label>Btw-percentage op je facturen<input name="vatPercent" inputmode="decimal" value="${esc(co.vatPercent ?? "21")}"><small>Je prijzen zijn inclusief deze btw.</small></label></div>
      <label class="check"><input type="checkbox" name="enforce" ${co.enforce ? "checked" : ""}> Extra servers van klanten echt uitzetten</label>
      <p class="msg"></p><div><button class="btn primary">Opslaan</button></div></form>`;
  $("#hf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await busy($("button.primary", f), () => api("/api/aanbieder/bedrijf", { method: "POST", body: { name: f.elements.name.value, address: f.address.value, kvk: f.kvk.value, vat: f.vat.value, email: f.email.value, vatPercent: f.vatPercent.value, enforce: f.enforce.checked } }));
      renderHub("aanbieder/bedrijf", savedMsg(a));
    } catch (err) { formMsg(f, err.message); }
  };
}

function hubAccounts(pane, a) {
  const ac = a.accounts ?? {};
  const field = (name, label, value, extra = "") => `<label>${label}<input name="${name}" value="${esc(value ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" ${extra}></label>`;
  pane.innerHTML = `${sectionHead(a, "accounts")}
    <form class="fields" id="hf"><p class="muted" style="margin:0">Sleutels staan versleuteld in je kluis; je ziet alleen de laatste vier tekens. Leeg laten of zo laten = niet wijzigen. Elke sleutel wordt meteen gecontroleerd.</p>
      <h3 style="margin:0">Mollie <small class="muted">${ac.mollieMode === "live" ? "· live: echte betalingen" : ac.mollieMode === "test" ? "· testsleutel" : ""}</small></h3><small class="muted">${A_HELP.mollie}</small>
      ${field("mollieKey", "API-sleutel", ac.mollieKey, 'placeholder="test_… of live_…"')}
      ${regelKnop("mollie", "Nagaan wat er bij Mollie nog aan moet")}
      <h3 style="margin:0">deSEC</h3><small class="muted">${A_HELP.desec}</small>
      ${ac.desecToken ? "" : regelKnop("desec", "Nog geen deSEC-account? Laat de app er een maken")}
      ${field("desecToken", "Token", ac.desecToken)}
      <h3 style="margin:0">Scaleway</h3><small class="muted">${A_HELP.scaleway}</small>
      ${regelKnop("scaleway", ac.scalewaySecretKey ? "Opnieuw regelen met één sleutel" : "Regel het met één sleutel")}
      <details ${ac.scalewaySecretKey ? "open" : ""}><summary>Of vul de sleutel van de Dienst zelf in</summary><div class="fields" style="margin-top:10px"><small class="muted">${A_HELP.scalewayHand}</small>
      <div class="row">${field("scalewaySecretKey", "Geheime sleutel", ac.scalewaySecretKey)}${field("scalewayOrgId", "Organisatie-ID", ac.scalewayOrgId)}</div></div></details>
      <h3 style="margin:0">Mail versturen</h3><small class="muted">${config?.mailRelay ? A_HELP.smtp : A_HELP.smtpZelf}</small>
      ${regelKnop("mail", "Regel de mail via Scaleway")}
      <div class="row">${field("smtpUrl", "Mailserver", "", `placeholder="${ac.smtp ? `Nu ${esc(ac.smtp)}; leeg = zo laten` : "smtp://gebruiker:wachtwoord@server:587"}"`)}${field("mailFrom", "Afzender", ac.mailFrom, 'type="email"')}</div>
      <h3 style="margin:0">Openprovider <small class="muted">· optioneel</small></h3><small class="muted">${A_HELP.openprovider}</small>
      <div class="row">${field("openproviderUser", "Gebruiker", ac.openproviderUser)}${field("openproviderPass", "Wachtwoord", ac.openproviderPass, 'type="password"')}</div>
      <h3 style="margin:0">Gratis adressen <small class="muted">· optioneel</small></h3><small class="muted">${A_HELP.adres}</small>
      ${field("adresUrl", "Adressendienst", ac.adresUrl, 'placeholder="https://adressen.eigencloud.nl"')}
      <ul class="results" id="hChecks">${lastChecks ? resultItems(lastChecks) : ""}</ul>
      <p class="msg"></p><div><button class="btn primary">Opslaan en controleren</button></div></form>`;
  lastChecks = null;
  wireRegel($("#hf"), a, (flash) => renderHub("aanbieder/accounts", flash ? { ok: true, text: "Geregeld." } : null));
  $("#hf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(["scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "mailFrom", "openproviderUser", "openproviderPass", "adresUrl"].map((n) => [n, f[n].value]));
    if (f.smtpUrl.value.trim()) body.smtpUrl = f.smtpUrl.value;
    try {
      const r = await busy($("button.primary", f), () => api("/api/aanbieder/accounts", { method: "POST", body }));
      lastChecks = r.checks;
      renderHub("aanbieder/accounts", r.ok ? savedMsg(a) : { ok: false, text: "Opgeslagen, maar niet alles werkt. Pas aan wat rood is; zolang kan je Dienst de wijziging niet krijgen." });
    } catch (err) { formMsg(f, err.message); }
  };
}

function hubAdressen(pane, a) {
  const x = a.hub.find((y) => y.id === "adressendienst");
  pane.innerHTML = `${sectionHead(a, "adressendienst")}
    <p style="margin:0"><small class="muted">${A_HELP.adressen}</small></p>
    ${a.adressen ? `<p style="margin:0">Draait op <b>${esc(a.adressen.host)}</b> met de gedeelde zone <b>${esc(a.adressen.zone)}</b>.</p>` : `<p style="margin:0">Draait nu niet op de server van je Dienst.</p>`}
    ${x?.link ? `<div><button class="btn" id="hAdrOpen">Uitgegeven adressen bekijken ↗</button></div>` : ""}
    <form class="fields panel" id="hf">
      <label class="check"><input type="checkbox" name="adrAan" ${a.adressen ? "checked" : ""}> De gratis-adressendienst draait op de server van mijn Dienst</label>
      <div class="row"><label>Gedeelde zone<input name="adrZone" value="${esc(a.adressen?.zone ?? "")}" placeholder="eigencloud.nl" autocapitalize="off" spellcheck="false"></label>
        <label>deSEC-token voor die zone<input name="adrToken" value="${esc(a.adressen?.desecToken ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false"></label></div>
      <label>Adres van de adressendienst<input name="adrHost" value="${esc(a.adressen?.host ?? a.defaultAdressenHost ?? "")}" autocapitalize="off" spellcheck="false"></label>
      <p class="note warn" style="margin:0">Aan- of uitzetten, of een ander adres, gaat in na <b>Opnieuw opzetten</b> (Server en back-ups).</p>
      <ul class="results" id="adrChecks"></ul>
      <p class="msg"></p><div><button class="btn primary">Opslaan</button></div></form>`;
  $("#hAdrOpen")?.addEventListener("click", () => openBeheer(x.link));
  zoneLimit(pane, a);
  $("#hf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await busy($("button.primary", f), () => f.adrAan.checked
        ? api("/api/aanbieder/adressen", { method: "POST", body: { zone: f.adrZone.value, desecToken: f.adrToken.value, host: f.adrHost.value } })
        : api("/api/aanbieder/adressen", { method: "POST", body: { aan: false } }));
      if (!r.ok) { $("#adrChecks").innerHTML = resultItems(r.checks); return formMsg(f, "Zo kan het nog niet: pas aan wat rood is."); }
      renderHub("aanbieder/adressendienst", { ok: true, text: "Opgeslagen. Het gaat in na Opnieuw opzetten." });
    } catch (err) { formMsg(f, err.message); }
  };
}

/** De DNS-aanbieders, met wat de console al weet (bewaarde velden, sleutels bij Accounts of van je cloud). */
/** "deSEC" in plaats van "deSEC (gratis, open source, Berlijn)". */
const dnsLabel = (id) => (state.offers.dns ?? []).find((o) => o.id === id)?.name.replace(/ \(.*\)$/, "") ?? id;
/** dienst.jouwbedrijf.nl → jouwbedrijf.nl (zoals defaultZone in aanbieder.ts). */
const zoneOf = (v) => {
  const h = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return null;
  const p = h.split(".");
  return p.length > 2 ? p.slice(1).join(".") : h;
};

/** `urlInput`: het adresveld in dezelfde stap; het domein volgt dat zolang je het niet zelf wijzigt. */
function dnsChooser(box, a, urlInput = null) {
  const offers = (state.offers.dns ?? []);
  const link = a.dnsLink;
  const initial = a.dnsKeuze ?? (a.cloudDns ? "cloud" : offers.some((o) => o.id === "desec") ? "desec" : "handmatig");
  const known = (o, key) => (link?.provider === o.id && link.fields.includes(key)) || !!config?.providers?.[o.id]?.[key]
    || (o.id === "desec" && key === "token" && !!a.accounts?.desecToken) || (o.id === "scaleway" && key === "secretKey" && !!a.accounts?.scalewaySecretKey);
  const hint = (o, key) => (link?.provider === o.id && link.fields.includes(key) ? "Bewaard; leeg laten = zo laten"
    : o.id === "desec" && key === "token" && a.accounts?.desecToken ? "Leeg laten: het deSEC-token van Accounts"
    : o.id === "scaleway" && key === "secretKey" && a.accounts?.scalewaySecretKey ? "Leeg laten: de Scaleway-sleutel van Accounts"
    : config?.providers?.[o.id]?.[key] ? "Leeg laten: de sleutel van je cloud" : "");
  box.innerHTML = `<h3 style="margin:0">Wie zet het adres in de DNS?</h3><small class="muted">${A_HELP.dns}</small>
    <label>DNS<select name="dnsProv">
      ${a.cloudDns ? `<option value="cloud">Mijn eigen cloud (${esc(config?.domain ?? "")})</option>` : ""}
      ${offers.map((o) => `<option value="${esc(o.id)}">${esc(dnsLabel(o.id))}</option>`).join("")}
      <option value="handmatig">Ik zet het record zelf</option></select></label>
    <div class="fields" data-dnsf></div>`;
  const sel = $("select", box);
  sel.value = [...sel.options].some((o) => o.value === initial) ? initial : "handmatig";
  const draw = () => {
    const o = offers.find((x) => x.id === sel.value);
    $("[data-dnsf]", box).innerHTML = sel.value === "cloud" ? `<small class="muted">Je cloud zet het record zodra de server er is. Het adres moet dan onder ${esc(config?.domain ?? "het domein van je cloud")} vallen.</small>`
      : sel.value === "handmatig" ? `<small class="muted">Na het opzetten zie je welk A-record je bij je DNS-aanbieder moet zetten. Krijgt de server een ander IP-adres, dan pas je het zelf aan.</small>`
      : `${o.keyHelp ? `<small class="muted">${esc(o.keyHelp)}</small>` : ""}
        <label>Domein bij ${esc(dnsLabel(o.id))}<input name="dnsZone" value="${esc(link?.provider === o.id ? link.zone : a.defaultZone ?? zoneOf(urlInput?.value) ?? "")}" placeholder="jouwbedrijf.nl" autocapitalize="off" spellcheck="false"><small>Het domein waar het adres van je Dienst onder valt.</small></label>
        ${fieldInputs(o.fields, { optional: o.fields.every((fl) => fl.optional || known(o, fl.key)), placeholder: (k) => hint(o, k) })}`;
  };
  sel.onchange = draw;
  draw();
  urlInput?.addEventListener("input", () => {
    const z = $("[name=dnsZone]", box);
    if (z && !z.dataset.touched && !(link?.provider === sel.value)) z.value = zoneOf(urlInput.value) ?? "";
  });
  box.addEventListener("input", (e) => { if (e.target.name === "dnsZone") e.target.dataset.touched = "1"; });
  return {
    /** Bewaren als er iets te bewaren is; geeft het antwoord van POST /api/aanbieder/dns (of null). */
    async save() {
      const p = sel.value;
      const inputs = $$("[data-dnsf] input", box).filter((i) => i.name !== "dnsZone");
      const fields = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      const zone = $("[name=dnsZone]", box)?.value.trim() ?? "";
      const typed = inputs.some((i) => i.value.trim());
      if (p === initial && (p === "cloud" || p === "handmatig" || (link?.provider === p && !typed && zone === link.zone))) return null;
      return api("/api/aanbieder/dns", { method: "POST", body: { provider: p, zone, fields } });
    },
  };
}

function hubServer(pane, a) {
  const h = a.hosting ?? {}, bk = a.backup ?? {}, d = a.dns ?? {}, l = a.dnsLink;
  const ht = a.hersteltest;
  const records = (l?.records ?? []).filter((r) => r.value);
  pane.innerHTML = `${sectionHead(a, "server")}
    <div class="panel" style="margin-top:0">
      <div><b>Server</b><br><span class="muted">${a.server ? `${esc(a.server.ipv4 ?? "")} bij ${esc(placeName(a.server))} (${esc(a.server.size)})${h.monthly != null ? `, ${esc(eur(h.monthly))} per maand` : ""}` : "Geen server: je Dienst is verwijderd."}</span>
        ${a.server && (h.provider !== a.server.provider || h.region !== a.server.region) ? `<br><small>Gekozen voor de volgende keer: ${esc(h.name)} in ${esc(h.city)}</small>` : ""}</div>
      <div class="actions" style="margin:0"><button class="btn" id="hMove">Andere aanbieder of regio</button><button class="btn" id="hAddr">Ander adres</button></div>
    </div>
    <div class="panel">
      <div><b>Adres en DNS</b><br><span class="muted">${esc((a.url ?? "").replace(/^https:\/\//, ""))} · ${d.mode === "eigen" ? `de console zet het record bij ${esc(dnsLabel(d.provider))} (${esc(d.zone)})` : d.mode === "cloud" ? "je cloud zet het record" : "je zet het record zelf"}</span></div>
      ${l?.error ? `<p class="msg err" style="margin:0">${esc(l.error)}</p>` : ""}
      ${records.length ? `<ul class="results">${records.map((r) => `<li>${esc(r.sub ? `${r.sub}.${l.zone}` : l.zone)} ${esc(r.type)} → ${esc(r.value)}</li>`).join("")}</ul>` : ""}
      ${l?.nameservers?.length ? `<small class="muted">Staat ${esc(l.zone)} nog niet bij deze DNS-aanbieder? Zet bij de partij waar je het domein hebt de nameservers op: ${esc(l.nameservers.join(", "))}.</small>` : ""}
      <form class="fields" id="hDns"><div id="hDnsBox" class="fields"></div><p class="msg"></p><div><button class="btn">DNS bewaren</button></div></form>
    </div>
    <div class="panel">
      <div><b>Back-ups</b><br><span class="muted">${bk.bucket ? `Elk uur, versleuteld, 30 dagen niet te wissen: ${esc(bk.bucket)} bij ${esc(bk.name)} (${esc(bk.regionLabel)})` : "Nog geen back-ups"}</span></div>
      ${ht ? `<p class="${ht.ok ? "" : "note warn"}" style="margin:0"><small>Hersteltest ${esc(time(ht.at))}: ${ht.ok ? "gelukt" : "mislukt"}${ht.backupAt ? `, back-up van ${esc(time(ht.backupAt))}` : ""}. ${esc(ht.detail)}</small></p>` : ""}
      <div class="actions" style="margin:0"><button class="btn" id="hTest" ${bk.bucket ? "" : "disabled"}>Hersteltest</button></div>
      <small class="muted">De hersteltest haalt de nieuwste back-up op, ontsleutelt hem en controleert de database. Er verandert niets aan je Dienst.</small>
      ${a.alleenDienst && bk.bucket ? `<small class="muted">Je kluis staat ook versleuteld in deze opslag (met je herstelsleutel). Op een nieuw toestel: <i>Ik heb al een Eigen Cloud</i>, je herstelsleutel en de sleutels van deze opslag.</small>` : ""}
    </div>
    <div class="panel">
      <div><b>Opnieuw opzetten of verwijderen</b><br><small class="muted">Opnieuw opzetten: de huidige server maakt een laatste back-up, een nieuwe server zet die terug en het adres gaat naar de nieuwe. Een paar minuten is je Dienst niet bereikbaar.</small></div>
      <div class="actions" style="margin:0"><button class="btn${a.wijzigingen === "opnieuw" || !a.server ? " primary" : ""}" id="hAgain">Opnieuw opzetten</button>${a.server ? `<button class="btn danger" id="hDel">Dienst verwijderen</button>` : ""}</div>
      <div id="hExtra"></div>
    </div>`;
  $("#hMove").onclick = () => aStep("server").catch((e) => hubMsg(e.message));
  $("#hAddr").onclick = () => aStep("adres").catch((e) => hubMsg(e.message));
  const dnsUi = dnsChooser($("#hDnsBox"), a);
  $("#hDns").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await busy($("#hDns button"), () => dnsUi.save());
      if (!r) return formMsg(e.target, "Niets gewijzigd.", true);
      renderHub("aanbieder/server", r.detail ? { ok: false, text: r.detail } : { ok: true, text: r.synced ? "Bewaard; de records staan erin." : "Bewaard." });
    } catch (err) { formMsg(e.target, err.message); }
  };
  $("#hTest").onclick = async (e) => {
    try { const r = await busy(e.target, () => api("/api/aanbieder/hersteltest", { method: "POST" })); renderHub("aanbieder/server", { ok: r.ok, text: r.ok ? "Hersteltest gelukt." : `Hersteltest mislukt: ${r.detail}` }); }
    catch (err) { hubMsg(err.message); }
  };
  $("#hAgain").onclick = async (e) => {
    if (!confirm(a.server ? "Je Dienst opnieuw opzetten op een nieuwe server?\n\nDe huidige server maakt eerst een laatste back-up; de nieuwe zet die terug. Een paar minuten is de Dienst niet bereikbaar." : "Je Dienst opnieuw opzetten?\n\nEr komt een nieuwe server die de laatste back-up terugzet.")) return;
    try {
      const r = await busy(e.target, () => api("/api/aanbieder/opzetten", { method: "POST" }));
      $("#hExtra").innerHTML = `<ul class="results">${resultItems(r.steps)}</ul>`;
      hubMsg("De nieuwe server start op; over een paar minuten is je Dienst weer bereikbaar.", true);
    } catch (err) { if (err.data?.steps) $("#hExtra").innerHTML = `<ul class="results">${resultItems(err.data.steps)}</ul>`; hubMsg(err.message); }
  };
  $("#hDel")?.addEventListener("click", () => {
    const host = (a.url ?? "").replace(/^https:\/\//, "");
    $("#hExtra").innerHTML = `<form class="fields" id="adf"><p class="note warn" style="margin:0">De server van je Dienst gaat weg. Je klanten kunnen dan niet meer inloggen, bestellen of betalen; hun clouds blijven wel draaien. Er komt eerst nog een laatste back-up; de back-ups blijven bewaard, zodat je de Dienst later terug kunt zetten.${d.mode === "eigen" ? " De console haalt ook de DNS-records weg." : ""}</p>
      <label>Typ <b>${esc(host)}</b> om te bevestigen<input name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div><button class="btn danger">Definitief verwijderen</button></div></form>`;
    $("#adf").onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const r = await busy($("#adf button"), () => api("/api/aanbieder/verwijderen", { method: "POST", body: { confirm: ev.target.confirm.value } }));
        renderHub("aanbieder/server", { ok: true, text: `Verwijderd.${r.finalBackup ? "" : " De laatste back-up lukte niet; de vorige blijft bewaard."}` });
      } catch (err) { formMsg(ev.target, err.message); }
    };
  });
}

function hubKosten(pane, a) {
  const h = a.hosting ?? {}, x = a.hub.find((y) => y.id === "kosten");
  pane.innerHTML = `${sectionHead(a, "kosten")}
    <ul class="items">
      <li><span class="flag">${FLAGS[h.country] ?? "🖥️"}</span><b>Server van je Dienst</b><span class="sub">${esc(h.name ?? "")} ${esc(h.city ?? "")} (${esc(h.size ?? "")}), excl. btw</span><span class="end">${eur(h.monthly)}</span></li>
      <li><span class="flag">🗄️</span><b>Back-ups</b><span class="sub">${esc(a.backup?.name ?? "")}: een paar MB per uur, meestal minder dan een euro per maand</span><span class="end"></span></li>
    </ul>
    <p style="margin:0">Wat de clouds van je klanten bij Scaleway kosten, naast wat ze jou betalen (marge per bundel), staat in het beheer.</p>
    ${x?.link ? `<div><button class="btn" id="hK">Kosten in het beheer ↗</button></div>` : ""}`;
  $("#hK")?.addEventListener("click", () => openBeheer(x.link));
}

function hubUpdates(pane, a) {
  pane.innerHTML = `${sectionHead(a, "updates")}
    <div id="hUpd"><p class="muted" style="margin:0">Versie ophalen…</p></div>
    <p style="margin:0">Je Dienst werkt zichzelf elke nacht bij naar de nieuwste versie van Eigen Cloud. Gaat er iets mis, dan zet hij de vorige versie terug en probeert hij die versie niet opnieuw.</p>
    <p class="muted" style="margin:0"><small>Wil je meteen de nieuwste versie, of draait er een versie die niet bijwerkt? Kies dan bij Server en back-ups <b>Opnieuw opzetten</b>: de nieuwe server start met de nieuwste versie en zet je gegevens terug.</small></p>`;
  const show = (s) => { if ($("#hUpd")) $("#hUpd").innerHTML = s?.version ? `<p style="margin:0">Je Dienst draait versie <b>${esc(s.version)}</b>${s.uptime != null ? `, sinds ${s.uptime < 3600 ? Math.max(1, Math.round(s.uptime / 60)) + " minuten" : Math.round(s.uptime / 3600) + " uur"}` : ""}.</p>` : `<p class="muted" style="margin:0">${a.server ? "Je Dienst is nu niet bereikbaar." : "Er draait geen server."}</p>`; };
  if (a.lastHealth) show(a.lastHealth);
  if (a.server) api("/api/aanbieder/status").then(show).catch(() => {});
}

// ── Voorwaarden en privacy, Op de lijst (GitHub) en de zonelimiet bij deSEC ──

const dateLong = (ms) => new Date(ms).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });

/** Wat de Dienst host (voorwaarden, privacy, verwerkersovereenkomst) en welke links de app laat zien; maken in het beheer. */
async function hubVoorwaarden(pane, a) {
  const x = a.hub.find((y) => y.id === "voorwaarden");
  pane.innerHTML = `${sectionHead(a, "voorwaarden")}
    <p style="margin:0">Je Dienst zet je algemene voorwaarden, privacyverklaring en verwerkersovereenkomst op een eigen pagina. In het beheer maak je met één tik een voorbeeld uit je bedrijfsgegevens, je prijzen en de partijen waar alles staat. Lees het na en publiceer het; de app en het bestellen linken er dan vanzelf naartoe.</p>
    <p class="note warn" style="margin:0"><small>Een voorbeeld is geen juridisch advies. Laat het nakijken.</small></p>
    <div class="panel"><div id="hJur"><p class="muted" style="margin:0">Ophalen…</p></div>
      ${x?.link ? `<div><button class="btn primary" id="hJurOpen">Maken of wijzigen in het beheer ↗</button></div>` : ""}</div>`;
  $("#hJurOpen")?.addEventListener("click", () => openBeheer(x.link));
  let j;
  try { j = await api("/api/aanbieder/juridisch"); } catch (err) { if ($("#hJur")) $("#hJur").innerHTML = `<p class="msg err" style="margin:0">${esc(err.message)}</p>`; return; }
  if (!$("#hJur")) return;
  const link = (u) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https:\/\//, ""))}</a>` : "nog geen link");
  $("#hJur").innerHTML = `<ul class="results">
    ${j.documenten.map((d) => `<li class="${d.versie ? "" : "meh"}">${esc(d.titel)}${d.versie ? `: versie ${d.versie}, ${esc(dateLong(d.gewijzigd))}<small><a href="${esc(d.url)}" target="_blank" rel="noopener">Bekijken</a></small>` : `: nog niet gepubliceerd`}</li>`).join("")}
    </ul>
    ${j.fout ? `<p class="msg err" style="margin:0">${esc(j.fout)}</p>` : `<p class="muted" style="margin:0"><small>In de app en bij het bestellen: voorwaarden ${link(j.termsUrl)}, privacyverklaring ${link(j.privacyUrl)}. Een eigen link (beheer → Huisstijl) gaat voor.</small></p>`}`;
}

const PR_STATUS = { open: "open", samengevoegd: "samengevoegd", gesloten: "gesloten" };

/** Op de lijst van aanbieders: GitHub koppelen, je regel, aanmelden met een voorstel (pull request) en de status. */
async function hubLijst(pane, a) {
  const x = a.hub.find((y) => y.id === "lijst");
  pane.innerHTML = `${sectionHead(a, "lijst")}<div id="hLijst" class="fields"><p class="muted" style="margin:0">Ophalen…</p></div>`;
  let v;
  try { v = await api("/api/aanbieder/lijst"); } catch (err) { if ($("#hLijst")) $("#hLijst").innerHTML = `<p class="msg err" style="margin:0">${esc(err.message)}</p>`; return; }
  const box = $("#hLijst");
  if (!box) return;
  const g = v.github, pr = v.voorstel, r = v.regel;
  const st = v.opLijst && v.sleutelKlopt && v.actueel ? ["", "Je staat op de lijst. Nieuwe klanten kunnen je in de app kiezen."]
    : v.opLijst ? ["meh", v.sleutelKlopt ? "Je staat op de lijst, maar je regel is niet meer actueel." : "Je staat op de lijst, maar zonder de sleutel van je Dienst: gratis adressen werken dan niet."]
    : ["meh", "Je staat nog niet op de lijst."];
  const prNote = !pr ? "" : pr.status === "open" ? "De beheerders van het project kijken ernaar."
    : pr.status === "samengevoegd" ? (v.opLijst ? `Samengevoegd op ${dateLong(pr.samengevoegdOp)}.` : "Samengevoegd. GitHub heeft een paar minuten nodig om de openbare lijst bij te werken.")
    : "Gesloten zonder samenvoegen. Kijk op GitHub waarom; pas je regel aan en meld je opnieuw aan.";
  const knop = pr?.status === "open" ? "Voorstel bijwerken" : v.opLijst ? "Regel bijwerken" : "Aanmelden voor de lijst";
  box.innerHTML = `<ul class="results">
      <li class="${st[0]}">${esc(st[1])}</li>
      ${pr ? `<li class="${pr.status === "gesloten" ? "bad" : pr.status === "open" ? "busy" : ""}">Voorstel #${pr.nummer}: ${esc(PR_STATUS[pr.status] ?? pr.status)}<small>${esc(prNote)} <a href="${esc(pr.url)}" target="_blank" rel="noopener">Bekijken op GitHub</a></small></li>` : ""}
      ${v.voorwaarden && (!v.voorwaarden.termsUrl || !v.voorwaarden.privacyUrl) ? `<li class="meh">Nog geen voorwaarden of privacyverklaring<small>De beheerders van de lijst kijken daarnaar. <a href="#aanbieder/voorwaarden">Voorwaarden en privacy</a></small></li>` : ""}
      ${v.lijstFout ? `<li class="unknown">${esc(v.lijstFout)}</li>` : ""}
    </ul>
    <div class="panel">
      <div><b>1. GitHub koppelen</b><br><small class="muted">De lijst staat in het open-sourceproject op GitHub (${esc(v.repo)}). De app maakt het voorstel voor je; je hebt alleen een gratis GitHub-account nodig.</small></div>
      ${g.gekoppeld ? `<p style="margin:0">Gekoppeld als <b>@${esc(g.login ?? "")}</b>${g.beheerder ? ` <span class="chip">beheerder van het project</span>` : ""} · <button type="button" class="link" id="ghOff">Ontkoppelen</button></p>`
        : `<ol class="steps-mini"><li><a href="${esc(v.tokenUrl)}" target="_blank" rel="noopener">Maak een token op GitHub</a>. Het vinkje bij <b>public_repo</b> staat al aan; kies een vervaldatum en tik onderaan op <i>Generate token</i>.</li><li>Kopieer het token en plak het hier. Het staat daarna alleen in je kluis.</li></ol>
        <form class="fields" id="ghF"><label>Token<input name="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_…"></label><p class="msg"></p><div><button class="btn primary">Koppelen</button></div></form>`}
    </div>
    <div class="panel">
      <div><b>2. Je regel op de lijst</b><br><small class="muted">Naam en contact komen uit je huisstijl (beheer), de sleutel uit je Dienst.</small></div>
      ${r ? `<form class="fields" id="lF"><div class="row"><label style="flex:0 0 90px">Land<input name="land" maxlength="2" value="${esc(r.land ?? "NL")}" autocapitalize="characters"></label>
          <label>Omschrijving<input name="omschrijving" maxlength="140" value="${esc(r.omschrijving ?? "")}" placeholder="Eén zin, in gewone taal"></label></div>
        <pre class="regel" id="lPre">${esc(JSON.stringify(r, null, 2))}</pre>
        <p class="msg"></p>
        <div class="actions" style="margin:0"><button class="btn primary" ${g.gekoppeld ? "" : "disabled"}>${knop}</button>${pr?.status === "open" && g.beheerder ? `<button type="button" class="btn" id="lMerge">Zelf samenvoegen</button>` : ""}</div>
        ${g.gekoppeld ? "" : `<small class="muted">Koppel eerst GitHub (stap 1).</small>`}</form>`
      : `<p class="msg err" style="margin:0">${esc(v.dienstFout ?? "")}</p>`}
    </div>
    <p class="muted" style="margin:0"><small>Liever met de hand? ${x?.link ? `<button type="button" class="link" id="lHand">Op de lijst in het beheer ↗</button> geeft de hele lijst om te plakken in` : "Plak je regel in"} <a href="${esc(v.editUrl)}" target="_blank" rel="noopener">aanbieders.json op GitHub</a>.</small></p>`;
  $("#lHand")?.addEventListener("click", () => openBeheer(x.link));
  const again = (msg) => renderHub("aanbieder/lijst", msg);
  const gf = $("#ghF");
  if (gf) gf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const k = await busy($("button", gf), () => api("/api/github/koppelen", { method: "POST", body: { token: gf.token.value } }));
      again({ ok: true, text: `GitHub gekoppeld als @${k.login}.` });
    } catch (err) { formMsg(gf, err.message); }
  };
  $("#ghOff")?.addEventListener("click", async () => {
    if (!confirm("GitHub ontkoppelen?\n\nHet token gaat uit je kluis. Je voorstel en je regel blijven bestaan. Trek het token ook in op GitHub (Settings → Developer settings → Tokens).")) return;
    try { await api("/api/github/ontkoppelen", { method: "POST" }); again({ ok: true, text: "GitHub ontkoppeld." }); } catch (err) { hubMsg(err.message); }
  });
  const lf = $("#lF");
  if (lf) {
    lf.oninput = () => { $("#lPre").textContent = JSON.stringify({ ...r, land: lf.land.value.trim().toUpperCase(), omschrijving: lf.omschrijving.value.replace(/\s+/g, " ").trim() }, null, 2); };
    lf.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const k = await busy($("button.primary", lf), () => api("/api/aanbieder/lijst/aanmelden", { method: "POST", body: { land: lf.land.value, omschrijving: lf.omschrijving.value } }));
        again({ ok: true, text: k.bericht });
      } catch (err) { formMsg(lf, err.message); }
    };
  }
  $("#lMerge")?.addEventListener("click", async (e) => {
    if (!confirm(`Voorstel #${pr.nummer} zelf samenvoegen?\n\nDe regel staat daarna meteen in de openbare lijst (de app leest hem van GitHub). De CI draait zoals bij elke wijziging op main.`)) return;
    try { await busy(e.target, () => api("/api/aanbieder/lijst/samenvoegen", { method: "POST", body: { confirm: true } })); again({ ok: true, text: `Voorstel #${pr.nummer} is samengevoegd.` }); }
    catch (err) { hubMsg(err.message); }
  });
}

/** De mail aan deSEC voor een hogere zonelimiet (in het Engels; deSEC vraagt hem vanaf het e-mailadres van het account). */
function desecMail(z, a, verwacht) {
  const subject = `Request for a higher domain limit${z.account ? ` (${z.account})` : ""}`;
  const purpose = z.welke === "adressen"
    ? `We run the free-address service of Eigen Cloud, an open-source personal cloud (https://github.com/renevanes/own-cloud). Every user gets a free name under ${z.zone} (for example name.${z.zone}) as its own zone in this account, delegated from ${z.zone} with NS and DS records (DNSSEC).`
    : `We run an Eigen Cloud Dienst at ${a.url} (open source, https://github.com/renevanes/own-cloud). For every customer with their own domain name we create a DNS zone in this account, with DNSSEC.`;
  const body = ["Hello deSEC team,", "", `We would like to request a higher domain limit for our deSEC account${z.account ? ` ${z.account}` : ""}.`, "", `Purpose: ${purpose}`, "",
    `Current number of domains: ${z.zones ?? "unknown"}${z.limiet != null ? ` (limit: ${z.limiet})` : ""}`, `Expected number of domains in the next 12 months: ${verwacht}`, "",
    "Thank you for running deSEC!", "", "Kind regards,", a.company?.name ?? ""].join("\r\n");
  return `mailto:${z.support}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** In "Adressendienst": hoeveel zones er bij deSEC zijn, de limiet, en een mail om een hogere limiet te vragen. */
function zoneLimit(pane, a) {
  const welke = [...(a.adressen ? [["adressen", `Gedeelde zone ${a.adressen.zone}`, "Elk gratis adres is een eigen zone in dit account."]] : []),
    ...(a.accounts?.desecToken ? [["dienst", "Je eigen deSEC-account", "Elke klant met een eigen domein krijgt een zone in dit account."]] : [])];
  if (!welke.length) return;
  pane.insertAdjacentHTML("beforeend", `<h2 class="hubtitle small">Zones bij deSEC</h2>
    <p class="muted hubsub">deSEC heeft een limiet op het aantal zones per account. Vraag op tijd een hogere aan.</p>
    ${welke.map(([w, title, why]) => `<div class="panel" data-zone="${w}"><div><b>${esc(title)}</b><br><small class="muted">${esc(why)}</small></div>
      <ul class="results"><li class="busy" data-zstat>Ophalen…</li></ul>
      <div class="row"><label>Hoeveel zones verwacht je over een jaar?<input type="number" min="1" step="1" name="verwacht" inputmode="numeric"></label></div>
      <div><a class="btn" data-zmail href="#">Hogere zonelimiet aanvragen</a></div>
      <small class="muted" data-zhint>De mail gaat naar deSEC en is in het Engels. Stuur hem vanaf het e-mailadres van je deSEC-account: daar vraagt deSEC om.</small></div>`).join("")}`);
  for (const [w] of welke) {
    const box = pane.querySelector(`[data-zone="${w}"]`);
    const input = box.querySelector("[name=verwacht]"), mail = box.querySelector("[data-zmail]");
    let z = { welke: w, zone: a.adressen?.zone ?? null, account: null, zones: null, limiet: null, support: "support@desec.io" };
    const upd = () => { mail.href = desecMail(z, a, Math.max(1, Math.round(Number(input.value) || 0)) || "?"); };
    input.oninput = upd;
    upd();
    api(`/api/aanbieder/zonelimiet?welke=${w}`).then((r) => {
      z = r;
      const li = box.querySelector("[data-zstat]");
      li.className = r.zones != null && r.limiet != null && r.zones >= r.limiet * 0.8 ? "meh" : r.zones == null ? "unknown" : "";
      li.innerHTML = `${r.zones != null ? `${r.zones} zone${r.zones === 1 ? "" : "s"} in gebruik${r.limiet != null ? ` van de ${r.limiet} die deSEC toestaat` : ""}` : "Aantal zones onbekend"}${r.fout ? `<small>${esc(r.fout)}</small>` : ""}`;
      if (!input.value) input.value = String(Math.ceil(Math.max(100, (r.zones ?? 0) * 3) / 100) * 100);
      if (r.account) box.querySelector("[data-zhint]").textContent = `De mail gaat naar deSEC en is in het Engels. Stuur hem vanaf ${r.account}, het e-mailadres van je deSEC-account: daar vraagt deSEC om.`;
      upd();
    }).catch((err) => { const li = box.querySelector("[data-zstat]"); li.className = "bad"; li.textContent = err.message; if (!input.value) input.value = "500"; upd(); });
  }
}

/** Op het overzicht van je cloud: een korte verwijzing naar "Je dienst" (of: aanbieder worden). */
async function renderAanbiederTeaser() {
  const box = $("#aanbiederTeaser");
  if (!box) return;
  let a;
  try { a = await api("/api/aanbieder"); } catch { return; }
  rememberDienst(a);
  box.innerHTML = a.hub
    ? `<h2>Je dienst</h2><div class="panel"><div><b>${esc(a.company?.name ?? "")}</b><br><span class="muted">${esc((a.url ?? "").replace(/^https:\/\//, ""))}${a.wijzigingen === "toepassen" ? " · wijzigingen wachten" : ""}</span></div><div><a class="btn primary" href="#aanbieder">${esc(a.company?.name ?? "Je dienst")} beheren</a></div></div>`
    : a.started ? `<h2>Je dienst</h2><div class="panel"><p style="margin:0">Je bent bezig je eigen Dienst op te zetten.</p><div><a class="btn" href="#aanbieder">Verder met opzetten</a></div></div>`
    : `<h2>Aanbieder worden</h2><div class="panel"><p style="margin:0">Draai zelf een Eigen Cloud Dienst: mensen nemen dan bij jou een cloud, met jouw prijzen en jouw naam.</p><div><a class="btn" href="#aanbieder">Aanbieder worden</a></div></div>`;
}

/** Op het overzicht: alle gekoppelde sleutels (servers, DNS, opslag), elk met "Sleutels controleren". */
function keysSection() {
  if (!config) return "";
  const servers = (state.offers.servers ?? []).filter((o) => config.providers[o.id]);
  const dns = (state.offers.dns ?? []).find((o) => o.id === config.dnsMode);
  const stores = config.stores.filter((s) => s.type === "s3");
  if (!servers.length && !dns && !stores.length) return "";
  const li = (flag, name, sub, btn) => `<li><span class="flag">${flag}</span><b>${esc(name)}</b><span class="sub">${esc(sub)}</span><span class="end">${btn}</span></li>`;
  return `<div id="keys"><h2>Sleutels</h2><ul class="items">
    ${servers.map((o) => li(FLAGS[o.home] ?? "🖥️", o.name, "Servers", checkButton("servers", o.id, o.name))).join("")}
    ${dns ? li(FLAGS[dns.home] ?? "🌐", dns.name.replace(/ \(.*\)$/, ""), "DNS", checkButton("dns", dns.id, dns.name.replace(/ \(.*\)$/, ""))) : ""}
    ${stores.map((s) => li(FLAGS[s.country] ?? "🗄️", s.name, s.purpose === "backup" ? "Opslag, back-up" : "Opslag, werkkopie", checkButton("storage", s.name, s.name))).join("")}
  </ul><div id="checkBox"></div></div>`;
}

/** Op het overzicht (zelf regelen): geschatte kosten per aanbieder en in totaal per maand, met een budget. */
async function renderKosten(msg) {
  const box = $("#kosten");
  if (!box) return;
  let k;
  try { k = await api("/api/costs"); } catch (err) { box.innerHTML = `<h2>Kosten</h2><p class="msg err">${esc(err.message)}</p>`; return; }
  const home = (id) => [...(state.offers.servers ?? []), ...(state.offers.stores ?? [])].find((o) => o.id === id)?.home;
  const part = (n) => (n == null ? "onbekend" : eur(n));
  const sub = (p) => [
    k.sleeping && (state.offers.servers ?? []).some((o) => o.id === p.id) ? "servers € 0,00 (slaapt)" : p.servers === 0 ? "" : `servers ${part(p.servers)}`,
    p.storage === 0 && !p.bytes ? "" : `opslag ${part(p.storage)}${p.bytes ? ` (${mbStr(p.bytes)})` : ""}`,
  ].filter(Boolean).join(" · ");
  box.innerHTML = `<h2>Kosten</h2>
    <p class="muted" style="margin-top:0"><small>Geschat per maand, met de prijslijsten van de aanbieders. Uitgaand verkeer telt niet mee. Opslag gemeten om ${time(k.updatedAt)}.</small></p>
    ${k.sleeping ? `<p class="note">Je cloud slaapt: de servers kosten nu niets, de opslag wel.</p>` : ""}
    ${k.overBudget ? `<p class="note warn">De geschatte kosten (${eur(k.total)}) zijn hoger dan je budget van ${eur(k.budget)} per maand.</p>` : ""}
    <ul class="items">${k.providers.length ? k.providers.map((p) => `<li><span class="flag">${FLAGS[home(p.id)] ?? "🧾"}</span><b>${esc(p.name)}</b><span class="sub">${esc(sub(p))}</span><span class="end">${eur(p.total)}</span></li>`).join("") : `<li><span></span><span class="muted">Nog niets dat geld kost</span></li>`}
      <li><span></span><b>Totaal per maand</b><span class="sub">${k.complete ? "" : "Van een deel is de prijs onbekend; dat telt niet mee. "}${k.budget != null ? `Budget ${eur(k.budget)}` : "Geen budget ingesteld"}</span><span class="end"><b>${eur(k.total)}</b></span></li></ul>
    <form class="fields" id="budgetForm"><label>Budget per maand in euro<input name="budget" inputmode="decimal" autocomplete="off" placeholder="bijvoorbeeld 25" value="${k.budget != null ? esc(String(k.budget).replace(".", ",")) : ""}"><small class="muted">Kom je erboven, dan krijg je een melding per mail. Leeg laten: geen budget.</small></label>
      <div><button class="btn">Budget opslaan</button></div></form>
    <p class="msg ${msg?.ok ? "ok" : ""}" id="kmsg">${esc(msg?.text ?? "")}</p>`;
  $("#budgetForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const v = ev.target.budget.value.trim();
    try {
      await busy($("#budgetForm button"), () => api("/api/costs/budget", { method: "POST", body: { budget: v === "" ? null : v } }));
      renderKosten({ ok: true, text: v === "" ? "Budget weggehaald." : "Budget opgeslagen." });
    } catch (err) { $("#kmsg").textContent = err.message; $("#kmsg").className = "msg err"; }
  };
}

async function renderDash() {
  root.innerHTML = `<div class="dash"><div class="mapwrap" id="map"></div><section>${keyReminder()}<div id="side"><p class="muted">Status ophalen…</p></div>${config?.dienst?.orderId ? "" : `<div id="kosten"></div>`}${keysSection()}${config?.dienst?.orderId ? `<div id="abo"></div>` : ""}<div id="aanbiederTeaser"></div></section></div>`;
  if (config?.dienst?.orderId) renderAbo(); else renderKosten();
  renderAanbiederTeaser();
  const draw = async () => {
    let s;
    try { s = await api("/api/status"); } catch { return; }
    const nodes = s.live?.nodes ?? s.manifest?.nodes?.map((n) => ({ ...n, status: s.state === "asleep" ? "asleep" : n.status })) ?? [];
    const countries = [...new Set(nodes.map((n) => n.country).filter(Boolean))];
    $("#map").className = "mapwrap" + (s.state === "asleep" ? " asleep" : "");
    $("#map").innerHTML = europeMap(nodes.map((n) => ({ ...n, status: s.state === "asleep" ? "ready" : n.status })));
    const h = s.live?.health ?? {};
    const bad = Object.values(h).filter((x) => x === "fail").length, warn = Object.values(h).filter((x) => x === "warn").length;
    const cost = nodes.reduce((a, n) => a + (n.monthly_cost ?? 0), 0);
    const title = { awake: "Je cloud draait", asleep: "Je cloud slaapt", "falling-asleep": "Je cloud gaat slapen", starting: "Je cloud start op", unreachable: "Je cloud is niet bereikbaar", new: "Nog niet gestart" }[s.state];
    const sentence = s.state === "awake"
      ? `Op ${nodes.filter((n) => n.status === "ready").length} servers in ${countries.map((c) => FLAGS[c] ?? c).join(" ")}${cost ? `, voor ongeveer ${eur(cost)} per maand` : ""}.`
      : s.state === "asleep" ? "Alles staat versleuteld in je opslag. Je betaalt nu alleen voor opslag. Mail die binnenkomt, wordt door de afzenders een paar dagen opnieuw aangeboden."
      : s.state === "unreachable" ? `Geen enkele server reageert${s.manifest ? ` (laatst gezien ${time(s.manifest.updated)})` : ""}. Dat kan een storing zijn. Je kunt je cloud vanuit de back-up opnieuw starten.`
      : s.state === "starting" ? "Even geduld; dit duurt meestal 5 à 10 minuten."
      : s.state === "falling-asleep" ? "Alles wordt weggeschreven en gecontroleerd. Daarna gaan de servers uit." : "";
    $("#side").innerHTML = `
      <h1>${title}</h1><p class="state">${sentence}</p>
      <div class="actions">
        ${s.state === "awake" && s.appUrl ? `<a class="btn primary" href="${esc(s.appUrl)}" target="_blank" rel="noopener" data-cloud>Open mijn cloud</a>` : ""}
        ${s.state === "asleep" || s.state === "unreachable" ? `<button class="btn primary" id="wake">Wakker maken</button>` : ""}
        ${s.state === "awake" && s.live?.update?.available && !s.live.update.running ? `<button class="btn" id="upd">Bijwerken naar ${esc(s.live.update.available)}</button>` : ""}
        ${s.state === "awake" ? `<button class="btn" id="drillNow">Back-up testen</button><button class="btn" id="sleep">Laten slapen</button>` : ""}
        <a class="btn" href="/api/recovery-sheet" target="_blank" rel="noopener">Herstelblad</a>
        ${NATIVE ? "" : `<a class="btn" href="/api/download-db" download>Database downloaden</a>`}
        <a class="btn" href="#opslag">Instellingen</a>
      </div>
      ${s.launch && (!s.launch.done || s.state !== "awake") ? `<h2>Opstarten</h2>${launchView(s.launch)}` : ""}
      ${s.live ? `<div class="healthline ${bad ? "fail" : warn ? "warn" : ""}">${bad ? `${bad} probleem${bad === 1 ? "" : "en"} en ${warn} aandachtspunt${warn === 1 ? "" : "en"}` : warn ? `${warn} aandachtspunt${warn === 1 ? "" : "en"}` : "Alle controles in orde"}${s.appUrl && (bad || warn) ? ` · <a href="${esc(s.appUrl)}/#instellingen/gezondheid" target="_blank" rel="noopener">bekijken</a>` : ""}</div>` : ""}
      ${s.live?.update ? `<p class="muted"><small>${s.live.update.running ? `Bezig met bijwerken naar ${esc(s.live.update.latest?.version ?? "")}…` : s.live.update.failed ? `Bijwerken naar ${esc(s.live.update.failed.version)} lukte niet; de vorige versie draait door.` : `Software: versie ${esc([...new Set(Object.values(s.live.update.nodes).map((n) => n.version).filter(Boolean))].join(", "))}${s.live.update.mode === "auto" ? ", wordt 's nachts automatisch bijgewerkt" : ""}`}</small></p>` : ""}
      ${s.live?.lastDrill ? `<p class="muted"><small>Laatste back-uptest: ${time(s.live.lastDrill.ts)} — ${s.live.lastDrill.level === "info" ? "geslaagd" : "mislukt"}</small></p>` : ""}
      <h2>Servers</h2>
      <ul class="items">${nodes.length ? nodes.map((n) => `<li><span class="flag">${FLAGS[n.country] ?? "🖥️"}</span><b>${esc(placeName(n))}</b>
        <span class="sub">${n.kind === "witness" ? "Witness, beslist mee bij storingen" : n.isLeader ? "Dataserver, leidt nu" : "Dataserver, houdt alles bij"}${n.status !== "ready" ? ` · ${esc({ provisioning: "wordt aangemaakt", syncing: "haalt gegevens op", removing: "wordt opgeheven", asleep: "slaapt" }[n.status] ?? n.status)}` : ""}${n.monthly_cost ? ` · ${eur(n.monthly_cost)} p/m` : ""}</span></li>`).join("") : `<li><span></span><span class="muted">Nog geen servers</span></li>`}</ul>
      ${s.live?.events?.length ? `<h2>Wat er gebeurde</h2><ul class="events">${s.live.events.slice(0, 10).map((e) => `<li class="${e.level}"><time>${time(e.ts)}</time>${esc(e.message)}</li>`).join("")}</ul>` : ""}
      <p class="msg" id="dmsg"></p>`;
    $("#wake")?.addEventListener("click", async (e) => { try { await busy(e.target, () => api("/api/wake", { method: "POST" })); draw(); } catch (err) { $("#dmsg").textContent = err.message; $("#dmsg").className = "msg err"; } });
    $("#upd")?.addEventListener("click", async (e) => { try { await busy(e.target, () => api("/api/action", { method: "POST", body: { type: "update" } })); $("#dmsg").textContent = "Bijwerken gestart: één server tegelijk."; $("#dmsg").className = "msg ok"; } catch (err) { $("#dmsg").textContent = err.message; $("#dmsg").className = "msg err"; } });
    $("#drillNow")?.addEventListener("click", async (e) => { try { await busy(e.target, () => api("/api/action", { method: "POST", body: { type: "drill" } })); $("#dmsg").textContent = "Back-uptest gestart; het resultaat verschijnt hieronder."; $("#dmsg").className = "msg ok"; } catch (err) { $("#dmsg").textContent = err.message; } });
    $("#sleep")?.addEventListener("click", async (e) => {
      if (!confirm("Je cloud laten slapen?\n\nAlles wordt versleuteld weggeschreven en gecontroleerd. Daarna worden alle servers verwijderd en betaal je alleen voor opslag. Mail en je cloud zijn dan niet bereikbaar tot je hem wakker maakt.")) return;
      try { await busy(e.target, () => api("/api/action", { method: "POST", body: { type: "sleep" } })); $("#dmsg").textContent = "Gaat slapen…"; $("#dmsg").className = "msg ok"; } catch (err) { $("#dmsg").textContent = err.message; }
    });
  };
  await draw();
  timer = setInterval(draw, 5000);
}

boot();
