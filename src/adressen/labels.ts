/** Regels voor gratis namen (naam.<zone>): dezelfde bij de Dienst (BROKER_FREE_ZONE) en de centrale adressendienst. */
import { RESERVED_LABELS } from "../broker/config.js";

export const LABEL_RULE_ERROR = "Kies een naam van 3 tot 32 letters, cijfers of streepjes";
export const LABEL_RESERVED_ERROR = "Deze naam is gereserveerd. Kies een andere.";

/** Foutmelding als `label` geen geldige gratis naam is, anders null. */
export function labelError(label: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label) || label.length < 3) return LABEL_RULE_ERROR;
  if (RESERVED_LABELS.has(label) || /^xn--/.test(label)) return LABEL_RESERVED_ERROR;
  return null;
}

/**
 * "vanes", "Vanes.EigenCloud.nl." → { label: "vanes", naam: "vanes.eigencloud.nl" }.
 * null als het een naam buiten de zone is (bijv. "vanes.nl"); { error } als de naam niet mag.
 */
export function parseFreeName(raw: unknown, zone: string): { label: string; naam: string } | { error: string } | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.]+$/, "");
  const label = v.endsWith(`.${zone}`) ? v.slice(0, -(zone.length + 1)) : v.includes(".") ? null : v;
  if (label === null) return null;
  const err = labelError(label);
  return err ? { error: err } : { label, naam: `${label}.${zone}` };
}
