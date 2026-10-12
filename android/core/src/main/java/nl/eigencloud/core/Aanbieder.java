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
 * src/console/aanbieder.ts; the console routes /api/aanbieder… return the same JSON). The Dienst's server can be at any
 * provider with servers ({@link Adapters}), its backups at any S3 storage. State lives in the vault under
 * console.aanbieder (older Scaleway-only states are migrated on read). Blocking; call off the UI thread.
 *
 * <p>Without an own cloud (vault with console.alleenDienst) the Dienst links its own DNS provider ({@code dns}): the
 * console then sets the A/AAAA records itself through the DNS adapter. Once set up there is one place for everything
 * ("Je dienst", {@code hub} in the view): what lives in the vault the console manages, what lives in the Dienst's
 * database opens /beheer at the right page.
 */
public final class Aanbieder {
    private Aanbieder() {}

    public static final String PROJECT_NAME = "eigen-cloud-dienst";
    /** Where a Dienst from before the provider choice runs (only Scaleway was possible then). */
    public static final String SERVER_REGION = "nl-ams-1";
    public static final String SERVER_SIZE = "DEV1-S";
    public static final String BACKUP_REGION = "fr-par";
    private static final List<String> STEPS = java.util.Arrays.asList("bedrijf", "accounts", "adres", "server", "opzetten", "klaar");
    private static final String[] ACCOUNT_FIELDS = {"scalewaySecretKey", "scalewayOrgId", "mollieKey", "desecToken", "smtpUrl", "openproviderUser", "openproviderPass", "adresUrl", "mailFrom"};

    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", Pattern.CASE_INSENSITIVE);
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern MOLLIE_KEY = Pattern.compile("^(test|live)_[A-Za-z0-9]+$");
    private static final Pattern HOSTNAME = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    private static final Pattern ZONE = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    /** Waar de Dienst de adressendienst op dezelfde server bereikt (ADRESSEN_LOCAL in aanbieder.ts). */
    public static final String ADRESSEN_LOCAL = "http://127.0.0.1:4200";
    /** Wat zonder nieuwe server kan wijzigen (INSTELBAAR in src/broker/instellingen.ts). */
    public static final List<String> INSTELBAAR = java.util.Arrays.asList(
            "BROKER_OWNER_EMAIL", "BROKER_ADMIN_EMAIL", "BROKER_BRAND_NAME", "BROKER_MAIL_FROM",
            "BROKER_COMPANY_NAME", "BROKER_COMPANY_ADDRESS", "BROKER_COMPANY_KVK", "BROKER_COMPANY_VAT", "BROKER_VAT_PERCENT", "BROKER_ENFORCE",
            "MOLLIE_API_KEY", "DESEC_TOKEN", "SCW_SECRET_KEY", "SCW_ORGANIZATION_ID", "BROKER_SMTP_URL", "OPENPROVIDER_USERNAME", "OPENPROVIDER_PASSWORD",
            "BROKER_ADRES_URL", "BROKER_ADRES_PUBLIEK");

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

    /** Server and storage offers from the catalog (the console passes them; tests point storage at a fake S3). */
    public interface Offers {
        List<Map<String, Object>> serverOffers();

        List<Map<String, Object>> storeOffers();

        /** DNS offers (catalog.json "dns"); empty when not given. */
        default List<Map<String, Object>> dnsOffers() { return new ArrayList<>(); }
    }

    /** Offers straight from a catalog. */
    public static Offers offers(final Catalog cat) {
        return new Offers() {
            @Override public List<Map<String, Object>> serverOffers() { return cat.serverOffers(); }

            @Override public List<Map<String, Object>> storeOffers() { return cat.storeOffers(); }

            @Override public List<Map<String, Object>> dnsOffers() { return cat.dnsOffers(); }
        };
    }

    /** What the console needs from its surroundings. */
    public interface Deps extends Offers {
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

