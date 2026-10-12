export function createOffline({ api, esc, section }) {
  const root = section("offline", "Offline op dit apparaat"), banner = document.querySelector("#offlineBanner");
  let registration, starting;
  async function start() {
    if (!navigator.serviceWorker) return;
    if (!starting) starting = navigator.serviceWorker.register("/sw.js").then(async (r) => { registration = r; await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
      setInterval(() => { if (navigator.onLine) message("sync").catch(() => {}); }, 60_000);
    });
    await starting; update();
  }
  async function message(type, extra = {}) {
    await start(); const worker = navigator.serviceWorker?.controller ?? registration?.active;
    if (!worker) throw new Error("Offline toegang vraagt een browser met service workers en een beveiligd adres.");
    const channel = new MessageChannel();
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Offline instellingen zijn nog niet beschikbaar.")), 15000); channel.port1.onmessage = (e) => { clearTimeout(timer); channel.port1.close(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.value); }; worker.postMessage({ type, ...extra }, [channel.port2]); });
  }
  let updating = false;
  async function update() {
    if (updating || !navigator.serviceWorker?.controller) return;
    updating = true;
    try { const s = await message("status"); const count = s.queue.length;
      banner.hidden = navigator.onLine && !count;
      banner.textContent = `${navigator.onLine ? "" : "Offline — je ziet eerder bewaarde gegevens. "}${count ? `${count} wijziging${count === 1 ? "" : "en"} op dit apparaat in de wachtrij. Bekijk Offline bij Instellingen.` : ""}`;
    } catch { /* initial worker startup */ } finally { updating = false; }
  }
  async function render() {
    try { const s = await message("status"), c = s.config ?? {};
      root.innerHTML = `<h2>Offline op dit apparaat</h2><p>Bewaar alleen op je eigen apparaat. Je browser bewaart gekozen gegevens maximaal 24 uur, tot 100 MB. Ze zijn leesbaar voor iemand die dit browserprofiel kan openen. Uitloggen, een andere account of een ongeldige sessie wist de lokale gegevens en de wachtrij.</p><form id="offlineForm" class="form narrow-form">${[["mail", "Mail die je opent"], ["calendar", "Agenda's die je opent"], ["contacts", "Contacten"], ["photos", "Fotolijsten en kleine voorbeelden"], ["queue", "Agenda- en contactwijzigingen en concepten in een wachtrij bewaren"]].map(([name, label]) => `<label class="check"><input type="checkbox" name="${name}" ${c[name] ? "checked" : ""}> ${label}</label>`).join("")}<button class="primary">Offline toegang inschakelen</button><button type="button" id="clearOffline" class="ghost danger">Alles wissen en uitschakelen</button></form><p class="error" id="offlineMessage" role="status"></p><h3>Wijzigingen op dit apparaat</h3><p>Ze gaan naar je cloud zodra je verbinding hebt. Een conflict wordt bewaard om te controleren; het overschrijft de serverversie niet.</p><ul class="feature-list">${s.queue.map((r) => `<li class="stack"><b>${esc(r.method)} ${esc(r.url)}</b><span>${r.status === "pending" ? "Wacht op verbinding" : esc(r.error || r.status)}</span><details><summary>Mijn wijziging bekijken</summary><pre>${esc(r.body || "Verwijderen")}</pre></details>${r.status !== "pending" ? '<p>Haal de huidige gegevens op in de app en pas je gewenste wijziging opnieuw toe. Verwijder deze oude poging daarna uit de wachtrij.</p>' : ""}<button class="ghost danger" data-discard="${esc(r.id)}">Deze poging verwijderen</button></li>`).join("") || "<li>De wachtrij is leeg.</li>"}</ul><button id="syncOffline" class="ghost">Nu synchroniseren</button>`;
      root.querySelector("form").onsubmit = async (e) => { e.preventDefault(); const choices = Object.fromEntries([...e.target.querySelectorAll("input")].map((input) => [input.name, input.checked]));
        try { await message("configure", { choices }); await api("/api/me"); root.querySelector("#offlineMessage").textContent = "Ingeschakeld. Gegevens die je vanaf nu opent worden bewaard."; } catch (err) { root.querySelector("#offlineMessage").textContent = err.message; }
      };
      root.querySelector("#clearOffline").onclick = async () => { if (!confirm("Lokale gegevens en nog niet gesynchroniseerde wijzigingen wissen?")) return; await message("clear"); render(); };
      root.querySelector("#syncOffline").onclick = async () => { try { await message("sync"); render(); } catch (err) { root.querySelector("#offlineMessage").textContent = err.message; } };
      root.onclick = async (e) => { const b = e.target.closest("[data-discard]"); if (b && confirm("Deze lokale wijziging verwijderen?")) { await message("discard", { id: b.dataset.discard }); render(); } };
    } catch (err) { root.textContent = err.message; }
  }
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data.type === "offline-status") update(); });
  window.addEventListener("online", () => { message("sync").catch(() => {}); update(); }); window.addEventListener("offline", update);
  return { start, show: (name) => name === "offline" ? render() : undefined, clear: () => message("clear").catch(() => {}) };
}
