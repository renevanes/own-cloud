package nl.eigencloud.core;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Aanbieder worden: je eigen Eigen Cloud Dienst opzetten en bijhouden vanuit de console (port of
 * src/console/aanbieder.ts; the console routes /api/aanbieder… return the same JSON). State lives in the vault under
 * console.aanbieder. Blocking; call off the UI thread.
 */
public final class Aanbieder {
    private Aanbieder() {}

    public static final String PROJECT_NAME = "eigen-cloud-dienst";
    public static final String SERVER_REGION = "nl-ams-1";
    public static final String SERVER_SIZE = "DEV1-S";
    public static final String BACKUP_REGION = "fr-par";
    private static final List<String> STEPS = java.util.Arrays.asList("bedrijf", "accounts", "adres", "opzetten", "klaar");
    private static final String[] ACCOUNT_FIELDS = {"scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "smtpUrl", "openproviderUser", "openproviderPass", "adresUrl", "mailFrom"};

    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", Pattern.CASE_INSENSITIVE);
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern MOLLIE_KEY = Pattern.compile("^(test|live)_[A-Za-z0-9]+$");
    private static final Pattern HOSTNAME = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");

    /** How the console reaches the Dienst (tests point the public address at a local server). */
    public interface Reach { String base(String url); }

    /** DNS lookup of A records (tests replace it). */
    public interface Resolver { List<String> resolve4(String host); }

    public static volatile Reach reach = url -> url;
    public static volatile Resolver resolver = Aanbieder::resolve4Doh;
    /** Security for smtp:// (not smtps://) when checking the mail server; tests use NONE against a local server. */
    public static volatile SmtpCheck.Security plainSmtp = SmtpCheck.Security.STARTTLS;
    /** Wait between bucket attempts (a new Scaleway key can take a few seconds to work). */
    public static volatile long retryDelayMs = 4000;

    /** What the console needs from its surroundings. */
    public interface Deps {
        /** Scaleway Object Storage endpoint of a region. */
        String storeEndpoint(String region);

        void save() throws IOException;
    }

    /** A failed setup, with the steps done so far (for {error, steps}). */
    public static final class SetupException extends IOException {
        private static final long serialVersionUID = 1L;
        public final transient List<Object> steps;

        SetupException(String message, List<Object> steps, Throwable cause) {
            super(message, cause);
            this.steps = steps;
        }
    }

    // ───────── Toestand ─────────

    private static Map<String, Object> existing(Map<String, Object> c) { return Json.map(c, "console", "aanbieder"); }

    private static Map<String, Object> state(Map<String, Object> c) {
        Map<String, Object> con = Json.map(c, "console");
        Map<String, Object> a = Json.map(con, "aanbieder");
        if (a == null) {
            a = Json.obj("step", "bedrijf");
            con.put("aanbieder", a);
        }
        return a;
    }

    private static Map<String, Object> sub(Map<String, Object> m, String key) {
        Map<String, Object> x = Json.map(m, key);
        if (x == null) { x = Json.obj(); m.put(key, x); }
        return x;
    }

    private static String s(Object v) { return v == null ? null : Json.jsString(v); }

    private static boolean nonEmpty(String v) { return v != null && !v.isEmpty(); }

    private static String mask(String v) { return v == null || v.isEmpty() ? "" : "••••••••" + v.substring(Math.max(0, v.length() - 4)); }

    private static String smtpOf(Map<String, Object> c, Map<String, Object> a) {
        String own = Json.str(a, "accounts", "smtpUrl");
        if (nonEmpty(own)) return own;
        String relay = Json.str(c, "console", "mailRelay");
        return relay == null ? "" : relay;
    }

    private static String mailFromOf(Map<String, Object> c, Map<String, Object> a) {
        String own = Json.str(a, "accounts", "mailFrom");
        if (nonEmpty(own)) return own;
        return "noreply@" + (c.get("domain") != null ? Json.jsString(c.get("domain")) : "localhost");
    }

    /** "smtp://gebruiker@host:587", zonder wachtwoord; null als het geen adres is. */
    public static String smtpDisplay(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            URI u = new URI(url);
            if (u.getScheme() == null || u.getHost() == null) return null;
            String ui = u.getRawUserInfo();
            String user = ui == null ? "" : Bytes.decodeURIComponent(ui.indexOf(':') >= 0 ? ui.substring(0, ui.indexOf(':')) : ui);
            return u.getScheme().toLowerCase(Locale.ROOT) + "://" + (user.isEmpty() ? "" : user + "@") + u.getHost() + (u.getPort() >= 0 ? ":" + u.getPort() : "");
        } catch (URISyntaxException | RuntimeException e) {
            return null;
        }
    }

