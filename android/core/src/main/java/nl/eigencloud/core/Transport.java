package nl.eigencloud.core;

import java.io.IOException;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Port of src/cluster/transport.ts: node-to-node (and admin-to-node) messages. JSON {ts, n, m} sealed with
 * the cluster key and AAD "rpc"; messages older than 60 s or seen before are refused.
 */
public final class Transport {
    private Transport() {}

    private static final Map<String, Long> SEEN = new LinkedHashMap<>();

    private static synchronized boolean remember(String nonce) {
        long now = System.currentTimeMillis();
        if (SEEN.size() > 20000) {
            for (Iterator<Map.Entry<String, Long>> it = SEEN.entrySet().iterator(); it.hasNext(); ) {
                if (now - it.next().getValue() > 120_000) it.remove();
            }
        }
        if (SEEN.containsKey(nonce)) return false;
        SEEN.put(nonce, now);
        return true;
    }

    /** Seals a message: JSON {ts: now, n: base64(12 random bytes), m: msg}, AAD "rpc". */
    public static byte[] sealMsg(byte[] key, Object msg) {
        Map<String, Object> env = Json.obj("ts", System.currentTimeMillis(), "n", Bytes.base64(Bytes.random(12)), "m", msg);
        return EigenCrypto.seal(key, Bytes.utf8(Json.stringify(env)), "rpc");
    }

    /** Opens a message; checks the 60-second window and replay. Returns the inner message {@code m}. */
    public static Object openMsg(byte[] key, byte[] buf) {
        Map<String, Object> env = Json.asMap(Json.parse(Bytes.utf8(EigenCrypto.open(key, buf, "rpc"))));
        if (env == null) throw new IllegalArgumentException("Ongeldig bericht");
        Number ts = Json.num(env, "ts");
        if (ts == null || Math.abs(System.currentTimeMillis() - ts.doubleValue()) > 60_000) throw new IllegalStateException("Bericht verlopen (klok gelijkzetten?)");
        if (!remember(String.valueOf(env.get("n")))) throw new IllegalStateException("Bericht al eerder ontvangen");
        return env.get("m");
    }

    /**
     * POST {url}/cluster/rpc with the sealed message; returns the opened reply.
     * Throws {@link IOException} on network errors and non-200 replies ("RPC url: status body").
     */
    public static Object rpc(byte[] key, String url, Object msg, int timeoutMs) throws IOException {
        String u = url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
        Http.Response r = Http.request("POST", u + "/cluster/rpc", Http.headers("content-type", "application/octet-stream"), sealMsg(key, msg), timeoutMs);
        if (r.status != 200) throw new IOException("RPC " + url + ": " + r.status + " " + Bytes.head(r.text(), 200));
        try {
            return openMsg(key, r.body);
        } catch (RuntimeException e) {
            throw new IOException("RPC " + url + ": " + e.getMessage(), e);
        }
    }

    /** rpc() for replies that are JSON objects. */
    public static Map<String, Object> rpcObject(byte[] key, String url, Object msg, int timeoutMs) throws IOException {
        Object o = rpc(key, url, msg, timeoutMs);
        Map<String, Object> m = Json.asMap(o);
        if (m == null) throw new IOException("RPC " + url + ": onverwacht antwoord");
        return m;
    }
}
