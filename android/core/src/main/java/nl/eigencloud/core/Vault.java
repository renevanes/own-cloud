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
 * The phone's vault: the admin configuration (master key, tokens) encrypted with a 32-byte vault key K,
 * AES-256-GCM with AAD "vault" (same sealed format as {@link EigenCrypto#seal}). Two ways to get K:
 *
 * <ul>
 * <li><b>passphrase</b> (the original format): K = PBKDF2-HMAC-SHA256(passphrase, salt, 310 000 iterations).
 *     File: {@code {"v":1,"kdf":"pbkdf2","iter":…,"salt":base64,"data":base64}}.</li>
 * <li><b>device</b>: K is random and wrapped by a key in the phone's secure hardware that needs the fingerprint
 *     ({@link DeviceLock}). File: {@code {"v":1,"kdf":"device","device":{…},"data":base64}}, optionally with
 *     {@code "pass":{"kdf":"pbkdf2","iter":…,"salt":…,"key":base64}} so a passphrase opens it too: {@code key} =
 *     seal(PBKDF2(passphrase), K, AAD "vault-key"). Without {@code key}, K is the PBKDF2 result itself (a passphrase
 *     vault that switched to the fingerprint keeps its passphrase that way).</li>
 * </ul>
 *
 * <p>With a passphrase vault, Android can also wrap K ({@link #exportKey()}) itself and later call
 * {@link #unlockWithKey(byte[])}. The desktop console uses scrypt; its vault file is a different format and is not
 * read here (move a configuration with the master key + storage recovery instead).
 */
public final class Vault {
    public static final int ITERATIONS = 310_000;
    public static final String PASSPHRASE = "passphrase", DEVICE = "device";
    private static final String AAD = "vault";
    private static final String KEY_AAD = "vault-key";

    private final File file;
    private byte[] key;
    private String mode = PASSPHRASE;
    // passphrase mode
    private byte[] salt;
    private int iterations = ITERATIONS;
    // device mode
    private Map<String, Object> device;
    private Map<String, Object> pass;
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

    private static void requireLongPassphrase(String passphrase) {
        if (passphrase == null || passphrase.length() < 12) throw new IllegalArgumentException("Kies een wachtwoordzin van minstens 12 tekens");
    }

    /** Creates a new vault file protected by a passphrase (≥ 12 characters). */
    public void create(String passphrase, Map<String, Object> cfg) throws IOException {
        requireLongPassphrase(passphrase);
        this.mode = PASSPHRASE;
        this.salt = Bytes.random(16);
        this.iterations = ITERATIONS;
        this.key = deriveKey(passphrase, salt, iterations);
        this.device = null;
        this.pass = null;
        this.config = cfg;
        save();
    }

    /**
     * Creates a new vault file protected by the phone's device key (no passphrase): a random vault key, wrapped by
     * {@code lock} (the owner confirms with the fingerprint). Nothing is written when wrapping fails.
     */
    public void createDevice(Map<String, Object> cfg, DeviceLock lock) throws IOException {
        if (lock == null) throw new DeviceLock.Unavailable("Met je vingerafdruk kan alleen in de app op je telefoon");
        byte[] k = Bytes.random(32);
        Map<String, Object> wrapped = lock.wrap(k.clone());
        this.mode = DEVICE;
        this.key = k;
        this.device = Json.copy(wrapped);
        this.pass = null;
        this.salt = null;
        this.config = cfg;
        save();
    }

    private Map<String, Object> readFile() throws IOException {
        try (FileInputStream in = new FileInputStream(file)) {
            Map<String, Object> f = Json.parseObject(Bytes.utf8(Bytes.readAll(in)));
            Object kdf = f.get("kdf");
            if (!Long.valueOf(1).equals(f.get("v")) || !("pbkdf2".equals(kdf) || (DEVICE.equals(kdf) && Json.map(f, "device") != null))) {
                throw new IOException("Onbekend kluisformaat");
            }
            return f;
        } catch (IllegalArgumentException e) {
            throw new IOException("Kluisbestand is beschadigd", e);
        }
    }

    /**
     * How the vault file on disk is protected, without unlocking: {@code {"mode":"passphrase"|"device","passphrase":bool}}
     * ({@code passphrase}: a passphrase opens it). Null when there is no (readable) vault.
     */
    public Map<String, Object> describe() {
        if (!exists()) return null;
        try {
            Map<String, Object> f = readFile();
            boolean dev = DEVICE.equals(f.get("kdf"));
            return Json.obj("mode", dev ? DEVICE : PASSPHRASE, "passphrase", !dev || Json.map(f, "pass") != null);
        } catch (IOException e) {
            return null;
        }
    }

    /** The wrapped vault key of a device vault on disk (for {@link DeviceLock#invalidated}); null otherwise. */
    public Map<String, Object> deviceWrap() {
        if (!exists()) return null;
        try {
            Map<String, Object> f = readFile();
            return DEVICE.equals(f.get("kdf")) ? Json.copy(Json.map(f, "device")) : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** "passphrase" or "device" for an unlocked vault. */
    public String mode() { return mode; }

    /** Unlocks with the passphrase; throws "Wachtwoordzin klopt niet" when wrong. */
    public void unlock(String passphrase) throws IOException {
        Map<String, Object> f = readFile();
        if (DEVICE.equals(f.get("kdf"))) {
            Map<String, Object> p = Json.map(f, "pass");
            if (p == null) throw new SecurityException("Deze kluis heeft geen wachtwoordzin. Ontgrendel met je vingerafdruk, of herstel met je herstelsleutel.");
            byte[] kek = deriveKey(passphrase == null ? "" : passphrase, Bytes.fromBase64(Json.str(p, "salt")), Json.num(p, "iter").intValue());
            byte[] k;
            if (Json.str(p, "key") == null) k = kek;
            else {
                try {
                    k = EigenCrypto.open(kek, Bytes.fromBase64(Json.str(p, "key")), KEY_AAD);
                } catch (RuntimeException e) {
                    throw new SecurityException("Wachtwoordzin klopt niet");
                }
            }
            open(f, k, "Wachtwoordzin klopt niet");
            return;
        }
        byte[] s = Bytes.fromBase64(Json.str(f, "salt"));
        int iter = Json.num(f, "iter").intValue();
        open(f, deriveKey(passphrase == null ? "" : passphrase, s, iter), "Wachtwoordzin klopt niet");
    }

    /** Unlocks a device vault through the phone's device key (asks for the fingerprint). */
    public void unlockDevice(DeviceLock lock, String via) throws IOException {
        if (lock == null) throw new DeviceLock.Unavailable("Met je vingerafdruk kan alleen in de app op je telefoon");
        Map<String, Object> f = readFile();
        if (!DEVICE.equals(f.get("kdf"))) throw new IllegalStateException("Deze kluis opent met je wachtwoordzin");
        byte[] k = lock.unwrap(Json.copy(Json.map(f, "device")), via);
        open(f, k, "Sleutel past niet bij deze kluis");
    }

    /** Unlocks with a previously exported key (e.g. unwrapped by the Android Keystore after biometrics). */
    public void unlockWithKey(byte[] vaultKey) throws IOException {
        open(readFile(), vaultKey.clone(), "Sleutel past niet bij deze kluis");
    }

    private void open(Map<String, Object> f, byte[] k, String wrong) {
        Map<String, Object> cfg;
        try {
            cfg = Json.asMap(EigenCrypto.openJson(k, Bytes.fromBase64(Json.str(f, "data")), AAD));
            if (cfg == null) throw new IllegalArgumentException();
        } catch (RuntimeException e) {
            throw new SecurityException(wrong);
        }
        if (DEVICE.equals(f.get("kdf"))) {
            this.mode = DEVICE;
            this.device = Json.copy(Json.map(f, "device"));
            this.pass = Json.map(f, "pass") == null ? null : Json.copy(Json.map(f, "pass"));
            this.salt = null;
        } else {
            this.mode = PASSPHRASE;
            this.salt = Bytes.fromBase64(Json.str(f, "salt"));
            this.iterations = Json.num(f, "iter").intValue();
            this.device = null;
            this.pass = null;
        }
        this.key = k;
        this.config = cfg;
    }

    /** True when a passphrase opens the (unlocked) vault. */
    public boolean hasPassphrase() {
        requireUnlocked();
        return PASSPHRASE.equals(mode) || pass != null;
    }

    /** Checks a passphrase against the unlocked vault without changing anything. */
    public boolean checkPassphrase(String passphrase) {
        requireUnlocked();
        if (passphrase == null) return false;
        if (PASSPHRASE.equals(mode)) return Bytes.equal(deriveKey(passphrase, salt, iterations), key);
        if (pass == null) return false;
        byte[] kek = deriveKey(passphrase, Bytes.fromBase64(Json.str(pass, "salt")), Json.num(pass, "iter").intValue());
        if (Json.str(pass, "key") == null) return Bytes.equal(kek, key);
        try {
            return Bytes.equal(EigenCrypto.open(kek, Bytes.fromBase64(Json.str(pass, "key")), KEY_AAD), key);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Device vault: also let a passphrase open it (≥ 12 characters), e.g. for when the fingerprints change.
     * Replaces an earlier passphrase.
     */
    public void addPassphrase(String passphrase) throws IOException {
        requireUnlocked();
        if (!DEVICE.equals(mode)) throw new IllegalStateException("Je kluis heeft al een wachtwoordzin");
        requireLongPassphrase(passphrase);
        byte[] s = Bytes.random(16);
        byte[] kek = deriveKey(passphrase, s, ITERATIONS);
        this.pass = Json.obj("kdf", "pbkdf2", "iter", (long) ITERATIONS, "salt", Bytes.base64(s), "key", Bytes.base64(EigenCrypto.seal(kek, key, KEY_AAD)));
        Arrays.fill(kek, (byte) 0);
        save();
    }

    /**
     * Protects the unlocked vault with a new device key (the owner confirms with the fingerprint). A passphrase vault
     * becomes a device vault whose passphrase keeps working; a device vault gets a fresh device key (after the
     * fingerprints changed). The old device key is released once the new one is saved.
     */
    public void useDevice(DeviceLock lock) throws IOException {
        requireUnlocked();
        if (lock == null) throw new DeviceLock.Unavailable("Met je vingerafdruk kan alleen in de app op je telefoon");
        Map<String, Object> wrapped = lock.wrap(key.clone());
        Map<String, Object> old = device;
        if (PASSPHRASE.equals(mode)) {
            this.pass = Json.obj("kdf", "pbkdf2", "iter", (long) iterations, "salt", Bytes.base64(salt));
            this.salt = null;
            this.mode = DEVICE;
        }
        this.device = Json.copy(wrapped);
        save();
        if (old != null) lock.release(old);
    }

    /** The 32-byte vault key (copy), to be wrapped by the Android Keystore. */
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

    /** Opnieuw beginnen: kluisbestand weg (de herstelsleutel is daarmee ook van dit toestel weg). */
    public void destroy() {
        lock();
        device = null;
        pass = null;
        if (file.exists() && !file.delete()) file.deleteOnExit();
        new File(file.getPath() + ".tmp").delete();
    }

    private void requireUnlocked() {
        if (key == null || config == null || (PASSPHRASE.equals(mode) ? salt == null : device == null)) throw new IllegalStateException("Kluis is op slot");
    }

    /** Encrypts and writes the config atomically (tmp file + rename), readable only by the owner. */
    public void save() throws IOException {
        requireUnlocked();
        String data = Bytes.base64(EigenCrypto.seal(key, Json.stringify(config), AAD));
        Map<String, Object> f = DEVICE.equals(mode)
                ? Json.obj("v", 1L, "kdf", DEVICE, "device", device)
                : Json.obj("v", 1L, "kdf", "pbkdf2", "iter", (long) iterations, "salt", Bytes.base64(salt));
        if (DEVICE.equals(mode) && pass != null) f.put("pass", pass);
        f.put("data", data);
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
