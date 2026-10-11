package nl.eigencloud.core;

import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Port of S3Store from src/cluster/stores.ts: S3-compatible storage (Hetzner, Scaleway, UpCloud, Exoscale,
 * MinIO …) with AWS Signature V4 (header variant with UNSIGNED-PAYLOAD, and presigned GET). Path-style
 * addressing unless {@code pathStyle: false}.
 *
 * <p>StoreConfig keys used: name, purpose, endpoint, region (default us-east-1), bucket, accessKey,
 * secretKey, pathStyle, prefix.
 */
public final class S3Store implements ObjectStore {
    private final Map<String, Object> config;
    private final String name;
    private final String purpose;
    private final String protocol; // "https:" style, like JS URL.protocol
    private final String endpointHost; // like JS URL.host (port omitted when default)
    private int timeoutMs = 60_000;

    public S3Store(Map<String, Object> config) {
        this.config = config;
        this.name = Json.str(config, "name");
        this.purpose = Json.str(config, "purpose");
        String ep = Json.str(config, "endpoint");
        if (ep == null) throw new IllegalArgumentException("Opslag zonder endpoint");
        try {
            URL u = new URL(ep);
            this.protocol = u.getProtocol().toLowerCase(Locale.ROOT) + ":";
            int port = u.getPort();
            boolean dflt = port == -1 || port == u.getDefaultPort();
            this.endpointHost = u.getHost().toLowerCase(Locale.ROOT) + (dflt ? "" : ":" + port);
        } catch (MalformedURLException e) {
            throw new IllegalArgumentException("Ongeldige endpoint-URL: " + ep);
        }
    }

    /** Network timeout for requests (default 60 s). */
    public S3Store timeout(int ms) {
        this.timeoutMs = ms;
        return this;
    }

    @Override public String name() { return name; }
    @Override public String purpose() { return purpose; }
    @Override public Map<String, Object> config() { return config; }

    /** Host of the endpoint as in JS {@code new URL(endpoint).host}. */
    public String endpointHost() { return endpointHost; }

    // ───────── URL and signing ─────────

