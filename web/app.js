// Eigen Cloud — webclient (geen build-stap nodig)
import { europeMap, MAP_CSS } from "/shared/europe.js";
document.head.insertAdjacentHTML("beforeend", `<style>${MAP_CSS}</style>`);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
    body: opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Niet ingelogd"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

const fmtDate = (ms) => {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  return d.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
};
const fmtFull = (ms) => new Date(ms).toLocaleString("nl-NL", { dateStyle: "full", timeStyle: "short" });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });

// ───────────── Login ─────────────
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; $("#password").focus(); }
async function boot() {
  try { await api("/api/me"); } catch { return showLogin(); }
  $("#login").hidden = true; $("#app").hidden = false;
  api("/api/cluster/status").then((c) => { if (c.enabled) $('[data-tab="nodes"]').hidden = false; }).catch(() => {});
  switchTab(location.hash.slice(1) || "mail");
  refreshHealthBanner();
  setInterval(refreshHealthBanner, 5 * 60_000);
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await api("/api/login", { method: "POST", body: { password: $("#password").value } }); $("#password").value = ""; boot(); }
  catch (err) { $("#loginError").textContent = err.message; }
});
$("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); showLogin(); };

// ───────────── Tabs ─────────────
const loaded = {};
function switchTab(target) {
  let [tab, sub] = String(target).split("/");
  if (!["mail", "agenda", "fotos", "nodes", "instellingen"].includes(tab)) tab = "mail";
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + tab));
  history.replaceState(null, "", "#" + tab + (sub ? "/" + sub : ""));
  if (!loaded[tab]) { loaded[tab] = true; ({ mail: initMail, agenda: initAgenda, fotos: initPhotos, nodes: initNodes, instellingen: initSettings })[tab](); }
  if (tab === "instellingen") showSettings(sub || "gezondheid");
}
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h.startsWith("instellingen")) switchTab(h); });
$$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

// ═════════════ MAIL ═════════════
const FOLDER_NAMES = { inbox: "📥 Inbox", sent: "📤 Verzonden", archive: "🗄️ Archief", drafts: "📝 Concepten", spam: "⚠️ Spam", trash: "🗑️ Prullenbak" };
const mail = { folder: "inbox", label: null, q: "", items: [], current: null };

async function loadFolders() {
  const { folders, labels } = await api("/api/mail/folders");
  $("#folders").innerHTML = folders.map((f) =>
    `<li data-folder="${f.folder}" class="${!mail.label && !mail.q && mail.folder === f.folder ? "active" : ""}">${FOLDER_NAMES[f.folder]}<span class="count">${f.unread || ""}</span></li>`).join("") +
    `<li data-starred="1" class="${mail.folder === "starred" ? "active" : ""}">⭐ Met ster</li>`;
  $("#labels").innerHTML = labels.map((l) => `<li data-label="${esc(l)}" class="${mail.label === l ? "active" : ""}">${esc(l)}</li>`).join("") || `<li class="muted">Geen</li>`;
}

async function loadMessages(append = false) {
  const p = new URLSearchParams({ limit: "50" });
  if (mail.q) p.set("q", mail.q);
  else if (mail.label) p.set("label", mail.label);
  else if (mail.folder === "starred") p.set("starred", "1");
  else p.set("folder", mail.folder);
  if (append && mail.items.length) p.set("before", mail.items.at(-1).date);
  const rows = await api("/api/mail/messages?" + p);
  mail.items = append ? mail.items.concat(rows) : rows;
  $("#moreMail").hidden = rows.length < 50;
  $("#messages").innerHTML = mail.items.map((m) => `
    <li data-id="${m.id}" class="${m.is_read ? "" : "unread"} ${mail.current === m.id ? "active" : ""}">
      <span class="from">${m.is_starred ? "⭐ " : ""}${esc(mail.folder === "sent" ? JSON.parse(m.to_addrs || "[]").map((a) => a.name || a.address).join(", ") : m.from_name || m.from_addr)}</span>
      <span class="date">${m.attachment_count ? "📎 " : ""}${fmtDate(m.date)}</span>
      <span class="subj">${esc(m.subject)}</span><span class="snip">${esc(m.snippet)}</span>
    </li>`).join("") || `<li class="muted">Geen berichten</li>`;
}

