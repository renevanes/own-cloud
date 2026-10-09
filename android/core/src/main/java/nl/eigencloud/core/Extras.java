package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Alles regelen vanuit de console (zelfde stappen als src/console/extras.ts):
 * gratis een deSEC-account met desgewenst naam.dedyn.io, of betaald via de Eigen Cloud Dienst (src/broker).
 * Methoden veranderen de beheerconfiguratie; de aanroeper bewaart de kluis.
 */
public final class Extras {
    private Extras() {}

    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOMAIN = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    private static final Pattern LABEL = Pattern.compile("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$");

    /** "vanes.nl" (eigen of te kopen domein) of "rene" → "rene.dedyn.io" (gratis). */
    public static String normalizeDomain(String input, String mode) {
        String d = (input == null ? "" : input).trim().toLowerCase(Locale.ROOT).replaceFirst("^https?://", "").replaceFirst("/[\\s\\S]*$", "");
        if ("free".equals(mode)) {
            d = d.replaceFirst("\\.dedyn\\.io$", "");
            if (!LABEL.matcher(d).matches()) throw new IllegalArgumentException("Kies een naam met letters, cijfers en streepjes, zoals vanes");
            return d + ".dedyn.io";
        }
        if (!DOMAIN.matcher(d).matches()) throw new IllegalArgumentException("Vul een domeinnaam in, zoals vanes.nl");
        return d;
    }

    private static Map<String, Object> console(Map<String, Object> c) {
        Map<String, Object> con = Json.map(c, "console");
        if (con == null) { con = Json.obj(); c.put("console", con); }
        return con;
    }

    /** Domein wijzigen vóór de start (DNS-koppeling van het oude domein vervalt). */
    public static void changeDomain(Map<String, Object> c, String domain, String mode) {
        Map<String, Object> con = console(c);
        String alert = Json.str(con, "alertEmail");
        if (alert != null && alert.endsWith("@" + domain)) throw new IllegalArgumentException("Je meldadres valt onder dit domein; kies eerst een ander meldadres");
        String from = Json.str(c, "appEnv", "MAIL_FROM");
        String mailbox = from != null && from.contains("@") ? from.substring(0, from.indexOf('@')) : "post";
        if (!domain.equals(c.get("domain"))) {
            c.put("dns", Json.list());
            con.remove("dnsMode");
            con.remove("nameservers");
        }
        c.put("domain", domain);
        Map<String, Object> env = Json.map(c, "appEnv");
        if (env == null) { env = Json.obj(); c.put("appEnv", env); }
        env.put("MAIL_DOMAINS", domain);
        env.put("MAIL_FROM", mailbox + "@" + domain);
        env.put("HOSTNAME_FQDN", "mail." + domain);
        con.put("domainMode", mode);
    }

    // ───────── deSEC ─────────

    private static Object call(String method, String url, Map<String, String> headers, Object body, int expectLow) throws IOException {
        Http.Response r = Http.request(method, url, headers, body == null ? null : Bytes.utf8(Json.stringify(body)), 20_000);
        Object j;
        try { j = r.body.length == 0 ? null : Json.parse(r.text()); } catch (RuntimeException e) { j = Json.obj("error", Bytes.head(r.text(), 200)); }
        if (r.status < expectLow || r.status >= 300) throw new HttpException(desecError(j), r.status, r.text());
        return j;
    }

    static String desecError(Object j) {
        Map<String, Object> o = Json.asMap(j);
        if (o == null) return "onbekende fout";
        if (o.containsKey("captcha")) return "De tekens uit het plaatje kloppen niet. Probeer het met een nieuw plaatje.";
        if (o.containsKey("email")) return "E-mailadres: " + flat(o.get("email"));
        if (o.containsKey("domain")) return "Naam: " + flat(o.get("domain"));
        if (o.get("detail") instanceof String) return (String) o.get("detail");
        return Bytes.head(Json.stringify(j), 200);
    }

