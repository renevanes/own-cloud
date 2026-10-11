package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The DNS step of the console (configureDns in src/console/server.ts, POST /api/dns and GET /api/dns/check): any
 * provider with DNS in the registry ({@link Adapters}, field definitions from catalog.json) or manual. Checks the key
 * and the zone through the adapter's connect, stores the link, and checks whether the domain is delegated to the
 * nameservers. There is no NS lookup in plain Java/Android, so the delegation check uses DNS-over-HTTPS JSON
 * ({@link Endpoints#DOH}).
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

    /** {@link #configure(Map, Catalog, String, String, Map)} without separate fields (only a token). */
    public static Result configure(Map<String, Object> c, Catalog catalog, String mode, String token) throws IOException {
        return configure(c, catalog, mode, token, null);
    }

    /**
     * Configures DNS on an admin config (mutates {@code c}: dns, console.dnsMode, console.nameservers); the caller
     * saves the vault afterwards. {@code mode}: the id of a DNS adapter ("desec", "hetzner", "scaleway", "exoscale",
     * "ovh", …) or "manual". Credentials: the key of the same provider under Servers, over that what was linked for
     * DNS before, over that what the user fills in now ({@code fieldsIn}, and {@code token}); masked values ("••…")
     * and empty values do not count. Throws {@link IOException} / IllegalArgumentException with a Dutch message.
     */
    public static Result configure(Map<String, Object> c, Catalog catalog, String mode, String token, Map<String, Object> fieldsIn) throws IOException {
        String d = Json.jsString(c.get("domain"));
        Map<String, Object> console = Json.map(c, "console");
        if (console == null) { console = Json.obj(); c.put("console", console); }
        if ("manual".equals(mode)) {
            c.put("dns", Json.list());
            console.put("dnsMode", "manual");
            return new Result(null, null);
        }
        Map<String, Object> given = Json.obj();
        if (fieldsIn != null) given.putAll(fieldsIn);
        if (token != null && !token.isEmpty()) given.put("token", token);
        Map<String, Object> fields = fieldsFor(c, catalog, mode, given);
        Adapters.Adapter a = Adapters.get(mode);
        List<Catalog.Field> want = Catalog.fields(catalog.dnsOffer(mode));
        List<Catalog.Field> missing = new ArrayList<>();
        for (Catalog.Field f : want) if (!f.optional && !Json.truthy(fields.get(f.key))) missing.add(f);
        if (!missing.isEmpty()) {
            if (missing.size() == 1 && "token".equals(missing.get(0).key)) throw new IOException("Vul je API-token in");
            StringBuilder b = new StringBuilder();
            for (Catalog.Field f : missing) b.append(b.length() == 0 ? "" : ", ").append(f.label);
            throw new IOException("Vul in: " + b);
        }
        List<String> ns = a.dns.connect.connect(fields, d);
        Object tok = fields.remove("token");
        Map<String, Object> link = Json.obj("type", mode, "name", mode);
        if (Json.truthy(tok)) link.put("token", tok);
        link.put("zone", d);
        if (!fields.isEmpty()) link.put("fields", fields);
        c.put("dns", Json.list(link));
        console.put("dnsMode", mode);
        console.put("nameservers", new ArrayList<Object>(ns));
        // dedyn.io-namen staan meteen goed: deSEC beheert dedyn.io zelf.
        return new Result(ns, d.endsWith(".dedyn.io") || delegated(d, ns));
    }

    /**
     * Credentials for DNS (dnsFieldsFor in server.ts): the key of the same provider under Servers, over that what was
     * linked for DNS before, over that {@code given} (masked "••…" and empty values do not count). Throws
     * IllegalArgumentException "Kies een DNS-aanbieder" for an unknown provider.
     */
    public static Map<String, Object> fieldsFor(Map<String, Object> c, Catalog catalog, String mode, Map<String, Object> given) {
        Adapters.Adapter a = mode == null ? null : Adapters.get(mode);
        Map<String, Object> offer = mode == null ? null : catalog.dnsOffer(mode);
        if (a == null || a.dns == null || offer == null) throw new IllegalArgumentException("Kies een DNS-aanbieder");
        List<Catalog.Field> want = Catalog.fields(offer);
        Map<String, Object> prev = null;
        for (Object x : Json.listAt(c, "dns")) if (mode.equals(Json.str(x, "type"))) { prev = Json.asMap(x); break; }
        Map<String, Object> fields = Json.obj();
        Map<String, Object> linked = Json.map(c, "providers", mode);
        if (linked != null) for (Catalog.Field f : want) if (Json.truthy(linked.get(f.key))) fields.put(f.key, linked.get(f.key));
        if (prev != null) for (Map.Entry<String, Object> e : Adapters.dnsFields(prev).entrySet()) if (!"api".equals(e.getKey())) fields.put(e.getKey(), e.getValue());
        if (given != null) for (Map.Entry<String, Object> e : given.entrySet()) {
            if (!(e.getValue() instanceof String)) continue;
            String v = (String) e.getValue();
            if (v.trim().isEmpty() || v.startsWith("••")) continue;
            for (Catalog.Field f : want) if (f.key.equals(e.getKey())) { fields.put(e.getKey(), v.trim()); break; }
        }
        return fields;
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
