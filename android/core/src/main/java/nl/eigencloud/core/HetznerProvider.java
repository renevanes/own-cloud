package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Hetzner Cloud (Germany, Finland): servers and DNS (adapters/hetzner.ts). Config: token, image?, sshKey?. */
public final class HetznerProvider implements Provider {
    /** The registry entry (servers, storage, DNS with a Caddy module). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("hetzner",
            new Adapters.Servers(HetznerProvider::new, HetznerProvider::fetchSizes, HetznerProvider::check), true,
            new Adapters.Dns(HetznerProvider::connect, (name, f, zone) -> new Dns(name, Adapters.field(f, "token"), zone),
                    f -> "dns hetzner " + Adapters.fieldJs(f, "token"), HetznerProvider::dnsCheck));

    private final Map<String, Object> cfg;
    private String base = Endpoints.HETZNER;

    public HetznerProvider(Map<String, Object> cfg) { this.cfg = cfg; }

    /** Overrides the API base URL (tests). */
    public HetznerProvider baseUrl(String base) {
        this.base = base;
        return this;
    }

    @Override public String name() { return "hetzner"; }

    private Map<String, String> h() {
        return Http.headers("authorization", "Bearer " + Json.jsString(cfg.get("token")), "content-type", "application/json");
    }

    @Override public String country(String region) { return region.startsWith("hel") ? "FI" : "DE"; }

    @Override
    public ServerInfo create(CreateSpec s) throws IOException {
        String name = (s.cluster + "-" + s.nodeId).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-");
        Map<String, Object> body = Json.obj(
                "name", Bytes.head(name, 63),
                "server_type", s.size,
                "image", cfg.get("image") != null ? cfg.get("image") : "ubuntu-24.04",
                "location", s.region,
                "user_data", s.userData,
                "labels", Json.obj("cluster", s.cluster, "node", s.nodeId, "kind", s.kind),
                "public_net", Json.obj("enable_ipv4", true, "enable_ipv6", true));
        if (Json.truthy(cfg.get("sshKey"))) body.put("ssh_keys", Json.list(cfg.get("sshKey")));
        Object json = ProviderApi.call("POST", base + "/servers", h(), Json.stringify(body)).json;
        Map<String, Object> srv = Json.map(json, "server");
        if (srv == null) throw new IOException("Hetzner: onverwacht antwoord");
        String v6net = Json.str(srv, "public_net", "ipv6", "ip");
        Double price = null;
        for (Object p : Json.listAt(srv, "server_type", "prices")) {
            if (s.region.equals(Json.str(p, "location"))) {
                Object gross = Json.path(p, "price_monthly", "gross");
                price = gross instanceof Number ? ((Number) gross).doubleValue() : Double.parseDouble(String.valueOf(gross));
                break;
            }
        }
        ServerInfo info = new ServerInfo();
        info.serverId = Json.jsString(srv.get("id"));
        info.ipv4 = Json.str(srv, "public_net", "ipv4", "ip");
        info.ipv6 = v6net != null ? v6net.replaceAll("/\\d+$", "").replaceAll("::$", "::1") : null;
        info.monthlyCost = price;
        info.country = country(s.region);
        return info;
    }

    @Override
    public void destroy(String id) throws IOException {
        ProviderApi.call("DELETE", base + "/servers/" + id, h(), null, 404);
    }

    @Override
    public List<ServerRef> list(String cluster) throws IOException {
        List<ServerRef> out = new ArrayList<>();
        for (int page = 1; ; page++) {
            Object json = ProviderApi.call("GET", base + "/servers?label_selector=" + Bytes.encodeURIComponent("cluster=" + cluster) + "&per_page=50&page=" + page, h(), null).json;
            for (Object s : Json.listAt(json, "servers")) out.add(new ServerRef(Json.jsString(Json.path(s, "id")), Json.str(s, "labels", "node")));
            if (!Json.truthy(Json.path(json, "meta", "pagination", "next_page"))) break;
        }
        return out;
    }