    /**
     * Older (Scaleway-only) states to the current shape: server and backup get their provider, retired servers become
     * {provider, serverId}, and a Dienst that exists (or existed) gets the place where it ran (migrate in TS).
     */
    @SuppressWarnings("unchecked")
    static Map<String, Object> migrate(Map<String, Object> a) {
        if (a == null) return null;
        Object ret = a.get("retired");
        if (ret instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<Object>) ret) out.add(x instanceof String ? Json.obj("provider", "scaleway", "serverId", x) : x);
            a.put("retired", out);
        }
        Map<String, Object> server = Json.map(a, "server");
        if (server != null && !Json.truthy(server.get("provider"))) server.put("provider", "scaleway");
        Map<String, Object> bk = Json.map(a, "backup");
        if (bk != null && !Json.truthy(bk.get("provider"))) {
            bk.put("provider", "scaleway");
            bk.put("country", bk.get("country") != null ? bk.get("country") : "FR");
        }
        if (a.get("hosting") == null && (server != null || Json.truthy(a.get("removed")) || Json.truthy(Json.path(a, "backup", "bucket")))) {
            a.put("hosting", Json.obj("provider", server != null && server.get("provider") != null ? server.get("provider") : "scaleway",
                    "region", server != null && server.get("region") != null ? server.get("region") : SERVER_REGION,
                    "size", server != null && server.get("size") != null ? server.get("size") : SERVER_SIZE, "monthly", null));
        }
        if ("opzetten".equals(a.get("step")) && (a.get("hosting") == null || a.get("backup") == null)) a.put("step", "server");
        return a;
    }

    private static Map<String, Object> existing(Map<String, Object> c) { return migrate(Json.map(c, "console", "aanbieder")); }

    private static Map<String, Object> state(Map<String, Object> c) {
        Map<String, Object> con = Json.map(c, "console");
        Map<String, Object> a = Json.map(con, "aanbieder");
        if (a == null) {
            a = Json.obj("step", "bedrijf");
            con.put("aanbieder", a);
        }
        return migrate(a);
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
        String z = defaultZone(hostOf(Json.str(a, "url")));
        return "noreply@" + (c.get("domain") != null ? Json.jsString(c.get("domain")) : z != null ? z : "localhost");
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

    /** The sub-name of {@code host} under the cloud's domain ("dienst"), or null. */
    private static String cloudSub(Map<String, Object> c, String host) {
        String d = c.get("domain") != null ? Json.jsString(c.get("domain")) : "";
        return host != null && !d.isEmpty() && host.endsWith("." + d) ? host.substring(0, host.length() - d.length() - 1) : null;
    }

    /** Can the cloud publish records (a running cloud with a DNS link)? */
    private static boolean cloudDns(Map<String, Object> c) {
        return !Json.listAt(c, "dns").isEmpty() && Json.truthy(Json.path(c, "console", "done")) && Json.truthy(c.get("domain"));
    }

    /** Who sets the record for {@code host}: "eigen" (the console, own DNS link), "cloud" or "handmatig" (dnsFor in TS). */
    private static Map<String, Object> dnsFor(Map<String, Object> c, Map<String, Object> a, String host) {
        Object value = Json.path(a, "server", "ipv4");
        Map<String, Object> own = Json.map(a, "dns");
        if (own != null) {
            String z = Json.str(own, "zone");
            String sub = host == null ? null : host.equals(z) ? "" : host.endsWith("." + z) ? host.substring(0, host.length() - z.length() - 1) : null;
            return Json.obj("host", host, "sub", sub, "managed", sub != null, "value", value, "mode", "eigen", "provider", own.get("provider"), "zone", z);
        }
        String sub = cloudSub(c, host);
        boolean managed = sub != null && !sub.isEmpty() && cloudDns(c);
        Object provider = null;
        if (managed) {
            Object m = Json.path(c, "console", "dnsMode");
            provider = m != null ? m : Json.listAt(c, "dns").isEmpty() ? null : Json.path(Json.listAt(c, "dns").get(0), "type");
        }
        return Json.obj("host", host, "sub", sub, "managed", managed, "value", value, "mode", managed ? "cloud" : "handmatig", "provider", provider, "zone", managed ? c.get("domain") : null);
    }

    /** Waar het adres van de Dienst naartoe wijst en wie dat record zet (je cloud, de console of jijzelf). */
    public static Map<String, Object> dnsInfo(Map<String, Object> c) {
        Map<String, Object> a = existing(c);
        return dnsFor(c, a, hostOf(Json.str(a, "url")));
    }

    /** Zelfde voor de hostnaam van de adressendienst (als die op deze server draait). */
    public static Map<String, Object> adressenDns(Map<String, Object> c) {
        Map<String, Object> a = existing(c);
        return dnsFor(c, a, Json.str(a, "adressen", "host"));
    }

    private static boolean accountsReady(Map<String, Object> a) {
        Map<String, Object> ch = Json.map(a, "checked");
        for (String k : new String[] {"scaleway", "mollie", "desec", "smtp"}) if (!Boolean.TRUE.equals(Json.path(ch, k))) return false;
        return !Boolean.FALSE.equals(Json.path(ch, "adres"));
    }

    private static boolean companyReady(Map<String, Object> a) {
        return nonEmpty(Json.str(a, "company", "name")) && nonEmpty(Json.str(a, "company", "email"));
    }

    private static boolean serverReady(Map<String, Object> a) { return a.get("hosting") != null && a.get("backup") != null; }

    private static Map<String, Object> find(List<Map<String, Object>> l, String id) {
        if (id == null) return null;
        for (Map<String, Object> m : l) if (id.equals(m.get("id"))) return m;
        return null;
    }

    private static Map<String, Object> region(Map<String, Object> offer, String id) {
        if (offer == null || id == null) return null;
        for (Object r : Json.listAt(offer, "regions")) if (id.equals(Json.str(r, "id"))) return Json.asMap(r);
        return null;
    }

    /** The server: provider, region (with city and country) and size, as the console shows it. */
    private static Map<String, Object> hostingView(Map<String, Object> a, Offers o) {
        Map<String, Object> h = Json.map(a, "hosting");
        if (h == null) return null;
        String p = Json.str(h, "provider"), reg = Json.str(h, "region");
        Map<String, Object> offer = find(o.serverOffers(), p);
        Map<String, Object> r = region(offer, reg);
        return Json.obj("provider", p, "name", offer != null ? offer.get("name") : p, "region", reg, "regionLabel", r != null ? r.get("label") : reg,
                "city", r != null ? r.get("city") : reg, "country", r != null ? r.get("country") : null, "size", h.get("size"), "monthly", h.get("monthly"));
    }

    /** The backup place: provider, region and (once there are backups) the bucket; the place is then fixed. */
    private static Map<String, Object> backupView(Map<String, Object> a, Offers o) {
        Map<String, Object> b = Json.map(a, "backup");
        if (b == null) return null;
        String p = Json.str(b, "provider"), reg = Json.str(b, "region"), endpoint = Json.str(b, "endpoint");
        Map<String, Object> offer = find(o.storeOffers(), p);
        Map<String, Object> r = region(offer, reg);
        if (r == null && offer != null) for (Object x : Json.listAt(offer, "regions")) if (nonEmpty(Json.str(x, "endpoint")) && Json.str(x, "endpoint").equals(endpoint)) { r = Json.asMap(x); break; }
        String host = hostOf(endpoint);
        String country = nonEmpty(Json.str(b, "country")) ? Json.str(b, "country") : r != null && nonEmpty(Json.str(r, "country")) ? Json.str(r, "country") : null;
        return Json.obj("provider", p, "name", offer != null ? offer.get("name") : p, "region", reg,
                "regionLabel", r != null ? r.get("label") : host != null ? host.toLowerCase(Locale.ROOT) : reg, "country", country,
                "bucket", b.get("bucket"),
                "auto", "scaleway".equals(p) && (!nonEmpty(Json.str(b, "accessKey")) || nonEmpty(Json.str(b, "applicationId"))));
    }

    /** GET /api/aanbieder: wat de console mag laten zien (geen geheimen, alleen de laatste 4 tekens). */
    public static Map<String, Object> view(Map<String, Object> c, Offers offers) {
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
                "ready", Json.obj("bedrijf", companyReady(a), "accounts", accountsReady(a), "adres", nonEmpty(url), "server", serverReady(a)),
                "hosting", hostingView(a, offers),
                "hostingKeys", hostingKeys(a),
                "server", server == null ? null : Json.obj("provider", server.get("provider"), "region", server.get("region"), "size", server.get("size"), "serverId", server.get("serverId"),
                        "ipv4", server.get("ipv4"), "ipv6", server.get("ipv6"), "createdAt", server.get("createdAt")),
                "backup", backupView(a, offers),
                "dns", dnsInfo(c),
                "createdAt", a.get("createdAt"),
                "lastHealth", a.get("lastHealth"),
                "removed", Json.truthy(a.get("removed")),
                "retired", (long) Json.listAt(a, "retired").size(),
                "beheerUrl", url != null ? url + "/beheer" : null,
                "adressen", adressenView(a),
                "defaultAdressenHost", defaultAdressenHost(c, a),
                "wijzigingen", wijzigingen(c, a),
                "alleenDienst", Json.truthy(Json.path(c, "console", "alleenDienst")),
                "cloudDns", cloudDns(c),
                "dnsLink", dnsLinkView(a),
                "dnsKeuze", dnsKeuze(c, a),
                "defaultZone", defaultZone(hostOf(url)),
                "hersteltest", a.get("hersteltest") != null ? a.get("hersteltest") : null,
                "pending", new ArrayList<Object>(pendingSections(c, a)),
                "hub", hubOf(c, a));
    }

    private static Map<String, Object> dnsLinkView(Map<String, Object> a) {
        Map<String, Object> d = Json.map(a, "dns");
        if (d == null) return null;
        Map<String, Object> f = Json.map(d, "fields");
        return Json.obj("provider", d.get("provider"), "zone", d.get("zone"), "fields", f == null ? Json.list() : new ArrayList<Object>(f.keySet()),
                "records", d.get("set") != null ? d.get("set") : Json.list(), "error", d.get("error") != null ? d.get("error") : null,
                "at", d.get("at") != null ? d.get("at") : null, "nameservers", d.get("nameservers") != null ? d.get("nameservers") : Json.list());
    }

    private static Object dnsKeuze(Map<String, Object> c, Map<String, Object> a) {
        Object p = Json.path(a, "dns", "provider");
        if (p != null) return p;
        if (Json.truthy(a.get("dnsHandmatig"))) return "handmatig";
        return "cloud".equals(Json.str(dnsInfo(c), "mode")) ? "cloud" : null;
    }

    /** Het beheer van de Dienst op een pagina, bijv. https://dienst.vanes.nl/beheer#/klanten. */
    public static String beheerLink(String url, String page) { return BeheerLink.of(url, page); }

    /** Standaardzone voor de eigen DNS-koppeling: dienst.vanes.nl → vanes.nl (twee labels blijven zoals ze zijn). */
    public static String defaultZone(String host) {
        if (host == null) return null;
        String[] parts = host.split("\\.", -1);
        return parts.length > 2 ? host.substring(host.indexOf('.') + 1) : host;
    }

    /** The sections of "Je dienst" (HUB in aanbieder.ts): id, label, where the data lives, /beheer page or null. */
    public static final String[][] HUB = {
            {"overzicht", "Overzicht", "console", null},
            {"bedrijf", "Bedrijf", "console", null},
            {"accounts", "Accounts en sleutels", "console", null},
            {"aanbod", "Aanbod en prijzen", "dienst", "aanbod"},
            {"huisstijl", "Huisstijl", "dienst", "huisstijl"},
            {"medewerkers", "Medewerkers", "dienst", "medewerkers"},
            {"klanten", "Klanten", "dienst", "klanten"},
            {"hulpvragen", "Hulpvragen", "dienst", "hulpvragen"},
            {"berichten", "Berichten", "dienst", "berichten"},
            {"adressendienst", "Adressendienst", "beide", "adressen"},
            {"lijst", "Op de lijst", "dienst", "lijst"},
            {"server", "Server en back-ups", "console", null},
            {"kosten", "Kosten", "beide", "kosten"},
            {"updates", "Updates", "console", null},
    };

    private static String sectionOf(String key) {
        switch (key) {
            case "BROKER_OWNER_EMAIL": case "BROKER_ADMIN_EMAIL": case "BROKER_BRAND_NAME": case "BROKER_COMPANY_NAME":
            case "BROKER_COMPANY_ADDRESS": case "BROKER_COMPANY_KVK": case "BROKER_COMPANY_VAT": case "BROKER_VAT_PERCENT": case "BROKER_ENFORCE":
                return "bedrijf";
            case "BROKER_ADRES_PUBLIEK": return "adressendienst";
            default: return "accounts";
        }
    }

    /** Sha256 per setting (deployed.keys). */
    private static Map<String, Object> envKeys(Map<String, Object> c, Map<String, Object> a) {
        Map<String, Object> out = Json.obj();
        for (String[] kv : instelbaarEnv(c, a)) out.put(kv[0], sha(kv[1]));
        return out;
    }

    /** Sections with changes that are not on the Dienst yet (in HUB order). */
    public static List<String> pendingSections(Map<String, Object> c, Map<String, Object> a) {
        List<String> out = new ArrayList<>();
        String w = wijzigingen(c, a);
        if (w == null || "geen".equals(w)) return out;
        java.util.Set<String> set = new java.util.HashSet<>();
        if ("opnieuw".equals(w)) set.add("server");
        Map<String, Object> keys = Json.map(a, "deployed", "keys");
        if (keys != null) {
            Map<String, Object> now = envKeys(c, a);
            java.util.Set<String> all = new LinkedHashSet<>(keys.keySet());
            all.addAll(now.keySet());
            for (String k : all) if (!java.util.Objects.equals(keys.get(k), now.get(k))) set.add(sectionOf(k));
        }
        for (String[] h : HUB) if (set.contains(h[0])) out.add(h[0]);
        return out;
    }

    private static List<Object> hubOf(Map<String, Object> c, Map<String, Object> a) {
        String url = Json.str(a, "url");
        boolean server = a.get("server") != null;
        if (!nonEmpty(url) || (!server && !Json.truthy(a.get("removed")))) return null;
        List<String> pend = pendingSections(c, a);
        List<Object> out = new ArrayList<>();
        for (String[] h : HUB) {
            boolean link = h[3] != null && server && !("adressendienst".equals(h[0]) && Json.map(a, "adressen") == null);
            out.add(Json.obj("id", h[0], "label", h[1], "waar", h[2], "link", link ? beheerLink(url, h[3]) : null, "pending", pend.contains(h[0])));
        }
        return out;
    }

    private static Map<String, Object> adressenView(Map<String, Object> a) {
        Map<String, Object> x = Json.map(a, "adressen");
        if (x == null) return null;
        return Json.obj("zone", x.get("zone"), "desecToken", mask(Json.str(x, "desecToken")), "host", x.get("host"), "url", "https://" + Json.str(x, "host"));
    }

    /** Standaardhost van de adressendienst: dienst.x.nl → adressen.x.nl, anders adressen.<domein van je cloud>. */
    public static String defaultAdressenHost(Map<String, Object> c, Map<String, Object> a) {
        String host = hostOf(Json.str(a, "url"));
        if (host != null && host.startsWith("dienst.")) return "adressen." + host.substring("dienst.".length());
        return Json.truthy(c.get("domain")) ? "adressen." + Json.jsString(c.get("domain")) : null;
    }

    private static String sha(Object x) { return Bytes.sha256Hex(Bytes.utf8(Json.stringify(x))); }

    private static List<Object> envList(List<String[]> env) {
        List<Object> out = new ArrayList<>();
        for (String[] kv : env) out.add(Json.list(kv[0], kv[1]));
        return out;
    }

    /** De instellingen die zonder nieuwe server kunnen wijzigen. */
    public static List<String[]> instelbaarEnv(Map<String, Object> c, Map<String, Object> a) {
        List<String[]> out = new ArrayList<>();
        for (String[] kv : dienstEnv(c, a)) if (INSTELBAAR.contains(kv[0])) out.add(kv);
        return out;
    }

    /** Wat bij de server hoort: adres, plek, back-upbucket en de adressendienst. */
    private static List<Object> shapeOf(Map<String, Object> a) {
        return Json.list(nz(Json.str(a, "url")), nz(Json.str(a, "hosting", "provider")), nz(Json.str(a, "hosting", "region")), nz(Json.str(a, "hosting", "size")),
                nz(Json.str(a, "backup", "bucket")), nz(Json.str(a, "adressen", "host")), nz(Json.str(a, "adressen", "zone")), nz(Json.str(a, "adressen", "desecToken")));
    }

    /** "geen", "toepassen" (zonder nieuwe server) of "opnieuw"; null = onbekend of geen server. */
    public static String wijzigingen(Map<String, Object> c, Map<String, Object> a) {
        if (a.get("server") == null || Json.map(a, "deployed") == null) return null;
        if (!sha(shapeOf(a)).equals(Json.str(a, "deployed", "shape"))) return "opnieuw";
        return sha(envList(instelbaarEnv(c, a))).equals(Json.str(a, "deployed", "env")) ? "geen" : "toepassen";
    }

    /** Providers the Dienst has its own credentials for (Scaleway always: the key at Accounts). */
    private static List<Object> hostingKeys(Map<String, Object> a) {
        List<Object> out = new ArrayList<>();
        out.add("scaleway");
        Map<String, Object> keys = Json.map(a, "keys");
        if (keys != null) for (String k : keys.keySet()) if (!"scaleway".equals(k)) out.add(k);
        return out;
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
        String pct = (b.get("vatPercent") == null ? "" : Json.jsString(b.get("vatPercent"))).trim().replaceFirst(",", ".").replaceFirst("%$", "").trim();
        if (!pct.isEmpty() && (!pct.matches("^\\d{1,3}(\\.\\d{1,2})?$") || Double.parseDouble(pct) > 100)) throw new IllegalArgumentException("Vul het btw-percentage in als getal, bijvoorbeeld 21");
        String vatPercent = pct.isEmpty() ? "" : Json.jsString(Double.parseDouble(pct));
        Object ef = b.get("enforce");
        boolean enforce = Boolean.TRUE.equals(ef) || "1".equals(ef) || "true".equals(ef) || "on".equals(ef);
        Map<String, Object> a = state(c);
        Map<String, Object> co = Json.obj("name", name, "address", address, "kvk", kvk, "vat", vat, "email", email);
        if (!vatPercent.isEmpty()) co.put("vatPercent", vatPercent);
        if (enforce) co.put("enforce", true);
        a.put("company", co);
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
        if (nonEmpty(Json.str(a, "url")) && !url.equals(Json.str(a, "url")) && a.get("server") != null && Json.map(a, "dns") == null) {
            String old = cloudSub(c, hostOf(Json.str(a, "url")));
            if (old != null && !old.isEmpty()) remove.add(old);
        }
        a.put("url", url);
        remove.remove(cloudSub(c, hostOf(url)));
        if (remove.isEmpty()) a.remove("dnsRemove"); else a.put("dnsRemove", new ArrayList<>(remove));
        if ("adres".equals(a.get("step"))) a.put("step", "server");
        return Json.obj("ok", true, "url", url, "step", a.get("step"), "dns", dnsInfo(c), "pending", a.get("server") != null);
    }

    // ───────── 3b. Gratis-adressendienst (optioneel, voor de beheerders van het project) ─────────

    private static void addRemove(Map<String, Object> a, String sub) {
        LinkedHashSet<Object> remove = new LinkedHashSet<>(Json.listAt(a, "dnsRemove"));
        remove.add(sub);
        a.put("dnsRemove", new ArrayList<>(remove));
    }

    /** De gratis-adressendienst op de server van de Dienst aan (met live controle bij deSEC) of uit (saveAdressen in TS). */
    public static Map<String, Object> saveAdressen(Map<String, Object> c, Map<String, Object> b) {
        Map<String, Object> a = state(c);
        String oldSub = a.get("server") != null && Json.map(a, "dns") == null ? cloudSub(c, Json.str(a, "adressen", "host")) : null;
        if (Boolean.FALSE.equals(b.get("aan"))) {
            if (oldSub != null) addRemove(a, oldSub);
            a.remove("adressen");
            return Json.obj("ok", true, "checks", new ArrayList<Object>(), "adressen", null, "pending", a.get("server") != null);
        }
        Map<String, Object> cur = Json.map(a, "adressen");
        String zone = (b.get("zone") != null ? Json.jsString(b.get("zone")) : cur != null ? nz(Json.str(cur, "zone")) : "").trim().toLowerCase(Locale.ROOT).replaceAll("^\\.+|\\.+$", "");
        if (!ZONE.matcher(zone).matches()) throw new IllegalArgumentException("Vul de gedeelde zone in, zoals eigencloud.nl");
        String token = b.get("desecToken") == null ? "" : Json.jsString(b.get("desecToken")).trim();
        if (token.isEmpty() || token.startsWith("••")) token = cur != null ? nz(Json.str(cur, "desecToken")) : "";
        if (token.isEmpty()) throw new IllegalArgumentException("Vul het deSEC-token voor deze zone in");
        if (token.matches("(?s).*\\s.*")) throw new IllegalArgumentException("Een token past op één regel, zonder spaties");
        String rawHost = b.get("host") == null ? "" : Json.jsString(b.get("host")).trim();
        if (rawHost.isEmpty()) rawHost = cur != null && nonEmpty(Json.str(cur, "host")) ? Json.str(cur, "host") : nz(defaultAdressenHost(c, a));
        String host;
        try { host = hostOf(cleanUrl(rawHost)); } catch (IllegalArgumentException e) { throw new IllegalArgumentException("Vul een hostnaam in, zoals adressen.vanes.nl"); }
        if (host.equals(hostOf(Json.str(a, "url")))) throw new IllegalArgumentException("De adressendienst heeft een eigen hostnaam nodig, anders dan die van je Dienst");
        List<Object> checks = new ArrayList<>();
        Map<String, String> h = Http.headers("authorization", "Token " + token);
        String base = Endpoints.DESEC.replaceAll("/+$", "");
        try {
            Res z = http("GET", base + "/domains/" + Bytes.encodeURIComponent(zone) + "/", h, null, 15_000);
            checks.add(z.ok() ? check("zone", "Gedeelde zone", true, zone + " staat in dit deSEC-account")
                    : z.status == 401 ? check("zone", "Gedeelde zone", false, "deSEC accepteert dit token niet")
                    : z.status == 404 ? check("zone", "Gedeelde zone", false, zone + " staat niet in het deSEC-account van dit token. Maak de zone daar eerst aan.")
                    : check("zone", "Gedeelde zone", false, "deSEC antwoordt " + z.status));
            Res t = http("GET", base + "/auth/tokens/", h, null, 15_000);
            checks.add(t.ok() ? check("tokens", "Token mag tokens beheren", true, "Nodig om per adres een token te maken dat alleen in die zone mag schrijven")
                    : t.status == 403 ? check("tokens", "Token mag tokens beheren", false, "Dit token mag geen tokens beheren. Maak bij deSEC een token met 'Manage tokens' (perm_manage_tokens).")
                    : check("tokens", "Token mag tokens beheren", false, "deSEC antwoordt " + t.status));
        } catch (IOException | RuntimeException e) {
            checks.add(check("zone", "Gedeelde zone", false, "deSEC is niet bereikbaar"));
        }
        boolean ok = checks.size() == 2;
        for (Object x : checks) ok &= Boolean.TRUE.equals(Json.path(x, "ok"));
        if (ok) {
            a.put("adressen", Json.obj("zone", zone, "desecToken", token, "host", host));
            String newSub = cloudSub(c, host);
            if (oldSub != null && !oldSub.equals(newSub)) addRemove(a, oldSub);
            List<Object> left = new ArrayList<>();
            String dienstSub = cloudSub(c, hostOf(Json.str(a, "url")));
            for (Object x : Json.listAt(a, "dnsRemove")) if (!x.equals(newSub) && !x.equals(dienstSub)) left.add(x);
            if (left.isEmpty()) a.remove("dnsRemove"); else a.put("dnsRemove", left);
        }
        return Json.obj("ok", ok, "checks", checks, "adressen", adressenView(a), "dns", adressenDns(c), "pending", a.get("server") != null);
    }

    // ───────── 4. Server en back-ups ─────────

    /**
     * Where the Dienst's server goes. Without a region: log in (read only) and per region the smallest suitable size
     * (≥ 2 GB, like the cloud) with its live price. With a region: store that choice. Credentials: Scaleway uses the key
     * at Accounts; other providers what the cloud already linked, with what is typed now on top ("••…" keeps it).
     */
    public static Map<String, Object> saveServer(Map<String, Object> c, Map<String, Object> b, Offers deps) throws IOException {
        Map<String, Object> a = state(c);
        Map<String, Object> offer = find(deps.serverOffers(), Json.str(b, "provider"));
        if (offer == null) throw new IllegalArgumentException("Kies een aanbieder voor de server");
        String id = Json.str(offer, "id"), name = Json.str(offer, "name");
        Map<String, Object> fields;
        if ("scaleway".equals(id)) {
            String key = Json.str(a, "accounts", "scalewaySecretKey");
            if (!nonEmpty(key) || !Boolean.TRUE.equals(Json.path(a, "checked", "scaleway"))) throw new IllegalArgumentException("Controleer eerst je Scaleway-sleutel bij Accounts");
            fields = Json.obj("secretKey", key, "projectId", nz(Json.str(a, "projectId")));
        } else {
            fields = Json.obj();
            Map<String, Object> linked = Json.map(c, "providers", id), own = Json.map(a, "keys", id), in = Json.map(b, "fields");
            if (linked != null) fields.putAll(Json.copy(linked));
            if (own != null) fields.putAll(Json.copy(own));
            if (in != null) for (Map.Entry<String, Object> e : in.entrySet()) {
                if (!(e.getValue() instanceof String)) continue;
                String t = ((String) e.getValue()).trim();
                if (!t.isEmpty() && !t.startsWith("••")) fields.put(e.getKey(), t);
            }
            List<String> missing = new ArrayList<>();
            for (Object f : Json.listAt(offer, "fields")) if (!Json.truthy(Json.path(f, "optional")) && !Json.truthy(fields.get(Json.str(f, "key")))) missing.add(Json.str(f, "label"));
            if (!missing.isEmpty()) throw new IllegalArgumentException("Vul in: " + String.join(", ", missing));
            try {
                Adapters.makeProvider(id, fields).list(PROJECT_NAME);
            } catch (IOException | RuntimeException e) {
                throw new IOException("Inloggen bij " + name + " lukt niet: " + Bytes.head(String.valueOf(e.getMessage()).replaceFirst("https?://\\S+", ""), 160), e);
            }
            Map<String, Object> keys = Json.map(a, "keys") != null ? Json.copy(Json.map(a, "keys")) : Json.obj();
            keys.put(id, fields);
            a.put("keys", keys);
        }
        String reg = Json.str(b, "region");
        if (!nonEmpty(reg)) {
            List<Object> regions = new ArrayList<>();
            for (Object r : Json.listAt(offer, "regions")) {
                Map<String, Object> x = Json.obj("region", Json.str(r, "id"), "label", Json.str(r, "label"), "city", Json.str(r, "city"), "country", Json.str(r, "country"));
                try {
                    Catalog.SizeOption s = Catalog.pickSize(Catalog.fetchSizes(id, fields, Json.str(r, "id")), "data");
                    if (s != null) {
                        x.put("size", s.size);
                        x.put("sizeLabel", s.label);
                        x.put("monthly", s.monthly);
                    } else x.put("error", "Geen geschikt formaat (minstens 2 GB geheugen)");
                } catch (IOException | RuntimeException e) {
                    x.put("error", "Prijzen ophalen lukt niet");
                }
                regions.add(x);
            }
            return Json.obj("ok", true, "provider", id, "regions", regions);
        }
        Map<String, Object> r = region(offer, reg);
        if (r == null) throw new IllegalArgumentException("Kies een regio");
        Catalog.SizeOption s;
        try {
            s = Catalog.pickSize(Catalog.fetchSizes(id, fields, reg), "data");
        } catch (IOException | RuntimeException e) {
            throw new IOException("Prijzen ophalen bij " + name + " lukt niet", e);
        }
        if (s == null) throw new IllegalArgumentException("Geen geschikt formaat in " + Json.str(r, "label") + " (minstens 2 GB geheugen)");
        a.put("hosting", Json.obj("provider", id, "region", reg, "size", s.size, "monthly", s.monthly));
        return Json.obj("ok", true, "provider", id, "hosting", hostingView(a, deps), "pending", a.get("server") != null);
    }

    /**
     * Where the backups go: a linked S3 store of the cloud ({store}: its keys, an own bucket), or a storage offer with
     * region and keys. Scaleway without keys: the console makes one. May differ from the server's provider. Once there
     * are backups the place is fixed (a new server restores them from there).
     */
    public static Map<String, Object> saveBackup(Map<String, Object> c, Map<String, Object> b, Offers deps) {
        Map<String, Object> a = state(c);
        String have = Json.str(a, "backup", "bucket");
        if (nonEmpty(have)) throw new IllegalArgumentException("De back-ups staan al in " + have + "; die plek blijft hetzelfde");
        List<Map<String, Object>> offers = new ArrayList<>();
        for (Map<String, Object> o : deps.storeOffers()) if (!"localfs".equals(o.get("id"))) offers.add(o);
        String storeName = Json.str(b, "store");
        if (nonEmpty(storeName)) {
            Map<String, Object> st = null;
            for (Map<String, Object> x : ClusterConfig.stores(c)) if (storeName.equals(x.get("name")) && "s3".equals(x.get("type"))) { st = x; break; }
            String ep = Json.str(st, "endpoint");
            if (st == null || !nonEmpty(ep) || !nonEmpty(Json.str(st, "accessKey")) || !nonEmpty(Json.str(st, "secretKey"))) throw new IllegalArgumentException("Kies een gekoppelde opslag");
            String provider = "custom";
            outer:
            for (Map<String, Object> o : offers) for (Object r : Json.listAt(o, "regions")) if (nonEmpty(Json.str(r, "endpoint")) && Json.str(r, "endpoint").equals(ep)) { provider = Json.str(o, "id"); break outer; }
            a.put("backup", Json.obj("provider", provider, "endpoint", ep, "region", st.get("region") != null ? st.get("region") : "us-east-1",
                    "country", st.get("country") != null ? st.get("country") : "", "accessKey", st.get("accessKey"), "secretKey", st.get("secretKey")));
            return Json.obj("ok", true, "backup", backupView(a, deps));
        }
        Map<String, Object> offer = find(offers, Json.str(b, "provider"));
        if (offer == null) throw new IllegalArgumentException("Kies waar de back-ups komen");
        Map<String, Object> r = region(offer, Json.str(b, "region"));
        if (r == null) throw new IllegalArgumentException("Kies een locatie voor de back-ups");
        String endpoint = Json.truthy(offer.get("customEndpoint")) ? (b.get("endpoint") == null ? "" : Json.jsString(b.get("endpoint"))).trim() : nz(Json.str(r, "endpoint"));
        if (!Pattern.compile("^https?://[^\\s/]+").matcher(endpoint).find()) throw new IllegalArgumentException("Vul de endpoint-URL in (begint met https://)");
        String rid = Json.str(r, "id");
        String region = "eigen".equals(rid) ? "us-east-1" : rid;
        String accessKey = (b.get("accessKey") == null ? "" : Json.jsString(b.get("accessKey"))).trim();
        String secretKey = (b.get("secretKey") == null ? "" : Json.jsString(b.get("secretKey"))).trim();
        if ((accessKey + secretKey).matches("(?s).*[\\r\\n].*")) throw new IllegalArgumentException("Een sleutel past op één regel");
        String id = Json.str(offer, "id");
        if ("scaleway".equals(id) && accessKey.isEmpty() && secretKey.isEmpty()) {
            // Scaleway zonder eigen sleutels: bij het opzetten maakt de console een sleutel die alleen in het project mag.
            Map<String, Object> prev = Json.map(a, "backup");
            boolean keep = prev != null && "scaleway".equals(Json.str(prev, "provider")) && nonEmpty(Json.str(prev, "applicationId")) && endpoint.equals(Json.str(prev, "endpoint"));
            if (!keep) a.put("backup", Json.obj("provider", "scaleway", "endpoint", endpoint, "region", region, "country", r.get("country")));
        } else {
            if (accessKey.isEmpty() || secretKey.isEmpty()) throw new IllegalArgumentException("Vul de toegangssleutel en geheime sleutel in");
            a.put("backup", Json.obj("provider", id, "endpoint", endpoint, "region", region, "country", r.get("country"), "accessKey", accessKey, "secretKey", secretKey));
        }
        return Json.obj("ok", true, "backup", backupView(a, deps));
    }

    // ───────── 5. Opzetten ─────────

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
        String pct = Json.str(co, "vatPercent");
        if (nonEmpty(pct) && !"21".equals(pct)) env.add(new String[] {"BROKER_VAT_PERCENT", pct});
        if (Json.truthy(co.get("enforce"))) env.add(new String[] {"BROKER_ENFORCE", "1"});
        env.add(new String[] {"MOLLIE_API_KEY", Json.str(acc, "mollieKey")});
        env.add(new String[] {"DESEC_TOKEN", Json.str(acc, "desecToken")});
        env.add(new String[] {"SCW_SECRET_KEY", Json.str(acc, "scalewaySecretKey")});
        env.add(new String[] {"SCW_ORGANIZATION_ID", Json.str(acc, "scalewayOrgId")});
        env.add(new String[] {"BROKER_SMTP_URL", smtpOf(c, a)});
        if (nonEmpty(Json.str(acc, "openproviderUser")) && nonEmpty(Json.str(acc, "openproviderPass"))) {
            env.add(new String[] {"OPENPROVIDER_USERNAME", Json.str(acc, "openproviderUser")});
            env.add(new String[] {"OPENPROVIDER_PASSWORD", Json.str(acc, "openproviderPass")});
        }
        // De adressendienst op deze server gaat voor een ingevuld adres: de Dienst praat er rechtstreeks mee.
        if (Json.map(a, "adressen") != null) {
            env.add(new String[] {"BROKER_ADRES_URL", ADRESSEN_LOCAL});
            env.add(new String[] {"BROKER_ADRES_PUBLIEK", "https://" + Json.str(a, "adressen", "host")});
            env.add(new String[] {"BROKER_BACKUP_ADRESSEN", "/adressen/adressen.sqlite"});
        } else if (nonEmpty(Json.str(acc, "adresUrl"))) env.add(new String[] {"BROKER_ADRES_URL", Json.str(acc, "adresUrl")});
        env.add(new String[] {"BROKER_BACKUP_ENDPOINT", Json.str(bk, "endpoint")});
        env.add(new String[] {"BROKER_BACKUP_REGION", Json.str(bk, "region")});
        env.add(new String[] {"BROKER_BACKUP_BUCKET", Json.str(bk, "bucket")});
        env.add(new String[] {"BROKER_BACKUP_ACCESS_KEY", Json.str(bk, "accessKey")});
        env.add(new String[] {"BROKER_BACKUP_SECRET_KEY", Json.str(bk, "secretKey")});
        Object at = a.get("envAt");
        if (Json.truthy(at)) env.add(new String[] {"BROKER_ENV_AT", Json.jsString(at)});
        return env;
    }

    /** adressen.env voor de adressendienst op de server van de Dienst (alleen voor de user-data). */
    public static List<String[]> adressenEnv(Map<String, Object> a) {
        List<String[]> env = new ArrayList<>();
        env.add(new String[] {"ADRES_ZONE", Json.str(a, "adressen", "zone")});
        env.add(new String[] {"ADRES_DESEC_TOKEN", Json.str(a, "adressen", "desecToken")});
        env.add(new String[] {"ADRES_PUBLIC_URL", "https://" + Json.str(a, "adressen", "host")});
        env.add(new String[] {"ADRES_LOKAAL_DIENST", Json.str(a, "url")});
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
        if (Json.map(a, "adressen") != null) {
            o.adressenHost = Json.str(a, "adressen", "host");
            o.adressenEnv = adressenEnv(a);
        }
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

    /** Backups at Scaleway without own keys: the console makes a key itself (storage only, only in the project). */
    private static boolean autoBackup(Map<String, Object> a) {
        return "scaleway".equals(Json.str(a, "backup", "provider")) && !nonEmpty(Json.str(a, "backup", "accessKey"));
    }

    /** Een eigen sleutel voor de back-ups: alleen Object Storage, alleen in het project van de Dienst. */
    private static void ensureBackupKey(Map<String, Object> a, String key, String org, Deps deps) throws IOException {
        Map<String, Object> bk = Json.map(a, "backup");
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
        Map<String, Object> store = Json.obj("name", "dienst-backup", "type", "s3", "purpose", "backup", "country", bk.get("country") != null ? bk.get("country") : "",
                "endpoint", bk.get("endpoint"), "region", bk.get("region"), "bucket", bucket, "accessKey", bk.get("accessKey"), "secretKey", bk.get("secretKey"));
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

    /**
     * The Provider for servers of the Dienst at a provider: Scaleway with the key at Accounts in the project
     * eigen-cloud-dienst; other providers with the credentials chosen at "Server en back-ups" (or the cloud's own).
     */
    private static Provider providerFor(Map<String, Object> c, Map<String, Object> a, String id) {
        if ("scaleway".equals(id)) {
            String key = Json.str(a, "accounts", "scalewaySecretKey");
            if (!nonEmpty(key) || !nonEmpty(Json.str(a, "projectId"))) throw new IllegalStateException("Geen Scaleway-sleutel of project voor de server");
            return Providers.make("scaleway", Json.obj("secretKey", key, "projectId", Json.str(a, "projectId")));
        }
        Map<String, Object> f = Json.map(a, "keys", id);
        if (f == null) f = Json.map(c, "providers", id);
        if (f == null) throw new IllegalStateException("Geen inloggegevens voor " + id + "; kies de server opnieuw");
        return Providers.make(id, f);
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
        Map<String, Object> hosting = Json.map(a, "hosting");
        if (hosting == null) throw new IllegalArgumentException("Kies eerst waar de server van je Dienst komt");
        if (a.get("backup") == null) throw new IllegalArgumentException("Kies eerst waar de back-ups komen");
        String hp = Json.str(hosting, "provider"), hr = Json.str(hosting, "region"), hs = Json.str(hosting, "size");
        Map<String, Object> offer = find(deps.serverOffers(), hp);
        if (offer == null) throw new IllegalArgumentException("Onbekende aanbieder " + hp);
        Map<String, Object> where = region(offer, hr);
        String key = Json.str(a, "accounts", "scalewaySecretKey"), org = Json.str(a, "accounts", "scalewayOrgId");
        List<Object> steps = new ArrayList<>();
        boolean replace = nonEmpty(Json.str(a, "server", "serverId"));
        try {
            boolean auto = autoBackup(a);
            if ("scaleway".equals(hp) || auto) {
                ensureProject(a, key, org);
                deps.save();
                steps.add(step("Project " + PROJECT_NAME + " bij Scaleway", true, null));
            }
            if (auto) {
                ensureBackupKey(a, key, org, deps);
                steps.add(step("Sleutel voor de back-ups (werkt alleen in dit project)", true, null));
            }
            ensureBucket(c, a, deps);
            Map<String, Object> bv = backupView(a, deps);
            steps.add(step("Back-upopslag bij " + Json.jsString(bv.get("name")) + " (" + Json.jsString(bv.get("regionLabel")) + "), 30 dagen niet te wissen", true, Json.str(a, "backup", "bucket")));
            if (!nonEmpty(Json.str(a, "secret"))) a.put("secret", EigenCrypto.randomKeyHex());
            deps.save();
            if (replace) {
                Object[] h = handover(a);
                steps.add(step("Laatste back-up van de huidige server", (Boolean) h[0], (String) h[1]));
            }
            String nodeId = "dienst-" + Bytes.hex(Bytes.random(3));
            // dienst.env van deze server is nieuwer dan instellingen die eerder met "Toepassen" zijn gestuurd.
            a.put("envAt", System.currentTimeMillis());
            Provider.ServerInfo info = providerFor(c, a, hp).create(new Provider.CreateSpec(PROJECT_NAME, nodeId, "data", hr, hs, serverUserData(c, a)));
            a.put("deployed", Json.obj("env", sha(envList(instelbaarEnv(c, a))), "shape", sha(shapeOf(a)), "keys", envKeys(c, a)));
            Map<String, Object> old = Json.map(a, "server");
            Map<String, Object> srv = Json.obj("provider", hp, "region", hr, "size", hs, "serverId", info.serverId);
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
                    retired.add(Json.obj("provider", old.get("provider"), "serverId", old.get("serverId")));
                    a.put("retired", retired);
                }
            }
            deps.save();
            steps.add(step("Server bij " + Json.jsString(offer.get("name")) + " in " + (where != null ? Json.str(where, "city") : hr) + " (" + hs + ")", true, info.ipv4 != null ? "IP-adres " + info.ipv4 : null));
            if (old != null && nonEmpty(Json.str(old, "serverId"))) steps.add(step("De vorige server wordt opgeruimd", true, null));
            Object[] sync = Json.map(a, "dns") != null ? syncOwnDns(a, deps) : null;
            if (sync != null) deps.save();
            Map<String, Object> d = dnsInfo(c);
            steps.add(dnsStep(d, info.ipv4, sync, Json.str(d, "host") + " wijst naar " + info.ipv4, false, deps));
            if (Json.map(a, "adressen") != null) {
                Map<String, Object> ad = adressenDns(c);
                steps.add(dnsStep(ad, info.ipv4, sync, "Adressendienst op " + Json.str(ad, "host"), true, deps));
            }
            if (!Json.listAt(a, "retired").isEmpty()) cleanupRetiredAsync(c, deps);
            return Json.obj("ok", true, "replaced", replace, "steps", steps, "server", view(c, deps).get("server"));
        } catch (IOException | RuntimeException e) {
            try { deps.save(); } catch (IOException ignored) { /* bewaren lukt de volgende keer */ }
            throw new SetupException(e.getMessage(), steps, e);
        }
    }

    /** The DNS step after setting up: who sets the record, or what you have to do yourself. */
    private static Map<String, Object> dnsStep(Map<String, Object> d, String ip, Object[] sync, String label, boolean also, Offers deps) {
        String name = dnsName(Json.str(d, "provider"), deps);
        if ("eigen".equals(d.get("mode")) && Json.truthy(d.get("managed"))) {
            return sync != null && !(Boolean) sync[0] ? step(Json.str(d, "host") + " in de DNS zetten bij " + name, false, (String) sync[2])
                    : step(label, true, "De console zet dit record bij " + name);
        }
        if (Json.truthy(d.get("managed"))) return step(label, true, also ? "Je cloud zet ook dit record zelf in je DNS" : "Je cloud zet dit record zelf in je DNS");
        return step("Zet bij je DNS een A-record: " + Json.str(d, "host") + " → " + ip, true, null);
    }

    /** "deSEC" instead of "deSEC (gratis, open source, Berlijn)": the name from the DNS offers. */
    private static String dnsName(String id, Offers deps) {
        if (id == null) return "";
        for (Map<String, Object> o : deps.dnsOffers()) if (id.equals(o.get("id"))) return Json.str(o, "name").replaceFirst(" \\(.*\\)$", "");
        return id;
    }

    // ───────── Eigen DNS van de Dienst ─────────

    /** TTL for the Dienst's records (deSEC rounds up to its minimum of an hour). */
    public static final int DNS_TTL = 300;

    /** The records that should exist with the own DNS link (ownDnsWant in TS): A and AAAA per host under the zone. */
    public static List<Object> ownDnsWant(Map<String, Object> a) {
        List<Object> out = new ArrayList<>();
        Map<String, Object> d = Json.map(a, "dns");
        if (d == null) return out;
        String z = Json.str(d, "zone");
        boolean live = a.get("server") != null && !Json.truthy(a.get("removed"));
        String v4 = live ? nz(Json.str(a, "server", "ipv4")) : "", v6 = live ? nz(Json.str(a, "server", "ipv6")) : "";
        List<String> seen = new ArrayList<>();
        for (String h : new String[] {hostOf(Json.str(a, "url")), Json.str(a, "adressen", "host")}) {
            if (h == null) continue;
            String sub = h.equals(z) ? "" : h.endsWith("." + z) ? h.substring(0, h.length() - z.length() - 1) : null;
            if (sub == null || seen.contains(sub)) continue;
            seen.add(sub);
            out.add(Json.obj("sub", sub, "type", "A", "value", v4));
            out.add(Json.obj("sub", sub, "type", "AAAA", "value", v6));
        }
        return out;
    }

    private static String recKey(Object x) { return Json.str(x, "sub") + "/" + Json.str(x, "type"); }

    /**
     * Brings the records at the own DNS link up to date (syncOwnDns in TS): only what differs from what the console set
     * before ({@code dns.set}); records no longer needed are removed. {ok, changed, detail}.
     */
    public static Object[] syncOwnDns(Map<String, Object> a, Offers deps) {
        Map<String, Object> d = Json.map(a, "dns");
        if (d == null) return new Object[] {true, 0, null};
        List<Object> want = ownDnsWant(a);
        Map<String, Object> done = new java.util.LinkedHashMap<>();
        for (Object x : Json.listAt(d, "set")) done.put(recKey(x), x);
        List<Object> todo = new ArrayList<>();
        for (Object w : want) {
            Object p = done.get(recKey(w));
            String pv = p == null ? "" : nz(Json.str(p, "value"));
            if (!pv.equals(Json.str(w, "value"))) todo.add(w);
        }
        for (Object p : Json.listAt(d, "set")) {
            boolean still = false;
            for (Object w : want) if (recKey(w).equals(recKey(p))) still = true;
            if (!still) { Map<String, Object> x = Json.copy(Json.asMap(p)); x.put("value", ""); todo.add(x); }
        }
        if (todo.isEmpty()) {
            d.remove("error");
            return new Object[] {true, 0, null};
        }
        int changed = 0;
        try {
            Adapters.Adapter ad = Adapters.get(Json.str(d, "provider"));
            if (ad == null || ad.dns == null) throw new IOException("Onbekende DNS-aanbieder " + Json.str(d, "provider"));
            Map<String, Object> fields = Json.map(d, "fields") != null ? Json.copy(Json.map(d, "fields")) : Json.obj();
            DnsProvider dns = ad.dns.create.make("dienst", fields, Json.str(d, "zone"));
            for (Object t : todo) {
                String v = Json.str(t, "value");
                List<String> values = new ArrayList<>();
                if (nonEmpty(v)) values.add(v);
                dns.setRecords(Json.str(t, "sub"), Json.str(t, "type"), values, DNS_TTL);
                changed++;
                if (nonEmpty(v)) done.put(recKey(t), t); else done.remove(recKey(t));
            }
            d.remove("error");
            d.put("at", System.currentTimeMillis());
            return new Object[] {true, changed, null};
        } catch (IOException | RuntimeException e) {
            String m = String.valueOf(e.getMessage()).replaceAll("https?://\\S+", "");
            d.put("error", dnsName(Json.str(d, "provider"), deps) + ": " + Bytes.head(m, 160));
            return new Object[] {false, changed, d.get("error")};
        } finally {
            d.put("set", new ArrayList<>(done.values()));
        }
    }

    /**
     * Who puts the Dienst's address in DNS (saveDns in TS): "cloud", "handmatig", or the id of a DNS provider with the
     * zone and credentials (also from the cloud's providers, the server keys, and deSEC/Scaleway keys at Accounts).
     * Checked live with the adapter's connect; with a running Dienst the records are set right away.
     */
    public static Map<String, Object> saveDns(Map<String, Object> c, Map<String, Object> b, Offers deps) throws IOException {
        Map<String, Object> a = state(c);
        String host = hostOf(Json.str(a, "url"));
        if (host == null) throw new IllegalArgumentException("Kies eerst het adres van je Dienst");
        String p = b.get("provider") == null ? "" : Json.jsString(b.get("provider"));
        final Map<String, Object> old = Json.map(a, "dns");
        if ("cloud".equals(p) || "handmatig".equals(p)) {
            if ("cloud".equals(p) && !(cloudSub(c, host) != null && cloudDns(c))) throw new IllegalArgumentException("Je cloud kan " + host + " niet in de DNS zetten; kies een DNS-aanbieder of zet het record zelf");
            boolean cleared = clearOld(a, old, deps);
            a.remove("dns");
            if ("handmatig".equals(p)) a.put("dnsHandmatig", true); else a.remove("dnsHandmatig");
            return Json.obj("ok", true, "dns", dnsInfo(c), "nameservers", null, "synced", null, "detail", cleared ? null : "De oude records konden niet weg; haal ze zelf weg bij je DNS-aanbieder");
        }
        Map<String, Object> offer = find(deps.dnsOffers(), p);
        Adapters.Adapter ad = Adapters.get(p);
        if (offer == null || ad == null || ad.dns == null) throw new IllegalArgumentException("Kies een DNS-aanbieder");
        String zone = (b.get("zone") == null ? "" : Json.jsString(b.get("zone"))).trim().toLowerCase(Locale.ROOT).replaceAll("^\\.+|\\.+$", "");
        if (zone.isEmpty()) zone = old != null && p.equals(Json.str(old, "provider")) ? Json.str(old, "zone") : nz(defaultZone(host));
        if (!ZONE.matcher(zone).matches()) throw new IllegalArgumentException("Vul het domein in waar het adres onder valt, zoals vanes.nl");
        if (!host.equals(zone) && !host.endsWith("." + zone)) throw new IllegalArgumentException(host + " valt niet onder " + zone);
        Map<String, Object> fields = Json.obj();
        for (Object f : Json.listAt(offer, "fields")) {
            String k = Json.str(f, "key");
            String v = Json.str(c, "providers", p, k);
            if (!nonEmpty(v)) v = Json.str(a, "keys", p, k);
            if (!nonEmpty(v) && "desec".equals(p) && "token".equals(k)) v = Json.str(a, "accounts", "desecToken");
            if (!nonEmpty(v) && "scaleway".equals(p) && "secretKey".equals(k)) v = Json.str(a, "accounts", "scalewaySecretKey");
            if (nonEmpty(v)) fields.put(k, v);
        }
        if (old != null && p.equals(Json.str(old, "provider")) && Json.map(old, "fields") != null) fields.putAll(Json.map(old, "fields"));
        Map<String, Object> in = Json.map(b, "fields");
        if (in != null) for (Map.Entry<String, Object> e : in.entrySet()) {
            if (!(e.getValue() instanceof String)) continue;
            String v = (String) e.getValue();
            boolean known = false;
            for (Object f : Json.listAt(offer, "fields")) if (e.getKey().equals(Json.str(f, "key"))) known = true;
            if (v.trim().isEmpty() || v.startsWith("••") || !known) continue;
            if (v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0) throw new IllegalArgumentException("Een sleutel past op één regel");
            fields.put(e.getKey(), v.trim());
        }
        List<String> missing = new ArrayList<>();
        for (Object f : Json.listAt(offer, "fields")) if (!Json.truthy(Json.path(f, "optional")) && !nonEmpty(Json.str(fields, Json.str(f, "key")))) missing.add(Json.str(f, "label"));
        if (!missing.isEmpty()) throw new IllegalArgumentException("Vul in: " + String.join(", ", missing));
        List<String> ns;
        try {
            ns = ad.dns.connect.connect(fields, zone);
        } catch (IOException | RuntimeException e) {
            throw new IOException(Json.str(offer, "name").replaceFirst(" \\(.*\\)$", "") + ": " + e.getMessage(), e);
        }
        boolean same = old != null && p.equals(Json.str(old, "provider")) && zone.equals(Json.str(old, "zone"));
        boolean cleared = same || clearOld(a, old, deps);
        a.put("dns", Json.obj("provider", p, "zone", zone, "fields", fields, "set", same && old.get("set") != null ? old.get("set") : Json.list(), "nameservers", new ArrayList<Object>(ns)));
        a.remove("dnsHandmatig");
        Object[] sync = a.get("server") != null ? syncOwnDns(a, deps) : null;
        return Json.obj("ok", true, "dns", dnsInfo(c), "nameservers", new ArrayList<Object>(ns), "synced", sync == null ? null : sync[0],
                "detail", sync != null && !(Boolean) sync[0] ? sync[2] : cleared ? null : "De oude records konden niet weg; haal ze zelf weg bij je vorige DNS-aanbieder");
    }

    /** Removes the records of a previous link (true when that worked or there were none). */
    private static boolean clearOld(Map<String, Object> a, Map<String, Object> old, Offers deps) {
        if (old == null || Json.listAt(old, "set").isEmpty()) return true;
        Map<String, Object> tmp = Json.copy(a);
        tmp.put("dns", Json.copy(old));
        tmp.put("server", null);
        tmp.put("removed", true);
        return (Boolean) syncOwnDns(tmp, deps)[0];
    }

    // ───────── Hersteltest ─────────

    private static S3Store backupStoreOf(Map<String, Object> bk) {
        return new S3Store(Json.obj("name", "dienst-backup", "type", "s3", "purpose", "backup", "endpoint", bk.get("endpoint"), "region", bk.get("region"),
                "bucket", bk.get("bucket"), "accessKey", bk.get("accessKey"), "secretKey", bk.get("secretKey")));
    }

    private static final Pattern BACKUP_KEY = Pattern.compile("^dienst/(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z");

    /** backupTime in src/broker/backup.ts: "dienst/20261011T120000Z-ab12.enc" → ms, or -1. */
    static long backupTime(String key) {
        java.util.regex.Matcher m = BACKUP_KEY.matcher(key);
        if (!m.find()) return -1;
        java.util.Calendar cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"));
        cal.clear();
        cal.set(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)) - 1, Integer.parseInt(m.group(3)), Integer.parseInt(m.group(4)), Integer.parseInt(m.group(5)), Integer.parseInt(m.group(6)));
        return cal.getTimeInMillis();
    }

    /**
     * Hersteltest (hersteltest in TS): the newest backup, decrypted with the Dienst's key (from BROKER_SECRET), checked for
     * a readable database. Read only.
     */
    public static Map<String, Object> hersteltest(Map<String, Object> c, Deps deps) throws IOException {
        Map<String, Object> a = existing(c);
        Map<String, Object> bk = Json.map(a, "backup");
        if (a == null || !nonEmpty(Json.str(a, "secret")) || bk == null || !nonEmpty(Json.str(bk, "bucket")) || !nonEmpty(Json.str(bk, "accessKey")) || !nonEmpty(Json.str(bk, "secretKey")))
            throw new IllegalArgumentException("Er zijn nog geen back-ups van je Dienst");
        S3Store store = backupStoreOf(bk);
        String lastKey = null;
        long lastAt = -1;
        byte[] buf = null;
        boolean reached = true;
        try {
            for (ObjectStore.Entry e : store.list("dienst/")) {
                long t = backupTime(e.key);
                if (t < 0) continue;
                if (lastKey == null || t > lastAt || (t == lastAt && e.key.compareTo(lastKey) > 0)) { lastKey = e.key; lastAt = t; }
            }
            if (lastKey != null) buf = store.getBuffer(lastKey);
        } catch (IOException | RuntimeException e) {
            reached = false;
        }
        Map<String, Object> res;
        if (!reached) res = Json.obj("ok", false, "backupAt", lastKey == null ? null : (Object) lastAt, "detail", "De back-upopslag is niet bereikbaar");
        else if (lastKey == null) res = Json.obj("ok", false, "backupAt", null, "detail", "Er staat nog geen back-up in de opslag");
        else if (buf == null) res = Json.obj("ok", false, "backupAt", lastAt, "detail", "De back-upopslag is niet bereikbaar");
        else {
            try {
                byte[] plain = EigenCrypto.decryptBuffer(EigenCrypto.deriveKey(Bytes.fromHex(Json.str(a, "secret")), "dienst-backup"), buf);
                byte[] json;
                try (java.util.zip.GZIPInputStream in = new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(plain))) { json = Bytes.readAll(in); }
                Map<String, Object> pack = Json.parseObject(Bytes.utf8(json));
                Map<String, Object> files = Json.map(pack, "files");
                java.util.TreeSet<String> names = new java.util.TreeSet<>(files == null ? new ArrayList<String>() : files.keySet());
                String b64 = files == null ? null : Json.str(files, "dienst.sqlite");
                byte[] db = b64 == null ? new byte[0] : java.util.Base64.getDecoder().decode(b64);
                byte[] head = Bytes.utf8("SQLite format 3\0");
                boolean ok = db.length >= 16 && java.util.Arrays.equals(java.util.Arrays.copyOf(db, 16), head);
                Number at = Json.num(pack, "at");
                res = Json.obj("ok", ok, "backupAt", at != null ? (Object) at.longValue() : lastAt,
                        "detail", ok ? "Terug te zetten: " + String.join(", ", names) + " (database " + ((db.length + 1023) / 1024) + " KB)" : "De database in de back-up is beschadigd");
            } catch (IOException | RuntimeException e) {
                res = Json.obj("ok", false, "backupAt", lastAt, "detail", "De back-up is niet te openen met de sleutel van je Dienst");
            }
        }
        Map<String, Object> ht = Json.obj("at", System.currentTimeMillis());
        ht.putAll(res);
        a.put("hersteltest", ht);
        deps.save();
        return Json.copy(ht);
    }

    // ───────── Herstelkopie zonder eigen cloud ─────────

    private static volatile String lastCopy = "";

    /**
     * Without an own cloud there is no storage for the vault's recovery copy: it goes (sealed with the master key, as for a
     * cloud) into the Dienst's backup bucket as admin-config.enc, only when something changed (saveDienstCopy in TS).
     */
    public static boolean saveDienstCopy(Map<String, Object> c) throws IOException {
        if (!Json.truthy(Json.path(c, "console", "alleenDienst")) || !Json.truthy(c.get("masterKey"))) return false;
        Map<String, Object> a = existing(c);
        Map<String, Object> bk = Json.map(a, "backup");
        if (bk == null || !nonEmpty(Json.str(bk, "bucket")) || !nonEmpty(Json.str(bk, "accessKey")) || !nonEmpty(Json.str(bk, "secretKey"))) return false;
        Map<String, Object> stable = Json.copy(c);
        Map<String, Object> sa = Json.map(stable, "console", "aanbieder");
        if (sa != null) sa.remove("lastHealth");
        String h = sha(stable);
        if (h.equals(lastCopy)) return false;
        backupStoreOf(bk).put("admin-config.enc", EigenCrypto.sealJson(ClusterConfig.keysFor(c).manifest, c, "admin-config"));
        lastCopy = h;
        return true;
    }

    private static final AtomicBoolean CLEANING = new AtomicBoolean();

    /** Vervangen of verwijderde servers weghalen bij hun aanbieder, op de achtergrond; mislukt het, dan de volgende keer. */
    public static void cleanupRetiredAsync(Map<String, Object> c, Deps deps) {
        Map<String, Object> a = existing(c);
        if (a == null || Json.listAt(a, "retired").isEmpty() || !CLEANING.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            try { cleanupRetired(c, deps); } finally { CLEANING.set(false); }
        }, "eigen-dienst-opruimen");
        t.setDaemon(true);
        t.start();
    }

    private static String retiredKey(Object x) { return Json.str(x, "provider") + "/" + Json.str(x, "serverId"); }

    /** Hetzelfde, maar wachtend (tests). */
    public static void cleanupRetired(Map<String, Object> c, Deps deps) {
        Map<String, Object> a = existing(c);
        if (a == null) return;
        // Ook servers die tijdens het opruimen bij de lijst komen (bijv. verwijderen vlak na opnieuw opzetten).
        java.util.Set<String> tried = new java.util.HashSet<>();
        for (Object x = first(Json.listAt(a, "retired"), tried); x != null; x = first(Json.listAt(a, "retired"), tried)) {
            final String k = retiredKey(x);
            tried.add(k);
            try {
                providerFor(c, a, Json.str(x, "provider")).destroy(Json.str(x, "serverId"));
                synchronized (a) {
                    List<Object> left = new ArrayList<>();
                    for (Object y : Json.listAt(a, "retired")) if (!retiredKey(y).equals(k)) left.add(y);
                    if (left.isEmpty()) a.remove("retired"); else a.put("retired", left);
                }
                deps.save();
            } catch (IOException | RuntimeException ignored) {
                // volgende keer
            }
        }
    }

    private static Object first(List<Object> l, java.util.Set<String> skip) {
        for (Object x : l) if (!skip.contains(retiredKey(x))) return x;
        return null;
    }

    // ───────── 6. Klaar: status, verwijderen ─────────

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
        // De user-data bevat de geheimen van de Dienst: weghalen bij de aanbieder zodra de server draait (als die dat kan).
        if (Boolean.TRUE.equals(h.get("reachable")) && !Json.truthy(server.get("userDataCleared"))) {
            try {
                Provider p = providerFor(c, a, Json.str(server, "provider"));
                if (p instanceof ScalewayProvider) {
                    ((ScalewayProvider) p).clearUserData(Json.str(server, "serverId"));
                    server.put("userDataCleared", true);
                }
            } catch (IOException | RuntimeException ignored) {
                // volgende keer
            }
        }
        // Eigen DNS-koppeling: records bijwerken als ze anders zijn dan wat er moet staan.
        if (Json.map(a, "dns") != null) syncOwnDns(a, deps);
        String host = hostOf(url);
        List<String> have = new ArrayList<>(resolver.resolve4(host));
        java.util.Collections.sort(have);
        Object overzicht = Boolean.TRUE.equals(h.get("reachable")) && nonEmpty(Json.str(a, "secret")) ? dienstOverzicht(a) : null;
        deps.save();
        cleanupRetiredAsync(c, deps);
        Object want = server.get("ipv4");
        Map<String, Object> out = Json.copy(h);
        out.put("server", true);
        out.put("removed", false);
        out.put("dns", Json.obj("host", host, "want", want, "have", new ArrayList<Object>(have), "ok", want != null && have.contains(Json.jsString(want)),
                "mode", dnsInfo(c).get("mode"), "error", Json.path(a, "dns", "error")));
        out.put("retired", (long) Json.listAt(a, "retired").size());
        out.put("adressen", adressenStatus(a));
        out.put("overzicht", overzicht);
        return out;
    }

    /** Key figures of the Dienst via GET /v1/status/overzicht (dienstOverzicht in TS); null when that fails. */
    private static Object dienstOverzicht(Map<String, Object> a) {
        try {
            Res r = http("GET", reach.base(Json.str(a, "url")) + "/v1/status/overzicht", Http.headers("authorization", "Beheer " + beheerToken(Json.str(a, "secret"))), null, 8000);
            return r.ok() && r.json instanceof Map ? r.json : null;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * Gewijzigde instellingen naar de draaiende Dienst sturen zonder nieuwe server; de Dienst bewaart ze versleuteld en
     * start opnieuw (toepassen in aanbieder.ts).
     */
    public static Map<String, Object> toepassen(Map<String, Object> c, Deps deps) throws IOException {
        Map<String, Object> a = existing(c);
        if (a == null || a.get("server") == null || !nonEmpty(Json.str(a, "url")) || !nonEmpty(Json.str(a, "secret"))) throw new IllegalArgumentException("Er draait geen Dienst");
        if (!companyReady(a) || !accountsReady(a)) throw new IllegalArgumentException("Controleer eerst je bedrijfsgegevens en accounts");
        Map<String, Object> dep = Json.map(a, "deployed");
        if (dep != null && !sha(shapeOf(a)).equals(Json.str(dep, "shape"))) throw new IllegalArgumentException("Hiervoor is een nieuwe server nodig: kies Opnieuw opzetten");
        List<String[]> env = instelbaarEnv(c, a);
        Map<String, Object> envObj = Json.obj();
        for (String[] kv : env) envObj.put(kv[0], kv[1]);
        Number envAt = Json.num(a, "envAt");
        long at = Math.max(System.currentTimeMillis(), (envAt == null ? 0L : envAt.longValue()) + 1);
        Res r;
        try {
            r = http("POST", reach.base(Json.str(a, "url")) + "/v1/status/instellingen", Http.headers("authorization", "Beheer " + beheerToken(Json.str(a, "secret")), "content-type", "application/json"),
                    Json.obj("at", at, "env", envObj), 60_000);
        } catch (IOException | RuntimeException e) {
            throw new IOException("Je Dienst is nu niet bereikbaar; probeer het later opnieuw", e);
        }
        if (r.status == 404) throw new IOException("Je Dienst kent dit nog niet; wacht tot hij is bijgewerkt, of kies Opnieuw opzetten");
        if (!r.ok()) throw new IOException(Json.truthy(Json.path(r.json, "error")) ? "De Dienst weigert: " + Json.str(r.json, "error") : "De Dienst antwoordt " + r.status);
        a.put("deployed", Json.obj("env", sha(envList(env)), "shape", dep != null ? dep.get("shape") : sha(shapeOf(a)), "keys", envKeys(c, a)));
        deps.save();
        List<Object> keys = Json.listAt(r.json, "keys");
        return Json.obj("ok", true, "restart", Json.truthy(Json.path(r.json, "restart")), "keys", keys);
    }

    /** Bereikbaarheid van de adressendienst op de server van de Dienst (null als hij er niet draait). */
    private static Map<String, Object> adressenStatus(Map<String, Object> a) {
        Map<String, Object> x = Json.map(a, "adressen");
        if (x == null) return null;
        String url = "https://" + Json.str(x, "host");
        try {
            Res r = http("GET", reach.base(url) + "/v1/info", null, null, 8000);
            if (!r.ok() || !Json.truthy(Json.path(r.json, "zone"))) throw new IOException("De adressendienst antwoordt " + r.status);
            String zone = Json.str(r.json, "zone");
            return Json.obj("url", url, "reachable", true, "zone", zone, "ok", zone.equals(Json.str(x, "zone")));
        } catch (IOException | RuntimeException e) {
            String m = e.getMessage() == null ? "" : e.getMessage();
            return Json.obj("url", url, "reachable", false, "zone", null, "ok", false, "error", m.contains("antwoordt") ? m : "Nog niet bereikbaar");
        }
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
            retired.add(Json.obj("provider", Json.path(a, "server", "provider"), "serverId", Json.path(a, "server", "serverId")));
            a.put("retired", retired);
            a.put("server", null);
            a.put("removed", true);
            a.put("lastHealth", null);
            a.put("step", "klaar");
        }
        deps.save();
        // Eigen DNS-koppeling: de records weghalen.
        Object[] dns = Json.map(a, "dns") != null ? syncOwnDns(a, deps) : null;
        if (dns != null) deps.save();
        cleanupRetiredAsync(c, deps);
        return Json.obj("ok", true, "finalBackup", h[0], "detail", h[1], "bucket", Json.path(a, "backup", "bucket"), "pending", (long) Json.listAt(a, "retired").size(),
                "dns", dns == null ? null : dns[0]);
    }
}
