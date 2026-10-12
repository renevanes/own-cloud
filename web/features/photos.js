export function createPhotoTools({ api, esc, show }) {
  const head = document.querySelector(".photo-head"), annotations = document.querySelector("#photoAnnotations");
  const mapButton = document.createElement("button"); mapButton.className = "ghost"; mapButton.textContent = "Kaart"; head.prepend(mapButton);
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "Zoek in namen, beschrijving en tekst"; search.setAttribute("aria-label", "Foto's zoeken"); search.id = "photoTextSearch"; head.prepend(search);
  const tagFilter = document.createElement("select"); tagFilter.id = "photoTagFilter"; tagFilter.setAttribute("aria-label", "Foto's met een tag"); head.prepend(tagFilter);
  const map = document.createElement("dialog"); map.id = "photoMap"; map.className = "dlg wide-dialog"; document.body.append(map);
  async function tags() {
    try { const selected = tagFilter.value, rows = await api("/api/photos/tags"); tagFilter.innerHTML = '<option value="">Alle tags</option>' + rows.map((r) => `<option value="${esc(r.tag)}">${esc(r.tag)} (${r.count})</option>`).join(""); tagFilter.value = selected; } catch { /* older cloud */ }
  }
  mapButton.onclick = async () => {
    map.innerHTML = '<div class="row"><h2 class="grow">Locaties van je foto’s</h2><button class="ghost" data-close>Sluiten</button></div><p>Kies een punt om de foto te bekijken. De kaart gebruikt alleen de locatie die al in je foto staat.</p><div id="photoMapBody">Laden…</div>';
    map.querySelector("[data-close]").onclick = () => map.close(); map.showModal();
    try {
      const rows = await api("/api/photos/map"), root = map.querySelector("#photoMapBody");
      const xy = (points) => points.map(([lon, lat]) => `${(lon + 180) * 2},${(90 - lat) * 2}`).join(" ");
      const land = [ [[-168,70],[-125,70],[-55,50],[-80,10],[-115,28],[-168,60]], [[-80,10],[-35,-6],[-50,-55],[-75,-30]], [[-20,35],[35,35],[50,10],[20,-35],[-10,0]], [[-10,70],[70,75],[180,55],[140,10],[100,-5],[40,30],[-10,35]], [[110,-12],[155,-10],[153,-40],[113,-35]], [[-180,-70],[180,-70],[180,-90],[-180,-90]] ];
      root.innerHTML = rows.length ? `<svg class="photo-map" viewBox="0 0 720 360" role="img" aria-label="Wereldkaart met fotolocaties"><rect width="720" height="360" fill="#e6eef2"/>${land.map((p) => `<polygon points="${xy(p)}" fill="#d7dfd0" stroke="#9eac98"/>`).join("")}${[-60,-30,0,30,60].map((lat) => `<path d="M0 ${(90-lat)*2}H720" stroke="#bac7cf"/><text x="3" y="${(90-lat)*2-3}" font-size="10">${lat}°</text>`).join("")}${rows.map((p, i) => `<circle tabindex="0" role="button" aria-label="${esc(p.filename)}" data-photo="${i}" cx="${(p.lon+180)*2}" cy="${(90-p.lat)*2}" r="4" fill="#a73528"><title>${esc(p.filename)} · ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</title></circle>`).join("")}</svg><div id="mapPhoto"></div><p>${rows.length} foto's met locatie (maximaal 5000).</p>` : "<p>Je foto's hebben nog geen locatiegegevens.</p>";
      const select = (event) => { const point = event.target.closest("[data-photo]"); if (!point) return; const p = rows[Number(point.dataset.photo)]; root.querySelector("#mapPhoto").innerHTML = `<a href="/api/photos/${p.id}/original" target="_blank" rel="noopener"><img src="/api/photos/${p.id}/thumb" alt="${esc(p.filename)}" width="180"></a><p>${esc(p.filename)} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</p>`; };
      root.onclick = select; root.onkeydown = (e) => { if (["Enter", " "].includes(e.key)) select(e); };
    } catch (err) { map.querySelector("#photoMapBody").textContent = err.message; }
  };
  let current, polling;
  async function annotate(p) {
    current = p.id; clearTimeout(polling); annotations.textContent = "Laden…";
    try {
      const a = await api(`/api/photos/${p.id}/annotations`); if (current !== p.id) return;
      document.querySelector("#pvFav").hidden = !a.canEdit; document.querySelector("#pvDelete").hidden = !a.canEdit;
      annotations.innerHTML = `<form id="photoTagsForm" class="row"><label class="grow">Tags, bijvoorbeeld personen (komma's ertussen)<input name="tags" value="${esc(a.tags.join(", "))}" ${a.canEdit ? "" : "readonly"}></label>${a.canEdit ? '<button class="ghost">Tags opslaan</button>' : ""}</form><div class="row"><span class="grow">Tekstherkenning gebeurt op je eigen server.</span>${a.canEdit && !p.is_video ? '<button id="photoOcr" class="ghost">Tekst herkennen</button>' : ""}</div><p role="status" id="annotationStatus">${a.ocr ? esc(({ queued: "Wacht op tekstherkenning", running: "Tekst wordt herkend", done: "Tekst herkend", failed: a.ocr.error })[a.ocr.status] ?? a.ocr.status) : ""}</p>${a.text ? `<details><summary>Herkende tekst</summary><pre>${esc(a.text)}</pre></details>` : ""}`;
      annotations.querySelector("form").onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/photos/${p.id}/tags`, { method: "PUT", body: { tags: e.target.elements.tags.value.split(",").map((s) => s.trim()).filter(Boolean) } }); annotations.querySelector("#annotationStatus").textContent = "Tags opgeslagen."; tags(); } catch (err) { annotations.querySelector("#annotationStatus").textContent = err.message; } };
      annotations.querySelector("#photoOcr")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await api(`/api/photos/${p.id}/ocr`, { method: "POST", body: {} }); annotate(p); } catch (err) { annotations.querySelector("#annotationStatus").textContent = err.message; } });
      if (["queued", "running"].includes(a.ocr?.status) && document.querySelector("#photoDlg").open) polling = setTimeout(() => annotate(p), 3000);
    } catch (err) { if (current === p.id) annotations.textContent = err.message; }
  }
  document.querySelector("#photoDlg").addEventListener("close", () => { current = null; clearTimeout(polling); });
  return { annotate, tags, search: () => search.value, tag: () => tagFilter.value, onSearch: (load) => { let timer; search.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 300); }; tagFilter.onchange = load; } };
}
