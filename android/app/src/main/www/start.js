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

  function show(id) {
    $("#welcome").hidden = id !== "welcome";
    $("#offline").hidden = id !== "offline";
  }
  show(location.hash === "#offline" && info.cloud ? "offline" : "welcome");

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
