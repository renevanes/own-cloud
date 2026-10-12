/**
 * De herstelsleutel controleren: de server kiest één groep (1–8) en onthoudt die; fout → gewone melding, geen slot;
 * terug naar de sleutel → een andere groep; "later controleren" → verder, met een herinnering (keyCheck "later").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "herstelsleutel-"));
process.env.EIGEN_CONSOLE_LOCAL = "1";
process.env.EIGEN_VAULT = path.join(base, "kluis.json");

const { buildConsole } = await import("../src/console/server.js");

type App = Awaited<ReturnType<typeof buildConsole>>;
function client(app: App) {
  let cookie = "";
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: body as never, headers: cookie ? { cookie } : {} });
    const sc = r.headers["set-cookie"];
    if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(";")[0];
    return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), text: r.body };
  };
}
/** Zoals iemand het overtypt: hoofdletters, spaties, O voor 0 en l voor 1. */
const sloppy = (g: string) => ` ${g.slice(0, 4)} ${g.slice(4)} `.toUpperCase().replace(/0/g, "O").replace(/1/g, "l");

test("herstelsleutel: één groep vragen, fout, terug, later en goed; Dienst-kluis met later", async () => {
  const app = await buildConsole();
  const c = client(app);
  assert.equal((await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", passphrase: "vier losse woorden hier" })).status, 200);

  let k = (await c("GET", "/api/key")).json;
  assert.equal(k.groups.length, 8);
  assert.ok(Number.isInteger(k.ask) && k.ask >= 1 && k.ask <= 8, "ask is 1–8");
  assert.equal(k.confirmed, false);
  assert.equal(k.later, false);
  assert.equal((await c("GET", "/api/key")).json.ask, k.ask, "herladen vraagt dezelfde groep");
  assert.equal((await c("GET", "/api/config")).json.keyCheck, "open");

  // Fout: gewone melding met het groepnummer, geen slot.
  const wrongGroup = k.groups[k.ask % 8];
  for (let i = 0; i < 6; i++) {
    const r = await c("POST", "/api/key/confirm", { group: k.ask, value: i === 0 && wrongGroup !== k.groups[k.ask - 1] ? wrongGroup : "00000000" });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, `Dat is niet groep ${k.ask}. Kijk nog eens op je herstelblad.`);
    assert.equal(r.json.ask, k.ask);
  }
  // Een andere groep dan gevraagd → 409 met de gevraagde groep.
  const other = (k.ask % 8) + 1;
  let r = await c("POST", "/api/key/confirm", { group: other, value: k.groups[other - 1] });
  assert.equal(r.status, 409);
  assert.equal(r.json.ask, k.ask);

  // Terug naar de sleutel → een andere groep, en die blijft.
  const before = k.ask;
  r = await c("POST", "/api/key/new-group");
  assert.notEqual(r.json.ask, before);
  k = (await c("GET", "/api/key")).json;
  assert.equal(k.ask, r.json.ask);

  // Later controleren: de stappen gaan door, starten blokkeert er niet op, herinnering aan.
  r = await c("POST", "/api/key/later");
  assert.deepEqual(r.json, { ok: true, later: true });
  assert.equal((await c("GET", "/api/config")).json.keyCheck, "later");
  assert.equal((await c("GET", "/api/key")).json.later, true);
  let item = (await c("GET", "/api/checklist")).json.find((x: { id: string }) => x.id === "sleutel");
  assert.equal(item.ok, false);
  assert.equal(item.required, false, "later: starten kan");

  // Goed, met slordig typen (hoofdletters, spaties, O/l).
  r = await c("POST", "/api/key/confirm", { group: k.ask, value: sloppy(k.groups[k.ask - 1]) });
  assert.equal(r.status, 200, r.text);
  assert.equal((await c("GET", "/api/config")).json.keyCheck, "ok");
  const k2 = (await c("GET", "/api/key")).json;
  assert.equal(k2.confirmed, true);
  assert.equal(k2.later, false);
  item = (await c("GET", "/api/checklist")).json.find((x: { id: string }) => x.id === "sleutel");
  assert.deepEqual([item.ok, item.required], [true, true]);
  assert.deepEqual((await c("POST", "/api/key/later")).json, { ok: true, later: false }, "na de controle geen herinnering meer");

  // De oude vorm (groep 3 en 7) werkt nog.
  assert.equal((await c("POST", "/api/key/confirm", { g3: "fout", g7: k.groups[6] })).status, 400);
  assert.equal((await c("POST", "/api/key/confirm", { g3: k.groups[2], g7: k.groups[6] })).status, 200);

  // Opnieuw beginnen, nu met een kluis alleen voor een Dienst.
  assert.equal((await c("POST", "/api/setup/reset", {})).status, 200);
  assert.equal((await c("POST", "/api/setup/aanbieder", { passphrase: "vier losse woorden hier" })).status, 200);
  assert.equal((await c("POST", "/api/key/later")).json.later, true);
  assert.equal((await c("GET", "/api/config")).json.keyCheck, "later");
  r = await c("POST", "/api/setup/cloud", { domain: "vanes.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord" });
  assert.equal(r.json.step, "regelen", "later telt: niet terug naar de sleutel");
  await app.close();
});
