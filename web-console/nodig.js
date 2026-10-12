// "Wat je nodig hebt" om aanbieder te worden: de lijst met status per onderdeel, en per onderdeel het regelen ervan.
// Wat via een API kan, doet de app; wat de persoon zelf moet doen (account openen, ID-controle) wordt een begeleide stap.
// De server-kant staat in src/console/benodigdheden.ts (en android/core Benodigdheden.java, met dezelfde JSON).

export const NODIG_CSS = `
.nodig { display: grid; gap: 14px; }
.nodig .sum { display: grid; gap: 8px; }
.nodig .sum b { font-size: var(--fs-1); }
.nodig .bar2 { height: 8px; border-radius: 99px; background: var(--sunk); overflow: hidden; }
.nodig .bar2 i { display: block; height: 100%; background: var(--accent); border-radius: 99px; }
.nodig h3.opt { margin: 10px 0 0; font-size: var(--fs-0); color: var(--muted); font-weight: 700; }
.nlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.nrow { border: 1.5px solid var(--line); border-radius: var(--radius-l); background: var(--panel); }
.nrow.uit { border-color: var(--accent); }
.nrow .head { display: grid; grid-template-columns: 34px 1fr auto; gap: 4px 10px; align-items: start; padding: 14px 14px 14px 12px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.nrow .ico { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 16px; border: 2px solid var(--line); color: var(--muted); background: var(--bg); }
.nrow.ok .ico { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.nrow.bijna .ico { background: var(--warn-soft); border-color: var(--warn); color: var(--warn); }
.nrow .txt { display: grid; gap: 3px; min-width: 0; }
.nrow .txt b { font-size: 16px; }
.nrow .txt .u { color: var(--muted); font-size: 14px; }
.nrow .txt .d { font-size: 14px; }
.nrow.bijna .txt .d { color: var(--warn); }
.nrow .txt .k { color: var(--muted); font-size: 13px; }
.nrow .head .btn { padding: 7px 12px; white-space: nowrap; }
.nrow .body { border-top: 1.5px solid var(--line); padding: 16px; display: grid; gap: 14px; }
.nrow .body .flash { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px dashed var(--line); }
.nrow .body .row { display: flex; gap: 10px; flex-wrap: wrap; }
.nrow .body .row > label { flex: 1 1 160px; }
.chipbig { display: inline-block; padding: 3px 10px; border-radius: 99px; font-weight: 700; font-size: 13px; letter-spacing: .04em; }
.chipbig.test { background: var(--warn-soft); color: var(--warn); border: 1.5px solid var(--warn); }
.chipbig.live { background: var(--accent); color: var(--accent-ink); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 14px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.copyline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.copyline code { background: var(--sunk); padding: 4px 8px; border-radius: var(--radius-s); overflow-wrap: anywhere; }
.recs { display: grid; gap: 8px; font-size: 13px; }
.recs > div { border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 10px; display: grid; gap: 2px; }
.recs code { overflow-wrap: anywhere; }
@media (max-width: 520px) { .nrow .head { grid-template-columns: 30px 1fr; } .nrow .head .btn { grid-column: 2; justify-self: start; } }
dialog.nvenster[open] { max-height: 92vh; overflow: auto; }
dialog.nvenster .nrow { border: 0; background: none; }
dialog.nvenster .nrow .body { border-top: 0; padding: 4px 0 0; }
`;

const ICON = { ok: "✓", bijna: "!", open: "○" };
const STATUS_TEXT = { ok: "Geregeld", bijna: "Bijna", open: "Nog niet" };
let timer = null;

/**
 * De lijst in `box`. ctx: helpers uit console.js ({api, esc, busy, formMsg, resultItems, openBeheer, openUrl, readClipboard,
 * fillKeys, dnsChooser, config, aStep, goHash}) en `a` = GET /api/aanbieder. opts.start: eerste scherm (met Beginnen).
 * opts.open: dit onderdeel meteen openklappen.
 */
