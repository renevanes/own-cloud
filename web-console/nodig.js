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
.nmodus { border: 0; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.nmodus legend { font-weight: 700; margin-bottom: 8px; padding: 0; }
.nkeus { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: start; padding: 12px 14px; border: 1.5px solid var(--line); border-radius: var(--radius-l); background: var(--panel); cursor: pointer; }
.nkeus input { margin: 3px 0 0; accent-color: var(--accent); width: auto; }
.nkeus b { font-size: 15px; }
.nkeus small { grid-column: 2; color: var(--muted); font-size: 13px; }
.nkeus.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.ngratis { border-left: 4px solid var(--accent); background: var(--accent-soft); padding: 12px 14px; border-radius: var(--radius-s); display: grid; gap: 6px; }
.ngratis b { font-size: 15px; }
.ngratis ul { margin: 0; padding-left: 18px; font-size: 13px; display: grid; gap: 2px; }
.ngratis small { font-size: 12px; }
.nwarn { margin: 0; display: grid; gap: 10px; }
.nwarn .actions { margin: 0; }
.nrow .txt .route { justify-self: start; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--text); }
.nrow .txt .route.niet { background: var(--sunk); color: var(--muted); }
.proefkeus { display: grid; gap: 10px; }
.proefkeus .pk { border: 1.5px solid var(--line); border-radius: var(--radius-l); padding: 12px 14px; display: grid; gap: 6px; background: var(--panel); }
.proefkeus .pk.on { border-color: var(--accent); }
.proefkeus .pk p { margin: 0; font-size: 14px; }
.proefkeus .pk small { color: var(--muted); font-size: 13px; }
.tegoed { height: 8px; border-radius: 99px; background: var(--sunk); overflow: hidden; }
.tegoed i { display: block; height: 100%; background: var(--accent); }
.tegoed.laag i { background: var(--warn); }
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
          <span class="d">${esc(x.detail)}</span>${x.route ? `<span class="route${/^Niet nodig/.test(x.route) ? " niet" : ""}">${esc(x.route)}</span>` : ""}${x.kosten ? `<span class="k">Kosten: ${esc(x.kosten)}</span>` : ""}</div>
        ${x.actie.soort === "hub" && !ctx.a.hub ? "" : `<button type="button" class="btn${x.status === "ok" ? "" : " primary"}" data-actie="${esc(x.id)}">${esc(x.actie.label)}</button>`}</div>
      <div class="body" hidden></div></li>`;
  const must = l.items.filter((x) => !x.optioneel), opt = l.items.filter((x) => x.optioneel);
  const pct = l.totaal ? Math.round((l.klaar / l.totaal) * 100) : 0;
  const gratis = l.modus === "gratis";
  box.innerHTML = `<div class="nodig">
    ${l.waarschuwing ? `<div class="note warn nwarn"><div><b>${esc(l.waarschuwing.titel)}</b><br><small>${esc(l.waarschuwing.tekst)}</small></div>
      <div class="actions"><button type="button" class="btn primary" data-verhuis>Verhuizen naar een betaalde server</button></div></div>` : ""}
    <fieldset class="nmodus"><legend>Hoe wil je beginnen?</legend>
      <label class="nkeus${gratis ? " on" : ""}"><input type="radio" name="nmodus" value="gratis" ${gratis ? "checked" : ""}><b>Zo gratis mogelijk beginnen</b>
        <small>Een gratis adres bij deSEC, een server op starttegoed en gratis mail. Later verhuist de app je Dienst met één tik naar een betaalde server.</small></label>
      <label class="nkeus${gratis ? "" : " on"}"><input type="radio" name="nmodus" value="standaard" ${gratis ? "" : "checked"}><b>Standaard</b>
        <small>Een eigen domein en een betaalde server vanaf het begin.</small></label>
    </fieldset>
    ${gratis && l.kosten ? `<div class="ngratis"><b>${esc(l.kosten.tekst)}</b><ul>${l.kosten.regels.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><small class="muted">${esc(l.kosten.buiten)}</small></div>` : ""}
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
  box.querySelectorAll("input[name=nmodus]").forEach((r) => r.onchange = async () => {
    try { await ctx.api("/api/aanbieder/modus", { method: "POST", body: { modus: r.value } }); } catch { /* blijft zoals het was */ }
    renderNodig(box, ctx, { ...opts, fresh: false, open: null });
  });
  box.querySelectorAll("[data-verhuis]").forEach((b) => b.onclick = () => verhuisVenster(ctx, (flash) => renderNodig(box, ctx, { ...opts, fresh: true, open: "server", flash })));
  ctx.nodig = l;
  ctx.openRow = (id) => { const x = l.items.find((y) => y.id === id); if (x) act(box, ctx, x, l, opts); };
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
    const k = li.querySelector(".txt .k");
    if (k && x.kosten) k.textContent = `Kosten: ${x.kosten}`;
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
const TITELS = { scaleway: "Scaleway met één sleutel", desec: "Gratis deSEC-account", mollie: "Mollie nagaan", mail: "Mail van je Dienst", openprovider: "Openprovider koppelen", domein: "Domein", dns: "DNS voor je domein", adressendienst: "Gratis-adressendienst", server: "Server op starttegoed" };

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
  ctx.nodig = l;
  ctx.openRow = (other) => { close(); regelVenster(other, ctx, onDone); };
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
  if (ctx.nodig?.modus === "gratis") return pDomeinGratis(body, ctx, again);
  return pDomeinEigen(body, ctx, again);
}

