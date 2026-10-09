// Schematische kaart van Europa met het "slakkenspoor" tussen de plekken waar je cloud draait.
// Equirectangulair met cos(52°)-correctie; bewust vereenvoudigd.
const MAIN = [[-9.5,43],[-1.8,43.4],[-1.2,46.2],[-4.5,47.8],[-4.6,48.6],[-1.6,48.7],[-1.3,49.6],[0.2,49.7],[1.6,50.9],[2.5,51.1],[3.4,51.4],[4.2,52],[4.7,52.9],[5.4,53.4],[7,53.6],[8.6,53.9],[8.9,54.5],[8.6,55.4],[8.1,56.6],[10.5,57.7],[10.6,56.5],[10,54.8],[11,54],[12.5,54.5],[14.2,53.9],[16,54.3],[18.6,54.8],[19.9,54.4],[21.2,55.3],[21,56.8],[23.5,57],[24.4,58.3],[23.4,59],[24.8,59.5],[28,59.5],[30,60],[26.5,60.4],[22.9,59.8],[21.3,60.8],[21.6,63],[24.5,64.9],[25.4,65.4],[22.5,65.8],[21,64.2],[18.5,62.8],[17.4,61.2],[18.9,59.9],[18.3,59.3],[16.6,57.9],[16.4,56.3],[14.4,55.6],[12.9,55.4],[12.6,56.1],[11.8,58],[11.1,59],[10.6,59.6],[10.2,59],[8,58.1],[5.6,58.9],[5,60.4],[5,62],[8,63.4],[10.5,64.5],[14,67],[16,68.5],[19,69.8],[23,70.6],[28,71],[31,70.3],[32,69.8],[32,46.6],[30.7,46.5],[29.7,45.2],[28.6,43.8],[28,42.5],[29,41.2],[26,40.8],[24,40.8],[23,39.6],[24,38],[22.9,36.5],[21,39],[19.4,40.3],[19.4,41.8],[17.9,42.6],[15.3,44],[13.6,45],[13.7,45.7],[12.3,45.3],[13.6,43.6],[16,41.4],[18.5,40.1],[17.2,39.4],[16.6,38.4],[15.6,38],[15.6,40.1],[12.3,41.7],[10.2,43.9],[8.7,44.4],[7.5,43.8],[4.8,43.4],[3,43.3],[3.2,41.9],[-0.3,39.5],[0.2,38.8],[-2,36.7],[-5.6,36],[-6.3,36.8],[-8.9,37],[-9,38.7]];
const ISLANDS = [
  [[-5.7,50],[-3,50.6],[1.4,51.2],[1.7,52.6],[0.3,53.4],[-0.1,54.5],[-1.6,55.6],[-2,56],[-3,56],[-1.8,57.5],[-3,58.6],[-5,58.6],[-5.6,57.5],[-5.8,56.3],[-5,55.8],[-5,54.8],[-3,54.9],[-3.4,54.3],[-3,53.4],[-4.6,53.3],[-4.2,52.3],[-5.2,51.7],[-3.2,51.4],[-4.2,51.2]],
  [[-6,52.2],[-6.2,53.9],[-5.6,54.6],[-7.4,55.3],[-8.5,54.5],[-10,54.2],[-9.9,52],[-8.5,51.6]],
  [[12.4,38],[15.6,38.3],[15.1,36.7],[12.4,37.8]], [[8.2,41],[9.8,41],[9.6,39.1],[8.4,39]], [[8.6,42.9],[9.5,43],[9.4,41.4],[8.8,41.6]],
];
export const CITIES = {
  "scaleway/nl-ams-1": [4.9, 52.37], "scaleway/nl-ams-2": [4.75, 52.3], "scaleway/nl-ams-3": [5.05, 52.42], "scaleway/fr-par-1": [2.35, 48.86], "scaleway/fr-par-2": [2.25, 48.8], "scaleway/pl-waw-1": [21, 52.23],
  "hetzner/fsn1": [12.37, 50.48], "hetzner/nbg1": [11.08, 49.45], "hetzner/hel1": [24.94, 60.17],
  "upcloud/nl-ams1": [4.95, 52.35], "upcloud/de-fra1": [8.68, 50.11], "upcloud/fi-hel1": [24.9, 60.2], "upcloud/fi-hel2": [24.8, 60.25], "upcloud/se-sto1": [18.07, 59.33],
  "local/ams": [4.9, 52.37], "local/fra": [8.68, 50.11], "local/hel": [24.94, 60.17],
};
const HOME = [4.48, 51.92];
const K = Math.cos((52 * Math.PI) / 180);
const proj = ([lon, lat]) => [((lon + 11) * K * 10).toFixed(1), ((71.5 - lat) * 10).toFixed(1)];
const path = (pts) => "M" + pts.map((p) => proj(p).join(",")).join("L") + "Z";

