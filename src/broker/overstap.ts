/**
 * Overstappen naar een andere aanbieder: wat de Dienst van de vorige (of, bij teruggaan, de nieuwe) aanbieder
 * daarvoor doet. De console van de klant regelt de rest (slapen, gegevens overzetten, wekken).
 *
 * deSEC-zonenamen zijn uniek over alle accounts: een eigen of via ons geregistreerd domein kan pas bij de nieuwe
 * aanbieder komen als wij de zone weghalen (dns-vrijgeven). De nieuwe aanbieder wacht daarop (WaitError in de
 * stap dns-zone). Gaat het overstappen mis, dan zet dns-terug alles weer bij ons.
 */
import { ApiError } from "./apis.js";
import { getOrder, orderState, patchState, event } from "./db.js";
import { type Ctx, withLock } from "./context.js";
import { UserError } from "./billing.js";
import { ensureZone, isCentral, parseDnskey, saveKit, WaitError, writeAcmeCnames, writeMailRecords, writeSecrets } from "./provision.js";

const LIVE = ["ready", "payment_problem", "suspended"];

async function opDomainId(ctx: Ctx, orderId: string): Promise<number | string | null> {
  const o = getOrder(ctx.db, orderId)!;
  const st = orderState(o);
  if (st.opDomainId) return st.opDomainId;
  const id = await ctx.apis.openprovider.findDomainId(o.domain);
  if (id) patchState(ctx.db, o.id, { opDomainId: id });
  return id;
}

/**
 * DNS-zone vrijgeven (alleen eigen domein of via ons geregistreerd/verhuisd). Zolang de cloud bij ons draait alleen
 * met {overstap: true}. Bij een domein dat wij registreerden gaat eerst DNSSEC bij het register uit, zodat het domein
 * met de nieuwe sleutels van de nieuwe aanbieder bereikbaar blijft. Nog eens aanroepen kan (verandert dan niets).
 */
export async function dnsRelease(ctx: Ctx, orderId: string, body: { overstap?: unknown }) {
  return withLock(`dns:${orderId}`, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (o.domain_mode === "sub") {
      throw new UserError(400, isCentral(o)
        ? "Een gratis adres van de adressendienst neem je mee met je overdrachtscode; vrijgeven is niet nodig"
        : "Een gratis adres van deze aanbieder kan niet mee naar een andere aanbieder");
    }
    if (![...LIVE, "cancelled"].includes(o.status)) throw new UserError(409, "Je abonnement is nog niet klaar");
    const st = orderState(o);
    if (LIVE.includes(o.status) && body?.overstap !== true && !st.dnsReleasedAt) {
      throw new UserError(409, "Je cloud gebruikt deze DNS nog. Geef hem alleen vrij als je overstapt naar een andere aanbieder.");
    }
    let dnssec: "uitgezet" | "zelf" | "mislukt" = "zelf";
    if (o.domain_mode === "register" || o.domain_mode === "transfer") {
      if (st.dnssecOff) dnssec = "uitgezet";
      else {
        try {
          const id = await opDomainId(ctx, o.id);
          if (!id) throw new Error("domein niet gevonden bij Openprovider");
          await ctx.apis.openprovider.setDnssec(id, null);
          patchState(ctx.db, o.id, { dnssecOff: true });
          dnssec = "uitgezet";
        } catch (e) {
          dnssec = "mislukt";
          event(ctx.db, o.id, "dnssec-uit-error", (e as Error).message);
        }
      }
    }
    const removed = await ctx.apis.desec.deleteZone(o.domain);
    patchState(ctx.db, o.id, { dnsReleasedAt: st.dnsReleasedAt ?? Date.now(), zone: false });
    event(ctx.db, o.id, "dns-vrijgegeven", { removed, dnssec });
    return { ok: true, domain: o.domain, released: true, dnssec };
  });
}

