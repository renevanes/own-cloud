import { storeRawMessage } from "./store.js";
import { OWNER_ID, recipientUser } from "../users.js";
import { db } from "../db.js";

/**
 * Inkomende mail per ontvanger in de juiste mailbox. De ontvangers uit de SMTP-envelop reizen mee als eerste regel
 * ("X-Eigen-Envelope-To: a@x, b@x") zodat ook mail die een volger tijdelijk bewaart (secundaire MX) bij de juiste
 * gebruiker aankomt. Die regel wordt er vóór het opslaan weer afgehaald. Zonder die regel (oudere server): eigenaar.
 */
export const ENVELOPE_HEADER = "X-Eigen-Envelope-To";

export function withEnvelope(raw: Buffer, recipients: string[]): Buffer {
  const clean = recipients.map((r) => r.replace(/[\r\n,]/g, "").trim()).filter(Boolean);
  return Buffer.concat([Buffer.from(`${ENVELOPE_HEADER}: ${clean.join(", ")}\r\n`), raw]);
}

export function splitEnvelope(raw: Buffer): { raw: Buffer; recipients: string[] | null } {
  const prefix = `${ENVELOPE_HEADER}: `;
  if (raw.subarray(0, prefix.length).toString("latin1") !== prefix) return { raw, recipients: null };
  const nl = raw.indexOf("\n");
  if (nl < 0) return { raw, recipients: null };
  const line = raw.subarray(prefix.length, nl).toString("utf8").replace(/\r$/, "");
  return { raw: raw.subarray(nl + 1), recipients: line.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) };
}

/** Bij wie komt mail voor deze ontvangers terecht (al aangenomen mail: nooit weggooien, desnoods bij de eigenaar). */
export function mailboxesFor(recipients: string[] | null): number[] {
  if (!recipients?.length) return [OWNER_ID];
  const ids = new Set<number>();
  for (const r of recipients) {
    const id = recipientUser(r);
    if (id !== null) { ids.add(id); continue; }
    // Tussen aannemen en opslaan uitgeschakeld: toch bewaren bij die gebruiker.
    const local = r.split("@")[0]?.replace(/\+.*$/, "");
    const row = local ? (db.prepare("SELECT id FROM users WHERE localpart = ? AND status != 'removed'").get(local) as { id: number } | undefined) : undefined;
    ids.add(row?.id ?? OWNER_ID);
  }
  return [...ids];
}

/** Slaat een inkomend bericht op bij elke ontvanger. Geeft de nieuwe bericht-id's terug. */
export async function deliverInbound(input: Buffer): Promise<number[]> {
  const { raw, recipients } = splitEnvelope(input);
  const out: number[] = [];
  for (const userId of mailboxesFor(recipients)) {
    const id = await storeRawMessage(raw, { folder: "inbox", userId });
    if (id) out.push(id);
  }
  return out;
}