    private static String flat(Object v) {
        List<Object> l = Json.asList(v);
        if (l == null) return Json.jsString(v);
        List<String> s = new ArrayList<>();
        for (Object x : l) s.add(Json.jsString(x));
        return String.join(" ", s);
    }

    private static final Map<String, String> JSON = Http.headers("content-type", "application/json");

    public static Map<String, Object> desecCaptcha() throws IOException {
        Map<String, Object> j = Json.asMap(call("POST", Endpoints.DESEC + "/captcha/", JSON, Json.obj(), 200));
        if (j == null || j.get("id") == null) throw new IOException("deSEC is niet bereikbaar");
        return Json.obj("id", j.get("id"), "challenge", j.get("challenge"), "kind", j.get("kind") == null ? "image" : j.get("kind"));
    }

    public static Map<String, Object> desecRegister(Map<String, Object> c, String captchaId, String solution, String emailIn) throws IOException {
        Map<String, Object> con = console(c);
        String email = (emailIn != null && !emailIn.isEmpty() ? emailIn : Json.str(con, "alertEmail") == null ? "" : Json.str(con, "alertEmail")).trim();
        if (!EMAIL.matcher(email).matches()) throw new IllegalArgumentException("Vul een e-mailadres in voor je deSEC-account");
        String domain = Json.jsString(c.get("domain"));
        if (email.endsWith("@" + domain)) throw new IllegalArgumentException("Gebruik een adres buiten je nieuwe domein; dat bestaat nog niet");
        String password = Bytes.base64(Bytes.random(18)).replace('+', '-').replace('/', '_').replace("=", "");
        Map<String, Object> body = Json.obj("email", email, "password", password, "captcha", Json.obj("id", captchaId, "solution", solution == null ? "" : solution.trim()), "outreach_preference", false);
        if (domain.endsWith(".dedyn.io")) body.put("domain", domain);
        try {
            call("POST", Endpoints.DESEC + "/auth/", JSON, body, 200);
        } catch (HttpException e) {
            throw new IOException(e.getMessage(), e);
        }
        con.put("desec", Json.obj("email", email, "password", password, "at", System.currentTimeMillis()));
        return Json.obj("ok", true, "email", email);
    }

    /** Na het bevestigen: inloggen en een blijvend token maken. null = nog niet bevestigd. */
    public static String desecFinish(Map<String, Object> c) throws IOException {
        Map<String, Object> acc = Json.map(c, "console", "desec");
        if (acc == null) throw new IllegalArgumentException("Maak eerst het deSEC-account aan");
        Http.Response login = Http.request("POST", Endpoints.DESEC + "/auth/login/", JSON,
                Bytes.utf8(Json.stringify(Json.obj("email", acc.get("email"), "password", acc.get("password")))), 20_000);
        if (login.status == 401 || login.status == 403) {
            Number at = Json.num(acc, "at");
            if (at != null && System.currentTimeMillis() - at.longValue() > 12 * 3_600_000L) throw new IOException("De bevestigingslink is verlopen. Maak het account opnieuw aan.");
            return null;
        }
        String loginToken = login.ok() ? Json.str(Json.parse(login.text()), "token") : null;
        if (loginToken == null) throw new IOException("Inloggen bij deSEC mislukt (" + login.status + ")");
        Object t;
        try {
            t = call("POST", Endpoints.DESEC + "/auth/tokens/", Http.headers("authorization", "Token " + loginToken, "content-type", "application/json"),
                    Json.obj("name", "eigen-cloud " + Json.jsString(c.get("domain")), "perm_manage_tokens", false), 200);
        } catch (HttpException e) {
            throw new IOException("Token maken bij deSEC mislukt: " + e.getMessage(), e);
        }
        String token = Json.str(t, "token");
        if (token == null) throw new IOException("Token maken bij deSEC mislukt");
        return token;
    }

    // ───────── Eigen Cloud Dienst ─────────

