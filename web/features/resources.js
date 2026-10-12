export function createResourceTools({ api, esc, me, section }) {
  const root = section("opslag", "Opslag en spamcontrole"); document.querySelector('#settingsNav [data-sec="opslag"]').setAttribute("data-owner", "");
  async function render() {
    if (!me().owner) return;
    try {
      const [r, users, spam] = await Promise.all([api("/api/admin/resources"), api("/api/users"), api("/api/mail/filter")]);
      root.innerHTML = `<h2>Opslag en spamcontrole</h2><p>Vrij op deze server: ${(r.freeBytes / 1e9).toFixed(1)} GB. Limieten gelden voor foto's, mail, concepten, postvak uit en tijdelijke uploads. Tijdens verwerken is extra vrije ruimte nodig.</p><form id="quotaForm" class="form narrow-form"><label>Voor wie<select name="user"><option value="">Standaard voor alle gebruikers</option>${users.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></label><label>Limiet in GB (0 = geen limiet)<input name="limit" type="number" min="0" step="0.001" required value="${r.defaultLimitBytes / 1e9}"></label><button class="primary">Limiet opslaan</button></form><p class="error" role="status"></p><h3>Werk dat nog wacht</h3><ul class="feature-list">${r.imports.map((j) => `<li>Import · gebruiker ${j.user_id} · ${esc(j.status)} · ${j.count}</li>`).join("")}${r.outbox.map((j) => `<li>Postvak uit · ${esc(j.status)} · ${j.count}</li>`).join("") || ""}</ul><h3>Spamcontrole</h3><p>Gebruik de Rspamd-service van je eigen server. Als de service hapert blijft mail bewaard; de controle krijgt dan de status ‘niet beschikbaar’. Verdachte mail gaat naar Spam.</p><form id="spamForm" class="form narrow-form"><label>Adres van je Rspamd-service (leeg = uit)<input name="url" type="url" value="${esc(spam.url ?? "")}"></label><label>Spam vanaf deze score<input name="threshold" type="number" min="0" max="100" step="0.1" value="${spam.threshold}" required></label><button class="primary">Spamcontrole opslaan</button></form>`;
      const status = root.querySelector('[role="status"]');
      const form = root.querySelector("#quotaForm");
      form.elements.user.onchange = () => { const row = r.userLimits.find((x) => x.key === `storage_limit:${form.elements.user.value}`); form.elements.limit.value = (row ? Number(row.value) : r.defaultLimitBytes) / 1e9; };
      form.onsubmit = async (e) => { e.preventDefault(); try { await api("/api/admin/resources", { method: "PUT", body: { bytes: Math.round(Number(form.elements.limit.value) * 1e9), userId: Number(form.elements.user.value) || undefined } }); status.textContent = "Limiet opgeslagen."; } catch (err) { status.textContent = err.message; } };
      root.querySelector("#spamForm").onsubmit = async (e) => { e.preventDefault(); try { await api("/api/mail/filter", { method: "PUT", body: { url: e.target.elements.url.value, threshold: Number(e.target.elements.threshold.value) } }); status.textContent = "Spamcontrole opgeslagen."; } catch (err) { status.textContent = err.message; } };
    } catch (err) { root.textContent = err.message; }
  }
  return { show: (name) => name === "opslag" ? render() : undefined };
}
