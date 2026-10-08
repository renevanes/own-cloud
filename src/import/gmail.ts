import fs from "node:fs";
import { storeRawMessage, type Folder, type StoreOptions } from "../mail/store.js";

const SYSTEM_LABELS = new Set(["inbox", "opened", "unread", "sent", "starred", "important", "archived", "spam", "trash", "drafts", "draft", "chat", "postvak in", "verzonden", "gelezen", "ongelezen", "met ster", "belangrijk", "gearchiveerd", "prullenbak", "concepten"]);

function decodeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, txt: string) => {
    const buf = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64")
      : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
  });
}

/** Leest de X-Gmail-Labels-header en vertaalt die naar map + vlaggen. */
export function gmailLabelsToOptions(raw: Buffer): StoreOptions {
  const headEnd = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const head = raw.subarray(0, headEnd >= 0 ? headEnd : Math.min(raw.length, 64 * 1024)).toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  const m = /^X-Gmail-Labels:\s*(.*)$/im.exec(head);
  if (!m) return { folder: "inbox", isRead: true };
  const labels = decodeWords(Buffer.from(m[1], "latin1").toString("utf8")).split(",").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const has = (...names: string[]) => labels.some((l) => names.includes(l.toLowerCase()));

  let folder: Folder = "archive";
  if (has("trash", "prullenbak")) folder = "trash";
  else if (has("spam")) folder = "spam";
  else if (has("inbox", "postvak in")) folder = "inbox";
  else if (has("drafts", "draft", "concepten")) folder = "drafts";
  else if (has("sent", "verzonden")) folder = "sent";

  return {
    folder,
    isRead: !has("unread", "ongelezen"),
    isStarred: has("starred", "met ster"),
    labels: labels.filter((l) => !SYSTEM_LABELS.has(l.toLowerCase()) && !/^(category|categorie) /i.test(l)),
  };
}

/** Splitst een (Google Takeout) mbox-bestand stream-gewijs in losse berichten. */
export async function* readMbox(file: string): AsyncGenerator<Buffer> {
  const fromLine = /^From \S+ .*\d{4}\s*$/;
  let current: Buffer[] = [];
  let leftover: Buffer = Buffer.alloc(0);
  let started = false;

  const flush = function* () {
    if (current.length) {
      let msg = Buffer.concat(current);
      // mboxrd: ">From " aan het begin van een regel was geëscaped.
      if (msg.includes("\n>From ")) msg = Buffer.from(msg.toString("latin1").replace(/^>(>*From )/gm, "$1"), "latin1");
      yield msg;
    }
    current = [];
  };

  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    let buf: Buffer = leftover.length ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer);
    let pos = 0;
    let nl: number;
    while ((nl = buf.indexOf(10, pos)) !== -1) {
      const line = buf.subarray(pos, nl + 1);
      if (line[0] === 0x46 /* F */ && fromLine.test(line.toString("latin1").trimEnd())) {
        yield* flush();
        started = true;
      } else if (started) current.push(line);
      pos = nl + 1;
    }
    leftover = buf.subarray(pos);
  }
  if (leftover.length && started) current.push(leftover);
  yield* flush();
}

export async function importGmailMbox(file: string, onProgress?: (n: { done: number; added: number; skipped: number; failed: number }) => void) {
  const stats = { done: 0, added: 0, skipped: 0, failed: 0 };
  for await (const raw of readMbox(file)) {
    try {
      const id = await storeRawMessage(raw, gmailLabelsToOptions(raw));
      id ? stats.added++ : stats.skipped++;
    } catch (e) {
      stats.failed++;
    }
    stats.done++;
    if (onProgress && stats.done % 250 === 0) onProgress(stats);
  }
  return stats;
}
