package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * "Sleutels controleren" (port of src/cluster/adapters/check.ts): checks a provider's credentials with ONLY reading
 * requests (GET or HEAD); nothing is ever created or changed. Each check is one row {id, label, ok, detail} with ok
 * true, false (detail says what to fix where) or null (not visible through the API, or not checked because logging
 * in failed). The Dutch texts are identical to the TypeScript ones: the console and the app show the same list
 * (test/fixtures/key-checks.json is shared by both test suites).
 *
 * <p>Per provider: {@code check} / {@code dnsCheck} in the provider classes; storage is generic S3 ({@link #storage}).
 */
public final class KeyCheck {
    private KeyCheck() {}

    public static final String NOT_CHECKED = "Niet gecontroleerd, want inloggen lukt niet";
    public static final String RIGHTS_HIDDEN = "Kan de aanbieder niet laten zien; blijkt bij het starten";

    static final String LOGIN = "Inloggen lukt", SERVERS = "Servers bekijken", SIZES = "Formaten en prijzen ophalen", RIGHTS = "Rechten voor servers maken",
            PROJECT = "Project bekijken", ZONE = "DNS-zone bekijken", ZONES = "DNS-zones bekijken", DNS_RIGHTS = "Rechten om DNS te wijzigen";

    /** One row {id, label, ok, detail}. */
    public static Map<String, Object> row(String id, String label, Boolean ok, String detail) {
        return Json.obj("id", id, "label", label, "ok", ok, "detail", detail == null ? "" : detail);
    }

    static Map<String, Object> row(String id, String label, Boolean ok) { return row(id, label, ok, ""); }

    /** Answer of {@link #look}: status 0 = no connection (text is the error). */
    static final class Look {
        final int status;
        final String text;
        final Object json;

        Look(int status, String text, Object json) {
            this.status = status;
            this.text = text;
            this.json = json;
        }

        boolean good() { return status >= 200 && status < 300; }
    }

    /** One reading request; never throws. */
    static Look look(String url, Map<String, String> headers) {
        return look("GET", url, headers);
    }

    static Look look(String method, String url, Map<String, String> headers) {
        try {
            Http.Response r = Http.request(method, url, headers, null, 15_000);
            String text = r.text();
            Object json = null;
            try { json = text.isEmpty() ? null : Json.parse(text); } catch (IllegalArgumentException e) { /* no JSON */ }
            return new Look(r.status, text, json);
        } catch (IOException | RuntimeException e) {
            return new Look(0, String.valueOf(e.getMessage()), null);
        }
    }

    static boolean good(int status) { return status >= 200 && status < 300; }

    /** Explanation of an unexpected answer (or no connection). */
    static String failText(int status, String text) {
        String t = Bytes.head(text.trim(), 120);
        if (status == 0) return "Geen verbinding met de aanbieder: " + t;
        return "De aanbieder antwoordde met fout " + status + (t.isEmpty() ? "" : ": " + t);
    }

    static String failText(Look r) { return failText(r.status, r.text); }

    /** Logging in failed: that row ✗, the rest "not checked". {@code rest}: id, label, id, label, … */
    static List<Object> loginFailed(String detail, String... rest) {
        List<Object> out = new ArrayList<>();
        out.add(row("login", LOGIN, false, detail));
        for (int i = 0; i + 1 < rest.length; i += 2) out.add(row(rest[i], rest[i + 1], null, NOT_CHECKED));
        return out;
    }

    /** Number of items of a JSON list (or keys of an object) at a path; 0 when missing. */
    static int count(Object root, Object... keys) {
        Object v = Json.path(root, keys);
        if (v instanceof List) return ((List<?>) v).size();
        if (v instanceof Map) return ((Map<?, ?>) v).size();
        return 0;
    }

    /** Field value as a string ("" when missing). */
    static String f(Map<String, Object> fields, String key) { return Adapters.field(fields, key); }

    /**
     * For a provider without its own check: log in (list the servers, as when linking) and fetch the sizes in the
     * first region. Also read-only.
     */
    static List<Object> genericServers(String id, Map<String, Object> fields, String cluster, String firstRegion) {
        try {
            Providers.make(id, fields).list(cluster);
        } catch (IOException | RuntimeException e) {
            return loginFailed(Bytes.head(String.valueOf(e.getMessage()).replaceFirst("https?://\\S+", ""), 160), "sizes", SIZES, "rights", RIGHTS);
        }
        List<Object> out = new ArrayList<>();
        out.add(row("login", LOGIN, true));
        try {
            out.add(row("sizes", SIZES, true, Catalog.fetchSizes(id, fields, firstRegion).size() + " formaten"));
        } catch (IOException | RuntimeException e) {
            out.add(row("sizes", SIZES, false, Bytes.head(String.valueOf(e.getMessage()), 160)));
        }
        out.add(row("rights", RIGHTS, null, RIGHTS_HIDDEN));
        return out;
    }

    /** Whether a rule like "GET /cloud/project/*" covers a path like "/cloud/project/abc/instance" (* = anything). */
    static boolean ruleCovers(List<Object> rules, String method, String path) {
        for (Object r : rules) {
            String m = Json.str(r, "method"), p = Json.str(r, "path");
            if (!method.equals(m) || p == null) continue;
            StringBuilder re = new StringBuilder("^");
            String[] parts = p.split("\\*", -1);
            for (int i = 0; i < parts.length; i++) {
                if (i > 0) re.append(".*");
                re.append(Pattern.quote(parts[i]));
            }
            if (Pattern.compile(re.append("$").toString()).matcher(path).find()) return true;
        }
        return false;
    }

    // ───────── Storage (S3, the same for every provider) ─────────

    private static S3Store.Probe probe(S3Store s, String kind) {
        try {
            return s.probe(kind);
        } catch (IOException | RuntimeException e) {
            return new S3Store.Probe(0, String.valueOf(e.getMessage()), 0);
        }
    }

    /**
     * Storage: list the buckets (log in), look at the own bucket (HEAD) and ask for one object name. Writing is only
     * tested when linking (a small test file); that does not belong here.
     */
    public static List<Object> storage(Map<String, Object> cfg) {
        S3Store s = new S3Store(cfg);
        String bucket = Json.str(cfg, "bucket") == null ? "" : Json.str(cfg, "bucket");
        String[] rest = bucket.isEmpty() ? new String[0] : new String[] {"bucket", "Bucket bekijken", "objects", "Bestanden bekijken"};
        List<Object> out = new ArrayList<>();
        S3Store.Probe b = probe(s, "buckets");
        if (good(b.status)) out.add(row("login", LOGIN, true, "Buckets: " + b.count));
        else if ("InvalidAccessKeyId".equals(b.code)) return loginFailed("De opslag herkent deze toegangssleutel niet. Kopieer hem opnieuw of maak een nieuwe.", rest);
        else if ("SignatureDoesNotMatch".equals(b.code)) return loginFailed("De geheime sleutel hoort niet bij deze toegangssleutel. Kopieer hem opnieuw.", rest);
        else if (b.status == 403) out.add(row("login", LOGIN, null, "Deze sleutel mag de lijst met buckets niet opvragen. Dat is niet erg als hij wel bij de eigen bucket kan."));
        else return loginFailed(failText(b.status, b.code), rest);
        if (bucket.isEmpty()) return out;
        S3Store.Probe h = probe(s, "bucket");
        String bl = "Bucket bekijken";
        if (good(h.status)) out.add(row("bucket", bl, true, bucket + " gevonden"));
        else if (h.status == 404) out.add(row("bucket", bl, null, bucket + " bestaat nog niet; de console maakt hem aan bij het koppelen."));
        else if (h.status == 403) out.add(row("bucket", bl, false, "Geen toegang tot " + bucket + ". Bestaat hij al bij iemand anders, of mag de sleutel er niet bij?"));
        else if (h.status == 301) out.add(row("bucket", bl, false, bucket + " staat in een andere regio dan deze opslag."));
        else out.add(row("bucket", bl, false, failText(h.status, h.code)));
        if (!good(h.status)) {
            out.add(row("objects", "Bestanden bekijken", null, "Niet gecontroleerd, want de bucket is niet te bekijken"));
            return out;
        }
        S3Store.Probe o = probe(s, "objects");
        if (good(o.status)) out.add(row("objects", "Bestanden bekijken", true));
        else if (o.status == 403) out.add(row("objects", "Bestanden bekijken", false, "De sleutel mag de bestanden in deze bucket niet bekijken. Geef hem lees- en schrijfrechten op de bucket."));
        else out.add(row("objects", "Bestanden bekijken", false, failText(o.status, o.code)));
        return out;
    }

    // ───────── The console route (keyChecks in src/console/server.ts) ─────────

    /** Given fields that count: strings, not empty, not masked ("••…"), trimmed. */
    private static Map<String, Object> given(Map<String, Object> fieldsIn) {
        Map<String, Object> out = Json.obj();
        if (fieldsIn != null) for (Map.Entry<String, Object> e : fieldsIn.entrySet()) {
            if (!(e.getValue() instanceof String)) continue;
            String v = (String) e.getValue();
            if (!v.isEmpty() && !v.startsWith("••")) out.put(e.getKey(), v.trim());
        }
        return out;
    }

    /** Scaleway: the access key (SCW…) of a store with the same secret key, so the rights can be read via IAM. */
    private static Map<String, Object> withAccessKey(Map<String, Object> c, Map<String, Object> f) {
        if (!Json.truthy(f.get("secretKey")) || Json.truthy(f.get("accessKey"))) return f;
        for (Map<String, Object> st : ClusterConfig.stores(c)) {
            if (Json.truthy(st.get("accessKey")) && f.get("secretKey").equals(st.get("secretKey"))) {
                Map<String, Object> out = Json.copy(f);
                out.put("accessKey", st.get("accessKey"));
                return out;
            }
        }
        return f;
    }

    /**
     * POST /api/check: kind "servers" or "dns" (id = provider) or "storage" (id = name of a linked store). Fields not
     * given come from the vault. Throws IllegalArgumentException with a Dutch message for an unknown kind or id.
     */
    public static List<Object> forConsole(Map<String, Object> c, Catalog catalog, String kind, String id, Map<String, Object> fieldsIn) throws IOException {
        if ("servers".equals(kind)) {
            Adapters.Adapter a = id == null ? null : Adapters.get(id);
            if (a == null || a.servers == null || catalog.serverOffer(id) == null) throw new IllegalArgumentException("Onbekende aanbieder");
            Map<String, Object> f = Json.obj();
            Map<String, Object> old = Json.map(c, "providers", id);
            if (old != null) f.putAll(old);
            f.putAll(given(fieldsIn));
            f = withAccessKey(c, f);
            if (a.servers.check != null) return a.servers.check.check(f);
            List<Catalog.RegionInfo> regions = catalog.serverRegions(id);
            return genericServers(id, f, Json.jsString(c.get("cluster")), regions.isEmpty() ? "" : regions.get(0).id);
        }
        if ("dns".equals(kind)) {
            Map<String, Object> f = withAccessKey(c, DnsSetup.fieldsFor(c, catalog, id, given(fieldsIn)));
            Adapters.Adapter a = Adapters.get(id);
            if (a.dns.check == null) return Json.list(row("login", LOGIN, null, "Deze aanbieder kan de console nog niet controleren"));
            return a.dns.check.check(f, c.get("domain") == null ? "" : Json.jsString(c.get("domain")));
        }
        if ("storage".equals(kind)) {
            Map<String, Object> st = null;
            for (Map<String, Object> x : ClusterConfig.stores(c)) if (id != null && id.equals(Json.str(x, "name"))) st = x;
            if (st == null) throw new IllegalArgumentException("Onbekende opslag");
            if (!"s3".equals(Json.str(st, "type"))) throw new IllegalArgumentException("Deze opslag is een map op deze computer; daar horen geen sleutels bij");
            Map<String, Object> cfg = Json.copy(st);
            Map<String, Object> g = given(fieldsIn);
            for (String k : new String[] {"accessKey", "secretKey"}) if (Json.truthy(g.get(k))) cfg.put(k, g.get(k));
            return storage(cfg);
        }
        throw new IllegalArgumentException("Kies servers, dns of storage");
    }
}
