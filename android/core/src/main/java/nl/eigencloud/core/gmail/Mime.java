package nl.eigencloud.core.gmail;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Internet mail parsing without libraries: headers (folding, RFC 2047 encoded words, raw 8-bit), Content-Type
 * parameters (RFC 2231 continuations and charsets), transfer encodings (base64, quoted-printable), charsets
 * (UTF-8, ISO-8859-1/Windows-1252 and whatever the platform knows), multipart trees with IMAP section numbers
 * (RFC 3501: the same numbers BODYSTRUCTURE and BODY[n] use), addresses and dates. Lenient everywhere: real mail
 * is often slightly broken, and a readable message beats an exception.
 */
public final class Mime {
    private Mime() {}

    // ───────── Headers ─────────

    /** Headers in order; names compared case-insensitively. Values are unfolded but not yet RFC 2047-decoded. */
    public static final class Headers {
        public final List<String[]> list = new ArrayList<>();

        public String get(String name) {
            for (String[] h : list) if (h[0].equalsIgnoreCase(name)) return h[1];
            return null;
        }

        public List<String> all(String name) {
            List<String> out = new ArrayList<>();
            for (String[] h : list) if (h[0].equalsIgnoreCase(name)) out.add(h[1]);
            return out;
        }

        /** Decoded (RFC 2047) value, or "" when absent. */
        public String text(String name) {
            String v = get(name);
            return v == null ? "" : decodeWords(v).trim();
        }
    }

    /** Index where the body starts (after the empty line), or raw.length when there is no body. */
    public static int bodyStart(byte[] raw, int from, int to) {
        if (from < to && (raw[from] == '\n' || (raw[from] == '\r' && from + 1 < to && raw[from + 1] == '\n'))) return raw[from] == '\n' ? from + 1 : from + 2;
        for (int i = from; i < to; i++) {
            if (raw[i] != '\n') continue;
            if (i + 1 < to && raw[i + 1] == '\n') return i + 2;
            if (i + 2 < to && raw[i + 1] == '\r' && raw[i + 2] == '\n') return i + 3;
        }
        return to;
    }

    public static Headers parseHeaders(byte[] raw, int from, int to) {
        Headers h = new Headers();
        String text = bytesToText(raw, from, to);
        String name = null;
        StringBuilder value = null;
        for (String line : text.split("\r?\n", -1)) {
            if (line.isEmpty()) break;
            if ((line.charAt(0) == ' ' || line.charAt(0) == '\t') && value != null) {
                value.append(' ').append(line.trim());
                continue;
            }
            if (name != null) h.list.add(new String[]{name, value.toString().trim()});
            int colon = line.indexOf(':');
            if (colon <= 0) { name = null; value = null; continue; }
            name = line.substring(0, colon).trim();
            value = new StringBuilder(line.substring(colon + 1));
        }
        if (name != null) h.list.add(new String[]{name, value.toString().trim()});
        return h;
    }

    /** Raw header bytes: UTF-8 when valid (RFC 6532), otherwise Windows-1252. */
    static String bytesToText(byte[] raw, int from, int to) {
        boolean ascii = true;
        for (int i = from; i < to; i++) if (raw[i] < 0) { ascii = false; break; }
        if (ascii) return new String(raw, from, to - from, StandardCharsets.ISO_8859_1);
        String utf = strictUtf8(raw, from, to - from);
        return utf != null ? utf : decodeCharset(slice(raw, from, to), "windows-1252");
    }

    // ───────── RFC 2047 ─────────

    private static final Pattern WORD = Pattern.compile("=\\?([^?\\s]+)\\?([BbQq])\\?([^?\\s]*)\\?=");

