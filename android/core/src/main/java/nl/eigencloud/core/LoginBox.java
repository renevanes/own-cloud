package nl.eigencloud.core;

import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;

/**
 * The cloud login on the phone ("Inloggen met je vingerafdruk"): address + password sealed for an RSA key pair whose
 * private half lives in the phone's secure hardware and only works after the fingerprint. Sealing needs only the public
 * key (no prompt, so the app can store the generated password right after the console launched the cloud); opening
 * needs the fingerprint.
 *
 * <p>Format: {@code {"v":1,"url":…,"key":base64(RSA-OAEP-SHA256(k)),"data":base64(seal(k, {"u":…,"p":…}, AAD "cloud-login:" + url))}}
 * with a fresh 32-byte k (AES-256-GCM, {@link EigenCrypto#seal}). MGF1 uses SHA-1: the setting that the Android
 * Keystore supports on every version.
 */
public final class LoginBox {
    private LoginBox() {}

    public static final String RSA = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding";

    public static OAEPParameterSpec oaep() { return new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT); }

    private static String aad(String url) { return "cloud-login:" + url; }

    /** Seals the login for {@code url} with {@code pub} (also a Keystore public key: it is copied to a plain one first). */
    public static Map<String, Object> seal(PublicKey pub, String url, String user, String password) throws GeneralSecurityException {
        if (url == null || password == null || password.isEmpty()) throw new IllegalArgumentException("Geen inloggegevens");
        PublicKey plain = KeyFactory.getInstance(pub.getAlgorithm()).generatePublic(new X509EncodedKeySpec(pub.getEncoded()));
        Cipher c = Cipher.getInstance(RSA);
        c.init(Cipher.ENCRYPT_MODE, plain, oaep());
        byte[] k = Bytes.random(32);
        try {
            byte[] wrapped = c.doFinal(k);
            byte[] data = EigenCrypto.sealJson(k, Json.obj("u", user == null ? "" : user, "p", password), aad(url));
            return Json.obj("v", 1L, "url", url, "key", Bytes.base64(wrapped), "data", Bytes.base64(data));
        } finally {
            Arrays.fill(k, (byte) 0);
        }
    }

    /** The cipher to unlock with the fingerprint (BiometricPrompt.CryptoObject); throws when the key was invalidated. */
    public static Cipher decryptCipher(PrivateKey priv) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance(RSA);
        c.init(Cipher.DECRYPT_MODE, priv, oaep());
        return c;
    }

    /** Opens the box with an (authenticated) decrypt cipher: {user, password}. */
    public static String[] open(Cipher unlocked, Map<String, Object> box) throws GeneralSecurityException {
        if (box == null || !Long.valueOf(1).equals(box.get("v"))) throw new GeneralSecurityException("Onbekend formaat");
        byte[] k = unlocked.doFinal(Bytes.fromBase64(Json.str(box, "key")));
        try {
            Map<String, Object> m = Json.asMap(EigenCrypto.openJson(k, Bytes.fromBase64(Json.str(box, "data")), aad(Json.str(box, "url"))));
            if (m == null || Json.str(m, "p") == null) throw new GeneralSecurityException("Leeg");
            return new String[] {Json.str(m, "u"), Json.str(m, "p")};
        } catch (RuntimeException e) {
            throw new GeneralSecurityException("Past niet", e);
        } finally {
            Arrays.fill(k, (byte) 0);
        }
    }
}
