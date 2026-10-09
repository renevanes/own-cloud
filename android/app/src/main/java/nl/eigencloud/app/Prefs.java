package nl.eigencloud.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Instellingen van de app (alleen op deze telefoon; Google-back-up van app-gegevens staat uit). */
final class Prefs {
    private Prefs() {}

    static final String CLOUD_URL = "cloudUrl";
    static final String BACKUP_PHOTOS = "backupPhotos";
    static final String BACKUP_VIDEOS = "backupVideos";
    static final String BACKUP_WIFI_ONLY = "backupWifiOnly";
    static final String BACKUP_CHARGING_ONLY = "backupChargingOnly";
    static final String CALENDAR = "calendar";
    static final String NOTIFY_MAIL = "notifyMail";
    static final String NOTIFY_HEALTH = "notifyHealth";
    static final String UPDATES = "updates";

    static SharedPreferences get(Context c) { return c.getApplicationContext().getSharedPreferences("eigen", Context.MODE_PRIVATE); }

    static String cloudUrl(Context c) { return get(c).getString(CLOUD_URL, null); }

    static boolean flag(Context c, String key) {
        boolean def = key.equals(BACKUP_WIFI_ONLY) || key.equals(NOTIFY_MAIL) || key.equals(NOTIFY_HEALTH) || key.equals(UPDATES) || key.equals(BACKUP_VIDEOS);
        return get(c).getBoolean(key, def);
    }

    static void setFlag(Context c, String key, boolean v) { get(c).edit().putBoolean(key, v).apply(); }

    static long num(Context c, String key) { return get(c).getLong(key, 0); }

    static void setNum(Context c, String key, long v) { get(c).edit().putLong(key, v).apply(); }

    static String str(Context c, String key) { return get(c).getString(key, null); }

    static void setStr(Context c, String key, String v) { get(c).edit().putString(key, v).apply(); }
}
