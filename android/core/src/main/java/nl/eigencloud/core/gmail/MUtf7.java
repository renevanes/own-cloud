package nl.eigencloud.core.gmail;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * IMAP's modified UTF-7 (RFC 3501 §5.1.3) for mailbox and Gmail label names: printable ASCII stays as is
 * ("&amp;" becomes "&amp;-"), everything else is UTF-16 in a modified base64 between "&amp;" and "-".
 */
public final class MUtf7 {
    private MUtf7() {}

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,".toCharArray();

    public static String encode(String s) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c >= 0x20 && c <= 0x7e) {
                out.append(c == '&' ? "&-" : String.valueOf(c));
                i++;
                continue;
            }
            int j = i;
            while (j < s.length() && (s.charAt(j) < 0x20 || s.charAt(j) > 0x7e)) j++;
            byte[] utf16 = s.substring(i, j).getBytes(StandardCharsets.UTF_16BE);
            out.append('&');
            int bits = 0, acc = 0;
            for (byte b : utf16) {
                acc = (acc << 8) | (b & 0xff);
                bits += 8;
                while (bits >= 6) {
                    bits -= 6;
                    out.append(B64[(acc >> bits) & 0x3f]);
                }
            }
            if (bits > 0) out.append(B64[(acc << (6 - bits)) & 0x3f]);
            out.append('-');
            i = j;
        }
        return out.toString();
    }

    /** Lenient: malformed sequences are kept literally. */
    public static String decode(String s) {
        if (s.indexOf('&') < 0) return s;
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != '&') { out.append(c); i++; continue; }
            int end = s.indexOf('-', i + 1);
            if (end < 0) { out.append(s.substring(i)); break; }
            if (end == i + 1) { out.append('&'); i = end + 1; continue; }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            int bits = 0, acc = 0;
            boolean ok = true;
            for (int k = i + 1; k < end; k++) {
                int v = val(s.charAt(k));
                if (v < 0) { ok = false; break; }
                acc = (acc << 6) | v;
                bits += 6;
                if (bits >= 8) {
                    bits -= 8;
                    bytes.write((acc >> bits) & 0xff);
                }
            }
            if (ok && bytes.size() % 2 == 0) out.append(new String(bytes.toByteArray(), StandardCharsets.UTF_16BE));
            else out.append(s, i, end + 1);
            i = end + 1;
        }
        return out.toString();
    }

    private static int val(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == ',') return 63;
        return -1;
    }
}
