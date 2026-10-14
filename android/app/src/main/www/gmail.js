// Gmail op deze telefoon: schermen bovenop de Java-kern (brug EigenGmail → nl.eigencloud.core.gmail.GmailApi).
(function () {
  "use strict";
  const G = window.EigenGmail;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Brug ──
  const pending = {};
  let seq = 0;
  window.__gmailReply = (id, status, body) => {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    let j;
    try { j = JSON.parse(body); } catch (e) { j = { error: body }; }
    if (status >= 200 && status < 300) p.resolve(j);
    else { const err = new Error((j && j.error) || "Er ging iets mis"); err.data = j; err.status = status; p.reject(err); }
  };
  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      if (!G) { reject(new Error("Werk de app bij")); return; }
      const id = ++seq;
      pending[id] = { resolve, reject };
      G.call(id, method, path, body ? JSON.stringify(body) : "");
    });
  }
  const waiters = {};
  function waitFor(type) { return new Promise((resolve) => { (waiters[type] = waiters[type] || []).push(resolve); }); }
  window.addEventListener("gmail", (e) => {
    const d = e.detail || {};
    (waiters[d.type] || []).splice(0).forEach((f) => f(d));
    if (d.type === "sync" || d.type === "resume") refreshSoon();
    if (d.type === "account") {
      if (d.address) $("#address").value = d.address;
      else if (d.error) setupMsg(d.error, true);
    }
    if (d.type === "files") addFiles(d);
    if (d.type === "attachment") {
      if (d.error) toast(d.error);
      else if (d.saved) toast("Bewaard");
      $$(".atts [data-busy]").forEach((b) => { b.disabled = false; b.removeAttribute("data-busy"); });
    }
    if (d.type === "mailto") openCompose({ to: decodeURIComponent(d.to || "") });
    if (d.type === "notifications" && !d.allowed) $("#notifyMsg").textContent = "Meldingen staan uit voor deze app in de instellingen van je telefoon.";
    if (d.type === "error") toast(d.error);
  });

  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ── Datum en grootte ──
  const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const two = (n) => ("0" + n).slice(-2);
  function when(ms) {
    if (!ms) return "";
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return two(d.getHours()) + ":" + two(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getDate() + "-" + (d.getMonth() + 1) + "-" + d.getFullYear();
  }
  function full(ms) {
    const d = new Date(ms);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + " om " + two(d.getHours()) + ":" + two(d.getMinutes());
  }
  function size(n) {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1).replace(".", ",") + " GB";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
    return Math.max(1, Math.round(n / 1024)) + " kB";
  }
  const nf = (n) => Number(n || 0).toLocaleString("nl-NL");

  // ── Toestand en navigatie ──
  let state = null, boxes = [], view = "inbox", query = "", remote = null, msgs = [], more = false, current = null;
  const VIEW_NAMES = { inbox: "Inbox", starred: "Met ster", important: "Belangrijk", sent: "Verzonden", drafts: "Concepten", all: "Alle e-mail", spam: "Spam", trash: "Prullenbak" };
  const viewName = (v) => VIEW_NAMES[v] || (v.startsWith("label:") ? v.slice(6) : v);

  function show(id) {
    ["setup", "list", "read", "compose", "settings"].forEach((s) => { $("#" + s).hidden = s !== id; });
    $("#searchBtn").hidden = id !== "list";
    $("#menuBtn").hidden = id === "setup";
    closeDrawer();
    window.scrollTo(0, 0);
  }

  async function loadState() {
    try { state = await api("GET", "/api/state"); } catch (e) { state = state || { configured: false }; }
    return state;
  }

  async function route() {
    await loadState();
    const h = location.hash.replace(/^#/, "");
    if (!state.configured) { show("setup"); $("#title").textContent = "Gmail"; return; }
    if (h.startsWith("msg/")) return openMessage(h.slice(4));
    if (h === "compose") { if (!composing) return openCompose({}, true); show("compose"); return; }
    if (h === "settings") return openSettings();
    const v = h.startsWith("box/") ? decodeURIComponent(h.slice(4)) : "inbox";
    if (v !== view || remote) { view = v; remote = null; }
    show("list");
    $("#title").textContent = query ? "Zoeken" : viewName(view);
    await Promise.all([loadBoxes(), loadList(false)]);
  }
  window.addEventListener("hashchange", route);

  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadState();
      if (!state.configured) return;
      if (!$("#list").hidden && !remote) { loadBoxes(); loadList(false, true); }
      else renderStatus();
      if (!$("#settings").hidden) fillSettings();
    }, 250);
  }

  // ── Instellen ──
  function setupMsg(text, err) {
    const m = $("#setupMsg");
    m.textContent = text || "";
    m.className = "msg" + (text ? (err ? " err" : " ok") : "");
  }
  $("#pickAccount").addEventListener("click", () => { setupMsg(""); G && G.pickAccount(); });
  $("#openGoogle").addEventListener("click", () => G && G.openAppPasswords());
  $("#paste").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const address = $("#address").value.trim();
    if (!address) { setupMsg("Kies of vul eerst je Gmail-adres in.", true); return; }
    let p;
    try { p = JSON.parse(G.pastePassword()); } catch (err) { p = { ok: false, error: "Plakken lukte niet" }; }
    if (!p || !p.ok) { setupMsg(p ? p.error : "Plakken lukte niet", true); return; }
    btn.disabled = true;
    setupMsg("Geplakt (" + p.masked + "). Verbinden met Gmail…");
    try {
      const r = await api("POST", "/api/setup", { address });
      setupMsg("");
      toast("Verbonden. " + (r.total ? nf(r.total) + " berichten; " : "") + "de nieuwste komen eerst.");
      if (G.askNotifications) G.askNotifications();
      location.hash = "#box/inbox";
      route();
    } catch (err) {
      setupMsg(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Mappen ──
  async function loadBoxes() {
    try { boxes = await api("GET", "/api/mailboxes"); } catch (e) { return; }
    const ul = $("#boxes");
    ul.innerHTML = "";
    let sep = false;
    boxes.forEach((b) => {
      if (!b.system && !sep) { sep = true; const li = document.createElement("li"); li.className = "sep"; ul.appendChild(li); }
      const li = document.createElement("li");
      li.innerHTML = `<button class="${b.view === view ? "on" : ""}" data-view="${esc(b.view)}"><span>${esc(b.name)}</span><span class="count">${b.unread ? nf(b.unread) : ""}</span></button>`;
      ul.appendChild(li);
    });
  }
  $("#boxes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    query = "";
    $("#q").value = "";
    $("#searchForm").hidden = true;
    location.hash = "#box/" + encodeURIComponent(b.dataset.view);
    closeDrawer();
  });
  function openDrawer() { $("#drawer").hidden = false; $("#scrim").hidden = false; $("#menuBtn").setAttribute("aria-expanded", "true"); }
  function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; $("#menuBtn").setAttribute("aria-expanded", "false"); }
  $("#menuBtn").addEventListener("click", () => ($("#drawer").hidden ? openDrawer() : closeDrawer()));
  $("#scrim").addEventListener("click", closeDrawer);
  $("#toSettings").addEventListener("click", () => { location.hash = "#settings"; });
  $("#toApp").addEventListener("click", () => G && G.openApp());

  // ── Status ──
  function renderStatus() {
    const el = $("#status");
    if (!state || !state.status) { el.textContent = ""; return; }
    const s = state.status, parts = [];
    let cls = "status";
    if (s.authFailed) {
      el.className = "status err";
      el.innerHTML = `${esc(s.error)} <button class="link" id="fixAccount">Instellingen</button>`;
      $("#fixAccount").onclick = () => { location.hash = "#settings"; };
      return;
    }
    if (s.headers && s.walkDone === false && s.headers.total) parts.push(`Eerste keer ophalen: ${nf(s.headers.done)} van ${nf(s.headers.total)} berichten`);
    if (s.bodies && s.bodies.total && s.bodies.done < s.bodies.total) parts.push(`inhoud ${nf(s.bodies.done)} van ${nf(s.bodies.total)}` + (s.waitingForWifi ? " (de rest via wifi)" : ""));
    if (state.pending) parts.push(`${nf(state.pending)} wijziging${state.pending === 1 ? "" : "en"} nog naar Gmail`);
    if (s.error) { cls = "status warn"; parts.push(s.error); }
    else if (s.running) parts.push("Bijwerken…");
    else if (s.lastOk) parts.push("Bijgewerkt " + (new Date(s.lastOk).toDateString() === new Date().toDateString() ? "om " + when(s.lastOk) : when(s.lastOk)));
    el.className = cls;
    el.innerHTML = esc(parts.join(" · ")) + (s.error ? ` <button class="link" id="retrySync">Opnieuw</button>` : "");
    if (s.error) $("#retrySync").onclick = () => { api("POST", "/api/sync").catch((e) => toast(e.message)); el.textContent = "Bijwerken…"; };
    renderOutbox();
  }

  function renderOutbox() {
    const ul = $("#outbox");
    ul.innerHTML = "";
    (state.outbox || []).forEach((o) => {
      const li = document.createElement("li");
      li.className = o.state === "failed" ? "failed" : "";
      const what = o.state === "failed" ? "Niet verstuurd" : o.state === "unknown" ? "Misschien verstuurd" : "Wordt verstuurd";
      li.innerHTML = `<b>${what}:</b> ${esc(o.subject || "(geen onderwerp)")} <span class="muted">aan ${esc((o.to || []).join(", "))}</span>`
        + (o.error ? `<div class="muted">${esc(o.error)}</div>` : "")
        + (o.state === "sending" ? "" : `<div class="row-actions"><button class="btn" data-retry="${o.seq}">Opnieuw proberen</button>${o.state === "failed" || o.state === "queued" ? `<button class="btn danger" data-drop="${o.seq}">Verwijderen</button>` : ""}</div>`);
      ul.appendChild(li);
    });
  }
  $("#outbox").addEventListener("click", async (e) => {
    const r = e.target.closest("[data-retry]"), d = e.target.closest("[data-drop]");
    try {
      if (r) { await api("POST", "/api/outbox/retry", { seq: Number(r.dataset.retry) }); toast("Wordt opnieuw verstuurd"); }
      if (d && confirm("Dit bericht niet versturen en weggooien?")) { await api("POST", "/api/outbox/delete", { seq: Number(d.dataset.drop) }); }
    } catch (err) { toast(err.message); }
    refreshSoon();
  });

  // ── Lijst ──
  async function loadList(append, quiet) {
    if (remote) return;
    let path = "/api/messages?view=" + encodeURIComponent(view);
    if (query) path += "&q=" + encodeURIComponent(query) + "&scope=everywhere";
    if (append && msgs.length) { const last = msgs[msgs.length - 1]; path += "&before=" + last.date + "&beforeId=" + encodeURIComponent(last.id); }
    let r;
    try { r = await api("GET", path); } catch (e) { if (!quiet) toast(e.message); return; }
    msgs = append ? msgs.concat(r.messages) : r.messages;
    more = r.more;
    renderList();
    renderStatus();
  }

  function renderList() {
    const ul = $("#msgs");
    ul.innerHTML = msgs.map((m) => {
      const who = view === "sent" || view === "drafts" ? "Aan: " + (m.to || "") : m.fromName || m.fromAddr || "(onbekend)";
      const tags = (m.labels || []).filter((l) => !l.startsWith("\\") && "label:" + l !== view).slice(0, 2).map((l) => `<span class="tag">${esc(l)}</span>`).join("");
      return `<li class="msg-row${m.seen ? "" : " unread"}" data-id="${esc(m.id)}">
        <div class="who">${esc(who)}${m.box === "trash" && view !== "trash" ? ' <span class="tag">Prullenbak</span>' : ""}</div>
        <div class="when">${when(m.date)}</div>
        <div class="subj">${esc(m.subject || "(geen onderwerp)")}${m.attach ? " 📎" : ""}${tags}</div>
        <div class="snip">${esc(m.snippet || "")}</div>
        <button class="star${m.flagged ? " on" : ""}" data-star="${esc(m.id)}" aria-label="${m.flagged ? "Ster weghalen" : "Ster geven"}">${m.flagged ? "★" : "☆"}</button>
      </li>`;
    }).join("");
    $("#more").hidden = !more;
    $("#empty").hidden = msgs.length > 0;
    $("#empty").textContent = query ? "Niets gevonden op de telefoon. Probeer ‘Ook bij Gmail’." : "Geen berichten.";
  }
  $("#msgs").addEventListener("click", async (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      e.stopPropagation();
      const m = msgs.find((x) => x.id === star.dataset.star);
      if (!m) return;
      m.flagged = !m.flagged;
      renderList();
      api("POST", "/api/action", { ids: [m.id], op: m.flagged ? "flag" : "unflag" }).catch((err) => toast(err.message));
      return;
    }
    const row = e.target.closest("[data-id]");
    if (row) location.hash = "#msg/" + row.dataset.id;
  });
  $("#more").addEventListener("click", () => loadList(true));

  // ── Zoeken ──
  $("#searchBtn").addEventListener("click", () => {
    const f = $("#searchForm");
    f.hidden = !f.hidden;
    if (!f.hidden) $("#q").focus();
    else if (query || remote) { query = ""; remote = null; $("#q").value = ""; route(); }
  });
  let searchTimer = null;
  $("#q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = $("#q").value.trim(); remote = null; $("#title").textContent = query ? "Zoeken" : viewName(view); loadList(false); }, 250);
  });
  $("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); query = $("#q").value.trim(); remote = null; loadList(false); });
  $("#remoteSearch").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const q = $("#q").value.trim();
    if (!q) { $("#q").focus(); return; }
    btn.disabled = true;
    $("#status").textContent = "Zoeken bij Gmail…";
    try {
      const r = await api("POST", "/api/remote-search", { q });
      remote = q;
      msgs = r.messages;
      more = false;
      $("#title").textContent = "Gmail: " + q;
      renderList();
      $("#status").textContent = r.messages.length ? `${r.messages.length} gevonden bij Gmail (Gmail-zoektaal werkt ook, bijv. from:anna has:attachment)` : "Ook bij Gmail niets gevonden.";
    } catch (err) {
      $("#status").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Lezen ──
  async function openMessage(id) {
    show("read");
    $("#sheet").hidden = true;
    const box = $("#message");
    box.innerHTML = `<p class="muted">Bezig met openen…</p>`;
    let m;
    try { m = await api("GET", "/api/message?id=" + encodeURIComponent(id)); } catch (e) { box.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return; }
    current = m;
    $("#title").textContent = m.subject || "(geen onderwerp)";
    $("#archiveBtn").textContent = m.box !== "all" ? "Naar inbox" : (m.labels || []).includes("\\Inbox") ? "Archiveren" : "Naar inbox";
    $("#archiveBtn").dataset.act = $("#archiveBtn").textContent === "Archiveren" ? "archive" : "inbox";
    $("#trashBtn").textContent = m.box === "trash" || m.box === "spam" ? "Definitief verwijderen" : "Verwijderen";
    $("#trashBtn").dataset.act = m.box === "trash" || m.box === "spam" ? "delete" : "trash";
    const labels = (m.labels || []).filter((l) => !l.startsWith("\\"));
    box.innerHTML = `
      <h2>${esc(m.subject || "(geen onderwerp)")}</h2>
      ${labels.length ? `<ul class="chips">${labels.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      <div class="meta"><b>${esc(m.fromName || m.fromAddr)}</b>${m.fromName ? " &lt;" + esc(m.fromAddr) + "&gt;" : ""}<br>
        ${m.to ? "Aan: " + esc(m.to) + "<br>" : ""}${m.cc ? "Cc: " + esc(m.cc) + "<br>" : ""}${full(m.date)}${m.flagged ? " · ★" : ""}</div>
      ${m.fetchError ? `<p class="note">De inhoud kon niet worden opgehaald: ${esc(m.fetchError)} <button class="link" id="refetch">Opnieuw</button></p>` : ""}
      ${(m.attachments || []).length ? `<ul class="atts">${m.attachments.map((a) => `<li><span class="name">📎 ${esc(a.name)} <small class="muted">${size(a.size)}${a.downloaded ? "" : " · nog bij Gmail"}</small></span>
        <button class="btn" data-open="${esc(a.section)}">Openen</button><button class="btn" data-save="${esc(a.section)}">Bewaren</button></li>`).join("")}</ul>` : ""}
      ${m.remoteImages ? `<p class="note" id="imgNote">Afbeeldingen van internet zijn verborgen (de afzender zou zien dat je de mail opent). <button class="link" id="showImgs">Afbeeldingen tonen</button></p>` : ""}
      <iframe class="frame" id="frame" title="Bericht" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" src="${esc(m.contentUrl)}"></iframe>
      <div class="reply-bar">
        <button class="btn" data-act="reply">Beantwoorden</button>
        <button class="btn" data-act="replyAll">Allen beantwoorden</button>
        <button class="btn" data-act="forward">Doorsturen</button>
      </div>
      ${m.thread && m.thread.length > 1 ? `<h3 class="small muted">Dit gesprek (${m.thread.length})</h3><ul class="thread">${m.thread.map((t) => `<li class="${t.current ? "cur" : ""}" data-thread="${esc(t.id)}">${when(t.date)} · ${esc(t.fromName || t.fromAddr)} <span class="muted">${esc(t.snippet || "")}</span></li>`).join("")}</ul>` : ""}`;
    sizeFrame();
    if ($("#showImgs")) $("#showImgs").onclick = () => { $("#frame").src = m.contentUrl + "?img=1"; $("#imgNote").remove(); };
    if ($("#refetch")) $("#refetch").onclick = () => openMessage(id);
  }

  function sizeFrame() {
    const f = $("#frame");
    if (!f) return;
    const fit = () => {
      try {
        const d = f.contentDocument;
        if (!d || !d.documentElement) return;
        f.style.height = Math.max(200, d.documentElement.scrollHeight + 8) + "px";
        $$("img", d).forEach((img) => { if (!img.complete) img.addEventListener("load", fit, { once: true }); });
      } catch (e) { f.style.height = "70vh"; }
    };
    f.addEventListener("load", () => { fit(); setTimeout(fit, 400); setTimeout(fit, 1500); });
  }

  $("#message").addEventListener("click", (e) => {
    const t = e.target.closest("[data-thread]");
    if (t && !t.classList.contains("cur")) { location.hash = "#msg/" + t.dataset.thread; return; }
    const o = e.target.closest("[data-open]"), s = e.target.closest("[data-save]");
    if (o || s) {
      const b = o || s;
      b.disabled = true;
      b.setAttribute("data-busy", "1");
      toast("Bezig…");
      if (o) G.openAttachment(current.id, o.dataset.open); else G.saveAttachment(current.id, s.dataset.save);
    }
  });

  async function act(op, extra) {
    if (!current) return;
    try {
      await api("POST", "/api/action", Object.assign({ ids: [current.id], op }, extra || {}));
    } catch (e) { toast(e.message); return false; }
    return true;
  }

  $("#read").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !current) return;
    const a = b.dataset.act;
    if (a === "back") { history.back(); return; }
    if (a === "more") { toggleSheet(); return; }
    if (a === "reply" || a === "replyAll" || a === "forward") {
      try {
        const c = await api("GET", "/api/compose?id=" + encodeURIComponent(current.id) + "&mode=" + (a === "replyAll" ? "all" : a === "forward" ? "forward" : "reply"));
        openCompose(c);
      } catch (err) { toast(err.message); }
      return;
    }
    if (a === "delete" && !confirm("Dit bericht definitief verwijderen? Dat kan niet ongedaan worden gemaakt, ook niet in Gmail.")) return;
    const msgsFor = { archive: "Gearchiveerd", inbox: "Terug in de inbox", trash: "Naar de prullenbak", delete: "Verwijderd", spam: "Naar spam", unseen: "Gemarkeerd als ongelezen" };
    if (await act(a)) {
      if (msgsFor[a]) toast(msgsFor[a]);
      if (a === "flag" || a === "unflag") { openMessage(current.id); return; }
      history.back();
    }
  });

  function toggleSheet() {
    const sh = $("#sheet");
    if (!sh.hidden) { sh.hidden = true; return; }
    const m = current;
    const labels = boxes.filter((b) => !b.system).map((b) => b.name);
    const mine = (m.labels || []).filter((l) => !l.startsWith("\\"));
    sh.innerHTML = `
      <button class="btn" data-act="${m.flagged ? "unflag" : "flag"}">${m.flagged ? "Ster weghalen" : "Ster geven"}</button>
      <button class="btn" data-act="unseen">Markeren als ongelezen</button>
      ${m.box === "spam" ? `<button class="btn" data-act="inbox">Geen spam</button>` : m.box === "all" ? `<button class="btn" data-act="spam">Spam</button>` : `<button class="btn" data-act="inbox">Terugzetten in de inbox</button>`}
      <div><b class="small">Labels</b></div>
      <div class="labels">${labels.map((l) => `<button class="btn${mine.includes(l) ? " primary" : ""}" data-label="${esc(l)}">${esc(l)}</button>`).join("")}
        <button class="btn" data-label="">+ Nieuw label</button></div>
      <div><b class="small">Verplaatsen naar</b></div>
      <div class="labels">${labels.map((l) => `<button class="btn" data-move="${esc(l)}">${esc(l)}</button>`).join("")}</div>`;
    sh.hidden = false;
  }
  $("#sheet").addEventListener("click", async (e) => {
    const lb = e.target.closest("[data-label]"), mv = e.target.closest("[data-move]");
    if (!lb && !mv) return;
    e.stopPropagation();
    if (lb) {
      let name = lb.dataset.label;
      if (!name) { name = (prompt("Naam van het nieuwe label") || "").trim(); if (!name) return; }
      const has = (current.labels || []).includes(name);
      if (await act(has ? "unlabel" : "label", { label: name })) { toast(has ? "Label weggehaald" : "Label toegevoegd"); openMessage(current.id); }
      return;
    }
    const from = view.startsWith("label:") ? view : "inbox";
    if (await act("move", { label: mv.dataset.move, from })) { toast("Verplaatst naar " + mv.dataset.move); history.back(); }
  });

  // ── Schrijven ──
  let composing = null, files = [], fwdAttachments = [];
  function openCompose(c, replace) {
    composing = c || {};
    files = [];
    fwdAttachments = (c && c.forwardAttachments) || [];
    const f = $("#composeForm");
    f.to.value = c.to || "";
    f.cc.value = c.cc || "";
    f.bcc.value = "";
    f.subject.value = c.subject || "";
    f.text.value = c.text || "";
    $("#ccFields").hidden = !c.cc;
    $("#composeTitle").textContent = c.mode === "forward" ? "Doorsturen" : c.mode === "all" ? "Allen beantwoorden" : c.mode === "reply" ? "Beantwoorden" : "Nieuw bericht";
    $("#composeMsg").textContent = "";
    renderFiles();
    if (replace) history.replaceState(null, "", "#compose"); else location.hash = "#compose";
    show("compose");
    $("#title").textContent = $("#composeTitle").textContent;
    setTimeout(() => { (c.to ? f.text : f.to).focus(); if (c.to) f.text.setSelectionRange(0, 0); }, 50);
  }
  $("#composeBtn").addEventListener("click", () => openCompose({}));
  $("#ccToggle").addEventListener("click", () => { $("#ccFields").hidden = !$("#ccFields").hidden; });
  $("#cancelCompose").addEventListener("click", () => {
    const f = $("#composeForm");
    if ((f.text.value.trim() || files.length) && !confirm("Dit bericht weggooien?")) return;
    composing = null;
    history.back();
  });
  $("#addFile").addEventListener("click", () => G && G.pickFiles());
  function addFiles(d) {
    if (d.error) $("#composeMsg").textContent = d.error;
    (d.files || []).forEach((f) => files.push(f));
    renderFiles();
  }
  function renderFiles() {
    const ul = $("#attachList");
    ul.innerHTML = fwdAttachments.map((a, i) => `<li><label class="check"><input type="checkbox" data-fwd="${i}" ${a.off ? "" : "checked"}> ${esc(a.name)} <small>${size(a.size)}</small></label></li>`).join("")
      + files.map((f, i) => `<li>${esc(f.name)} <small>${size(f.size)}</small><button type="button" data-unfile="${i}" aria-label="Weghalen">×</button></li>`).join("");
  }
  $("#attachList").addEventListener("click", (e) => {
    const x = e.target.closest("[data-unfile]");
    if (x) { files.splice(Number(x.dataset.unfile), 1); renderFiles(); }
  });
  $("#attachList").addEventListener("change", (e) => {
    const c = e.target.closest("[data-fwd]");
    if (c) fwdAttachments[Number(c.dataset.fwd)].off = !c.checked;
  });
  $("#composeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget, btn = $("#sendBtn");
    if (!f.to.value.trim() && !f.cc.value.trim() && !f.bcc.value.trim()) { $("#composeMsg").textContent = "Aan wie? Vul een e-mailadres in."; f.to.focus(); return; }
    btn.disabled = true;
    $("#composeMsg").textContent = "";
    try {
      await api("POST", "/api/send", {
        to: f.to.value, cc: f.cc.value, bcc: f.bcc.value, subject: f.subject.value, text: f.text.value,
        replyTo: composing && composing.replyTo, mode: composing && composing.mode,
        files: files.map((x) => ({ token: x.token, name: x.name, type: x.type })),
        forwardAttachments: fwdAttachments.filter((a) => !a.off).map((a) => a.section),
      });
      composing = null;
      toast("Wordt verstuurd");
      history.back();
    } catch (err) {
      $("#composeMsg").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Instellingen ──
  async function openSettings() {
    show("settings");
    $("#title").textContent = "Instellingen";
    $("#accountDetails").hidden = true;
    $("#showAccount").hidden = false;
    $("#accountMsg").textContent = "";
    fillSettings();
  }
  function fillSettings() {
    const st = state.settings || {};
    $("#accountLine").textContent = state.address ? "Gmail van " + state.address : "";
    $$("#months input").forEach((r) => { r.checked = Number(r.value) === Number(st.months); });
    $("#attachLimit").value = String(st.attachLimitMb || 10);
    $("#mobileData").checked = !!st.mobileData;
    $("#notify").checked = !!st.notify;
    $("#notifyMsg").textContent = st.notify && G && G.notificationsAllowed && !G.notificationsAllowed() ? "Meldingen staan uit voor deze app in de instellingen van je telefoon." : "";
    $("#storageLine").textContent = "Op deze telefoon: " + size(state.storage || 0) + " aan berichten en bijlagen.";
  }
  $("#settingsBack").addEventListener("click", () => history.back());
  async function saveSettings(patch) {
    try { state = await api("PUT", "/api/settings", patch); fillSettings(); toast("Opgeslagen"); } catch (e) { toast(e.message); fillSettings(); }
  }
  $("#months").addEventListener("change", (e) => {
    const v = Number(e.target.value), cur = Number((state.settings || {}).months);
    const shrinks = v !== 0 && (cur === 0 || v < cur);
    if (shrinks && !confirm(`De inhoud van berichten ouder dan ${v} maanden gaat van de telefoon (afzender, onderwerp en het begin blijven). Doorgaan?`)) { fillSettings(); return; }
    saveSettings({ months: v });
  });
  $("#attachLimit").addEventListener("change", (e) => saveSettings({ attachLimitMb: Number(e.target.value) }));
  $("#mobileData").addEventListener("change", (e) => saveSettings({ mobileData: e.target.checked }));
  $("#notify").addEventListener("change", (e) => {
    if (e.target.checked && G && G.askNotifications) G.askNotifications();
    saveSettings({ notify: e.target.checked });
  });
  $("#free").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { const r = await api("POST", "/api/free"); toast(size(r.freed) + " vrijgemaakt"); await loadState(); fillSettings(); } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
  $("#syncNow").addEventListener("click", () => { api("POST", "/api/sync").then(() => toast("Bijwerken…")).catch((e) => toast(e.message)); });

  async function confirmed(title) {
    const p = waitFor("confirm");
    G.confirm(title);
    const r = await p;
    if (!r.ok) throw new Error(r.error || "Niet bevestigd");
  }
  $("#showAccount").addEventListener("click", async () => {
    try {
      await confirmed("Gmail-instellingen tonen");
      const a = await api("GET", "/api/account");
      $("#pwMasked").textContent = a.password || "";
      $("#accountDetails").hidden = false;
      $("#showAccount").hidden = true;
    } catch (e) { toast(e.message); }
  });
  $("#newPassword").addEventListener("click", async () => {
    const m = $("#accountMsg");
    let p;
    try { p = JSON.parse(G.pastePassword()); } catch (e) { p = null; }
    if (!p || !p.ok) { m.textContent = p ? p.error : "Plakken lukte niet"; m.className = "msg err"; return; }
    m.textContent = "Testen…";
    m.className = "msg";
    const save = () => api("POST", "/api/setup", { address: state.address }); // het geplakte wachtwoord blijft in de app
    try {
      try {
        await save();
      } catch (e) {
        if (!(e.data && e.data.confirm)) throw e;
        await confirmed("Gmail-instellingen wijzigen");
        await save();
      }
      m.textContent = "Nieuw app-wachtwoord werkt en is bewaard.";
      m.className = "msg ok";
      $("#pwMasked").textContent = p.masked;
      refreshSoon();
    } catch (e) {
      m.textContent = e.message;
      m.className = "msg err";
    }
  });
  $("#forget").addEventListener("click", async () => {
    if (!confirm("Gmail van deze telefoon verwijderen?\n\nDe kopie op de telefoon en het app-wachtwoord gaan weg. In Gmail zelf verandert niets. Berichten die nog niet verstuurd zijn, gaan ook weg.")) return;
    try {
      await api("POST", "/api/forget");
      toast("Verwijderd van deze telefoon");
      location.hash = "";
      route();
    } catch (e) {
      if (e.data && e.data.confirm) { try { await confirmed("Gmail van deze telefoon verwijderen"); await api("POST", "/api/forget"); location.hash = ""; route(); return; } catch (x) { toast(x.message); return; } }
      toast(e.message);
    }
  });

  if (!G) { document.body.innerHTML = "<main class='gm-main'><p>Open dit scherm in de Eigen Cloud-app.</p></main>"; return; }
  route();
})();