async function openMessage(id) {
  mail.current = id;
  const m = await api("/api/mail/messages/" + id);
  $$("#messages li").forEach((li) => li.classList.toggle("active", Number(li.dataset.id) === id));
  $(`#messages li[data-id="${id}"]`)?.classList.remove("unread");
  $("#tab-mail").classList.add("reading");
  const to = JSON.parse(m.to_addrs || "[]").map((a) => a.name ? `${a.name} &lt;${esc(a.address)}&gt;` : esc(a.address)).join(", ");
  const r = $("#reader");
  r.classList.remove("empty");
  r.innerHTML = `
    <div class="actions">
      <button class="ghost back" data-act="back">‹ Terug</button>
      <button class="ghost" data-act="reply">↩ Beantwoorden</button>
      <button class="ghost" data-act="forward">↪ Doorsturen</button>
      <button class="ghost" data-act="archive">🗄️ Archiveren</button>
      <button class="ghost" data-act="star">${m.is_starred ? "★" : "☆"}</button>
      <button class="ghost" data-act="unread">Ongelezen</button>
      <button class="ghost danger" data-act="delete">🗑 ${m.folder === "trash" ? "Definitief" : ""}</button>
      ${m.folder === "spam" || m.folder === "trash" ? `<button class="ghost" data-act="inbox">Naar inbox</button>` : ""}
    </div>
    <h2>${esc(m.subject)}</h2>
    <div class="meta"><b>${esc(m.from_name || "")}</b> &lt;${esc(m.from_addr)}&gt;<br>Aan: ${to}<br>${fmtFull(m.date)}</div>
    ${m.thread.length > 1 ? `<div class="thread">${m.thread.map((t) => `<div data-id="${t.id}" class="${t.id === m.id ? "cur" : ""}">${fmtDate(t.date)} · ${esc(t.from_name || t.from_addr)}</div>`).join("")}</div>` : ""}
    ${m.attachments.length ? `<div class="atts">${m.attachments.map((a) => `<a href="/api/mail/attachments/${a.id}">📎 ${esc(a.filename)} <small>${Math.ceil(a.size / 1024)} kB</small></a>`).join("")}</div>` : ""}
    ${m.body_html
      ? `<p class="muted" id="imgNote"><small>Externe afbeeldingen zijn geblokkeerd. <a href="#" id="loadImgs">Toch laden</a></small></p><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`
      : `<pre>${esc(m.body_text)}</pre>`}`;

  if (m.body_html) {
    const frame = $("iframe", r);
    const render = (allowImgs) => {
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: ${allowImgs ? "https: http:" : ""}; font-src data:">`;
      frame.srcdoc = `<!doctype html><html><head>${csp}<base target="_blank"><style>body{font-family:system-ui,sans-serif;margin:12px;color:#111}</style></head><body>${m.body_html}</body></html>`;
      frame.onload = () => { frame.style.height = Math.max(400, frame.contentDocument?.body?.scrollHeight + 40 || 600) + "px"; };
    };
    render(false);
    $("#loadImgs").onclick = (e) => { e.preventDefault(); render(true); $("#imgNote").remove(); };
  }

  $$(".thread div", r).forEach((d) => (d.onclick = () => openMessage(Number(d.dataset.id))));
  r.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "back") { $("#tab-mail").classList.remove("reading"); return; }
    if (act === "reply") return openCompose({ to: m.from_addr, subject: /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject, text: `\n\nOp ${fmtFull(m.date)} schreef ${m.from_name || m.from_addr}:\n` + (m.body_text || "").split("\n").map((l) => "> " + l).join("\n"), replyToId: m.id });
    if (act === "forward") return openCompose({ subject: "Fwd: " + m.subject, text: `\n\n---------- Doorgestuurd bericht ----------\nVan: ${m.from_name} <${m.from_addr}>\nDatum: ${fmtFull(m.date)}\nOnderwerp: ${m.subject}\n\n${m.body_text || ""}` });
    if (act === "star") { await api("/api/mail/messages/" + m.id, { method: "PATCH", body: { is_starred: !m.is_starred } }); return openMessage(m.id); }
    if (act === "unread") await api("/api/mail/messages/" + m.id, { method: "PATCH", body: { is_read: false } });
    if (act === "archive") await api("/api/mail/messages/" + m.id, { method: "PATCH", body: { folder: "archive" } });
    if (act === "inbox") await api("/api/mail/messages/" + m.id, { method: "PATCH", body: { folder: "inbox" } });
    if (act === "delete") { if (m.folder === "trash" && !confirm("Definitief verwijderen?")) return; await api("/api/mail/messages/" + m.id, { method: "DELETE" }); }
    mail.current = null;
    r.className = "reader empty"; r.innerHTML = `<p class="muted">Selecteer een bericht</p>`;
    $("#tab-mail").classList.remove("reading");
    loadMessages(); loadFolders();
  };
}

function openCompose(pre = {}) {
  const f = $("#composeForm");
  f.reset();
  for (const k of ["to", "subject", "text", "replyToId"]) if (pre[k] !== undefined) f.elements[k].value = pre[k];
  $("#composeError").textContent = "";
  $("#composeDlg").showModal();
  (pre.to ? f.elements.text : f.elements.to).focus();
  if (pre.text) f.elements.text.setSelectionRange(0, 0);
}

const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });

$("#composeForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "send") return;
  e.preventDefault();
  const f = e.target, btn = $("#sendBtn");
  btn.disabled = true; btn.textContent = "Versturen…";
  try {
    const attachments = await Promise.all([...f.elements.files.files].map(async (file) => ({ filename: file.name, contentType: file.type, base64: await fileToBase64(file) })));
    await api("/api/mail/send", { method: "POST", body: {
      to: f.elements.to.value, cc: f.elements.cc.value ? f.elements.cc.value.split(",").map((s) => s.trim()) : undefined,
      subject: f.elements.subject.value, text: f.elements.text.value, replyToId: Number(f.elements.replyToId.value) || undefined, attachments,
    } });
    $("#composeDlg").close();
    if (mail.folder === "sent") loadMessages();
  } catch (err) { $("#composeError").textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = "Versturen"; }
});

function initMail() {
  const menu = document.createElement("button");
  menu.className = "ghost back"; menu.type = "button"; menu.textContent = "☰";
  menu.onclick = () => $(".side").classList.toggle("open");
  $("#mailSearch").style.display = "flex"; $("#mailSearch").prepend(menu);

  $("#folders").onclick = $("#labels").onclick = (e) => {
    const li = e.target.closest("li"); if (!li) return;
    mail.q = ""; $("#mailQ").value = "";
    mail.label = li.dataset.label ?? null;
    mail.folder = li.dataset.starred ? "starred" : li.dataset.folder ?? mail.folder;
    $(".side").classList.remove("open");
    loadFolders(); loadMessages();
  };
  $("#messages").onclick = (e) => { const li = e.target.closest("li[data-id]"); if (li) openMessage(Number(li.dataset.id)); };
  $("#mailSearch").onsubmit = (e) => { e.preventDefault(); mail.q = $("#mailQ").value.trim(); loadFolders(); loadMessages(); };
  $("#moreMail").onclick = () => loadMessages(true);
  $("#compose").onclick = () => openCompose();
  loadFolders(); loadMessages();
  setInterval(() => { if (!$("#tab-mail").hidden && !mail.q) { loadFolders(); if (!mail.current) loadMessages(); } }, 60_000);
}

// ═════════════ AGENDA ═════════════
const cal = { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), selected: new Date(), events: [], calendars: [] };
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

async function loadCalendar() {
  const first = new Date(cal.month);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // maandag
  const end = new Date(start); end.setDate(start.getDate() + 42);
  cal.events = await api(`/api/events?from=${start.getTime()}&to=${end.getTime()}`);
  const color = (id) => cal.calendars.find((c) => c.id === id)?.color || "#3f6f4a";

  $("#calTitle").textContent = first.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
  const today = dayKey(new Date());
  let html = ["ma", "di", "wo", "do", "vr", "za", "zo"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const ds = d.getTime(), de = new Date(d).setDate(d.getDate() + 1);
    const evs = cal.events.filter((e) => e.occurrence_start < de && e.occurrence_end > ds);
    html += `<div class="day ${d.getMonth() !== first.getMonth() ? "other" : ""} ${dayKey(d) === today ? "today" : ""} ${dayKey(d) === dayKey(cal.selected) ? "sel" : ""}" data-ms="${ds}">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map((e) => `<div class="ev" style="background:${color(e.calendar_id)}">${e.all_day ? "" : fmtTime(e.occurrence_start) + " "}${esc(e.title)}</div>`).join("")}
      ${evs.length > 3 ? `<div class="muted" style="font-size:11px">+${evs.length - 3}</div>` : ""}
    </div>`;
  }
  $("#calGrid").innerHTML = html;
  renderDayList();
}

