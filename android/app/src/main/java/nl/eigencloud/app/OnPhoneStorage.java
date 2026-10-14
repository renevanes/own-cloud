package nl.eigencloud.app;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.Json;

/**
 * Wat de app op de telefoon inneemt, voor het scherm "Opslag op deze telefoon". Agenda-reservekopieën, foto's uit je
 * cloud en de Takeout-import staan onder files/telefoon/ en zijn daar vrij te maken; andere onderdelen (zoals een
 * kopie van Gmail) tonen we met hun grootte, vrijmaken gebeurt in dat onderdeel zelf.
 */
final class OnPhoneStorage {
    private OnPhoneStorage() {}

    static long size(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long n = 0;
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) n += size(x);
        return n;
    }

    /** Alles van de app: bestanden, databases en tijdelijke bestanden. */
    static long appBytes(Context c) {
        File data = c.getFilesDir().getParentFile();
        return data != null ? size(data) : size(c.getFilesDir()) + size(c.getCacheDir());
    }

    /** Andere mappen van de app dan die van "Op deze telefoon", met een leesbare naam. */
    static List<Object> otherParts(Context c) {
        List<Object> out = new ArrayList<>();
        File[] fs = c.getFilesDir().listFiles();
        if (fs != null) for (File f : fs) {
            String n = f.getName();
            if (n.equals("telefoon")) continue;
            long bytes = size(f);
            if (bytes == 0) continue;
            out.add(part(label(n), bytes));
        }
        File db = c.getDatabasePath("x").getParentFile();
        if (db != null && size(db) > 0) out.add(part("Databases (bijvoorbeeld een kopie van je mail)", size(db)));
        long cache = size(c.getCacheDir());
        if (cache > 0) out.add(part("Tijdelijke bestanden (updates en dergelijke)", cache));
        return out;
    }

    private static Map<String, Object> part(String name, long bytes) { return Json.obj("name", name, "bytes", bytes); }

    /** Loskoppelen van je cloud: foto's uit die cloud en een lopende import weg; agenda-reservekopieën blijven. */
    static void forgetCloud(Context c) {
        TakeoutRun.stop(c);
        PhotoLibrary.free(c, "all");
    }

    /** "App helemaal opnieuw instellen": ook alles van "Op deze telefoon" weg. */
    static void reset(Context c) {
        forgetCloud(c);
        delete(new File(c.getFilesDir(), "telefoon"));
        OnPhonePrefs.get(c).edit().clear().apply();
    }

    private static void delete(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) delete(x);
        f.delete();
    }

    private static String label(String dir) {
        switch (dir) {
            case "beheer": return "Beheerkluis";
            case "gmail": return "Gmail op deze telefoon";
            default: return dir;
        }
    }
}
