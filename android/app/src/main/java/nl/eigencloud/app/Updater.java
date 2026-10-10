package nl.eigencloud.app;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Http;
import nl.eigencloud.core.Json;

/**
 * Automatische updates, zonder Play Store. Elke build op main wordt door GitHub Actions als pakket op ghcr.io
 * gezet (openbaar te lezen, ook als de code privé is): een klein update.json en de APK. De app kijkt elke paar
 * uur, downloadt een nieuwere versie via wifi, controleert de SHA-256 en de ondertekening, en installeert hem
 * zelf. Vanaf Android 12 gebeurt dat stil (na de eerste keer); daarvoor vraagt Android één tik.
 */
final class Updater {
    private Updater() {}

    static final class Release {
        final long code;
        final String version, apkDigest;
        final long size;
        /** Van je eigen cloud in plaats van ghcr.io (als die niet bereikbaar of niet openbaar is). */
        CloudApi viaCloud;

        Release(long code, String version, String apkDigest, long size) {
            this.code = code;
            this.version = version;
            this.apkDigest = apkDigest;
            this.size = size;
        }
    }

    /** Tweede bron: de app zit ook in je server-image en is op te halen bij je eigen cloud (ingelogd). */
    static Release fromCloud(Context c) throws IOException {
        CloudApi api = CloudApi.fromApp(c);
        if (api == null) throw new IOException("niet ingelogd bij je cloud");
        Map<String, Object> j = Json.asMap(api.getJson("/app/update.json"));
        Number code = Json.num(j, "versionCode"), size = Json.num(j, "size");
        String sha = Json.str(j, "sha256");
        if (code == null || sha == null || !sha.matches("[0-9a-f]{64}")) throw new IOException("onvolledige update-informatie van je cloud");
        Release r = new Release(code.longValue(), Json.str(j, "version"), "sha256:" + sha, size == null ? -1 : size.longValue());
        r.viaCloud = api;
        return r;
    }

    /** Nieuwste versie: eerst ghcr.io, anders je eigen cloud. */
    static Release newest(Context c) throws IOException {
        IOException first;
        try {
            Release g = latest();
            try {
                Release own = fromCloud(c);
                if (own.code > g.code) return own;
            } catch (IOException ignored) {
                // eigen cloud heeft (nog) geen app; ghcr is genoeg
            }
            return g;
        } catch (IOException e) {
            first = e;
        }
        try {
            return fromCloud(c);
        } catch (IOException e) {
            throw new IOException(first.getMessage() + " (ook je eigen cloud: " + e.getMessage() + ")");
        }
    }

    private static final String REGISTRY = "https://ghcr.io";

    // ───────── Ophalen van ghcr.io (OCI-registry, anoniem lezen) ─────────

    private static String token() throws IOException {
        Http.Response r = Http.request("GET", REGISTRY + "/token?service=ghcr.io&scope=repository:" + BuildConfig.UPDATE_IMAGE + ":pull", null, null, 15_000);
        if (!r.ok()) throw new IOException("Update-server weigert (" + r.status + "). Staat het pakket eigen-cloud-app op openbaar?");
        return Json.str(Json.parse(r.text()), "token");
    }

    /** Leest de nieuwste release (update.json in het pakket). */
    static Release latest() throws IOException {
        String tok = token();
        Http.Response m = Http.request("GET", REGISTRY + "/v2/" + BuildConfig.UPDATE_IMAGE + "/manifests/latest",
                Http.headers("authorization", "Bearer " + tok, "accept", "application/vnd.oci.image.manifest.v1+json"), null, 15_000);
        if (!m.ok()) throw new IOException("Geen update-informatie gevonden (" + m.status + ")");
        String infoDigest = null, apkDigest = null;
        long apkSize = -1;
        for (Object layer : Json.listAt(Json.parse(m.text()), "layers")) {
            String title = Json.str(layer, "annotations", "org.opencontainers.image.title");
            if ("update.json".equals(title)) infoDigest = Json.str(layer, "digest");
            if (title != null && title.endsWith(".apk")) { apkDigest = Json.str(layer, "digest"); Number s = Json.num(layer, "size"); apkSize = s == null ? -1 : s.longValue(); }
        }
        if (infoDigest == null || apkDigest == null) throw new IOException("Update-pakket is onvolledig");
        byte[] info = blob(tok, infoDigest, 64 * 1024);
        Map<String, Object> j = Json.parseObject(Bytes.utf8(info));
        Number code = Json.num(j, "versionCode");
        return new Release(code == null ? 0 : code.longValue(), Json.str(j, "version"), apkDigest, apkSize);
    }

