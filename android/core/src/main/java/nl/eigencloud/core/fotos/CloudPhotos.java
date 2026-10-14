package nl.eigencloud.core.fotos;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * De foto-API van je cloud (src/photos/routes.ts), met het sessie-token van de app als Bearer-token:
 * de tijdlijn ophalen ({@code GET /api/photos}, nieuwste eerst, per 500), miniatuur en origineel downloaden, en
 * uploaden ({@code POST /api/photos/upload}) met de gegevens uit Google Takeout als extra velden.
 */
public final class CloudPhotos {
    private final String base;
    private final String token;

    public CloudPhotos(String base, String token) {
        this.base = base.replaceAll("/+$", "");
        this.token = token;
    }

    /** Niet (meer) ingelogd: later verder, na opnieuw inloggen in de app. */
    public static final class Unauthorized extends TakeoutImport.Retry {
        private static final long serialVersionUID = 1L;

        public Unauthorized() { super("Log opnieuw in in de app"); }
    }

    /** Fout bij het lezen van het bestand dat geüpload wordt (niet bij de verbinding). */
    public static final class InputFailed extends IOException {
        private static final long serialVersionUID = 1L;

        InputFailed(IOException cause) { super(cause.getMessage(), cause); }
    }

    public static final class Photo {
        public long id;
        public long takenAt;
        public String filename;
        public String mime;
        public boolean video;
        public boolean thumb;
        public int width;
        public int height;

        public Map<String, Object> toJson() {
            Map<String, Object> m = Json.obj("i", id, "t", takenAt, "f", filename);
            if (mime != null) m.put("m", mime);
            if (video) m.put("v", 1);
            if (thumb) m.put("h", 1);
            if (width > 0) m.put("w", width);
            if (height > 0) m.put("g", height);
            return m;
        }

        public static Photo fromJson(Map<String, Object> m) {
            Photo p = new Photo();
            p.id = Json.num(m, "i").longValue();
            p.takenAt = Json.num(m, "t").longValue();
            p.filename = Json.str(m, "f");
            p.mime = Json.str(m, "m");
            p.video = m.get("v") != null;
            p.thumb = m.get("h") != null;
            Number w = Json.num(m, "w"), g = Json.num(m, "g");
            p.width = w == null ? 0 : w.intValue();
            p.height = g == null ? 0 : g.intValue();
            return p;
        }
    }

    static Photo fromApi(Map<String, Object> r) {
        Photo p = new Photo();
        p.id = Json.num(r, "id").longValue();
        Number t = Json.num(r, "taken_at");
        p.takenAt = t == null ? 0 : t.longValue();
        p.filename = Json.str(r, "filename");
        p.mime = Json.str(r, "mime");
        p.video = Json.truthy(r.get("is_video"));
        p.thumb = Json.truthy(r.get("has_thumb"));
        Number w = Json.num(r, "width"), h = Json.num(r, "height");
        p.width = w == null ? 0 : w.intValue();
        p.height = h == null ? 0 : h.intValue();
        return p;
    }

    /** Eén pagina van de tijdlijn, nieuwste eerst; {@code before}/{@code beforeId} = het laatste van de vorige pagina. */
    public List<Photo> page(Long before, Long beforeId, int limit) throws IOException {
        String q = "/api/photos?limit=" + limit + (before != null ? "&before=" + before + "&beforeId=" + beforeId : "");
        Object json = Json.parse(Bytes.utf8(get(q)));
        List<Object> rows = Json.asList(json);
        if (rows == null) throw new IOException("Onverwacht antwoord van /api/photos");
        List<Photo> out = new ArrayList<>();
        for (Object o : rows) {
            Map<String, Object> r = Json.asMap(o);
            if (r != null && Json.num(r, "id") != null) out.add(fromApi(r));
        }
        return out;
    }

    /** De hele tijdlijn (alle pagina's). */
    public List<Photo> all(TakeoutImport.Cancel cancel) throws IOException {
        List<Photo> out = new ArrayList<>();
        Long before = null, beforeId = null;
        while (true) {
            if (cancel != null && cancel.cancelled()) throw new TakeoutImport.Retry("Gestopt");
            List<Photo> page = page(before, beforeId, 500);
            out.addAll(page);
            if (page.size() < 500) return out;
            Photo last = page.get(page.size() - 1);
            before = last.takenAt;
            beforeId = last.id;
            if (out.size() > 2_000_000) throw new IOException("Te veel foto's");
        }
    }

