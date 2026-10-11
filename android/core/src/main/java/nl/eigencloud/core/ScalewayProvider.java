package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Scaleway (France, Netherlands, Poland): servers and DNS (adapters/scaleway.ts). Config: secretKey, projectId, imageLabel?. */
public final class ScalewayProvider implements Provider {
    /** The registry entry (servers, storage, DNS; no Caddy module). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("scaleway",
            new Adapters.Servers(ScalewayProvider::new, ScalewayProvider::fetchSizes), true,
            new Adapters.Dns(ScalewayProvider::connect, (name, f, zone) -> new Dns(name, Adapters.field(f, "secretKey"), zone), null));

    static final String[] ZONES = {"nl-ams-1", "nl-ams-2", "nl-ams-3", "fr-par-1", "fr-par-2", "fr-par-3", "pl-waw-1", "pl-waw-2", "pl-waw-3"};

    private final Map<String, Object> cfg;
    private String root = Endpoints.SCALEWAY;
    private long retryDelayMs = 5000;

    public ScalewayProvider(Map<String, Object> cfg) { this.cfg = cfg; }

    /** Overrides the API root URL, e.g. "http://127.0.0.1:1234" (tests). */
    public ScalewayProvider baseUrl(String root) {
        this.root = root;
        return this;
    }

    /** Delay between IP release attempts in destroy() (default 5 s). */
    public ScalewayProvider retryDelay(long ms) {
        this.retryDelayMs = ms;
        return this;
    }

    @Override public String name() { return "scaleway"; }

    private Map<String, String> h() { return h("application/json"); }

    private Map<String, String> h(String ct) {
        return Http.headers("x-auth-token", Json.jsString(cfg.get("secretKey")), "content-type", ct);
    }

    private String base(String zone) { return root + "/instance/v1/zones/" + zone; }

    @Override
    public String country(String region) { return region.startsWith("nl-") ? "NL" : region.startsWith("pl-") ? "PL" : "FR"; }

    private String image(String zone) throws IOException {
        String label = cfg.get("imageLabel") != null ? Json.jsString(cfg.get("imageLabel")) : "ubuntu_noble";
        Object json = ProviderApi.call("GET", root + "/marketplace/v2/local-images?image_label=" + label + "&zone=" + zone + "&type=instance_sbs", h(), null).json;
        String id = Json.str(json, "local_images", 0, "id");
        if (id == null || id.isEmpty()) throw new IOException("Scaleway: geen image " + label + " in " + zone);
        return id;
    }

    @Override
    public ServerInfo create(CreateSpec s) throws IOException {
        String zone = s.region;
        Object project = cfg.get("projectId");
        Map<String, Object> ipBody = Json.obj("project", project, "type", "routed_ipv4", "tags", Json.list("cluster=" + s.cluster, "node=" + s.nodeId));
        Map<String, Object> ip = Json.map(ProviderApi.call("POST", base(zone) + "/ips", h(), Json.stringify(ipBody)).json, "ip");
        if (ip == null) throw new IOException("Scaleway: onverwacht antwoord");
        String ipId = Json.jsString(ip.get("id"));
        try {
            String image = image(zone);
            Map<String, Object> body = Json.obj(
                    "name", s.cluster + "-" + s.nodeId, "commercial_type", s.size, "image", image, "project", project,
                    "public_ips", Json.list(ip.get("id")), "tags", Json.list("cluster=" + s.cluster, "node=" + s.nodeId, "kind=" + s.kind));
            Object json = ProviderApi.call("POST", base(zone) + "/servers", h(), Json.stringify(body)).json;
            String id = Json.str(json, "server", "id");
            ProviderApi.call("PATCH", base(zone) + "/servers/" + id + "/user_data/cloud-init", h("text/plain"), s.userData);
            ProviderApi.call("POST", base(zone) + "/servers/" + id + "/action", h(), Json.stringify(Json.obj("action", "poweron")));
            ServerInfo info = new ServerInfo();
            info.serverId = zone + "/" + id + "/" + ipId;
            info.ipv4 = Json.str(ip, "address");
            info.country = country(zone);
            return info;
        } catch (IOException | RuntimeException e) {
            try {
                ProviderApi.call("DELETE", base(zone) + "/ips/" + ipId, h(), null, 404);
            } catch (IOException | RuntimeException ignored) {
                // best effort
            }
            throw e;
        }
    }

