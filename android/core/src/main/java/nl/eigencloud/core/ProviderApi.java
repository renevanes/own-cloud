package nl.eigencloud.core;

import java.io.IOException;
import java.util.Map;

/** The api() helper of src/cluster/providers.ts: JSON over HTTP with the same error messages. */
final class ProviderApi {
    private ProviderApi() {}

    static final int TIMEOUT_MS = 60_000;

    static final class Result {
        final int status;
        final Object json;

        Result(int status, Object json) {
            this.status = status;
            this.json = json;
        }
    }

    /**
     * Throws "METHOD url → status text[0..300]" unless the status is 2xx or in {@code okStatus}.
     * An empty body yields an empty object.
     */
    static Result call(String method, String url, Map<String, String> headers, String body, int... okStatus) throws IOException {
        Http.Response r = Http.request(method, url, headers, body == null ? null : Bytes.utf8(body), TIMEOUT_MS);
        String text = r.text();
        boolean ok = r.ok();
        for (int s : okStatus) if (s == r.status) ok = true;
        if (!ok) throw new HttpException(method + " " + url + " → " + r.status + " " + Bytes.head(text, 300), r.status, text);
        Object json;
        try {
            json = text.isEmpty() ? Json.obj() : Json.parse(text);
        } catch (IllegalArgumentException e) {
            throw new IOException("Ongeldige JSON van " + url + ": " + e.getMessage(), e);
        }
        return new Result(r.status, json);
    }

    static void sleep(long ms) throws IOException {
        if (ms <= 0) return;
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Onderbroken", e);
        }
    }
}