    /** Haalt een blob op (volgt de omleiding naar de opslag van GitHub, zonder het token mee te sturen). */
    private static byte[] blob(String tok, String digest, int max) throws IOException {
        File tmp = File.createTempFile("blob", null);
        try {
            download(tok, digest, tmp, max);
            try (FileInputStream in = new FileInputStream(tmp)) { return Bytes.readAll(in); }
        } finally {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
    }

    private static void download(String tok, String digest, File out, long max) throws IOException {
        String url = REGISTRY + "/v2/" + BuildConfig.UPDATE_IMAGE + "/blobs/" + digest;
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20_000);
            c.setReadTimeout(60_000);
            if (url.startsWith(REGISTRY)) c.setRequestProperty("authorization", "Bearer " + tok);
            int st = c.getResponseCode();
            if (st >= 300 && st < 400) {
                String loc = c.getHeaderField("location");
                c.disconnect();
                if (loc == null || !loc.startsWith("https://")) throw new IOException("Ongeldige omleiding");
                url = loc;
                continue;
            }
            if (st != 200) { c.disconnect(); throw new IOException("Downloaden mislukt (" + st + ")"); }
            MessageDigest sha;
            try { sha = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException(e); }
            long n = 0;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[256 * 1024];
                int k;
                while ((k = in.read(buf)) > 0) {
                    n += k;
                    if (n > max) throw new IOException("Bestand groter dan verwacht");
                    sha.update(buf, 0, k);
                    os.write(buf, 0, k);
                }
            } finally {
                c.disconnect();
            }
            // In een OCI-registry is de naam van een blob zijn SHA-256: zo weten we zeker dat het klopt.
            if (!("sha256:" + Bytes.hex(sha.digest())).equals(digest)) throw new IOException("Controle van de download mislukt (SHA-256 klopt niet)");
            return;
        }
        throw new IOException("Te veel omleidingen");
    }

    private static void downloadFromCloud(Release r, File out) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(r.viaCloud.base + "/app/eigen-cloud.apk").openConnection();
        try {
            c.setConnectTimeout(20_000);
            c.setReadTimeout(60_000);
            c.setRequestProperty("authorization", "Bearer " + r.viaCloud.token());
            if (c.getResponseCode() != 200) throw new IOException("Downloaden van je cloud mislukt (" + c.getResponseCode() + ")");
            MessageDigest sha;
            try { sha = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException(e); }
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[256 * 1024];
                int k;
                long n = 0;
                while ((k = in.read(buf)) > 0) {
                    n += k;
                    if (n > 200L * 1024 * 1024) throw new IOException("Bestand groter dan verwacht");
                    sha.update(buf, 0, k);
                    os.write(buf, 0, k);
                }
            }
            if (!("sha256:" + Bytes.hex(sha.digest())).equals(r.apkDigest)) throw new IOException("Controle van de download mislukt (SHA-256 klopt niet)");
        } finally {
            c.disconnect();
        }
    }

    // ───────── Installeren ─────────

    /** Mag de app zelf updates installeren? (Instelling "Onbekende apps installeren" voor Eigen Cloud.) */
    static boolean canInstall(Context c) { return c.getPackageManager().canRequestPackageInstalls(); }

    static Intent installPermissionIntent(Context c) {
        return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signatures(PackageInfo p) {
        if (p == null) return null;
        if (Build.VERSION.SDK_INT >= 28) return p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners();
        return p.signatures;
    }

    @SuppressWarnings("deprecation")
    private static int sigFlag() { return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES; }

    /** Downloadt, controleert en installeert {@code r}. Gooit een IOException met een Nederlandse uitleg. */
    static void install(Context c, Release r) throws IOException {
        File dir = new File(c.getCacheDir(), "update");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "eigen-cloud.apk");
        if (r.viaCloud != null) downloadFromCloud(r, apk);
        else download(token(), r.apkDigest, apk, r.size > 0 ? r.size : 200L * 1024 * 1024);
        PackageManager pm = c.getPackageManager();
        PackageInfo mine, theirs;
        try { mine = pm.getPackageInfo(c.getPackageName(), sigFlag()); } catch (PackageManager.NameNotFoundException e) { throw new IOException(e); }
        theirs = pm.getPackageArchiveInfo(apk.getPath(), sigFlag());
        if (theirs == null || !c.getPackageName().equals(theirs.packageName)) throw new IOException("De download is geen Eigen Cloud-app");
        if (!Arrays.equals(signatures(mine), signatures(theirs))) {
            throw new IOException("De nieuwe versie is met een andere sleutel ondertekend. Verwijder de app één keer en installeer de nieuwe versie handmatig.");
        }
        PackageInstaller pi = pm.getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName());
        params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        if (Build.VERSION.SDK_INT >= 33) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream os = s.openWrite("eigen-cloud.apk", 0, apk.length())) {
                byte[] buf = new byte[256 * 1024];
                int k;
                while ((k = in.read(buf)) > 0) os.write(buf, 0, k);
                s.fsync(os);
            }
            Intent done = new Intent(c, InstallReceiver.class).putExtra(InstallReceiver.EXTRA_VERSION, r.version);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(c, id, done, flags).getIntentSender());
        } catch (IOException | RuntimeException e) {
            pi.abandonSession(id);
            throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage(), e);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
        Prefs.setStr(c, "update.installing", r.version);
    }

    // ───────── Planning ─────────

    /** Kijkt of er een nieuwere versie is; onthoudt het resultaat voor het instellingenscherm. */
    static Release check(Context c) throws IOException {
        Release r = newest(c);
        Prefs.setNum(c, "update.checked", System.currentTimeMillis());
        if (r.code <= BuildConfig.VERSION_CODE) { Prefs.setStr(c, "update.version", null); return null; }
        Prefs.setStr(c, "update.version", r.version);
        Prefs.setStr(c, "update.error", null);
        return r;
    }

    /** Vanuit de achtergrondtaak: hooguit elke 6 uur kijken, en via wifi meteen installeren. */
    static void periodic(Context c) {
        if (!Prefs.flag(c, Prefs.UPDATES)) return;
        if (System.currentTimeMillis() - Prefs.num(c, "update.checked") < 6 * 3_600_000L) return;
        try {
            Release r = check(c);
            if (r == null) return;
            boolean metered = c.getSystemService(ConnectivityManager.class).isActiveNetworkMetered();
            if (Prefs.flag(c, Prefs.AUTO_INSTALL) && canInstall(c) && !metered) { install(c, r); return; }
            if (r.version.equals(Prefs.str(c, "update.notified"))) return;
            Prefs.setStr(c, "update.notified", r.version);
            Notification n = Notify.builder(c, Notify.UPDATE)
                    .setContentTitle("Nieuwe versie: " + r.version)
                    .setContentText(canInstall(c) ? "Wordt via wifi geïnstalleerd, of tik om nu bij te werken" : "Tik om bij te werken")
                    .setContentIntent(Notify.openApp(c, "#instellingen/telefoon", 3))
                    .setAutoCancel(true)
                    .build();
            Notify.show(c, Notify.ID_UPDATE, n);
        } catch (IOException | RuntimeException e) {
            Prefs.setStr(c, "update.error", e.getMessage());
        }
    }

    static Map<String, Object> status(Context c) {
        return Json.obj("current", BuildConfig.VERSION_NAME, "available", Prefs.str(c, "update.version"), "checked", Prefs.num(c, "update.checked"),
                "auto", Prefs.flag(c, Prefs.AUTO_INSTALL), "canInstall", canInstall(c), "error", Prefs.str(c, "update.error"),
                "installing", Prefs.str(c, "update.installing"));
    }
}