    @Override
    public void destroy(String serverId) throws IOException {
        String[] p = serverId.split("/", -1);
        String zone = p[0], id = p.length > 1 ? p[1] : "", ipId = p.length > 2 ? p[2] : "";
        ProviderApi.call("POST", base(zone) + "/servers/" + id + "/action", h(), Json.stringify(Json.obj("action", "terminate")), 404);
        if (!ipId.isEmpty()) {
            // The IP is only released once the server is gone.
            for (int i = 0; i < 30; i++) {
                ProviderApi.Result r = ProviderApi.call("DELETE", base(zone) + "/ips/" + ipId, h(), null, 404, 409, 412);
                if (r.status < 300 || r.status == 404) break;
                ProviderApi.sleep(retryDelayMs);
            }
        }
    }

    @Override
    public List<ServerRef> list(String cluster) throws IOException {
        List<ServerRef> out = new ArrayList<>();
        for (String zone : ZONES) {
            Object json;
            try {
                json = ProviderApi.call("GET", base(zone) + "/servers?tags=" + Bytes.encodeURIComponent("cluster=" + cluster) + "&per_page=100", h(), null).json;
            } catch (IOException | RuntimeException e) {
                json = Json.obj();
            }
            for (Object srv : Json.listAt(json, "servers")) {
                String node = "";
                for (Object t : Json.listAt(srv, "tags")) {
                    if (t instanceof String && ((String) t).startsWith("node=")) { node = ((String) t).substring(5); break; }
                }
                String pip = Json.path(srv, "public_ips", 0, "id") != null ? Json.jsString(Json.path(srv, "public_ips", 0, "id")) : "";
                out.add(new ServerRef(zone + "/" + Json.jsString(Json.path(srv, "id")) + "/" + pip, node));
            }
        }
        return out;
    }

    @Override public boolean supportsPtr() { return false; }

    @Override public void setPtr(ServerInfo server, String hostname) { /* not supported */ }

    // ───────── Sizes ─────────

    private static final Pattern TYPES = Pattern.compile("^(DEV1|PLAY2|PRO2|GP1|STARDUST|POP2)", Pattern.CASE_INSENSITIVE);

    /** Live server types (x86) with monthly prices, cheapest first. */
    public static List<Catalog.SizeOption> fetchSizes(Map<String, Object> cfg, String region) throws IOException {
        List<Catalog.SizeOption> out = new ArrayList<>();
        Object j = Catalog.getJson(Endpoints.SCALEWAY + "/instance/v1/zones/" + region + "/products/servers?per_page=100", Http.headers("x-auth-token", Json.jsString(cfg.get("secretKey"))));
        Map<String, Object> srv = Json.map(j, "servers");
        if (srv == null) throw new IOException("Scaleway: onverwacht antwoord");
        for (Map.Entry<String, Object> e : srv.entrySet()) {
            Object s = e.getValue();
            if (!TYPES.matcher(e.getKey()).find() || !"x86_64".equals(Json.str(s, "arch"))) continue;
            double ram = Catalog.jsRound(Catalog.d(Json.path(s, "ram")) / Math.pow(1024, 3));
            Object ncpus = Json.path(s, "ncpus");
            Object mp = Json.path(s, "monthly_price");
            Double monthly;
            if (mp != null) monthly = Catalog.d(mp);
            else {
                Object hp = Json.path(s, "hourly_price");
                monthly = Json.truthy(hp) ? Catalog.jsRound(Catalog.d(hp) * 730 * 100) / 100 : null;
            }
            out.add(new Catalog.SizeOption(e.getKey(), Json.jsString(ncpus) + " vCPU, " + Json.numberToString(ram) + " GB", ram, Catalog.d(ncpus), monthly));
        }
        Catalog.sortBy(out, s -> s.monthly != null ? s.monthly : 999);
        return out;
    }

