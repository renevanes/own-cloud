package nl.eigencloud.core.agenda;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * Reservekopieën van agenda's als .ics-bestanden in een map van de app: per agenda een map met een paar recente
 * kopieën (nieuwste eerst). Een kopie die niets nieuws bevat, wordt niet opnieuw bewaard.
 *
 * <pre>
 *   &lt;root&gt;/&lt;sleutel&gt;/info.json             naam, account, aantal afspraken per bestand
 *   &lt;root&gt;/&lt;sleutel&gt;/20261013-071500.ics
 * </pre>
 */
public final class BackupStore {
    private static final Pattern KEY = Pattern.compile("[0-9a-f]{12}");
    private static final Pattern FILE = Pattern.compile("\\d{8}-\\d{6}(-\\d{1,3})?\\.ics");

    private final File root;

    public BackupStore(File root) { this.root = root; }

    public static final class Copy {
        public String file;
        public long time;
        public long bytes;
        public int events;
    }

    public static final class Cal {
        public String key;
        public String name;
        public String account;
        /** Nieuwste eerst. */
        public final List<Copy> copies = new ArrayList<>();
    }

    public static final class Saved {
        public String file;
        public boolean unchanged;
    }

    /** Vaste sleutel voor een agenda (account + naam): blijft gelijk als Android de agenda een nieuw nummer geeft. */
    public static String keyFor(String account, String name) {
        return Bytes.sha256Hex(Bytes.utf8((account == null ? "" : account) + "\n" + (name == null ? "" : name))).substring(0, 12);
    }

    public Saved save(String key, String name, String account, String ics, int events, long now, int keep) throws IOException {
        if (!KEY.matcher(key).matches()) throw new IllegalArgumentException("Ongeldige sleutel");
        File dir = new File(root, key);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Map voor de reservekopie maken lukt niet");
        Map<String, Object> info = info(dir);
        info.put("name", name);
        info.put("account", account);
        Saved s = new Saved();
        List<File> files = files(dir);
        byte[] data = Bytes.utf8(ics);
        if (!files.isEmpty() && Arrays.equals(read(files.get(0)), data)) {
            s.file = files.get(0).getName();
            s.unchanged = true;
            writeInfo(dir, info);
            return s;
        }
        String base = stamp(now);
        File f = new File(dir, base + ".ics");
        for (int i = 1; f.exists() && i < 1000; i++) f = new File(dir, base + "-" + i + ".ics");
        File tmp = new File(dir, f.getName() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(data); }
        if (!tmp.renameTo(f)) { tmp.delete(); throw new IOException("Reservekopie bewaren lukt niet"); }
        Map<String, Object> counts = Json.asMap(info.get("counts"));
        if (counts == null) { counts = Json.obj(); info.put("counts", counts); }
        counts.put(f.getName(), events);
        s.file = f.getName();
        writeInfo(dir, info);
        prune(dir, keep);
        return s;
    }

    /** Alle agenda's met hun kopieën, op naam gesorteerd. */
    public List<Cal> list() {
        List<Cal> out = new ArrayList<>();
        File[] dirs = root.listFiles();
        if (dirs == null) return out;
        for (File d : dirs) {
            if (!d.isDirectory() || !KEY.matcher(d.getName()).matches()) continue;
            Map<String, Object> info = info(d);
            Cal c = new Cal();
            c.key = d.getName();
            c.name = Json.str(info, "name");
            c.account = Json.str(info, "account");
            Map<String, Object> counts = Json.asMap(info.get("counts"));
            for (File f : files(d)) {
                Copy k = new Copy();
                k.file = f.getName();
                k.time = timeOf(f.getName());
                k.bytes = f.length();
                Number n = counts == null ? null : Json.num(counts, f.getName());
                k.events = n == null ? -1 : n.intValue();
                c.copies.add(k);
            }
            if (!c.copies.isEmpty()) out.add(c);
        }
        out.sort((a, b) -> String.valueOf(a.name).compareToIgnoreCase(String.valueOf(b.name)));
        return out;
    }

