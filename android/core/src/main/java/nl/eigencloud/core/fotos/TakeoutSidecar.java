package nl.eigencloud.core.fotos;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import nl.eigencloud.core.Json;

/**
 * Google Takeout-metadata bij foto's, zoals src/import/photos.ts en src/import/takeout.ts het doen: welk
 * JSON-bestand bij welke foto hoort (Google gebruikt wisselende en afgekapte namen), wat erin staat (datum, plaats,
 * beschrijving, favoriet), welke map een album is, en welke bestanden foto's of video's zijn.
 */
public final class TakeoutSidecar {
    private TakeoutSidecar() {}

    /** Gegevens uit het JSON-bestand naast een foto. Velden zijn null als Google ze niet gaf. */
    public static final class Meta {
        public Long takenAt;
        public Double lat;
        public Double lon;
        public String description;
        public boolean favorite;

        public Map<String, Object> toJson() {
            Map<String, Object> m = Json.obj();
            if (takenAt != null) m.put("t", takenAt);
            if (lat != null) m.put("la", lat);
            if (lon != null) m.put("lo", lon);
            if (description != null) m.put("d", description);
            if (favorite) m.put("f", true);
            return m;
        }

        public static Meta fromJson(Map<String, Object> m) {
            Meta x = new Meta();
            Number t = Json.num(m, "t"), la = Json.num(m, "la"), lo = Json.num(m, "lo");
            x.takenAt = t == null ? null : t.longValue();
            x.lat = la == null ? null : la.doubleValue();
            x.lon = lo == null ? null : lo.doubleValue();
            x.description = Json.str(m, "d");
            x.favorite = Json.truthy(m.get("f"));
            return x;
        }
    }

