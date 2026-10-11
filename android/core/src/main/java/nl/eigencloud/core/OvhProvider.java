package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * OVHcloud (France): Public Cloud instances in one project, and DNS (adapters/ovh.ts). API
 * https://eu.api.ovh.com/1.0 ({@link Endpoints#OVH}). Config: appKey, appSecret, consumerKey, projectId, image?.
 *
 * <p>Signature (as the official libraries python-ovh and node-ovh):
 * {@code X-Ovh-Signature = "$1$" + sha1_hex(AS + "+" + CK + "+" + METHOD + "+" + full URL + "+" + body + "+" + time)},
 * with the server time from GET /auth/time (asked once, kept as the difference with our own clock).
 */
public final class OvhProvider implements Provider {
    /** Waiting for a new instance's IP address (ovhTiming; tests set pollMs to 0). */
    public static volatile long pollMs = 5000;
    public static volatile int polls = 60;

    /** The rights a consumer key needs (OVH_ACCESS_RULES; "{projectId}" and "{zone}" or "*"). */
    public static List<String[]> accessRules(String projectId, String zone) {
        List<String[]> l = new ArrayList<>();
        l.add(new String[] {"GET", "/cloud/project/" + projectId + "/*"});
        l.add(new String[] {"POST", "/cloud/project/" + projectId + "/instance"});
        l.add(new String[] {"DELETE", "/cloud/project/" + projectId + "/instance/*"});
        l.add(new String[] {"GET", "/domain/zone/" + zone});
        l.add(new String[] {"GET", "/domain/zone/" + zone + "/*"});
        l.add(new String[] {"POST", "/domain/zone/" + zone + "/*"});
        l.add(new String[] {"DELETE", "/domain/zone/" + zone + "/record/*"});
        return l;
    }

    /** The registry entry (servers, storage, DNS; no Caddy module, no reverse DNS via the API). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("ovh",
            new Adapters.Servers(OvhProvider::new, OvhProvider::fetchSizes), true,
            new Adapters.Dns(OvhProvider::connect, Dns::new, null));

    /** "$1$" + sha1_hex(AS+CK+METHOD+URL+BODY+TS joined with "+") (ovhSign). */
    public static String sign(String appSecret, String consumerKey, String method, String url, String body, long timestamp) {
        String s = appSecret + "+" + consumerKey + "+" + method.toUpperCase(Locale.ROOT) + "+" + url + "+" + body + "+" + timestamp;
        return "$1$" + Bytes.hex(Bytes.sha1(Bytes.utf8(s)));
    }

    /** Signed calls with the server's clock. */
    static final class Client {
        private final Map<String, Object> cfg;
        private final String base = Endpoints.OVH.replaceAll("/$", "");
        private Long delta;

        Client(Map<String, Object> cfg) { this.cfg = cfg; }

        private long now() throws IOException {
            if (delta == null) {
                Object t = ProviderApi.call("GET", base + "/auth/time", null, null).json;
                delta = (long) Catalog.d(t) - System.currentTimeMillis() / 1000;
            }
            return System.currentTimeMillis() / 1000 + delta;
        }

        ProviderApi.Result call(String method, String pathq, Object body, int... okStatus) throws IOException {
            String url = base + pathq;
            String b = body == null ? "" : Json.stringify(body);
            long ts = now();
            Map<String, String> h = Http.headers(
                    "X-Ovh-Application", Adapters.fieldJs(cfg, "appKey"), "X-Ovh-Consumer", Adapters.fieldJs(cfg, "consumerKey"), "X-Ovh-Timestamp", Long.toString(ts),
                    "X-Ovh-Signature", sign(Adapters.fieldJs(cfg, "appSecret"), Adapters.fieldJs(cfg, "consumerKey"), method, url, b, ts), "content-type", "application/json");
            return ProviderApi.call(method, url, h, b.isEmpty() ? null : b, okStatus);
        }
    }

    private static final Object[][] COUNTRY = {
            {Pattern.compile("^(GRA|SBG|RBX|EU-WEST-PAR)"), "FR"}, {Pattern.compile("^DE"), "DE"}, {Pattern.compile("^WAW"), "PL"},
            {Pattern.compile("^UK"), "GB"}, {Pattern.compile("^(BHS|CA)"), "CA"}};
    private static final Pattern NODE = Pattern.compile("^n-[0-9a-z]+$");

    private final Map<String, Object> cfg;
    private final Client c;

    public OvhProvider(Map<String, Object> cfg) {
        if (!Json.truthy(cfg.get("projectId"))) throw new IllegalArgumentException("OVHcloud: vul het project-ID van je Public Cloud-project in");
        this.cfg = cfg;
        this.c = new Client(cfg);
    }

    private String p() { return "/cloud/project/" + Bytes.encodeURIComponent(Json.jsString(cfg.get("projectId"))); }

    @Override public String name() { return "ovh"; }

    @Override
    public String country(String region) {
        String r = region.toUpperCase(Locale.ROOT);
        for (Object[] x : COUNTRY) if (((Pattern) x[0]).matcher(r).find()) return (String) x[1];
        return "FR";
    }

