export function createContacts({ api, esc }) {
  const form = document.querySelector("#contactForm"), root = document.querySelector("#contactList"), status = document.querySelector("#contactMessage");
  let rows = [];
  async function load() {
    try { rows = await api("/api/contacts");
      root.innerHTML = rows.map((c) => `<li><button class="ghost grow" data-edit="${esc(c.id)}"><b>${esc(c.name)}</b><small>${esc(c.email)}${c.phone ? " · " + esc(c.phone) : ""}</small></button><button class="ghost danger" data-delete="${esc(c.id)}">Verwijderen</button></li>`).join("") || "<li>Je adresboek is nog leeg.</li>";
    } catch (err) { status.textContent = err.message; }
  }
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = form.elements, id = f.id.value;
    try { const r = await api(id ? `/api/contacts/${id}` : "/api/contacts", { method: id ? "PUT" : "POST", body: { name: f.name.value, email: f.email.value, phone: f.phone.value, ...(id ? { revision: Number(f.revision.value) } : {}) } });
      form.reset(); status.textContent = r.queued ? "Wijziging staat op dit apparaat in de wachtrij." : "Contact opgeslagen."; load();
    } catch (err) { status.textContent = err.message; }
  };
  root.onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return; const c = rows.find((r) => r.id === (b.dataset.edit ?? b.dataset.delete)); if (!c) return;
    if (b.dataset.edit) { for (const key of ["id", "revision", "name", "email", "phone"]) form.elements[key].value = c[key] ?? ""; form.elements.name.focus(); }
    if (b.dataset.delete && confirm(`Contact ${c.name} verwijderen?`)) try { await api(`/api/contacts/${c.id}`, { method: "DELETE", headers: { "If-Match": `"contact-${c.id}-${c.revision}"` } }); load(); } catch (err) { status.textContent = err.message; }
  };
  form.onreset = () => { queueMicrotask(() => { form.elements.id.value = ""; form.elements.revision.value = ""; }); };
  return { load };
}