function renderDayList() {
  const ds = new Date(cal.selected); ds.setHours(0, 0, 0, 0);
  const de = new Date(ds); de.setDate(ds.getDate() + 1);
  const evs = cal.events.filter((e) => e.occurrence_start < de.getTime() && e.occurrence_end > ds.getTime());
  const color = (id) => cal.calendars.find((c) => c.id === id)?.color || "#3f6f4a";
  $("#dayList").innerHTML = `<h3 style="margin:8px 0 2px">${ds.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" })}</h3>` +
    (evs.map((e, i) => `<div class="item" data-i="${cal.events.indexOf(e)}" style="border-left-color:${color(e.calendar_id)}">
      <b>${esc(e.title)}</b> ${e.recurring ? "🔁" : ""}<br><small>${e.all_day ? "Hele dag" : fmtTime(e.occurrence_start) + " – " + fmtTime(e.occurrence_end)}${e.location ? " · 📍 " + esc(e.location) : ""}</small>
    </div>`).join("") || `<p class="muted">Geen afspraken</p>`);
}

const toLocalInput = (ms, dateOnly) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString();
  return dateOnly ? d.slice(0, 10) : d.slice(0, 16);
};

function openEvent(ev) {
  const f = $("#eventForm");
  f.reset();
  $("#calSelect").innerHTML = cal.calendars.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#eventDlgTitle").textContent = ev?.id ? "Afspraak bewerken" : "Nieuwe afspraak";
  $("#deleteEvent").hidden = !ev?.id;
  const start = ev?.start ?? (() => { const d = new Date(cal.selected); d.setHours(new Date().getHours() + 1, 0, 0, 0); return d.getTime(); })();
  const end = ev?.end ?? start + 3600e3;
  const allDay = !!ev?.all_day;
  f.elements.all_day.checked = allDay;
  setAllDayInputs(allDay);
  f.elements.start.value = toLocalInput(start, allDay);
  f.elements.end.value = toLocalInput(allDay ? end - 864e5 : end, allDay);
  for (const k of ["title", "location", "description", "id"]) f.elements[k].value = ev?.[k] ?? "";
  f.elements.rrule.value = ev?.rrule ?? "";
  if (ev?.rrule && !f.elements.rrule.value) { f.elements.rrule.add(new Option("Aangepast: " + ev.rrule, ev.rrule)); f.elements.rrule.value = ev.rrule; }
  f.elements.calendar_id.value = ev?.calendar_id ?? cal.calendars[0]?.id;
  f.elements.reminder_min.value = ev?.reminder_min ?? "";
  f.elements.occurrence.value = ev?.occurrence_start ?? "";
  $("#eventDlg").showModal();
}
function setAllDayInputs(allDay) {
  const f = $("#eventForm");
  for (const n of ["start", "end"]) {
    const v = f.elements[n].value;
    f.elements[n].type = allDay ? "date" : "datetime-local";
    if (v) f.elements[n].value = allDay ? v.slice(0, 10) : v.length === 10 ? v + "T09:00" : v;
  }
}
$("#eventForm").elements.all_day.onchange = (e) => setAllDayInputs(e.target.checked);