    private static String hostOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try { return new URI(url).getHost(); } catch (URISyntaxException e) { return null; }
    }

    /** Waar het adres van de Dienst naartoe wijst en of je cloud dat record zelf publiceert. */
    public static Map<String, Object> dnsInfo(Map<String, Object> c) {
        Map<String, Object> a = existing(c);
        String host = hostOf(Json.str(a, "url"));
        String d = c.get("domain") != null ? Json.jsString(c.get("domain")) : "";
        String sub = host != null && !d.isEmpty() && host.endsWith("." + d) ? host.substring(0, host.length() - d.length() - 1) : null;
        boolean managed = sub != null && !Json.listAt(c, "dns").isEmpty() && Json.truthy(Json.path(c, "console", "done"));
        return Json.obj("host", host, "sub", sub, "managed", managed, "value", Json.path(a, "server", "ipv4"));
    }

    private static boolean accountsReady(Map<String, Object> a) {
        Map<String, Object> ch = Json.map(a, "checked");
        for (String k : new String[] {"scaleway", "mollie", "desec", "smtp"}) if (!Boolean.TRUE.equals(Json.path(ch, k))) return false;
        return !Boolean.FALSE.equals(Json.path(ch, "adres"));
    }

    private static boolean companyReady(Map<String, Object> a) {
        return nonEmpty(Json.str(a, "company", "name")) && nonEmpty(Json.str(a, "company", "email"));
    }

    /** GET /api/aanbieder: wat de console mag laten zien (geen geheimen, alleen de laatste 4 tekens). */
    public static Map<String, Object> view(Map<String, Object> c) {
        Map<String, Object> a = existing(c);
        Object domain = c.get("domain");
        String defaultUrl = Json.truthy(domain) ? "https://dienst." + Json.jsString(domain) : null;
        String alert = Json.str(c, "console", "alertEmail");
        Object defaultEmail = nonEmpty(alert) ? alert : null;
        if (a == null) return Json.obj("started", false, "step", null, "defaultUrl", defaultUrl, "defaultEmail", defaultEmail);
        Map<String, Object> acc = Json.map(a, "accounts");
        if (acc == null) acc = Json.obj();
        String smtp = smtpOf(c, a);
        String mollie = Json.str(acc, "mollieKey");
        Map<String, Object> server = Json.map(a, "server");
        String bucket = Json.str(a, "backup", "bucket");
        Map<String, Object> checked = Json.map(a, "checked");
        String url = Json.str(a, "url");
        return Json.obj(
                "started", true,
                "step", a.get("step"),
                "defaultUrl", defaultUrl,
                "defaultEmail", defaultEmail,
                "company", a.get("company") != null ? a.get("company") : null,
                "url", url,
                "accounts", Json.obj(
                        "scalewayOrgId", acc.get("scalewayOrgId") != null ? acc.get("scalewayOrgId") : "", "scalewaySecretKey", mask(Json.str(acc, "scalewaySecretKey")),
                        "mollieKey", mask(mollie), "mollieMode", mollie != null && !mollie.isEmpty() ? (mollie.startsWith("live_") ? "live" : "test") : null,
                        "desecToken", mask(Json.str(acc, "desecToken")),
                        "smtp", smtpDisplay(smtp), "smtpFromCloud", !nonEmpty(Json.str(acc, "smtpUrl")) && Json.truthy(Json.path(c, "console", "mailRelay")),
                        "openproviderUser", acc.get("openproviderUser") != null ? acc.get("openproviderUser") : "", "openproviderPass", mask(Json.str(acc, "openproviderPass")),
                        "adresUrl", acc.get("adresUrl") != null ? acc.get("adresUrl") : "", "mailFrom", mailFromOf(c, a)),
                "checked", checked != null ? checked : Json.obj(),
                "ready", Json.obj("bedrijf", companyReady(a), "accounts", accountsReady(a), "adres", nonEmpty(url)),
                "server", server == null ? null : Json.obj("region", server.get("region"), "size", server.get("size"), "serverId", server.get("serverId"),
                        "ipv4", server.get("ipv4"), "ipv6", server.get("ipv6"), "createdAt", server.get("createdAt")),
                "backup", nonEmpty(bucket) ? Json.obj("bucket", bucket, "region", Json.path(a, "backup", "region")) : null,
                "dns", dnsInfo(c),
                "createdAt", a.get("createdAt"),
                "lastHealth", a.get("lastHealth"),
                "removed", Json.truthy(a.get("removed")),
                "retired", (long) Json.listAt(a, "retired").size(),
                "beheerUrl", url != null ? url + "/beheer" : null);
    }

    /** Vorige/Volgende in de stappen; "uit" vergeet alles zolang er geen Dienst is (of was). */
    public static Map<String, Object> setStep(Map<String, Object> c, String step) {
        if ("uit".equals(step)) {
            Map<String, Object> cur = existing(c);
            if (cur != null && (cur.get("server") != null || Json.truthy(cur.get("removed")))) throw new IllegalArgumentException("Je Dienst bestaat al; verwijderen kan bij Je dienst");
            Json.map(c, "console").remove("aanbieder");
            return Json.obj("ok", true, "step", null);
        }
        if (!STEPS.contains(step)) throw new IllegalArgumentException("Onbekende stap");
        Map<String, Object> a = state(c);
        if ("klaar".equals(step) && a.get("server") == null && !Json.truthy(a.get("removed"))) throw new IllegalArgumentException("Zet de Dienst eerst op");
        a.put("step", step);
        return Json.obj("ok", true, "step", step);
    }

    // ───────── 1. Bedrijf ─────────

    public static Map<String, Object> saveBedrijf(Map<String, Object> c, Map<String, Object> b) {
        String name = b.get("name") == null ? "" : Json.jsString(b.get("name")).trim();
        if (name.length() < 2 || name.length() > 100 || name.indexOf('\n') >= 0 || name.indexOf('\r') >= 0) throw new IllegalArgumentException("Vul de naam van je bedrijf in");
        List<String> raw = new ArrayList<>();
        Object addr = b.get("address");
        if (addr instanceof List) for (Object x : (List<?>) addr) raw.add(Json.jsString(x));
        else for (String l : (addr == null ? "" : Json.jsString(addr)).split("\\r?\\n", -1)) raw.add(l);
        List<Object> address = new ArrayList<>();
        for (String l : raw) if (!l.trim().isEmpty()) address.add(l.trim());
        for (Object l : address) if (((String) l).length() > 100) throw new IllegalArgumentException("Het adres mag hooguit 5 regels hebben");
        if (address.size() > 5) throw new IllegalArgumentException("Het adres mag hooguit 5 regels hebben");
        String kvk = (b.get("kvk") == null ? "" : Json.jsString(b.get("kvk"))).replaceAll("\\s", "");
        if (!kvk.isEmpty() && !kvk.matches("^\\d{8}$")) throw new IllegalArgumentException("Een KvK-nummer heeft 8 cijfers");
        String vat = (b.get("vat") == null ? "" : Json.jsString(b.get("vat"))).replaceAll("[\\s.]", "").toUpperCase(Locale.ROOT);
        if (!vat.isEmpty() && !vat.matches("^[A-Z]{2}[0-9A-Z]{2,13}$")) throw new IllegalArgumentException("Vul het btw-nummer in zoals NL001234567B01");
        String email = (b.get("email") == null ? "" : Json.jsString(b.get("email"))).trim().toLowerCase(Locale.ROOT);
        if (!EMAIL.matcher(email).matches()) throw new IllegalArgumentException("Vul het e-mailadres van de eigenaar in");
        Map<String, Object> a = state(c);
        a.put("company", Json.obj("name", name, "address", address, "kvk", kvk, "vat", vat, "email", email));
        if ("bedrijf".equals(a.get("step"))) a.put("step", "accounts");
        return Json.obj("ok", true, "step", a.get("step"));
    }

    // ───────── 2. Accounts ─────────

    private static final class Res {
        final int status;
        final Object json;

        Res(int status, Object json) {
            this.status = status;
            this.json = json;
        }

        boolean ok() { return status >= 200 && status < 300; }
    }

    private static Res http(String method, String url, Map<String, String> headers, Object body, int ms) throws IOException {
        Http.Response r = Http.request(method, url, headers, body == null ? null : Bytes.utf8(Json.stringify(body)), ms);
        Object j = null;
        String t = r.text();
        try { j = t.isEmpty() ? null : Json.parse(t); } catch (RuntimeException e) { j = null; }
        return new Res(r.status, j);
    }

    private static Map<String, Object> check(String id, String label, boolean ok, String detail) {
        return Json.obj("id", id, "label", label, "ok", ok, "detail", detail);
    }

    private static Map<String, Object> checkScaleway(String key, String org) {
        String id = "scaleway", label = "Scaleway";
        if (!UUID.matcher(key).matches() || !UUID.matcher(org).matches()) return check(id, label, false, "Vul de geheime sleutel en het organisatie-ID in (allebei 8-4-4-4-12 tekens)");
        try {
            Res r = http("GET", Endpoints.SCALEWAY.replaceAll("/+$", "") + "/account/v3/projects?organization_id=" + Bytes.encodeURIComponent(org) + "&page_size=1", Http.headers("x-auth-token", key), null, 15_000);
            if (r.status == 401) return check(id, label, false, "Scaleway accepteert deze sleutel niet");
            if (r.status == 403) return check(id, label, false, "Deze sleutel mag geen projecten beheren. Geef hem de rechten uit de uitleg (ProjectManager, IAMManager, InstancesFullAccess, ObjectStorageFullAccess)");
            if (!r.ok()) return check(id, label, false, "Scaleway antwoordt " + r.status);
            return check(id, label, true, "Sleutel werkt voor je organisatie");
        } catch (IOException | RuntimeException e) {
            return check(id, label, false, "Scaleway is niet bereikbaar");
        }
    }

    private static Map<String, Object> checkMollie(String key) {
        String id = "mollie", label = "Mollie";
        if (!MOLLIE_KEY.matcher(key).matches()) return check(id, label, false, "Een Mollie-sleutel begint met test_ of live_");
        try {
            Res r = http("GET", Endpoints.MOLLIE.replaceAll("/+$", "") + "/methods", Http.headers("authorization", "Bearer " + key), null, 15_000);
            if (r.status == 401 || r.status == 403) return check(id, label, false, "Mollie accepteert deze sleutel niet");
            if (!r.ok()) return check(id, label, false, "Mollie antwoordt " + r.status);
            return check(id, label, true, key.startsWith("test_") ? "Testsleutel: betalingen zijn nep. Zet er later een live_-sleutel in." : "Live: echte betalingen");
        } catch (IOException | RuntimeException e) {
            return check(id, label, false, "Mollie is niet bereikbaar");
        }
    }

    private static Map<String, Object> checkDesec(String token) {
        String id = "desec", label = "deSEC";
        if (token.isEmpty()) return check(id, label, false, "Vul je deSEC-token in");
        try {
            Res r = http("GET", Endpoints.DESEC.replaceAll("/+$", "") + "/domains/", Http.headers("authorization", "Token " + token), null, 15_000);
            if (r.status == 401 || r.status == 403) return check(id, label, false, "deSEC accepteert dit token niet");
            if (!r.ok()) return check(id, label, false, "deSEC antwoordt " + r.status);
            return check(id, label, true, "Token werkt");
        } catch (IOException | RuntimeException e) {
            return check(id, label, false, "deSEC is niet bereikbaar");
        }
    }

    private static Map<String, Object> checkSmtp(String url) {
        String id = "smtp", label = "Mail versturen";
        if (url.isEmpty()) return check(id, label, false, "Vul een mailserver in, bijv. smtp://gebruiker:wachtwoord@smtp.tem.scaleway.com:587");
        SmtpCheck.Relay r = SmtpCheck.parseRelayUrl(url);
        if (r == null || r.host == null) return check(id, label, false, "Dat is geen geldig adres; het begint met smtp:// of smtps://");
        int port = r.port > 0 ? r.port : r.secure ? 465 : 587;
        try {
            SmtpCheck.verify(r.host, port, r.user, r.password, r.secure ? SmtpCheck.Security.IMPLICIT_TLS : plainSmtp, 10_000, null);
            return check(id, label, true, "Mail versturen werkt (via " + r.host + ")");
        } catch (IOException | RuntimeException e) {
            return check(id, label, false, "Verbinden met " + r.host + " lukt niet: " + e.getMessage());
        }
    }

    private static Map<String, Object> checkOpenprovider(String user, String pass) {
        String id = "openprovider", label = "Openprovider (optioneel)";
        if (user.isEmpty() || pass.isEmpty()) return check(id, label, false, "Vul gebruikersnaam én wachtwoord in");
        try {
            Res r = http("POST", Endpoints.OPENPROVIDER.replaceAll("/+$", "") + "/auth/login", Http.headers("content-type", "application/json"),
                    Json.obj("username", user, "password", pass, "ip", "0.0.0.0"), 15_000);
            if (r.ok() && Json.truthy(Json.path(r.json, "data", "token"))) return check(id, label, true, "Inloggen werkt: klanten kunnen een domein kopen");
            return check(id, label, false, "Openprovider laat deze gebruiker niet inloggen (vanaf dit apparaat). Controleer ook de IP-lijst; de Dienst kan dit later nog eens proberen.");
        } catch (IOException | RuntimeException e) {
            return check(id, label, false, "Openprovider is niet bereikbaar");
        }
    }

    private static Map<String, Object> checkAdres(String url) {
        String id = "adres", label = "Gratis adressen (optioneel)";
        try {
            URI u = new URI(url);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getRawUserInfo() != null || u.getRawQuery() != null) throw new URISyntaxException(url, "geen https");
            return check(id, label, true, "Gratis adressen via " + u.getHost().toLowerCase(Locale.ROOT));
        } catch (URISyntaxException e) {
            return check(id, label, false, "Het adres van de adressendienst begint met https://");
        }
    }

    /** Sleutels bewaren en live controleren; "••…" laat de bewaarde staan, leeg wist hem. Openprovider houdt niet tegen. */
    public static Map<String, Object> saveAccounts(Map<String, Object> c, Map<String, Object> b) {
        Map<String, Object> a = state(c);
        Map<String, Object> acc = Json.map(a, "accounts") != null ? Json.copy(Json.map(a, "accounts")) : Json.obj();
        for (String f : ACCOUNT_FIELDS) {
            if (!b.containsKey(f) || b.get(f) == null) continue;
            String v = Json.jsString(b.get(f)).trim();
            if (v.startsWith("••")) continue;
            if (f.equals("scalewaySecretKey") || f.equals("scalewayOrgId")) v = v.replaceAll("^[\"']|[\"']$", "").toLowerCase(Locale.ROOT);
            if (v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0) throw new IllegalArgumentException("Een sleutel past op één regel");
            if (!v.isEmpty()) acc.put(f, v); else acc.remove(f);
        }
        String mailFrom = Json.str(acc, "mailFrom");
        if (nonEmpty(mailFrom) && !EMAIL.matcher(mailFrom).matches()) throw new IllegalArgumentException("Het afzenderadres is geen geldig e-mailadres");
        a.put("accounts", acc);
        List<Object> checks = new ArrayList<>();
        checks.add(checkScaleway(nz(Json.str(acc, "scalewaySecretKey")), nz(Json.str(acc, "scalewayOrgId"))));
        checks.add(checkMollie(nz(Json.str(acc, "mollieKey"))));
        checks.add(checkDesec(nz(Json.str(acc, "desecToken"))));
        checks.add(checkSmtp(smtpOf(c, a)));
        if (nonEmpty(Json.str(acc, "openproviderUser")) || nonEmpty(Json.str(acc, "openproviderPass"))) checks.add(checkOpenprovider(nz(Json.str(acc, "openproviderUser")), nz(Json.str(acc, "openproviderPass"))));
        if (nonEmpty(Json.str(acc, "adresUrl"))) checks.add(checkAdres(Json.str(acc, "adresUrl")));
        Map<String, Object> checked = Json.obj();
        for (Object x : checks) checked.put(Json.str(x, "id"), Json.path(x, "ok"));
        a.put("checked", checked);
        boolean ready = accountsReady(a);
        if (ready && "accounts".equals(a.get("step"))) a.put("step", "adres");
        return Json.obj("ok", ready, "checks", checks, "step", a.get("step"));
    }

    private static String nz(String v) { return v == null ? "" : v; }

    // ───────── 3. Adres ─────────

    /** "dienst.vanes.nl" → "https://dienst.vanes.nl"; alleen https, zonder pad, poort of query. */
    public static String cleanUrl(String raw) {
        String v = (raw == null ? "" : raw).trim().toLowerCase(Locale.ROOT);
        if (!v.matches("^[a-z]+://.*")) v = "https://" + v;
        URI u;
        try { u = new URI(v); } catch (URISyntaxException e) { throw new IllegalArgumentException("Dat is geen geldig adres"); }
        String path = u.getRawPath();
        if (!"https".equals(u.getScheme()) || u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null || (u.getPort() >= 0 && u.getPort() != 443)
                || (path != null && !path.isEmpty() && !path.equals("/"))) throw new IllegalArgumentException("Vul alleen een adres in, zoals https://dienst.vanes.nl");
        if (u.getHost() == null || !HOSTNAME.matcher(u.getHost()).matches()) throw new IllegalArgumentException("Vul een adres in met een domeinnaam, zoals dienst.vanes.nl");
        return "https://" + u.getHost();
    }

    public static Map<String, Object> saveAdres(Map<String, Object> c, Map<String, Object> b) {
        Map<String, Object> a = state(c);
        String def = Json.truthy(c.get("domain")) ? "https://dienst." + Json.jsString(c.get("domain")) : "";
        String in = Json.str(b, "url");
        String url = cleanUrl(nonEmpty(in) ? in : def);
        LinkedHashSet<Object> remove = new LinkedHashSet<>(Json.listAt(a, "dnsRemove"));
        if (nonEmpty(Json.str(a, "url")) && !url.equals(Json.str(a, "url")) && a.get("server") != null) {
            String old = Json.str(dnsInfo(c), "sub");
            if (old != null) remove.add(old);
        }
        a.put("url", url);
        remove.remove(Json.str(dnsInfo(c), "sub"));
        if (remove.isEmpty()) a.remove("dnsRemove"); else a.put("dnsRemove", new ArrayList<>(remove));
        if ("adres".equals(a.get("step"))) a.put("step", "opzetten");
        return Json.obj("ok", true, "url", url, "step", a.get("step"), "dns", dnsInfo(c), "pending", a.get("server") != null);
    }

    // ───────── 4. Opzetten ─────────

    private static Object scw(String method, String path, String key, Object body) throws IOException {
        Res r;
        try {
            r = http(method, Endpoints.SCALEWAY.replaceAll("/+$", "") + path, Http.headers("x-auth-token", key, "content-type", "application/json"), body, 30_000);
        } catch (IOException e) {
            throw new IOException("Scaleway is niet bereikbaar", e);
        }
        if (r.status == 401) throw new HttpException("Scaleway accepteert de sleutel niet meer", 401, "");
        if (r.status == 403) throw new HttpException("De sleutel mag dit niet bij Scaleway (" + (Json.path(r.json, "message") != null ? Json.jsString(Json.path(r.json, "message")) : "geen toegang") + ")", 403, "");
        if (!r.ok()) throw new HttpException("Scaleway antwoordt " + r.status + ": " + Bytes.head(Json.path(r.json, "message") != null ? Json.jsString(Json.path(r.json, "message")) : "", 160), r.status, "");
        return r.json;
    }

    /** De omgeving van de Dienst (dienst.env), in vaste volgorde; alleen voor de user-data. */
    public static List<String[]> dienstEnv(Map<String, Object> c, Map<String, Object> a) {
        Map<String, Object> acc = Json.map(a, "accounts"), co = Json.map(a, "company"), bk = Json.map(a, "backup");
        String name = Json.str(co, "name");
        String brand = name.replaceAll("[<>\"]", "").trim();
        List<String> lines = new ArrayList<>();
        for (Object l : Json.listAt(co, "address")) lines.add(Json.jsString(l));
        List<String[]> env = new ArrayList<>();
        env.add(new String[] {"BROKER_PUBLIC_URL", Json.str(a, "url")});
        env.add(new String[] {"BROKER_SECRET", Json.str(a, "secret")});
        env.add(new String[] {"BROKER_OWNER_EMAIL", Json.str(co, "email")});
        env.add(new String[] {"BROKER_ADMIN_EMAIL", Json.str(co, "email")});
        env.add(new String[] {"BROKER_BRAND_NAME", name});
        env.add(new String[] {"BROKER_MAIL_FROM", brand + " <" + mailFromOf(c, a) + ">"});
        env.add(new String[] {"BROKER_COMPANY_NAME", name});
        env.add(new String[] {"BROKER_COMPANY_ADDRESS", String.join("\\n", lines)});
        if (nonEmpty(Json.str(co, "kvk"))) env.add(new String[] {"BROKER_COMPANY_KVK", Json.str(co, "kvk")});
        if (nonEmpty(Json.str(co, "vat"))) env.add(new String[] {"BROKER_COMPANY_VAT", Json.str(co, "vat")});
        env.add(new String[] {"MOLLIE_API_KEY", Json.str(acc, "mollieKey")});
        env.add(new String[] {"DESEC_TOKEN", Json.str(acc, "desecToken")});
        env.add(new String[] {"SCW_SECRET_KEY", Json.str(acc, "scalewaySecretKey")});
        env.add(new String[] {"SCW_ORGANIZATION_ID", Json.str(acc, "scalewayOrgId")});
        env.add(new String[] {"BROKER_SMTP_URL", smtpOf(c, a)});
        if (nonEmpty(Json.str(acc, "openproviderUser")) && nonEmpty(Json.str(acc, "openproviderPass"))) {
            env.add(new String[] {"OPENPROVIDER_USERNAME", Json.str(acc, "openproviderUser")});
            env.add(new String[] {"OPENPROVIDER_PASSWORD", Json.str(acc, "openproviderPass")});
        }
        if (nonEmpty(Json.str(acc, "adresUrl"))) env.add(new String[] {"BROKER_ADRES_URL", Json.str(acc, "adresUrl")});
        env.add(new String[] {"BROKER_BACKUP_ENDPOINT", Json.str(bk, "endpoint")});
        env.add(new String[] {"BROKER_BACKUP_REGION", Json.str(bk, "region")});
        env.add(new String[] {"BROKER_BACKUP_BUCKET", Json.str(bk, "bucket")});
        env.add(new String[] {"BROKER_BACKUP_ACCESS_KEY", Json.str(bk, "accessKey")});
        env.add(new String[] {"BROKER_BACKUP_SECRET_KEY", Json.str(bk, "secretKey")});
        return env;
    }

    /** Het opstartscript voor de server van de Dienst (met dezelfde images als je cloud). */
    public static String serverUserData(Map<String, Object> c, Map<String, Object> a) {
        String ref = Json.str(c, "image", "ref"), caddyRef = Json.str(c, "image", "caddyRef");
        CloudInit.DienstInit o = new CloudInit.DienstInit();
        o.host = hostOf(Json.str(a, "url"));
        o.email = Json.str(a, "company", "email");
        o.env = dienstEnv(c, a);
        o.appImage = nonEmpty(ref) ? ref : "ghcr.io/renevanes/eigen-cloud:latest";
        o.caddyImage = nonEmpty(caddyRef) ? caddyRef : "ghcr.io/renevanes/eigen-caddy:latest";
        o.appRef = o.appImage.replaceFirst("@sha256:[0-9a-f]{64}$", ":latest");
        o.caddyRef = o.caddyImage.replaceFirst("@sha256:[0-9a-f]{64}$", ":latest");
        return CloudInit.dienstUserData(o);
    }

    /** Token voor POST /v1/status/handover (zie src/broker/backup.ts). */
    public static String beheerToken(String secretHex) { return Bytes.hex(EigenCrypto.deriveKey(Bytes.fromHex(secretHex), "dienst-beheer")); }

    /** {ok, detail}: de huidige server een laatste back-up laten maken; daarna schrijft hij niets meer. */
    private static Object[] handover(Map<String, Object> a) {
        String url = Json.str(a, "url"), secret = Json.str(a, "secret");
        if (!nonEmpty(url) || !nonEmpty(secret)) return new Object[] {false, "Geen adres"};
        try {
            Res r = http("POST", reach.base(url) + "/v1/status/handover", Http.headers("authorization", "Beheer " + beheerToken(secret)), null, 120_000);
            if (r.ok()) return new Object[] {true, Json.truthy(Json.path(r.json, "lastBackupAt")) ? "Alles staat in de back-up" : "Geen back-up ingesteld"};
            return new Object[] {false, "De server antwoordt " + r.status + "; de nieuwe server krijgt de laatste back-up van het afgelopen uur"};
        } catch (IOException | RuntimeException e) {
            return new Object[] {false, "De server is niet bereikbaar; de nieuwe server krijgt de laatste back-up"};
        }
    }

    private static String ensureProject(Map<String, Object> a, String key, String org) throws IOException {
        if (nonEmpty(Json.str(a, "projectId"))) return Json.str(a, "projectId");
        Object list = scw("GET", "/account/v3/projects?organization_id=" + Bytes.encodeURIComponent(org) + "&name=" + PROJECT_NAME, key, null);
        String id = null;
        for (Object p : Json.listAt(list, "projects")) if (PROJECT_NAME.equals(Json.str(p, "name"))) { id = s(Json.path(p, "id")); break; }
        if (id == null) id = s(Json.path(scw("POST", "/account/v3/projects", key, Json.obj("name", PROJECT_NAME, "organization_id", org, "description", "Eigen Cloud Dienst: server en back-ups")), "id"));
        if (id == null) throw new IOException("Scaleway gaf geen project-id terug");
        a.put("projectId", id);
        return id;
    }

    /** Een eigen sleutel voor de back-ups: alleen Object Storage, alleen in het project van de Dienst. */
    private static void ensureBackupKey(Map<String, Object> a, String key, String org, Deps deps) throws IOException {
        Map<String, Object> bk = Json.map(a, "backup");
        if (bk == null) {
            bk = Json.obj("endpoint", deps.storeEndpoint(BACKUP_REGION), "region", BACKUP_REGION);
            a.put("backup", bk);
        }
        if (nonEmpty(Json.str(bk, "accessKey")) && nonEmpty(Json.str(bk, "secretKey"))) return;
        String name = PROJECT_NAME + "-backup";
        String orgQ = Bytes.encodeURIComponent(org);
        if (!nonEmpty(Json.str(bk, "applicationId"))) {
            String id = null;
            for (Object x : Json.listAt(scw("GET", "/iam/v1alpha1/applications?organization_id=" + orgQ + "&name=" + name, key, null), "applications")) if (name.equals(Json.str(x, "name"))) { id = s(Json.path(x, "id")); break; }
            if (id == null) id = s(Json.path(scw("POST", "/iam/v1alpha1/applications", key, Json.obj("name", name, "organization_id", org, "description", "Back-ups van de Eigen Cloud Dienst")), "id"));
            if (id == null) throw new IOException("Scaleway gaf geen applicatie-id terug");
            bk.put("applicationId", id);
            deps.save();
        }
        if (!nonEmpty(Json.str(bk, "policyId"))) {
            String id = s(Json.path(scw("GET", "/iam/v1alpha1/policies?organization_id=" + orgQ + "&application_id=" + Json.str(bk, "applicationId"), key, null), "policies", 0, "id"));
            if (id == null) id = s(Json.path(scw("POST", "/iam/v1alpha1/policies", key, Json.obj("name", name, "organization_id", org, "application_id", bk.get("applicationId"),
                    "description", "Alleen opslag in project " + Json.str(a, "projectId"), "rules", Json.list(Json.obj("permission_set_names", Json.list("ObjectStorageFullAccess"), "project_ids", Json.list(a.get("projectId")))))), "id"));
            if (id == null) throw new IOException("Scaleway gaf geen policy-id terug");
            bk.put("policyId", id);
            deps.save();
        }
        Object k = scw("POST", "/iam/v1alpha1/api-keys", key, Json.obj("application_id", bk.get("applicationId"), "default_project_id", a.get("projectId"), "description", "Back-ups van de Eigen Cloud Dienst"));
        if (!Json.truthy(Json.path(k, "access_key")) || !Json.truthy(Json.path(k, "secret_key"))) throw new IOException("Scaleway gaf geen sleutel terug");
        bk.put("accessKey", Json.str(k, "access_key"));
        bk.put("secretKey", Json.str(k, "secret_key"));
        deps.save();
    }

    private static void ensureBucket(Map<String, Object> c, Map<String, Object> a, Deps deps) throws IOException {
        Map<String, Object> bk = Json.map(a, "backup");
        String bucket = nonEmpty(Json.str(bk, "bucket")) ? Json.str(bk, "bucket") : Json.jsString(c.get("cluster")) + "-dienst-backup-" + Bytes.hex(Bytes.random(3));
        Map<String, Object> store = Json.obj("name", "dienst-backup", "type", "s3", "purpose", "backup", "country", "FR", "endpoint", bk.get("endpoint"), "region", bk.get("region"),
                "bucket", bucket, "accessKey", bk.get("accessKey"), "secretKey", bk.get("secretKey"));
        List<Admin.StepResult> steps = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            steps = Admin.prepareStore(store);
            if (Admin.storeStepsOk(steps)) {
                bk.put("bucket", bucket);
                deps.save();
                return;
            }
            ProviderApi.sleep(retryDelayMs);
        }
        List<String> why = new ArrayList<>();
        for (Admin.StepResult x : steps) if (!x.ok) why.add(x.label + (x.detail != null && !x.detail.isEmpty() ? " (" + x.detail + ")" : ""));
        throw new IOException("Back-upopslag klaarzetten lukte niet: " + String.join(", ", why));
    }

    private static Provider provider(Map<String, Object> a) {
        return Providers.make("scaleway", Json.obj("secretKey", Json.str(a, "accounts", "scalewaySecretKey"), "projectId", Json.str(a, "projectId")));
    }

    private static Map<String, Object> step(String label, boolean ok, String detail) {
        Map<String, Object> m = Json.obj("label", label, "ok", ok);
        if (detail != null) m.put("detail", detail);
        return m;
    }

    /** Opzetten, of (met een server) opnieuw opzetten: laatste back-up, nieuwe server die hem terugzet, oude weg. */
    public static Map<String, Object> opzetten(Map<String, Object> c, Deps deps) throws IOException {
        Map<String, Object> a = state(c);
        if (!companyReady(a)) throw new IllegalArgumentException("Vul eerst je bedrijfsgegevens in");
        if (!accountsReady(a)) throw new IllegalArgumentException("Controleer eerst je accounts (stap 2)");
        if (!nonEmpty(Json.str(a, "url"))) throw new IllegalArgumentException("Kies eerst het adres van je Dienst");
        String key = Json.str(a, "accounts", "scalewaySecretKey"), org = Json.str(a, "accounts", "scalewayOrgId");
        List<Object> steps = new ArrayList<>();
        boolean replace = nonEmpty(Json.str(a, "server", "serverId"));
        try {
            ensureProject(a, key, org);
            deps.save();
            steps.add(step("Project " + PROJECT_NAME + " bij Scaleway", true, null));
            ensureBackupKey(a, key, org, deps);
            steps.add(step("Sleutel voor de back-ups (werkt alleen in dit project)", true, null));
            ensureBucket(c, a, deps);
            steps.add(step("Back-upopslag in Parijs, 30 dagen niet te wissen", true, Json.str(a, "backup", "bucket")));
            if (!nonEmpty(Json.str(a, "secret"))) a.put("secret", EigenCrypto.randomKeyHex());
            deps.save();
            if (replace) {
                Object[] h = handover(a);
                steps.add(step("Laatste back-up van de huidige server", (Boolean) h[0], (String) h[1]));
            }
            String nodeId = "dienst-" + Bytes.hex(Bytes.random(3));
            Provider.ServerInfo info = provider(a).create(new Provider.CreateSpec(PROJECT_NAME, nodeId, "data", SERVER_REGION, SERVER_SIZE, serverUserData(c, a)));
            Map<String, Object> old = Json.map(a, "server");
            Map<String, Object> srv = Json.obj("provider", "scaleway", "region", SERVER_REGION, "size", SERVER_SIZE, "serverId", info.serverId);
            if (info.ipv4 != null) srv.put("ipv4", info.ipv4);
            if (info.ipv6 != null) srv.put("ipv6", info.ipv6);
            srv.put("createdAt", System.currentTimeMillis());
            synchronized (a) {
                a.put("server", srv);
                a.put("removed", false);
                if (a.get("createdAt") == null) a.put("createdAt", System.currentTimeMillis());
                a.put("lastHealth", null);
                a.put("step", "klaar");
                if (old != null && nonEmpty(Json.str(old, "serverId"))) {
                    List<Object> retired = new ArrayList<>(Json.listAt(a, "retired"));
                    retired.add(old.get("serverId"));
                    a.put("retired", retired);
                }
            }
            deps.save();
            steps.add(step("Server in Amsterdam (" + SERVER_SIZE + ")", true, info.ipv4 != null ? "IP-adres " + info.ipv4 : null));
            if (old != null && nonEmpty(Json.str(old, "serverId"))) steps.add(step("De vorige server wordt opgeruimd", true, null));
            Map<String, Object> d = dnsInfo(c);
            steps.add(Json.truthy(d.get("managed"))
                    ? step(Json.str(d, "host") + " wijst naar " + info.ipv4, true, "Je cloud zet dit record zelf in je DNS")
                    : step("Zet bij je DNS een A-record: " + Json.str(d, "host") + " → " + info.ipv4, true, null));
            if (!Json.listAt(a, "retired").isEmpty()) cleanupRetiredAsync(c, deps);
            return Json.obj("ok", true, "replaced", replace, "steps", steps, "server", view(c).get("server"));
        } catch (IOException | RuntimeException e) {
            try { deps.save(); } catch (IOException ignored) { /* bewaren lukt de volgende keer */ }
            throw new SetupException(e.getMessage(), steps, e);
        }
    }

    private static final AtomicBoolean CLEANING = new AtomicBoolean();

    /** Vervangen of verwijderde servers weghalen bij Scaleway, op de achtergrond; mislukt het, dan de volgende keer. */
    public static void cleanupRetiredAsync(Map<String, Object> c, Deps deps) {
        Map<String, Object> a = existing(c);
        if (a == null || Json.listAt(a, "retired").isEmpty() || !CLEANING.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            try { cleanupRetired(c, deps); } finally { CLEANING.set(false); }
        }, "eigen-dienst-opruimen");
        t.setDaemon(true);
        t.start();
    }

    /** Hetzelfde, maar wachtend (tests). */
    public static void cleanupRetired(Map<String, Object> c, Deps deps) {
        Map<String, Object> a = existing(c);
        if (a == null) return;
        // Ook servers die tijdens het opruimen bij de lijst komen (bijv. verwijderen vlak na opnieuw opzetten).
        java.util.Set<Object> tried = new java.util.HashSet<>();
        for (Object id = first(Json.listAt(a, "retired"), tried); id != null; id = first(Json.listAt(a, "retired"), tried)) {
            tried.add(id);
            try {
                provider(a).destroy(Json.jsString(id));
                synchronized (a) {
                    List<Object> left = new ArrayList<>(Json.listAt(a, "retired"));
                    left.remove(id);
                    if (left.isEmpty()) a.remove("retired"); else a.put("retired", left);
                }
                deps.save();
            } catch (IOException | RuntimeException ignored) {
                // volgende keer
            }
        }
    }

    private static Object first(List<Object> l, java.util.Set<Object> skip) {
        for (Object x : l) if (!skip.contains(x)) return x;
        return null;
    }

    // ───────── 5. Klaar: status, verwijderen ─────────

    /** A-records via DNS-over-HTTPS (zoals DnsSetup.resolveNs). */
    static List<String> resolve4Doh(String host) {
        for (String base : Endpoints.DOH) {
            try {
                String url = base + (base.contains("?") ? "&" : "?") + "name=" + Bytes.encodeURIComponent(host) + "&type=A";
                Http.Response r = Http.request("GET", url, Http.headers("accept", "application/dns-json"), null, 8000);
                if (!r.ok()) continue;
                List<String> out = new ArrayList<>();
                Object j = Json.parse(r.text());
                Number st = Json.num(j, "Status");
                if (st != null && st.intValue() != 0) return out;
                for (Object x : Json.listAt(j, "Answer")) {
                    Number type = Json.num(x, "type");
                    if (type != null && type.intValue() == 1 && Json.str(x, "data") != null) out.add(Json.str(x, "data").trim());
                }
                return out;
            } catch (IOException | RuntimeException ignored) {
                // volgende resolver
            }
        }
        return new ArrayList<>();
    }

    public static Map<String, Object> status(Map<String, Object> c, Deps deps) throws IOException {
        Map<String, Object> a = existing(c);
        Map<String, Object> server = Json.map(a, "server");
        if (server == null || !nonEmpty(Json.str(a, "url"))) return Json.obj("reachable", false, "server", false, "removed", a != null && Json.truthy(a.get("removed")));
        String url = Json.str(a, "url");
        Map<String, Object> h;
        try {
            Res r = http("GET", reach.base(url) + "/v1/status", null, null, 8000);
            if (!r.ok() || r.json == null) throw new IOException("De Dienst antwoordt " + r.status);
            h = Json.obj("at", System.currentTimeMillis(), "reachable", true, "version", Json.path(r.json, "version"), "uptime", Json.path(r.json, "uptime"),
                    "lastBackupAt", Json.path(r.json, "lastBackupAt"), "backup", Json.path(r.json, "backup"), "closing", Json.truthy(Json.path(r.json, "closing")));
        } catch (IOException | RuntimeException e) {
            String m = e.getMessage() == null ? "" : e.getMessage();
            h = Json.obj("at", System.currentTimeMillis(), "reachable", false, "version", null, "uptime", null, "lastBackupAt", Json.path(a, "lastHealth", "lastBackupAt"),
                    "backup", null, "closing", false, "error", m.contains("antwoordt") ? m : "Nog niet bereikbaar");
        }
        a.put("lastHealth", h);
        // De user-data bevat de geheimen van de Dienst: weghalen bij Scaleway zodra de server draait.
        if (Boolean.TRUE.equals(h.get("reachable")) && !Json.truthy(server.get("userDataCleared"))) {
            String[] parts = Json.jsString(server.get("serverId")).split("/");
            try {
                Http.Response r = Http.request("DELETE", Endpoints.SCALEWAY.replaceAll("/+$", "") + "/instance/v1/zones/" + parts[0] + "/servers/" + parts[1] + "/user_data/cloud-init",
                        Http.headers("x-auth-token", nz(Json.str(a, "accounts", "scalewaySecretKey"))), null, 15_000);
                if (r.ok() || r.status == 404) server.put("userDataCleared", true);
            } catch (IOException | RuntimeException ignored) {
                // volgende keer
            }
        }
        String host = hostOf(url);
        List<String> have = new ArrayList<>(resolver.resolve4(host));
        java.util.Collections.sort(have);
        deps.save();
        cleanupRetiredAsync(c, deps);
        Object want = server.get("ipv4");
        Map<String, Object> out = Json.copy(h);
        out.put("server", true);
        out.put("removed", false);
        out.put("dns", Json.obj("host", host, "want", want, "have", new ArrayList<Object>(have), "ok", want != null && have.contains(Json.jsString(want))));
        out.put("retired", (long) Json.listAt(a, "retired").size());
        return out;
    }

    /** De server weghalen; de back-ups (en hun sleutel) blijven, zodat "Opnieuw opzetten" alles terugzet. */
    public static Map<String, Object> verwijderen(Map<String, Object> c, Map<String, Object> b, Deps deps) throws IOException {
        Map<String, Object> a = existing(c);
        if (a == null || a.get("server") == null) throw new IllegalArgumentException("Er draait geen Dienst");
        String host = hostOf(Json.str(a, "url"));
        String confirm = b.get("confirm") == null ? "" : Json.jsString(b.get("confirm"));
        if (!confirm.trim().toLowerCase(Locale.ROOT).equals(host)) throw new IllegalArgumentException("Typ " + host + " om te bevestigen");
        Object[] h = handover(a);
        synchronized (a) {
            List<Object> retired = new ArrayList<>(Json.listAt(a, "retired"));
            retired.add(Json.path(a, "server", "serverId"));
            a.put("retired", retired);
            a.put("server", null);
            a.put("removed", true);
            a.put("lastHealth", null);
            a.put("step", "klaar");
        }
        deps.save();
        cleanupRetiredAsync(c, deps);
        return Json.obj("ok", true, "finalBackup", h[0], "detail", h[1], "bucket", Json.path(a, "backup", "bucket"), "pending", (long) Json.listAt(a, "retired").size());
    }
}
