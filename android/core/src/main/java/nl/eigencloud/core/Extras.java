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
        if (!DOMAIN.matcher(d).matches()) throw new IllegalArgumentException("sub".equals(mode) ? "Kies eerst een vrije naam" : "Vul een domeinnaam in, zoals vanes.nl");
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
        // Zonder punt: een gratis adres van de dienst (naam.<zone>); de dienst controleert de naam zelf.
        String raw = name == null ? "" : name.trim().toLowerCase();
        String d = raw.matches("^[a-z0-9-]+$") ? raw : normalizeDomain(name, "buy");
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
        if (domain.endsWith(".dedyn.io")) throw new IllegalArgumentException("Bij de dienst hoort een eigen domeinnaam of een gratis adres van de dienst. Kies eerst een adres.");
        String mode = "sub".equals(Json.str(c, "console", "domainMode")) ? "sub" : Json.str(b, "mode");
        Map<String, Object> dom = Json.obj("mode", mode, "name", domain);
        String auth = Json.str(b, "authCode");
        if (auth != null && !auth.isEmpty()) dom.put("authCode", auth);
        Map<String, Object> body = Json.obj("bundle", b.get("bundle"), "domain", dom, "acceptTerms", true);
        if (("register".equals(mode) || "transfer".equals(mode)) && b.get("registrant") != null) body.put("registrant", b.get("registrant"));
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

    // ───────── Herstellen op een nieuw apparaat, via de dienst ─────────

    public static String dienstStartLogin(String base, String email) throws IOException {
        String e = email == null ? "" : email.trim();
        if (!EMAIL.matcher(e).matches()) throw new IllegalArgumentException("Vul een geldig e-mailadres in");
        dienst(base, "POST", "/v1/auth/start", Json.obj("email", e), null);
        return e;
    }

    public static String dienstFinishLogin(String base, String email, String code) throws IOException {
        return Json.str(dienst(base, "POST", "/v1/auth/verify", Json.obj("email", email, "code", code == null ? "" : code.replaceAll("\\s", "")), null), "token");
    }

    /**
     * Herstellen met alleen je herstelsleutel en je inlog bij de dienst: de opslag en de sleutels komen uit het
     * pakket. Geeft de beheerconfiguratie terug (al gemarkeerd als klaar, met de dienstgegevens erin).
     */
    public static Map<String, Object> recoverViaDienst(String base, String email, String token, String masterKeyInput, Catalog catalog) throws IOException {
        String key = Console.normalizeMasterKey(masterKeyInput);
        Object me = dienst(base, "GET", "/v1/me", null, token);
        Map<String, Object> order = null;
        long newest = -1;
        for (Object o : Json.listAt(me, "orders")) {
            String st = Json.str(o, "status");
            if (!"ready".equals(st) && !"payment_problem".equals(st) && !"cancelled".equals(st)) continue;
            Number at = Json.num(o, "createdAt");
            long t = at == null ? 0 : at.longValue();
            if (t >= newest) { newest = t; order = Json.asMap(o); }
        }
        if (order == null) throw new IOException("Bij dit e-mailadres hoort geen actief abonnement");
        Map<String, Object> kit = Json.asMap(dienst(base, "GET", "/v1/orders/" + Json.str(order, "id") + "/kit", null, token));
        List<Object> storage = new ArrayList<>(Json.listAt(kit, "storage"));
        storage.sort((a, b) -> Boolean.compare(!"replica".equals(Json.str(a, "purpose")), !"replica".equals(Json.str(b, "purpose"))));
        IOException last = null;
        for (Object st : storage) {
            Map<String, Object> offer = catalog.storeOffer(Json.str(st, "offer"));
            Map<String, Object> region = null;
            if (offer != null) for (Object r : Json.listAt(offer, "regions")) if (Json.str(st, "region").equals(Json.str(r, "id"))) region = Json.asMap(r);
            if (region == null) continue;
            Map<String, Object> store = Json.obj("name", Json.str(st, "offer") + "-" + Json.str(st, "region"), "type", "s3", "purpose", Json.str(st, "purpose"),
                    "country", region.get("country"), "endpoint", region.get("endpoint"), "region", Json.str(st, "region"),
                    "accessKey", Json.str(st, "accessKey"), "secretKey", Json.str(st, "secretKey"));
            try {
                Map<String, Object> c = Json.map(Admin.findAdminConfig(key, store), "config");
                Map<String, Object> con = Json.map(c, "console");
                if (con == null) { con = Json.obj(); c.put("console", con); }
                con.put("step", "klaar");
                con.put("done", true);
                con.put("keyConfirmed", true);
                con.put("dienst", Json.obj("email", email, "token", token, "orderId", Json.str(order, "id"), "bundle", order.get("bundle"), "applied", true));
                return c;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("Geen opslag gevonden in je pakket");
    }

    // ───────── Abonnement beheren ─────────

    private static String[] order(Map<String, Object> c) {
        Map<String, Object> d = dienstState(c);
        if (Json.str(d, "token") == null || Json.str(d, "orderId") == null) throw new IllegalArgumentException("Er is geen abonnement bij de dienst");
        return new String[]{Json.str(d, "token"), Json.str(d, "orderId")};
    }

    public static Object dienstBilling(String base, Map<String, Object> c) throws IOException {
        String[] o = order(c);
        return dienst(base, "GET", "/v1/orders/" + o[1] + "/billing", null, o[0]);
    }

    /** Ander pakket; daarna de nieuwe plekken en aantallen overnemen. Geeft ook "policy" terug voor het cluster. */
    public static Map<String, Object> dienstChangeBundle(String base, Map<String, Object> c, String bundle) throws IOException {
        String[] o = order(c);
        Object r = dienst(base, "POST", "/v1/orders/" + o[1] + "/bundle", Json.obj("bundle", bundle), o[0]);
        Map<String, Object> kit = Json.asMap(dienst(base, "GET", "/v1/orders/" + o[1] + "/kit", null, o[0]));
        Map<String, Object> pol = Json.map(c, "policy");
        if (pol == null) { pol = ClusterConfig.defaultPolicy(); c.put("policy", pol); }
        pol.put("placement", Json.copy(Json.listAt(kit, "placement")));
        Map<String, Object> counts = Json.obj("minDataNodes", Json.num(kit, "policy", "minDataNodes"), "witnesses", Json.num(kit, "policy", "witnesses"));
        pol.putAll(counts);
        dienstState(c).put("bundle", bundle);
        return Json.obj("ok", true, "bundle", Json.path(r, "bundle"), "effective", Json.path(r, "effective"), "policy", counts);
    }

    /** payment-method, settle, cancel of resume. */
    public static Object dienstAction(String base, Map<String, Object> c, String action) throws IOException {
        if (!action.matches("payment-method|settle|cancel|resume")) throw new IllegalArgumentException("Onbekende actie");
        String[] o = order(c);
        return dienst(base, "POST", "/v1/orders/" + o[1] + "/" + action, Json.obj(), o[0]);
    }

    public static Object dienstAuthcode(String base, Map<String, Object> c) throws IOException {
        String[] o = order(c);
        return dienst(base, "GET", "/v1/orders/" + o[1] + "/authcode", null, o[0]);
    }

    /** Factuur als HTML (de dienst vraagt een sessie; de console toont hem zelf). */
    public static Map<String, Object> dienstInvoice(String base, Map<String, Object> c, String id) throws IOException {
        String[] o = order(c);
        if (id == null || !id.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException("Onbekende factuur");
        Http.Response r = Http.request("GET", base.replaceAll("/+$", "") + "/v1/invoices/" + id, Http.headers("authorization", "Bearer " + o[0]), null, 20_000);
        if (!r.ok()) throw new IOException(r.status == 404 ? "Factuur niet gevonden" : "De dienst antwoordt " + r.status);
        return Json.obj("html", r.text());
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

    // ───────── Eén sleutel bij Scaleway: de console regelt de rest ─────────
    //
    // Een account bij een aanbieder kan de app niet voor je aanmaken (naam, betaalmethode, soms een ID-check).
    // Met één API-sleutel van Scaleway zet de console wel alles klaar: opslag in Amsterdam en Parijs, servers,
    // en het versturen van mail (Transactional Email, met de DKIM-sleutel in je eigen DNS).

    public static final String SCW_SIGNUP_URL = "https://account.scaleway.com/register";
    public static final String SCW_KEYS_URL = "https://console.scaleway.com/iam/api-keys";
    private static final String TEM = "/transactional-email/v1alpha1/regions/fr-par/domains";

    private static String jsMessage(Object j, String fallback) {
        Object m = Json.path(j, "message");
        return m != null ? Json.jsString(m) : fallback;
    }

    private static Object scw(String method, String path, String secretKey, Object body) throws IOException {
        Http.Response r;
        try {
            r = Http.request(method, Endpoints.SCALEWAY.replaceAll("/+$", "") + path, Http.headers("x-auth-token", secretKey, "content-type", "application/json"),
                    body == null ? null : Bytes.utf8(Json.stringify(body)), 20_000);
        } catch (IOException e) {
            throw new IOException("Scaleway is niet bereikbaar (" + e.getMessage() + ")", e);
        }
        String t = r.text();
        Object j;
        try { j = t.isEmpty() ? null : Json.parse(t); } catch (RuntimeException e) { j = Json.obj("error", Bytes.head(t, 200)); }
        if (r.status == 401) throw new HttpException("Scaleway accepteert deze sleutel niet. Kopieer de geheime sleutel opnieuw (hij wordt maar één keer getoond).", 401, t);
        if (r.status == 403) throw new HttpException("Deze sleutel mag dit niet bij Scaleway (" + jsMessage(j, "geen toegang") + ")", 403, t);
        if (!r.ok()) throw new HttpException("Scaleway antwoordt " + r.status + ": " + Bytes.head(jsMessage(j, Json.stringify(j)), 160), r.status, t);
        return j;
    }

    /** JavaScript's \s (ASCII whitespace plus the Unicode spaces), without relying on (?U) (not on Android). */
    private static final String JS_WS = "[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern WS_EDGES = Pattern.compile("^" + JS_WS + "+|" + JS_WS + "+$"), WS = Pattern.compile(JS_WS + "+");
    private static final Pattern SCW_ACCESS = Pattern.compile("^SCW[A-Z0-9]{17}$");
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern PROJECT_ID = Pattern.compile("^[0-9a-f-]{36}$");

    private static String clean(String v) {
        String s = WS_EDGES.matcher(v == null ? "" : v).replaceAll("");
        s = s.replaceAll("^[\"']|[\"']$", "");
        return WS.matcher(s).replaceAll("");
    }

    /** Sleutels uit wat de gebruiker plakte: spaties en aanhalingstekens eraf, en de vorm controleren. Geeft {accessKey, secretKey}. */
    public static String[] scwKeys(String accessKeyIn, String secretKeyIn) {
        String accessKey = clean(accessKeyIn).toUpperCase(Locale.ROOT), secretKey = clean(secretKeyIn).toLowerCase(Locale.ROOT);
        if (!SCW_ACCESS.matcher(accessKey).matches()) throw new IllegalArgumentException("De toegangssleutel begint met SCW en heeft 20 tekens");
        if (!UUID.matcher(secretKey).matches()) throw new IllegalArgumentException("De geheime sleutel ziet eruit als 8-4-4-4-12 tekens met streepjes");
        return new String[] {accessKey, secretKey};
    }

    /** Het project waar de sleutel bij hoort (het standaardproject van de sleutel). */
    public static String scwProject(String accessKey, String secretKey, String projectId) throws IOException {
        if (projectId != null && PROJECT_ID.matcher(projectId.trim()).matches()) return projectId.trim();
        Object k;
        try {
            k = scw("GET", "/iam/v1alpha1/api-keys/" + Bytes.encodeURIComponent(accessKey), secretKey, null);
        } catch (HttpException e) {
            if (e.status == 403 || e.status == 404) throw new IOException("Kon het project van deze sleutel niet opzoeken. Maak de sleutel aan voor jezelf (niet voor een applicatie), of vul het project-ID in.", e);
            throw e;
        }
        Object sk = Json.path(k, "secret_key");
        if (Json.truthy(sk) && !secretKey.equals(sk)) throw new IOException("Deze geheime sleutel hoort niet bij deze toegangssleutel");
        Object id = Json.path(k, "default_project_id");
        if (!Json.truthy(id)) throw new IOException("Deze sleutel heeft geen standaardproject. Vul het project-ID in (Scaleway-console → Project → Instellingen).");
        return Json.jsString(id);
    }

    /** Recordnaam (relatief of volledig) → subname binnen de zone (src/tem.ts subnameOf). */
    public static String subnameOf(String name, String zone) {
        String n = name.replaceFirst("\\.$", "").toLowerCase(Locale.ROOT);
        if (n.equals(zone) || n.equals("@") || n.isEmpty()) return "";
        return n.endsWith("." + zone) ? n.substring(0, n.length() - zone.length() - 1) : n;
    }

    /** Records uit een TEM-domein, ook bij oudere vormen (spf_config/dkim_config): {dkim: {name, value}|null, dmarc, spfExtra}. */
    public static Map<String, Object> temRecords(Object dom, String projectId) {
        Object r = Json.path(dom, "records");
        Map<String, Object> dkim = temPick(Json.path(r, "dkim"));
        if (dkim == null && Json.truthy(Json.path(dom, "dkim_config"))) dkim = Json.obj("name", projectId + "._domainkey", "value", Json.jsString(Json.path(dom, "dkim_config")));
        Map<String, Object> dmarc = temPick(Json.path(r, "dmarc"));
        Map<String, Object> spfRec = temPick(Json.path(r, "spf"));
        String spf = spfRec != null ? (String) spfRec.get("value") : Json.truthy(Json.path(dom, "spf_config")) ? Json.jsString(Json.path(dom, "spf_config")) : "";
        List<String> inc = new ArrayList<>();
        for (String tok : WS.split(spf)) if (tok.startsWith("include:")) inc.add(tok);
        return Json.obj("dkim", dkim, "dmarc", dmarc, "spfExtra", String.join(" ", inc));
    }

    private static Map<String, Object> temPick(Object x) {
        Map<String, Object> m = Json.asMap(x);
        if (m == null || !Json.truthy(m.get("value"))) return null;
        return Json.obj("name", m.get("name") == null ? "" : Json.jsString(m.get("name")), "value", Json.jsString(m.get("value")));
    }

    /** Mail versturen via Scaleway: maildomein aanmelden, relay instellen, DKIM-record voor de cloud klaarzetten. */
    public static Map<String, Object> scwMail(Map<String, Object> c, String secretKey, String projectId) throws IOException {
        String d = Json.truthy(c.get("domain")) ? Json.jsString(c.get("domain")) : null;
        if (d == null) throw new IOException("Nog geen domein");
        Map<String, Object> con = console(c);
        Object dom = null;
        String known = Json.str(con, "temDomainId");
        if (known != null && !known.isEmpty()) {
            try { dom = scw("GET", TEM + "/" + known, secretKey, null); } catch (IOException e) { dom = null; }
        }
        if (dom != null && (!d.equals(Json.path(dom, "name")) || "revoked".equals(Json.path(dom, "status")))) dom = null;
        if (dom == null) {
            Object list = scw("GET", TEM + "?project_id=" + Bytes.encodeURIComponent(projectId) + "&name=" + Bytes.encodeURIComponent(d), secretKey, null);
            for (Object x : Json.listAt(list, "domains")) {
                if (d.equals(Json.path(x, "name")) && !"revoked".equals(Json.path(x, "status"))) { dom = x; break; }
            }
        }
        if (dom == null) dom = scw("POST", TEM, secretKey, Json.obj("project_id", projectId, "domain_name", d, "accept_tos", true));
        if (!Json.truthy(Json.path(dom, "id"))) throw new IOException("Scaleway gaf geen maildomein terug");
        Map<String, Object> rec = temRecords(dom, projectId);
        Map<String, Object> dkim = Json.asMap(rec.get("dkim"));
        con.put("temDomainId", Json.jsString(Json.path(dom, "id")));
        con.put("mailRelay", "smtp://" + Bytes.encodeURIComponent(projectId) + ":" + Bytes.encodeURIComponent(secretKey) + "@smtp.tem.scaleway.com:587");
        String spfExtra = (String) rec.get("spfExtra");
        con.put("spfExtra", spfExtra.isEmpty() ? "include:_spf.tem.scaleway.com" : spfExtra);
        con.put("extraDns", dkim != null ? Json.list(Json.obj("sub", subnameOf((String) dkim.get("name"), d), "type", "TXT", "value", dkim.get("value"))) : Json.list());
        return Json.obj("ok", true, "detail", dkim != null ? "Je cloud zet de handtekening (DKIM) zelf in je DNS; Scaleway keurt het domein daarna goed" : "Maildomein aangemeld");
    }

    /** Bij opnieuw beginnen: het maildomein bij Scaleway intrekken. Null als er niets in te trekken is. */
    public static String scwRevokeMail(Map<String, Object> c) throws IOException {
        String secret = Json.str(c, "providers", "scaleway", "secretKey");
        String id = Json.str(c, "console", "temDomainId");
        if (id == null || id.isEmpty() || secret == null || secret.isEmpty()) return null;
        scw("POST", TEM + "/" + id + "/revoke", secret, Json.obj());
        return "Maildomein bij Scaleway ingetrokken";
    }
}