    // ───────── DNS (Domains and DNS, domain/v2beta1) ─────────

    /** Checks the key and that the zone is in Domains and DNS; returns its nameservers. */
    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        Http.Response r = Http.request("GET", Endpoints.SCALEWAY + "/domain/v2beta1/dns-zones?dns_zone=" + Bytes.encodeURIComponent(zone),
                Http.headers("x-auth-token", Adapters.fieldJs(fields, "secretKey")), null, ProviderApi.TIMEOUT_MS);
        if (r.status == 401 || r.status == 403) throw new IOException("Scaleway accepteert deze sleutel niet voor DNS (recht DomainsDNSFullAccess nodig)");
        if (!r.ok()) throw new IOException("Scaleway DNS: " + r.status + " " + Bytes.head(r.text(), 160));
        Object j = Json.parse(r.text());
        for (Object z : Json.listAt(j, "dns_zones")) {
            String sub = Json.str(z, "subdomain"), dom = Json.str(z, "domain");
            String full = sub != null && !sub.isEmpty() ? sub + "." + dom : dom;
            if (!zone.equals(full)) continue;
            List<Object> ns = Json.listAt(z, "ns");
            if (ns.isEmpty()) ns = Json.listAt(z, "ns_default");
            List<String> out = new ArrayList<>();
            for (Object n : ns) out.add(Json.jsString(n));
            if (out.isEmpty()) {
                out.add("ns0.dom.scw.cloud");
                out.add("ns1.dom.scw.cloud");
            }
            return out;
        }
        throw new IOException("Zet " + zone + " eerst bij Scaleway: Console → Domains and DNS → domein toevoegen");
    }

    /**
     * Scaleway Domains and DNS: all records of a name+type replaced with one PATCH ("set"), or removed ("delete").
     * Not tested against a live account (MX as data + priority, TXT without quotes), see PROVIDERS.md.
     */
    public static final class Dns implements DnsProvider {
        private final String name, secretKey, zone;
        private final String root = Endpoints.SCALEWAY;

        public Dns(String name, String secretKey, String zone) {
            this.name = name;
            this.secretKey = secretKey;
            this.zone = zone;
        }

        @Override public String name() { return name; }

        /** The PATCH body for one setRecords call (also used by the golden tests). */
        static Map<String, Object> body(String sub, String type, List<String> values, int ttl) {
            Map<String, Object> idFields = Json.obj("name", sub, "type", type);
            List<Object> records = new ArrayList<>();
            for (String v : values) {
                if ("MX".equals(type)) {
                    DnsProvider.Mx mx = DnsProvider.parseMx(v);
                    records.add(Json.obj("name", sub, "type", type, "ttl", (long) ttl, "data", mx.host + ".", "priority", mx.priority));
                } else {
                    records.add(Json.obj("name", sub, "type", type, "ttl", (long) ttl, "data", "TXT".equals(type) ? DnsProvider.unquoteTxt(v) : v));
                }
            }
            Map<String, Object> change = values.isEmpty() ? Json.obj("delete", Json.obj("id_fields", idFields))
                    : Json.obj("set", Json.obj("id_fields", idFields, "records", records));
            return Json.obj("changes", Json.list(change), "return_all_records", false);
        }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            String url = root + "/domain/v2beta1/dns-zones/" + Bytes.encodeURIComponent(zone) + "/records";
            Map<String, String> h = Http.headers("x-auth-token", secretKey, "content-type", "application/json");
            if (values.isEmpty()) ProviderApi.call("PATCH", url, h, Json.stringify(body(sub, type, values, ttl)), 404);
            else ProviderApi.call("PATCH", url, h, Json.stringify(body(sub, type, values, ttl)));
        }
    }
}
