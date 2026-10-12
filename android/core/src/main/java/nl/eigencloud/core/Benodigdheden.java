package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.regex.Pattern;

/**
 * "Wat je nodig hebt" om zelf aanbieder te worden, en het regelen ervan vanuit de app (port of
 * src/console/benodigdheden.ts; the console routes /api/aanbieder/benodigdheden, /scaleway, /mollie, /desec/…, /domein…,
 * /mail and /openprovider return the same JSON). Everything an API can do, the app does; what needs the person at the
 * company (opening an account, payment details, an ID check) is a guided step after which the app checks by itself.
 * Blocking; call off the UI thread. Sources of every API are listed in the TypeScript file.
 */
public final class Benodigdheden {
    private Benodigdheden() {}

    public static final List<String> DESEC_NS = Arrays.asList("ns1.desec.io", "ns2.desec.org");
    public static final String SCW_APP = "eigen-cloud-dienst";
    public static final String OP_PANEL_URL = "https://cp.openprovider.eu";
    /** Wait between attempts with a new Scaleway key (tests: 0). */
    public static volatile long retryDelayMs = 3000;
    /** How long the list waits for one check (nodigNet.waitMs); a later answer is kept for the next time. */
    public static volatile long waitMs = 6000;

    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern ZONE = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", Pattern.CASE_INSENSITIVE);

    /** A failure with the steps done so far ({error, steps}). */
    public static final class StepsException extends IOException {
        private static final long serialVersionUID = 1L;
        public final transient List<Object> steps;

        StepsException(String message, List<Object> steps, Throwable cause) {
            super(message, cause);
            this.steps = steps;
        }
    }

    private static StepsException fail(Throwable e, List<Object> steps) { return new StepsException(e.getMessage(), steps, e); }

    private static Map<String, Object> step(String label, boolean ok, String detail) {
        Map<String, Object> s = Json.obj("label", label, "ok", ok);
        if (detail != null) s.put("detail", detail);
        return s;
    }

    private static boolean nonEmpty(String v) { return v != null && !v.isEmpty(); }

    private static String nz(String v) { return v == null ? "" : v; }

    private static Map<String, Object> sub(Map<String, Object> m, String key) {
        Map<String, Object> x = Json.map(m, key);
        if (x == null) { x = Json.obj(); m.put(key, x); }
        return x;
    }

    private static String mask(String v) { return v == null || v.isEmpty() ? "" : "••••••••" + v.substring(Math.max(0, v.length() - 4)); }

    private static String hostOf(String url) {
        if (url == null) return null;
        try { return new java.net.URI(url).getHost(); } catch (java.net.URISyntaxException e) { return null; }
    }

    private static Map<String, Object> readOnly(Map<String, Object> c) {
        Map<String, Object> a = Aanbieder.existing(c);
        return a != null ? a : Json.obj("step", "bedrijf");
    }

    private static boolean isTrue(Object v) { return Boolean.TRUE.equals(v); }

    // ───────── Netwerk ─────────

    /** {status, json} with a short timeout; status 0 when unreachable (getJson in TS). */
    static Object[] getJson(String url, Map<String, String> headers, int ms) {
        try {
            Http.Response r = Http.request("GET", url, headers, null, ms);
            Object j = null;
            try { j = r.text().isEmpty() ? null : Json.parse(r.text()); } catch (RuntimeException ignored) { j = null; }
            return new Object[] {r.status, j};
        } catch (IOException | RuntimeException e) {
            return new Object[] {0, null};
        }
    }

    private static final Map<String, Object[]> CACHE = new ConcurrentHashMap<>(); // key → {at (Long), value}

    /** Tests: check everything again. */
    public static void resetCache() { CACHE.clear(); }

    private interface Check<T> { T run(); }

    private interface Good<T> { boolean ok(T v); }

    /** A check at most once a minute (a failed one: again after 20 seconds), unless {@code fresh}. */
    @SuppressWarnings("unchecked")
    private static <T> T cached(String key, boolean fresh, Check<T> fn, Good<T> good) {
        Object[] hit = CACHE.get(key);
        if (!fresh && hit != null && System.currentTimeMillis() - (Long) hit[0] < (good.ok((T) hit[1]) ? 60_000L : 20_000L)) return (T) hit[1];
        T v = fn.run();
        CACHE.put(key, new Object[] {System.currentTimeMillis(), v});
        return v;
    }

    private static String reach(String url) { return Aanbieder.reach.base(url); }

    private static Map<String, String> beheer(Map<String, Object> a) {
        return nonEmpty(Json.str(a, "secret")) ? Http.headers("authorization", "Beheer " + Aanbieder.beheerToken(Json.str(a, "secret"))) : null;
    }

    // ───────── De lijst ─────────

    private static Map<String, Object> item(String id, String label, String status, String uitleg, String kosten, String detail, boolean optioneel, String soort, String doel) {
        return Json.obj("id", id, "label", label, "status", status, "uitleg", uitleg, "kosten", kosten, "detail", detail, "optioneel", optioneel,
                "actie", Json.obj("label", "hub".equals(soort) ? "Bekijken" : "ok".equals(status) ? "Wijzigen" : "Regelen", "soort", soort, "doel", doel));
    }

    /** € 7,99 (toFixed(2) with a comma). */
    private static String euro(double n) { return "€ " + ConsoleApi.euro(n); }

    public static Map<String, Object> links() {
        return Json.obj("scaleway", Json.obj("aanmelden", Extras.SCW_SIGNUP_URL, "sleutels", Extras.SCW_KEYS_URL),
                "mollie", mollieLinks(null), "openprovider", OP_PANEL_URL, "desec", "https://desec.io");
    }

    private static Map<String, Object> mollieLinks(String dashboard) {
        return Json.obj("dashboard", dashboard != null ? dashboard : "https://my.mollie.com/dashboard", "sleutels", "https://my.mollie.com/dashboard/developers/api-keys",
                "aanmelden", "https://my.mollie.com/dashboard/signup");
    }

    private static <T> Future<T> submit(ExecutorService ex, Callable<T> c) { return ex.submit(c); }

    private static <T> T get(Future<T> f) {
        try { return f == null ? null : f.get(); } catch (Exception e) { return null; }
    }

