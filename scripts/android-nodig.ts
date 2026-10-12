/**
 * Hulpdienst voor android/core/test.sh (BenodigdhedenTest) en voor schermafbeeldingen: de nep-aanbieders van
 * test/helpers/fake-nodig.ts (Scaleway, Mollie, deSEC, Openprovider, DoH, de Dienst, SMTP) plus een bedieningsadres.
 * Schrijft {control, base, dienst, env, smtpPort} naar het opgegeven bestand.
 *   POST <control>/reset                     → alles terug naar het begin
 *   POST <control>/mutate {op, …}            → de nep-aanbieders veranderen (zie hieronder)
 *   POST <control>/op-zone {name}            → de records van een zone bij nep-Openprovider
 *   POST <control>/get {path}                → een waarde uit de toestand van de nep-aanbieders ("op.contactPut", …)
 *   POST <control>/ts {fn, config, body?, fresh?} → dezelfde functie in TypeScript (src/console/benodigdheden.ts) met
 *        deze kluisconfiguratie; geeft {status, json, config}. Zo vergelijkt de Java-test zijn antwoorden met die van TS.
 *   POST <control>/klok {now}                → de vaste klok van "Zo gratis mogelijk" (gratis.ts; null = de echte tijd)
 * Ook een nep-S3 (fake-s3.ts) voor de back-ups bij verhuizen: zijn adres staat als `s3` in het bestand.
 */
import fs from "node:fs";
import http from "node:http";
import { fakeNodig } from "../test/helpers/fake-nodig.js";
import { fakeS3 } from "../test/helpers/fake-s3.js";

const out = process.argv[2];
if (!out) { console.error("gebruik: android-nodig.ts <info.json>"); process.exit(2); }
const f = await fakeNodig();
const s3 = fakeS3();
const s3url = `http://127.0.0.1:${await s3.listening}`;
Object.assign(process.env, f.env);
const aan = await import("../src/console/aanbieder.js");
const nodig = await import("../src/console/benodigdheden.js");
const gratis = await import("../src/console/gratis.js");
const { resetOpTokens } = await import("../src/cluster/adapters/openprovider.js");
const { serverOffers, storeOffers, dnsOffers } = await import("../src/console/catalog.js");
aan.aanbiederNet.reach = () => f.dienst;
const deps = { save: () => {}, sleep: async () => {}, serverOffers: () => serverOffers(), storeOffers: () => storeOffers(), dnsOffers: () => dnsOffers() };

/** Een waarde in de toestand van de nep-aanbieders zetten: "mollie.first", "dienst.lijst", … */
function setPath(path: string, value: unknown) {
  const keys = path.split(".");
  let o: any = f.st;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)!] = value;
}

function mutate(b: any) {
  switch (b.op) {
    case "dns": f.st.dns.set(b.name, b.rec); return;
    case "set": setPath(b.path, b.value); return;
    case "scwKey": f.st.scw.keys.push(b.key); return;
    case "scwRules": f.st.scw.policies[0].rules = b.rules; return;
    case "opDomain": f.st.op.domains.push(b.domain); return;
    case "temStatus": f.st.scw.tem[0].status = b.status; return;
    case "desecConfirm": f.st.desec.confirmed = true; return;
    case "upcServer": f.st.upc.servers.push(b.server); return;
    default: throw new Error(`onbekende op ${b.op}`);
  }
}

const FNS: Record<string, (c: any, b: any, fresh: boolean) => Promise<unknown> | unknown> = {
  benodigdheden: (c, _b, fresh) => nodig.benodigdheden(c, fresh),
  scaleway: (c, b) => nodig.scaleway(c, b, deps),
  mollie: (c, b) => nodig.mollie(c, b),
  desecRegister: (c, b) => nodig.desecRegister(c, b),
  desecFinish: (c, b) => nodig.desecFinish(c, b),
  domein: (c, b) => nodig.domein(c, b),
  delegeren: (c, b) => nodig.delegeren(c, b, deps),
  kopen: (c, b) => nodig.kopen(c, b, deps),
  mail: (c, b) => nodig.mail(c, b, deps),
  mailStatus: (c) => nodig.mailStatus(c, deps),
  openprovider: (c, b) => nodig.openprovider(c, b, deps),
  openproviderCheck: (c) => nodig.openproviderCheck(c, deps),
  saveBedrijf: (c, b) => aan.saveBedrijf(c, b),
  saveAdres: (c, b) => aan.saveAdres(c, b),
  saveDns: (c, b) => aan.saveDns(c, b, deps),
  setModus: (c, b) => gratis.setModus(c, b),
  gratisAdres: (c, b) => gratis.gratisAdres(c, b, deps),
  proef: (c, b) => gratis.proef(c, b, deps),
  verhuizen: (c, b) => gratis.verhuizen(c, b, deps),
  view: (c) => aan.view(c, deps),
};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (x) => chunks.push(x));
  req.on("end", async () => {
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    let b: any = {};
    try { b = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { return send(400, { error: "geen JSON" }); }
    try {
      if (req.url === "/reset") { f.reset(); nodig.resetNodigCache(); gratis.resetGratisCache(); resetOpTokens(); return send(200, { ok: true }); }
      if (req.url === "/klok") { const n = b.now; gratis.gratisNet.now = typeof n === "number" ? () => n : () => Date.now(); return send(200, { ok: true }); }
      if (req.url === "/mutate") { mutate(b); return send(200, { ok: true }); }
      if (req.url === "/op-zone") return send(200, { records: f.st.op.zones.get(b.name) ?? null });
      if (req.url === "/get") { let o: any = f.st; for (const k of String(b.path).split(".")) o = o?.[k]; return send(200, { value: o ?? null }); }
      if (req.url === "/ts") {
        const fn = FNS[b.fn];
        if (!fn) return send(404, { error: `onbekende functie ${b.fn}` });
        const c = b.config;
        try { const json = await fn(c, b.body ?? {}, !!b.fresh); return send(200, { status: 200, json, config: c }); }
        catch (e) { return send(200, { status: 400, json: { error: (e as Error).message, ...((e as { steps?: unknown }).steps ? { steps: (e as { steps?: unknown }).steps } : {}) }, config: c }); }
      }
      return send(404, { error: "onbekend" });
    } catch (e) { return send(500, { error: (e as Error).message }); }
  });
});
const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
fs.writeFileSync(out, JSON.stringify({ control: `http://127.0.0.1:${port}`, base: f.base, dienst: f.dienst, env: f.env, smtpPort: f.smtpPort, s3: s3url }));
console.log(`nep-aanbieders voor "Wat je nodig hebt" op ${f.base}, bediening op :${port}`);
process.on("SIGTERM", () => { void Promise.all([f.close(), s3.close()]).finally(() => process.exit(0)); });