$("#eventForm").addEventListener("submit", async (e) => {
  const action = e.submitter?.value;
  if (action === "cancel") return;
  e.preventDefault();
  const f = e.target, id = f.elements.id.value;
  if (action === "delete") {
    const occ = f.elements.occurrence.value;
    const onlyThis = f.elements.rrule.value && occ && confirm("Alleen deze herhaling verwijderen?\n(Annuleren = de hele reeks)");
    await api(`/api/events/${id}${onlyThis ? "?occurrence=" + occ : ""}`, { method: "DELETE" });
  } else {
    const allDay = f.elements.all_day.checked;
    let start = new Date(allDay ? f.elements.start.value + "T00:00:00Z" : f.elements.start.value).getTime();
    let end = new Date(allDay ? f.elements.end.value + "T00:00:00Z" : f.elements.end.value).getTime() + (allDay ? 864e5 : 0);
    if (end <= start) end = start + (allDay ? 864e5 : 3600e3);
    const body = {
      title: f.elements.title.value, location: f.elements.location.value || null, description: f.elements.description.value || null,
      start, end, all_day: allDay, rrule: f.elements.rrule.value || null, calendar_id: Number(f.elements.calendar_id.value),
      reminder_min: f.elements.reminder_min.value ? Number(f.elements.reminder_min.value) : null, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    await api(id ? "/api/events/" + id : "/api/events", { method: id ? "PATCH" : "POST", body });
  }
  $("#eventDlg").close();
  loadCalendar();
});

async function initAgenda() {
  cal.calendars = await api("/api/calendars");
  $("#calGrid").onclick = (e) => { const d = e.target.closest(".day"); if (!d) return; cal.selected = new Date(Number(d.dataset.ms)); $$(".day").forEach((x) => x.classList.toggle("sel", x === d)); renderDayList(); };
  $("#calGrid").ondblclick = (e) => { if (e.target.closest(".day")) openEvent(); };
  $("#dayList").onclick = async (e) => {
    const it = e.target.closest(".item"); if (!it) return;
    const occ = cal.events[Number(it.dataset.i)];
    const full = await api("/api/events/" + occ.id);
    openEvent({ ...full, occurrence_start: occ.recurring ? occ.occurrence_start : undefined });
  };
  $("#calPrev").onclick = () => { cal.month.setMonth(cal.month.getMonth() - 1); loadCalendar(); };
  $("#calNext").onclick = () => { cal.month.setMonth(cal.month.getMonth() + 1); loadCalendar(); };
  $("#calToday").onclick = () => { const n = new Date(); cal.month = new Date(n.getFullYear(), n.getMonth(), 1); cal.selected = n; loadCalendar(); };
  $("#newEvent").onclick = () => openEvent();
  loadCalendar();
}

// ═════════════ FOTO'S ═════════════
const ph = { items: [], done: false, loading: false, filter: "", album: "", index: -1 };

async function loadPhotos(reset = false) {
  if (ph.loading || (ph.done && !reset)) return;
  ph.loading = true;
  if (reset) { ph.items = []; ph.done = false; $("#photoGrid").innerHTML = ""; }
  const p = new URLSearchParams({ limit: "150" });
  if (ph.filter) p.set(ph.filter, "1");
  if (ph.album) p.set("album", ph.album);
  const last = ph.items.at(-1);
  if (last) { p.set("before", last.taken_at); p.set("beforeId", last.id); }
  const rows = await api("/api/photos?" + p);
  ph.done = rows.length < 150;
  let lastMonth = last ? new Date(last.taken_at).toLocaleDateString("nl-NL", { month: "long", year: "numeric" }) : "";
  let html = "";
  for (const r of rows) {
    const m = new Date(r.taken_at).toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
    if (m !== lastMonth) { html += `<h3>${m}</h3>`; lastMonth = m; }
    html += `<div class="ph" data-i="${ph.items.length}">${r.has_thumb ? `<img loading="lazy" src="/api/photos/${r.id}/thumb" alt="">` : `<div class="muted" style="padding:8px;font-size:12px">${esc(r.filename)}</div>`}
      <span class="badge">${r.is_video ? "▶" : ""}${r.is_favorite ? " ★" : ""}</span></div>`;
    ph.items.push(r);
  }
  $("#photoGrid").insertAdjacentHTML("beforeend", html);
  if (!ph.items.length) $("#photoGrid").innerHTML = `<p class="muted">Nog geen foto's. Upload er een paar of importeer je Google Foto's.</p>`;
  ph.loading = false;
}

function showPhoto(i) {
  if (i < 0 || i >= ph.items.length) return;
  ph.index = i;
  const p = ph.items[i], src = `/api/photos/${p.id}/original`;
  $("#pvMedia").innerHTML = p.is_video ? `<video src="${src}" controls autoplay playsinline></video>` : `<img src="${src}" alt="">`;
  $("#pvInfo").textContent = `${fmtFull(p.taken_at)}${p.camera ? " · " + p.camera : ""}${p.description ? " · " + p.description : ""}`;
  $("#pvFav").textContent = p.is_favorite ? "★" : "☆";
  $("#pvDownload").href = src + "?download=1";
  if (!$("#photoDlg").open) $("#photoDlg").showModal();
  if (i > ph.items.length - 10) loadPhotos();
}

async function uploadFiles(files) {
  const list = [...files];
  let done = 0, added = 0, dup = 0;
  for (let i = 0; i < list.length; i += 5) {
    const fd = new FormData();
    for (const f of list.slice(i, i + 5)) { fd.append("lastModified", String(f.lastModified)); fd.append("file", f, f.name); }
    const res = await api("/api/photos/upload", { method: "POST", body: fd });
    for (const r of res) { done++; if (r.duplicate) dup++; else if (r.id) added++; }
    $("#uploadStatus").textContent = `Uploaden… ${done}/${list.length}`;
  }
  $("#uploadStatus").textContent = `✅ ${added} toegevoegd${dup ? `, ${dup} stond er al` : ""}`;
  loadPhotos(true);
}

async function initPhotos() {
  const albums = await api("/api/albums");
  $("#albumFilter").innerHTML = `<option value="">Alle albums</option>` + albums.map((a) => `<option value="${a.id}">${esc(a.name)} (${a.count})</option>`).join("");
  $("#photoFilter").onchange = (e) => { ph.filter = e.target.value; loadPhotos(true); };
  $("#albumFilter").onchange = (e) => { ph.album = e.target.value; loadPhotos(true); };
  $("#uploadInput").onchange = (e) => uploadFiles(e.target.files);
  $("#photoGrid").onclick = (e) => { const t = e.target.closest(".ph"); if (t) showPhoto(Number(t.dataset.i)); };
  $("#pvPrev").onclick = () => showPhoto(ph.index - 1);
  $("#pvNext").onclick = () => showPhoto(ph.index + 1);
  $("#pvClose").onclick = () => { $("#pvMedia").innerHTML = ""; $("#photoDlg").close(); };
  $("#pvFav").onclick = async () => { const p = ph.items[ph.index]; p.is_favorite = p.is_favorite ? 0 : 1; await api("/api/photos/" + p.id, { method: "PATCH", body: { is_favorite: !!p.is_favorite } }); showPhoto(ph.index); };
  $("#pvDelete").onclick = async () => {
    if (!confirm("Deze foto definitief verwijderen?")) return;
    const p = ph.items[ph.index];
    await api("/api/photos/" + p.id, { method: "DELETE" });
    $(`.ph[data-i="${ph.index}"]`)?.remove();
    ph.items.splice(ph.index, 1);
    $("#photoDlg").close(); loadPhotos(true);
  };
  document.addEventListener("keydown", (e) => {
    if (!$("#photoDlg").open) return;
    if (e.key === "ArrowLeft") showPhoto(ph.index - 1);
    if (e.key === "ArrowRight") showPhoto(ph.index + 1);
  });
  let touchX = 0;
  $("#pvMedia").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
  $("#pvMedia").addEventListener("touchend", (e) => { const dx = e.changedTouches[0].clientX - touchX; if (Math.abs(dx) > 60) showPhoto(ph.index + (dx < 0 ? 1 : -1)); });
  new IntersectionObserver((en) => { if (en[0].isIntersecting) loadPhotos(); }, { root: $("#tab-fotos"), rootMargin: "800px" }).observe($("#photoSentinel"));
  // Slepen & neerzetten
  $("#tab-fotos").addEventListener("dragover", (e) => e.preventDefault());
  $("#tab-fotos").addEventListener("drop", (e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); });
  loadPhotos(true);
}

boot();

// ═════════════ WAAR DRAAI IK (cluster) ═════════════
const FLAGS = { NL: "🇳🇱", DE: "🇩🇪", FI: "🇫🇮", FR: "🇫🇷", PL: "🇵🇱", SE: "🇸🇪", ES: "🇪🇸", AT: "🇦🇹", CH: "🇨🇭", BE: "🇧🇪", DK: "🇩🇰", NO: "🇳🇴", IT: "🇮🇹" };
const STATUS_NL = { provisioning: "wordt aangemaakt", syncing: "synchroniseert", ready: "actief", removing: "wordt verwijderd", removed: "verwijderd", failed: "mislukt" };
const ago = (ms) => { if (!ms) return "nooit"; const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? "nu" : s < 90 ? `${s} s geleden` : s < 5400 ? `${Math.round(s / 60)} min geleden` : `${Math.round(s / 3600)} u geleden`; };
const eur = (n) => n == null ? "" : "€ " + Number(n).toFixed(2).replace(".", ",");
let cluster = null;

