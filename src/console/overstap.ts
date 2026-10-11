/**
 * Overstappen: je cloud draait via aanbieder A (een Eigen Cloud Dienst) en gaat naar aanbieder B, of naar zelf
 * beheren met je eigen Scaleway-sleutel. Met de bestaande middelen: slapen bij A (alles in A's opslag), de opslag
 * kopiëren naar de nieuwe plek, de instellingen omzetten en wakker worden bij B.
 *
 * De toestand staat in de kluis (console.overstap), zodat hij na het herstarten van de console of de app verder kan.
 * Elke stap kan opnieuw: wat al gedaan is, wordt overgeslagen of herkend. De opslag van A blijft tijdens het
 * overstappen onaangeroerd; gaat er iets mis vóór je cloud bij B draait, dan kan hij terug naar A.
 *
 * De Android-app heeft dezelfde logica in Java (android/core Overstap.java); de antwoorden zijn gelijk.
 */
import type { AdminConfig, ConsoleState } from "./vault.js";
import type { StoreConfig, ObjectStore } from "../cluster/stores.js";
import type { DnsConfig, Placement } from "../cluster/config.js";
import { makeStore } from "../cluster/stores.js";
import { makeProvider } from "../cluster/providers.js";
import { rpc } from "../cluster/transport.js";
import { keysFor } from "../cluster/config.js";
import { clusterStatus, consoleSettings, findLeader, probeCluster, pushAdminConfig, readManifest, saveAdminCopy, sendJob } from "../cluster/admin.js";
import * as extras from "./extras.js";

// ───────── Toestand ─────────

type Stap = "inloggen" | "bestellen" | "betalen" | "zelf" | "gereed" | "overzetten" | "mislukt" | "terug" | "teruggezet" | "klaar";

/** Een plek: alles wat er bij aanbieder A (vorige) of B (doel) anders is in de configuratie. */
export interface Plek {
  stores: StoreConfig[];
  providers: Record<string, Record<string, string>>;
  policy: { placement: Placement[]; minDataNodes: number; witnesses: number };
  dns: DnsConfig[];
  console: Partial<Pick<ConsoleState, "mailRelay" | "spfExtra" | "extraDns" | "maxUsers" | "dnsMode" | "nameservers" | "preset" | "quick" | "temDomainId" | "catalog" | "dienst" | "firstLaunch">>;
  /** DS-records van de nieuwe zone (eigen domein), voor bij de registrar. */
  ds?: string[];
}

export interface OverstapState {
  /** Adres van de nieuwe aanbieder, of "zelf". */
  naar: string;
  naarNaam: string;
  started: number;
  stap: Stap;
  van: { url: string; naam: string; orderId: string; token: string; domain: string; mode: "own" | "register" | "transfer" | "sub"; central: boolean; transferCode?: string };
  /** Inloggen en bestellen bij de nieuwe aanbieder (de sessie bij A blijft in console.dienst tot het omzetten). */
  email?: string;
  token?: string;
  orderId?: string;
  bundle?: string;
  checkoutUrl?: string;
  bestelling?: { status: string; steps: { id: string; label: string; state: string; detail?: string }[]; error?: string };
  /** Zelf beheren: je eigen Scaleway-sleutel en deSEC-token. */
  zelf?: { accessKey: string; secretKey: string; projectId: string; desecToken: string };
  schatting?: { bytes: number; objects: number };
  doel?: Plek;
  vorige?: Plek;
  /** Afgeronde onderdelen van het overzetten (en van teruggaan, met voorvoegsel "terug:"). */
  gedaan: string[];
  fase?: string;
  /** Term uit het manifest bij het inslapen (wekken begint hoger). */
  term?: number;
  details?: Record<string, string>;
  kopie?: { objects: number; bytes: number; done: number; doneBytes: number; skipped: number };
  wake?: { clusterUrl: string; at: number };
  terugWake?: { clusterUrl: string; at: number };
  /** Zone bij deSEC van de gebruiker zelf (zelf beheren) aangemaakt. */
  zoneZelf?: boolean;
  klaar?: { ds?: string[]; authCode?: string; dnssec?: string; endsAt?: string };
  log: { at: number; text: string }[];
  fout?: string;
}

export interface Deps {
  cfg(): AdminConfig;
  /** Kluis bewaren (en na de start: herstelkopie en instellingen naar het cluster). */
  save(): void;
  /** Alleen de kluis bewaren (tijdens het overzetten: niets naar een cluster sturen). */
  saveVault(): void;
  addStore(b: extras.KitStoreInput, t: AdminConfig): ReturnType<extras.AddStoreFn>;
  linkProvider(id: string, fields: Record<string, string>, t: AdminConfig): Promise<{ ok: boolean; regions: { region: string; data?: unknown; error?: string }[] }>;
  choosePreset(id: string, t: AdminConfig): { id: string; title: string; monthly: number | null };
  localKit(kit: extras.Kit, orderId: string): extras.Kit;
  /** Eerste server starten (wekken); geeft het clusteradres van die server. */
  launch(c: AdminConfig, first: { provider: string; region: string; size: string; country?: string }, term: number, adminOverride?: { settings: Record<string, string> }): Promise<{ clusterUrl: string }>;
}

const ms = (name: string, def: number) => Number(process.env[name] ?? def);
const POLL = () => ms("EIGEN_OVERSTAP_POLL_MS", 3000);
const SLEEP_MS = () => ms("EIGEN_OVERSTAP_SLEEP_MS", 30 * 60_000);
const WAKE_MS = () => ms("EIGEN_OVERSTAP_WAKE_MS", 30 * 60_000);
const NEW_MS = () => ms("EIGEN_OVERSTAP_NEW_MS", 60 * 60_000);
const wait = (t: number) => new Promise((r) => setTimeout(r, t));

/** Zelfde tekst als WAIT_RELEASE in src/broker/provision.ts. */
export const WAIT_RELEASE = "Wacht tot je vorige aanbieder je DNS vrijgeeft";
const FASES = ["voorbereiden", "slapen", "dns", "nieuw", "kopieren", "omzetten", "wekken", "opruimen"] as const;
const TERUG = ["servers", "instellingen", "dns", "wekken"] as const;
/** Niet kopiëren: eenmalige opstartgegevens van servers en schrijftests. */
const SKIP = ["bootstrap/", "test/"];

