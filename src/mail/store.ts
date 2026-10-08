import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { db } from "../db.js";
import { paths } from "../config.js";

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam" | "drafts";

export interface StoreOptions {
  folder?: Folder;
  labels?: string[];
  isRead?: boolean;
  isStarred?: boolean;
}

interface Addr { name: string; address: string }

function addrs(a: AddressObject | AddressObject[] | undefined): Addr[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((o) => o.value).map((v) => ({ name: v.name ?? "", address: (v.address ?? "").toLowerCase() }));
}

function normSubject(s: string | undefined) {
  return (s ?? "").replace(/^\s*((re|fw|fwd|aw|wg|antw|doorst)\s*:\s*)+/i, "").trim().toLowerCase();
}

function threadKey(m: ParsedMail): string {
  const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
  const root = refs[0] ?? m.inReplyTo ?? m.messageId;
  if (root) {
    // Hergebruik de thread van een bekend bericht als dat er al is.
    const known = db.prepare("SELECT thread_key FROM messages WHERE message_id = ?").get(root) as { thread_key: string } | undefined;
    if (known) return known.thread_key;
    if (refs.length || m.inReplyTo) return root;
  }
  return "subj:" + crypto.createHash("sha1").update(normSubject(m.subject)).digest("hex").slice(0, 16) + ":" + (m.messageId ?? crypto.randomUUID());
}

function snippetOf(text: string | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Bewaart een ruw RFC 822-bericht. Geeft het nieuwe id terug, of null als het al bestond. */
export async function storeRawMessage(raw: Buffer, opts: StoreOptions = {}): Promise<number | null> {
  const m = await simpleParser(raw, { skipImageLinks: true });

  if (m.messageId) {
    const exists = db.prepare("SELECT id FROM messages WHERE message_id = ?").get(m.messageId);
    if (exists) return null;
  }

  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  const rawPath = path.join(paths.mailRaw, sha.slice(0, 2), sha + ".eml");
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, raw);

  const from = addrs(m.from)[0];
  const date = m.date?.getTime() ?? Date.now();

  const insert = db.prepare(`
    INSERT INTO messages (message_id, thread_key, folder, labels, from_addr, from_name, to_addrs, cc_addrs,
                          subject, snippet, body_text, body_html, date, is_read, is_starred, raw_path, size)
    VALUES (@message_id, @thread_key, @folder, @labels, @from_addr, @from_name, @to_addrs, @cc_addrs,
            @subject, @snippet, @body_text, @body_html, @date, @is_read, @is_starred, @raw_path, @size)`);

  const id = Number(
    insert.run({
      message_id: m.messageId ?? null,
      thread_key: threadKey(m),
      folder: opts.folder ?? "inbox",
      labels: JSON.stringify(opts.labels ?? []),
      from_addr: from?.address ?? null,
      from_name: from?.name ?? null,
      to_addrs: JSON.stringify(addrs(m.to)),
      cc_addrs: JSON.stringify(addrs(m.cc)),
      subject: m.subject ?? "(geen onderwerp)",
      snippet: snippetOf(m.text),
      body_text: m.text ?? null,
      body_html: typeof m.html === "string" ? m.html : null,
      date,
      is_read: opts.isRead ? 1 : 0,
      is_starred: opts.isStarred ? 1 : 0,
      raw_path: rawPath,
      size: raw.length,
    }).lastInsertRowid,
  );

  const addAtt = db.prepare("INSERT INTO attachments (message_id, filename, mime, size, path) VALUES (?, ?, ?, ?, ?)");
  for (const att of m.attachments) {
    const aSha = crypto.createHash("sha256").update(att.content).digest("hex");
    const aPath = path.join(paths.mailAttachments, aSha.slice(0, 2), aSha);
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    if (!fs.existsSync(aPath)) fs.writeFileSync(aPath, att.content);
    addAtt.run(id, att.filename ?? "bijlage", att.contentType, att.size, aPath);
  }
  return id;
}
