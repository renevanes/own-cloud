/**
 * Instellen zonder wachtwoorden te bedenken of te typen: de wachtwoordgenerator en het plakken van sleutels
 * (web-console/secrets.js, gelijk aan Passwords.java via golden.ts), en de console op de computer naast de app:
 * dezelfde vormen van /api/state en /api/config (test/fixtures/console-shapes.json, ook gecontroleerd door
 * DeviceVaultTest.java), en duidelijke fouten voor wat alleen in de app kan (kluis achter de vingerafdruk,
 * het wachtwoord van je cloud tonen).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePassword, normalizeSecret, passwordBits, ALPHABET, PATTERN, MAX_PASTE } from "../web-console/secrets.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "vingerafdruk-"));
process.env.EIGEN_CONSOLE_LOCAL = "1";
process.env.EIGEN_VAULT = path.join(base, "kluis.json");

const { buildConsole } = await import("../src/console/server.js");
const shapes = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/console-shapes.json"), "utf8"));

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
const ch = (n: number) => String.fromCharCode(n);

test("wachtwoordgenerator: sterk, leesbaar, zonder herhaling of voorkeur", () => {
  assert.equal(ALPHABET.length, 31);
  for (const bad of "ilo01ILO") assert.ok(!ALPHABET.includes(bad), `geen ${bad}`);
  assert.ok(passwordBits() > 98, `bits: ${passwordBits()}`);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (let i = 0; i < 3000; i++) {
    const p = generatePassword();
    assert.match(p, PATTERN);
    assert.ok(p.length >= 10, "cloud wil minstens 10 tekens");
    seen.add(p);
    for (const c of p.replace(/-/g, "")) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.equal(seen.size, 3000, "geen herhaling");
  assert.equal(counts.size, ALPHABET.length, "elk teken komt voor");
  const expected = (3000 * 20) / ALPHABET.length;
  for (const [c, n] of counts) assert.ok(Math.abs(n - expected) < expected * 0.2, `teken ${c} ongeveer even vaak (${n} ≈ ${expected.toFixed(0)})`);
  // Afwijzen boven het grootste veelvoud van 31 (248): geen voorkeur voor de eerste tekens.
  const fake = (b: Uint8Array) => { b.fill(1); b.set([255, 250, 248, 247]); };
  const nine = ALPHABET[247 % 31].repeat(5);
  assert.equal(generatePassword(fake), [nine, nine, nine, nine].join("-"), "bytes ≥ 248 overgeslagen, 247 → laatste teken");
});

test("plakken: sleutels en tokens schoon in het veld", () => {
  assert.equal(normalizeSecret("  SCWABCDEFGHIJKLMNOPQ \n"), "SCWABCDEFGHIJKLMNOPQ");
  assert.equal(normalizeSecret('"geheim-token"'), "geheim-token");
  assert.equal(normalizeSecret(ch(0x201c) + "curly" + ch(0x201d)), "curly");
  assert.equal(normalizeSecret(ch(0xfeff) + "a" + ch(0x200b) + "b"), "ab", "onzichtbare tekens weg");
  assert.equal(normalizeSecret("\n\n eerste regel \ntweede"), "eerste regel", "eerste niet-lege regel");
  assert.equal(normalizeSecret("x" + ch(0xa0) + "y"), "x y", "harde spatie wordt gewone");
  assert.equal(normalizeSecret("p@ss w0rd"), "p@ss w0rd", "spaties binnenin blijven");
  assert.equal(normalizeSecret("'half\""), "'half\"", "ongelijke aanhalingstekens blijven");
  assert.equal(normalizeSecret(null), "");
  assert.equal(normalizeSecret("x".repeat(MAX_PASTE + 10)).length, MAX_PASTE);
});

test("console op de computer: zelfde vormen als de app, vingerafdruk alleen in de app", async () => {
  const app = await buildConsole();
  const c = client(app);
  let st = (await c("GET", "/api/state")).json;
  for (const k of shapes.state) assert.ok(k in st, `state.${k}`);
  assert.equal(st.vaultMode, null);
  assert.equal(st.vaultPassphrase, false);
  assert.ok(!("device" in st), "geen vingerafdruk op de computer");

  // Kluis achter de vingerafdruk of een gemaakt wachtwoord: alleen in de app.
  for (const route of ["/api/setup/create", "/api/setup/aanbieder", "/api/setup/recover"]) {
    const r = await c("POST", route, { domain: "vanes.test", mailbox: "rene", appPassword: "mijn-cloud-wachtwoord", vault: "device", masterKey: "0".repeat(64), store: {} });
    assert.equal(r.status, shapes.deviceUnavailable.status, route);
    assert.deepEqual(Object.keys(r.json), shapes.deviceUnavailable.keys, route);
    assert.match(r.json.error, /alleen in de app/);
  }
  assert.equal((await c("POST", "/api/unlock/device", {})).json.unavailable, true);
  assert.match((await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", generatePassword: true, passphrase: "vier losse woorden hier" })).json.error, /10 tekens/, "de computer maakt geen onzichtbaar wachtwoord");
  assert.equal(fs.existsSync(process.env.EIGEN_VAULT!), false);

  // Met een wachtwoordzin (zoals altijd op de computer).
  const pw = generatePassword();
  assert.equal((await c("POST", "/api/setup/create", { domain: "vanes.test", mailbox: "rene", appPassword: pw, vault: "passphrase", passphrase: "vier losse woorden hier" })).status, 200);
  st = (await c("GET", "/api/state")).json;
  assert.equal(st.vaultMode, "passphrase");
  assert.ok(shapes.vaultModes.includes(st.vaultMode));
  assert.equal(st.vaultPassphrase, true);
  const conf = (await c("GET", "/api/config")).json;
  assert.deepEqual(Object.keys(conf.appLogin), shapes.appLogin);
  assert.deepEqual(conf.appLogin, { stored: false, generated: false }, "de computer bewaart alleen de hash");
  assert.ok(!fs.readFileSync(process.env.EIGEN_VAULT!, "utf8").includes(pw));
  let r = await c("POST", "/api/app-password/show", {});
  assert.equal(r.status, shapes.appPasswordNotStored.status);
  assert.equal(r.json.error, shapes.appPasswordNotStored.error);
  r = await c("POST", "/api/vault/passphrase", { passphrase: "nog een wachtwoordzin" });
  assert.equal(r.status, shapes.vaultHasPassphrase.status);
  assert.equal(r.json.error, shapes.vaultHasPassphrase.error);
  r = await c("POST", "/api/vault/device", {});
  assert.equal(r.status, 400);
  assert.equal(r.json.unavailable, true);
  await app.close();
});
