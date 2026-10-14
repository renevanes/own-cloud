// Op deze telefoon: je Google-agenda (met eigen reservekopie), je foto's (galerij, Uit Google Foto's halen, foto's
// uit je cloud) en wat het aan ruimte kost. Praat met de app via window.EigenDevice (OnPhoneActivity).
(function () {
  "use strict";
  var dev = window.EigenDevice;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var DAY = 86400000;

  // ── Brug: call(methode, args) → Promise ──
  var seq = 0, waiting = {};
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      if (!dev) { reject(new Error("Werk de app bij om dit te gebruiken.")); return; }
      var id = "v" + (++seq);
      waiting[id] = { resolve: resolve, reject: reject };
      dev.call(id, method, JSON.stringify(args || {}));
    });
  }
  window.addEventListener("eigendevice", function (e) {
    var d = e.detail || {};
    if (d.type === "result") {
      var w = waiting[d.id];
      if (!w) return;
      delete waiting[d.id];
      if (d.ok) w.resolve(d.data); else w.reject(new Error(d.error || "Er ging iets mis"));
      return;
    }
    if (d.type === "permission") { permMsg = d.granted ? "" : "Zonder toestemming gaat het niet. Je kunt het later nog aanzetten bij de instellingen van de app."; route(); return; }
    if (d.type === "takeout") { takeoutMsg = d.error || (d.cancelled ? "" : "Gekozen. De app doorzoekt nu je bestanden en begint daarna met uploaden."); renderFotos(); return; }
    if (d.type === "saved") { flash(d.error ? d.error : "Bewaard als bestand.", !!d.error); return; }
    if (d.type === "changed") refreshQuiet();
  });

  // ── Opmaak ──
  function nf(n) { return Number(n || 0).toLocaleString("nl-NL"); }
  function bytes(b) {
    b = Number(b || 0);
    if (b < 1024 * 1024) return Math.max(0, Math.round(b / 1024)) + " kB";
    if (b < 1024 * 1024 * 1024) return (b / 1048576).toLocaleString("nl-NL", { maximumFractionDigits: 1 }) + " MB";
    return (b / 1073741824).toLocaleString("nl-NL", { maximumFractionDigits: 1 }) + " GB";
  }
  function when(ms) {
    if (!ms) return "nog niet";
    var d = new Date(ms), today = new Date().toDateString();
    var hm = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === today ? "vandaag " + hm : d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" }) + " " + hm;
  }
  function dayLabel(ms, utc) {
    return new Date(ms).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: utc ? "UTC" : undefined });
  }
  function time(ms) { return new Date(ms).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dateInput(ms, utc) { var d = new Date(ms); return utc ? d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function timeInput(ms) { var d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function plural(n, one, many) { return nf(n) + " " + (n === 1 ? one : many); }

  var flashTimer;
  function flash(text, bad) {
    var el = $("#flash");
    if (!el) { el = document.createElement("p"); el.id = "flash"; el.className = "note"; el.setAttribute("role", "status"); $(".tel").insertBefore(el, $(".tel-bar").nextSibling); }
    el.textContent = text;
    el.className = bad ? "note warn" : "note";
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.hidden = true; }, 6000);
  }

  // ── Navigatie ──
  var TITLES = { "": "Op deze telefoon", agenda: "Agenda op deze telefoon", fotos: "Foto's op deze telefoon", galerij: "Je foto's uit je cloud", opslag: "Opslag op deze telefoon" };
  function view() { var h = location.hash.replace("#", ""); return TITLES[h] !== undefined ? h : ""; }
  function route() {
    var v = view();
    ["home", "agenda", "fotos", "galerij", "opslag"].forEach(function (n) { $("#v-" + n).hidden = (n === "home" ? "" : n) !== v; });
    $("#title").textContent = TITLES[v];
    if (v === "") renderHome();
    if (v === "agenda") renderAgenda();
    if (v === "fotos") renderFotos();
    if (v === "galerij") renderGalerij(true);
    if (v === "opslag") renderOpslag();
  }
  window.addEventListener("hashchange", function () { if (overlay) { overlay = false; hideSheet(); hideViewer(); } route(); window.scrollTo(0, 0); });
  $("#back").addEventListener("click", function () { if (!view()) call("close"); else if (history.length > 1) history.back(); else location.hash = ""; });

  // Vensters (formulier, foto) krijgen een eigen stap in de geschiedenis: de terugknop van Android sluit ze eerst.
  var overlay = false;
  function pushOverlay() { if (!overlay) { overlay = true; history.pushState({ ov: 1 }, ""); } }
  function popOverlay() { if (overlay) { overlay = false; if (history.state && history.state.ov) history.back(); } }
  window.addEventListener("popstate", function () { if (overlay) { overlay = false; hideSheet(); hideViewer(); } });
  var quietTimer;
  function refreshQuiet() { clearTimeout(quietTimer); quietTimer = setTimeout(function () { if ($("#sheet").hidden && $("#viewer").hidden) route(); }, 300); }

  // ═════════ Overzicht ═════════
  function renderHome() {
    call("agenda.status", { peek: true }).then(function (s) {
      if (!s.permitted) { $("#sumAgenda").textContent = "Je Google-agenda op de telefoon, bekijken en wijzigen, met een eigen reservekopie."; return; }
      var names = s.accounts.map(function (a) { return a.name; });
      $("#sumAgenda").textContent = (names.length ? "Google-agenda van " + names.join(", ") : "Geen Google-account op deze telefoon") +
        (s.backup.on ? " · reservekopie " + when(s.backup.last) : "");
    }).catch(function () {});
    call("fotos.status").then(function (s) {
      var g = s.gallery;
      var t = g.permitted ? plural(g.images, "foto", "foto's") + " en " + plural(g.videos, "video", "video's") + " in je galerij" : "Je galerij, je foto's uit Google en uit je cloud";
      if (s.backup.on) t += " · back-up aan";
      if (s.takeout && s.takeout.phase === "bezig") t += " · import uit Google bezig";
      $("#sumFotos").textContent = t;
    }).catch(function () {});
    call("opslag.status").then(function (s) { $("#sumOpslag").textContent = "De app gebruikt " + bytes(s.app) + " · vrij op de telefoon: " + bytes(s.free); }).catch(function () {});
  }

  // ═════════ Agenda ═════════
  var ag = { status: null, from: 0, hidden: {}, items: [] };
  var permMsg = "";
  try { ag.hidden = JSON.parse(localStorage.getItem("agenda.hidden") || "{}") || {}; } catch (e) { ag.hidden = {}; }
  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (!ag.from) ag.from = startOfToday();

  function allCalendars() {
    var s = ag.status, out = [];
    if (!s) return out;
    s.accounts.forEach(function (a) { a.calendars.forEach(function (c) { out.push(c); }); });
    s.others.forEach(function (c) { out.push(c); });
    return out;
  }

  function renderAgenda() {
    call("agenda.status").then(function (s) {
      ag.status = s;
      $("#agPerm").hidden = s.permitted;
      $("#agMain").hidden = !s.permitted;
      $("#agPermMsg").textContent = permMsg;
      if (!s.permitted) return;
      renderGoogle(s);
      renderFilter();
      loadEvents();
      renderBackup(s);
      renderEigen(s);
    }).catch(function (e) { flash(e.message, true); });
  }

  function syncLine(a) {
    var st = a.sync || {};
    if (st.known && !st.master) return '<p class="state warn">Synchroniseren staat uit op deze telefoon. Wijzigingen gaan dan niet naar Google, en wat je in Google verandert komt hier niet.</p><div class="actions"><button class="btn primary small" data-act="sync-settings">Synchronisatie aanzetten</button></div>';
    if (st.known && !st.auto) return '<p class="state warn">Agenda-synchronisatie staat uit voor dit account.</p><div class="actions"><button class="btn primary small" data-act="sync-settings">Synchronisatie aanzetten</button></div>';
    return '<p class="state ok">Android houdt deze agenda in twee richtingen gelijk met Google: wat je hier of in Google Agenda verandert, staat binnen een paar minuten aan beide kanten.</p>';
  }

  function calRow(c) {
    var tags = [];
    if (!c.sync) tags.push("niet gesynchroniseerd");
    if (!c.writable) tags.push(c.type === "eigen" ? "uit je cloud, alleen lezen" : "alleen lezen");
    return '<li><span class="swatch" style="background:' + esc(c.color) + '"></span><span>' + esc(c.name) + (tags.length ? ' <span class="tag">· ' + esc(tags.join(", ")) + "</span>" : "") + "</span>" +
      (c.writable ? '<label><input type="checkbox" data-include="' + esc(c.key) + '"' + (c.backup ? " checked" : "") + "> reservekopie</label>" : "<span></span>") + "</li>";
  }

  function renderGoogle(s) {
    var h = "";
    if (s.accounts.length) {
      h += "<h2>Google-agenda op deze telefoon</h2>";
      s.accounts.forEach(function (a) {
        h += "<h3>" + esc(a.name) + "</h3>" + syncLine(a) + '<ul class="cal-list">' + a.calendars.map(calRow).join("") + "</ul>";
        if (a.calendars.some(function (c) { return !c.sync; })) h += '<p class="muted small">Een agenda die niet gesynchroniseerd wordt, zet je aan in de app Google Agenda (Instellingen → de agenda → Synchroniseren) of hier bij de synchronisatie.</p>';
      });
      h += '<p class="muted small">Er is geen wachtwoord nodig: Android regelt de synchronisatie met het Google-account dat al op je telefoon staat.</p>';
    } else {
      h += "<h2>Geen Google-account op deze telefoon</h2>" +
        "<p>Je Google-agenda staat hier vanzelf, in twee richtingen gesynchroniseerd, zodra je Google-account op de telefoon staat. Je logt dan in bij Google zelf, in Android; deze app ziet je wachtwoord niet.</p>" +
        '<div class="actions"><button class="btn primary" data-act="add-account">Google-account toevoegen</button></div>' +
        "<p>Liever geen Google-account op je telefoon? Volg je Google-agenda dan in je cloud (alleen lezen): wat in Google verandert, komt elke minuut in je cloud en via de agenda Eigen Cloud ook op je telefoon.</p>" +
        (s.cloud ? '<div class="actions"><button class="btn" data-act="cloud-gmail">Google Agenda volgen in je cloud</button></div>' : '<p class="muted small">Verbind eerst de app met je cloud; daarna vind je dit bij Instellingen → Gmail.</p>');
    }
    if (s.others.length) h += "<h3>Andere agenda's op deze telefoon</h3>" + '<ul class="cal-list">' + s.others.map(calRow).join("") + "</ul>";
    $("#agGoogle").innerHTML = h;
  }

  function renderFilter() {
    var cals = allCalendars().filter(function (c) { return c.sync; });
    $("#agFilter").innerHTML = cals.length > 1 ? cals.map(function (c) {
      return '<button class="chip-btn" data-filter="' + c.id + '" aria-pressed="' + (!ag.hidden[c.id]) + '"><span class="swatch" style="background:' + esc(c.color) + '"></span>' + esc(c.name) + "</button>";
    }).join("") : "";
    $("#agNew").hidden = !allCalendars().some(function (c) { return c.writable && c.sync; });
  }

  function loadEvents() {
    var ids = allCalendars().filter(function (c) { return c.sync && !ag.hidden[c.id]; }).map(function (c) { return c.id; });
    var to = ag.from + 14 * DAY;
    $("#agRange").textContent = new Date(ag.from).toLocaleDateString("nl-NL", { day: "numeric", month: "short" }) + " – " + new Date(to - 1).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
    call("agenda.events", { from: ag.from, to: to, calendars: ids }).then(function (list) {
      ag.items = list;
      var byCal = {};
      allCalendars().forEach(function (c) { byCal[c.id] = c; });
      if (!list.length) { $("#agList").innerHTML = '<p class="empty">Geen afspraken in deze twee weken.</p>'; return; }
      var h = "", lastDay = "";
      list.forEach(function (e, i) {
        var day = dayLabel(e.begin, e.allDay);
        if (day !== lastDay) { h += '<div class="day">' + esc(day) + "</div>"; lastDay = day; }
        var w = e.allDay ? "Hele dag" : time(e.begin) + "<br>" + time(e.end);
        var cal = byCal[e.calendar];
        h += '<button class="ev" data-ev="' + i + '"><span class="bar" style="background:' + esc(e.color) + '"></span><span class="when">' + w + '</span><span class="what"><b>' + esc(e.title || "(zonder titel)") + "</b>" +
          (e.location ? "<small>" + esc(e.location) + "</small><br>" : "") + "<small>" + esc(cal ? cal.name : "") + (e.recurring ? " · herhaalt" : "") + "</small></span></button>";
      });
      $("#agList").innerHTML = h;
    }).catch(function (e) { $("#agList").innerHTML = '<p class="empty">' + esc(e.message) + "</p>"; });
  }

  function renderBackup(s) {
    var b = s.backup;
    var periods = [[3, "3 maanden"], [6, "6 maanden"], [12, "12 maanden"], [24, "2 jaar"], [0, "alles"]];
    var h = "<h2>Reservekopie op deze telefoon</h2>" +
      "<p>Elke dag een kopie van je agenda's als .ics-bestand op de telefoon, los van Google. Raakt er iets kwijt, dan zet je het hiermee terug in een agenda naar keuze.</p>" +
      '<label class="check"><input type="checkbox" data-set="backup"' + (b.on ? " checked" : "") + "> <span>Elke dag een reservekopie maken</span></label>" +
      '<div class="two" style="margin:10px 0"><label>Periode<select data-set="months">' + periods.map(function (p) { return '<option value="' + p[0] + '"' + (b.months === p[0] ? " selected" : "") + ">" + (p[0] ? "afgelopen " + p[1] + " en alles wat komt" : "alles") + "</option>"; }).join("") + "</select></label>" +
      '<label>Bewaren<select data-set="keep">' + [7, 14, 30].map(function (k) { return '<option value="' + k + '"' + (b.keep === k ? " selected" : "") + ">laatste " + k + " kopieën</option>"; }).join("") + "</select></label></div>" +
      '<p class="state' + (b.error ? " warn" : "") + '">' + (b.error ? esc(b.error) : "Laatste kopie: " + when(b.last) + (b.last ? " · " + plural(b.events, "afspraak", "afspraken") : "")) + "</p>" +
      '<div class="actions"><button class="btn" data-act="backup-now">Nu een reservekopie maken</button></div><div id="agCopies"></div>';
    $("#agBackup").innerHTML = h;
    loadCopies();
  }

  var copies = [];
  function loadCopies() {
    call("agenda.backups").then(function (list) {
      copies = list;
      if (!list.length) { $("#agCopies").innerHTML = '<p class="muted small">Nog geen reservekopieën.</p>'; return; }
      $("#agCopies").innerHTML = '<ul class="copies">' + list.map(function (c, i) {
        var n = c.copies[0];
        return "<li><b>" + esc(c.name) + '</b><span class="muted small">' + esc(c.account || "") + " · laatste kopie " + when(n.time) + (n.events >= 0 ? " · " + plural(n.events, "afspraak", "afspraken") : "") + " · " + plural(c.copies.length, "kopie", "kopieën") + "</span>" +
          '<div class="actions"><button class="btn small primary" data-restore="' + i + '">Herstel uit reservekopie</button><button class="btn small" data-savefile="' + i + '">Bewaren als bestand</button></div></li>';
      }).join("") + "</ul>" +
        '<p class="muted small">Een bewaard .ics-bestand kun je ook in je cloud importeren (Instellingen → Importeren uit Google).</p>';
    }).catch(function (e) { $("#agCopies").innerHTML = '<p class="state warn">' + esc(e.message) + "</p>"; });
  }

  function renderEigen(s) {
    var show = s.eigenCloud.on && s.accounts.length;
    $("#agEigen").hidden = !show;
    if (!show) return;
    $("#agEigen").innerHTML = "<h2>Je cloud-agenda en Google samen</h2>" +
      "<p>Je cloud-agenda staat ook op deze telefoon (agenda Eigen Cloud). Volg je in je cloud ook je Google-agenda, dan zou die hier twee keer staan.</p>" +
      '<label class="check"><input type="checkbox" data-set="skipFollowed"' + (s.eigenCloud.skipFollowed ? " checked" : "") + "> <span>Gevolgde Google-agenda's niet dubbel tonen</span></label>";
  }

  // ── Afspraak bekijken, maken, wijzigen ──
  function openEvent(item) {
    var cal = allCalendars().filter(function (c) { return c.id === item.calendar; })[0];
    var whenText = item.allDay ? dayLabel(item.begin, true) + (item.end - item.begin > DAY ? " t/m " + dayLabel(item.end - DAY, true) : "") + ", hele dag"
      : dayLabel(item.begin) + ", " + time(item.begin) + " – " + time(item.end);
    var body = "<p>" + esc(whenText) + "</p>" + (item.location ? "<p>" + esc(item.location) + "</p>" : "") + '<p class="muted">' + esc(cal ? cal.name : "") + (item.recurring ? " · herhaalt" : "") + "</p>";
    var writable = cal && cal.writable;
    if (writable && item.recurring) {
      body += '<div class="actions"><button class="btn primary" data-edit="this">Alleen deze keer wijzigen</button><button class="btn" data-edit="all">Alle keren wijzigen</button></div>' +
        '<div class="actions"><button class="btn danger" data-del="this">Deze keer verwijderen</button><button class="btn danger" data-del="all">Alle keren verwijderen</button></div>';
    } else if (writable) {
      body += '<div class="actions"><button class="btn primary" data-edit="all">Wijzigen</button><button class="btn danger" data-del="all">Verwijderen</button></div>';
    } else body += '<p class="muted small">Deze agenda is alleen te lezen.</p>';
    body += '<div class="actions"><button class="btn" data-act="close">Sluiten</button></div><p class="msg" id="evMsg"></p>';
    showSheet(item.title || "(zonder titel)", body);
    $("#sheetBody").onclick = function (e) {
      var t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.act === "close") return closeSheet();
      if (t.dataset.edit) {
        call("agenda.event", { id: item.id }).then(function (ev) {
          if (t.dataset.edit === "this") { ev.start = item.begin; ev.end = item.end; ev.repeat = ""; }
          eventForm(ev, t.dataset.edit, item.begin);
        }).catch(function (er) { $("#evMsg").textContent = er.message; $("#evMsg").className = "msg err"; });
      }
      if (t.dataset.del) {
        var text = t.dataset.del === "this" ? "Deze keer verwijderen?" : item.recurring ? "Alle keren verwijderen?" : "Deze afspraak verwijderen?";
        if (!confirm(text + (cal && cal.type === "google" ? "\n\nAndroid verwijdert hem ook in Google Agenda." : ""))) return;
        t.disabled = true;
        call("agenda.delete", { id: item.id, scope: t.dataset.del, instance: item.begin }).then(function () { closeSheet(); flash("Verwijderd."); loadEvents(); })
          .catch(function (er) { t.disabled = false; $("#evMsg").textContent = er.message; $("#evMsg").className = "msg err"; });
      }
    };
  }

  function eventForm(ev, scope, instance) {
    var cals = allCalendars().filter(function (c) { return c.writable && c.sync; });
    var isNew = !ev;
    if (isNew) {
      var start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
      ev = { id: -1, calendar: (cals.filter(function (c) { return c.primary; })[0] || cals[0] || {}).id, title: "", start: start.getTime(), end: start.getTime() + 3600000, allDay: false, repeat: "", reminder: 10 };
    }
    var allDay = !!ev.allDay;
    var endShown = allDay ? ev.end - DAY : ev.end;
    var repeats = [["", "Niet"], ["DAILY", "Elke dag"], ["WEEKLY", "Elke week"], ["MONTHLY", "Elke maand"], ["YEARLY", "Elk jaar"]];
    if (ev.repeat === "CUSTOM" && scope !== "this") repeats.push(["KEEP", "Zoals het was"]);
    var rep = ev.repeat === "CUSTOM" ? "KEEP" : (ev.repeat || "");
    var rems = [[-1, "Geen"], [0, "Op het moment zelf"], [10, "10 minuten vooraf"], [30, "30 minuten vooraf"], [60, "1 uur vooraf"], [1440, "1 dag vooraf"]];
    if (rems.every(function (r) { return r[0] !== ev.reminder; })) rems.push([ev.reminder, ev.reminder + " minuten vooraf"]);
    var h = '<form class="fields" id="evForm">' +
      (isNew ? "<label>Agenda<select name=\"calendar\">" + cals.map(function (c) { return '<option value="' + c.id + '"' + (c.id === ev.calendar ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select></label>" : "") +
      '<label>Titel<input name="title" required maxlength="500" value="' + esc(ev.title) + '"></label>' +
      '<label class="check"><input type="checkbox" name="allDay"' + (allDay ? " checked" : "") + "> <span>Hele dag</span></label>" +
      '<div class="two"><label>Begint<input type="date" name="sd" required value="' + dateInput(ev.start, allDay) + '"></label><label class="t">Om<input type="time" name="st" value="' + timeInput(ev.start) + '"></label></div>' +
      '<div class="two"><label>Eindigt<input type="date" name="ed" required value="' + dateInput(endShown, allDay) + '"></label><label class="t">Om<input type="time" name="et" value="' + timeInput(ev.end) + '"></label></div>' +
      (scope === "this" ? "" : '<label>Herhalen<select name="repeat">' + repeats.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === rep ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") + "</select></label>") +
      '<label>Herinnering<select name="reminder">' + rems.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === ev.reminder ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") + "</select></label>" +
      '<label>Plaats<input name="location" value="' + esc(ev.location || "") + '"></label>' +
      '<label>Beschrijving<textarea name="description" rows="3">' + esc(ev.description || "") + "</textarea></label>" +
      '<p class="msg" id="formMsg" role="status"></p>' +
      '<div class="actions"><button class="btn primary">Opslaan</button><button class="btn" type="button" data-act="close">Annuleren</button></div></form>';
    showSheet(isNew ? "Nieuwe afspraak" : scope === "this" ? "Deze keer wijzigen" : "Afspraak wijzigen", h);
    var f = $("#evForm");
    function times() { f.querySelectorAll(".t").forEach(function (el) { el.hidden = f.allDay.checked; }); }
    times();
    f.allDay.onchange = times;
    f.sd.onchange = function () { if (f.ed.value < f.sd.value) f.ed.value = f.sd.value; };
    $("#sheetBody").onclick = function (e) { if (e.target.dataset && e.target.dataset.act === "close") closeSheet(); };
    f.onsubmit = function (e) {
      e.preventDefault();
      var all = f.allDay.checked, sd = f.sd.value.split("-").map(Number), ed = f.ed.value.split("-").map(Number);
      var start, end;
      if (all) { start = Date.UTC(sd[0], sd[1] - 1, sd[2]); end = Date.UTC(ed[0], ed[1] - 1, ed[2]) + DAY; }
      else {
        var st = (f.st.value || "00:00").split(":").map(Number), et = (f.et.value || "00:00").split(":").map(Number);
        start = new Date(sd[0], sd[1] - 1, sd[2], st[0], st[1]).getTime();
        end = new Date(ed[0], ed[1] - 1, ed[2], et[0], et[1]).getTime();
      }
      var btn = f.querySelector(".btn.primary");
      btn.disabled = true;
      call("agenda.save", { id: ev.id, calendar: isNew ? Number(f.calendar.value) : ev.calendar, title: f.title.value, description: f.description.value, location: f.location.value,
        allDay: all, start: start, end: end, repeat: f.repeat ? f.repeat.value : "", rrule: ev.rrule, reminder: Number(f.reminder.value), scope: scope, instance: instance || 0 })
        .then(function () {
          closeSheet();
          var cal = allCalendars().filter(function (c) { return c.id === (isNew ? Number(f.calendar.value) : ev.calendar); })[0];
          flash(cal && cal.type === "google" ? "Opgeslagen. Android stuurt het naar Google Agenda." : "Opgeslagen.");
          loadEvents();
        })
        .catch(function (er) { btn.disabled = false; $("#formMsg").textContent = er.message; $("#formMsg").className = "msg err"; });
    };
  }

  // ── Herstel uit reservekopie ──
  function restoreFlow(c) {
    var targets = allCalendars().filter(function (k) { return k.writable; });
    if (!targets.length) { flash("Er is geen agenda op deze telefoon waarin je kunt schrijven.", true); return; }
    var same = targets.filter(function (k) { return k.key === c.key; })[0];
    var h = '<form class="fields" id="rsForm"><label>Kopie<select name="file">' + c.copies.map(function (k) {
      return '<option value="' + esc(k.file) + '">' + esc(when(k.time)) + (k.events >= 0 ? " · " + plural(k.events, "afspraak", "afspraken") : "") + "</option>";
    }).join("") + "</select></label>" +
      '<label>Terugzetten in<select name="cal">' + targets.map(function (k) { return '<option value="' + k.id + '"' + (same && same.id === k.id ? " selected" : "") + ">" + esc(k.name) + (k.account && k.account !== k.name ? " (" + esc(k.account) + ")" : "") + "</option>"; }).join("") + "</select></label>" +
      '<div id="rsPreview"><p class="muted">Bezig met vergelijken…</p></div><p class="msg" id="rsMsg" role="status"></p>' +
      '<div class="actions"><button class="btn primary" id="rsGo" disabled>Terugzetten</button><button class="btn" type="button" data-act="close">Annuleren</button></div></form>';
    showSheet("Herstel uit reservekopie: " + c.name, h);
    var f = $("#rsForm"), plan = null;
    function preview() {
      $("#rsGo").disabled = true;
      $("#rsPreview").innerHTML = '<p class="muted">Bezig met vergelijken…</p>';
      call("agenda.preview", { key: c.key, file: f.file.value, calendar: Number(f.cal.value) }).then(function (p) {
        plan = p;
        var line = function (x) { return "<li>" + esc(x.title) + " · " + esc(x.allDay ? dayLabel(x.start, true) : dayLabel(x.start) + " " + time(x.start)) + (x.what ? " <span class=\"muted\">(" + esc(x.what) + ")</span>" : "") + "</li>"; };
        var h2 = "<p>" + plural(p.missing, "afspraak ontbreekt", "afspraken ontbreken") + " in " + esc(p.calendar) + ", " + plural(p.changed, "is anders", "zijn anders") + " en " + plural(p.same, "is gelijk", "zijn gelijk") + ".</p>";
        if (p.missing) h2 += "<b>Ontbreekt</b><ul class=\"list\">" + p.missingList.map(line).join("") + (p.missing > p.missingList.length ? "<li>…</li>" : "") + "</ul>";
        if (p.changed) h2 += "<b>Anders</b><ul class=\"list\">" + p.changedList.map(line).join("") + (p.changed > p.changedList.length ? "<li>…</li>" : "") + "</ul>" +
          '<label class="check"><input type="checkbox" name="changed"> <span>Ook de ' + plural(p.changed, "gewijzigde afspraak", "gewijzigde afspraken") + " terugzetten zoals in de kopie</span></label>";
        if (p.only) h2 += '<p class="muted small">' + plural(p.only, "afspraak staat", "afspraken staan") + " alleen in de agenda (bijvoorbeeld nieuw sinds de kopie). Die blijven gewoon staan.</p>";
        $("#rsPreview").innerHTML = h2;
        $("#rsGo").disabled = !p.missing && !p.changed;
        if (!p.missing && !p.changed) $("#rsPreview").innerHTML += '<p class="state ok">Alles uit deze kopie staat al in de agenda.</p>';
      }).catch(function (er) { $("#rsPreview").innerHTML = '<p class="state warn">' + esc(er.message) + "</p>"; });
    }
    f.file.onchange = preview;
    f.cal.onchange = preview;
    preview();
    $("#sheetBody").onclick = function (e) { if (e.target.dataset && e.target.dataset.act === "close") closeSheet(); };
    f.onsubmit = function (e) {
      e.preventDefault();
      if (!plan) return;
      $("#rsGo").disabled = true;
      $("#rsMsg").textContent = "Bezig met terugzetten…";
      call("agenda.restore", { key: c.key, file: f.file.value, calendar: Number(f.cal.value), changed: !!(f.changed && f.changed.checked) }).then(function (r) {
        closeSheet();
        flash(plural(r.added, "afspraak", "afspraken") + " teruggezet" + (r.updated ? " en " + plural(r.updated, "afspraak", "afspraken") + " hersteld" : "") + " in " + r.calendar + "." + (r.google ? " Android stuurt ze naar Google Agenda." : ""));
        loadEvents();
      }).catch(function (er) { $("#rsGo").disabled = false; $("#rsMsg").textContent = er.message; $("#rsMsg").className = "msg err"; });
    };
  }

  $("#v-agenda").addEventListener("click", function (e) {
    var t = e.target.closest("button, input");
    if (!t) return;
    var act = t.dataset.act;
    if (act === "perm-agenda") call("permission", { what: "agenda" });
    if (act === "sync-settings") call("open.syncSettings");
    if (act === "add-account") call("open.addAccount");
    if (act === "cloud-gmail") call("open.cloud", { hash: "#instellingen/gmail" });
    if (act === "ag-prev") { ag.from -= 14 * DAY; loadEvents(); }
    if (act === "ag-next") { ag.from += 14 * DAY; loadEvents(); }
    if (act === "new-event") eventForm(null, "all", 0);
    if (act === "backup-now") {
      t.disabled = true; t.textContent = "Bezig…";
      call("agenda.backupNow").then(function (r) {
        flash(r.error ? r.error : r.errors && r.errors.length ? "Niet alles gelukt: " + r.errors.join("; ") : r.saved ? "Reservekopie gemaakt (" + plural(r.events, "afspraak", "afspraken") + ")." : "Niets veranderd sinds de vorige kopie.", !!r.error);
        renderAgenda();
      }).catch(function (er) { flash(er.message, true); t.disabled = false; });
    }
    if (t.dataset.filter) {
      var id = t.dataset.filter;
      ag.hidden[id] = !ag.hidden[id];
      try { localStorage.setItem("agenda.hidden", JSON.stringify(ag.hidden)); } catch (er) { /* niet bewaard */ }
      renderFilter(); loadEvents();
    }
    if (t.dataset.ev) openEvent(ag.items[Number(t.dataset.ev)]);
    if (t.dataset.restore) restoreFlow(copies[Number(t.dataset.restore)]);
    if (t.dataset.savefile) { var c = copies[Number(t.dataset.savefile)]; call("agenda.saveFile", { key: c.key, file: c.copies[0].file, name: c.name }); }
  });
  $("#v-agenda").addEventListener("change", function (e) {
    var t = e.target;
    if (t.dataset.include) call("agenda.settings", { include: t.dataset.include, on: t.checked }).catch(function (er) { flash(er.message, true); });
    var k = t.dataset.set;
    if (!k) return;
    var args = {};
    args[k] = t.type === "checkbox" ? t.checked : Number(t.value);
    call("agenda.settings", args).then(function () { if (k === "skipFollowed") flash(t.checked ? "Gevolgde Google-agenda's staan nu niet meer dubbel." : "Gevolgde Google-agenda's staan nu ook in Eigen Cloud."); })
      .catch(function (er) { flash(er.message, true); });
  });

  // ═════════ Foto's ═════════
  var takeoutMsg = "", takeoutTimer;
  function renderFotos() {
    call("fotos.status").then(function (s) {
      renderGallery(s);
      renderTakeout(s);
      renderCache(s);
      clearTimeout(takeoutTimer);
      var p = s.takeout && s.takeout.phase;
      if (view() === "fotos" && (p === "doorzoeken" || p === "bezig")) takeoutTimer = setTimeout(function () { if ($("#sheet").hidden) renderFotos(); }, 4000);
    }).catch(function (e) { flash(e.message, true); });
  }

  function renderGallery(s) {
    var g = s.gallery, b = s.backup, h = "<h2>In de galerij van deze telefoon</h2>";
    if (!g.permitted) {
      h += "<p>Geef de app toegang tot je foto's om te zien wat er op de telefoon staat en om ze naar je cloud te zetten.</p>" +
        '<div class="actions"><button class="btn primary" data-act="perm-fotos">Toegang geven</button></div><p class="msg">' + esc(permMsg) + "</p>";
    } else {
      h += "<p>" + plural(g.images, "foto", "foto's") + " en " + plural(g.videos, "video", "video's") + " (" + bytes(g.bytes) + ") staan op deze telefoon. Die zijn van jou en blijven hier.</p>";
    }
    if (s.cloud) {
      if (b.on) {
        h += '<p class="state' + (b.blocker ? " warn" : " ok") + '">Back-up naar je cloud staat aan' + (b.blocker ? ": " + esc(b.blocker) : "") + (b.pending > 0 ? " · nog " + nf(b.pending) + " te gaan" : " · alles staat erin") + " · laatste " + when(b.last) + "</p>" +
          '<div class="actions"><button class="btn small" data-act="backup-off">Back-up uitzetten</button></div>';
      } else {
        h += "<p>Nieuwe foto's en video's automatisch naar je cloud, met de plaats waar ze gemaakt zijn. Wat moet er mee?</p>" +
          '<div class="actions"><button class="btn primary" data-backup="all">Alles, ook wat er al op staat</button><button class="btn" data-backup="now">Alleen nieuwe foto\'s</button></div>';
      }
    }
    h += '<p class="muted small">Google Foto\'s zelf kan deze app niet bijhouden: Google laat sinds 31 maart 2025 geen andere apps meer bij je hele fotobibliotheek (alleen nog bij foto\'s die je per keer kiest). Je oude foto\'s haal je daarom één keer over met Google Takeout, hieronder.</p>';
    $("#fGallery").innerHTML = h;
  }

  function renderTakeout(s) {
    var t = s.takeout || { phase: "leeg" }, h = "<h2>Uit Google Foto's halen (eenmalig)</h2>";
    if (!s.cloud) {
      $("#fTakeout").innerHTML = h + "<p>Verbind de app eerst met je cloud. Daarna haal je hier je foto's uit Google Foto's over.</p>";
      return;
    }
    if (t.phase === "leeg" || t.phase === "klaar" || t.phase === "fout") {
      if (t.phase === "klaar") h += '<p class="state ok">Klaar: ' + plural(t.added || 0, "foto nieuw", "foto's nieuw") + ", " + nf(t.duplicates || 0) + " stonden er al" + (t.failed ? ", " + nf(t.failed) + " mislukt" + (t.lastError ? " (bijv. " + esc(t.lastError) + ")" : "") : "") + ".</p>";
      if (t.phase === "fout") h += '<p class="state warn">' + esc(t.fatal) + "</p>";
      if (t.note) h += '<p class="note warn small">' + esc(t.note) + "</p>";
      h += '<ol class="steps">' +
        '<li>Open Google Takeout. Kies <b>Alles deselecteren</b> en vink alleen <b>Google Foto\'s</b> aan. Kies daarna <b>.zip</b> en de grootste bestandsgrootte (50 GB). Google mailt je als het klaar is; dat duurt uren tot een paar dagen.<div class="actions"><button class="btn" data-act="open-takeout">Google Takeout openen</button></div></li>' +
        "<li>Download alle zip-bestanden naar deze telefoon (bijvoorbeeld in Downloads). Uitpakken hoeft niet.</li>" +
        '<li>Kies ze hier. De app leest ze op de telefoon en zet de foto\'s één voor één in je cloud, met datum, plaats, beschrijving, favoriet en album uit Google. Dubbele foto\'s slaat je cloud over, dus opnieuw doen kan altijd.<div class="actions"><button class="btn primary" data-act="pick-zips">Takeout-bestanden kiezen</button></div></li></ol>' +
        '<label class="check"><input type="checkbox" data-takeout="wifi"' + (t.wifiOnly !== false ? " checked" : "") + "> <span>Alleen via wifi</span></label>" +
        '<p class="msg" id="tkMsg">' + esc(takeoutMsg) + "</p>" +
        '<p class="muted small">Liever op de computer? Gebruik <button class="link" data-act="cloud-import">Importeren uit Google</button> in je cloud; daar kunnen ook je mail en agenda mee.</p>';
      $("#fTakeout").innerHTML = h;
      return;
    }
    var total = t.total || 0, pos = t.position || 0;
    h += "<p>" + esc((t.files || []).join(", ")) + " (" + bytes(t.size) + ")</p>";
    if (t.phase === "doorzoeken") h += '<p class="state">Bezig met doorzoeken van je bestanden…</p>';
    else {
      h += '<div class="progressbar"><span style="width:' + (total ? Math.round(pos * 100 / total) : 0) + '%"></span></div>' +
        "<p>" + nf(pos) + " van " + plural(total, "foto of video", "foto's en video's") + " · " + nf(t.added || 0) + " nieuw, " + nf(t.duplicates || 0) + " stonden er al" + (t.failed ? ", " + nf(t.failed) + " mislukt" : "") + "</p>" +
        '<p class="muted small">' + nf(t.withMeta || 0) + " met datum en plaats uit Google" + (t.skipped ? " · " + nf(t.skipped) + " uit de prullenbak overgeslagen" : "") + "</p>";
      if (t.paused) h += '<p class="state">Gepauzeerd.</p>';
      else if (t.waiting) h += '<p class="state warn">' + esc(t.waiting) + "</p>";
      if (t.otherGoogle) h += '<p class="muted small">Er zitten ook mail- of agendabestanden in je Takeout. Die haal je over via Importeren uit Google in je cloud.</p>';
      if (t.note) h += '<p class="note warn small">' + esc(t.note) + "</p>";
    }
    h += '<div class="actions">' + (t.paused ? '<button class="btn primary" data-takeout="resume">Verder</button>' : '<button class="btn" data-takeout="pause">Pauzeren</button>') +
      '<button class="btn danger" data-takeout="stop">Stoppen</button></div>' +
      '<label class="check"><input type="checkbox" data-takeout="wifi"' + (t.wifiOnly !== false ? " checked" : "") + "> <span>Alleen via wifi</span></label>" +
      '<p class="muted small">Dit gaat op de achtergrond door, ook als je de app sluit. Je ziet de voortgang in een melding.</p>';
    $("#fTakeout").innerHTML = h;
  }

  function renderCache(s) {
    var c = s.cache, h = "<h2>Je foto's uit je cloud op deze telefoon</h2>";
    if (!s.cloud) { $("#fCache").innerHTML = h + "<p>Verbind de app eerst met je cloud.</p>"; return; }
    h += "<p>Bekijk je foto's uit je cloud, ook zonder internet: recente foto's helemaal, oudere als miniatuur. Een oudere foto haalt de app op zodra je hem opent.</p>" +
      '<label class="check"><input type="checkbox" data-cache="on"' + (c.on ? " checked" : "") + "> <span>Foto's uit je cloud op deze telefoon zetten</span></label>";
    if (c.on) {
      var months = [[3, "3 maanden"], [6, "6 maanden"], [12, "12 maanden"], [24, "2 jaar"], [0, "geen (alleen miniaturen)"]];
      h += '<div class="two" style="margin:10px 0"><label>Helemaal op de telefoon<select data-cache="months">' + months.map(function (m) { return '<option value="' + m[0] + '"' + (c.months === m[0] ? " selected" : "") + ">" + (m[0] ? "laatste " + m[1] : m[1]) + "</option>"; }).join("") + "</select></label>" +
        '<label>Hooguit<select data-cache="maxGb">' + [1, 2, 5, 10, 20, 50].map(function (g) { return '<option value="' + g + '"' + (c.maxGb === g ? " selected" : "") + ">" + g + " GB</option>"; }).join("") + "</select></label></div>" +
        '<label class="check"><input type="checkbox" data-cache="videos"' + (c.videos ? " checked" : "") + "> <span>Ook video's helemaal</span></label>" +
        '<label class="check"><input type="checkbox" data-cache="mobile"' + (c.mobile ? " checked" : "") + "> <span>Ook via mobiele data ophalen</span></label>" +
        '<p class="state' + (c.error ? " warn" : "") + '">' + (c.error ? esc(c.error) + " · " : "") + plural(c.originals, "foto", "foto's") + " helemaal en " + plural(c.minis, "miniatuur", "miniaturen") + " op de telefoon (" + bytes(c.miniBytes + c.originalBytes) + ")" +
        (c.total ? " · " + nf(c.total) + " in je cloud, " + nf(c.recent) + " van de laatste maanden" : "") + " · bijgewerkt " + when(c.last) + "</p>" +
        '<div class="actions"><a class="btn primary" href="#galerij">Bekijken</a><button class="btn" data-act="cache-now">Nu bijwerken</button></div>' +
        '<p class="muted small">Zonder wifi haalt de app niets vooraf op; een foto die je opent via mobiele data vraagt eerst of dat mag.</p>';
    }
    $("#fCache").innerHTML = h;
  }

  $("#v-fotos").addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    var act = t.dataset.act;
    if (act === "perm-fotos") call("permission", { what: "fotos" });
    if (act === "backup-off") call("fotos.backupOff").then(renderFotos);
    if (t.dataset.backup) call("permission", { what: "fotos", scope: t.dataset.backup });
    if (act === "open-takeout") call("open.takeout");
    if (act === "pick-zips") { takeoutMsg = ""; call("takeout.pick"); }
    if (act === "cloud-import") call("open.cloud", { hash: "#instellingen/importeren" });
    if (act === "cache-now") { call("fotos.refresh").then(function () { flash("Bezig met bijwerken. Dat gaat op de achtergrond door."); }); }
    var tk = t.dataset.takeout;
    if (tk === "pause" || tk === "resume") call("takeout.pause", { on: tk === "pause" }).then(renderFotos).catch(function (er) { flash(er.message, true); });
    if (tk === "stop" && confirm("De import stoppen?\n\nWat al in je cloud staat, blijft daar. Opnieuw beginnen kan altijd; dubbele foto's worden overgeslagen.")) call("takeout.stop").then(renderFotos);
  });
  $("#v-fotos").addEventListener("change", function (e) {
    var t = e.target;
    if (t.dataset.takeout === "wifi") call("takeout.wifi", { on: t.checked }).then(renderFotos);
    var k = t.dataset.cache;
    if (!k) return;
    var args = {};
    args[k] = t.type === "checkbox" ? t.checked : Number(t.value);
    call("fotos.settings", args).then(renderFotos).catch(function (er) { flash(er.message, true); });
  });

  // ═════════ Galerij (foto's uit je cloud) ═════════
  var gal = { items: [], total: 0, loading: false };
  function renderGalerij(reset) {
    if (reset) { gal.items = []; gal.total = 0; $("#gGrid").innerHTML = ""; }
    if (gal.loading) return;
    gal.loading = true;
    call("fotos.page", { offset: gal.items.length, limit: 240 }).then(function (p) {
      gal.loading = false;
      gal.total = p.total;
      var start = gal.items.length;
      gal.items = gal.items.concat(p.items);
      $("#gInfo").textContent = p.total ? nf(p.total) + " foto's en video's in je cloud. Met een groen stipje: helemaal op de telefoon." : "Nog geen overzicht van je cloud. Zet Foto's uit je cloud aan bij Foto's op deze telefoon, en wacht even op wifi.";
      var h = "", last = start ? monthOf(gal.items[start - 1].t) : "";
      p.items.forEach(function (it, i) {
        var m = monthOf(it.t);
        if (m !== last) { h += '<div class="month">' + esc(m) + "</div>"; last = m; }
        h += '<button data-g="' + (start + i) + '" class="' + (it.v ? "vid " : "") + (it.full ? "full" : "") + '" aria-label="' + esc(it.f) + '">' + (it.h ? '<img loading="lazy" alt="" src="/foto/mini/' + it.id + '">' : "<small>" + esc(it.f) + "</small>") + "</button>";
      });
      $("#gGrid").insertAdjacentHTML("beforeend", h);
      $("#gMore").hidden = gal.items.length >= gal.total;
    }).catch(function (e) { gal.loading = false; $("#gInfo").textContent = e.message; });
  }
  function monthOf(t) { return new Date(t).toLocaleDateString("nl-NL", { month: "long", year: "numeric" }); }
  window.addEventListener("scroll", function () {
    if (view() !== "galerij" || gal.loading || gal.items.length >= gal.total) return;
    if (window.innerHeight + window.scrollY > document.body.offsetHeight - 800) renderGalerij(false);
  });
  $("#v-galerij").addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "g-more") renderGalerij(false);
    if (t.dataset.g) openPhoto(Number(t.dataset.g));
  });

  var cur = -1;
  function openPhoto(i, confirmed) {
    var it = gal.items[i];
    if (!it) return;
    cur = i;
    $("#viewer").hidden = false;
    pushOverlay();
    $("#vInfo").textContent = new Date(it.t).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" }) + " · " + it.f;
    var body = $("#vBody");
    body.innerHTML = it.h ? '<img alt="" src="/foto/mini/' + it.id + '">' : "<p>Bezig met laden…</p>";
    call("fotos.prepare", { id: it.id, confirmed: !!confirmed }).then(function (r) {
      if (cur !== i) return;
      if (r.ask) {
        body.innerHTML = (it.h ? '<img alt="" src="/foto/mini/' + it.id + '">' : "") + '<div class="ask"><p>Dit origineel staat nog niet op je telefoon en je hebt nu geen wifi.</p><button class="btn" data-act="v-load">Ophalen via mobiele data</button></div>';
        return;
      }
      it.full = true;
      body.innerHTML = r.video ? '<video controls autoplay playsinline src="/foto/groot/' + it.id + '"></video>' : '<img alt="" src="/foto/groot/' + it.id + '">';
    }).catch(function (e) { if (cur === i) body.insertAdjacentHTML("beforeend", '<p class="ask">' + esc(e.message) + "</p>"); });
  }
  function hideViewer() { $("#viewer").hidden = true; $("#vBody").innerHTML = ""; cur = -1; }
  function closeViewer() { hideViewer(); popOverlay(); }
  $("#viewer").addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.act === "v-close") closeViewer();
    if (t.dataset.act === "v-prev" && cur > 0) openPhoto(cur - 1);
    if (t.dataset.act === "v-next" && cur < gal.items.length - 1) openPhoto(cur + 1);
    if (t.dataset.act === "v-load") openPhoto(cur, true);
  });
  var touchX = null;
  $("#viewer").addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  $("#viewer").addEventListener("touchend", function (e) {
    if (touchX == null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (dx > 60 && cur > 0) openPhoto(cur - 1);
    if (dx < -60 && cur < gal.items.length - 1) openPhoto(cur + 1);
  });

  // ═════════ Opslag ═════════
  function renderOpslag() {
    call("opslag.status").then(function (s) {
      var f = s.fotos, h = '<ul class="parts">' +
        "<li><b>Agenda-reservekopieën</b><span class=\"size\">" + bytes(s.agenda.bytes) + '</span><span class="muted small">' + plural(s.agenda.copies, "kopie", "kopieën") + "</span>" +
        (s.agenda.copies > 1 ? '<div class="actions"><button class="btn small" data-free="agenda">Vrijmaken: alleen de nieuwste houden</button></div>' : "") + "</li>" +
        "<li><b>Foto's uit je cloud</b><span class=\"size\">" + bytes(f.mini + f.originals + f.index) + '</span><span class="muted small">miniaturen ' + bytes(f.mini) + " · volledige foto's " + bytes(f.originals) + "</span>" +
        (f.mini + f.originals > 0 ? '<div class="actions"><button class="btn small" data-free="fotos" data-scope="originals">Volledige foto\'s weghalen</button><button class="btn small" data-free="fotos" data-scope="all">Alles weghalen</button></div>' +
          '<span class="muted small">Staat Foto\'s uit je cloud aan, dan komen recente foto\'s bij de volgende ronde terug (via wifi).</span>' : "") + "</li>" +
        "<li><b>Uit Google Foto's halen</b><span class=\"size\">" + bytes(s.takeout) + '</span><span class="muted small">voortgang en overzicht van de import; de zips zelf staan in je Downloads</span>' +
        (s.takeout > 0 ? '<div class="actions"><button class="btn small" data-free="takeout">Vrijmaken</button></div>' : "") + "</li>";
      (s.parts || []).forEach(function (p) { h += "<li><b>" + esc(p.name) + '</b><span class="size">' + bytes(p.bytes) + '</span><span class="muted small">Vrijmaken doe je in dat onderdeel.</span></li>'; });
      if (s.gallery && s.gallery.permitted) h += "<li><b>Galerij van de telefoon</b><span class=\"size\">" + bytes(s.gallery.bytes) + '</span><span class="muted small">' + plural(s.gallery.images, "foto", "foto's") + " en " + plural(s.gallery.videos, "video", "video's") + ". Die beheer je in de galerij-app; deze app verwijdert ze nooit.</span></li>";
      h += "</ul><p class=\"state\">De app gebruikt in totaal " + bytes(s.app) + ". Vrij op de telefoon: " + bytes(s.free) + ".</p>";
      $("#oList").innerHTML = h;
    }).catch(function (e) { $("#oList").innerHTML = '<p class="state warn">' + esc(e.message) + "</p>"; });
  }
  $("#v-opslag").addEventListener("click", function (e) {
    var t = e.target.closest("button");
    if (!t || !t.dataset.free) return;
    var what = { agenda: "Oudere agenda-reservekopieën weghalen? De nieuwste per agenda blijft.", takeout: "De voortgang van de import vergeten? Wat al in je cloud staat, blijft daar.",
      fotos: t.dataset.scope === "all" ? "Alle foto's uit je cloud van deze telefoon weghalen? In je cloud blijven ze gewoon staan." : "De volledige foto's van deze telefoon weghalen? Miniaturen blijven, en in je cloud blijft alles staan." }[t.dataset.free];
    if (!confirm(what)) return;
    t.disabled = true;
    call("opslag.free", { part: t.dataset.free, scope: t.dataset.scope }).then(function () { flash("Vrijgemaakt."); renderOpslag(); }).catch(function (er) { t.disabled = false; flash(er.message, true); });
  });

  // ═════════ Venster ═════════
  function showSheet(title, html) {
    $("#sheetTitle").textContent = title;
    $("#sheetBody").innerHTML = html;
    $("#sheetBody").onclick = null;
    $("#sheet").hidden = false;
    pushOverlay();
    var first = $("#sheetBody input:not([type=checkbox]), #sheetBody select, #sheetBody button");
    if (first) first.focus();
  }
  function hideSheet() { $("#sheet").hidden = true; $("#sheetBody").innerHTML = ""; }
  function closeSheet() { hideSheet(); popOverlay(); }
  $("#sheet").addEventListener("click", function (e) { if (e.target.id === "sheet") closeSheet(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { hideSheet(); hideViewer(); popOverlay(); } });

  route();
})();
