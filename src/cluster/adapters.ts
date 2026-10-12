/**
 * Registry van aanbieders — de ENIGE plek waar aanbieders opgesomd worden. makeProvider, makeDns, de catalogus
 * (STORE_OFFERS / SERVER_OFFERS / dnsOffers), fetchSizes, de beheerconsole en catalog.json voor de Android-app
 * worden hieruit afgeleid.
 *
 * Een aanbieder toevoegen: maak src/cluster/adapters/<id>.ts met één `ProviderAdapter`, zet hem hieronder in de
 * lijst, en schrijf tests tegen een nagebootste API (zie PROVIDERS.md en test/adapters.test.ts).
 */
import type { ProviderAdapter } from "./adapters/types.js";
import { scaleway } from "./adapters/scaleway.js";
import { hetzner } from "./adapters/hetzner.js";
import { upcloud } from "./adapters/upcloud.js";
import { exoscale } from "./adapters/exoscale.js";
import { ovh } from "./adapters/ovh.js";
import { openprovider } from "./adapters/openprovider.js";
import { desec } from "./adapters/desec.js";
import { custom } from "./adapters/custom.js";
import { local } from "./adapters/local.js";

export type * from "./adapters/types.js";

/** Volgorde = volgorde in de console (en bij gelijke keuze in de verspreidingsvoorstellen). */
const BUILTIN: ProviderAdapter[] = [desec, scaleway, hetzner, upcloud, exoscale, ovh, openprovider, custom, local];

const registry: ProviderAdapter[] = [...BUILTIN];

/** Alle aanbieders, inclusief de testaanbieder `local` (filter zelf op `testOnly` voor wat de gebruiker ziet). */
export function adapters(): readonly ProviderAdapter[] {
  return registry;
}

export function getAdapter(id: string): ProviderAdapter | undefined {
  return registry.find((a) => a.id === id);
}

/**
 * Een aanbieder toevoegen tijdens het draaien (tests, of een eigen build die er een adapter bij zet).
 * Vervangt een bestaande met dezelfde id. Geeft een functie terug die hem weer weghaalt.
 */
export function registerAdapter(a: ProviderAdapter): () => void {
  const i = registry.findIndex((x) => x.id === a.id);
  const before = i >= 0 ? registry[i] : undefined;
  if (i >= 0) registry[i] = a; else registry.push(a);
  return () => {
    const j = registry.indexOf(a);
    if (j < 0) return;
    if (before) registry[j] = before; else registry.splice(j, 1);
  };
}

/** Welke velden van een aanbieder geheim zijn (maskeren in de console). */
export function isSecretField(adapterId: string, key: string) {
  const a = getAdapter(adapterId);
  const f = [...(a?.fields ?? []), ...(a?.dns?.fields ?? [])].find((x) => x.key === key);
  return f ? !!f.secret : /token|secret|password|consumer/i.test(key);
}
