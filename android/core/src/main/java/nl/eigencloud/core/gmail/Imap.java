package nl.eigencloud.core.gmail;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

/**
 * IMAP4rev1 client for Gmail (RFC 3501 + CONDSTORE, UIDPLUS, MOVE, IDLE, ESEARCH, LITERAL+, COMPRESS=DEFLATE,
 * SPECIAL-USE and Gmail's X-GM-EXT-1). One connection, one command at a time. Responses are parsed into
 * nested lists of Strings (atoms and quoted strings), byte[] (literals) and null (NIL).
 */
public final class Imap implements Closeable {

    public static final class Config {
        public String host = "imap.gmail.com";
        public int port = 993;
        /** Implicit TLS; only tests turn it off. */
        public boolean tls = true;
        public int timeoutMs = 60_000;
        public boolean compress = true;

        public static Config gmail() { return new Config(); }
    }

    public static class ImapException extends IOException {
        private static final long serialVersionUID = 1L;
        public final String status, code;

        public ImapException(String status, String code, String text) {
            super(text);
            this.status = status;
            this.code = code;
        }

        public boolean authFailed() {
            String t = (code + " " + getMessage()).toUpperCase(Locale.ROOT);
            return t.contains("AUTHENTICATIONFAILED") || t.contains("INVALID CREDENTIALS") || t.contains("AUTHORIZATIONFAILED") || t.contains("WEBALERT");
        }

        /** Gmail's way of saying: slow down (bandwidth or command limits, too many connections). */
        public boolean throttled() {
            String t = (code + " " + getMessage()).toUpperCase(Locale.ROOT);
            return t.contains("THROTTLED") || t.contains("OVERQUOTA") || t.contains("LIMIT") || t.contains("TOO MANY") || t.contains("UNAVAILABLE");
        }
    }

    /** One response line (with its literals) after parsing. */
    public static final class Response {
        /** "*", "+" or the command tag. */
        public String tag;
        /** OK/NO/BAD/BYE/PREAUTH for status responses, else null. */
        public String status;
        /** Response code without brackets ("UIDVALIDITY 123"), or null. */
        public String code;
        /** Human text of a status or continuation response. */
        public String text = "";
        /** "* 12 EXISTS" → 12; -1 when absent. */
        public long number = -1;
        /** Upper-case keyword: EXISTS, EXPUNGE, FETCH, LIST, SEARCH, ESEARCH, CAPABILITY, FLAGS, VANISHED, ENABLED, … */
        public String type;
        /** Tokens after the keyword. */
        public final List<Object> data = new ArrayList<>();
    }

    public static final class Mailbox {
        public String name;
        public long exists, uidValidity, uidNext, highestModseq;
        public boolean readOnly;
    }

    public static final class ListEntry {
        /** As on the wire (modified UTF-7) — use this in commands. */
        public String raw;
        /** Decoded for people. */
        public String name;
        public String delimiter;
        /** Lower-case attributes, e.g. "\\all", "\\noselect", "\\haschildren". */
        public final Set<String> attrs = new HashSet<>();

        public boolean has(String a) { return attrs.contains(a.toLowerCase(Locale.ROOT)); }
    }

    /** A FETCH response: items by upper-case name ("UID", "FLAGS", "BODY[]", "BODY[TEXT]<0>", "X-GM-LABELS", …). */
    public static final class Fetch {
        public long seq;
        public final Map<String, Object> items = new LinkedHashMap<>();

        public long uid() { return num(items.get("UID")); }

        public Object get(String key) { return items.get(key); }

        /**
         * Body section: "BODY[TEXT]" also matches the partial "BODY[TEXT]&lt;0&gt;"; a prefix without "]" (like
         * "BODY[HEADER.FIELDS") matches any key starting with it.
         */
        public byte[] body(String prefix) {
            String p = prefix.toUpperCase(Locale.ROOT);
            boolean open = !p.endsWith("]");
            for (Map.Entry<String, Object> e : items.entrySet()) {
                String k = e.getKey();
                if (k.startsWith(p) && (open || k.length() == p.length() || k.charAt(p.length()) == '<')) {
                    Object v = e.getValue();
                    return v instanceof byte[] ? (byte[]) v : v instanceof String ? ((String) v).getBytes(StandardCharsets.UTF_8) : new byte[0];
                }
            }
            return null;
        }

