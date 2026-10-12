/**
 * Klaarzetten na betaling: een stappenmachine die in SQLite staat. Elke stap kijkt eerst of het
 * onderdeel al bestaat (en bewaart het id), zodat opnieuw proberen nooit dubbel aanmaakt.
 * Tijdelijke fouten (netwerk, 5xx, 401/429) → later opnieuw; blijvende fouten (4xx) → mislukt.
 */
import crypto from "node:crypto";
import { NAMESERVERS } from "./config.js";
import { ApiError, isPermanent, type Desec } from "./apis.js";
import { type OrderRow, getOrder, getCustomer, orderState, patchState, setStatus, event, sha256 } from "./db.js";
import { type Ctx, bundleOf, setStep, getSteps, withLock } from "./context.js";
import { trySend } from "./mail.js";

export interface OrderInput {
  registrant?: Registrant;
  authCode?: string;
  /** Gratis adres meenemen van een andere aanbieder: de overdrachtscode van de klant. */
  transferCode?: string;
}

export interface Registrant {
  firstName: string; lastName: string; company?: string;
  street: string; number: string; zipcode: string; city: string; country: string;
  phone: string; email: string;
}

export interface OrderSecrets {
  apiKey?: { accessKey: string; secretKey: string };
  dnsToken?: string;
  /** Gratis adres via de adressendienst: deSEC-token dat alleen in de zone van dit adres mag schrijven. */
  zoneToken?: string;
  /** En de overdrachtscode van de klant (ook in het pakket). */
  transferCode?: string;
}

export interface Kit {
  domain: string;
  nameservers: string[];
  delegated: boolean;
  provider: { id: "scaleway"; fields: { secretKey: string; projectId: string } };
  storage: { offer: "scaleway"; region: string; accessKey: string; secretKey: string; purpose: "replica" | "backup" }[];
  placement: { provider: string; region: string; size: string; country: string; kind: "data" | "witness" }[];
  policy: { minDataNodes: number; witnesses: number };
  dns: {
    type: "desec"; name: string; token: string; zone: string; api: string; acme: { username: string; password: string; subdomain: string; server_url: string };
    /** Gratis adres via de adressendienst: hiermee neemt een andere aanbieder het adres over (overstappen). */
    transferCode?: string;
  };
  mailRelay: { host: string; port: number; user: string; password: string; secure: boolean } | null;
  spfExtra: string;
  /** Hoeveel gebruikers de cloud mag hebben (bundel + extra gekocht). */
  users: number;
  /** DS-records van de zone (DNSSEC), behalve bij een adres van de adressendienst. */
  ds?: string[];
}

export const readInput = (ctx: Ctx, o: OrderRow) => ctx.secrets.open<OrderInput>(o.input_enc, `input:${o.id}`) ?? {};
export const readSecrets = (ctx: Ctx, o: OrderRow) => ctx.secrets.open<OrderSecrets>(o.secrets_enc, `secrets:${o.id}`) ?? {};
export const readKit = (ctx: Ctx, o: OrderRow) => ctx.secrets.open<Kit>(o.kit_enc, `kit:${o.id}`);

export function writeSecrets(ctx: Ctx, id: string, patch: Partial<OrderSecrets>) {
  const o = getOrder(ctx.db, id)!;
  const s = { ...readSecrets(ctx, o), ...patch };
  ctx.db.prepare("UPDATE orders SET secrets_enc = ? WHERE id = ?").run(ctx.secrets.seal(s, `secrets:${id}`), id);
  return s;
}

/** Gratis adres uit de centrale adressendienst (de zone staat niet in ons eigen deSEC-account). */
export const isCentral = (o: OrderRow) => o.domain_mode === "sub" && orderState(o).adres === "centraal";

/**
 * deSEC voor de zone van deze bestelling. Bij een adres van de adressendienst is dat het token dat alleen in die
 * zone mag schrijven; anders het token van de dienst zelf. Alles wat de zone van de klant aanraakt gaat hierlangs.
 */
