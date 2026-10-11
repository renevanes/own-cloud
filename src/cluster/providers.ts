/**
 * Servers bij cloudaanbieders. De adapters zelf staan in src/cluster/adapters/ en worden opgesomd in de registry
 * (src/cluster/adapters.ts); dit bestand houdt de bestaande namen werkend.
 *
 * ⚠️ De adapters volgen de publieke API-documentatie en zijn getest tegen nagebootste API's, niet tegen live
 *    accounts; test ze eerst met `eigen provider-test <naam>`. Zie PROVIDERS.md per aanbieder.
 */
import { getAdapter } from "./adapters.js";
import type { Provider } from "./adapters/types.js";

export type { CreateSpec, ServerInfo, Provider } from "./adapters/types.js";
export { HetznerProvider } from "./adapters/hetzner.js";
export { ScalewayProvider, scwApi } from "./adapters/scaleway.js";
export { UpCloudProvider } from "./adapters/upcloud.js";
export { ExoscaleProvider } from "./adapters/exoscale.js";
export { OvhProvider } from "./adapters/ovh.js";
export { LocalProvider } from "./adapters/local.js";

/** Provider voor config.providers[name] (met `type` kun je een andere naam dan de adapter-id gebruiken). */
export function makeProvider(name: string, cfg: Record<string, string>): Provider {
  const a = getAdapter(cfg.type ?? name);
  if (!a?.servers) throw new Error(`Onbekende aanbieder ${name}`);
  return a.servers.create(cfg);
}
