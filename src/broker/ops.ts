/** Beheerhandelingen: opzeggen (klant), opschorten, hervatten, opnieuw proberen en opruimen (CLI). */
import { type OrderRow, getOrder, getCustomer, orderState, patchState, setStatus, event } from "./db.js";
import { type Ctx, bundleOf, setStep, getSteps, withLock, paidThrough, todayNl } from "./context.js";
import { newApiKey, saveKit, provisionOrder, writeSecrets, isCentral, readSecrets } from "./provision.js";
import { ApiError } from "./apis.js";
import { trySend } from "./mail.js";

export async function cancelOrder(ctx: Ctx, orderId: string) {
  return withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (o.status === "cancelled") return { endsAt: o.ends_at ?? todayNl() };
    const cust = getCustomer(ctx.db, o.customer_id)!;
    if (o.mollie_subscription_id && cust.mollie_customer_id) {
      try { await ctx.apis.mollie.cancelSubscription(cust.mollie_customer_id, o.mollie_subscription_id); }
      catch (e) { if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e; }
    }
    const endsAt = o.paid_at ? paidThrough(o.subscription_start) : todayNl();
    ctx.db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, ends_at = ? WHERE id = ?").run(Date.now(), endsAt, o.id);
    event(ctx.db, o.id, "cancelled", { endsAt });
    if (o.paid_at) {
      await trySend(ctx.mail, cust.email, "Je abonnement is opgezegd",
        `Hallo,\n\nJe abonnement voor ${o.domain} is opgezegd. Er wordt niets meer afgeschreven. Alles blijft werken tot ${endsAt}; daarna bewaren we je gegevens nog 30 dagen, zodat je ze kunt meenemen.\n\nWil je je domeinnaam houden? Vraag dan een verhuiscode aan, dan zetten we die voor je klaar.\n\nGroet,\nEigen Cloud Dienst`);
      await trySend(ctx.mail, ctx.cfg.adminEmail, `Opgezegd: ${o.domain}`, `Bestelling ${o.id} (${cust.email}) loopt af op ${endsAt}. Opruimen daarna: npm run dienst:cli -- opruimen ${o.id} --zeker`);
    }
    return { endsAt };
  });
}

export async function projectServers(ctx: Ctx, o: OrderRow) {
  const st = orderState(o);
  const b = bundleOf(ctx, o.bundle);
  const zones = [...new Set([...(b?.placement.map((p) => p.region) ?? []), "nl-ams-1", "nl-ams-2", "nl-ams-3", "fr-par-1", "fr-par-2", "pl-waw-1"])];
  const out: { zone: string; id: string; state: string; name: string; type: string | null; created: string | null }[] = [];
  for (const zone of zones) for (const s of await ctx.apis.scaleway.servers(zone, st.projectId)) out.push({ zone, id: s.id, state: s.state, name: s.name, type: s.commercial_type ?? null, created: s.creation_date ?? null });
  return out;
}

/** Sleutel intrekken en servers uitzetten. Gegevens blijven staan. */
export async function suspendOrder(ctx: Ctx, orderId: string) {
  return withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    const st = orderState(o);
    const log: string[] = [];
    if (st.apiKeyAccess) {
      await ctx.apis.scaleway.reqOr404("DELETE", `/iam/v1alpha1/api-keys/${encodeURIComponent(st.apiKeyAccess)}`);
      patchState(ctx.db, o.id, { apiKeyAccess: null });
      writeSecrets(ctx, o.id, { apiKey: undefined });
      log.push(`API-sleutel ${st.apiKeyAccess} ingetrokken`);
    }
    if (st.projectId) {
      for (const s of await projectServers(ctx, o)) {
        if (s.state !== "running") continue;
        await ctx.apis.scaleway.serverAction(s.zone, s.id, "poweroff");
        log.push(`Server ${s.name || s.id} (${s.zone}) uitgezet`);
      }
    }
    patchState(ctx.db, o.id, { suspendedFrom: o.status });
    setStatus(ctx.db, o.id, "suspended", "Opgeschort");
    event(ctx.db, o.id, "suspended", log);
    const cust = getCustomer(ctx.db, o.customer_id)!;
    await trySend(ctx.mail, cust.email, "Je cloud is opgeschort",
      `Hallo,\n\nJe cloud voor ${o.domain} is opgeschort en de servers staan uit. Je gegevens blijven bewaard.\n\nNeem contact met ons op om hem weer aan te zetten.\n\nGroet,\nEigen Cloud Dienst`);
    return log;
  });
}

