package nl.eigencloud.core.fotos;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.SeekableByteChannel;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * Foto's uit Google Takeout-zips naar je cloud, vanaf de telefoon: eerst alle zips doorzoeken (alleen de
 * inhoudsopgave en de kleine JSON-bestanden), dan foto voor foto uploaden met datum, plaats, beschrijving,
 * favoriet en album uit de JSON. Google zet een foto en zijn JSON soms in verschillende zips; daarom eerst alles
 * doorzoeken, net als processTakeout in src/import/takeout.ts.
 *
 * <p>Er wordt niets uitgepakt op de telefoon: elk bestand gaat rechtstreeks uit de zip naar de cloud. De voortgang
 * is één getal (hoeveel bestanden klaar zijn); met dezelfde zips is de volgorde altijd gelijk, dus na een
 * onderbreking gaat het verder waar het was. Dubbele foto's herkent de cloud zelf.
 */
public final class TakeoutImport {
    private TakeoutImport() {}

    /** Een gekozen zip. */
    public interface Source {
        String name();

        long size();

        SeekableByteChannel open() throws IOException;
    }

    /** Eén foto of video om te uploaden. */
    public static final class Item {
        public int source;
        public int entry;
        public String rel;
        public String name;
        public String album;
        public long size;
        public String mime;
        public TakeoutSidecar.Meta meta;
        /** Tijd van het bestand in de zip (ms), of 0. */
        public long zipTime;

        /** Datum voor de cloud als de foto zelf geen datum heeft: uit Google, anders uit de zip. */
        public long lastModified() { return meta != null && meta.takenAt != null ? meta.takenAt : zipTime > 0 ? zipTime : System.currentTimeMillis(); }
    }

    public static final class Scan {
        public final List<Item> items = new ArrayList<>();
        public final List<String> names = new ArrayList<>();
        public final List<Long> sizes = new ArrayList<>();
        public int withMeta;
        public int jsonFiles;
        public int skipped;
        /** Mail- en agendabestanden in de zips (die gaan via Importeren in de cloud). */
        public int otherGoogle;
        public long bytes;

        /** Klopt deze doorzoeking nog bij deze zips (zelfde namen en groottes, zelfde volgorde)? */
        public boolean matches(List<? extends Source> sources) {
            if (sources.size() != names.size()) return false;
            for (int i = 0; i < sources.size(); i++) if (!sources.get(i).name().equals(names.get(i)) || sources.get(i).size() != sizes.get(i)) return false;
            return true;
        }

        public Map<String, Object> toJson() {
            List<Object> list = new ArrayList<>();
            for (Item it : items) {
                Map<String, Object> m = Json.obj("s", it.source, "e", it.entry, "r", it.rel, "z", it.size, "t", it.zipTime);
                if (it.album != null) m.put("a", it.album);
                if (it.meta != null) m.put("m", it.meta.toJson());
                list.add(m);
            }
            return Json.obj("v", 1, "names", new ArrayList<Object>(names), "sizes", new ArrayList<Object>(sizes), "withMeta", withMeta, "jsonFiles", jsonFiles,
                    "skipped", skipped, "otherGoogle", otherGoogle, "bytes", bytes, "items", list);
        }

        public static Scan fromJson(Map<String, Object> j) {
            Scan s = new Scan();
            for (Object o : Json.asList(j.get("names"))) s.names.add((String) o);
            for (Object o : Json.asList(j.get("sizes"))) s.sizes.add(((Number) o).longValue());
            s.withMeta = Json.num(j, "withMeta").intValue();
            s.jsonFiles = Json.num(j, "jsonFiles").intValue();
            s.skipped = Json.num(j, "skipped").intValue();
            s.otherGoogle = Json.num(j, "otherGoogle").intValue();
            s.bytes = Json.num(j, "bytes").longValue();
            for (Object o : Json.asList(j.get("items"))) {
                Map<String, Object> m = Json.asMap(o);
                Item it = new Item();
                it.source = Json.num(m, "s").intValue();
                it.entry = Json.num(m, "e").intValue();
                it.rel = Json.str(m, "r");
                it.name = TakeoutSidecar.baseName(it.rel);
                it.size = Json.num(m, "z").longValue();
                Number t = Json.num(m, "t");
                it.zipTime = t == null ? 0 : t.longValue();
                it.album = Json.str(m, "a");
                it.mime = TakeoutSidecar.mime(it.name);
                if (m.get("m") != null) it.meta = TakeoutSidecar.Meta.fromJson(Json.asMap(m.get("m")));
                s.items.add(it);
            }
            return s;
        }
    }

