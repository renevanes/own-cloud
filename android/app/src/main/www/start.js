// Startscherm van de Android-app: verbinden met je cloud, of er zelf een opzetten.
(function () {
  "use strict";
  var phone = window.EigenPhone;
  var $ = function (s) { return document.querySelector(s); };
  var info = {};
  try { info = JSON.parse(phone.info()) || {}; } catch (e) { info = {}; }

  // Kluis op deze telefoon: beheer van je cloud; alleen een Dienst (nog geen cloud): toch een eigen cloud maken.
  function setup() {
    if (info.console && info.dienstOnly) {
      $("#setup b").textContent = "Ook een eigen cloud maken";
      $("#setup .muted").textContent = "Mail, agenda en foto's voor jezelf, met dezelfde kluis. Je Dienst blijft zoals hij is.";
    } else if (info.console) {
      $("#setup b").textContent = "Beheer openen";
      $("#setup .muted").textContent = "Je cloud starten, laten slapen of wakker maken, en instellingen van je servers.";
    }
  }
  setup();

  // ── Aanbieder worden, of je eigen Dienst beheren ("ESAPE beheren") ──
  function provider() {
    var own = !!info.dienstOwn;
    var name = info.dienstName || (info.dienstOwn || "").replace(/^https:\/\//, "");
    var title = own ? name + " beheren" : "Aanbieder worden";
    $("#providerTitle").textContent = title;
    $("#providerText").textContent = own
      ? "Je Dienst: klanten, aanbod en prijzen, sleutels, server en back-ups. Alles op één plek."
      : "Draai je eigen Eigen Cloud Dienst, met je eigen naam en prijzen. Mensen nemen dan bij jou een cloud. Een eigen cloud is niet nodig.";
    $("#dienstOwn").textContent = title;
    $("#providerAbout").textContent = own
      ? "Je eigen Dienst (" + (info.dienstOwn || "").replace(/^https:\/\//, "") + ") beheer je in de app. Ben je ook medewerker van een andere Dienst? Open dan het beheer daarvan."
      : "Bied je Eigen Cloud aan anderen aan? Zet je eigen Dienst op, of open het beheer van een Dienst waar je medewerker bent.";
  }
  function openProvider() {
    if (phone.openConsoleAt) phone.openConsoleAt("#aanbieder"); else phone.openConsole();
  }
  provider();
  // Terug uit de console (bijv. net je Dienst opgezet): het startscherm bijwerken.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) reload(); });

  var home = location.hash === "#offline" && info.cloud ? "offline" : "welcome";
  function show(id) {
    $("#welcome").hidden = id !== "welcome";
    $("#login").hidden = id !== "login";
    $("#offline").hidden = id !== "offline";
    $("#about").hidden = id !== "about";
    $(".foot").hidden = id === "about";
    window.scrollTo(0, 0);
  }
  show(location.hash === "#over" ? "about" : home);

  // ── Over Eigen Cloud ──
  function reload() { try { info = JSON.parse(phone.info()) || {}; } catch (e) { /* oud */ } renderAbout(); provider(); setup(); }
  function when(ms) {
    if (!ms) return "nog niet";
    var d = new Date(ms), now = new Date();
    var t = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    return d.toDateString() === now.toDateString() ? "vandaag om " + t : d.getDate() + "-" + (d.getMonth() + 1) + " om " + t;
  }
  var updMsg = "";
  function renderAbout() {
    var u = (info.updates || {}).status || {};
    $("#ver").textContent = info.version || "";
    $("#footVer").textContent = info.version || "";
    var line = u.installing ? "Versie " + u.installing + " wordt geïnstalleerd…"
      : u.available ? "Versie " + u.available + " is beschikbaar."
      : "Je hebt de nieuwste versie. Laatst gekeken: " + when(u.checked) + ".";
    if (updMsg) line = updMsg;
    if (u.error && !u.available && !updMsg) line += " Laatste poging mislukte: " + u.error;
    $("#upd").textContent = line;
    var notes = $("#notes");
    notes.innerHTML = "";
    (u.available ? u.notes || [] : []).forEach(function (n) { var li = document.createElement("li"); li.textContent = n; notes.appendChild(li); });
    notes.hidden = !notes.children.length;
    $("#install").hidden = !u.available;
    $("#autoUpd").checked = !!(info.updates || {}).on;
    $("#cloud").textContent = info.cloud ? info.cloud.replace(/^https:\/\//, "") : "nog niet verbonden";
    $("#beheer").textContent = info.console ? "kluis op deze telefoon" : "nog niet ingesteld";
    var lg = info.login || {};
    $("#loginHow").innerHTML = "";
    $("#loginHow").append(document.createTextNode(lg.fingerprint ? "met je vingerafdruk " : info.cloud ? "met je wachtwoord" : "nog niet"));
    if (lg.fingerprint && phone.forgetLogin) {
      var off = document.createElement("button");
      off.className = "link";
      off.textContent = "uitzetten";
      off.onclick = function () { if (confirm("Inloggen met je vingerafdruk uitzetten?\n\nDe app vergeet je bewaarde inlog. Je blijft ingelogd tot je sessie verloopt; daarna typ je je wachtwoord.")) phone.forgetLogin(); };
      $("#loginHow").append(off);
    }
    $("#device").textContent = (info.device || "") + (info.android ? " · Android " + info.android : "");
    $("#resetConsole").hidden = !info.console;
  }
  renderAbout();
  $("#aboutLink").addEventListener("click", function () { reload(); show("about"); });
  $("#back").addEventListener("click", function () {
    updMsg = "";
    // Vanuit je cloud (Instellingen → Telefoon) hierheen gekomen? Dan terug naar daar.
    if (location.hash === "#over" && history.length > 1) history.back(); else show(home);
  });
  $("#check").addEventListener("click", function (e) { e.target.disabled = true; updMsg = "Bezig met zoeken…"; renderAbout(); phone.checkUpdate(); });
  $("#install").addEventListener("click", function (e) { e.target.disabled = true; updMsg = "Bezig met bijwerken…"; renderAbout(); phone.installUpdate(); });
  $("#news").addEventListener("click", function () { if (phone.whatsNew) phone.whatsNew(); });
  $("#autoUpd").addEventListener("change", function (e) { phone.set("updates", e.target.checked); });
  var repo = "https://github.com/" + (info.repo || "renevanes/own-cloud");
  $("#source").addEventListener("click", function (e) { e.preventDefault(); location.href = repo + "/releases"; });
  $("#manual").addEventListener("click", function (e) { e.preventDefault(); location.href = repo + "#readme"; });
  $("#resetConsole").addEventListener("click", function () {
    if (confirm("Beheerkluis van deze telefoon wissen?\n\nDe sleutels voor het beheer van je cloud verdwijnen van deze telefoon. Je cloud blijft draaien. Met je herstelsleutel (op je herstelblad) zet je het beheer later weer terug.")) phone.resetApp("console");
  });
  $("#resetAll").addEventListener("click", function () {
    if (confirm("De app helemaal opnieuw instellen?\n\nDe app vergeet je cloud, je inlog, de beheerkluis en alle instellingen, alsof hij net is geïnstalleerd. Je cloud zelf en je foto's daarin blijven bestaan. Voor het beheer heb je daarna je herstelsleutel nodig.")) phone.resetApp("all");
  });

  // ── Voor aanbieders: beheer van je Eigen Cloud Dienst ──
  var dienstForm = $("#dienstForm");
  function dienstMsg(text) {
    var m = dienstForm.querySelector(".msg");
    m.textContent = text || "";
    m.className = text ? "msg err" : "msg";
  }
  $("#dienstOpen").addEventListener("click", function () {
    if (!phone.openDienst) { dienstMsg("Werk de app bij om het beheer van je dienst te openen."); dienstForm.hidden = false; return; }
    dienstForm.address.value = (info.dienst || "").replace(/^https:\/\//, "");
    dienstMsg("");
    dienstForm.hidden = false;
    $("#dienstOpen").hidden = true;
    dienstForm.address.focus();
  });
  $("#dienstCancel").addEventListener("click", function () {
    dienstForm.hidden = true;
    $("#dienstOpen").hidden = false;
    dienstMsg("");
  });
  dienstForm.addEventListener("submit", function (e) {
    e.preventDefault();
    dienstMsg("");
    if (phone.openDienst) phone.openDienst(dienstForm.address.value);
  });

  // ── Inloggen: na Verbinden, of als je sessie verlopen is (dan meteen je vingerafdruk) ──
  var lf = $("#loginForm");
  function loginMsg(text) {
    var m = lf.querySelector(".msg");
    m.textContent = text || "";
    m.className = text ? "msg err" : "msg";
  }
  function loginBusy(on) {
    var b = lf.querySelector("button");
    b.disabled = on;
    b.textContent = on ? "Bezig…" : "Inloggen";
    $("#fpLogin").disabled = on;
  }
  function showLogin(d, auto) {
    $("#loginWhere").textContent = "Bij " + (d.host || "je cloud") + ".";
    $("#userRow").hidden = !d.multiUser;
    lf.user.required = !!d.multiUser;
    $("#passRow").hidden = false;
    lf.password.required = true;
    $("#codeRow").hidden = true;
    lf.code.required = false;
    lf.code.value = "";
    $("#rememberRow").hidden = !d.remember;
    lf.remember.checked = true;
    $("#loginNote").hidden = !d.remember || !!d.fingerprint;
    $("#fpBox").hidden = !d.fingerprint;
    lf.hidden = !!d.fingerprint;
    loginMsg("");
    loginBusy(false);
    show("login");
    if (d.fingerprint && auto) { loginBusy(true); phone.fingerprintLogin(); }
    else if (!d.fingerprint) (d.multiUser ? lf.user : lf.password).focus();
  }
  $("#fpLogin").addEventListener("click", function () { loginMsg(""); loginBusy(true); phone.fingerprintLogin(); });
  $("#typeInstead").addEventListener("click", function () { $("#fpBox").hidden = true; lf.hidden = false; $("#loginNote").hidden = $("#rememberRow").hidden; lf.password.focus(); });
  lf.addEventListener("submit", function (e) {
    e.preventDefault();
    loginMsg("");
    loginBusy(true);
    phone.login(lf.user.value, $("#passRow").hidden ? "" : lf.password.value, lf.code.value, !$("#rememberRow").hidden && lf.remember.checked);
  });
  $("#loginOther").addEventListener("click", function () { if (info.cloud) phone.forget(); else show("welcome"); });
  window.addEventListener("eigenphone", function (e) {
    var d = e.detail || {};
    if (d.type === "connect" && d.login) { var b = form.querySelector("button"); b.disabled = false; b.textContent = "Verbinden"; showLogin(d, false); return; }
    if (d.type !== "login") return;
    if (d.form || d.login) { showLogin(d, true); return; }
    loginBusy(false);
    if (d.noCloud) { show("welcome"); return; }
    if (d.mfa) {
      // Wachtwoord klopt; nu de code. Het wachtwoord onthoudt de app zolang dit scherm openstaat.
      $("#fpBox").hidden = true;
      lf.hidden = false;
      $("#passRow").hidden = true;
      lf.password.required = false;
      $("#codeRow").hidden = false;
      lf.code.required = true;
      lf.code.focus();
      loginMsg(d.error);
      return;
    }
    if (d.fingerprint === false) { $("#fpBox").hidden = true; lf.hidden = false; }
    if (d.error) loginMsg(d.error);
  });
  if (location.hash === "#inloggen" && phone.loginStart) { show("login"); $("#loginWhere").textContent = "Even kijken…"; lf.hidden = true; phone.loginStart(); }

  var form = $("#connect");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Bezig…";
    form.querySelector(".msg").textContent = "";
    phone.connect(form.address.value);
  });
  window.addEventListener("eigenphone", function (e) {
    var d = e.detail || {};
    if (d.type === "update" || d.type === "changed") {
      updMsg = d.error || (d.installing ? "Versie " + d.installing + " wordt geïnstalleerd…" : d.type === "update" && !d.available ? "Je hebt de nieuwste versie." : "");
      $("#check").disabled = false; $("#install").disabled = false;
      reload();
      return;
    }
    if (d.type === "dienst") {
      if (d.error) { dienstMsg(d.error); return; }
      info.dienst = d.url;
      dienstForm.hidden = true;
      $("#dienstOpen").hidden = false;
      return;
    }
    if (d.type !== "connect" || d.login) return;
    var btn = form.querySelector("button");
    btn.disabled = false;
    btn.textContent = "Verbinden";
    var m = form.querySelector(".msg");
    m.textContent = d.error;
    m.className = "msg err";
  });
  $("#setup").addEventListener("click", function () {
    if (info.console && info.dienstOnly && phone.openConsoleAt) phone.openConsoleAt("#jij"); else phone.openConsole();
  });
  $("#provider").addEventListener("click", openProvider);
  $("#dienstOwn").addEventListener("click", openProvider);
  $("#manage").addEventListener("click", function () { phone.openConsole(); });
  $("#retry").addEventListener("click", function () { phone.retry(); });
  $("#other").addEventListener("click", function () { phone.forget(); });

  // ── Op deze telefoon: agenda, foto's en opslag (OnPhoneActivity) ──
  var onPhone = typeof phone.openOnPhone === "function";
  $("#onPhone").hidden = !onPhone;
  $("#onPhoneAbout").hidden = !onPhone;
  document.querySelectorAll("[data-onphone]").forEach(function (b) { b.addEventListener("click", function () { phone.openOnPhone(b.dataset.onphone); }); });
})();
