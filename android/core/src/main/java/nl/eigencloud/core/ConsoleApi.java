package nl.eigencloud.core;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


/**
 * The console's /api routes (src/console/server.ts) without a web server, for the Android app: the same
 * web-console screens call {@link #handle} through a JavaScript bridge. Blocking; call off the UI thread.
 * Dutch error messages, like the desktop console.
 */
public final class ConsoleApi {
    /** Notified when a launched cloud is reachable on its public address. */
    public interface Listener { void cloudReady(String appUrl); }
    public static final class Reply {
        public final int status;
        public final String body;

        Reply(int status, Object json) {
            this.status = status;
            this.body = json == null ? "null" : Json.stringify(json);
        }
    }

    public final Vault vault;
    private final Catalog catalog;
    private final Listener listener;
    private long lastUse;
    /** Inloggen bij de dienst vóór er een kluis is (herstellen op een nieuw apparaat); alleen in het geheugen. */
    private volatile String recoverEmail, recoverToken, recoverBase;
    /** Hoeveel aanbieders de openbare lijst had (bij de laatste keer ophalen). */
    private volatile int knownAanbieders;
    private final Map<String, Object[]> brandCache = new HashMap<>(); // base → {at (Long), brand}

    /** Base URL of the Eigen Cloud Dienst (central paid service); empty = not offered. */
    public volatile String dienstUrl = "";
    /** The vault locks itself after this much idle time (ms). */
    public long idleMs = 15 * 60_000L;

    public ConsoleApi(File vaultFile, Catalog catalog, Listener listener) {
        this.vault = new Vault(vaultFile);
        this.catalog = catalog;
        this.listener = listener;
    }

    // ───────── Starten (zoals startLaunch/followLaunch in server.ts) ─────────

    private Map<String, Object> launch; // {steps, appUrl, done, startedAt}
    /** Every start gets a number; following an older one (e.g. a failed wake while switching providers) then stops. */
    private long launchGen;

    private synchronized void setStep(long gen, String id, String state, String detail) {
        if (gen == launchGen) setStep(id, state, detail);
    }

    private synchronized boolean current(long gen) { return gen == launchGen; }

    private synchronized void setStep(String id, String state, String detail) {
        if (launch == null) return;
        for (Object s : Json.listAt(launch, "steps")) {
            Map<String, Object> m = Json.asMap(s);
            if (id.equals(m.get("id"))) { m.put("state", state); if (detail != null) m.put("detail", detail); }
        }
    }

    private synchronized boolean launching() { return launch != null && !Json.truthy(launch.get("done")); }

    private synchronized Object launchJson() { return launch == null ? null : Json.copy(launch); }