        public List<String> strings(String key) {
            List<String> out = new ArrayList<>();
            Object v = items.get(key);
            if (v instanceof List) for (Object o : (List<?>) v) if (o != null) out.add(str(o));
            return out;
        }
    }

    public interface Handler {
        void untagged(Response r) throws IOException;
    }

    /** A literal command argument (sent as {n} or {n+}). */
    public static final class Lit {
        final byte[] bytes;

        public Lit(byte[] b) { bytes = b; }
    }

    private final Config cfg;
    private Socket sock;
    private InputStream in;
    private OutputStream out;
    private int tagNo;
    public final Set<String> caps = new HashSet<>();
    public Mailbox selected;
    private boolean condstoreEnabled;
    /** Untagged EXISTS/EXPUNGE/FETCH/VANISHED seen outside of a handler (e.g. during IDLE or NOOP). */
    public final List<Response> events = new ArrayList<>();

    public Imap(Config cfg) throws IOException {
        this.cfg = cfg;
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(cfg.host, cfg.port), Math.min(cfg.timeoutMs, 20_000));
        raw.setSoTimeout(cfg.timeoutMs);
        sock = cfg.tls ? Smtp.tls(raw, cfg.host, cfg.port) : raw;
        in = new BufferedInputStream(sock.getInputStream(), 64 * 1024);
        out = new BufferedOutputStream(sock.getOutputStream(), 16 * 1024);
        Response greet = read();
        if ("BYE".equals(greet.status)) throw new ImapException("BYE", greet.code, greet.text);
        caps(greet);
        if (caps.isEmpty()) command("CAPABILITY");
    }

    private void caps(Response r) {
        String code = r.code;
        if (code != null && code.toUpperCase(Locale.ROOT).startsWith("CAPABILITY ")) {
            caps.clear();
            for (String c : code.substring(11).trim().split("\\s+")) caps.add(c.toUpperCase(Locale.ROOT));
        }
    }

    public boolean has(String cap) { return caps.contains(cap.toUpperCase(Locale.ROOT)); }

    public void login(String user, String password) throws IOException {
        if (has("LOGINDISABLED")) throw new ImapException("NO", null, "Inloggen met wachtwoord is uitgeschakeld op deze server");
        command("LOGIN ", astring(user), " ", astring(password));
        command("CAPABILITY"); // capabilities change after login
        if (cfg.compress && has("COMPRESS=DEFLATE")) compress();
        if (has("CONDSTORE")) {
            if (has("ENABLE")) command("ENABLE CONDSTORE");
            condstoreEnabled = true;
        }
    }

    public boolean condstore() { return condstoreEnabled; }

    private void compress() throws IOException {
        command("COMPRESS DEFLATE");
        in = new BufferedInputStream(new InflaterInputStream(sock.getInputStream(), new Inflater(true), 16 * 1024), 64 * 1024);
        out = new BufferedOutputStream(new DeflaterOutputStream(sock.getOutputStream(), new Deflater(Deflater.DEFAULT_COMPRESSION, true), 16 * 1024, true), 16 * 1024);
    }

    public List<ListEntry> list() throws IOException {
        List<ListEntry> out = new ArrayList<>();
        command(r -> {
            if (!"LIST".equals(r.type) && !"XLIST".equals(r.type)) return;
            ListEntry e = new ListEntry();
            Object attrs = r.data.size() > 0 ? r.data.get(0) : null;
            if (attrs instanceof List) for (Object a : (List<?>) attrs) if (a != null) e.attrs.add(str(a).toLowerCase(Locale.ROOT));
            e.delimiter = r.data.size() > 1 && r.data.get(1) != null ? str(r.data.get(1)) : "/";
            e.raw = r.data.size() > 2 ? str(r.data.get(2)) : "";
            e.name = MUtf7.decode(e.raw);
            out.add(e);
        }, "LIST \"\" \"*\"");
        return out;
    }

    public Mailbox select(String rawName, boolean readOnly) throws IOException {
        Mailbox m = new Mailbox();
        m.name = rawName;
        m.readOnly = readOnly;
        selected = null;
        Response done = command(r -> {
            if ("EXISTS".equals(r.type)) m.exists = r.number;
            if (r.code != null) code(m, r.code);
        }, readOnly ? "EXAMINE " : "SELECT ", quoted(rawName), condstoreEnabled && !has("ENABLE") ? " (CONDSTORE)" : "");
        if (done.code != null) code(m, done.code);
        selected = m;
        events.clear();
        return m;
    }

    private static void code(Mailbox m, String code) {
        String[] p = code.split("\\s+");
        if (p.length < 2) return;
        try {
            switch (p[0].toUpperCase(Locale.ROOT)) {
                case "UIDVALIDITY": m.uidValidity = Long.parseLong(p[1]); break;
                case "UIDNEXT": m.uidNext = Long.parseLong(p[1]); break;
                case "HIGHESTMODSEQ": m.highestModseq = Long.parseLong(p[1]); break;
                default: break;
            }
        } catch (NumberFormatException ignored) {
            // odd server: leave 0
        }
    }

    /** UID SEARCH; {@code criteria} are command parts (Strings and {@link Lit}s). */
    public List<Long> uidSearch(Object... criteria) throws IOException {
        List<Long> uids = new ArrayList<>();
        Object[] parts = new Object[criteria.length + 1];
        parts[0] = "UID SEARCH ";
        System.arraycopy(criteria, 0, parts, 1, criteria.length);
        command(r -> {
            if ("SEARCH".equals(r.type)) {
                for (Object o : r.data) {
                    if (o instanceof String && ((String) o).matches("\\d+")) uids.add(Long.parseLong((String) o));
                }
            } else if ("ESEARCH".equals(r.type)) {
                for (int i = 0; i + 1 < r.data.size(); i++) if ("ALL".equalsIgnoreCase(str(r.data.get(i)))) uids.addAll(parseSet(str(r.data.get(i + 1))));
            }
        }, parts);
        return uids;
    }

    /** Number of messages matching (ESEARCH COUNT when available). */
    public long uidSearchCount(String criteria) throws IOException {
        if (!has("ESEARCH")) return uidSearch(criteria).size();
        long[] count = {0};
        command(r -> {
            if (!"ESEARCH".equals(r.type)) return;
            for (int i = 0; i + 1 < r.data.size(); i++) if ("COUNT".equalsIgnoreCase(str(r.data.get(i)))) count[0] = Long.parseLong(str(r.data.get(i + 1)));
        }, "UID SEARCH RETURN (COUNT) " + criteria);
        return count[0];
    }

    public interface FetchHandler {
        void fetched(Fetch f) throws IOException;
    }

    /** UID FETCH set items [modifiers]; each response goes to {@code each} as it arrives (no buffering of the whole result). */
    public void uidFetch(String set, String items, String modifiers, FetchHandler each) throws IOException {
        command(r -> {
            if (!"FETCH".equals(r.type)) { events.add(r); return; }
            Fetch f = toFetch(r);
            if (f.items.containsKey("UID")) each.fetched(f);
            else events.add(r); // an unsolicited flag update without UID
        }, "UID FETCH " + set + " " + items + (modifiers == null || modifiers.isEmpty() ? "" : " " + modifiers));
    }

    static Fetch toFetch(Response r) {
        Fetch f = new Fetch();
        f.seq = r.number;
        Object list = r.data.isEmpty() ? null : r.data.get(0);
        if (list instanceof List) {
            List<?> l = (List<?>) list;
            for (int i = 0; i + 1 < l.size(); i += 2) f.items.put(str(l.get(i)).toUpperCase(Locale.ROOT), l.get(i + 1));
        }
        return f;
    }

    public static final class StoreResult {
        /** UIDs for which the server sent the new state. */
        public final Set<Long> touched = new HashSet<>();
        /** CONDSTORE: UIDs not changed because they were modified since UNCHANGEDSINCE. */
        public final Set<Long> modified = new HashSet<>();
    }

    /**
     * UID STORE set [(UNCHANGEDSINCE m)] action values, e.g. action "+FLAGS" values "(\\Seen)", or "-X-GM-LABELS".
     * Not silent, so we learn which messages still exist.
     */
    public StoreResult uidStore(String set, Long unchangedSince, String action, Object... values) throws IOException {
        StoreResult res = new StoreResult();
        Object[] parts = new Object[values.length + 1];
        parts[0] = "UID STORE " + set + (unchangedSince != null && condstoreEnabled ? " (UNCHANGEDSINCE " + unchangedSince + ")" : "") + " " + action + " ";
        System.arraycopy(values, 0, parts, 1, values.length);
        Response done = command(r -> {
            if ("FETCH".equals(r.type)) {
                Fetch f = toFetch(r);
                if (f.items.containsKey("UID")) res.touched.add(f.uid());
            }
        }, parts);
        if (done.code != null && done.code.toUpperCase(Locale.ROOT).startsWith("MODIFIED ")) res.modified.addAll(parseSet(done.code.substring(9).trim()));
        return res;
    }

    /** Moves messages; without MOVE: COPY, mark \Deleted and expunge just those (UIDPLUS) or all deleted. */
    public void uidMove(String set, String destRaw) throws IOException {
        if (has("MOVE")) {
            command("UID MOVE " + set + " ", quoted(destRaw));
            return;
        }
        command("UID COPY " + set + " ", quoted(destRaw));
        uidStore(set, null, "+FLAGS.SILENT", "(\\Deleted)");
        uidExpunge(set);
    }

    public void uidExpunge(String set) throws IOException {
        if (has("UIDPLUS")) command("UID EXPUNGE " + set);
        else command("EXPUNGE");
    }

    public void noop() throws IOException { command("NOOP"); }

    /**
     * IDLE until something changes in the selected mailbox, {@code maxMs} passes, or {@code stop} says so (checked
     * about every second). Returns the untagged responses that arrived (EXISTS, EXPUNGE, FETCH).
     */
    public List<Response> idle(long maxMs, BooleanSupplier stop) throws IOException {
        if (!has("IDLE")) {
            long until = System.currentTimeMillis() + Math.min(maxMs, 60_000);
            while (System.currentTimeMillis() < until && !stop.getAsBoolean()) {
                try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
            }
            noop();
            List<Response> got = new ArrayList<>(events);
            events.clear();
            return got;
        }
        String tag = nextTag();
        write(tag + " IDLE\r\n");
        Response cont = read();
        while (!"+".equals(cont.tag)) {
            if (tag.equals(cont.tag)) throw new ImapException(cont.status, cont.code, cont.text);
            untagged(cont, null);
            cont = read();
        }
        List<Response> got = new ArrayList<>();
        long until = System.currentTimeMillis() + maxMs;
        int old = sock.getSoTimeout();
        try {
            sock.setSoTimeout(1000);
            while (System.currentTimeMillis() < until && !stop.getAsBoolean() && got.isEmpty()) {
                Response r;
                try {
                    r = read(true);
                } catch (SocketTimeoutException tick) {
                    continue;
                }
                if (r == null) continue;
                if ("BYE".equals(r.status)) throw new ImapException("BYE", r.code, r.text);
                if (r.type != null && (r.type.equals("EXISTS") || r.type.equals("EXPUNGE") || r.type.equals("FETCH") || r.type.equals("VANISHED"))) got.add(r);
            }
        } finally {
            sock.setSoTimeout(old);
        }
        write("DONE\r\n");
        for (;;) {
            Response r = read();
            if (tag.equals(r.tag)) {
                if (!"OK".equals(r.status)) throw new ImapException(r.status, r.code, r.text);
                break;
            }
            if (r.type != null && (r.type.equals("EXISTS") || r.type.equals("EXPUNGE") || r.type.equals("FETCH") || r.type.equals("VANISHED"))) got.add(r);
        }
        return got;
    }

    public void logout() {
        try { command("LOGOUT"); } catch (IOException ignored) { /* closing anyway */ }
        close();
    }

    @Override
    public void close() {
        try { sock.close(); } catch (IOException ignored) { /* closing */ }
    }

    // ───────── Commands ─────────

    public Response command(Object... parts) throws IOException { return command(null, parts); }

    private String nextTag() { return "A" + (++tagNo); }

    /** Sends a command (Strings as is, {@link Lit} as literals) and reads until its tagged response. NO/BAD throw. */
    public Response command(Handler h, Object... parts) throws IOException {
        String tag = nextTag();
        write(tag + " ");
        for (Object p : parts) {
            if (p instanceof Lit) {
                byte[] b = ((Lit) p).bytes;
                boolean nonSync = has("LITERAL+") || (has("LITERAL-") && b.length <= 4096);
                write("{" + b.length + (nonSync ? "+" : "") + "}\r\n");
                if (!nonSync) {
                    for (;;) {
                        Response r = read();
                        if ("+".equals(r.tag)) break;
                        if (tag.equals(r.tag)) throw new ImapException(r.status, r.code, r.text);
                        untagged(r, h);
                    }
                }
                out.write(b);
            } else {
                write(String.valueOf(p));
            }
        }
        write("\r\n");
        for (;;) {
            Response r = read();
            if (tag.equals(r.tag)) {
                caps(r);
                if (!"OK".equals(r.status)) throw new ImapException(r.status, r.code, r.text.isEmpty() ? r.status : r.text);
                return r;
            }
            if ("+".equals(r.tag)) continue; // unexpected continuation
            untagged(r, h);
        }
    }

    private void untagged(Response r, Handler h) throws IOException {
        if ("BYE".equals(r.status)) {
            throw new ImapException("BYE", r.code, r.text.isEmpty() ? "De server sloot de verbinding" : r.text);
        }
        caps(r);
        if ("CAPABILITY".equals(r.type)) {
            caps.clear();
            for (Object o : r.data) if (o != null) caps.add(str(o).toUpperCase(Locale.ROOT));
            return;
        }
        if (selected != null && "EXISTS".equals(r.type)) selected.exists = r.number;
        if (h != null) h.untagged(r);
        else if (r.type != null && (r.type.equals("EXISTS") || r.type.equals("EXPUNGE") || r.type.equals("FETCH") || r.type.equals("VANISHED"))) events.add(r);
    }

    private void write(String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.UTF_8));
        if (s.endsWith("\r\n")) out.flush();
    }

    /** Quoted string (or literal when it cannot be quoted). */
    public static Object astring(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c > 126 || c < 32) return new Lit(s.getBytes(StandardCharsets.UTF_8));
        }
        return quoted(s);
    }

    public static String quoted(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** A Gmail label as a STORE value: modified UTF-7, quoted (system labels like \Inbox stay atoms). */
    public static String label(String name) {
        if (name.startsWith("\\") && name.matches("\\\\[A-Za-z]+")) return name;
        return quoted(MUtf7.encode(name));
    }

    /** "1:5,7,9:10" from sorted or unsorted UIDs. */
    public static String set(List<Long> uids) {
        List<Long> s = new ArrayList<>(uids);
        java.util.Collections.sort(s);
        StringBuilder b = new StringBuilder();
        int i = 0;
        while (i < s.size()) {
            long start = s.get(i), end = start;
            while (i + 1 < s.size() && s.get(i + 1) <= end + 1) end = Math.max(end, s.get(++i));
            if (b.length() > 0) b.append(',');
            b.append(start);
            if (end != start) b.append(':').append(end);
            i++;
        }
        return b.toString();
    }

    /** "1:3,7" → [1, 2, 3, 7] (ranges larger than 1,000,000 are refused). */
    public static List<Long> parseSet(String s) {
        List<Long> out = new ArrayList<>();
        for (String part : s.split(",")) {
            part = part.trim();
            if (part.isEmpty()) continue;
            int colon = part.indexOf(':');
            if (colon < 0) { out.add(Long.parseLong(part)); continue; }
            long a = Long.parseLong(part.substring(0, colon)), b = Long.parseLong(part.substring(colon + 1));
            if (Math.abs(b - a) > 1_000_000) throw new IllegalArgumentException("UID range too large");
            for (long x = Math.min(a, b); x <= Math.max(a, b); x++) out.add(x);
        }
        return out;
    }

    // ───────── Reading and parsing ─────────

    private Response read() throws IOException {
        Response r = read(false);
        if (r == null) throw new IOException("Lege regel van de server");
        return r;
    }

    /**
     * Reads one response. With {@code idleTicks}, a read timeout before the first byte is passed on as
     * {@link SocketTimeoutException} (a tick); once a line has started, timeouts are waited out.
     */
    private Response read(boolean idleTicks) throws IOException {
        List<Object> segments = new ArrayList<>();
        boolean first = true;
        for (;;) {
            byte[] line = readLine(idleTicks, first);
            first = false;
            int len = line.length;
            Matcher m = LITERAL_END.matcher(new String(line, Math.max(0, len - 24), Math.min(24, len), StandardCharsets.ISO_8859_1));
            if (m.find()) {
                long n = Long.parseLong(m.group(1));
                if (n > 200L * 1024 * 1024) throw new IOException("Literal too large");
                int cut = len - m.group().length();
                segments.add(new String(line, 0, cut, StandardCharsets.UTF_8));
                byte[] lit = new byte[(int) n];
                int off = 0;
                while (off < n) {
                    int k;
                    try {
                        k = in.read(lit, off, (int) n - off);
                    } catch (SocketTimeoutException e) {
                        if (idleTicks) continue; // in IDLE the timeout is only a tick; the rest is on its way
                        throw e;
                    }
                    if (k < 0) throw new IOException("Verbinding verbroken tijdens het lezen");
                    off += k;
                }
                segments.add(lit);
                continue;
            }
            segments.add(new String(line, StandardCharsets.UTF_8));
            break;
        }
        return parse(segments);
    }

    private static final Pattern LITERAL_END = Pattern.compile("\\{(\\d+)\\+?\\}$");

    /** In IDLE ({@code ticks}) a timeout before the first byte of a response is a tick; later ones are waited out. */
    private byte[] readLine(boolean ticks, boolean firstLine) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        for (;;) {
            int c;
            try {
                c = in.read();
            } catch (SocketTimeoutException e) {
                if (!ticks || (firstLine && b.size() == 0)) throw e;
                continue;
            }
            if (c == -1) {
                if (b.size() == 0) throw new IOException("De server sloot de verbinding");
                break;
            }
            if (c == '\n') break;
            b.write(c);
            if (b.size() > 10 * 1024 * 1024) throw new IOException("Line too long");
        }
        byte[] r = b.toByteArray();
        if (r.length > 0 && r[r.length - 1] == '\r') {
            byte[] t = new byte[r.length - 1];
            System.arraycopy(r, 0, t, 0, t.length);
            return t;
        }
        return r;
    }

    public static Response parse(List<Object> segments) {
        Response r = new Response();
        String head = (String) segments.get(0);
        int sp = head.indexOf(' ');
        r.tag = sp < 0 ? head : head.substring(0, sp);
        String rest = sp < 0 ? "" : head.substring(sp + 1);
        if (r.tag.equals("+")) { r.text = rest; return r; }
        // status response?
        int sp2 = rest.indexOf(' ');
        String word = (sp2 < 0 ? rest : rest.substring(0, sp2)).toUpperCase(Locale.ROOT);
        if (word.equals("OK") || word.equals("NO") || word.equals("BAD") || word.equals("BYE") || word.equals("PREAUTH")) {
            r.status = word;
            String t = sp2 < 0 ? "" : rest.substring(sp2 + 1);
            if (t.startsWith("[")) {
                int close = matchBracket(t);
                r.code = t.substring(1, close < 0 ? t.length() : close);
                t = close < 0 ? "" : t.substring(close + 1).trim();
            }
            StringBuilder txt = new StringBuilder(t);
            for (int i = 1; i < segments.size(); i++) txt.append(segments.get(i) instanceof byte[] ? new String((byte[]) segments.get(i), StandardCharsets.UTF_8) : segments.get(i));
            r.text = txt.toString();
            return r;
        }
        // data response: [number] TYPE tokens...
        Tok tok = new Tok(segments, sp < 0 ? head.length() : sp + 1);
        Object first = tok.next();
        if (first instanceof String && ((String) first).matches("\\d+")) {
            r.number = Long.parseLong((String) first);
            Object t = tok.next();
            r.type = t == null ? "" : str(t).toUpperCase(Locale.ROOT);
        } else {
            r.type = first == null ? "" : str(first).toUpperCase(Locale.ROOT);
        }
        for (Object o; (o = tok.next()) != Tok.END; ) r.data.add(o);
        return r;
    }

    private static int matchBracket(String t) {
        int depth = 0;
        boolean quote = false;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (quote) { if (c == '\\') i++; else if (c == '"') quote = false; continue; }
            if (c == '"') quote = true;
            else if (c == '[') depth++;
            else if (c == ']' && --depth == 0) return i;
        }
        return -1;
    }

    /** Tokenizer over text segments and literals. */
    private static final class Tok {
        static final Object END = new Object();
        static final Object CLOSE = new Object();
        final List<Object> seg;
        int si;
        int pos;

        Tok(List<Object> seg, int pos) {
            this.seg = seg;
            this.pos = pos;
        }

        /** Next value (String, byte[], List, null) or END. */
        Object next() {
            Object o = raw();
            return o == CLOSE ? END : o;
        }

        private Object raw() {
            for (;;) {
                if (si >= seg.size()) return END;
                Object s = seg.get(si);
                if (s instanceof byte[]) { si++; pos = 0; return s; }
                String t = (String) s;
                while (pos < t.length() && t.charAt(pos) == ' ') pos++;
                if (pos >= t.length()) { si++; pos = 0; continue; }
                char c = t.charAt(pos);
                if (c == '(') {
                    pos++;
                    List<Object> list = new ArrayList<>();
                    for (;;) {
                        Object v = raw();
                        if (v == CLOSE || v == END) return list;
                        list.add(v);
                    }
                }
                if (c == ')') { pos++; return CLOSE; }
                if (c == '"') {
                    StringBuilder b = new StringBuilder();
                    pos++;
                    while (pos < t.length()) {
                        char q = t.charAt(pos++);
                        if (q == '\\' && pos < t.length()) { b.append(t.charAt(pos++)); continue; }
                        if (q == '"') break;
                        b.append(q);
                    }
                    return b.toString();
                }
                int start = pos;
                int depth = 0;
                while (pos < t.length()) {
                    char a = t.charAt(pos);
                    if (a == '[') depth++;
                    else if (a == ']') depth--;
                    else if (depth == 0 && (a == ' ' || a == '(' || a == ')')) break;
                    pos++;
                }
                String atom = t.substring(start, pos);
                return atom.equalsIgnoreCase("NIL") ? null : atom;
            }
        }
    }

    public static String str(Object o) {
        if (o == null) return "";
        if (o instanceof byte[]) return new String((byte[]) o, StandardCharsets.UTF_8);
        return String.valueOf(o);
    }

    public static long num(Object o) {
        try {
            return o == null ? -1 : Long.parseLong(str(o).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** IMAP date for SEARCH SINCE: "1-Jan-2024". */
    public static String searchDate(long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("d-MMM-yyyy", Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(ms));
    }

    /** INTERNALDATE "17-Jul-1996 02:44:25 -0700" → ms. */
    public static long internalDate(String s) {
        if (s == null) return 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("d-MMM-yyyy HH:mm:ss Z", Locale.US);
            return f.parse(s.trim()).getTime();
        } catch (java.text.ParseException e) {
            return 0;
        }
    }
}
