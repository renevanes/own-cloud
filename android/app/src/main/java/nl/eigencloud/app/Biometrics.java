package nl.eigencloud.app;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Looper;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import java.io.IOException;
import java.lang.ref.WeakReference;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.Signature;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.DeviceLock;
import nl.eigencloud.core.Json;

/**
 * Vingerafdruk (of gezicht) en de pincode van de telefoon, met sleutels in de beveiligde hardware (Android Keystore).
 *
 * <ul>
 * <li><b>Kluis achter je vingerafdruk</b> (standaard op de telefoon): de sleutel van de kluis is willekeurig en zit
 *     versleuteld achter een Keystore-sleutel die alleen na je vingerafdruk werkt; vanaf Android 11 ook na de pincode,
 *     het patroon of het wachtwoord van de telefoon. {@link #LOCK} is die sleutel voor de Java-kern ({@link DeviceLock}).</li>
 * <li><b>Kluis met wachtwoordzin</b> (zoals voorheen): "Voortaan ontgrendelen met vingerafdruk" bewaart de afgeleide
 *     sleutel achter een Keystore-sleutel met alleen biometrie ({@link #enroll}, {@link #unlock}).</li>
 * </ul>
 * Komt er een vingerafdruk bij, dan zet Android die sleutels uit; de app legt dat uit en biedt de pincode, de
 * wachtwoordzin (als je die hebt) of de herstelsleutel aan. Zie TRUST.md.
 */
final class Biometrics {
    private Biometrics() {}

    interface Done {
        void ok(byte[] value);

        void fail(String message);
    }

    /** Uitkomst van een vraag om je vingerafdruk (de sleutel in de CryptoObject is daarna te gebruiken). */
    interface Answer {
        void ok();

        void fail(String message, boolean cancelled);
    }

    /** Wat de vraag om je vingerafdruk laat zien. */
    static final class Ask {
        final String title;
        String subtitle;
        String negative = "Annuleren";
        /** De pincode van de telefoon als alternatief (Android 11+, en alleen als de sleutel dat toestaat). */
        boolean pin;
        /** Meteen om de pincode vragen. */
        boolean pinOnly;

        Ask(String title) { this.title = title; }
    }

    /** Kluis met wachtwoordzin: de afgeleide sleutel achter biometrie (zoals voorheen). */
    private static final String ALIAS = "eigen-kluis";
    /** Kluis achter je vingerafdruk: één Keystore-sleutel per keer dat je hem (opnieuw) instelt. */
    private static final String DEVICE_PREFIX = "eigen-kluis-apparaat-";

    // ───────── Wat kan deze telefoon? ─────────

    /** Sterke biometrie (vingerafdruk of gezicht) is ingesteld; vanaf Android 10 na te gaan. */
    static boolean available(Context c) {
        if (Build.VERSION.SDK_INT < 29) return false;
        return biometricCode(c) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    /** BiometricManager-uitkomst voor sterke biometrie (Android 10+); -1 als dat niet na te gaan is. */
    @SuppressWarnings("deprecation")
    private static int biometricCode(Context c) {
        if (Build.VERSION.SDK_INT >= 29) {
            BiometricManager bm = c.getSystemService(BiometricManager.class);
            if (bm == null) return BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE;
            if (Build.VERSION.SDK_INT >= 30) return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
            return bm.canAuthenticate();
        }
        return -1;
    }

    /** Er is een schermvergrendeling (pincode, patroon of wachtwoord). */
    static boolean secure(Context c) {
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    /** De pincode als alternatief: vanaf Android 11 kan een Keystore-sleutel ook met de schermvergrendeling. */
    static boolean pinAllowed(Context c) { return Build.VERSION.SDK_INT >= 30 && secure(c); }

    /**
     * Voor de schermen (zie {@link DeviceLock#status()}): {@code available} als de kluis achter je vingerafdruk kan.
     * Er moet een vingerafdruk (of gezicht) zijn; de pincode is alleen het alternatief.
     */
    static Map<String, Object> status(Context c) {
        if (Build.VERSION.SDK_INT < 28) return Json.obj("available", false, "biometric", false, "pin", false, "reason", "android");
        if (!secure(c)) return Json.obj("available", false, "biometric", false, "pin", false, "reason", "geen-slot");
        int code = biometricCode(c);
        boolean pin = pinAllowed(c);
        if (code == -1) return Json.obj("available", true, "biometric", null, "pin", pin, "reason", null); // Android 9: blijkt bij het instellen
        if (code == BiometricManager.BIOMETRIC_SUCCESS) return Json.obj("available", true, "biometric", true, "pin", pin, "reason", null);
        String reason = code == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ? "geen-vinger" : "hardware";
        return Json.obj("available", false, "biometric", false, "pin", pin, "reason", reason);
    }

    /** De instellingen van Android om een vingerafdruk (en zo nodig eerst een pincode) in te stellen. */
    @SuppressWarnings("deprecation")
    static Intent securitySettings() {
        if (Build.VERSION.SDK_INT >= 30) {
            return new Intent(Settings.ACTION_BIOMETRIC_ENROLL).putExtra(Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED, BiometricManager.Authenticators.BIOMETRIC_STRONG);
        }
        if (Build.VERSION.SDK_INT >= 28) return new Intent(Settings.ACTION_FINGERPRINT_ENROLL);
        return new Intent(Settings.ACTION_SECURITY_SETTINGS);
    }

    static void openSecuritySettings(Activity a) {
        try {
            a.startActivity(securitySettings());
        } catch (RuntimeException e) {
            try { a.startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS)); } catch (RuntimeException ignored) { /* geen instellingen-app */ }
        }
    }

