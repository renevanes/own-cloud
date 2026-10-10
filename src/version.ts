/**
 * Welke versie draait hier. Het versienummer staat in het bestand VERSION (VERSION_NAME, bijv. "1.12") en geldt
 * voor de app én de servers. In het server-image zet de CI EIGEN_VERSION; bij ontwikkelen is het "<versie>-dev".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function pkgVersion() {
  try {
    const v = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../VERSION");
    const m = /^VERSION_NAME=(\S+)/m.exec(fs.readFileSync(v, "utf8"));
    if (m) return m[1];
  } catch { /* geen VERSION-bestand: package.json */ }
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    return (JSON.parse(fs.readFileSync(p, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const VERSION = () => process.env.EIGEN_VERSION || `${pkgVersion()}-dev`;

/** -1, 0, 1 voor versies als "1.12" of "1.0.0.42"; null als een van beide geen echte versie is (bijv. "-dev"). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => (v && /^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0, q = y[i] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