const NS = ["ns1.desec.io", "ns2.desec.org"];

function st(c: AdminConfig) {
  const o = c.console.overstap;
  if (!o) throw new Error("Er loopt geen overstap");
  return o;
}

function log(o: OverstapState, text: string) {
  o.log.push({ at: Date.now(), text });
  if (o.log.length > 60) o.log.splice(0, o.log.length - 60);
}

const zoneOf = (domain: string) => domain.slice(domain.indexOf(".") + 1);
const needsDns = (o: OverstapState) => o.van.mode !== "sub";
const dienstNaar = (o: OverstapState) => o.naar !== "zelf";

function readyToSwitch(o: OverstapState) {
  if (o.naar === "zelf") return !!o.zelf;
  const b = o.bestelling;
  if (!b) return false;
  if (b.status === "ready") return true;
  // Eigen of geregistreerd domein: de nieuwe aanbieder wacht op onze DNS; die geven we pas vrij bij het overzetten.
  return b.status === "provisioning" && !o.van.central && b.steps.some((s) => s.id === "dns-zone" && s.state === "busy" && s.detail === WAIT_RELEASE);
}

function stapOf(o: OverstapState): Stap {
  if (["overzetten", "mislukt", "terug", "teruggezet", "klaar"].includes(o.stap)) return o.stap;
  if (o.naar === "zelf") return o.zelf ? "gereed" : "zelf";
  if (!o.token) return "inloggen";
  if (!o.orderId) return "bestellen";
  return readyToSwitch(o) ? "gereed" : "betalen";
}

/** Geschatte tijd offline (minuten): slapen en wekken plus het kopiëren dat tijdens het overstappen moet gebeuren. */
export function minutesOffline(o: Pick<OverstapState, "naar" | "van" | "schatting">) {
  const bytes = o.schatting?.bytes ?? 0;
  // Bij een gratis adres en bij zelf beheren kopiëren we vooraf (terwijl je cloud nog draait): dan alleen het laatste stukje.
  const vooraf = o.naar === "zelf" || o.van.central;
  return 15 + (vooraf ? 2 : Math.ceil(bytes / 3e8));
}

const LABELS = (o: OverstapState): [string, string][] => [
  ["voorbereiden", "Nieuwe plek klaarzetten"],
  ["slapen", `Je cloud laten slapen bij ${o.van.naam}`],
  ...(needsDns(o) ? [["dns", `DNS vrijgeven bij ${o.van.naam}`] as [string, string]] : []),
  ["nieuw", dienstNaar(o) ? `${o.naarNaam} zet alles klaar` : "Je DNS bij deSEC aanmaken"],
  ["kopieren", "Gegevens overzetten"],
  ["omzetten", `Instellingen omzetten naar ${o.naarNaam}`],
  ["wekken", `Wakker worden bij ${o.naarNaam}`],
  ["opruimen", `Abonnement bij ${o.van.naam} opzeggen`],
];
const TERUG_LABELS = (o: OverstapState): [string, string][] => [
  ["servers", `Servers bij ${o.naarNaam} weghalen`],
  ["instellingen", `Instellingen terug naar ${o.van.naam}`],
  ["dns", `DNS terug naar ${o.van.naam}`],
  ["wekken", `Wakker worden bij ${o.van.naam}`],
];

/** Wat de console en de app laten zien (geen sleutels). */
export function view(c: AdminConfig) {
  const o = c.console.overstap;
  if (!o) return { actief: false };
  const stap = stapOf(o);
  const terug = stap === "terug" || stap === "teruggezet";
  const steps = (terug ? TERUG_LABELS(o).map(([id, label]) => [`terug:${id}`, label]) : LABELS(o)).map(([id, label]) => {
    const state = o.gedaan.includes(id) ? "done" : o.fase === id ? (o.fout ? "fail" : "busy") : "wait";
    const detail = o.details?.[id];
    return { id, label, state, ...(detail ? { detail } : {}) };
  });
  return {
    actief: true, naar: o.naar, naarNaam: o.naarNaam, stap, started: o.started,
    van: { url: o.van.url, naam: o.van.naam, domain: o.van.domain, mode: o.van.mode, central: o.van.central },
    email: o.email ?? null, loggedIn: !!o.token, orderId: o.orderId ?? null, bundle: o.bundle ?? null, checkoutUrl: o.checkoutUrl ?? null,
    bestelling: o.bestelling ?? null,
    zelf: o.naar === "zelf" ? { sleutel: !!o.zelf } : null,
    dnsNodig: needsDns(o),
    schatting: o.schatting ? { bytes: o.schatting.bytes, objects: o.schatting.objects, minuten: minutesOffline(o) } : null,
    stappen: ["inloggen", "bestellen", "betalen", "zelf", "gereed"].includes(stap) ? [] : steps,
    kopie: o.kopie ?? null,
    log: o.log.slice(-20),
    fout: o.fout ?? null,
    // Terug kan zolang je cloud nog niet bij de nieuwe plek draait.
    kanTerug: (stap === "mislukt" && !o.gedaan.includes("wekken")) || (stap === "terug" && !!o.fout),
    klaar: o.klaar ?? null,
  };
}

// ───────── Beginnen, inloggen, bestellen ─────────

