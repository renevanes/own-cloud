package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The DNS step of the console (POST /api/dns and GET /api/dns/check in src/console/server.ts): checks the
 * deSEC / Hetzner token, creates the deSEC domain when needed, finds the nameservers, and checks whether the
 * domain is delegated to them. There is no NS lookup in plain Java/Android, so the delegation check uses
 * DNS-over-HTTPS JSON ({@link Endpoints#DOH}).
 */
public final class DnsSetup {
    private DnsSetup() {}

    /** Outcome of {@link #configure}. */
    public static final class Result {
        /** Nameservers the domain should point to; null in manual mode. */
        public final List<String> ns;
        /** Whether the domain already points to them; null in manual mode. */
        public final Boolean delegated;

        Result(List<String> ns, Boolean delegated) {
            this.ns = ns;
            this.delegated = delegated;
        }

        public Map<String, Object> toJson() {
            return Json.obj("ok", true, "ns", ns == null ? null : new ArrayList<Object>(ns), "delegated", delegated);
        }
    }

    /**
     * Configures DNS on an admin config (mutates {@code c}: dns, console.dnsMode, console.nameservers); the
     * caller saves the vault afterwards. {@code mode}: "desec", "hetzner" or "manual". A null token or one
     * starting with "••" (masked) reuses the stored token. Throws {@link IOException} with a Dutch message.
     */
    public static Result configure(Map<String, Object> c, String mode, String token) throws IOException {
        String d = Json.jsString(c.get("domain"));
        Map<String, Object> console = Json.map(c, "console");
        if (console == null) { console = Json.obj(); c.put("console", console); }
        if ("manual".equals(mode)) {
            c.put("dns", Json.list());
            console.put("dnsMode", "manual");
            return new Result(null, null);
        }
        if (!"desec".equals(mode) && !"hetzner".equals(mode)) throw new IllegalArgumentException("Onbekende DNS-keuze");
        String tok = token != null && !token.startsWith("••") ? token.trim() : null;
        if (tok == null) {
            for (Object x : Json.listAt(c, "dns")) if (mode.equals(Json.str(x, "type"))) { tok = Json.str(x, "token"); break; }
        }
        if (tok == null || tok.isEmpty()) throw new IOException("Vul je API-token in");
        List<String> ns = "desec".equals(mode) ? desec(d, tok) : hetzner(d, tok);
        c.put("dns", Json.list(Json.obj("type", mode, "name", mode, "token", tok, "zone", d)));
        console.put("dnsMode", mode);
        console.put("nameservers", new ArrayList<Object>(ns));
        // dedyn.io-namen staan meteen goed: deSEC beheert dedyn.io zelf.
        return new Result(ns, d.endsWith(".dedyn.io") || delegated(d, ns));
    }

    /** deSEC: checks the token and adds the domain when it does not exist yet. */
    public static List<String> desec(String domain, String token) throws IOException {
        Map<String, String> h = Http.headers("authorization", "Token " + token, "content-type", "application/json");
        Http.Response r = Http.request("GET", Endpoints.DESEC + "/domains/" + domain + "/", h, null, 15_000);
        if (r.status == 401 || r.status == 403) throw new IOException("deSEC accepteert dit token niet");
        if (r.status == 404) {
            if (domain.endsWith(".dedyn.io")) throw new IOException(domain + " bestaat (nog) niet bij deSEC. Maak het account opnieuw aan met een andere naam.");
            Http.Response cr = Http.request("POST", Endpoints.DESEC + "/domains/", h, Bytes.utf8(Json.stringify(Json.obj("name", domain))), 15_000);
            if (!cr.ok()) throw new IOException("Domein toevoegen bij deSEC mislukt: " + Bytes.head(cr.text(), 200));
        }
        List<String> ns = new ArrayList<>();
        ns.add("ns1.desec.io");
        ns.add("ns2.desec.org");
        return ns;
    }

    /** Hetzner (Cloud API DNS): looks up the zone and its assigned nameservers. */
    public static List<String> hetzner(String domain, String token) throws IOException {
        Http.Response r = Http.request("GET", Endpoints.HETZNER + "/zones?name=" + domain, Http.headers("authorization", "Bearer " + token), null, 15_000);
        if (!r.ok()) throw new IOException("Hetzner accepteert dit token niet (of DNS staat nog in de oude DNS-console)");
        Object j = Json.parse(r.text());
        List<Object> zones = Json.listAt(j, "zones");
        if (zones.isEmpty()) throw new IOException("Maak eerst de zone " + domain + " aan in de Hetzner Console → DNS");
        List<Object> assigned = Json.asList(Json.path(zones.get(0), "authoritative_nameservers", "assigned"));
        List<String> ns = new ArrayList<>();
        if (assigned == null) {
            ns.add("hydrogen.ns.hetzner.com");
            ns.add("oxygen.ns.hetzner.com");
            ns.add("helium.ns.hetzner.de");
        } else for (Object a : assigned) ns.add(Json.jsString(a));
        return ns;
    }

    /** True when every expected nameserver is among the domain's current NS records (case-insensitive). */
    public static boolean delegated(String domain, List<String> ns) {
        List<String> cur = resolveNs(domain);
        for (String n : ns) if (!cur.contains(n.toLowerCase(Locale.ROOT))) return false;
        return true;
    }

    /** Current NS records of a domain via DNS-over-HTTPS (lowercase, no trailing dot); empty on failure. */
    public static List<String> resolveNs(String domain) {
        for (String base : Endpoints.DOH) {
            try {
                String url = base + (base.contains("?") ? "&" : "?") + "name=" + Bytes.encodeURIComponent(domain) + "&type=NS";
                Http.Response r = Http.request("GET", url, Http.headers("accept", "application/dns-json"), null, 8000);
                if (!r.ok()) continue;
                return parseDohNs(r.text());
            } catch (IOException | RuntimeException ignored) {
                // try the next resolver
            }
        }
        return new ArrayList<>();
    }

    /** Parses a DNS-over-HTTPS JSON answer and returns the NS (type 2) targets, normalized. */
    public static List<String> parseDohNs(String json) {
        List<String> out = new ArrayList<>();
        Object j = Json.parse(json);
        Number status = Json.num(j, "Status");
        if (status != null && status.intValue() != 0) return out;
        for (Object a : Json.listAt(j, "Answer")) {
            Number type = Json.num(a, "type");
            String data = Json.str(a, "data");
            if (type == null || type.intValue() != 2 || data == null) continue;
            String n = data.trim().toLowerCase(Locale.ROOT);
            if (n.endsWith(".")) n = n.substring(0, n.length() - 1);
            out.add(n);
        }
        return out;
    }
}