    public interface Cancel { boolean cancelled(); }

    /** Doorzoekt alle zips: welke foto's en video's, en welke gegevens uit Google horen erbij. */
    public static Scan scan(List<? extends Source> sources, Cancel cancel) throws IOException {
        Scan s = new Scan();
        // map (pad binnen Google Foto's) → JSON-naam → gegevens; over alle zips heen
        Map<String, Map<String, TakeoutSidecar.Meta>> jsons = new HashMap<>();
        List<Item> media = new ArrayList<>();
        for (int si = 0; si < sources.size(); si++) {
            Source src = sources.get(si);
            s.names.add(src.name());
            s.sizes.add(src.size());
            try (SeekableByteChannel ch = src.open(); ZipReader zip = new ZipReader(ch)) {
                for (ZipReader.Entry e : zip.entries()) {
                    if (cancel != null && cancel.cancelled()) throw new IOException("Gestopt");
                    if (e.directory()) continue;
                    String rel = TakeoutSidecar.photosRel(e.name);
                    String lower = e.name.toLowerCase(Locale.ROOT);
                    if (rel == null) {
                        if (lower.endsWith(".mbox") || lower.endsWith(".ics")) s.otherGoogle++;
                        continue;
                    }
                    if (lower.endsWith(".json")) {
                        if (e.size > 2 * 1024 * 1024) continue;
                        s.jsonFiles++;
                        TakeoutSidecar.Meta meta;
                        try (InputStream in = zip.open(e)) {
                            meta = TakeoutSidecar.parse(Bytes.utf8(Bytes.readAll(in)));
                        } catch (IOException ex) {
                            meta = null;
                        }
                        if (meta != null) jsons.computeIfAbsent(dir(rel), k -> new LinkedHashMap<>()).put(TakeoutSidecar.baseName(rel), meta);
                        continue;
                    }
                    if (!TakeoutSidecar.isMedia(rel)) continue;
                    String folder = TakeoutSidecar.folder(rel);
                    if (TakeoutSidecar.skipFolder(folder)) { s.skipped++; continue; }
                    Item it = new Item();
                    it.source = si;
                    it.entry = e.index;
                    it.rel = rel;
                    it.name = TakeoutSidecar.baseName(rel);
                    it.size = e.size;
                    it.zipTime = e.time;
                    it.album = TakeoutSidecar.album(folder);
                    it.mime = TakeoutSidecar.mime(it.name);
                    media.add(it);
                }
            }
        }
        for (Item it : media) {
            Map<String, TakeoutSidecar.Meta> here = jsons.get(dir(it.rel));
            if (here != null) {
                String side = TakeoutSidecar.find(it.name, new ArrayList<>(here.keySet()));
                if (side != null) { it.meta = here.get(side); s.withMeta++; }
            }
            s.bytes += it.size;
            s.items.add(it);
        }
        return s;
    }

    static String dir(String rel) {
        int slash = rel.lastIndexOf('/');
        return slash < 0 ? "" : rel.substring(0, slash);
    }

    /** Waar de import is. Wordt door de app bewaard; {@link #position} = aantal afgehandelde bestanden. */
    public static final class State {
        public int position;
        public int added;
        public int duplicates;
        public int failed;
        public long bytes;
        /** Laatste fout per bestand (ter informatie). */
        public String lastError;
        /** Waarom de import nu stilstaat en later verder moet (geen verbinding, cloud bezig…), of null. */
        public String waiting;
        /** De import kan niet verder (bijv. zip niet meer te lezen); opnieuw kiezen nodig. */
        public String fatal;

        public boolean done(Scan s) { return position >= s.items.size(); }

        public Map<String, Object> toJson() {
            return Json.obj("position", position, "added", added, "duplicates", duplicates, "failed", failed, "bytes", bytes,
                    "lastError", lastError, "waiting", waiting, "fatal", fatal);
        }

