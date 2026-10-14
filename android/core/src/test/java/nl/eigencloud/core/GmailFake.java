package nl.eigencloud.core;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

import nl.eigencloud.core.gmail.Imap;
import nl.eigencloud.core.gmail.MUtf7;

/**
 * A small Gmail for the tests: IMAP (plain TCP) with Gmail's model — every message once in "All Mail" with labels,
 * INBOX/Sent/Starred/label folders as views, Trash and Spam outside All Mail — and the extensions the phone uses:
 * X-GM-MSGID/THRID/LABELS/RAW, SPECIAL-USE (with Dutch folder names, so nothing may depend on names), CONDSTORE,
 * ESEARCH, MOVE, UIDPLUS, IDLE, LITERAL-, COMPRESS=DEFLATE. Plus SMTP that files what is sent under \Sent, like Gmail.
 * Its own little MIME splitter (independent from the code under test) serves BODY[n] and BODYSTRUCTURE.
 */
final class GmailFake implements Closeable {
    static final String ALL = "[Gmail]/Alle berichten", TRASH = "[Gmail]/Prullenbak", SPAM = "[Gmail]/Spam", SENT = "[Gmail]/Verzonden berichten",
            DRAFTS = "[Gmail]/Concepten", STARRED = "[Gmail]/Met ster", IMPORTANT = "[Gmail]/Belangrijk";

    static final class Msg {
        long gmid, thrid, modseq, date;
        byte[] raw;
        final Set<String> flags = new LinkedHashSet<>();
        final Set<String> labels = new LinkedHashSet<>();
        String loc = "all";
    }

    final class Folder {
        final String name, special;
        long uidValidity, nextUid = 1;
        final TreeMap<Long, Msg> byUid = new TreeMap<>();
        final Map<Msg, Long> uidOf = new IdentityHashMap<>();
        final Predicate<Msg> member;

        Folder(String name, String special, Predicate<Msg> member) {
            this.name = name;
            this.special = special;
            this.member = member;
            this.uidValidity = 1000 + folders.size();
        }
    }

    final Map<String, Folder> folders = new LinkedHashMap<>();
    final List<Msg> msgs = new ArrayList<>();
    long modseq = 5000, nextGmid = 1_700_000_000_000_000_001L;
    volatile boolean move = true, condstore = true, esearch = true, compress = true, idle = true;
    String user = "rene.test@gmail.com", password = "abcdefghijklmnop";
    final List<String> log = Collections.synchronizedList(new ArrayList<>());
    final List<String> smtpLog = Collections.synchronizedList(new ArrayList<>());
    final List<byte[]> sent = Collections.synchronizedList(new ArrayList<>());
    /** SMTP: reply code for the end of DATA (250 = fine); dropAfterData closes without a reply. */
    volatile int smtpDataReply = 250;
    volatile boolean smtpDropAfterData, smtpDeliverOnDrop = true;
    volatile int logins;

    private final ServerSocket imapServer, smtpServer;
    private final List<Socket> open = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean closed;

    GmailFake() throws IOException {
        folder("INBOX", null, m -> m.loc.equals("all") && m.labels.contains("\\Inbox"));
        folder("[Gmail]", "\\Noselect", m -> false);
        folder(ALL, "\\All", m -> m.loc.equals("all"));
        folder(TRASH, "\\Trash", m -> m.loc.equals("trash"));
        folder(SPAM, "\\Junk", m -> m.loc.equals("spam"));
        folder(SENT, "\\Sent", m -> m.loc.equals("all") && m.labels.contains("\\Sent"));
        folder(DRAFTS, "\\Drafts", m -> m.loc.equals("all") && m.labels.contains("\\Draft"));
        folder(STARRED, "\\Flagged", m -> m.loc.equals("all") && m.flags.contains("\\Flagged"));
        folder(IMPORTANT, "\\Important", m -> m.loc.equals("all") && m.labels.contains("\\Important"));
        imapServer = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        smtpServer = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        accept(imapServer, this::imapSession);
        accept(smtpServer, this::smtpSession);
    }

    int imapPort() { return imapServer.getLocalPort(); }

    int smtpPort() { return smtpServer.getLocalPort(); }

    synchronized Folder folder(String name, String special, Predicate<Msg> member) {
        Folder f = new Folder(name, special, member);
        folders.put(name, f);
        return f;
    }

    synchronized void labelFolder(String label) {
        if (!label.startsWith("\\") && !folders.containsKey(label)) folder(label, null, m -> m.loc.equals("all") && m.labels.contains(label));
    }

    // ───────── Model ─────────

    synchronized Msg add(String raw, long date, String... labels) {
        Msg m = new Msg();
        m.gmid = nextGmid++;
        m.raw = raw.replace("\r\n", "\n").replace("\n", "\r\n").getBytes(StandardCharsets.UTF_8);
        m.date = date;
        m.thrid = m.gmid;
        String irt = header(m.raw, "In-Reply-To");
        if (irt != null) for (Msg o : msgs) if (irt.trim().equals(header(o.raw, "Message-ID"))) m.thrid = o.thrid;
        for (String l : labels) {
            if (l.equals("\\Seen") || l.equals("\\Flagged") || l.equals("\\Answered")) m.flags.add(l);
            else if (l.equals("trash")) m.loc = "trash";
            else if (l.equals("spam")) m.loc = "spam";
            else { m.labels.add(l); labelFolder(l); }
        }
        m.modseq = ++modseq;
        msgs.add(m);
        refresh();
        return m;
    }

