package nl.eigencloud.app;

import android.app.Notification;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.Map;

import nl.eigencloud.core.Json;

/**
 * Automatische back-up van foto's en video's naar je eigen cloud. Houdt per soort bij tot waar hij is
 * (toegevoegd-tijd + id), zodat er nooit iets dubbel hoeft; de cloud herkent dubbele bestanden bovendien zelf.
 */
final class PhotoBackup {
    private PhotoBackup() {}

    interface Cancel { boolean cancelled(); }

    static final class Result {
        int uploaded, duplicates, failed;
        String stopped;
    }

    private static final String[] COLS = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED, "datetaken"};

    static boolean permitted(Context c) {
        if (Build.VERSION.SDK_INT >= 33) return c.checkSelfPermission("android.permission.READ_MEDIA_IMAGES") == PackageManager.PERMISSION_GRANTED;
        return c.checkSelfPermission("android.permission.READ_EXTERNAL_STORAGE") == PackageManager.PERMISSION_GRANTED;
    }

    /** Waarom er nu geen back-up gemaakt wordt (null = mag). */
    static String blocker(Context c) {
        if (!Prefs.flag(c, Prefs.BACKUP_PHOTOS)) return "uit";
        if (!permitted(c)) return "Geef de app toegang tot je foto's";
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm.getActiveNetwork() == null) return "Geen internet";
        if (Prefs.flag(c, Prefs.BACKUP_WIFI_ONLY) && cm.isActiveNetworkMetered()) return "Wacht op wifi";
        if (Prefs.flag(c, Prefs.BACKUP_CHARGING_ONLY) && !c.getSystemService(BatteryManager.class).isCharging()) return "Wacht tot de telefoon oplaadt";
        return null;
    }

    /** "Vanaf nu": alles wat al op de telefoon staat overslaan. */
    static void startFromNow(Context c) {
        long now = System.currentTimeMillis() / 1000;
        for (String kind : new String[]{"images", "video"}) {
            Prefs.setNum(c, "mark." + kind + ".added", now);
            Prefs.setNum(c, "mark." + kind + ".id", Long.MAX_VALUE);
        }
    }

    static Uri collection(String kind) {
        return kind.equals("video") ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    }

    private static Cursor query(ContentResolver cr, String kind, long added, long id) {
        String sel = MediaStore.MediaColumns.DATE_ADDED + " > ? OR (" + MediaStore.MediaColumns.DATE_ADDED + " = ? AND " + MediaStore.MediaColumns._ID + " > ?)";
        String[] args = {String.valueOf(added), String.valueOf(added), String.valueOf(id == Long.MAX_VALUE ? Long.MAX_VALUE : id)};
        return cr.query(collection(kind), COLS, sel, args, MediaStore.MediaColumns.DATE_ADDED + " ASC, " + MediaStore.MediaColumns._ID + " ASC");
    }

    /** Aantal nog niet geback-upte foto's en video's. */
    static int pending(Context c) {
        if (!permitted(c)) return -1;
        int n = 0;
        for (String kind : kinds(c)) {
            try (Cursor cur = query(c.getContentResolver(), kind, Prefs.num(c, "mark." + kind + ".added"), Prefs.num(c, "mark." + kind + ".id"))) {
                if (cur != null) n += cur.getCount();
            } catch (RuntimeException e) {
                // geen toegang
            }
        }
        return n;
    }

    private static String[] kinds(Context c) {
        return Prefs.flag(c, Prefs.BACKUP_VIDEOS) ? new String[]{"images", "video"} : new String[]{"images"};
    }

    static Result run(Context c, CloudApi api, Cancel cancel) {
        Result res = new Result();
        String why = blocker(c);
        if (why != null) { res.stopped = why; return res; }
        int total = pending(c);
        if (total <= 0) return res;
        long deadline = System.currentTimeMillis() + 8 * 60_000; // JobScheduler geeft ongeveer 10 minuten
        int done = 0;
        boolean original = Build.VERSION.SDK_INT >= 29 && c.checkSelfPermission("android.permission.ACCESS_MEDIA_LOCATION") == PackageManager.PERMISSION_GRANTED;
        ContentResolver cr = c.getContentResolver();
        try {
            for (String kind : kinds(c)) {
                String markAdded = "mark." + kind + ".added", markId = "mark." + kind + ".id";
                try (Cursor cur = query(cr, kind, Prefs.num(c, markAdded), Prefs.num(c, markId))) {
                    if (cur == null) continue;
                    while (cur.moveToNext()) {
                        if (cancel.cancelled() || System.currentTimeMillis() > deadline) { res.stopped = "later verder"; return res; }
                        if (blocker(c) != null) { res.stopped = blocker(c); return res; }
                        long id = cur.getLong(0);
                        String name = cur.getString(1);
                        String mime = cur.getString(2);
                        long added = cur.getLong(3);
                        long size = cur.isNull(4) ? -1 : cur.getLong(4);
                        long taken = cur.isNull(6) ? 0 : cur.getLong(6);
                        long modified = cur.isNull(5) ? 0 : cur.getLong(5) * 1000;
                        progress(c, done, total, name);
                        Uri uri = ContentUris.withAppendedId(collection(kind), id);
                        if (original && Build.VERSION.SDK_INT >= 29) uri = MediaStore.setRequireOriginal(uri); // behoudt de plaats (GPS) in de foto
                        try (InputStream in = cr.openInputStream(uri)) {
                            if (in == null) throw new IOException("niet leesbaar");
                            Map<String, Object> r = api.upload(fileName(name, mime, id), mime, taken > 0 ? taken : modified > 0 ? modified : added * 1000, in, size);
                            if (Json.truthy(r.get("duplicate"))) res.duplicates++;
                            else if (r.get("error") != null) res.failed++;
                            else res.uploaded++;
                        } catch (CloudApi.NotLoggedIn e) {
                            res.stopped = "Log opnieuw in in de app";
                            return res;
                        } catch (IOException e) {
                            // Netwerkfout: hier stoppen en later opnieuw, zodat er niets wordt overgeslagen.
                            if (isNetwork(e)) { res.stopped = "verbinding weg"; return res; }
                            res.failed++;
                        } catch (SecurityException e) {
                            res.failed++;
                        }
                        Prefs.setNum(c, markAdded, added);
                        Prefs.setNum(c, markId, id);
                        done++;
                    }
                }
            }
        } finally {
            Notify.cancel(c, Notify.ID_BACKUP);
            if (res.uploaded > 0) Prefs.setNum(c, "backup.last", System.currentTimeMillis());
            Prefs.setNum(c, "backup.lastCount", res.uploaded);
        }
        return res;
    }

    private static boolean isNetwork(IOException e) {
        String m = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
        return e instanceof java.net.SocketException || e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException
                || e instanceof javax.net.ssl.SSLException || m.contains("uploaden mislukt (5");
    }

    static String fileName(String name, String mime, long id) {
        String n = name == null || name.isEmpty() ? "media-" + id : name;
        if (!n.contains(".") && mime != null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext != null) n += "." + ext;
        }
        return n;
    }

    private static void progress(Context c, int done, int total, String name) {
        Notification n = Notify.builder(c, Notify.BACKUP)
                .setContentTitle("Back-up naar je eigen cloud")
                .setContentText((done + 1) + " van " + total + (name != null ? " · " + name : ""))
                .setProgress(total, done, false)
                .setOngoing(true).setOnlyAlertOnce(true)
                .build();
        Notify.show(c, Notify.ID_BACKUP, n);
    }
}
