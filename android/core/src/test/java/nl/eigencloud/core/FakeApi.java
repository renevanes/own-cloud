package nl.eigencloud.core;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/** Local fake HTTP API for tests (JDK-only com.sun.net.httpserver; never used by the core). */
final class FakeApi implements AutoCloseable {
    /** A recorded request. */
    static final class Call {
        String method, path, query, rawBody;
        Map<String, String> headers = new LinkedHashMap<>();
        /** Parsed JSON body (when it starts with { or [), else null. */
        Object json;

        String url() { return path + (query != null ? "?" + query : ""); }

        @Override public String toString() { return method + " " + url(); }
    }

    /** A canned reply. */
    static final class Reply {
        final int status;
        final String body;
        final String contentType;

        Reply(int status, String body, String contentType) {
            this.status = status;
            this.body = body;
            this.contentType = contentType;
        }
    }

    interface Handler { Reply handle(Call c); }

    private final HttpServer server;
    private final List<Object[]> routes = new ArrayList<>();
    final List<Call> calls = new ArrayList<>();

    FakeApi() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::serve);
        server.start();
    }

    String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    /** Adds a route matched against "METHOD /path?query" (regex find). */
    FakeApi on(String regex, Handler h) {
        routes.add(new Object[] {Pattern.compile(regex), h});
        return this;
    }

    FakeApi json(String regex, int status, Object json) { return on(regex, c -> new Reply(status, json == null ? "" : Json.stringify(json), "application/json")); }

    void reset() {
        routes.clear();
        synchronized (calls) { calls.clear(); }
    }

    Call last() { return calls.get(calls.size() - 1); }

    Call find(String regex) {
        Pattern p = Pattern.compile(regex);
        for (Call c : calls) if (p.matcher(c.method + " " + c.url()).find()) return c;
        return null;
    }

    private void serve(HttpExchange ex) throws IOException {
        Call c = new Call();
        c.method = ex.getRequestMethod();
        c.path = ex.getRequestURI().getRawPath();
        c.query = ex.getRequestURI().getRawQuery();
        for (Map.Entry<String, List<String>> h : ex.getRequestHeaders().entrySet()) c.headers.put(h.getKey().toLowerCase(Locale.ROOT), h.getValue().get(0));
        c.rawBody = Bytes.utf8(Bytes.readAll(ex.getRequestBody()));
        if (c.rawBody.startsWith("{") || c.rawBody.startsWith("[")) c.json = Json.parse(c.rawBody);
        synchronized (calls) { calls.add(c); }
        Reply r = new Reply(500, "niet gemockt", "text/plain");
        for (Object[] route : routes) {
            if (((Pattern) route[0]).matcher(c.method + " " + c.url()).find()) { r = ((Handler) route[1]).handle(c); break; }
        }
        byte[] body = Bytes.utf8(r.body);
        ex.getResponseHeaders().set("content-type", r.contentType);
        boolean empty = r.status == 204 || body.length == 0;
        ex.sendResponseHeaders(r.status, empty ? -1 : body.length);
        if (!empty) try (OutputStream o = ex.getResponseBody()) { o.write(body); }
        ex.close();
    }

    @Override public void close() { server.stop(0); }
}
