package nl.eigencloud.core;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Exoscale (Switzerland; zones in CH, DE, AT and BG): servers and DNS (adapters/exoscale.ts). Compute API v2 on
 * https://api-&lt;zone&gt;.exoscale.com/v2 ({@link Endpoints#EXOSCALE}). Config: apiKey, apiSecret, template?, diskGb?.
 *
 * <p>Signature EXO2-HMAC-SHA256 (as the reference implementation requests-exoscale-auth):
 * <pre>
 *   message   = "&lt;METHOD&gt; &lt;path without query&gt;\n&lt;body&gt;\n&lt;query values, sorted by name, concatenated&gt;\n\n&lt;expires&gt;"
 *   signature = base64(HMAC-SHA256(secret, message))
 *   header    = "EXO2-HMAC-SHA256 credential=&lt;key&gt;[,signed-query-args=&lt;a;b&gt;],expires=&lt;unix time&gt;,signature=&lt;…&gt;"
 * </pre>
 */
public final class ExoscaleProvider implements Provider {
    public static final List<String> ZONES = Collections.unmodifiableList(Arrays.asList("ch-gva-2", "ch-dk-2", "de-fra-1", "de-muc-1", "at-vie-1", "at-vie-2", "bg-sof-1"));

    /** Time between polls of a running operation, and how many (exoTiming; tests set pollMs to 0). */
    public static volatile long pollMs = 2000;
    public static volatile int polls = 90;

    /** The registry entry (servers, storage, DNS; no Caddy module). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("exoscale",
            new Adapters.Servers(ExoscaleProvider::new, ExoscaleProvider::fetchSizes), true,
            new Adapters.Dns(ExoscaleProvider::connect, Dns::new, null));

    private static final String SG_NAME = "eigen-cloud";
    /** The DNS API is global; we talk to zone ch-gva-2. */
    private static final String DNS_ZONE = "ch-gva-2";

    private final Map<String, Object> cfg;
    private final String base = Endpoints.EXOSCALE;
    private final Map<String, String> sg = new HashMap<>();

    public ExoscaleProvider(Map<String, Object> cfg) { this.cfg = cfg; }

    @Override public String name() { return "exoscale"; }

    @Override public String country(String zone) { return Bytes.head(zone, 2).toUpperCase(Locale.ROOT); }

    // ───────── Signed requests ─────────

    /** API base of a zone (exoBase). */
    static String base(String template, String zone) { return template.replace("{zone}", zone).replaceAll("/$", ""); }

    /** The Authorization header for a request (exoSign). */
    public static String sign(String method, String url, String body, String key, String secret, long expires) {
        URI u;
        try {
            u = new URI(url);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("Ongeldige URL " + url, e);
        }
        Map<String, List<String>> params = new LinkedHashMap<>();
        String q = u.getRawQuery();
        if (q != null && !q.isEmpty()) {
            for (String part : q.split("&")) {
                if (part.isEmpty()) continue;
                int eq = part.indexOf('=');
                String k = Bytes.decodeURIComponent((eq < 0 ? part : part.substring(0, eq)).replace('+', ' '));
                String v = eq < 0 ? "" : Bytes.decodeURIComponent(part.substring(eq + 1).replace('+', ' '));
                List<String> l = params.get(k);
                if (l == null) params.put(k, l = new ArrayList<>());
                l.add(v);
            }
        }
        List<String> names = new ArrayList<>(params.keySet());
        Collections.sort(names);
        StringBuilder values = new StringBuilder();
        for (String n : names) if (params.get(n).size() == 1) values.append(params.get(n).get(0));
        String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
        String message = method.toUpperCase(Locale.ROOT) + " " + path + "\n" + body + "\n" + values + "\n\n" + expires;
        String signature = Bytes.base64(Bytes.hmacSha256(Bytes.utf8(secret), message));
        return "EXO2-HMAC-SHA256 credential=" + key + (names.isEmpty() ? "" : ",signed-query-args=" + String.join(";", names))
                + ",expires=" + expires + ",signature=" + signature;
    }

    /** A signed request to the API in a zone (valid for 10 minutes). */
    static ProviderApi.Result exo(Map<String, Object> cfg, String template, String zone, String method, String pathq, Object body, int... okStatus) throws IOException {
        String url = base(template, zone) + pathq;
        String b = body == null ? "" : Json.stringify(body);
        String auth = sign(method, url, b, Adapters.fieldJs(cfg, "apiKey"), Adapters.fieldJs(cfg, "apiSecret"), System.currentTimeMillis() / 1000 + 600);
        return ProviderApi.call(method, url, Http.headers("authorization", auth, "content-type", "application/json"), b.isEmpty() ? null : b, okStatus);
    }