export async function renderNodig(box, ctx, opts = {}) {
  clearInterval(timer);
  const { esc } = ctx;
  let l;
  box.innerHTML = `<div class="nodig"><p class="muted" style="margin:0">Nagaan wat er al geregeld is…</p></div>`;
  try { l = await ctx.api(`/api/aanbieder/benodigdheden${opts.fresh ? "?fresh=1" : ""}`); }
  catch (err) { box.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; return; }
  if (!box.isConnected) return;
  const row = (x) => `<li class="nrow ${x.status}" data-id="${esc(x.id)}">
      <div class="head"><span class="ico" aria-hidden="true">${ICON[x.status]}</span>
        <div class="txt"><b>${esc(x.label)}<span class="visually-hidden">: ${esc(STATUS_TEXT[x.status])}</span></b><span class="u">${esc(x.uitleg)}</span>
          <span class="d">${esc(x.detail)}</span>${x.kosten ? `<span class="k">Kosten: ${esc(x.kosten)}</span>` : ""}</div>
        ${x.actie.soort === "hub" && !ctx.a.hub ? "" : `<button type="button" class="btn${x.status === "ok" ? "" : " primary"}" data-actie="${esc(x.id)}">${esc(x.actie.label)}</button>`}</div>
      <div class="body" hidden></div></li>`;
  const must = l.items.filter((x) => !x.optioneel), opt = l.items.filter((x) => x.optioneel);
  const pct = l.totaal ? Math.round((l.klaar / l.totaal) * 100) : 0;
  box.innerHTML = `<div class="nodig">
    <div class="sum"><b>${l.klaar === l.totaal ? "Alles is geregeld" : `${l.klaar} van ${l.totaal} geregeld`}</b>
      <div class="bar2" role="progressbar" aria-valuemin="0" aria-valuemax="${l.totaal}" aria-valuenow="${l.klaar}"><i style="width:${pct}%"></i></div>
      <small class="muted">Wat via een koppeling kan, regelt de app. Een account openen (met je naam, betaalgegevens of een ID-controle) doe je zelf; de app opent de juiste pagina en ziet daarna zelf dat het gelukt is.</small>
      ${opts.start ? `<div><button type="button" class="btn primary" data-start>Beginnen</button></div>` : ""}</div>
    <ul class="nlist">${must.map(row).join("")}</ul>
    <h3 class="opt">Optioneel</h3>
    <ul class="nlist">${opt.map(row).join("")}</ul>
    <p style="margin:0"><button type="button" class="link" id="nFresh">Opnieuw nagaan</button></p>
    ${opts.start ? `<div class="actions" style="margin:0"><button type="button" class="btn primary big" data-start>Beginnen</button></div>` : ""}
  </div>`;
  box.querySelector("#nFresh").onclick = () => renderNodig(box, ctx, { ...opts, fresh: true, open: null });
  box.querySelectorAll("[data-start]").forEach((b) => b.onclick = () => ctx.aStep("bedrijf").then(() => ctx.goHash("aanbieder")).catch(() => {}));
  ctx.links = l.links;
  const items = Object.fromEntries(l.items.map((x) => [x.id, x]));
  box.querySelectorAll("[data-actie]").forEach((b) => b.onclick = () => act(box, ctx, items[b.dataset.actie], l, opts));
  if (opts.open && items[opts.open]?.actie.soort === "paneel") act(box, ctx, items[opts.open], l, opts);
}

/** Alleen de status van de regels (en de samenvatting) bijwerken, zonder het open paneel te sluiten. */
async function updateRows(box, ctx) {
  let l;
  try { l = await ctx.api("/api/aanbieder/benodigdheden?fresh=1"); } catch { return; }
  for (const x of l.items) {
    const li = box.querySelector(`.nrow[data-id="${x.id}"]`);
    if (!li) continue;
    li.classList.remove("ok", "bijna", "open");
    li.classList.add(x.status);
    li.querySelector(".ico").textContent = ICON[x.status];
    li.querySelector(".txt .d").textContent = x.detail;
    const b = li.querySelector("[data-actie]");
    if (b) { b.textContent = x.actie.label; b.classList.toggle("primary", x.status !== "ok"); }
  }
  const sum = box.querySelector(".sum b");
  if (sum) sum.textContent = l.klaar === l.totaal ? "Alles is geregeld" : `${l.klaar} van ${l.totaal} geregeld`;
  const bar = box.querySelector(".bar2 i");
  if (bar) bar.style.width = `${l.totaal ? Math.round((l.klaar / l.totaal) * 100) : 0}%`;
}

/** "Regelen": een paneel onder de regel, of naar de stap of het onderdeel van Je dienst. */
function act(box, ctx, x, l, opts) {
  const li = box.querySelector(`.nrow[data-id="${x.id}"]`);
  if (x.actie.soort === "stap") return ctx.a.hub ? ctx.goHash(`aanbieder/${x.actie.doel}`) : ctx.aStep(x.actie.doel).then(() => ctx.goHash("aanbieder")).catch(() => {});
  if (x.actie.soort === "hub") {
    const h = (ctx.a.hub ?? []).find((y) => y.id === x.actie.doel) ?? (ctx.a.hub ?? []).find((y) => y.id === "huisstijl");
    if (!h) return ctx.goHash("aanbieder/nodig");
    return h.waar === "dienst" ? (h.link ? ctx.openBeheer(h.link) : null) : ctx.goHash(`aanbieder/${h.id}`);
  }
  const body = li.querySelector(".body");
  const opening = body.hidden;
  box.querySelectorAll(".nrow .body").forEach((b) => { b.hidden = true; b.innerHTML = ""; b.parentElement.classList.remove("uit"); });
  clearInterval(timer);
  if (!opening) return;
  body.hidden = false;
  li.classList.add("uit");
  // Na een gelukte actie: de lijst opnieuw nagaan, dit paneel weer open, met de uitkomst (flash) bovenaan.
  const again = (flash) => renderNodig(box, ctx, { ...opts, fresh: true, open: x.id, flash: typeof flash === "string" ? flash : null });
  again.rows = () => updateRows(box, ctx);
  const P = PANELS[x.id];
  if (P) P(body, ctx, again, l);
  if (opts.flash) { body.insertAdjacentHTML("afterbegin", `<div class="flash">${opts.flash}</div>`); opts.flash = null; }
  body.scrollIntoView?.({ block: "nearest" });
}

/** Titel van een onderdeel in een venster (regelVenster). */
const TITELS = { scaleway: "Scaleway met één sleutel", desec: "Gratis deSEC-account", mollie: "Mollie nagaan", mail: "Mail van je Dienst", openprovider: "Openprovider koppelen", domein: "Domein", dns: "DNS voor je domein", adressendienst: "Gratis-adressendienst" };