/** Overstap beginnen: controleren of je adres mee kan, en hoe groot je cloud is (voor de schatting). */
export async function start(c: AdminConfig, naarIn: string) {
  const cur = c.console.overstap;
  if (cur && ["overzetten", "terug", "mislukt"].includes(cur.stap)) throw new Error("Er loopt al een overstap. Rond die eerst af of ga terug.");
  if (cur?.orderId && !["teruggezet", "klaar"].includes(cur.stap)) throw new Error("Je hebt al besteld bij een andere aanbieder. Stop eerst die overstap.");
  if (!c.console.done) throw new Error("Je cloud is nog niet gestart. Kies in de assistent gewoon een andere aanbieder.");
  const d = c.console.dienst;
  if (!d?.orderId || !d.token || !d.applied) throw new Error("Je hebt geen abonnement bij een aanbieder");
  const vanUrl = extras.baseOf(c);
  const naar = naarIn === "zelf" ? "zelf" : extras.cleanDienstUrl(naarIn);
  if (naar === vanUrl) throw new Error("Je zit al bij deze aanbieder");
  const order = await extras.dienstCall(`/v1/orders/${d.orderId}`, { token: d.token, base: vanUrl });
  if (!["ready", "payment_problem"].includes(order.status)) throw new Error("Overstappen kan als je abonnement loopt (niet opgezegd of opgeschort)");
  const mode = order.domainMode as OverstapState["van"]["mode"];
  let transferCode = d.transferCode;
  if (mode === "sub" && !transferCode) {
    const kit = (await extras.dienstCall(`/v1/orders/${d.orderId}/kit`, { token: d.token, base: vanUrl }).catch(() => null)) as extras.Kit | null;
    transferCode = kit?.dns?.transferCode;
  }
  const central = mode === "sub" && !!transferCode;
  const vanNaam = (await extras.dienstBrand(vanUrl).catch(() => null))?.name ?? "je huidige aanbieder";
  const domain = c.domain!;
  if (mode === "sub" && !central) {
    throw new Error(`Je adres ${domain} hoort bij ${vanNaam} zelf en kan niet mee naar een andere plek. Een ander adres kiezen kan bij een draaiende cloud (nog) niet; vraag ${vanNaam} om hulp.`);
  }
  let naarNaam = "Zelf beheren";
  if (naar === "zelf") {
    if (central) throw new Error(`Je gratis adres ${domain} kan alleen bij een aanbieder blijven: het hoort bij de gedeelde adressendienst. Kies een andere aanbieder, of neem eerst een eigen domein.`);
  } else {
    const b = await extras.dienstBrand(naar);
    naarNaam = b.name;
    if (central && b.freeZone !== zoneOf(domain)) throw new Error(`${b.name} gebruikt de gedeelde adressendienst niet; je adres ${domain} kan daar niet mee naartoe. Kies een andere aanbieder.`);
  }
  // Hoe groot is je cloud? (voor de schatting van de tijd offline)
  let schatting: OverstapState["schatting"];
  try {
    const src = c.stores.find((s) => s.purpose === "replica") ?? c.stores[0];
    const list = (await makeStore(src).list("")).filter((x) => !SKIP.some((p) => x.key.startsWith(p)));
    schatting = { bytes: list.reduce((a, x) => a + x.size, 0), objects: list.length };
  } catch { schatting = undefined; }
  const o: OverstapState = {
    naar, naarNaam, started: Date.now(), stap: "inloggen",
    van: { url: vanUrl, naam: vanNaam, orderId: d.orderId, token: d.token, domain, mode, central, ...(central ? { transferCode } : {}) },
    ...(naar !== "zelf" && cur?.naar === naar && cur.token ? { email: cur.email, token: cur.token } : {}),
    ...(schatting ? { schatting } : {}),
    gedaan: [], log: [],
  };
  if (naar !== "zelf" && !o.email) o.email = d.email;
  log(o, naar === "zelf" ? "Overstap naar zelf beheren begonnen" : `Overstap naar ${naarNaam} begonnen`);
  o.stap = stapOf(o);
  c.console.overstap = o;
  return view(c);
}

export async function login(c: AdminConfig, email: string) {
  const o = st(c);
  if (!dienstNaar(o)) throw new Error("Bij zelf beheren log je niet in");
  if (o.orderId) throw new Error("Je hebt al besteld");
  const e = await extras.dienstStartLogin(email, o.naar);
  o.email = e;
  delete o.token;
  return { ok: true, email: e };
}

export async function verify(c: AdminConfig, code: string) {
  const o = st(c);
  if (!o.email) throw new Error("Vul eerst je e-mailadres in");
  o.token = await extras.dienstFinishLogin(o.email, code, o.naar);
  o.stap = stapOf(o);
  return { ok: true, email: o.email };
}

/** Bestellen bij de nieuwe aanbieder, met je adres zoals het nu is (of de overdrachtscode/verhuiscode). */
export async function order(c: AdminConfig, b: { bundle?: string; acceptTerms?: boolean; registrant?: Record<string, string> }) {
  const o = st(c);
  if (!dienstNaar(o)) throw new Error("Bij zelf beheren bestel je niets");
  if (!o.token) throw new Error(`Log eerst in bij ${o.naarNaam}`);
  if (o.orderId) throw new Error("Je hebt al besteld");
  if (!b.acceptTerms) throw new Error("Ga akkoord met de voorwaarden om verder te gaan");
  if (!b.bundle) throw new Error("Kies een bundel");
  const domain: Record<string, string> = { mode: "own", name: o.van.domain };
  let registrant: Record<string, string> | undefined;
  if (o.van.central) Object.assign(domain, { mode: "sub", transferCode: o.van.transferCode! });
  else if (o.van.mode === "register" || o.van.mode === "transfer") {
    // Het domein staat via de vorige aanbieder geregistreerd: verhuizen met de verhuiscode.
    const a = await extras.dienstCall(`/v1/orders/${o.van.orderId}/authcode`, { token: o.van.token, base: o.van.url });
    Object.assign(domain, { mode: "transfer", authCode: a.authCode });
    registrant = b.registrant;
  }
  const r = await extras.dienstCall("/v1/orders", { token: o.token, base: o.naar, body: { bundle: b.bundle, domain, ...(registrant ? { registrant } : {}), acceptTerms: true } });
  o.orderId = r.orderId;
  o.bundle = b.bundle;
  o.checkoutUrl = r.checkoutUrl;
  log(o, `Besteld bij ${o.naarNaam}`);
  o.stap = stapOf(o);
  return { ok: true, orderId: r.orderId, checkoutUrl: r.checkoutUrl };
}