    private static Object dienst(String base, String method, String path, Object body, String token) throws IOException {
        if (base == null || base.isEmpty()) throw new IOException("De Eigen Cloud Dienst is in deze versie niet ingesteld");
        Map<String, String> h = Http.headers("accept", "application/json");
        if (body != null) h.put("content-type", "application/json");
        if (token != null) h.put("authorization", "Bearer " + token);
        Http.Response r;
        try {
            r = Http.request(method, base.replaceAll("/+$", "") + path, h, body == null ? null : Bytes.utf8(Json.stringify(body)), 30_000);
        } catch (IOException e) {
            throw new IOException("De Eigen Cloud Dienst is niet bereikbaar", e);
        }
        Object j;
        try { j = r.body.length == 0 ? null : Json.parse(r.text()); } catch (RuntimeException e) { j = null; }
        if (r.status == 401) throw new IOException("Log opnieuw in bij de dienst");
        if (!r.ok()) throw new IOException(Json.str(j, "error") != null ? Json.str(j, "error") : "De dienst antwoordt " + r.status);
        return j;
    }

    public static Object dienstInfo(String base) throws IOException { return dienst(base, "GET", "/v1/info", null, null); }

    public static Object dienstCheck(String base, String name) throws IOException {
        String d = normalizeDomain(name, "buy");
        return dienst(base, "GET", "/v1/domains/check?name=" + Bytes.encodeURIComponent(d), null, null);
    }

    private static Map<String, Object> dienstState(Map<String, Object> c) {
        Map<String, Object> con = console(c);
        Map<String, Object> d = Json.map(con, "dienst");
        if (d == null) { d = Json.obj(); con.put("dienst", d); }
        return d;
    }

    public static Map<String, Object> dienstLogin(String base, Map<String, Object> c, String email) throws IOException {
        String e = email == null ? "" : email.trim();
        if (!EMAIL.matcher(e).matches()) throw new IllegalArgumentException("Vul een geldig e-mailadres in");
        dienst(base, "POST", "/v1/auth/start", Json.obj("email", e), null);
        dienstState(c).put("email", e);
        return Json.obj("ok", true, "email", e);
    }

    public static Map<String, Object> dienstVerify(String base, Map<String, Object> c, String code) throws IOException {
        Map<String, Object> d = dienstState(c);
        String email = Json.str(d, "email");
        if (email == null) throw new IllegalArgumentException("Vul eerst je e-mailadres in");
        Object r = dienst(base, "POST", "/v1/auth/verify", Json.obj("email", email, "code", code == null ? "" : code.replaceAll("\\s", "")), null);
        d.put("token", Json.str(r, "token"));
        return Json.obj("ok", true, "email", email);
    }

    public static Map<String, Object> dienstOrder(String base, Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> d = dienstState(c);
        String token = Json.str(d, "token");
        if (token == null) throw new IllegalArgumentException("Log eerst in bij de dienst");
        if (!Json.truthy(b.get("acceptTerms"))) throw new IllegalArgumentException("Ga akkoord met de voorwaarden om verder te gaan");
        String domain = Json.jsString(c.get("domain"));
        if (domain.endsWith(".dedyn.io")) throw new IllegalArgumentException("Bij de dienst hoort een eigen domeinnaam. Kies eerst een domein.");
        String mode = Json.str(b, "mode");
        Map<String, Object> dom = Json.obj("mode", mode, "name", domain);
        String auth = Json.str(b, "authCode");
        if (auth != null && !auth.isEmpty()) dom.put("authCode", auth);
        Map<String, Object> body = Json.obj("bundle", b.get("bundle"), "domain", dom, "acceptTerms", true);
        if (!"own".equals(mode) && b.get("registrant") != null) body.put("registrant", b.get("registrant"));
        Object r = dienst(base, "POST", "/v1/orders", body, token);
        d.put("orderId", Json.str(r, "orderId"));
        d.put("bundle", b.get("bundle"));
        d.put("applied", false);
        return Json.obj("ok", true, "orderId", Json.str(r, "orderId"), "checkoutUrl", Json.str(r, "checkoutUrl"));
    }