/**
 * Eén onderdeel regelen in een venster, zonder de lijst eromheen: hetzelfde paneel als in "Wat je nodig hebt". Voor de
 * stap Accounts en Je dienst → Accounts en sleutels (de knoppen "Laat de app het regelen"). onDone(flashHtml) na een
 * gelukte actie; het venster sluit dan.
 */
export async function regelVenster(id, ctx, onDone) {
  const dlg = document.createElement("dialog");
  dlg.className = "confirm nvenster";
  dlg.innerHTML = `<h2>${ctx.esc(TITELS[id] ?? id)}</h2><div class="nodig"><div class="nrow uit" data-id="${ctx.esc(id)}"><div class="body"><p class="muted" style="margin:0">Even kijken…</p></div></div></div>
    <div class="row"><button type="button" class="btn quiet" data-close>Sluiten</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  const close = () => { clearInterval(timer); dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-close]").onclick = close;
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  const body = dlg.querySelector(".body");
  let l;
  try { l = await ctx.api("/api/aanbieder/benodigdheden"); }
  catch (err) { body.innerHTML = `<p class="msg err" style="margin:0">${ctx.esc(err.message)}</p>`; return; }
  ctx.links = l.links;
  const again = (flash) => { close(); onDone?.(typeof flash === "string" ? flash : null); };
  again.rows = () => {};
  PANELS[id]?.(body, ctx, again, l);
}

// ───────── Hulpjes ─────────

const open = (ctx, url) => ctx.openUrl(url);
const linkBtn = (ctx, url, label) => `<button type="button" class="btn" data-open="${ctx.esc(url)}">${ctx.esc(label)}</button>`;
function wireLinks(el, ctx) {
  el.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => open(ctx, b.dataset.open));
  el.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    try { if (ctx.NATIVE?.copy) ctx.NATIVE.copy(b.dataset.copy); else await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Gekopieerd"; }
    catch { b.textContent = "Kopiëren lukt niet"; }
  });
}
const copyLine = (ctx, v) => `<span class="copyline"><code>${ctx.esc(v)}</code><button type="button" class="btn" data-copy="${ctx.esc(v)}">Kopiëren</button></span>`;
const eur = (bedrag) => `€ ${String(bedrag).replace(".", ",")}`;

/** Het resultaat van POST /api/aanbieder/domein: waar de DNS staat, wat er moet, en (vrij) kopen bij Openprovider. */
function domeinResult(el, ctx, r, again) {
  const { esc } = ctx;
  const dsBlock = r.ds?.length && (r.goed === false || r.dnssec === false) ? `<div><small class="muted">DS-gegevens (DNSSEC):</small>${r.ds.map((x) => `<div>${copyLine(ctx, x)}</div>`).join("")}</div>` : "";
  const lines = [];
  if (r.geregistreerd === false) { if (!r.uitleg) lines.push(`<li class="meh">${esc(r.zone)} lijkt nog niet geregistreerd</li>`); }
  else if (r.geregistreerd === null) lines.push(`<li class="unknown">Kon niet nagaan of ${esc(r.zone)} bestaat</li>`);
  else lines.push(`<li>${esc(r.zone)} is geregistreerd${r.bij ? `; de DNS staat bij ${esc(r.bij)}` : ""}<small>${esc(r.nameservers.join(", "))}</small></li>`);
  if (r.doel && r.geregistreerd) lines.push(r.goed ? `<li>De nameservers wijzen naar ${esc(r.doel.naam)}</li>` : `<li class="meh">De nameservers moeten naar ${esc(r.doel.naam)}<small>${esc(r.doel.nameservers.join(", "))}</small></li>`);
  if (r.dnssec === true) lines.push(`<li>DNSSEC staat aan</li>`);
  if (r.dnssec === false && r.goed) lines.push(`<li class="meh">DNSSEC staat nog niet aan</li>`);
  if (r.openprovider?.fout) lines.push(`<li class="unknown">Openprovider: ${esc(r.openprovider.fout)}</li>`);
  const buy = r.geregistreerd === false && r.openprovider?.vrij && r.openprovider.prijs;
  el.innerHTML = `${lines.length ? `<ul class="results">${lines.join("")}</ul>` : ""}
    ${r.uitleg ? `<p style="margin:0">${esc(r.uitleg)}</p>` : ""}${dsBlock}
    ${r.kanDelegeren ? `<div><button type="button" class="btn primary" id="nDel">Zet het voor me goed via Openprovider</button></div>` : ""}
    ${r.geregistreerd === false && !r.openprovider?.gekoppeld ? `<p class="muted" style="margin:0"><small>Koppel Openprovider (hieronder bij Optioneel) om het domein hier te kopen.</small></p>` : ""}
    ${buy ? `<form class="fields panel" id="nBuy"><b>${esc(r.zone)} kopen bij Openprovider</b>
      <p style="margin:0">${esc(eur(r.openprovider.prijs.bedrag))} per jaar (zonder btw), van je Openprovider-tegoed. Het verlengt elk jaar vanzelf; opzeggen doe je bij Openprovider.</p>
      <small class="muted">Houder van het domein (komt in het register). Leeg laten als je bij Openprovider al een houder met je e-mailadres hebt.</small>
      <div class="row"><label>Voornaam<input name="voornaam" autocomplete="given-name"></label><label>Achternaam<input name="achternaam" autocomplete="family-name"></label></div>
      <div class="row"><label>Straat<input name="straat" autocomplete="address-line1"></label><label style="flex:0 1 110px">Huisnummer<input name="huisnummer"></label></div>
      <div class="row"><label style="flex:0 1 130px">Postcode<input name="postcode" autocomplete="postal-code"></label><label>Plaats<input name="plaats" autocomplete="address-level2"></label></div>
      <div class="row"><label>Telefoon<input name="telefoon" type="tel" placeholder="+31 6 12345678" autocomplete="tel"></label><label style="flex:0 1 90px">Land<input name="land" value="NL" maxlength="2"></label></div>
      <label class="check"><input type="checkbox" name="akkoord"> Ja, koop ${esc(r.zone)} voor ${esc(eur(r.openprovider.prijs.bedrag))} per jaar</label>
      <ul class="results" id="nBuyRes"></ul><p class="msg"></p><div><button class="btn primary">Kopen</button></div></form>` : ""}`;
  wireLinks(el, ctx);
  el.querySelector("#nDel")?.addEventListener("click", async (e) => {
    try {
      const d = await ctx.busy(e.target, () => ctx.api("/api/aanbieder/domein/delegeren", { method: "POST", body: { voor: r.voor, zone: r.zone } }));
      again(`<ul class="results">${ctx.resultItems(d.steps)}</ul><p class="muted" style="margin:0"><small>Het kan een paar uur duren voordat iedereen het ziet; de app kijkt vanzelf.</small></p>`);
    } catch (err) { el.insertAdjacentHTML("afterbegin", `<p class="msg err" style="margin:0">${esc(err.message)}</p>`); }
  });
  const f = el.querySelector("#nBuy");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    if (!f.akkoord.checked) return ctx.formMsg(f, "Vink eerst aan dat je het domein wilt kopen.");
    const houder = Object.fromEntries(["voornaam", "achternaam", "straat", "huisnummer", "postcode", "plaats", "telefoon", "land"].map((n) => [n, f[n].value]));
    try {
      const k = await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/domein/kopen", { method: "POST", body: { voor: r.voor, zone: r.zone, prijs: r.openprovider.prijs.bedrag, akkoord: true, houder } }));
      f.querySelector("#nBuyRes").innerHTML = ctx.resultItems(k.steps);
      again(`<ul class="results">${ctx.resultItems(k.steps)}</ul>`);
    } catch (err) { if (err.data?.steps) f.querySelector("#nBuyRes").innerHTML = ctx.resultItems(err.data.steps); ctx.formMsg(f, err.message); }
  };
}

async function checkDomein(el, ctx, body, again) {
  el.innerHTML = `<p class="muted" style="margin:0">Nagaan waar de DNS staat…</p>`;
  try { domeinResult(el, ctx, await ctx.api("/api/aanbieder/domein", { method: "POST", body }), again); }
  catch (err) { el.innerHTML = `<p class="msg err" style="margin:0">${ctx.esc(err.message)}</p>`; }
}

// ───────── Panelen ─────────

function pDomein(body, ctx, again) {
  const { esc, a } = ctx;
  body.innerHTML = `<form class="fields" id="nf"><label>Adres van je Dienst<input name="url" value="${esc(a.url ?? a.defaultUrl ?? "")}" placeholder="dienst.jouwbedrijf.nl" autocapitalize="off" spellcheck="false" required>
      <small>Een naam onder je eigen domein, bijvoorbeeld dienst.jouwbedrijf.nl. Nog geen domein? Vul het gewenste adres in; de app kijkt of het nog vrij is.</small></label>
    ${a.server ? `<p class="note warn" style="margin:0">Een nieuw adres gaat pas in na <b>Opnieuw opzetten</b>.</p>` : ""}
    <p class="msg"></p><div><button class="btn primary">Opslaan en nagaan</button></div></form><div id="nRes" class="fields"></div>`;
  const f = body.querySelector("#nf");
  if (a.url) checkDomein(body.querySelector("#nRes"), ctx, {}, again);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/adres", { method: "POST", body: { url: f.url.value } }));
      ctx.a.url = "https://" + f.url.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      ctx.formMsg(f, "Opgeslagen.", true);
      checkDomein(body.querySelector("#nRes"), ctx, {}, again);
      again.rows();
    } catch (err) { ctx.formMsg(f, err.message); }
  };
}

function pDns(body, ctx, again) {
  const { a } = ctx;
  if (!a.url) { body.innerHTML = `<p style="margin:0">Kies eerst het adres van je Dienst (Domein, hierboven).</p>`; return; }
  body.innerHTML = `<form class="fields" id="nf"><div id="nDnsKeuze" class="fields"></div><p class="msg"></p><div><button class="btn primary">Opslaan</button></div></form>
    <div id="nRes" class="fields"></div>`;
  const ui = ctx.dnsChooser(body.querySelector("#nDnsKeuze"), a, null);
  const f = body.querySelector("#nf"), res = body.querySelector("#nRes");
  const check = () => (a.dnsLink ? checkDomein(res, ctx, {}, again) : null);
  check();
  // Zolang dit paneel open is: elke halve minuut opnieuw kijken of de nameservers al goed staan.
  timer = setInterval(() => { if (!res.isConnected) return clearInterval(timer); if (!res.querySelector("form")) check(); }, 30_000);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await ctx.busy(f.querySelector("button.primary"), () => ui.save());
      ctx.formMsg(f, r?.detail ?? "Opgeslagen.", !r?.detail);
      ctx.a = await ctx.api("/api/aanbieder");
      if (ctx.a.dnsLink) checkDomein(res, ctx, {}, again); else res.innerHTML = "";
      again.rows();
    } catch (err) { ctx.formMsg(f, err.message); }
  };
}

function pScaleway(body, ctx, again, l) {
  const { esc } = ctx;
  const klaar = l.items.find((x) => x.id === "scaleway")?.status === "ok";
  body.innerHTML = `${klaar ? `<p style="margin:0">Je Dienst heeft een eigen sleutel bij Scaleway. Opnieuw doen kan altijd: er komt niets dubbel.</p><details><summary>Opnieuw met een sleutel</summary>` : ""}<ol class="guide">
      <li><b>Een account bij Scaleway.</b> Met je bedrijfsgegevens en een betaalmethode; dat doe je zelf.
        <div>${linkBtn(ctx, ctx.links.scaleway.aanmelden, "Account maken")} <span class="muted">Heb je er al een? Sla deze stap over.</span></div></li>
      <li><b>Eén API-sleutel voor jezelf.</b> Kies <i>Generate API key</i>, bij <i>Bearer</i> jezelf (niet een applicatie), zonder vervaldatum. Kopieer de twee sleutels die Scaleway één keer laat zien.
        <div>${linkBtn(ctx, ctx.links.scaleway.sleutels, "Sleutelpagina openen")}</div></li>
      <li><b>Plak ze hier.</b> De app maakt daarmee een eigen applicatie <i>eigen-cloud-dienst</i> met alleen de rechten die je Dienst nodig heeft (projecten, sleutels, servers, opslag en mail), en een eigen sleutel daarvoor. Het organisatie-ID zoekt de app zelf op.</li>
    </ol>
    <form class="fields" id="nf">
      <label>Toegangssleutel<div class="paste"><input name="accessKey" placeholder="SCW…" autocomplete="off" autocapitalize="characters" spellcheck="false" required><button type="button" class="btn" data-paste>Plakken</button></div></label>
      <label>Geheime sleutel<div class="paste"><input name="secretKey" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" spellcheck="false" required><button type="button" class="btn" data-paste>Plakken</button></div></label>
      <label class="check"><input type="checkbox" name="verwijderen" checked> Mijn eigen sleutel daarna weggooien (aanbevolen)<small>Je Dienst krijgt zijn eigen sleutel; je persoonlijke sleutel is dan niet meer nodig.</small></label>
      <ul class="results" id="nRes"></ul><p class="msg"></p><div><button class="btn primary">Regel de rest</button></div></form>${klaar ? "</details>" : ""}`;
  wireLinks(body, ctx);
  const f = body.querySelector("#nf");
  f.querySelectorAll("[data-paste]").forEach((b) => b.onclick = async () => {
    const t = await ctx.readClipboard();
    if (!ctx.fillKeys(f, t)) { if (t) b.previousElementSibling.value = t.trim(); else ctx.formMsg(f, "Het klembord is leeg. Plak met lang drukken in het veld."); }
  });
  f.accessKey.addEventListener("paste", (e) => { if (ctx.fillKeys(f, e.clipboardData?.getData("text"))) e.preventDefault(); });
  f.secretKey.addEventListener("paste", (e) => { if (ctx.fillKeys(f, e.clipboardData?.getData("text"))) e.preventDefault(); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const res = body.querySelector("#nRes");
    res.innerHTML = `<li class="busy">Bezig: sleutel bekijken, applicatie en rechten maken, eigen sleutel maken…</li>`;
    try {
      const r = await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/scaleway", { method: "POST", body: { accessKey: f.accessKey.value, secretKey: f.secretKey.value, verwijderen: f.verwijderen.checked } }));
      again(`<ul class="results">${ctx.resultItems(r.steps)}</ul><p class="msg ok" style="margin:0">Klaar. Je Dienst heeft een eigen sleutel in organisatie ${esc(r.org)}.</p>`);
    } catch (err) { res.innerHTML = ctx.resultItems(err.data?.steps ?? []); ctx.formMsg(f, err.message); }
  };
}

function mollieResult(el, ctx, r) {
  const { esc } = ctx;
  const has = (list, id) => list.includes(id);
  el.innerHTML = `<div class="panel" style="margin:0">
      <div><span class="chipbig ${r.mode}">${r.mode === "live" ? "LIVE" : "TEST"}</span> <span class="muted">${r.mode === "live" ? "Echte betalingen" : "Nep-betalingen om te proberen"}</span></div>
      <dl class="kv"><dt>Profiel</dt><dd>${esc(r.profiel?.naam || "?")}${r.profiel?.website ? ` · ${esc(r.profiel.website)}` : ""}</dd>
        <dt>Status</dt><dd>${esc({ verified: "Goedgekeurd door Mollie", unverified: "Nog niet goedgekeurd", blocked: "Geblokkeerd" }[r.profiel?.status] ?? r.profiel?.status ?? "")}</dd></dl>
      <ul class="results">
        <li class="${has(r.methoden.eerste, "ideal") ? "" : "bad"}">iDEAL voor de eerste betaling</li>
        <li class="${has(r.methoden.terugkerend, "directdebit") ? "" : "bad"}">SEPA-incasso voor elke maand</li>
      </ul>
      ${r.todo.length ? `<div><b>Nog te doen</b><ul class="results">${r.todo.map((t) => `<li class="meh">${esc(t.tekst)}${t.link ? `<small><button type="button" class="link" data-open="${esc(t.link)}">Mollie-dashboard openen</button></small>` : ""}</li>`).join("")}</ul></div>` : `<p class="msg ok" style="margin:0">Alles staat aan.</p>`}
      ${r.test ? `<p class="note warn" style="margin:0">${esc(r.test)}</p>` : ""}
      ${r.pending ? `<p class="muted" style="margin:0"><small>Je Dienst gebruikt de nieuwe sleutel na <b>Wijzigingen toepassen</b> (bovenaan Je dienst).</small></p>` : ""}
      <p class="muted" style="margin:0"><small>${esc(r.onboarding)}</small></p></div>`;
  wireLinks(el, ctx);
}

function pMollie(body, ctx, again) {
  const { a } = ctx;
  body.innerHTML = `<ol class="guide">
      <li><b>Een account bij Mollie.</b> Met je bedrijfsgegevens; Mollie controleert je identiteit en je bankrekening. Dat doe je zelf.
        <div>${linkBtn(ctx, ctx.links.mollie.aanmelden, "Account maken")}</div></li>
      <li><b>Kopieer een API-sleutel.</b> Begin met de testsleutel (test_…); de live-sleutel (live_…) werkt zodra Mollie je account heeft goedgekeurd.
        <div>${linkBtn(ctx, ctx.links.mollie.sleutels, "Sleutels bij Mollie")}</div></li>
    </ol>
    <form class="fields" id="nf"><label>API-sleutel<input name="key" value="${ctx.esc(a.accounts?.mollieKey ?? "")}" placeholder="test_… of live_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <p class="msg"></p><div><button class="btn primary">Controleren</button></div></form><div id="nRes"></div>`;
  wireLinks(body, ctx);
  const f = body.querySelector("#nf"), res = body.querySelector("#nRes");
  const run = async (btn, key) => {
    try { mollieResult(res, ctx, await ctx.busy(btn, () => ctx.api("/api/aanbieder/mollie", { method: "POST", body: key === undefined ? {} : { key } }))); ctx.formMsg(f, ""); if (key !== undefined) again.rows(); }
    catch (err) { res.innerHTML = ""; ctx.formMsg(f, err.message); }
  };
  if (a.accounts?.mollieKey) run(f.querySelector("button.primary"));
  f.onsubmit = (e) => { e.preventDefault(); run(f.querySelector("button.primary"), f.key.value); };
}

