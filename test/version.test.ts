// Versiebeheer: één nummer voor app en servers (VERSION), met een wijzigingslog dat de app laat zien.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VERSION, compareVersions } from "../src/version.js";

const file = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8");
const name = /^VERSION_NAME=(\d+\.\d+)$/m.exec(file)?.[1];
const code = Number(/^VERSION_CODE=(\d+)$/m.exec(file)?.[1]);
const log = JSON.parse(fs.readFileSync(new URL("../changelog.json", import.meta.url), "utf8")) as { version: string; date: string; changes: string[] }[];

test("VERSION en wijzigingslog horen bij elkaar", () => {
  assert.ok(name, "VERSION_NAME is X.Y");
  assert.ok(code > 2000100, "versiecode hoger dan die van de eerste builds (2000000 + bouwnummer)");
  assert.equal(log[0].version, name, "het wijzigingslog begint bij de huidige versie (scripts/bump.sh)");
  for (const e of log) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.changes.length > 0 && e.changes.every((c) => typeof c === "string" && c.trim().length > 0), `versie ${e.version} heeft wijzigingen`);
  }
  for (let i = 1; i < log.length; i++) assert.equal(compareVersions(log[i - 1].version, log[i].version), 1, "nieuwste eerst, elk nummer één keer");
});

test("de servers kennen dezelfde versie, en zien hem als nieuwer dan de eerste builds", () => {
  const saved = process.env.EIGEN_VERSION;
  delete process.env.EIGEN_VERSION;
  try { assert.equal(VERSION(), `${name}-dev`); } finally { if (saved !== undefined) process.env.EIGEN_VERSION = saved; }
  assert.equal(compareVersions(name, "1.0.0.15"), 1);
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("2.0", "1.42"), 1);
});
