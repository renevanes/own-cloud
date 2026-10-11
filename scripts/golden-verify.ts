/**
 * Controleert met de TypeScript-code wat de Java-kern van de Android-app heeft gemaakt
 * (android/core/build/java-out/*.json, geschreven door CryptoGoldenTest en VaultTest):
 * Java seal → TS open, Java sealMsg → TS openMsg, Java adminProof → TS verifyAdminProof, Java-kluis → Node,
 * en de handtekeningen van Exoscale/OVHcloud uit de Java-adapters → TS exoSign/ovhSign (FormatsGoldenTest).
 * Gebruik: npx tsx scripts/golden-verify.ts [build-map]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deriveKey, open, openJson } from "../src/cluster/crypto.js";
import { openMsg } from "../src/cluster/transport.js";
import { keysFor } from "../src/cluster/config.js";
import { verifyAdminProof } from "../src/cluster/admin.js";
import { exoSign } from "../src/cluster/adapters/exoscale.js";
import { ovhSign } from "../src/cluster/adapters/ovh.js";

const root = path.resolve(import.meta.dirname, "..");
const build = path.resolve(process.argv[2] ?? path.join(root, "android/core/build"));
const out = path.join(build, "java-out");
let failures = 0;
let checks = 0;
function check(ok: boolean, what: string) {
  checks++;
  if (!ok) { failures++; console.log(`  FAIL: ${what}`); }
}
function attempt(what: string, fn: () => boolean) {
  try { check(fn(), what); } catch (e) { check(false, `${what} (${(e as Error).message})`); }
}
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8"));
const b = (s: string) => Buffer.from(s, "base64");

const c = read("crypto.json");
const master = Buffer.from(c.masterKey, "hex");
const keys = keysFor({ masterKey: c.masterKey });

c.seals.forEach((s: { purpose: string; aad: string | null; plain: string; sealed: string }, i: number) =>
  attempt(`TS open van Java seal #${i} (${s.purpose}, aad=${s.aad})`, () => open(deriveKey(master, s.purpose), b(s.sealed), s.aad ?? undefined).equals(b(s.plain))));
attempt("manifest (AAD manifest)", () => isDeepStrictEqual(openJson(keys.manifest!, b(c.manifest.sealed), "manifest"), c.manifest.value));
attempt("admin-config (AAD admin-config)", () => isDeepStrictEqual(openJson(keys.manifest!, b(c.adminConfig.sealed), "admin-config"), c.adminConfig.value));
attempt("bootstrap (sleutel uit join-token)", () => isDeepStrictEqual(openJson(deriveKey(Buffer.from(c.bootstrap.joinToken, "hex"), "bootstrap"), b(c.bootstrap.sealed), "bootstrap"), c.bootstrap.value));
attempt("rpc: TS openMsg van Java sealMsg", () => isDeepStrictEqual(openMsg(keys.cluster, b(c.rpc.sealed)), c.rpc.msg));
attempt("rpc: verkeerde sleutel geweigerd", () => { try { openMsg(deriveKey(master, "anders"), b(c.rpc.sealed)); return false; } catch { return true; } });

c.proofs.forEach((p: { payloadJson: string; proof: { ts: number; mac: string } }, i: number) => {
  const payload = JSON.parse(p.payloadJson);
  check(JSON.stringify(payload) === p.payloadJson, `Java Json.stringify == JSON.stringify (payload #${i})`);
  check(verifyAdminProof(c.masterKey, payload, p.proof), `TS verifyAdminProof van Java-handtekening #${i}`);
  check(!verifyAdminProof(c.masterKey, { ...payload, extra: 1 }, p.proof), `gewijzigde payload geweigerd #${i}`);
});

const v = read("vault.json");
attempt("Java-kluis te openen met Node (PBKDF2-SHA256 + AES-GCM, AAD vault)", () => {
  const f = JSON.parse(fs.readFileSync(path.join(out, v.file), "utf8"));
  if (f.v !== 1 || f.kdf !== "pbkdf2") return false;
  const key = crypto.pbkdf2Sync(v.passphrase.normalize("NFKC"), b(f.salt), f.iter, 32, "sha256");
  return open(key, b(f.data), "vault").toString("utf8") === v.expected;
});

const sigs = read("signatures.json");
for (const e of sigs.exo) attempt(`Exoscale-handtekening van Java = TS exoSign (${e.method} ${e.url})`, () => exoSign(e.method, e.url, e.body, e.key, e.secret, e.expires) === e.header);
for (const o of sigs.ovh) attempt(`OVH-handtekening van Java = TS ovhSign (${o.method} ${o.url})`, () => ovhSign(o.appSecret, o.consumerKey, o.method, o.url, o.body, o.ts) === o.signature);
check(sigs.exo.length === 3 && sigs.ovh.length === 2, "handtekeningen van Java aanwezig");

console.log(`  golden-verify (TS): ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
