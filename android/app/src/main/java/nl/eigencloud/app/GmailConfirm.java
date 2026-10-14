package nl.eigencloud.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

/**
 * "Ben jij het?" voordat de Gmail-instellingen te zien of te wijzigen zijn: vingerafdruk (of gezicht), met de
 * pincode/het patroon van de telefoon als alternatief. Zonder schermvergrendeling is er niets om te controleren.
 * Android 8 en 9: het scherm van de telefoon voor de pincode (daar zit vaak ook de vingerafdruk op).
 */
final class GmailConfirm {
    private GmailConfirm() {}

    static final int REQUEST = 7230;

    interface Done {
        void result(boolean ok, String message);
    }

    /** Starts the check; for Android 8–9 the activity passes its {@code onActivityResult} to {@link #activityResult}. */
    static void ask(Activity a, String title, Done done) {
        KeyguardManager km = a.getSystemService(KeyguardManager.class);
        if (km == null || !km.isDeviceSecure()) { done.result(true, null); return; }
        if (Build.VERSION.SDK_INT >= 29) {
            Prompt.show(a, title, done);
            return;
        }
        Intent i = km.createConfirmDeviceCredentialIntent(title, "Bevestig dat jij het bent");
        if (i == null) { done.result(true, null); return; }
        pending = done;
        a.startActivityForResult(i, REQUEST);
    }

    /** BiometricPrompt with the phone's PIN as alternative (Android 10+). */
    @android.annotation.TargetApi(29)
    private static final class Prompt {
        static void show(Activity a, String title, Done done) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(a).setTitle(title).setSubtitle("Met je vingerafdruk of de pincode van je telefoon");
            if (Build.VERSION.SDK_INT >= 30) {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                b.setDeviceCredentialAllowed(true);
            }
            b.build().authenticate(new CancellationSignal(), a.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { done.result(true, null); }

                @Override public void onAuthenticationError(int code, CharSequence msg) { done.result(false, String.valueOf(msg)); }
            });
        }
    }

    private static Done pending;

    static boolean activityResult(int request, int result) {
        if (request != REQUEST || pending == null) return false;
        Done d = pending;
        pending = null;
        d.result(result == Activity.RESULT_OK, result == Activity.RESULT_OK ? null : "Niet bevestigd");
        return true;
    }
}
