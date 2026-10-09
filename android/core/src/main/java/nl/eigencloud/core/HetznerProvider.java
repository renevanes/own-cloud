package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Hetzner Cloud (Germany, Finland). Config: token, image?, sshKey?. */
public final class HetznerProvider implements Provider {
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
}
