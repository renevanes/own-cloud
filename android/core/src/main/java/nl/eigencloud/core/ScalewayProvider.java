package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Scaleway (France, Netherlands, Poland): servers and DNS (adapters/scaleway.ts). Config: secretKey, projectId, imageLabel?. */
public final class ScalewayProvider implements Provider {
    /** The registry entry (servers, storage, DNS with a Caddy module: needs secretKey and organizationId). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("scaleway",
            new Adapters.Servers(ScalewayProvider::new, ScalewayProvider::fetchSizes, ScalewayProvider::check), true,
            new Adapters.Dns(ScalewayProvider::connect, (name, f, zone) -> new Dns(name, Adapters.field(f, "secretKey"), zone),
                    f -> Json.truthy(f.get("secretKey")) && Json.truthy(f.get("organizationId"))
                            ? "dns scaleway {\n\t\t\tsecret_key " + Adapters.fieldJs(f, "secretKey") + "\n\t\t\torganization_id " + Adapters.fieldJs(f, "organizationId") + "\n\t\t}"
                            : "", ScalewayProvider::dnsCheck));

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

    /**
     * Removes the cloud-init script (with secrets) at Scaleway once the server runs (clearUserData in TS). A server
     * that no longer exists is fine.
     */
    public void clearUserData(String serverId) throws IOException {
        String[] p = serverId.split("/", -1);
        ProviderApi.call("DELETE", base(p[0]) + "/servers/" + (p.length > 1 ? p[1] : "") + "/user_data/cloud-init", h(), null, 404);
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

    // ───────── Sleutels controleren (read-only; scalewayCheck in adapters/scaleway.ts) ─────────

    static final String KEY = "Scaleway herkent deze geheime sleutel niet. Maak een nieuwe: Console → IAM → API-sleutels.";

    /**
     * The key's rights via IAM (only with the access key, SCW…, which is not among the server fields but is with
     * Scaleway storage): API key → user (owner = everything) or application → groups → policies → rules with their
     * permission sets. When the key may not read IAM, it is unknown.
     */
    static Map<String, Object> rights(Map<String, Object> f, List<String> sets, String need, String label, String project) {
        String ak = Adapters.field(f, "accessKey");
        if (ak.isEmpty()) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
        String sk = Adapters.fieldJs(f, "secretKey");
        Map<String, String> h = Http.headers("x-auth-token", sk);
        String iam = Endpoints.SCALEWAY + "/iam/v1alpha1";
        KeyCheck.Look k = KeyCheck.look(iam + "/api-keys/" + Bytes.encodeURIComponent(ak), h);
        String ks = Json.str(k.json, "secret_key");
        if (!k.good() || (ks != null && !ks.isEmpty() && !ks.equals(sk))) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
        boolean user = Json.truthy(Json.path(k.json, "user_id"));
        String param = user ? "user_ids" : "application_ids";
        Object idv = user ? Json.path(k.json, "user_id") : Json.path(k.json, "application_id");
        String id = idv == null ? "" : Json.jsString(idv);
        KeyCheck.Look who = KeyCheck.look(iam + "/" + (user ? "users" : "applications") + "/" + Bytes.encodeURIComponent(id), h);
        if (!who.good()) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
        if ("owner".equals(Json.str(who.json, "type"))) return KeyCheck.row("rights", label, true, "De sleutel hoort bij de eigenaar van het account en mag alles");
        Object orgv = Json.path(who.json, "organization_id");
        String org = Bytes.encodeURIComponent(orgv == null ? "" : Json.jsString(orgv));
        KeyCheck.Look g = KeyCheck.look(iam + "/groups?organization_id=" + org + "&" + param + "=" + Bytes.encodeURIComponent(id) + "&page_size=100", h);
        if (!g.good()) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
        List<String> owners = new ArrayList<>();
        owners.add(param + "=" + Bytes.encodeURIComponent(id));
        for (Object x : Json.listAt(g.json, "groups")) owners.add("group_ids=" + Bytes.encodeURIComponent(Json.jsString(Json.path(x, "id"))));
        List<String> policies = new ArrayList<>();
        for (String o : owners) {
            KeyCheck.Look p = KeyCheck.look(iam + "/policies?organization_id=" + org + "&" + o + "&page_size=100", h);
            if (!p.good()) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
            for (Object x : Json.listAt(p.json, "policies")) {
                String pid = Json.jsString(Json.path(x, "id"));
                if (!policies.contains(pid)) policies.add(pid);
            }
        }
        for (String pid : policies) {
            KeyCheck.Look r = KeyCheck.look(iam + "/rules?policy_id=" + Bytes.encodeURIComponent(pid) + "&page_size=100", h);
            if (!r.good()) return KeyCheck.row("rights", label, null, KeyCheck.RIGHTS_HIDDEN);
            for (Object rule : Json.listAt(r.json, "rules")) {
                String hit = null;
                for (Object n : Json.listAt(rule, "permission_set_names")) if (sets.contains(Json.jsString(n))) { hit = Json.jsString(n); break; }
                boolean scope = Json.truthy(Json.path(rule, "organization_id")) || Json.truthy(Json.path(rule, "account_root_user_id")) || project.isEmpty()
                        || Json.listAt(rule, "project_ids").contains(project);
                if (hit != null && scope) return KeyCheck.row("rights", label, true, "Recht " + hit + " gevonden");
            }
        }
        return KeyCheck.row("rights", label, false, "De sleutel mist het recht " + need + ". Voeg het toe: Console → IAM → Beleid → je beleid → regel met " + need
                + (project.isEmpty() ? "" : " voor dit project") + ".");
    }

    /** View servers (instance API, Amsterdam 1), sizes and prices, and the rights via IAM. */
    public static List<Object> check(Map<String, Object> f) {
        Map<String, String> h = Http.headers("x-auth-token", Adapters.fieldJs(f, "secretKey"));
        String base = Endpoints.SCALEWAY + "/instance/v1/zones/nl-ams-1";
        String project = Adapters.field(f, "projectId");
        KeyCheck.Look s = KeyCheck.look(base + "/servers?per_page=1" + (project.isEmpty() ? "" : "&project=" + Bytes.encodeURIComponent(project)), h);
        String[] rest = {"servers", KeyCheck.SERVERS, "sizes", KeyCheck.SIZES, "rights", KeyCheck.RIGHTS};
        if (s.status == 401) return KeyCheck.loginFailed(KEY, rest);
        if (!s.good() && s.status != 403) return KeyCheck.loginFailed(KeyCheck.failText(s), rest);
        List<Object> out = Json.list(KeyCheck.row("login", KeyCheck.LOGIN, true));
        out.add(s.good() ? KeyCheck.row("servers", KeyCheck.SERVERS, true)
                : KeyCheck.row("servers", KeyCheck.SERVERS, false, "De sleutel mag geen servers bekijken. Geef hem het recht InstancesFullAccess: Console → IAM → Beleid."));
        KeyCheck.Look t = KeyCheck.look(base + "/products/servers?per_page=100", h);
        out.add(t.good() ? KeyCheck.row("sizes", KeyCheck.SIZES, true, KeyCheck.count(t.json, "servers") + " formaten") : KeyCheck.row("sizes", KeyCheck.SIZES, false, KeyCheck.failText(t)));
        out.add(rights(f, java.util.Arrays.asList("AllProductsFullAccess", "InstancesFullAccess"), "InstancesFullAccess", KeyCheck.RIGHTS, project));
        return out;
    }

    /** View the DNS zone (Domains and DNS) and the rights via IAM. */
    public static List<Object> dnsCheck(Map<String, Object> f, String zone) {
        KeyCheck.Look r = KeyCheck.look(Endpoints.SCALEWAY + "/domain/v2beta1/dns-zones?" + (zone.isEmpty() ? "page_size=1" : "dns_zone=" + Bytes.encodeURIComponent(zone)),
                Http.headers("x-auth-token", Adapters.fieldJs(f, "secretKey")));
        String label = zone.isEmpty() ? KeyCheck.ZONES : KeyCheck.ZONE;
        String[] rest = {"zone", label, "rights", KeyCheck.DNS_RIGHTS};
        if (r.status == 401) return KeyCheck.loginFailed(KEY, rest);
        if (!r.good() && r.status != 403) return KeyCheck.loginFailed(KeyCheck.failText(r), rest);
        List<Object> out = Json.list(KeyCheck.row("login", KeyCheck.LOGIN, true));
        boolean found = false;
        for (Object x : Json.listAt(r.json, "dns_zones")) {
            String sub = Json.str(x, "subdomain"), dom = Json.str(x, "domain");
            if (zone.equals(sub != null && !sub.isEmpty() ? sub + "." + dom : dom)) found = true;
        }
        if (r.status == 403) out.add(KeyCheck.row("zone", label, false, "De sleutel mag DNS niet bekijken. Geef hem het recht DomainsDNSFullAccess: Console → IAM → Beleid."));
        else if (zone.isEmpty()) out.add(KeyCheck.row("zone", label, true));
        else if (found) out.add(KeyCheck.row("zone", label, true, zone + " gevonden"));
        else out.add(KeyCheck.row("zone", label, false, "Zet " + zone + " eerst bij Scaleway: Console → Domains and DNS → domein toevoegen"));
        out.add(rights(f, java.util.Arrays.asList("AllProductsFullAccess", "DomainsDNSFullAccess"), "DomainsDNSFullAccess", KeyCheck.DNS_RIGHTS, ""));
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
            // Caddy (DNS-01) also needs the organization ID: look it up via the zone's project. The caller stores the
            // fields after connect, so it ends up in the DNS link. On failure (e.g. no read right): HTTP-01.
            String project = Json.str(z, "project_id");
            if (!Json.truthy(fields.get("organizationId")) && project != null && !project.isEmpty()) {
                try {
                    Http.Response p = Http.request("GET", Endpoints.SCALEWAY + "/account/v3/projects/" + Bytes.encodeURIComponent(project),
                            Http.headers("x-auth-token", Adapters.fieldJs(fields, "secretKey")), null, ProviderApi.TIMEOUT_MS);
                    String org = p.ok() ? Json.str(Json.parse(p.text()), "organization_id") : null;
                    if (org != null && !org.isEmpty()) fields.put("organizationId", org);
                } catch (Exception ignored) { /* HTTP-01 */ }
            }
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
