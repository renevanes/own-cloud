package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** UpCloud (Finland; zones in Amsterdam, Frankfurt …). Config: token, or username + password; template?, sshKey?. */
public final class UpCloudProvider implements Provider {
    private final Map<String, Object> cfg;
    private String base = Endpoints.UPCLOUD;
    private long pollDelayMs = 3000;

    public UpCloudProvider(Map<String, Object> cfg) { this.cfg = cfg; }

    /** Overrides the API base URL (tests). */
    public UpCloudProvider baseUrl(String base) {
        this.base = base;
        return this;
    }

    /** Delay between state polls in destroy() (default 3 s). */
    public UpCloudProvider pollDelay(long ms) {
        this.pollDelayMs = ms;
        return this;
    }

    @Override public String name() { return "upcloud"; }

    private Map<String, String> h() {
        String auth = Json.truthy(cfg.get("token")) ? "Bearer " + Json.jsString(cfg.get("token"))
                : "Basic " + Bytes.base64(Bytes.utf8(jsOrUndefined(cfg.get("username")) + ":" + jsOrUndefined(cfg.get("password"))));
        return Http.headers("authorization", auth, "content-type", "application/json");
    }

    private static String jsOrUndefined(Object v) { return v == null ? "undefined" : Json.jsString(v); }

    @Override public String country(String region) { return Bytes.head(region, 2).toUpperCase(Locale.ROOT); }

    private String template() throws IOException {
        String want = cfg.get("template") != null ? Json.jsString(cfg.get("template")) : "Ubuntu Server 24.04";
        Object json = ProviderApi.call("GET", base + "/storage/template", h(), null).json;
        for (Object s : Json.listAt(json, "storages", "storage")) {
            String title = Json.str(s, "title");
            if (title != null && title.contains(want)) return Json.jsString(Json.path(s, "uuid"));
        }
        throw new IOException("UpCloud: template " + want + " niet gevonden");
    }

    @Override
    public ServerInfo create(CreateSpec s) throws IOException {
        String tpl = template();
        Map<String, Object> login = Json.obj("username", "root", "create_password", "no");
        if (Json.truthy(cfg.get("sshKey"))) login.put("ssh_keys", Json.obj("ssh_key", Json.list(cfg.get("sshKey"))));
        Map<String, Object> server = Json.obj(
                "zone", s.region, "title", s.cluster + "-" + s.nodeId, "hostname", s.nodeId + "." + s.cluster, "plan", s.size, "metadata", "yes", "user_data", s.userData,
                "labels", Json.obj("label", Json.list(Json.obj("key", "cluster", "value", s.cluster), Json.obj("key", "node", "value", s.nodeId), Json.obj("key", "kind", "value", s.kind))),
                "storage_devices", Json.obj("storage_device", Json.list(Json.obj("action", "clone", "storage", tpl, "title", "root", "size", 25L, "tier", "maxiops"))),
                "networking", Json.obj("interfaces", Json.obj("interface", Json.list(
                        Json.obj("type", "public", "ip_addresses", Json.obj("ip_address", Json.list(Json.obj("family", "IPv4")))),
                        Json.obj("type", "public", "ip_addresses", Json.obj("ip_address", Json.list(Json.obj("family", "IPv6")))),
                        Json.obj("type", "utility", "ip_addresses", Json.obj("ip_address", Json.list(Json.obj("family", "IPv4"))))))),
                "login_user", login);
        Object json = ProviderApi.call("POST", base + "/server", h(), Json.stringify(Json.obj("server", server))).json;
        ServerInfo info = new ServerInfo();
        info.serverId = Json.str(json, "server", "uuid");
        for (Object ip : Json.listAt(json, "server", "ip_addresses", "ip_address")) {
            if (!"public".equals(Json.str(ip, "access"))) continue;
            if ("IPv4".equals(Json.str(ip, "family")) && info.ipv4 == null) info.ipv4 = Json.str(ip, "address");
            if ("IPv6".equals(Json.str(ip, "family")) && info.ipv6 == null) info.ipv6 = Json.str(ip, "address");
        }
        info.country = country(s.region);
        return info;
    }

    @Override
    public void destroy(String uuid) throws IOException {
        ProviderApi.Result r = ProviderApi.call("POST", base + "/server/" + uuid + "/stop", h(),
                Json.stringify(Json.obj("stop_server", Json.obj("stop_type", "hard", "timeout", "60"))), 400, 404, 409);
        if (r.status == 404) return;
        for (int i = 0; i < 40; i++) {
            ProviderApi.Result st = ProviderApi.call("GET", base + "/server/" + uuid, h(), null, 404);
            if (st.status == 404 || "stopped".equals(Json.str(st.json, "server", "state"))) break;
            ProviderApi.sleep(pollDelayMs);
        }
        ProviderApi.call("DELETE", base + "/server/" + uuid + "?storages=1&backups=delete", h(), null, 404);
    }

    @Override
    public List<ServerRef> list(String cluster) throws IOException {
        Object json = ProviderApi.call("GET", base + "/server?label=" + Bytes.encodeURIComponent("cluster=" + cluster), h(), null).json;
        List<ServerRef> out = new ArrayList<>();
        for (Object s : Json.listAt(json, "servers", "server")) {
            String node = "";
            for (Object l : Json.listAt(s, "labels", "label")) {
                if ("node".equals(Json.str(l, "key"))) { node = Json.str(l, "value"); break; }
            }
            out.add(new ServerRef(Json.str(s, "uuid"), node));
        }
        return out;
    }

    @Override public boolean supportsPtr() { return false; }

    @Override public void setPtr(ServerInfo server, String hostname) { /* not supported */ }
}