    private String image(String region) throws IOException {
        String want = cfg.get("image") != null ? Json.jsString(cfg.get("image")) : "Ubuntu 24.04";
        Object json = c.call("GET", p() + "/image?osType=linux&region=" + Bytes.encodeURIComponent(region), null).json;
        Object img = null;
        for (Object i : Json.asList(json) == null ? new ArrayList<Object>() : Json.asList(json)) if (want.equals(Json.str(i, "name"))) { img = i; break; }
        if (img == null) for (Object i : Json.asList(json) == null ? new ArrayList<Object>() : Json.asList(json)) {
            String n = Json.str(i, "name");
            if (n != null && n.contains(want)) { img = i; break; }
        }
        if (img == null) throw new IOException("OVHcloud: geen image " + want + " in " + region);
        return Json.jsString(Json.path(img, "id"));
    }

    private String flavor(String region, String size) throws IOException {
        Object json = c.call("GET", p() + "/flavor?region=" + Bytes.encodeURIComponent(region), null).json;
        if (Json.asList(json) != null) for (Object f : Json.asList(json)) if (size.equals(Json.str(f, "name"))) return Json.jsString(Json.path(f, "id"));
        throw new IOException("OVHcloud: formaat " + size + " bestaat niet in " + region);
    }

    private static String pub(Object inst, int version) {
        for (Object a : Json.listAt(inst, "ipAddresses")) {
            Number v = Json.num(a, "version");
            if ("public".equals(Json.str(a, "type")) && v != null && v.doubleValue() == version) return Json.str(a, "ip");
        }
        return null;
    }

    @Override
    public ServerInfo create(CreateSpec s) throws IOException {
        String imageId = image(s.region), flavorId = flavor(s.region, s.size);
        Object inst = c.call("POST", p() + "/instance", Json.obj(
                "name", s.cluster + "-" + s.nodeId, "region", s.region, "flavorId", flavorId, "imageId", imageId, "userData", s.userData, "monthlyBilling", false)).json;
        // The IP address only comes once the instance is built.
        for (int i = 0; pub(inst, 4) == null && i < polls; i++) {
            ProviderApi.sleep(pollMs);
            inst = c.call("GET", p() + "/instance/" + Json.jsString(Json.path(inst, "id")), null).json;
            if ("ERROR".equals(Json.str(inst, "status"))) throw new IOException("OVHcloud: instance " + Json.jsString(Json.path(inst, "id")) + " kon niet starten");
        }
        ServerInfo info = new ServerInfo();
        info.serverId = Json.jsString(Json.path(inst, "id"));
        info.ipv4 = pub(inst, 4);
        info.ipv6 = pub(inst, 6);
        info.country = country(s.region);
        return info;
    }

    @Override
    public void destroy(String id) throws IOException {
        c.call("DELETE", p() + "/instance/" + Bytes.encodeURIComponent(id), null, 404);
    }

    /** OVHcloud instances have no labels: we recognise them by the name &lt;cluster&gt;-&lt;node id&gt;. */
    @Override
    public List<ServerRef> list(String cluster) throws IOException {
        Object json = c.call("GET", p() + "/instance", null).json;
        List<ServerRef> out = new ArrayList<>();
        if (Json.asList(json) != null) for (Object i : Json.asList(json)) {
            String name = Json.str(i, "name");
            if (name == null || !name.startsWith(cluster + "-")) continue;
            String node = name.substring(cluster.length() + 1);
            // Node ids are "n-<hex>"; so "eigen-x-n-1" (cluster eigen-x) does not fall under cluster "eigen".
            if (NODE.matcher(node).find()) out.add(new ServerRef(Json.jsString(Json.path(i, "id")), node));
        }
        return out;
    }

    /** No reverse DNS via the API for Public Cloud addresses (set it in the OVHcloud manager). */
    @Override public boolean supportsPtr() { return false; }

    @Override public void setPtr(ServerInfo server, String hostname) { /* not supported */ }

    // ───────── Sizes ─────────

    private static final Pattern FLAVORS = Pattern.compile("^(d2|b2|b3|c2|c3|r2|r3)-\\d+$", Pattern.CASE_INSENSITIVE);