function mailResult(el, ctx, r) {
  const { esc } = ctx;
  el.innerHTML = !r.manier ? "" : `<div class="panel" style="margin:0"><ul class="results">
      <li class="${r.werkt ? "" : "bad"}">${r.werkt ? "Inloggen bij de mailserver werkt" : "Inloggen bij de mailserver lukt niet"}<small>${esc(r.smtp ?? "")}${r.afzender ? ` · afzender ${esc(r.afzender)}` : ""}</small></li>
      ${r.manier === "scaleway" ? `<li class="${r.status === "checked" ? "" : "meh"}">${r.status === "checked" ? `Scaleway heeft ${esc(r.domein)} goedgekeurd` : `Scaleway controleert ${esc(r.domein)}`}<small>${r.status === "checked" ? "" : "Dat duurt meestal een paar minuten tot een uur."}</small></li>` : ""}</ul>
    ${r.records?.length ? `<div class="recs">${r.records.map((x) => `<div><b>${esc(x.type)} ${esc(x.naam)}</b>${x.gezet ? `<small class="muted">Door de app in je DNS gezet</small>` : `<small class="muted">Zet dit record zelf bij je DNS:</small>${copyLine(ctx, x.waarde)}`}</div>`).join("")}</div>` : ""}
    ${r.manier === "scaleway" && r.status !== "checked" ? `<div><button type="button" class="btn" id="nMailAgain">Opnieuw nagaan</button></div>` : ""}
    ${r.pending ? `<p class="muted" style="margin:0"><small>Je Dienst gebruikt dit na <b>Wijzigingen toepassen</b>.</small></p>` : ""}</div>`;
  wireLinks(el, ctx);
  el.querySelector("#nMailAgain")?.addEventListener("click", async (e) => {
    try { mailResult(el, ctx, await ctx.busy(e.target, () => ctx.api("/api/aanbieder/mail"))); } catch { /* volgende keer */ }
  });
}

