// Maakt een DKIM-sleutelpaar en toont het DNS-record dat je moet aanmaken.
//   node scripts/dkim.mjs [selector] [domein]
import crypto from "node:crypto";
import fs from "node:fs";
const selector = process.argv[2] || "eigen";
const domain = process.argv[3] || "example.nl";
fs.mkdirSync("data", { recursive: true });
const file = "data/dkim-private.pem";
if (fs.existsSync(file)) { console.error(`${file} bestaat al — verwijder hem eerst als je echt een nieuwe sleutel wilt.`); process.exit(1); }
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
console.log(`Privésleutel opgeslagen in ${file}\n\nMaak dit TXT-record aan:\n  Naam:   ${selector}._domainkey.${domain}\n  Waarde: v=DKIM1; k=rsa; p=${pub}\n`);