    private Map<String, Object> startLaunch(Map<String, Object> c, Admin.FirstNode first, long term) throws IOException {
        Map<String, Object> offer = catalog.serverOffer(first.provider);
        String city = null;
        if (offer != null) for (Catalog.RegionInfo r : catalog.serverRegions(first.provider)) if (r.id.equals(first.region)) city = r.city;
        String domain = Json.jsString(c.get("domain"));
        final long gen;
        synchronized (this) {
            gen = ++launchGen;
            launch = Json.obj("startedAt", System.currentTimeMillis(), "done", false, "appUrl", null, "steps", Json.list(
                    Json.obj("id", "server", "label", "Server aanmaken bij " + (offer != null ? Json.str(offer, "name") : first.provider) + (city != null ? " in " + city : ""), "state", "busy"),
                    Json.obj("id", "boot", "label", "Opstarten", "state", "wait"),
                    Json.obj("id", "start", "label", term > 0 ? "Gegevens terugzetten" : "Je cloud inrichten", "state", "wait"),
                    Json.obj("id", "grow", "label", "Tweede server en witness erbij", "state", "wait"),
                    Json.obj("id", "https", "label", "Bereikbaar maken op cloud." + domain, "state", "wait")));
        }
        try {
            first.term = term;
            first.initialSettings = term > 0 ? null : Console.initialSettings(c, dienstUrl);
            Admin.Provisioned r = Admin.provisionFirstNode(c, first);
            setStep("server", "done", r.info.ipv4 != null ? "IP-adres " + r.info.ipv4 : "");
            Console.markLaunched(c, first, r);
            vault.save();
            synchronized (this) { launch.put("appUrl", Console.appUrl(c)); }
            Number min = Json.num(c, "policy", "minDataNodes"), wit = Json.num(c, "policy", "witnesses");
            int want = (min == null ? 2 : min.intValue()) + (wit == null ? 1 : wit.intValue());
            String clusterUrl = r.clusterUrl, apiUrl = r.info.apiUrl;
            Thread t = new Thread(() -> {
                try { followLaunch(c, clusterUrl, apiUrl, want, gen); } catch (RuntimeException e) { setStep(gen, "grow", "fail", e.getMessage()); }
            }, "eigen-launch");
            t.setDaemon(true);
            t.start();
            return Json.obj("ok", true, "nodeId", r.nodeId);
        } catch (IOException | RuntimeException e) {
            setStep("server", "fail", e.getMessage());
            synchronized (this) { launch.put("done", true); }
            throw e;
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static boolean http200(String url, int timeout) {
        try { return Http.request("GET", url, null, null, timeout).status == 200; } catch (IOException e) { return false; }
    }

    private void followLaunch(Map<String, Object> c, String clusterUrl, String apiUrl, int want, long gen) {
        byte[] key = ClusterConfig.keysFor(c).cluster;
        long deadline = System.currentTimeMillis() + 45 * 60_000L;
        setStep(gen, "boot", "busy", "Software installeren en starten (meestal 2 à 4 minuten)");
        while (current(gen) && System.currentTimeMillis() < deadline && !http200(clusterUrl + "/cluster/health", 4000)) sleep(3000);
        setStep(gen, "boot", "done", "");
        setStep(gen, "start", "busy", "Back-up terugzetten en de leiding nemen");
        while (current(gen) && System.currentTimeMillis() < deadline) {
            try {
                if ("leader".equals(Transport.rpcObject(key, clusterUrl, Json.obj("type", "status"), 3000).get("role"))) break;
            } catch (IOException | RuntimeException ignored) {
                // nog niet
            }
            sleep(2000);
        }
        setStep(gen, "start", "done", "");
        setStep(gen, "grow", "busy", "Tweede server en witness worden aangemaakt");
        List<String> urls = new ArrayList<>();
        urls.add(clusterUrl);
        while (current(gen) && System.currentTimeMillis() < deadline) {
            Admin.Leader leader = Admin.findLeader(c, urls);
            int ready = 0;
            if (leader != null) {
                try {
                    Map<String, Object> sum = Transport.rpcObject(key, leader.url, Json.obj("type", "clusterSummary"), 5000);
                    for (Object n : Json.listAt(sum, "nodes")) if ("ready".equals(Json.str(n, "status"))) ready++;
                    setStep(gen, "grow", "busy", ready + " van " + want + " servers klaar");
                } catch (IOException | RuntimeException ignored) {
                    // straks opnieuw
                }
            }
            if (ready >= want) break;
            sleep(3000);
        }
        setStep(gen, "grow", "done", want + " servers actief");
        String domain = Json.jsString(c.get("domain"));
        setStep(gen, "https", "busy", "Wachten tot cloud." + domain + " bereikbaar is (DNS en certificaat)");
        String url = Console.appUrl(c) != null ? Console.appUrl(c) : apiUrl;
        while (current(gen) && System.currentTimeMillis() < deadline && url != null && !http200(url + "/healthz", 5000)) sleep(5000);
        setStep(gen, "https", "done", "");
        synchronized (this) {
            if (gen != launchGen) return;
            launch.put("done", true);
        }
        if (listener != null && url != null) listener.cloudReady(url);
    }

    // ───────── Hulpjes ─────────

    private Map<String, Object> cfg() { return vault.config(); }

    /** Bewaren in de kluis; na de start ook de herstelkopie in de opslag en de instellingen naar het cluster. */
    private void save() throws IOException {
        vault.save();
        Map<String, Object> c = cfg();
        if (Json.truthy(Json.path(c, "console", "done"))) {
            Map<String, Object> copy = Json.copy(c);
            Thread t = new Thread(() -> {
                try { Admin.saveAdminCopy(copy); } catch (RuntimeException ignored) { /* volgende keer */ }
                String def = dienstUrl;
                try { Admin.pushAdminConfig(copy, def); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
            }, "eigen-save");
            t.setDaemon(true);
            t.start();
        } else if (Json.truthy(Json.path(c, "console", "alleenDienst"))) {
            // Zonder eigen cloud: de herstelkopie in de back-upbucket van de Dienst (zodra die er is).
            Map<String, Object> copy = Json.copy(c);
            Thread t = new Thread(() -> {
                try { Aanbieder.saveDienstCopy(copy); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
            }, "eigen-save");
            t.setDaemon(true);
            t.start();
        }
    }

    private static String mask(String v) {
        if (v == null || v.isEmpty()) return "";
        return "••••••••" + v.substring(Math.max(0, v.length() - 4));
    }

    private Map<String, Object> sanitized(Map<String, Object> c) {
        List<Object> stores = new ArrayList<>();
        for (Map<String, Object> s : ClusterConfig.stores(c)) {
            Map<String, Object> m = Json.copy(s);
            if (Json.truthy(m.get("accessKey"))) m.put("accessKey", mask(Json.str(m, "accessKey")));
            if (Json.truthy(m.get("secretKey"))) m.put("secretKey", "••••••••");
            stores.add(m);
        }
        Map<String, Object> providers = Json.obj();
        Map<String, Object> pv = Json.map(c, "providers");
        if (pv != null) for (Map.Entry<String, Object> e : pv.entrySet()) {
            Map<String, Object> f = Json.obj();
            Map<String, Object> fields = Json.asMap(e.getValue());
            String type = fields != null && fields.get("type") != null ? Json.jsString(fields.get("type")) : e.getKey();
            if (fields != null) for (Map.Entry<String, Object> x : fields.entrySet()) {
                String v = Json.jsString(x.getValue());
                f.put(x.getKey(), catalog.isSecretField(type, x.getKey()) ? mask(v) : v);
            }
            providers.put(e.getKey(), f);
        }
        List<Object> dns = new ArrayList<>();
        for (Object d : Json.listAt(c, "dns")) {
            Map<String, Object> m = Json.copy(Json.asMap(d));
            // { ...d, token: d.token ? mask(d.token) : undefined, fields?: masked per field }
            if (Json.truthy(m.get("token"))) m.put("token", mask(Json.jsString(m.get("token"))));
            else m.remove("token");
            Map<String, Object> df = Json.map(m, "fields");
            if (df != null) {
                String type = Json.str(m, "type");
                Map<String, Object> masked = Json.obj();
                for (Map.Entry<String, Object> x : df.entrySet()) {
                    String v = Json.jsString(x.getValue());
                    masked.put(x.getKey(), type != null && catalog.isSecretField(type, x.getKey()) ? mask(v) : x.getValue());
                }
                m.put("fields", masked);
            }
            dns.add(m);
        }
        Map<String, Object> con = Json.map(c, "console");
        Object relay = null;
        String relayUrl = Json.str(con, "mailRelay");
        if (relayUrl != null && !relayUrl.isEmpty()) {
            SmtpCheck.Relay r = SmtpCheck.parseRelayUrl(relayUrl);
            if (r != null) relay = r.toPublicJson();
        }
        return Json.obj("cluster", c.get("cluster"), "domain", c.get("domain"), "mailFrom", Json.path(c, "appEnv", "MAIL_FROM"),
                "alertEmail", Json.str(con, "alertEmail") == null ? "" : Json.str(con, "alertEmail"),
                "stores", stores, "providers", providers, "dns", dns,
                "dnsMode", con == null ? null : con.get("dnsMode"), "mailRelay", relay,
                "spfExtra", Json.str(con, "spfExtra") == null ? "" : Json.str(con, "spfExtra"),
                "policy", c.get("policy"), "preset", con == null ? null : con.get("preset"),
                "domainMode", con == null || con.get("domainMode") == null ? "own" : con.get("domainMode"),
                "desec", Json.map(con, "desec") == null ? null : Json.obj("email", Json.str(con, "desec", "email"), "at", Json.path(con, "desec", "at")),
                "quick", con == null ? null : con.get("quick"),
                "dienst", Json.map(con, "dienst") == null ? null : Json.obj("url", Json.path(con, "dienst", "url"), "invite", Json.path(con, "dienst", "invite"),
                        "email", Json.str(con, "dienst", "email"), "loggedIn", Json.str(con, "dienst", "token") != null,
                        "orderId", Json.str(con, "dienst", "orderId"), "bundle", Json.path(con, "dienst", "bundle"), "applied", Json.truthy(Json.path(con, "dienst", "applied"))),
                "maxUsers", con == null || con.get("maxUsers") == null ? (Object) 0L : con.get("maxUsers"),
                "overstap", Json.map(con, "overstap") == null ? null : Json.obj("naar", Json.path(con, "overstap", "naar"), "stap", Json.path(con, "overstap", "stap")),
                "alleenDienst", Json.truthy(Json.path(con, "alleenDienst")),
                "keyCheck", Console.keyCheckState(c));
    }

    /** What /api/state reports about biometric unlock (filled in by the app). */
    public volatile Map<String, Object> biometric = Json.obj("available", false, "enrolled", false);

    // ───────── Router ─────────

    private static Reply ok(Object j) { return new Reply(200, j); }


    private static Reply err(int status, String msg) { return new Reply(status, Json.obj("error", msg)); }

    /** 400 with the error and, when checking itself works, the list of "Sleutels controleren" (checksAfter in server.ts). */
    private Reply checksAfter(Map<String, Object> c, String error, String kind, String id, Map<String, Object> fields) {
        try {
            return err(400, error, "checks", KeyCheck.forConsole(c, catalog, kind, id, fields));
        } catch (IOException | RuntimeException e) {
            return err(400, error);
        }
    }

    /** Error reply with extra fields (e.g. the steps done so far), like {@code reply.code(400).send({error, steps})}. */
    private static Reply err(int status, String msg, Object... extra) {
        Map<String, Object> j = Json.obj("error", msg);
        j.putAll(Json.obj(extra));
        return new Reply(status, j);
    }

    public synchronized boolean unlocked() {
        // Tijdens het overstappen niet op slot: dat loopt op de achtergrond verder en moet de kluis kunnen bijwerken.
        if (vault.isUnlocked() && System.currentTimeMillis() - lastUse > idleMs && lastUse > 0 && !Overstap.busy()) vault.lock();
        return vault.isUnlocked();
    }

    public synchronized void touch() { lastUse = System.currentTimeMillis(); }

    /** One console API call: method, path ("/api/…") and JSON body text (may be empty). */
    public Reply handle(String method, String path, String bodyText) {
        try {
            Map<String, Object> body = bodyText == null || bodyText.isEmpty() ? Json.obj() : Json.parseObject(bodyText);
            return route(method, path, body);
        } catch (IllegalArgumentException | IllegalStateException e) {
            return err(400, e.getMessage());
        } catch (SecurityException e) {
            return err(401, e.getMessage());
        } catch (IOException e) {
            return err(400, e.getMessage());
        } catch (RuntimeException e) {
            return err(500, "Er ging iets mis: " + e);
        }
    }

    /** Waarde uit de querystring (zoals Fastify: + is een spatie), of "" als hij ontbreekt. */
    static String query(String path, String name) {
        int q = path.indexOf('?');
        if (q < 0) return "";
        for (String part : path.substring(q + 1).split("&")) {
            int eq = part.indexOf('=');
            String k = Bytes.decodeURIComponent((eq < 0 ? part : part.substring(0, eq)).replace('+', ' '));
            if (k.equals(name)) return eq < 0 ? "" : Bytes.decodeURIComponent(part.substring(eq + 1).replace('+', ' '));
        }
        return "";
    }

    private final java.util.concurrent.atomic.AtomicBoolean warmed = new java.util.concurrent.atomic.AtomicBoolean();

    /** De lijst van aanbieders (met wie er antwoordt) eenmalig op de achtergrond ophalen (zoals buildConsole in TS). */
    private void warmAanbieders() {
        if (!warmed.compareAndSet(false, true)) return;
        Thread t = new Thread(() -> {
            int reachable = 0;
            for (Object a : Extras.aanbieders(dienstUrl)) if (Boolean.TRUE.equals(Json.path(a, "bereikbaar"))) reachable++;
            knownAanbieders = reachable;
        }, "eigen-aanbieders");
        t.setDaemon(true);
        t.start();
    }

    /** Aanbieder van de huidige kluis (ontgrendeld), anders de standaard van deze versie. */
    private String currentBase() { return Extras.baseOf(vault.isUnlocked() ? cfg() : null, dienstUrl); }

    private Map<String, Object> brandCached(String base) throws IOException {
        synchronized (brandCache) {
            Object[] hit = brandCache.get(base);
            if (hit != null && System.currentTimeMillis() - (Long) hit[0] < 10 * 60_000L) return Json.copy(Json.asMap(hit[1]));
        }
        Map<String, Object> v = Extras.dienstBrand(base);
        synchronized (brandCache) { brandCache.put(base, new Object[] {System.currentTimeMillis(), Json.copy(v)}); }
        return v;
    }

    private static final Pattern STORE = Pattern.compile("^/api/stores/(.+)$"), PROVIDER = Pattern.compile("^/api/providers/(.+)$");

    private Reply route(String method, String path, Map<String, Object> b) throws IOException {
        String p = path.replaceFirst("\\?.*$", "");
        String key = method + " " + p;

        // Zonder ontgrendelen
        switch (key) {
            case "GET /api/state": {
                warmAanbieders();
                Map<String, Object> con = vault.isUnlocked() ? Json.map(cfg(), "console") : null;
                return ok(Json.obj("vault", vault.exists(), "unlocked", unlocked(), "step", con == null ? null : con.get("step"),
                        "done", con != null && Json.truthy(con.get("done")), "domain", vault.isUnlocked() ? cfg().get("domain") : null,
                        "offers", Json.obj("stores", catalog.storeOffers(), "servers", catalog.serverOffers(), "dns", catalog.dnsOffers()),
                        "phone", true, "biometric", biometric,
                        "dienst", !Extras.defaultBase(dienstUrl).isEmpty() || Json.truthy(Json.path(con, "dienst", "url")) || knownAanbieders > 0,
                        "aanbieder", Json.path(con, "dienst", "url"),
                        "domainMode", con == null ? null : con.get("domainMode"),
                        "scaleway", Json.obj("signup", Extras.SCW_SIGNUP_URL, "keys", Extras.SCW_KEYS_URL)));
            }
            case "GET /api/dienst/info":
                return ok(Extras.dienstInfo(currentBase()));
            case "GET /api/dienst/check": {
                String name = "";
                int q = path.indexOf("?name=");
                if (q >= 0) name = Bytes.decodeURIComponent(path.substring(q + 6).replaceFirst("&.*$", ""));
                return ok(Extras.dienstCheck(currentBase(), name));
            }
            // Aanbieders: de openbare lijst, hun huisstijl en uitnodigingscodes.
            case "GET /api/aanbieders": {
                List<Object> list = Extras.aanbieders(dienstUrl);
                int reachable = 0;
                for (Object a : list) if (Boolean.TRUE.equals(Json.path(a, "bereikbaar"))) reachable++;
                knownAanbieders = reachable;
                return ok(Json.obj("aanbieders", list, "gekozen", vault.isUnlocked() ? Json.path(cfg(), "console", "dienst", "url") : null));
            }
            case "GET /api/aanbieder/brand":
                return ok(brandCached(Extras.cleanDienstUrl(query(path, "url"))));
            case "GET /api/aanbieder/invite":
                return ok(Extras.dienstInvite(Extras.cleanDienstUrl(query(path, "url")), query(path, "code")));
            case "POST /api/setup/create": {
                if (vault.exists()) return err(409, "Er is al een kluis. Ontgrendel hem.");
                String mode = Json.str(b, "domainMode") == null ? "own" : Json.str(b, "domainMode");
                String domain = Extras.normalizeDomain(Json.str(b, "domain"), mode);
                String alert = Json.str(b, "alertEmail");
                if ("free".equals(mode) && (alert == null || alert.isEmpty())) return err(400, "Vul een meldadres in; daarmee maakt de console je gratis deSEC-account aan");
                Map<String, Object> c = Console.newAdminConfig(domain, Json.str(b, "mailbox"), alert, Json.str(b, "appPassword"));
                Json.map(c, "console").put("domainMode", mode);
                vault.create(Json.str(b, "passphrase"), c);
                touch();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/setup/aanbieder": {
                // Aanbieder worden zonder eigen cloud: een kluis alleen voor de Dienst.
                if (vault.exists()) return err(409, "Er is al een kluis. Ontgrendel hem.");
                vault.create(Json.str(b, "passphrase") == null ? "" : Json.str(b, "passphrase"), Console.newDienstConfig());
                touch();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/setup/recover": {
                if (vault.exists()) return err(409, "Er is al een kluis op deze telefoon");
                Map<String, Object> c = Console.recoverAdminConfig(Json.str(b, "masterKey"), Json.map(b, "store"));
                vault.create(Json.str(b, "passphrase"), c);
                touch();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/recover/dienst/login": {
                String url = Json.str(b, "url");
                String base = url != null && !url.isEmpty() ? Extras.cleanDienstUrl(url) : Extras.defaultBase(dienstUrl);
                recoverEmail = Extras.dienstStartLogin(base, Json.str(b, "email"));
                recoverBase = base;
                recoverToken = null;
                return ok(Json.obj("ok", true));
            }
            case "POST /api/recover/dienst/verify":
                if (recoverEmail == null) return err(400, "Vul eerst je e-mailadres in");
                recoverToken = Extras.dienstFinishLogin(recoverBase, recoverEmail, Json.str(b, "code"));
                return ok(Json.obj("ok", true));
            case "POST /api/setup/recover-dienst": {
                if (vault.exists()) return err(409, "Er is al een kluis op deze telefoon");
                if (recoverToken == null) return err(400, "Log eerst in bij de dienst");
                Map<String, Object> c = Extras.recoverViaDienst(recoverBase, dienstUrl, recoverEmail, recoverToken, Json.str(b, "masterKey"), catalog);
                vault.create(Json.str(b, "passphrase"), c);
                recoverEmail = null;
                recoverToken = null;
                recoverBase = null;
                touch();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/vault/forget": {
                // Wachtwoordzin vergeten: de kluis van deze telefoon wissen (herstellen kan met de herstelsleutel).
                if (!Boolean.TRUE.equals(b.get("confirm"))) return err(400, "Bevestig dat je de kluis wilt wissen");
                vault.destroy();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/unlock": {
                try {
                    vault.unlock(Json.str(b, "passphrase") == null ? "" : Json.str(b, "passphrase"));
                } catch (SecurityException | IOException e) {
                    sleep(800);
                    return err(401, e.getMessage());
                }
                touch();
                return ok(Json.obj("ok", true));
            }
            default:
                break;
        }

        if (!unlocked()) return err(401, "De kluis is op slot");
        touch();
        Map<String, Object> c = cfg();
        String base = Extras.baseOf(c, dienstUrl);
        Matcher m;

        switch (key) {
            case "POST /api/lock":
                vault.lock();
                return ok(Json.obj("ok", true));
            case "GET /api/config":
                return ok(sanitized(c));
            case "POST /api/step":
                Json.map(c, "console").put("step", Json.str(b, "step"));
                save();
                return ok(Json.obj("ok", true));

            case "GET /api/key": {
                boolean[] changed = { false };
                long ask = Console.keyAsk(c, changed);
                if (changed[0]) save();
                boolean confirmed = Json.truthy(Json.path(c, "console", "keyConfirmed"));
                return ok(Json.obj("groups", Console.keyGroups(c), "check", Console.keyCheck(c), "confirmed", confirmed,
                        "later", !confirmed && Json.truthy(Json.path(c, "console", "keyCheckLater")), "ask", ask));
            }
            case "POST /api/key/confirm": {
                if (b.get("value") == null && (b.get("g3") != null || b.get("g7") != null)) {
                    Console.confirmKey(c, Json.str(b, "g3"), Json.str(b, "g7")); // oude vorm: groep 3 en 7
                } else {
                    boolean[] changed = { false };
                    long ask = Console.keyAsk(c, changed);
                    if (changed[0]) save();
                    Object group = b.get("group") == null ? null : jsNumber(b.get("group"));
                    if (b.get("group") != null && (!(group instanceof Number) || ((Number) group).doubleValue() != ask)) return err(409, "Er wordt nu naar groep " + ask + " gevraagd", "ask", ask);
                    String value = b.get("value") == null ? "" : Json.jsString(b.get("value"));
                    if (!Console.normGroup(value).equals(Console.keyGroups(c).get((int) ask - 1))) return err(400, "Dat is niet groep " + ask + ". Kijk nog eens op je herstelblad.", "ask", ask);
                    Console.keyConfirmed(c);
                }
                save();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/key/new-group": {
                long ask = Console.newKeyGroup(c);
                save();
                return ok(Json.obj("ask", ask));
            }
            case "POST /api/key/later": {
                boolean later = Console.keyLater(c);
                save();
                return ok(Json.obj("ok", true, "later", later));
            }

            case "POST /api/stores": {
                Console.StoreSetup r = Console.addStore(c, catalog, Json.str(b, "offer"), Json.str(b, "region"), Json.str(b, "endpoint"), Json.str(b, "accessKey"),
                        Json.str(b, "secretKey"), Json.str(b, "bucket"), "backup".equals(Json.str(b, "purpose")) ? "backup" : "replica");
                if (r.ok) save();
                List<Object> steps = new ArrayList<>();
                for (Admin.StepResult s : r.steps) steps.add(s.toJson());
                return ok(Json.obj("ok", r.ok, "steps", steps, "name", r.name));
            }

            case "POST /api/providers": {
                Map<String, String> fields = new HashMap<>();
                Map<String, Object> f = Json.map(b, "fields");
                if (f != null) for (Map.Entry<String, Object> e : f.entrySet()) fields.put(e.getKey(), Json.jsString(e.getValue()));
                List<Console.RegionSizes> regions;
                try {
                    regions = Console.connectProvider(c, catalog, Json.str(b, "id"), fields);
                } catch (IOException e) {
                    // Inloggen mislukt: de fout plus het lijstje van "Sleutels controleren" (alleen lezen).
                    if (!String.valueOf(e.getMessage()).startsWith("Inloggen bij ")) throw e;
                    return checksAfter(c, e.getMessage(), "servers", Json.str(b, "id"), f);
                }
                save();
                List<Object> out = new ArrayList<>();
                for (Console.RegionSizes r : regions) {
                    Map<String, Object> x = Json.obj("region", r.region);
                    if (r.data != null) x.put("data", r.data.toJson());
                    if (r.witness != null) x.put("witness", r.witness.toJson());
                    if (r.error != null) x.put("error", r.error);
                    out.add(x);
                }
                return ok(Json.obj("ok", true, "regions", out));
            }

            case "GET /api/presets": {
                List<Object> out = new ArrayList<>();
                for (Catalog.Preset pr : Console.presets(c, catalog)) out.add(pr.toJson());
                return ok(Json.obj("presets", out, "chosen", Json.path(c, "console", "preset")));
            }
            case "POST /api/presets/choose": {
                String id = Json.str(b, "id");
                Console.choosePreset(c, catalog, id);
                save();
                Object chosen = null;
                for (Catalog.Preset pr : Console.presets(c, catalog)) if (pr.id.equals(id)) chosen = pr.toJson();
                return ok(Json.obj("ok", true, "preset", chosen));
            }

            // ── Eén sleutel bij Scaleway: de console regelt opslag, servers en mail ──
            case "POST /api/quick/scaleway":
                return quickScaleway(c, b);
            case "POST /api/quick/off":
                // Terug naar "zelf per onderdeel": de één-sleutel-markering eraf (gekoppelde dingen blijven staan).
                Json.map(c, "console").remove("quick");
                save();
                return ok(Json.obj("ok", true));

            // ── Opnieuw beginnen (alleen vóór de start) ──
            case "POST /api/setup/reset": {
                Map<String, Object> con = Json.map(c, "console");
                if (Json.truthy(Json.path(con, "done")) || Json.truthy(Json.path(con, "firstLaunch"))) return err(409, "Je cloud is al gestart. Opnieuw beginnen kan dan niet meer vanuit de assistent.");
                Map<String, Object> dienst = Json.map(con, "aanbieder");
                if (dienst != null && (dienst.get("server") != null || Json.truthy(dienst.get("removed")) || Json.truthy(Json.path(dienst, "backup", "bucket"))))
                    return err(409, "In deze kluis staat ook je Eigen Cloud Dienst. Wissen kan niet: dan ben je de sleutel van je Dienst kwijt.");
                List<Object> done = new ArrayList<>(), left = new ArrayList<>();
                if (Json.truthy(b.get("cleanup"))) {
                    for (Map<String, Object> st : ClusterConfig.stores(c)) {
                        if (!"s3".equals(st.get("type"))) continue;
                        String why;
                        try { why = new S3Store(st).destroyBucket(); } catch (IOException | RuntimeException e) { why = e.getMessage(); }
                        if (why != null) left.add(Json.jsString(st.get("bucket")) + ": " + why); else done.add("Bucket " + Json.jsString(st.get("bucket")) + " verwijderd");
                    }
                    try {
                        String r = Extras.scwRevokeMail(c);
                        if (r != null) done.add(r);
                    } catch (IOException | RuntimeException e) {
                        left.add("Maildomein: " + e.getMessage());
                    }
                }
                vault.destroy();
                return ok(Json.obj("ok", true, "done", done, "left", left));
            }

            case "POST /api/dns": {
                Object tok = b.get("token");
                DnsSetup.Result r;
                try {
                    r = DnsSetup.configure(c, catalog, Json.str(b, "mode"), tok instanceof String ? (String) tok : null, Json.map(b, "fields"));
                } catch (IOException | IllegalArgumentException e) {
                    Adapters.Adapter a = Json.str(b, "mode") == null ? null : Adapters.get(Json.str(b, "mode"));
                    if (a == null || a.dns == null || String.valueOf(e.getMessage()).startsWith("Vul ")) throw e;
                    Map<String, Object> given = Json.obj();
                    if (Json.map(b, "fields") != null) given.putAll(Json.map(b, "fields"));
                    if (tok instanceof String && !((String) tok).isEmpty()) given.put("token", tok);
                    return checksAfter(c, e.getMessage(), "dns", Json.str(b, "mode"), given);
                }
                save();
                return ok(r.toJson());
            }
            // ── Sleutels controleren (alleen lezen) ──
            case "POST /api/check":
                return ok(Json.obj("checks", KeyCheck.forConsole(c, catalog, Json.str(b, "kind"), Json.str(b, "id"), Json.map(b, "fields"))));

            case "GET /api/dns/check": {
                List<Object> ns = Json.listAt(c, "console", "nameservers");
                List<String> nsl = new ArrayList<>();
                for (Object x : ns) nsl.add(Json.jsString(x));
                String d = Json.jsString(c.get("domain"));
                return ok(Json.obj("ns", ns.isEmpty() ? null : ns, "delegated", ns.isEmpty() ? null : DnsSetup.delegated(d, nsl), "current", new ArrayList<Object>(DnsSetup.resolveNs(d))));
            }

            case "POST /api/mail": {
                Map<String, Object> r = Json.map(b, "relay");
                SmtpCheck.Relay relay = null;
                if (r != null) {
                    Number port = Json.num(r, "port");
                    relay = new SmtpCheck.Relay(Json.str(r, "host"), port == null ? 587 : port.intValue(), Json.str(r, "user"), Json.str(r, "password"), Json.truthy(r.get("secure")));
                }
                boolean tested = SmtpCheck.configure(c, relay, Json.str(b, "spfExtra"), Json.truthy(b.get("sendTest")));
                save();
                return ok(Json.obj("ok", true, "tested", tested));
            }

            case "POST /api/setup/domain": {
                if (Json.truthy(Json.path(c, "console", "done"))) return err(409, "Je cloud draait al; het domein wijzigen kan dan niet meer hier");
                String mode = Json.str(b, "domainMode") == null ? "own" : Json.str(b, "domainMode");
                Object before = c.get("domain");
                Extras.changeDomain(c, Extras.normalizeDomain(Json.str(b, "domain"), mode), mode);
                // Mail via Scaleway hoort bij het domein: bij een ander domein opnieuw aanmelden.
                Map<String, Object> con = Json.map(c, "console");
                String scwSecret = Json.str(c, "providers", "scaleway", "secretKey"), scwProject = Json.str(c, "providers", "scaleway", "projectId");
                if (Json.truthy(con.get("quick")) && !c.get("domain").equals(before) && Json.truthy(scwSecret) && Json.truthy(scwProject)) {
                    try { Extras.scwRevokeMail(c); } catch (IOException | RuntimeException ignored) { /* zoals .catch(() => null) */ }
                    con.remove("temDomainId");
                    try {
                        Extras.scwMail(c, scwSecret, scwProject);
                    } catch (IOException | RuntimeException e) {
                        con.put("mailRelay", "");
                        con.put("extraDns", Json.list());
                    }
                }
                save();
                return ok(Json.obj("ok", true, "domain", c.get("domain")));
            }
            case "POST /api/desec/captcha":
                return ok(Extras.desecCaptcha());
            case "POST /api/desec/register": {
                Map<String, Object> r = Extras.desecRegister(c, Json.str(b, "captchaId"), Json.str(b, "solution"), Json.str(b, "email"));
                save();
                return ok(r);
            }
            case "POST /api/desec/finish": {
                String token;
                try {
                    token = Extras.desecFinish(c);
                } finally {
                    save();
                }
                if (token == null) return ok(Json.obj("pending", true, "email", Json.str(c, "console", "desec", "email")));
                DnsSetup.Result r = DnsSetup.configure(c, catalog, "desec", token);
                save();
                return ok(r.toJson());
            }
            // ── Aanbieder kiezen, huisstijl, hulpvragen, berichten, gebruikers ──
            case "POST /api/dienst/select": {
                String invite = Json.str(b, "invite");
                Map<String, Object> r = Extras.dienstSelect(c, dienstUrl, Json.str(b, "url") == null ? "" : Json.str(b, "url"), invite == null || invite.isEmpty() ? null : invite);
                save();
                return ok(r);
            }
            case "GET /api/dienst/brand": {
                if (base.isEmpty()) return ok(Json.obj("url", null));
                try {
                    return ok(brandCached(base));
                } catch (IOException | RuntimeException e) {
                    return err(502, e.getMessage());
                }
            }
            case "GET /api/dienst/tickets":
                return ok(Extras.dienstTickets(base, c));
            case "POST /api/dienst/tickets":
                return ok(Extras.dienstNewTicket(base, c, b));
            case "GET /api/dienst/ticket":
                return ok(Extras.dienstTicket(base, c, query(path, "id")));
            case "POST /api/dienst/ticket/reply":
                return ok(Extras.dienstTicketReply(base, c, Json.str(b, "id") == null ? "" : Json.str(b, "id"), Json.str(b, "message") == null ? "" : Json.str(b, "message")));
            case "GET /api/dienst/announcements":
                return ok(Extras.dienstAnnouncements(base, c));
            case "POST /api/dienst/users": {
                Map<String, Object> r = Extras.dienstSetUsers(base, c, jsNumber(b.get("count")));
                save();
                return ok(r);
            }

            case "POST /api/dienst/login": {
                Map<String, Object> r = Extras.dienstLogin(base, c, Json.str(b, "email"));
                save();
                return ok(r);
            }
            case "POST /api/dienst/verify": {
                Map<String, Object> r = Extras.dienstVerify(base, c, Json.str(b, "code"));
                save();
                return ok(r);
            }
            case "POST /api/dienst/order": {
                Map<String, Object> r = Extras.dienstOrder(base, c, b);
                save();
                return ok(r);
            }
            case "GET /api/dienst/status":
                return ok(Extras.dienstStatus(base, c));
            case "GET /api/dienst/billing":
                return ok(Extras.dienstBilling(base, c));
            case "POST /api/dienst/bundle": {
                Map<String, Object> r = Extras.dienstChangeBundle(base, c, Json.str(b, "bundle"));
                save();
                if (Json.truthy(Json.path(c, "console", "done"))) {
                    Admin.Status st = Admin.clusterStatus(c, Console.knownUrls(c));
                    if (st.leaderUrl != null) {
                        try { Admin.setPolicy(c, st.leaderUrl, Json.map(r, "policy")); } catch (IOException ignored) { /* volgende keer via de beheerconfiguratie */ }
                    }
                }
                return ok(r);
            }
            case "POST /api/dienst/payment-method":
            case "POST /api/dienst/settle":
            case "POST /api/dienst/cancel":
            case "POST /api/dienst/resume":
                return ok(Extras.dienstAction(base, c, p.substring("/api/dienst/".length())));
            case "GET /api/dienst/authcode":
                return ok(Extras.dienstAuthcode(base, c));
            case "GET /api/dienst/invoice": {
                int q = path.indexOf("?id=");
                return ok(Extras.dienstInvoice(base, c, q < 0 ? "" : Bytes.decodeURIComponent(path.substring(q + 4).replaceFirst("&.*$", ""))));
            }
            case "POST /api/dienst/apply": {
                try {
                    return ok(Extras.dienstApply(base, c, catalog));
                } finally {
                    save();
                }
            }

            // ── Overstappen naar een andere aanbieder of naar zelf beheren ──
            case "GET /api/overstap": {
                if (Overstap.refresh(c)) vault.save();
                Overstap.ensureRunning(overstapDeps());
                return ok(Overstap.view(c));
            }
            case "POST /api/overstap/start": {
                Map<String, Object> r = Overstap.start(c, Json.str(b, "naar") == null ? "" : Json.str(b, "naar"), dienstUrl);
                save();
                return ok(r);
            }
            case "POST /api/overstap/login": {
                Map<String, Object> r = Overstap.login(c, Json.str(b, "email"));
                vault.save();
                return ok(r);
            }
            case "POST /api/overstap/verify": {
                Map<String, Object> r = Overstap.verify(c, Json.str(b, "code"));
                vault.save();
                return ok(r);
            }
            case "POST /api/overstap/order": {
                Map<String, Object> r = Overstap.order(c, b);
                vault.save();
                return ok(r);
            }
            case "POST /api/overstap/zelf": {
                Map<String, Object> r = Overstap.zelf(c, b);
                vault.save();
                return ok(r);
            }
            case "POST /api/overstap/nu":
                return ok(Overstap.overzetten(overstapDeps(), b.get("confirm")));
            case "POST /api/overstap/terug":
                return ok(Overstap.terug(overstapDeps()));
            case "POST /api/overstap/stoppen":
                return ok(Overstap.stoppen(overstapDeps()));

            // ── Aanbieder worden: je eigen Eigen Cloud Dienst opzetten en bijhouden ──
            case "GET /api/aanbieder":
                return ok(Aanbieder.view(c, aanbiederDeps()));
            // ── Wat je nodig hebt om aanbieder te worden, en het regelen ervan (Benodigdheden) ──
            case "GET /api/aanbieder/benodigdheden":
                return ok(Benodigdheden.benodigdheden(c, "1".equals(query(path, "fresh")), aanbiederDeps()));
            case "POST /api/aanbieder/scaleway":
                try {
                    return ok(Benodigdheden.scaleway(c, b, aanbiederDeps()));
                } catch (Benodigdheden.StepsException e) {
                    save();
                    return err(400, e.getMessage(), "steps", e.steps);
                }
            case "POST /api/aanbieder/mollie":
                try {
                    Map<String, Object> r = Benodigdheden.mollie(c, b);
                    save();
                    return ok(r);
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "POST /api/aanbieder/desec/register": {
                Map<String, Object> r = Benodigdheden.desecRegister(c, b);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/desec/finish":
                try {
                    Map<String, Object> r = Benodigdheden.desecFinish(c, b);
                    save();
                    return ok(r);
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "POST /api/aanbieder/domein":
                return ok(Benodigdheden.domein(c, b, aanbiederDeps()));
            case "POST /api/aanbieder/domein/delegeren":
                try {
                    return ok(Benodigdheden.delegeren(c, b, aanbiederDeps()));
                } catch (Benodigdheden.StepsException e) {
                    return err(400, e.getMessage(), "steps", e.steps);
                }
            case "POST /api/aanbieder/domein/kopen":
                try {
                    return ok(Benodigdheden.kopen(c, b, aanbiederDeps()));
                } catch (Benodigdheden.StepsException e) {
                    return err(400, e.getMessage(), "steps", e.steps);
                }
            case "GET /api/aanbieder/mail":
                return ok(Benodigdheden.mailStatus(c, aanbiederDeps()));
            case "POST /api/aanbieder/mail":
                try {
                    return ok(Benodigdheden.mail(c, b, aanbiederDeps()));
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "GET /api/aanbieder/openprovider":
                return ok(Benodigdheden.openproviderCheck(c, aanbiederDeps()));
            case "POST /api/aanbieder/openprovider":
                try {
                    return ok(Benodigdheden.openprovider(c, b, aanbiederDeps()));
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "POST /api/aanbieder/stap": {
                Map<String, Object> r = Aanbieder.setStep(c, Json.str(b, "step") == null ? "" : Json.str(b, "step"));
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/bedrijf": {
                Map<String, Object> r = Aanbieder.saveBedrijf(c, b);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/accounts": {
                Map<String, Object> r = Aanbieder.saveAccounts(c, b);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/adres": {
                Map<String, Object> r = Aanbieder.saveAdres(c, b);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/adressen": {
                Map<String, Object> r = Aanbieder.saveAdressen(c, b);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/toepassen":
                return ok(Aanbieder.toepassen(c, aanbiederDeps()));
            case "POST /api/aanbieder/server": {
                Map<String, Object> r = Aanbieder.saveServer(c, b, aanbiederDeps());
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/backup": {
                Map<String, Object> r = Aanbieder.saveBackup(c, b, aanbiederDeps());
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/opzetten":
                try {
                    return ok(Aanbieder.opzetten(c, aanbiederDeps()));
                } catch (Aanbieder.SetupException e) {
                    return err(400, e.getMessage(), "steps", e.steps);
                }
            case "GET /api/aanbieder/status":
                return ok(Aanbieder.status(c, aanbiederDeps()));
            case "POST /api/aanbieder/verwijderen":
                return ok(Aanbieder.verwijderen(c, b, aanbiederDeps()));
            case "POST /api/aanbieder/dns":
                try {
                    Map<String, Object> r = Aanbieder.saveDns(c, b, aanbiederDeps());
                    save();
                    return ok(r);
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "POST /api/aanbieder/hersteltest":
                return ok(Aanbieder.hersteltest(c, aanbiederDeps()));
            // ── Op de lijst via GitHub, voorwaarden en privacy, zonelimiet bij deSEC (GitHub, DienstVoorwaarden, ZoneLimiet) ──
            case "GET /api/aanbieder/lijst":
                return ok(GitHub.view(c, this::save));
            case "POST /api/github/koppelen": {
                Map<String, Object> r = GitHub.koppelen(c, b);
                save();
                return ok(r);
            }
            case "POST /api/github/ontkoppelen": {
                Map<String, Object> r = GitHub.ontkoppelen(c);
                save();
                return ok(r);
            }
            case "POST /api/aanbieder/lijst/aanmelden":
                try {
                    Map<String, Object> r = GitHub.aanmelden(c, b);
                    save();
                    return ok(r);
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "POST /api/aanbieder/lijst/samenvoegen":
                try {
                    Map<String, Object> r = GitHub.samenvoegen(c, b);
                    save();
                    return ok(r);
                } catch (IOException | RuntimeException e) {
                    save();
                    throw e;
                }
            case "GET /api/aanbieder/juridisch":
                return ok(DienstVoorwaarden.status(c));
            case "GET /api/aanbieder/zonelimiet":
                return ok(ZoneLimiet.status(c, query(path, "welke")));
            case "POST /api/setup/cloud": {
                // Kluis alleen voor een Dienst: er komt toch een eigen cloud bij.
                if (!Json.truthy(Json.path(c, "console", "alleenDienst"))) return err(409, "Je hebt al een eigen cloud");
                String mode = Json.str(b, "domainMode") == null ? "own" : Json.str(b, "domainMode");
                String domain = Extras.normalizeDomain(Json.str(b, "domain"), mode);
                String alert = Json.str(b, "alertEmail");
                if ("free".equals(mode) && (alert == null || alert.isEmpty())) return err(400, "Vul een meldadres in; daarmee maakt de console je gratis deSEC-account aan");
                String step = Console.addCloud(c, domain, mode, Json.str(b, "mailbox"), alert, Json.str(b, "appPassword"));
                save();
                return ok(Json.obj("ok", true, "step", step));
            }

            case "GET /api/checklist":
                return ok(Console.checklist(c));

            case "POST /api/launch": {
                String blocker = Console.launchBlocker(c);
                if (blocker != null) return err(400, blocker);
                if (launching()) return err(409, "Er wordt al gestart");
                Admin.FirstNode first = Console.firstPlacement(c);
                Map<String, Object> env = Json.map(c, "appEnv");
                if (env != null) env.put("SMTP_RELAY", "");
                Admin.saveAdminCopy(c);
                return ok(startLaunch(c, first, 0));
            }
            case "GET /api/launch":
                return ok(launchJson());

            case "GET /api/status": {
                Admin.Status st = Admin.clusterStatus(c, Console.knownUrls(c));
                return ok(Json.obj("state", Console.state(st, launching()), "domain", c.get("domain"), "appUrl", Console.appUrl(c),
                        "manifest", st.manifest, "live", st.live, "launch", launchJson()));
            }
            case "GET /api/costs": {
                Admin.Status st = Admin.clusterStatus(c, Console.knownUrls(c));
                return ok(Costs.view(c, st.manifest, st.live, catalog, "1".equals(query(path, "fresh"))));
            }
            case "POST /api/costs/budget": {
                Map<String, Object> r = Costs.setBudget(c, b.get("budget"));
                save();
                return ok(r);
            }
            case "POST /api/action": {
                Admin.Status st = Admin.clusterStatus(c, Console.knownUrls(c));
                if (st.leaderUrl == null) return err(409, "Het cluster is niet bereikbaar");
                Map<String, Object> r = Admin.sendJob(c, st.leaderUrl, Json.str(b, "type"), Json.map(b, "params"));
                if (!Json.truthy(r.get("ok"))) return err(400, Json.str(r, "error") != null ? Json.str(r, "error") : "Mislukt");
                return ok(r);
            }
            case "PUT /api/policy": {
                Map<String, Object> pol = Console.policyChange(c, b);
                save();
                Admin.saveAdminCopy(c);
                Admin.Status st = Admin.clusterStatus(c, Console.knownUrls(c));
                if (st.leaderUrl != null) {
                    try { Admin.setPolicy(c, st.leaderUrl, pol); } catch (IOException ignored) { /* wordt bij de volgende push alsnog gezet */ }
                }
                return ok(Json.obj("ok", true));
            }
            case "POST /api/wake": {
                Map<String, Object> man = Admin.readManifest(c);
                if (man != null && !"asleep".equals(man.get("state")) && !Admin.probeCluster(c, man).isEmpty()) return err(409, "Je cloud is al wakker");
                if (launching()) return err(409, "Er wordt al gestart");
                Admin.FirstNode first = Console.wakeTarget(c, man);
                return ok(startLaunch(c, first, man == null ? 1 : Console.wakeTerm(man)));
            }
            default:
                break;
        }

        if ("DELETE".equals(method) && (m = STORE.matcher(p)).matches()) {
            Console.removeStore(c, Bytes.decodeURIComponent(m.group(1)));
            save();
            return ok(Json.obj("ok", true));
        }
        if ("DELETE".equals(method) && (m = PROVIDER.matcher(p)).matches()) {
            Console.removeProvider(c, Bytes.decodeURIComponent(m.group(1)));
            save();
            return ok(Json.obj("ok", true));
        }
        return err(404, "Onbekend: " + key);
    }

    /** Wat het overstappen nodig heeft van de console. */
    private Overstap.Deps overstapDeps() {
        return new Overstap.Deps() {
            @Override public Map<String, Object> cfg() { return vault.isUnlocked() ? vault.config() : null; }

            @Override public void save() throws IOException { ConsoleApi.this.save(); }

            @Override public void saveVault() throws IOException { vault.save(); }

            @Override public Catalog catalog() { return catalog; }

            @Override public String launch(Map<String, Object> c, Admin.FirstNode first, long term, Map<String, Object> adminOverride) throws IOException {
                first.adminOverride = adminOverride;
                startLaunch(c, first, term);
                return Json.str(c, "console", "firstLaunch", "clusterUrl");
            }
        };
    }

    /** Wat Aanbieder nodig heeft: de aanbieders en opslag uit de catalogus, en bewaren. */
    private Aanbieder.Deps aanbiederDeps() {
        return new Aanbieder.Deps() {
            @Override public List<Map<String, Object>> serverOffers() { return catalog.serverOffers(); }

            @Override public List<Map<String, Object>> storeOffers() { return catalog.storeOffers(); }

            @Override public List<Map<String, Object>> dnsOffers() { return catalog.dnsOffers(); }

            @Override public void save() throws IOException { ConsoleApi.this.save(); }
        };
    }

    /** JS {@code Number(v ?? 0)} for a JSON value: a number, or null for NaN (as JSON.stringify writes it). */
    static Object jsNumber(Object v) {
        if (v == null) return 0L;
        if (v instanceof Number) return v;
        if (v instanceof Boolean) return (Boolean) v ? 1L : 0L;
        if (v instanceof String) {
            String t = ((String) v).trim();
            if (t.isEmpty()) return 0L;
            try {
                double d = Double.parseDouble(t);
                if (Double.isInfinite(d) || Double.isNaN(d)) return null;
                return d == Math.rint(d) && Math.abs(d) < 9.007199254740992E15 ? (Object) (long) d : (Object) d;
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static Map<String, Object> step(String label, boolean ok, String detail) {
        Map<String, Object> s = Json.obj("label", label, "ok", ok);
        if (detail != null) s.put("detail", detail);
        return s;
    }

    /** "ongeveer € 13,34": toFixed(2) met een komma. */
    static String euro(double v) {
        return new java.math.BigDecimal(v).setScale(2, java.math.RoundingMode.HALF_UP).toPlainString().replace(".", ",");
    }

    /** POST /api/quick/scaleway: met één sleutel opslag (Amsterdam + Parijs), servers en mail bij Scaleway klaarzetten. */
    private Reply quickScaleway(Map<String, Object> c, Map<String, Object> b) throws IOException {
        List<Object> steps = new ArrayList<>();
        try {
            String[] keys = Extras.scwKeys(Json.str(b, "accessKey"), Json.str(b, "secretKey"));
            String accessKey = keys[0], secretKey = keys[1];
            String projectId = Extras.scwProject(accessKey, secretKey, Json.str(b, "projectId"));
            steps.add(step("Sleutel werkt", true, null));
            Map<String, String> fields = new HashMap<>();
            fields.put("secretKey", secretKey);
            fields.put("projectId", projectId);
            List<Console.RegionSizes> regions = Console.connectProvider(c, catalog, "scaleway", fields);
            vault.save();
            boolean priced = false;
            String firstError = null;
            for (Console.RegionSizes r : regions) {
                if (r.data != null) priced = true;
                if (firstError == null && r.error != null && !r.error.isEmpty()) firstError = r.error;
            }
            if (!priced) throw new IOException("Scaleway gaf geen serverprijzen: " + (firstError != null ? firstError : "onbekend"));
            steps.add(step("Servers en prijzen opgehaald", true, null));
            String[][] stores = {{"nl-ams", "replica", "Opslag in Amsterdam"}, {"fr-par", "backup", "Back-up in Parijs, 30 dagen niet te wissen"}};
            for (String[] s : stores) {
                Console.StoreSetup r = Console.addStore(c, catalog, "scaleway", s[0], null, accessKey, secretKey, null, s[1]);
                if (!r.ok) {
                    List<String> why = new ArrayList<>();
                    for (Admin.StepResult x : r.steps) if (!x.ok) why.add(x.label + (x.detail != null && !x.detail.isEmpty() ? " (" + x.detail + ")" : ""));
                    throw new IOException(s[2] + ": " + String.join(", ", why));
                }
                vault.save();
                steps.add(step(s[2], true, null));
            }
            Console.choosePreset(c, catalog, "nl");
            vault.save();
            Catalog.Preset preset = null;
            for (Catalog.Preset pr : Console.presets(c, catalog)) if (pr.id.equals("nl")) preset = pr;
            steps.add(step("Servers: " + preset.title, true, preset.monthly != null ? "ongeveer € " + euro(preset.monthly) + " per maand bij Scaleway, plus een paar euro voor opslag" : null));
            try {
                Map<String, Object> m = Extras.scwMail(c, secretKey, projectId);
                steps.add(step("Mail versturen via Scaleway", true, Json.str(m, "detail")));
            } catch (IOException | RuntimeException e) {
                steps.add(step("Mail versturen via Scaleway", false, e.getMessage() + ". Je kunt dit later bij Mail regelen; je cloud werkt ook zonder."));
            }
            Map<String, Object> con = Json.map(c, "console");
            con.put("quick", "scaleway");
            con.put("preset", preset.id);
            save();
            return ok(Json.obj("ok", true, "steps", steps, "monthly", preset.monthly));
        } catch (IOException | RuntimeException e) {
            save();
            return err(400, e.getMessage(), "steps", steps);
        }
    }

    /** The recovery sheet HTML (to print or save as PDF). */
    public String recoverySheet() {
        if (!unlocked()) throw new SecurityException("De kluis is op slot");
        return Console.recoverySheet(cfg());
    }
}