    synchronized Msg byGmid(long id) {
        for (Msg m : msgs) if (m.gmid == id) return m;
        return null;
    }

    synchronized void change(Msg m, Runnable r) {
        r.run();
        m.modseq = ++modseq;
        refresh();
    }

    synchronized void remove(Msg m) {
        msgs.remove(m);
        refresh();
    }

    /** New UIDVALIDITY for a folder (all messages get new UIDs). */
    synchronized void renumber(String folder) {
        Folder f = folders.get(folder);
        f.uidValidity += 77;
        f.byUid.clear();
        f.uidOf.clear();
        f.nextUid += 10;
        refresh();
    }

    /** Folder membership after a change: newcomers get the next UID, leavers are expunged. */
    synchronized void refresh() {
        for (Folder f : folders.values()) {
            for (Msg m : new ArrayList<>(f.uidOf.keySet())) {
                if (!msgs.contains(m) || !f.member.test(m)) f.byUid.remove(f.uidOf.remove(m));
            }
            List<Msg> sorted = new ArrayList<>(msgs);
            for (Msg m : sorted) {
                if (f.member.test(m) && !f.uidOf.containsKey(m)) {
                    long uid = f.nextUid++;
                    f.uidOf.put(m, uid);
                    f.byUid.put(uid, m);
                }
            }
        }
        notifyAll();
    }

    static String header(byte[] raw, String name) {
        String head = new String(raw, StandardCharsets.UTF_8);
        int end = head.indexOf("\r\n\r\n");
        if (end >= 0) head = head.substring(0, end);
        Matcher m = Pattern.compile("(?im)^" + Pattern.quote(name) + ":[ \\t]*(.*(?:\\r\\n[ \\t].*)*)").matcher(head);
        return m.find() ? m.group(1).replaceAll("\\r\\n[ \\t]+", " ").trim() : null;
    }

    // ───────── Sockets ─────────

    interface SessionBody {
        void run(Socket s) throws IOException;
    }

