// Eigen Cloud — beheerconsole
import { europeMap, MAP_CSS } from "/shared/europe.js";
document.head.insertAdjacentHTML("beforeend", `<style>${MAP_CSS}</style>`);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const root = $("#root");
const FLAGS = { NL: "🇳🇱", DE: "🇩🇪", FI: "🇫🇮", FR: "🇫🇷", PL: "🇵🇱", SE: "🇸🇪", AT: "🇦🇹", CH: "🇨🇭", BE: "🇧🇪" };
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
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
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

let state = null, config = null, timer = null, dienstTimer = null;

const BASE_STEPS = [
  { id: "jij", label: "Jij en je adres" },
  { id: "sleutel", label: "Herstelsleutel" },
  { id: "regelen", label: "Zelf of via de dienst" },
  { id: "opslag", label: "Opslag voor back-ups" },
  { id: "servers", label: "Servers" },
  { id: "domein", label: "Domein koppelen" },
  { id: "mail", label: "Mail versturen" },
  { id: "starten", label: "Starten" },
];
/** De stap "Zelf of via de dienst" alleen als deze versie een Eigen Cloud Dienst kent. */
let STEPS = BASE_STEPS.filter((x) => x.id !== "regelen");

async function boot() {
  state = await api("/api/state");
  STEPS = BASE_STEPS.filter((x) => x.id !== "regelen" || state.dienst);
  render();
}

async function render() {
  clearInterval(timer);
  clearTimeout(dienstTimer);
  $("#lockBtn").hidden = !state.unlocked;
  if (!state.vault) return renderStart();
  if (!state.unlocked) return renderLock();
  config = await api("/api/config");
  const hash = location.hash.slice(1);
  if (state.done && !STEPS.some((s) => s.id === hash)) return renderDash();
  renderStep(STEPS.some((s) => s.id === hash) && hash !== "jij" ? hash : state.step ?? "sleutel");
}

$("#lockBtn").onclick = async () => { await api("/api/lock", { method: "POST" }); location.hash = ""; boot(); };
window.addEventListener("hashchange", () => state?.unlocked && render());

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

// ═════════ Start, slot, herstel ═════════