/**
 * nodes: [{ id, kind, provider, region, status, isLeader }]
 * Geeft een SVG-string terug. Het spoor loopt van de leider langs de andere nodes.
 */
export function europeMap(nodes, { home = true, label = "Kaart van Europa met je servers" } = {}) {
  const pts = nodes.map((n) => ({ ...n, at: CITIES[`${n.provider}/${n.region}`] })).filter((n) => n.at);
  // Nodes op (bijna) dezelfde plek iets uit elkaar zetten.
  const seen = new Map();
  for (const p of pts) {
    const k = p.at.map((v) => Math.round(v)).join(",");
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    if (i) p.at = [p.at[0] + 0.9 * Math.cos(i * 2.1), p.at[1] + 0.6 * Math.sin(i * 2.1)];
  }
  const ordered = [...pts].sort((a, b) => (b.isLeader ? 1 : 0) - (a.isLeader ? 1 : 0));
  const trail = ordered.length > 1 ? ordered.map((p) => proj(p.at)) : [];
  let d = "";
  for (let i = 0; i < trail.length; i++) {
    if (!i) { d = `M${trail[0].join(",")}`; continue; }
    const [x0, y0] = trail[i - 1].map(Number), [x1, y1] = trail[i].map(Number);
    const mx = (x0 + x1) / 2 + (y1 - y0) * 0.25, my = (y0 + y1) / 2 - (x1 - x0) * 0.25;
    d += ` Q${mx.toFixed(1)},${my.toFixed(1)} ${x1},${y1}`;
  }
  const dots = pts.map((p) => {
    const [x, y] = proj(p.at);
    const down = p.status !== "ready" && p.status !== undefined;
    const r = p.kind === "witness" ? 4.5 : 7;
    return `<g class="eu-node ${p.kind} ${down ? "pending" : ""} ${p.isLeader ? "leader" : ""}" transform="translate(${x},${y})">
      ${p.isLeader ? `<circle r="${r + 6}" class="eu-halo"/>` : ""}
      <circle r="${r}"><title>${p.id} · ${p.provider} ${p.region}</title></circle></g>`;
  }).join("");
  const homeDot = home ? (() => { const [x, y] = proj(HOME); return `<g class="eu-home" transform="translate(${x},${y})"><rect x="-3.5" y="-3.5" width="7" height="7" rx="1.5"><title>Thuis (Rotterdam)</title></rect></g>`; })() : "";
  return `<svg class="eu-map" viewBox="0 20 270 360" role="img" aria-label="${label}">
    <path class="eu-land" d="${path(MAIN)}"/>${ISLANDS.map((i) => `<path class="eu-land" d="${path(i)}"/>`).join("")}
    ${d ? `<path class="eu-trail" d="${d}"/>` : ""}${homeDot}${dots}</svg>`;
}

export const MAP_CSS = `
.eu-map { width: 100%; height: auto; display: block; -webkit-mask-image: linear-gradient(90deg, #000 86%, transparent 100%); mask-image: linear-gradient(90deg, #000 86%, transparent 100%); }
.eu-land { fill: var(--sunk); stroke: var(--line); stroke-width: .8; stroke-linejoin: round; }
.eu-trail { fill: none; stroke: var(--trail); stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 1 6; }
.eu-node circle { fill: var(--accent); stroke: var(--panel); stroke-width: 2; }
.eu-node.witness circle { fill: var(--panel); stroke: var(--accent); stroke-width: 2.5; }
.eu-node.pending circle { fill: var(--warn); }
.eu-node .eu-halo { fill: none; stroke: var(--accent); stroke-width: 1.5; opacity: .45; }
.eu-home rect { fill: var(--text); }
`;