/** Nieuwe sleutel en pakket; de console haalt het nieuwe pakket op en start de servers weer. */
export async function resumeOrder(ctx: Ctx, orderId: string) {
  return withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (o.status !== "suspended") throw new Error(`Bestelling staat op '${o.status}', niet op opgeschort`);
    await newApiKey(ctx, o.id);
    const ready = !!o.kit_enc;
    if (ready) saveKit(ctx, o.id);
    setStatus(ctx.db, o.id, ready ? "ready" : "provisioning");
    event(ctx.db, o.id, "resumed");
    const cust = getCustomer(ctx.db, o.customer_id)!;
    await trySend(ctx.mail, cust.email, "Je cloud kan weer aan",
      `Hallo,\n\nJe cloud voor ${o.domain} is niet langer opgeschort. Open je beheerconsole of de app: die haalt de nieuwe toegang op en zet je servers weer aan.\n\nGroet,\nEigen Cloud Dienst`);
    return ready ? "ready" : "provisioning";
  });
}

/** Mislukte bestelling opnieuw proberen vanaf de stap die misging. */
export async function retryOrder(ctx: Ctx, orderId: string) {
  await withLock(orderId, async () => {
    const o = getOrder(ctx.db, orderId)!;
    if (o.status !== "failed" && o.status !== "provisioning") throw new Error(`Bestelling staat op '${o.status}'; alleen 'failed' of 'provisioning' kan opnieuw`);
    for (const s of getSteps(ctx.db, o.id)) if (s.state === "fail" || s.state === "busy") setStep(ctx.db, o.id, s.id, "wait");
    ctx.db.prepare("UPDATE orders SET status = 'provisioning', error = NULL, attempts = 0, next_attempt_at = 0 WHERE id = ?").run(o.id);
    event(ctx.db, o.id, "retry");
  });
  return provisionOrder(ctx, orderId);
}

/**
 * Na opzegging: IAM-applicatie (met sleutels en policy) en maildomein weg. Een gratis adres van de
 * adressendienst blijft bewust staan: de klant kan het met zijn overdrachtscode naar een andere aanbieder
 * meenemen. Vrijgeven kan daarna met releaseAdres (dienst:cli -- adres-vrijgeven). Zonder `sure` alleen
 * een overzicht van wat er zou gebeuren. Servers, volumes en buckets: zie BROKER.md (handmatig).
 */
