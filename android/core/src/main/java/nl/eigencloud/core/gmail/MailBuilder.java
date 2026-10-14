package nl.eigencloud.core.gmail;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** Builds an RFC 5322 message (UTF-8, quoted-printable text, base64 attachments with RFC 2231 file names). */
public final class MailBuilder {
    private MailBuilder() {}

    public static final class Attachment {
        public final String name, mime;
        public final File file;
        public final byte[] data;

        public Attachment(String name, String mime, File file) { this(name, mime, file, null); }

        public Attachment(String name, String mime, byte[] data) { this(name, mime, null, data); }

        private Attachment(String name, String mime, File file, byte[] data) {
            this.name = name == null || name.trim().isEmpty() ? "bijlage" : name.trim();
            this.mime = mime == null || !mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? "application/octet-stream" : mime.toLowerCase(Locale.ROOT);
            this.file = file;
            this.data = data;
        }

        InputStream open() throws IOException { return file != null ? new FileInputStream(file) : new java.io.ByteArrayInputStream(data); }
    }

    public static final class Draft {
        public Mime.Address from;
        public List<Mime.Address> to = new ArrayList<>(), cc = new ArrayList<>(), bcc = new ArrayList<>();
        public String subject = "", text = "";
        /** Message-ID of the message this replies to, and its References chain (both may be null). */
        public String inReplyTo, references;
        public final List<Attachment> attachments = new ArrayList<>();

        /** All envelope recipients (to, cc and bcc). */
        public List<String> recipients() {
            List<String> r = new ArrayList<>();
            for (List<Mime.Address> l : java.util.Arrays.asList(to, cc, bcc)) for (Mime.Address a : l) if (!a.email.isEmpty() && !r.contains(a.email)) r.add(a.email);
            return r;
        }
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    public static String newMessageId(String fromEmail) {
        byte[] b = new byte[12];
        RANDOM.nextBytes(b);
        StringBuilder h = new StringBuilder();
        for (byte x : b) h.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        String domain = fromEmail != null && fromEmail.contains("@") ? fromEmail.substring(fromEmail.indexOf('@') + 1) : "eigencloud.local";
        return "<" + h + "@" + domain + ">";
    }

    /** Writes the message; Bcc is not written (only used for the envelope). */
    public static void write(Draft d, long dateMs, String messageId, OutputStream out) throws IOException {
        StringBuilder h = new StringBuilder();
        SimpleDateFormat df = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", Locale.US);
        df.setTimeZone(TimeZone.getDefault());
        header(h, "Date", df.format(new Date(dateMs)));
        header(h, "From", d.from.header());
        if (!d.to.isEmpty()) header(h, "To", list(d.to));
        if (!d.cc.isEmpty()) header(h, "Cc", list(d.cc));
        header(h, "Subject", Mime.encodeWord(d.subject == null ? "" : d.subject.replaceAll("[\\r\\n]+", " ")));
        header(h, "Message-ID", messageId);
        if (d.inReplyTo != null && !d.inReplyTo.isEmpty()) header(h, "In-Reply-To", d.inReplyTo);
        String refs = references(d.references, d.inReplyTo);
        if (refs != null) header(h, "References", refs);
        header(h, "MIME-Version", "1.0");
        String boundary = null;
        if (!d.attachments.isEmpty()) {
            boundary = "=_eigen_" + Long.toHexString(RANDOM.nextLong() & Long.MAX_VALUE);
            header(h, "Content-Type", "multipart/mixed; boundary=\"" + boundary + "\"");
        } else {
            header(h, "Content-Type", "text/plain; charset=utf-8");
            header(h, "Content-Transfer-Encoding", "quoted-printable");
        }
        h.append("\r\n");
        out.write(h.toString().getBytes(StandardCharsets.UTF_8));
        String body = encodeQP(d.text == null ? "" : d.text);
        if (boundary == null) {
            out.write(body.getBytes(StandardCharsets.US_ASCII));
            return;
        }
        StringBuilder p = new StringBuilder();
        p.append("This is a multi-part message in MIME format.\r\n\r\n--").append(boundary).append("\r\n");
        p.append("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n").append(body).append("\r\n");
        out.write(p.toString().getBytes(StandardCharsets.US_ASCII));
        for (Attachment a : d.attachments) {
            StringBuilder ah = new StringBuilder();
            ah.append("--").append(boundary).append("\r\n");
            ah.append("Content-Type: ").append(a.mime).append("; name=\"").append(asciiName(a.name)).append("\"\r\n");
            ah.append("Content-Disposition: attachment; filename=\"").append(asciiName(a.name)).append('"');
            if (!isAscii(a.name)) ah.append(";\r\n filename*=UTF-8''").append(pct(a.name));
            ah.append("\r\nContent-Transfer-Encoding: base64\r\n\r\n");
            out.write(ah.toString().getBytes(StandardCharsets.US_ASCII));
            try (InputStream in = a.open()) { base64Lines(in, out); }
        }
        out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    public static byte[] build(Draft d, long dateMs, String messageId) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        try {
            write(d, dateMs, messageId, b);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return b.toByteArray();
    }

    /** The References header for a reply: the parent's chain plus the parent itself (at most 20 ids). */
    public static String references(String parentRefs, String parentId) {
        List<String> ids = new ArrayList<>();
        if (parentRefs != null) for (String s : parentRefs.trim().split("\\s+")) if (s.startsWith("<") && !ids.contains(s)) ids.add(s);
        if (parentId != null && !parentId.isEmpty() && !ids.contains(parentId)) ids.add(parentId);
        if (ids.isEmpty()) return null;
        while (ids.size() > 20) ids.remove(1); // keep the first (thread root) and the newest
        return String.join("\r\n ", ids);
    }

    private static void header(StringBuilder h, String name, String value) {
        h.append(name).append(": ").append(value).append("\r\n");
    }

    private static String list(List<Mime.Address> l) {
        StringBuilder b = new StringBuilder();
        for (Mime.Address a : l) {
            if (b.length() > 0) b.append(",\r\n ");
            b.append(a.header());
        }
        return b.toString();
    }

    private static boolean isAscii(String s) {
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) > 126 || s.charAt(i) < 32) return false;
        return true;
    }