function pMail(body, ctx, again, l) {
  const scwOk = l.items.find((x) => x.id === "scaleway")?.status === "ok";
  const cloud = !!ctx.config?.mailRelay;
  body.innerHTML = `<form class="fields" id="nf">
      <label class="check"><input type="radio" name="manier" value="scaleway" ${scwOk ? "checked" : "disabled"}> Regel het via Scaleway (aanbevolen)<small>${scwOk ? "De app meldt het adres van je Dienst aan als maildomein, zet de records in je DNS en vult de mailserver in. Meestal gratis." : "Regel eerst Scaleway (hierboven)."}</small></label>
      ${cloud ? `<label class="check"><input type="radio" name="manier" value="cloud" ${scwOk ? "" : "checked"}> Via de mail van je eigen cloud</label>` : ""}
      <label class="check"><input type="radio" name="manier" value="smtp" ${!scwOk && !cloud ? "checked" : ""}> Een eigen mailserver (SMTP)</label>
      <div id="nSmtp" class="row" hidden><label>Mailserver<input name="smtpUrl" placeholder="smtp://gebruiker:wachtwoord@server:587" autocomplete="off" spellcheck="false"></label><label>Afzender<input name="mailFrom" type="email" placeholder="noreply@jouwbedrijf.nl"></label></div>
      <p class="msg"></p><div><button class="btn primary">Instellen</button></div></form><div id="nRes"></div>`;
  const f = body.querySelector("#nf"), res = body.querySelector("#nRes");
  const sync = () => { body.querySelector("#nSmtp").hidden = f.querySelector("input[name=manier]:checked")?.value !== "smtp"; };
  f.querySelectorAll("input[name=manier]").forEach((r) => r.onchange = sync);
  sync();
  ctx.api("/api/aanbieder/mail").then((r) => mailResult(res, ctx, r)).catch(() => {});
  f.onsubmit = async (e) => {
    e.preventDefault();
    const manier = f.querySelector("input[name=manier]:checked")?.value;
    try {
      const r = await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/mail", { method: "POST", body: { manier, smtpUrl: f.smtpUrl.value, mailFrom: f.mailFrom.value } }));
      mailResult(res, ctx, r);
      ctx.formMsg(f, r.detail ?? "Ingesteld.", r.werkt);
      again.rows();
    } catch (err) { ctx.formMsg(f, err.message); }
  };
}

