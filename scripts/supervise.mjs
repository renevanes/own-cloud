// Kleine procesbewaker (zoals Docker's restart-policy): herstart de node bij exitcode 75 (herstel nodig) of een crash.
//   node scripts/supervise.mjs src/main.ts
import { spawn } from "node:child_process";

const [entry] = process.argv.slice(2);
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; child?.kill(sig); });

let child;
let restarts = 0;
function run() {
  child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (stopping || signal === "SIGKILL") process.exit(code ?? 0);
    restarts++;
    const delay = code === 75 ? 200 : Math.min(30000, 1000 * restarts);
    console.log(`[supervise] node stopte (code ${code}, signaal ${signal}); herstart over ${delay} ms`);
    setTimeout(run, delay);
  });
}
run();
