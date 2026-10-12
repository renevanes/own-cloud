import type { OverstapState } from "./overstap.js";

export function transferPreview(o: OverstapState, ready: boolean, minutes: number) {
  const copy = o.kopie as (OverstapState["kopie"] & { verified?: number }) | undefined;
  const cutover = o.stap === "terug" ? "returning" : o.stap === "teruggezet" ? "source" : o.gedaan.includes("wekken") || o.stap === "klaar" ? "destination" : ["overzetten", "mislukt"].includes(o.stap) ? "moving" : "source";
  return { contractVersion: 1, destination: { name: o.naarNaam, monthly: o.bestelling?.monthly ?? null }, estimatedOfflineMinutes: minutes, ready,
    cutover, integrity: { method: "sha256", objectsVerified: copy?.verified ?? 0, objectsTotal: copy?.objects ?? o.schatting?.objects ?? null,
      complete: !!copy && copy.done === copy.objects && copy.verified === copy.objects } };
}
