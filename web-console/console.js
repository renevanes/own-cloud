// Eigen Cloud — beheerconsole
import { europeMap, MAP_CSS } from "/shared/europe.js";
document.head.insertAdjacentHTML("beforeend", `<style>${MAP_CSS}</style>`);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const root = $("#root");
const FLAGS = { NL: "🇳🇱", DE: "🇩🇪", FI: "🇫🇮", FR: "🇫🇷", PL: "🇵🇱", SE: "🇸🇪", AT: "🇦🇹", CH: "🇨🇭", BE: "🇧🇪" };
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

let state = null, config = null, timer = null;

const STEPS = [
  { id: "jij", label: "Jij en je domein" },
  { id: "sleutel", label: "Herstelsleutel" },
  { id: "opslag", label: "Opslag voor back-ups" },
  { id: "servers", label: "Servers" },
  { id: "domein", label: "Domein koppelen" },
  { id: "mail", label: "Mail versturen" },
  { id: "starten", label: "Starten" },
];

async function boot() {
  state = await api("/api/state");
  render();
}

async function render() {
  clearInterval(timer);
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

function renderCreate() {
  root.innerHTML = wizardShell("jij", `
    <h1>Jij en je domein</h1>
    <p class="lead">Je cloud draait op je eigen domeinnaam. Heb je er nog geen, registreer er dan eerst een (bijvoorbeeld bij een Nederlandse registrar).</p>
    <form class="fields" id="f">
      <label>Domeinnaam<input name="domain" placeholder="vanes.nl" autocomplete="off" required></label>
      <label>Je e-mailadres<div class="suffix"><input name="mailbox" placeholder="rene" required><span id="at">@…</span></div></label>
      <label>Wachtwoord om in je cloud in te loggen<input type="password" name="appPassword" minlength="10" autocomplete="new-password" required><small>Minstens 10 tekens. Dit gebruik je dagelijks, ook op je telefoon.</small></label>
      <label>Meldingen bij problemen naar<input type="email" name="alertEmail" placeholder="een adres bij een andere aanbieder"><small>Kies een adres buiten je nieuwe domein, zodat een melding ook aankomt als je mail stuk is.</small></label>
      <h2>Kluis van deze console</h2>
      <p class="muted" style="margin:0">De console bewaart je sleutels en API-tokens versleuteld op ${DEVICE}. Kies een wachtwoordzin die je nergens anders gebruikt, bijvoorbeeld vier losse woorden.</p>
      <div class="row"><label>Wachtwoordzin<input type="password" name="pass" minlength="12" autocomplete="new-password" required></label>
      <label>Nog een keer<input type="password" name="pass2" minlength="12" autocomplete="new-password" required></label></div>
      <p class="msg"></p>
      <div class="next"><button class="btn primary">Verder</button></div>
    </form>`);
  const f = $("#f");
  f.domain.oninput = () => ($("#at").textContent = "@" + (f.domain.value.trim() || "…"));
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.pass.value !== f.pass2.value) return formMsg(f, "De wachtwoordzinnen zijn niet gelijk");
    try {
      await busy($("button", f), () => api("/api/setup/create", { method: "POST", body: { domain: f.domain.value, mailbox: f.mailbox.value, appPassword: f.appPassword.value, alertEmail: f.alertEmail.value, passphrase: f.pass.value } }));
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
  const fn = ({ sleutel: stepKey, opslag: stepStores, servers: stepServers, domein: stepDns, mail: stepMail, starten: stepLaunch, klaar: renderDash })[id] ?? stepKey;
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
    try { await api("/api/key/confirm", { method: "POST", body: { g3: f.g3.value, g7: f.g7.value } }); go("opslag"); }
    catch (err) { formMsg(f, err.message); }
  };
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
  root.innerHTML = wizardShell("domein", `
    <h1>Domein koppelen</h1>
    <p class="lead">Je cloud zet zelf de juiste DNS-records voor ${esc(d)}: waar de site en je mail te vinden zijn, en de beveiliging van je mail. Daarvoor heeft hij toegang nodig tot je DNS.</p>
    <form class="fields" id="f">
      <fieldset class="radios">
        <label class="check"><input type="radio" name="mode" value="desec" ${config.dnsMode !== "hetzner" && config.dnsMode !== "manual" ? "checked" : ""}> deSEC (gratis, Berlijn, aanbevolen)</label>
        <label class="check"><input type="radio" name="mode" value="hetzner" ${config.dnsMode === "hetzner" ? "checked" : ""}> Hetzner DNS</label>
        <label class="check"><input type="radio" name="mode" value="manual" ${config.dnsMode === "manual" ? "checked" : ""}> Ik regel DNS zelf</label>
      </fieldset>
      <label class="tok">API-token<input name="token" type="password" autocomplete="off" placeholder="${config.dns[0]?.token ?? ""}"><small class="hint"></small></label>
      <p class="msg"></p>
      <div><button class="btn">Koppelen</button></div>
    </form>
    <div id="nsBox"></div>
    <div class="next"><button class="btn primary" id="nx" ${config.dnsMode ? "" : "disabled"}>Verder</button></div>`);
  const f = $("#f");
  const upd = () => {
    const m = f.mode.value;
    $(".tok", f).hidden = m === "manual";
    $(".hint", f).innerHTML = m === "desec" ? 'Maak een gratis account op <a href="https://desec.io" target="_blank" rel="noopener">desec.io</a> en daarna een token onder "Token Management".' : m === "hetzner" ? "Hetzner Console → je project → Beveiliging → API-tokens. Maak de DNS-zone eerst aan." : "";
    $("button", f).textContent = m === "manual" ? "Opslaan" : "Koppelen";
  };
  f.onchange = upd;
  upd();
  const showNs = (r) => {
    if (!r?.ns) return ($("#nsBox").innerHTML = f.mode.value === "manual" ? `<div class="note">Na het starten laat je cloud onder <b>Instellingen → Gezondheid</b> precies zien welke records je moet zetten.</div>` : "");
    $("#nsBox").innerHTML = `<div class="panel"><b>${r.delegated ? "✓ Je domein wijst al naar " + (f.mode.value === "desec" ? "deSEC" : "Hetzner") : "Nog één ding bij je registrar"}</b>
      ${r.delegated ? "" : `<p style="margin:0">Log in bij de partij waar je ${esc(d)} hebt geregistreerd en vervang de nameservers door:</p><div class="ns">${r.ns.map((n) => `<code>${esc(n)}</code>`).join("")}</div>
      <p class="muted" style="margin:0"><small>Dat kan tot een dag duren. Je kunt intussen gewoon verder; je cloud controleert het zelf.</small></p><div><button class="btn" id="chk">Nu controleren</button></div>`}</div>`;
    $("#chk")?.addEventListener("click", async (e) => { const c = await busy(e.target, () => api("/api/dns/check")); showNs(c); });
  };
  if (config.dnsMode && config.dnsMode !== "manual") api("/api/dns/check").then(showNs).catch(() => {});
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await busy($("button", f), () => api("/api/dns", { method: "POST", body: { mode: f.mode.value, token: f.token.value } }));
      config = await api("/api/config");
      $("#nx").disabled = false;
      formMsg(f, f.mode.value === "manual" ? "Opgeslagen." : "Gekoppeld.", true);
      showNs(r);
    } catch (err) { formMsg(f, err.message); }
  };
  $("#nx").onclick = () => go("mail");
}

