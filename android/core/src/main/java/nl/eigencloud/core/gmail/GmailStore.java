package nl.eigencloud.core.gmail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import nl.eigencloud.core.Json;

/**
 * The phone's copy of Gmail: one row per message keyed by X-GM-MSGID (Gmail's id that stays the same in every
 * folder), its labels, where it lives on the server (All Mail, Trash or Spam, with the UID per folder), the
 * downloaded parts as files, the queue of changes still to send to Gmail, and the outbox.
 */
public final class GmailStore {
    public static final String ALL = "all", TRASH = "trash", SPAM = "spam";
    /** Body states. */
    public static final int NONE = 0, PARTIAL = 1, COMPLETE = 2;

    final Sql db;
    public final File dir;

    public GmailStore(Sql db, File dir) {
        this.db = db;
        this.dir = dir;
        dir.mkdirs();
        migrate();
    }

    private void migrate() {
        db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
        db.exec("CREATE TABLE IF NOT EXISTS msg (id TEXT PRIMARY KEY, thr TEXT, date INTEGER, from_name TEXT, from_addr TEXT, to_text TEXT, cc_text TEXT, "
                + "subject TEXT, snippet TEXT, size INTEGER, seen INTEGER, flagged INTEGER, answered INTEGER, draft INTEGER, box TEXT, msg_id TEXT, "
                + "in_reply_to TEXT, refs TEXT, attach INTEGER, body INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, modseq INTEGER DEFAULT 0, search TEXT, reply_to TEXT)");
        db.exec("CREATE INDEX IF NOT EXISTS msg_box_date ON msg(box, date)");
        db.exec("CREATE INDEX IF NOT EXISTS msg_thr ON msg(thr)");
        db.exec("CREATE INDEX IF NOT EXISTS msg_msgid ON msg(msg_id)");
        db.exec("CREATE TABLE IF NOT EXISTS lbl (label TEXT, id TEXT, PRIMARY KEY(label, id))");
        db.exec("CREATE INDEX IF NOT EXISTS lbl_id ON lbl(id)");
        db.exec("CREATE TABLE IF NOT EXISTS uid (box TEXT, uid INTEGER, id TEXT, PRIMARY KEY(box, uid))");
        db.exec("CREATE INDEX IF NOT EXISTS uid_id ON uid(id)");
        db.exec("CREATE TABLE IF NOT EXISTS part (id TEXT, section TEXT, type TEXT, name TEXT, cid TEXT, size INTEGER, disp TEXT, encoding TEXT, charset TEXT, "
                + "file INTEGER DEFAULT 0, PRIMARY KEY(id, section))");
        db.exec("CREATE TABLE IF NOT EXISTS folder (name TEXT PRIMARY KEY, raw TEXT, role TEXT)");
        db.exec("CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, op TEXT, args TEXT, at INTEGER, tries INTEGER DEFAULT 0, error TEXT)");
        db.exec("CREATE INDEX IF NOT EXISTS ops_id ON ops(id)");
        db.exec("CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, at INTEGER, state TEXT, tries INTEGER DEFAULT 0, "
                + "error TEXT, subject TEXT, rcpt TEXT, reply_to TEXT, next_at INTEGER DEFAULT 0)");
        // Sending when the app stopped: maybe Gmail has it. The next run checks before sending again.
        db.exec("UPDATE outbox SET state = 'unknown' WHERE state = 'sending'");
        // An outbox row whose file was never completed (the app stopped while writing) never reached "queued".
        for (Object[] r : db.query("SELECT seq FROM outbox WHERE state = 'new'")) {
            long seq = (Long) r[0];
            if (!outboxFile(seq).exists()) db.exec("DELETE FROM outbox WHERE seq = ?", seq);
            else db.exec("UPDATE outbox SET state = 'queued' WHERE seq = ?", seq);
        }
    }

    private int txDepth;

    /** A transaction; nested calls join the outer one. All SQL goes through this object's lock. */
    public synchronized void tx(Runnable r) {
        if (txDepth > 0) { r.run(); return; }
        db.begin();
        txDepth = 1;
        try {
            r.run();
            txDepth = 0;
            db.commit();
        } catch (RuntimeException e) {
            txDepth = 0;
            db.rollback();
            throw e;
        }
    }