async function loadCluster() {
  cluster = await api("/api/cluster/status");
  if (!cluster.enabled) return;
  const c = cluster;
  const active = c.nodes.filter((n) => n.status !== "removed");
  const countries = [...new Set(active.map((n) => n.country).filter(Boolean))];
  $("#clusterSummary").innerHTML = [
    `<span class="pill ${c.sleeping ? "warn" : "ok"}">${c.sleeping ? "😴 slaapt" : "🐌 wakker"}</span>`,
    `<span class="pill">Leider: <b>${esc(c.nodes.find((n) => n.isLeader)?.place ?? c.leader)}</b></span>`,
    `<span class="pill">${active.filter((n) => n.kind === "data").length} dataservers, ${active.filter((n) => n.kind === "witness").length} witness</span>`,
    `<span class="pill">${countries.map((x) => FLAGS[x] || x).join(" ")} ${countries.length} ${countries.length === 1 ? "land" : "landen"}</span>`,
    `<span class="pill">${eur(c.monthlyCost)} / maand</span>`,
    c.blobQueue ? `<span class="pill warn">${c.blobQueue} bestanden wachten op upload</span>` : "",
  ].join("");

  $("#nodeMap").innerHTML = europeMap(active.map((n) => ({ ...n, status: n.status })));
  $("#nodeCards").innerHTML = active.map((n) => {
    const stale = n.status === "ready" && !n.isSelf && n.lastContact && Date.now() - n.lastContact > 15000;
    const roleText = n.kind === "witness" ? "Witness · beslist mee bij storingen" : n.isLeader ? "Dataserver · leidt nu" : "Dataserver · houdt alles bij";
    return `<div class="node ${n.isLeader ? "leader" : ""} ${stale ? "down" : ""}">
      <div class="top"><span class="flag">${FLAGS[n.country] || "🖥️"}</span><span class="name">${esc(n.place || n.id)}</span></div>
      <div class="meta"><span class="dot ${stale ? "stale" : n.status}"></span>${stale ? "onbereikbaar" : STATUS_NL[n.status] || n.status} · ${roleText}<br>
        ${n.monthly_cost != null ? eur(n.monthly_cost) + " per maand · " : ""}contact ${n.isSelf ? "nu (deze server)" : ago(n.lastContact)}${n.kind === "data" && n.lag ? ` · ${n.lag} wijzigingen achter` : ""}</div>
      <div class="tech">${esc(n.id)} · ${esc(n.size ?? "")}${n.ipv4 ? " · " + esc(n.ipv4) : ""}</div>
      ${n.status === "ready" ? `<div class="acts"><button class="ghost" data-move="${n.id}">↪ Verhuizen</button><button class="ghost danger" data-remove="${n.id}">Opheffen</button></div>` : ""}
    </div>`;
  }).join("");

  $("#storeList").innerHTML = c.stores.map((s) => `<div class="store"><span>${FLAGS[s.country] || "🗄️"} <b>${esc(s.name)}</b> · ${s.purpose === "backup" ? "back-up (onveranderbaar)" : "werkkopie"}</span>
    <span class="${s.uploadedSeq != null && c.lastSeq - s.uploadedSeq > 50 ? "error" : "muted"}">${s.uploadedSeq == null ? "?" : c.lastSeq - s.uploadedSeq === 0 ? "✓ bij" : `${c.lastSeq - s.uploadedSeq} achter`}</span></div>`).join("");

  const f = $("#policyForm");
  if (document.activeElement?.form !== f) {
    f.elements.autoHeal.checked = !!c.policy.autoHeal;
    for (const k of ["minDataNodes", "witnesses", "autoReplaceAfterMin"]) f.elements[k].value = c.policy[k];
  }
  const JOB = { spawn: "Server aanmaken", move: "Verhuizen", remove: "Server opheffen", sleep: "Laten slapen", drill: "Back-up testen", snapshot: "Back-up maken" };
  const JST = { pending: "wacht", running: "bezig", done: "klaar", failed: "mislukt" };
  $("#jobList").innerHTML = c.jobs.map((j) => `<li class="${j.status === "failed" ? "error" : ""}"><time>${fmtDate(j.created)}</time><b>${JOB[j.type] ?? esc(j.type)}</b> · ${JST[j.status] ?? esc(j.status)}${j.error && j.status !== "done" ? " — " + esc(j.error) : ""}</li>`).join("") || `<li class="muted">Niets bezig</li>`;
  $("#eventList").innerHTML = c.events.map((e) => `<li class="${e.level}"><time>${fmtDate(e.ts)}</time>${esc(e.message)}</li>`).join("");
}

function choosePlacement(title, kind) {
  return new Promise((resolve) => {
    const opts = cluster.policy.placement.filter((p) => !p.kind || p.kind === kind);
    if (!opts.length) { alert("Er staan nog geen plaatsingsopties in het beleid (cluster-configuratie)."); return resolve(null); }
    $("#placeTitle").textContent = title;
    $("#placeSelect").innerHTML = `<option value="auto">Automatisch (spreiden over aanbieders en landen)</option>` +
      opts.map((p, i) => `<option value="${i}">${FLAGS[p.country] || ""} ${esc(p.provider)} / ${esc(p.region)} · ${esc(p.size)}</option>`).join("");
    $("#placeHint").textContent = "De nieuwe server haalt zelf de versleutelde data op en sluit aan. Dat duurt meestal een paar minuten.";
    const dlg = $("#placeDlg");
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? ($("#placeSelect").value === "auto" ? "auto" : opts[Number($("#placeSelect").value)]) : null);
    dlg.showModal();
  });
}

async function startJob(type, params = {}) {
  try { await api("/api/cluster/jobs", { method: "POST", body: { type, params } }); await loadCluster(); }
  catch (e) { alert(e.message); }
}