    static String enc(String s) {
        // encodeURIComponent + !'()* encoded too (RFC 3986)
        String e = Bytes.encodeURIComponent(s);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < e.length(); i++) {
            char c = e.charAt(i);
            if ("!'()*".indexOf(c) >= 0) b.append('%').append(String.format(Locale.ROOT, "%02X", (int) c));
            else b.append(c);
        }
        return b.toString();
    }

    static String encKey(String k) {
        String[] parts = k.split("/", -1);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) b.append('/');
            b.append(enc(parts[i]));
        }
        return b.toString();
    }

    private String prefix() {
        String p = Json.str(config, "prefix");
        return p == null || p.isEmpty() ? null : p;
    }

    private static String stripSlash(String p) { return p.endsWith("/") ? p.substring(0, p.length() - 1) : p; }

    private static final class Url {
        String host, path, qs, href;
    }

    /**
     * Request URL. An empty key addresses the bucket itself (list, bucket config), so the store prefix is
     * not applied then. (Deviation from the TS version, which appends the prefix there too and so sends
     * bucket-level requests to an object URL when a prefix is configured.)
     */
    private Url url(String key, Map<String, String> query) {
        String pre = prefix();
        String k = (pre != null && !key.isEmpty() ? stripSlash(pre) + "/" : "") + key;
        boolean pathStyle = !Boolean.FALSE.equals(config.get("pathStyle"));
        String bucket = Json.jsString(config.get("bucket"));
        Url u = new Url();
        u.host = pathStyle ? endpointHost : bucket + "." + endpointHost;
        String p = (pathStyle ? "/" + bucket : "") + (!k.isEmpty() ? "/" + encKey(k) : pathStyle ? "" : "/");
        List<String> names = new ArrayList<>(query.keySet());
        Collections.sort(names); // JS default sort = UTF-16 code unit order, same as String.compareTo
        StringBuilder qs = new StringBuilder();
        for (String q : names) {
            if (qs.length() > 0) qs.append('&');
            qs.append(enc(q)).append('=').append(enc(query.get(q)));
        }
        u.path = p.isEmpty() ? "/" : p;
        u.qs = qs.toString();
        u.href = protocol + "//" + u.host + u.path + (u.qs.isEmpty() ? "" : "?" + u.qs);
        return u;
    }

    private static String amzDate(long nowMs) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(nowMs));
    }

    private String region() {
        String r = Json.str(config, "region");
        return r != null ? r : "us-east-1";
    }

    private byte[] signingKey(String date) {
        byte[] k = Bytes.hmacSha256(Bytes.utf8("AWS4" + Json.jsString(config.get("secretKey"))), date);
        k = Bytes.hmacSha256(k, region());
        k = Bytes.hmacSha256(k, "s3");
        return Bytes.hmacSha256(k, "aws4_request");
    }

    private String scope(String date) { return date + "/" + region() + "/s3/aws4_request"; }

    /** Signed request headers (SigV4 header variant, UNSIGNED-PAYLOAD). Returns url + headers. */
    Map.Entry<String, Map<String, String>> sign(String method, String key, Map<String, String> query, Map<String, String> extra, long nowMs) {
        Url u = url(key, query);
        String date = amzDate(nowMs);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("host", u.host);
        headers.put("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
        headers.put("x-amz-date", date);
        headers.putAll(extra);
        TreeMap<String, String> canonH = new TreeMap<>();
        for (Map.Entry<String, String> e : headers.entrySet()) canonH.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue());
        StringBuilder ch = new StringBuilder();
        StringBuilder names = new StringBuilder();
        for (Map.Entry<String, String> e : canonH.entrySet()) {
            String v = headers.containsKey(e.getKey()) ? headers.get(e.getKey()) : e.getValue();
            ch.append(e.getKey()).append(':').append(v.trim()).append('\n');
            if (names.length() > 0) names.append(';');
            names.append(e.getKey());
        }
        String canon = method + "\n" + u.path + "\n" + u.qs + "\n" + ch + "\n" + names + "\nUNSIGNED-PAYLOAD";
        String sc = scope(date.substring(0, 8));
        String sts = "AWS4-HMAC-SHA256\n" + date + "\n" + sc + "\n" + Bytes.sha256Hex(Bytes.utf8(canon));
        String sig = Bytes.hex(Bytes.hmacSha256(signingKey(date.substring(0, 8)), sts));
        headers.put("authorization", "AWS4-HMAC-SHA256 Credential=" + Json.jsString(config.get("accessKey")) + "/" + sc + ", SignedHeaders=" + names + ", Signature=" + sig);
        return new java.util.AbstractMap.SimpleEntry<>(u.href, headers);
    }

    private Http.Response req(String method, String key, Map<String, String> query, byte[] body, Map<String, String> extraHeaders) throws IOException {
        Map<String, String> extra = new LinkedHashMap<>(extraHeaders);
        if ("PUT".equals(method)) extra.put("content-length", String.valueOf(body == null ? 0 : body.length));
        Map.Entry<String, Map<String, String>> s = sign(method, key, query, extra, System.currentTimeMillis());
        return Http.request(method, s.getKey(), s.getValue(), "PUT".equals(method) ? (body == null ? new byte[0] : body) : body, timeoutMs);
    }

    private static Map<String, String> none() { return Collections.emptyMap(); }

    // ───────── Objects ─────────

    /**
     * Uploads an object. Sends Content-MD5 (deviation from the TS version): S3 requires it for uploads to
     * buckets with default object-lock retention, which is how backup buckets are set up.
     */
    @Override
    public void put(String key, byte[] body) throws IOException {
        Http.Response r = req("PUT", key, none(), body, Http.headers("content-md5", Bytes.base64(Bytes.md5(body))));
        if (r.status >= 300) throw new IOException(name + ": PUT " + key + " → " + r.status + " " + Bytes.head(r.text(), 200));
    }

    @Override
    public byte[] getBuffer(String key) throws IOException {
        Http.Response r = req("GET", key, none(), null, none());
        if (r.status == 404) return null;
        if (r.status >= 300) throw new IOException(name + ": GET " + key + " → " + r.status + " " + Bytes.head(r.text(), 200));
        return r.body;
    }

    @Override
    public boolean head(String key) throws IOException {
        Http.Response r = req("HEAD", key, none(), null, none());
        if (r.status == 404) return false;
        if (r.status >= 300) throw new IOException(name + ": HEAD " + key + " → " + r.status);
        return true;
    }

    private static final Pattern CONTENTS = Pattern.compile("<Contents>([\\s\\S]*?)</Contents>");
    private static final Pattern KEY = Pattern.compile("<Key>([\\s\\S]*?)</Key>");
    private static final Pattern SIZE = Pattern.compile("<Size>(\\d+)</Size>");
    private static final Pattern TRUNC = Pattern.compile("<IsTruncated>true</IsTruncated>");
    private static final Pattern NEXT = Pattern.compile("<NextContinuationToken>([\\s\\S]*?)</NextContinuationToken>");

    static String xmlUnescape(String k) {
        return k.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    }

    @Override
    public List<Entry> list(String prefix) throws IOException {
        List<Entry> out = new ArrayList<>();
        String pre = prefix();
        String pfx = (pre != null ? stripSlash(pre) + "/" : "") + prefix;
        String token = null;
        do {
            Map<String, String> q = new LinkedHashMap<>();
            q.put("list-type", "2");
            q.put("prefix", pfx);
            if (token != null) q.put("continuation-token", token);
            Http.Response r = req("GET", "", q, null, none());
            String xml = r.text();
            if (r.status >= 300) throw new IOException(name + ": LIST → " + r.status + " " + Bytes.head(xml, 200));
            Matcher m = CONTENTS.matcher(xml);
            while (m.find()) {
                Matcher km = KEY.matcher(m.group(1));
                String k = km.find() ? km.group(1) : "";
                Matcher sm = SIZE.matcher(m.group(1));
                long size = sm.find() ? Long.parseLong(sm.group(1)) : 0;
                String key = xmlUnescape(k);
                out.add(new Entry(pre != null ? key.substring(Math.min(key.length(), stripSlash(pre).length() + 1)) : key, size));
            }
            token = null;
            if (TRUNC.matcher(xml).find()) {
                Matcher n = NEXT.matcher(xml);
                if (n.find()) token = n.group(1);
            }
        } while (token != null && !token.isEmpty());
        return out;
    }

    @Override
    public void delete(String key) throws IOException {
        Http.Response r = req("DELETE", key, none(), null, none());
        if (r.status >= 300 && r.status != 404) throw new IOException(name + ": DELETE " + key + " → " + r.status);
    }

    // ───────── Bucket management (setup wizard) ─────────

    private static final Pattern BUCKET_NAME = Pattern.compile("<Bucket>[\\s\\S]*?<Name>([^<]+)</Name>");

    /** Alle buckets van deze sleutel (S3 ListBuckets), om bij herstellen de juiste te vinden. */
    public List<String> listBuckets() throws IOException {
        Map<String, Object> c = Json.copy(config);
        c.put("bucket", "");
        c.put("pathStyle", true);
        c.remove("prefix");
        Http.Response r = new S3Store(c).req("GET", "", none(), null, none());
        if (r.status >= 300) throw new IOException(r.status == 403 ? "De sleutel geeft geen toegang" : "Buckets opvragen mislukt: " + r.status);
        List<String> out = new ArrayList<>();
        java.util.regex.Matcher m = BUCKET_NAME.matcher(r.text());
        while (m.find()) out.add(m.group(1));
        return out;
    }

    /** Result of {@link #probe}: HTTP status, S3 error code ("" when none) and the number of buckets or objects. */
    public static final class Probe {
        public final int status;
        public final String code;
        public final int count;

        Probe(int status, String code, int count) {
            this.status = status;
            this.code = code;
            this.count = count;
        }
    }

    private static final Pattern PROBE_CODE = Pattern.compile("<Code>([^<]+)</Code>");

    /**
     * Read-only, for "Sleutels controleren" (probe in stores.ts): ListBuckets ("buckets"), HeadBucket ("bucket") or
     * ListObjectsV2 with one key ("objects").
     */
    public Probe probe(String kind) throws IOException {
        S3Store s = this;
        if ("buckets".equals(kind)) {
            Map<String, Object> c = Json.copy(config);
            c.put("bucket", "");
            c.put("pathStyle", true);
            c.remove("prefix");
            s = new S3Store(c);
        }
        Map<String, String> q = new LinkedHashMap<>();
        if ("objects".equals(kind)) {
            q.put("list-type", "2");
            q.put("max-keys", "1");
        }
        Http.Response r = s.req("bucket".equals(kind) ? "HEAD" : "GET", "", q, null, none());
        String text = r.text();
        Matcher m = PROBE_CODE.matcher(text);
        Matcher n = Pattern.compile("buckets".equals(kind) ? "<Bucket>" : "<Contents>").matcher(text);
        int count = 0;
        while (n.find()) count++;
        return new Probe(r.status, m.find() ? m.group(1) : "", count);
    }

    public boolean bucketExists() throws IOException {
        Http.Response r = req("HEAD", "", none(), null, none());
        if (r.status == 404) return false;
        if (r.status == 403) throw new IOException("Geen toegang tot deze bucket (bestaat hij al bij iemand anders, of klopt de sleutel niet?)");
        if (r.status >= 300) throw new IOException("Bucket controleren mislukt: " + r.status);
        return true;
    }

    public void createBucket(boolean objectLock) throws IOException {
        String region = region();
        byte[] body = region.equals("us-east-1") ? new byte[0]
                : Bytes.utf8("<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><LocationConstraint>" + region + "</LocationConstraint></CreateBucketConfiguration>");
        Map<String, String> extra = objectLock ? Http.headers("x-amz-bucket-object-lock-enabled", "true") : none();
        Http.Response r = req("PUT", "", none(), body, extra);
        String text = r.text();
        if (r.status >= 300 && !text.contains("BucketAlreadyOwnedByYou")) throw new IOException("Bucket aanmaken mislukt: " + r.status + " " + Bytes.head(text, 200));
    }

    private static final Pattern VERSION = Pattern.compile("<(?:Version|DeleteMarker)>([\\s\\S]*?)</(?:Version|DeleteMarker)>");
    private static final Pattern VERSION_ID = Pattern.compile("<VersionId>([\\s\\S]*?)</VersionId>");
    private static final Pattern CODE = Pattern.compile("<Code>([^<]+)");

    private static String code(String xml, int status) {
        Matcher m = CODE.matcher(xml);
        return m.find() ? m.group(1) : String.valueOf(status);
    }

    /**
     * Bucket helemaal weghalen (bij opnieuw beginnen vóór de start): alle versies wissen, ook die onder
     * object-lock in GOVERNANCE-modus, en dan de bucket zelf. Geeft null, of een uitleg als het niet kan.
     * (Sleutels uit de versielijst zijn volledig; anders dan de TS-versie wordt het opslagvoorvoegsel er
     * dus niet nog een keer voor gezet.)
     */
    public String destroyBucket() throws IOException {
        Map<String, Object> c = Json.copy(config);
        c.remove("prefix");
        S3Store raw = new S3Store(c).timeout(timeoutMs);
        Map<String, String> versions = new LinkedHashMap<>();
        versions.put("versions", "");
        for (int round = 0; round < 50; round++) {
            Http.Response r = raw.req("GET", "", versions, null, none());
            String xml = r.text();
            if (r.status == 404) return null;
            if (r.status >= 300) return "Inhoud opvragen mislukt (" + r.status + ")";
            List<String[]> items = new ArrayList<>();
            Matcher m = VERSION.matcher(xml);
            while (m.find()) {
                Matcher km = KEY.matcher(m.group(1));
                Matcher vm = VERSION_ID.matcher(m.group(1));
                items.add(new String[] {xmlUnescape(km.find() ? km.group(1) : ""), vm.find() ? vm.group(1) : ""});
            }
            if (items.isEmpty()) break;
            for (String[] it : items) {
                Map<String, String> q = new LinkedHashMap<>();
                if (!it[1].isEmpty() && !"null".equals(it[1])) q.put("versionId", it[1]);
                Http.Response d = raw.req("DELETE", it[0], q, null, Http.headers("x-amz-bypass-governance-retention", "true"));
                if (d.status >= 300 && d.status != 404) return "Bestand " + it[0] + " kan (nog) niet weg: " + code(d.text(), d.status);
            }
        }
        Http.Response r = raw.req("DELETE", "", none(), null, none());
        if (r.status >= 300 && r.status != 404) return "Bucket verwijderen mislukt: " + code(r.text(), r.status);
        return null;
    }

    /** Bucket sub-resource ("versioning", "object-lock", "lifecycle"); false when the provider refuses it. */
    public boolean putBucketConfig(String sub, String xml) throws IOException {
        byte[] body = Bytes.utf8(xml);
        Map<String, String> q = new LinkedHashMap<>();
        q.put(sub, "");
        Http.Response r = req("PUT", "", q, body, Http.headers("content-md5", Bytes.base64(Bytes.md5(body)), "content-type", "application/xml"));
        return r.status < 300;
    }

    // ───────── Presigned GET ─────────

    @Override
    public String presignGet(String key, int seconds) { return presignGet(key, seconds, System.currentTimeMillis()); }

    /** Presigned GET (query variant of SigV4) at a fixed time, for tests and reproducibility. */
    public String presignGet(String key, int seconds, long nowMs) {
        String date = amzDate(nowMs);
        String sc = scope(date.substring(0, 8));
        Map<String, String> q = new LinkedHashMap<>();
        q.put("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
        q.put("X-Amz-Credential", Json.jsString(config.get("accessKey")) + "/" + sc);
        q.put("X-Amz-Date", date);
        q.put("X-Amz-Expires", String.valueOf(seconds));
        q.put("X-Amz-SignedHeaders", "host");
        Url u = url(key, q);
        String canon = "GET\n" + u.path + "\n" + u.qs + "\nhost:" + u.host + "\n\nhost\nUNSIGNED-PAYLOAD";
        String sts = "AWS4-HMAC-SHA256\n" + date + "\n" + sc + "\n" + Bytes.sha256Hex(Bytes.utf8(canon));
        return u.href + "&X-Amz-Signature=" + Bytes.hex(Bytes.hmacSha256(signingKey(date.substring(0, 8)), sts));
    }
}
