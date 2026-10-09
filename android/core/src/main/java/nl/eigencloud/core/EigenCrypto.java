package nl.eigencloud.core;

import java.security.GeneralSecurityException;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Port of src/cluster/crypto.ts (small messages only; stream encryption is not needed on the phone).
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
}
