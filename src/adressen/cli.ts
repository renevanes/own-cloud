/**
 * Beheer van de adressendienst vanaf de opdrachtregel.
 *   npm run adressen:cli -- namen
 *   npm run adressen:cli -- vrijgeven <naam> [--zeker]
 *   npm run adressen:cli -- aanbieders
 *   npm run adressen:cli -- logboek [<naam>]
 * Gebruikt dezelfde omgevingsvariabelen (en datamap) als de adressendienst zelf.
 */
import { loadAdresConfig } from "./config.js";
import { createAdressen, isFree, releaseName } from "./app.js";
import { getNaam, type NaamRow } from "./db.js";
import { parseFreeName } from "./labels.js";
import { normDienstUrl } from "./sign.js";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) : "-");
const STATUS: Record<string, string> = { bezig: "wordt aangemaakt", actief: "in gebruik", vrijgegeven: "vrijgegeven" };

const [cmd, arg, ...rest] = process.argv.slice(2);
const svc = await createAdressen(loadAdresConfig());
const { ctx } = svc;

try {
  switch (cmd) {
    case "namen": {
      const rows = ctx.db.prepare("SELECT * FROM namen ORDER BY naam").all() as NaamRow[];
      if (!rows.length) console.log("Nog geen namen uitgegeven.");
      for (const r of rows) {
        const extra = r.status === "vrijgegeven"
          ? `vrijgegeven ${when(r.released_at)}${isFree(ctx, r.label) ? ", weer vrij" : `, vrij vanaf ${when((r.released_at ?? 0) + ctx.cfg.quarantineMs)}`}`
          : `${r.dienst ?? "-"}${r.ref ? ` (${r.ref})` : ""}, sinds ${when(r.created_at)}`;
        console.log(`  ${r.naam.padEnd(36)} ${(STATUS[r.status] ?? r.status).padEnd(17)} ${extra}`);
      }
      break;
    }
    case "vrijgeven": {
      const p = parseFreeName(arg, ctx.cfg.zone);
      if (!p || "error" in p) { console.error(`Geef een naam onder ${ctx.cfg.zone} op.`); process.exit(1); }
      const row = getNaam(ctx.db, p.label);
      if (!row || row.status === "vrijgegeven") { console.error(`${p.naam} is niet in gebruik.`); process.exit(1); }
      if (!(rest.includes("--zeker") || arg === "--zeker")) {
        console.log(`Dit zou er gebeuren met ${p.naam} (nu bij ${row.dienst ?? "-"}); voer uit met --zeker:`);
        console.log("  - het token van de aanbieder intrekken");
        console.log(`  - de verwijzing (NS/DS) in ${ctx.cfg.zone} weghalen`);
        console.log(`  - de zone ${p.naam} bij deSEC verwijderen (met alle records van de klant)`);
        console.log("  - de naam is daarna 30 dagen niet opnieuw uit te geven");
        break;
      }
      const r = await releaseName(ctx, null, p.label, "beheer (opdrachtregel)");
      console.log(`${r.naam} is vrijgegeven; weer beschikbaar vanaf ${when(Date.parse(r.vrijVanaf))}.`);
      break;
    }
    case "aanbieders": {
      const map = await ctx.providers.refresh();
      console.log(`Lijst: ${ctx.cfg.listUrl}`);
      if (!map.size) console.log("  (leeg)");
      for (const p of map.values()) {
        const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM namen WHERE dienst = ? AND status != 'vrijgegeven'").get(normDienstUrl(p.url)) as { n: number }).n;
        console.log(`  ${p.naam.padEnd(28)} ${p.url.padEnd(40)} ${p.key ? "sleutel ok" : "GEEN geldige sleutel"}  ${n} naam/namen`);
      }
      break;
    }
    case "logboek": {
      const p = arg ? parseFreeName(arg, ctx.cfg.zone) : null;
      const naam = p && !("error" in p) ? p.naam : null;
      const rows = (naam
        ? ctx.db.prepare("SELECT * FROM logboek WHERE naam = ? ORDER BY id DESC LIMIT 200").all(naam)
        : ctx.db.prepare("SELECT * FROM logboek ORDER BY id DESC LIMIT 50").all()) as { at: number; dienst: string | null; actie: string; naam: string | null; detail: string | null }[];
      if (!rows.length) console.log("Nog niets in het logboek.");
      for (const r of rows) console.log(`  ${when(r.at)}  ${r.actie.padEnd(20)} ${(r.naam ?? "").padEnd(32)} ${r.dienst ?? ""}${r.detail ? `  ${r.detail}` : ""}`);
      break;
    }
    default:
      console.log(`Gebruik: npm run adressen:cli -- <opdracht>

  namen                    alle uitgegeven namen met hun aanbieder
  vrijgeven <naam> [--zeker]  naam intrekken: zone, verwijzing en token weg (30 dagen quarantaine)
  aanbieders               de lijst van aanbieders, met of hun sleutel klopt
  logboek [<naam>]         laatste gebeurtenissen (of die van één naam)`);
  }
} catch (e) {
  console.error(`Mislukt: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await svc.close();
}