    /** Miniatuur ({@code thumb}) of origineel naar {@code dest} (eerst naar een tijdelijk bestand). Geeft het aantal bytes. */
    public long download(long id, boolean thumb, File dest) throws IOException {
        HttpURLConnection c = open("/api/photos/" + id + (thumb ? "/thumb" : "/original"), "GET");
        try {
            int status = status(c);
            if (status == 404) throw new java.io.FileNotFoundException("Niet (meer) in je cloud");
            if (status >= 300) { drain(c); throw problem(status, "Downloaden"); }
            File tmp = new File(dest.getPath() + ".deel");
            long n = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024];
                for (int r; (r = in.read(buf)) > 0; ) { out.write(buf, 0, r); n += r; }
            } catch (IOException e) {
                tmp.delete();
                throw network(e);
            }
            if (!tmp.renameTo(dest)) { tmp.delete(); throw new IOException("Bewaren op de telefoon lukt niet"); }
            return n;
        } finally {
            c.disconnect();
        }
    }

    /** Extra gegevens bij een upload (uit Google Takeout). */
    public static final class Extra {
        public Long takenAt;
        public Double lat;
        public Double lon;
        public String description;
        public boolean favorite;
        public String album;

        public static Extra of(TakeoutSidecar.Meta m, String album) {
            Extra x = new Extra();
            if (m != null) { x.takenAt = m.takenAt; x.lat = m.lat; x.lon = m.lon; x.description = m.description; x.favorite = m.favorite; }
            x.album = album;
            return x;
        }
    }

    /** Multipart-kop met de velden vóór het bestand (de cloud leest velden die vóór het bestand staan). */
    public static byte[] multipartHead(String boundary, String filename, String mime, long lastModified, Extra x) {
        StringBuilder b = new StringBuilder();
        field(b, boundary, "lastModified", String.valueOf(lastModified));
        if (x != null) {
            if (x.takenAt != null) field(b, boundary, "takenAt", String.valueOf(x.takenAt));
            if (x.lat != null && x.lon != null) { field(b, boundary, "lat", String.valueOf(x.lat)); field(b, boundary, "lon", String.valueOf(x.lon)); }
            if (x.description != null && !x.description.isEmpty()) field(b, boundary, "description", x.description);
            if (x.favorite) field(b, boundary, "favorite", "1");
            if (x.album != null && !x.album.isEmpty()) field(b, boundary, "album", x.album);
        }
        String safe = filename.replaceAll("[\"\\r\\n]", "_");
        b.append("--").append(boundary).append("\r\nContent-Disposition: form-data; name=\"file\"; filename=\"").append(safe)
                .append("\"\r\nContent-Type: ").append(mime == null ? "application/octet-stream" : mime).append("\r\n\r\n");
        return Bytes.utf8(b.toString());
    }

    private static void field(StringBuilder b, String boundary, String name, String value) {
        b.append("--").append(boundary).append("\r\nContent-Disposition: form-data; name=\"").append(name).append("\"\r\n\r\n")
                .append(value.replace("--" + boundary, "- -" + boundary)).append("\r\n");
    }

    /**
     * Uploadt één bestand (gestreamd). Geeft de regel uit het antwoord ({@code {filename, id, duplicate}} of
     * {@code {error}}). Gooit {@link TakeoutImport.Retry} bij verbindingsproblemen of als de cloud even niet kan,
     * {@link InputFailed} als het bestand zelf niet te lezen is.
     */
    public Map<String, Object> upload(String filename, String mime, long lastModified, Extra extra, InputStream in, long size) throws IOException {
        String boundary = "eigen" + Bytes.hex(Bytes.random(12));
        byte[] head = multipartHead(boundary, filename, mime, lastModified, extra);
        byte[] tail = Bytes.utf8("\r\n--" + boundary + "--\r\n");
        HttpURLConnection c = open("/api/photos/upload", "POST");
        try {
            c.setDoOutput(true);
            c.setReadTimeout(300_000);
            c.setRequestProperty("content-type", "multipart/form-data; boundary=" + boundary);
            if (size >= 0) c.setFixedLengthStreamingMode(head.length + size + tail.length);
            else c.setChunkedStreamingMode(256 * 1024);
            try (OutputStream os = c.getOutputStream()) {
                os.write(head);
                byte[] buf = new byte[256 * 1024];
                while (true) {
                    int n;
                    try { n = in.read(buf); } catch (IOException e) { throw new InputFailed(e); }
                    if (n < 0) break;
                    os.write(buf, 0, n);
                }
                os.write(tail);
            } catch (InputFailed e) {
                throw e;
            } catch (IOException e) {
                throw network(e);
            }
            int status = status(c);
            String text;
            try (InputStream rin = status >= 400 ? c.getErrorStream() : c.getInputStream()) {
                text = rin == null ? "" : Bytes.utf8(Bytes.readAll(rin));
            } catch (IOException e) {
                throw network(e);
            }
            if (status == 413) return Json.obj("filename", filename, "error", "Te groot voor je cloud");
            if (status >= 300) {
                IOException p = problem(status, "Uploaden");
                if (p instanceof TakeoutImport.Retry) throw p;
                String msg = null;
                try { msg = Json.str(Json.parse(text), "error"); } catch (RuntimeException ignored) { /* geen JSON */ }
                return Json.obj("filename", filename, "error", msg != null ? msg : "Geweigerd (" + status + ")");
            }
            List<Object> l = Json.asList(Json.parse(text));
            return l != null && !l.isEmpty() && Json.asMap(l.get(0)) != null ? Json.asMap(l.get(0)) : Json.obj("filename", filename, "error", "Onverwacht antwoord");
        } finally {
            c.disconnect();
        }
    }

    /** Uploader voor {@link TakeoutImport#run}. */
    public TakeoutImport.Uploader takeoutUploader() {
        return (item, content) -> {
            Map<String, Object> r = upload(item.name, item.mime, item.lastModified(), Extra.of(item.meta, item.album), content, item.size);
            if (r.get("error") != null) return TakeoutImport.Result.failed(Json.jsString(r.get("error")));
            return TakeoutImport.Result.ok(Json.truthy(r.get("duplicate")));
        };
    }

    /** Wat de cloud kan ({@code GET /api/capabilities}); null als hij het niet zegt. */
    public List<Object> features() throws IOException {
        try {
            return Json.asList(Json.path(Json.parse(Bytes.utf8(get("/api/capabilities"))), "features"));
        } catch (RuntimeException e) {
            return null;
        }
    }

    private byte[] get(String path) throws IOException {
        HttpURLConnection c = open(path, "GET");
        try {
            int status = status(c);
            if (status >= 300) { drain(c); throw problem(status, path); }
            try (InputStream in = c.getInputStream()) {
                return Bytes.readAll(in);
            } catch (IOException e) {
                throw network(e);
            }
        } finally {
            c.disconnect();
        }
    }

    private HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection c;
        try {
            c = (HttpURLConnection) new URL(base + path).openConnection();
        } catch (IOException e) {
            throw network(e);
        }
        c.setRequestMethod(method);
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("authorization", "Bearer " + token);
        c.setRequestProperty("accept", "application/json, */*");
        return c;
    }

    private static int status(HttpURLConnection c) throws IOException {
        int s;
        try {
            s = c.getResponseCode();
        } catch (IOException e) {
            throw network(e);
        }
        if (s == 401) throw new Unauthorized();
        return s;
    }

    private static void drain(HttpURLConnection c) {
        try (InputStream in = c.getErrorStream()) {
            if (in != null) Bytes.readAll(in);
        } catch (IOException ignored) {
            // niets
        }
    }

    /** 5xx, 429 en 503 (cloud bezig, opslag vol aan het lopen…) zijn tijdelijk; de rest niet. */
    static IOException problem(int status, String what) {
        if (status >= 500 || status == 429 || status == 408) return new TakeoutImport.Retry("Je cloud kan het nu even niet aan (" + status + "), later verder");
        return new IOException(what + " mislukt (" + status + ")");
    }

    static IOException network(IOException e) {
        if (e instanceof TakeoutImport.Retry) return e;
        String m = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
        if (e instanceof SocketException || e instanceof UnknownHostException || e instanceof SocketTimeoutException
                || e instanceof javax.net.ssl.SSLException || e instanceof java.io.EOFException || m.contains("connection") || m.contains("timeout") || m.contains("reset"))
            return new TakeoutImport.Retry("Geen verbinding met je cloud, later verder", e);
        return e;
    }
}
