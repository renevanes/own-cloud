package nl.eigencloud.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.net.ConnectivityManager;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.IOException;

/**
 * Bijwerken terwijl de app open is, zoals de andere apps van Rene: bij openen kijken (hooguit eens per half uur),
 * en een nieuwe versie meteen installeren (via wifi, als Android dat toestaat) of aanbieden met één knop.
 * Werkt ook als er nog geen cloud is (tijdens het opzetten): de app zelf komt van ghcr.io.
 */
final class UpdateCheck {
    private UpdateCheck() {}

    private static final long EVERY = 30 * 60_000L;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** Er staat een activiteit van de app op het scherm (dan mag de installatie meteen om bevestiging vragen). */
    static volatile java.lang.ref.WeakReference<Activity> visible = new java.lang.ref.WeakReference<>(null);
    private static volatile boolean busy;

    static void resumed(Activity a) {
        visible = new java.lang.ref.WeakReference<>(a);
        // Terug uit "apps installeren toestaan" na een tik op Bijwerken: nu installeren.
        if (Prefs.str(a, "update.pendingInstall") != null && Updater.canInstall(a)) {
            Prefs.setStr(a, "update.pendingInstall", null);
            installNow(a, false);
            return;
        }
        if (!Prefs.flag(a, Prefs.UPDATES) || busy) return;
        if (System.currentTimeMillis() - Prefs.num(a, "update.checked") < EVERY) {
            String v = Prefs.str(a, "update.version");
            if (v != null && Prefs.str(a, "update.installing") == null) offer(a, v);
            return;
        }
        busy = true;
        new Thread(() -> {
            try {
                Updater.Release r = Updater.check(a);
                if (r == null) return;
                boolean metered = a.getSystemService(ConnectivityManager.class).isActiveNetworkMetered();
                if (Prefs.flag(a, Prefs.AUTO_INSTALL) && Updater.canInstall(a) && !metered) {
                    MAIN.post(() -> Toast.makeText(a, "Eigen Cloud wordt bijgewerkt naar versie " + r.version, Toast.LENGTH_LONG).show());
                    Updater.install(a, r);
                } else {
                    MAIN.post(() -> offer(a, r.version));
                }
            } catch (IOException | RuntimeException e) {
                Prefs.setStr(a, "update.error", e.getMessage());
            } finally {
                busy = false;
            }
        }, "update-check").start();
    }

    static void paused(Activity a) {
        if (visible.get() == a) visible.clear();
    }

    /** Dialoog met wat er nieuw is en een knop Bijwerken; "Later" vraagt het pas de volgende dag weer. */
    private static void offer(Activity a, String version) {
        if (a.isFinishing() || visible.get() != a) return;
        String later = Prefs.str(a, "update.later");
        if (later != null && later.startsWith(version + "@") && System.currentTimeMillis() - Long.parseLong(later.substring(version.length() + 1)) < 20 * 3_600_000L) return;
        String notes = Prefs.str(a, "update.notes");
        StringBuilder msg = new StringBuilder();
        if (notes != null) for (String line : notes.split("\n")) msg.append("• ").append(line).append('\n');
        if (!Updater.canInstall(a)) msg.append(msg.length() > 0 ? "\n" : "").append("Android vraagt één keer of Eigen Cloud updates mag installeren. Zet dat aan en kom terug; daarna gaat bijwerken vanzelf.");
        new AlertDialog.Builder(a, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
                .setTitle("Nieuwe versie: " + version)
                .setMessage(msg.length() == 0 ? "Er is een nieuwe versie van Eigen Cloud." : msg.toString().trim())
                .setPositiveButton("Bijwerken", (d, w) -> installNow(a, true))
                .setNegativeButton("Later", (d, w) -> Prefs.setStr(a, "update.later", version + "@" + System.currentTimeMillis()))
                .show();
    }

    private static void installNow(Activity a, boolean askPermission) {
        if (!Updater.canInstall(a)) {
            if (!askPermission) return;
            Prefs.setStr(a, "update.pendingInstall", "1");
            a.startActivity(Updater.installPermissionIntent(a));
            return;
        }
        Toast.makeText(a, "Nieuwe versie wordt gedownload…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                Updater.Release r = Updater.check(a);
                if (r == null) { MAIN.post(() -> Toast.makeText(a, "Je hebt de nieuwste versie.", Toast.LENGTH_SHORT).show()); return; }
                Updater.install(a, r);
            } catch (IOException | RuntimeException e) {
                Prefs.setStr(a, "update.error", e.getMessage());
                MAIN.post(() -> Toast.makeText(a, "Bijwerken lukte niet: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "update-install").start();
    }
}
