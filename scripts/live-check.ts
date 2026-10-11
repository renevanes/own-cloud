/**
 * Adapters controleren tegen een ECHT account — voor beheerders van deze code, niet voor gebruikers.
 *
 *   npm run live-check                 # alle aanbieders waarvan de omgevingsvariabelen gezet zijn
 *   npm run live-check -- hetzner ovh  # alleen deze
 *
 * Doet ALLEEN lezende verzoeken (dezelfde "Sleutels controleren" als de console, plus de formaten en prijzen per
 * regio). Er wordt niets aangemaakt, gewijzigd of verwijderd, en geheimen worden nooit afgedrukt.
 *
 * Omgevingsvariabelen (laat weg wat je niet hebt):
 *   HCLOUD_TOKEN                                   Hetzner Cloud (servers en DNS)
 *   SCW_SECRET_KEY, SCW_PROJECT_ID [, SCW_ACCESS_KEY]  Scaleway (met de toegangssleutel ook de rechten via IAM)
 *   UPCLOUD_TOKEN  of  UPCLOUD_USERNAME + UPCLOUD_PASSWORD   UpCloud
 *   EXOSCALE_KEY, EXOSCALE_SECRET                  Exoscale (servers en DNS)
 *   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY [, OVH_PROJECT]   OVHcloud (servers met OVH_PROJECT, en DNS)
 *   DESEC_TOKEN                                    deSEC (DNS)
 *   DOMAIN                                         zone voor de DNS-controles (anders alleen "zones bekijken")
 *   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY [, S3_REGION, S3_BUCKET]   een S3-opslag (elke aanbieder)
 *
 * Exitcode 1 als er een controle met ✗ is (of een formatenlijst niet op te halen is).
 */
import { getAdapter } from "../src/cluster/adapters.js";
import { checkStorage, type KeyCheck } from "../src/cluster/adapters/check.js";

const env = (k: string) => process.env[k]?.trim() || "";
const domain = env("DOMAIN");

/** Per aanbieder: velden uit de omgeving (null = niet ingesteld). */
const accounts: Record<string, () => Record<string, string> | null> = {
  hetzner: () => env("HCLOUD_TOKEN") ? { token: env("HCLOUD_TOKEN") } : null,
  scaleway: () => env("SCW_SECRET_KEY") ? { secretKey: env("SCW_SECRET_KEY"), projectId: env("SCW_PROJECT_ID"), accessKey: env("SCW_ACCESS_KEY") } : null,
  upcloud: () => env("UPCLOUD_TOKEN") ? { token: env("UPCLOUD_TOKEN") } : env("UPCLOUD_USERNAME") ? { username: env("UPCLOUD_USERNAME"), password: env("UPCLOUD_PASSWORD") } : null,
  exoscale: () => env("EXOSCALE_KEY") ? { apiKey: env("EXOSCALE_KEY"), apiSecret: env("EXOSCALE_SECRET") } : null,
  ovh: () => env("OVH_APP_KEY") ? { appKey: env("OVH_APP_KEY"), appSecret: env("OVH_APP_SECRET"), consumerKey: env("OVH_CONSUMER_KEY"), projectId: env("OVH_PROJECT") } : null,
  desec: () => env("DESEC_TOKEN") ? { token: env("DESEC_TOKEN") } : null,
};

let failed = false;
const mark = (ok: boolean | null) => (ok === true ? "✓" : ok === false ? "✗" : "?");
function print(title: string, checks: KeyCheck[]) {
  console.log(`\n${title}`);
  for (const c of checks) {
    console.log(`  ${mark(c.ok)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    if (c.ok === false) failed = true;
  }
}

const only = process.argv.slice(2);
let ran = 0;
for (const [id, read] of Object.entries(accounts)) {
  if (only.length && !only.includes(id)) continue;
  const fields = read();
  if (!fields) { if (only.includes(id)) console.log(`\n${id}: geen omgevingsvariabelen gezet (zie bovenaan scripts/live-check.ts)`); continue; }
  ran++;
  const a = getAdapter(id)!;
  for (const [k, v] of Object.entries(fields)) if (!v) delete fields[k];
  if (a.servers?.check && (id !== "ovh" || fields.projectId)) {
    print(`${a.name} — servers`, await a.servers.check(fields));
    console.log("  Formaten en prijzen per regio:");
    for (const r of a.servers.regions) {
      try {
        const sizes = await a.servers.fetchSizes(fields, r.id);
        const cheap = sizes.slice(0, 3).map((s) => `${s.size} (${s.label}, ${s.monthly == null ? "prijs onbekend" : `€ ${s.monthly.toFixed(2)}`})`).join("; ");
        console.log(`    ${sizes.length ? "✓" : "?"} ${r.label} (${r.id}): ${sizes.length} formaten${cheap ? ` — goedkoopste: ${cheap}` : ""}`);
      } catch (e) {
        failed = true;
        console.log(`    ✗ ${r.label} (${r.id}): ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  if (a.dns?.check) print(`${a.dns.name ?? a.name} — DNS${domain ? ` (${domain})` : ""}`, await a.dns.check(fields, domain));
}
if (only.includes("s3") || (!only.length && env("S3_ENDPOINT"))) {
  if (env("S3_ENDPOINT")) {
    ran++;
    print(`S3-opslag ${env("S3_ENDPOINT")}${env("S3_BUCKET") ? ` (bucket ${env("S3_BUCKET")})` : ""}`, await checkStorage({
      name: "live-check", type: "s3", purpose: "replica", endpoint: env("S3_ENDPOINT"), region: env("S3_REGION") || "us-east-1",
      accessKey: env("S3_ACCESS_KEY"), secretKey: env("S3_SECRET_KEY"), bucket: env("S3_BUCKET") || undefined,
    }));
  } else console.log("\ns3: geen S3_ENDPOINT gezet");
}
if (!ran) {
  console.log("Geen enkele aanbieder ingesteld. Zet bijvoorbeeld HCLOUD_TOKEN of DESEC_TOKEN (zie bovenaan scripts/live-check.ts).");
  process.exit(2);
}
console.log(failed ? "\nEr is iets niet in orde (✗ hierboven)." : "\nAlles wat te controleren valt is in orde (? = de aanbieder laat het niet zien).");
process.exit(failed ? 1 : 0);
