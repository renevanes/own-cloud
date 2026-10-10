package nl.eigencloud.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Uitkomst van een update-installatie: gelukt, of Android wil eerst een tik van jou. */
public final class InstallReceiver extends BroadcastReceiver {
    static final String EXTRA_VERSION = "version";

    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String version = intent.getStringExtra(EXTRA_VERSION);
        Prefs.setStr(c, "update.installing", null);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Eerste keer (of Android ouder dan 12): Android vraagt toestemming. Vanuit de achtergrond mag de app geen
            // scherm openen, dus een melding waarop je tikt.
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // Staat de app open (je tikte net op Bijwerken)? Dan meteen de vraag van Android tonen.
            android.app.Activity open = UpdateCheck.visible;
            if (open != null && !open.isFinishing()) {
                try { open.startActivity(confirm); return; } catch (RuntimeException ignored) { /* dan via een melding */ }
            }
            PendingIntent pi = PendingIntent.getActivity(c, 5, confirm, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = Notify.builder(c, Notify.UPDATE).setContentTitle("Versie " + version + " is klaar").setContentText("Tik om bij te werken")
                    .setContentIntent(pi).setAutoCancel(true).build();
            Notify.show(c, Notify.ID_UPDATE, n);
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            Prefs.setStr(c, "update.version", null);
            Prefs.setStr(c, "update.error", null);
        } else {
            Prefs.setStr(c, "update.error", "Installeren mislukt: " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }
}
