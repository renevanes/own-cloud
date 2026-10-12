/**
 * Huisstijl en aanbod van de aanbieder, bewaard in de database (met de omgevingsvariabelen en bundles.json
 * als standaard). Bundels uit het beheer vervangen cfg.bundles, zodat de rest van de dienst niets merkt.
 */
import { type Bundle, type CostTable, normalizeBundle } from "./config.js";
import { type Db, getSetting, setSetting } from "./db.js";
import type { Ctx } from "./context.js";

export interface Brand {
  name: string;
  accentColor: string | null;
  contact: { email: string | null; phone: string | null; website: string | null };
  termsUrl: string | null;
  privacyUrl: string | null;
}

type StoredBrand = Partial<Omit<Brand, "contact">> & { contact?: Partial<Brand["contact"]> };

export function getBrand(ctx: Ctx): Brand & { logoUrl: string | null } {
  const s = getSetting<StoredBrand>(ctx.db, "brand") ?? {};
  const logo = ctx.db.prepare("SELECT updated_at FROM files WHERE key = 'logo'").get() as { updated_at: number } | undefined;
  return {
    name: s.name || ctx.cfg.brandName,
    accentColor: s.accentColor ?? null,
    contact: { email: s.contact?.email ?? null, phone: s.contact?.phone ?? null, website: s.contact?.website ?? null },
    // Eigen links (beheer → Huisstijl, of BROKER_TERMS_URL/BROKER_PRIVACY_URL) gaan voor; anders de pagina's die de
    // Dienst zelf host (beheer → Voorwaarden en privacy, zie juridisch.ts), zodra die gepubliceerd zijn.
    termsUrl: s.termsUrl !== undefined ? s.termsUrl : ctx.cfg.termsUrl ?? hostedDoc(ctx, "voorwaarden"),
    privacyUrl: s.privacyUrl !== undefined ? s.privacyUrl : ctx.cfg.privacyUrl ?? hostedDoc(ctx, "privacy"),
    logoUrl: logo ? `${ctx.cfg.publicUrl}/v1/brand/logo?v=${logo.updated_at}` : null,
  };
}

/** De links die in Huisstijl zijn ingevuld (null = niet ingevuld). */
export function ownLinks(ctx: Ctx) {
  const s = getSetting<StoredBrand>(ctx.db, "brand") ?? {};
  return { termsUrl: s.termsUrl ?? null, privacyUrl: s.privacyUrl ?? null };
}

/** Het adres van een gepubliceerd document van de Dienst zelf (bijv. https://dienst.x.nl/voorwaarden), of null. */
export function hostedDoc(ctx: Ctx, kind: "voorwaarden" | "privacy" | "verwerkersovereenkomst"): string | null {
  return ctx.db.prepare("SELECT 1 FROM legal_docs WHERE kind = ? LIMIT 1").get(kind) ? `${ctx.cfg.publicUrl}/${kind}` : null;
}

