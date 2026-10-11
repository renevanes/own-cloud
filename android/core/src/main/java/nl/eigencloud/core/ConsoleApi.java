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
    private volatile String recoverEmail, recoverToken;

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
        synchronized (this) {
            launch = Json.obj("startedAt", System.currentTimeMillis(), "done", false, "appUrl", null, "steps", Json.list(
                    Json.obj("id", "server", "label", "Server aanmaken bij " + (offer != null ? Json.str(offer, "name") : first.provider) + (city != null ? " in " + city : ""), "state", "busy"),
                    Json.obj("id", "boot", "label", "Opstarten", "state", "wait"),
                    Json.obj("id", "start", "label", term > 0 ? "Gegevens terugzetten" : "Je cloud inrichten", "state", "wait"),
                    Json.obj("id", "grow", "label", "Tweede server en witness erbij", "state", "wait"),
                    Json.obj("id", "https", "label", "Bereikbaar maken op cloud." + domain, "state", "wait")));
        }
        try {
            first.term = term;
            first.initialSettings = term > 0 ? null : Console.initialSettings(c);
            Admin.Provisioned r = Admin.provisionFirstNode(c, first);
            setStep("server", "done", r.info.ipv4 != null ? "IP-adres " + r.info.ipv4 : "");
            Console.markLaunched(c, first, r);
            vault.save();
            synchronized (this) { launch.put("appUrl", Console.appUrl(c)); }
            Number min = Json.num(c, "policy", "minDataNodes"), wit = Json.num(c, "policy", "witnesses");
            int want = (min == null ? 2 : min.intValue()) + (wit == null ? 1 : wit.intValue());
            String clusterUrl = r.clusterUrl, apiUrl = r.info.apiUrl;
            Thread t = new Thread(() -> {
                try { followLaunch(c, clusterUrl, apiUrl, want); } catch (RuntimeException e) { setStep("grow", "fail", e.getMessage()); }
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

    private void followLaunch(Map<String, Object> c, String clusterUrl, String apiUrl, int want) {
        byte[] key = ClusterConfig.keysFor(c).cluster;
        long deadline = System.currentTimeMillis() + 45 * 60_000L;
        setStep("boot", "busy", "Software installeren en starten (meestal 2 à 4 minuten)");
        while (System.currentTimeMillis() < deadline && !http200(clusterUrl + "/cluster/health", 4000)) sleep(3000);
        setStep("boot", "done", "");
        setStep("start", "busy", "Back-up terugzetten en de leiding nemen");
        while (System.currentTimeMillis() < deadline) {
            try {
                if ("leader".equals(Transport.rpcObject(key, clusterUrl, Json.obj("type", "status"), 3000).get("role"))) break;
            } catch (IOException | RuntimeException ignored) {
                // nog niet
            }
            sleep(2000);
        }
        setStep("start", "done", "");
        setStep("grow", "busy", "Tweede server en witness worden aangemaakt");
        List<String> urls = new ArrayList<>();
        urls.add(clusterUrl);
        while (System.currentTimeMillis() < deadline) {
            Admin.Leader leader = Admin.findLeader(c, urls);
            int ready = 0;
            if (leader != null) {
                try {
                    Map<String, Object> sum = Transport.rpcObject(key, leader.url, Json.obj("type", "clusterSummary"), 5000);
                    for (Object n : Json.listAt(sum, "nodes")) if ("ready".equals(Json.str(n, "status"))) ready++;
                    setStep("grow", "busy", ready + " van " + want + " servers klaar");
                } catch (IOException | RuntimeException ignored) {
                    // straks opnieuw
                }
            }
            if (ready >= want) break;
            sleep(3000);
        }
        setStep("grow", "done", want + " servers actief");
        String domain = Json.jsString(c.get("domain"));
        setStep("https", "busy", "Wachten tot cloud." + domain + " bereikbaar is (DNS en certificaat)");
        String url = Console.appUrl(c) != null ? Console.appUrl(c) : apiUrl;
        while (System.currentTimeMillis() < deadline && url != null && !http200(url + "/healthz", 5000)) sleep(5000);
        setStep("https", "done", "");
        synchronized (this) { launch.put("done", true); }
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
                try { Admin.pushAdminConfig(copy); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
            }, "eigen-save");
            t.setDaemon(true);
            t.start();
        }
    }

    private static String mask(String v) {
        if (v == null || v.isEmpty()) return "";
        return "••••••••" + v.substring(Math.max(0, v.length() - 4));
    }

    private static final Pattern SECRET = Pattern.compile("token|secret|password", Pattern.CASE_INSENSITIVE);

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
            if (fields != null) for (Map.Entry<String, Object> x : fields.entrySet()) {
                String v = Json.jsString(x.getValue());
                f.put(x.getKey(), SECRET.matcher(x.getKey()).find() ? mask(v) : v);
            }
            providers.put(e.getKey(), f);
        }
        List<Object> dns = new ArrayList<>();
        for (Object d : Json.listAt(c, "dns")) {
            Map<String, Object> m = Json.copy(Json.asMap(d));
            if (Json.truthy(m.get("token"))) m.put("token", mask(Json.str(m, "token")));
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
                "dienst", Json.map(con, "dienst") == null ? null : Json.obj("email", Json.str(con, "dienst", "email"), "loggedIn", Json.str(con, "dienst", "token") != null,
                        "orderId", Json.str(con, "dienst", "orderId"), "bundle", Json.path(con, "dienst", "bundle"), "applied", Json.truthy(Json.path(con, "dienst", "applied"))));
    }

    /** What /api/state reports about biometric unlock (filled in by the app). */
    public volatile Map<String, Object> biometric = Json.obj("available", false, "enrolled", false);

    // ───────── Router ─────────

    private static Reply ok(Object j) { return new Reply(200, j); }

    private static Reply err(int status, String msg) { return new Reply(status, Json.obj("error", msg)); }

    /** Error reply with extra fields (e.g. the steps done so far), like {@code reply.code(400).send({error, steps})}. */
    private static Reply err(int status, String msg, Object... extra) {
        Map<String, Object> j = Json.obj("error", msg);
        j.putAll(Json.obj(extra));
        return new Reply(status, j);
    }

    public synchronized boolean unlocked() {
        if (vault.isUnlocked() && System.currentTimeMillis() - lastUse > idleMs && lastUse > 0) vault.lock();
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

    private static final Pattern STORE = Pattern.compile("^/api/stores/(.+)$"), PROVIDER = Pattern.compile("^/api/providers/(.+)$");

    private Reply route(String method, String path, Map<String, Object> b) throws IOException {
        String p = path.replaceFirst("\\?.*$", "");
        String key = method + " " + p;

        // Zonder ontgrendelen
        switch (key) {
            case "GET /api/state": {
                Map<String, Object> con = vault.isUnlocked() ? Json.map(cfg(), "console") : null;
                return ok(Json.obj("vault", vault.exists(), "unlocked", unlocked(), "step", con == null ? null : con.get("step"),
                        "done", con != null && Json.truthy(con.get("done")), "domain", vault.isUnlocked() ? cfg().get("domain") : null,
                        "offers", Json.obj("stores", catalog.storeOffers(), "servers", catalog.serverOffers()),
                        "phone", true, "biometric", biometric, "dienst", dienstUrl != null && !dienstUrl.isEmpty(),
                        "domainMode", con == null ? null : con.get("domainMode"),
                        "scaleway", Json.obj("signup", Extras.SCW_SIGNUP_URL, "keys", Extras.SCW_KEYS_URL)));
            }
            case "GET /api/dienst/info":
                return ok(Extras.dienstInfo(dienstUrl));
            case "GET /api/dienst/check": {
                String name = "";
                int q = path.indexOf("?name=");
                if (q >= 0) name = Bytes.decodeURIComponent(path.substring(q + 6).replaceFirst("&.*$", ""));
                return ok(Extras.dienstCheck(dienstUrl, name));
            }
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
            case "POST /api/setup/recover": {
                if (vault.exists()) return err(409, "Er is al een kluis op deze telefoon");
                Map<String, Object> c = Console.recoverAdminConfig(Json.str(b, "masterKey"), Json.map(b, "store"));
                vault.create(Json.str(b, "passphrase"), c);
                touch();
                return ok(Json.obj("ok", true));
            }
            case "POST /api/recover/dienst/login":
                recoverEmail = Extras.dienstStartLogin(dienstUrl, Json.str(b, "email"));
                recoverToken = null;
                return ok(Json.obj("ok", true));
            case "POST /api/recover/dienst/verify":
                if (recoverEmail == null) return err(400, "Vul eerst je e-mailadres in");
                recoverToken = Extras.dienstFinishLogin(dienstUrl, recoverEmail, Json.str(b, "code"));
                return ok(Json.obj("ok", true));
            case "POST /api/setup/recover-dienst": {
                if (vault.exists()) return err(409, "Er is al een kluis op deze telefoon");
                if (recoverToken == null) return err(400, "Log eerst in bij de dienst");
                Map<String, Object> c = Extras.recoverViaDienst(dienstUrl, recoverEmail, recoverToken, Json.str(b, "masterKey"), catalog);
                vault.create(Json.str(b, "passphrase"), c);
                recoverEmail = null;
                recoverToken = null;
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

            case "GET /api/key":
                return ok(Json.obj("groups", Console.keyGroups(c), "check", Console.keyCheck(c), "confirmed", Json.truthy(Json.path(c, "console", "keyConfirmed"))));
            case "POST /api/key/confirm":
                Console.confirmKey(c, Json.str(b, "g3"), Json.str(b, "g7"));
                save();
                return ok(Json.obj("ok", true));

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
                List<Console.RegionSizes> regions = Console.connectProvider(c, catalog, Json.str(b, "id"), fields);
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
                DnsSetup.Result r = DnsSetup.configure(c, Json.str(b, "mode"), Json.str(b, "token"));
                save();
                return ok(r.toJson());
            }
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
                DnsSetup.Result r = DnsSetup.configure(c, "desec", token);
                save();
                return ok(r.toJson());
            }
            case "POST /api/dienst/login": {
                Map<String, Object> r = Extras.dienstLogin(dienstUrl, c, Json.str(b, "email"));
                save();
                return ok(r);
            }
            case "POST /api/dienst/verify": {
                Map<String, Object> r = Extras.dienstVerify(dienstUrl, c, Json.str(b, "code"));
                save();
                return ok(r);
            }
            case "POST /api/dienst/order": {
                Map<String, Object> r = Extras.dienstOrder(dienstUrl, c, b);
                save();
                return ok(r);
            }
            case "GET /api/dienst/status":
                return ok(Extras.dienstStatus(dienstUrl, c));
            case "GET /api/dienst/billing":
                return ok(Extras.dienstBilling(dienstUrl, c));
            case "POST /api/dienst/bundle": {
                Map<String, Object> r = Extras.dienstChangeBundle(dienstUrl, c, Json.str(b, "bundle"));
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
                return ok(Extras.dienstAction(dienstUrl, c, p.substring("/api/dienst/".length())));
            case "GET /api/dienst/authcode":
                return ok(Extras.dienstAuthcode(dienstUrl, c));
            case "GET /api/dienst/invoice": {
                int q = path.indexOf("?id=");
                return ok(Extras.dienstInvoice(dienstUrl, c, q < 0 ? "" : Bytes.decodeURIComponent(path.substring(q + 4).replaceFirst("&.*$", ""))));
            }
            case "POST /api/dienst/apply": {
                try {
                    return ok(Extras.dienstApply(dienstUrl, c, catalog));
                } finally {
                    save();
                }
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
