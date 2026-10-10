package nl.eigencloud.app;

import android.content.Context;
import android.webkit.CookieManager;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.Map;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Http;
import nl.eigencloud.core.Json;

/**
 * De cloud-API vanuit de achtergrond (foto-back-up, agenda, meldingen). Inloggen gebeurt in de app zelf; het
 * sessie-token uit dat cookie werkt ook als Bearer-token (zie src/auth.ts), dus de app bewaart geen wachtwoord.
 */
final class CloudApi {
    final String base;
    private final String token;

    static final class NotLoggedIn extends IOException {
        private static final long serialVersionUID = 1L;

        NotLoggedIn() { super("Niet ingelogd in de app"); }
    }

    private CloudApi(String base, String token) {
        this.base = base;
        this.token = token;
    }

    /** null als er nog geen cloud gekoppeld is of je niet bent ingelogd. */
    static CloudApi fromApp(Context c) {
        String base = Prefs.cloudUrl(c);
        if (base == null) return null;
        String token = sessionToken(base);
        return token == null ? null : new CloudApi(base, token);
    }

    static String sessionToken(String base) {
        String cookies;
        try { cookies = CookieManager.getInstance().getCookie(base); } catch (RuntimeException e) { return null; }
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String p = part.trim();
            if (p.startsWith("session=")) {
                String v = p.substring(8);
                // Token = "<verloopt-ms>.<handtekening>"
                int dot = v.indexOf('.');
                try { if (dot > 0 && Long.parseLong(v.substring(0, dot)) < System.currentTimeMillis()) return null; } catch (NumberFormatException e) { return null; }
                return v;
            }
        }
        return null;
    }

    /**
     * Maakt van wat iemand intypt een cloud-adres: "vanes.nl" of "cloud.vanes.nl" → https://cloud.vanes.nl.
     * Alleen HTTPS, behalve voor een test-server op je eigen netwerk/emulator.
     */
    static String normalize(String input) {
        String s = input == null ? "" : input.trim().toLowerCase(Locale.ROOT);
        s = s.replaceAll("/+$", "");
        if (s.isEmpty()) throw new IllegalArgumentException("Vul het adres van je cloud in");
        if (!s.contains("://")) {
            String host = s.replaceAll("/.*$", "");
            if (!host.startsWith("cloud.") && host.chars().filter(ch -> ch == '.').count() == 1) s = "cloud." + s;
            s = "https://" + s;
        }
        URL u;
        try { u = new URL(s); } catch (IOException e) { throw new IllegalArgumentException("Dat is geen geldig adres"); }
        boolean local = u.getHost().equals("10.0.2.2") || u.getHost().equals("localhost") || u.getHost().startsWith("192.168.");
        if (!"https".equals(u.getProtocol()) && !local) throw new IllegalArgumentException("Je cloud moet via https bereikbaar zijn");
        return u.getProtocol() + "://" + u.getHost() + (u.getPort() == -1 ? "" : ":" + u.getPort());
    }

    /** Controleert of er echt een Eigen Cloud op dit adres draait. */
    static void probe(String base) throws IOException {
        Http.Response r;
        try {
            r = Http.request("GET", base + "/api/me", null, null, 10_000);
        } catch (IOException e) {
            throw new IOException("Geen verbinding met " + base.replaceFirst("^https?://", "") + ". Klopt het adres, en draait je cloud?");
        }
        boolean json = String.valueOf(r.headers.get("content-type")).contains("json");
        if (!(r.status == 401 || r.status == 200) || !json) throw new IOException("Op dat adres draait geen Eigen Cloud");
    }

    String token() { return token; }

    private Map<String, String> auth() { return Http.headers("authorization", "Bearer " + token, "accept", "application/json"); }

    Object getJson(String path) throws IOException {
        Http.Response r = Http.request("GET", base + path, auth(), null, 30_000);
        if (r.status == 401) throw new NotLoggedIn();
        if (!r.ok()) throw new IOException(path + " → " + r.status);
        return Json.parse(r.text());
    }

    /** Fotobestand naar /api/photos/upload (multipart, gestreamd). Geeft het resultaat per bestand terug. */
    Map<String, Object> upload(String filename, String mime, long lastModified, InputStream in, long size) throws IOException {
        String boundary = "eigen" + Bytes.hex(Bytes.random(12));
        String safeName = filename.replaceAll("[\"\\r\\n]", "_");
        byte[] head = Bytes.utf8("--" + boundary + "\r\nContent-Disposition: form-data; name=\"lastModified\"\r\n\r\n" + lastModified + "\r\n"
                + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + safeName + "\"\r\nContent-Type: " + (mime == null ? "application/octet-stream" : mime) + "\r\n\r\n");
        byte[] tail = Bytes.utf8("\r\n--" + boundary + "--\r\n");
        HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/photos/upload").openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(20_000);
            c.setReadTimeout(300_000);
            c.setDoOutput(true);
            c.setRequestProperty("authorization", "Bearer " + token);
            c.setRequestProperty("content-type", "multipart/form-data; boundary=" + boundary);
            if (size >= 0) c.setFixedLengthStreamingMode(head.length + size + tail.length);
            else c.setChunkedStreamingMode(256 * 1024);
            try (OutputStream os = c.getOutputStream()) {
                os.write(head);
                byte[] buf = new byte[256 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                os.write(tail);
            }
            int status = c.getResponseCode();
            if (status == 401) throw new NotLoggedIn();
            InputStream rin = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = rin == null ? "" : Bytes.utf8(Bytes.readAll(rin));
            if (status >= 300) throw new IOException("Uploaden mislukt (" + status + ")");
            Object res = Json.parse(text);
            java.util.List<Object> l = Json.asList(res);
            return l != null && !l.isEmpty() ? Json.asMap(l.get(0)) : Json.obj();
        } finally {
            c.disconnect();
        }
    }
}