const URL_RE = /^https?:\/\/[^\s<>"']{3,500}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Wijzigt (een deel van) de huisstijl. Lege tekst = terug naar de standaard (of leeg). Gooit Error met een leesbare melding. */
export function updateBrand(ctx: Ctx, patch: any): Brand {
  const cur = getSetting<StoredBrand>(ctx.db, "brand") ?? {};
  const next: StoredBrand = { ...cur, contact: { ...cur.contact } };
  const str = (v: unknown, max: number) => (v === null ? "" : String(v ?? "").trim().slice(0, max));
  if (patch.name !== undefined) {
    const n = str(patch.name, 80);
    if (n) next.name = n; else delete next.name;
  }
  if (patch.accentColor !== undefined) {
    const c = str(patch.accentColor, 7).toLowerCase();
    if (c && !/^#[0-9a-f]{6}$/.test(c)) throw new Error("Kies de accentkleur als #rrggbb, bijvoorbeeld #3f6f4a");
    next.accentColor = c || null;
  }
  for (const k of ["termsUrl", "privacyUrl"] as const) {
    if (patch[k] === undefined) continue;
    const u = str(patch[k], 500);
    if (u && !URL_RE.test(u)) throw new Error("Een link begint met https://");
    if (u) next[k] = u; else delete next[k];
  }
  const c = patch.contact ?? {};
  if (c.email !== undefined) {
    const e = str(c.email, 254);
    if (e && !EMAIL_RE.test(e)) throw new Error("Het e-mailadres voor contact klopt niet");
    next.contact!.email = e || null;
  }
  if (c.phone !== undefined) {
    const ph = str(c.phone, 40);
    if (ph && !/^[+0-9 ()-]{6,40}$/.test(ph)) throw new Error("Het telefoonnummer klopt niet");
    next.contact!.phone = ph || null;
  }
  if (c.website !== undefined) {
    const w = str(c.website, 500);
    if (w && !URL_RE.test(w)) throw new Error("De website begint met https://");
    next.contact!.website = w || null;
  }
  setSetting(ctx.db, "brand", next);
  return getBrand(ctx);
}

export const LOGO_MAX = 200 * 1024;

/** Controleert en bewaart een logo (PNG of SVG, hooguit 200 KB). */
export function saveLogo(db: Db, type: string, data: Buffer) {
  if (!data.length) throw new Error("Het bestand is leeg");
  if (data.length > LOGO_MAX) throw new Error("Het logo is te groot (hooguit 200 KB)");
  if (type === "image/png") {
    if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("Dit is geen PNG-bestand");
  } else if (type === "image/svg+xml") {
    const text = data.toString("utf8");
    if (!/<svg[\s>]/i.test(text)) throw new Error("Dit is geen SVG-bestand");
    // Geen scripts, gebeurtenissen of externe verwijzingen in een logo.
    if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|xlink:href\s*=\s*["'](?!#)|\shref\s*=\s*["'](?!#)/i.test(text)) throw new Error("Dit SVG-bestand bevat scripts of verwijzingen naar buiten; sla het op als eenvoudige SVG of PNG");
  } else throw new Error("Kies een PNG- of SVG-bestand");
  db.prepare("INSERT INTO files (key, type, data, updated_at) VALUES ('logo', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at")
    .run(type, data, Date.now());
}

export function getLogo(db: Db) {
  return db.prepare("SELECT type, data, updated_at FROM files WHERE key = 'logo'").get() as { type: string; data: Buffer; updated_at: number } | undefined;
}

// ───────── Aanbod (bundels) ─────────

/** Bij het starten: bundels uit het beheer (als die er zijn) gaan voor bundles.json. */
export function loadOfferingFromDb(ctx: Ctx) {
  // Kosten uit het beheer (Kosten → Prijzen die we aannemen) gaan voor bundles.json.
  const costs = getSetting<unknown>(ctx.db, "costs");
  if (costs) { try { ctx.cfg.costs = normalizeCosts(costs, ctx.cfg.costs); } catch (e) { console.error(`[dienst] kosten in de database kloppen niet: ${(e as Error).message}`); } }
  const list = getSetting<any[]>(ctx.db, "bundles");
  if (!Array.isArray(list) || !list.length) return;
  try { ctx.cfg.bundles = list.map((b) => normalizeBundle(b, "aanbod in de database")); }
  catch (e) { console.error(`[dienst] aanbod in de database klopt niet, bundles.json wordt gebruikt: ${(e as Error).message}`); }
}

export function saveOffering(ctx: Ctx, list: Bundle[]) {
  setSetting(ctx.db, "bundles", list);
  ctx.cfg.bundles = list;
}

/** Een bundel toevoegen of vervangen. Bestaande bestellingen houden hun eigen maandbedrag. */
export function putBundle(ctx: Ctx, raw: any): Bundle {
  const b = normalizeBundle(raw, "bundel");
  const list = ctx.cfg.bundles.filter((x) => x.id !== b.id);
  const at = ctx.cfg.bundles.findIndex((x) => x.id === b.id);
  if (at >= 0) list.splice(at, 0, b); else list.push(b);
  saveOffering(ctx, list);
  return b;
}

export function deleteBundle(ctx: Ctx, id: string) {
  const used = ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE bundle = ? AND status NOT IN ('cancelled','failed','awaiting_payment')").get(id) as { n: number };
  if (used.n) throw new Error(`Deze bundel wordt nog door ${used.n} klant${used.n === 1 ? "" : "en"} gebruikt`);
  const list = ctx.cfg.bundles.filter((x) => x.id !== id);
  if (list.length === ctx.cfg.bundles.length) throw new Error("Deze bundel bestaat niet");
  if (!list.length) throw new Error("Er moet minstens één bundel overblijven");
  saveOffering(ctx, list);
}

/** De bundel zoals de app hem ziet. */
export const publicBundle = (b: Bundle) => ({
  id: b.id, title: b.title, description: b.description, monthly: b.monthly, includes: b.includes, extraUserMonthly: b.extraUserMonthly, placement: b.placement,
});

/**
 * Geschatte kosten (excl. btw, per maand) per serverformaat en per GB opslag, uit het beheer. Een formaat met een lege
 * prijs gaat weg (dan geldt de standaard of niets). Bedragen als "4.50" (een komma mag ook).
 */
export function normalizeCosts(raw: any, base: CostTable): CostTable {
  if (!raw || typeof raw !== "object") throw new Error("Geen kosten opgegeven");
  const money = (v: unknown, what: string) => {
    const t = String(v ?? "").trim().replace(",", ".");
    if (!/^\d{1,5}(\.\d{1,4})?$/.test(t)) throw new Error(`${what}: vul een bedrag in zoals 4.50`);
    return t;
  };
  const servers: Record<string, string> = { ...base.servers };
  for (const [k, v] of Object.entries((raw.servers ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(k)) throw new Error(`Ongeldig serverformaat: ${k}`);
    if (v === null || String(v).trim() === "") { delete servers[k]; continue; }
    servers[k] = money(v, k);
  }
  const gb = raw.storageGbMonthly === undefined ? base.storageGbMonthly : money(raw.storageGbMonthly, "Opslag per GB");
  return { servers, storageGbMonthly: gb };
}

export function saveCosts(ctx: Ctx, raw: unknown) {
  const c = normalizeCosts(raw, ctx.cfg.costs);
  setSetting(ctx.db, "costs", c);
  ctx.cfg.costs = c;
  return c;
}
