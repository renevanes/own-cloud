package nl.eigencloud.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.NonWritableChannelException;
import java.nio.channels.SeekableByteChannel;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.fotos.CloudPhotos;
import nl.eigencloud.core.fotos.TakeoutImport;

/**
 * "Uit Google Foto's halen (eenmalig)": de Takeout-zips die je in het systeem-kiesvenster kiest, worden op de
 * telefoon gelezen (niets uitgepakt) en foto voor foto met datum, plaats en album naar je cloud gestuurd
 * ({@link TakeoutImport}). Loopt op de achtergrond in stukjes ({@link OnPhoneJob}) en gaat na een onderbreking
 * verder waar hij was. Zonder Google-koppeling: Google laat sinds 31 maart 2025 geen apps meer bij je hele
 * fotobibliotheek, Takeout is de weg.
 */
final class TakeoutRun {
    private TakeoutRun() {}

    static final int NOTIFY_ID = 31;

    static File dir(Context c) { return new File(new File(c.getFilesDir(), "telefoon"), "takeout"); }

    /** Een gekozen zip (blijvende leestoegang via het systeem-kiesvenster). */
    static final class UriSource implements TakeoutImport.Source {
        final Context c;
        final Uri uri;
        final String name;
        final long size;

        UriSource(Context c, Uri uri, String name, long size) { this.c = c; this.uri = uri; this.name = name; this.size = size; }

        @Override public String name() { return name; }

        @Override public long size() { return size; }

        @Override
        public SeekableByteChannel open() throws IOException {
            ParcelFileDescriptor pfd;
            try {
                pfd = c.getContentResolver().openFileDescriptor(uri, "r");
            } catch (SecurityException | IllegalArgumentException e) {
                throw new IOException("Geen toegang meer tot " + name, e);
            }
            if (pfd == null) throw new IOException(name + " is niet te openen");
            FileInputStream in = new FileInputStream(pfd.getFileDescriptor());
            FileChannel ch = in.getChannel();
            long n;
            try {
                n = ch.size();
                ch.position(0);
            } catch (IOException e) {
                n = -1;
            }
            if (n <= 0) {
                in.close();
                pfd.close();
                throw new IOException(name + " staat niet op de telefoon zelf. Download het bestand eerst (bijvoorbeeld naar Downloads) en kies het daar.");
            }
            return new PfdChannel(ch, in, pfd);
        }
    }

    /** FileChannel dat bij sluiten ook de bestandsbeschrijving vrijgeeft. */
    private static final class PfdChannel implements SeekableByteChannel {
        private final FileChannel ch;
        private final FileInputStream in;
        private final ParcelFileDescriptor pfd;

        PfdChannel(FileChannel ch, FileInputStream in, ParcelFileDescriptor pfd) { this.ch = ch; this.in = in; this.pfd = pfd; }

        @Override public int read(ByteBuffer dst) throws IOException { return ch.read(dst); }

        @Override public int write(ByteBuffer src) { throw new NonWritableChannelException(); }

        @Override public long position() throws IOException { return ch.position(); }

        @Override public SeekableByteChannel position(long p) throws IOException { ch.position(p); return this; }

        @Override public long size() throws IOException { return ch.size(); }

        @Override public SeekableByteChannel truncate(long size) { throw new NonWritableChannelException(); }

        @Override public boolean isOpen() { return ch.isOpen(); }

        @Override
        public void close() throws IOException {
            try { ch.close(); in.close(); } finally { pfd.close(); }
        }
    }

    // ───────── Bewaarde toestand ─────────

