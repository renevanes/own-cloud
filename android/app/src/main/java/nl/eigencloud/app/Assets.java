package nl.eigencloud.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Serveert de schermen die in de app zitten (beheerconsole, startscherm) op een vast https-adres, zodat
 * JavaScript-modules en lettertypen werken zoals op de computer. Niets hiervan gaat over het netwerk.
 */
final class Assets {
    private Assets() {}

    static final String ORIGIN = "https://appassets.androidplatform.net";

    static boolean ours(Uri u) {
        return u != null && "https".equals(u.getScheme()) && "appassets.androidplatform.net".equals(u.getHost());
    }

    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("json", "application/json");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("txt", "text/plain");
    }

    static WebResourceResponse serve(Context c, Uri u) {
        String path = u.getPath() == null || u.getPath().equals("/") ? "/index.html" : u.getPath();
        if (path.contains("..")) return notFound();
        String ext = path.substring(path.lastIndexOf('.') + 1);
        String type = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
        try {
            InputStream in = c.getAssets().open("www" + path);
            WebResourceResponse r = new WebResourceResponse(type, type.startsWith("text/") || type.endsWith("json") || type.endsWith("xml") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            h.put("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'");
            r.setResponseHeaders(h);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", new java.io.ByteArrayInputStream(new byte[0]));
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }
}