    @Override public boolean supportsPtr() { return true; }

    @Override
    public void setPtr(ServerInfo server, String hostname) throws IOException {
        for (String ip : new String[] {server.ipv4, server.ipv6}) {
            if (ip == null || ip.isEmpty()) continue;
            ProviderApi.call("POST", base + "/servers/" + server.serverId + "/actions/change_dns_ptr", h(), Json.stringify(Json.obj("ip", ip, "dns_ptr", hostname)));
        }
    }

    // ───────── Sizes ─────────

    /** Live server types with prices in a region (x86, not deprecated), cheapest first. */
    public static List<Catalog.SizeOption> fetchSizes(Map<String, Object> cfg, String region) throws IOException {
        List<Catalog.SizeOption> out = new ArrayList<>();
        Object j = Catalog.getJson(Endpoints.HETZNER + "/server_types?per_page=50", Http.headers("authorization", "Bearer " + Json.jsString(cfg.get("token"))));
        for (Object t : Json.listAt(j, "server_types")) {
            if (Json.truthy(Json.path(t, "deprecation")) || !"x86".equals(Json.str(t, "architecture"))) continue;
            Object price = null;
            for (Object p : Json.listAt(t, "prices")) if (region.equals(Json.str(p, "location"))) { price = p; break; }
            if (price == null) continue;
            Object mem = Json.path(t, "memory"), cores = Json.path(t, "cores");
            out.add(new Catalog.SizeOption(Json.str(t, "name"), Json.jsString(cores) + " vCPU, " + Json.jsString(mem) + " GB", Catalog.d(mem), Catalog.d(cores), Catalog.d(Json.path(price, "price_monthly", "gross"))));
        }
        Catalog.sortBy(out, s -> s.monthly != null ? s.monthly : 0);
        return out;
    }

    // ───────── Sleutels controleren (read-only; hetznerCheck in adapters/hetzner.ts) ─────────

    static final String KEY = "Hetzner herkent dit token niet. Maak een nieuw token: Hetzner Console → je project → Beveiliging → API-tokens.";
    /** Hetzner has no API showing whether a token may only read (docs.hetzner.com: Read = only GET). */
    static final String RIGHTS = "Kan de aanbieder niet laten zien; blijkt bij het starten. Kies bij het maken van het token 'Lezen en schrijven'.";

    /** GET /servers (log in, view servers), GET /server_types (sizes and prices). */
    public static List<Object> check(Map<String, Object> f) {
        Map<String, String> h = Http.headers("authorization", "Bearer " + Adapters.fieldJs(f, "token"));
        KeyCheck.Look s = KeyCheck.look(Endpoints.HETZNER + "/servers?per_page=1", h);
        String[] rest = {"servers", KeyCheck.SERVERS, "sizes", KeyCheck.SIZES, "rights", KeyCheck.RIGHTS};
        if (s.status == 401) return KeyCheck.loginFailed(KEY, rest);
        if (!s.good()) return KeyCheck.loginFailed(KeyCheck.failText(s), rest);
        KeyCheck.Look t = KeyCheck.look(Endpoints.HETZNER + "/server_types?per_page=50", h);
        return Json.list(KeyCheck.row("login", KeyCheck.LOGIN, true), KeyCheck.row("servers", KeyCheck.SERVERS, true),
                t.good() ? KeyCheck.row("sizes", KeyCheck.SIZES, true, KeyCheck.count(t.json, "server_types") + " formaten") : KeyCheck.row("sizes", KeyCheck.SIZES, false, KeyCheck.failText(t)),
                KeyCheck.row("rights", KeyCheck.RIGHTS, null, RIGHTS));
    }

