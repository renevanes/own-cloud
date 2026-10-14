package nl.eigencloud.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Instellingen van "Agenda en foto's op deze telefoon" (eigen bestand, los van {@link Prefs}, zodat de onderdelen
 * elkaar niet in de weg zitten).
 */
final class OnPhonePrefs {
    private OnPhonePrefs() {}

    // Agenda
    static final String CAL_BACKUP = "agenda.backup";
    static final String CAL_MONTHS = "agenda.months";
    static final String CAL_KEEP = "agenda.keep";
    static final String CAL_EXCLUDE = "agenda.exclude";
    static final String CAL_LAST = "agenda.last";
    static final String CAL_ERROR = "agenda.error";
    static final String CAL_SAVED = "agenda.saved";
    /** "Agenda op deze telefoon" is een keer geopend: pas dan begint de dagelijkse reservekopie. */
    static final String CAL_SEEN = "agenda.seen";
    /** Gevolgde Google-agenda's uit je cloud niet nog eens via "Eigen Cloud" op de telefoon zetten. */
    static final String CAL_SKIP_FOLLOWED = "agenda.skipFollowed";

    // Foto's uit je cloud
    static final String PH_CACHE = "fotos.cache";
    static final String PH_MONTHS = "fotos.months";
    static final String PH_MAX_GB = "fotos.maxGb";
    static final String PH_MOBILE = "fotos.mobile";
    static final String PH_VIDEOS = "fotos.videos";
    static final String PH_INDEXED = "fotos.indexed";
    static final String PH_LAST = "fotos.last";
    static final String PH_ERROR = "fotos.error";

    // Uit Google Foto's halen
    static final String TK_WIFI = "takeout.wifi";

    static SharedPreferences get(Context c) { return c.getApplicationContext().getSharedPreferences("telefoon", Context.MODE_PRIVATE); }

    static boolean flag(Context c, String key) {
        boolean def = key.equals(CAL_BACKUP) || key.equals(CAL_SKIP_FOLLOWED) || key.equals(TK_WIFI);
        return get(c).getBoolean(key, def);
    }

    static void setFlag(Context c, String key, boolean v) { get(c).edit().putBoolean(key, v).apply(); }

    static int integer(Context c, String key) {
        int def = key.equals(CAL_MONTHS) || key.equals(PH_MONTHS) ? 12 : key.equals(CAL_KEEP) ? 14 : key.equals(PH_MAX_GB) ? 5 : 0;
        return get(c).getInt(key, def);
    }

    static void setInt(Context c, String key, int v) { get(c).edit().putInt(key, v).apply(); }

    static long num(Context c, String key) { return get(c).getLong(key, 0); }

    static void setNum(Context c, String key, long v) { get(c).edit().putLong(key, v).apply(); }

    static String str(Context c, String key) { return get(c).getString(key, null); }

    static void setStr(Context c, String key, String v) { get(c).edit().putString(key, v).apply(); }
}