    private static final java.util.Set<String> IMAGE = new java.util.HashSet<>(java.util.Arrays.asList(
            ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".avif", ".dng", ".bmp"));
    private static final java.util.Set<String> VIDEO = new java.util.HashSet<>(java.util.Arrays.asList(
            ".mp4", ".mov", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".mts"));
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        String[] kv = {".jpg", "image/jpeg", ".jpeg", "image/jpeg", ".png", "image/png", ".gif", "image/gif", ".webp", "image/webp",
                ".heic", "image/heic", ".heif", "image/heif", ".tif", "image/tiff", ".tiff", "image/tiff", ".avif", "image/avif",
                ".dng", "image/x-adobe-dng", ".bmp", "image/bmp", ".mp4", "video/mp4", ".mov", "video/quicktime", ".m4v", "video/mp4",
                ".3gp", "video/3gpp", ".avi", "video/x-msvideo", ".mkv", "video/x-matroska", ".webm", "video/webm", ".mts", "video/mp2t"};
        for (int i = 0; i < kv.length; i += 2) MIME.put(kv[i], kv[i + 1]);
    }

    static String ext(String name) {
        String base = baseName(name);
        int dot = base.lastIndexOf('.');
        return dot <= 0 ? "" : base.substring(dot).toLowerCase(Locale.ROOT);
    }

    static String baseName(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? path : path.substring(slash + 1);
    }

    /** Foto of video volgens dezelfde lijst als isMediaFile in src/photos/store.ts. */
    public static boolean isMedia(String name) { String e = ext(name); return IMAGE.contains(e) || VIDEO.contains(e); }

    public static boolean isVideo(String name) { return VIDEO.contains(ext(name)); }

    public static String mime(String name) {
        String m = MIME.get(ext(name));
        return m == null ? "application/octet-stream" : m;
    }

    /** Herkent Takeout-paden in alle talen die Google gebruikt voor Foto's (PHOTOS_ROOT in takeout.ts). */
    private static final Pattern PHOTOS_ROOT = Pattern.compile("(^|/)(Google Photos|Google Foto's|Google Fotos|Google Foto|Google Photos?)/", Pattern.CASE_INSENSITIVE);
    /** Mappen die Google zelf aanmaakt per jaar — geen echt album. */
    private static final Pattern YEAR_FOLDER = Pattern.compile("^(photos from|foto's van|fotos van|photos de|fotos von) \\d{4}$", Pattern.CASE_INSENSITIVE);
    private static final Pattern SKIP_FOLDER = Pattern.compile("^(trash|prullenbak|archive|archief|bin)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern ROOT_NAMES = Pattern.compile("^(google (photos|foto's)|takeout)$", Pattern.CASE_INSENSITIVE);

    /** Pad binnen "Google Foto's/" (bijv. "Vakantie Italië/IMG_1.jpg"), of null als het geen Foto's-bestand is. */
    public static String photosRel(String zipPath) {
        String name = zipPath.replace('\\', '/');
        if (name.endsWith("/") || name.contains("..")) return null;
        Matcher m = PHOTOS_ROOT.matcher(name);
        if (!m.find()) return null;
        return name.substring(m.end());
    }

    /** Map waarin het bestand staat (binnen Google Foto's), of null als het er direct in staat. */
    public static String folder(String rel) {
        int slash = rel.lastIndexOf('/');
        if (slash < 0) return null;
        String dir = rel.substring(0, slash);
        int prev = dir.lastIndexOf('/');
        return prev < 0 ? dir : dir.substring(prev + 1);
    }

    /** Prullenbak en archief slaat de import over (zoals importTakeoutPhotos). */
    public static boolean skipFolder(String folder) { return folder != null && SKIP_FOLDER.matcher(folder).matches(); }

    /** Albumnaam voor deze map, of null voor jaar-mappen en de hoofdmap. */
    public static String album(String folder) {
        if (folder == null || folder.isEmpty()) return null;
        if (YEAR_FOLDER.matcher(folder).matches() || ROOT_NAMES.matcher(folder).matches()) return null;
        return folder;
    }

    private static final Pattern DUP = Pattern.compile("^(.*)\\((\\d+)\\)(\\.[^.]+)$");
    private static final Pattern EDITED = Pattern.compile("-(edited|bewerkt|bearbeitet|modifié)(?=\\.[^.]+$)", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
    private static final Pattern TRUNC_SUFFIX = Pattern.compile("(\\(\\d+\\))?\\.json$");

    /**
     * Zoekt het JSON-bestand dat Google Takeout naast een foto zet (findSidecar in photos.ts): foto.jpg.json,
     * foto.jpg.supplemental-metadata.json, afgekapte namen (max ~51 tekens), en "foto(1).jpg" ↔ "foto.jpg(1).json".
     */
    public static String find(String media, List<String> jsonsInDir) {
        String name = baseName(media);
        List<String> candidates = new ArrayList<>();
        candidates.add(name);
        Matcher dup = DUP.matcher(name);
        if (dup.matches()) candidates.add(dup.group(1) + dup.group(3) + "(" + dup.group(2) + ")");
        String edited = EDITED.matcher(name).replaceAll("");
        if (!edited.equals(name)) candidates.add(edited);

        for (String c : candidates) {
            for (String j : jsonsInDir) if (j.equals(c + ".json") || j.startsWith(c + ".supplemental") || j.startsWith(c + ".suppl")) return j;
            String longName = c + ".supplemental-metadata";
            for (String j : jsonsInDir) {
                String stem = TRUNC_SUFFIX.matcher(j).replaceAll("");
                if (stem.length() >= 30 && longName.startsWith(stem)) return j;
            }
            int dot = c.lastIndexOf('.');
            String noExt = (dot < 0 ? c : c.substring(0, dot)) + ".json";
            for (String j : jsonsInDir) if (j.equals(noExt)) return j;
        }
        return null;
    }

    /** Leest het JSON-bestand; null als het geen geldige JSON is. */
    public static Meta parse(String json) {
        Map<String, Object> j;
        try {
            j = Json.asMap(Json.parse(json));
        } catch (RuntimeException e) {
            return null;
        }
        if (j == null) return null;
        Meta m = new Meta();
        Object ts = Json.path(j, "photoTakenTime", "timestamp");
        double t = number(ts);
        if (t > 0) m.takenAt = (long) (t * 1000);
        Map<String, Object> geo = Json.map(j, "geoData");
        if (geo == null || number(geo.get("latitude")) == 0 || Double.isNaN(number(geo.get("latitude")))) geo = Json.map(j, "geoDataExif");
        if (geo != null) {
            double la = number(geo.get("latitude")), lo = number(geo.get("longitude"));
            if (la != 0 && lo != 0 && !Double.isNaN(la) && !Double.isNaN(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) { m.lat = la; m.lon = lo; }
        }
        Object d = j.get("description");
        if (d instanceof String && !((String) d).isEmpty()) m.description = (String) d;
        m.favorite = Boolean.TRUE.equals(j.get("favorited"));
        return m;
    }

    /** Getal zoals JavaScript's Number(x): tekst wordt omgezet, de rest is NaN. */
    static double number(Object o) {
        if (o instanceof Number) return ((Number) o).doubleValue();
        if (o instanceof String) {
            try { return Double.parseDouble(((String) o).trim()); } catch (NumberFormatException e) { return Double.NaN; }
        }
        return Double.NaN;
    }
}