    private ProviderApi.Result exo(String zone, String method, String pathq, Object body, int... okStatus) throws IOException {
        return exo(cfg, base, zone, method, pathq, body, okStatus);
    }

    /** Waits until an operation is done; returns the id of the object it concerns (may be null). */
    static String waitOp(Map<String, Object> cfg, String template, String zone, Object op) throws IOException {
        for (int i = 0; i < polls; i++) {
            String state = Json.str(op, "state");
            if ("success".equals(state)) return refId(op);
            if ("failure".equals(state) || "timeout".equals(state)) {
                String why = Json.str(op, "message") != null ? Json.str(op, "message") : Json.str(op, "reason") != null ? Json.str(op, "reason") : state;
                throw new IOException("Exoscale: " + why);
            }
            if (!Json.truthy(Json.path(op, "id"))) return refId(op);
            ProviderApi.sleep(pollMs);
            op = exo(cfg, template, zone, "GET", "/operation/" + Json.jsString(Json.path(op, "id")), null).json;
        }
        throw new IOException("Exoscale: operatie duurt te lang");
    }

    private static String refId(Object op) {
        Object id = Json.path(op, "reference", "id");
        return id == null ? null : Json.jsString(id);
    }

    // ───────── Servers ─────────

    private String template(String zone) throws IOException {
        String want = cfg.get("template") != null ? Json.jsString(cfg.get("template")) : "Ubuntu 24.04";
        Object json = exo(zone, "GET", "/template?visibility=public", null).json;
        Object best = null;
        String bestAt = null;
        for (Object t : Json.listAt(json, "templates")) {
            String name = Json.str(t, "name");
            if (name == null || !name.contains(want)) continue;
            List<Object> zones = Json.asList(Json.path(t, "zones"));
            if (zones != null && !zones.contains(zone)) continue;
            String at = Json.path(t, "created-at") == null ? "" : Json.jsString(Json.path(t, "created-at"));
            // Newest first (stable: the first of equal dates wins, like Array.prototype.sort).
            if (best == null || at.compareTo(bestAt) > 0) { best = t; bestAt = at; }
        }
        if (best == null) throw new IOException("Exoscale: geen template " + want + " in " + zone);
        return Json.jsString(Json.path(best, "id"));
    }

    private String instanceType(String zone, String size) throws IOException {
        Object json = exo(zone, "GET", "/instance-type", null).json;
        for (Object t : Json.listAt(json, "instance-types")) {
            if ((Json.jsString(Json.path(t, "family")) + "." + Json.jsString(Json.path(t, "size"))).equals(size)) return Json.jsString(Json.path(t, "id"));
        }
        throw new IOException("Exoscale: formaat " + size + " bestaat niet");
    }

    /**
     * Exoscale lets nothing in by default. One security group "eigen-cloud" lets everything through; the firewall
     * on the server itself (ufw, via cloud-init) decides which ports are really open.
     */
    private String securityGroup(String zone) throws IOException {
        String hit = sg.get(zone);
        if (hit != null) return hit;
        Object json = exo(zone, "GET", "/security-group", null).json;
        String id = null;
        for (Object g : Json.listAt(json, "security-groups")) if (SG_NAME.equals(Json.str(g, "name"))) { id = Json.jsString(Json.path(g, "id")); break; }
        if (id == null) {
            id = waitOp(cfg, base, zone, exo(zone, "POST", "/security-group", Json.obj("name", SG_NAME, "description", "Eigen Cloud: alles door, de server filtert zelf (ufw)")).json);
            if (id == null || id.isEmpty()) throw new IOException("Exoscale: security group aanmaken mislukt");
            List<Object> rules = Json.list(
                    Json.obj("flow-direction", "ingress", "protocol", "tcp", "start-port", 1L, "end-port", 65535L, "network", "0.0.0.0/0"),
                    Json.obj("flow-direction", "ingress", "protocol", "tcp", "start-port", 1L, "end-port", 65535L, "network", "::/0"),
                    Json.obj("flow-direction", "ingress", "protocol", "icmp", "network", "0.0.0.0/0", "icmp", Json.obj("type", -1L, "code", -1L)),
                    Json.obj("flow-direction", "ingress", "protocol", "icmpv6", "network", "::/0", "icmp", Json.obj("type", -1L, "code", -1L)));
            for (Object rule : rules) waitOp(cfg, base, zone, exo(zone, "POST", "/security-group/" + id + "/rules", rule).json);
        }
        sg.put(zone, id);
        return id;
    }

