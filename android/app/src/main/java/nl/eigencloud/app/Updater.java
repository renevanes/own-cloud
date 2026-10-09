package nl.eigencloud.app;

import android.app.Notification;
import android.content.Context;

import java.io.IOException;
import java.util.Map;

import nl.eigencloud.core.Http;
import nl.eigencloud.core.Json;

/**
 * Nieuwe versies komen van GitHub Releases (gebouwd en ondertekend door GitHub Actions), niet via Google Play.
 * De app kijkt hooguit één keer per dag en meldt een nieuwe versie; installeren doe je zelf met één tik.
 */
final class Updater {
    private Updater() {}

    static final class Release {
        final String version, apkUrl, pageUrl;

        Release(String version, String apkUrl, String pageUrl) {
            this.version = version;
            this.apkUrl = apkUrl;
            this.pageUrl = pageUrl;
        }
    }

    /** Nieuwste release met een APK, of null. */
    static Release latest() throws IOException {
        Http.Response r = Http.request("GET", "https://api.github.com/repos/" + BuildConfig.UPDATE_REPO + "/releases?per_page=10",
                Http.headers("accept", "application/vnd.github+json", "user-agent", "eigen-cloud-android"), null, 15_000);
        if (!r.ok()) throw new IOException("GitHub antwoordt " + r.status);
        for (Object rel : Json.asList(Json.parse(r.text()))) {
            if (Json.truthy(Json.path(rel, "draft")) || Json.truthy(Json.path(rel, "prerelease"))) continue;
            for (Object a : Json.listAt(rel, "assets")) {
                String name = Json.str(a, "name");
                if (name != null && name.endsWith(".apk")) {
                    String tag = Json.str(rel, "tag_name");
                    return new Release(tag == null ? "?" : tag.replaceFirst("^(android-)?v", ""), Json.str(a, "browser_download_url"), Json.str(rel, "html_url"));
                }
            }
        }
        return null;
    }

    /** -1, 0 of 1 voor versies als "1.2.10". */
    static int compare(String a, String b) {
        String[] x = a.split("[.-]"), y = b.split("[.-]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? num(x[i]) : 0, q = i < y.length ? num(y[i]) : 0;
            if (p != q) return p < q ? -1 : 1;
        }
        return 0;
    }

    private static int num(String s) {
        try { return Integer.parseInt(s.replaceAll("\\D.*$", "")); } catch (NumberFormatException e) { return 0; }
    }

    /** Geeft de nieuwere release terug (of null) en onthoudt het resultaat voor het instellingenscherm. */
    static Release check(Context c) throws IOException {
        Release r = latest();
        Prefs.setNum(c, "update.checked", System.currentTimeMillis());
        if (r == null || compare(r.version, BuildConfig.VERSION_NAME) <= 0) { Prefs.setStr(c, "update.version", null); return null; }
        Prefs.setStr(c, "update.version", r.version);
        Prefs.setStr(c, "update.url", r.apkUrl);
        return r;
    }

    static void daily(Context c) {
        if (!Prefs.flag(c, Prefs.UPDATES)) return;
        if (System.currentTimeMillis() - Prefs.num(c, "update.checked") < 20 * 3_600_000L) return;
        try {
            Release r = check(c);
            if (r == null || r.version.equals(Prefs.str(c, "update.notified"))) return;
            Prefs.setStr(c, "update.notified", r.version);
            Notification n = Notify.builder(c, Notify.UPDATE)
                    .setContentTitle("Nieuwe versie: " + r.version)
                    .setContentText("Tik om de app bij te werken")
                    .setContentIntent(Notify.openUrl(c, r.apkUrl, 3))
                    .setAutoCancel(true)
                    .build();
            Notify.show(c, Notify.ID_UPDATE, n);
        } catch (IOException | RuntimeException ignored) {
            // volgende keer opnieuw
        }
    }

    static Map<String, Object> status(Context c) {
        return Json.obj("current", BuildConfig.VERSION_NAME, "available", Prefs.str(c, "update.version"), "url", Prefs.str(c, "update.url"),
                "checked", Prefs.num(c, "update.checked"));
    }
}