function renderStart() {
  root.innerHTML = `<section class="center">
    <h1>Je eigen cloud, op jouw plek in Europa.</h1>
    <p class="lead">Mail, agenda en foto's op servers die jij kiest. Deze console helpt je in een paar stappen op weg.</p>
    <div class="choices">
      <button class="choice" id="new"><b>Nieuwe Eigen Cloud maken</b><span class="muted">Ongeveer een kwartier, plus het wachten op een export van Google als je wilt overstappen.</span></button>
      <button class="choice" id="recover"><b>Ik heb al een Eigen Cloud</b><span class="muted">Op een nieuwe ${NATIVE ? "telefoon" : "computer"}, of na een storing: herstellen met je herstelsleutel.</span></button>
    </div></section>`;
  $("#new").onclick = renderCreate;
  $("#recover").onclick = renderRecover;
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
    </form></section>`;
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
      <span class="pip">${i < idx ? "✓" : ""}</span>${i < idx && s.id !== "jij" ? `<a href="#${s.id}">${s.label}</a>` : `<span class="t">${s.label}</span>`}</li>`).join("")}
  </ol><section class="pane">${inner}</section></div>`;
}

const DOMAIN_HINTS = {
  own: "Straks zet je bij de partij waar je domein staat de nameservers om. De console vertelt precies wat je moet invullen.",
  buy: "De Eigen Cloud Dienst registreert hem voor je; de kosten zitten in je abonnement.",
  free: "Gratis van deSEC (open source, non-profit, Berlijn). Prima om te beginnen. Voor mail is een eigen domein beter: sommige ontvangers vertrouwen gratis adressen minder.",
};

function renderCreate() {
  root.innerHTML = wizardShell("jij", `
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
      <h2>Kluis van deze console</h2>
      <p class="muted" style="margin:0">De console bewaart je sleutels en API-tokens versleuteld op ${DEVICE}. Kies een wachtwoordzin die je nergens anders gebruikt, bijvoorbeeld vier losse woorden.</p>
      <div class="row"><label>Wachtwoordzin<input type="password" name="pass" minlength="12" autocomplete="new-password" required></label>
      <label>Nog een keer<input type="password" name="pass2" minlength="12" autocomplete="new-password" required></label></div>
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
    if (f.pass.value !== f.pass2.value) return formMsg(f, "De wachtwoordzinnen zijn niet gelijk");
    try {
      await busy($("button", f), () => api("/api/setup/create", { method: "POST", body: { domain: f.domain.value, domainMode: f.domainMode.value, mailbox: f.mailbox.value, appPassword: f.appPassword.value, alertEmail: f.alertEmail.value, passphrase: f.pass.value } }));
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
    <form class="fields" id="f">
      <label>Herstelsleutel<input name="key" placeholder="8 groepen van 8 tekens" autocomplete="off" required><small>Spaties maken niet uit.</small></label>
      <h2 style="margin:8px 0 0">Een opslag waar je back-ups staan</h2>
      ${storeFields(offers)}
      <label>Bucket<input name="bucket" required></label>
      <h2 style="margin:8px 0 0">Nieuwe kluis op ${DEVICE}</h2>
      <label>Wachtwoordzin<input type="password" name="pass" minlength="12" required></label>
      <p class="msg"></p>
      <div><button class="btn primary">Herstellen</button> <button type="button" class="link" id="back">Terug</button></div>
    </form></section>`;
  const f = $("#f");
  wireStoreFields(f, offers);
  $("#back").onclick = renderStart;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const o = offers.find((x) => x.id === f.offer.value), r = o.regions.find((x) => x.id === f.region.value);
    const store = o.id === "localfs"
      ? { name: "herstel", type: "fs", purpose: "replica", dir: f.bucket.value }
      : { name: "herstel", type: "s3", purpose: "replica", endpoint: o.customEndpoint ? f.endpoint.value : r.endpoint, region: r.id, bucket: f.bucket.value, accessKey: f.accessKey.value, secretKey: f.secretKey.value };
    try { await busy($("button", f), () => api("/api/setup/recover", { method: "POST", body: { masterKey: f.key.value, passphrase: f.pass.value, store } })); location.hash = ""; boot(); }
    catch (err) { formMsg(f, err.message); }
  };
}

// ═════════ Stappen ═════════

async function go(step) {
  await api("/api/step", { method: "POST", body: { step } });
  state.step = step;
  location.hash = step;
}

function renderStep(id) {
  const fn = ({ sleutel: stepKey, regelen: stepRegelen, opslag: stepStores, servers: stepServers, domein: stepDns, mail: stepMail, starten: stepLaunch, klaar: renderDash })[id] ?? stepKey;
  fn();
}

async function stepKey() {
  const k = await api("/api/key");
  root.innerHTML = wizardShell("sleutel", `
    <h1>Je herstelsleutel</h1>
    <p class="lead">Alles wat je cloud opslaat, wordt hiermee versleuteld. Zonder deze sleutel kan niemand je back-ups lezen — ook jij niet.</p>
    <div class="key">${k.groups.map((g, i) => `<div>${g}<small>groep ${i + 1}</small></div>`).join("")}</div>
    <p class="muted">Controlegetal ${k.check}</p>
    <div class="note">Schrijf hem op of druk het herstelblad af, en bewaar het op twee plekken: thuis bij je belangrijke papieren en bij iemand die je vertrouwt. Niet als foto op je telefoon.</div>
    <p><a class="btn" href="/api/recovery-sheet" target="_blank" rel="noopener">Herstelblad afdrukken</a></p>
    <h2>Even controleren</h2>
    <form class="fields" id="f">
      <div class="row"><label>Groep 3<input name="g3" autocomplete="off" required></label><label>Groep 7<input name="g7" autocomplete="off" required></label></div>
      <p class="msg"></p>
      <div class="next"><button class="btn primary">${k.confirmed ? "Verder" : "Klopt, verder"}</button></div>
    </form>`);
  const f = $("#f");
  if (k.confirmed) { f.g3.value = k.groups[2]; f.g7.value = k.groups[6]; }
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/key/confirm", { method: "POST", body: { g3: f.g3.value, g7: f.g7.value } }); go(state.dienst ? "regelen" : "opslag"); }
    catch (err) { formMsg(f, err.message); }
  };
}

// ═════════ Zelf of via de Eigen Cloud Dienst ═════════

let dienstInfoCache = null, lastCheckout = null;

async function stepRegelen() {
  if (config.dienst?.orderId) return dienstProgress();
  dienstInfoCache = await api("/api/dienst/info").catch(() => null);
  const info = dienstInfoCache;
  root.innerHTML = wizardShell("regelen", `
    <h1>Zelf regelen of via de dienst?</h1>
    <p class="lead">Je cloud heeft opslag, servers, DNS en een mail-relay nodig. Die kun je zelf afsluiten, of in één abonnement laten regelen. Je gegevens zijn in beide gevallen versleuteld met jouw sleutel; ook de dienst kan ze niet lezen.</p>
    <div class="choices">
      <button class="choice" id="zelf"><b>Zelf regelen</b><span class="muted">Je maakt accounts bij Europese aanbieders en betaalt hen rechtstreeks. DNS kan gratis via deSEC. Meestal het goedkoopst, wel meer stappen.</span></button>
    </div>
    <h2>Alles geregeld door de Eigen Cloud Dienst</h2>
    ${info ? `<p class="muted" style="margin:0 0 12px">Servers en opslag in Amsterdam en Parijs (Scaleway), je domein, DNS en mail-relay. Eén bedrag per maand, maandelijks opzegbaar. Je kunt later alles meenemen naar je eigen accounts.</p>
      <div class="presets">${info.bundles.map((b) => `<button class="preset" data-bundle="${esc(b.id)}">
        <b>${esc(b.title)}</b><span class="price">${eurStr(b.monthly)} per maand</span><p>${esc(b.description)}</p>
        <p><small>${b.includes.dataServers} dataservers en ${b.includes.witnesses} witness · ${b.includes.storageGb} GB opslag${b.includes.domain ? " · domein" : ""}${b.includes.mail ? " · mail-relay" : ""}</small></p></button>`).join("")}</div>`
      : `<p class="note warn">De dienst is nu niet bereikbaar. Probeer het later opnieuw, of regel het zelf.</p>`}`);
  $("#zelf").onclick = () => go("opslag");
  root.onclick = (e) => { const b = e.target.closest?.("[data-bundle]")?.dataset.bundle; if (b) dienstLogin(b); };
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
  if (mode === "free") {
    dienstShell(`
      <h1>Kies een domeinnaam</h1>
      <p class="lead">Bij de dienst hoort een eigen domein, zoals vanes.nl, in plaats van ${esc(config.domain)}. De registratie zit in je abonnement.</p>
      <form class="fields" id="f"><label>Domeinnaam<input name="domain" placeholder="vanes.nl" autocapitalize="off" required></label>
        <label class="check"><input type="checkbox" name="mine"> Dit domein heb ik al</label>
        <p class="msg"></p><div><button class="btn primary">Verder</button></div></form>`);
    const f = $("#f");
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        if (!f.mine.checked) {
          const r = await api(`/api/dienst/check?name=${encodeURIComponent(f.domain.value)}`);
          if (!r.available) return formMsg(f, `${r.domain} is al bezet. Kies een andere naam, of vink aan dat hij van jou is.`);
        }
        await busy($("button", f), () => api("/api/setup/domain", { method: "POST", body: { domain: f.domain.value, domainMode: f.mine.checked ? "own" : "buy" } }));
        config = await api("/api/config");
        dienstOrder(bundle);
      } catch (err) { formMsg(f, err.message); }
    };
    return;
  }
  const countries = { NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", LU: "Luxemburg" };
  dienstShell(`
    <h1>${esc(b?.title ?? "Abonnement")} — ${eurStr(b?.monthly)} per maand</h1>
    <p class="lead">Nog een paar gegevens, dan reken je af met iDEAL. Daarna wordt alles voor ${esc(config.domain)} klaargezet.</p>
    <form class="fields" id="f">
      ${mode === "own" ? `<fieldset class="radios">
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
    $(".reg", f).hidden = m === "own";
    $$(".reg input:not([name=company])", f).forEach((i) => (i.required = m !== "own"));
  };
  f.onchange = upd;
  upd();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const m = f.dmode.value;
    const registrant = Object.fromEntries(["firstName", "lastName", "company", "street", "number", "zipcode", "city", "country", "phone", "email"].map((k) => [k, f[k].value.trim()]));
    try {
      const r = await busy($("button", f), () => api("/api/dienst/order", { method: "POST", body: { bundle, mode: m, authCode: f.authCode?.value, registrant, acceptTerms: f.terms.checked } }));
      lastCheckout = r.checkoutUrl;
      config = await api("/api/config");
      if (NATIVE) NATIVE.openUrl(r.checkoutUrl); else window.open(r.checkoutUrl, "_blank", "noopener");
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
    ${st.status === "ready" && config.dienst?.applied ? `<div class="next"><button class="btn primary" id="nx">Verder naar starten</button></div>` : ""}`);
  $("#nx")?.addEventListener("click", () => go("starten"));
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
      <span class="end"><button class="link" data-del="${esc(s.name)}">Verwijderen</button></span></li>`).join("")}</ul>` : ""}
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
      <span class="end">${config.providers[o.id] ? `<span class="muted">✓ gekoppeld</span> <button class="link" data-unlink="${o.id}">Loskoppelen</button>` : `<button class="btn" data-link="${o.id}">Koppelen</button>`}</span></li>`).join("")}</ul>
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
        ${o.fields.map((fl) => `<label>${esc(fl.label)}<input name="${fl.key}" ${fl.secret ? 'type="password"' : ""} autocomplete="off" required></label>`).join("")}
        ${o.signupUrl ? `<p class="muted" style="margin:0">Maak een API-token aan in de <a href="${o.signupUrl}" target="_blank" rel="noopener">console van ${esc(o.name)}</a>.</p>` : ""}
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
        } catch (err) { formMsg(lf, err.message); }
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
    $("#nx").onclick = () => go("mail");
    return;
  }
  const free = config.domainMode === "free";
  root.innerHTML = wizardShell("domein", `
    <h1>Domein koppelen</h1>
    <p class="lead">${free ? `${esc(d)} komt van deSEC: gratis, open source en zonder reclame. De console maakt het account voor je aan; jij hoeft alleen een plaatje over te typen en een link in je mail aan te klikken.`
      : `Je cloud zet zelf de juiste DNS-records voor ${esc(d)}: waar de site en je mail te vinden zijn, en de beveiliging van je mail. Daarvoor heeft hij toegang nodig tot je DNS.`}</p>
    ${free ? "" : `<form class="fields" id="f">
      <fieldset class="radios">
        <label class="check"><input type="radio" name="mode" value="desec" ${config.dnsMode !== "hetzner" && config.dnsMode !== "manual" ? "checked" : ""}> deSEC (gratis, open source, Berlijn — aanbevolen)</label>
        <label class="check"><input type="radio" name="mode" value="hetzner" ${config.dnsMode === "hetzner" ? "checked" : ""}> Hetzner DNS</label>
        <label class="check"><input type="radio" name="mode" value="manual" ${config.dnsMode === "manual" ? "checked" : ""}> Ik regel DNS zelf</label>
      </fieldset>
      <p class="desecNew" style="margin:0"><button type="button" class="btn" id="newDesec">Nog geen deSEC-account? Laat de console er een maken</button></p>
      <label class="tok">API-token<input name="token" type="password" autocomplete="off" placeholder="${config.dns[0]?.token ?? ""}"><small class="hint"></small></label>
      <p class="msg"></p>
      <div><button class="btn">Koppelen</button></div>
    </form>`}
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
      $(".tok", f).hidden = m === "manual";
      $(".desecNew", f).hidden = m !== "desec" || !!config.dnsMode;
      $(".hint", f).innerHTML = m === "desec" ? 'Al een account op <a href="https://desec.io" target="_blank" rel="noopener">desec.io</a>? Maak een token onder "Token Management" en plak het hier.' : m === "hetzner" ? "Hetzner Console → je project → Beveiliging → API-tokens. Maak de DNS-zone eerst aan." : "";
      $("button[type=submit], form#f > div > button", f).textContent = m === "manual" ? "Opslaan" : "Koppelen";
    };
    f.onchange = upd;
    upd();
    $("#newDesec").onclick = () => { $(".desecNew", f).hidden = true; desecSignup($("#signup"), done); };
    if (config.dnsMode && config.dnsMode !== "manual") api("/api/dns/check").then((r) => nsPanel(r, d, f.mode.value === "desec" ? "deSEC" : "Hetzner")).catch(() => {});
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await busy($("form#f > div > button", f), () => api("/api/dns", { method: "POST", body: { mode: f.mode.value, token: f.token.value } }));
        config = await api("/api/config");
        formMsg(f, f.mode.value === "manual" ? "Opgeslagen." : "Gekoppeld.", true);
        $("#nx").disabled = false;
        if (f.mode.value === "manual") $("#nsBox").innerHTML = `<div class="note">Na het starten laat je cloud onder <b>Instellingen → Gezondheid</b> precies zien welke records je moet zetten.</div>`;
        else nsPanel(r, d, f.mode.value === "desec" ? "deSEC" : "Hetzner");
      } catch (err) { formMsg(f, err.message); }
    };
  }
  $("#nx").onclick = () => go("mail");
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
    <ul class="results">${list.map((x) => `<li class="${x.ok ? "" : x.required ? "bad" : "meh"}">${esc(x.label)}${!x.ok && !x.required ? "<small>Kan later ook, via Instellingen in je cloud.</small>" : ""}</li>`).join("")}</ul>
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

async function renderDash() {
  root.innerHTML = `<div class="dash"><div class="mapwrap" id="map"></div><section id="side"><p class="muted">Status ophalen…</p></section></div>`;
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