    private static String asciiName(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b.append(c >= 32 && c <= 126 && c != '"' && c != '\\' ? c : '_');
        }
        return b.toString();
    }

    private static String pct(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(StandardCharsets.UTF_8)) {
            int c = x & 0xff;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_') b.append((char) c);
            else b.append('%').append(String.format(Locale.ROOT, "%02X", c));
        }
        return b.toString();
    }

    private static void base64Lines(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[57 * 64];
        Base64.Encoder enc = Base64.getEncoder();
        int fill = 0;
        for (;;) {
            int n = in.read(buf, fill, buf.length - fill);
            if (n > 0) fill += n;
            if (n < 0 || fill == buf.length) {
                int full = n < 0 ? fill : fill - fill % 57;
                for (int i = 0; i < full; i += 57) {
                    int len = Math.min(57, full - i);
                    byte[] chunk = new byte[len];
                    System.arraycopy(buf, i, chunk, 0, len);
                    out.write(enc.encode(chunk));
                    out.write('\r');
                    out.write('\n');
                }
                System.arraycopy(buf, full, buf, 0, fill - full);
                fill -= full;
                if (n < 0) return;
            }
        }
    }

    /** Quoted-printable (RFC 2045) of UTF-8 text with CRLF line ends and soft breaks at 76 characters. */
    public static String encodeQP(String text) {
        StringBuilder out = new StringBuilder();
        String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        for (int li = 0; li < lines.length; li++) {
            byte[] b = lines[li].getBytes(StandardCharsets.UTF_8);
            StringBuilder line = new StringBuilder();
            for (int i = 0; i < b.length; i++) {
                int c = b[i] & 0xff;
                boolean last = i == b.length - 1;
                String enc;
                if ((c >= 33 && c <= 126 && c != '=') || ((c == ' ' || c == '\t') && !last)) enc = String.valueOf((char) c);
                else enc = String.format(Locale.ROOT, "=%02X", c);
                // keep multi-byte sequences together on a line
                int seq = 1;
                if (c >= 0xc0) { seq = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2; }
                int need = enc.length() * (c >= 0xc0 ? seq : 1);
                if (line.length() + need > 75) {
                    out.append(line).append("=\r\n");
                    line.setLength(0);
                }
                if (line.length() == 0 && c == '.') enc = "=2E"; // no lone dots at line start (SMTP safety)
                line.append(enc);
            }
            out.append(line);
            if (li < lines.length - 1) out.append("\r\n");
        }
        return out.toString();
    }
}