/** Stand van de bestelling bij de nieuwe aanbieder bijwerken (voor het wachtscherm). */
export async function refresh(c: AdminConfig) {
  const o = c.console.overstap;
  if (!o?.orderId || !o.token || !["betalen", "gereed"].includes(stapOf(o))) return false;
  const r = await extras.dienstCall(`/v1/orders/${o.orderId}`, { token: o.token, base: o.naar }).catch(() => null);
  if (!r) return false;
  const before = JSON.stringify(o.bestelling ?? null);
  o.bestelling = { status: r.status, steps: r.steps ?? [], ...(r.error ? { error: r.error } : {}) };
  o.stap = stapOf(o);
  return JSON.stringify(o.bestelling) !== before;
}

/** Zelf beheren: je eigen Scaleway-sleutel (zoals bij "één sleutel") en een deSEC-token voor je DNS. */
export async function zelf(c: AdminConfig, b: { accessKey?: string; secretKey?: string; projectId?: string; desecToken?: string }) {
  const o = st(c);
  if (o.naar !== "zelf") throw new Error("Dit hoort bij zelf beheren");
  if (o.stap !== "zelf" && o.stap !== "gereed") throw new Error("Het overzetten is al begonnen");
  const { accessKey, secretKey } = extras.scwKeys(b);
  const projectId = await extras.scwProject(accessKey, secretKey, b.projectId);
  const desecToken = (b.desecToken ?? "").trim();
  if (!desecToken) throw new Error("Vul een token van je eigen deSEC-account in; daar komt je DNS");
  const r = await fetch(`${extras.DESEC_URL()}/domains/`, { headers: { authorization: `Token ${desecToken}` } }).catch(() => null);
  if (!r || r.status === 401 || r.status === 403) throw new Error("deSEC accepteert dit token niet");
  if (!r.ok) throw new Error(`deSEC antwoordt ${r.status}`);
  o.zelf = { accessKey, secretKey, projectId, desecToken };
  o.stap = stapOf(o);
  log(o, "Sleutels voor zelf beheren gecontroleerd");
  return view(c);
}

// ───────── Opslag kopiëren ─────────

export interface CopyProgress { objects: number; bytes: number; done: number; doneBytes: number; skipped: number }

/**
 * Alle objecten van A's opslag naar de nieuwe opslag (per doel de bron met hetzelfde doel: replica → replica,
 * back-up → back-up). Hervatbaar: wat al met dezelfde grootte bestaat onder db/ en blobs/ (die veranderen nooit)
 * wordt overgeslagen; de rest (manifest, configuratie, images) altijd opnieuw. Daarna controleren.
 */