    public static Object dienstStatus(String base, Map<String, Object> c) throws IOException {
        Map<String, Object> d = dienstState(c);
        if (Json.str(d, "token") == null || Json.str(d, "orderId") == null) return Json.obj("status", "none");
        return dienst(base, "GET", "/v1/orders/" + Json.str(d, "orderId"), null, Json.str(d, "token"));
    }

    /** Het pakket van de dienst overnemen: aanbieder, opslag (buckets klaarzetten), plekken, DNS via de dienst, mail. */
    public static Map<String, Object> dienstApply(String base, Map<String, Object> c, Catalog catalog) throws IOException {
        Map<String, Object> d = dienstState(c);
        if (Json.str(d, "token") == null || Json.str(d, "orderId") == null) throw new IllegalArgumentException("Er is nog geen bestelling");
        Map<String, Object> kit = Json.asMap(dienst(base, "GET", "/v1/orders/" + Json.str(d, "orderId") + "/kit", null, Json.str(d, "token")));
        if (kit == null) throw new IOException("Leeg pakket van de dienst");
        if (!Json.jsString(kit.get("domain")).equals(Json.jsString(c.get("domain")))) throw new IOException("Het pakket is voor " + kit.get("domain") + ", niet voor " + c.get("domain"));
        Map<String, Object> providers = Json.map(c, "providers");
        if (providers == null) { providers = Json.obj(); c.put("providers", providers); }
        providers.put(Json.str(kit, "provider", "id"), Json.copy(Json.map(kit, "provider", "fields")));
        List<Object> names = new ArrayList<>();
        for (Object st : Json.listAt(kit, "storage")) {
            Console.StoreSetup r = Console.addStore(c, catalog, Json.str(st, "offer"), Json.str(st, "region"), null, Json.str(st, "accessKey"), Json.str(st, "secretKey"), null, Json.str(st, "purpose"));
            if (!r.ok) {
                StringBuilder why = new StringBuilder();
                for (Admin.StepResult s : r.steps) if (!s.ok) why.append(s.label).append(s.detail != null ? " (" + s.detail + ")" : "").append(", ");
                throw new IOException("Opslag " + r.name + " klaarzetten lukte niet: " + why.toString().replaceAll(", $", ""));
            }
            names.add(r.name);
        }
        Map<String, Object> pol = Json.map(c, "policy");
        if (pol == null) { pol = ClusterConfig.defaultPolicy(); c.put("policy", pol); }
        pol.put("placement", Json.copy(Json.listAt(kit, "placement")));
        if (Json.num(kit, "policy", "minDataNodes") != null) pol.put("minDataNodes", Json.num(kit, "policy", "minDataNodes"));
        if (Json.num(kit, "policy", "witnesses") != null) pol.put("witnesses", Json.num(kit, "policy", "witnesses"));
        Map<String, Object> con = console(c);
        con.put("preset", "dienst");
        Map<String, Object> dns = Json.map(kit, "dns");
        Map<String, Object> d0 = Json.obj("type", "desec", "name", "dienst", "token", dns.get("token"), "zone", dns.get("zone"), "api", dns.get("api"));
        if (dns.get("acme") != null) d0.put("acme", Json.copy(dns.get("acme")));
        c.put("dns", Json.list(d0));
        con.put("dnsMode", "dienst");
        con.put("nameservers", Json.copy(Json.listAt(kit, "nameservers")));
        Map<String, Object> m = Json.map(kit, "mailRelay");
        if (m != null) {
            Number port = Json.num(m, "port");
            con.put("mailRelay", SmtpCheck.relayUrl(new SmtpCheck.Relay(Json.str(m, "host"), port == null ? 587 : port.intValue(), Json.str(m, "user"), Json.str(m, "password"), Json.truthy(m.get("secure")))));
        }
        con.put("spfExtra", Json.str(kit, "spfExtra") == null ? "" : Json.str(kit, "spfExtra"));
        d.put("applied", true);
        return Json.obj("ok", true, "stores", names, "nameservers", kit.get("nameservers"), "delegated", kit.get("delegated"));
    }
}
