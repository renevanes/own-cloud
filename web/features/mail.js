const $ = (selector) => document.querySelector(selector);
const split = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const base64 = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file); });
const states = { queued: "Wacht op verzending", retry: "Wordt opnieuw geprobeerd", processing: "Wordt verstuurd", sent: "Aangenomen door mailserver", failed: "Mislukt", uncertain: "Ontvangst controleren", pending: "Wacht", sending: "Wordt verstuurd" };
export function createMailTools({ api, esc, reload }) {
  const form = $("#composeForm"), dialog = $("#composeDlg");
  let draftId, revision, sendKey, savedAttachments = [], lastSaved = "", timer, saving = Promise.resolve();
  const panel = document.createElement("dialog"); panel.className = "dlg wide-dialog"; panel.id = "mailToolsDialog"; document.body.append(panel);
  const attachmentsLine = document.createElement("p"); attachmentsLine.className = "muted"; form.elements.files.after(attachmentsLine);
  const summary = () => { attachmentsLine.innerHTML = savedAttachments.map((a, i) => `<span>${esc(a.filename)} <button type="button" class="ghost" data-remove="${i}">Verwijderen</button></span>`).join(" "); };
  attachmentsLine.onclick = (e) => { const b = e.target.closest("[data-remove]"); if (b) { savedAttachments.splice(Number(b.dataset.remove), 1); summary(); } };
  async function contents() {
    const files = [...form.elements.files.files];
    if (files.reduce((n, f) => n + f.size, 0) > 25 * 1024 ** 2) throw new Error("Kies maximaal 25 MB aan bijlagen per bericht.");
    const attachments = [...savedAttachments, ...await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type, base64: await base64(f) })))];
    return { to: split(form.elements.to.value), cc: split(form.elements.cc.value), subject: form.elements.subject.value, text: form.elements.text.value,
      replyToId: Number(form.elements.replyToId.value) || undefined, attachments };
  }
  async function saveDraft() {
    const body = await contents(), serialized = JSON.stringify(body);
    if (serialized === lastSaved) return;
    const r = await api(`/api/mail/drafts/${draftId}`, { method: "PUT", body, headers: revision ? { "If-Match": `"draft-${draftId}-${revision}"` } : { "If-None-Match": "*" } });
    revision = r.updated; lastSaved = serialized;
    $("#composeError").textContent = r.queued ? "Concept staat op dit apparaat in de wachtrij." : "Concept bewaard.";
  }
  function requestSave() { saving = saving.catch(() => {}).then(saveDraft); return saving; }
  form.addEventListener("input", () => { clearTimeout(timer); if (navigator.onLine) timer = setTimeout(() => requestSave().catch((e) => $("#composeError").textContent = e.message), 1500); });
  $("#saveDraft").onclick = () => { clearTimeout(timer); requestSave().catch((e) => $("#composeError").textContent = e.message); };
  form.addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "send") return;
    e.preventDefault(); clearTimeout(timer);
    const button = $("#sendBtn"); button.disabled = true; button.textContent = "In postvak uit zetten…";
    try {
      await saving.catch(() => {}); const body = await contents();
      if (!body.to.length) throw new Error("Vul een ontvanger in");
      const r = await api("/api/mail/send", { method: "POST", body, headers: { "Idempotency-Key": sendKey } });
      await api(`/api/mail/drafts/${draftId}`, { method: "DELETE" }).catch(() => {});
      dialog.close(); reload();
      $("#mailToolStatus").textContent = `Bericht: ${states[r.status] ?? r.status}. Bekijk Postvak uit voor de status per ontvanger.`;
    } catch (error) { $("#composeError").textContent = error.message; }
    finally { button.disabled = false; button.textContent = "Versturen"; }
  });
  dialog.addEventListener("close", () => { clearTimeout(timer); });
  async function render(kind) {
    panel.innerHTML = `<div class="row"><h2 class="grow">${({ drafts: "Concepten", outbox: "Postvak uit", rules: "Mailregels" })[kind]}</h2><button class="ghost" data-close>Sluiten</button></div><div id="mailToolBody">Laden…</div><p class="error" id="mailToolError" role="status"></p>`;
    if (!panel.open) panel.showModal(); panel.querySelector("[data-close]").onclick = () => panel.close();
    const root = panel.querySelector("#mailToolBody");
    try {
      if (kind === "drafts") {
        const rows = await api("/api/mail/drafts");
        root.innerHTML = `<ul class="feature-list">${rows.map((d) => `<li><button class="ghost grow" data-open="${esc(d.id)}">${esc(d.mail.subject || "Zonder onderwerp")}<small>${esc((Array.isArray(d.mail.to) ? d.mail.to : split(d.mail.to)).join(", "))}</small></button><button class="ghost danger" data-delete="${esc(d.id)}">Verwijderen</button></li>`).join("") || "<li>Geen bewaarde concepten.</li>"}</ul>`;
        root.onclick = async (e) => { const b = e.target.closest("button"); if (!b) return;
          try { if (b.dataset.open) { const d = rows.find((r) => r.id === b.dataset.open); panel.close(); open({ ...d.mail, draftId: d.id, updated: d.updated }); }
            if (b.dataset.delete && confirm("Dit concept verwijderen?")) { await api(`/api/mail/drafts/${b.dataset.delete}`, { method: "DELETE" }); render(kind); } }
          catch (err) { panel.querySelector("#mailToolError").textContent = err.message; }
        };
      } else if (kind === "outbox") {
        const rows = await api("/api/mail/outbox");
        root.innerHTML = `<p>De status geeft aan of de mailserver het bericht heeft aangenomen. Bij een onderbroken verbinding controleer je zelf of een ontvanger het heeft gekregen.</p><ul class="feature-list">${rows.map((o) => `<li class="stack"><b>${esc(o.mail.subject || "Zonder onderwerp")}</b><span>${esc(states[o.status] ?? o.status)}</span>${o.deliveries.map((d) => `<div>${esc(d.address)} · ${esc(states[d.status] ?? d.status)} ${d.error ? `<small>${esc(d.error)}</small>` : ""}${d.status === "uncertain" ? `<button class="ghost" data-id="${esc(o.id)}" data-address="${esc(d.address)}" data-delivered="true">Ontvangst bevestigd</button><button class="ghost" data-id="${esc(o.id)}" data-address="${esc(d.address)}" data-delivered="false">Ontvanger heeft niets: opnieuw proberen</button>` : ""}</div>`).join("")}${["retry", "failed"].includes(o.status) ? `<button class="ghost" data-retry="${esc(o.id)}">Niet-bezorgde ontvangers opnieuw proberen</button>` : ""}</li>`).join("") || "<li>Geen uitgaande berichten.</li>"}</ul><button class="ghost" data-refresh>Vernieuwen</button>`;
        root.onclick = async (e) => { const b = e.target.closest("button"); if (!b) return;
          try { if (b.dataset.retry) await api(`/api/mail/outbox/${b.dataset.retry}/retry`, { method: "POST", body: {} });
            if (b.dataset.address) { if (b.dataset.delivered === "false" && !confirm("Opnieuw proberen kan een tweede kopie opleveren als het bericht toch ontvangen is. Verdergaan?")) return; await api(`/api/mail/outbox/${b.dataset.id}/resolve`, { method: "POST", body: { address: b.dataset.address, delivered: b.dataset.delivered === "true" } }); }
            render(kind);
          } catch (err) { panel.querySelector("#mailToolError").textContent = err.message; }
        };
      } else {
        const rows = await api("/api/mail/rules");
        root.innerHTML = `<p>Een mailregel zoekt naar tekst in een kopregel. Spamcontrole gaat vóór je regels; verdachte mail blijft in Spam.</p><ul class="feature-list">${rows.map((r) => `<li><span class="grow">${esc(r.field)} bevat “${esc(r.pattern)}” → ${esc(r.folder)}</span><button class="ghost danger" data-delete="${esc(r.id)}">Verwijderen</button></li>`).join("")}</ul><form id="mailRuleForm" class="form"><label>Kopregel<select name="field"><option value="from">Van</option><option value="to">Aan</option><option value="subject">Onderwerp</option></select></label><label>Bevat<input name="pattern" maxlength="200" required></label><label>Verplaatsen naar<select name="folder"><option value="archive">Archief</option><option value="inbox">Inbox</option><option value="spam">Spam</option><option value="trash">Prullenbak</option></select></label><button class="primary">Regel toevoegen</button></form>`;
        root.querySelector("form").onsubmit = async (e) => { e.preventDefault(); try { await api("/api/mail/rules", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); render(kind); } catch (err) { panel.querySelector("#mailToolError").textContent = err.message; } };
        root.onclick = async (e) => { const b = e.target.closest("[data-delete]"); if (b) try { await api(`/api/mail/rules/${b.dataset.delete}`, { method: "DELETE" }); render(kind); } catch (err) { panel.querySelector("#mailToolError").textContent = err.message; } };
      }
    } catch (err) { root.textContent = err.message; }
  }
  function open(pre = {}) {
    clearTimeout(timer); form.reset(); draftId = pre.draftId ?? crypto.randomUUID(); revision = pre.updated; sendKey = crypto.randomUUID(); lastSaved = ""; savedAttachments = pre.attachments ?? [];
    for (const key of ["to", "cc", "subject", "text", "replyToId"]) if (pre[key] !== undefined) form.elements[key].value = Array.isArray(pre[key]) ? pre[key].join(", ") : pre[key];
    summary(); $("#composeError").textContent = ""; dialog.showModal(); (pre.to ? form.elements.text : form.elements.to).focus();
  }
  const controls = document.createElement("div"); controls.innerHTML = `<button class="ghost block" data-kind="drafts">Concepten</button><button class="ghost block" data-kind="outbox">Postvak uit</button><button class="ghost block" data-kind="rules">Mailregels</button><small id="mailToolStatus" role="status"></small>`; $("#compose").after(controls);
  controls.onclick = (e) => { const kind = e.target.closest("[data-kind]")?.dataset.kind; if (kind) render(kind); };
  return { open };
}