    private synchronized void exec(String sql, Object... args) { db.exec(sql, args); }

    private synchronized List<Object[]> q(String sql, Object... args) { return db.query(sql, args); }

    // ───────── Key/value ─────────

    public String value(String k) {
        List<Object[]> r = q("SELECT v FROM kv WHERE k = ?", k);
        return r.isEmpty() ? null : (String) r.get(0)[0];
    }

    public void put(String k, String v) {
        if (v == null) exec("DELETE FROM kv WHERE k = ?", k);
        else exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, v);
    }

    public Map<String, Object> json(String k) {
        String v = value(k);
        if (v == null) return Json.obj();
        try { return Json.parseObject(v); } catch (RuntimeException e) { return Json.obj(); }
    }

    public void putJson(String k, Map<String, Object> v) { put(k, Json.stringify(v)); }

    // ───────── Messages ─────────

    public static final class Msg {
        public String id, thr = "", fromName = "", fromAddr = "", to = "", cc = "", subject = "", snippet = "", box = ALL;
        public String msgId, inReplyTo, refs, replyTo;
        public long date, size, modseq;
        public boolean seen, flagged, answered, draft, attach, pinned;
        public int body;
        public final Set<String> labels = new LinkedHashSet<>();

        public Map<String, Object> toJson() {
            return Json.obj("id", id, "thr", thr, "date", date, "fromName", fromName, "fromAddr", fromAddr, "to", to, "cc", cc, "subject", subject,
                    "snippet", snippet, "size", size, "seen", seen, "flagged", flagged, "answered", answered, "draft", draft, "box", box,
                    "attach", attach, "body", (long) body, "pinned", pinned, "labels", new ArrayList<Object>(labels));
        }
    }

    private static final String COLS = "id, thr, date, from_name, from_addr, to_text, cc_text, subject, snippet, size, seen, flagged, answered, draft, box, "
            + "msg_id, in_reply_to, refs, attach, body, pinned, modseq, reply_to";

    private static Msg row(Object[] r) {
        Msg m = new Msg();
        m.id = (String) r[0];
        m.thr = s(r[1]);
        m.date = l(r[2]);
        m.fromName = s(r[3]);
        m.fromAddr = s(r[4]);
        m.to = s(r[5]);
        m.cc = s(r[6]);
        m.subject = s(r[7]);
        m.snippet = s(r[8]);
        m.size = l(r[9]);
        m.seen = l(r[10]) != 0;
        m.flagged = l(r[11]) != 0;
        m.answered = l(r[12]) != 0;
        m.draft = l(r[13]) != 0;
        m.box = s(r[14]);
        m.msgId = (String) r[15];
        m.inReplyTo = (String) r[16];
        m.refs = (String) r[17];
        m.attach = l(r[18]) != 0;
        m.body = (int) l(r[19]);
        m.pinned = l(r[20]) != 0;
        m.modseq = l(r[21]);
        m.replyTo = (String) r[22];
        return m;
    }

    static String s(Object o) { return o == null ? "" : String.valueOf(o); }

    static long l(Object o) { return o == null ? 0 : ((Number) o).longValue(); }

    private static long b(boolean v) { return v ? 1 : 0; }

    public Msg get(String id) {
        List<Object[]> r = q("SELECT " + COLS + " FROM msg WHERE id = ?", id);
        if (r.isEmpty()) return null;
        Msg m = row(r.get(0));
        m.labels.addAll(labels(id));
        return m;
    }

    public boolean exists(String id) { return !q("SELECT 1 FROM msg WHERE id = ?", id).isEmpty(); }

    public List<String> labels(String id) {
        List<String> out = new ArrayList<>();
        for (Object[] r : q("SELECT label FROM lbl WHERE id = ? ORDER BY label", id)) out.add((String) r[0]);
        return out;
    }

    private static String searchText(Msg m) {
        return (m.subject + " " + m.fromName + " " + m.fromAddr + " " + m.to + " " + m.cc + " " + m.snippet).toLowerCase(Locale.ROOT);
    }

    /** Inserts a message seen for the first time, or updates its header fields, state and labels. Keeps body, pinned. */
    public synchronized void save(Msg m) {
        tx(() -> {
            if (m.snippet.isEmpty()) {
                List<Object[]> old = q("SELECT snippet FROM msg WHERE id = ?", m.id);
                if (!old.isEmpty()) m.snippet = s(old.get(0)[0]);
            }
            if (exists(m.id)) {
                exec("UPDATE msg SET thr=?, date=?, from_name=?, from_addr=?, to_text=?, cc_text=?, subject=?, snippet=CASE WHEN ? = '' THEN snippet ELSE ? END, "
                                + "size=?, seen=?, flagged=?, answered=?, draft=?, box=?, msg_id=?, in_reply_to=?, refs=COALESCE(?, refs), attach=MAX(attach, ?), modseq=?, search=?, reply_to=COALESCE(?, reply_to) WHERE id=?",
                        m.thr, m.date, m.fromName, m.fromAddr, m.to, m.cc, m.subject, m.snippet, m.snippet, m.size, b(m.seen), b(m.flagged), b(m.answered), b(m.draft),
                        m.box, m.msgId, m.inReplyTo, m.refs, b(m.attach), m.modseq, searchText(m), m.replyTo, m.id);
            } else {
                exec("INSERT INTO msg (" + COLS + ", search) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        m.id, m.thr, m.date, m.fromName, m.fromAddr, m.to, m.cc, m.subject, m.snippet, m.size, b(m.seen), b(m.flagged), b(m.answered), b(m.draft),
                        m.box, m.msgId, m.inReplyTo, m.refs, b(m.attach), 0L, 0L, m.modseq, m.replyTo, searchText(m));
            }
            setLabels(m.id, m.labels);
        });
    }

    /** Flags, labels and location from the server (a CONDSTORE change or a flag refresh). */
    public synchronized void updateState(String id, boolean seen, boolean flagged, boolean answered, boolean draft, Set<String> labels, String box, long modseq) {
        tx(() -> {
            exec("UPDATE msg SET seen=?, flagged=?, answered=?, draft=?, box=?, modseq=? WHERE id=?", b(seen), b(flagged), b(answered), b(draft), box, modseq, id);
            setLabels(id, labels);
        });
    }

    private void setLabels(String id, Set<String> labels) {
        exec("DELETE FROM lbl WHERE id = ?", id);
        for (String lb : labels) exec("INSERT OR IGNORE INTO lbl (label, id) VALUES (?, ?)", lb, id);
    }

    public void setFlag(String id, String column, boolean v) {
        if (!column.matches("seen|flagged|answered|pinned")) throw new IllegalArgumentException(column);
        exec("UPDATE msg SET " + column + " = ? WHERE id = ?", b(v), id);
    }

    public void addLabel(String id, String label) { exec("INSERT OR IGNORE INTO lbl (label, id) VALUES (?, ?)", label, id); }

    public void removeLabel(String id, String label) { exec("DELETE FROM lbl WHERE label = ? AND id = ?", label, id); }

    public void setBox(String id, String box) { exec("UPDATE msg SET box = ? WHERE id = ?", box, id); }

    public synchronized void setSnippet(String id, String snippet) {
        Msg m = get(id);
        if (m == null) return;
        m.snippet = snippet;
        exec("UPDATE msg SET snippet = ?, search = ? WHERE id = ?", snippet, searchText(m), id);
    }

    /** Removes a message completely (Gmail deleted it): rows, queued changes and files. */
    public synchronized void delete(String id) {
        tx(() -> {
            exec("DELETE FROM msg WHERE id = ?", id);
            exec("DELETE FROM lbl WHERE id = ?", id);
            exec("DELETE FROM uid WHERE id = ?", id);
            exec("DELETE FROM part WHERE id = ?", id);
            exec("DELETE FROM ops WHERE id = ?", id);
        });
        deleteDir(msgDir(id));
    }

    // ───────── UIDs per server folder ─────────

    public void map(String box, long uid, String id) { exec("INSERT OR REPLACE INTO uid (box, uid, id) VALUES (?, ?, ?)", box, uid, id); }

    public String idFor(String box, long uid) {
        List<Object[]> r = q("SELECT id FROM uid WHERE box = ? AND uid = ?", box, uid);
        return r.isEmpty() ? null : (String) r.get(0)[0];
    }

    /** Where the message is on the server: {box, uid}, preferring All Mail, then Trash, then Spam; null when unknown. */
    public Object[] location(String id) {
        Object[] best = null;
        for (Object[] r : q("SELECT box, uid FROM uid WHERE id = ?", id)) {
            String box = (String) r[0];
            if (box.contains("~")) continue;
            if (best == null || rank(box) < rank((String) best[0])) best = new Object[]{box, r[1]};
        }
        return best;
    }

    private static int rank(String box) { return ALL.equals(box) ? 0 : TRASH.equals(box) ? 1 : 2; }

    /** Removes the mapping; when the message is in no folder any more, Gmail deleted it and it goes here too. */
    public synchronized boolean unmap(String box, long uid) {
        String id = idFor(box, uid);
        exec("DELETE FROM uid WHERE box = ? AND uid = ?", box, uid);
        if (id != null && q("SELECT 1 FROM uid WHERE id = ? LIMIT 1", id).isEmpty()) {
            delete(id);
            return true;
        }
        return false;
    }

    /** Removes only the mapping (the message moved; the destination folder maps it again). */
    public void unmapKeep(String box, long uid) { exec("DELETE FROM uid WHERE box = ? AND uid = ?", box, uid); }

    /** Messages that are in no server folder any more (after a full pull): Gmail deleted them. */
    public int deleteOrphans() {
        List<String> gone = new ArrayList<>();
        for (Object[] r : q("SELECT id FROM msg WHERE NOT EXISTS (SELECT 1 FROM uid WHERE uid.id = msg.id)")) gone.add((String) r[0]);
        for (String id : gone) delete(id);
        return gone.size();
    }

    public long countUids(String box, long lo, long hi) {
        return l(q("SELECT COUNT(*) FROM uid WHERE box = ? AND uid >= ? AND uid <= ?", box, lo, hi).get(0)[0]);
    }

    public List<Long> uids(String box, long lo, long hi) {
        List<Long> out = new ArrayList<>();
        for (Object[] r : q("SELECT uid FROM uid WHERE box = ? AND uid >= ? AND uid <= ? ORDER BY uid", box, lo, hi)) out.add(l(r[0]));
        return out;
    }

    /** UIDs (ascending) in [lo, hi], at most {@code limit}, starting after {@code after}. */
    public List<Long> uidsAfter(String box, long after, long hi, int limit) {
        List<Long> out = new ArrayList<>();
        for (Object[] r : q("SELECT uid FROM uid WHERE box = ? AND uid > ? AND uid <= ? ORDER BY uid LIMIT " + limit, box, after, hi)) out.add(l(r[0]));
        return out;
    }

    public long maxUid(String box) { return l(q("SELECT MAX(uid) FROM uid WHERE box = ?", box).get(0)[0]); }

    /** UIDVALIDITY changed: keep the old mapping aside until a full walk has re-found every message. */
    public synchronized void resetBox(String box) {
        tx(() -> {
            exec("DELETE FROM uid WHERE box = ?", box + "~old");
            exec("UPDATE uid SET box = ? WHERE box = ?", box + "~old", box);
        });
    }

    /** After a full walk: messages that were only remembered under the old numbering are gone from Gmail. */
    public synchronized int finishReset(String box) {
        List<String> gone = new ArrayList<>();
        for (Object[] r : q("SELECT o.id FROM uid o WHERE o.box = ? AND NOT EXISTS (SELECT 1 FROM uid n WHERE n.id = o.id AND n.box NOT LIKE '%~old')", box + "~old")) {
            gone.add((String) r[0]);
        }
        exec("DELETE FROM uid WHERE box = ?", box + "~old");
        for (String id : gone) delete(id);
        return gone.size();
    }

    public boolean hasOld(String box) { return !q("SELECT 1 FROM uid WHERE box = ? LIMIT 1", box + "~old").isEmpty(); }

    /** The message was found again under the new numbering. */
    public void dropOld(String box, String id) { exec("DELETE FROM uid WHERE box = ? AND id = ?", box + "~old", id); }

    // ───────── Parts and files ─────────

    public static final class PartRow {
        public String section, type, name, cid, disposition, encoding, charset;
        public long size;
        public boolean file;

        public Mime.Part toPart() {
            Mime.Part p = new Mime.Part();
            p.section = section;
            p.type = type;
            p.filename = name.isEmpty() ? null : name;
            p.cid = cid.isEmpty() ? null : cid;
            p.disposition = disposition.isEmpty() ? null : disposition;
            p.encoding = encoding.isEmpty() ? null : encoding;
            p.charset = charset.isEmpty() ? null : charset;
            p.size = size;
            return p;
        }
    }

    public File msgDir(String id) {
        if (!id.matches("[0-9a-zA-Z_-]+")) throw new IllegalArgumentException("bad id");
        return new File(new File(dir, "m"), id);
    }

    public File partFile(String id, String section) {
        if (!section.matches("[0-9.]+")) throw new IllegalArgumentException("bad section");
        return new File(msgDir(id), section);
    }

    public List<PartRow> parts(String id) {
        List<PartRow> out = new ArrayList<>();
        for (Object[] r : q("SELECT section, type, name, cid, size, disp, encoding, charset, file FROM part WHERE id = ?", id)) {
            PartRow p = new PartRow();
            p.section = (String) r[0];
            p.type = s(r[1]);
            p.name = s(r[2]);
            p.cid = s(r[3]);
            p.size = l(r[4]);
            p.disposition = s(r[5]);
            p.encoding = s(r[6]);
            p.charset = s(r[7]);
            p.file = l(r[8]) != 0;
            out.add(p);
        }
        out.sort((a, c) -> compareSections(a.section, c.section));
        return out;
    }

    static int compareSections(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.min(x.length, y.length); i++) {
            int c = Long.compare(Long.parseLong(x[i]), Long.parseLong(y[i]));
            if (c != 0) return c;
        }
        return Integer.compare(x.length, y.length);
    }

    /**
     * Stores the structure and the parts that have data (files first, then rows, so a row never points at a
     * missing file). Body state: complete when every part is here, partial when some large part was left out.
     */
    public synchronized void saveParts(String id, List<Mime.Part> parts, Mime.Headers headers) throws IOException {
        File d = msgDir(id);
        d.mkdirs();
        for (Mime.Part p : parts) if (p.data != null) writeFile(partFile(id, p.section), p.data);
        boolean complete = true;
        for (Mime.Part p : parts) if (p.data == null) complete = false;
        final boolean full = complete;
        tx(() -> {
            exec("DELETE FROM part WHERE id = ?", id);
            boolean attach = false;
            for (Mime.Part p : parts) {
                exec("INSERT INTO part (id, section, type, name, cid, size, disp, encoding, charset, file) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        id, p.section, p.type, p.filename == null ? "" : p.filename, p.cid == null ? "" : p.cid, p.size,
                        p.disposition == null ? "" : p.disposition, p.encoding == null ? "" : p.encoding, p.charset == null ? "" : p.charset, b(p.data != null));
                if (!p.isBodyCandidate()) attach = true;
            }
            exec("UPDATE msg SET body = ?, attach = ? WHERE id = ?", (long) (full ? COMPLETE : PARTIAL), b(attach && hasRealAttachment(parts)), id);
            if (headers != null) {
                String refs = headers.get("References");
                if (refs != null) exec("UPDATE msg SET refs = ? WHERE id = ?", refs.replaceAll("\\s+", " ").trim(), id);
                String rt = headers.get("Reply-To");
                if (rt != null) exec("UPDATE msg SET reply_to = ? WHERE id = ?", Mime.formatList(Mime.parseAddresses(rt)), id);
            }
        });
    }

    /** Inline images only (multipart/related with cids) do not count as attachments for the paperclip. */
    private static boolean hasRealAttachment(List<Mime.Part> parts) {
        for (Mime.Part p : parts) {
            if (p.isBodyCandidate()) continue;
            if (p.cid != null && p.type.startsWith("image/") && !"attachment".equals(p.disposition)) continue;
            return true;
        }
        return false;
    }

    /** One part fetched later (on demand). */
    public synchronized void savePartData(String id, String section, byte[] data) throws IOException {
        writeFile(partFile(id, section), data);
        tx(() -> {
            exec("UPDATE part SET file = 1, size = ? WHERE id = ? AND section = ?", (long) data.length, id, section);
            if (q("SELECT 1 FROM part WHERE id = ? AND file = 0 LIMIT 1", id).isEmpty()) exec("UPDATE msg SET body = ? WHERE id = ?", (long) COMPLETE, id);
        });
    }

    public byte[] readPart(String id, String section) throws IOException {
        File f = partFile(id, section);
        if (!f.exists()) return null;
        return java.nio.file.Files.readAllBytes(f.toPath());
    }

    /** Forgets the downloaded content (headers and snippet stay). */
    public synchronized void dropBody(String id) {
        tx(() -> {
            exec("DELETE FROM part WHERE id = ?", id);
            exec("UPDATE msg SET body = 0, pinned = 0 WHERE id = ?", id);
        });
        deleteDir(msgDir(id));
    }

    static void writeFile(File f, byte[] data) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(data); }
        if (!tmp.renameTo(f)) {
            f.delete();
            if (!tmp.renameTo(f)) throw new IOException("Kon " + f.getName() + " niet bewaren");
        }
    }

    static void deleteDir(File d) {
        File[] files = d.listFiles();
        if (files != null) for (File f : files) { if (f.isDirectory()) deleteDir(f); else f.delete(); }
        d.delete();
    }

    /** Bytes used by downloaded parts. */
    public long storageBytes() {
        return l(q("SELECT COALESCE(SUM(size), 0) FROM part WHERE file = 1").get(0)[0]);
    }

    // ───────── Listing and search ─────────

    /** A mailbox view: "inbox", "starred", "sent", "drafts", "important", "all", "trash", "spam" or "label:Name". */
    static String[] viewSql(String view) {
        switch (view) {
            case "inbox": return new String[]{"m.box = 'all' AND EXISTS (SELECT 1 FROM lbl l WHERE l.id = m.id AND l.label = ?)", "\\Inbox"};
            case "starred": return new String[]{"m.box = 'all' AND m.flagged = 1"};
            case "sent": return new String[]{"m.box = 'all' AND EXISTS (SELECT 1 FROM lbl l WHERE l.id = m.id AND l.label = ?)", "\\Sent"};
            case "drafts": return new String[]{"m.box = 'all' AND m.draft = 1"};
            case "important": return new String[]{"m.box = 'all' AND EXISTS (SELECT 1 FROM lbl l WHERE l.id = m.id AND l.label = ?)", "\\Important"};
            case "all": return new String[]{"m.box = 'all'"};
            case "trash": return new String[]{"m.box = 'trash'"};
            case "spam": return new String[]{"m.box = 'spam'"};
            default:
                if (view.startsWith("label:")) return new String[]{"m.box = 'all' AND EXISTS (SELECT 1 FROM lbl l WHERE l.id = m.id AND l.label = ?)", view.substring(6)};
                throw new IllegalArgumentException("Onbekende map");
        }
    }

    /**
     * Newest first; {@code beforeDate}/{@code beforeId} continue a page (0/null for the first page). {@code query}:
     * all words must appear in subject, sender, recipients or snippet. A null view searches everything except spam.
     */
    public List<Msg> list(String view, long beforeDate, String beforeId, int limit, String query) {
        List<Object> args = new ArrayList<>();
        StringBuilder where = new StringBuilder();
        if (view == null) where.append("m.box != 'spam'");
        else {
            String[] v = viewSql(view);
            where.append(v[0]);
            for (int i = 1; i < v.length; i++) args.add(v[i]);
        }
        if (beforeDate > 0) {
            where.append(" AND (m.date < ? OR (m.date = ? AND m.id < ?))");
            args.add(beforeDate);
            args.add(beforeDate);
            args.add(beforeId == null ? "" : beforeId);
        }
        if (query != null) {
            for (String w : query.toLowerCase(Locale.ROOT).trim().split("\\s+")) {
                if (w.isEmpty()) continue;
                where.append(" AND m.search LIKE ? ESCAPE '\\'");
                args.add("%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
            }
        }
        List<Msg> out = new ArrayList<>();
        for (Object[] r : q("SELECT " + prefixed() + " FROM msg m WHERE " + where + " ORDER BY m.date DESC, m.id DESC LIMIT " + Math.max(1, Math.min(limit, 500)), args.toArray())) {
            out.add(row(r));
        }
        attachLabels(out);
        return out;
    }

    private static String prefixed() { return "m." + COLS.replace(", ", ", m."); }

    private void attachLabels(List<Msg> msgs) {
        if (msgs.isEmpty()) return;
        StringBuilder in = new StringBuilder();
        List<Object> args = new ArrayList<>();
        java.util.Map<String, Msg> byId = new java.util.HashMap<>();
        for (Msg m : msgs) {
            if (in.length() > 0) in.append(',');
            in.append('?');
            args.add(m.id);
            byId.put(m.id, m);
        }
        for (Object[] r : q("SELECT id, label FROM lbl WHERE id IN (" + in + ") ORDER BY label", args.toArray())) {
            Msg m = byId.get((String) r[0]);
            if (m != null) m.labels.add((String) r[1]);
        }
    }

    public long unread(String view) {
        String[] v = viewSql(view);
        Object[] args = new Object[v.length - 1];
        System.arraycopy(v, 1, args, 0, args.length);
        return l(q("SELECT COUNT(*) FROM msg m WHERE " + v[0] + " AND m.seen = 0", args).get(0)[0]);
    }

    public long count(String where, Object... args) { return l(q("SELECT COUNT(*) FROM msg m WHERE " + where, args).get(0)[0]); }

    public List<Msg> thread(String thr) {
        List<Msg> out = new ArrayList<>();
        if (thr == null || thr.isEmpty()) return out;
        for (Object[] r : q("SELECT " + prefixed() + " FROM msg m WHERE m.thr = ? AND m.box != 'spam' ORDER BY m.date, m.id LIMIT 200", thr)) out.add(row(r));
        attachLabels(out);
        return out;
    }

    public Msg byMessageId(String msgId) {
        List<Object[]> r = q("SELECT id FROM msg WHERE msg_id = ? LIMIT 1", msgId);
        return r.isEmpty() ? null : get((String) r.get(0)[0]);
    }

    /** Messages in the window without content, newest first (what the body pass downloads next). */
    public List<Msg> needingBody(long since, int limit) {
        List<Msg> out = new ArrayList<>();
        for (Object[] r : q("SELECT " + prefixed() + " FROM msg m WHERE m.body = 0 AND m.box != 'spam' AND m.date >= ? ORDER BY m.date DESC LIMIT " + limit, since)) out.add(row(r));
        return out;
    }

    /** Content outside the window that was not opened on purpose: removed when the window shrinks. */
    public List<String> bodiesOutside(long since, boolean includePinned, int limit) {
        List<String> out = new ArrayList<>();
        for (Object[] r : q("SELECT id FROM msg WHERE body > 0 AND date < ?" + (includePinned ? "" : " AND pinned = 0") + " LIMIT " + limit, since)) out.add((String) r[0]);
        return out;
    }

    // ───────── Labels (folders) ─────────

    public void saveFolders(List<String[]> folders) {
        tx(() -> {
            exec("DELETE FROM folder");
            for (String[] f : folders) exec("INSERT OR REPLACE INTO folder (name, raw, role) VALUES (?, ?, ?)", f[0], f[1], f[2]);
        });
    }

    /** {name, raw, role} in name order. */
    public List<String[]> folders() {
        List<String[]> out = new ArrayList<>();
        for (Object[] r : q("SELECT name, raw, role FROM folder ORDER BY name")) out.add(new String[]{(String) r[0], (String) r[1], s(r[2])});
        return out;
    }

    public String folderRaw(String role) {
        List<Object[]> r = q("SELECT raw FROM folder WHERE role = ? LIMIT 1", role);
        return r.isEmpty() ? null : (String) r.get(0)[0];
    }

    // ───────── Queue of changes for Gmail ─────────

    public static final class Op {
        public long seq, at;
        public String id, op;
        public Map<String, Object> args;
        public int tries;
        public String error;
    }

    public long enqueue(String id, String op, Map<String, Object> args) {
        exec("INSERT INTO ops (id, op, args, at) VALUES (?, ?, ?, ?)", id, op, Json.stringify(args == null ? Json.obj() : args), System.currentTimeMillis());
        return l(q("SELECT MAX(seq) FROM ops").get(0)[0]);
    }

    public List<Op> ops(int limit) {
        List<Op> out = new ArrayList<>();
        for (Object[] r : q("SELECT seq, id, op, args, at, tries, error FROM ops ORDER BY seq LIMIT " + limit)) {
            Op o = new Op();
            o.seq = l(r[0]);
            o.id = (String) r[1];
            o.op = (String) r[2];
            o.args = Json.parseObject(s(r[3]).isEmpty() ? "{}" : (String) r[3]);
            o.at = l(r[4]);
            o.tries = (int) l(r[5]);
            o.error = (String) r[6];
            out.add(o);
        }
        return out;
    }

    public long pendingOps() { return l(q("SELECT COUNT(*) FROM ops").get(0)[0]); }

    public boolean hasPending(String id) { return !q("SELECT 1 FROM ops WHERE id = ? LIMIT 1", id).isEmpty(); }

    public void opDone(long seq) { exec("DELETE FROM ops WHERE seq = ?", seq); }

    public void opFailed(long seq, String error) { exec("UPDATE ops SET tries = tries + 1, error = ? WHERE seq = ?", error, seq); }

    // ───────── Outbox ─────────

    public File outboxFile(long seq) { return new File(new File(dir, "outbox"), seq + ".eml"); }

    public static final class Outgoing {
        public long seq, at, nextAt;
        public String msgId, state, error, subject, replyTo;
        public List<String> rcpt = new ArrayList<>();
        public int tries;

        public Map<String, Object> toJson() {
            return Json.obj("seq", seq, "at", at, "state", state, "error", error, "subject", subject, "to", new ArrayList<Object>(rcpt), "tries", (long) tries);
        }
    }

    /** Reserves an outbox entry; the caller writes {@link #outboxFile} and then calls {@link #outboxReady}. */
    public long outboxCreate(String msgId, String subject, List<String> rcpt, String replyTo) {
        new File(dir, "outbox").mkdirs();
        exec("INSERT INTO outbox (msg_id, at, state, subject, rcpt, reply_to) VALUES (?, ?, 'new', ?, ?, ?)",
                msgId, System.currentTimeMillis(), subject, Json.stringify(new ArrayList<Object>(rcpt)), replyTo);
        return l(q("SELECT MAX(seq) FROM outbox").get(0)[0]);
    }

    public void outboxReady(long seq) { exec("UPDATE outbox SET state = 'queued' WHERE seq = ?", seq); }

    public void outboxState(long seq, String state, String error, long nextAt) {
        exec("UPDATE outbox SET state = ?, error = ?, tries = tries + (CASE WHEN ? IN ('queued', 'unknown', 'failed') THEN 1 ELSE 0 END), next_at = ? WHERE seq = ?",
                state, error, state, nextAt, seq);
    }

    /** Only after Gmail confirmed: the file goes, then the row. */
    public void outboxSent(long seq) {
        outboxFile(seq).delete();
        exec("DELETE FROM outbox WHERE seq = ?", seq);
    }

    public List<Outgoing> outbox() {
        List<Outgoing> out = new ArrayList<>();
        for (Object[] r : q("SELECT seq, msg_id, at, state, tries, error, subject, rcpt, reply_to, next_at FROM outbox WHERE state != 'new' ORDER BY seq")) {
            Outgoing o = new Outgoing();
            o.seq = l(r[0]);
            o.msgId = (String) r[1];
            o.at = l(r[2]);
            o.state = (String) r[3];
            o.tries = (int) l(r[4]);
            o.error = (String) r[5];
            o.subject = s(r[6]);
            for (Object x : Json.asList(Json.parse(s(r[7]).isEmpty() ? "[]" : (String) r[7]))) o.rcpt.add(String.valueOf(x));
            o.replyTo = (String) r[8];
            o.nextAt = l(r[9]);
            out.add(o);
        }
        return out;
    }

    /** Everything (account removed from this phone). */
    public synchronized void wipe() {
        tx(() -> {
            for (String t : new String[]{"kv", "msg", "lbl", "uid", "part", "folder", "ops", "outbox"}) exec("DELETE FROM " + t);
        });
        deleteDir(new File(dir, "m"));
        deleteDir(new File(dir, "outbox"));
        deleteDir(new File(dir, "tmp"));
    }

    static List<String> sortedCopy(Set<String> s) {
        List<String> l = new ArrayList<>(s);
        Collections.sort(l);
        return l;
    }
}