/** Zo gratis mogelijk: een naam bij deSEC (naam.dedyn.io), nagaan of hij vrij is, maken en wachten tot hij werkt. */
function pDomeinGratis(body, ctx, again) {
  const { esc, a } = ctx;
  const host = (a.url ?? "").replace(/^https:\/\//, "");
  const dedyn = /^[^.]+\.dedyn\.io$/.test(host);
  const token = !!a.accounts?.desecToken;
  const naam = (a.gratisAdres?.naam ?? (dedyn ? host : "")).replace(/\.dedyn\.io$/, "");
  body.innerHTML = `<form class="fields" id="nGa">
      <p style="margin:0">deSEC geeft je gratis een eigen naam onder <b>dedyn.io</b>, met DNSSEC. Dat wordt het adres van je Dienst, bijvoorbeeld <b>jouwbedrijf.dedyn.io</b>. Eén gratis adres per deSEC-account.</p>
      ${token ? "" : `<p class="note warn" style="margin:0">Hiervoor heb je eerst een gratis deSEC-account nodig; de app maakt het voor je. <button type="button" class="link" id="nGaDesec">deSEC-account maken</button></p>`}
      <label>Naam van je gratis adres<div class="suffix"><input name="naam" value="${esc(naam)}" placeholder="jouwbedrijf" autocapitalize="off" spellcheck="false" autocomplete="off" required><span>.dedyn.io</span></div>
        <small>Kleine letters, cijfers en streepjes.</small></label>
      ${a.server && host && !dedyn ? `<p class="note warn" style="margin:0">Een nieuw adres gaat pas in na <b>Opnieuw opzetten</b>.</p>` : ""}
      <div class="actions" style="margin:0"><button type="button" class="btn" id="nGaCheck" ${token ? "" : "disabled"}>Nagaan of hij vrij is</button><button class="btn primary" ${token ? "" : "disabled"}>Maak dit adres</button></div>
      <div id="nGaRes"></div><p class="msg"></p></form>
    <details${host && !dedyn ? " open" : ""}><summary>Ik heb een eigen domein</summary><div id="nEigen" class="fields" style="margin-top:10px"></div></details>`;
  pDomeinEigen(body.querySelector("#nEigen"), ctx, again, { leeg: dedyn });
  body.querySelector("#nGaDesec")?.addEventListener("click", () => ctx.openRow?.("desec"));
  const f = body.querySelector("#nGa"), res = body.querySelector("#nGaRes");
  const show = (r) => {
    const cls = { vrij: "ok", klaar: "ok", "van-jou": "ok", wacht: "", bezet: "err", ander: "err", onbekend: "" }[r.status] ?? "";
    res.innerHTML = `<p class="msg ${cls}" style="margin:0">${esc(r.uitleg)}</p>
      ${r.status === "wacht" ? `<p class="muted" style="margin:0"><small>Je kunt intussen verder met de rest van de lijst.</small></p>` : ""}
      ${r.status === "ander" ? `<div><button type="button" class="btn" id="nGaAnder">${esc(r.ander)} gebruiken</button></div>` : ""}`;
    res.querySelector("#nGaAnder")?.addEventListener("click", (e) => run(e.target, r.ander, true));
    clearInterval(timer);
    // deSEC zet de naam in dedyn.io; zolang dat duurt, elke 15 seconden opnieuw kijken.
    if (r.status === "wacht") timer = setInterval(async () => {
      if (!res.isConnected) return clearInterval(timer);
      try { const n = await ctx.api("/api/aanbieder/gratis-adres", { method: "POST", body: { naam: r.naam } }); if (n.status !== "wacht") { clearInterval(timer); show(n); again.rows(); } } catch { /* volgende keer */ }
    }, 15_000);
  };
  const run = async (btn, naamIn, maken) => {
    if (maken) res.innerHTML = `<p class="muted" style="margin:0">Bezig: deSEC maakt je adres. Dat kan een halve minuut duren…</p>`;
    try {
      const r = await ctx.busy(btn, () => ctx.api("/api/aanbieder/gratis-adres", { method: "POST", body: { naam: naamIn, maken } }));
      ctx.formMsg(f, "");
      if (maken && r.gebruikt) { ctx.a = await ctx.api("/api/aanbieder"); again.rows(); }
      show(r);
    } catch (err) { res.innerHTML = ""; ctx.formMsg(f, err.message); }
  };
  body.querySelector("#nGaCheck").onclick = (e) => run(e.target, f.naam.value, false);
  f.onsubmit = (e) => { e.preventDefault(); run(f.querySelector("button.primary"), f.naam.value, true); };
  if (token && dedyn && a.gratisAdres?.naam === host) run(body.querySelector("#nGaCheck"), host, false);
}

function pDomeinEigen(body, ctx, again, opts = {}) {
  const { esc, a } = ctx;
  body.innerHTML = `<form class="fields" id="nf"><label>Adres van je Dienst<input name="url" value="${esc(opts.leeg ? "" : a.url ?? a.defaultUrl ?? "")}" placeholder="dienst.jouwbedrijf.nl" autocapitalize="off" spellcheck="false" required>
      <small>Een naam onder je eigen domein, bijvoorbeeld dienst.jouwbedrijf.nl. Nog geen domein? Vul het gewenste adres in; de app kijkt of het nog vrij is.</small></label>
    ${a.server ? `<p class="note warn" style="margin:0">Een nieuw adres gaat pas in na <b>Opnieuw opzetten</b>.</p>` : ""}
    <p class="msg"></p><div><button class="btn primary">Opslaan en nagaan</button></div></form><div id="nRes" class="fields"></div>`;
  const f = body.querySelector("#nf");
  if (a.url && !opts.leeg) checkDomein(body.querySelector("#nRes"), ctx, {}, again);
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
      <li><b>Een account bij Scaleway.</b> Met je bedrijfsgegevens en een betaalmethode; dat doe je zelf.${ctx.nodig?.modus === "gratis" ? ` Een account is gratis. Scaleway vraagt wel een betaalmethode voordat je iets kunt gebruiken: een creditcard (met een controlebedrag van € 1 dat je terugkrijgt) of SEPA-incasso (met een identiteitscontrole). Je hebt het toch nodig voor de clouds van je klanten en voor de mail.` : ""}
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
      <li class="${r.werkt ? "" : "bad"}">${/^scwtem:/.test(r.smtp ?? "") ? (r.werkt ? "Mail versturen via de webkoppeling van Scaleway werkt" : "Mail versturen via Scaleway lukt niet") : r.werkt ? "Inloggen bij de mailserver werkt" : "Inloggen bij de mailserver lukt niet"}<small>${/^scwtem:/.test(r.smtp ?? "") ? "Via HTTPS, zonder SMTP" : esc(r.smtp ?? "")}${r.afzender ? ` · afzender ${esc(r.afzender)}` : ""}</small></li>
      ${r.manier === "scaleway" ? `<li class="${r.status === "checked" ? "" : "meh"}">${r.status === "checked" ? `Scaleway heeft ${esc(r.domein)} goedgekeurd` : `Scaleway controleert ${esc(r.domein)}`}<small>${r.status === "checked" ? "" : "Dat duurt meestal een paar minuten tot een uur."}</small></li>` : ""}</ul>
    ${r.records?.length ? `<div class="recs">${r.records.map((x) => `<div><b>${esc(x.type)} ${esc(x.naam)}</b>${x.gezet ? `<small class="muted">Door de app in je DNS gezet</small>` : `<small class="muted">Zet dit record zelf bij je DNS:</small>${copyLine(ctx, x.waarde)}`}</div>`).join("")}</div>` : ""}
    ${r.manier === "scaleway" && r.status !== "checked" ? `<div><button type="button" class="btn" id="nMailAgain">Opnieuw nagaan</button></div>` : ""}
    ${r.pending ? `<p class="muted" style="margin:0"><small>Je Dienst gebruikt dit na <b>Wijzigingen toepassen</b>.</small></p>` : ""}</div>`;
  wireLinks(el, ctx);
  el.querySelector("#nMailAgain")?.addEventListener("click", async (e) => {
    try { mailResult(el, ctx, await ctx.busy(e.target, () => ctx.api("/api/aanbieder/mail"))); } catch { /* volgende keer */ }
  });
}

/** Uitleg bij "Regel het via Scaleway", met de gratis route als die gekozen is. */
function gratisMail(scwOk, ctx) {
  const gratis = ctx.nodig?.modus === "gratis";
  if (!scwOk) return gratis ? "Regel eerst Scaleway (hierboven). Een account is gratis; Scaleway vraagt wel een betaalmethode. Je hebt het toch nodig voor de clouds van je klanten." : "Regel eerst Scaleway (hierboven).";
  return gratis ? "Gratis tot 300 mails per maand, daarna € 0,25 per 1.000 (volgens Scaleway). De app meldt het adres van je Dienst aan als maildomein en zet de records in je DNS. De mail gaat via de beveiligde webkoppeling van Scaleway, zodat hij ook werkt op een proefserver waar de mailpoorten dicht zijn."
    : "De app meldt het adres van je Dienst aan als maildomein, zet de records in je DNS en vult de mailserver in. Meestal gratis.";
}

function pMail(body, ctx, again, l) {
  const scwOk = l.items.find((x) => x.id === "scaleway")?.status === "ok";
  const cloud = !!ctx.config?.mailRelay;
  body.innerHTML = `<form class="fields" id="nf">
      <label class="check"><input type="radio" name="manier" value="scaleway" ${scwOk ? "checked" : "disabled"}> Regel het via Scaleway (aanbevolen)<small>${gratisMail(scwOk, ctx)}</small></label>
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
const PANELS = { domein: pDomein, dns: pDns, scaleway: pScaleway, mollie: pMollie, mail: pMail, desec: pDesec, openprovider: pOpenprovider, adressendienst: pAdressen, server: pServer };

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

// ───────── Server op starttegoed en verhuizen ─────────

/** Het tegoed als balkje, met de einddatum. */
function proefInfo(ctx, p) {
  const { esc } = ctx;
  return `<div class="panel" style="margin:0"><div><b>Proef bij ${esc(p.naam)}</b>${p.actief ? "" : ` <span class="chip">${p.verhuisd ? "verhuisd" : "niet meer in gebruik"}</span>`}</div>
    <dl class="kv"><dt>Tot</dt><dd>${esc(p.eindTekst ?? "tot je tegoed op is")}${p.eindBron === "geschat" ? ` <small class="muted">(geschat: ${esc(p.naam)} noemt 7 dagen vanaf het begin)</small>` : ""}</dd>
      <dt>Tegoed</dt><dd>${p.tegoedTekst ? `${esc(p.tegoedTekst)} <small class="muted">volgens ${esc(p.naam)}</small>` : `<span class="muted">nog niet gelezen</span>`}</dd></dl>
    ${p.procent != null ? `<div class="tegoed${p.procent < 20 ? " laag" : ""}" role="progressbar" aria-label="Tegoed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.procent}"><i style="width:${p.procent}%"></i></div>` : ""}
    ${p.waarschuwing ? `<p class="note warn" style="margin:0"><small>${esc(p.waarschuwing)}</small></p>` : ""}</div>`;
}

/**
 * "Server en back-ups": bij Zo gratis mogelijk eerst UpCloud of Exoscale met starttegoed (aanmelden, wat je krijgt en
 * wat er aan het eind gebeurt), dan de sleutel; de app kiest het kleinste geschikte formaat. Loopt de proef, dan het
 * tegoed, de einddatum en Verhuizen naar een betaalde server.
 */
function pServer(body, ctx, again, l, opts = {}) {
  const { esc, a } = ctx;
  const p = a.proef;
  const stap = () => ctx.aStep("server").then(() => ctx.goHash("aanbieder")).catch(() => {});
  if (p && (p.actief || a.server?.provider === p.provider)) {
    body.innerHTML = `${proefInfo(ctx, p)}
      <p style="margin:0"><small class="muted">${esc(p.einde)}</small></p>
      <form class="fields" id="nEind"><label>Tot wanneer loopt je proef?<input type="date" name="eind" value="${esc(p.eindDatum ?? "")}"><small>Staat in je account bij ${esc(p.naam)}. Leeg laten: de app schat het.</small></label>
        <p class="msg"></p><div class="actions" style="margin:0"><button class="btn">Datum bewaren</button></div></form>
      <div class="actions" style="margin:0">${a.server ? `<button type="button" class="btn primary" id="nMove">Verhuizen naar een betaalde server</button>` : ""}<button type="button" class="btn" id="nStap">${a.server ? "Andere aanbieder kiezen" : "Verder met opzetten"}</button></div>
      <div id="nMoveBox"></div>`;
    const f = body.querySelector("#nEind");
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await ctx.busy(f.querySelector("button"), () => ctx.api("/api/aanbieder/proef", { method: "POST", body: { eind: f.eind.value } })); ctx.a = await ctx.api("/api/aanbieder"); again("<p class=\"msg ok\" style=\"margin:0\">Einddatum bewaard.</p>"); }
      catch (err) { ctx.formMsg(f, err.message); }
    };
    body.querySelector("#nMove")?.addEventListener("click", () => verhuisPaneel(body.querySelector("#nMoveBox"), ctx, (flash) => again(flash)));
    body.querySelector("#nStap").onclick = stap;
    return;
  }
  const h = a.hosting;
  if (h && !opts.kiezen) {
    // Al een betaalde server (of gekozen bij Server en back-ups): dat laten zien, met de weg naar Server en back-ups.
    const prijs = h.monthly != null ? `, € ${h.monthly.toFixed(2).replace(".", ",")} per maand zonder btw` : "";
    body.innerHTML = `<p style="margin:0">${a.server ? "Je Dienst draait" : "Gekozen"} bij <b>${esc(h.name)}</b> in ${esc(h.city)} (${esc(h.size)})${esc(prijs)}.${p?.verhuisd ? ` Verhuisd van de proef bij ${esc(p.naam)}.` : ""}</p>
      <div class="actions" style="margin:0"><button type="button" class="btn primary" id="nStap">Server en back-ups</button>${a.server ? "" : `<button type="button" class="btn" id="nKies">Toch gratis proberen met starttegoed</button>`}</div>`;
    body.querySelector("#nStap").onclick = () => (a.hub ? ctx.goHash("aanbieder/server") : stap());
    body.querySelector("#nKies")?.addEventListener("click", () => pServer(body, ctx, again, l, { kiezen: true }));
    return;
  }
  const list = l.proefAanbieders ?? ctx.nodig?.proefAanbieders ?? [];
  if (!list.length) { body.innerHTML = `<p style="margin:0">Kies bij <b>Server en back-ups</b> waar je server komt.</p><div><button type="button" class="btn primary" id="nStap">Server kiezen</button></div>`; body.querySelector("#nStap").onclick = stap; return; }
  body.innerHTML = `<p style="margin:0">Probeer je Dienst eerst gratis op een server met starttegoed. Loopt de proef af, dan verhuist de app hem met één tik naar een betaalde server; je klanten merken daar weinig van.</p>
    <div class="proefkeus">${list.map((x, i) => `<label class="pk${i === 0 ? " on" : ""}"><span class="check"><input type="radio" name="pk" value="${esc(x.id)}" ${i === 0 ? "checked" : ""}> <b>${esc(x.naam)}</b></span>
        <p>${esc(x.wat)}</p><small>${esc(x.tijdens)}</small><small><b>Daarna:</b> ${esc(x.einde)}</small><small><b>Back-ups:</b> ${esc(x.backup)}</small></label>`).join("")}</div>
    <ol class="guide" id="nProefStap"></ol>
    <form class="fields" id="nProef"><div id="nVelden" class="fields"></div><ul class="results" id="nProefRes"></ul><p class="msg"></p>
      <div class="actions" style="margin:0"><button class="btn primary">Koppelen en server kiezen</button></div></form>
    <p class="muted" style="margin:0"><small>Liever meteen een betaalde server? <button type="button" class="link" id="nStap">Kies zelf bij Server en back-ups</button></small></p>`;
  wireLinks(body, ctx);
  body.querySelector("#nStap").onclick = stap;
  const f = body.querySelector("#nProef");
  const keus = () => list.find((x) => x.id === body.querySelector("input[name=pk]:checked")?.value) ?? list[0];
  const sync = () => {
    const x = keus();
    body.querySelectorAll(".pk").forEach((el) => el.classList.toggle("on", el.querySelector("input").value === x.id));
    body.querySelector("#nProefStap").innerHTML = `<li><b>Een account bij ${esc(x.naam)}.</b> Dat doe je zelf, met je creditcard ter controle.<div>${linkBtn(ctx, x.aanmelden, "Account maken")}</div></li>
      <li><b>Een sleutel voor de app.</b> ${esc(x.keyHelp)}</li><li><b>Plak hem hier.</b> De app kiest de dichtstbijzijnde plek met het kleinste geschikte formaat.</li>`;
    wireLinks(body.querySelector("#nProefStap"), ctx);
    body.querySelector("#nVelden").innerHTML = x.fields.map((fl) => `<label>${esc(fl.label)}<input name="${esc(fl.key)}" ${fl.secret ? 'type="password"' : ""} autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`).join("");
  };
  body.querySelectorAll("input[name=pk]").forEach((r) => r.onchange = sync);
  sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const x = keus();
    const fields = Object.fromEntries(x.fields.map((fl) => [fl.key, f.querySelector(`[name="${fl.key}"]`).value]));
    body.querySelector("#nProefRes").innerHTML = `<li class="busy">Bezig: sleutel controleren, formaten ophalen, tegoed lezen…</li>`;
    try {
      const r = await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/proef", { method: "POST", body: { provider: x.id, fields } }));
      ctx.a = await ctx.api("/api/aanbieder");
      again(`<ul class="results"><li>Server bij ${esc(r.hosting.name)} in ${esc(r.hosting.city)} (${esc(r.hosting.size)})<small>Gratis zolang je starttegoed loopt${r.proef.eindTekst ? `, tot ${esc(r.proef.eindTekst)}` : ""}</small></li>
        <li>Back-ups bij ${esc(r.backup.name)}<small>${esc(r.backupUitleg)}</small></li>${r.proef.tegoedTekst ? `<li>Tegoed: ${esc(r.proef.tegoedTekst)}</li>` : ""}</ul>
        <p class="muted" style="margin:0"><small>De server komt er bij <b>Opzetten</b>, als de rest van de lijst klaar is.</small></p>`);
    } catch (err) { body.querySelector("#nProefRes").innerHTML = ""; ctx.formMsg(f, err.message); }
  };
}