function pDesec(body, ctx, again, l) {
  const { esc, a } = ctx;
  const acc = a.accounts ?? {};
  const wacht = !acc.desecToken && l.items.find((x) => x.id === "desec")?.status === "bijna";
  const wait = () => {
    body.innerHTML = `<div class="fields"><b>Kijk in je mail</b>
      <p style="margin:0">deSEC heeft een bevestigingslink gestuurd. Klik erop en kom daarna hier terug.</p>
      <label class="check"><input type="checkbox" id="nAdr" ${a.adressen ? "checked" : ""}> Ook een token voor de gratis-adressendienst<small>Alleen voor de beheerders van het project: dat token mag ook tokens maken.</small></label>
      <p class="msg" id="nMsg"></p><div><button class="btn primary" id="nClicked">Ik heb op de link geklikt</button> <button type="button" class="link" id="nRedo">Opnieuw beginnen</button></div></div>`;
    body.querySelector("#nClicked").onclick = async (e) => {
      const m = body.querySelector("#nMsg");
      try {
        const r = await ctx.busy(e.target, () => ctx.api("/api/aanbieder/desec/finish", { method: "POST", body: { adressen: body.querySelector("#nAdr").checked } }));
        if (r.pending) { m.textContent = "Nog niet bevestigd. Duurt het lang? Kijk ook in je spammap."; m.className = "msg err"; return; }
        again(`<p class="msg ok" style="margin:0">Account klaar. Je Dienst heeft een token dat zones mag maken en weghalen${r.tokens.includes("adressen") ? ", en de adressendienst een token dat ook tokens mag maken" : ""}.</p>`);
      } catch (err) { m.textContent = err.message; m.className = "msg err"; }
    };
    body.querySelector("#nRedo").onclick = () => signup();
  };
  const signup = async () => {
    body.innerHTML = `<form class="fields" id="nf"><b>Laat de app een gratis account maken</b>
        <label>E-mailadres voor het account<input type="email" name="email" required value="${esc(a.company?.email ?? "")}"><small>deSEC stuurt hier een bevestigingslink naartoe.</small></label>
        <div class="captcha"><img id="nCap" alt="Plaatje met tekens"><button type="button" class="link" id="nCapNew">Ander plaatje</button></div>
        <label>Tekens uit het plaatje<input name="solution" autocomplete="off" autocapitalize="characters" required></label>
        <p class="msg"></p><div><button class="btn primary">Account maken</button></div></form>
      <details><summary>Ik heb al een token</summary><form class="fields" id="nTok" style="margin-top:10px"><label>Token<input name="token" autocomplete="off" spellcheck="false"><small>Een token dat domeinen mag aanmaken en weghalen (desec.io → Token Management).</small></label><p class="msg"></p><div><button class="btn">Bewaren en controleren</button></div></form></details>`;
    const f = body.querySelector("#nf");
    let capId = null;
    const load = async () => {
      try { const c = await ctx.api("/api/desec/captcha", { method: "POST" }); capId = c.id; body.querySelector("#nCap").src = `data:image/png;base64,${c.challenge}`; f.solution.value = ""; }
      catch (err) { ctx.formMsg(f, err.message); }
    };
    body.querySelector("#nCapNew").onclick = load;
    load();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/desec/register", { method: "POST", body: { captchaId: capId, solution: f.solution.value, email: f.email.value } })); wait(); }
      catch (err) { ctx.formMsg(f, err.message); load(); }
    };
    const t = body.querySelector("#nTok");
    t.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await ctx.busy(t.querySelector("button"), () => ctx.api("/api/aanbieder/accounts", { method: "POST", body: { desecToken: t.token.value } }));
        const d = r.checks.find((x) => x.id === "desec");
        ctx.formMsg(t, d?.detail ?? "Bewaard.", !!d?.ok);
        if (d?.ok) again(`<p class="msg ok" style="margin:0">${esc(d.detail)}</p>`);
      } catch (err) { ctx.formMsg(t, err.message); }
    };
  };
  if (wacht) wait();
  else if (acc.desecToken) {
    body.innerHTML = `<p style="margin:0">Je Dienst heeft een deSEC-token (${esc(acc.desecToken)}).</p>
      <div class="actions" style="margin:0"><button type="button" class="btn" id="nNew">Nieuw account of ander token</button></div>`;
    body.querySelector("#nNew").onclick = () => signup();
  } else signup();
}

