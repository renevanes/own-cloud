/**
 * Aanbieder worden: je eigen Eigen Cloud Dienst (src/broker) opzetten en bijhouden vanuit de console, zonder terminal.
 * Stappen: bedrijf → accounts (live gecontroleerd) → adres (dienst.<domein>, je cloud publiceert het A-record via
 * zijn eigen DNS-koppeling) → server (aanbieder en regio uit de registry, kleinste geschikte formaat; back-ups bij
 * elke S3-opslag) → opzetten (back-upbucket, server met cloud-init) → klaar (status, opnieuw opzetten, verwijderen).
 * De server en de back-ups mogen bij verschillende aanbieders staan. Bij Scaleway maakt de console een eigen project
 * "eigen-cloud-dienst" en (back-ups bij Scaleway zonder eigen sleutels) een sleutel die alleen opslag in dat project mag.
 * De Scaleway-sleutel bij Accounts blijft nodig: daarmee zet de Dienst de clouds van klanten op (src/broker/provision.ts).
 * De toestand staat in de kluis onder console.aanbieder.
 * Zonder eigen cloud (kluis met console.alleenDienst) koppelt de Dienst zijn eigen DNS-aanbieder (`dns`): de console
 * zet dan zelf de A/AAAA-records via de DNS-adapter, en werkt ze bij als het IP-adres verandert of de Dienst weggaat.
 * Na het opzetten is er één plek voor alles ("Je dienst", `hub` in de view): wat in de kluis staat beheert de console,
 * wat in de database van de Dienst staat opent /beheer op de juiste pagina.
 * De Android-app heeft hetzelfde in Java (android/core Aanbieder.java); de JSON van de routes is gelijk.
 */
import crypto from "node:crypto";
import dnsp from "node:dns/promises";
import zlib from "node:zlib";
import nodemailer from "nodemailer";
import type { AdminConfig } from "./vault.js";
import { DESEC_URL } from "./extras.js";
import { makeProvider, scwApi, type Provider } from "../cluster/providers.js";
import { prepareStore, type StepResult } from "../cluster/admin.js";
import { S3Store, type StoreConfig } from "../cluster/stores.js";
import { dienstUserData } from "../cluster/cloudinit.js";
import { decryptBuffer, deriveKey, randomKeyHex, sealJson } from "../cluster/crypto.js";
import { keysFor } from "../cluster/config.js";
import { getAdapter } from "../cluster/adapters.js";
import { dnsOffers as catalogDnsOffers, fetchSizes, pickSize, type DnsOffer, type ServerOffer, type StoreOffer, type SizeOption } from "./catalog.js";
import { INSTELBAAR } from "../broker/instellingen.js";
import { latestBackup } from "../broker/backup.js";

export const MOLLIE_URL = () => (process.env.EIGEN_MOLLIE_URL ?? "https://api.mollie.com/v2").replace(/\/+$/, "");
export const OPENPROVIDER_URL = () => (process.env.EIGEN_OPENPROVIDER_URL ?? "https://api.openprovider.eu/v1beta").replace(/\/+$/, "");

export const PROJECT_NAME = "eigen-cloud-dienst";
/** Waar een Dienst van vóór de keuze van aanbieder staat (alleen Scaleway kon toen). */
export const SERVER_REGION = "nl-ams-1";
export const SERVER_SIZE = "DEV1-S";
export const BACKUP_REGION = "fr-par";
const STEPS = ["bedrijf", "accounts", "adres", "server", "opzetten", "klaar"] as const;
type Step = (typeof STEPS)[number];

export interface AanbiederState {
  step: Step;
  /** vatPercent (tekst, bijv. "21") en enforce (bewaker zet extra servers uit) alleen als ze zijn ingevuld. */
  company?: { name: string; address: string[]; kvk: string; vat: string; email: string; vatPercent?: string; enforce?: boolean };
  url?: string;
  accounts?: { scalewaySecretKey?: string; scalewayOrgId?: string; mollieKey?: string; desecToken?: string; smtpUrl?: string; openproviderUser?: string; openproviderPass?: string; adresUrl?: string; mailFrom?: string };
  checked?: Record<string, boolean>;
  projectId?: string;
  /** Waar de server van de Dienst komt: een aanbieder met servers uit de registry, regio en (kleinste geschikte) formaat. */
  hosting?: { provider: string; region: string; size: string; monthly: number | null };
  /** Inloggegevens per aanbieder voor de server (niet voor Scaleway: dat is de sleutel bij Accounts). Nooit in een antwoord. */
  keys?: Record<string, Record<string, string>>;
  /**
   * Back-upopslag (S3) bij een opslag-aanbieder uit de registry (`provider`), of "custom". Scaleway zonder eigen
   * sleutels: de console maakt zelf een sleutel die alleen opslag in het project mag (applicationId/policyId).
   */
  backup?: { provider: string; endpoint: string; region: string; country?: string; bucket?: string; accessKey?: string; secretKey?: string; applicationId?: string; policyId?: string };
  server?: { provider: string; region: string; size: string; serverId: string; ipv4?: string; ipv6?: string; createdAt: number; userDataCleared?: boolean } | null;
  /** BROKER_SECRET van de Dienst (64 hex); de back-ups zijn daarmee versleuteld. */
  secret?: string;
  createdAt?: number;
  lastHealth?: Health | null;
  removed?: boolean;
  /** Vervangen servers die nog weg moeten (vroeger alleen een id: dat was altijd Scaleway). */
  retired?: { provider: string; serverId: string }[];
  /** Vorige adressen (subnaam onder het domein) waarvan de cloud het record moet weghalen. */
  dnsRemove?: string[];
  /**
   * Ook de gratis-adressendienst op deze server (voor de beheerders van het project, zie ADRESSEN.md): de gedeelde zone,
   * een deSEC-token voor het account van die zone (mag zones maken en tokens beheren) en zijn eigen hostnaam.
   */
  adressen?: { zone: string; desecToken: string; host: string };
  /** Wanneer de console dienst.env voor de huidige server schreef (BROKER_ENV_AT). */
  envAt?: number;
  /**
   * Wat er op de server staat (sha256): de instellingen die "Toepassen" kan wijzigen, en wat een nieuwe server vraagt.
   * `keys`: per instelling (sha256 van de waarde), zodat de console per onderdeel kan laten zien wat nog niet is toegepast.
   */
  deployed?: { env: string; shape: string; keys?: Record<string, string> };
  /**
   * Eigen DNS-koppeling van de Dienst (zonder eigen cloud, of als je dat liever hebt): aanbieder uit de registry, de zone
   * waar het adres onder valt, inloggegevens (nooit in een antwoord), en de records die de console daar zette (`set`).
   */
  dns?: { provider: string; zone: string; fields: Record<string, string>; set?: DnsRec[]; error?: string; at?: number; nameservers?: string[] };
  /** Bewust gekozen: je zet het record zelf (anders kiest de console standaard een DNS-aanbieder). */
  dnsHandmatig?: boolean;
  /** Laatste hersteltest: de nieuwste back-up ophalen, ontsleutelen en de database controleren. */
  hersteltest?: { at: number; ok: boolean; backupAt: number | null; detail: string };
}
export interface DnsRec { sub: string; type: "A" | "AAAA"; value: string }
export interface Health { at: number; reachable: boolean; version: string | null; uptime: number | null; lastBackupAt: number | null; backup: string | null; closing: boolean; error?: string }