        public static State fromJson(Map<String, Object> j) {
            State s = new State();
            if (j == null) return s;
            Number p = Json.num(j, "position"), a = Json.num(j, "added"), d = Json.num(j, "duplicates"), f = Json.num(j, "failed"), b = Json.num(j, "bytes");
            s.position = p == null ? 0 : p.intValue();
            s.added = a == null ? 0 : a.intValue();
            s.duplicates = d == null ? 0 : d.intValue();
            s.failed = f == null ? 0 : f.intValue();
            s.bytes = b == null ? 0 : b.longValue();
            s.lastError = Json.str(j, "lastError");
            s.waiting = Json.str(j, "waiting");
            s.fatal = Json.str(j, "fatal");
            return s;
        }
    }

    /** Wat er met één bestand gebeurde. */
    public static final class Result {
        public boolean duplicate;
        public String error;

        public static Result ok(boolean duplicate) { Result r = new Result(); r.duplicate = duplicate; return r; }

        public static Result failed(String error) { Result r = new Result(); r.error = error; return r; }
    }

    /** Uploadt één bestand. Gooit {@link Retry} als het later opnieuw moet (verbinding weg, cloud niet bereikbaar). */
    public interface Uploader { Result upload(Item item, InputStream content) throws IOException; }

    /** Tijdelijk probleem: stoppen en later verder op dezelfde plek. */
    public static class Retry extends IOException {
        private static final long serialVersionUID = 1L;

        public Retry(String message) { super(message); }

        public Retry(String message, Throwable cause) { super(message, cause); }
    }

    public interface Progress { void update(State s, Item current); }

    /**
     * Gaat verder vanaf {@code state.position} tot alles klaar is, {@code cancel} ja zegt, de tijd om is
     * ({@code deadline}, ms) of er een {@link Retry} komt. Past {@code state} aan; de app bewaart hem.
     */
    public static State run(List<? extends Source> sources, Scan scan, State state, Uploader up, Cancel cancel, long deadline, Progress progress) {
        state.waiting = null;
        if (!scan.matches(sources)) { state.fatal = "De gekozen bestanden zijn veranderd. Kies ze opnieuw."; return state; }
        int open = -1;
        SeekableByteChannel ch = null;
        ZipReader zip = null;
        try {
            while (state.position < scan.items.size()) {
                if (cancel != null && cancel.cancelled()) { state.waiting = "Gepauzeerd"; return state; }
                if (System.currentTimeMillis() > deadline) { state.waiting = "Later verder"; return state; }
                Item it = scan.items.get(state.position);
                if (it.source != open) {
                    if (zip != null) try { zip.close(); } catch (IOException ignored) { /* al dicht */ }
                    zip = null;
                    ch = null;
                    try {
                        ch = sources.get(it.source).open();
                        zip = new ZipReader(ch);
                    } catch (IOException e) {
                        if (ch != null) try { ch.close(); } catch (IOException ignored) { /* al dicht */ }
                        state.fatal = "Kan " + sources.get(it.source).name() + " niet meer lezen. Staat het bestand nog op de telefoon? (" + e.getMessage() + ")";
                        return state;
                    }
                    open = it.source;
                }
                if (progress != null) progress.update(state, it);
                ZipReader.Entry e = it.entry < zip.entries().size() ? zip.entries().get(it.entry) : null;
                if (e == null) { state.fatal = "De gekozen bestanden zijn veranderd. Kies ze opnieuw."; return state; }
                try (InputStream in = zip.open(e)) {
                    Result r = up.upload(it, in);
                    if (r.error != null) { state.failed++; state.lastError = it.name + ": " + r.error; }
                    else if (r.duplicate) state.duplicates++;
                    else { state.added++; state.bytes += it.size; }
                } catch (Retry r) {
                    state.waiting = r.getMessage();
                    return state;
                } catch (IOException ex) {
                    // Dit ene bestand lukt niet (beschadigd in de zip, of geweigerd): overslaan.
                    state.failed++;
                    state.lastError = it.name + ": " + ex.getMessage();
                }
                state.position++;
            }
            if (progress != null) progress.update(state, null);
            return state;
        } finally {
            if (zip != null) try { zip.close(); } catch (IOException ignored) { /* al dicht */ }
        }
    }
}