async function initNodes() {
  $("#addData").onclick = async () => { const p = await choosePlacement("Nieuwe data-node", "data"); if (p) startJob("spawn", { kind: "data", ...(p === "auto" ? {} : p) }); };
  $("#addWitness").onclick = async () => { const p = await choosePlacement("Nieuwe witness", "witness"); if (p) startJob("spawn", { kind: "witness", ...(p === "auto" ? {} : p) }); };
  $("#runDrill").onclick = () => startJob("drill");
  $("#runSnapshot").onclick = () => startJob("snapshot");
  $("#sleepCluster").onclick = () => {
    if (confirm("Cluster laten slapen?\n\nAlles wordt versleuteld weggeschreven en daarna worden ALLE servers verwijderd. Je betaalt dan alleen nog voor opslag.\nWekken doe je met: eigen wake")) startJob("sleep");
  };
  $("#nodeCards").onclick = async (e) => {
    const mv = e.target.closest("[data-move]")?.dataset.move, rm = e.target.closest("[data-remove]")?.dataset.remove;
    if (mv) { const n = cluster.nodes.find((x) => x.id === mv); const p = await choosePlacement(`${mv} verhuizen naar…`, n.kind); if (p) startJob("move", { nodeId: mv, ...(p === "auto" ? {} : { to: p }) }); }
    if (rm && confirm(`${rm} verwijderen? Het beleid maakt eventueel automatisch een vervanger.`)) startJob("remove", { nodeId: rm });
  };
  $("#policyForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await api("/api/cluster/policy", { method: "PUT", body: { autoHeal: f.elements.autoHeal.checked, minDataNodes: Number(f.elements.minDataNodes.value), witnesses: Number(f.elements.witnesses.value), autoReplaceAfterMin: Number(f.elements.autoReplaceAfterMin.value) } });
    loadCluster();
  };
  await loadCluster();
  setInterval(() => { if (!$("#tab-nodes").hidden) loadCluster().catch(() => {}); }, 3000);
}


// ═════════════ GEZONDHEID ═════════════
const GLYPH = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
let healthData = null;

async function refreshHealthBanner(fresh = false) {
  try { healthData = await api("/api/health" + (fresh ? "?fresh=1" : "")); } catch { return; }
  const { summary } = healthData;
  const b = $("#healthBanner"), dot = $("#healthDot");
  const n = summary.fail + summary.warn;
  dot.hidden = !n;
  dot.classList.toggle("fail", summary.fail > 0);
  if (summary.fail) {
    b.hidden = false;
    b.className = "health-banner fail";
    b.innerHTML = `<span>${summary.fail === 1 ? "Er is één probleem" : `Er zijn ${summary.fail} problemen`} met je cloud.</span><a href="#instellingen/gezondheid">Bekijken en oplossen</a>`;
  } else b.hidden = true;
  if (!$("#tab-instellingen").hidden) renderHealth();
}

function renderHealth() {
  if (!healthData) return;
  const { checks, summary, checkedAt } = healthData;
  $("#healthSummary").textContent = summary.fail || summary.warn
    ? `${summary.ok} in orde, ${summary.warn} let op, ${summary.fail} probleem${summary.fail === 1 ? "" : "en"} · gecontroleerd om ${fmtTime(checkedAt)}`
    : `Alles in orde · gecontroleerd om ${fmtTime(checkedAt)}`;
  const groups = ["Mail", "Domein", "Back-up", "Servers", "Meldingen"];
  const order = { fail: 0, warn: 1, ok: 2, skip: 3 };
  $("#healthList").innerHTML = groups.map((g) => {
    const items = checks.filter((c) => c.group === g).sort((a, b) => order[a.status] - order[b.status]);
    if (!items.length) return "";
    return `<div><h3>${g}</h3><ul class="checks">${items.map((c) => `
      <li class="${c.status}"><span class="glyph" aria-label="${c.status}">${GLYPH[c.status]}</span>
        <span class="title">${esc(c.title)}</span>
        ${c.fix ? `<span class="act"><button class="ghost" data-fix="${c.fix.action}">${esc(c.fix.label)}</button></span>` : ""}
        <span class="detail">${esc(c.detail)}</span>
        ${c.manual ? `<div class="records"><span class="muted"><small>Zet dit record bij je DNS-beheerder:</small></span>${c.manual.map((r, i) => `<div class="rec"><span class="rtype">${r.type}</span><code>${esc(r.name)}</code><code id="rec-${c.id}-${i}">${esc(r.value)}</code><button class="ghost" data-copytext="${esc(r.value)}">Kopiëren</button></div>`).join("")}</div>` : ""}
      </li>`).join("")}</ul></div>`;
  }).join("");
}

// ═════════════ INSTELLINGEN ═════════════
let settings = null;
const RELAYS = {
  none: { hint: "Je server levert mail zelf af. Dat werkt alleen als je aanbieder poort 25 openzet, en na een verhuizing moet het nieuwe IP-adres eerst vertrouwen opbouwen." },
  scaleway: { host: "smtp.tem.scw.cloud", port: 465, secure: true, hint: "Scaleway Transactional Email (Frankrijk). Gebruikersnaam is je project-ID, wachtwoord een API-sleutel. Controleer de servernaam in je Scaleway-console." },
  brevo: { host: "smtp-relay.brevo.com", port: 587, secure: false, spf: "include:spf.brevo.com", hint: "Brevo (Frankrijk). Gebruikersnaam en SMTP-sleutel vind je onder SMTP & API." },
  custom: { hint: "Elke SMTP-relay die je vertrouwt." },
};

function showSettings(sec) {
  $$("#settingsNav a").forEach((a) => a.classList.toggle("active", a.dataset.sec === sec));
  $$(".settings-sec").forEach((s) => (s.hidden = s.dataset.sec !== sec));
  if (sec === "gezondheid") healthData ? renderHealth() : refreshHealthBanner();
  if (sec === "tijdmachine") loadTimeMachine();
  if (sec === "importeren") loadUploads();
}

function msg(el, text, ok) { el.textContent = text; el.className = "form-msg " + (ok ? "ok" : "err"); }

