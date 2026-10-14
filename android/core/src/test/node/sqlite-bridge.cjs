// Test helper for the Java core: real SQLite (better-sqlite3) for GmailStore, one JSON request per line on stdin.
//   node sqlite-bridge.cjs <dir with node_modules> [database file]
// Request: {"op":"exec"|"query","sql":"…","args":[…]}  Reply: {"ok":true} | {"rows":[[…],…]} | {"error":"…"}
"use strict";
const Database = require(require.resolve("better-sqlite3", { paths: [process.argv[2] || process.cwd()] }));
const db = new Database(process.argv[3] || ":memory:");
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let out;
  try {
    const r = JSON.parse(line);
    const args = (r.args || []).map((a) => (typeof a === "boolean" ? (a ? 1 : 0) : a));
    if (r.op === "exec") {
      if (!args.length && /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(r.sql)) db.exec(r.sql);
      else db.prepare(r.sql).run(...args);
      out = { ok: true };
    } else {
      out = { rows: db.prepare(r.sql).raw(true).all(...args) };
    }
  } catch (e) {
    out = { error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(out) + "\n");
});
rl.on("close", () => db.close());