export async function copyStores(from: ObjectStore[], to: ObjectStore[], onProgress: (p: CopyProgress) => void = () => {}) {
  const p: CopyProgress = { objects: 0, bytes: 0, done: 0, doneBytes: 0, skipped: 0 };
  const pairs = to.map((t) => ({ to: t, from: from.find((f) => f.purpose === t.purpose) ?? from.find((f) => f.purpose === "replica") ?? from[0] }));
  const plans: { from: ObjectStore; to: ObjectStore; src: { key: string; size: number }[]; dst: Map<string, number> }[] = [];
  for (const pr of pairs) {
    const src = (await pr.from.list("")).filter((x) => !SKIP.some((s) => x.key.startsWith(s)));
    const dst = new Map((await pr.to.list("")).map((x) => [x.key, x.size]));
    plans.push({ ...pr, src, dst });
    p.objects += src.length;
    p.bytes += src.reduce((a, x) => a + x.size, 0);
  }
  onProgress({ ...p });
  for (const plan of plans) {
    const queue = [...plan.src];
    const worker = async () => {
      for (let obj = queue.shift(); obj; obj = queue.shift()) {
        const fixed = /^(db|blobs)\//.test(obj.key);
        if (fixed && plan.dst.get(obj.key) === obj.size) { p.skipped++; p.done++; p.doneBytes += obj.size; onProgress({ ...p }); continue; }
        const body = await plan.from.get(obj.key);
        if (body) await plan.to.put(obj.key, body, obj.size);
        p.done++;
        p.doneBytes += obj.size;
        onProgress({ ...p });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // Controle: alles wat (nog) in de bron staat, staat er nu ook, even groot.
    const after = new Map((await plan.to.list("")).map((x) => [x.key, x.size]));
    const still = new Map((await plan.from.list("")).map((x) => [x.key, x.size]));
    const missing = plan.src.filter((x) => still.get(x.key) === x.size && after.get(x.key) !== x.size);
    if (missing.length) throw new Error(`${missing.length} ${missing.length === 1 ? "bestand ontbreekt" : "bestanden ontbreken"} in ${plan.to.name} na het kopiëren (bijv. ${missing[0].key})`);
  }
  return p;
}

// ───────── Plekken ─────────

function plekVan(c: AdminConfig): Plek {
  const k = c.console;
  return JSON.parse(JSON.stringify({
    stores: c.stores, providers: c.providers, dns: c.dns,
    policy: { placement: c.policy.placement, minDataNodes: c.policy.minDataNodes, witnesses: c.policy.witnesses },
    console: { mailRelay: k.mailRelay, spfExtra: k.spfExtra, extraDns: k.extraDns, maxUsers: k.maxUsers, dnsMode: k.dnsMode, nameservers: k.nameservers, preset: k.preset, quick: k.quick, temDomainId: k.temDomainId, catalog: k.catalog, dienst: k.dienst, firstLaunch: k.firstLaunch },
  })) as Plek;
}

function zetPlek(c: AdminConfig, p: Plek) {
  const copy = JSON.parse(JSON.stringify(p)) as Plek;
  c.stores = copy.stores;
  c.providers = copy.providers;
  c.dns = copy.dns;
  c.policy = { ...c.policy, ...copy.policy };
  const con = c.console as unknown as Record<string, unknown>;
  for (const k of ["mailRelay", "spfExtra", "extraDns", "maxUsers", "dnsMode", "nameservers", "preset", "quick", "temDomainId", "catalog", "dienst", "firstLaunch"] as const) {
    const v = (copy.console as Record<string, unknown>)[k];
    if (v === undefined || v === null) delete con[k]; else con[k] = v;
  }
}

/** Een kladversie van de configuratie om de nieuwe plek in op te bouwen (buckets, aanbieder, plekken). */
function kladblok(c: AdminConfig, o: OverstapState): AdminConfig {
  const t = JSON.parse(JSON.stringify({ ...c, console: { ...c.console, overstap: undefined } })) as AdminConfig;
  t.stores = o.doel?.stores ? JSON.parse(JSON.stringify(o.doel.stores)) : [];
  t.providers = {};
  t.dns = [];
  delete t.console.dienst;
  t.console.catalog = {};
  t.console.mailRelay = "";
  t.console.spfExtra = "";
  t.console.extraDns = [];
  delete t.console.temDomainId;
  return t;
}

async function doelVanKit(deps: Deps, c: AdminConfig, o: OverstapState) {
  const kit = deps.localKit((await extras.dienstCall(`/v1/orders/${o.orderId}/kit`, { token: o.token, base: o.naar })) as extras.Kit, o.orderId!);
  if (kit.domain !== o.van.domain) throw new Error(`Het pakket van ${o.naarNaam} is voor ${kit.domain}, niet voor ${o.van.domain}`);
  const t = kladblok(c, o);
  await extras.applyKit(t, kit, (b) => deps.addStore(b, t));
  const p = plekVan(t);
  p.console = {
    mailRelay: t.console.mailRelay ?? "", spfExtra: t.console.spfExtra ?? "", extraDns: [], maxUsers: t.console.maxUsers ?? 0,
    dnsMode: "dienst", nameservers: kit.nameservers, preset: "dienst",
    dienst: { url: o.naar, email: o.email, token: o.token, orderId: o.orderId, bundle: o.bundle, applied: true, ...(kit.dns.transferCode ? { transferCode: kit.dns.transferCode } : {}) },
  };
  if (kit.ds?.length) p.ds = kit.ds;
  return p;
}

async function doelZelf(deps: Deps, c: AdminConfig, o: OverstapState) {
  const z = o.zelf!;
  const t = kladblok(c, o);
  const linked = await deps.linkProvider("scaleway", { secretKey: z.secretKey, projectId: z.projectId }, t);
  if (!linked.regions.some((r) => r.data)) throw new Error(`Scaleway gaf geen serverprijzen: ${linked.regions.map((r) => r.error).filter(Boolean)[0] ?? "onbekend"}`);
  for (const [region, purpose] of [["nl-ams", "replica"], ["fr-par", "backup"]] as const) {
    const r = await deps.addStore({ offer: "scaleway", region, accessKey: z.accessKey, secretKey: z.secretKey, purpose }, t);
    if (!r.ok) throw new Error(`Opslag ${r.name}: ${r.steps.filter((x) => !x.ok).map((x) => x.label + (x.detail ? ` (${x.detail})` : "")).join(", ")}`);
    o.doel = { ...(o.doel ?? plekVan(t)), stores: t.stores };
    deps.saveVault();
  }
  const preset = deps.choosePreset("nl", t);
  try { await extras.scwMail(t, z.secretKey, z.projectId); }
  catch (e) { t.console.mailRelay = ""; log(o, `Mail versturen via Scaleway lukte niet (${(e as Error).message}); je kunt dit later bij Mail regelen`); }
  const p = plekVan(t);
  p.dns = [{ type: "desec", name: "desec", token: z.desecToken, zone: o.van.domain }];
  p.console = {
    mailRelay: t.console.mailRelay ?? "", spfExtra: t.console.spfExtra ?? "", extraDns: t.console.extraDns ?? [], maxUsers: 0,
    dnsMode: "desec", nameservers: NS, preset: preset.id, quick: "scaleway", temDomainId: t.console.temDomainId, catalog: t.console.catalog,
  };
  return p;
}

// ───────── Het overzetten ─────────

let running: Promise<void> | null = null;
export const busy = () => !!running;

/** Overzetten starten (of na een fout opnieuw proberen). Het werk loopt op de achtergrond; volg het via view(). */
export function overzetten(deps: Deps, confirm: unknown) {
  const c = deps.cfg();
  const o = st(c);
  if (confirm !== true) throw new Error("Bevestig dat je wilt overstappen: je cloud is daarbij een tijdje offline");
  const s = stapOf(o);
  if (s !== "gereed" && s !== "mislukt" && s !== "overzetten") throw new Error(s === "terug" || s === "teruggezet" ? "Je cloud gaat (of ging) terug; begin opnieuw met overstappen" : "Nog niet klaar om over te zetten");
  if (o.stap !== "overzetten") { o.stap = "overzetten"; delete o.fout; log(o, "Overzetten begonnen"); deps.saveVault(); }
  ensureRunning(deps);
  return view(c);
}

/** Na het herstarten van de console of de app: een lopende overstap (of teruggang) verder laten gaan. */
export function ensureRunning(deps: Deps) {
  const o = deps.cfg()?.console.overstap;
  if (running || !o || o.fout || (o.stap !== "overzetten" && o.stap !== "terug")) return;
  const c = deps.cfg();
  running = (o.stap === "terug" ? runTerug(deps, c) : runOver(deps, c)).finally(() => { running = null; });
}

async function runOver(deps: Deps, c: AdminConfig) {
  const o = st(c);
  for (const f of FASES) {
    if (o.gedaan.includes(f)) continue;
    if (f === "dns" && !needsDns(o)) { o.gedaan.push(f); continue; }
    o.fase = f;
    deps.saveVault();
    try {
      await FASE[f](deps, c, o);
      o.gedaan.push(f);
      deps.saveVault();
    } catch (e) {
      o.fout = (e as Error).message;
      o.stap = "mislukt";
      log(o, `Mislukt bij ${f}: ${o.fout}`);
      deps.saveVault();
      return;
    }
  }
  delete o.fase;
  o.stap = "klaar";
  log(o, `Klaar: je cloud draait bij ${o.naarNaam}`);
  deps.save();
}

const detail = (o: OverstapState, id: string, text: string) => { (o.details ??= {})[id] = text; };

const FASE: Record<(typeof FASES)[number], (deps: Deps, c: AdminConfig, o: OverstapState) => Promise<void>> = {
  async voorbereiden(deps, c, o) {
    // Draait je cloud? Dan moet hij weten hoe hij bij de nieuwe plek wakker wordt (versie met "overstap").
    const s = await clusterStatus(c);
    if (s.leaderUrl) {
      const info = await rpc<{ features?: string[] }>(keysFor(c).cluster, s.leaderUrl, { type: "nodeInfo" }, 5000).catch(() => null);
      if (info && !(info.features ?? []).includes("overstap")) throw new Error("Je cloud draait nog een oudere versie. Werk hem eerst bij (op het overzicht) en probeer het daarna opnieuw.");
    } else if (s.manifest?.state !== "asleep") throw new Error("Je cloud is niet bereikbaar. Maak hem eerst wakker of vraag je aanbieder om hulp.");
    if (dienstNaar(o)) {
      await refresh(c);
      if (o.bestelling?.status === "ready" && !o.doel) o.doel = await doelVanKit(deps, c, o);
    } else if (!o.doel?.dns?.length) o.doel = await doelZelf(deps, c, o);
    deps.saveVault();
    // Al kopiëren terwijl je cloud nog draait: tijdens het overstappen hoeft dan alleen het laatste stukje.
    if (o.doel && s.leaderUrl) {
      detail(o, "voorbereiden", "Gegevens alvast kopiëren terwijl je cloud nog draait");
      await kopieer(deps, c, o, "voorbereiden");
      detail(o, "voorbereiden", "Alvast gekopieerd; je cloud draaide nog");
    }
  },

  async slapen(deps, c, o) {
    const end = Date.now() + SLEEP_MS();
    let asked = false;
    for (;;) {
      const s = await clusterStatus(c);
      if (s.leaderUrl && !s.live?.sleeping && !asked) {
        const r = await sendJob(c, s.leaderUrl, "sleep");
        if (!r.ok) throw new Error(r.error ?? "Slapen lukte niet");
        asked = true;
        log(o, "Je cloud gaat slapen");
      }
      if (!s.leaderUrl && s.manifest?.state === "asleep" && !(await probeCluster(c, s.manifest)).length) {
        o.term = s.manifest.term;
        break;
      }
      if (!s.leaderUrl && !s.manifest) throw new Error("Geen manifest in je opslag gevonden");
      if (Date.now() > end) throw new Error("Slapen duurt te lang. Probeer het opnieuw.");
      detail(o, "slapen", asked ? "Alles wordt weggeschreven en gecontroleerd" : "Wachten op je cloud");
      await wait(POLL());
    }
    // Servers die na het slapen nog bestaan (bijv. uitgezet), weghalen met de sleutel van de vorige plek.
    let n = 0;
    for (const [name, fields] of Object.entries(c.providers)) {
      try {
        const p = makeProvider(name, fields);
        for (const sv of await p.list(c.cluster)) { await p.destroy(sv.serverId); n++; }
      } catch (e) { log(o, `Servers bij ${name} nakijken lukte niet: ${(e as Error).message}`); }
    }
    detail(o, "slapen", n ? `Slaapt; ${n} achtergebleven server(s) weggehaald` : "Slaapt; alles staat in de opslag");
  },

  async dns(_deps, _c, o) {
    const r = await extras.dienstCall(`/v1/orders/${o.van.orderId}/dns-vrijgeven`, { token: o.van.token, base: o.van.url, body: { overstap: true } });
    (o.klaar ??= {}).dnssec = r.dnssec;
    detail(o, "dns", r.dnssec === "uitgezet" ? "Vrijgegeven; DNSSEC staat even uit" : r.dnssec === "mislukt" ? "Vrijgegeven; DNSSEC uitzetten lukte niet" : "Vrijgegeven");
    log(o, `DNS van ${o.van.domain} vrijgegeven bij ${o.van.naam}`);
  },

  async nieuw(deps, c, o) {
    const end = Date.now() + NEW_MS();
    if (dienstNaar(o)) {
      for (;;) {
        const r = await extras.dienstCall(`/v1/orders/${o.orderId}`, { token: o.token, base: o.naar });
        o.bestelling = { status: r.status, steps: r.steps ?? [], ...(r.error ? { error: r.error } : {}) };
        if (r.status === "ready") break;
        if (r.status === "failed") throw new Error(`${o.naarNaam}: ${r.error ?? "klaarzetten mislukt"}`);
        if (!["paid", "provisioning"].includes(r.status)) throw new Error(`Je bestelling bij ${o.naarNaam} staat op ${r.status}`);
        const busyStep = (r.steps ?? []).find((x: { state: string }) => x.state === "busy");
        detail(o, "nieuw", busyStep ? `${busyStep.label}${busyStep.detail ? `: ${busyStep.detail}` : ""}` : "Bezig");
        if (Date.now() > end) throw new Error(`${o.naarNaam} is nog niet klaar. Probeer het straks opnieuw.`);
        deps.saveVault();
        await wait(POLL());
      }
      if (!o.doel || o.doel.console.dienst?.orderId !== o.orderId) o.doel = await doelVanKit(deps, c, o);
      detail(o, "nieuw", "Klaar");
      return;
    }
    // Zelf: de zone in je eigen deSEC-account (kan pas nu de vorige aanbieder hem heeft vrijgegeven).
    const token = o.zelf!.desecToken, d = o.van.domain;
    const h = { authorization: `Token ${token}`, "content-type": "application/json" };
    for (;;) {
      const g = await fetch(`${extras.DESEC_URL()}/domains/${d}/`, { headers: h });
      if (g.ok) {
        const z = (await g.json()) as { keys?: { ds?: string[] }[] };
        const ds = (z.keys ?? []).flatMap((k) => k.ds ?? []);
        if (ds.length) o.doel!.ds = ds;
        break;
      }
      const cr = await fetch(`${extras.DESEC_URL()}/domains/`, { method: "POST", headers: h, body: JSON.stringify({ name: d }) });
      if (cr.ok) { o.zoneZelf = true; deps.saveVault(); continue; }
      if (cr.status !== 409 && cr.status !== 400) throw new Error(`Je domein bij deSEC aanmaken lukte niet (${cr.status}): ${(await cr.text()).slice(0, 160)}`);
      if (Date.now() > end) throw new Error("Je domein staat nog bij een ander deSEC-account. Probeer het straks opnieuw.");
      detail(o, "nieuw", WAIT_RELEASE);
      await wait(POLL());
    }
    detail(o, "nieuw", "Je domein staat in je eigen deSEC-account");
  },

  async kopieren(deps, c, o) {
    await kopieer(deps, c, o, "kopieren");
  },

  async omzetten(deps, c, o) {
    if (!o.vorige) o.vorige = plekVan(c);
    zetPlek(c, o.doel!);
    deps.saveVault();
    await saveAdminCopy(c).catch(() => 0);
    detail(o, "omzetten", "Opslag, servers, DNS en mail van de nieuwe plek");
  },

  async wekken(deps, c, o) {
    await wekOp(deps, c, o, "wekken", true);
  },

  async opruimen(deps, c, o) {
    const k = (o.klaar ??= {});
    if (o.doel?.ds?.length && o.van.mode === "own") k.ds = o.doel.ds;
    if (o.naar === "zelf" && (o.van.mode === "register" || o.van.mode === "transfer")) {
      const a = await extras.dienstCall(`/v1/orders/${o.van.orderId}/authcode`, { token: o.van.token, base: o.van.url }).catch(() => null);
      if (a?.authCode) k.authCode = a.authCode;
      if (o.doel?.ds?.length) k.ds = o.doel.ds;
    }
    const r = await extras.dienstCall(`/v1/orders/${o.van.orderId}/cancel`, { token: o.van.token, base: o.van.url, body: {} });
    k.endsAt = r.endsAt;
    detail(o, "opruimen", `Opgezegd; ${o.van.naam} ruimt je oude opslag op`);
    log(o, `Abonnement bij ${o.van.naam} opgezegd`);
  },
};

async function kopieer(deps: Deps, c: AdminConfig, o: OverstapState, stap: string) {
  const from = (o.vorige ?? plekVan(c)).stores.map(makeStore);
  const to = o.doel!.stores.map(makeStore);
  let last = 0;
  const p = await copyStores(from, to, (x) => {
    o.kopie = x;
    detail(o, stap, `${x.done} van ${x.objects} bestanden (${mb(x.doneBytes)} van ${mb(x.bytes)})`);
    if (Date.now() - last > 3000) { last = Date.now(); deps.saveVault(); }
  });
  o.kopie = p;
  detail(o, stap, `${p.objects} bestanden (${mb(p.bytes)}) staan op de nieuwe plek`);
  log(o, `Gekopieerd: ${p.done - p.skipped} nieuw, ${p.skipped} waren er al`);
}

const mb = (b: number) => (b < 1e6 ? `${Math.max(0, Math.round(b / 1e3))} kB` : `${(b / 1e6).toFixed(1).replace(".", ",")} MB`);

/** Wakker maken met de huidige configuratie en wachten tot er een leider is (met de gegevens terug). */
async function wekOp(deps: Deps, c: AdminConfig, o: OverstapState, stap: string, override: boolean) {
  const keyStep = stap === "wekken" ? "wake" : "terugWake";
  const recs = o as unknown as Record<string, { clusterUrl: string; at: number } | undefined>;
  let clusterUrl = recs[keyStep]?.clusterUrl;
  if (clusterUrl && !(await findLeader(c, [clusterUrl]).catch(() => null)) && Date.now() - (recs[keyStep]?.at ?? 0) > WAKE_MS()) {
    // Vorige poging kwam niet op (na opnieuw proberen): die servers weg en opnieuw beginnen.
    if (override) await removeServers(c, o).catch(() => {});
    clusterUrl = undefined;
  }
  if (!clusterUrl) {
    const m = await readManifest(c);
    const t = !override ? m?.topology?.find((x) => x.kind === "data") : undefined;
    const first = t ? { provider: t.provider, region: t.region, size: t.size } : c.policy.placement.find((p) => p.kind !== "witness");
    if (!first) throw new Error("Geen plek voor een server in de nieuwe instellingen");
    const settings = consoleSettings(c, extras.DIENST_URL());
    const r = await deps.launch(c, first, (m?.term ?? o.term ?? 0) + 1, override ? { settings } : undefined);
    clusterUrl = r.clusterUrl;
    (o as unknown as Record<string, unknown>)[keyStep] = { clusterUrl, at: Date.now() };
    deps.saveVault();
  }
  const end = (recs[keyStep]?.at ?? Date.now()) + WAKE_MS();
  detail(o, stap, "Server opstarten en je gegevens terugzetten");
  for (;;) {
    const l = await findLeader(c, [clusterUrl]).catch(() => null);
    if (l) {
      // Voor de zekerheid (oudere servers kennen adminOverride niet): de instellingen nog eens sturen.
      await pushAdminConfig(c, extras.DIENST_URL(), l.url).catch(() => false);
      break;
    }
    if (Date.now() > end) throw new Error("Je cloud komt niet op bij de nieuwe plek");
    await wait(POLL());
  }
  detail(o, stap, "Je cloud draait weer; de overige servers komen er vanzelf bij");
}

/** Servers van dit cluster bij de aanbieders van de nieuwe plek weghalen (bij teruggaan). */
async function removeServers(c: AdminConfig, o: OverstapState) {
  const doel = o.doel;
  if (!doel) return 0;
  let n = 0;
  for (const [name, fields] of Object.entries(doel.providers)) {
    if (JSON.stringify(o.vorige?.providers?.[name] ?? null) === JSON.stringify(fields)) continue;
    const p = makeProvider(name, fields);
    for (const sv of await p.list(c.cluster)) { await p.destroy(sv.serverId); n++; }
  }
  return n;
}

// ───────── Terug naar de vorige aanbieder ─────────

export function terug(deps: Deps) {
  const c = deps.cfg();
  const o = st(c);
  const s = stapOf(o);
  if (s !== "mislukt" && !(s === "terug" && o.fout)) throw new Error(s === "klaar" ? "Je cloud draait al bij de nieuwe plek" : "Terug kan alleen als het overzetten mislukte");
  if (o.gedaan.includes("wekken")) throw new Error(`Je cloud draait al bij ${o.naarNaam}; terug kan niet meer zonder gegevens te verliezen`);
  o.stap = "terug";
  delete o.fout;
  delete o.fase;
  log(o, `Terug naar ${o.van.naam}`);
  deps.saveVault();
  ensureRunning(deps);
  return view(c);
}

async function runTerug(deps: Deps, c: AdminConfig) {
  const o = st(c);
  for (const f of TERUG) {
    const id = `terug:${f}`;
    if (o.gedaan.includes(id)) continue;
    o.fase = id;
    deps.saveVault();
    try {
      await TERUG_FASE[f](deps, c, o);
      o.gedaan.push(id);
      deps.saveVault();
    } catch (e) {
      o.fout = (e as Error).message;
      log(o, `Teruggaan lukte niet bij ${f}: ${o.fout}`);
      deps.saveVault();
      return;
    }
  }
  delete o.fase;
  o.stap = "teruggezet";
  log(o, `Je cloud draait weer bij ${o.van.naam}`);
  deps.save();
}

const TERUG_FASE: Record<(typeof TERUG)[number], (deps: Deps, c: AdminConfig, o: OverstapState) => Promise<void>> = {
  async servers(_deps, c, o) {
    const n = o.gedaan.includes("omzetten") || o.wake ? await removeServers(c, o) : 0;
    detail(o, "terug:servers", n ? `${n} server(s) weggehaald` : "Er stonden geen servers");
  },
  async instellingen(deps, c, o) {
    if (o.vorige) zetPlek(c, o.vorige);
    delete o.wake;
    deps.saveVault();
    await saveAdminCopy(c).catch(() => 0);
    detail(o, "terug:instellingen", "Opslag, servers, DNS en mail van je vorige aanbieder");
  },
  async dns(_deps, _c, o) {
    if (dienstNaar(o) && o.orderId) {
      if (o.van.central) {
        // B heeft je adres overgenomen (met een nieuwe overdrachtscode): terughalen met die code.
        const kit = await extras.dienstCall(`/v1/orders/${o.orderId}/kit`, { token: o.token, base: o.naar }).catch(() => null);
        const code = kit?.dns?.transferCode;
        if (code) await extras.dienstCall(`/v1/orders/${o.van.orderId}/dns-terug`, { token: o.van.token, base: o.van.url, body: { transferCode: code } });
      }
      await extras.dienstCall(`/v1/orders/${o.orderId}/cancel`, { token: o.token, base: o.naar, body: {} }).catch((e) => log(o, `Opzeggen bij ${o.naarNaam}: ${(e as Error).message}`));
      if (!o.van.central && o.gedaan.includes("dns")) {
        await extras.dienstCall(`/v1/orders/${o.orderId}/dns-vrijgeven`, { token: o.token, base: o.naar, body: { overstap: true } }).catch((e) => log(o, `DNS vrijgeven bij ${o.naarNaam}: ${(e as Error).message}`));
      }
    }
    if (o.naar === "zelf" && o.zoneZelf) {
      const r = await fetch(`${extras.DESEC_URL()}/domains/${o.van.domain}/`, { method: "DELETE", headers: { authorization: `Token ${o.zelf!.desecToken}` } });
      if (!r.ok && r.status !== 404) throw new Error(`Je domein bij deSEC weghalen lukte niet (${r.status})`);
      delete o.zoneZelf;
    }
    if (needsDns(o) && o.gedaan.includes("dns")) {
      const end = Date.now() + NEW_MS();
      for (;;) {
        try {
          const r = await extras.dienstCall(`/v1/orders/${o.van.orderId}/dns-terug`, { token: o.van.token, base: o.van.url, body: {} });
          if (r.ds?.length && o.van.mode === "own") (o.klaar ??= {}).ds = r.ds;
          break;
        } catch (e) {
          if (Date.now() > end || !/staat nog bij/.test((e as Error).message)) throw e;
          detail(o, "terug:dns", "Wacht tot de nieuwe aanbieder je DNS vrijgeeft");
          await wait(POLL());
        }
      }
    }
    detail(o, "terug:dns", "Je DNS staat weer bij je vorige aanbieder");
  },
  async wekken(deps, c, o) {
    // Was hij nog aan het inslapen (bijv. toen het overzetten mislukte)? Dan eerst dat afwachten.
    const end = Date.now() + SLEEP_MS();
    for (;;) {
      const s = await clusterStatus(c);
      if (s.leaderUrl && !s.live?.sleeping && !o.terugWake) { detail(o, "terug:wekken", "Je cloud is wakker"); return; }
      if (!s.leaderUrl || o.terugWake) break;
      if (Date.now() > end) throw new Error("Je cloud is nog aan het inslapen. Probeer het straks opnieuw.");
      detail(o, "terug:wekken", "Wachten tot je cloud slaapt");
      await wait(POLL());
    }
    await wekOp(deps, c, o, "terug:wekken", false);
  },
};

/** Overstap stoppen vóór het overzetten (bestelling bij de nieuwe aanbieder opzeggen), of het resultaat wegklikken. */
export async function stoppen(deps: Deps) {
  const c = deps.cfg();
  const o = c.console.overstap;
  if (!o) return { ok: true };
  const s = stapOf(o);
  if (s === "overzetten" || s === "terug" || s === "mislukt") throw new Error(s === "mislukt" ? `Kies eerst Terug naar ${o.van.naam} of probeer het opnieuw` : "Het overzetten loopt; wacht tot het klaar is");
  if (o.orderId && o.token && s !== "klaar" && s !== "teruggezet") {
    if (o.van.central && o.bestelling?.status === "ready") {
      const kit = await extras.dienstCall(`/v1/orders/${o.orderId}/kit`, { token: o.token, base: o.naar });
      if (kit?.dns?.transferCode) await extras.dienstCall(`/v1/orders/${o.van.orderId}/dns-terug`, { token: o.van.token, base: o.van.url, body: { transferCode: kit.dns.transferCode } });
    } else if (o.van.central && o.bestelling?.status !== "awaiting_payment") {
      await refresh(c);
      if (o.bestelling?.status !== "ready") throw new Error(`Wacht even tot ${o.naarNaam} klaar is; je adres staat daar al. Daarna kun je stoppen.`);
      return stoppen(deps);
    }
    await extras.dienstCall(`/v1/orders/${o.orderId}/cancel`, { token: o.token, base: o.naar, body: {} });
  }
  delete c.console.overstap;
  deps.save();
  return { ok: true };
}