const RELAYS = {
  scaleway: { host: "smtp.tem.scw.cloud", port: 465, secure: true, label: "Scaleway TEM (Frankrijk)" },
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
        ${s.state === "awake" ? `<button class="btn" id="drillNow">Back-up testen</button><button class="btn" id="sleep">Laten slapen</button>` : ""}
        <a class="btn" href="/api/recovery-sheet" target="_blank" rel="noopener">Herstelblad</a>
        ${NATIVE ? "" : `<a class="btn" href="/api/download-db" download>Database downloaden</a>`}
        <a class="btn" href="#opslag">Instellingen</a>
      </div>
      ${s.launch && (!s.launch.done || s.state !== "awake") ? `<h2>Opstarten</h2>${launchView(s.launch)}` : ""}
      ${s.live ? `<div class="healthline ${bad ? "fail" : warn ? "warn" : ""}">${bad ? `${bad} probleem${bad === 1 ? "" : "en"} en ${warn} aandachtspunt${warn === 1 ? "" : "en"}` : warn ? `${warn} aandachtspunt${warn === 1 ? "" : "en"}` : "Alle controles in orde"}${s.appUrl && (bad || warn) ? ` · <a href="${esc(s.appUrl)}/#instellingen/gezondheid" target="_blank" rel="noopener">bekijken</a>` : ""}</div>` : ""}
      ${s.live?.lastDrill ? `<p class="muted"><small>Laatste back-uptest: ${time(s.live.lastDrill.ts)} — ${s.live.lastDrill.level === "info" ? "geslaagd" : "mislukt"}</small></p>` : ""}
      <h2>Servers</h2>
      <ul class="items">${nodes.length ? nodes.map((n) => `<li><span class="flag">${FLAGS[n.country] ?? "🖥️"}</span><b>${esc(placeName(n))}</b>
        <span class="sub">${n.kind === "witness" ? "Witness, beslist mee bij storingen" : n.isLeader ? "Dataserver, leidt nu" : "Dataserver, houdt alles bij"}${n.status !== "ready" ? ` · ${esc({ provisioning: "wordt aangemaakt", syncing: "haalt gegevens op", removing: "wordt opgeheven", asleep: "slaapt" }[n.status] ?? n.status)}` : ""}${n.monthly_cost ? ` · ${eur(n.monthly_cost)} p/m` : ""}</span></li>`).join("") : `<li><span></span><span class="muted">Nog geen servers</span></li>`}</ul>
      ${s.live?.events?.length ? `<h2>Wat er gebeurde</h2><ul class="events">${s.live.events.slice(0, 10).map((e) => `<li class="${e.level}"><time>${time(e.ts)}</time>${esc(e.message)}</li>`).join("")}</ul>` : ""}
      <p class="msg" id="dmsg"></p>`;
    $("#wake")?.addEventListener("click", async (e) => { try { await busy(e.target, () => api("/api/wake", { method: "POST" })); draw(); } catch (err) { $("#dmsg").textContent = err.message; $("#dmsg").className = "msg err"; } });
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