    private Object diskSize() {
        Object v = cfg.get("diskGb");
        if (v == null) return 25L;
        double d = Catalog.d(v);
        return d == Math.rint(d) && Math.abs(d) < 1e15 ? (Object) (long) d : (Object) d;
    }

    @Override
    public ServerInfo create(CreateSpec s) throws IOException {
        String zone = s.region;
        String template = template(zone), type = instanceType(zone, s.size), group = securityGroup(zone);
        String name = Bytes.head((s.cluster + "-" + s.nodeId).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-"), 63);
        Map<String, Object> body = Json.obj(
                "name", name,
                "instance-type", Json.obj("id", type),
                "template", Json.obj("id", template),
                "disk-size", diskSize(),
                "user-data", Bytes.base64(Bytes.utf8(s.userData)),
                "labels", Json.obj("cluster", s.cluster, "node", s.nodeId, "kind", s.kind),
                "security-groups", Json.list(Json.obj("id", group)),
                "public-ip-assignment", "inet4",
                "ipv6-enabled", true,
                "auto-start", true);
        String id = waitOp(cfg, base, zone, exo(zone, "POST", "/instance", body).json);
        if (id == null || id.isEmpty()) throw new IOException("Exoscale: geen server-id in het antwoord");
        Object json = exo(zone, "GET", "/instance/" + id, null).json;
        ServerInfo info = new ServerInfo();
        info.serverId = zone + "/" + id;
        info.ipv4 = Json.str(json, "public-ip");
        String v6 = Json.str(json, "ipv6-address");
        info.ipv6 = v6 == null || v6.isEmpty() ? null : v6;
        info.country = country(zone);
        return info;
    }

    @Override
    public void destroy(String serverId) throws IOException {
        String[] p = serverId.split("/", -1);
        exo(p[0], "DELETE", "/instance/" + (p.length > 1 ? p[1] : "undefined"), null, 404);
    }

    @Override
    public List<ServerRef> list(String cluster) throws IOException {
        List<ServerRef> out = new ArrayList<>();
        List<IOException> errors = new ArrayList<>();
        for (String zone : ZONES) {
            try {
                Object json = exo(zone, "GET", "/instance", null).json;
                for (Object i : Json.listAt(json, "instances")) {
                    if (!cluster.equals(Json.str(i, "labels", "cluster"))) continue;
                    String node = Json.str(i, "labels", "node");
                    out.add(new ServerRef(zone + "/" + Json.jsString(Json.path(i, "id")), node == null ? "" : node));
                }
            } catch (HttpException e) {
                if (e.status == 401 || e.status == 403) throw e;
                errors.add(e);
            } catch (IOException e) {
                errors.add(e);
            }
        }
        if (errors.size() == ZONES.size()) throw errors.get(0);
        return out;
    }

    @Override public boolean supportsPtr() { return true; }

    @Override
    public void setPtr(ServerInfo server, String hostname) throws IOException {
        String[] p = server.serverId.split("/", -1);
        exo(p[0], "POST", "/reverse-dns/instance/" + (p.length > 1 ? p[1] : "undefined"), Json.obj("domain-name", hostname));
    }

    // ───────── Sizes ─────────

    /** "standard" instance types allowed for the account in the zone. Exoscale has no price API: monthly is null. */
    public static List<Catalog.SizeOption> fetchSizes(Map<String, Object> cfg, String zone) throws IOException {
        Object json = exo(cfg, Endpoints.EXOSCALE, zone, "GET", "/instance-type", null).json;
        List<Catalog.SizeOption> out = new ArrayList<>();
        for (Object t : Json.listAt(json, "instance-types")) {
            if (!"standard".equals(Json.str(t, "family")) || Boolean.FALSE.equals(Json.path(t, "authorized"))) continue;
            List<Object> zones = Json.asList(Json.path(t, "zones"));
            if (zones != null && !zones.contains(zone)) continue;
            double ramGb = Catalog.jsRound(Catalog.d(Json.path(t, "memory")) / Math.pow(1024, 3) * 100) / 100;
            Object cpus = Json.path(t, "cpus");
            out.add(new Catalog.SizeOption(Json.jsString(Json.path(t, "family")) + "." + Json.jsString(Json.path(t, "size")),
                    Json.jsString(cpus) + " vCPU, " + Json.numberToString(ramGb) + " GB", ramGb, Catalog.d(cpus), null));
        }
        Catalog.sortByRamCpus(out);
        return out;
    }

    // ───────── DNS ─────────

    /** Checks the key for DNS and creates the zone when it is not there yet; returns Exoscale's nameservers. */
    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        String template = Endpoints.EXOSCALE;
        Object list;
        try {
            list = exo(fields, template, DNS_ZONE, "GET", "/dns-domain", null).json;
        } catch (HttpException e) {
            if (e.status == 401 || e.status == 403) throw new IOException("Exoscale accepteert deze sleutel niet voor DNS");
            throw e;
        }
        boolean found = false;
        for (Object d : Json.listAt(list, "dns-domains")) if (zone.equals(Json.str(d, "unicode-name"))) found = true;
        if (!found) {
            try {
                waitOp(fields, template, DNS_ZONE, exo(fields, template, DNS_ZONE, "POST", "/dns-domain", Json.obj("unicode-name", zone)).json);
            } catch (IOException e) {
                throw new IOException("Zone " + zone + " aanmaken bij Exoscale mislukt (heb je een DNS-abonnement?): " + Bytes.head(String.valueOf(e.getMessage()), 160), e);
            }
        }
        return new ArrayList<>(Arrays.asList("ns1.exoscale.ch", "ns1.exoscale.com", "ns1.exoscale.io", "ns1.exoscale.net"));
    }

