export function createAccountTools({ api, esc, me, section, reloadShared }) {
  const security = section("beveiliging", "Beveiliging");
  const sharing = section("delen", "Delen");
  const data = section("gegevens", "Je gegevens");
  const error = (root, err) => { root.querySelector("[role=status]").textContent = err.message; };
  const field = (name, label, type = "text", attrs = "") => `<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`;
  const password = field("password", "Wachtwoord", "password", 'autocomplete="current-password" required maxlength="1024"');
  const code = field("code", "Tweede inlogcode of herstelcode (als ingesteld)", "text", 'autocomplete="one-time-code" maxlength="100"');
  async function renderSecurity(extra = "") {
    try {
      const s = await api("/api/security");
      security.innerHTML = `<h2>Beveiliging</h2>${extra}<p class="error" role="status"></p><h3>Tweede inlogstap</h3><p>${s.mfa ? `Ingeschakeld · ${s.recoveryCodes} herstelcodes over.` : "Voeg een authenticator-app toe, met herstelcodes voor als je je telefoon kwijt bent."}</p><form id="mfaForm" class="form narrow-form">${password}${code}<button class="primary" name="action" value="${s.mfa ? "disable" : "enrol"}">${s.mfa ? "Tweede stap uitschakelen" : "Authenticator instellen"}</button></form><div id="mfaPending"></div>
        <h3>Apparaten en sessies</h3><p>Wachtwoordwijzigingen trekken oude sessies en sync-wachtwoorden in. Bij oudere sessies verschijnt een apparaat na opnieuw inloggen.</p><ul class="feature-list">${s.sessions.map((r) => `<li><span class="grow">${esc(r.label)} ${r.current ? "(dit apparaat)" : ""}<small>Laatst gebruikt ${new Date(r.lastUsed).toLocaleString("nl-NL")}</small></span>${r.current ? "" : `<button class="ghost danger" data-session="${esc(r.id)}">Uitloggen</button>`}</li>`).join("")}</ul><button id="revokeDevices" class="ghost">Andere apparaten en sync-wachtwoorden uitloggen</button>
        <h3>Agenda en contacten synchroniseren</h3><p>Gebruik je mailadres als gebruikersnaam en maak hieronder een apart wachtwoord. CalDAV: <code>${esc(location.origin)}/dav/calendars/${me().id}/</code><br>CardDAV: <code>${esc(location.origin)}/dav/addressbooks/${me().id}/</code></p>
        <ul class="feature-list">${s.credentials.map((c) => `<li><span class="grow">${esc(c.label)}<small>${esc(JSON.parse(c.scopes).join(", "))} · verloopt ${new Date(c.expires).toLocaleDateString("nl-NL")}</small></span><button class="ghost danger" data-credential="${esc(c.id)}">Intrekken</button></li>`).join("")}</ul>
        <form id="credentialForm" class="form narrow-form">${field("label", "Naam van het apparaat", "text", 'required maxlength="80"')}${password}${code}<label class="check"><input type="checkbox" name="caldav" checked> Agenda's (CalDAV)</label><label class="check"><input type="checkbox" name="carddav" checked> Contacten (CardDAV)</label><button class="primary">Sync-wachtwoord maken</button></form><div id="credentialSecret"></div>`;
      security.querySelector("#mfaForm").onsubmit = async (e) => {
        e.preventDefault(); const body = Object.fromEntries(new FormData(e.target));
        try {
          if (s.mfa) { await api("/api/security/mfa/disable", { method: "POST", body }); await renderSecurity(); return; }
          const enrol = await api("/api/security/mfa/enrol", { method: "POST", body }); e.target.reset();
          const pending = security.querySelector("#mfaPending");
          pending.innerHTML = `<div class="note"><p>Scan met je authenticator-app, of voer de sleutel in. De sleutel blijft tien minuten geldig voor instellen.</p><img src="${esc(enrol.qr)}" alt="QR-code voor je authenticator" width="180"><p><code>${esc(enrol.secret)}</code></p><form id="mfaConfirm" class="form narrow-form"><label>Code uit de app<input name="code" autocomplete="one-time-code" pattern="[0-9]{6}" required></label><button class="primary">Tweede stap inschakelen</button></form></div>`;
          pending.querySelector("form").onsubmit = async (event) => {
            event.preventDefault(); try { const r = await api("/api/security/mfa/confirm", { method: "POST", body: { code: event.target.elements.code.value } });
              await renderSecurity(`<div class="note" id="recoveryCodes"><b>Bewaar deze herstelcodes op een veilige plek buiten dit apparaat.</b><p>Elke code werkt één keer. Ze worden nu één keer getoond.</p><pre>${esc(r.recoveryCodes.join("\n"))}</pre><button class="ghost" id="downloadRecovery">Herstelcodes downloaden</button></div>`);
              security.querySelector("#downloadRecovery").onclick = () => { const url = URL.createObjectURL(new Blob([r.recoveryCodes.join("\n") + "\n"], { type: "text/plain" })); const a = document.createElement("a"); a.href = url; a.download = "eigen-cloud-herstelcodes.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
            } catch (err) { error(security, err); }
          };
        } catch (err) { error(security, err); }
      };
      security.querySelector("#revokeDevices").onclick = async () => {
        if (!confirm("Andere apparaten moeten opnieuw inloggen. CalDAV- en CardDAV-clients krijgen een nieuw sync-wachtwoord. Doorgaan?")) return;
        try { await api("/api/security/sessions/revoke-others", { method: "POST", body: {} }); await renderSecurity(); } catch (err) { error(security, err); }
      };
      security.querySelector("#credentialForm").onsubmit = async (e) => {
        e.preventDefault(); const f = e.target.elements;
        try { const r = await api("/api/security/credentials", { method: "POST", body: { label: f.label.value, password: f.password.value, code: f.code.value, scopes: [f.caldav.checked && "caldav", f.carddav.checked && "carddav"].filter(Boolean) } });
          await renderSecurity(); security.querySelector("#credentialSecret").innerHTML = `<div class="note"><b>Dit wachtwoord wordt één keer getoond.</b><p>Gebruikersnaam: ${esc(r.username)}</p><p><code>${esc(r.password)}</code></p></div>`;
        } catch (err) { error(security, err); }
      };
      security.onclick = async (e) => { const b = e.target.closest("[data-session],[data-credential]"); if (!b) return;
        try { await api(`/api/security/${b.dataset.session ? "sessions/" + b.dataset.session : "credentials/" + b.dataset.credential}`, { method: "DELETE" }); await renderSecurity(); } catch (err) { error(security, err); }
      };
    } catch (err) { security.textContent = err.message; }
  }
  async function renderSharing() {
    try {
      const [shares, calendars, albums] = await Promise.all([api("/api/sharing"), api("/api/calendars"), api("/api/albums")]);
      const resources = [...calendars.filter((r) => r.role === "owner").map((r) => ({ ...r, kind: "calendar" })), ...albums.filter((r) => r.role === "owner").map((r) => ({ ...r, kind: "album" }))];
      sharing.innerHTML = `<h2>Delen met je familie</h2><p>Je deelt alleen een gekozen agenda of album. De andere gebruiker moet de uitnodiging eerst aannemen.</p><p class="error" role="status"></p><ul class="feature-list">${shares.map((s) => `<li><span class="grow">${esc(s.name)} · ${esc(s.owner)} → ${esc(s.member)}<small>${s.role === "write" ? "Samen wijzigen" : "Alleen lezen"} · ${esc(({ invited: "Uitgenodigd", accepted: "Aangenomen", declined: "Afgewezen" })[s.status])}</small></span>${s.member_id === me().id && s.status === "invited" ? `<button class="ghost" data-accept="${esc(s.id)}">Aannemen</button><button class="ghost" data-decline="${esc(s.id)}">Afwijzen</button>` : ""}<button class="ghost danger" data-remove="${esc(s.id)}">${s.owner_id === me().id ? "Intrekken" : "Verlaten"}</button></li>`).join("") || "<li>Er is nog niets gedeeld.</li>"}</ul><h3>Uitnodigen</h3><form id="shareForm" class="form narrow-form"><label>Agenda of album<select name="resource">${resources.map((r) => `<option value="${r.kind}:${r.id}">${r.kind === "calendar" ? "Agenda" : "Album"}: ${esc(r.name)}</option>`).join("")}</select></label>${field("member", "Mailadres van een andere gebruiker in deze cloud", "email", "required")}<label>Rechten<select name="role"><option value="read">Alleen lezen</option><option value="write">Samen wijzigen</option></select></label><button class="primary" ${resources.length ? "" : "disabled"}>Uitnodigen</button></form><h3>Nieuwe agenda of nieuw album</h3><form id="resourceForm" class="form narrow-form"><label>Soort<select name="kind"><option value="calendar">Agenda</option><option value="album">Album</option></select></label>${field("name", "Naam", "text", 'required maxlength="120"')}<button class="ghost">Aanmaken</button></form>`;
      sharing.querySelector("#shareForm").onsubmit = async (e) => { e.preventDefault(); const f = e.target.elements, [kind, id] = f.resource.value.split(":");
        try { await api("/api/sharing", { method: "POST", body: { kind, resourceId: Number(id), member: f.member.value, role: f.role.value } }); renderSharing(); } catch (err) { error(sharing, err); }
      };
      sharing.querySelector("#resourceForm").onsubmit = async (e) => { e.preventDefault(); const f = e.target.elements;
        try { await api(f.kind.value === "calendar" ? "/api/calendars" : "/api/albums", { method: "POST", body: { name: f.name.value } }); reloadShared(); renderSharing(); } catch (err) { error(sharing, err); }
      };
      sharing.onclick = async (e) => { const b = e.target.closest("[data-accept],[data-decline],[data-remove]"); if (!b) return;
        try { const id = b.dataset.accept ?? b.dataset.decline ?? b.dataset.remove;
          await api(`/api/sharing/${id}${b.dataset.remove ? "" : "/respond"}`, { method: b.dataset.remove ? "DELETE" : "POST", body: b.dataset.remove ? undefined : { accept: !!b.dataset.accept } }); reloadShared(); renderSharing();
        } catch (err) { error(sharing, err); }
      };
    } catch (err) { sharing.textContent = err.message; }
  }
  async function renderData() {
    try { const p = await api("/api/export/preview");
      data.innerHTML = `<h2>Je gegevens meenemen</h2><p>Download alle eigen mail, agenda's, contacten, foto's, albums, tags, herkende tekst, concepten en postvak uit. Het zipbestand bevat originele bestanden en een SHA-256-controlelijst. Accountgeheimen en nog niet verwerkte importarchieven zitten er niet in.</p><p>${p.messages} berichten · ${p.events} afspraken · ${p.photos} foto's · ${p.contacts} contacten · ongeveer ${(p.bytes / 1e6).toFixed(1)} MB aan bestanden.</p><a class="btn primary" href="/api/export/download" download>Alles downloaden</a><p class="muted">Gedeelde gegevens blijven eigendom van de gebruiker die ze heeft gemaakt. Voor overstappen naar een andere aanbieder open je de beheerconsole of de Android-app.</p>`;
    } catch (err) { data.textContent = err.message; }
  }
  return { show: (name) => { if (name === "beveiliging") return renderSecurity(); if (name === "delen") return renderSharing(); if (name === "gegevens") return renderData(); } };
}