    /** Decodes encoded words; adjacent words (only whitespace between) are joined, also when a character is split across them. */
    public static String decodeWords(String s) {
        if (s == null || s.indexOf("=?") < 0) return s;
        StringBuilder out = new StringBuilder();
        Matcher m = WORD.matcher(s);
        int last = 0;
        String pendingCharset = null;
        ByteArrayOutputStream pending = new ByteArrayOutputStream();
        while (m.find()) {
            String between = s.substring(last, m.start());
            boolean adjacent = pendingCharset != null && between.trim().isEmpty();
            String cs = m.group(1);
            int star = cs.indexOf('*'); // RFC 2231 language suffix
            if (star >= 0) cs = cs.substring(0, star);
            if (!adjacent || !cs.equalsIgnoreCase(pendingCharset)) {
                if (pendingCharset != null) { out.append(decodeCharset(pending.toByteArray(), pendingCharset)); pending.reset(); }
                if (!adjacent) out.append(between);
            }
            byte[] b = m.group(2).equalsIgnoreCase("B") ? decodeBase64(m.group(3).getBytes(StandardCharsets.ISO_8859_1))
                    : decodeQP(m.group(3).getBytes(StandardCharsets.ISO_8859_1), true);
            pending.write(b, 0, b.length);
            pendingCharset = cs;
            last = m.end();
        }
        if (pendingCharset != null) out.append(decodeCharset(pending.toByteArray(), pendingCharset));
        out.append(s.substring(last));
        return out.toString();
    }