export async function cleanupOrder(ctx: Ctx, orderId: string, sure: boolean) {
  const o = getOrder(ctx.db, orderId)!;
  if (o.status !== "cancelled") throw new Error(`Alleen een opgezegde bestelling kan worden opgeruimd (deze staat op '${o.status}')`);
  const st = orderState(o);
  const scw = ctx.apis.scaleway;
  const plan: string[] = [];
  if (st.policyId) plan.push(`IAM-policy ${st.policyId} verwijderen`);
  if (st.applicationId) plan.push(`IAM-applicatie ${st.applicationId} verwijderen (met alle API-sleutels)`);
  if (st.temDomainId) plan.push(`Maildomein ${st.temDomainId} intrekken`);
  plan.push("DNS-toegang van het cluster intrekken");
  const servers = st.projectId ? await projectServers(ctx, o).catch(() => []) : [];
  const manual = [
    ...servers.map((s) => `Server ${s.name || s.id} (${s.zone}, ${s.state}) — zelf verwijderen in de Scaleway-console (met volumes)`),
    ...(st.projectId ? [`Buckets in project ${st.projectId} — eerst leegmaken (object-lock!), daarna het project verwijderen`] : []),
    isCentral(o)
      ? `Gratis adres ${o.domain} blijft bij de adressendienst op jouw naam staan, zodat de klant het met zijn overdrachtscode kan meenemen. Niet meer nodig? npm run dienst:cli -- adres-vrijgeven ${o.id} --zeker`
      : `DNS-zone ${o.domain} bij deSEC en de domeinnaam bij Openprovider blijven staan tot de klant verhuist of de domeinnaam vervalt`,
  ];
  if (!sure) return { done: [] as string[], plan, manual };
  const done: string[] = [];
  return withLock(orderId, async () => {
    if (st.policyId) { await scw.reqOr404("DELETE", `/iam/v1alpha1/policies/${st.policyId}`); done.push("IAM-policy verwijderd"); }
    if (st.applicationId) { await scw.reqOr404("DELETE", `/iam/v1alpha1/applications/${st.applicationId}`); done.push("IAM-applicatie en sleutels verwijderd"); }
    if (st.temDomainId) { await scw.reqOr404("POST", `/transactional-email/v1alpha1/regions/fr-par/domains/${st.temDomainId}/revoke`, {}); done.push("Maildomein ingetrokken"); }
    ctx.db.prepare("UPDATE orders SET dns_token_hash = NULL, kit_enc = NULL WHERE id = ?").run(o.id);
    writeSecrets(ctx, o.id, { apiKey: undefined, dnsToken: undefined });
    patchState(ctx.db, o.id, { policyId: null, applicationId: null, apiKeyAccess: null, temDomainId: null, cleanedAt: Date.now() });
    done.push("DNS-toegang en pakket gewist");
    event(ctx.db, o.id, "cleanup", done);
    return { done, plan, manual };
  });
}

/**
 * Gratis adres van een opgezegde bestelling teruggeven aan de adressendienst: zone, verwijzing en ons token
 * gaan weg; na 30 dagen kan iemand anders de naam krijgen. Zonder `sure` alleen wat er zou gebeuren.
 */
export async function releaseAdres(ctx: Ctx, orderId: string, sure: boolean) {
  const o = getOrder(ctx.db, orderId)!;
  if (!isCentral(o)) throw new Error("Deze bestelling heeft geen gratis adres van de adressendienst");
  if (o.status !== "cancelled") throw new Error(`Alleen bij een opgezegde bestelling (deze staat op '${o.status}')`);
  if (!ctx.apis.adres) throw new Error("BROKER_ADRES_URL is niet ingesteld");
  const plan = [`${o.domain} vrijgeven bij de adressendienst: de zone met alle records van de klant wordt verwijderd`, "De naam is na 30 dagen weer vrij voor anderen"];
  if (!sure) return { done: [] as string[], plan };
  return withLock(orderId, async () => {
    if (!readSecrets(ctx, o).zoneToken) throw new Error("Dit adres is al vrijgegeven of overgenomen");
    let r: { vrijVanaf?: string } | null = null;
    try { r = await ctx.apis.adres!.release(o.domain); }
    catch (e) {
      // 403: inmiddels bij een andere aanbieder (de klant is overgestapt); 404: al vrijgegeven.
      if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) throw e;
    }
    writeSecrets(ctx, o.id, { zoneToken: undefined, transferCode: undefined });
    patchState(ctx.db, o.id, { adresReleasedAt: Date.now() });
    event(ctx.db, o.id, "adres-vrijgegeven", r ?? "al weg of overgenomen");
    return { done: [r ? `${o.domain} vrijgegeven; weer beschikbaar vanaf ${r.vrijVanaf?.slice(0, 10)}` : `${o.domain} was al vrijgegeven of hoort nu bij een andere aanbieder`], plan };
  });
}
