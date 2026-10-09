package nl.eigencloud.app;

import android.app.Activity;
import android.content.Context;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import nl.eigencloud.core.Bytes;

/**
 * Ontgrendelen met vingerafdruk of gezicht. De sleutel van de kluis wordt versleuteld met een sleutel in de
 * beveiligde hardware van de telefoon (Android Keystore), die alleen na biometrische controle werkt. Komt er
 * een nieuwe vingerafdruk bij, dan vervalt die sleutel en vraagt de app weer om je wachtwoordzin.
 */
@android.annotation.TargetApi(29)
final class Biometrics {
    private Biometrics() {}

    interface Done {
        void ok(byte[] value);

        void fail(String message);
    }

    private static final String ALIAS = "eigen-kluis";

    static boolean available(Context c) {
        if (Build.VERSION.SDK_INT < 29) return false;
        BiometricManager bm = c.getSystemService(BiometricManager.class);
        if (bm == null) return false;
        if (Build.VERSION.SDK_INT >= 30) return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
        return bm.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
    }

    static boolean enrolled(Context c) { return Prefs.str(c, "bio.data") != null; }

    static void forget(Context c) {
        Prefs.setStr(c, "bio.data", null);
        Prefs.setStr(c, "bio.iv", null);
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {
            // er was geen sleutel
        }
    }

    private static SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        if (!create) return null;
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        g.init(spec.build());
        return g.generateKey();
    }

    /** Slaat {@code secret} op achter biometrie (vraagt één keer om je vingerafdruk). */
    static void enroll(Activity a, byte[] secret, Done done) {
        try {
            forget(a);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            prompt(a, "Vingerafdruk instellen", "Voortaan ontgrendel je de beheerkluis hiermee", cipher, new Done() {
                @Override public void ok(byte[] unused) {
                    try {
                        byte[] ct = cipher.doFinal(secret);
                        Prefs.setStr(a, "bio.iv", Bytes.base64(cipher.getIV()));
                        Prefs.setStr(a, "bio.data", Bytes.base64(ct));
                        done.ok(null);
                    } catch (Exception e) {
                        done.fail("Instellen mislukt: " + e.getMessage());
                    }
                }

                @Override public void fail(String message) { done.fail(message); }
            });
        } catch (Exception e) {
            done.fail("Instellen mislukt: " + e.getMessage());
        }
    }

    /** Vraagt om je vingerafdruk en geeft het opgeslagen geheim terug. */
    static void unlock(Activity a, Done done) {
        try {
            SecretKey k = key(false);
            String iv = Prefs.str(a, "bio.iv"), data = Prefs.str(a, "bio.data");
            if (k == null || iv == null || data == null) { forget(a); done.fail("Gebruik je wachtwoordzin"); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, Bytes.fromBase64(iv)));
            prompt(a, "Beheerkluis ontgrendelen", null, cipher, new Done() {
                @Override public void ok(byte[] unused) {
                    try { done.ok(cipher.doFinal(Bytes.fromBase64(data))); } catch (Exception e) { done.fail("Ontgrendelen mislukt; gebruik je wachtwoordzin"); }
                }

                @Override public void fail(String message) { done.fail(message); }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            forget(a);
            done.fail("Er is een vingerafdruk bijgekomen. Ontgrendel één keer met je wachtwoordzin.");
        } catch (Exception e) {
            done.fail("Ontgrendelen mislukt: " + e.getMessage());
        }
    }

    private static void prompt(Activity a, String title, String subtitle, Cipher cipher, Done done) {
        a.runOnUiThread(() -> {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(a).setTitle(title)
                    .setNegativeButton("Wachtwoordzin gebruiken", a.getMainExecutor(), (d, w) -> done.fail("Gebruik je wachtwoordzin"));
            if (subtitle != null) b.setSubtitle(subtitle);
            b.build().authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), a.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { done.ok(null); }

                @Override public void onAuthenticationError(int code, CharSequence msg) { done.fail(String.valueOf(msg)); }
            });
        });
    }
}