    public String read(String key, String file) throws IOException {
        if (!KEY.matcher(key == null ? "" : key).matches() || !FILE.matcher(file == null ? "" : file).matches()) throw new IllegalArgumentException("Onbekende reservekopie");
        File f = new File(new File(root, key), file);
        if (!f.isFile()) throw new IOException("Deze reservekopie bestaat niet meer");
        return Bytes.utf8(read(f));
    }

    /** Ruimte die alle kopieën innemen (bytes). */
    public long bytes() { return size(root); }

    public int count() {
        int n = 0;
        for (Cal c : list()) n += c.copies.size();
        return n;
    }

    /** Per agenda alleen de {@code keep} nieuwste kopieën bewaren. Geeft het aantal weggehaalde bestanden. */
    public int prune(int keep) {
        int n = 0;
        File[] dirs = root.listFiles();
        if (dirs == null) return 0;
        for (File d : dirs) if (d.isDirectory() && KEY.matcher(d.getName()).matches()) n += prune(d, keep);
        return n;
    }

    private int prune(File dir, int keep) {
        List<File> files = files(dir);
        int n = 0;
        for (int i = Math.max(1, keep); i < files.size(); i++) if (files.get(i).delete()) n++;
        if (n > 0) {
            Map<String, Object> info = info(dir);
            Map<String, Object> counts = Json.asMap(info.get("counts"));
            if (counts != null) {
                List<String> present = new ArrayList<>();
                for (File f : files(dir)) present.add(f.getName());
                counts.keySet().retainAll(present);
                try { writeInfo(dir, info); } catch (IOException e) { /* telling is alleen informatie */ }
            }
        }
        return n;
    }

    static List<File> files(File dir) {
        List<File> out = new ArrayList<>();
        File[] fs = dir.listFiles();
        if (fs == null) return out;
        for (File f : fs) if (f.isFile() && FILE.matcher(f.getName()).matches()) out.add(f);
        // Nieuwste eerst: naam = tijd (+ volgnummer)
        out.sort((a, b) -> {
            int t = Long.compare(timeOf(b.getName()), timeOf(a.getName()));
            return t != 0 ? t : Integer.compare(seq(b.getName()), seq(a.getName()));
        });
        return out;
    }

    private static int seq(String name) {
        String base = name.substring(0, name.length() - 4);
        int dash = base.indexOf('-', 9);
        return dash < 0 ? 0 : Integer.parseInt(base.substring(dash + 1));
    }

    static String stamp(long ms) {
        ZonedDateTime t = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC);
        return String.format(Locale.ROOT, "%04d%02d%02d-%02d%02d%02d", t.getYear(), t.getMonthValue(), t.getDayOfMonth(), t.getHour(), t.getMinute(), t.getSecond());
    }

    static long timeOf(String name) {
        try {
            return ZonedDateTime.of(Integer.parseInt(name.substring(0, 4)), Integer.parseInt(name.substring(4, 6)), Integer.parseInt(name.substring(6, 8)),
                    Integer.parseInt(name.substring(9, 11)), Integer.parseInt(name.substring(11, 13)), Integer.parseInt(name.substring(13, 15)), 0, ZoneOffset.UTC)
                    .toInstant().toEpochMilli();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    private static Map<String, Object> info(File dir) {
        File f = new File(dir, "info.json");
        try {
            Map<String, Object> m = Json.asMap(Json.parse(Bytes.utf8(read(f))));
            if (m != null) return m;
        } catch (IOException | RuntimeException e) {
            // nieuw of beschadigd
        }
        return Json.obj();
    }

    private static void writeInfo(File dir, Map<String, Object> info) throws IOException {
        File tmp = new File(dir, "info.json.tmp");
        try (OutputStream o = new FileOutputStream(tmp)) { o.write(Bytes.utf8(Json.stringify(info))); }
        if (!tmp.renameTo(new File(dir, "info.json"))) { tmp.delete(); throw new IOException("info.json bewaren lukt niet"); }
    }

    private static byte[] read(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) { return Bytes.readAll(in); }
    }

    static long size(File f) {
        if (f.isFile()) return f.length();
        long n = 0;
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) n += size(x);
        return n;
    }
}