    /** Linux flavours of the project in a region, with prices from the public catalogue (×730 hours), cheapest first. */
    public static List<Catalog.SizeOption> fetchSizes(Map<String, Object> cfg, String region) throws IOException {
        Client c = new Client(cfg);
        String project = cfg.get("projectId") == null ? "" : Json.jsString(cfg.get("projectId"));
        Object json = c.call("GET", "/cloud/project/" + Bytes.encodeURIComponent(project) + "/flavor?region=" + Bytes.encodeURIComponent(region), null).json;
        List<Object> flavors = new ArrayList<>();
        if (Json.asList(json) != null) for (Object f : Json.asList(json)) {
            String os = Json.str(f, "osType") == null ? "linux" : Json.str(f, "osType");
            String name = Json.str(f, "name");
            if (!Boolean.FALSE.equals(Json.path(f, "available")) && "linux".equals(os) && name != null && FLAVORS.matcher(name).find()) flavors.add(f);
        }
        // Prices from the public catalogue (no key needed). If that fails: "prijs onbekend".
        Map<String, Object> prices = new HashMap<>();
        try {
            Object cat = ProviderApi.call("GET", Endpoints.OVH.replaceAll("/$", "") + "/order/catalog/public/cloud?ovhSubsidiary=FR", null, null).json;
            for (Object a : Json.listAt(cat, "addons")) {
                List<Object> pr = Json.listAt(a, "pricings");
                if (!pr.isEmpty()) prices.put(Json.jsString(Json.path(a, "planCode")), Json.path(pr.get(0), "price"));
            }
        } catch (IOException | RuntimeException ignored) {
            // no prices
        }
        List<Catalog.SizeOption> out = new ArrayList<>();
        for (Object f : flavors) {
            Object hourlyCode = Json.path(f, "planCodes", "hourly");
            Object hourly = Json.truthy(hourlyCode) && prices.containsKey(Json.jsString(hourlyCode)) ? prices.get(Json.jsString(hourlyCode)) : null;
            // Catalogue prices are in 1/100,000,000 euro per hour; a month is 730 hours.
            Double monthly = hourly != null ? Catalog.jsRound((Catalog.d(hourly) / 1e8) * 730 * 100) / 100 : null;
            Object ram = Json.path(f, "ram"), vcpus = Json.path(f, "vcpus");
            out.add(new Catalog.SizeOption(Json.str(f, "name"), Json.jsString(vcpus) + " vCPU, " + Json.jsString(ram) + " GB", Catalog.d(ram), Catalog.d(vcpus), monthly));
        }
        Catalog.sortBy(out, s -> s.monthly != null ? s.monthly : s.ramGb * 3);
        return out;
    }

    // ───────── DNS ─────────

    /** Checks the keys and that the zone is at OVHcloud DNS; returns its nameservers. */
    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        ProviderApi.Result r = new Client(fields).call("GET", "/domain/zone/" + Bytes.encodeURIComponent(zone), null, 401, 403, 404);
        if (r.status == 401 || r.status == 403) throw new IOException("OVHcloud accepteert deze sleutels niet (controleer de rechten op /domain/zone)");
        if (r.status == 404) throw new IOException("Zone " + zone + " staat niet bij OVHcloud DNS. Zet hem eerst in het OVHcloud-beheer (Web Cloud → Domeinen).");
        List<String> ns = new ArrayList<>();
        for (Object n : Json.listAt(r.json, "nameServers")) ns.add(Json.jsString(n));
        if (ns.isEmpty()) {
            ns.add("dns.ovh.net");
            ns.add("ns.ovh.net");
        }
        return ns;
    }

    /** OVHcloud DNS: records of a zone (only what differs is changed), then the zone is refreshed. */
    public static final class Dns implements DnsProvider {
        private final String name, zone;
        private final Client c;

        public Dns(String name, Map<String, Object> fields, String zone) {
            this.name = name;
            this.zone = zone;
            this.c = new Client(fields);
        }

        @Override public String name() { return name; }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            String z = "/domain/zone/" + Bytes.encodeURIComponent(zone);
            Object ids = c.call("GET", z + "/record?fieldType=" + type + (sub.isEmpty() ? "" : "&subDomain=" + Bytes.encodeURIComponent(sub)), null).json;
            List<Object> mine = new ArrayList<>();
            if (Json.asList(ids) != null) for (Object id : Json.asList(ids)) {
                Object r = c.call("GET", z + "/record/" + Json.jsString(id), null).json;
                String rs = Json.str(r, "subDomain") == null ? "" : Json.str(r, "subDomain");
                if (rs.equals(sub)) mine.add(r);
            }
            Set<String> keep = new HashSet<>();
            List<String> todo = new ArrayList<>();
            for (String v : values) {
                Object same = null;
                for (Object r : mine) {
                    Object t = Json.path(r, "ttl");
                    if (!keep.contains(Json.jsString(Json.path(r, "id"))) && v.equals(Json.str(r, "target")) && t instanceof Number && ((Number) t).doubleValue() == ttl) { same = r; break; }
                }
                if (same != null) keep.add(Json.jsString(Json.path(same, "id")));
                else todo.add(v);
            }
            List<Object> stale = new ArrayList<>();
            for (Object r : mine) if (!keep.contains(Json.jsString(Json.path(r, "id")))) stale.add(r);
            for (Object r : stale) c.call("DELETE", z + "/record/" + Json.jsString(Json.path(r, "id")), null, 404);
            for (String v : todo) c.call("POST", z + "/record", Json.obj("fieldType", type, "subDomain", sub, "target", v, "ttl", (long) ttl));
            if (!todo.isEmpty() || !stale.isEmpty()) c.call("POST", z + "/refresh", null);
        }
    }
}