    private static Map<String, Object> read(Context c, String name) {
        File f = new File(dir(c), name);
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            return Json.asMap(Json.parse(Bytes.utf8(Bytes.readAll(in))));
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static void write(Context c, String name, Map<String, Object> json) throws IOException {
        File d = dir(c);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("Map voor de import maken lukt niet");
        File tmp = new File(d, name + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(Bytes.utf8(Json.stringify(json))); }
        if (!tmp.renameTo(new File(d, name))) throw new IOException("Voortgang bewaren lukt niet");
    }

    static List<UriSource> sources(Context c) {
        List<UriSource> out = new ArrayList<>();
        Map<String, Object> s = read(c, "bronnen.json");
        if (s == null || Json.asList(s.get("files")) == null) return out;
        for (Object o : Json.asList(s.get("files"))) {
            Map<String, Object> m = Json.asMap(o);
            out.add(new UriSource(c.getApplicationContext(), Uri.parse(Json.str(m, "uri")), Json.str(m, "name"), Json.num(m, "size").longValue()));
        }
        return out;
    }

    /** De gekozen zips onthouden (met blijvende leestoegang) en de import starten. */
    static synchronized void choose(Context c, List<Uri> uris) throws IOException {
        stop(c);
        ContentResolver cr = c.getContentResolver();
        List<Object> files = new ArrayList<>();
        for (Uri u : uris) {
            try {
                cr.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException e) {
                // tijdelijke toegang: werkt tot de app sluit
            }
            String name = u.getLastPathSegment();
            long size = -1;
            try (Cursor cur = cr.query(u, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cur != null && cur.moveToFirst()) {
                    if (!cur.isNull(0)) name = cur.getString(0);
                    if (!cur.isNull(1)) size = cur.getLong(1);
                }
            }
            if (name == null || !name.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) throw new IOException((name == null ? "Dit bestand" : name) + " is geen zip. Kies de .zip-bestanden van Google Takeout.");
            files.add(Json.obj("uri", u.toString(), "name", name, "size", size));
        }
        if (files.isEmpty()) throw new IOException("Geen bestanden gekozen");
        write(c, "bronnen.json", Json.obj("files", files, "chosen", System.currentTimeMillis()));
        OnPhoneJob.takeout(c);
    }

    static boolean paused(Context c) { return new File(dir(c), "gepauzeerd").exists(); }

    static void pause(Context c, boolean on) throws IOException {
        File f = new File(dir(c), "gepauzeerd");
        if (on) { if (!f.exists() && !f.createNewFile()) throw new IOException("Pauzeren lukt niet"); }
        else { f.delete(); OnPhoneJob.takeout(c); }
    }

    /** Stoppen en alles van deze import vergeten (wat al in je cloud staat, blijft daar). */
    static synchronized void stop(Context c) {
        for (UriSource s : sources(c)) {
            try { c.getContentResolver().releasePersistableUriPermission(s.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { /* had geen blijvende toegang */ }
        }
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) f.delete();
        Notify.cancel(c, NOTIFY_ID);
    }

    static boolean active(Context c) {
        if (sources(c).isEmpty() || paused(c)) return false;
        Map<String, Object> st = read(c, "stand.json");
        if (st != null && (Json.str(st, "fatal") != null || Json.truthy(st.get("done")))) return false;
        return true;
    }

    static Map<String, Object> status(Context c) {
        List<UriSource> src = sources(c);
        if (src.isEmpty()) return Json.obj("phase", "leeg");
        List<Object> names = new ArrayList<>();
        long size = 0;
        for (UriSource s : src) { names.add(s.name); size += Math.max(0, s.size); }
        Map<String, Object> scan = read(c, "overzicht.json");
        Map<String, Object> st = read(c, "stand.json");
        Map<String, Object> out = Json.obj("files", names, "size", size, "paused", paused(c), "wifiOnly", OnPhonePrefs.flag(c, OnPhonePrefs.TK_WIFI));
        if (scan != null) {
            out.put("total", Json.asList(scan.get("items")) == null ? 0 : Json.asList(scan.get("items")).size());
            out.put("withMeta", scan.get("withMeta"));
            out.put("otherGoogle", scan.get("otherGoogle"));
            out.put("skipped", scan.get("skipped"));
            out.put("bytes", scan.get("bytes"));
        }
        if (st != null) out.putAll(st);
        String phase = st != null && Json.str(st, "fatal") != null ? "fout" : st != null && Json.truthy(st.get("done")) ? "klaar"
                : paused(c) ? "gepauzeerd" : scan == null ? "doorzoeken" : "bezig";
        out.put("phase", phase);
        return out;
    }

    /**
     * Eén ronde: doorzoeken (als dat nog moet) en uploaden tot {@code deadline}. Geeft true als er later nog een
     * ronde moet komen.
     */
    static synchronized boolean run(Context c, TakeoutImport.Cancel cancel, long deadline) {
        List<UriSource> src = sources(c);
        if (src.isEmpty() || paused(c)) return false;
        Map<String, Object> stJson = read(c, "stand.json");
        TakeoutImport.State st = TakeoutImport.State.fromJson(stJson);
        if (st.fatal != null || (stJson != null && Json.truthy(stJson.get("done")))) return false;
        try {
            TakeoutImport.Scan scan;
            Map<String, Object> scanJson = read(c, "overzicht.json");
            if (scanJson == null) {
                progress(c, "Je Takeout-bestanden doorzoeken…", 0, 0);
                scan = TakeoutImport.scan(src, cancel);
                write(c, "overzicht.json", scan.toJson());
            } else scan = TakeoutImport.Scan.fromJson(scanJson);

            CloudApi api = CloudApi.fromApp(c);
            if (api == null) { st.waiting = "Log in in de app"; save(c, st, scan, null); return false; }
            if (OnPhonePrefs.flag(c, OnPhonePrefs.TK_WIFI) && PhotoLibrary.metered(c)) { st.waiting = "Wacht op wifi"; save(c, st, scan, null); return true; }
            CloudPhotos cloud = new CloudPhotos(api.base, api.token());
            String note = null;
            try {
                List<Object> f = cloud.features();
                if (f != null && !f.contains("photo-upload-meta")) note = "Je cloud is nog niet bijgewerkt: de datum gaat mee, plaats, album en favoriet nog niet. Werk je cloud bij en importeer gerust opnieuw.";
            } catch (IOException e) {
                // straks bij uploaden blijkt het wel
            }
            final String noteFinal = note;
            final int total = scan.items.size();
            final long[] lastSave = {System.currentTimeMillis()};
            final TakeoutImport.Scan scanFinal = scan;
            st = TakeoutImport.run(src, scan, st, cloud.takeoutUploader(), cancel, deadline, (state, item) -> {
                if (item != null) progress(c, "Foto's uit Google naar je cloud", state.position, total);
                if (System.currentTimeMillis() - lastSave[0] > 5_000) {
                    lastSave[0] = System.currentTimeMillis();
                    try { save(c, state, scanFinal, noteFinal); } catch (IOException ignored) { /* volgende keer */ }
                }
            });
            save(c, st, scan, note);
            if (st.fatal != null) { finished(c, "Import gestopt", st.fatal); return false; }
            if (st.done(scan)) {
                finished(c, "Klaar met je foto's uit Google", st.added + " nieuw, " + st.duplicates + " stonden er al" + (st.failed > 0 ? ", " + st.failed + " mislukt" : ""));
                return false;
            }
            if (st.waiting != null && st.waiting.startsWith("Log")) return false;
            return !"Gepauzeerd".equals(st.waiting);
        } catch (IOException | RuntimeException e) {
            st.fatal = e.getMessage();
            try { save(c, st, null, null); } catch (IOException ignored) { /* niets */ }
            finished(c, "Import gestopt", e.getMessage());
            return false;
        }
    }

    private static void save(Context c, TakeoutImport.State st, TakeoutImport.Scan scan, String note) throws IOException {
        Map<String, Object> m = st.toJson();
        m.put("done", scan != null && st.done(scan));
        m.put("note", note);
        m.put("updated", System.currentTimeMillis());
        write(c, "stand.json", m);
    }

    private static void progress(Context c, String title, int done, int total) {
        android.app.Notification n = Notify.builder(c, Notify.BACKUP)
                .setContentTitle(title)
                .setContentText(total > 0 ? done + " van " + total : "Even geduld")
                .setProgress(total, done, total == 0)
                .setOngoing(true).setOnlyAlertOnce(true)
                .setContentIntent(OnPhoneActivity.pending(c, "#fotos"))
                .build();
        Notify.show(c, NOTIFY_ID, n);
    }

    private static void finished(Context c, String title, String text) {
        Notify.show(c, NOTIFY_ID, Notify.builder(c, Notify.BACKUP).setContentTitle(title).setContentText(text)
                .setContentIntent(OnPhoneActivity.pending(c, "#fotos")).setAutoCancel(true).build());
    }

    static long bytes(Context c) {
        long n = 0;
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) n += f.length();
        return n;
    }
}