    // ───────── Keystore ─────────

    private static KeyStore keyStore() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private static void delete(String alias) {
        try { keyStore().deleteEntry(alias); } catch (GeneralSecurityException | IOException | RuntimeException ignored) { /* er was geen sleutel */ }
    }

    /** Kluis met wachtwoordzin: de vingerafdruk-ontgrendeling vergeten (de kluis zelf blijft). */
    static void forget(Context c) {
        Prefs.setStr(c, "bio.data", null);
        Prefs.setStr(c, "bio.iv", null);
        delete(ALIAS);
    }

    /** Alles vergeten (opnieuw instellen): ook de sleutels van een kluis achter je vingerafdruk. */
    static void forgetAll(Context c) {
        forget(c);
        try {
            KeyStore ks = keyStore();
            for (String a : Collections.list(ks.aliases())) if (a.startsWith(DEVICE_PREFIX)) ks.deleteEntry(a);
        } catch (GeneralSecurityException | IOException | RuntimeException ignored) {
            // niets te wissen
        }
    }

    static boolean enrolled(Context c) { return Prefs.str(c, "bio.data") != null; }

    // ───────── Kluis met wachtwoordzin: vingerafdruk erbij (zoals voorheen) ─────────

    private static SecretKey legacyKey(boolean create) throws GeneralSecurityException, IOException {
        KeyStore ks = keyStore();
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
        if (Build.VERSION.SDK_INT < 29) { done.fail("Niet beschikbaar op deze Android-versie"); return; }
        try {
            forget(a);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, legacyKey(true));
            Ask q = new Ask("Vingerafdruk instellen");
            q.subtitle = "Voortaan ontgrendel je de beheerkluis hiermee";
            onUi(a, q, cipher, new Answer() {
                @Override public void ok() {
                    try {
                        byte[] ct = cipher.doFinal(secret);
                        Prefs.setStr(a, "bio.iv", Bytes.base64(cipher.getIV()));
                        Prefs.setStr(a, "bio.data", Bytes.base64(ct));
                        done.ok(null);
                    } catch (GeneralSecurityException | RuntimeException e) {
                        done.fail("Instellen mislukt: " + e.getMessage());
                    }
                }

                @Override public void fail(String message, boolean cancelled) { done.fail(message); }
            });
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            done.fail("Instellen mislukt: " + e.getMessage());
        }
    }

    /** Vraagt om je vingerafdruk en geeft het opgeslagen geheim terug. */
    static void unlock(Activity a, Done done) {
        if (Build.VERSION.SDK_INT < 29) { done.fail("Gebruik je wachtwoordzin"); return; }
        try {
            SecretKey k = legacyKey(false);
            String iv = Prefs.str(a, "bio.iv"), data = Prefs.str(a, "bio.data");
            if (k == null || iv == null || data == null) { forget(a); done.fail("Gebruik je wachtwoordzin"); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, Bytes.fromBase64(iv)));
            Ask q = new Ask("Beheerkluis ontgrendelen");
            q.negative = "Wachtwoordzin gebruiken";
            onUi(a, q, cipher, new Answer() {
                @Override public void ok() {
                    try { done.ok(cipher.doFinal(Bytes.fromBase64(data))); } catch (GeneralSecurityException | RuntimeException e) { done.fail("Ontgrendelen mislukt; gebruik je wachtwoordzin"); }
                }

                @Override public void fail(String message, boolean cancelled) { done.fail(cancelled ? "Gebruik je wachtwoordzin" : message); }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            forget(a);
            done.fail("Er is een vingerafdruk bijgekomen. Ontgrendel één keer met je wachtwoordzin.");
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            done.fail("Ontgrendelen mislukt: " + e.getMessage());
        }
    }

    // ───────── De vraag om je vingerafdruk ─────────

    private static void onUi(Activity a, Ask q, Object crypto, Answer cb) {
        if (Build.VERSION.SDK_INT < 28) { cb.fail("Met je vingerafdruk kan vanaf Android 9", false); return; }
        a.runOnUiThread(() -> {
            if (a.isFinishing() || a.isDestroyed()) { cb.fail("De app is gesloten", true); return; }
            try { ask(a, q, crypto, cb); } catch (RuntimeException e) { cb.fail("De vraag om je vingerafdruk lukte niet: " + e.getMessage(), false); }
        });
    }

    /**
     * Toont de vraag om je vingerafdruk (op de UI-thread). Met {@code crypto} (Cipher of Signature) is die sleutel daarna
     * te gebruiken; zonder is het alleen een bevestiging dat jij het bent. Vanaf Android 11 kan de pincode van de
     * telefoon het alternatief zijn ({@link Ask#pin}); anders is er een knop met {@link Ask#negative}.
     */
    @TargetApi(28)
    @SuppressWarnings("deprecation")
    static CancellationSignal ask(Activity a, Ask q, Object crypto, Answer cb) {
        BiometricPrompt.Builder b = new BiometricPrompt.Builder(a).setTitle(q.title);
        if (q.subtitle != null) b.setSubtitle(q.subtitle);
        boolean[] done = {false};
        Answer once = new Answer() {
            @Override public void ok() { if (!done[0]) { done[0] = true; cb.ok(); } }

            @Override public void fail(String message, boolean cancelled) { if (!done[0]) { done[0] = true; cb.fail(message, cancelled); } }
        };
        if (Build.VERSION.SDK_INT >= 30) {
            if (q.pin || q.pinOnly) {
                b.setAllowedAuthenticators(q.pinOnly ? BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        : BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
                b.setNegativeButton(q.negative, a.getMainExecutor(), (d, w) -> once.fail(q.negative, true));
            }
        } else if (Build.VERSION.SDK_INT >= 29 && crypto == null && q.pin) {
            b.setDeviceCredentialAllowed(true);
        } else {
            b.setNegativeButton(q.negative, a.getMainExecutor(), (d, w) -> once.fail(q.negative, true));
        }
        BiometricPrompt p = b.build();
        CancellationSignal cancel = new CancellationSignal();
        BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { once.ok(); }

            @Override public void onAuthenticationError(int code, CharSequence msg) { once.fail(errorText(code, msg, q.pin), cancelledCode(code)); }
        };
        if (crypto instanceof Cipher) p.authenticate(new BiometricPrompt.CryptoObject((Cipher) crypto), cancel, a.getMainExecutor(), callback);
        else if (crypto instanceof Signature) p.authenticate(new BiometricPrompt.CryptoObject((Signature) crypto), cancel, a.getMainExecutor(), callback);
        else p.authenticate(cancel, a.getMainExecutor(), callback);
        return cancel;
    }

    private static boolean cancelledCode(int code) {
        return code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT;
    }

    /** Fouten van de vraag in gewone taal. */
    static String errorText(int code, CharSequence msg, boolean pin) {
        switch (code) {
            case BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED:
            case BiometricPrompt.BIOMETRIC_ERROR_CANCELED:
            case BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT:
                return "Geannuleerd";
            case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT:
                return "Te vaak geprobeerd. Wacht even" + (pin ? ", of gebruik de pincode van je telefoon." : " en probeer het opnieuw.");
            case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT:
                return "Te vaak geprobeerd. Ontgrendel je telefoon één keer met je pincode en probeer het daarna opnieuw.";
            case BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS:
                return "Er staat geen vingerafdruk op deze telefoon. Stel er een in bij de instellingen van Android.";
            case BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT:
            case BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "De vingerafdruklezer werkt nu niet. Probeer het later opnieuw.";
            default:
                return msg == null ? "Dat lukte niet" : msg.toString();
        }
    }

    // ───────── Kluis achter je vingerafdruk: de sleutel voor de Java-kern ─────────

    static final PhoneLock LOCK = new PhoneLock();

    /**
     * {@link DeviceLock} met een AES-256-GCM-sleutel in de Android Keystore: alleen te gebruiken na je vingerafdruk
     * (elke keer opnieuw), vanaf Android 11 ook na de pincode van de telefoon, alleen als de telefoon ontgrendeld is, en
     * ongeldig als er een vingerafdruk bijkomt. De vragen verschijnen boven de activity die als laatste {@link #attach}
     * deed; de aanroepen wachten op het antwoord (dus nooit op de UI-thread).
     */
    static final class PhoneLock implements DeviceLock {
        private volatile WeakReference<Activity> front = new WeakReference<>(null);
        private volatile Context app;

        /** Zonder activity: alleen voor {@link #status()} (vragen kan pas na {@link #attach}). */
        void init(Context c) {
            if (app == null) app = c.getApplicationContext();
        }

        void attach(Activity a) {
            app = a.getApplicationContext();
            front = new WeakReference<>(a);
        }

        void detach(Activity a) {
            if (front.get() == a) front = new WeakReference<>(null);
        }

        private Activity activity() throws Unavailable {
            Activity a = front.get();
            if (a == null || a.isFinishing()) throw new Unavailable("Open de app om je vingerafdruk te geven");
            if (Looper.myLooper() == Looper.getMainLooper()) throw new IllegalStateException("Niet op de UI-thread wachten");
            return a;
        }

        @Override public Map<String, Object> status() {
            Context c = app;
            return c == null ? Json.obj("available", false, "biometric", false, "pin", false, "reason", "hardware") : Biometrics.status(c);
        }

        @Override public boolean invalidated(Map<String, Object> wrapped) {
            if (Build.VERSION.SDK_INT < 28) return false;
            try {
                return decryptCipher(wrapped) == null;
            } catch (KeyPermanentlyInvalidatedException e) {
                return true;
            } catch (GeneralSecurityException | IOException | RuntimeException e) {
                return false;
            }
        }

        private static Cipher decryptCipher(Map<String, Object> w) throws GeneralSecurityException, IOException {
            String alias = Json.str(w, "alias"), iv = Json.str(w, "iv");
            if (alias == null || iv == null || !alias.startsWith(DEVICE_PREFIX)) return null;
            KeyStore ks = keyStore();
            if (!ks.containsAlias(alias)) return null;
            SecretKey k = (SecretKey) ks.getKey(alias, null);
            if (k == null) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, Bytes.fromBase64(iv)));
            return c;
        }

        @TargetApi(28)
        private static SecretKey newKey(String alias, boolean pin) throws GeneralSecurityException {
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(true)
                    .setInvalidatedByBiometricEnrollment(true)
                    .setUnlockedDeviceRequired(true);
            if (Build.VERSION.SDK_INT >= 30) {
                spec.setUserAuthenticationParameters(0, pin ? KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL : KeyProperties.AUTH_BIOMETRIC_STRONG);
            }
            g.init(spec.build());
            return g.generateKey();
        }

        /** Wacht op het antwoord van de vraag (hooguit drie minuten). */
        private static void await(Activity a, Ask q, Object crypto) throws IOException {
            CountDownLatch latch = new CountDownLatch(1);
            String[] error = {null};
            boolean[] cancelled = {false};
            CancellationSignal[] signal = {null};
            if (Build.VERSION.SDK_INT < 28) throw new Unavailable("Met je vingerafdruk kan vanaf Android 9");
            a.runOnUiThread(() -> {
                if (a.isFinishing() || a.isDestroyed()) { error[0] = "De app is gesloten"; cancelled[0] = true; latch.countDown(); return; }
                try {
                    signal[0] = ask(a, q, crypto, new Answer() {
                        @Override public void ok() { latch.countDown(); }

                        @Override public void fail(String message, boolean c) { error[0] = message; cancelled[0] = c; latch.countDown(); }
                    });
                } catch (RuntimeException e) {
                    error[0] = "De vraag om je vingerafdruk lukte niet: " + e.getMessage();
                    latch.countDown();
                }
            });
            try {
                if (!latch.await(3, TimeUnit.MINUTES)) {
                    a.runOnUiThread(() -> { if (signal[0] != null) signal[0].cancel(); });
                    throw new Cancelled("Geannuleerd");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new Cancelled("Geannuleerd");
            }
            if (error[0] != null) throw cancelled[0] ? new Cancelled(error[0]) : new IOException(error[0]);
        }

        @Override public Map<String, Object> wrap(byte[] key) throws IOException {
            Activity a = activity();
            if (Build.VERSION.SDK_INT < 28) throw new Unavailable("Met je vingerafdruk kan vanaf Android 9");
            Map<String, Object> st = Biometrics.status(a);
            if (!Boolean.TRUE.equals(st.get("available"))) throw new Unavailable("Stel eerst een vingerafdruk in op deze telefoon, of kies een wachtwoordzin");
            boolean pin = pinAllowed(a);
            String alias = DEVICE_PREFIX + Bytes.hex(Bytes.random(6));
            Cipher c;
            try {
                newKey(alias, pin);
                c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, (SecretKey) keyStore().getKey(alias, null));
            } catch (GeneralSecurityException | IOException | RuntimeException e) {
                delete(alias);
                // Zonder vingerafdruk weigert de Keystore een sleutel die er een vereist.
                throw new Unavailable("Stel eerst een vingerafdruk in op deze telefoon, of kies een wachtwoordzin");
            }
            Ask q = new Ask("Kluis beveiligen");
            q.subtitle = "Bevestig met je vingerafdruk. Daarna is er geen wachtwoordzin nodig.";
            q.pin = pin;
            try {
                await(a, q, c);
                byte[] ct = c.doFinal(key);
                return Json.obj("alias", alias, "iv", Bytes.base64(c.getIV()), "key", Bytes.base64(ct), "pin", pin);
            } catch (GeneralSecurityException | RuntimeException e) {
                delete(alias);
                throw new IOException("Beveiligen lukte niet: " + e.getMessage());
            } catch (IOException e) {
                delete(alias);
                throw e;
            }
        }

        @Override public byte[] unwrap(Map<String, Object> wrapped, String via) throws IOException {
            Activity a = activity();
            Cipher c;
            try {
                c = decryptCipher(wrapped);
            } catch (KeyPermanentlyInvalidatedException e) {
                throw new Invalidated("Er is een vingerafdruk bijgekomen of je schermvergrendeling is veranderd. Daardoor werkt de sleutel van je kluis niet meer.");
            } catch (GeneralSecurityException | RuntimeException e) {
                throw new IOException("Ontgrendelen lukte niet: " + e.getMessage());
            }
            if (c == null) throw new Invalidated("De sleutel van je kluis staat niet meer op deze telefoon.");
            boolean pin = Boolean.TRUE.equals(wrapped.get("pin")) && pinAllowed(a);
            Ask q = new Ask("Beheerkluis ontgrendelen");
            q.pin = pin;
            q.pinOnly = pin && "pin".equals(via);
            await(a, q, c);
            try {
                return c.doFinal(Bytes.fromBase64(Json.str(wrapped, "key")));
            } catch (GeneralSecurityException | RuntimeException e) {
                // Wel bevestigd, maar de sleutel weigert: hij hoort niet meer bij je huidige vingerafdrukken.
                throw new Invalidated("Je vingerafdrukken zijn veranderd. Daardoor werkt de sleutel van je kluis niet meer met je vingerafdruk.");
            }
        }

        @Override public void confirm(String title) throws IOException {
            Activity a = activity();
            Ask q = new Ask(title);
            q.subtitle = "Bevestig dat jij het bent";
            q.pin = pinAllowed(a) || (Build.VERSION.SDK_INT == 29 && secure(a));
            await(a, q, null);
        }

        @Override public void release(Map<String, Object> wrapped) {
            String alias = Json.str(wrapped, "alias");
            if (alias != null && alias.startsWith(DEVICE_PREFIX)) delete(alias);
        }
    }
}
