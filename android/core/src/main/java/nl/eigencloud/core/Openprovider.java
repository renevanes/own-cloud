package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Openprovider (registrar, the Netherlands): DNS only, plus the small client the console uses for buying domains,
 * nameservers, DNSSEC and the API IP list (port of src/cluster/adapters/openprovider.ts; sources and assumptions are
 * listed there). Base URL {@link Endpoints#OPENPROVIDER} (/v1 per developer.openprovider.com; paths as in the v1beta swagger).
 */
public final class Openprovider {
    private Openprovider() {}

    /** Openprovider DNS nameservers (not in the API documentation; from the control panel). */
    public static final List<String> NAMESERVERS = Arrays.asList("ns1.openprovider.nl", "ns2.openprovider.be", "ns3.openprovider.eu");
    public static final int MIN_TTL = 900;

    /** The registry entry (fields username, password; no Caddy module: HTTP-01). */
    static final Adapters.Adapter ADAPTER = new Adapters.Adapter("openprovider", null, false,
            new Adapters.Dns(Openprovider::connect, (name, f, zone) -> new Dns(name, Adapters.field(f, "username"), Adapters.field(f, "password"), zone), null, Openprovider::check));

    /** An error from Openprovider, with the HTTP status (0 = unreachable) and Openprovider's code. */
    public static final class OpError extends IOException {
        private static final long serialVersionUID = 1L;
        public final int status;
        public final Integer code;

        OpError(String message, int status, Integer code) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    private static final Map<String, Object[]> TOKENS = new ConcurrentHashMap<>(); // key → {token, until (Long)}

    /** Tests: forget all tokens. */
    public static void resetTokens() { TOKENS.clear(); }

    /** The client (OpenproviderApi in TS). */
    public static final class Api {
        private final String user, pass, base;

        public Api(String user, String pass) {
            this.user = user == null ? "" : user;
            this.pass = pass == null ? "" : pass;
            this.base = Endpoints.OPENPROVIDER.replaceAll("/+$", "");
        }

        private String key() { return base + "|" + user + "|" + Bytes.sha256Hex(Bytes.utf8(pass)); }

        public String login() throws IOException {
            if (user.isEmpty() || pass.isEmpty()) throw new OpError("Vul je Openprovider-gebruikersnaam en wachtwoord in", 400, null);
            Object[] hit = TOKENS.get(key());
            if (hit != null && (Long) hit[1] > System.currentTimeMillis()) return (String) hit[0];
            Http.Response r;
            try {
                r = Http.request("POST", base + "/auth/login", Http.headers("content-type", "application/json"),
                        Bytes.utf8(Json.stringify(Json.obj("username", user, "password", pass, "ip", "0.0.0.0"))), 15_000);
            } catch (IOException e) {
                throw new OpError("Openprovider is niet bereikbaar", 0, null);
            }
            Object j = null;
            try { j = r.text().isEmpty() ? null : Json.parse(r.text()); } catch (RuntimeException ignored) { j = null; }
            String t = Json.str(j, "data", "token");
            Number code = Json.num(j, "code");
            if (!r.ok() || t == null || t.isEmpty() || (code != null && code.intValue() != 0)) {
                throw new OpError("Openprovider laat deze gebruiker niet inloggen. Klopt het wachtwoord, staat API-toegang aan, en mag dit IP-adres erbij?", r.status == 200 ? 401 : r.status, code == null ? null : code.intValue());
            }
            TOKENS.put(key(), new Object[] {t, System.currentTimeMillis() + 24 * 3_600_000L});
            return t;
        }

        /** Request with the token; on 401 log in once more. Returns the whole answer ({code, data}). */
        public Object req(String method, String path, Object body) throws IOException {
            for (int attempt = 0; ; attempt++) {
                String t = login();
                Http.Response r;
                try {
                    r = body == null ? Http.request(method, base + path, Http.headers("authorization", "Bearer " + t), null, 30_000)
                            : Http.request(method, base + path, Http.headers("authorization", "Bearer " + t, "content-type", "application/json"), Bytes.utf8(Json.stringify(body)), 30_000);
                } catch (IOException e) {
                    throw new OpError("Openprovider is niet bereikbaar", 0, null);
                }
                String text = r.text();
                Object j = null;
                try { j = text.isEmpty() ? null : Json.parse(text); } catch (RuntimeException ignored) { j = null; }
                if (r.status == 401 && attempt == 0) { TOKENS.remove(key()); continue; }
                Number code = Json.num(j, "code");
                if (!r.ok() || (code != null && code.intValue() != 0)) {
                    Object desc = Json.path(j, "desc");
                    String d = desc != null ? Json.jsString(desc) : "fout " + r.status;
                    throw new OpError("Openprovider: " + Bytes.head(d, 200), r.ok() ? 400 : r.status, code == null ? null : code.intValue());
                }
                return j;
            }
        }
    }

    /** "esape.nl" → {name: "esape", extension: "nl"}. */
    public static Map<String, Object> splitDomain(String d) {
        int i = d.indexOf('.');
        return Json.obj("name", d.substring(0, i), "extension", d.substring(i + 1));
    }

    /** Openprovider record name (relative or full) → subname within the zone ("" = the zone itself). */
    public static String sub(String name, String zone) {
        String n = (name == null ? "" : name).toLowerCase(java.util.Locale.ROOT).replaceAll("\\.$", "");
        if (n.isEmpty() || n.equals("@") || n.equals(zone)) return "";
        return n.endsWith("." + zone) ? n.substring(0, n.length() - zone.length() - 1) : n;
    }

    /** A value in zone-file notation → record for Openprovider (opRecord). */
    public static Map<String, Object> record(String sub, String type, String v, int ttl) {
        long t = Math.max(ttl, MIN_TTL);
        switch (type) {
            case "MX": {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d+)\\s+(\\S+?)\\.?$").matcher(v.trim());
                if (m.find()) return Json.obj("name", sub, "type", type, "ttl", t, "value", m.group(2), "prio", Long.parseLong(m.group(1)));
                return Json.obj("name", sub, "type", type, "ttl", t, "value", v.trim().replaceAll("\\.$", ""), "prio", 10L);
            }
            case "TXT": return Json.obj("name", sub, "type", type, "ttl", t, "value", v.replaceAll("\"\\s*\"", "").replaceAll("^\"|\"$", ""));
            case "NS":
            case "CNAME": return Json.obj("name", sub, "type", type, "ttl", t, "value", v.replaceAll("\\.$", ""));
            default: return Json.obj("name", sub, "type", type, "ttl", t, "value", v);
        }
    }

    public static List<String> connect(Map<String, Object> fields, String zone) throws IOException {
        Api op = new Api(Adapters.field(fields, "username"), Adapters.field(fields, "password"));
        op.login();
        try {
            op.req("GET", "/dns/zones/" + Bytes.encodeURIComponent(zone), null);
        } catch (OpError e) {
            if (e.status != 404 && e.status != 400) throw new IOException(e.getMessage(), e);
            try {
                op.req("POST", "/dns/zones", Json.obj("domain", splitDomain(zone), "type", "master", "records", Json.list()));
            } catch (OpError e2) {
                throw new IOException("DNS-zone aanmaken bij Openprovider mislukt: " + e2.getMessage(), e2);
            }
        }
        return new ArrayList<>(NAMESERVERS);
    }

    /** Log in and look at the zone (read only: logging in changes nothing). */
    public static List<Object> check(Map<String, Object> f, String zone) {
        String label = zone.isEmpty() ? KeyCheck.ZONES : KeyCheck.ZONE;
        String[] rest = {"zone", label, "rights", KeyCheck.DNS_RIGHTS};
        Api op = new Api(Adapters.field(f, "username"), Adapters.field(f, "password"));
        try { op.login(); } catch (IOException e) { return KeyCheck.loginFailed(e.getMessage(), rest); }
        List<Object> out = Json.list(KeyCheck.row("login", KeyCheck.LOGIN, true));
        try {
            op.req("GET", zone.isEmpty() ? "/dns/zones?limit=1" : "/dns/zones/" + Bytes.encodeURIComponent(zone), null);
            out.add(KeyCheck.row("zone", label, true, zone.isEmpty() ? "" : zone + " gevonden"));
        } catch (OpError e) {
            out.add(!zone.isEmpty() && (e.status == 404 || e.status == 400) ? KeyCheck.row("zone", label, null, zone + " heeft nog geen DNS bij Openprovider; de console maakt de zone aan bij het koppelen.")
                    : KeyCheck.row("zone", label, false, e.getMessage()));
        } catch (IOException e) {
            out.add(KeyCheck.row("zone", label, false, e.getMessage()));
        }
        out.add(KeyCheck.row("rights", KeyCheck.DNS_RIGHTS, null, "Openprovider laat de rechten niet zien; blijkt bij het eerste record"));
        return out;
    }

    /** Records via the zone update (remove what was there for this name and type, add the new ones). */
    public static final class Dns implements DnsProvider {
        private final String name, user, pass, zone;

        public Dns(String name, String user, String pass, String zone) {
            this.name = name;
            this.user = user;
            this.pass = pass;
            this.zone = zone;
        }

        @Override public String name() { return name; }

        @Override
        public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
            Api op = new Api(user, pass);
            String z = Bytes.encodeURIComponent(zone);
            Object list = op.req("GET", "/dns/zones/" + z + "/records?type=" + Bytes.encodeURIComponent(type) + "&limit=500", null);
            List<Object> old = new ArrayList<>();
            for (Object r : Json.listAt(list, "data", "results")) {
                if (!type.equals(Json.jsString(Json.path(r, "type")).toUpperCase(java.util.Locale.ROOT)) || !sub.equals(sub(Json.str(r, "name"), zone))) continue;
                Map<String, Object> o = Json.obj("name", sub, "type", type, "value", Json.jsString(Json.path(r, "value")), "ttl", Json.num(r, "ttl") == null ? null : (Object) Json.num(r, "ttl").longValue());
                if ("MX".equals(type) && Json.path(r, "prio") != null) o.put("prio", Json.num(r, "prio").longValue());
                old.add(o);
            }
            List<Object> add = new ArrayList<>();
            for (String v : values) add.add(record(sub, type, v, ttl));
            boolean same = old.size() == add.size();
            for (Object a : add) {
                boolean found = false;
                for (Object o : old) {
                    if (Json.jsString(Json.path(o, "value")).equals(Json.jsString(Json.path(a, "value"))) && String.valueOf(Json.path(o, "ttl")).equals(String.valueOf(Json.path(a, "ttl")))
                            && String.valueOf(Json.path(o, "prio")).equals(String.valueOf(Json.path(a, "prio")))) { found = true; break; }
                }
                if (!found) same = false;
            }
            if (same) return;
            Map<String, Object> records = Json.obj();
            if (!old.isEmpty()) records.put("remove", old);
            if (!add.isEmpty()) records.put("add", add);
            op.req("PUT", "/dns/zones/" + z, Json.obj("name", zone, "records", records));
        }
    }
}
