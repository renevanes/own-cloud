package nl.eigencloud.app;

import android.annotation.TargetApi;
import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.webkit.CookieManager;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.cert.Certificate;
import java.util.Map;

import javax.crypto.Cipher;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Http;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.LoginBox;

/**
 * Inloggen bij je cloud zonder te typen.
 *
 * <ul>
 * <li>Met de cloud die de console op deze telefoon opzette: de app logt zelf in met het wachtwoord uit de kluis
 *     ({@link #login}), direct na het starten.</li>
 * <li>Daarna, en na de eerste keer "Verbinden" met je wachtwoord: het wachtwoord staat in een {@link LoginBox} achter je
 *     vingerafdruk ({@link #remember}, {@link #unlock}). Verloopt de sessie (na 30 dagen) of log je uit, dan is opnieuw
 *     inloggen één tik met je vingerafdruk.</li>
 * </ul>
 * Inloggen gebeurt zoals in de browser: {@code POST /api/login} geeft een sessie (zie src/auth.ts, met een eigen regel in
 * Apparaten en sessies: "Eigen Cloud-app op …"). Het token komt in de cookie van de app; de achtergrondtaken gebruiken het
 * ({@link CloudApi#sessionToken}). Een gewijzigd wachtwoord maakt de bewaarde inlog ongeldig: dan één keer typen.
 */
final class CloudLogin {
    private CloudLogin() {}

    private static final String ALIAS = "eigen-cloud-inlog";
    private static final String PREF = "login.box";
    private static final long SESSION_SECONDS = 30L * 86400;

    /** Inloggen lukte niet. {@code mfa}: de code uit je authenticator-app is nodig; {@code wrong}: wachtwoord klopt niet. */
    static final class Failed extends IOException {
        private static final long serialVersionUID = 1L;
        final boolean mfa, wrong;

        Failed(String message, boolean mfa, boolean wrong) {
            super(message);
            this.mfa = mfa;
            this.wrong = wrong;
        }
    }

    interface Unlocked {
        void ok(String user, String password);

        /** {@code invalid}: de bewaarde inlog is weg of werkt niet meer (dan één keer typen). */
        void fail(String message, boolean cancelled, boolean invalid);
    }

    /** Naam van deze telefoon in Apparaten en sessies van je cloud. */
    static String label() { return "Eigen Cloud-app op " + Build.MANUFACTURER + " " + Build.MODEL; }

    /** Inloggen bij {@code base}; bij succes staat de sessie in de cookie van de app. Blokkeert: niet op de UI-thread. */
    static void login(String base, String user, String password, String code) throws IOException {
        Map<String, Object> body = Json.obj("password", password == null ? "" : password);
        if (user != null && !user.trim().isEmpty()) body.put("user", user.trim());
        if (code != null && !code.trim().isEmpty()) body.put("code", code.trim());
        Http.Response r;
        try {
            r = Http.request("POST", base + "/api/login", Http.headers("content-type", "application/json", "accept", "application/json", "user-agent", label()),
                    Bytes.utf8(Json.stringify(body)), 20_000);
        } catch (IOException e) {
            throw new IOException("Geen verbinding met " + Uri.parse(base).getHost() + ". Heb je internet?");
        }
        Object j;
        try { j = Json.parse(r.text()); } catch (RuntimeException e) { j = null; }
        if (r.ok()) {
            String token = Json.str(j, "token");
            if (token == null || token.isEmpty()) throw new IOException("Inloggen lukte niet");
            setSession(base, token);
            return;
        }
        boolean mfa = Json.truthy(Json.path(j, "mfaRequired"));
        String error = Json.str(j, "error");
        throw new Failed(error != null ? error : "Inloggen lukte niet (" + r.status + ")", mfa, r.status == 401 && !mfa);
    }

    /** Het sessie-token als cookie, zoals de cloud het zelf zet (30 dagen, alleen voor de cloud, niet voor scripts). */
    static void setSession(String base, String token) {
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setCookie(base, "session=" + token + "; Path=/; Max-Age=" + SESSION_SECONDS + "; HttpOnly; SameSite=Strict" + (base.startsWith("https://") ? "; Secure" : ""));
        cm.flush();
    }

    // ───────── Bewaren achter je vingerafdruk ─────────

    /** Kan deze telefoon een inlog achter de vingerafdruk bewaren? */
    static boolean available(Context c) { return Build.VERSION.SDK_INT >= 28 && Boolean.TRUE.equals(Biometrics.status(c).get("available")); }

