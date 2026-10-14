package nl.eigencloud.app;

import android.content.Context;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.WebResourceResponse;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.fotos.CloudPhotos;
import nl.eigencloud.core.fotos.PhotoCache;
import nl.eigencloud.core.fotos.TakeoutImport;

/**
 * Je foto's uit Eigen Cloud op de telefoon: de laatste maanden helemaal, oudere als miniatuur, en een origineel
 * pas als je hem opent (zie {@link PhotoCache}). Alles staat in de map van de app; de WebView van
 * {@link OnPhoneActivity} haalt ze op via {@code /foto/mini/<id>} en {@code /foto/groot/<id>}.
 */
final class PhotoLibrary {
    private PhotoLibrary() {}

    static File root(Context c) { return new File(new File(c.getFilesDir(), "telefoon"), "fotos"); }

    private static File miniDir(Context c) { return new File(root(c), "mini"); }

    private static File grootDir(Context c) { return new File(root(c), "groot"); }

    static File mini(Context c, long id) { return new File(miniDir(c), id + ".webp"); }

    static File groot(Context c, long id) { return new File(grootDir(c), String.valueOf(id)); }

    // ───────── Instellingen en netwerk ─────────

    static PhotoCache.Settings settings(Context c) {
        PhotoCache.Settings s = new PhotoCache.Settings();
        s.months = OnPhonePrefs.integer(c, OnPhonePrefs.PH_MONTHS);
        s.maxBytes = Math.max(0, OnPhonePrefs.integer(c, OnPhonePrefs.PH_MAX_GB)) * 1024L * 1024 * 1024;
        s.onDemandBytes = Math.min(1024L * 1024 * 1024, s.maxBytes / 4);
        s.mobile = OnPhonePrefs.flag(c, OnPhonePrefs.PH_MOBILE);
        s.videos = OnPhonePrefs.flag(c, OnPhonePrefs.PH_VIDEOS);
        return s;
    }

    static boolean online(Context c) { return c.getSystemService(ConnectivityManager.class).getActiveNetwork() != null; }

    static boolean metered(Context c) { return c.getSystemService(ConnectivityManager.class).isActiveNetworkMetered(); }

    static CloudPhotos api(Context c) {
        CloudApi a = CloudApi.fromApp(c);
        return a == null ? null : new CloudPhotos(a.base, a.token());
    }

    // ───────── Overzicht van je cloud (index) ─────────

    private static List<CloudPhotos.Photo> index;
    private static Map<Long, CloudPhotos.Photo> byId;

    static synchronized List<CloudPhotos.Photo> index(Context c) {
        if (index != null) return index;
        List<CloudPhotos.Photo> out = new ArrayList<>();
        File f = new File(root(c), "index.json");
        if (f.isFile()) {
            try (InputStream in = new FileInputStream(f)) {
                List<Object> l = Json.asList(Json.parse(Bytes.utf8(Bytes.readAll(in))));
                if (l != null) for (Object o : l) out.add(CloudPhotos.Photo.fromJson(Json.asMap(o)));
            } catch (IOException | RuntimeException e) {
                out.clear();
            }
        }
        setIndex(out);
        return out;
    }

    private static void setIndex(List<CloudPhotos.Photo> l) {
        index = l;
        byId = new HashMap<>();
        for (CloudPhotos.Photo p : l) byId.put(p.id, p);
    }

    static synchronized CloudPhotos.Photo photo(Context c, long id) {
        index(c);
        return byId.get(id);
    }

