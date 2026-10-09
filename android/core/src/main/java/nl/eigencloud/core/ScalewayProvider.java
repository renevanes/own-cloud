package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Scaleway (France, Netherlands, Poland). Config: secretKey, projectId, imageLabel?. */
public final class ScalewayProvider implements Provider {
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
}