    private static Map<String, Object> box(Context c) {
        String s = Prefs.str(c, PREF);
        if (s == null) return null;
        try { return Json.parseObject(s); } catch (RuntimeException e) { return null; }
    }

    /** Is er een inlog voor deze cloud bewaard? */
    static boolean has(Context c, String base) {
        Map<String, Object> b = box(c);
        return b != null && base != null && base.equals(Json.str(b, "url"));
    }

    static void forget(Context c) {
        Prefs.setStr(c, PREF, null);
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(ALIAS);
        } catch (GeneralSecurityException | IOException | RuntimeException ignored) {
            // er was geen sleutel
        }
    }

    /**
     * Bewaart de inlog voor {@code base} achter je vingerafdruk. Vraagt nu niets (alleen de publieke sleutel is nodig);
     * openen vraagt wel om je vingerafdruk. Doet niets als de telefoon geen vingerafdruk heeft.
     */
    static boolean remember(Context c, String base, String user, String password) {
        if (Build.VERSION.SDK_INT < 28 || !available(c)) return false;
        try {
            boolean pin = Biometrics.pinAllowed(c);
            Map<String, Object> b = LoginBox.seal(publicKey(pin), base, user, password);
            b.put("pin", pin);
            Prefs.setStr(c, PREF, Json.stringify(b));
            return true;
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            forget(c);
            return false;
        }
    }

    /** RSA-sleutelpaar in de Keystore: versleutelen kan altijd, ontsleutelen alleen na je vingerafdruk (of pincode, Android 11+). */
    @TargetApi(28)
    private static PublicKey publicKey(boolean pin) throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS); // elke keer een nieuw paar: past bij de huidige vingerafdrukken
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(2048)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, pin ? KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL : KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        g.initialize(spec.build());
        g.generateKeyPair();
        Certificate cert = ks.getCertificate(ALIAS);
        if (cert == null) throw new GeneralSecurityException("Geen sleutel");
        return cert.getPublicKey();
    }

    /** Vraagt om je vingerafdruk en geeft de bewaarde inlog voor {@code base} (antwoord op de UI-thread). */
    static void unlock(Activity a, String base, Unlocked cb) {
        Map<String, Object> b = box(a);
        if (b == null || !base.equals(Json.str(b, "url"))) { cb.fail("Er is nog geen inlog bewaard", false, true); return; }
        if (Build.VERSION.SDK_INT < 28) { cb.fail("Met je vingerafdruk kan vanaf Android 9", false, true); return; }
        Cipher cipher;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            PrivateKey k = (PrivateKey) ks.getKey(ALIAS, null);
            if (k == null) { forget(a); cb.fail("Log één keer in met je wachtwoord.", false, true); return; }
            cipher = LoginBox.decryptCipher(k);
        } catch (KeyPermanentlyInvalidatedException e) {
            forget(a);
            cb.fail("Je vingerafdrukken zijn veranderd. Log één keer in met je wachtwoord; daarna werkt je vingerafdruk weer.", false, true);
            return;
        } catch (GeneralSecurityException | IOException | RuntimeException e) {
            cb.fail("Inloggen met je vingerafdruk lukte niet: " + e.getMessage(), false, false);
            return;
        }
        Biometrics.Ask q = new Biometrics.Ask("Inloggen bij " + Uri.parse(base).getHost());
        q.subtitle = "Bevestig met je vingerafdruk";
        q.negative = "Wachtwoord intypen";
        q.pin = Boolean.TRUE.equals(b.get("pin")) && Biometrics.pinAllowed(a);
        a.runOnUiThread(() -> {
            if (a.isFinishing() || a.isDestroyed()) { cb.fail("Geannuleerd", true, false); return; }
            try {
                Biometrics.ask(a, q, cipher, new Biometrics.Answer() {
                    @Override public void ok() {
                        try {
                            String[] up = LoginBox.open(cipher, b);
                            cb.ok(up[0], up[1]);
                        } catch (GeneralSecurityException | RuntimeException e) {
                            forget(a);
                            cb.fail("Je vingerafdrukken zijn veranderd. Log één keer in met je wachtwoord; daarna werkt je vingerafdruk weer.", false, true);
                        }
                    }

                    @Override public void fail(String message, boolean cancelled) { cb.fail(message, cancelled, false); }
                });
            } catch (RuntimeException e) {
                cb.fail("Inloggen met je vingerafdruk lukte niet: " + e.getMessage(), false, false);
            }
        });
    }
}
