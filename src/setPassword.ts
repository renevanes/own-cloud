import readline from "node:readline/promises";
import { setPassword } from "./auth.js";

const fromArg = process.argv[2];
let pw = fromArg;
if (!pw) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  pw = await rl.question("Nieuw wachtwoord (min. 10 tekens): ");
  rl.close();
}
setPassword(pw!.trim());
console.log("✅ Wachtwoord ingesteld.");