    private static synchronized void saveIndex(Context c, List<CloudPhotos.Photo> l) throws IOException {
        File dir = root(c);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Map voor foto's maken lukt niet");
        List<Object> json = new ArrayList<>();
        for (CloudPhotos.Photo p : l) json.add(p.toJson());
        File tmp = new File(dir, "index.json.tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(Bytes.utf8(Json.stringify(json))); }
        if (!tmp.renameTo(new File(dir, "index.json"))) throw new IOException("Overzicht bewaren lukt niet");
        setIndex(l);
    }

    // ───────── Wat er al staat ─────────

    static List<PhotoCache.Cached> cached(Context c) {
        List<PhotoCache.Cached> out = new ArrayList<>();
        add(out, miniDir(c).listFiles(), PhotoCache.Kind.THUMB);
        add(out, grootDir(c).listFiles(), PhotoCache.Kind.ORIGINAL);
        return out;
    }

    private static void add(List<PhotoCache.Cached> out, File[] files, PhotoCache.Kind kind) {
        if (files == null) return;
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(".deel")) { f.delete(); continue; }
            try {
                long id = Long.parseLong(kind == PhotoCache.Kind.THUMB ? n.replace(".webp", "") : n);
                out.add(new PhotoCache.Cached(id, kind, f.length(), f.lastModified()));
            } catch (NumberFormatException e) {
                // geen bestand van ons
            }
        }
    }

    private static File file(Context c, long id, PhotoCache.Kind kind) { return kind == PhotoCache.Kind.THUMB ? mini(c, id) : groot(c, id); }

    // ───────── Bijwerken op de achtergrond ─────────

    /**
     * Overzicht bijwerken (hooguit eens per 6 uur, of met {@code force}), opruimen wat weg moet en vooraf ophalen
     * wat erbij moet, tot {@code deadline}. Alleen via wifi, tenzij mobiele data mag.
     */
    static Map<String, Object> sync(Context c, TakeoutImport.Cancel cancel, long deadline, boolean force) {
        if (!OnPhonePrefs.flag(c, OnPhonePrefs.PH_CACHE)) return Json.obj("off", true);
        CloudPhotos api = api(c);
        if (api == null) return note(c, "Log in in de app om je foto's op te halen");
        if (!online(c)) return note(c, "Geen internet");
        PhotoCache.Settings s = settings(c);
        if (!PhotoCache.prefetchAllowed(metered(c), s)) return note(c, "Wacht op wifi");
        int fetched = 0, evicted = 0;
        try {
            long now = System.currentTimeMillis();
            if (force || index(c).isEmpty() || now - OnPhonePrefs.num(c, OnPhonePrefs.PH_INDEXED) > 6 * 3_600_000L) {
                saveIndex(c, api.all(cancel));
                OnPhonePrefs.setNum(c, OnPhonePrefs.PH_INDEXED, now);
            }
            PhotoCache.Plan plan = PhotoCache.plan(index(c), cached(c), s, now);
            for (PhotoCache.Cached x : plan.evict) if (file(c, x.id, x.kind).delete()) evicted++;
            miniDir(c).mkdirs();
            grootDir(c).mkdirs();
            for (PhotoCache.Want w : plan.fetch) {
                if ((cancel != null && cancel.cancelled()) || System.currentTimeMillis() > deadline) break;
                if (!PhotoCache.prefetchAllowed(metered(c), s)) { OnPhonePrefs.setStr(c, OnPhonePrefs.PH_ERROR, "Wacht op wifi"); break; }
                try {
                    api.download(w.photo.id, w.kind == PhotoCache.Kind.THUMB, file(c, w.photo.id, w.kind));
                    fetched++;
                } catch (java.io.FileNotFoundException gone) {
                    // intussen verwijderd in de cloud; volgende keer uit het overzicht
                }
            }
            OnPhonePrefs.setNum(c, OnPhonePrefs.PH_LAST, System.currentTimeMillis());
            OnPhonePrefs.setStr(c, OnPhonePrefs.PH_ERROR, null);
            return Json.obj("fetched", fetched, "evicted", evicted, "more", plan.fetch.size() > fetched);
        } catch (IOException | RuntimeException e) {
            return note(c, e.getMessage());
        }
    }

    private static Map<String, Object> note(Context c, String msg) {
        OnPhonePrefs.setStr(c, OnPhonePrefs.PH_ERROR, msg);
        return Json.obj("error", msg);
    }

    // ───────── Voor het scherm ─────────

    static Map<String, Object> status(Context c) {
        PhotoCache.Settings s = settings(c);
        List<CloudPhotos.Photo> idx = index(c);
        long cut = PhotoCache.cutoff(System.currentTimeMillis(), s.months);
        int recent = 0;
        for (CloudPhotos.Photo p : idx) if (p.takenAt >= cut) recent++;
        long miniBytes = 0, grootBytes = 0;
        int minis = 0, groot = 0;
        for (PhotoCache.Cached x : cached(c)) {
            if (x.kind == PhotoCache.Kind.THUMB) { minis++; miniBytes += x.bytes; } else { groot++; grootBytes += x.bytes; }
        }
        return Json.obj("on", OnPhonePrefs.flag(c, OnPhonePrefs.PH_CACHE), "months", s.months, "maxGb", OnPhonePrefs.integer(c, OnPhonePrefs.PH_MAX_GB),
                "mobile", s.mobile, "videos", s.videos, "last", OnPhonePrefs.num(c, OnPhonePrefs.PH_LAST), "indexed", OnPhonePrefs.num(c, OnPhonePrefs.PH_INDEXED),
                "error", OnPhonePrefs.str(c, OnPhonePrefs.PH_ERROR), "total", idx.size(), "recent", recent, "older", idx.size() - recent,
                "minis", minis, "originals", groot, "miniBytes", miniBytes, "originalBytes", grootBytes, "cloud", CloudApi.fromApp(c) != null,
                "metered", metered(c));
    }

    /** Een stuk van de tijdlijn voor het raster (nieuwste eerst). */
    static Map<String, Object> page(Context c, int offset, int limit) {
        List<CloudPhotos.Photo> idx = index(c);
        List<Object> items = new ArrayList<>();
        for (int i = Math.max(0, offset); i < Math.min(idx.size(), offset + Math.max(1, Math.min(limit, 500))); i++) {
            CloudPhotos.Photo p = idx.get(i);
            items.add(Json.obj("id", p.id, "t", p.takenAt, "f", p.filename, "v", p.video, "h", p.thumb, "full", groot(c, p.id).isFile()));
        }
        return Json.obj("total", idx.size(), "offset", offset, "items", items);
    }

    /** Een origineel openen: klaar, eerst vragen (mobiele data), of nu ophalen. */
    static Map<String, Object> prepare(Context c, long id, boolean confirmed) throws IOException {
        File f = groot(c, id);
        PhotoCache.Open o = PhotoCache.open(f.isFile(), metered(c), settings(c), confirmed);
        if (o == PhotoCache.Open.ASK) return Json.obj("ask", true);
        if (o == PhotoCache.Open.FETCH) {
            CloudPhotos api = api(c);
            if (api == null) throw new IOException("Log in in de app om dit origineel op te halen");
            if (!online(c)) throw new IOException("Geen internet");
            grootDir(c).mkdirs();
            api.download(id, false, f);
        }
        f.setLastModified(System.currentTimeMillis());
        CloudPhotos.Photo p = photo(c, id);
        return Json.obj("ready", true, "video", p != null && p.video, "bytes", f.length());
    }

    /** Antwoord voor de WebView op /foto/mini/&lt;id&gt; en /foto/groot/&lt;id&gt; (met Range voor video's). */
    static WebResourceResponse serve(Context c, Uri u, Map<String, String> headers) {
        List<String> seg = u.getPathSegments();
        if (seg.size() != 3) return notFound();
        long id;
        try { id = Long.parseLong(seg.get(2)); } catch (NumberFormatException e) { return notFound(); }
        try {
            if ("mini".equals(seg.get(1))) {
                File f = mini(c, id);
                if (!f.isFile()) {
                    // Een miniatuur die je ziet, halen we altijd (klein), ook via mobiele data.
                    CloudPhotos api = api(c);
                    if (api == null || !online(c)) return notFound();
                    miniDir(c).mkdirs();
                    api.download(id, true, f);
                }
                return file(f, "image/webp", headers);
            }
            if ("groot".equals(seg.get(1))) {
                File f = groot(c, id);
                if (!f.isFile()) return notFound();
                CloudPhotos.Photo p = photo(c, id);
                return file(f, p != null && p.mime != null ? p.mime : "application/octet-stream", headers);
            }
        } catch (IOException | RuntimeException e) {
            return notFound();
        }
        return notFound();
    }

    private static String header(Map<String, String> h, String name) {
        if (h == null) return null;
        for (Map.Entry<String, String> e : h.entrySet()) if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        return null;
    }

    static WebResourceResponse file(File f, String mime, Map<String, String> req) throws IOException {
        long len = f.length();
        Map<String, String> h = new HashMap<>();
        h.put("Accept-Ranges", "bytes");
        h.put("Cache-Control", "no-store");
        String range = header(req, "Range");
        if (range != null && range.startsWith("bytes=")) {
            String[] p = range.substring(6).split("-", 2);
            try {
                long start = p[0].isEmpty() ? Math.max(0, len - Long.parseLong(p[1])) : Long.parseLong(p[0]);
                long end = p.length > 1 && !p[1].isEmpty() && !p[0].isEmpty() ? Math.min(Long.parseLong(p[1]), len - 1) : len - 1;
                if (start <= end && start < len) {
                    FileInputStream in = new FileInputStream(f);
                    in.getChannel().position(start);
                    h.put("Content-Range", "bytes " + start + "-" + end + "/" + len);
                    h.put("Content-Length", String.valueOf(end - start + 1));
                    return new WebResourceResponse(mime, null, 206, "Partial Content", h, new Limited(in, end - start + 1));
                }
            } catch (NumberFormatException ignored) {
                // hele bestand
            }
        }
        h.put("Content-Length", String.valueOf(len));
        return new WebResourceResponse(mime, null, 200, "OK", h, new FileInputStream(f));
    }

    private static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long n) { super(in); left = n; }

        @Override public int read() throws IOException { if (left <= 0) return -1; int b = super.read(); if (b >= 0) left--; return b; }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }

    // ───────── Foto's op deze telefoon (galerij) ─────────

    /** Hoeveel foto's en video's er in de galerij van de telefoon staan, en hoe groot. */
    static Map<String, Object> gallery(Context c) {
        if (!PhotoBackup.permitted(c)) return Json.obj("permitted", false);
        long[] img = count(c, MediaStore.Images.Media.EXTERNAL_CONTENT_URI), vid = count(c, MediaStore.Video.Media.EXTERNAL_CONTENT_URI);
        return Json.obj("permitted", true, "images", img[0], "videos", vid[0], "bytes", img[1] + vid[1]);
    }

    private static long[] count(Context c, Uri uri) {
        long n = 0, bytes = 0;
        try (Cursor cur = c.getContentResolver().query(uri, new String[]{MediaStore.MediaColumns.SIZE}, null, null, null)) {
            while (cur != null && cur.moveToNext()) { n++; if (!cur.isNull(0)) bytes += cur.getLong(0); }
        } catch (RuntimeException e) {
            // geen toegang tot deze soort
        }
        return new long[]{n, bytes};
    }

    // ───────── Opslag ─────────

    static Map<String, Object> storage(Context c) {
        long mini = 0, groot = 0;
        for (PhotoCache.Cached x : cached(c)) { if (x.kind == PhotoCache.Kind.THUMB) mini += x.bytes; else groot += x.bytes; }
        File idx = new File(root(c), "index.json");
        return Json.obj("mini", mini, "originals", groot, "index", idx.length());
    }

    /** "originals": volledige foto's weg (miniaturen blijven); "all": alles, ook het overzicht. */
    static synchronized long free(Context c, String scope) {
        long n = 0;
        File[] g = grootDir(c).listFiles();
        if (g != null) for (File f : g) { long l = f.length(); if (f.delete()) n += l; }
        if ("all".equals(scope)) {
            File[] m = miniDir(c).listFiles();
            if (m != null) for (File f : m) { long l = f.length(); if (f.delete()) n += l; }
            File idx = new File(root(c), "index.json");
            long l = idx.length();
            if (idx.delete()) n += l;
            setIndex(new ArrayList<>());
            OnPhonePrefs.setNum(c, OnPhonePrefs.PH_INDEXED, 0);
        }
        return n;
    }

    static String human(long bytes) {
        if (bytes < 1024 * 1024) return String.format(Locale.ROOT, "%d kB", bytes / 1024);
        return String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0);
    }
}