async function initSettings() {
  settings = await api("/api/settings");
  const f = $("#mailForm");
  f.elements.mailFrom.value = settings.mailFrom;
  f.elements.alertEmail.value = settings.alertEmail;
  f.elements.spfExtra.value = settings.spfExtra;
  const r = settings.relay;
  const preset = !r ? "none" : r.host === RELAYS.scaleway.host ? "scaleway" : r.host === RELAYS.brevo.host ? "brevo" : "custom";
  f.elements.preset.value = preset;
  if (r) { f.elements.host.value = r.host; f.elements.port.value = r.port; f.elements.user.value = r.user; f.elements.secure.checked = r.secure; }
  const applyPreset = (fill) => {
    const p = f.elements.preset.value, d = RELAYS[p];
    $(".relay-fields").hidden = p === "none";
    $("#relayHint").textContent = d.hint;
    if (fill && d.host) { f.elements.host.value = d.host; f.elements.port.value = d.port; f.elements.secure.checked = d.secure; if (d.spf) f.elements.spfExtra.value = d.spf; }
  };
  applyPreset(false);
  $("#relayPreset").onchange = () => applyPreset(true);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const none = f.elements.preset.value === "none";
    try {
      await api("/api/settings", { method: "PUT", body: {
        mailFrom: f.elements.mailFrom.value, alertEmail: f.elements.alertEmail.value, spfExtra: none ? "" : f.elements.spfExtra.value,
        relay: none ? null : { host: f.elements.host.value, port: Number(f.elements.port.value), user: f.elements.user.value, password: f.elements.password.value || undefined, secure: f.elements.secure.checked },
      } });
      f.elements.password.value = "";
      msg($("#mailMsg"), "Opgeslagen. DNS wordt zo nodig automatisch bijgewerkt.", true);
      refreshHealthBanner(true);
    } catch (err) { msg($("#mailMsg"), err.message, false); }
  };
  $("#testMail").onclick = async () => {
    msg($("#mailMsg"), "Versturen…", true);
    try { const r = await api("/api/settings/test-mail", { method: "POST", body: {} }); msg($("#mailMsg"), `Testbericht verstuurd naar ${r.to}. Kijk of het aankomt (ook in je spammap).`, true); }
    catch (err) { msg($("#mailMsg"), err.message, false); }
  };

  $("#pwForm").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/settings/password", { method: "POST", body: { current: e.target.elements.current.value, next: e.target.elements.next.value } }); e.target.reset(); msg($("#pwMsg"), "Wachtwoord gewijzigd.", true); }
    catch (err) { msg($("#pwMsg"), err.message, false); }
  };

  if (settings.icalUrl) {
    $("#icalUrl").value = settings.icalUrl;
    $("#icalQr").innerHTML = await (await fetch("/api/settings/ical-qr")).text();
  } else $("#icalUrl").value = "Niet beschikbaar (geen agenda-token ingesteld)";

  $("#healthRefresh").onclick = async () => { $("#healthRefresh").disabled = true; await refreshHealthBanner(true); $("#healthRefresh").disabled = false; };
  $("#healthList").onclick = async (e) => {
    const fix = e.target.closest("[data-fix]")?.dataset.fix;
    const copy = e.target.closest("[data-copytext]");
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copytext); copy.textContent = "Gekopieerd"; return; }
    if (!fix) return;
    e.target.disabled = true; e.target.textContent = "Bezig…";
    try { const r = await api("/api/health/fix", { method: "POST", body: { action: fix } }); e.target.textContent = "✓"; $("#healthSummary").textContent = r.message; setTimeout(() => refreshHealthBanner(true), 1500); }
    catch (err) { e.target.textContent = "Opnieuw"; e.target.disabled = false; alert(err.message); }
  };
  document.addEventListener("click", (e) => {
    const id = e.target.closest("[data-copy]")?.dataset.copy;
    if (id) { navigator.clipboard?.writeText($("#" + id).value); e.target.textContent = "Gekopieerd"; }
  });
  initImport();
}

// ═════════════ IMPORTEREN ═════════════
const CHUNK = 8 * 1024 * 1024;
const pending = new Map(); // naam|grootte → File
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " kB";
let importTimer = null;

async function loadUploads() {
  const ups = await api("/api/import/uploads");
  for (const f of pending.values()) if (!ups.some((u) => u.name === f.name && u.size === f.size)) ups.push({ name: f.name, size: f.size, received: 0, local: true });
  $("#uploadList").innerHTML = ups.map((u) => {
    const pct = Math.floor((u.received / u.size) * 100);
    const waiting = u.received < u.size && !pending.has(u.name + "|" + u.size);
    return `<li><span>${esc(u.name)}</span><span class="size">${fmtSize(u.size)}</span><span class="muted">${u.received >= u.size ? "klaar" : waiting ? "onderbroken — kies het bestand opnieuw" : pct + "%"}</span><span class="bar"><i style="width:${pct}%"></i></span></li>`;
  }).join("");
  $("#startImport").disabled = !ups.length || ups.some((u) => u.received < u.size);
  const st = await api("/api/import/status");
  if (st.progress) renderImport(st);
}

