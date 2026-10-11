package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** deSEC (Germany, non-profit): DNS only, with a Caddy module (adapters/desec.ts). Fields: token (api?). */
public final class Desec {
    private Desec() {}

    /** The registry entry. */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("desec", null, false,
            new Adapters.Dns(Desec::connect, (name, f, zone) -> new Dns(name, Adapters.field(f, "token"), zone, Adapters.field(f, "api")),
                    f -> "dns desec {\n\t\t\ttoken " + Adapters.fieldJs(f, "token") + "\n\t\t}"));

    private static String base(Map<String, Object> fields) {
        String api = Adapters.field(fields, "api");
        return (api.isEmpty() ? Endpoints.DESEC : api).replaceAll("/+$", "");
    }

    /** Checks the token and adds the domain when it does not exist yet (not for name.dedyn.io). */
    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        String base = base(fields);
        Map<String, String> h = Http.headers("authorization", "Token " + Adapters.fieldJs(fields, "token"), "content-type", "application/json");
        Http.Response r = Http.request("GET", base + "/domains/" + zone + "/", h, null, 15_000);
        if (r.status == 401 || r.status == 403) throw new IOException("deSEC accepteert dit token niet");
        if (r.status == 404) {
            if (zone.endsWith(".dedyn.io")) throw new IOException(zone + " bestaat (nog) niet bij deSEC. Maak het account opnieuw aan met een andere naam.");
            Http.Response cr = Http.request("POST", base + "/domains/", h, Bytes.utf8(Json.stringify(Json.obj("name", zone))), 15_000);
            if (!cr.ok()) throw new IOException("Domein toevoegen bij deSEC mislukt: " + Bytes.head(cr.text(), 200));
        }
        List<String> ns = new ArrayList<>();
        ns.add("ns1.desec.io");
        ns.add("ns2.desec.org");
        return ns;
    }

    /** Records via PUT rrsets (bulk). deSEC's minimum TTL is an hour; fine, failover does not depend on DNS. */
    public static final class Dns implements DnsProvider {
        private final String name, token, zone, api;

        /** {@code api}: another base URL (e.g. the DNS proxy of the Eigen Cloud Dienst); "" = deSEC itself. */
        public Dns(String name, String token, String zone, String api) {
            this.name = name;
            this.token = token;
            this.zone = zone;
            this.api = api == null || api.isEmpty() ? Endpoints.DESEC : api;
        }

        @Override public String name() { return name; }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            String base = api.replaceAll("/+$", "");
            Object body = Json.list(Json.obj("subname", sub, "type", type, "ttl", (long) Math.max(ttl, 3600), "records", new ArrayList<Object>(values)));
            Http.Response r = Http.request("PUT", base + "/domains/" + zone + "/rrsets/", Http.headers("authorization", "Token " + token, "content-type", "application/json"),
                    Bytes.utf8(Json.stringify(body)), ProviderApi.TIMEOUT_MS);
            if (!r.ok()) throw new IOException("deSEC " + sub + "/" + type + ": " + r.status + " " + Bytes.head(r.text(), 200));
        }
    }
}
