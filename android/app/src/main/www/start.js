// Startscherm van de Android-app: verbinden met je cloud, of er zelf een opzetten.
(function () {
  "use strict";
  var phone = window.EigenPhone;
  var $ = function (s) { return document.querySelector(s); };
  var info = {};
  try { info = JSON.parse(phone.info()) || {}; } catch (e) { info = {}; }

  if (info.console) {
    $("#setup b").textContent = "Beheer openen";
    $("#setup .muted").textContent = "Je cloud starten, laten slapen of wakker maken, en instellingen van je servers.";
  }

  var home = location.hash === "#offline" && info.cloud ? "offline" : "welcome";
  function show(id) {
    $("#welcome").hidden = id !== "welcome";
    $("#offline").hidden = id !== "offline";
    $("#about").hidden = id !== "about";
    $(".foot").hidden = id === "about";
    window.scrollTo(0, 0);
  }
  show(location.hash === "#over" ? "about" : home);

  // ── Over Eigen Cloud ──
  function reload() { try { info = JSON.parse(phone.info()) || {}; } catch (e) { /* oud */ } renderAbout(); }
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
    if (d.type !== "connect") return;
    var btn = form.querySelector("button");
    btn.disabled = false;
    btn.textContent = "Verbinden";
    var m = form.querySelector(".msg");
    m.textContent = d.error;
    m.className = "msg err";
  });
  $("#setup").addEventListener("click", function () { phone.openConsole(); });
  $("#manage").addEventListener("click", function () { phone.openConsole(); });
  $("#retry").addEventListener("click", function () { phone.retry(); });
  $("#other").addEventListener("click", function () { phone.forget(); });
})();
