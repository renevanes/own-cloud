/** Hulpjes voor DNS-records en het Scaleway-maildomein (TEM); gedeeld door de dienst en de beheerconsole. */

/** TXT-waarde voor deSEC: tussen aanhalingstekens, in stukken van max. 255 tekens. */
export function txtRecord(value: string) {
  const v = value.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
  const parts: string[] = [];
  for (let i = 0; i < v.length; i += 255) parts.push(`"${v.slice(i, i + 255).replace(/"/g, '\\"')}"`);
  return parts.join(" ") || '""';
}

/** Recordnaam (relatief of volledig) → deSEC-subname binnen de zone. */
export function subnameOf(name: string, zone: string) {
  const n = name.replace(/\.$/, "").toLowerCase();
  if (n === zone || n === "@" || n === "") return "";
  return n.endsWith(`.${zone}`) ? n.slice(0, -(zone.length + 1)) : n;
}

/** Records uit een TEM-domein, ook bij oudere vormen (spf_config/dkim_config). */
export function temRecords(dom: any, projectId: string) {
  const r = dom?.records ?? {};
  const pick = (x: any) => (x && typeof x === "object" && x.value ? { name: String(x.name ?? ""), value: String(x.value) } : null);
  const dkim = pick(r.dkim) ?? (dom?.dkim_config ? { name: `${projectId}._domainkey`, value: String(dom.dkim_config) } : null);
  const dmarc = pick(r.dmarc);
  const spf = pick(r.spf)?.value ?? (dom?.spf_config ? String(dom.spf_config) : "");
  const spfExtra = spf.split(/\s+/).filter((t) => /^include:/.test(t)).join(" ");
  return { dkim, dmarc, spfExtra };
}
