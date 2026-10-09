package nl.eigencloud.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.ProtocolException;
import java.net.Socket;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLSocketFactory;

/**
 * Small blocking HTTP client on top of {@link HttpURLConnection} (available on Android). Redirects are not
 * followed and non-2xx responses are returned, not thrown. Requests with method PATCH fall back to a minimal
 * HTTP/1.1 client over a socket when the platform's HttpURLConnection refuses the method (desktop JDK;
 * Android supports PATCH natively).
 */
public final class Http {
    private Http() {}

    /** A complete HTTP response. */
    public static final class Response {
        public final int status;
        public final byte[] body;
        /** Response headers with lowercase names (first value). */
        public final Map<String, String> headers;

        public Response(int status, byte[] body, Map<String, String> headers) {
            this.status = status;
            this.body = body;
            this.headers = headers;
        }

        public String text() { return Bytes.utf8(body); }

        public boolean ok() { return status >= 200 && status < 300; }
    }

    /** Performs a request; {@code headers} may be null, {@code body} null for no body. */
    public static Response request(String method, String url, Map<String, String> headers, byte[] body, int timeoutMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
        } catch (ProtocolException e) {
            c.disconnect();
            return rawRequest(method, url, headers, body, timeoutMs);
        }
        try {
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            if (headers != null) {
                for (Map.Entry<String, String> h : headers.entrySet()) {
                    String k = h.getKey().toLowerCase(Locale.ROOT);
                    if (k.equals("host") || k.equals("content-length")) continue; // set by the platform
                    c.setRequestProperty(h.getKey(), h.getValue());
                }
            }
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = c.getOutputStream()) { os.write(body); }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : null;
            if (status < 400) {
                try { in = c.getInputStream(); } catch (IOException e) { in = c.getErrorStream(); }
            }
            byte[] data = "HEAD".equals(method) ? new byte[0] : Bytes.readAll(in);
            if (in != null) in.close();
            Map<String, String> hs = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() != null && !e.getValue().isEmpty()) hs.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue().get(0));
            }
            return new Response(status, data, hs);
        } finally {
            c.disconnect();
        }
    }

    /** Minimal HTTP/1.1 client (Connection: close; Content-Length or chunked responses). */
    static Response rawRequest(String method, String url, Map<String, String> headers, byte[] body, int timeoutMs) throws IOException {
        URL u = new URL(url);
        boolean tls = "https".equalsIgnoreCase(u.getProtocol());
        int port = u.getPort() != -1 ? u.getPort() : (tls ? 443 : 80);
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(u.getHost(), port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            if (tls) {
                // Hostnaam controleren: een kale SSLSocket doet dat niet vanzelf (wel nodig: hier gaan API-tokens over).
                javax.net.ssl.SSLSocket ssl = (javax.net.ssl.SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, u.getHost(), port, true);
                javax.net.ssl.SSLParameters p = ssl.getSSLParameters();
                p.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(p);
                ssl.startHandshake();
                s = ssl;
            }
            String path = u.getFile().isEmpty() ? "/" : u.getFile();
            StringBuilder h = new StringBuilder();
            h.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            boolean defaultPort = u.getPort() == -1 || u.getPort() == u.getDefaultPort();
            h.append("Host: ").append(u.getHost()).append(defaultPort ? "" : ":" + u.getPort()).append("\r\n");
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    String k = e.getKey().toLowerCase(Locale.ROOT);
                    if (k.equals("host") || k.equals("content-length") || k.equals("connection")) continue;
                    h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                }
            }
            h.append("Content-Length: ").append(body == null ? 0 : body.length).append("\r\n");
            h.append("Connection: close\r\n\r\n");
            OutputStream os = s.getOutputStream();
            os.write(Bytes.utf8(h.toString()));
            if (body != null) os.write(body);
            os.flush();

            InputStream in = s.getInputStream();
            String statusLine = readLine(in);
            String[] parts = statusLine.split(" ", 3);
            if (parts.length < 2 || !parts[0].startsWith("HTTP/")) throw new IOException("Ongeldig HTTP-antwoord");
            int status = Integer.parseInt(parts[1]);
            Map<String, String> hs = new LinkedHashMap<>();
            for (String line; !(line = readLine(in)).isEmpty(); ) {
                int i = line.indexOf(':');
                if (i > 0) hs.putIfAbsent(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            byte[] data;
            if ("HEAD".equals(method) || status == 204 || status == 304) data = new byte[0];
            else if ("chunked".equalsIgnoreCase(hs.get("transfer-encoding"))) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                for (;;) {
                    String sz = readLine(in);
                    int semi = sz.indexOf(';');
                    int n = Integer.parseInt((semi >= 0 ? sz.substring(0, semi) : sz).trim(), 16);
                    if (n == 0) break;
                    out.write(readN(in, n));
                    readLine(in);
                }
                data = out.toByteArray();
            } else if (hs.containsKey("content-length")) data = readN(in, Integer.parseInt(hs.get("content-length")));
            else data = Bytes.readAll(in);
            return new Response(status, data, hs);
        } finally {
            s.close();
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c == -1 && b.size() == 0) throw new IOException("Verbinding onverwacht gesloten");
        return Bytes.utf8(b.toByteArray());
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int o = 0;
        while (o < n) {
            int r = in.read(b, o, n - o);
            if (r < 0) throw new IOException("Verbinding onverwacht gesloten");
            o += r;
        }
        return b;
    }

    /** Headers map helper: {@code headers("a", "1", "b", "2")}. */
    public static Map<String, String> headers(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }
}
