package nl.eigencloud.core;

import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import nl.eigencloud.core.fotos.CloudPhotos;
import nl.eigencloud.core.fotos.TakeoutImport;
import nl.eigencloud.core.fotos.TakeoutSidecar;
import nl.eigencloud.core.fotos.ZipReader;

/**
 * "Uit Google Foto's halen": JSON-bestanden bij foto's vinden en lezen (zelfde regels als src/import/photos.ts),
 * zips lezen (ook ZIP64 en beschadigde bestanden), alle zips doorzoeken, uploaden met hervatten, en de
 * foto-API van de cloud (lijst, download, upload met extra velden, foutsoorten) tegen een nep-cloud.
 */
public class TakeoutTest {
    static File dir;

    public static void main(String[] args) {
        T.main("TakeoutTest", () -> {
            dir = Files.createTempDirectory("takeout").toFile();
            try {
                sidecars();
                zips();
                zip64();
                scanAndRun();
                cloud();
            } finally {
                deleteTree(dir);
            }
        });
    }

    static void sidecars() throws IOException {
        // Dezelfde gevallen als de test van findSidecar in test/smoke.test.ts, plus meer.
        T.eq("a.jpg.json", TakeoutSidecar.find("/x/a.jpg", List.of("a.jpg.json")), "a.jpg.json");
        T.eq("a.jpg.supplemental-metadata.json", TakeoutSidecar.find("/x/a.jpg", List.of("a.jpg.supplemental-metadata.json")), "supplemental-metadata");
        T.eq("a.jpg(2).json", TakeoutSidecar.find("/x/a(2).jpg", List.of("a.jpg(2).json")), "dubbel (2)");
        T.eq("a.jpg.supplemental-metadata.json", TakeoutSidecar.find("/x/a-bewerkt.jpg", List.of("a.jpg.supplemental-metadata.json")), "bewerkt");
        T.eq("IMG_20190101_120000.jpg.supplemental-meta.json", TakeoutSidecar.find("IMG_20190101_120000.jpg", List.of("IMG_20190101_120000.jpg.supplemental-meta.json")), "afgekapt: suppl");
        T.eq("PXL_20230615_101010123.NIGHT.jpg.supplemen.json",
                TakeoutSidecar.find("PXL_20230615_101010123.NIGHT.jpg", List.of("andere.json", "PXL_20230615_101010123.NIGHT.jpg.supplemen.json")), "afgekapt op 51 tekens");
        T.eq("Screenshot_20200202-101112_WhatsAp.json", TakeoutSidecar.find("Screenshot_20200202-101112_WhatsApp.jpg",
                List.of("Screenshot_20200202-101112_WhatsAp.json")), "afgekapte naam (oude stijl, ≥ 30 tekens)");
        T.eq(null, TakeoutSidecar.find("Screenshot_2020-02-02-10-11-12.png", List.of("Screenshot_2020-02-02-10-1.json")), "afgekapt maar < 30 tekens: niet raden");
        // Golden: precies wat findSidecar in src/import/photos.ts zegt (scripts/telefoon-golden.ts).
        Map<String, Object> golden = Json.parseObject(new String(Files.readAllBytes(new File(T.buildDir(), "telefoon-golden.json").toPath()), StandardCharsets.UTF_8));
        List<String> jsons = new ArrayList<>();
        for (Object o : Json.listAt(golden, "sidecars", "jsons")) jsons.add((String) o);
        for (Object o : Json.listAt(golden, "sidecars", "cases")) {
            String media = Json.str(o, "media");
            T.eq(Json.str(o, "json"), TakeoutSidecar.find(media, jsons), "findSidecar(" + media + ") = TypeScript");
        }
        T.eq("foto.json", TakeoutSidecar.find("foto.jpg", List.of("foto.json")), "zonder extensie");
        T.eq("IMG_1-edited.jpg.json", TakeoutSidecar.find("IMG_1-edited.jpg", List.of("IMG_1.jpg.json", "IMG_1-edited.jpg.json")), "eigen JSON gaat vóór die van het origineel");
        T.eq(null, TakeoutSidecar.find("b.jpg", List.of("a.jpg.json", "metadata.json")), "geen JSON");
        T.eq(null, TakeoutSidecar.find("kort.jpg", List.of("kort.j.json")), "korte afgekapte namen niet raden");

        TakeoutSidecar.Meta m = TakeoutSidecar.parse("{\"title\":\"a.jpg\",\"description\":\"Strand\",\"photoTakenTime\":{\"timestamp\":\"1546300800\",\"formatted\":\"1 jan. 2019\"},"
                + "\"geoData\":{\"latitude\":0.0,\"longitude\":0.0},\"geoDataExif\":{\"latitude\":52.37,\"longitude\":4.89},\"favorited\":true}");
        T.eq(1546300800000L, m.takenAt, "datum (seconden als tekst)");
        T.eq(52.37, m.lat, "plaats uit geoDataExif als geoData 0 is");
        T.eq(4.89, m.lon, "lengte");
        T.eq("Strand", m.description, "beschrijving");
        T.check(m.favorite, "favoriet");
        TakeoutSidecar.Meta g = TakeoutSidecar.parse("{\"photoTakenTime\":{\"timestamp\":0},\"geoData\":{\"latitude\":51.92,\"longitude\":4.48},\"description\":\"\"}");
        T.check(g.takenAt == null && g.lat == 51.92 && g.description == null && !g.favorite, "geen datum, geoData, lege beschrijving");
        T.check(TakeoutSidecar.parse("{\"geoData\":{\"latitude\":52.1,\"longitude\":0}}").lat == null, "lengte 0: geen plaats (zoals photos.ts)");
        T.eq(null, TakeoutSidecar.parse("{kapot"), "kapotte JSON");
        T.eq(null, TakeoutSidecar.parse("[1]"), "geen object");

        T.eq("Vakantie Italië/IMG_1.jpg", TakeoutSidecar.photosRel("Takeout/Google Foto's/Vakantie Italië/IMG_1.jpg"), "pad binnen Google Foto's");
        T.eq("Photos from 2019/a.jpg", TakeoutSidecar.photosRel("Takeout/Google Photos/Photos from 2019/a.jpg"), "Engels");
        T.eq(null, TakeoutSidecar.photosRel("Takeout/Mail/Alle mail.mbox"), "mail");
        T.eq(null, TakeoutSidecar.photosRel("Takeout/Google Foto's/../../etc/passwd"), "geen ..");
        T.eq("Vakantie Italië", TakeoutSidecar.folder("Vakantie Italië/IMG_1.jpg"), "map");
        T.eq(null, TakeoutSidecar.folder("IMG_1.jpg"), "direct in de hoofdmap");
        T.eq("Vakantie Italië", TakeoutSidecar.album("Vakantie Italië"), "album");
        T.eq(null, TakeoutSidecar.album("Photos from 2019"), "jaarmap is geen album");
        T.eq(null, TakeoutSidecar.album("Foto's van 2021"), "jaarmap (NL)");
        T.eq(null, TakeoutSidecar.album("Google Photos"), "hoofdmap");
        T.check(TakeoutSidecar.skipFolder("Prullenbak") && TakeoutSidecar.skipFolder("Archive") && !TakeoutSidecar.skipFolder("Album"), "prullenbak/archief overslaan");
        T.check(TakeoutSidecar.isMedia("A.HEIC") && TakeoutSidecar.isMedia("v.MTS") && !TakeoutSidecar.isMedia("a.json") && !TakeoutSidecar.isMedia("x.html"), "media herkennen");
        T.eq("video/quicktime", TakeoutSidecar.mime("b.MOV"), "mime");
    }