/**
 * Terug na een mislukte overstap: de DNS weer bij ons. Gratis adres van de adressendienst: overnemen met de
 * (nieuwe) overdrachtscode van de klant. Eigen of geregistreerd domein: zone opnieuw maken (kan pas als de nieuwe
 * aanbieder hem heeft vrijgegeven), met de records die wij erin zetten (DKIM, acme), en DNSSEC weer aan.
 */
export async function dnsBack(ctx: Ctx, orderId: string, body: { transferCode?: unknown }) {
  return withLock(`dns:${orderId}`, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (!LIVE.includes(o.status)) throw new UserError(409, "Dit abonnement loopt niet (meer)");
    if (isCentral(o)) {
      const code = typeof body?.transferCode === "string" ? body.transferCode.trim() : "";
      if (!/^[A-Za-z0-9-]{16,40}$/.test(code)) throw new UserError(400, "Vul de overdrachtscode van je adres in");
      if (!ctx.apis.adres) throw new UserError(409, "Deze aanbieder is niet (meer) gekoppeld aan de adressendienst");
      let r;
      try { r = await ctx.apis.adres.transfer(o.domain, code, o.id); }
      catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 400)) throw new UserError(400, "Deze overdrachtscode klopt niet bij dit adres");
        if (e instanceof ApiError && e.status === 404) throw new UserError(404, `${o.domain} is niet (meer) in gebruik`);
        throw e;
      }
      writeSecrets(ctx, o.id, { zoneToken: r.token, transferCode: r.overdrachtscode });
      patchState(ctx.db, o.id, { adresBackAt: Date.now() });
      if (o.kit_enc) saveKit(ctx, o.id);
      event(ctx.db, o.id, "adres-terug", { naam: r.naam });
      return { ok: true, domain: o.domain, transferCode: r.overdrachtscode };
    }
    if (o.domain_mode === "sub") throw new UserError(400, "Dit adres is nooit vrijgegeven");
    let z;
    try { z = await ensureZone(ctx, o); }
    catch (e) {
      if (e instanceof WaitError) throw new UserError(409, "Je DNS staat nog bij de andere aanbieder. Die moet hem eerst vrijgeven.");
      throw e;
    }
    const dnskeys = ((z.keys ?? []) as { dnskey?: string }[]).map((k) => k.dnskey).filter((x): x is string => !!x);
    const ds = ((z.keys ?? []) as { ds?: string[] }[]).flatMap((k) => k.ds ?? []).filter(Boolean);
    patchState(ctx.db, o.id, { zone: true, dnskeys, ds });
    const fresh = getOrder(ctx.db, o.id)!;
    await writeAcmeCnames(ctx, fresh);
    const st = orderState(fresh);
    if (st.temDomainId && st.projectId) {
      const dom = await ctx.apis.scaleway.reqOr404("GET", `/transactional-email/v1alpha1/regions/fr-par/domains/${st.temDomainId}`);
      if (dom) await writeMailRecords(ctx, fresh, dom, st.projectId);
    }
    let dnssec: "aan" | "zelf" | "mislukt" = "zelf";
    if ((o.domain_mode === "register" || o.domain_mode === "transfer") && st.dnssecOff) {
      try {
        const id = await opDomainId(ctx, o.id);
        if (!id) throw new Error("domein niet gevonden bij Openprovider");
        await ctx.apis.openprovider.setDnssec(id, dnskeys.map(parseDnskey).filter((k): k is NonNullable<typeof k> => !!k));
        patchState(ctx.db, o.id, { dnssecOff: false });
        dnssec = "aan";
      } catch (e) {
        dnssec = "mislukt";
        event(ctx.db, o.id, "dnssec-aan-error", (e as Error).message);
      }
    }
    patchState(ctx.db, o.id, { dnsReleasedAt: null });
    if (fresh.kit_enc) saveKit(ctx, o.id);
    event(ctx.db, o.id, "dns-terug", { dnssec });
    // Bij een eigen domein: de nieuwe DS-records (andere sleutels dan vóór het vrijgeven) zet de klant bij zijn registrar.
    return { ok: true, domain: o.domain, ds, dnssec };
  });
}
