package nl.eigencloud.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import nl.eigencloud.core.Bytes;

/**
 * Geheimen die de app ook zonder jou moet kunnen lezen (achtergrondsynchronisatie, bijv. een app-wachtwoord van Gmail):
 * versleuteld met een AES-256-GCM-sleutel in de beveiligde hardware van de telefoon (Android Keystore) die géén
 * vingerafdruk vraagt. Zo staat er niets leesbaar in de app-gegevens, en een kopie van die gegevens is zonder deze
 * telefoon niets waard. Wat wél je vingerafdruk moet vragen (de beheerkluis, inloggen): zie {@link Biometrics} en
 * {@link CloudLogin}.
 *
 * <pre>
 *   DeviceSecrets.put(context, "gmail.appPassword", wachtwoord);   // bewaren (null = wissen)
 *   String pw = DeviceSecrets.get(context, "gmail.appPassword");   // null als het er niet (meer) is
 *   DeviceSecrets.remove(context, "gmail.appPassword");
 * </pre>
 *
 * De naam is ook de "additional data" van de versleuteling: een waarde kan niet onder een andere naam worden gelezen.
 * Blokkeert even (Keystore): liever niet op de UI-thread. Gaat de sleutel verloren (app-gegevens gewist, nieuwe
 * telefoon), dan geeft {@link #get} null en moet het geheim opnieuw worden ingevuld. Google-back-up van app-gegevens
 * staat uit, dus deze waarden gaan niet mee naar een andere telefoon.
 */
public final class DeviceSecrets {
    private DeviceSecrets() {}

    private static final String ALIAS = "eigen-apparaat-geheimen";
    private static final String FILE = "geheimen";

    private static SharedPreferences prefs(Context c) { return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE); }

    private static synchronized SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    /** Versleutelt {@code value} voor {@code name}: base64(iv ‖ ciphertext+tag). */
    public static String encrypt(String name, String value) throws GeneralSecurityException, IOException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Bytes.base64(Bytes.concat(c.getIV(), ct));
    }

    /** Ontsleutelt wat {@link #encrypt} onder dezelfde naam gaf. */
    public static String decrypt(String name, String sealed) throws GeneralSecurityException, IOException {
        byte[] all = Bytes.fromBase64(sealed);
        if (all.length < 12 + 16) throw new GeneralSecurityException("Te kort");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
        c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
    }

    /** Bewaart een geheim onder {@code name}; {@code null} wist het. Geeft false als bewaren niet lukte. */
    public static boolean put(Context c, String name, String value) {
        if (value == null) { remove(c, name); return true; }
        try {
            prefs(c).edit().putString(name, encrypt(name, value)).apply();
            return true;
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            return false;
        }
    }

    /** Het geheim onder {@code name}, of null als het er niet is of niet meer te lezen is. */
    public static String get(Context c, String name) {
        String s = prefs(c).getString(name, null);
        if (s == null) return null;
        try {
            return decrypt(name, s);
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            return null;
        }
    }

    public static void remove(Context c, String name) { prefs(c).edit().remove(name).apply(); }

    /** Alles wissen (opnieuw instellen van de app). */
    public static void clear(Context c) {
        prefs(c).edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(ALIAS);
        } catch (GeneralSecurityException | IOException | RuntimeException ignored) {
            // er was geen sleutel
        }
    }
}