    private void accept(ServerSocket server, SessionBody body) {
        Thread t = new Thread(() -> {
            while (!closed) {
                try {
                    Socket s = server.accept();
                    open.add(s);
                    Thread c = new Thread(() -> {
                        try { body.run(s); } catch (IOException | RuntimeException e) { /* client went away */ } finally { try { s.close(); } catch (IOException ignored) { } }
                    });
                    c.setDaemon(true);
                    c.start();
                } catch (IOException e) {
                    return;
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    /** Drops every open connection (simulates the network going away). */
    void dropConnections() {
        synchronized (open) {
            for (Socket s : open) try { s.close(); } catch (IOException ignored) { }
            open.clear();
        }
    }

    @Override public void close() {
        closed = true;
        try { imapServer.close(); } catch (IOException ignored) { }
        try { smtpServer.close(); } catch (IOException ignored) { }
        dropConnections();
    }

    // ───────── IMAP session ─────────

    private final class Session {
        final Socket sock;
        InputStream in;
        OutputStream out;
        boolean auth, condstore;
        Folder selected;
        boolean readOnly;
        final List<Long> snapshot = new ArrayList<>();

        Session(Socket s) throws IOException {
            sock = s;
            in = new BufferedInputStream(s.getInputStream());
            out = new BufferedOutputStream(s.getOutputStream());
        }

        void send(String line) throws IOException {
            out.write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
        }

        void flush() throws IOException { out.flush(); }

        String readLine() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int c;
            while ((c = in.read()) != -1 && c != '\n') b.write(c);
            if (c == -1 && b.size() == 0) return null;
            String s = new String(b.toByteArray(), StandardCharsets.UTF_8);
            return s.endsWith("\r") ? s.substring(0, s.length() - 1) : s;
        }

        /** A command with its literals as segments for {@link Imap#parse}. */
        List<Object> readCommand() throws IOException {
            List<Object> seg = new ArrayList<>();
            for (;;) {
                String line = readLine();
                if (line == null) return null;
                Matcher m = Pattern.compile("\\{(\\d+)(\\+?)\\}$").matcher(line);
                if (!m.find()) { seg.add(line); return seg; }
                seg.add(line.substring(0, m.start()));
                if (m.group(2).isEmpty()) { send("+ go ahead"); flush(); }
                byte[] lit = new byte[Integer.parseInt(m.group(1))];
                int off = 0;
                while (off < lit.length) {
                    int k = in.read(lit, off, lit.length - off);
                    if (k < 0) return null;
                    off += k;
                }
                seg.add(lit);
            }
        }
    }

    private String caps(boolean authed) {
        StringBuilder b = new StringBuilder("IMAP4rev1 UNSELECT ID NAMESPACE CHILDREN X-GM-EXT-1 UIDPLUS ENABLE SPECIAL-USE LITERAL- UTF8=ACCEPT");
        if (idle) b.append(" IDLE");
        if (move) b.append(" MOVE");
        if (condstore) b.append(" CONDSTORE");
        if (esearch) b.append(" ESEARCH");
        if (compress && authed) b.append(" COMPRESS=DEFLATE");
        if (!authed) b.append(" AUTH=PLAIN AUTH=XOAUTH2");
        return b.toString();
    }

    private void imapSession(Socket s) throws IOException {
        Session ss = new Session(s);
        ss.send("* OK Gimap ready for requests from 127.0.0.1");
        ss.flush();
        for (;;) {
            List<Object> seg = ss.readCommand();
            if (seg == null) return;
            Imap.Response c = Imap.parse(seg);
            String tag = c.tag;
            String cmd = c.type == null ? "" : c.type;
            List<Object> a = c.data;
            log.add(cmd + (a.isEmpty() ? "" : " " + describe(a)));
            try {
                if (cmd.equals("UID") && !a.isEmpty()) {
                    String sub = Imap.str(a.get(0)).toUpperCase(Locale.ROOT);
                    uidCommand(ss, tag, sub, a.subList(1, a.size()));
                    continue;
                }
                switch (cmd) {
                    case "CAPABILITY": ss.send("* CAPABILITY " + caps(ss.auth)); ok(ss, tag, "Thats all she wrote!"); break;
                    case "NOOP": updates(ss); ok(ss, tag, "Success"); break;
                    case "LOGOUT": ss.send("* BYE LOGOUT Requested"); ok(ss, tag, "73 GOODBYE"); return;
                    case "ID": ss.send("* ID (\"name\" \"GImap\")"); ok(ss, tag, "Success"); break;
                    case "LOGIN": {
                        String u = Imap.str(a.get(0)), p = Imap.str(a.get(1));
                        if (u.equalsIgnoreCase(user) && p.equals(password)) {
                            ss.auth = true;
                            logins++;
                            ss.send(tag + " OK [CAPABILITY " + caps(true) + "] " + u + " authenticated (Success)");
                        } else ss.send(tag + " NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)");
                        ss.flush();
                        break;
                    }
                    case "ENABLE":
                        if (condstore) { ss.condstore = true; ss.send("* ENABLED CONDSTORE"); }
                        ok(ss, tag, "Success");
                        break;
                    case "COMPRESS":
                        ss.send(tag + " OK Success");
                        ss.flush();
                        ss.in = new BufferedInputStream(new InflaterInputStream(s.getInputStream(), new Inflater(true)));
                        ss.out = new BufferedOutputStream(new DeflaterOutputStream(s.getOutputStream(), new Deflater(Deflater.DEFAULT_COMPRESSION, true), true));
                        break;
                    case "LIST": list(ss, tag); break;
                    case "SELECT":
                    case "EXAMINE": select(ss, tag, MUtf7.decode(Imap.str(a.get(0))), cmd.equals("EXAMINE"), a.size() > 1); break;
                    case "IDLE": idleCmd(ss, tag); break;
                    case "EXPUNGE": expunge(ss, null); ok(ss, tag, "Success"); break;
                    case "CLOSE": ss.selected = null; ok(ss, tag, "Success"); break;
                    default: ss.send(tag + " BAD Unknown command " + cmd); ss.flush();
                }
            } catch (RuntimeException e) {
                ss.send(tag + " BAD " + e);
                ss.flush();
            }
        }
    }

    private static String describe(List<Object> a) {
        StringBuilder b = new StringBuilder();
        for (Object o : a) {
            if (b.length() > 0) b.append(' ');
            b.append(o instanceof byte[] ? "{literal:" + new String((byte[]) o, StandardCharsets.UTF_8) + "}" : o instanceof List ? "(" + describe(listOf(o)) + ")" : String.valueOf(o));
        }
        return b.toString();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> listOf(Object o) { return (List<Object>) o; }

    private void ok(Session ss, String tag, String text) throws IOException {
        ss.send(tag + " OK " + text);
        ss.flush();
    }

    private synchronized void list(Session ss, String tag) throws IOException {
        for (Folder f : folders.values()) {
            String attrs = f.special == null ? "\\HasNoChildren" : f.special.equals("\\Noselect") ? "\\HasChildren \\Noselect" : f.special + " \\HasNoChildren";
            ss.send("* LIST (" + attrs + ") \"/\" " + Imap.quoted(MUtf7.encode(f.name)));
        }
        ok(ss, tag, "Success");
    }

    private void select(Session ss, String tag, String name, boolean ro, boolean condstoreParam) throws IOException {
        Folder f;
        synchronized (this) {
            f = folders.get(name);
            if (f == null || "\\Noselect".equals(f.special)) { ss.send(tag + " NO [NONEXISTENT] Unknown Mailbox"); ss.flush(); return; }
            if (condstoreParam && condstore) ss.condstore = true;
            ss.selected = f;
            ss.readOnly = ro;
            ss.snapshot.clear();
            ss.snapshot.addAll(f.byUid.keySet());
            ss.send("* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing)");
            ss.send("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing \\*)] Flags permitted.");
            ss.send("* OK [UIDVALIDITY " + f.uidValidity + "] UIDs valid.");
            ss.send("* " + f.byUid.size() + " EXISTS");
            ss.send("* 0 RECENT");
            ss.send("* OK [UIDNEXT " + f.nextUid + "] Predicted next UID.");
            if (ss.condstore) ss.send("* OK [HIGHESTMODSEQ " + modseq + "]");
        }
        ok(ss, tag, (ro ? "[READ-ONLY] " : "[READ-WRITE] ") + MUtf7.encode(name) + " selected. (Success)");
    }

    /** Unsolicited EXPUNGE/EXISTS for what changed in the selected folder since the session last looked. */
    private synchronized void updates(Session ss) throws IOException {
        if (ss.selected == null) return;
        Folder f = ss.selected;
        for (int i = ss.snapshot.size() - 1; i >= 0; i--) {
            if (!f.byUid.containsKey(ss.snapshot.get(i))) {
                ss.send("* " + (i + 1) + " EXPUNGE");
                ss.snapshot.remove(i);
            }
        }
        boolean added = false;
        for (Long u : f.byUid.keySet()) if (!ss.snapshot.contains(u)) { ss.snapshot.add(u); added = true; }
        if (added) ss.send("* " + ss.snapshot.size() + " EXISTS");
    }

    private void idleCmd(Session ss, String tag) throws IOException {
        if (!idle) { ss.send(tag + " BAD IDLE not supported"); ss.flush(); return; }
        ss.send("+ idling");
        ss.flush();
        int old = ss.sock.getSoTimeout();
        ss.sock.setSoTimeout(100);
        try {
            for (;;) {
                updates(ss);
                ss.flush();
                String line;
                try {
                    line = ss.readLine();
                } catch (SocketTimeoutException e) {
                    continue;
                }
                if (line == null) throw new IOException("gone");
                if (line.equalsIgnoreCase("DONE")) break;
            }
        } finally {
            ss.sock.setSoTimeout(old);
        }
        ok(ss, tag, "IDLE terminated (Success)");
    }

    // ───────── UID commands ─────────

    private void uidCommand(Session ss, String tag, String sub, List<Object> a) throws IOException {
        if (ss.selected == null) { ss.send(tag + " BAD No mailbox selected"); ss.flush(); return; }
        switch (sub) {
            case "FETCH": uidFetch(ss, a); break;
            case "SEARCH": uidSearch(ss, a); break;
            case "STORE": {
                String code = uidStore(ss, a);
                updates(ss);
                ok(ss, tag, (code == null ? "" : "[" + code + "] ") + "Success");
                return;
            }
            case "MOVE":
                if (!move) { ss.send(tag + " BAD Unknown command"); ss.flush(); return; }
                copy(ss, a, true);
                break;
            case "COPY": copy(ss, a, false); break;
            case "EXPUNGE": expunge(ss, uids(ss.selected, Imap.str(a.get(0)))); break;
            default: ss.send(tag + " BAD Unknown UID command"); ss.flush(); return;
        }
        updates(ss);
        ok(ss, tag, "Success");
    }

    private synchronized List<Long> uids(Folder f, String set) {
        List<Long> out = new ArrayList<>();
        long max = f.byUid.isEmpty() ? 0 : f.byUid.lastKey();
        for (String part : set.split(",")) {
            int colon = part.indexOf(':');
            long lo, hi;
            if (colon < 0) { lo = hi = part.equals("*") ? max : Long.parseLong(part); }
            else {
                String x = part.substring(0, colon), y = part.substring(colon + 1);
                lo = x.equals("*") ? max : Long.parseLong(x);
                hi = y.equals("*") ? max : Long.parseLong(y);
                if (lo > hi) { long t = lo; lo = hi; hi = t; }
            }
            for (Long u : f.byUid.subMap(lo, true, hi, true).keySet()) if (!out.contains(u)) out.add(u);
        }
        Collections.sort(out);
        return out;
    }

    private void uidFetch(Session ss, List<Object> a) throws IOException {
        Folder f = ss.selected;
        long changedSince = -1;
        if (a.size() > 2 && a.get(2) instanceof List) {
            List<Object> mod = listOf(a.get(2));
            for (int i = 0; i + 1 < mod.size(); i++) if (Imap.str(mod.get(i)).equalsIgnoreCase("CHANGEDSINCE")) changedSince = Long.parseLong(Imap.str(mod.get(i + 1)));
        }
        List<Object> items = a.get(1) instanceof List ? listOf(a.get(1)) : Collections.singletonList(a.get(1));
        synchronized (this) {
            List<Long> seqs = new ArrayList<>(f.byUid.keySet());
            for (Long uid : uids(f, Imap.str(a.get(0)))) {
                Msg m = f.byUid.get(uid);
                if (changedSince >= 0 && m.modseq <= changedSince) continue;
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                int seq = seqOf(ss, seqs, uid);
                w(b, "* " + seq + " FETCH (UID " + uid);
                for (Object it : items) {
                    String item = Imap.str(it).toUpperCase(Locale.ROOT);
                    if (item.equals("UID")) continue;
                    w(b, " ");
                    fetchItem(b, f, m, item, Imap.str(it));
                }
                if (ss.condstore && !items.toString().toUpperCase(Locale.ROOT).contains("MODSEQ")) w(b, " MODSEQ (" + m.modseq + ")");
                w(b, ")\r\n");
                ss.out.write(b.toByteArray());
            }
        }
    }

    private static int seqOf(Session ss, List<Long> current, long uid) {
        int i = ss.snapshot.indexOf(uid);
        return i >= 0 ? i + 1 : current.indexOf(uid) + 1;
    }

    private static void w(ByteArrayOutputStream b, String s) {
        byte[] x = s.getBytes(StandardCharsets.UTF_8);
        b.write(x, 0, x.length);
    }

    private static void lit(ByteArrayOutputStream b, byte[] data) {
        w(b, "{" + data.length + "}\r\n");
        b.write(data, 0, data.length);
    }

    private void fetchItem(ByteArrayOutputStream b, Folder f, Msg m, String item, String original) {
        switch (item) {
            case "FLAGS": w(b, "FLAGS (" + String.join(" ", m.flags) + ")"); return;
            case "INTERNALDATE": {
                SimpleDateFormat df = new SimpleDateFormat("dd-MMM-yyyy HH:mm:ss Z", Locale.US);
                df.setTimeZone(TimeZone.getTimeZone("UTC"));
                w(b, "INTERNALDATE \"" + df.format(new Date(m.date)) + "\"");
                return;
            }
            case "RFC822.SIZE": w(b, "RFC822.SIZE " + m.raw.length); return;
            case "X-GM-MSGID": w(b, "X-GM-MSGID " + m.gmid); return;
            case "X-GM-THRID": w(b, "X-GM-THRID " + m.thrid); return;
            case "MODSEQ": w(b, "MODSEQ (" + m.modseq + ")"); return;
            case "X-GM-LABELS": {
                List<String> out = new ArrayList<>();
                for (String l : m.labels) out.add(l.startsWith("\\") ? "\"\\" + l + "\"" : atomOrQuoted(MUtf7.encode(l)));
                if (m.flags.contains("\\Flagged")) out.add("\"\\\\Starred\"");
                w(b, "X-GM-LABELS (" + String.join(" ", out) + ")");
                return;
            }
            case "BODYSTRUCTURE": w(b, "BODYSTRUCTURE " + bodystructure(Ent.parse(m.raw, 0, m.raw.length), true)); return;
            default:
        }
        Matcher x = Pattern.compile("^BODY(?:\\.PEEK)?\\[(.*)\\](?:<(\\d+)\\.(\\d+)>)?$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(original);
        if (!x.matches()) throw new IllegalArgumentException("item " + item);
        String section = x.group(1);
        byte[] data = section(m.raw, section);
        String key = "BODY[" + section + "]";
        if (x.group(2) != null) {
            int start = Integer.parseInt(x.group(2)), len = Integer.parseInt(x.group(3));
            int s = Math.min(start, data.length), e = Math.min(data.length, s + len);
            byte[] d = new byte[e - s];
            System.arraycopy(data, s, d, 0, d.length);
            data = d;
            key += "<" + start + ">";
        }
        w(b, key + " ");
        lit(b, data);
    }

    private static String atomOrQuoted(String s) {
        return s.matches("[A-Za-z0-9&,+._-]+") ? s : Imap.quoted(s);
    }

    private static byte[] section(byte[] raw, String section) {
        Ent e = Ent.parse(raw, 0, raw.length);
        String s = section.toUpperCase(Locale.ROOT);
        if (s.isEmpty()) return raw;
        if (s.equals("HEADER")) return slice(raw, e.start, e.bodyStart);
        if (s.equals("TEXT")) return slice(raw, e.bodyStart, e.end);
        if (s.startsWith("HEADER.FIELDS")) {
            Set<String> want = new LinkedHashSet<>();
            for (String n : s.replaceAll(".*\\((.*)\\).*", "$1").trim().split("\\s+")) want.add(n.toLowerCase(Locale.ROOT));
            StringBuilder out = new StringBuilder();
            String head = new String(raw, e.start, e.bodyStart - e.start, StandardCharsets.UTF_8);
            String cur = null;
            for (String line : head.split("\r\n")) {
                if (line.isEmpty()) continue;
                if ((line.startsWith(" ") || line.startsWith("\t")) && cur != null) { out.append(line).append("\r\n"); continue; }
                int colon = line.indexOf(':');
                cur = colon > 0 && want.contains(line.substring(0, colon).trim().toLowerCase(Locale.ROOT)) ? line : null;
                if (cur != null) out.append(line).append("\r\n");
            }
            out.append("\r\n");
            return out.toString().getBytes(StandardCharsets.UTF_8);
        }
        // numeric section
        Ent cur = e;
        String[] path = s.split("\\.");
        for (int i = 0; i < path.length; i++) {
            if (path[i].equals("MIME")) return slice(raw, cur.start, cur.bodyStart);
            int n = Integer.parseInt(path[i]);
            if (cur.children == null) {
                if (n == 1) continue; // a non-multipart body is part 1
                return new byte[0];
            }
            if (n < 1 || n > cur.children.size()) return new byte[0];
            cur = cur.children.get(n - 1);
        }
        return slice(raw, cur.bodyStart, cur.end);
    }

    static byte[] slice(byte[] raw, int a, int b) {
        byte[] d = new byte[Math.max(0, b - a)];
        System.arraycopy(raw, a, d, 0, d.length);
        return d;
    }

    /** Independent mini MIME splitter for sections and BODYSTRUCTURE. */
    static final class Ent {
        int start, bodyStart, end;
        String type = "text", sub = "plain", enc = "7BIT", id, disp;
        final Map<String, String> params = new LinkedHashMap<>(), dparams = new LinkedHashMap<>();
        List<Ent> children;

        static Ent parse(byte[] raw, int from, int to) {
            Ent e = new Ent();
            e.start = from;
            e.end = to;
            int hb = from;
            e.bodyStart = to;
            for (int i = from; i < to; i++) {
                if (raw[i] == '\n' && (i == from || (i + 2 < to && raw[i + 1] == '\r' && raw[i + 2] == '\n'))) { e.bodyStart = i == from ? i + 1 : i + 3; break; }
                if (i == from && raw[i] == '\r' && i + 1 < to && raw[i + 1] == '\n') { e.bodyStart = i + 2; break; }
            }
            String head = new String(raw, hb, e.bodyStart - hb, StandardCharsets.UTF_8).replaceAll("\\r\\n[ \\t]+", " ");
            for (String line : head.split("\r\n")) {
                int colon = line.indexOf(':');
                if (colon <= 0) continue;
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT), value = line.substring(colon + 1).trim();
                if (name.equals("content-type")) {
                    String[] p = split(value);
                    String[] t = p[0].trim().toLowerCase(Locale.ROOT).split("/");
                    e.type = t[0];
                    e.sub = t.length > 1 ? t[1] : "plain";
                    for (int i = 1; i < p.length; i++) param(p[i], e.params);
                } else if (name.equals("content-transfer-encoding")) e.enc = value.toUpperCase(Locale.ROOT);
                else if (name.equals("content-id")) e.id = value;
                else if (name.equals("content-disposition")) {
                    String[] p = split(value);
                    e.disp = p[0].trim().toUpperCase(Locale.ROOT);
                    for (int i = 1; i < p.length; i++) param(p[i], e.dparams);
                }
            }
            String boundary = e.params.get("BOUNDARY");
            if (e.type.equals("multipart") && boundary != null) {
                e.children = new ArrayList<>();
                byte[] d = ("--" + boundary).getBytes(StandardCharsets.UTF_8);
                int partStart = -1;
                int i = e.bodyStart;
                while (i < to) {
                    int le = i;
                    while (le < to && raw[le] != '\n') le++;
                    boolean match = le - i >= d.length;
                    for (int k = 0; match && k < d.length; k++) if (raw[i + k] != d[k]) match = false;
                    if (match) {
                        String rest = new String(raw, i + d.length, Math.max(0, le - i - d.length), StandardCharsets.UTF_8).trim();
                        if (rest.isEmpty() || rest.equals("--")) {
                            if (partStart >= 0) {
                                int pe = i;
                                if (pe > partStart && raw[pe - 1] == '\n') pe--;
                                if (pe > partStart && raw[pe - 1] == '\r') pe--;
                                e.children.add(parse(raw, partStart, pe));
                            }
                            if (rest.equals("--")) break;
                            partStart = Math.min(to, le + 1);
                        }
                    }
                    i = le + 1;
                }
            }
            return e;
        }

        private static String[] split(String v) {
            List<String> out = new ArrayList<>();
            StringBuilder cur = new StringBuilder();
            boolean q = false;
            for (char c : v.toCharArray()) {
                if (c == '"') q = !q;
                if (c == ';' && !q) { out.add(cur.toString()); cur.setLength(0); continue; }
                cur.append(c);
            }
            out.add(cur.toString());
            return out.toArray(new String[0]);
        }

        private static void param(String p, Map<String, String> into) {
            int eq = p.indexOf('=');
            if (eq <= 0) return;
            String v = p.substring(eq + 1).trim();
            if (v.startsWith("\"") && v.endsWith("\"") && v.length() >= 2) v = v.substring(1, v.length() - 1);
            into.put(p.substring(0, eq).trim().toUpperCase(Locale.ROOT), v);
        }
    }

    private static String q(String s) { return s == null ? "NIL" : Imap.quoted(s); }

    private static String plist(Map<String, String> p) {
        if (p.isEmpty()) return "NIL";
        StringBuilder b = new StringBuilder("(");
        for (Map.Entry<String, String> e : p.entrySet()) {
            if (b.length() > 1) b.append(' ');
            b.append(q(e.getKey())).append(' ').append(q(e.getValue()));
        }
        return b.append(')').toString();
    }

    private static String bodystructure(Ent e, boolean top) {
        if (e.children != null) {
            StringBuilder b = new StringBuilder("(");
            for (Ent c : e.children) b.append(bodystructure(c, false));
            Map<String, String> p = new LinkedHashMap<>(e.params);
            b.append(' ').append(q(e.sub.toUpperCase(Locale.ROOT))).append(' ').append(plist(p)).append(" NIL NIL NIL)");
            return b.toString();
        }
        int size = e.end - e.bodyStart;
        StringBuilder b = new StringBuilder("(");
        b.append(q(e.type.toUpperCase(Locale.ROOT))).append(' ').append(q(e.sub.toUpperCase(Locale.ROOT))).append(' ').append(plist(e.params)).append(' ')
                .append(q(e.id)).append(" NIL ").append(q(e.enc)).append(' ').append(size);
        if (e.type.equals("text")) b.append(' ').append(1);
        if (e.type.equals("message") && e.sub.equals("rfc822")) b.append(" (NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL) (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 0 0) 0");
        b.append(" NIL ");
        b.append(e.disp == null ? "NIL" : "(" + q(e.disp) + " " + plist(e.dparams) + ")");
        b.append(" NIL NIL)");
        return b.toString();
    }

    private void uidSearch(Session ss, List<Object> a) throws IOException {
        Folder f = ss.selected;
        boolean count = false;
        int i = 0;
        if (i < a.size() && Imap.str(a.get(i)).equalsIgnoreCase("RETURN")) {
            count = Imap.str(a.get(i + 1)).toUpperCase(Locale.ROOT).contains("COUNT");
            i += 2;
        }
        if (i < a.size() && Imap.str(a.get(i)).equalsIgnoreCase("CHARSET")) i += 2;
        List<Long> hits = new ArrayList<>();
        synchronized (this) {
            hits.addAll(f.byUid.keySet());
            while (i < a.size()) {
                String k = Imap.str(a.get(i)).toUpperCase(Locale.ROOT);
                if (k.equals("ALL")) { i++; continue; }
                if (k.equals("UID")) { List<Long> set = uids(f, Imap.str(a.get(i + 1))); hits.retainAll(set); i += 2; continue; }
                if (k.equals("X-GM-RAW")) {
                    String needle = Imap.str(a.get(i + 1)).toLowerCase(Locale.ROOT);
                    hits.removeIf(u -> !new String(f.byUid.get(u).raw, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT).contains(needle));
                    i += 2;
                    continue;
                }
                if (k.equals("X-GM-MSGID")) { long id = Long.parseLong(Imap.str(a.get(i + 1))); hits.removeIf(u -> f.byUid.get(u).gmid != id); i += 2; continue; }
                if (k.equals("HEADER")) {
                    String name = Imap.str(a.get(i + 1)), val = Imap.str(a.get(i + 2));
                    hits.removeIf(u -> { String h = header(f.byUid.get(u).raw, name); return h == null || !h.contains(val); });
                    i += 3;
                    continue;
                }
                if (k.equals("SINCE")) {
                    try {
                        SimpleDateFormat df = new SimpleDateFormat("d-MMM-yyyy", Locale.US);
                        df.setTimeZone(TimeZone.getTimeZone("UTC"));
                        long since = df.parse(Imap.str(a.get(i + 1))).getTime();
                        hits.removeIf(u -> f.byUid.get(u).date < since);
                    } catch (java.text.ParseException e) {
                        throw new IllegalArgumentException(e);
                    }
                    i += 2;
                    continue;
                }
                throw new IllegalArgumentException("search key " + k);
            }
        }
        if (count && esearch) ss.send("* ESEARCH UID COUNT " + hits.size());
        else {
            StringBuilder b = new StringBuilder("* SEARCH");
            for (Long u : hits) b.append(' ').append(u);
            ss.send(b.toString());
        }
    }

    /** Returns a response code (MODIFIED …) or null. */
    private String uidStore(Session ss, List<Object> a) throws IOException {
        Folder f = ss.selected;
        int i = 1;
        long unchanged = -1;
        if (a.get(1) instanceof List) {
            List<Object> mod = listOf(a.get(1));
            unchanged = Long.parseLong(Imap.str(mod.get(1)));
            i = 2;
        }
        String action = Imap.str(a.get(i)).toUpperCase(Locale.ROOT);
        List<Object> values = a.get(i + 1) instanceof List ? listOf(a.get(i + 1)) : Collections.singletonList(a.get(i + 1));
        boolean silent = action.endsWith(".SILENT");
        String what = action.replace(".SILENT", "");
        List<Long> modified = new ArrayList<>();
        synchronized (this) {
            List<Long> set = uids(f, Imap.str(a.get(0)));
            List<Msg> touched = new ArrayList<>();
            for (Long uid : set) {
                Msg m = f.byUid.get(uid);
                if (unchanged >= 0 && m.modseq > unchanged) { modified.add(uid); continue; }
                boolean labels = what.contains("X-GM-LABELS");
                Set<String> target = labels ? m.labels : m.flags;
                Set<String> before = new LinkedHashSet<>(target);
                List<String> vals = new ArrayList<>();
                for (Object v : values) {
                    String s = Imap.str(v);
                    vals.add(labels && !s.startsWith("\\") ? MUtf7.decode(s) : s);
                }
                if (what.startsWith("+")) target.addAll(vals);
                else if (what.startsWith("-")) target.removeAll(vals);
                else { target.clear(); target.addAll(vals); }
                if (labels) for (String v : vals) labelFolder(v);
                if (!before.equals(target)) m.modseq = ++modseq;
                touched.add(m);
            }
            List<Long> seqs = new ArrayList<>(f.byUid.keySet());
            if (!silent) {
                for (Msg m : touched) {
                    long uid = f.uidOf.get(m);
                    ss.send("* " + seqOf(ss, seqs, uid) + " FETCH (UID " + uid + " FLAGS (" + String.join(" ", m.flags) + ")" + (ss.condstore ? " MODSEQ (" + m.modseq + ")" : "") + ")");
                }
            }
            refresh();
        }
        return modified.isEmpty() ? null : "MODIFIED " + Imap.set(modified);
    }

    private void copy(Session ss, List<Object> a, boolean isMove) {
        Folder from = ss.selected;
        String dest = MUtf7.decode(Imap.str(a.get(1)));
        synchronized (this) {
            Folder to = folders.get(dest);
            if (to == null) throw new IllegalArgumentException("[TRYCREATE] no such folder");
            for (Long uid : uids(from, Imap.str(a.get(0)))) {
                Msg m = from.byUid.get(uid);
                if (to.special != null && to.special.equals("\\Trash")) m.loc = "trash";
                else if (to.special != null && to.special.equals("\\Junk")) m.loc = "spam";
                else if (to.name.equals("INBOX")) { m.loc = "all"; m.labels.add("\\Inbox"); }
                else if (to.special != null && to.special.equals("\\All")) m.loc = "all";
                else if (to.special == null) { m.loc = "all"; m.labels.add(to.name); }
                if (isMove && from.name.equals("INBOX")) m.labels.remove("\\Inbox");
                if (isMove && from.special == null && !from.name.equals("INBOX")) m.labels.remove(from.name);
                m.modseq = ++modseq;
            }
            refresh();
        }
    }

    private void expunge(Session ss, List<Long> only) throws IOException {
        Folder f = ss.selected;
        synchronized (this) {
            for (Map.Entry<Long, Msg> e : new ArrayList<>(f.byUid.entrySet())) {
                Msg m = e.getValue();
                if (!m.flags.contains("\\Deleted") || (only != null && !only.contains(e.getKey()))) continue;
                m.flags.remove("\\Deleted");
                if (f.special != null && (f.special.equals("\\Trash") || f.special.equals("\\Junk"))) msgs.remove(m);
                else if (f.name.equals("INBOX")) m.labels.remove("\\Inbox");
                else if (f.special != null && f.special.equals("\\All")) m.loc = "trash";
                else m.labels.remove(f.name);
                m.modseq = ++modseq;
            }
            refresh();
        }
    }

    // ───────── SMTP ─────────

    private void smtpSession(Socket s) throws IOException {
        InputStream in = new BufferedInputStream(s.getInputStream());
        OutputStream out = s.getOutputStream();
        Session io = new Session(s);
        io.in = in;
        io.out = new BufferedOutputStream(out);
        io.send("220 smtp.fake ESMTP ready");
        io.flush();
        boolean authed = false;
        String from = null;
        List<String> rcpt = new ArrayList<>();
        for (;;) {
            String line = io.readLine();
            if (line == null) return;
            smtpLog.add(line.startsWith("AUTH PLAIN ") ? "AUTH PLAIN …" : line);
            String up = line.toUpperCase(Locale.ROOT);
            if (up.startsWith("EHLO")) { io.send("250-smtp.fake at your service"); io.send("250-SIZE 35882577"); io.send("250-AUTH LOGIN PLAIN XOAUTH2"); io.send("250 8BITMIME"); }
            else if (up.startsWith("AUTH PLAIN ")) {
                String[] p = new String(Base64.getDecoder().decode(line.substring(11).trim()), StandardCharsets.UTF_8).split("\0", -1);
                authed = p.length == 3 && p[1].equalsIgnoreCase(user) && p[2].equals(password);
                io.send(authed ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted");
            } else if (up.startsWith("MAIL FROM:")) {
                if (!authed) io.send("530 5.7.0 Authentication Required");
                else { from = line.substring(10).trim(); rcpt.clear(); io.send("250 2.1.0 OK"); }
            } else if (up.startsWith("RCPT TO:")) {
                String r = line.substring(8).trim();
                if (r.contains("bounce")) io.send("550 5.1.1 The email account that you tried to reach does not exist");
                else { rcpt.add(r); io.send("250 2.1.5 OK"); }
            } else if (up.equals("DATA")) {
                io.send("354 Go ahead");
                io.flush();
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                for (;;) {
                    String l = io.readLine();
                    if (l == null) return;
                    if (l.equals(".")) break;
                    if (l.startsWith("..")) l = l.substring(1);
                    byte[] x = (l + "\r\n").getBytes(StandardCharsets.UTF_8);
                    data.write(x, 0, x.length);
                }
                byte[] msg = data.toByteArray();
                boolean deliver = smtpDropAfterData ? smtpDeliverOnDrop : smtpDataReply == 250;
                if (deliver) {
                    sent.add(msg);
                    Msg m = add(new String(msg, StandardCharsets.UTF_8), System.currentTimeMillis(), "\\Sent", "\\Seen");
                    m.flags.add("\\Seen");
                }
                if (smtpDropAfterData) { s.close(); return; }
                io.send(smtpDataReply == 250 ? "250 2.0.0 OK 1700000000 x1-20020a" : smtpDataReply + " 4.7.0 Try again later");
            } else if (up.equals("QUIT")) { io.send("221 2.0.0 closing connection"); io.flush(); return; }
            else if (up.equals("RSET") || up.equals("NOOP")) io.send("250 OK");
            else io.send("502 5.5.1 Unrecognized command");
            io.flush();
        }
    }
}
