package nl.eigencloud.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

/** Meldingen, zonder Google-diensten: de app haalt zelf op (zie {@link SyncJob}). */
final class Notify {
    private Notify() {}

    static final String MAIL = "mail", STATUS = "status", BACKUP = "backup", UPDATE = "update";
    static final int ID_MAIL = 10, ID_STATUS = 11, ID_BACKUP = 12, ID_UPDATE = 13, ID_SHARE = 14;

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(MAIL, "Nieuwe mail", NotificationManager.IMPORTANCE_DEFAULT));
        nm.createNotificationChannel(new NotificationChannel(STATUS, "Gezondheid van je cloud", NotificationManager.IMPORTANCE_DEFAULT));
        NotificationChannel b = new NotificationChannel(BACKUP, "Foto-back-up", NotificationManager.IMPORTANCE_LOW);
        b.setShowBadge(false);
        nm.createNotificationChannel(b);
        nm.createNotificationChannel(new NotificationChannel(UPDATE, "Nieuwe versie van de app", NotificationManager.IMPORTANCE_LOW));
    }

    static boolean allowed(Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    /** Opent de cloud in de app op een bepaald onderdeel, bijvoorbeeld "#mail". */
    static PendingIntent openApp(Context c, String hash, int request) {
        Intent i = new Intent(c, MainActivity.class).putExtra(MainActivity.EXTRA_HASH, hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, request, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent openUrl(Context c, String url, int request) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, request, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification.Builder builder(Context c, String channel) {
        return new Notification.Builder(c, channel).setSmallIcon(R.drawable.ic_notify).setColor(0xff3f6f4a);
    }

    static void show(Context c, int id, Notification n) {
        if (!allowed(c)) return;
        c.getSystemService(NotificationManager.class).notify(id, n);
    }

    static void cancel(Context c, int id) { c.getSystemService(NotificationManager.class).cancel(id); }
}