export function desecFor(ctx: Ctx, o: OrderRow): Desec {
  if (!isCentral(o)) return ctx.apis.desec;
  const token = readSecrets(ctx, o).zoneToken;
  if (!token) throw new ApiError("Dienst", 503, "Dit adres heeft nog geen DNS-toegang van de adressendienst");
  return ctx.apis.desec.withToken(token);
}

export function splitDomain(domain: string) {
  const i = domain.indexOf(".");
  return { name: domain.slice(0, i), extension: domain.slice(i + 1) };
}

/** Naam voor project en IAM-applicatie bij Scaleway. */
export const resourceName = (o: OrderRow) => `eigen-cloud-${o.customer_id}-${o.id.slice(0, 8)}`;

/** "+31 6 12345678", "0612345678", "+32 2 1234567" → Openprovider-telefoon. */
export function parsePhone(input: string): { country_code: string; area_code: string; subscriber_number: string } | null {
  let s = input.trim().replace(/[()\-.]/g, " ").replace(/\s+/g, " ");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  let cc: string;
  let rest: string;
  if (s.startsWith("+")) {
    const m = /^\+(\d{1,3}) (.+)$/.exec(s);
    if (m) { cc = m[1]; rest = m[2]; }
    else {
      const digits = s.slice(1).replace(/ /g, "");
      const one = ["1", "7"], two = ["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "90"];
      const len = one.includes(digits[0]) ? 1 : two.includes(digits.slice(0, 2)) ? 2 : 3;
      cc = digits.slice(0, len); rest = digits.slice(len);
    }
  } else if (s.startsWith("0")) { cc = "31"; rest = s.slice(1); }
  else return null;
  rest = rest.replace(/^0/, "");
  const parts = rest.split(" ").filter(Boolean);
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  let area: string, sub: string;
  if (parts.length >= 2) { area = parts[0]; sub = parts.slice(1).join(""); }
  else {
    const d = parts[0] ?? "";
    let len = 2;
    if (cc === "31") {
      const twoDigit = ["10", "13", "15", "20", "23", "24", "26", "30", "33", "35", "36", "38", "40", "43", "45", "46", "50", "53", "55", "58", "70", "71", "72", "73", "74", "75", "76", "77", "78", "79", "85", "88", "97"];
      len = d.startsWith("6") ? 1 : twoDigit.includes(d.slice(0, 2)) ? 2 : 3;
    }
    area = d.slice(0, len); sub = d.slice(len);
  }
  const total = (area + sub).length;
  if (!area || sub.length < 4 || total < 7 || total > 14) return null;
  return { country_code: `+${cc}`, area_code: area, subscriber_number: sub };
}

/** "257 3 13 <base64>" → Openprovider dnssec_keys. */
export function parseDnskey(s: string) {
  const [flags, protocol, alg, ...key] = s.trim().split(/\s+/);
  if (!key.length) return null;
  return { flags: Number(flags), protocol: Number(protocol), alg: Number(alg), pub_key: key.join("") };
}

export { txtRecord, subnameOf, temRecords } from "../tem.js";
import { txtRecord, subnameOf, temRecords } from "../tem.js";

// ───────── Zone en records (ook gebruikt bij overstappen: dns-vrijgeven en dns-terug) ─────────

/**
 * De zone staat nog bij een andere aanbieder (deSEC-zonenamen zijn uniek over alle accounts): wachten tot die
 * hem vrijgeeft. Tijdelijk (geen mislukte bestelling) en zonder oplopende wachttijd; zie provisionOrder.
 */
export class WaitError extends ApiError {
  constructor(readonly detail: string) { super("deSEC", 409, detail); }
  override get permanent() { return false; }
}
export const WAIT_RELEASE = "Wacht tot je vorige aanbieder je DNS vrijgeeft";

/** Zone in ons deSEC-account: bestaande ophalen, anders aanmaken. Staat hij in een ander account, dan WaitError. */
export async function ensureZone(ctx: Ctx, o: OrderRow) {
  let z = await ctx.apis.desec.getZone(o.domain);
  if (z) return z;
  try { z = await ctx.apis.desec.createZone(o.domain); }
  catch (e) {
    // Bestaat al (bijv. na een onderbroken poging)? Dan alsnog ophalen.
    if (e instanceof ApiError && (e.status === 409 || e.status === 400)) z = await ctx.apis.desec.getZone(o.domain);
    // Niet in ons account maar wel bezet: bij een andere aanbieder (overstappen) of iemand anders.
    if (!z && e instanceof ApiError && (e.status === 409 || (e.status === 400 && /conflict|exist|unavailable|already|bezet/i.test(e.message)))) throw new WaitError(WAIT_RELEASE);
    if (!z) throw e;
  }
  return z;
}

/** DKIM (en DMARC als die er nog niet is) van het maildomein bij Scaleway in de zone van de klant. */
export async function writeMailRecords(ctx: Ctx, o: OrderRow, dom: unknown, projectId: string) {
  const rec = temRecords(dom as never, projectId);
  const desec = desecFor(ctx, o);
  const rrsets: { subname: string; type: string; ttl: number; records: string[] }[] = [];
  if (rec.dkim) rrsets.push({ subname: subnameOf(rec.dkim.name, o.domain), type: "TXT", ttl: 3600, records: [txtRecord(rec.dkim.value)] });
  if (rec.dmarc) {
    const sub = subnameOf(rec.dmarc.name || "_dmarc", o.domain);
    if (!(await desec.getRrset(o.domain, sub, "TXT"))) rrsets.push({ subname: sub, type: "TXT", ttl: 3600, records: [txtRecord(rec.dmarc.value)] });
  }
  // Geen SPF hier: het cluster beheert het apex-TXT-record zelf en voegt spfExtra toe.
  if (rrsets.length) await desec.putRrsets(o.domain, rrsets);
  return rec;
}

/**
 * Certificaten (Let's Encrypt, DNS-01) gaan via ons acme-dns-adres: de uitdagingen voor cloud. en mail.
 * wijzen naar _acme.<domein>; alleen dat ene TXT-record kan de server via ons bijwerken.
 */
export async function writeAcmeCnames(ctx: Ctx, o: OrderRow) {
  await desecFor(ctx, o).putRrsets(o.domain, ["cloud", "mail"].map((h) => ({ subname: `_acme-challenge.${h}`, type: "CNAME", ttl: 3600, records: [`_acme.${o.domain}.`] })));
}

// ───────── De stappen ─────────

type StepFn = (ctx: Ctx, o: OrderRow) => Promise<string | undefined>;

const STEPS: [string, StepFn][] = [
  ["dns-zone", async (ctx, o) => {
    if (isCentral(o)) {
      // Gratis adres van de adressendienst: die maakt de zone (in het centrale account) en geeft ons een token voor alleen die zone.
      const adres = ctx.apis.adres;
      if (!adres) throw new ApiError("Dienst", 400, "Deze dienst is niet (meer) gekoppeld aan de adressendienst (BROKER_ADRES_URL)");
      if (readSecrets(ctx, o).zoneToken) return undefined;
      const transferCode = readInput(ctx, o).transferCode;
      const label = o.domain.slice(0, o.domain.indexOf("."));
      const r = transferCode ? await adres.transfer(o.domain, transferCode, o.id) : await adres.create(label, o.id);
      if (!r?.token || !r?.overdrachtscode || r.naam !== o.domain) throw new ApiError("Adressendienst", 502, "De adressendienst gaf geen bruikbaar antwoord");
      writeSecrets(ctx, o.id, { zoneToken: r.token, transferCode: r.overdrachtscode });
      patchState(ctx.db, o.id, { zone: true, adresMovedIn: !!transferCode });
      event(ctx.db, o.id, transferCode ? "adres-overgenomen" : "adres-aangevraagd", { naam: r.naam });
      return transferCode ? "Je adres is overgenomen, met al je DNS-records" : "Je adres is aangevraagd bij de adressendienst";
    }
    const z = await ensureZone(ctx, o);
    const dnskeys = ((z.keys ?? []) as any[]).map((k) => k.dnskey).filter(Boolean);
    const ds = ((z.keys ?? []) as any[]).flatMap((k) => k.ds ?? []).filter(Boolean);
    patchState(ctx.db, o.id, { zone: true, dnskeys, ds });
    return dnskeys.length ? "Zone aangemaakt, met DNSSEC" : "Zone aangemaakt";
  }],

  ["domain", async (ctx, o) => {
    if (o.domain_mode === "own") return `Zet bij je eigen registrar de nameservers op ${NAMESERVERS.join(" en ")}`;
    if (isCentral(o)) return "Je adres werkt"; // de adressendienst heeft de verwijzing (NS/DS) al gezet
    if (o.domain_mode === "sub") {
      // Gratis adres: in de zone van de dienst naar de eigen zone van de klant wijzen (NS), met DNSSEC (DS).
      const parent = ctx.cfg.freeZone;
      if (!parent || !o.domain.endsWith(`.${parent}`)) throw new ApiError("Dienst", 400, "Gratis adressen staan uit bij deze dienst");
      const label = o.domain.slice(0, -(parent.length + 1));
      const ds = (orderState(o).ds ?? []) as string[];
      await ctx.apis.desec.putRrsets(parent, [
        { subname: label, type: "NS", ttl: 3600, records: NAMESERVERS.map((n) => `${n}.`) },
        ...(ds.length ? [{ subname: label, type: "DS", ttl: 3600, records: ds }] : []),
      ]);
      return ds.length ? "Je adres werkt, met DNSSEC" : "Je adres werkt";
    }
    const st = orderState(o);
    const op = ctx.apis.openprovider;
    const transferMsg = "Verhuizing aangevraagd. Je huidige registrar moet die nog goedkeuren; dat duurt meestal een paar dagen";
    if (st.opDomainId) return o.domain_mode === "transfer" ? transferMsg : "Geregistreerd";
    const existing = await op.req("GET", `/domains?full_name=${encodeURIComponent(o.domain)}&limit=1`);
    const found = (existing?.data?.results ?? []).find((d: any) => `${d.domain?.name}.${d.domain?.extension}` === o.domain || d.full_name === o.domain);
    if (found?.id) { patchState(ctx.db, o.id, { opDomainId: found.id }); return o.domain_mode === "transfer" ? transferMsg : "Geregistreerd"; }

    const input = readInput(ctx, o);
    const r = input.registrant;
    if (!r) throw new ApiError("Dienst", 400, "Gegevens van de houder ontbreken");
    let handle: string = st.opHandle;
    if (!handle) {
      const phone = parsePhone(r.phone);
      if (!phone) throw new ApiError("Dienst", 400, "Telefoonnummer van de houder klopt niet");
      const initials = `${r.firstName.split(/\s+/).map((p) => p[0]?.toUpperCase()).filter(Boolean).join(".")}.`;
      const c = await op.req("POST", "/customers", {
        name: { first_name: r.firstName, last_name: r.lastName, initials },
        address: { street: r.street, number: r.number, zipcode: r.zipcode, city: r.city, country: r.country.toUpperCase() },
        phone, email: r.email, ...(r.company ? { company_name: r.company } : {}),
      });
      handle = c?.data?.handle;
      if (!handle) throw new ApiError("Openprovider", 502, "Openprovider gaf geen klant-handle terug");
      patchState(ctx.db, o.id, { opHandle: handle });
    }
    const keys = ((st.dnskeys ?? []) as string[]).map(parseDnskey).filter(Boolean);
    const body: Record<string, unknown> = {
      domain: splitDomain(o.domain),
      owner_handle: handle, admin_handle: handle, tech_handle: handle, billing_handle: handle,
      period: 1, autorenew: "on",
      name_servers: NAMESERVERS.map((name) => ({ name })),
      is_dnssec_enabled: keys.length > 0,
      ...(keys.length ? { dnssec_keys: keys } : {}),
    };
    // Aanname: een create mét auth_code is bij Openprovider een verhuizing (zie BROKER.md).
    if (o.domain_mode === "transfer") body.auth_code = input.authCode;
    const d = await op.req("POST", "/domains", body);
    const id = d?.data?.id;
    if (!id) throw new ApiError("Openprovider", 502, "Openprovider gaf geen domein-id terug");
    patchState(ctx.db, o.id, { opDomainId: id, opDomainStatus: d?.data?.status ?? null });
    return o.domain_mode === "transfer" ? transferMsg : "Geregistreerd";
  }],

  ["scaleway-project", async (ctx, o) => {
    const scw = ctx.apis.scaleway;
    const st = orderState(o);
    if (st.projectId) return undefined;
    const name = resourceName(o);
    const list = await scw.req("GET", `/account/v3/projects?organization_id=${encodeURIComponent(scw.organizationId)}&name=${encodeURIComponent(name)}`);
    let id = (list?.projects ?? []).find((p: any) => p.name === name)?.id;
    if (!id) id = (await scw.req("POST", "/account/v3/projects", { name, organization_id: scw.organizationId, description: `Eigen Cloud voor ${o.domain} (bestelling ${o.id})` }))?.id;
    if (!id) throw new ApiError("Scaleway", 502, "Scaleway gaf geen project-id terug");
    patchState(ctx.db, o.id, { projectId: id });
    return undefined;
  }],

  ["scaleway-iam", async (ctx, o) => {
    const scw = ctx.apis.scaleway;
    const org = encodeURIComponent(scw.organizationId);
    let st = orderState(o);
    const name = resourceName(o);
    if (!st.applicationId) {
      const list = await scw.req("GET", `/iam/v1alpha1/applications?organization_id=${org}&name=${encodeURIComponent(name)}`);
      let id = (list?.applications ?? []).find((a: any) => a.name === name)?.id;
      if (!id) id = (await scw.req("POST", "/iam/v1alpha1/applications", { name, organization_id: scw.organizationId, description: `Eigen Cloud ${o.domain}: alleen project ${st.projectId}` }))?.id;
      if (!id) throw new ApiError("Scaleway", 502, "Scaleway gaf geen applicatie-id terug");
      st = patchState(ctx.db, o.id, { applicationId: id });
    }
    if (!st.policyId) {
      // De API filtert op application_ids (scaleway-sdk-go iam/v1alpha1 ListPolicies); zelf nog eens op de applicatie,
      // anders zou een policy van een andere klant (of van de Dienst) gekozen kunnen worden.
      const list = await scw.req("GET", `/iam/v1alpha1/policies?organization_id=${org}&application_ids=${encodeURIComponent(st.applicationId)}`);
      let id = (list?.policies ?? []).find((p: any) => p.application_id === st.applicationId)?.id;
      if (!id) id = (await scw.req("POST", "/iam/v1alpha1/policies", {
        name, organization_id: scw.organizationId, application_id: st.applicationId,
        description: `Alleen project ${st.projectId}`,
        rules: [{ permission_set_names: scw.permissionSets, project_ids: [st.projectId] }],
      }))?.id;
      if (!id) throw new ApiError("Scaleway", 502, "Scaleway gaf geen policy-id terug");
      st = patchState(ctx.db, o.id, { policyId: id });
    }
    if (!readSecrets(ctx, getOrder(ctx.db, o.id)!).apiKey) await newApiKey(ctx, o.id);
    return "Werkt alleen binnen jouw eigen project";
  }],

  ["mail", async (ctx, o) => {
    const scw = ctx.apis.scaleway;
    let st = orderState(o);
    const base = "/transactional-email/v1alpha1/regions/fr-par/domains";
    let dom: any = null;
    if (st.temDomainId) dom = await scw.reqOr404("GET", `${base}/${st.temDomainId}`);
    if (!dom) {
      const list = await scw.req("GET", `${base}?project_id=${encodeURIComponent(st.projectId)}&name=${encodeURIComponent(o.domain)}`);
      dom = (list?.domains ?? []).find((d: any) => d.name === o.domain && d.status !== "revoked") ?? null;
    }
    if (!dom) dom = await scw.req("POST", base, { project_id: st.projectId, domain_name: o.domain, accept_tos: true });
    if (!dom?.id) throw new ApiError("Scaleway", 502, "Scaleway gaf geen maildomein-id terug");
    st = patchState(ctx.db, o.id, { temDomainId: dom.id });

    const rec = await writeMailRecords(ctx, o, dom, st.projectId);
    patchState(ctx.db, o.id, { spfExtra: rec.spfExtra });
    // Laat Scaleway de records controleren; dat gebeurt op de achtergrond en houdt "klaar" niet op.
    await scw.req("POST", `${base}/${dom.id}/check`, {}).catch((e) => event(ctx.db, o.id, "tem-check", (e as Error).message));
    return rec.dkim ? "Handtekening (DKIM) staat in je DNS" : "Maildomein aangemeld";
  }],

  ["dns-token", async (ctx, o) => {
    await writeAcmeCnames(ctx, o);
    const s = readSecrets(ctx, o);
    if (s.dnsToken && o.dns_token_hash === sha256(s.dnsToken)) return undefined;
    const token = crypto.randomBytes(32).toString("hex");
    writeSecrets(ctx, o.id, { dnsToken: token });
    ctx.db.prepare("UPDATE orders SET dns_token_hash = ? WHERE id = ?").run(sha256(token), o.id);
    return undefined;
  }],

  ["ready", async (ctx, o) => {
    saveKit(ctx, o.id);
    return undefined;
  }],
];

/** Nieuwe projectgebonden API-sleutel. Oude sleutels van de applicatie (zonder bekend geheim) gaan weg. */
export async function newApiKey(ctx: Ctx, orderId: string) {
  const scw = ctx.apis.scaleway;
  const st = orderState(getOrder(ctx.db, orderId)!);
  const list = await scw.req("GET", `/iam/v1alpha1/api-keys?application_id=${encodeURIComponent(st.applicationId)}`);
  for (const k of list?.api_keys ?? []) await scw.reqOr404("DELETE", `/iam/v1alpha1/api-keys/${encodeURIComponent(k.access_key)}`);
  const k = await scw.req("POST", "/iam/v1alpha1/api-keys", { application_id: st.applicationId, default_project_id: st.projectId, description: `Eigen Cloud ${getOrder(ctx.db, orderId)!.domain}` });
  if (!k?.access_key || !k?.secret_key) throw new ApiError("Scaleway", 502, "Scaleway gaf geen API-sleutel terug");
  // Het geheim krijg je maar één keer: meteen versleuteld bewaren.
  writeSecrets(ctx, orderId, { apiKey: { accessKey: k.access_key, secretKey: k.secret_key } });
  patchState(ctx.db, orderId, { apiKeyAccess: k.access_key });
}

/** Stelt het pakket voor de console samen en bewaart het versleuteld. */
export function saveKit(ctx: Ctx, orderId: string): Kit {
  const o = getOrder(ctx.db, orderId)!;
  const st = orderState(o);
  const s = readSecrets(ctx, o);
  const b = bundleOf(ctx, o.bundle);
  if (!b) throw new ApiError("Dienst", 400, `Bundel ${o.bundle} bestaat niet meer`);
  if (!s.apiKey || !s.dnsToken || !st.projectId) throw new ApiError("Dienst", 500, "Pakket onvolledig: sleutel, DNS-token of project ontbreekt");
  const kit: Kit = {
    domain: o.domain,
    nameservers: NAMESERVERS,
    delegated: o.domain_mode === "register" || o.domain_mode === "sub",
    provider: { id: "scaleway", fields: { secretKey: s.apiKey.secretKey, projectId: st.projectId } },
    storage: b.storage.map((x) => ({ offer: "scaleway" as const, region: x.region, accessKey: s.apiKey!.accessKey, secretKey: s.apiKey!.secretKey, purpose: x.purpose })),
    placement: b.placement.map((p) => ({ provider: p.provider, region: p.region, size: p.size, country: p.country, kind: p.kind })),
    policy: { minDataNodes: b.includes.dataServers, witnesses: b.includes.witnesses },
    dns: {
      type: "desec", name: "dienst", token: s.dnsToken, zone: o.domain, api: `${ctx.cfg.publicUrl}/v1/desec`,
      acme: { username: o.id, password: s.dnsToken, subdomain: "_acme", server_url: `${ctx.cfg.publicUrl}/v1/acme-dns` },
      ...(isCentral(o) && s.transferCode ? { transferCode: s.transferCode } : {}),
    },
    mailRelay: b.includes.mail ? { host: "smtp.tem.scaleway.com", port: 587, user: st.projectId, password: s.apiKey.secretKey, secure: false } : null,
    spfExtra: st.spfExtra ?? "",
    users: b.includes.users + (o.extra_users ?? 0),
    // DNSSEC van de zone (niet bij een adres van de adressendienst): bij een eigen domein zet de klant deze DS-records bij zijn registrar.
    ...(!isCentral(o) && Array.isArray(st.ds) && st.ds.length ? { ds: st.ds as string[] } : {}),
  };
  ctx.db.prepare("UPDATE orders SET kit_enc = ? WHERE id = ?").run(ctx.secrets.seal(kit, `kit:${orderId}`), orderId);
  return kit;
}

/** Stappen die de DNS-zone niet nodig hebben: die lopen alvast door terwijl we op de vorige aanbieder wachten. */
const ZONE_FREE_STEPS = new Set(["scaleway-project", "scaleway-iam"]);

const LABEL_FAIL: Record<string, string> = {
  "dns-zone": "De DNS-zone kon niet worden aangemaakt",
  domain: "De domeinnaam kon niet worden geregeld",
  "scaleway-project": "Het project bij Scaleway kon niet worden aangemaakt",
  "scaleway-iam": "De toegangssleutel kon niet worden gemaakt",
  mail: "Mail versturen kon niet worden ingesteld",
  "dns-token": "De DNS-toegang kon niet worden gemaakt",
  ready: "Het pakket kon niet worden samengesteld",
};

/** Eén ronde klaarzetten. Geeft de nieuwe status terug. */
export function provisionOrder(ctx: Ctx, orderId: string) {
  return withLock(orderId, async () => {
    let o = getOrder(ctx.db, orderId);
    if (!o || !["paid", "provisioning"].includes(o.status)) return o?.status;
    if (o.status === "paid") setStatus(ctx.db, o.id, "provisioning");
    const done = new Set(getSteps(ctx.db, o.id).filter((s) => s.state === "done").map((s) => s.id));
    /** Wachten op de vorige aanbieder (zone nog daar): alleen stappen doen die de zone niet nodig hebben. */
    let waiting: string | null = null;
    for (const [id, fn] of STEPS) {
      if (done.has(id)) continue;
      if (waiting && !ZONE_FREE_STEPS.has(id)) continue;
      o = getOrder(ctx.db, orderId)!;
      // Wachten we al op de vorige aanbieder? Dan blijft dat zichtbaar terwijl we opnieuw kijken.
      setStep(ctx.db, o.id, id, "busy", id === "dns-zone" && orderState(o).waitingSince && !orderState(o).zone ? WAIT_RELEASE : undefined);
      try {
        const detail = await fn(ctx, o);
        setStep(ctx.db, o.id, id, "done", detail);
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof WaitError) {
          // Geen fout: snel opnieuw kijken, zonder oplopende wachttijd en zonder mail na 10 keer.
          const ws = orderState(o);
          if (!ws.waitingSince) { patchState(ctx.db, o.id, { waitingSince: Date.now() }); event(ctx.db, o.id, "wacht-op-dns", msg); }
          else if (!ws.waitMailed && Date.now() - ws.waitingSince > 24 * 3600_000) {
            patchState(ctx.db, o.id, { waitMailed: true });
            await trySend(ctx.mail, ctx.cfg.adminEmail, `Wacht al een dag op DNS: ${o.domain}`, `Bestelling ${o.id} (${o.domain}) wacht al een dag tot de DNS-zone bij deSEC vrijkomt. Die staat in een ander deSEC-account: bij de vorige aanbieder van de klant, of bij iemand anders.`);
          }
          setStep(ctx.db, o.id, id, "busy", e.detail);
          ctx.db.prepare("UPDATE orders SET next_attempt_at = ? WHERE id = ?").run(Date.now() + ctx.cfg.loopMs, o.id);
          waiting = e.detail;
          continue;
        }
        event(ctx.db, o.id, `step-${id}-error`, msg);
        if (isPermanent(e)) {
          const text = `${LABEL_FAIL[id] ?? "Er ging iets mis"}: ${msg}`;
          setStep(ctx.db, o.id, id, "fail", text);
          setStatus(ctx.db, o.id, "failed", text);
          await trySend(ctx.mail, ctx.cfg.adminEmail, `Klaarzetten mislukt: ${o.domain}`, `Bestelling ${o.id} (${o.domain}) bleef steken bij stap '${id}':\n\n${msg}\n\nNa het oplossen: npm run dienst:cli -- opnieuw ${o.id}`);
          return "failed";
        }
        const attempts = o.attempts + 1;
        const wait = Math.min(ctx.cfg.loopMs * 2 ** Math.min(attempts - 1, 6), 3600_000);
        ctx.db.prepare("UPDATE orders SET attempts = ?, next_attempt_at = ? WHERE id = ?").run(attempts, Date.now() + wait, o.id);
        setStep(ctx.db, o.id, id, "busy", "Lukte nog niet; we proberen het zo opnieuw");
        if (attempts === 10) await trySend(ctx.mail, ctx.cfg.adminEmail, `Klaarzetten loopt vast: ${o.domain}`, `Bestelling ${o.id} lukt al 10 keer niet bij stap '${id}':\n\n${msg}`);
        return "provisioning";
      }
    }
    if (waiting) return "provisioning";
    ctx.db.prepare("UPDATE orders SET attempts = 0, next_attempt_at = 0 WHERE id = ?").run(orderId);
    setStatus(ctx.db, orderId, "ready");
    event(ctx.db, orderId, "ready");
    o = getOrder(ctx.db, orderId)!;
    const cust = getCustomer(ctx.db, o.customer_id)!;
    await trySend(ctx.mail, cust.email, "Je cloud staat klaar om te starten",
      `Hallo,\n\nAlles voor ${o.domain} is geregeld: servers, opslag, DNS en mail.\n\nOpen de Eigen Cloud-app of je beheerconsole en kies "Starten". Je cloud wordt dan in een paar minuten gebouwd. Je hoofdsleutel maak je zelf aan; die komt nooit bij ons.\n\nGroet,\nEigen Cloud Dienst`);
    return "ready";
  });
}

/** Alle bestellingen die (weer) aan de beurt zijn. */
export async function provisionDue(ctx: Ctx) {
  const due = ctx.db.prepare("SELECT id FROM orders WHERE status IN ('paid','provisioning') AND next_attempt_at <= ?").all(Date.now()) as { id: string }[];
  for (const { id } of due) await provisionOrder(ctx, id).catch((e) => console.error(`[dienst] klaarzetten ${id}: ${(e as Error).message}`));
}