async function uploadFile(file) {
  const key = file.name + "|" + file.size;
  pending.set(key, file);
  let meta = await api("/api/import/uploads", { method: "POST", body: { name: file.name, size: file.size } });
  let offset = meta.received;
  while (offset < file.size) {
    const blob = file.slice(offset, offset + CHUNK);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`/api/import/uploads/${meta.id}?offset=${offset}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: blob });
        const j = await r.json();
        if (r.status === 409) { offset = j.received; break; }
        if (!r.ok) throw new Error(j.error);
        offset = j.received;
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
      }
    }
    const li = [...$$("#uploadList li")].find((x) => x.firstElementChild.textContent === file.name);
    if (li) { li.querySelector(".bar i").style.width = Math.floor((offset / file.size) * 100) + "%"; li.children[2].textContent = Math.floor((offset / file.size) * 100) + "%"; }
  }
  pending.delete(key);
}

function initImport() {
  const dz = $("#dropzone");
  const take = async (files) => {
    const list = [...files].filter((f) => /\.(zip|mbox|ics)$/i.test(f.name));
    if (!list.length) return alert("Kies .zip-bestanden van Google Takeout (of .mbox / .ics).");
    for (const f of list) pending.set(f.name + "|" + f.size, f);
    await loadUploads();
    for (const f of list) { try { await uploadFile(f); } catch (e) { alert(`${f.name}: ${e.message}`); } }
    loadUploads();
  };
  $("#takeoutInput").onchange = (e) => take(e.target.files);
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); take(e.dataTransfer.files); });
  $("#startImport").onclick = async () => {
    try { await api("/api/import/start", { method: "POST", body: {} }); pollImport(); }
    catch (e) { alert(e.message); }
  };
}

function pollImport() {
  clearInterval(importTimer);
  const tick = async () => {
    const st = await api("/api/import/status");
    renderImport(st);
    if (!st.running) { clearInterval(importTimer); loadUploads(); }
  };
  importTimer = setInterval(tick, 1500);
  tick();
}

function renderImport(st) {
  const p = st.progress, el = $("#importProgress");
  if (!p) return;
  el.hidden = false;
  const phase = st.error ? `Gestopt: ${st.error}` : st.running ? `Bezig met ${p.phase}${p.file ? ` — ${p.file}` : ""}…` : "Klaar met importeren";
  el.innerHTML = `<div class="phase">${esc(phase)}</div>
    <div class="counters"><div><b>${p.mail.added}</b>mails${p.mail.skipped ? ` · ${p.mail.skipped} al aanwezig` : ""}</div>
    <div><b>${p.calendar.added + p.calendar.updated}</b>afspraken in ${p.calendar.calendars} agenda${p.calendar.calendars === 1 ? "" : "'s"}</div>
    <div><b>${p.photos.added}</b>foto's en video's${p.photos.duplicates ? ` · ${p.photos.duplicates} al aanwezig` : ""}</div></div>
    ${p.log.length ? `<ul>${p.log.slice(-8).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}`;
  if (st.running && !importTimer) pollImport();
}

// ═════════════ TIJDMACHINE ═════════════
let tmPreview = null;
const toInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 19);

async function loadTimeMachine() {
  const info = await api("/api/timemachine");
  const body = $("#tmBody");
  if (!info.available) { body.innerHTML = `<p class="empty-note">${esc(info.reason)}</p>`; return; }
  const def = Date.now() - 864e5;
  body.innerHTML = `
    <form class="tm-pick" id="tmForm">
      <label>Hoe zag het eruit op<input type="datetime-local" name="at" step="1" min="${toInput(info.oldest)}" max="${toInput(Date.now())}" value="${toInput(Math.max(def, info.oldest))}" required></label>
      <button class="primary">Bekijken</button>
    </form>
    <div class="chips"><button data-ago="3600000">1 uur geleden</button><button data-ago="86400000">Gisteren</button><button data-ago="604800000">Vorige week</button><button data-ago="2592000000">Vorige maand</button></div>
    <p class="muted"><small>Terug tot ${fmtFull(info.oldest)}.</small></p>
    <div id="tmResult" class="tm-result"></div>`;
  const f = $("#tmForm");
  $(".chips", body).onclick = (e) => { const ago = e.target.dataset.ago; if (ago) { f.elements.at.value = toInput(Math.max(info.oldest, Date.now() - Number(ago))); f.requestSubmit(); } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#tmResult");
    out.innerHTML = `<p class="muted">Back-up van dat moment wordt opgehaald en vergeleken…</p>`;
    try {
      tmPreview = await api("/api/timemachine/preview", { method: "POST", body: { at: new Date(f.elements.at.value).getTime() } });
      renderTm();
    } catch (err) { out.innerHTML = `<p class="form-msg err">${esc(err.message)}</p>`; }
  };
}

function renderTm() {
  const { items, counts, at, id } = tmPreview;
  const total = counts.messages + counts.events + counts.photos;
  const out = $("#tmResult");
  if (!total) { out.innerHTML = `<p class="empty-note">Op ${fmtFull(at)} was alles hetzelfde als nu. Er is niets terug te halen.</p>`; return; }
  out.innerHTML = `<p>Op <b>${fmtFull(at)}</b> was er dit dat nu ontbreekt of anders is. Kies wat je terug wilt.</p>
    ${items.messages.length ? `<div class="tm-group"><h3>Mails <button type="button" class="ghost" data-all="m">alles</button></h3><ul class="tm-items">${items.messages.map((m) => `<li><label><input type="checkbox" data-m="${m.id}"><span><b>${esc(m.subject)}</b><br><small class="muted">${esc(m.from_name || m.from_addr)} · ${fmtDate(m.date)}</small></span><span class="why">${m.reason}</span></label></li>`).join("")}</ul></div>` : ""}
    ${items.events.length ? `<div class="tm-group"><h3>Afspraken <button type="button" class="ghost" data-all="e">alles</button></h3><ul class="tm-items">${items.events.map((e) => `<li><label><input type="checkbox" data-e="${esc(e.uid)}"><span><b>${esc(e.title)}</b><br><small class="muted">${e.all_day ? new Date(e.start).toLocaleDateString("nl-NL", { dateStyle: "medium" }) : fmtFull(e.start)}</small></span><span class="why">${e.reason}</span></label></li>`).join("")}</ul></div>` : ""}
    ${items.photos.length ? `<div class="tm-group"><h3>Foto's <button type="button" class="ghost" data-all="p">alles</button></h3><div class="tm-photos">${items.photos.map((p) => `<label title="${esc(p.filename)} · ${p.reason}"><input type="checkbox" data-p="${p.id}">${p.has_thumb ? `<img loading="lazy" src="/api/timemachine/${id}/photos/${p.id}/thumb" alt="">` : `<small>${esc(p.filename)}</small>`}</label>`).join("")}</div></div>` : ""}
    <div class="tm-actions"><button class="primary" id="tmRestore" disabled>Terugzetten</button><span class="muted" id="tmCount"></span></div>`;
  const update = () => {
    const n = $$("input[type=checkbox]:checked", out).length;
    $("#tmRestore").disabled = !n;
    $("#tmRestore").textContent = n ? `${n} terugzetten` : "Terugzetten";
  };
  out.onchange = update;
  out.onclick = async (e) => {
    const all = e.target.dataset.all;
    if (all) { const boxes = $$(`[data-${all}]`, out).filter((x) => x.tagName === "INPUT"); const on = boxes.some((b) => !b.checked); boxes.forEach((b) => (b.checked = on)); update(); }
    if (e.target.id === "tmRestore") {
      e.target.disabled = true; e.target.textContent = "Bezig…";
      const pick = (k) => $$(`input[data-${k}]:checked`, out).map((x) => x.dataset[k]);
      try {
        const r = await api("/api/timemachine/restore", { method: "POST", body: { id, messages: pick("m").map(Number), events: pick("e"), photos: pick("p").map(Number) } });
        const { messages, events, photos } = r.restored;
        out.innerHTML = `<p class="form-msg ok">Teruggezet: ${messages} mail${messages === 1 ? "" : "s"}, ${events} afspra${events === 1 ? "ak" : "ken"} en ${photos} foto${photos === 1 ? "" : "'s"}.</p>`;
      } catch (err) { e.target.disabled = false; e.target.textContent = "Opnieuw proberen"; alert(err.message); }
    }
  };
}