    /** GET /zones?name=<zone> (Cloud API). */
    public static List<Object> dnsCheck(Map<String, Object> f, String zone) {
        KeyCheck.Look z = KeyCheck.look(Endpoints.HETZNER + "/zones?" + (zone.isEmpty() ? "per_page=1" : "name=" + Bytes.encodeURIComponent(zone)),
                Http.headers("authorization", "Bearer " + Adapters.fieldJs(f, "token")));
        String label = zone.isEmpty() ? KeyCheck.ZONES : KeyCheck.ZONE;
        String[] rest = {"zone", label, "rights", KeyCheck.DNS_RIGHTS};
        if (z.status == 401) return KeyCheck.loginFailed(KEY, rest);
        if (!z.good()) return KeyCheck.loginFailed(KeyCheck.failText(z) + ". Staat je DNS nog in de oude DNS-console? Verhuis de zone naar de Hetzner Console.", rest);
        boolean found = KeyCheck.count(z.json, "zones") > 0;
        return Json.list(KeyCheck.row("login", KeyCheck.LOGIN, true),
                zone.isEmpty() ? KeyCheck.row("zone", label, true) : found ? KeyCheck.row("zone", label, true, zone + " gevonden")
                        : KeyCheck.row("zone", label, false, "Maak eerst de zone " + zone + " aan in de Hetzner Console → DNS"),
                KeyCheck.row("rights", KeyCheck.DNS_RIGHTS, null, RIGHTS));
    }

    // ───────── DNS (Cloud API zones/rrsets) ─────────

    /** Checks the token and finds the zone's assigned nameservers. */
    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        Http.Response r = Http.request("GET", Endpoints.HETZNER + "/zones?name=" + zone, Http.headers("authorization", "Bearer " + Adapters.fieldJs(fields, "token")), null, 15_000);
        if (!r.ok()) throw new IOException("Hetzner accepteert dit token niet (of DNS staat nog in de oude DNS-console)");
        Object j = Json.parse(r.text());
        List<Object> zones = Json.listAt(j, "zones");
        if (zones.isEmpty()) throw new IOException("Maak eerst de zone " + zone + " aan in de Hetzner Console → DNS");
        List<Object> assigned = Json.asList(Json.path(zones.get(0), "authoritative_nameservers", "assigned"));
        List<String> ns = new ArrayList<>();
        if (assigned == null) {
            ns.add("hydrogen.ns.hetzner.com");
            ns.add("oxygen.ns.hetzner.com");
            ns.add("helium.ns.hetzner.de");
        } else for (Object a : assigned) ns.add(Json.jsString(a));
        return ns;
    }

    /** Hetzner DNS via the Cloud API (zones/rrsets). The zone must be in the new Hetzner Console. */
    public static final class Dns implements DnsProvider {
        private final String name, token, zone;
        private final String base = Endpoints.HETZNER;

        public Dns(String name, String token, String zone) {
            this.name = name;
            this.token = token;
            this.zone = zone;
        }

        @Override public String name() { return name; }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            String rr = base + "/zones/" + zone + "/rrsets";
            Map<String, String> h = Http.headers("authorization", "Bearer " + token, "content-type", "application/json");
            String n = sub == null || sub.isEmpty() ? "@" : sub;
            if (values.isEmpty()) {
                Http.Response r = Http.request("DELETE", rr + "/" + n + "/" + type, h, null, ProviderApi.TIMEOUT_MS);
                if (!r.ok() && r.status != 404) throw new IOException("Hetzner DNS delete " + n + "/" + type + ": " + r.status);
                return;
            }
            List<Object> records = new ArrayList<>();
            for (String v : values) records.add(Json.obj("value", v));
            Http.Response r = Http.request("POST", rr + "/" + n + "/" + type + "/actions/set_records", h, Bytes.utf8(Json.stringify(Json.obj("records", records))), ProviderApi.TIMEOUT_MS);
            if (r.status == 404) r = Http.request("POST", rr, h, Bytes.utf8(Json.stringify(Json.obj("name", n, "type", type, "ttl", (long) ttl, "records", records))), ProviderApi.TIMEOUT_MS);
            if (!r.ok()) throw new IOException("Hetzner DNS " + n + "/" + type + ": " + r.status + " " + Bytes.head(r.text(), 200));
        }
    }
}
