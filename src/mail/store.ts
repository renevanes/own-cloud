import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { db } from "../db.js";
import { paths, config } from "../config.js";
import { fsyncFile, reserveSpace } from "../work.js";
import { getUser } from "../users.js";
import { blobWritten, relData } from "../blobs.js";

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam" | "drafts";

export interface StoreOptions {
  folder?: Folder;
  labels?: string[];
  isRead?: boolean;
  isStarred?: boolean;
  /** Van wie is dit bericht (standaard de eigenaar). */
  userId?: number;
  dedupKey?: string;
  reserved?: boolean;
  inbound?: boolean;
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

function threadKey(m: ParsedMail, userId: number): string {
  const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
  const root = refs[0] ?? m.inReplyTo ?? m.messageId;
  if (root) {
    // Hergebruik de thread van een bekend bericht als dat er al is.
    const known = db.prepare("SELECT thread_key FROM messages WHERE message_id = ? AND user_id = ?").get(root, userId) as { thread_key: string } | undefined;
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
  let userId = opts.userId ?? 1;
  if (getUser(userId)?.status === "removed") {
    if (opts.inbound) userId = 1;
    else throw Object.assign(new Error("Dit account is verwijderd"), { statusCode: 401 });
  }

  const messageId = m.messageId ?? `<incoming-${opts.dedupKey ?? crypto.createHash("sha256").update(raw).digest("hex")}@eigen-cloud>`;
  {
    const exists = db.prepare("SELECT id,raw_path FROM messages WHERE message_id = ? AND user_id = ?").get(messageId, userId) as { id: number; raw_path: string | null } | undefined;
    if (exists) {
      const sha = crypto.createHash("sha256").update(raw).digest("hex");
      if (exists.raw_path?.endsWith(sha + ".eml")) {
        const rawFile = path.join(config.dataDir, exists.raw_path);
        if (!fs.existsSync(rawFile)) { fs.mkdirSync(path.dirname(rawFile), { recursive: true }); fs.writeFileSync(rawFile, raw); fsyncFile(rawFile); blobWritten(exists.raw_path); }
        for (const att of m.attachments) {
          const hash = crypto.createHash("sha256").update(att.content).digest("hex"), file = path.join(paths.mailAttachments, hash.slice(0, 2), hash);
          if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, att.content); fsyncFile(file); blobWritten(relData(file)); }
        }
      }
      return null;
    }
  }
  const release = opts.reserved ? () => {} : reserveSpace(userId, raw.length + m.attachments.reduce((n, a) => n + a.size, 0));
  try {

  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  const rawPath = path.join(paths.mailRaw, sha.slice(0, 2), sha + ".eml");
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, raw);
  fsyncFile(rawPath);

  const from = addrs(m.from)[0];
  const date = m.date?.getTime() ?? Date.now();

  // Bijlagen eerst naar schijf, daarna alles in één transactie in de database.
  const atts = m.attachments.map((att) => {
    const aSha = crypto.createHash("sha256").update(att.content).digest("hex");
    const aPath = path.join(paths.mailAttachments, aSha.slice(0, 2), aSha);
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    if (!fs.existsSync(aPath)) fs.writeFileSync(aPath, att.content);
    fsyncFile(aPath);
    return { filename: att.filename ?? "bijlage", mime: att.contentType, size: att.size, rel: relData(aPath) };
  });

  const insert = db.prepare(`
    INSERT INTO messages (message_id, thread_key, folder, labels, from_addr, from_name, to_addrs, cc_addrs,
                          subject, snippet, body_text, body_html, date, is_read, is_starred, raw_path, size, user_id)
    VALUES (@message_id, @thread_key, @folder, @labels, @from_addr, @from_name, @to_addrs, @cc_addrs,
            @subject, @snippet, @body_text, @body_html, @date, @is_read, @is_starred, @raw_path, @size, @user_id)`);
  const addAtt = db.prepare("INSERT INTO attachments (message_id, filename, mime, size, path) VALUES (?, ?, ?, ?, ?)");
  const rawRel = relData(rawPath);
  const tk = threadKey(m, userId);

  return db.transaction(() => {
    const id = Number(
      insert.run({
        message_id: messageId,
        thread_key: tk,
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
        raw_path: rawRel,
        size: raw.length,
        user_id: userId,
      }).lastInsertRowid,
    );
    blobWritten(rawRel);
    for (const a of atts) {
      addAtt.run(id, a.filename, a.mime, a.size, a.rel);
      blobWritten(a.rel);
    }
    return id;
  })();
  } finally { release(); }
}
