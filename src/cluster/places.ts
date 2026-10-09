/** Menselijke namen voor aanbieders en regio's (voor meldingen en het logboek). */
const PROVIDERS: Record<string, string> = { hetzner: "Hetzner", scaleway: "Scaleway", upcloud: "UpCloud", local: "Lokaal", manual: "Eigen server" };
const CITIES: Record<string, string> = {
  fsn1: "Falkenstein", nbg1: "Neurenberg", hel1: "Helsinki",
  "nl-ams-1": "Amsterdam", "nl-ams-2": "Amsterdam", "nl-ams-3": "Amsterdam", "fr-par-1": "Parijs", "fr-par-2": "Parijs", "fr-par-3": "Parijs", "pl-waw-1": "Warschau",
  "nl-ams1": "Amsterdam", "de-fra1": "Frankfurt", "fi-hel1": "Helsinki", "fi-hel2": "Helsinki", "se-sto1": "Stockholm",
  ams: "Amsterdam", fra: "Frankfurt", hel: "Helsinki",
};
export function place(n: { provider: string; region?: string | null; kind?: string }) {
  const city = n.region ? CITIES[n.region] ?? n.region : "";
  return `${PROVIDERS[n.provider] ?? n.provider}${city ? " " + city : ""}`;
}
export function role(kind: string) {
  return kind === "witness" ? "witness" : "dataserver";
}
