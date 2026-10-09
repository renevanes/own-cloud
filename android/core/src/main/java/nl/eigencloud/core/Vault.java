package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.Map;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * The phone's vault: the admin configuration (master key, tokens) encrypted with a passphrase.
 * PBKDF2-HMAC-SHA256 (310 000 iterations, 16-byte salt) → AES-256-GCM with AAD "vault" (same sealed format
 * as {@link EigenCrypto#seal}). File: {@code {"v":1,"kdf":"pbkdf2","iter":…,"salt":base64,"data":base64}}.
 *
 * <p>For biometric unlock, Android can wrap the derived key ({@link #exportKey()}) with a Keystore key and
 * later call {@link #unlockWithKey(byte[])}. The desktop console uses scrypt; its vault file is a different
 * format and is not read here (move a configuration with the master key + storage recovery instead).
 */
public final class Vault {
    public static final int ITERATIONS = 310_000;
    private static final String AAD = "vault";

    private final File file;
    private byte[] key;
    private byte[] salt;
    private int iterations = ITERATIONS;
    private Map<String, Object> config;

    public Vault(File file) { this.file = file; }

    public File file() { return file; }

    public boolean exists() { return file.isFile(); }

    public boolean isUnlocked() { return config != null; }

    /** The decrypted admin config (mutable; call {@link #save()} after changing it). Null when locked. */
    public Map<String, Object> config() { return config; }

    /** Replaces the admin config (call {@link #save()} afterwards). */
    public void setConfig(Map<String, Object> cfg) {
        requireUnlocked();
        this.config = cfg;
    }

    /** PBKDF2-HMAC-SHA256 over the NFKC-normalized passphrase (UTF-8), 32 bytes. */
    public static byte[] deriveKey(String passphrase, byte[] salt, int iterations) {
        String norm = Normalizer.normalize(passphrase, Normalizer.Form.NFKC);
        char[] pw = norm.toCharArray();
        try {
            SecretKeyFactory f = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            return f.generateSecret(new PBEKeySpec(pw, salt, iterations, 256)).getEncoded();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("PBKDF2 niet beschikbaar", e);
        } finally {
            Arrays.fill(pw, '\0');
        }
    }

    /** Creates a new vault file (passphrase ≥ 12 characters). */
    public void create(String passphrase, Map<String, Object> cfg) throws IOException {
        if (passphrase == null || passphrase.length() < 12) throw new IllegalArgumentException("Kies een wachtwoordzin van minstens 12 tekens");
        this.salt = Bytes.random(16);
        this.iterations = ITERATIONS;
        this.key = deriveKey(passphrase, salt, iterations);
        this.config = cfg;
        save();
    }

    private Map<String, Object> readFile() throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            Map<String, Object> f = Json.parseObject(Bytes.utf8(Bytes.readAll(in)));
            if (!Long.valueOf(1).equals(f.get("v")) || !"pbkdf2".equals(f.get("kdf"))) throw new IOException("Onbekend kluisformaat");
            return f;
        } catch (IllegalArgumentException e) {
            throw new IOException("Kluisbestand is beschadigd", e);
        }
    }

    /** Unlocks with the passphrase; throws "Wachtwoordzin klopt niet" when wrong. */
    public void unlock(String passphrase) throws IOException {
        Map<String, Object> f = readFile();
        byte[] s = Bytes.fromBase64(Json.str(f, "salt"));
        int iter = Json.num(f, "iter").intValue();
        open(f, deriveKey(passphrase, s, iter), s, iter, "Wachtwoordzin klopt niet");
    }

    /** Unlocks with a previously exported key (e.g. unwrapped by the Android Keystore after biometrics). */
    public void unlockWithKey(byte[] derivedKey) throws IOException {
        Map<String, Object> f = readFile();
        open(f, derivedKey.clone(), Bytes.fromBase64(Json.str(f, "salt")), Json.num(f, "iter").intValue(), "Sleutel past niet bij deze kluis");
    }

    private void open(Map<String, Object> f, byte[] k, byte[] s, int iter, String wrong) throws IOException {
        Map<String, Object> cfg;
        try {
            cfg = Json.asMap(EigenCrypto.openJson(k, Bytes.fromBase64(Json.str(f, "data")), AAD));
            if (cfg == null) throw new IllegalArgumentException();
        } catch (RuntimeException e) {
            throw new SecurityException(wrong);
        }
        this.key = k;
        this.salt = s;
        this.iterations = iter;
        this.config = cfg;
    }

    /** The derived 32-byte vault key (copy), to be wrapped by the Android Keystore. */
    public byte[] exportKey() {
        requireUnlocked();
        return key.clone();
    }

    /** Forgets the key and the decrypted config. */
    public void lock() {
        if (key != null) Arrays.fill(key, (byte) 0);
        key = null;
        config = null;
    }

    private void requireUnlocked() {
        if (key == null || salt == null || config == null) throw new IllegalStateException("Kluis is op slot");
    }

    /** Encrypts and writes the config atomically (tmp file + rename), readable only by the owner. */
    public void save() throws IOException {
        requireUnlocked();
        Map<String, Object> f = Json.obj("v", 1L, "kdf", "pbkdf2", "iter", (long) iterations, "salt", Bytes.base64(salt),
                "data", Bytes.base64(EigenCrypto.seal(key, Json.stringify(config), AAD)));
        File dir = file.getAbsoluteFile().getParentFile();
        if (dir != null) dir.mkdirs();
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) {
            o.write(Bytes.utf8(Json.stringify(f)));
            o.getFD().sync();
        }
        tmp.setReadable(false, false);
        tmp.setReadable(true, true);
        tmp.setWritable(false, false);
        tmp.setWritable(true, true);
        if (!tmp.renameTo(file)) {
            if (!file.delete() || !tmp.renameTo(file)) throw new IOException("Kluis opslaan mislukt");
        }
    }
}