/**
 * Verhuizen naar een betaalde server: de goedkoopste geschikte plek bij de gekoppelde aanbieders (of een andere uit de
 * lijst), dan het gewone opnieuw opzetten. onDone(flashHtml) na het verhuizen.
 */
export async function verhuisPaneel(el, ctx, onDone, opts = {}) {
  const { esc } = ctx;
  el.innerHTML = `<p class="muted" style="margin:0">De goedkoopste betaalde server zoeken…</p>`;
  let r;
  try { r = await ctx.api("/api/aanbieder/verhuizen", { method: "POST", body: {} }); }
  catch (err) { el.innerHTML = `<p class="msg err" style="margin:0">${esc(err.message)}</p>`; return; }
  const ander = () => ctx.aStep("server").then(() => ctx.goHash("aanbieder")).catch(() => {});
  const prijs = (k) => (k.monthly == null ? "prijs onbekend" : `€ ${k.monthly.toFixed(2).replace(".", ",")} per maand (zonder btw)`);
  if (!r.keuze) {
    el.innerHTML = `<div class="fields"><p style="margin:0">${esc(r.uitleg)}</p><div class="actions" style="margin:0"><button type="button" class="btn primary" data-ander>Aanbieder kiezen</button></div></div>`;
    el.querySelector("[data-ander]").onclick = ander;
    return;
  }
  el.innerHTML = `<form class="fields${opts.venster ? "" : " panel"}" style="margin:0" id="nVh">${opts.venster ? "" : "<b>Verhuizen naar een betaalde server</b>"}
      ${r.kandidaten.map((k, i) => `<label class="check"><input type="radio" name="naar" value="${i}" ${i === 0 ? "checked" : ""}> ${esc(k.naam)}, ${esc(k.city)} <small>${esc(k.sizeLabel)} (${esc(k.size)}), ${esc(prijs(k))}${i === 0 ? " · de goedkoopste" : ""}</small></label>`).join("")}
      <p class="muted" style="margin:0"><small>De app maakt eerst een laatste back-up, zet een nieuwe server op die alles terugzet, zet het adres om en haalt de proefserver weg. Je Dienst is een paar minuten niet bereikbaar; door de DNS kan het tot een uur duren voordat iedereen hem weer ziet. ${esc(r.backup)}</small></p>
      <ul class="results" id="nVhRes"></ul><p class="msg"></p>
      <div class="actions" style="margin:0"><button class="btn primary">Verhuizen</button><button type="button" class="btn" data-ander>Andere aanbieder kiezen</button></div></form>`;
  el.querySelector("[data-ander]").onclick = ander;
  const f = el.querySelector("#nVh");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const k = r.kandidaten[Number(f.querySelector("input[name=naar]:checked")?.value ?? 0)];
    if (!confirm(`Je Dienst verhuizen naar ${k.naam} in ${k.city}?\n\nEen paar minuten is je Dienst niet bereikbaar.`)) return;
    try {
      const v = await ctx.busy(f.querySelector("button.primary"), () => ctx.api("/api/aanbieder/verhuizen", { method: "POST", body: { provider: k.provider, region: k.region, akkoord: true } }));
      onDone?.(`<ul class="results">${ctx.resultItems(v.steps)}</ul><p class="msg ok" style="margin:0">Verhuisd. De nieuwe server start op; over een paar minuten is je Dienst weer bereikbaar.</p>`);
    } catch (err) { if (err.data?.steps) f.querySelector("#nVhRes").innerHTML = ctx.resultItems(err.data.steps); ctx.formMsg(f, err.message); }
  };
}

/** Hetzelfde in een venster (vanuit Je dienst en het overzicht). */
export function verhuisVenster(ctx, onDone) {
  const dlg = document.createElement("dialog");
  dlg.className = "confirm nvenster";
  dlg.innerHTML = `<h2>Verhuizen naar een betaalde server</h2><div class="nodig"><div id="nVhBox"></div></div><div class="row"><button type="button" class="btn quiet" data-close>Sluiten</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector("[data-close]").onclick = close;
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  verhuisPaneel(dlg.querySelector("#nVhBox"), ctx, (flash) => { close(); onDone?.(flash); }, { venster: true });
}
