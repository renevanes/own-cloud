package nl.eigencloud.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Byte and string helpers shared by the core (hex, base64, UTF-8, hashing, URI encoding). */
public final class Bytes {
    private Bytes() {}

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** Cryptographically secure random bytes. */
    public static byte[] random(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    /** Lowercase hex. */
    public static String hex(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            c[2 * i] = HEX[(b[i] >> 4) & 15];
            c[2 * i + 1] = HEX[b[i] & 15];
        }
        return new String(c);
    }

    /**
     * Decodes hex like Node's {@code Buffer.from(s, "hex")}: stops at the first invalid pair and ignores a
     * trailing odd nibble.
     */
    public static byte[] fromHex(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() / 2);
        for (int i = 0; i + 1 < s.length(); i += 2) {
            int hi = Character.digit(s.charAt(i), 16), lo = Character.digit(s.charAt(i + 1), 16);
            if (hi < 0 || lo < 0) break;
            out.write(hi * 16 + lo);
        }
        return out.toByteArray();
    }

    public static String base64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    public static byte[] fromBase64(String s) { return Base64.getDecoder().decode(s.trim()); }

    /**
     * UTF-8 encoding like Node's {@code Buffer.from(string)}: lone surrogates become U+FFFD (EF BF BD).
     */
    public static byte[] utf8(String s) {
        boolean clean = true;
        for (int i = 0; i < s.length() && clean; i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) i++;
                else clean = false;
            } else if (Character.isLowSurrogate(c)) clean = false;
        }
        if (clean) return s.getBytes(StandardCharsets.UTF_8);
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                b.append(c).append(s.charAt(++i));
            } else if (Character.isSurrogate(c)) b.append('�');
            else b.append(c);
        }
        return b.toString().getBytes(StandardCharsets.UTF_8);
    }

    public static String utf8(byte[] b) { return new String(b, StandardCharsets.UTF_8); }

    public static byte[] sha256(byte[] data) { return digest("SHA-256", data); }

    public static String sha256Hex(byte[] data) { return hex(sha256(data)); }

    public static byte[] md5(byte[] data) { return digest("MD5", data); }

    private static byte[] digest(String alg, byte[] data) {
        try {
            return MessageDigest.getInstance(alg).digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] hmacSha256(byte[] key, byte[] data) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            // SecretKeySpec refuses empty keys; HMAC pads keys with zeros to the block size, so an all-zero
            // 64-byte key is equivalent to an empty key.
            m.init(new SecretKeySpec(key.length == 0 ? new byte[64] : key, "HmacSHA256"));
            return m.doFinal(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    public static byte[] hmacSha256(byte[] key, String data) { return hmacSha256(key, utf8(data)); }

    /** Constant-time comparison. */
    public static boolean equal(byte[] a, byte[] b) { return MessageDigest.isEqual(a, b); }

    public static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }

    public static byte[] readAll(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int r;
        while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
        return out.toByteArray();
    }

    /** JavaScript's {@code encodeURIComponent} (keeps A–Z a–z 0–9 - _ . ! ~ * ' ( )). */
    public static String encodeURIComponent(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : utf8(s)) {
            int c = x & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".indexOf(c) >= 0) b.append((char) c);
            else b.append('%').append(Character.toUpperCase(HEX[c >> 4])).append(Character.toUpperCase(HEX[c & 15]));
        }
        return b.toString();
    }

    /** JavaScript's {@code decodeURIComponent} (lenient: invalid escapes are kept as-is). */
    public static String decodeURIComponent(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) { out.write(hi * 16 + lo); i += 2; continue; }
            }
            if (out.size() > 0) { b.append(utf8(out.toByteArray())); out.reset(); }
            b.append(c);
        }
        if (out.size() > 0) b.append(utf8(out.toByteArray()));
        return b.toString();
    }

    /** JS {@code String.prototype.slice(0, n)} on UTF-16 units. */
    public static String head(String s, int n) { return s.length() <= n ? s : s.substring(0, n); }
}