    static File zipFile(String name, Object... entries) throws IOException {
        File f = new File(dir, name);
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(f))) {
            for (int i = 0; i < entries.length; i += 2) {
                String n = (String) entries[i];
                byte[] data = entries[i + 1] instanceof String ? ((String) entries[i + 1]).getBytes(StandardCharsets.UTF_8) : (byte[]) entries[i + 1];
                ZipEntry e = new ZipEntry(n);
                if (n.endsWith(".jpg") || n.endsWith(".mp4")) {
                    // Zoals Takeout: foto's opgeslagen (niet ingepakt)
                    e.setMethod(ZipEntry.STORED);
                    e.setSize(data.length);
                    CRC32 c = new CRC32();
                    c.update(data);
                    e.setCrc(c.getValue());
                }
                e.setTime(1_600_000_000_000L);
                z.putNextEntry(e);
                z.write(data);
                z.closeEntry();
            }
        }
        return f;
    }

    static byte[] bytes(int n, int seed) {
        byte[] b = new byte[n];
        new java.util.Random(seed).nextBytes(b);
        return b;
    }

    static byte[] readAll(InputStream in) throws IOException { return Bytes.readAll(in); }

    static void zips() throws IOException {
        byte[] photo = bytes(300_000, 1);
        File f = zipFile("gewoon.zip", "Takeout/Google Foto's/Album/a.jpg", photo, "Takeout/Google Foto's/Album/a.jpg.json", "{\"x\":1}",
                "Takeout/Google Foto's/Album/üñí €.txt", "tekst ".repeat(10_000));
        try (FileChannel ch = FileChannel.open(f.toPath(), StandardOpenOption.READ); ZipReader z = new ZipReader(ch)) {
            T.eq(3, z.entries().size(), "drie bestanden");
            T.eq("Takeout/Google Foto's/Album/üñí €.txt", z.entries().get(2).name, "UTF-8-naam");
            T.check(java.util.Arrays.equals(photo, readAll(z.open(z.entries().get(0)))), "opgeslagen bestand gelijk");
            T.eq("tekst ".repeat(10_000), new String(readAll(z.open(z.entries().get(2))), StandardCharsets.UTF_8), "ingepakt bestand (met data descriptor) gelijk");
            // Willekeurige volgorde, twee tegelijk open
            InputStream x = z.open(z.entries().get(2)), y = z.open(z.entries().get(0));
            byte[] bx = new byte[10];
            T.eq(10, x.read(bx), "deels lezen");
            T.check(java.util.Arrays.equals(photo, readAll(y)), "tweede tegelijk");
            x.close();
            // DOS-tijd heeft geen tijdzone (Java schrijft lokale tijd, wij lezen UTC): binnen een halve dag en op 2 s.
            long when = z.entries().get(0).time;
            T.check(Math.abs(when - 1_600_000_000_000L) <= 14 * 3_600_000L && when % 2000 == 0, "tijd uit de zip: " + when);
        }
        // Beschadigd: één byte van de foto veranderd → CRC-fout bij lezen, de rest blijft leesbaar.
        byte[] raw = Files.readAllBytes(f.toPath());
        int at = indexOf(raw, photo, 0) + 1000;
        raw[at] ^= 0x55;
        File broken = new File(dir, "kapot.zip");
        Files.write(broken.toPath(), raw);
        try (FileChannel ch = FileChannel.open(broken.toPath(), StandardOpenOption.READ); ZipReader z = new ZipReader(ch)) {
            T.throwsWith("CRC", () -> readAll(z.open(z.entries().get(0))), "beschadigde foto valt op");
            T.eq("{\"x\":1}", new String(readAll(z.open(z.entries().get(1))), StandardCharsets.UTF_8), "rest leesbaar");
        }
        // Afgebroken download: geen einde van de zip
        File half = new File(dir, "half.zip");
        Files.write(half.toPath(), java.util.Arrays.copyOf(raw, raw.length / 2));
        T.throwsWith("Is het downloaden klaar", () -> new ZipReader(FileChannel.open(half.toPath(), StandardOpenOption.READ)), "halve zip");
        File none = new File(dir, "niet.zip");
        Files.write(none.toPath(), "geen zip".getBytes(StandardCharsets.UTF_8));
        T.throwsWith("geen zip", () -> new ZipReader(FileChannel.open(none.toPath(), StandardOpenOption.READ)), "geen zip");
    }

    static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < 64; j++) if (hay[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    /** Met de hand gemaakte ZIP64 (zoals bij een Takeout van meer dan 4 GB): echte waarden in de ZIP64-extra. */
    static void zip64() throws IOException {
        byte[] data = "inhoud van een foto achter de 4 GB-grens".getBytes(StandardCharsets.UTF_8);
        byte[] name = "Takeout/Google Photos/groot.jpg".getBytes(StandardCharsets.UTF_8);
        CRC32 crc = new CRC32();
        crc.update(data);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteBuffer lh = le(30 + name.length + 20);
        lh.putInt(0x04034b50).putShort((short) 45).putShort((short) 0x0800).putShort((short) 0).putInt(0).putInt((int) crc.getValue())
                .putInt(0xffffffff).putInt(0xffffffff).putShort((short) name.length).putShort((short) 20).put(name)
                .putShort((short) 1).putShort((short) 16).putLong(data.length).putLong(data.length);
        out.write(lh.array());
        out.write(data);
        long cdOffset = out.size();
        ByteBuffer cd = le(46 + name.length + 28);
        cd.putInt(0x02014b50).putShort((short) 45).putShort((short) 45).putShort((short) 0x0800).putShort((short) 0).putInt(0).putInt((int) crc.getValue())
                .putInt(0xffffffff).putInt(0xffffffff).putShort((short) name.length).putShort((short) 28).putShort((short) 0).putShort((short) 0).putShort((short) 0).putInt(0)
                .putInt(0xffffffff).put(name)
                .putShort((short) 1).putShort((short) 24).putLong(data.length).putLong(data.length).putLong(0);
        out.write(cd.array());
        long cdSize = out.size() - cdOffset;
        long z64 = out.size();
        ByteBuffer rec = le(56);
        rec.putInt(0x06064b50).putLong(44).putShort((short) 45).putShort((short) 45).putInt(0).putInt(0).putLong(1).putLong(1).putLong(cdSize).putLong(cdOffset);
        out.write(rec.array());
        ByteBuffer loc = le(20);
        loc.putInt(0x07064b50).putInt(0).putLong(z64).putInt(1);
        out.write(loc.array());
        ByteBuffer end = le(22);
        end.putInt(0x06054b50).putShort((short) 0).putShort((short) 0).putShort((short) 0xffff).putShort((short) 0xffff).putInt(0xffffffff).putInt(0xffffffff).putShort((short) 0);
        out.write(end.array());
        File f = new File(dir, "zip64.zip");
        Files.write(f.toPath(), out.toByteArray());
        try (FileChannel ch = FileChannel.open(f.toPath(), StandardOpenOption.READ); ZipReader z = new ZipReader(ch)) {
            T.eq(1, z.entries().size(), "ZIP64: één bestand");
            T.eq((long) data.length, z.entries().get(0).size, "ZIP64: grootte uit de extra");
            T.check(java.util.Arrays.equals(data, readAll(z.open(z.entries().get(0)))), "ZIP64: inhoud");
        }
        // Meer dan 65535 bestanden: Java schrijft dan zelf een ZIP64-einde.
        File many = new File(dir, "veel.zip");
        try (ZipOutputStream zo = new ZipOutputStream(new java.io.BufferedOutputStream(new FileOutputStream(many)))) {
            zo.setLevel(0);
            for (int i = 0; i < 66_000; i++) { zo.putNextEntry(new ZipEntry("f/" + i)); zo.write(i & 0xff); zo.closeEntry(); }
        }
        try (FileChannel ch = FileChannel.open(many.toPath(), StandardOpenOption.READ); ZipReader z = new ZipReader(ch)) {
            T.eq(66_000, z.entries().size(), "66.000 bestanden (ZIP64-einde)");
            T.eq(65_999 & 0xff, z.open(z.entries().get(65_999)).read(), "laatste bestand leesbaar");
        }
    }

    static ByteBuffer le(int n) { return ByteBuffer.allocate(n).order(ByteOrder.LITTLE_ENDIAN); }

    static final class FileSource implements TakeoutImport.Source {
        final File f;

        FileSource(File f) { this.f = f; }

        @Override public String name() { return f.getName(); }

        @Override public long size() { return f.length(); }

        @Override public SeekableByteChannel open() throws IOException { return FileChannel.open(f.toPath(), StandardOpenOption.READ); }
    }

    static void scanAndRun() throws Exception {
        byte[] a = bytes(1000, 2), b = bytes(2000, 3), c = bytes(1500, 4), v = bytes(5000, 5), t = bytes(100, 6);
        // Google zet de JSON van b.jpg in de tweede zip; prullenbak wordt overgeslagen; mail en agenda tellen apart.
        File z1 = zipFile("takeout-001.zip",
                "Takeout/Google Foto's/Vakantie Italië/a.jpg", a,
                "Takeout/Google Foto's/Vakantie Italië/a.jpg.supplemental-metadata.json", "{\"photoTakenTime\":{\"timestamp\":\"1546300800\"},\"geoData\":{\"latitude\":41.9,\"longitude\":12.5},\"favorited\":true}",
                "Takeout/Google Foto's/Photos from 2019/b.jpg", b,
                "Takeout/Google Foto's/Prullenbak/weg.jpg", t,
                "Takeout/Mail/Alle mail.mbox", "From x",
                "Takeout/Agenda/rene@example.com.ics", "BEGIN:VCALENDAR");
        File z2 = zipFile("takeout-002.zip",
                "Takeout/Google Foto's/Photos from 2019/b.jpg.json", "{\"photoTakenTime\":{\"timestamp\":\"1556700000\"},\"description\":\"Zon\"}",
                "Takeout/Google Foto's/Photos from 2019/c(1).jpg", c,
                "Takeout/Google Foto's/Photos from 2019/c.jpg(1).json", "{\"photoTakenTime\":{\"timestamp\":\"1556800000\"}}",
                "Takeout/Google Foto's/film.mp4", v,
                "Takeout/Google Foto's/kapot.jpg.json", "{kapot");
        List<FileSource> src = List.of(new FileSource(z1), new FileSource(z2));
        TakeoutImport.Scan s = TakeoutImport.scan(src, null);
        T.eq(4, s.items.size(), "vier foto's/video's (prullenbak overgeslagen)");
        T.eq(1, s.skipped, "één overgeslagen");
        T.eq(2, s.otherGoogle, "mail en agenda gezien");
        T.eq(3, s.withMeta, "drie met gegevens van Google (ook over zips heen)");
        T.eq(4, s.jsonFiles, "vier JSON-bestanden gelezen");
        T.eq((long) (a.length + b.length + c.length + v.length), s.bytes, "totale grootte");
        TakeoutImport.Item ia = s.items.get(0), ib = s.items.get(1), ic = s.items.get(2), iv = s.items.get(3);
        T.eq("Vakantie Italië", ia.album, "album");
        T.check(ia.meta.favorite && ia.meta.lat == 41.9 && ia.meta.takenAt == 1546300800000L, "gegevens a");
        T.eq(null, ib.album, "jaarmap geen album");
        T.eq("Zon", ib.meta.description, "JSON uit andere zip");
        T.eq(1556800000000L, ic.meta.takenAt, "c(1).jpg ↔ c.jpg(1).json");
        T.eq(null, iv.meta, "video zonder JSON");
        T.eq("video/mp4", iv.mime, "mime video");
        T.check(iv.zipTime > 0 && iv.lastModified() == iv.zipTime, "zonder Google-datum: tijd uit de zip");
        // Bewaren en terugladen
        TakeoutImport.Scan s2 = TakeoutImport.Scan.fromJson(Json.parseObject(Json.stringify(s.toJson())));
        T.eq(Json.stringify(s.toJson()), Json.stringify(s2.toJson()), "doorzoeking bewaren en teruglezen");
        T.check(s2.matches(src), "past bij dezelfde zips");
        T.check(!s2.matches(List.of(new FileSource(z2), new FileSource(z1))), "andere volgorde past niet");

        // Uploaden: na twee bestanden een verbindingsfout, daarna verder waar het was.
        List<String> uploaded = new ArrayList<>();
        int[] failAfter = {2};
        TakeoutImport.Uploader up = (item, in) -> {
            byte[] data = readAll(in);
            if (failAfter[0]-- == 0) throw new TakeoutImport.Retry("Geen verbinding met je cloud, later verder");
            uploaded.add(item.name + ":" + data.length);
            if (item.name.equals("c(1).jpg")) return TakeoutImport.Result.ok(true);
            return TakeoutImport.Result.ok(false);
        };
        TakeoutImport.State st = TakeoutImport.run(src, s2, new TakeoutImport.State(), up, null, Long.MAX_VALUE, null);
        T.eq(2, st.position, "gestopt na twee");
        T.eq("Geen verbinding met je cloud, later verder", st.waiting, "wacht op verbinding");
        st = TakeoutImport.State.fromJson(Json.parseObject(Json.stringify(st.toJson())));
        List<Integer> seen = new ArrayList<>();
        st = TakeoutImport.run(src, s2, st, up, null, Long.MAX_VALUE, (state, item) -> seen.add(state.position));
        T.check(st.done(s2) && st.waiting == null && st.fatal == null, "klaar");
        T.eq(List.of("a.jpg:1000", "b.jpg:2000", "c(1).jpg:1500", "film.mp4:5000"), uploaded, "elk bestand één keer, volledig");
        T.eq(3, st.added, "drie nieuw");
        T.eq(1, st.duplicates, "één stond er al");
        T.eq(List.of(2, 3, 4), seen, "voortgang");
        // Gestopt door de gebruiker, en de tijd op
        T.eq("Gepauzeerd", TakeoutImport.run(src, s2, new TakeoutImport.State(), up, () -> true, Long.MAX_VALUE, null).waiting, "pauzeren");
        T.eq("Later verder", TakeoutImport.run(src, s2, new TakeoutImport.State(), up, null, 0, null).waiting, "tijd op");
        // Een geweigerd bestand telt als mislukt, de rest gaat door.
        TakeoutImport.State st2 = TakeoutImport.run(src, s2, new TakeoutImport.State(), (item, in) -> item.name.equals("b.jpg") ? TakeoutImport.Result.failed("Geen foto of video") : TakeoutImport.Result.ok(false),
                null, Long.MAX_VALUE, null);
        T.check(st2.failed == 1 && st2.added == 3 && "b.jpg: Geen foto of video".equals(st2.lastError), "mislukt bestand overgeslagen");
        // Zip weg → kan niet verder
        File gone = new File(dir, "weg.zip");
        Files.copy(z2.toPath(), gone.toPath());
        List<FileSource> src3 = List.of(new FileSource(z1), new FileSource(gone));
        TakeoutImport.Scan s3 = TakeoutImport.scan(src3, null);
        gone.delete();
        TakeoutImport.State st3 = TakeoutImport.run(src3, s3, new TakeoutImport.State(), (item, in) -> TakeoutImport.Result.ok(false), null, Long.MAX_VALUE, null);
        T.check(st3.fatal != null && st3.fatal.contains("veranderd"), "verdwenen zip: opnieuw kiezen (" + st3.fatal + ")");
    }

    /** Nep-cloud met /api/photos, /thumb, /original, /upload en /api/capabilities. */
    static void cloud() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<Map<String, Object>> photos = new ArrayList<>();
        for (int i = 1; i <= 1200; i++) photos.add(Json.obj("id", 2000 - i, "filename", "IMG_" + i + ".jpg", "mime", "image/jpeg", "taken_at", 1_700_000_000_000L - i * 60_000L,
                "is_video", i % 100 == 0 ? 1 : 0, "has_thumb", 1, "width", 4000, "height", 3000));
        List<Map<String, String>> uploads = new ArrayList<>();
        int[] status = {200};
        server.createContext("/api/photos", ex -> {
            String auth = ex.getRequestHeaders().getFirst("authorization");
            String path = ex.getRequestURI().getPath();
            byte[] body;
            int code = 200;
            if (!"Bearer geheim".equals(auth)) { code = 401; body = "{\"error\":\"Log in\"}".getBytes(StandardCharsets.UTF_8); }
            else if (path.equals("/api/photos")) {
                Map<String, String> q = query(ex.getRequestURI().getRawQuery());
                int limit = Integer.parseInt(q.get("limit"));
                List<Object> page = new ArrayList<>();
                for (Map<String, Object> p : photos) {
                    long t = ((Number) p.get("taken_at")).longValue(), id = ((Number) p.get("id")).longValue();
                    if (q.containsKey("before") && !(t < Long.parseLong(q.get("before")) || (t == Long.parseLong(q.get("before")) && id < Long.parseLong(q.get("beforeId"))))) continue;
                    if (page.size() < limit) page.add(p);
                }
                body = Json.stringify(page).getBytes(StandardCharsets.UTF_8);
            } else if (path.endsWith("/thumb")) body = "MINI".getBytes(StandardCharsets.UTF_8);
            else if (path.endsWith("/original")) {
                if (path.contains("/999/")) { code = 404; body = new byte[0]; } else body = bytes(100_000, 7);
            } else if (path.equals("/api/photos/upload")) {
                String ct = ex.getRequestHeaders().getFirst("content-type");
                Map<String, String> fields = multipart(readAll(ex.getRequestBody()), ct.substring(ct.indexOf("boundary=") + 9));
                uploads.add(fields);
                code = status[0];
                body = (code == 200 ? "[{\"filename\":\"" + fields.get("filename") + "\",\"id\":5,\"duplicate\":" + "dubbel.jpg".equals(fields.get("filename")) + "}]"
                        : code == 400 ? "{\"error\":\"Geen foto of video\"}" : "{\"error\":\"x\"}").getBytes(StandardCharsets.UTF_8);
            } else { code = 404; body = new byte[0]; }
            ex.sendResponseHeaders(code, body.length == 0 ? -1 : body.length);
            if (body.length > 0) try (OutputStream o = ex.getResponseBody()) { o.write(body); }
            ex.close();
        });
        server.start();
        try {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            CloudPhotos api = new CloudPhotos(base + "/", "geheim");
            List<CloudPhotos.Photo> all = api.all(null);
            T.eq(1200, all.size(), "hele tijdlijn in pagina's van 500");
            T.eq(1999L, all.get(0).id, "nieuwste eerst");
            T.check(all.get(99).video && !all.get(0).video && all.get(0).thumb && all.get(0).width == 4000, "velden");
            T.eq(Json.stringify(all.get(5).toJson()), Json.stringify(CloudPhotos.Photo.fromJson(all.get(5).toJson()).toJson()), "compact bewaren");
            File mini = new File(dir, "m.webp"), big = new File(dir, "o.jpg");
            T.eq(4L, api.download(1999, true, mini), "miniatuur");
            T.eq(100_000L, api.download(1999, false, big), "origineel");
            T.check(big.length() == 100_000 && !new File(big.getPath() + ".deel").exists(), "zonder tijdelijk bestand");
            T.throwsWith("Niet (meer)", () -> api.download(999, false, new File(dir, "x")), "404");
            T.throwsWith("Log opnieuw in", () -> new CloudPhotos(base, "fout").page(null, null, 10), "401: opnieuw inloggen");
            T.check(isRetry(() -> new CloudPhotos(base, "fout").page(null, null, 10)), "401 is tijdelijk (later verder)");

            CloudPhotos.Extra x = new CloudPhotos.Extra();
            x.takenAt = 1546300800000L; x.lat = 41.9; x.lon = 12.5; x.description = "Zon, zee\nen strand"; x.favorite = true; x.album = "Vakantie Italië";
            Map<String, Object> r = api.upload("a\"b.jpg", "image/jpeg", 1546300800000L, x, new ByteArrayInputStream(bytes(1000, 9)), 1000);
            T.eq(5L, Json.num(r, "id").longValue(), "upload: id");
            Map<String, String> f = uploads.get(0);
            T.eq("a_b.jpg", f.get("filename"), "bestandsnaam veilig");
            T.eq("1546300800000", f.get("lastModified"), "lastModified");
            T.eq("1546300800000", f.get("takenAt"), "takenAt");
            T.eq("41.9", f.get("lat"), "lat");
            T.eq("12.5", f.get("lon"), "lon");
            T.eq("Zon, zee\nen strand", f.get("description"), "beschrijving");
            T.eq("1", f.get("favorite"), "favoriet");
            T.eq("Vakantie Italië", f.get("album"), "album (UTF-8)");
            T.eq("1000", f.get("filesize"), "bestand compleet");
            T.eq(List.of("lastModified", "takenAt", "lat", "lon", "description", "favorite", "album", "file"), List.of(f.get("order").split(",")), "velden vóór het bestand");
            api.upload("zonder.jpg", "image/jpeg", 1L, null, new ByteArrayInputStream(new byte[10]), -1);
            T.eq("1", uploads.get(1).get("lastModified"), "zonder extra velden");
            T.check(!uploads.get(1).containsKey("takenAt"), "geen takenAt zonder gegevens");
            T.eq("10", uploads.get(1).get("filesize"), "chunked (onbekende grootte)");

            status[0] = 400;
            T.eq("Geen foto of video", Json.str(api.upload("x.jpg", "image/jpeg", 1L, null, new ByteArrayInputStream(new byte[3]), 3), "error"), "400: fout voor dit bestand");
            status[0] = 413;
            T.eq("Te groot voor je cloud", Json.str(api.upload("x.jpg", "image/jpeg", 1L, null, new ByteArrayInputStream(new byte[3]), 3), "error"), "413");
            status[0] = 503;
            T.check(isRetry(() -> api.upload("x.jpg", "image/jpeg", 1L, null, new ByteArrayInputStream(new byte[3]), 3)), "503: later opnieuw");
            status[0] = 200;
            InputStream broken = new InputStream() {
                int n;
                @Override public int read() throws IOException { if (n++ > 5) throw new java.util.zip.ZipException("x.jpg is beschadigd (CRC)"); return 1; }
            };
            try {
                api.upload("x.jpg", "image/jpeg", 1L, null, broken, -1);
                T.check(false, "kapotte invoer moet fout geven");
            } catch (CloudPhotos.InputFailed e) {
                T.check(e.getMessage().contains("CRC"), "kapotte invoer: InputFailed, geen Retry");
            }
            // Uploader voor de Takeout-import: dubbel en nieuw
            TakeoutImport.Item it = new TakeoutImport.Item();
            it.name = "dubbel.jpg"; it.mime = "image/jpeg"; it.size = 4; it.album = "A";
            T.check(api.takeoutUploader().upload(it, new ByteArrayInputStream(new byte[4])).duplicate, "dubbel herkend");
        } finally {
            server.stop(0);
        }
        // Geen cloud op dit adres: tijdelijk probleem
        T.check(isRetry(() -> new CloudPhotos("http://127.0.0.1:1", "x").page(null, null, 1)), "geen verbinding: later verder");
    }

    static boolean isRetry(T.ThrowingRunnable r) {
        try { r.run(); return false; } catch (TakeoutImport.Retry e) { return true; } catch (Exception e) { System.out.println("    (geen Retry maar " + e + ")"); return false; }
    }

    static Map<String, String> query(String q) {
        Map<String, String> m = new LinkedHashMap<>();
        if (q == null) return m;
        for (String p : q.split("&")) { int eq = p.indexOf('='); m.put(p.substring(0, eq), p.substring(eq + 1)); }
        return m;
    }

    /** Minimale multipart-lezer voor de nep-cloud: velden, bestandsnaam, bestandsgrootte en volgorde. */
    static Map<String, String> multipart(byte[] body, String boundary) {
        Map<String, String> out = new LinkedHashMap<>();
        String text = new String(body, StandardCharsets.ISO_8859_1);
        List<String> order = new ArrayList<>();
        for (String part : text.split("--" + java.util.regex.Pattern.quote(boundary))) {
            int sep = part.indexOf("\r\n\r\n");
            if (sep < 0) continue;
            String head = part.substring(0, sep);
            String value = part.substring(sep + 4);
            if (value.endsWith("\r\n")) value = value.substring(0, value.length() - 2);
            java.util.regex.Matcher n = java.util.regex.Pattern.compile("name=\"([^\"]*)\"").matcher(head);
            if (!n.find()) continue;
            order.add(n.group(1));
            if (n.group(1).equals("file")) {
                java.util.regex.Matcher fn = java.util.regex.Pattern.compile("filename=\"([^\"]*)\"").matcher(head);
                if (fn.find()) out.put("filename", new String(fn.group(1).getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8));
                out.put("filesize", String.valueOf(value.length()));
            } else out.put(n.group(1), new String(value.getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8));
        }
        out.put("order", String.join(",", order));
        return out;
    }

    static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) deleteTree(x);
        f.delete();
    }
}
