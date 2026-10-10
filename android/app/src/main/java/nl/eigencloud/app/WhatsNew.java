package nl.eigencloud.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * "Wat is er nieuw": na een update één keer de wijzigingen sinds de versie die je eerder gebruikte. Het
 * wijzigingslog (changelog.json uit de repository) zit in de app; bij een nieuwe installatie toont hij niets.
 */
final class WhatsNew {
    private WhatsNew() {}

    private static final String SEEN = "whatsnew.code";

    /** Het wijzigingslog in de app, nieuwste eerst: [{version, date, changes[]}]. */
    static List<Object> log(Context c) {
        try (InputStream in = c.getAssets().open("www/changelog.json")) {
            List<Object> l = Json.asList(Json.parse(Bytes.utf8(Bytes.readAll(in))));
            return l != null ? l : new ArrayList<>();
        } catch (IOException | RuntimeException e) {
            return new ArrayList<>();
        }
    }

    /** De regels van één versie (uit het log van de app of uit update.json), of een lege lijst. */
    static List<String> changesOf(List<Object> log, String version) {
        List<String> out = new ArrayList<>();
        for (Object e : log) {
            if (version != null && version.equals(Json.str(e, "version"))) {
                for (Object line : Json.listAt(e, "changes")) out.add(String.valueOf(line));
            }
        }
        return out;
    }

    /** Bij openen: na een update eenmalig tonen wat er nieuw is. */
    static void maybeShow(Activity a) {
        long seen = Prefs.num(a, SEEN);
        if (seen >= BuildConfig.VERSION_CODE) return;
        Prefs.setNum(a, SEEN, BuildConfig.VERSION_CODE);
        if (seen == 0 && freshInstall(a)) return;
        // Alle versies die je hebt overgeslagen (hooguit vijf); bij een update vanaf een app zonder deze functie alleen de nieuwste.
        List<Object> log = log(a);
        String lastSeen = Prefs.str(a, "whatsnew.version");
        List<Object> show = new ArrayList<>();
        for (Object e : log) {
            String v = Json.str(e, "version");
            if (v == null || (lastSeen != null && v.equals(lastSeen))) break;
            show.add(e);
            if (show.size() >= 5 || lastSeen == null) break;
        }
        Prefs.setStr(a, "whatsnew.version", BuildConfig.VERSION_NAME);
        if (show.isEmpty()) return;
        dialog(a, "Nieuw in versie " + BuildConfig.VERSION_NAME, show, show.size() > 1, true);
    }

    /** Het hele wijzigingslog (knop in Instellingen → Telefoon). */
    static void showAll(Activity a) {
        dialog(a, "Wat is er nieuw", log(a), true, false);
    }

    private static void dialog(Activity a, String title, List<Object> entries, boolean headers, boolean moreButton) {
        StringBuilder sb = new StringBuilder();
        for (Object e : entries) {
            if (headers) sb.append(sb.length() > 0 ? "\n" : "").append("Versie ").append(Json.str(e, "version")).append(dateOf(e)).append('\n');
            for (Object line : Json.listAt(e, "changes")) sb.append("• ").append(line).append('\n');
        }
        if (sb.length() == 0) sb.append("Geen wijzigingen bekend.");
        AlertDialog.Builder b = new AlertDialog.Builder(a, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
                .setTitle(title)
                .setMessage(sb.toString().trim())
                .setPositiveButton("Fijn", null);
        if (moreButton) b.setNeutralButton("Alle versies", (d, w) -> showAll(a));
        if (!a.isFinishing()) b.show();
    }

    private static String dateOf(Object e) {
        String d = Json.str(e, "date");
        if (d == null || !d.matches("\\d{4}-\\d{2}-\\d{2}")) return "";
        String[] p = d.split("-");
        String[] months = {"januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"};
        return " (" + Integer.parseInt(p[2]) + " " + months[Integer.parseInt(p[1]) - 1] + " " + p[0] + ")";
    }

    private static boolean freshInstall(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.firstInstallTime == pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return true;
        }
    }

    /** Voor update.json: de regels van de versie die klaarstaat. */
    static List<String> notesFrom(Map<String, Object> updateJson, String version) {
        Object log = updateJson.get("changelog");
        return log instanceof List ? changesOf(Json.asList(log), version) : new ArrayList<>();
    }
}
