// Eigen Cloud — webclient (geen build-stap nodig)
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
  switchTab(location.hash.slice(1) || "mail");
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await api("/api/login", { method: "POST", body: { password: $("#password").value } }); $("#password").value = ""; boot(); }
  catch (err) { $("#loginError").textContent = err.message; }
});
$("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); showLogin(); };

// ───────────── Tabs ─────────────
const loaded = {};
function switchTab(tab) {
  if (!["mail", "agenda", "fotos"].includes(tab)) tab = "mail";
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + tab));
  history.replaceState(null, "", "#" + tab);
  if (!loaded[tab]) { loaded[tab] = true; ({ mail: initMail, agenda: initAgenda, fotos: initPhotos })[tab](); }
}
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
  const color = (id) => cal.calendars.find((c) => c.id === id)?.color || "#3b82f6";

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
  const color = (id) => cal.calendars.find((c) => c.id === id)?.color || "#3b82f6";
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
