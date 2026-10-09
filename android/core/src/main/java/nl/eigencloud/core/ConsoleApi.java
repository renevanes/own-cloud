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
                "policy", c.get("policy"), "preset", con == null ? null : con.get("preset"));
    }

    /** What /api/state reports about biometric unlock (filled in by the app). */
    public volatile Map<String, Object> biometric = Json.obj("available", false, "enrolled", false);

    // ───────── Router ─────────

    private static Reply ok(Object j) { return new Reply(200, j); }

    private static Reply err(int status, String msg) { return new Reply(status, Json.obj("error", msg)); }

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
                        "phone", true, "biometric", biometric));
            }
            case "POST /api/setup/create": {
                if (vault.exists()) return err(409, "Er is al een kluis. Ontgrendel hem.");
                Map<String, Object> c = Console.newAdminConfig(Json.str(b, "domain"), Json.str(b, "mailbox"), Json.str(b, "alertEmail"), Json.str(b, "appPassword"));
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

    /** The recovery sheet HTML (to print or save as PDF). */
    public String recoverySheet() {
        if (!unlocked()) throw new SecurityException("De kluis is op slot");
        return Console.recoverySheet(cfg());
    }
}