    /** RFC 2047 B-encoding when needed (non-ASCII or control characters), split so no encoded word exceeds 75 characters. */
    public static String encodeWord(String s) {
        boolean plain = true;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c > 126 || (c < 32 && c != '\t')) { plain = false; break; }
        }
        if (plain && !s.contains("=?")) return s;
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            int j = i, bytes = 0;
            while (j < s.length()) {
                int cp = s.codePointAt(j);
                int n = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8).length;
                if (bytes + n > 45) break;
                bytes += n;
                j += Character.charCount(cp);
            }
            if (out.length() > 0) out.append("\r\n ");
            out.append("=?UTF-8?B?").append(java.util.Base64.getEncoder().encodeToString(s.substring(i, j).getBytes(StandardCharsets.UTF_8))).append("?=");
            i = j;
        }
        return out.toString();
    }

    // ───────── Transfer encodings ─────────

    public static byte[] decodeQP(byte[] in, boolean header) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length);
        int i = 0;
        while (i < in.length) {
            byte b = in[i];
            if (header && b == '_') { out.write(' '); i++; continue; }
            if (b != '=') { out.write(b); i++; continue; }
            // soft line break: "=" + optional whitespace + (CR)LF
            int k = i + 1;
            while (k < in.length && (in[k] == ' ' || in[k] == '\t')) k++;
            if (k < in.length && in[k] == '\n') { i = k + 1; continue; }
            if (k + 1 < in.length && in[k] == '\r' && in[k + 1] == '\n') { i = k + 2; continue; }
            if (k >= in.length) { i = k; continue; } // "=" at the very end
            if (i + 2 < in.length && hex(in[i + 1]) >= 0 && hex(in[i + 2]) >= 0) {
                out.write(hex(in[i + 1]) * 16 + hex(in[i + 2]));
                i += 3;
                continue;
            }
            out.write(b); // not a valid escape: keep literally
            i++;
        }
        return out.toByteArray();
    }

    private static int hex(byte b) {
        if (b >= '0' && b <= '9') return b - '0';
        if (b >= 'A' && b <= 'F') return b - 'A' + 10;
        if (b >= 'a' && b <= 'f') return b - 'a' + 10;
        return -1;
    }

    /** Lenient base64: skips anything outside the alphabet, tolerates missing padding. */
    public static byte[] decodeBase64(byte[] in) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length * 3 / 4 + 3);
        int acc = 0, n = 0;
        for (byte b : in) {
            int v;
            if (b >= 'A' && b <= 'Z') v = b - 'A';
            else if (b >= 'a' && b <= 'z') v = b - 'a' + 26;
            else if (b >= '0' && b <= '9') v = b - '0' + 52;
            else if (b == '+' || b == '-') v = 62;
            else if (b == '/' || b == '_') v = 63;
            else if (b == '=') {
                // end of a group; another base64 block may follow (concatenated encodings)
                if (n == 2) out.write((acc >> 4) & 0xff);
                else if (n == 3) { out.write((acc >> 10) & 0xff); out.write((acc >> 2) & 0xff); }
                acc = 0;
                n = 0;
                continue;
            }
            else continue;
            acc = (acc << 6) | v;
            n++;
            if (n == 4) {
                out.write((acc >> 16) & 0xff);
                out.write((acc >> 8) & 0xff);
                out.write(acc & 0xff);
                acc = 0;
                n = 0;
            }
        }
        if (n == 2) out.write((acc >> 4) & 0xff);
        else if (n == 3) {
            out.write((acc >> 10) & 0xff);
            out.write((acc >> 2) & 0xff);
        }
        return out.toByteArray();
    }

    public static byte[] decodeTransfer(byte[] data, String encoding) {
        String e = encoding == null ? "" : encoding.trim().toLowerCase(Locale.ROOT);
        if (e.equals("base64")) return decodeBase64(data);
        if (e.equals("quoted-printable")) return decodeQP(data, false);
        return data;
    }

    /** Drops an incomplete UTF-8 sequence at the end (text cut off by a partial fetch). */
    public static byte[] trimPartialUtf8(byte[] b, String charset) {
        String cs = charset == null ? "utf-8" : charset.trim().toLowerCase(Locale.ROOT);
        if (!cs.isEmpty() && !cs.equals("utf-8") && !cs.equals("utf8")) return b;
        int end = b.length, i = end - 1, back = 0;
        while (i >= 0 && back < 4 && (b[i] & 0xc0) == 0x80) { i--; back++; }
        if (i < 0) return b;
        int lead = b[i] & 0xff;
        int need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (need > 1 && end - i < need) return slice(b, 0, i);
        return b;
    }

    // ───────── Charsets ─────────

    /** Decodes text in the given charset; unknown or broken labels fall back to UTF-8 (when valid) or Windows-1252. */
    public static String decodeCharset(byte[] b, String charset) {
        String cs = charset == null ? "" : charset.trim().replace("\"", "").toLowerCase(Locale.ROOT);
        if (cs.isEmpty() || cs.equals("utf-8") || cs.equals("utf8") || cs.equals("unicode-1-1-utf-8")) {
            String s = strictUtf8(b, 0, b.length);
            return s != null ? s : cs.isEmpty() && isAscii(b) ? new String(b, StandardCharsets.US_ASCII) : fallback(b);
        }
        // Like browsers (WHATWG): Latin-1 and ASCII labels mean Windows-1252, a superset that has € and curly quotes.
        if (cs.equals("us-ascii") || cs.equals("ascii") || cs.equals("iso-8859-1") || cs.equals("latin1") || cs.equals("iso_8859-1") || cs.equals("l1")
                || cs.equals("cp1252") || cs.equals("windows-1252") || cs.equals("ansi_x3.4-1968") || cs.equals("x-user-defined")) {
            String utf = isAscii(b) ? null : strictUtf8(b, 0, b.length);
            return utf != null && cs.contains("ascii") ? utf : windows1252(b);
        }
        if (cs.equals("ks_c_5601-1987")) cs = "euc-kr";
        if (cs.equals("gb2312")) cs = "gbk";
        try {
            return new String(b, Charset.forName(cs));
        } catch (RuntimeException e) {
            return fallback(b);
        }
    }

    private static String fallback(byte[] b) {
        String s = strictUtf8(b, 0, b.length);
        return s != null ? s : windows1252(b);
    }

    private static boolean isAscii(byte[] b) {
        for (byte x : b) if (x < 0) return false;
        return true;
    }

    private static String windows1252(byte[] b) {
        try {
            return new String(b, Charset.forName("windows-1252"));
        } catch (RuntimeException e) {
            return new String(b, StandardCharsets.ISO_8859_1);
        }
    }

    static String strictUtf8(byte[] b, int off, int len) {
        CharsetDecoder d = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            return d.decode(ByteBuffer.wrap(b, off, len)).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    // ───────── Content-Type and parameters ─────────

    public static final class ContentType {
        public String type = "text", subtype = "plain";
        public final Map<String, String> params = new LinkedHashMap<>();

        public String mime() { return type + "/" + subtype; }

        public String param(String name) { return params.get(name.toLowerCase(Locale.ROOT)); }
    }

    public static ContentType parseContentType(String value) {
        ContentType ct = new ContentType();
        if (value == null) return ct;
        int semi = value.indexOf(';');
        String mt = (semi < 0 ? value : value.substring(0, semi)).trim().toLowerCase(Locale.ROOT);
        int slash = mt.indexOf('/');
        if (slash > 0 && slash < mt.length() - 1) {
            ct.type = mt.substring(0, slash).trim();
            ct.subtype = mt.substring(slash + 1).trim();
        } else if (mt.equals("text")) {
            ct.type = "text";
        }
        if (semi >= 0) ct.params.putAll(parseParams(value.substring(semi + 1)));
        return ct;
    }

    /** Disposition value ("attachment"/"inline") plus parameters. */
    public static String[] parseDisposition(String value, Map<String, String> paramsOut) {
        if (value == null) return new String[]{null};
        int semi = value.indexOf(';');
        String d = (semi < 0 ? value : value.substring(0, semi)).trim().toLowerCase(Locale.ROOT);
        if (semi >= 0) paramsOut.putAll(parseParams(value.substring(semi + 1)));
        return new String[]{d.isEmpty() ? null : d};
    }

    /**
     * {@code ; a=b; c="d e"; f*=utf-8''%E2%82%AC; g*0=x; g*1*=%20y} → decoded map with lowercase keys. RFC 2231
     * continuations are joined in order; RFC 2047 encoded words in values (common for file names) are decoded.
     */
    public static Map<String, String> parseParams(String s) {
        Map<String, String> raw = new LinkedHashMap<>();
        int i = 0, n = s.length();
        while (i < n) {
            while (i < n && (s.charAt(i) == ';' || Character.isWhitespace(s.charAt(i)))) i++;
            int eq = i;
            while (eq < n && s.charAt(eq) != '=' && s.charAt(eq) != ';') eq++;
            if (eq >= n || s.charAt(eq) == ';') { i = eq; continue; }
            String key = s.substring(i, eq).trim().toLowerCase(Locale.ROOT);
            int v = eq + 1;
            while (v < n && Character.isWhitespace(s.charAt(v))) v++;
            String val;
            if (v < n && s.charAt(v) == '"') {
                StringBuilder b = new StringBuilder();
                int k = v + 1;
                for (; k < n; k++) {
                    char c = s.charAt(k);
                    if (c == '\\' && k + 1 < n) { b.append(s.charAt(++k)); continue; }
                    if (c == '"') break;
                    b.append(c);
                }
                val = b.toString();
                i = k + 1;
            } else {
                int k = v;
                while (k < n && s.charAt(k) != ';') k++;
                val = s.substring(v, k).trim();
                i = k;
            }
            if (!key.isEmpty() && !raw.containsKey(key)) raw.put(key, val);
        }
        // RFC 2231: name*=charset'lang'pct, name*0=..., name*1*=...
        Map<String, String> out = new LinkedHashMap<>();
        Map<String, TreeMap<Integer, String[]>> conts = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : raw.entrySet()) {
            String k = e.getKey();
            Matcher m = Pattern.compile("^(.+?)\\*(\\d+)(\\*?)$").matcher(k);
            if (m.matches()) {
                conts.computeIfAbsent(m.group(1), x -> new TreeMap<>()).put(Integer.parseInt(m.group(2)), new String[]{e.getValue(), m.group(3)});
            } else if (k.endsWith("*")) {
                out.put(k.substring(0, k.length() - 1), decode2231(e.getValue(), true, null));
            } else if (!out.containsKey(k)) {
                out.put(k, decodeWords(e.getValue()));
            }
        }
        for (Map.Entry<String, TreeMap<Integer, String[]>> e : conts.entrySet()) {
            String charset = null;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            boolean first = true;
            for (String[] piece : e.getValue().values()) {
                String v = piece[0];
                boolean enc = !piece[1].isEmpty();
                if (first && enc) {
                    int q1 = v.indexOf('\''), q2 = q1 < 0 ? -1 : v.indexOf('\'', q1 + 1);
                    if (q2 > 0) { charset = v.substring(0, q1); v = v.substring(q2 + 1); }
                }
                first = false;
                byte[] b = enc ? pctDecode(v) : v.getBytes(StandardCharsets.UTF_8);
                bytes.write(b, 0, b.length);
            }
            out.put(e.getKey(), decodeCharset(bytes.toByteArray(), charset == null || charset.isEmpty() ? "utf-8" : charset));
        }
        return out;
    }

    private static String decode2231(String v, boolean withCharset, String charset) {
        String cs = charset;
        if (withCharset) {
            int q1 = v.indexOf('\''), q2 = q1 < 0 ? -1 : v.indexOf('\'', q1 + 1);
            if (q2 > 0) { cs = v.substring(0, q1); v = v.substring(q2 + 1); }
        }
        return decodeCharset(pctDecode(v), cs == null || cs.isEmpty() ? "utf-8" : cs);
    }

    private static byte[] pctDecode(String v) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '%' && i + 2 < v.length() && hex((byte) v.charAt(i + 1)) >= 0 && hex((byte) v.charAt(i + 2)) >= 0) {
                b.write(hex((byte) v.charAt(i + 1)) * 16 + hex((byte) v.charAt(i + 2)));
                i += 2;
            } else {
                byte[] x = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                b.write(x, 0, x.length);
            }
        }
        return b.toByteArray();
    }

    // ───────── Parts ─────────

    /** A leaf body part with its IMAP section number ("1", "1.2", …). */
    public static final class Part {
        public String section;
        public String type = "text/plain";
        public String charset;
        public String encoding;
        public String disposition;
        public String filename;
        public String cid;
        /** Decoded size in bytes (estimated from the encoded size when the content was not downloaded). */
        public long size;
        /** Decoded content; null when not downloaded. */
        public byte[] data;

        public boolean isText() { return type.equals("text/plain") || type.equals("text/html"); }

        /** Body text candidates are text parts that are neither marked nor named as attachments. */
        public boolean isBodyCandidate() { return isText() && !"attachment".equals(disposition) && filename == null; }

        public String text() { return data == null ? "" : decodeCharset(data, charset); }

        /** A name for saving: the file name, or something sensible from the type. */
        public String displayName() {
            if (filename != null && !filename.trim().isEmpty()) return filename.trim().replaceAll("[\\\\/\\x00-\\x1f]", "_");
            if (type.equals("message/rfc822")) return "bericht.eml";
            int slash = type.indexOf('/');
            String sub = slash < 0 ? "bin" : type.substring(slash + 1);
            if (sub.equals("jpeg")) sub = "jpg";
            if (sub.equals("plain")) sub = "txt";
            if (sub.length() > 8 || !sub.matches("[a-z0-9]+")) sub = "bin";
            return (type.startsWith("image/") ? "afbeelding" : "bijlage") + "." + sub;
        }
    }

    /** A parsed message: the useful headers decoded, and the leaf parts in order. */
    public static final class Message {
        public Headers headers;
        public String subject = "";
        public List<Address> from = new ArrayList<>(), to = new ArrayList<>(), cc = new ArrayList<>(), bcc = new ArrayList<>(), replyTo = new ArrayList<>();
        public long date;
        public String messageId, inReplyTo, references;
        public ContentType contentType;
        public final List<Part> parts = new ArrayList<>();

        public Part textPart() {
            for (Part p : parts) if (p.isBodyCandidate() && p.type.equals("text/plain")) return p;
            return null;
        }

        public Part htmlPart() {
            for (Part p : parts) if (p.isBodyCandidate() && p.type.equals("text/html")) return p;
            return null;
        }

        /** Attachments: every non-body part (inline images are filtered by the viewer when the HTML uses them). */
        public List<Part> attachments() {
            List<Part> out = new ArrayList<>();
            Part t = textPart(), h = htmlPart();
            for (Part p : parts) if (p != t && p != h) out.add(p);
            return out;
        }
    }

    /** Parses a complete message (as BODY[] / RFC822 returns it). */
    public static Message parse(byte[] raw) {
        Message m = new Message();
        int bs = bodyStart(raw, 0, raw.length);
        m.headers = parseHeaders(raw, 0, bs);
        fillEnvelope(m, m.headers);
        m.contentType = parseContentType(m.headers.get("Content-Type"));
        if (m.contentType.type.equals("multipart")) walk(raw, bs, raw.length, m.contentType, "", m.parts, 0);
        else m.parts.add(leaf(raw, bs, raw.length, m.headers, m.contentType, "1"));
        return m;
    }

    /** Fills subject, addresses, date and ids from headers (also used for HEADER.FIELDS fetches). */
    public static void fillEnvelope(Message m, Headers h) {
        m.headers = h;
        m.subject = h.text("Subject");
        m.from = parseAddresses(h.get("From"));
        m.to = parseAddresses(h.get("To"));
        m.cc = parseAddresses(h.get("Cc"));
        m.bcc = parseAddresses(h.get("Bcc"));
        m.replyTo = parseAddresses(h.get("Reply-To"));
        m.date = parseDate(h.get("Date"));
        m.messageId = firstId(h.get("Message-ID"));
        m.inReplyTo = firstId(h.get("In-Reply-To"));
        String refs = h.get("References");
        m.references = refs == null ? null : refs.replaceAll("\\s+", " ").trim();
    }

    private static String firstId(String v) {
        if (v == null) return null;
        Matcher x = Pattern.compile("<[^<>\\s]+>").matcher(v);
        if (x.find()) return x.group();
        String t = v.trim();
        return t.isEmpty() ? null : "<" + t.replaceAll("[<>\\s]", "") + ">";
    }

    private static void walk(byte[] raw, int from, int to, ContentType ct, String prefix, List<Part> out, int depth) {
        String boundary = ct.param("boundary");
        List<int[]> bodies = boundary == null || boundary.isEmpty() || depth > 20 ? new ArrayList<>() : splitMultipart(raw, from, to, boundary);
        if (bodies.isEmpty()) {
            // No usable boundary: show what there is as text.
            Part p = new Part();
            p.section = prefix.isEmpty() ? "1" : prefix + ".1";
            p.data = slice(raw, from, to);
            p.size = p.data.length;
            out.add(p);
            return;
        }
        int n = 0;
        for (int[] b : bodies) {
            n++;
            String sec = prefix.isEmpty() ? String.valueOf(n) : prefix + "." + n;
            int bs = bodyStart(raw, b[0], b[1]);
            Headers h = parseHeaders(raw, b[0], bs);
            ContentType pct = h.get("Content-Type") == null && ct.subtype.equals("digest") ? parseContentType("message/rfc822") : parseContentType(h.get("Content-Type"));
            if (pct.type.equals("multipart")) walk(raw, bs, b[1], pct, sec, out, depth + 1);
            else out.add(leaf(raw, bs, b[1], h, pct, sec));
        }
    }

    /** Body ranges between boundary lines; a missing closing boundary ends at the end of the data. */
    static List<int[]> splitMultipart(byte[] raw, int from, int to, String boundary) {
        byte[] delim = ("--" + boundary).getBytes(StandardCharsets.ISO_8859_1);
        List<int[]> out = new ArrayList<>();
        int partStart = -1;
        int i = from;
        while (i < to) {
            int lineEnd = i;
            while (lineEnd < to && raw[lineEnd] != '\n') lineEnd++;
            if (startsWith(raw, i, lineEnd, delim)) {
                int after = i + delim.length;
                boolean close = after + 1 < lineEnd && raw[after] == '-' && raw[after + 1] == '-';
                boolean onlyWs = true;
                for (int k = close ? after + 2 : after; k < lineEnd; k++) if (raw[k] != ' ' && raw[k] != '\t' && raw[k] != '\r') { onlyWs = false; break; }
                if (onlyWs) {
                    if (partStart >= 0) {
                        int end = i;
                        // the CRLF before the delimiter belongs to the delimiter
                        if (end > partStart && raw[end - 1] == '\n') end--;
                        if (end > partStart && raw[end - 1] == '\r') end--;
                        out.add(new int[]{partStart, Math.max(partStart, end)});
                    }
                    if (close) return out;
                    partStart = Math.min(to, lineEnd + 1);
                }
            }
            i = lineEnd + 1;
        }
        if (partStart >= 0 && partStart < to) out.add(new int[]{partStart, to});
        return out;
    }

    private static boolean startsWith(byte[] raw, int i, int end, byte[] p) {
        if (end - i < p.length) return false;
        for (int k = 0; k < p.length; k++) if (raw[i + k] != p[k]) return false;
        return true;
    }

    private static Part leaf(byte[] raw, int from, int to, Headers h, ContentType ct, String section) {
        Part p = new Part();
        p.section = section;
        p.type = ct.mime();
        p.charset = ct.param("charset");
        p.encoding = h.get("Content-Transfer-Encoding") == null ? null : h.get("Content-Transfer-Encoding").trim().toLowerCase(Locale.ROOT);
        Map<String, String> dp = new LinkedHashMap<>();
        p.disposition = parseDisposition(h.get("Content-Disposition"), dp)[0];
        String name = dp.get("filename");
        if (name == null || name.isEmpty()) name = ct.param("name");
        p.filename = name == null || name.trim().isEmpty() ? null : name.trim();
        String cid = h.get("Content-ID");
        if (cid != null) p.cid = cid.trim().replaceAll("^<|>$", "");
        p.data = decodeTransfer(slice(raw, from, to), p.encoding);
        p.size = p.data.length;
        return p;
    }

    static byte[] slice(byte[] raw, int from, int to) {
        byte[] b = new byte[Math.max(0, to - from)];
        System.arraycopy(raw, from, b, 0, b.length);
        return b;
    }

    // ───────── Addresses ─────────

    public static final class Address {
        public final String name, email;

        public Address(String name, String email) {
            this.name = name == null ? "" : name;
            this.email = email == null ? "" : email;
        }

        /** "Name" or the address. */
        public String label() { return name.isEmpty() ? email : name; }

        /** RFC 5322 form, with the name encoded when needed. */
        public String header() {
            if (name.isEmpty()) return email;
            String enc = encodeWord(name);
            if (!enc.equals(name)) return enc + " <" + email + ">";
            boolean special = name.matches(".*[()<>\\[\\]:;@\\\\,.\"].*");
            return (special ? "\"" + name.replace("\\", "\\\\").replace("\"", "\\\"") + "\"" : name) + " <" + email + ">";
        }

        @Override public String toString() { return name.isEmpty() ? email : name + " <" + email + ">"; }
    }

    /** Lenient address-list parsing: quoted names with commas, comments, groups, bare addresses. */
    public static List<Address> parseAddresses(String v) {
        List<Address> out = new ArrayList<>();
        if (v == null) return out;
        List<String> items = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quote = false;
        int angle = 0, paren = 0;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (quote) {
                cur.append(c);
                if (c == '\\' && i + 1 < v.length()) cur.append(v.charAt(++i));
                else if (c == '"') quote = false;
                continue;
            }
            if (c == '"') quote = true;
            else if (c == '<') angle++;
            else if (c == '>' && angle > 0) angle--;
            else if (c == '(') paren++;
            else if (c == ')' && paren > 0) paren--;
            else if ((c == ',' || c == ';') && angle == 0 && paren == 0) { items.add(cur.toString()); cur.setLength(0); continue; }
            else if (c == ':' && angle == 0 && paren == 0) { cur.setLength(0); continue; } // group name
            cur.append(c);
        }
        items.add(cur.toString());
        for (String item : items) {
            String s = item.trim();
            if (s.isEmpty()) continue;
            String name, email;
            int lt = s.lastIndexOf('<'), gt = s.lastIndexOf('>');
            if (lt >= 0 && gt > lt) {
                email = s.substring(lt + 1, gt).trim();
                name = s.substring(0, lt).trim();
            } else {
                String comment = "";
                Matcher cm = Pattern.compile("\\(([^)]*)\\)").matcher(s);
                if (cm.find()) comment = cm.group(1);
                email = s.replaceAll("\\([^)]*\\)", "").trim();
                name = comment.trim();
            }
            if (name.startsWith("\"") && name.endsWith("\"") && name.length() >= 2) name = name.substring(1, name.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
            name = decodeWords(name).trim();
            email = email.replaceAll("\\s+", "");
            if (email.isEmpty() && name.isEmpty()) continue;
            if (!email.contains("@") && name.isEmpty()) { name = email; email = ""; }
            if (name.equalsIgnoreCase(email)) name = "";
            out.add(new Address(name, email));
        }
        return out;
    }

    public static String formatList(List<Address> list) {
        StringBuilder b = new StringBuilder();
        for (Address a : list) {
            if (b.length() > 0) b.append(", ");
            b.append(a);
        }
        return b.toString();
    }

    // ───────── Dates ─────────

    private static final Pattern DATE = Pattern.compile("(\\d{1,2})\\s+([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{2,4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?\\s*([+-]\\d{4}|[A-Za-z]{1,5})?");
    private static final String MONTHS = "janfebmaraprmayjunjulaugsepoctnovdec";

    /** RFC 5322 date (lenient: no weekday, 2-digit years, named zones); 0 when unreadable. */
    public static long parseDate(String v) {
        if (v == null) return 0;
        Matcher m = DATE.matcher(v);
        if (!m.find()) return 0;
        int mon = MONTHS.indexOf(m.group(2).toLowerCase(Locale.ROOT));
        if (mon < 0 || mon % 3 != 0) return 0;
        int year = Integer.parseInt(m.group(3));
        if (m.group(3).length() == 2) year += year < 50 ? 2000 : 1900;
        else if (m.group(3).length() == 3) year += 1900;
        int offsetMin = 0;
        String z = m.group(7);
        if (z != null) {
            if (z.startsWith("+") || z.startsWith("-")) {
                int hh = Integer.parseInt(z.substring(1, 3)), mm = Integer.parseInt(z.substring(3, 5));
                offsetMin = (hh * 60 + mm) * (z.startsWith("-") ? -1 : 1);
            } else {
                switch (z.toUpperCase(Locale.ROOT)) {
                    case "EDT": offsetMin = -4 * 60; break;
                    case "EST": case "CDT": offsetMin = -5 * 60; break;
                    case "CST": case "MDT": offsetMin = -6 * 60; break;
                    case "MST": case "PDT": offsetMin = -7 * 60; break;
                    case "PST": offsetMin = -8 * 60; break;
                    case "CET": offsetMin = 60; break;
                    case "CEST": offsetMin = 120; break;
                    default: offsetMin = 0;
                }
            }
        }
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.ROOT);
        c.clear();
        c.set(year, mon / 3, Integer.parseInt(m.group(1)), Integer.parseInt(m.group(4)), Integer.parseInt(m.group(5)), m.group(6) == null ? 0 : Integer.parseInt(m.group(6)));
        return c.getTimeInMillis() - offsetMin * 60_000L;
    }

    // ───────── Text helpers ─────────

    /** Plain text from HTML: drops head/style/script, turns block ends into newlines, decodes common entities. */
    public static String htmlToText(String html) {
        String s = html.replaceAll("(?is)<(head|style|script|title)\\b.*?</\\1\\s*>", " ")
                .replaceAll("(?is)<!--.*?-->", " ")
                .replaceAll("(?i)<br\\s*/?>", "\n")
                .replaceAll("(?i)</(p|div|tr|li|h[1-6]|blockquote|table)>", "\n")
                .replaceAll("(?s)<[^>]*>", "");
        return decodeEntities(s).replaceAll("[ \\t\\x0B\\f\\r\\u00a0]+", " ").replaceAll(" ?\n ?", "\n").replaceAll("\n{3,}", "\n\n").trim();
    }

    public static String decodeEntities(String s) {
        if (s.indexOf('&') < 0) return s;
        Matcher m = Pattern.compile("&(#x[0-9a-fA-F]+|#\\d+|[a-zA-Z]+);").matcher(s);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String e = m.group(1), r = null;
            try {
                if (e.startsWith("#x") || e.startsWith("#X")) r = new String(Character.toChars(Integer.parseInt(e.substring(2), 16)));
                else if (e.startsWith("#")) r = new String(Character.toChars(Integer.parseInt(e.substring(1))));
            } catch (RuntimeException ex) {
                r = null;
            }
            if (r == null) {
                switch (e) {
                    case "amp": r = "&"; break;
                    case "lt": r = "<"; break;
                    case "gt": r = ">"; break;
                    case "quot": r = "\""; break;
                    case "apos": r = "'"; break;
                    case "nbsp": r = " "; break;
                    case "euro": r = "€"; break;
                    case "copy": r = "©"; break;
                    case "eacute": r = "é"; break;
                    case "euml": r = "ë"; break;
                    case "iuml": r = "ï"; break;
                    case "ouml": r = "ö"; break;
                    case "uuml": r = "ü"; break;
                    case "hellip": r = "…"; break;
                    case "ndash": r = "–"; break;
                    case "mdash": r = "—"; break;
                    case "rsquo": r = "’"; break;
                    case "lsquo": r = "‘"; break;
                    case "rdquo": r = "”"; break;
                    case "ldquo": r = "“"; break;
                    case "zwnj": case "shy": r = ""; break;
                    default: r = m.group();
                }
            }
            m.appendReplacement(out, Matcher.quoteReplacement(r));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** A one-line preview of at most {@code max} characters. */
    public static String snippet(String text, int max) {
        String s = text == null ? "" : text.replaceAll("(?m)^>.*$", " ").replaceAll("[\\s\\u00a0\\u200c\\u034f]+", " ").trim();
        return s.length() <= max ? s : s.substring(0, max).trim() + "…";
    }
}