    /** Exoscale DNS (v2 dns-domain and records): updates records in place (upsert), skips what is already right. */
    public static final class Dns implements DnsProvider {
        private final String name, zone;
        private final Map<String, Object> cfg;
        private final String base = Endpoints.EXOSCALE;
        private String domainId;

        public Dns(String name, Map<String, Object> fields, String zone) {
            this.name = name;
            this.cfg = fields;
            this.zone = zone;
        }

        @Override public String name() { return name; }

        private ProviderApi.Result exo(String method, String pathq, Object body, int... okStatus) throws IOException {
            return ExoscaleProvider.exo(cfg, base, DNS_ZONE, method, pathq, body, okStatus);
        }

        private String domain() throws IOException {
            if (domainId != null) return domainId;
            Object json = exo("GET", "/dns-domain", null).json;
            for (Object d : Json.listAt(json, "dns-domains")) {
                if (zone.equals(Json.str(d, "unicode-name"))) return domainId = Json.jsString(Json.path(d, "id"));
            }
            throw new IOException("Exoscale DNS: zone " + zone + " niet gevonden");
        }

        private static boolean sameNumber(Object a, long b) { return a instanceof Number && ((Number) a).doubleValue() == b; }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            String dom = domain();
            Object json = exo("GET", "/dns-domain/" + dom + "/record", null).json;
            List<Object> existing = new ArrayList<>();
            for (Object r : Json.listAt(json, "dns-domain-records")) {
                if (sub.equals(Json.str(r, "name")) && type.equals(Json.str(r, "type")) && !Json.truthy(Json.path(r, "system-record"))) existing.add(r);
            }
            // Wanted records: {content, priority (MX only)}.
            List<Object[]> want = new ArrayList<>();
            for (String v : values) {
                if ("MX".equals(type)) {
                    DnsProvider.Mx mx = DnsProvider.parseMx(v);
                    want.add(new Object[] {mx.host, mx.priority});
                } else want.add(new Object[] {"TXT".equals(type) ? DnsProvider.unquoteTxt(v) : v, null});
            }
            // Update in place: reuse existing records, skip what is already right, remove the rest.
            Set<String> keep = new HashSet<>();
            List<Object[]> todo = new ArrayList<>();
            for (Object[] w : want) {
                Object same = null;
                for (Object r : existing) {
                    String id = Json.jsString(Json.path(r, "id"));
                    if (keep.contains(id) || !w[0].equals(Json.str(r, "content")) || !sameNumber(Json.path(r, "ttl"), ttl)) continue;
                    if (w[1] != null && !sameNumber(Json.path(r, "priority"), (Long) w[1])) continue;
                    same = r;
                    break;
                }
                if (same != null) keep.add(Json.jsString(Json.path(same, "id")));
                else todo.add(w);
            }
            List<Object> free = new ArrayList<>();
            for (Object r : existing) if (!keep.contains(Json.jsString(Json.path(r, "id")))) free.add(r);
            for (Object[] w : todo) {
                Object r = free.isEmpty() ? null : free.remove(0);
                Map<String, Object> b = r != null ? Json.obj("content", w[0], "ttl", (long) ttl) : Json.obj("name", sub, "type", type, "content", w[0], "ttl", (long) ttl);
                if (w[1] != null) b.put("priority", w[1]);
                if (r != null) exo("PUT", "/dns-domain/" + dom + "/record/" + Json.jsString(Json.path(r, "id")), b);
                else exo("POST", "/dns-domain/" + dom + "/record", b);
            }
            for (Object r : free) exo("DELETE", "/dns-domain/" + dom + "/record/" + Json.jsString(Json.path(r, "id")), null, 404);
        }
    }
}