function pOpenprovider(body, ctx, again) {
  const { esc, a } = ctx;
  const acc = a.accounts ?? {};
  body.innerHTML = `<ol class="guide">
      <li><b>Een reseller-account bij Openprovider</b>, met tegoed voor de domeinen. Dat doe je zelf.
        <div>${linkBtn(ctx, "https://www.openprovider.com", "Openprovider")}</div></li>
      <li><b>API-toegang aanzetten.</b> In het controlepaneel: Account → Contactpersonen → je naam → API → API-toegang aan.
        <div>${linkBtn(ctx, ctx.links.openprovider, "Controlepaneel openen")}</div></li>
    </ol>
    <form class="fields" id="nf"><div class="row"><label>Gebruikersnaam<input name="gebruiker" value="${esc(acc.openproviderUser ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label>Wachtwoord<input name="wachtwoord" type="password" placeholder="${acc.openproviderPass ? "Bewaard; leeg laten = zo laten" : ""}" autocomplete="off"></label></div>
      <p class="msg"></p><div><button class="btn primary">Koppelen en nagaan</button></div></form><div id="nRes"></div>`;
  wireLinks(body, ctx);
  const f = body.querySelector("#nf"), res = body.querySelector("#nRes");
  const show = (r) => {
    res.innerHTML = `<div class="panel" style="margin:0"><ul class="results">
        <li class="${r.login.ok ? "" : "bad"}">${esc(r.login.detail)}</li>
        ${r.dienst ? `<li class="${r.dienst.ok ? "" : "bad"}">Vanaf de server van je Dienst<small>${esc(r.dienst.detail)}</small></li>` : ""}
      </ul>
      ${r.ip.adressen.length ? `<div><small class="muted">IP-adres van je server:</small>${r.ip.adressen.map((x) => `<div>${copyLine(ctx, x)}</div>`).join("")}</div>` : ""}
      <p style="margin:0"><small>${esc(r.ip.uitleg)}</small></p>
      ${r.ip.status === "handmatig" || (r.dienst && !r.dienst.ok) ? `<div class="actions" style="margin:0">${linkBtn(ctx, r.link, "Openprovider openen")}<button type="button" class="btn" id="nOpAgain">Opnieuw nagaan</button></div>` : ""}
      ${r.pending ? `<p class="muted" style="margin:0"><small>Gewijzigd? Je Dienst gebruikt het na <b>Wijzigingen toepassen</b>.</small></p>` : ""}</div>`;
    wireLinks(res, ctx);
    res.querySelector("#nOpAgain")?.addEventListener("click", async (e) => {
      try { const c = await ctx.busy(e.target, () => ctx.api("/api/aanbieder/openprovider")); show({ ...r, dienst: c.dienst }); } catch { /* */ }
    });
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { show(await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/openprovider", { method: "POST", body: { gebruiker: f.gebruiker.value, wachtwoord: f.wachtwoord.value } }))); ctx.formMsg(f, ""); again.rows(); }
    catch (err) { ctx.formMsg(f, err.message); }
  };
}

/** Per onderdeel het paneel onder "Regelen". */
const PANELS = { domein: pDomein, dns: pDns, scaleway: pScaleway, mollie: pMollie, mail: pMail, desec: pDesec, openprovider: pOpenprovider, adressendienst: pAdressen };

function pAdressen(body, ctx, again) {
  const { esc, a } = ctx;
  body.innerHTML = `<p style="margin:0"><small class="muted">De gratis-adressendienst draait mee op de server van je Dienst en heeft een eigen domein nodig (de gedeelde zone, bijvoorbeeld eigencloud.nl), bij deSEC, met een token dat tokens mag beheren (bij deSEC hierboven: "Ook een token voor de gratis-adressendienst").</small></p>
    <form class="fields" id="nf"><label>Gedeelde zone<input name="zone" value="${esc(a.adressen?.zone ?? "")}" placeholder="eigencloud.nl" autocapitalize="off" spellcheck="false" required></label>
      <p class="msg"></p><div class="actions" style="margin:0"><button class="btn primary">Nagaan</button>${a.hub ? `<a class="btn" href="#aanbieder/adressendienst">Aan- of uitzetten</a>` : ""}</div></form>
    <div id="nRes" class="fields"></div>`;
  const f = body.querySelector("#nf"), res = body.querySelector("#nRes");
  if (a.adressen?.zone) checkDomein(res, ctx, { voor: "adressen", zone: a.adressen.zone }, again);
  f.onsubmit = (e) => { e.preventDefault(); checkDomein(res, ctx, { voor: "adressen", zone: f.zone.value }, again); };
}
