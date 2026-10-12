/* Offline data is explicit, account-scoped, bounded, and cleared on sign-out or session invalidation. */
const PUBLIC = "eigen-shell-1.17", PRIVATE = "eigen-private-", MAX_ENTRIES = 300, MAX_BYTES = 100 * 1024 ** 2, MAX_AGE = 24 * 3600_000;
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/features/index.js", "/features/mail.js", "/features/account.js", "/features/contacts.js", "/features/photos.js", "/features/offline.js", "/features/resources.js", "/shared/europe.js", "/shared/tokens.css"];
let syncing, cacheWork = Promise.resolve();
const database = new Promise((resolve, reject) => {
  const open = indexedDB.open("eigen-offline-v1", 1);
  open.onupgradeneeded = () => { open.result.createObjectStore("meta"); open.result.createObjectStore("queue", { keyPath: "id" }); };
  open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
});
async function table(store, method, value, key) {
  const db = await database, tx = db.transaction(store, ["get", "getAll"].includes(method) ? "readonly" : "readwrite");
  const request = tx.objectStore(store)[method](...(value === undefined ? [] : key === undefined ? [value] : [value, key]));
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
const config = () => table("meta", "get", "config");
const identity = (user) => `${user.cloudInstance ?? "legacy"}:${user.id}:${user.sessionGeneration ?? 0}`;
async function clear() {
  await table("meta", "put", null, "config"); await table("queue", "clear"); await cacheWork.catch(() => {});
  for (const name of await caches.keys()) if (name.startsWith(PRIVATE)) await caches.delete(name);
}
async function notify() { for (const client of await self.clients.matchAll()) client.postMessage({ type: "offline-status" }); }
async function session(c) {
  const response = await fetch("/api/me", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 401) { await clear(); throw new Error("Log opnieuw in. Lokale gegevens zijn gewist."); }
  if (!response.ok) throw new Error("Je cloud is nog niet bereikbaar.");
  const user = (await response.json()).user;
  if (c && c.identity !== identity(user)) { await clear(); throw new Error("De sessie is veranderd. Lokale gegevens zijn gewist."); }
  return user;
}
function allowed(path, c) {
  if (!c?.enabled) return false;
  if (path === "/api/me") return true;
  if (c.mail && /^\/api\/mail\/(folders|messages(?:\/\d+)?)$/.test(path)) return true;
  if (c.calendar && /^\/api\/(calendars|events(?:\/\d+)?)$/.test(path)) return true;
  if (c.contacts && path === "/api/contacts") return true;
  return c.photos && /^\/api\/photos(?:\/(?:summary|tags|map|\d+\/(?:thumb|annotations)))?$/.test(path);
}
async function limitedBody(stream, maximum) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maximum) { await reader.cancel(); return null; } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const out = new Uint8Array(bytes); let offset = 0; for (const b of chunks) { out.set(b, offset); offset += b.length; } return out;
}
async function remember(request, response, c) {
  const max = request.url.endsWith("/thumb") ? 4 * 1024 ** 2 : 2 * 1024 ** 2;
  if (Number(response.headers.get("content-length") ?? 0) > max) return;
  const bytes = await limitedBody(response.body, max); if (!bytes) return;
  cacheWork = cacheWork.catch(() => {}).then(async () => {
    if ((await config())?.identity !== c.identity) return;
    const cache = await caches.open(PRIVATE + c.identity), headers = new Headers(response.headers);
    headers.set("X-Eigen-Cached-At", String(Date.now())); headers.set("Content-Length", String(bytes.length));
    await cache.delete(request); await cache.put(request, new Response(bytes, { headers, status: response.status }));
    const keys = await cache.keys(); let total = 0;
    for (const key of keys) total += Number((await cache.match(key)).headers.get("content-length") ?? 0);
    while (keys.length > MAX_ENTRIES || total > MAX_BYTES) { const oldest = keys.shift(); const r = await cache.match(oldest); total -= Number(r.headers.get("content-length") ?? 0); await cache.delete(oldest); }
  });
  await cacheWork;
}
async function read(request, event) {
  const path = new URL(request.url).pathname, c = await config();
  if (await table("meta", "get", "signedOut") && !["/api/login/info"].includes(path)) {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    return json({ error: "Niet ingelogd" }, 401);
  }
  try {
    const response = await fetch(request);
    if (response.status === 401 && path.startsWith("/api/")) { await clear(); await notify(); }
    if (path === "/api/me" && response.ok && c && identity((await response.clone().json()).user) !== c.identity) { await clear(); await notify(); }
    if (allowed(path, c)) {
      if (response.ok) event.waitUntil(remember(request, response.clone(), c));
      else if ([403, 404].includes(response.status)) await (await caches.open(PRIVATE + c.identity)).delete(request);
    }
    return response;
  } catch {
    if (allowed(path, c)) {
      const cached = await (await caches.open(PRIVATE + c.identity)).match(request);
      if (cached && Date.now() - Number(cached.headers.get("X-Eigen-Cached-At")) < MAX_AGE) {
        const headers = new Headers(cached.headers); headers.set("X-Eigen-Offline", "true"); return new Response(cached.body, { headers, status: cached.status });
      }
    }
    return new Response(JSON.stringify({ error: "Dit is niet offline bewaard. Verbind met je cloud om het op te halen." }), { status: 503, headers: { "content-type": "application/json" } });
  }
}
function editable(method, path) {
  return /^(POST|PATCH|DELETE)$/.test(method) && /^\/api\/events(?:\/\d+)?$/.test(path) || /^(POST|PUT|DELETE)$/.test(method) && /^\/api\/contacts(?:\/[A-Za-z0-9_-]+)?$/.test(path) || /^(PUT|DELETE)$/.test(method) && /^\/api\/mail\/drafts\/[A-Za-z0-9_-]+$/.test(path);
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function write(request) {
  const saved = request.clone(), path = new URL(request.url).pathname;
  if (path === "/api/logout") {
    await clear(); await table("meta", "put", true, "signedOut");
    return fetch(request).catch(() => json({ ok: true, localSignOut: true }));
  }
  if (path === "/api/login") {
    const response = await fetch(request);
    if (response.ok) await table("meta", "put", false, "signedOut");
    return response;
  }
  if (await table("meta", "get", "signedOut")) return json({ error: "Niet ingelogd" }, 401);
  try { const response = await fetch(request); if (response.status === 401) { await clear(); await notify(); } return response; }
  catch {
    const c = await config();
    if (!c?.enabled || !c.queue || !editable(saved.method, path)) return json({ error: "Deze handeling heeft een verbinding met je cloud nodig." }, 503);
    const existing = await table("queue", "getAll");
    if (existing.length >= 50) return json({ error: "Er staan al 50 wijzigingen in de wachtrij. Verbind eerst met je cloud." }, 507);
    const data = await limitedBody(saved.body, 2 * 1024 ** 2);
    if (!data) return json({ error: "Deze wijziging is te groot om offline te bewaren." }, 413);
    const body = new TextDecoder().decode(data), headers = { "Content-Type": "application/json", "Idempotency-Key": saved.headers.get("idempotency-key") ?? crypto.randomUUID() };
    for (const name of ["If-Match", "If-None-Match"]) if (saved.headers.has(name)) headers[name] = saved.headers.get(name);
    if (saved.method !== "POST" && !path.includes("/drafts/") && !headers["If-Match"] && !(path.startsWith("/api/contacts/") && saved.method === "PUT" && JSON.parse(body || "{}").revision))
      return json({ error: "Haal eerst de nieuwste versie op voordat je dit offline wijzigt." }, 428);
    const id = crypto.randomUUID();
    await table("queue", "put", { id, identity: c.identity, method: saved.method, url: new URL(saved.url).pathname + new URL(saved.url).search, body, headers, created: Date.now(), status: "pending" });
    await notify(); if (self.registration.sync) await self.registration.sync.register("eigen-edits").catch(() => {});
    return json({ ok: true, queued: true, operationId: id }, 202);
  }
}
async function syncQueue() {
  if (syncing) return syncing;
  syncing = (async () => {
    const c = await config(); if (!c?.queue) return;
    await session(c);
    const rows = await table("queue", "getAll"); rows.sort((a, b) => a.created - b.created);
    for (const row of rows) {
      if (row.status !== "pending" || row.identity !== c.identity) continue;
      if ((await config())?.identity !== c.identity) return;
      const response = await fetch(row.url, { method: row.method, headers: row.headers, body: row.body || (row.method === "DELETE" ? "{}" : undefined), credentials: "same-origin" });
      if (response.status === 401) { await clear(); return; }
      if (response.ok) await table("queue", "delete", row.id);
      else if (response.status >= 500 || response.status === 429) return;
      else { row.status = [409, 412, 428].includes(response.status) ? "conflict" : "failed"; row.error = (await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`; await table("queue", "put", row); }
    }
  })().finally(async () => { syncing = undefined; await notify(); });
  return syncing;
}
self.addEventListener("install", (event) => event.waitUntil(caches.open(PUBLIC).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil((async () => { for (const name of await caches.keys()) if (name.startsWith("eigen-shell-") && name !== PUBLIC) await caches.delete(name); await self.clients.claim(); })()));
self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url); if (url.origin !== self.location.origin) return;
  if (request.method === "GET" && url.pathname.startsWith("/api/")) event.respondWith(read(request, event));
  else if (request.method !== "GET" && url.pathname.startsWith("/api/")) event.respondWith(write(request));
  else if (request.method === "GET" && (SHELL.includes(url.pathname) || url.pathname.startsWith("/fonts/"))) event.respondWith(fetch(request).catch(async () => (await caches.open(PUBLIC)).match(request) ?? Response.error()));
});
self.addEventListener("sync", (event) => { if (event.tag === "eigen-edits") event.waitUntil(syncQueue()); });
self.addEventListener("message", (event) => {
  event.waitUntil((async () => {
    let value;
    try {
      const message = event.data ?? {};
      if (message.type === "clear") { await clear(); value = { ok: true }; }
      else if (message.type === "configure") {
        const user = await session(), current = await config();
        if (current?.identity !== identity(user)) await clear();
        const choices = message.choices ?? {};
        await table("meta", "put", { identity: identity(user), enabled: true, mail: !!choices.mail, calendar: !!choices.calendar, contacts: !!choices.contacts, photos: !!choices.photos, queue: !!choices.queue }, "config");
        // Seed the account identity needed when reopening the shell offline.
        const request = new Request(new URL("/api/me", self.location.origin)); await remember(request, json({ ok: true, user, mailFrom: user.address }), await config());
        value = { ok: true };
      } else if (message.type === "sync") { await syncQueue(); value = { ok: true }; }
      else if (message.type === "discard") { await table("queue", "delete", message.id); value = { ok: true }; }
      else if (message.type === "status") value = { config: await config(), queue: await table("queue", "getAll") };
      else throw new Error("Onbekende handeling");
      event.ports[0]?.postMessage({ value }); if (message.type !== "status") await notify();
    } catch (error) { event.ports[0]?.postMessage({ error: error.message }); }
  })());
});