/** Te vervangen in tests: hoe de console de Dienst bereikt en DNS opzoekt. */
export const aanbiederNet = {
  reach: (url: string) => url,
  resolve4: (host: string) => { const r = new dnsp.Resolver({ timeout: 3000, tries: 1 }); return r.resolve4(host); },
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mask = (v?: string) => (v ? "•".repeat(8) + v.slice(-4) : "");
const fail = (msg: string, steps?: StepResult[]) => Object.assign(new Error(msg), { steps });

/**
 * Oudere kluizen (alleen Scaleway) bijwerken naar de vorm van nu: server en back-up krijgen hun aanbieder, vervangen
 * servers worden {provider, serverId}, en een Dienst die er is (of was) krijgt de plek waar hij stond.
 */
export function migrate(a: AanbiederState): AanbiederState {
  const x = a as AanbiederState & { retired?: (string | { provider: string; serverId: string })[] };
  if (x.retired) x.retired = x.retired.map((r) => (typeof r === "string" ? { provider: "scaleway", serverId: r } : r));
  if (a.server && !a.server.provider) (a.server as { provider: string }).provider = "scaleway";
  if (a.backup && !a.backup.provider) a.backup = { ...a.backup, provider: "scaleway", country: a.backup.country ?? "FR" };
  if (!a.hosting && (a.server || a.removed || a.backup?.bucket)) {
    a.hosting = { provider: a.server?.provider ?? "scaleway", region: a.server?.region ?? SERVER_REGION, size: a.server?.size ?? SERVER_SIZE, monthly: null };
  }
  if (a.step === "opzetten" && (!a.hosting || !a.backup)) a.step = "server";
  return a;
}

function state(c: AdminConfig): AanbiederState {
  const con = c.console as AdminConfig["console"] & { aanbieder?: AanbiederState };
  return migrate((con.aanbieder ??= { step: "bedrijf" }));
}
const existing = (c: AdminConfig) => {
  const a = (c.console as { aanbieder?: AanbiederState }).aanbieder;
  return a ? migrate(a) : null;
};

/** De mailserver van de Dienst: zelf ingevuld, anders de relay van je eigen cloud. */
const smtpOf = (c: AdminConfig, a: AanbiederState) => a.accounts?.smtpUrl || c.console.mailRelay || "";
const mailFromOf = (c: AdminConfig, a: AanbiederState) => a.accounts?.mailFrom || `noreply@${c.domain ?? defaultZone(hostOf(a.url)) ?? "localhost"}`;

/** "smtp://gebruiker@host:587", zonder wachtwoord. */
export function smtpDisplay(url: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? decodeURIComponent(u.username) + "@" : ""}${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch { return null; }
}

function hostOf(url?: string) {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}

/** De subnaam van `host` onder het domein van je cloud (bijv. "dienst"), of null. */
function cloudSub(c: AdminConfig, host: string | null | undefined) {
  const d = c.domain ?? "";
  return host && d && host.endsWith(`.${d}`) ? host.slice(0, -(d.length + 1)) : null;
}
/** Kan je cloud records publiceren (draaiende cloud met een DNS-koppeling)? */
const cloudDns = (c: AdminConfig) => c.dns.length > 0 && !!c.console.done && !!c.domain;

/**
 * Wie het record voor `host` zet: "eigen" (de console, via de eigen DNS-koppeling van de Dienst), "cloud" (je cloud,
 * via extra_dns) of "handmatig" (jij zelf). Met de aanbieder en de zone.
 */
function dnsFor(c: AdminConfig, a: AanbiederState | null, host: string | null) {
  const value = a?.server?.ipv4 ?? null;
  if (a?.dns) {
    const z = a.dns.zone;
    const sub = host ? (host === z ? "" : host.endsWith(`.${z}`) ? host.slice(0, -(z.length + 1)) : null) : null;
    return { host, sub, managed: sub !== null, value, mode: "eigen", provider: a.dns.provider, zone: z };
  }
  const sub = cloudSub(c, host);
  const managed = !!sub && cloudDns(c);
  return { host, sub, managed, value, mode: managed ? "cloud" : "handmatig", provider: managed ? c.console.dnsMode ?? c.dns[0]?.type ?? null : null, zone: managed ? c.domain ?? null : null };
}

/** Waar het adres van de Dienst naartoe wijst en wie dat record zet (je cloud, de console of jijzelf). */
export function dnsInfo(c: AdminConfig) {
  const a = existing(c);
  return dnsFor(c, a, hostOf(a?.url));
}

/** Zelfde voor de hostnaam van de adressendienst (als die op deze server draait). */
export function adressenDns(c: AdminConfig) {
  const a = existing(c);
  return dnsFor(c, a, a?.adressen?.host ?? null);
}

const accountsReady = (a: AanbiederState) => ["scaleway", "mollie", "desec", "smtp"].every((k) => a.checked?.[k] === true) && a.checked?.adres !== false;
const companyReady = (a: AanbiederState) => !!(a.company?.name && a.company.email);
const serverReady = (a: AanbiederState) => !!(a.hosting && a.backup);

/** Aanbieders en opslag uit de registry (de console geeft ze mee; in tests met een nep-S3). */
export interface Offers {
  serverOffers: () => ServerOffer[];
  storeOffers: () => StoreOffer[];
  /** DNS-aanbieders (standaard die uit de registry). */
  dnsOffers?: () => DnsOffer[];
}

/** De server: aanbieder, regio (met stad en land) en formaat, zoals de console hem laat zien. */
function hostingView(a: AanbiederState, o: Offers) {
  const h = a.hosting;
  if (!h) return null;
  const offer = o.serverOffers().find((x) => x.id === h.provider);
  const r = offer?.regions.find((x) => x.id === h.region);
  return { provider: h.provider, name: offer?.name ?? h.provider, region: h.region, regionLabel: r?.label ?? h.region, city: r?.city ?? h.region, country: r?.country ?? null, size: h.size, monthly: h.monthly ?? null };
}

/** De back-upplek: aanbieder, regio en (zodra er back-ups zijn) de bucket; die plek ligt dan vast. */
function backupView(a: AanbiederState, o: Offers) {
  const b = a.backup;
  if (!b) return null;
  const offer = o.storeOffers().find((x) => x.id === b.provider);
  const r = offer?.regions.find((x) => x.id === b.region) ?? offer?.regions.find((x) => !!x.endpoint && x.endpoint === b.endpoint);
  return { provider: b.provider, name: offer?.name ?? b.provider, region: b.region, regionLabel: r?.label ?? hostOf(b.endpoint) ?? b.region, country: b.country || r?.country || null, bucket: b.bucket ?? null, auto: b.provider === "scaleway" && (!b.accessKey || !!b.applicationId) };
}

/** Wat de console mag laten zien: geen geheimen, alleen de laatste 4 tekens. */
export function view(c: AdminConfig, o: Offers) {
  const a = existing(c);
  const defaultUrl = c.domain ? `https://dienst.${c.domain}` : null;
  if (!a) return { started: false, step: null, defaultUrl, defaultEmail: c.console.alertEmail || null };
  const acc = a.accounts ?? {};
  const smtp = smtpOf(c, a);
  return {
    started: true,
    step: a.step,
    defaultUrl,
    defaultEmail: c.console.alertEmail || null,
    company: a.company ?? null,
    url: a.url ?? null,
    accounts: {
      scalewayOrgId: acc.scalewayOrgId ?? "", scalewaySecretKey: mask(acc.scalewaySecretKey),
      mollieKey: mask(acc.mollieKey), mollieMode: acc.mollieKey ? (acc.mollieKey.startsWith("live_") ? "live" : "test") : null,
      desecToken: mask(acc.desecToken),
      smtp: smtpDisplay(smtp), smtpFromCloud: !acc.smtpUrl && !!c.console.mailRelay,
      openproviderUser: acc.openproviderUser ?? "", openproviderPass: mask(acc.openproviderPass),
      adresUrl: acc.adresUrl ?? "", mailFrom: mailFromOf(c, a),
    },
    checked: a.checked ?? {},
    ready: { bedrijf: companyReady(a), accounts: accountsReady(a), adres: !!a.url, server: serverReady(a) },
    hosting: hostingView(a, o),
    /** Aanbieders waarvoor de Dienst eigen inloggegevens heeft (Scaleway: altijd, via Accounts). */
    hostingKeys: ["scaleway", ...Object.keys(a.keys ?? {}).filter((k) => k !== "scaleway")],
    server: a.server ? { provider: a.server.provider, region: a.server.region, size: a.server.size, serverId: a.server.serverId, ipv4: a.server.ipv4 ?? null, ipv6: a.server.ipv6 ?? null, createdAt: a.server.createdAt } : null,
    backup: backupView(a, o),
    dns: dnsInfo(c),
    createdAt: a.createdAt ?? null,
    lastHealth: a.lastHealth ?? null,
    removed: !!a.removed,
    retired: (a.retired ?? []).length,
    beheerUrl: a.url ? `${a.url}/beheer` : null,
    adressen: a.adressen ? { zone: a.adressen.zone, desecToken: mask(a.adressen.desecToken), host: a.adressen.host, url: `https://${a.adressen.host}` } : null,
    defaultAdressenHost: defaultAdressenHost(c, a),
    wijzigingen: wijzigingen(c, a),
    /** Zonder eigen cloud opgezet (kluis alleen voor de Dienst), en of je cloud records kan publiceren. */
    alleenDienst: !!c.console.alleenDienst,
    cloudDns: cloudDns(c),
    /** De eigen DNS-koppeling van de Dienst: aanbieder, zone, welke velden bewaard zijn (nooit de waarden) en de records. */
    dnsLink: a.dns ? { provider: a.dns.provider, zone: a.dns.zone, fields: Object.keys(a.dns.fields), records: a.dns.set ?? [], error: a.dns.error ?? null, at: a.dns.at ?? null, nameservers: a.dns.nameservers ?? [] } : null,
    /** Wat er bij "Wie zet het adres in de DNS?" gekozen is: een DNS-aanbieder, "cloud", "handmatig", of null (nog niets). */
    dnsKeuze: a.dns?.provider ?? (a.dnsHandmatig ? "handmatig" : dnsInfo(c).mode === "cloud" ? "cloud" : null),
    defaultZone: defaultZone(hostOf(a.url)),
    hersteltest: a.hersteltest ?? null,
    pending: pendingSections(c, a),
    hub: hubOf(c, a),
  };
}

/** Het beheer van de Dienst op een bepaalde pagina, bijv. https://dienst.vanes.nl/beheer#/klanten. */
export const beheerLink = (url: string, page: string) => `${url}/beheer#/${page}`;

/** Standaardzone voor de eigen DNS-koppeling: dienst.vanes.nl → vanes.nl (twee labels blijven zoals ze zijn). */
export function defaultZone(host: string | null) {
  if (!host) return null;
  const parts = host.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : host;
}

/**
 * De onderdelen van "Je dienst", in vaste volgorde: id, naam, waar de gegevens staan ("console" = in je kluis, "dienst" =
 * in de database van de Dienst, "beide") en de pagina van /beheer (of null).
 */
export const HUB: [string, string, "console" | "dienst" | "beide", string | null][] = [
  ["overzicht", "Overzicht", "console", null],
  ["bedrijf", "Bedrijf", "console", null],
  ["accounts", "Accounts en sleutels", "console", null],
  ["aanbod", "Aanbod en prijzen", "dienst", "aanbod"],
  ["huisstijl", "Huisstijl", "dienst", "huisstijl"],
  ["medewerkers", "Medewerkers", "dienst", "medewerkers"],
  ["klanten", "Klanten", "dienst", "klanten"],
  ["hulpvragen", "Hulpvragen", "dienst", "hulpvragen"],
  ["berichten", "Berichten", "dienst", "berichten"],
  ["adressendienst", "Adressendienst", "beide", "adressen"],
  ["lijst", "Op de lijst", "dienst", "lijst"],
  ["server", "Server en back-ups", "console", null],
  ["kosten", "Kosten", "beide", "kosten"],
  ["updates", "Updates", "console", null],
];

/** Bij welk onderdeel een instelling van de Dienst hoort (voor "nog niet toegepast"). */
const SECTION_OF: Record<string, string> = {
  BROKER_OWNER_EMAIL: "bedrijf", BROKER_ADMIN_EMAIL: "bedrijf", BROKER_BRAND_NAME: "bedrijf", BROKER_COMPANY_NAME: "bedrijf",
  BROKER_COMPANY_ADDRESS: "bedrijf", BROKER_COMPANY_KVK: "bedrijf", BROKER_COMPANY_VAT: "bedrijf", BROKER_VAT_PERCENT: "bedrijf", BROKER_ENFORCE: "bedrijf",
  BROKER_ADRES_PUBLIEK: "adressendienst",
};

/** Sha256 per instelling (zoals in deployed.keys). */
const envKeys = (c: AdminConfig, a: AanbiederState) => Object.fromEntries(instelbaarEnv(c, a).map(([k, v]) => [k, sha(v)]));

/** Onderdelen met wijzigingen die nog niet op de Dienst staan (in de volgorde van HUB). */
export function pendingSections(c: AdminConfig, a: AanbiederState): string[] {
  const w = wijzigingen(c, a);
  if (!w || w === "geen") return [];
  const out = new Set<string>();
  if (w === "opnieuw") out.add("server");
  const keys = a.deployed?.keys;
  if (keys) {
    const now = envKeys(c, a);
    for (const k of new Set([...Object.keys(keys), ...Object.keys(now)])) if (keys[k] !== now[k]) out.add(SECTION_OF[k] ?? "accounts");
  }
  return HUB.map(([id]) => id).filter((id) => out.has(id));
}

/** "Je dienst": de onderdelen met een link naar /beheer en of er iets wacht. Alleen als de Dienst er is (of was). */
function hubOf(c: AdminConfig, a: AanbiederState) {
  if (!a.url || (!a.server && !a.removed)) return null;
  const pend = pendingSections(c, a);
  return HUB.map(([id, label, waar, page]) => ({
    id, label, waar,
    link: page && a.server && !(id === "adressendienst" && !a.adressen) ? beheerLink(a.url!, page) : null,
    pending: pend.includes(id),
  }));
}

/** Standaardhost van de adressendienst: dienst.x.nl → adressen.x.nl, anders adressen.<domein van je cloud>. */
export function defaultAdressenHost(c: AdminConfig, a: AanbiederState) {
  const host = hostOf(a.url);
  if (host?.startsWith("dienst.")) return `adressen.${host.slice("dienst.".length)}`;
  return c.domain ? `adressen.${c.domain}` : null;
}

const sha = (x: unknown) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
/** De instellingen die zonder nieuwe server kunnen wijzigen (zie INSTELBAAR in src/broker/instellingen.ts). */
export const instelbaarEnv = (c: AdminConfig, a: AanbiederState) => dienstEnv(c, a).filter(([k]) => (INSTELBAAR as readonly string[]).includes(k));
/** Wat bij de server hoort: adres, plek, back-upbucket en de adressendienst. Anders: opnieuw opzetten. */
const shapeOf = (a: AanbiederState) => [a.url ?? "", a.hosting?.provider ?? "", a.hosting?.region ?? "", a.hosting?.size ?? "", a.backup?.bucket ?? "", a.adressen?.host ?? "", a.adressen?.zone ?? "", a.adressen?.desecToken ?? ""];

/** Wat er nu op een (nieuwe) server zou staan, als sha256 (zoals in `deployed`). */
export const deployedHashes = (c: AdminConfig, a: AanbiederState) => ({ env: sha(instelbaarEnv(c, a)), shape: sha(shapeOf(a)), keys: envKeys(c, a) });

/** "geen", "toepassen" (kan zonder nieuwe server) of "opnieuw" (nieuwe server nodig); null = onbekend of geen server. */
export function wijzigingen(c: AdminConfig, a: AanbiederState): "geen" | "toepassen" | "opnieuw" | null {
  if (!a.server || !a.deployed) return null;
  if (sha(shapeOf(a)) !== a.deployed.shape) return "opnieuw";
  return sha(instelbaarEnv(c, a)) !== a.deployed.env ? "toepassen" : "geen";
}

/** Vorige/Volgende in de stappen. */
export function setStep(c: AdminConfig, step: string) {
  if (step === "uit") {
    // Stoppen met de stappen: alles vergeten, zolang er geen Dienst draait (of draaide).
    const cur = existing(c);
    if (cur?.server || cur?.removed) throw new Error("Je Dienst bestaat al; verwijderen kan bij Je dienst");
    delete (c.console as { aanbieder?: AanbiederState }).aanbieder;
    return { ok: true, step: null };
  }
  if (!STEPS.includes(step as Step)) throw new Error("Onbekende stap");
  const a = state(c);
  if (step === "klaar" && !a.server && !a.removed) throw new Error("Zet de Dienst eerst op");
  a.step = step as Step;
  return { ok: true, step: a.step };
}

// ───────── 1. Bedrijf ─────────

export function saveBedrijf(c: AdminConfig, b: { name?: string; address?: string | string[]; kvk?: string; vat?: string; email?: string; vatPercent?: string | number; enforce?: boolean | string }) {
  const name = String(b.name ?? "").trim();
  if (name.length < 2 || name.length > 100 || /[\r\n]/.test(name)) throw new Error("Vul de naam van je bedrijf in");
  const raw = Array.isArray(b.address) ? b.address.map(String) : String(b.address ?? "").split(/\r?\n/);
  const address = raw.map((l) => l.trim()).filter(Boolean);
  if (address.length > 5 || address.some((l) => l.length > 100)) throw new Error("Het adres mag hooguit 5 regels hebben");
  const kvk = String(b.kvk ?? "").replace(/\s/g, "");
  if (kvk && !/^\d{8}$/.test(kvk)) throw new Error("Een KvK-nummer heeft 8 cijfers");
  const vat = String(b.vat ?? "").replace(/[\s.]/g, "").toUpperCase();
  if (vat && !/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(vat)) throw new Error("Vul het btw-nummer in zoals NL001234567B01");
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Vul het e-mailadres van de eigenaar in");
  const pct = String(b.vatPercent ?? "").trim().replace(",", ".").replace(/%$/, "").trim();
  if (pct && (!/^\d{1,3}(\.\d{1,2})?$/.test(pct) || Number(pct) > 100)) throw new Error("Vul het btw-percentage in als getal, bijvoorbeeld 21");
  const vatPercent = pct ? String(Number(pct)) : "";
  const enforce = b.enforce === true || b.enforce === "1" || b.enforce === "true" || b.enforce === "on";
  const a = state(c);
  a.company = { name, address, kvk, vat, email, ...(vatPercent ? { vatPercent } : {}), ...(enforce ? { enforce: true } : {}) };
  if (a.step === "bedrijf") a.step = "accounts";
  return { ok: true, step: a.step };
}

// ───────── 2. Accounts ─────────

type Check = { id: string; label: string; ok: boolean; detail: string };
const ACCOUNT_FIELDS = ["scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "smtpUrl", "openproviderUser", "openproviderPass", "adresUrl", "mailFrom"] as const;

async function http(url: string, init: RequestInit = {}, ms = 15_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const t = await r.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { /* geen JSON */ }
  return { status: r.status, ok: r.ok, json: j };
}

async function checkScaleway(key: string, org: string): Promise<Check> {
  const c = { id: "scaleway", label: "Scaleway" };
  if (!UUID.test(key) || !UUID.test(org)) return { ...c, ok: false, detail: "Vul de geheime sleutel en het organisatie-ID in (allebei 8-4-4-4-12 tekens)" };
  try {
    const r = await http(`${scwApi()}/account/v3/projects?organization_id=${encodeURIComponent(org)}&page_size=1`, { headers: { "x-auth-token": key } });
    if (r.status === 401) return { ...c, ok: false, detail: "Scaleway accepteert deze sleutel niet" };
    if (r.status === 403) return { ...c, ok: false, detail: "Deze sleutel mag geen projecten beheren. Geef hem de rechten uit de uitleg (ProjectManager, IAMManager, InstancesFullAccess, ObjectStorageFullAccess)" };
    if (!r.ok) return { ...c, ok: false, detail: `Scaleway antwoordt ${r.status}` };
    return { ...c, ok: true, detail: "Sleutel werkt voor je organisatie" };
  } catch { return { ...c, ok: false, detail: "Scaleway is niet bereikbaar" }; }
}

async function checkMollie(key: string): Promise<Check> {
  const c = { id: "mollie", label: "Mollie" };
  if (!/^(test|live)_[A-Za-z0-9]+$/.test(key)) return { ...c, ok: false, detail: "Een Mollie-sleutel begint met test_ of live_" };
  try {
    const r = await http(`${MOLLIE_URL()}/methods`, { headers: { authorization: `Bearer ${key}` } });
    if (r.status === 401 || r.status === 403) return { ...c, ok: false, detail: "Mollie accepteert deze sleutel niet" };
    if (!r.ok) return { ...c, ok: false, detail: `Mollie antwoordt ${r.status}` };
    return { ...c, ok: true, detail: key.startsWith("test_") ? "Testsleutel: betalingen zijn nep. Zet er later een live_-sleutel in." : "Live: echte betalingen" };
  } catch { return { ...c, ok: false, detail: "Mollie is niet bereikbaar" }; }
}

async function checkDesec(token: string): Promise<Check> {
  const c = { id: "desec", label: "deSEC" };
  if (!token) return { ...c, ok: false, detail: "Vul je deSEC-token in" };
  try {
    const r = await http(`${DESEC_URL()}/domains/`, { headers: { authorization: `Token ${token}` } });
    if (r.status === 401 || r.status === 403) return { ...c, ok: false, detail: "deSEC accepteert dit token niet" };
    if (!r.ok) return { ...c, ok: false, detail: `deSEC antwoordt ${r.status}` };
    return { ...c, ok: true, detail: "Token werkt" };
  } catch { return { ...c, ok: false, detail: "deSEC is niet bereikbaar" }; }
}

async function checkSmtp(url: string): Promise<Check> {
  const c = { id: "smtp", label: "Mail versturen" };
  if (!url) return { ...c, ok: false, detail: "Vul een mailserver in, bijv. smtp://gebruiker:wachtwoord@smtp.tem.scaleway.com:587" };
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error();
    host = u.hostname;
  } catch { return { ...c, ok: false, detail: "Dat is geen geldig adres; het begint met smtp:// of smtps://" }; }
  try {
    await nodemailer.createTransport(url, { connectionTimeout: 10_000 } as never).verify();
    return { ...c, ok: true, detail: `Mail versturen werkt (via ${host})` };
  } catch (e) { return { ...c, ok: false, detail: `Verbinden met ${host} lukt niet: ${(e as Error).message}` }; }
}

async function checkOpenprovider(user: string, pass: string): Promise<Check> {
  const c = { id: "openprovider", label: "Openprovider (optioneel)" };
  if (!user || !pass) return { ...c, ok: false, detail: "Vul gebruikersnaam én wachtwoord in" };
  try {
    const r = await http(`${OPENPROVIDER_URL()}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: pass, ip: "0.0.0.0" }) });
    if (r.ok && r.json?.data?.token) return { ...c, ok: true, detail: "Inloggen werkt: klanten kunnen een domein kopen" };
    return { ...c, ok: false, detail: "Openprovider laat deze gebruiker niet inloggen (vanaf dit apparaat). Controleer ook de IP-lijst; de Dienst kan dit later nog eens proberen." };
  } catch { return { ...c, ok: false, detail: "Openprovider is niet bereikbaar" }; }
}

function checkAdres(url: string): Check {
  const c = { id: "adres", label: "Gratis adressen (optioneel)" };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.search) throw new Error();
    return { ...c, ok: true, detail: `Gratis adressen via ${u.hostname}` };
  } catch { return { ...c, ok: false, detail: "Het adres van de adressendienst begint met https://" }; }
}

/**
 * Sleutels bewaren en live controleren. Een gemaskeerde waarde ("••••…") laat de bewaarde staan, een lege waarde wist
 * hem. Openprovider is optioneel en houdt de volgende stap niet tegen (het IP-adres van de server moet daar op de lijst).
 */
export async function saveAccounts(c: AdminConfig, b: Record<string, unknown>) {
  const a = state(c);
  const acc = { ...(a.accounts ?? {}) } as Record<string, string | undefined>;
  for (const f of ACCOUNT_FIELDS) {
    if (!(f in b) || b[f] === undefined || b[f] === null) continue;
    let v = String(b[f]).trim();
    if (v.startsWith("••")) continue;
    if (f === "scalewaySecretKey" || f === "scalewayOrgId") v = v.replace(/^["']|["']$/g, "").toLowerCase();
    if (/[\r\n]/.test(v)) throw new Error("Een sleutel past op één regel");
    if (v) acc[f] = v; else delete acc[f];
  }
  if (acc.mailFrom && !EMAIL.test(acc.mailFrom)) throw new Error("Het afzenderadres is geen geldig e-mailadres");
  a.accounts = acc;
  const checks: Check[] = await Promise.all([
    checkScaleway(acc.scalewaySecretKey ?? "", acc.scalewayOrgId ?? ""),
    checkMollie(acc.mollieKey ?? ""),
    checkDesec(acc.desecToken ?? ""),
    checkSmtp(smtpOf(c, a)),
  ]);
  if (acc.openproviderUser || acc.openproviderPass) checks.push(await checkOpenprovider(acc.openproviderUser ?? "", acc.openproviderPass ?? ""));
  if (acc.adresUrl) checks.push(checkAdres(acc.adresUrl));
  a.checked = Object.fromEntries(checks.map((x) => [x.id, x.ok]));
  const ready = accountsReady(a);
  if (ready && a.step === "accounts") a.step = "adres";
  return { ok: ready, checks, step: a.step };
}

// ───────── 3. Adres ─────────

export function cleanUrl(raw: string) {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z]+:\/\//.test(v)) v = `https://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error("Dat is geen geldig adres"); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port || (u.pathname !== "/" && u.pathname !== "")) throw new Error("Vul alleen een adres in, zoals https://dienst.vanes.nl");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname)) throw new Error("Vul een adres in met een domeinnaam, zoals dienst.vanes.nl");
  return `https://${u.hostname}`;
}

export function saveAdres(c: AdminConfig, b: { url?: string }) {
  const a = state(c);
  const def = c.domain ? `https://dienst.${c.domain}` : "";
  const url = cleanUrl(b.url || def);
  if (a.url && a.url !== url && a.server && !a.dns) {
    // Het oude adres weghalen uit de DNS van je cloud (alleen als de cloud het beheerde). Met een eigen DNS-koppeling
    // haalt de console het oude record zelf weg bij (opnieuw) opzetten.
    const old = cloudSub(c, hostOf(a.url));
    if (old) a.dnsRemove = [...new Set([...(a.dnsRemove ?? []), old])];
  }
  a.url = url;
  a.dnsRemove = (a.dnsRemove ?? []).filter((x) => x !== cloudSub(c, hostOf(a.url)));
  if (!a.dnsRemove.length) delete a.dnsRemove;
  if (a.step === "adres") a.step = "server";
  return { ok: true, url, step: a.step, dns: dnsInfo(c), pending: !!a.server };
}

// ───────── 3b. Gratis-adressendienst (optioneel, voor de beheerders van het project) ─────────

const ZONE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * De gratis-adressendienst op dezelfde server als de Dienst: `aan: false` haalt hem weg; anders de gedeelde zone, een
 * deSEC-token voor het account van die zone en de hostnaam (standaard adressen.<domein>). Live gecontroleerd: de zone
 * staat in dit deSEC-account en het token mag tokens beheren (zie ADRESSEN.md). Gaat in bij (opnieuw) opzetten.
 */
export async function saveAdressen(c: AdminConfig, b: { aan?: boolean; zone?: string; desecToken?: string; host?: string }) {
  const a = state(c);
  const oldSub = a.server && !a.dns ? cloudSub(c, a.adressen?.host) : null;
  if (b.aan === false) {
    if (oldSub) a.dnsRemove = [...new Set([...(a.dnsRemove ?? []), oldSub])];
    delete a.adressen;
    return { ok: true, checks: [] as Check[], adressen: null, pending: !!a.server };
  }
  const zone = String(b.zone ?? a.adressen?.zone ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!ZONE.test(zone)) throw new Error("Vul de gedeelde zone in, zoals eigencloud.nl");
  let token = String(b.desecToken ?? "").trim();
  if (!token || token.startsWith("••")) token = a.adressen?.desecToken ?? "";
  if (!token) throw new Error("Vul het deSEC-token voor deze zone in");
  if (/[\r\n\s]/.test(token)) throw new Error("Een token past op één regel, zonder spaties");
  const rawHost = String(b.host ?? "").trim() || a.adressen?.host || defaultAdressenHost(c, a) || "";
  let host: string;
  try { host = new URL(cleanUrl(rawHost)).hostname; } catch { throw new Error("Vul een hostnaam in, zoals adressen.vanes.nl"); }
  if (host === hostOf(a.url)) throw new Error("De adressendienst heeft een eigen hostnaam nodig, anders dan die van je Dienst");
  const checks: Check[] = [];
  const h = { authorization: `Token ${token}` };
  try {
    const z = await http(`${DESEC_URL()}/domains/${encodeURIComponent(zone)}/`, { headers: h });
    checks.push(z.ok ? { id: "zone", label: "Gedeelde zone", ok: true, detail: `${zone} staat in dit deSEC-account` }
      : z.status === 401 ? { id: "zone", label: "Gedeelde zone", ok: false, detail: "deSEC accepteert dit token niet" }
      : z.status === 404 ? { id: "zone", label: "Gedeelde zone", ok: false, detail: `${zone} staat niet in het deSEC-account van dit token. Maak de zone daar eerst aan.` }
      : { id: "zone", label: "Gedeelde zone", ok: false, detail: `deSEC antwoordt ${z.status}` });
    const t = await http(`${DESEC_URL()}/auth/tokens/`, { headers: h });
    checks.push(t.ok ? { id: "tokens", label: "Token mag tokens beheren", ok: true, detail: "Nodig om per adres een token te maken dat alleen in die zone mag schrijven" }
      : t.status === 403 ? { id: "tokens", label: "Token mag tokens beheren", ok: false, detail: "Dit token mag geen tokens beheren. Maak bij deSEC een token met 'Manage tokens' (perm_manage_tokens)." }
      : { id: "tokens", label: "Token mag tokens beheren", ok: false, detail: `deSEC antwoordt ${t.status}` });
  } catch { checks.push({ id: "zone", label: "Gedeelde zone", ok: false, detail: "deSEC is niet bereikbaar" }); }
  const ok = checks.length === 2 && checks.every((x) => x.ok);
  if (ok) {
    a.adressen = { zone, desecToken: token, host };
    if (oldSub && oldSub !== cloudSub(c, host)) a.dnsRemove = [...new Set([...(a.dnsRemove ?? []), oldSub])];
    a.dnsRemove = (a.dnsRemove ?? []).filter((x) => x !== cloudSub(c, host) && x !== cloudSub(c, hostOf(a.url)));
    if (!a.dnsRemove.length) delete a.dnsRemove;
  }
  const x = a.adressen;
  return { ok, checks, adressen: x ? { zone: x.zone, desecToken: mask(x.desecToken), host: x.host, url: `https://${x.host}` } : null, dns: adressenDns(c), pending: !!a.server };
}

// ───────── 4. Server en back-ups ─────────

/**
 * Waar de server van de Dienst komt. Zonder `region`: inloggen controleren (alleen lezen) en per regio het kleinste
 * geschikte formaat (≥ 2 GB, zoals bij de cloud) met de live prijs. Met `region`: die keuze bewaren.
 * Inloggegevens: Scaleway gebruikt de sleutel bij Accounts; andere aanbieders wat je cloud al heeft gekoppeld, met wat
 * nu is ingevuld eroverheen ("••…" laat de bewaarde staan). Een andere keuze gaat in bij (opnieuw) opzetten.
 */
export async function saveServer(c: AdminConfig, b: { provider?: string; region?: string; fields?: Record<string, unknown> }, deps: Offers) {
  const a = state(c);
  const offer = deps.serverOffers().find((o) => o.id === b.provider);
  if (!offer) throw new Error("Kies een aanbieder voor de server");
  let fields: Record<string, string>;
  if (offer.id === "scaleway") {
    const key = a.accounts?.scalewaySecretKey;
    if (!key || a.checked?.scaleway !== true) throw new Error("Controleer eerst je Scaleway-sleutel bij Accounts");
    fields = { secretKey: key, projectId: a.projectId ?? "" };
  } else {
    fields = { ...(c.providers[offer.id] ?? {}), ...(a.keys?.[offer.id] ?? {}) };
    for (const [k, v] of Object.entries(b.fields ?? {})) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t && !t.startsWith("••")) fields[k] = t;
    }
    const missing = offer.fields.filter((f) => !f.optional && !fields[f.key]);
    if (missing.length) throw new Error(`Vul in: ${missing.map((f) => f.label).join(", ")}`);
    try { await makeProvider(offer.id, fields).list(PROJECT_NAME); }
    catch (e) { throw new Error(`Inloggen bij ${offer.name} lukt niet: ${(e as Error).message.replace(/https?:\/\/\S+/, "").slice(0, 160)}`); }
    a.keys = { ...(a.keys ?? {}), [offer.id]: fields };
  }
  if (!b.region) {
    const regions = await Promise.all(offer.regions.map(async (r) => {
      const base = { region: r.id, label: r.label, city: r.city, country: r.country };
      try {
        const s = pickSize(await fetchSizes(offer.id, fields, r.id), "data");
        return s ? { ...base, size: s.size, sizeLabel: s.label, monthly: s.monthly } : { ...base, error: "Geen geschikt formaat (minstens 2 GB geheugen)" };
      } catch { return { ...base, error: "Prijzen ophalen lukt niet" }; }
    }));
    return { ok: true, provider: offer.id, regions };
  }
  const r = offer.regions.find((x) => x.id === b.region);
  if (!r) throw new Error("Kies een regio");
  let s: SizeOption | undefined;
  try { s = pickSize(await fetchSizes(offer.id, fields, r.id), "data"); }
  catch { throw new Error(`Prijzen ophalen bij ${offer.name} lukt niet`); }
  if (!s) throw new Error(`Geen geschikt formaat in ${r.label} (minstens 2 GB geheugen)`);
  a.hosting = { provider: offer.id, region: r.id, size: s.size, monthly: s.monthly };
  return { ok: true, provider: offer.id, hosting: hostingView(a, deps), pending: !!a.server };
}

/**
 * Waar de back-ups komen: een gekoppelde opslag van je cloud (`store`, met diens sleutels, een eigen bucket), of een
 * opslag-aanbieder uit de registry met regio en sleutels. Scaleway zonder sleutels: de console maakt er zelf een.
 * Mag bij een andere aanbieder dan de server. Zodra er back-ups zijn, ligt de plek vast (de nieuwe server zet ze terug).
 */
export function saveBackup(c: AdminConfig, b: { provider?: string; region?: string; endpoint?: string; accessKey?: string; secretKey?: string; store?: string }, deps: Offers) {
  const a = state(c);
  if (a.backup?.bucket) throw new Error(`De back-ups staan al in ${a.backup.bucket}; die plek blijft hetzelfde`);
  const offers = deps.storeOffers().filter((o) => o.id !== "localfs");
  if (b.store) {
    const st = c.stores.find((x) => x.name === b.store && x.type === "s3");
    if (!st?.endpoint || !st.accessKey || !st.secretKey) throw new Error("Kies een gekoppelde opslag");
    const offer = offers.find((o) => o.regions.some((r) => !!r.endpoint && r.endpoint === st.endpoint));
    a.backup = { provider: offer?.id ?? "custom", endpoint: st.endpoint, region: st.region ?? "us-east-1", country: st.country ?? "", accessKey: st.accessKey, secretKey: st.secretKey };
    return { ok: true, backup: backupView(a, deps) };
  }
  const offer = offers.find((o) => o.id === b.provider);
  if (!offer) throw new Error("Kies waar de back-ups komen");
  const r = offer.regions.find((x) => x.id === b.region);
  if (!r) throw new Error("Kies een locatie voor de back-ups");
  const endpoint = offer.customEndpoint ? String(b.endpoint ?? "").trim() : r.endpoint;
  if (!/^https?:\/\/[^\s/]+/.test(endpoint)) throw new Error("Vul de endpoint-URL in (begint met https://)");
  const region = r.id === "eigen" ? "us-east-1" : r.id;
  const accessKey = String(b.accessKey ?? "").trim(), secretKey = String(b.secretKey ?? "").trim();
  if (/[\r\n]/.test(accessKey + secretKey)) throw new Error("Een sleutel past op één regel");
  if (offer.id === "scaleway" && !accessKey && !secretKey) {
    // Scaleway zonder eigen sleutels: bij het opzetten maakt de console een sleutel die alleen in het project mag.
    const prev = a.backup;
    a.backup = prev?.provider === "scaleway" && prev.applicationId && prev.endpoint === endpoint ? prev : { provider: "scaleway", endpoint, region, country: r.country };
  } else {
    if (!accessKey || !secretKey) throw new Error("Vul de toegangssleutel en geheime sleutel in");
    a.backup = { provider: offer.id, endpoint, region, country: r.country, accessKey, secretKey };
  }
  return { ok: true, backup: backupView(a, deps) };
}

// ───────── 5. Opzetten ─────────

async function scw(method: string, p: string, key: string, body?: unknown) {
  let r;
  try { r = await http(`${scwApi()}${p}`, { method, headers: { "x-auth-token": key, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, 30_000); }
  catch { throw new Error("Scaleway is niet bereikbaar"); }
  if (r.status === 401) throw new Error("Scaleway accepteert de sleutel niet meer");
  if (r.status === 403) throw new Error(`De sleutel mag dit niet bij Scaleway (${String(r.json?.message ?? "geen toegang")})`);
  if (!r.ok) throw new Error(`Scaleway antwoordt ${r.status}: ${String(r.json?.message ?? "").slice(0, 160)}`);
  return r.json as any;
}

/** De omgeving van de Dienst (dienst.env), in vaste volgorde. Alleen voor de user-data; nooit in een antwoord. */
export function dienstEnv(c: AdminConfig, a: AanbiederState): [string, string][] {
  const acc = a.accounts ?? {}, co = a.company!;
  const brand = co.name.replace(/[<>"]/g, "").trim();
  const env: [string, string][] = [
    ["BROKER_PUBLIC_URL", a.url!],
    ["BROKER_SECRET", a.secret!],
    ["BROKER_OWNER_EMAIL", co.email],
    ["BROKER_ADMIN_EMAIL", co.email],
    ["BROKER_BRAND_NAME", co.name],
    ["BROKER_MAIL_FROM", `${brand} <${mailFromOf(c, a)}>`],
    ["BROKER_COMPANY_NAME", co.name],
    ["BROKER_COMPANY_ADDRESS", co.address.join("\\n")],
  ];
  if (co.kvk) env.push(["BROKER_COMPANY_KVK", co.kvk]);
  if (co.vat) env.push(["BROKER_COMPANY_VAT", co.vat]);
  if (co.vatPercent && co.vatPercent !== "21") env.push(["BROKER_VAT_PERCENT", co.vatPercent]);
  if (co.enforce) env.push(["BROKER_ENFORCE", "1"]);
  env.push(["MOLLIE_API_KEY", acc.mollieKey!], ["DESEC_TOKEN", acc.desecToken!], ["SCW_SECRET_KEY", acc.scalewaySecretKey!], ["SCW_ORGANIZATION_ID", acc.scalewayOrgId!], ["BROKER_SMTP_URL", smtpOf(c, a)]);
  if (acc.openproviderUser && acc.openproviderPass) env.push(["OPENPROVIDER_USERNAME", acc.openproviderUser], ["OPENPROVIDER_PASSWORD", acc.openproviderPass]);
  // De adressendienst op deze server gaat voor een ingevuld adres: de Dienst praat er rechtstreeks mee.
  if (a.adressen) env.push(["BROKER_ADRES_URL", ADRESSEN_LOCAL], ["BROKER_ADRES_PUBLIEK", `https://${a.adressen.host}`], ["BROKER_BACKUP_ADRESSEN", "/adressen/adressen.sqlite"]);
  else if (acc.adresUrl) env.push(["BROKER_ADRES_URL", acc.adresUrl]);
  const bk = a.backup!;
  env.push(["BROKER_BACKUP_ENDPOINT", bk.endpoint], ["BROKER_BACKUP_REGION", bk.region], ["BROKER_BACKUP_BUCKET", bk.bucket!], ["BROKER_BACKUP_ACCESS_KEY", bk.accessKey!], ["BROKER_BACKUP_SECRET_KEY", bk.secretKey!]);
  if (a.envAt) env.push(["BROKER_ENV_AT", String(a.envAt)]);
  return env;
}

/** Waar de Dienst de adressendienst op dezelfde server bereikt. */
export const ADRESSEN_LOCAL = "http://127.0.0.1:4200";

/** adressen.env voor de adressendienst op de server van de Dienst (alleen voor de user-data). */
export function adressenEnv(a: AanbiederState): [string, string][] {
  const x = a.adressen!;
  return [["ADRES_ZONE", x.zone], ["ADRES_DESEC_TOKEN", x.desecToken], ["ADRES_PUBLIC_URL", `https://${x.host}`], ["ADRES_LOKAAL_DIENST", a.url!]];
}

/** Het opstartscript voor de server van de Dienst (met dezelfde images als je cloud). */
export function serverUserData(c: AdminConfig, a: AanbiederState) {
  const img = c.image as { ref?: string; caddyRef?: string };
  const appImage = img.ref || "ghcr.io/renevanes/eigen-cloud:latest";
  const caddyImage = img.caddyRef || "ghcr.io/renevanes/eigen-caddy:latest";
  const latest = (r: string) => r.replace(/@sha256:[0-9a-f]{64}$/, ":latest");
  return dienstUserData({ host: hostOf(a.url)!, email: a.company!.email, env: dienstEnv(c, a), appImage, caddyImage, appRef: latest(appImage), caddyRef: latest(caddyImage),
    ...(a.adressen ? { adressen: { host: a.adressen.host, env: adressenEnv(a) } } : {}) });
}

/** Token voor POST /v1/status/handover (zie src/broker/backup.ts). */
export const beheerToken = (secretHex: string) => deriveKey(Buffer.from(secretHex, "hex"), "dienst-beheer").toString("hex");

/** De huidige server een laatste back-up laten maken; daarna schrijft hij niets meer. */
async function handover(a: AanbiederState): Promise<{ ok: boolean; detail: string }> {
  if (!a.url || !a.secret) return { ok: false, detail: "Geen adres" };
  try {
    const r = await http(`${aanbiederNet.reach(a.url)}/v1/status/handover`, { method: "POST", headers: { authorization: `Beheer ${beheerToken(a.secret)}` } }, 120_000);
    if (r.ok) return { ok: true, detail: r.json?.lastBackupAt ? "Alles staat in de back-up" : "Geen back-up ingesteld" };
    return { ok: false, detail: `De server antwoordt ${r.status}; de nieuwe server krijgt de laatste back-up van het afgelopen uur` };
  } catch { return { ok: false, detail: "De server is niet bereikbaar; de nieuwe server krijgt de laatste back-up" }; }
}

export interface Deps extends Offers {
  save: () => void;
  /** Wachten tussen pogingen (een nieuwe sleutel werkt bij Scaleway soms pas na een paar seconden). */
  sleep?: (ms: number) => Promise<void>;
}

async function ensureProject(a: AanbiederState, key: string, org: string) {
  if (a.projectId) return a.projectId;
  const list = await scw("GET", `/account/v3/projects?organization_id=${encodeURIComponent(org)}&name=${PROJECT_NAME}`, key);
  let id = (list?.projects ?? []).find((p: { name: string }) => p.name === PROJECT_NAME)?.id as string | undefined;
  if (!id) id = (await scw("POST", "/account/v3/projects", key, { name: PROJECT_NAME, organization_id: org, description: "Eigen Cloud Dienst: server en back-ups" }))?.id;
  if (!id) throw new Error("Scaleway gaf geen project-id terug");
  return (a.projectId = id);
}

/** Back-ups bij Scaleway zonder eigen sleutels: de console maakt er zelf een (alleen opslag, alleen in het project). */
const autoBackup = (a: AanbiederState) => a.backup?.provider === "scaleway" && !a.backup.accessKey;

/** Een eigen sleutel voor de back-ups: alleen Object Storage, alleen in het project van de Dienst. */
async function ensureBackupKey(a: AanbiederState, key: string, org: string, deps: Deps) {
  const bk = a.backup!;
  if (bk.accessKey && bk.secretKey) return;
  const name = `${PROJECT_NAME}-backup`;
  if (!bk.applicationId) {
    const list = await scw("GET", `/iam/v1alpha1/applications?organization_id=${encodeURIComponent(org)}&name=${name}`, key);
    bk.applicationId = (list?.applications ?? []).find((x: { name: string }) => x.name === name)?.id
      ?? (await scw("POST", "/iam/v1alpha1/applications", key, { name, organization_id: org, description: "Back-ups van de Eigen Cloud Dienst" }))?.id;
    if (!bk.applicationId) throw new Error("Scaleway gaf geen applicatie-id terug");
    deps.save();
  }
  if (!bk.policyId) {
    const list = await scw("GET", `/iam/v1alpha1/policies?organization_id=${encodeURIComponent(org)}&application_id=${bk.applicationId}`, key);
    bk.policyId = (list?.policies ?? [])[0]?.id
      ?? (await scw("POST", "/iam/v1alpha1/policies", key, { name, organization_id: org, application_id: bk.applicationId, description: `Alleen opslag in project ${a.projectId}`, rules: [{ permission_set_names: ["ObjectStorageFullAccess"], project_ids: [a.projectId] }] }))?.id;
    if (!bk.policyId) throw new Error("Scaleway gaf geen policy-id terug");
    deps.save();
  }
  const k = await scw("POST", "/iam/v1alpha1/api-keys", key, { application_id: bk.applicationId, default_project_id: a.projectId, description: "Back-ups van de Eigen Cloud Dienst" });
  if (!k?.access_key || !k?.secret_key) throw new Error("Scaleway gaf geen sleutel terug");
  bk.accessKey = k.access_key;
  bk.secretKey = k.secret_key;
  deps.save();
}

async function ensureBucket(c: AdminConfig, a: AanbiederState, deps: Deps) {
  const bk = a.backup!;
  const bucket = bk.bucket ?? `${c.cluster}-dienst-backup-${crypto.randomBytes(3).toString("hex")}`;
  const store: StoreConfig = { name: "dienst-backup", type: "s3", purpose: "backup", country: bk.country ?? "", endpoint: bk.endpoint, region: bk.region, bucket, accessKey: bk.accessKey, secretKey: bk.secretKey };
  let steps: StepResult[] = [];
  for (let i = 0; i < 4; i++) {
    steps = await prepareStore(store);
    if (steps.every((x) => x.ok || /Versiebeheer|Onveranderbaar/.test(x.label))) {
      bk.bucket = bucket;
      deps.save();
      return;
    }
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(4000);
  }
  throw new Error(`Back-upopslag klaarzetten lukte niet: ${steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
}

/**
 * De Provider (src/cluster/adapters) voor servers van de Dienst bij een aanbieder. Scaleway: de sleutel bij Accounts
 * in het project eigen-cloud-dienst; andere aanbieders: de inloggegevens die bij "Server en back-ups" zijn gekozen.
 */
function providerFor(c: AdminConfig, a: AanbiederState, id: string): Provider {
  if (id === "scaleway") {
    const key = a.accounts?.scalewaySecretKey;
    if (!key || !a.projectId) throw new Error("Geen Scaleway-sleutel of project voor de server");
    return makeProvider("scaleway", { secretKey: key, projectId: a.projectId });
  }
  const f = a.keys?.[id] ?? c.providers[id];
  if (!f) throw new Error(`Geen inloggegevens voor ${id}; kies de server opnieuw`);
  return makeProvider(id, f);
}

/**
 * Opzetten, of (als er al een server is) opnieuw opzetten: de huidige server maakt een laatste back-up, er komt een
 * nieuwe server die die back-up bij de eerste start terugzet, het adres wijst naar de nieuwe, de oude gaat weg.
 * Zo werken ook gewijzigde instellingen (en een andere aanbieder of regio): die staan in de user-data van de nieuwe server.
 */
export async function opzetten(c: AdminConfig, deps: Deps) {
  const a = state(c);
  if (!companyReady(a)) throw new Error("Vul eerst je bedrijfsgegevens in");
  if (!accountsReady(a)) throw new Error("Controleer eerst je accounts (stap 2)");
  if (!a.url) throw new Error("Kies eerst het adres van je Dienst");
  if (!a.hosting) throw new Error("Kies eerst waar de server van je Dienst komt");
  if (!a.backup) throw new Error("Kies eerst waar de back-ups komen");
  const hosting = a.hosting;
  const offer = deps.serverOffers().find((o) => o.id === hosting.provider);
  if (!offer) throw new Error(`Onbekende aanbieder ${hosting.provider}`);
  const where = offer.regions.find((r) => r.id === hosting.region);
  const key = a.accounts!.scalewaySecretKey!, org = a.accounts!.scalewayOrgId!;
  const steps: StepResult[] = [];
  const replace = !!a.server?.serverId;
  try {
    const auto = autoBackup(a);
    if (hosting.provider === "scaleway" || auto) {
      await ensureProject(a, key, org);
      deps.save();
      steps.push({ label: `Project ${PROJECT_NAME} bij Scaleway`, ok: true });
    }
    if (auto) {
      await ensureBackupKey(a, key, org, deps);
      steps.push({ label: "Sleutel voor de back-ups (werkt alleen in dit project)", ok: true });
    }
    await ensureBucket(c, a, deps);
    const bv = backupView(a, deps)!;
    steps.push({ label: `Back-upopslag bij ${bv.name} (${bv.regionLabel}), 30 dagen niet te wissen`, ok: true, detail: a.backup.bucket });
    a.secret ??= randomKeyHex();
    deps.save();
    if (replace) {
      const h = await handover(a);
      steps.push({ label: "Laatste back-up van de huidige server", ok: h.ok, detail: h.detail });
    }
    const nodeId = `dienst-${crypto.randomBytes(3).toString("hex")}`;
    // dienst.env van deze server is nieuwer dan instellingen die eerder met "Toepassen" zijn gestuurd.
    a.envAt = Date.now();
    const info = await providerFor(c, a, hosting.provider).create({ cluster: PROJECT_NAME, nodeId, kind: "data", region: hosting.region, size: hosting.size, userData: serverUserData(c, a) });
    a.deployed = deployedHashes(c, a);
    const old = a.server;
    a.server = { provider: hosting.provider, region: hosting.region, size: hosting.size, serverId: info.serverId, ...(info.ipv4 ? { ipv4: info.ipv4 } : {}), ...(info.ipv6 ? { ipv6: info.ipv6 } : {}), createdAt: Date.now() };
    a.removed = false;
    a.createdAt ??= Date.now();
    a.lastHealth = null;
    a.step = "klaar";
    if (old?.serverId) a.retired = [...(a.retired ?? []), { provider: old.provider, serverId: old.serverId }];
    deps.save();
    steps.push({ label: `Server bij ${offer.name} in ${where?.city ?? hosting.region} (${hosting.size})`, ok: true, detail: info.ipv4 ? `IP-adres ${info.ipv4}` : undefined });
    if (old?.serverId) steps.push({ label: "De vorige server wordt opgeruimd", ok: true });
    const sync = a.dns ? await syncOwnDns(a) : null;
    if (sync) deps.save();
    const d = dnsInfo(c);
    steps.push(dnsStep(d, info.ipv4, sync, `${d.host} wijst naar ${info.ipv4}`, false));
    if (a.adressen) {
      const ad = adressenDns(c);
      steps.push(dnsStep(ad, info.ipv4, sync, `Adressendienst op ${ad.host}`, true));
    }
    if (a.retired?.length) void cleanupRetired(c, deps);
    return { ok: true, replaced: replace, steps, server: view(c, deps).server };
  } catch (e) {
    deps.save();
    throw fail((e as Error).message, steps);
  }
}

/** De stap over DNS na het opzetten: wie het record zet, of wat je zelf moet doen. */
function dnsStep(d: ReturnType<typeof dnsInfo>, ip: string | undefined, sync: { ok: boolean; detail?: string } | null, label: string, also: boolean): StepResult {
  if (d.mode === "eigen" && d.managed) {
    return sync && !sync.ok ? { label: `${d.host} in de DNS zetten bij ${dnsName(d.provider)}`, ok: false, detail: sync.detail }
      : { label, ok: true, detail: `De console zet dit record bij ${dnsName(d.provider)}` };
  }
  if (d.managed) return { label, ok: true, detail: also ? "Je cloud zet ook dit record zelf in je DNS" : "Je cloud zet dit record zelf in je DNS" };
  return { label: `Zet bij je DNS een A-record: ${d.host} → ${ip}`, ok: true };
}

/** "deSEC" in plaats van "desec" (de naam van de DNS-aanbieder in de registry). */
function dnsName(id: string | null) {
  const a = id ? getAdapter(id) : undefined;
  return (a?.dns?.name ?? a?.name ?? id ?? "").replace(/ \(.*\)$/, "");
}

// ───────── Eigen DNS van de Dienst ─────────

/** TTL voor de records van de Dienst (deSEC rondt op naar zijn minimum van een uur). */
export const DNS_TTL = 300;

/**
 * De records die er moeten staan bij de eigen DNS-koppeling: A en AAAA voor het adres van de Dienst en (als die meedraait)
 * de adressendienst, voor zover ze onder de zone vallen. Zonder server (of na verwijderen) met lege waarden: weghalen.
 */
export function ownDnsWant(a: AanbiederState): DnsRec[] {
  if (!a.dns) return [];
  const z = a.dns.zone, out: DnsRec[] = [];
  const live = !!a.server && !a.removed;
  for (const h of [hostOf(a.url), a.adressen?.host ?? null]) {
    if (!h) continue;
    const sub = h === z ? "" : h.endsWith(`.${z}`) ? h.slice(0, -(z.length + 1)) : null;
    if (sub === null || out.some((x) => x.sub === sub)) continue;
    out.push({ sub, type: "A", value: live ? a.server?.ipv4 ?? "" : "" }, { sub, type: "AAAA", value: live ? a.server?.ipv6 ?? "" : "" });
  }
  return out;
}

function ownDnsProvider(d: NonNullable<AanbiederState["dns"]>) {
  const ad = getAdapter(d.provider);
  if (!ad?.dns) throw new Error(`Onbekende DNS-aanbieder ${d.provider}`);
  return ad.dns.create("dienst", d.fields, d.zone);
}

/**
 * De records bij de eigen DNS-koppeling bijwerken: alleen wat anders is dan wat de console er eerder zette (`dns.set`),
 * en wat niet meer nodig is weghalen. Mislukt het, dan blijft `dns.error` staan en probeert de status het opnieuw.
 */
export async function syncOwnDns(a: AanbiederState): Promise<{ ok: boolean; changed: number; detail?: string }> {
  const d = a.dns;
  if (!d) return { ok: true, changed: 0 };
  const want = ownDnsWant(a);
  const key = (x: DnsRec) => `${x.sub}/${x.type}`;
  const done = new Map((d.set ?? []).map((x) => [key(x), x] as const));
  const todo: DnsRec[] = [];
  for (const w of want) if ((done.get(key(w))?.value ?? "") !== w.value) todo.push(w);
  for (const p of d.set ?? []) if (!want.some((w) => key(w) === key(p))) todo.push({ ...p, value: "" });
  if (!todo.length) {
    if (d.error) delete d.error;
    return { ok: true, changed: 0 };
  }
  let changed = 0;
  try {
    const dns = ownDnsProvider(d);
    for (const t of todo) {
      await dns.setRecords(t.sub, t.type, t.value ? [t.value] : [], DNS_TTL);
      changed++;
      if (t.value) done.set(key(t), t); else done.delete(key(t));
    }
    delete d.error;
    d.at = Date.now();
    return { ok: true, changed };
  } catch (e) {
    d.error = `${dnsName(d.provider)}: ${(e as Error).message.replace(/https?:\/\/\S+/g, "").slice(0, 160)}`;
    return { ok: false, changed, detail: d.error };
  } finally {
    d.set = [...done.values()];
  }
}

/**
 * Wie het adres van de Dienst in de DNS zet. `provider`: "cloud" (je cloud, als die DNS heeft en het adres onder zijn
 * domein valt), "handmatig" (je zet het record zelf), of de id van een DNS-aanbieder uit de registry (deSEC, Scaleway,
 * Hetzner, Exoscale, OVHcloud …) met de zone en inloggegevens. Inloggegevens komen ook van wat al gekoppeld is: je cloud
 * (`providers`), de server van de Dienst (`keys`), en bij deSEC/Scaleway de sleutels bij Accounts. Live gecontroleerd met
 * `connect` van de adapter (bij deSEC: de zone wordt aangemaakt als hij er nog niet is). Draait de Dienst al, dan zet de
 * console de records meteen; records bij een vorige koppeling haalt hij weg.
 */
export async function saveDns(c: AdminConfig, b: { provider?: string; zone?: string; fields?: Record<string, unknown> }, deps: Offers) {
  const a = state(c);
  const host = hostOf(a.url);
  if (!host) throw new Error("Kies eerst het adres van je Dienst");
  const p = String(b.provider ?? "");
  const old = a.dns;
  /** Records bij de vorige koppeling weghalen (lukt dat niet, dan blijven ze staan; geen fout). */
  const clearOld = async () => {
    if (!old?.set?.length) return true;
    const tmp: AanbiederState = { ...a, dns: { ...old }, server: null, removed: true };
    const r = await syncOwnDns(tmp);
    return r.ok;
  };
  if (p === "cloud" || p === "handmatig") {
    if (p === "cloud" && !(cloudSub(c, host) !== null && cloudDns(c))) throw new Error(`Je cloud kan ${host} niet in de DNS zetten; kies een DNS-aanbieder of zet het record zelf`);
    const cleared = await clearOld();
    delete a.dns;
    if (p === "handmatig") a.dnsHandmatig = true; else delete a.dnsHandmatig;
    return { ok: true, dns: dnsInfo(c), nameservers: null, synced: null, detail: cleared ? null : "De oude records konden niet weg; haal ze zelf weg bij je DNS-aanbieder" };
  }
  const offer = (deps.dnsOffers?.() ?? catalogDnsOffers()).find((o) => o.id === p);
  const ad = getAdapter(p);
  if (!offer || !ad?.dns) throw new Error("Kies een DNS-aanbieder");
  const zone = String(b.zone ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "") || (old?.provider === p ? old.zone : defaultZone(host) ?? "");
  if (!ZONE.test(zone)) throw new Error("Vul het domein in waar het adres onder valt, zoals vanes.nl");
  if (host !== zone && !host.endsWith(`.${zone}`)) throw new Error(`${host} valt niet onder ${zone}`);
  const fields: Record<string, string> = {};
  const fallback: Record<string, string | undefined> = p === "desec" ? { token: a.accounts?.desecToken } : p === "scaleway" ? { secretKey: a.accounts?.scalewaySecretKey } : {};
  for (const f of offer.fields) {
    const v = c.providers[p]?.[f.key] || a.keys?.[p]?.[f.key] || fallback[f.key];
    if (v) fields[f.key] = v;
  }
  if (old?.provider === p) Object.assign(fields, old.fields);
  for (const [k, v] of Object.entries(b.fields ?? {})) {
    if (typeof v !== "string" || !v.trim() || v.startsWith("••") || !offer.fields.some((f) => f.key === k)) continue;
    if (/[\r\n]/.test(v)) throw new Error("Een sleutel past op één regel");
    fields[k] = v.trim();
  }
  const missing = offer.fields.filter((f) => !f.optional && !fields[f.key]);
  if (missing.length) throw new Error(`Vul in: ${missing.map((f) => f.label).join(", ")}`);
  let nameservers: string[];
  try { nameservers = (await ad.dns.connect(fields, zone)).nameservers; }
  catch (e) { throw new Error(`${offer.name.replace(/ \(.*\)$/, "")}: ${(e as Error).message}`); }
  const same = old?.provider === p && old.zone === zone;
  const cleared = same ? true : await clearOld();
  a.dns = { provider: p, zone, fields, set: same ? old!.set ?? [] : [], nameservers };
  delete a.dnsHandmatig;
  // Records van je cloud: die haalt de cloud weg (extra_dns) als het adres niet onder deze zone valt.
  const sync = a.server ? await syncOwnDns(a) : null;
  return { ok: true, dns: dnsInfo(c), nameservers, synced: sync ? sync.ok : null, detail: sync && !sync.ok ? sync.detail : cleared ? null : "De oude records konden niet weg; haal ze zelf weg bij je vorige DNS-aanbieder" };
}

// ───────── Hersteltest ─────────

const backupStoreOf = (bk: NonNullable<AanbiederState["backup"]>) =>
  new S3Store({ name: "dienst-backup", type: "s3", purpose: "backup", endpoint: bk.endpoint, region: bk.region, bucket: bk.bucket!, accessKey: bk.accessKey!, secretKey: bk.secretKey! });

/**
 * Hersteltest: de nieuwste back-up ophalen, met de sleutel van de Dienst (afgeleid van BROKER_SECRET) ontsleutelen en
 * nagaan dat de database erin zit en leesbaar is. Alleen lezen; er verandert niets aan de Dienst of de back-ups.
 */
export async function hersteltest(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  const bk = a?.backup;
  if (!a?.secret || !bk?.bucket || !bk.accessKey || !bk.secretKey) throw new Error("Er zijn nog geen back-ups van je Dienst");
  let res: { ok: boolean; backupAt: number | null; detail: string };
  const store = backupStoreOf(bk);
  let buf: Buffer | null = null, last: { key: string; at: number } | null = null, reached = true;
  try {
    last = await latestBackup(store);
    if (last) buf = await store.getBuffer(last.key);
  } catch { reached = false; }
  if (!reached) res = { ok: false, backupAt: last?.at ?? null, detail: "De back-upopslag is niet bereikbaar" };
  else if (!last) res = { ok: false, backupAt: null, detail: "Er staat nog geen back-up in de opslag" };
  else if (!buf) res = { ok: false, backupAt: last.at, detail: "De back-upopslag is niet bereikbaar" };
  else {
    try {
      const pack = JSON.parse(zlib.gunzipSync(await decryptBuffer(deriveKey(Buffer.from(a.secret, "hex"), "dienst-backup"), buf)).toString("utf8")) as { at?: number; files?: Record<string, string> };
      const files = Object.keys(pack.files ?? {}).sort();
      const db = Buffer.from(pack.files?.["dienst.sqlite"] ?? "", "base64");
      const ok = db.subarray(0, 16).toString("latin1") === "SQLite format 3\0";
      res = { ok, backupAt: typeof pack.at === "number" ? pack.at : last.at,
        detail: ok ? `Terug te zetten: ${files.join(", ")} (database ${Math.ceil(db.length / 1024)} KB)` : "De database in de back-up is beschadigd" };
    } catch { res = { ok: false, backupAt: last.at, detail: "De back-up is niet te openen met de sleutel van je Dienst" }; }
  }
  a.hersteltest = { at: Date.now(), ...res };
  deps.save();
  return { ...a.hersteltest };
}

// ───────── Herstelkopie zonder eigen cloud ─────────

let lastCopy = "";
/**
 * Zonder eigen cloud is er geen opslag voor de herstelkopie van de kluis: de console zet hem (versleuteld met je
 * herstelsleutel, zoals bij een cloud) in de back-upbucket van de Dienst, als `admin-config.enc`. Alleen als er iets
 * veranderde (niet bij elke statuscontrole). Herstellen: "Ik heb al een Eigen Cloud" met de sleutels van die opslag.
 */
export async function saveDienstCopy(c: AdminConfig) {
  if (!c.console.alleenDienst || !c.masterKey) return false;
  const a = existing(c);
  const bk = a?.backup;
  if (!bk?.bucket || !bk.accessKey || !bk.secretKey) return false;
  const stable = JSON.parse(JSON.stringify(c)) as AdminConfig & { console: { aanbieder?: AanbiederState } };
  if (stable.console.aanbieder) delete stable.console.aanbieder.lastHealth;
  const h = sha(stable);
  if (h === lastCopy) return false;
  await backupStoreOf(bk).put("admin-config.enc", sealJson(keysFor(c).manifest!, c, "admin-config"));
  lastCopy = h;
  return true;
}

let cleaning: Promise<unknown> | null = null;
/** Vervangen of verwijderde servers weghalen bij hun aanbieder (op de achtergrond; mislukt het, dan de volgende keer). */
export function cleanupRetired(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.retired?.length || cleaning) return cleaning ?? Promise.resolve();
  cleaning = (async () => {
    // Ook servers die tijdens het opruimen bij de lijst komen (bijv. verwijderen vlak na opnieuw opzetten).
    const tried = new Set<string>();
    const k = (x: { provider: string; serverId: string }) => `${x.provider}/${x.serverId}`;
    for (let x = a.retired?.[0]; x !== undefined; x = (a.retired ?? []).find((y) => !tried.has(k(y)))) {
      const cur = x;
      tried.add(k(cur));
      try {
        await providerFor(c, a, cur.provider).destroy(cur.serverId);
        a.retired = a.retired!.filter((y) => k(y) !== k(cur));
        if (!a.retired.length) delete a.retired;
        deps.save();
      } catch { /* volgende keer */ }
    }
  })().finally(() => { cleaning = null; });
  return cleaning;
}

// ───────── 6. Klaar: status, verwijderen ─────────

export async function status(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.server || !a.url) return { reachable: false, server: false, removed: !!a?.removed };
  let h: Health;
  try {
    const r = await http(`${aanbiederNet.reach(a.url)}/v1/status`, {}, 8000);
    if (!r.ok || !r.json) throw new Error(`De Dienst antwoordt ${r.status}`);
    h = { at: Date.now(), reachable: true, version: r.json.version ?? null, uptime: r.json.uptime ?? null, lastBackupAt: r.json.lastBackupAt ?? null, backup: r.json.backup ?? null, closing: !!r.json.closing };
  } catch (e) {
    const m = (e as Error).message;
    h = { at: Date.now(), reachable: false, version: null, uptime: null, lastBackupAt: a.lastHealth?.lastBackupAt ?? null, backup: null, closing: false, error: /antwoordt/.test(m) ? m : "Nog niet bereikbaar" };
  }
  a.lastHealth = h;
  // De user-data bevat de geheimen van de Dienst: weghalen bij de aanbieder zodra de server draait (als die dat kan).
  if (h.reachable && !a.server.userDataCleared) {
    try {
      const p = providerFor(c, a, a.server.provider);
      if (p.clearUserData) {
        await p.clearUserData(a.server.serverId);
        a.server.userDataCleared = true;
      }
    } catch { /* volgende keer */ }
  }
  // Eigen DNS-koppeling: records bijwerken als ze anders zijn dan wat er moet staan (bijv. na een mislukte poging).
  if (a.dns) await syncOwnDns(a);
  const host = hostOf(a.url)!;
  const have = (await aanbiederNet.resolve4(host).catch(() => [] as string[])).sort();
  const overzicht = h.reachable && a.secret ? await dienstOverzicht(a) : null;
  deps.save();
  void cleanupRetired(c, deps);
  return { ...h, server: true, removed: false,
    dns: { host, want: a.server.ipv4 ?? null, have, ok: !!a.server.ipv4 && have.includes(a.server.ipv4), mode: dnsInfo(c).mode, error: a.dns?.error ?? null },
    retired: (a.retired ?? []).length, adressen: await adressenStatus(c, a), overzicht };
}

/** Kerncijfers van de Dienst (klanten, omzet deze maand, open hulpvragen) via GET /v1/status/overzicht; null als dat niet kan. */
async function dienstOverzicht(a: AanbiederState) {
  try {
    const r = await http(`${aanbiederNet.reach(a.url!)}/v1/status/overzicht`, { headers: { authorization: `Beheer ${beheerToken(a.secret!)}` } }, 8000);
    return r.ok && r.json && typeof r.json === "object" ? r.json : null;
  } catch { return null; }
}

/**
 * Gewijzigde instellingen (bedrijf, sleutels, mail, btw, …) naar de draaiende Dienst sturen, zonder nieuwe server: de
 * Dienst bewaart ze versleuteld en start opnieuw (zie src/broker/instellingen.ts). Een ander adres, een andere plek of
 * de adressendienst aan/uit vraagt een nieuwe server: dan "Opnieuw opzetten".
 */
export async function toepassen(c: AdminConfig, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.server || !a.url || !a.secret) throw new Error("Er draait geen Dienst");
  if (!companyReady(a) || !accountsReady(a)) throw new Error("Controleer eerst je bedrijfsgegevens en accounts");
  if (a.deployed && sha(shapeOf(a)) !== a.deployed.shape) throw new Error("Hiervoor is een nieuwe server nodig: kies Opnieuw opzetten");
  const env = instelbaarEnv(c, a);
  const at = Math.max(Date.now(), (a.envAt ?? 0) + 1);
  let r;
  try {
    r = await http(`${aanbiederNet.reach(a.url)}/v1/status/instellingen`, { method: "POST", headers: { authorization: `Beheer ${beheerToken(a.secret)}`, "content-type": "application/json" }, body: JSON.stringify({ at, env: Object.fromEntries(env) }) }, 60_000);
  } catch { throw new Error("Je Dienst is nu niet bereikbaar; probeer het later opnieuw"); }
  if (r.status === 404) throw new Error("Je Dienst kent dit nog niet; wacht tot hij is bijgewerkt, of kies Opnieuw opzetten");
  if (!r.ok) throw new Error(r.json?.error ? `De Dienst weigert: ${r.json.error}` : `De Dienst antwoordt ${r.status}`);
  a.deployed = { env: sha(env), shape: a.deployed?.shape ?? sha(shapeOf(a)), keys: envKeys(c, a) };
  deps.save();
  return { ok: true, restart: !!r.json?.restart, keys: (r.json?.keys ?? []) as string[] };
}

/** Bereikbaarheid van de adressendienst op de server van de Dienst (null als hij er niet draait). */
async function adressenStatus(c: AdminConfig, a: AanbiederState) {
  if (!a.adressen) return null;
  const url = `https://${a.adressen.host}`;
  try {
    const r = await http(`${aanbiederNet.reach(url)}/v1/info`, {}, 8000);
    if (!r.ok || !r.json?.zone) throw new Error(`De adressendienst antwoordt ${r.status}`);
    return { url, reachable: true, zone: String(r.json.zone), ok: r.json.zone === a.adressen.zone };
  } catch (e) {
    const m = (e as Error).message;
    return { url, reachable: false, zone: null, ok: false, error: /antwoordt/.test(m) ? m : "Nog niet bereikbaar" };
  }
}

/** De server weghalen. De back-ups (en de sleutel ervan) blijven, zodat "Opnieuw opzetten" alles terugzet. */
export async function verwijderen(c: AdminConfig, b: { confirm?: string }, deps: Pick<Deps, "save">) {
  const a = existing(c);
  if (!a?.server) throw new Error("Er draait geen Dienst");
  const host = hostOf(a.url);
  if (String(b.confirm ?? "").trim().toLowerCase() !== host) throw new Error(`Typ ${host} om te bevestigen`);
  const h = await handover(a);
  a.retired = [...(a.retired ?? []), { provider: a.server.provider, serverId: a.server.serverId }];
  a.server = null;
  a.removed = true;
  a.lastHealth = null;
  a.step = "klaar";
  deps.save();
  // Eigen DNS-koppeling: de records weghalen (lukt dat nu niet, dan bij de volgende keer opnieuw opzetten).
  const dns = a.dns ? await syncOwnDns(a) : null;
  if (dns) deps.save();
  void cleanupRetired(c, deps);
  return { ok: true, finalBackup: h.ok, detail: h.detail, bucket: a.backup?.bucket ?? null, pending: (a.retired ?? []).length, dns: dns ? dns.ok : null };
}
