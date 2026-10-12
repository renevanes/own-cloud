package nl.eigencloud.core;

import java.security.GeneralSecurityException;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Port of src/cluster/crypto.ts: small sealed messages, and the chunked file format of encryptBuffer/decryptBuffer
 * (whole buffers in memory; used for the Dienst's backups in the hersteltest).
 *
 * <p>Sealed message format: {@code [0x01][nonce 12][ciphertext][tag 16]}, AES-256-GCM, optional AAD string.
 */
public final class EigenCrypto {
    private EigenCrypto() {}

    private static final byte[] HKDF_SALT = Bytes.utf8("eigen-cloud");

    /** HKDF-SHA256 subkey of the master key (salt "eigen-cloud", info = purpose), 32 bytes. */
    public static byte[] deriveKey(byte[] master, String purpose) { return deriveKey(master, purpose, 32); }

    /** HKDF-SHA256 (RFC 5869) with salt "eigen-cloud" and info = purpose. */
    public static byte[] deriveKey(byte[] master, String purpose, int len) {
        byte[] prk = Bytes.hmacSha256(HKDF_SALT, master);
        byte[] info = Bytes.utf8(purpose);
        byte[] out = new byte[len];
        byte[] t = new byte[0];
        int off = 0;
        for (int i = 1; off < len; i++) {
            t = Bytes.hmacSha256(prk, Bytes.concat(t, info, new byte[] {(byte) i}));
            int n = Math.min(t.length, len - off);
            System.arraycopy(t, 0, out, off, n);
            off += n;
        }
        return out;
    }

    /** Parses a 64-hex-character key; throws with the Dutch message from the TS source otherwise. */
    public static byte[] parseKey(String hex) {
        byte[] k = Bytes.fromHex(hex.trim());
        if (k.length != 32) throw new IllegalArgumentException("Sleutel moet 32 bytes (64 hex-tekens) zijn");
        return k;
    }

    /** New random 32-byte key as hex. */
    public static String randomKeyHex() { return Bytes.hex(Bytes.random(32)); }

    public static byte[] seal(byte[] key, byte[] data) { return seal(key, data, null); }

    public static byte[] seal(byte[] key, String data, String aad) { return seal(key, Bytes.utf8(data), aad); }

    /** AES-256-GCM seal; {@code aad} may be null (an empty string is treated as no AAD, like the TS code). */
    public static byte[] seal(byte[] key, byte[] data, String aad) {
        byte[] nonce = Bytes.random(12);
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            if (aad != null && !aad.isEmpty()) c.updateAAD(Bytes.utf8(aad));
            byte[] ctTag = c.doFinal(data);
            return Bytes.concat(new byte[] {1}, nonce, ctTag);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Versleutelen mislukt: " + e.getMessage(), e);
        }
    }

    public static byte[] open(byte[] key, byte[] buf) { return open(key, buf, null); }

    /**
     * Opens a sealed message. Throws {@link IllegalArgumentException} ("Ongeldig versleuteld bericht") for a
     * malformed buffer and {@link SecurityException} when the key/AAD does not match or the data was altered.
     */
    public static byte[] open(byte[] key, byte[] buf, String aad) {
        if (buf == null || buf.length < 29 || buf[0] != 1) throw new IllegalArgumentException("Ongeldig versleuteld bericht");
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            byte[] nonce = new byte[12];
            System.arraycopy(buf, 1, nonce, 0, 12);
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            if (aad != null && !aad.isEmpty()) c.updateAAD(Bytes.utf8(aad));
            return c.doFinal(buf, 13, buf.length - 13);
        } catch (AEADBadTagException e) {
            throw new SecurityException("Ontsleutelen mislukt (verkeerde sleutel of beschadigd bericht)", e);
        } catch (GeneralSecurityException e) {
            throw new SecurityException("Ontsleutelen mislukt: " + e.getMessage(), e);
        }
    }

    /** seal(key, JSON.stringify(obj), aad). */
    public static byte[] sealJson(byte[] key, Object obj, String aad) { return seal(key, Bytes.utf8(Json.stringify(obj)), aad); }

    /** JSON.parse(open(key, buf, aad)). */
    public static Object openJson(byte[] key, byte[] buf, String aad) { return Json.parse(Bytes.utf8(open(key, buf, aad))); }

    // ───────── Large files: "EC1\n" + base nonce(8) + chunks [length u32 (top bit = last)][ciphertext][tag 16] ─────────

    private static final byte[] MAGIC = Bytes.utf8("EC1\n");
    private static final int CHUNK = 1024 * 1024;
    private static final long FINAL = 0x80000000L;

    private static byte[] chunkNonce(byte[] base, int i) {
        byte[] n = new byte[12];
        System.arraycopy(base, 0, n, 0, 8);
        n[8] = (byte) (i >>> 24); n[9] = (byte) (i >>> 16); n[10] = (byte) (i >>> 8); n[11] = (byte) i;
        return n;
    }

    private static Cipher gcm(int mode, byte[] key, byte[] nonce, boolean last) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        c.updateAAD(new byte[] {(byte) (last ? 1 : 0)});
        return c;
    }

    /** encryptBuffer in crypto.ts: the whole buffer in the chunked format (blocks of 1 MiB, the last one marked). */
    public static byte[] encryptBuffer(byte[] key, byte[] plain) {
        try {
            byte[] base = Bytes.random(8);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(plain.length + 64);
            out.write(MAGIC, 0, MAGIC.length);
            out.write(base, 0, 8);
            int off = 0, i = 0;
            do {
                int len = Math.min(CHUNK, plain.length - off);
                boolean last = off + len >= plain.length;
                // Like the TS stream: only a block that is followed by more data is a full, non-final block.
                if (len == CHUNK && off + len == plain.length) last = true;
                byte[] ct = gcm(Cipher.ENCRYPT_MODE, key, chunkNonce(base, i++), last).doFinal(plain, off, len);
                long head = len | (last ? FINAL : 0);
                out.write(new byte[] {(byte) (head >>> 24), (byte) (head >>> 16), (byte) (head >>> 8), (byte) head}, 0, 4);
                out.write(ct, 0, ct.length);
                off += len;
                if (last) break;
            } while (true);
            return out.toByteArray();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** decryptBuffer in crypto.ts. Throws IllegalArgumentException (Dutch) for a damaged file or the wrong key. */
    public static byte[] decryptBuffer(byte[] key, byte[] enc) {
        if (enc.length < 12 || !java.util.Arrays.equals(java.util.Arrays.copyOf(enc, 4), MAGIC)) throw new IllegalArgumentException("Geen versleuteld Eigen Cloud-bestand");
        byte[] base = java.util.Arrays.copyOfRange(enc, 4, 12);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(enc.length);
        int p = 12, i = 0;
        boolean done = false;
        while (p < enc.length) {
            if (done) throw new IllegalArgumentException("Extra data na laatste blok");
            if (enc.length - p < 4) throw new IllegalArgumentException("Versleuteld bestand is afgekapt of beschadigd");
            long head = ((enc[p] & 0xffL) << 24) | ((enc[p + 1] & 0xffL) << 16) | ((enc[p + 2] & 0xffL) << 8) | (enc[p + 3] & 0xffL);
            boolean last = (head & FINAL) != 0;
            int len = (int) (head & ~FINAL);
            if (len > CHUNK) throw new IllegalArgumentException("Ongeldige bloklengte");
            if (enc.length - p < 4 + len + 16) throw new IllegalArgumentException("Versleuteld bestand is afgekapt of beschadigd");
            try {
                byte[] plain = gcm(Cipher.DECRYPT_MODE, key, chunkNonce(base, i++), last).doFinal(enc, p + 4, len + 16);
                out.write(plain, 0, plain.length);
            } catch (GeneralSecurityException e) {
                throw new IllegalArgumentException("Kan niet ontsleutelen (verkeerde sleutel of beschadigd bestand)");
            }
            p += 4 + len + 16;
            if (last) done = true;
        }
        if (!done) throw new IllegalArgumentException("Versleuteld bestand is afgekapt of beschadigd");
        return out.toByteArray();
    }
}