    /** At most {@code waitMs}; then null (the check goes on and fills the cache, like within() in TS). */
    private static <T> T within(Future<T> f) {
        try { return f == null ? null : f.get(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (Exception e) { return null; }
    }

    /**
     * The list with everything a provider needs, with the current status (benodigdheden in TS). Voorwaarden and Op de lijst
     * use the same checks as GET /api/aanbieder/juridisch (DienstVoorwaarden) and GET /api/aanbieder/lijst (GitHub).
     */
    public static Map<String, Object> benodigdheden(final Map<String, Object> c, final boolean fresh, final Aanbieder.Deps deps) {
        final Map<String, Object> a = readOnly(c);
        Map<String, Object> acc = Json.map(a, "accounts") != null ? Json.map(a, "accounts") : Json.obj();
        Map<String, Object> ch = Json.map(a, "checked") != null ? Json.map(a, "checked") : Json.obj();
        final String host = hostOf(Json.str(a, "url"));
        final String zone = Json.str(a, "dns", "zone") != null ? Json.str(a, "dns", "zone") : Aanbieder.defaultZone(host);
        final String url = Json.str(a, "url");
        final boolean live = a.get("server") != null && !Json.truthy(a.get("removed")) && nonEmpty(url);
        final boolean secret = nonEmpty(Json.str(a, "secret"));
        final String ipv4 = Json.str(a, "server", "ipv4");
        final String adrZone = Json.str(a, "adressen", "zone");
        ExecutorService ex = Executors.newFixedThreadPool(5, r -> { Thread t = new Thread(r, "benodigdheden"); t.setDaemon(true); return t; });
        Future<Doh.Answer> fNs, fA, fAdr;
        Future<Map<String, Object>> fJur, fLijst;
        try {
            fNs = zone != null ? submit(ex, () -> cached("ns:" + zone, fresh, () -> Doh.lookup(zone, "NS"), v -> v != null)) : null;
            fA = host != null && Json.truthy(a.get("dnsHandmatig")) && ipv4 != null ? submit(ex, () -> cached("a:" + host, fresh, () -> Doh.lookup(host, "A"), v -> v != null)) : null;
            fAdr = adrZone != null ? submit(ex, () -> cached("ns:" + adrZone, fresh, () -> Doh.lookup(adrZone, "NS"), v -> v != null)) : null;
            fJur = live ? submit(ex, () -> cached("juridisch:" + url, fresh, () -> {
                try { return DienstVoorwaarden.status(c); } catch (RuntimeException e) { return null; }
            }, v -> v != null && isTrue(v.get("bereikbaar")))) : null;
            fLijst = live && secret ? submit(ex, () -> cached("lijst:" + url, fresh, () -> {
                try { return GitHub.view(c, deps::save); } catch (IOException | RuntimeException e) { return null; }
            }, v -> v != null && v.get("dienstFout") == null && v.get("lijstFout") == null)) : null;
        } finally {
            ex.shutdown();
        }
        Doh.Answer ns = get(fNs), aRec = get(fA), adrNs = get(fAdr);
        Map<String, Object> jur = within(fJur), lijst = within(fLijst);
        List<Object> items = new ArrayList<>();

        // Domein
        {
            String uitleg = "Het adres van je Dienst, bijvoorbeeld dienst.jouwbedrijf.nl. Je klanten en de app vinden je daar.";
            String k = "ongeveer € 10 per jaar";
            if (host == null || zone == null) items.add(item("domein", "Domein", "open", uitleg, k, "Nog geen adres gekozen", false, "paneel", "domein"));
            else if (ns != null && ns.rcode == 3) items.add(item("domein", "Domein", "bijna", uitleg, k, zone + " lijkt nog niet geregistreerd", false, "paneel", "domein"));
            else if (ns != null && !ns.values.isEmpty()) items.add(item("domein", "Domein", "ok", uitleg, k, host + ", " + zone + " is geregistreerd", false, "paneel", "domein"));
            else items.add(item("domein", "Domein", "bijna", uitleg, k, host + "; kon niet nagaan of " + zone + " bestaat", false, "paneel", "domein"));
        }
        // DNS
        {
            String uitleg = "Zorgt dat het adres naar je server wijst. Met een DNS-aanbieder zet de app de records zelf.";
            String k = "gratis bij deSEC";
            Map<String, Object> d = Json.map(a, "dns");
            String keuze = d != null ? Json.str(d, "provider") : Json.truthy(a.get("dnsHandmatig")) ? "handmatig" : "cloud".equals(Aanbieder.dnsInfo(c).get("mode")) ? "cloud" : null;
            String label = "DNS voor dat domein";
            if (host == null || keuze == null) items.add(item("dns", label, "open", uitleg, k, "Nog niet gekozen wie de DNS doet", false, "paneel", "dns"));
            else if ("cloud".equals(keuze)) items.add(item("dns", label, "ok", uitleg, k, "Je eigen cloud zet het record", false, "paneel", "dns"));
            else if ("handmatig".equals(keuze)) {
                boolean okA = aRec != null && ipv4 != null && aRec.values.contains(ipv4);
                items.add(item("dns", label, okA ? "ok" : "bijna", uitleg, k, okA ? host + " wijst naar je server" : "Je zet het record zelf", false, "paneel", "dns"));
            } else {
                String naam = Aanbieder.dnsName(Json.str(d, "provider"), deps);
                List<String> want = new ArrayList<>();
                for (Object x : Json.listAt(d, "nameservers")) want.add(Json.jsString(x));
                String dz = Json.str(d, "zone");
                if (nonEmpty(Json.str(d, "error"))) items.add(item("dns", label, "bijna", uitleg, k, Json.str(d, "error"), false, "paneel", "dns"));
                else if (want.isEmpty() || (ns != null && Doh.nsMatch(ns.values, want))) items.add(item("dns", label, "ok", uitleg, k, dz + " staat bij " + naam, false, "paneel", "dns"));
                else {
                    String nu = ns != null ? Doh.nsProvider(ns.values) : null;
                    items.add(item("dns", label, "bijna", uitleg, k, nu != null ? dz + " staat nog bij " + nu + "; zet de nameservers op " + naam : "Zet de nameservers van " + dz + " op " + naam, false, "paneel", "dns"));
                }
            }
        }
        // Server en back-ups
        {
            String uitleg = "Een eigen server voor je Dienst, met elk uur een versleutelde back-up.";
            Number monthly = Json.num(a, "hosting", "monthly");
            String k = monthly != null ? euro(monthly.doubleValue()) + " per maand" : "vanaf ongeveer € 5 per maand";
            String label = "Server en back-ups";
            if (a.get("hosting") == null || a.get("backup") == null) items.add(item("server", label, "open", uitleg, k, "Nog niet gekozen waar", false, "stap", "server"));
            else if (a.get("server") == null) items.add(item("server", label, "bijna", uitleg, k, Json.truthy(a.get("removed")) ? "Je Dienst is verwijderd" : "Gekozen, nog niet opgezet", false, "stap", "server"));
            else if (Json.truthy(Json.path(a, "lastHealth", "reachable"))) items.add(item("server", label, "ok", uitleg, k, Json.truthy(Json.path(a, "lastHealth", "lastBackupAt")) ? "Draait, met back-ups" : "Draait", false, "stap", "server"));
            else items.add(item("server", label, "bijna", uitleg, k, "Opgezet, nog niet bereikbaar", false, "stap", "server"));
        }
        // Scaleway
        {
            String uitleg = "Hiermee zet je Dienst voor elke klant een eigen project op, met servers, opslag en mail.";
            String k = "wat je klanten gebruiken (zit in je prijs)";
            String label = "Scaleway voor klantclouds";
            if (!nonEmpty(Json.str(acc, "scalewaySecretKey"))) items.add(item("scaleway", label, "open", uitleg, k, "Nog geen sleutel", false, "paneel", "scaleway"));
            else if (!isTrue(ch.get("scaleway"))) items.add(item("scaleway", label, "bijna", uitleg, k, "De sleutel werkt nog niet", false, "paneel", "scaleway"));
            else items.add(item("scaleway", label, "ok", uitleg, k, nonEmpty(Json.str(a, "scw", "applicationId")) ? "Eigen sleutel voor je Dienst (eigen-cloud-dienst)" : "Sleutel werkt", false, "paneel", "scaleway"));
        }
        // Mollie
        {
            String uitleg = "Voor de betalingen van je klanten: eerst iDEAL, daarna elke maand een automatische incasso.";
            String k = "geen vaste kosten; per betaling een klein bedrag";
            String key = Json.str(acc, "mollieKey");
            List<Object> todo = Json.listAt(a, "mollie", "todo");
            if (!nonEmpty(key)) items.add(item("mollie", "Mollie", "open", uitleg, k, "Nog geen sleutel", false, "paneel", "mollie"));
            else if (!isTrue(ch.get("mollie"))) items.add(item("mollie", "Mollie", "bijna", uitleg, k, "Mollie accepteert de sleutel niet", false, "paneel", "mollie"));
            else if (Json.map(a, "mollie") != null && !todo.isEmpty()) items.add(item("mollie", "Mollie", "bijna", uitleg, k, Json.str(todo.get(0), "tekst"), false, "paneel", "mollie"));
            else if (key.startsWith("test_")) items.add(item("mollie", "Mollie", "bijna", uitleg, k, "Testsleutel: betalingen zijn nep", false, "paneel", "mollie"));
            else items.add(item("mollie", "Mollie", "ok", uitleg, k, "Live: echte betalingen", false, "paneel", "mollie"));
        }
        // Mail van je Dienst
        {
            String uitleg = "Voor inlogcodes, facturen en meldingen aan je klanten.";
            String k = "meestal gratis";
            String label = "Mail van je Dienst";
            String smtp = Aanbieder.smtpOf(c, a);
            boolean scw = "scaleway".equals(Json.str(a, "mail", "manier"));
            if (smtp.isEmpty()) items.add(item("mail", label, "open", uitleg, k, "Nog geen mailserver", false, "paneel", "mail"));
            else if (!isTrue(ch.get("smtp"))) items.add(item("mail", label, "bijna", uitleg, k, "Inloggen bij de mailserver lukt niet", false, "paneel", "mail"));
            else if (scw && !"checked".equals(Json.str(a, "mail", "status"))) items.add(item("mail", label, "bijna", uitleg, k, "Wacht tot Scaleway je maildomein heeft goedgekeurd", false, "paneel", "mail"));
            else items.add(item("mail", label, "ok", uitleg, k, scw ? "Via Scaleway, als " + nz(Json.str(acc, "mailFrom")) : "Mail versturen werkt", false, "paneel", "mail"));
        }
        // deSEC
        {
            String uitleg = "De DNS van de domeinen van je klanten. Gratis, open source, uit Berlijn.";
            String k = "gratis (een donatie is netjes)";
            String label = "deSEC voor klantdomeinen";
            boolean token = nonEmpty(Json.str(acc, "desecToken"));
            if (!token && a.get("desecAccount") == null) items.add(item("desec", label, "open", uitleg, k, "Nog geen account", false, "paneel", "desec"));
            else if (!token) items.add(item("desec", label, "bijna", uitleg, k, "Klik op de link in de mail aan " + Json.str(a, "desecAccount", "email"), false, "paneel", "desec"));
            else if (!isTrue(ch.get("desec"))) items.add(item("desec", label, "bijna", uitleg, k, "deSEC accepteert het token niet", false, "paneel", "desec"));
            else items.add(item("desec", label, "ok", uitleg, k, "Token werkt", false, "paneel", "desec"));
        }
        // Openprovider (optioneel)
        {
            String uitleg = "Alleen nodig als klanten via jou een domein kopen.";
            String k = "domeinen tegen inkoopprijs, van je tegoed";
            Map<String, Object> chk = Json.map(a, "openprovider", "check");
            if (!nonEmpty(Json.str(acc, "openproviderUser"))) items.add(item("openprovider", "Openprovider", "open", uitleg, k, "Niet gekoppeld (optioneel)", true, "paneel", "openprovider"));
            else if (!isTrue(ch.get("openprovider"))) items.add(item("openprovider", "Openprovider", "bijna", uitleg, k, "Inloggen lukt niet vanaf dit apparaat", true, "paneel", "openprovider"));
            else if (live && chk != null && !Json.truthy(chk.get("ok"))) items.add(item("openprovider", "Openprovider", "bijna", uitleg, k, Json.str(chk, "detail"), true, "paneel", "openprovider"));
            else if (live && chk == null) items.add(item("openprovider", "Openprovider", "bijna", uitleg, k, "Nog niet gecontroleerd vanaf de server van je Dienst", true, "paneel", "openprovider"));
            else items.add(item("openprovider", "Openprovider", "ok", uitleg, k, live ? "Werkt, ook vanaf je server" : "Inloggen werkt", true, "paneel", "openprovider"));
        }
        // Gratis-adressendienst (optioneel)
        {
            String uitleg = "Alleen voor de beheerders van het project: gratis adressen (naam.eigencloud.nl) voor klanten van alle aanbieders.";
            String k = "ongeveer € 10 per jaar voor het domein";
            String label = "Gratis-adressendienst";
            if (a.get("adressen") == null) items.add(item("adressendienst", label, "open", uitleg, k, "Draait niet (optioneel)", true, "paneel", "adressendienst"));
            else if (adrNs != null && Doh.nsMatch(adrNs.values, DESEC_NS)) items.add(item("adressendienst", label, "ok", uitleg, k, adrZone + " staat bij deSEC", true, "paneel", "adressendienst"));
            else items.add(item("adressendienst", label, "bijna", uitleg, k, adrNs != null && adrNs.rcode == 3 ? adrZone + " lijkt nog niet geregistreerd" : "Zet de nameservers van " + adrZone + " op deSEC", true, "paneel", "adressendienst"));
        }
        // Voorwaarden en privacy (alleen status, zoals GET /api/aanbieder/juridisch)
        {
            String uitleg = "Je klanten lezen je voorwaarden en privacyverklaring voordat ze bestellen.";
            String label = "Voorwaarden en privacy";
            boolean terms = jur != null && Json.truthy(jur.get("termsUrl")), privacy = jur != null && Json.truthy(jur.get("privacyUrl"));
            if (!live) items.add(item("voorwaarden", label, "open", uitleg, null, "Na het opzetten van je Dienst", false, "hub", "voorwaarden"));
            else if (jur == null || !isTrue(jur.get("bereikbaar"))) items.add(item("voorwaarden", label, "bijna", uitleg, null, "Je Dienst is nu niet bereikbaar", false, "hub", "voorwaarden"));
            else if (terms && privacy) items.add(item("voorwaarden", label, "ok", uitleg, null, "Staan online", false, "hub", "voorwaarden"));
            else items.add(item("voorwaarden", label, "bijna", uitleg, null, !terms && !privacy ? "Nog niet gepubliceerd" : !terms ? "Je voorwaarden ontbreken nog" : "Je privacyverklaring ontbreekt nog", false, "hub", "voorwaarden"));
        }
        // Op de lijst (alleen status, zoals GET /api/aanbieder/lijst)
        {
            String uitleg = "Dan kunnen mensen je Dienst in de app kiezen, en krijgt hij gratis adressen.";
            Map<String, Object> pr = lijst == null ? null : Json.map(lijst, "voorstel");
            String prs = pr == null ? null : Json.str(pr, "status");
            Object nr = pr == null ? null : Json.jsString(pr.get("nummer"));
            String status, detail;
            if (!live) { status = "open"; detail = "Na het opzetten van je Dienst"; }
            else if (lijst == null) { status = "bijna"; detail = "Kon niet nagaan of je Dienst op de lijst staat"; }
            else if (isTrue(lijst.get("opLijst")) && (lijst.get("regel") == null || isTrue(lijst.get("sleutelKlopt")))) { status = "ok"; detail = "Je Dienst staat op de lijst"; }
            else if (isTrue(lijst.get("opLijst"))) { status = "bijna"; detail = "Je regel staat erop, maar met een andere sleutel"; }
            else if ("open".equals(prs)) { status = "bijna"; detail = "Voorstel #" + nr + " wacht op de beheerders"; }
            else if ("samengevoegd".equals(prs)) { status = "bijna"; detail = "Samengevoegd; de openbare lijst wordt zo bijgewerkt"; }
            else if (lijst.get("lijstFout") != null) { status = "bijna"; detail = "Kon de openbare lijst nu niet lezen"; }
            else { status = "open"; detail = "gesloten".equals(prs) ? "Voorstel #" + nr + " is gesloten; meld je opnieuw aan" : "Nog niet op de lijst"; }
            items.add(item("lijst", "Op de lijst", status, uitleg, "gratis", detail, true, "hub", "lijst"));
        }
        long klaar = 0, totaal = 0;
        for (Object x : items) {
            if (Json.truthy(Json.path(x, "optioneel"))) continue;
            totaal++;
            if ("ok".equals(Json.str(x, "status"))) klaar++;
        }
        return Json.obj("items", items, "klaar", klaar, "totaal", totaal, "links", links(), "at", System.currentTimeMillis());
    }

    // ───────── Scaleway: één sleutel, de app regelt de rest ─────────

    /** The Dienst's permissions (SCW_RULES in TS). */
    public static List<Object> scwRules(String org) {
        return Json.list(Json.obj("permission_set_names", Json.list("ProjectManager", "IAMManager"), "organization_id", org),
                Json.obj("permission_set_names", Json.list("InstancesFullAccess", "ObjectStorageFullAccess", "TransactionalEmailFullAccess"), "organization_id", org));
    }

    private static boolean rulesOk(List<Object> rules, String org) {
        java.util.Set<String> have = new java.util.HashSet<>();
        for (Object r : rules) if (org.equals(Json.str(r, "organization_id"))) for (Object n : Json.listAt(r, "permission_set_names")) have.add(Json.jsString(n));
        for (Object r : scwRules(org)) for (Object n : Json.listAt(r, "permission_set_names")) if (!have.contains(Json.jsString(n))) return false;
        return true;
    }

    private static Object scw(String method, String path, String key, Object body) throws IOException { return Extras.scw(method, path, key, body); }

    private static String id(Object o) { Object v = Json.path(o, "id"); return v == null ? null : Json.jsString(v); }

    private static boolean deleteKey(String accessKey, String key) {
        try {
            scw("DELETE", "/iam/v1alpha1/api-keys/" + Bytes.encodeURIComponent(accessKey), key, null);
            return true;
        } catch (HttpException e) {
            return e.status == 404;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** With one personal Scaleway key, set everything up (scaleway in TS). Retrying creates nothing twice. */
    public static Map<String, Object> scaleway(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        List<Object> steps = new ArrayList<>();
        String[] keys = Extras.scwKeys(Json.str(b, "accessKey"), Json.str(b, "secretKey"));
        String accessKey = keys[0], secretKey = keys[1];
        try {
            Object k;
            try {
                k = scw("GET", "/iam/v1alpha1/api-keys/" + Bytes.encodeURIComponent(accessKey), secretKey, null);
            } catch (HttpException e) {
                if (e.status == 403 || e.status == 404) throw new IOException("Deze sleutel kan zichzelf niet bekijken. Maak de sleutel aan voor jezelf (IAM → API-sleutels → 'Mezelf'), als eigenaar van de organisatie.", e);
                throw e;
            }
            Object sk = Json.path(k, "secret_key");
            if (Json.truthy(sk) && !secretKey.equals(sk)) throw new IOException("Deze geheime sleutel hoort niet bij deze toegangssleutel");
            String userId = Json.str(k, "user_id"), appId = Json.str(k, "application_id");
            Object owner = nonEmpty(userId) ? scw("GET", "/iam/v1alpha1/users/" + Bytes.encodeURIComponent(userId), secretKey, null)
                    : nonEmpty(appId) ? scw("GET", "/iam/v1alpha1/applications/" + Bytes.encodeURIComponent(appId), secretKey, null) : null;
            String org = Json.path(owner, "organization_id") == null ? "" : Json.jsString(Json.path(owner, "organization_id"));
            if (!UUID.matcher(org).matches()) throw new IOException("Kon de organisatie van deze sleutel niet vinden");
            steps.add(step("Je sleutel werkt", true, "Organisatie " + org));
            Map<String, Object> st = Json.map(a, "scw");
            if (st == null || !org.equals(Json.str(st, "org"))) { st = Json.obj("org", org); a.put("scw", st); }
            String q = Bytes.encodeURIComponent(org);
            if (!nonEmpty(Json.str(st, "applicationId"))) {
                String app = null;
                for (Object x : Json.listAt(scw("GET", "/iam/v1alpha1/applications?organization_id=" + q + "&name=" + SCW_APP, secretKey, null), "applications")) if (SCW_APP.equals(Json.str(x, "name"))) { app = id(x); break; }
                if (app == null) app = id(scw("POST", "/iam/v1alpha1/applications", secretKey, Json.obj("name", SCW_APP, "organization_id", org, "description", "Eigen Cloud Dienst: klantprojecten, sleutels, servers, opslag en mail")));
                if (app == null) throw new IOException("Scaleway gaf geen applicatie-id terug");
                st.put("applicationId", app);
                deps.save();
            }
            String app = Json.str(st, "applicationId");
            steps.add(step("Applicatie " + SCW_APP, true, null));
            if (!nonEmpty(Json.str(st, "policyId"))) {
                String pol = null;
                for (Object x : Json.listAt(scw("GET", "/iam/v1alpha1/policies?organization_id=" + q + "&application_ids=" + Bytes.encodeURIComponent(app), secretKey, null), "policies")) {
                    if (app.equals(Json.str(x, "application_id"))) { pol = id(x); break; }
                }
                if (pol == null) {
                    pol = id(scw("POST", "/iam/v1alpha1/policies", secretKey, Json.obj("name", SCW_APP, "description", "Rechten van de Eigen Cloud Dienst", "organization_id", org, "application_id", app, "rules", scwRules(org))));
                    if (pol == null) throw new IOException("Scaleway gaf geen policy-id terug");
                }
                st.put("policyId", pol);
                deps.save();
            }
            String pol = Json.str(st, "policyId");
            Object rules = scw("GET", "/iam/v1alpha1/rules?policy_id=" + Bytes.encodeURIComponent(pol), secretKey, null);
            if (!rulesOk(Json.listAt(rules, "rules"), org)) scw("PUT", "/iam/v1alpha1/rules", secretKey, Json.obj("policy_id", pol, "rules", scwRules(org)));
            steps.add(step("Rechten: projecten, sleutels, servers, opslag en mail", true, null));
            Map<String, Object> acc = sub(a, "accounts");
            boolean reuse = false;
            if (nonEmpty(Json.str(st, "accessKey")) && nonEmpty(Json.str(acc, "scalewaySecretKey")) && org.equals(Json.str(acc, "scalewayOrgId"))) {
                try {
                    reuse = app.equals(Json.str(scw("GET", "/iam/v1alpha1/api-keys/" + Bytes.encodeURIComponent(Json.str(st, "accessKey")), secretKey, null), "application_id"));
                } catch (IOException | RuntimeException e) {
                    reuse = false;
                }
            }
            if (!reuse) {
                Map<String, Object> body = Json.obj("application_id", app, "description", "Eigen Cloud Dienst (gemaakt door de app)");
                if (Json.truthy(Json.path(k, "default_project_id"))) body.put("default_project_id", Json.path(k, "default_project_id"));
                Object nk = scw("POST", "/iam/v1alpha1/api-keys", secretKey, body);
                if (!Json.truthy(Json.path(nk, "access_key")) || !Json.truthy(Json.path(nk, "secret_key"))) throw new IOException("Scaleway gaf geen sleutel terug");
                st.put("accessKey", Json.str(nk, "access_key"));
                acc.put("scalewaySecretKey", Json.str(nk, "secret_key"));
                acc.put("scalewayOrgId", org);
                deps.save();
            }
            boolean works = false;
            for (int i = 0; i < 5 && !works; i++) {
                if (i > 0 && retryDelayMs > 0) {
                    try { Thread.sleep(retryDelayMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }
                works = isTrue(Aanbieder.checkScaleway(Json.str(acc, "scalewaySecretKey"), org).get("ok"));
            }
            sub(a, "checked").put("scaleway", works);
            if (!works) throw new IOException("De nieuwe sleutel werkt nog niet. Probeer het over een minuut opnieuw; wat al klaarstaat, blijft staan.");
            steps.add(step("Eigen sleutel voor je Dienst", true, reuse ? "Bestond al en werkt" : "Gemaakt en gecontroleerd"));
            boolean verwijderd = false;
            if (nonEmpty(userId) && !accessKey.equals(Json.str(st, "accessKey"))) {
                if (!Boolean.FALSE.equals(b.get("verwijderen"))) {
                    verwijderd = deleteKey(accessKey, Json.str(acc, "scalewaySecretKey")) || deleteKey(accessKey, secretKey);
                    steps.add(verwijderd ? step("Je eigen sleutel is weggegooid", true, null)
                            : step("Je eigen sleutel weggooien lukte niet", false, "Gooi hem zelf weg in de Scaleway-console (IAM → API-sleutels)"));
                } else steps.add(step("Je eigen sleutel blijft bestaan", true, "Gooi hem weg in de Scaleway-console als je hem niet meer nodig hebt"));
                st.put("personal", Json.obj("accessKey", mask(accessKey), "deleted", verwijderd));
            }
            deps.save();
            return Json.obj("ok", true, "steps", steps, "org", org, "applicatie", SCW_APP, "verwijderd", verwijderd);
        } catch (IOException | RuntimeException e) {
            deps.save();
            throw fail(e, steps);
        }
    }

    // ───────── Mollie ─────────

    private static List<Object> methodIds(String key, String seq) {
        Object[] r = getJson(Endpoints.MOLLIE.replaceAll("/+$", "") + "/methods?sequenceType=" + seq, Http.headers("authorization", "Bearer " + key), 15_000);
        List<Object> out = new ArrayList<>();
        for (Object m : Json.listAt(r[1], "_embedded", "methods")) out.add(Json.jsString(Json.path(m, "id")));
        return out;
    }

    /** Check the Mollie key and read what is still to do (mollie in TS). */
    public static Map<String, Object> mollie(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Map<String, Object> acc = sub(a, "accounts");
        Object kin = b.get("key");
        if (kin != null && !Json.jsString(kin).startsWith("••")) {
            String v = Json.jsString(kin).trim();
            if (!v.matches("^(test|live)_[A-Za-z0-9]+$")) throw new IllegalArgumentException("Een Mollie-sleutel begint met test_ of live_");
            acc.put("mollieKey", v);
        }
        String key = Json.str(acc, "mollieKey");
        if (!nonEmpty(key)) throw new IllegalArgumentException("Vul je Mollie-sleutel in");
        Map<String, String> h = Http.headers("authorization", "Bearer " + key);
        Object[] prof = getJson(Endpoints.MOLLIE.replaceAll("/+$", "") + "/profiles/me", h, 15_000);
        int status = (Integer) prof[0];
        sub(a, "checked").put("mollie", status == 200);
        if (status == 401 || status == 403) throw new IOException("Mollie accepteert deze sleutel niet");
        if (status != 200) throw new IOException(status != 0 ? "Mollie antwoordt " + status : "Mollie is niet bereikbaar");
        List<Object> eerste = methodIds(key, "first"), terugkerend = methodIds(key, "recurring");
        String mode = key.startsWith("live_") ? "live" : "test";
        Object p = prof[1] == null ? Json.obj() : prof[1];
        Object dh = Json.path(p, "_links", "dashboard", "href");
        String dashboard = dh instanceof String ? (String) dh : "https://my.mollie.com/dashboard";
        String pst = Json.path(p, "status") == null ? null : Json.jsString(Json.path(p, "status"));
        List<Object> todo = new ArrayList<>();
        if ("blocked".equals(pst)) todo.add(Json.obj("tekst", "Je Mollie-profiel is geblokkeerd. Neem contact op met Mollie.", "link", dashboard));
        else if ("live".equals(mode) && !"verified".equals(pst)) todo.add(Json.obj("tekst", "Mollie heeft je account nog niet goedgekeurd. Rond de aanmelding af in je Mollie-dashboard.", "link", dashboard));
        if (!eerste.contains("ideal")) todo.add(Json.obj("tekst", "iDEAL staat nog niet aan: zet het aan in je Mollie-dashboard.", "link", dashboard));
        if (!terugkerend.contains("directdebit")) todo.add(Json.obj("tekst", "SEPA-incasso staat nog niet aan: zet het aan in je Mollie-dashboard. Dat is nodig voor de maandelijkse betaling.", "link", dashboard));
        Map<String, Object> profiel = Json.obj("naam", Json.path(p, "name") == null ? "" : Json.jsString(Json.path(p, "name")), "website", Json.path(p, "website") == null ? "" : Json.jsString(Json.path(p, "website")), "status", pst == null ? "" : pst);
        Map<String, Object> methoden = Json.obj("eerste", eerste, "terugkerend", terugkerend);
        a.put("mollie", Json.obj("at", System.currentTimeMillis(), "mode", mode, "profiel", profiel, "methoden", methoden, "todo", todo));
        return Json.obj("ok", true, "mode", mode, "profiel", Json.copy(profiel), "methoden", Json.copy(methoden), "todo", Json.copy(todo),
                "test", "test".equals(mode) ? "Je gebruikt de testsleutel: betalingen zijn nep. Zet de live-sleutel erin zodra Mollie je account heeft goedgekeurd; daarna Wijzigingen toepassen." : null,
                "links", mollieLinks(dashboard),
                "onboarding", "Hoe ver je aanmelding bij Mollie is, laat Mollie alleen aan gekoppelde apps zien (OAuth); kijk daarvoor in je Mollie-dashboard.",
                "pending", a.get("server") != null);
    }

    // ───────── deSEC ─────────

    private static final Map<String, String> JSON = Http.headers("content-type", "application/json");

    /** A deSEC account for the Dienst (desecRegister in TS). */
    public static Map<String, Object> desecRegister(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        String email = nonEmpty(Json.str(b, "email")) ? Json.str(b, "email") : nonEmpty(Json.str(a, "company", "email")) ? Json.str(a, "company", "email") : nz(Json.str(c, "console", "alertEmail"));
        email = email.trim().toLowerCase(Locale.ROOT);
        if (!EMAIL.matcher(email).matches()) throw new IllegalArgumentException("Vul een e-mailadres in voor het deSEC-account");
        String password = Bytes.base64(Bytes.random(18)).replace('+', '-').replace('/', '_').replace("=", "");
        Map<String, Object> body = Json.obj("email", email, "password", password, "captcha", Json.obj("id", b.get("captchaId"), "solution", nz(Json.str(b, "solution")).trim()), "outreach_preference", false);
        Http.Response r;
        try {
            r = Http.request("POST", Endpoints.DESEC.replaceAll("/+$", "") + "/auth/", JSON, Bytes.utf8(Json.stringify(body)), 20_000);
        } catch (IOException e) {
            throw new IOException("deSEC is niet bereikbaar", e);
        }
        if (r.status != 202 && !r.ok()) {
            Object j = null;
            try { j = Json.parse(r.text()); } catch (RuntimeException ignored) { j = null; }
            throw new IOException(Extras.desecError(j));
        }
        a.put("desecAccount", Json.obj("email", email, "password", password, "at", System.currentTimeMillis()));
        return Json.obj("ok", true, "email", email);
    }

    private static Object desecPost(String path, String token, Object body) throws IOException {
        Http.Response r = Http.request("POST", Endpoints.DESEC.replaceAll("/+$", "") + path, Http.headers("authorization", "Token " + token, "content-type", "application/json"), Bytes.utf8(Json.stringify(body)), 20_000);
        Object j = null;
        try { j = r.text().isEmpty() ? null : Json.parse(r.text()); } catch (RuntimeException ignored) { j = null; }
        if (!r.ok()) throw new IOException(Extras.desecError(j));
        return j;
    }

    /** After the confirmation link: log in and make the tokens (desecFinish in TS). */
    public static Map<String, Object> desecFinish(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Map<String, Object> acc = Json.map(a, "desecAccount");
        if (acc == null) throw new IllegalArgumentException("Maak eerst het deSEC-account aan");
        Http.Response login;
        try {
            login = Http.request("POST", Endpoints.DESEC.replaceAll("/+$", "") + "/auth/login/", JSON, Bytes.utf8(Json.stringify(Json.obj("email", acc.get("email"), "password", acc.get("password")))), 20_000);
        } catch (IOException e) {
            throw new IOException("deSEC is niet bereikbaar", e);
        }
        if (login.status == 401 || login.status == 403) {
            Number at = Json.num(acc, "at");
            if (at != null && System.currentTimeMillis() - at.longValue() > 12 * 3_600_000L) throw new IOException("De bevestigingslink is verlopen. Maak het account opnieuw aan.");
            return Json.obj("ok", false, "pending", true, "email", acc.get("email"), "tokens", Json.list());
        }
        String lt = null;
        try { lt = Json.str(Json.parse(login.text()), "token"); } catch (RuntimeException ignored) { lt = null; }
        if (!login.ok() || !nonEmpty(lt)) throw new IOException("Inloggen bij deSEC mislukt");
        List<Object> made = new ArrayList<>();
        Map<String, Object> accounts = sub(a, "accounts");
        if (!nonEmpty(Json.str(accounts, "desecToken"))) {
            Object t = desecPost("/auth/tokens/", lt, Json.obj("name", "eigen-cloud-dienst", "perm_create_domain", true, "perm_delete_domain", true, "perm_manage_tokens", false));
            if (!nonEmpty(Json.str(t, "token"))) throw new IOException("Token maken bij deSEC mislukt");
            accounts.put("desecToken", Json.str(t, "token"));
            acc.put("tokenId", Json.path(t, "id"));
            made.add("dienst");
        }
        if (isTrue(b.get("adressen")) && !nonEmpty(Json.str(acc, "adressenToken"))) {
            Object t = desecPost("/auth/tokens/", lt, Json.obj("name", "eigen-cloud-adressen", "perm_create_domain", true, "perm_delete_domain", true, "perm_manage_tokens", true));
            if (!nonEmpty(Json.str(t, "token"))) throw new IOException("Token voor de adressendienst maken bij deSEC mislukt");
            acc.put("adressenToken", Json.str(t, "token"));
            acc.put("adressenTokenId", Json.path(t, "id"));
            Map<String, Object> adr = Json.map(a, "adressen");
            if (adr != null) adr.put("desecToken", Json.str(t, "token"));
            made.add("adressen");
        }
        sub(a, "checked").put("desec", isTrue(Aanbieder.checkDesec(Json.str(accounts, "desecToken")).get("ok")));
        return Json.obj("ok", true, "pending", false, "email", acc.get("email"), "tokens", made);
    }

    // ───────── Domein en DNS ─────────

    private static Openprovider.Api opOf(Map<String, Object> a) {
        String u = Json.str(a, "accounts", "openproviderUser"), p = Json.str(a, "accounts", "openproviderPass");
        return nonEmpty(u) && nonEmpty(p) ? new Openprovider.Api(u, p) : null;
    }

    /** {voor, zone, target (map or null), token}: which domain and where its DNS must be (doel in TS). */
    private static Object[] doel(Map<String, Object> c, Map<String, Object> a, Map<String, Object> b, Aanbieder.Offers deps) {
        String voor = "adressen".equals(Json.str(b, "voor")) ? "adressen" : "dienst";
        String raw = nz(b.get("zone") == null ? null : Json.jsString(b.get("zone"))).trim().toLowerCase(Locale.ROOT).replaceFirst("^https?://", "").replaceAll("[/.]+$", "");
        String zone = !raw.isEmpty() ? raw : "adressen".equals(voor) ? Json.str(a, "adressen", "zone")
                : Json.str(a, "dns", "zone") != null ? Json.str(a, "dns", "zone") : Aanbieder.defaultZone(hostOf(Json.str(a, "url")));
        if (zone == null || !ZONE.matcher(zone).matches()) throw new IllegalArgumentException("adressen".equals(voor) ? "Vul de gedeelde zone in, zoals eigencloud.nl" : "Kies eerst het adres van je Dienst");
        Map<String, Object> target = null;
        Map<String, Object> d = Json.map(a, "dns");
        if ("adressen".equals(voor)) target = Json.obj("id", "desec", "naam", "deSEC", "nameservers", new ArrayList<Object>(DESEC_NS));
        else if (d != null && zone.equals(Json.str(d, "zone"))) target = Json.obj("id", Json.str(d, "provider"), "naam", Aanbieder.dnsName(Json.str(d, "provider"), deps), "nameservers", new ArrayList<>(Json.listAt(d, "nameservers")));
        String token = "adressen".equals(voor) ? (nonEmpty(Json.str(a, "adressen", "desecToken")) ? Json.str(a, "adressen", "desecToken") : Json.str(a, "desecAccount", "adressenToken"))
                : d != null && "desec".equals(Json.str(d, "provider")) ? Json.str(d, "fields", "token") : null;
        return new Object[] {voor, zone, target, token};
    }

    private static List<String> strings(List<Object> l) {
        List<String> out = new ArrayList<>();
        for (Object x : l) out.add(Json.jsString(x));
        return out;
    }

    /** {dnskeys, ds} of a zone at deSEC; empty when that fails. */
    private static List<List<String>> desecKeys(String zone, String token) {
        List<String> dnskeys = new ArrayList<>(), ds = new ArrayList<>();
        if (nonEmpty(token)) {
            Object[] r = getJson(Endpoints.DESEC.replaceAll("/+$", "") + "/domains/" + Bytes.encodeURIComponent(zone) + "/", Http.headers("authorization", "Token " + token), 15_000);
            for (Object k : Json.listAt(r[1], "keys")) {
                String dk = Json.path(k, "dnskey") == null ? "" : Json.jsString(Json.path(k, "dnskey"));
                if (!dk.isEmpty()) dnskeys.add(dk);
                for (Object x : Json.listAt(k, "ds")) ds.add(Json.jsString(x));
            }
        }
        return Arrays.asList(dnskeys, ds);
    }

    /** "257 3 13 <base64>" → Openprovider dnssec_keys (parseDnskey in src/broker/provision.ts); null when malformed. */
    static Map<String, Object> parseDnskey(String s) {
        String[] p = s.trim().split("\\s+");
        if (p.length < 4) return null;
        StringBuilder key = new StringBuilder();
        for (int i = 3; i < p.length; i++) key.append(p[i]);
        return Json.obj("flags", Long.parseLong(p[0]), "protocol", Long.parseLong(p[1]), "alg", Long.parseLong(p[2]), "pub_key", key.toString());
    }

    private static List<Object> opKeys(List<String> dnskeys) {
        List<Object> out = new ArrayList<>();
        for (String k : dnskeys) { Map<String, Object> m = parseDnskey(k); if (m != null) out.add(m); }
        return out;
    }

    /** {id (Long), nameservers} of the domain in the Openprovider account, or null. */
    private static Map<String, Object> opDomain(Openprovider.Api op, String zone) throws IOException {
        Object j = op.req("GET", "/domains?full_name=" + Bytes.encodeURIComponent(zone) + "&limit=1", null);
        for (Object x : Json.listAt(j, "data", "results")) {
            if ((Json.jsString(Json.path(x, "domain", "name")) + "." + Json.jsString(Json.path(x, "domain", "extension"))).equals(zone) || zone.equals(Json.str(x, "full_name"))) {
                return Json.obj("id", Json.num(x, "id").longValue());
            }
        }
        return null;
    }

    /** {vrij, prijs} (POST /domains/check with_price). */
    private static Map<String, Object> opCheckDomain(Openprovider.Api op, String zone) throws IOException {
        Object j = op.req("POST", "/domains/check", Json.obj("domains", Json.list(Openprovider.splitDomain(zone)), "with_price", true));
        Object res = Json.path(j, "data") instanceof List ? Json.path(j, "data", 0) : Json.path(j, "data", "results", 0);
        boolean premium = Boolean.TRUE.equals(Json.path(res, "is_premium"));
        Object p = premium ? null : Json.path(res, "price", "reseller") != null ? Json.path(res, "price", "reseller") : Json.path(res, "price", "product");
        Object prijs = null;
        if (p != null && Json.path(p, "price") != null) {
            prijs = Json.obj("valuta", Json.path(p, "currency") == null ? "EUR" : Json.jsString(Json.path(p, "currency")),
                    "bedrag", new java.math.BigDecimal(Json.num(p, "price").doubleValue()).setScale(2, java.math.RoundingMode.HALF_UP).toPlainString());
        }
        return Json.obj("vrij", "free".equals(Json.str(res, "status")), "premium", premium, "prijs", prijs);
    }

    /** Where the domain's DNS is and whether it is where it must be (domein in TS). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> domein(Map<String, Object> c, Map<String, Object> b, Aanbieder.Offers deps) {
        Map<String, Object> a = readOnly(c);
        Object[] d = doel(c, a, b, deps);
        String voor = (String) d[0], zone = (String) d[1], token = (String) d[3];
        Map<String, Object> target = (Map<String, Object>) d[2];
        Doh.Answer ns = Doh.lookup(zone, "NS");
        Boolean registered = ns == null ? null : !ns.values.isEmpty() ? Boolean.TRUE : ns.rcode == 3 ? Boolean.FALSE : null;
        String bij = ns != null ? Doh.nsProvider(ns.values) : null;
        List<String> tns = target == null ? new ArrayList<>() : strings(Json.listAt(target, "nameservers"));
        Boolean goed = target != null && ns != null ? (!tns.isEmpty() ? (Boolean) Doh.nsMatch(ns.values, tns) : null) : null;
        List<List<String>> keys = target != null && "desec".equals(target.get("id")) ? desecKeys(zone, token) : Arrays.asList(new ArrayList<String>(), new ArrayList<String>());
        List<String> ds = keys.get(1);
        Boolean dnssec = null;
        if (!ds.isEmpty()) {
            Doh.Answer dsNu = Doh.lookup(zone, "DS");
            boolean any = false;
            if (dsNu != null) for (String v : dsNu.values) for (String x : ds) if (x.toLowerCase(Locale.ROOT).equals(v)) any = true;
            dnssec = any;
        }
        Openprovider.Api op = opOf(a);
        Map<String, Object> opInfo = Json.obj("gekoppeld", op != null, "domeinId", null, "vrij", null, "premium", false, "prijs", null, "fout", null);
        if (op != null) {
            try {
                Map<String, Object> dom = opDomain(op, zone);
                opInfo.put("domeinId", dom == null ? null : dom.get("id"));
                if (dom == null && !Boolean.TRUE.equals(registered)) opInfo.putAll(opCheckDomain(op, zone));
            } catch (IOException e) {
                opInfo.put("fout", e.getMessage());
            }
        }
        boolean kanDelegeren = op != null && opInfo.get("domeinId") != null && target != null && !tns.isEmpty() && (Boolean.FALSE.equals(goed) || Boolean.FALSE.equals(dnssec));
        String uitleg = null;
        if (Boolean.FALSE.equals(registered)) {
            uitleg = isTrue(opInfo.get("vrij")) && isTrue(opInfo.get("premium")) ? zone + " is nog vrij, maar het is een premium-domein met een hogere prijs. Koop het als je wilt in het controlepaneel van Openprovider."
                    : isTrue(opInfo.get("vrij")) && opInfo.get("prijs") != null ? zone + " is nog vrij. Je kunt het hieronder kopen bij Openprovider."
                    : zone + " lijkt nog niet geregistreerd. Koop het bij een registrar naar keuze, bijvoorbeeld Openprovider.";
        }
        else if (target != null && Boolean.FALSE.equals(goed)) {
            uitleg = "Log in bij de partij waar je " + zone + " hebt gekocht" + (bij != null ? " (de DNS staat nu bij " + bij + ")" : "") + ", zoek de nameservers van het domein en vervang ze door " + String.join(" en ", tns) + "."
                    + (!ds.isEmpty() ? " Zet daar ook DNSSEC aan met de DS-gegevens hieronder." : "") + " Het kan een paar uur duren voordat iedereen het ziet.";
        } else if (Boolean.FALSE.equals(dnssec)) uitleg = "De nameservers kloppen. Zet bij de partij waar je " + zone + " hebt gekocht nog DNSSEC aan met de DS-gegevens hieronder.";
        return Json.obj("zone", zone, "voor", voor, "geregistreerd", registered, "nameservers", ns == null ? Json.list() : new ArrayList<Object>(ns.values), "bij", bij,
                "doel", target, "goed", goed, "ds", new ArrayList<Object>(ds), "dnssec", dnssec, "openprovider", opInfo, "kanDelegeren", kanDelegeren, "uitleg", uitleg);
    }

    /** Set nameservers (and at deSEC the DNSSEC keys) at Openprovider (delegeren in TS). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> delegeren(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Object[] d = doel(c, a, b, deps);
        String voor = (String) d[0], zone = (String) d[1], token = (String) d[3];
        Map<String, Object> target = (Map<String, Object>) d[2];
        Openprovider.Api op = opOf(a);
        if (op == null) throw new IllegalArgumentException("Koppel eerst Openprovider");
        if (target == null || Json.listAt(target, "nameservers").isEmpty()) throw new IllegalArgumentException("Kies eerst wie de DNS van dit domein doet");
        List<String> tns = strings(Json.listAt(target, "nameservers"));
        List<Object> steps = new ArrayList<>();
        try {
            if ("adressen".equals(voor)) {
                if (!nonEmpty(token)) throw new IOException("Er is nog geen deSEC-token voor de adressendienst");
                Desec.connect(Json.obj("token", token), zone);
                steps.add(step(zone + " staat bij deSEC", true, null));
            }
            Map<String, Object> dom = opDomain(op, zone);
            if (dom == null) throw new IOException(zone + " staat niet in je Openprovider-account");
            List<Object> keys = "desec".equals(target.get("id")) ? opKeys(desecKeys(zone, token).get(0)) : new ArrayList<>();
            List<Object> nsl = new ArrayList<>();
            for (String n : tns) nsl.add(Json.obj("name", n));
            Map<String, Object> body = Json.obj("name_servers", nsl);
            if (!keys.isEmpty()) { body.put("is_dnssec_enabled", true); body.put("dnssec_keys", keys); }
            op.req("PUT", "/domains/" + dom.get("id"), body);
            steps.add(step("Nameservers op " + target.get("naam") + " gezet", true, String.join(", ", tns)));
            if (!keys.isEmpty()) steps.add(step("DNSSEC aangezet", true, null));
            deps.save();
            return Json.obj("ok", true, "steps", steps);
        } catch (IOException | RuntimeException e) {
            throw fail(e, steps);
        }
    }

    // parsePhone (src/broker/provision.ts), for the holder of a bought domain.
    private static final List<String> ONE = Arrays.asList("1", "7");
    private static final List<String> TWO = Arrays.asList("20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "90");
    private static final List<String> NL_TWO = Arrays.asList("10", "13", "15", "20", "23", "24", "26", "30", "33", "35", "36", "38", "40", "43", "45", "46", "50", "53", "55", "58", "70", "71", "72", "73", "74", "75", "76", "77", "78", "79", "85", "88", "97");

    /** "+31 6 12345678", "0612345678" → Openprovider phone, or null (parsePhone in provision.ts). */
    static Map<String, Object> parsePhone(String input) {
        String s = input.trim().replaceAll("[()\\-.]", " ").replaceAll("\\s+", " ");
        if (s.startsWith("00")) s = "+" + s.substring(2);
        String cc, rest;
        if (s.startsWith("+")) {
            java.util.regex.Matcher m = Pattern.compile("^\\+(\\d{1,3}) (.+)$").matcher(s);
            if (m.find()) { cc = m.group(1); rest = m.group(2); }
            else {
                String digits = s.substring(1).replace(" ", "");
                int len = !digits.isEmpty() && ONE.contains(digits.substring(0, 1)) ? 1 : digits.length() >= 2 && TWO.contains(digits.substring(0, 2)) ? 2 : 3;
                cc = digits.substring(0, Math.min(len, digits.length()));
                rest = digits.substring(Math.min(len, digits.length()));
            }
        } else if (s.startsWith("0")) { cc = "31"; rest = s.substring(1); }
        else return null;
        rest = rest.replaceFirst("^0", "");
        List<String> parts = new ArrayList<>();
        for (String p : rest.split(" ")) if (!p.isEmpty()) parts.add(p);
        for (String p : parts) if (!p.matches("^\\d+$")) return null;
        String area, sub;
        if (parts.size() >= 2) { area = parts.get(0); sub = String.join("", parts.subList(1, parts.size())); }
        else {
            String d = parts.isEmpty() ? "" : parts.get(0);
            int len = 2;
            if (cc.equals("31")) len = d.startsWith("6") ? 1 : d.length() >= 2 && NL_TWO.contains(d.substring(0, 2)) ? 2 : 3;
            area = d.substring(0, Math.min(len, d.length()));
            sub = d.substring(Math.min(len, d.length()));
        }
        int total = (area + sub).length();
        if (area.isEmpty() || sub.length() < 4 || total < 7 || total > 14) return null;
        return Json.obj("country_code", "+" + cc, "area_code", area, "subscriber_number", sub);
    }

    private static String h(Map<String, Object> houder, String k) {
        Object v = houder == null ? null : houder.get(k);
        return v == null ? "" : Json.jsString(v).trim();
    }

    /** Buy a domain at Openprovider, only with {@code akkoord} and the price shown (kopen in TS). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> kopen(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Object[] d = doel(c, a, b, deps);
        String voor = (String) d[0], zone = (String) d[1], token = (String) d[3];
        Map<String, Object> target = (Map<String, Object>) d[2];
        Openprovider.Api op = opOf(a);
        if (op == null) throw new IllegalArgumentException("Koppel eerst Openprovider");
        if (!isTrue(b.get("akkoord"))) throw new IllegalArgumentException("Bevestig eerst dat je het domein wilt kopen");
        List<Object> steps = new ArrayList<>();
        try {
            Map<String, Object> chk = opCheckDomain(op, zone);
            if (!isTrue(chk.get("vrij"))) throw new IOException(zone + " is niet (meer) vrij");
            if (isTrue(chk.get("premium"))) throw new IOException(zone + " is een premium-domein met een andere prijs. Koop het in het controlepaneel van Openprovider.");
            Map<String, Object> prijs = Json.map(chk, "prijs");
            String bedrag = prijs == null ? null : Json.str(prijs, "bedrag");
            if (bedrag == null || !bedrag.equals(b.get("prijs") == null ? "" : Json.jsString(b.get("prijs")))) {
                throw new IOException("De prijs is veranderd: nu " + (bedrag != null ? "€ " + bedrag.replace(".", ",") : "onbekend") + " per jaar. Kijk opnieuw en bevestig.");
            }
            String handle = Json.str(a, "opHandle");
            Map<String, Object> houder = Json.map(b, "houder");
            String email = (nonEmpty(h(houder, "email")) ? h(houder, "email") : nz(Json.str(a, "company", "email"))).trim().toLowerCase(Locale.ROOT);
            if (!nonEmpty(handle) && !email.isEmpty()) {
                Object j = op.req("GET", "/customers?email_pattern=" + Bytes.encodeURIComponent(email) + "&limit=1", null);
                handle = Json.str(j, "data", "results", 0, "handle");
            }
            if (!nonEmpty(handle)) {
                String[][] need = {{"voornaam", "voornaam"}, {"achternaam", "achternaam"}, {"straat", "straat"}, {"huisnummer", "huisnummer"}, {"postcode", "postcode"}, {"plaats", "plaats"}, {"telefoon", "telefoonnummer"}};
                List<String> missing = new ArrayList<>();
                for (String[] n : need) if (h(houder, n[0]).isEmpty()) missing.add(n[1]);
                if (!missing.isEmpty()) throw new IOException("Vul de gegevens van de houder in: " + String.join(", ", missing));
                Map<String, Object> phone = parsePhone(h(houder, "telefoon"));
                if (phone == null) throw new IOException("Het telefoonnummer klopt niet; schrijf het als +31 6 12345678");
                String first = h(houder, "voornaam");
                StringBuilder ini = new StringBuilder();
                for (String p : first.split("\\s+")) if (!p.isEmpty()) { if (ini.length() > 0) ini.append('.'); ini.append(p.substring(0, 1).toUpperCase(Locale.ROOT)); }
                String land = h(houder, "land").isEmpty() ? "NL" : h(houder, "land");
                Map<String, Object> body = Json.obj("name", Json.obj("first_name", first, "last_name", h(houder, "achternaam"), "initials", ini + "."),
                        "address", Json.obj("street", h(houder, "straat"), "number", h(houder, "huisnummer"), "zipcode", h(houder, "postcode"), "city", h(houder, "plaats"), "country", land.toUpperCase(Locale.ROOT)),
                        "phone", phone, "email", email);
                String company = nonEmpty(h(houder, "bedrijf")) ? h(houder, "bedrijf") : Json.str(a, "company", "name");
                if (nonEmpty(company)) body.put("company_name", company);
                Object r = op.req("POST", "/customers", body);
                handle = Json.str(r, "data", "handle");
                if (!nonEmpty(handle)) throw new IOException("Openprovider gaf geen houder terug");
                steps.add(step("Houder aangemaakt bij Openprovider", true, handle));
            }
            a.put("opHandle", handle);
            deps.save();
            if ("adressen".equals(voor) && nonEmpty(token)) Desec.connect(Json.obj("token", token), zone);
            List<Object> keys = target != null && "desec".equals(target.get("id")) ? opKeys(desecKeys(zone, token).get(0)) : new ArrayList<>();
            Map<String, Object> body = Json.obj("domain", Openprovider.splitDomain(zone), "period", 1L, "autorenew", "on",
                    "owner_handle", handle, "admin_handle", handle, "tech_handle", handle, "billing_handle", handle);
            List<Object> tns = target == null ? Json.list() : Json.listAt(target, "nameservers");
            if (!tns.isEmpty()) {
                List<Object> nsl = new ArrayList<>();
                for (Object n : tns) nsl.add(Json.obj("name", n));
                body.put("name_servers", nsl);
            }
            if (!keys.isEmpty()) { body.put("is_dnssec_enabled", true); body.put("dnssec_keys", keys); }
            Object dr = op.req("POST", "/domains", body);
            Number id = Json.num(dr, "data", "id");
            if (id == null) throw new IOException("Openprovider gaf geen domein-id terug");
            steps.add(step(zone + " gekocht", true, "€ " + bedrag.replace(".", ",") + " per jaar, verlengt elk jaar vanzelf"));
            deps.save();
            return Json.obj("ok", true, "steps", steps, "zone", zone, "id", id.longValue());
        } catch (IOException | RuntimeException e) {
            throw fail(e, steps);
        }
    }

    // ───────── Mail van de Dienst ─────────

    /** TXT value for deSEC and friends: quoted, in parts of at most 255 characters (txtRecord in src/tem.ts). */
    static String txtRecord(String value) {
        String v = value.replaceAll("^\"|\"$", "").replaceAll("\"\\s*\"", "");
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < v.length(); i += 255) parts.add("\"" + v.substring(i, Math.min(v.length(), i + 255)).replace("\"", "\\\"") + "\"");
        return parts.isEmpty() ? "\"\"" : String.join(" ", parts);
    }

    private static List<Object> publishMail(Map<String, Object> a, List<Object> recs) {
        Map<String, Object> d = Json.map(a, "dns");
        if (d == null) return recs;
        String zone = Json.str(d, "zone");
        Adapters.Adapter ad = Adapters.get(Json.str(d, "provider"));
        DnsProvider dns = ad == null || ad.dns == null ? null : ad.dns.create.make("dienst-mail", Json.map(d, "fields"), zone);
        List<Object> out = new ArrayList<>();
        for (Object r : recs) {
            String naam = Json.str(r, "naam");
            String sub = naam.equals(zone) ? "" : naam.endsWith("." + zone) ? naam.substring(0, naam.length() - zone.length() - 1) : null;
            boolean gezet = false;
            if (dns != null && sub != null) {
                try {
                    dns.setRecords(sub, "TXT", java.util.Collections.singletonList(txtRecord(Json.str(r, "waarde"))), 3600);
                    gezet = true;
                } catch (IOException | RuntimeException e) {
                    gezet = false;
                }
            }
            Map<String, Object> o = Json.copy(Json.asMap(r));
            o.put("gezet", gezet);
            out.add(o);
        }
        return out;
    }

    private static Map<String, Object> mailView(Map<String, Object> c, Map<String, Object> a) {
        Map<String, Object> m = Json.map(a, "mail");
        String smtp = Aanbieder.smtpOf(c, a);
        String manier = m != null ? Json.str(m, "manier") : nonEmpty(Json.str(a, "accounts", "smtpUrl")) ? "smtp" : nonEmpty(Json.str(c, "console", "mailRelay")) ? "cloud" : null;
        return Json.obj("manier", manier, "domein", m == null ? null : m.get("domein"), "status", m == null ? null : m.get("status"),
                "records", m != null && m.get("records") != null ? Json.copy(m.get("records")) : Json.list(),
                "smtp", Aanbieder.smtpDisplay(smtp), "afzender", Json.str(a, "accounts", "mailFrom"), "werkt", isTrue(Json.path(a, "checked", "smtp")),
                "cloudRelay", nonEmpty(Json.str(c, "console", "mailRelay")), "pending", a.get("server") != null);
    }

    /** Set up the Dienst's mail: scaleway (TEM), cloud or smtp (mail in TS). */
    public static Map<String, Object> mail(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Map<String, Object> acc = sub(a, "accounts");
        Map<String, Object> ch = sub(a, "checked");
        String manier = Json.str(b, "manier");
        if ("cloud".equals(manier)) {
            String relay = Json.str(c, "console", "mailRelay");
            if (!nonEmpty(relay)) throw new IllegalArgumentException("Je eigen cloud verstuurt nog geen mail");
            acc.remove("smtpUrl");
            a.put("mail", Json.obj("manier", "cloud"));
            ch.put("smtp", isTrue(Aanbieder.checkSmtp(relay).get("ok")));
            deps.save();
            return mailView(c, a);
        }
        if ("smtp".equals(manier)) {
            String url = nz(Json.str(b, "smtpUrl")).trim();
            if (url.isEmpty() && !nonEmpty(Json.str(acc, "smtpUrl"))) throw new IllegalArgumentException("Vul een mailserver in, bijv. smtp://gebruiker:wachtwoord@server:587");
            if (!url.isEmpty()) acc.put("smtpUrl", url);
            String from = nz(Json.str(b, "mailFrom")).trim();
            if (!from.isEmpty()) {
                if (!EMAIL.matcher(from).matches()) throw new IllegalArgumentException("Het afzenderadres is geen geldig e-mailadres");
                acc.put("mailFrom", from);
            }
            a.put("mail", Json.obj("manier", "smtp"));
            Map<String, Object> chk = Aanbieder.checkSmtp(Json.str(acc, "smtpUrl"));
            ch.put("smtp", isTrue(chk.get("ok")));
            deps.save();
            Map<String, Object> out = mailView(c, a);
            out.put("detail", chk.get("detail"));
            return out;
        }
        if (!"scaleway".equals(manier)) throw new IllegalArgumentException("Kies hoe je Dienst mail verstuurt");
        String key = Json.str(acc, "scalewaySecretKey"), org = Json.str(acc, "scalewayOrgId");
        if (!nonEmpty(key) || !nonEmpty(org) || !isTrue(ch.get("scaleway"))) throw new IllegalArgumentException("Regel eerst Scaleway (hierboven): de mail gaat met dezelfde sleutel");
        String host = hostOf(Json.str(a, "url"));
        if (host == null) throw new IllegalArgumentException("Kies eerst het adres van je Dienst");
        String projectId = Aanbieder.ensureProject(a, key, org);
        deps.save();
        String known = host.equals(Json.str(a, "mail", "domein")) ? Json.str(a, "mail", "temDomainId") : null;
        Object dom = Extras.temDomain(key, projectId, host, known);
        Map<String, Object> rec = Extras.temRecords(dom, projectId);
        List<Object> want = new ArrayList<>();
        String spfExtra = nz((String) rec.get("spfExtra"));
        want.add(Json.obj("naam", host, "type", "TXT", "waarde", "v=spf1 " + (spfExtra.isEmpty() ? "include:_spf.tem.scaleway.com" : spfExtra) + " -all", "gezet", false));
        Map<String, Object> dkim = Json.asMap(rec.get("dkim"));
        if (dkim != null) {
            String n = Json.str(dkim, "name").replaceAll("\\.$", "");
            want.add(Json.obj("naam", n.endsWith(host) ? n : Json.str(dkim, "name") + "." + host, "type", "TXT", "waarde", Json.str(dkim, "value"), "gezet", false));
        }
        Map<String, Object> dmarc = Json.asMap(rec.get("dmarc"));
        want.add(Json.obj("naam", "_dmarc." + host, "type", "TXT", "waarde", dmarc != null ? Json.str(dmarc, "value") : "v=DMARC1; p=none", "gezet", false));
        List<Object> records = publishMail(a, want);
        String url = "smtp://" + Bytes.encodeURIComponent(projectId) + ":" + Bytes.encodeURIComponent(key) + "@" + Endpoints.TEM_SMTP;
        acc.put("smtpUrl", url);
        acc.put("mailFrom", "noreply@" + host);
        try { scw("POST", Extras.TEM + "/" + Json.str(dom, "id") + "/check", key, Json.obj()); } catch (IOException | RuntimeException ignored) { /* later opnieuw */ }
        long now = System.currentTimeMillis();
        a.put("mail", Json.obj("manier", "scaleway", "domein", host, "projectId", projectId, "temDomainId", Json.str(dom, "id"),
                "status", Json.path(dom, "status") == null ? "" : Json.jsString(Json.path(dom, "status")), "records", records, "checkAt", now, "at", now));
        ch.put("smtp", isTrue(Aanbieder.checkSmtp(url).get("ok")));
        deps.save();
        return mailView(c, a);
    }

    /** Check the mail again (mailStatus in TS). */
    public static Map<String, Object> mailStatus(Map<String, Object> c, Aanbieder.Deps deps) {
        Map<String, Object> a = readOnly(c);
        Map<String, Object> m = Json.map(a, "mail");
        String key = Json.str(a, "accounts", "scalewaySecretKey");
        if (m != null && "scaleway".equals(m.get("manier")) && nonEmpty(Json.str(m, "temDomainId")) && nonEmpty(key)) {
            try {
                Object dom = scw("GET", Extras.TEM + "/" + Json.str(m, "temDomainId"), key, null);
                Object s = Json.path(dom, "status");
                m.put("status", s != null ? Json.jsString(s) : nz(Json.str(m, "status")));
                Number at = Json.num(m, "checkAt");
                if (!"checked".equals(m.get("status")) && System.currentTimeMillis() - (at == null ? 0 : at.longValue()) > 5 * 60_000L) {
                    m.put("checkAt", System.currentTimeMillis());
                    try { scw("POST", Extras.TEM + "/" + Json.str(m, "temDomainId") + "/check", key, Json.obj()); } catch (IOException | RuntimeException ignored) { /* */ }
                }
                deps.save();
            } catch (IOException | RuntimeException ignored) {
                // volgende keer
            }
        }
        return mailView(c, a);
    }

    // ───────── Openprovider: IP-adres van de server ─────────

    private static Map<String, Object> dienstOpCheck(Map<String, Object> a) {
        if (a.get("server") == null || !nonEmpty(Json.str(a, "url")) || !nonEmpty(Json.str(a, "secret"))) return null;
        Object[] r = getJson(reach(Json.str(a, "url")) + "/v1/status/check/openprovider", beheer(a), 20_000);
        int s = (Integer) r[0];
        if (s == 404) return Json.obj("at", System.currentTimeMillis(), "ok", false, "detail", "Je Dienst kent deze controle nog niet; wacht tot hij is bijgewerkt");
        if (s != 200 || r[1] == null) return Json.obj("at", System.currentTimeMillis(), "ok", false, "detail", "Je Dienst is nu niet bereikbaar");
        return Json.obj("at", System.currentTimeMillis(), "ok", Json.truthy(Json.path(r[1], "ok")), "detail", Json.path(r[1], "detail") == null ? "" : Json.jsString(Json.path(r[1], "detail")));
    }

    private static List<String> serverIps(Map<String, Object> a) {
        List<String> ips = new ArrayList<>();
        for (String k : new String[] {"ipv4", "ipv6"}) if (nonEmpty(Json.str(a, "server", k))) ips.add(Json.str(a, "server", k));
        return ips;
    }

    /** Fields of a contact that PUT /contacts/{id} knows (contactUpdateContactRequest), except id (CONTACT_KEEP in TS). */
    static final List<String> CONTACT_KEEP = Arrays.asList("additional_data", "address", "api_access_enabled", "auth_type", "comments", "company_name", "email", "inn", "is_active", "kpp", "locale", "name", "phone",
            "rcp_client_ip_list", "role", "type", "vat");

    /** Link Openprovider and put the server's IP on the list (openprovider in TS; API IP list = api_client_ip_list). */
    public static Map<String, Object> openprovider(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        Map<String, Object> acc = sub(a, "accounts");
        String u = nz(Json.str(b, "gebruiker")).trim(), p = b.get("wachtwoord") == null ? "" : Json.jsString(b.get("wachtwoord"));
        if (!u.isEmpty()) acc.put("openproviderUser", u);
        if (!p.isEmpty() && !p.startsWith("••")) acc.put("openproviderPass", p);
        if (!nonEmpty(Json.str(acc, "openproviderUser")) || !nonEmpty(Json.str(acc, "openproviderPass"))) throw new IllegalArgumentException("Vul je Openprovider-gebruikersnaam en wachtwoord in");
        Openprovider.Api op = opOf(a);
        Map<String, Object> login;
        try { op.login(); login = Json.obj("ok", true, "detail", "Inloggen werkt"); }
        catch (IOException e) { login = Json.obj("ok", false, "detail", e.getMessage()); }
        boolean loginOk = isTrue(login.get("ok"));
        sub(a, "checked").put("openprovider", loginOk);
        List<String> ips = serverIps(a);
        Map<String, Object> ip = Json.obj("adressen", new ArrayList<Object>(ips), "status", "geen-server", "uitleg", "Zodra je Dienst draait, zet de app het IP-adres van de server op de lijst.");
        Map<String, Object> st = sub(a, "openprovider");
        if (loginOk && !ips.isEmpty()) {
            String user = Json.str(acc, "openproviderUser");
            try {
                Object j = op.req("GET", "/contacts?username_pattern=" + Bytes.encodeURIComponent(user) + "&limit=10", null);
                Object me = null;
                for (Object x : Json.listAt(j, "data", "results")) if (user.toLowerCase(Locale.ROOT).equals(nz(Json.str(x, "username")).toLowerCase(Locale.ROOT))) { me = x; break; }
                if (me == null || Json.path(me, "id") == null) throw new IOException("Kon je API-gebruiker niet vinden");
                long cid = Json.num(me, "id").longValue();
                st.put("contactId", cid);
                List<String> allow = strings(Json.listAt(me, "api_client_ip_list", "allow")), deny = strings(Json.listAt(me, "api_client_ip_list", "deny"));
                List<String> missing = new ArrayList<>();
                for (String x : ips) if (!allow.contains(x)) missing.add(x);
                if (allow.isEmpty()) ip = Json.obj("adressen", new ArrayList<Object>(ips), "status", "open", "uitleg", "Je API-gebruiker heeft geen IP-lijst: elk adres mag. De app laat dat zo.");
                else if (missing.isEmpty()) ip = Json.obj("adressen", new ArrayList<Object>(ips), "status", "staat-erop", "uitleg", "Het IP-adres van je server staat op de lijst.");
                else {
                    List<Object> all = new ArrayList<>(allow);
                    all.addAll(missing);
                    // Everything the contact had goes back (whether PUT only changes the fields sent is not documented).
                    Map<String, Object> body = Json.obj();
                    for (String k : CONTACT_KEEP) { Object v = Json.path(me, k); if (v != null) body.put(k, Json.copy(v)); }
                    body.put("api_client_ip_list", Json.obj("allow", all, "deny", new ArrayList<Object>(deny)));
                    op.req("PUT", "/contacts/" + cid, body);
                    ip = Json.obj("adressen", new ArrayList<Object>(ips), "status", "toegevoegd", "uitleg", "De app heeft " + String.join(" en ", missing) + " op de lijst gezet.");
                }
            } catch (IOException | RuntimeException e) {
                ip = Json.obj("adressen", new ArrayList<Object>(ips), "status", "handmatig", "uitleg", "Zet " + String.join(" en ", ips) + " zelf op de lijst: Openprovider → Account → Contactpersonen → je naam → API → toegestane IP-adressen. (" + e.getMessage() + ")");
            }
        }
        if (loginOk && a.get("server") != null) {
            Map<String, Object> chk = dienstOpCheck(a);
            if (chk != null) st.put("check", chk); else st.remove("check");
        }
        deps.save();
        return Json.obj("ok", loginOk, "login", login, "ip", ip, "dienst", st.get("check") == null ? null : Json.copy(st.get("check")), "link", OP_PANEL_URL, "pending", a.get("server") != null);
    }

    /** Only check (from the Dienst's server): can it reach Openprovider? (openproviderCheck in TS) */
    public static Map<String, Object> openproviderCheck(Map<String, Object> c, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = readOnly(c);
        Map<String, Object> r = dienstOpCheck(a);
        if (r != null) { sub(a, "openprovider").put("check", r); deps.save(); }
        return Json.obj("dienst", r == null ? null : Json.copy(r), "ip", new ArrayList<Object>(serverIps(a)), "link", OP_PANEL_URL);
    }
}
