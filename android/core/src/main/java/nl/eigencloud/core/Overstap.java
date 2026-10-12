package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Port of src/console/overstap.ts: switching from provider A (an Eigen Cloud Dienst) to provider B or to managing
 * it yourself, with the existing mechanisms (sleep at A, copy the storage, switch the config, wake at B). The state
 * lives in the vault (console.overstap) and every step can be repeated. The JSON replies are identical to the TS
 * console's (same keys, same order).
 */
public final class Overstap {
    private Overstap() {}

    /** What the switch needs from the console. */
    public interface Deps {
        Map<String, Object> cfg();

        /** Save the vault (and after launch: admin copy and settings to the cluster). */
        void save() throws IOException;

        /** Save only the vault (during the switch nothing goes to a cluster). */
        void saveVault() throws IOException;

        Catalog catalog();

        /** Starts the first server (wake); returns its cluster URL. */
        String launch(Map<String, Object> c, Admin.FirstNode first, long term, Map<String, Object> adminOverride) throws IOException;
    }

    /** Timings (ms); tests make them short. */
    public static volatile long pollMs = 3000, sleepMs = 30 * 60_000L, wakeMs = 30 * 60_000L, newMs = 60 * 60_000L;

    /** Same text as WAIT_RELEASE in src/broker/provision.ts. */
    public static final String WAIT_RELEASE = "Wacht tot je vorige aanbieder je DNS vrijgeeft";
    static final List<String> FASES = Arrays.asList("voorbereiden", "slapen", "dns", "nieuw", "kopieren", "omzetten", "wekken", "opruimen");
    static final List<String> TERUG = Arrays.asList("servers", "instellingen", "dns", "wekken");
    private static final List<String> SKIP = Arrays.asList("bootstrap/", "test/");
    private static final List<String> RUNNING = Arrays.asList("overzetten", "mislukt", "terug", "teruggezet", "klaar");
    private static final List<String> PLEK_KEYS = Arrays.asList("mailRelay", "spfExtra", "extraDns", "maxUsers", "dnsMode", "nameservers", "preset", "quick", "temDomainId", "catalog", "dienst", "firstLaunch");

    // ───────── Toestand ─────────

    private static Map<String, Object> st(Map<String, Object> c) {
        Map<String, Object> o = Json.map(c, "console", "overstap");
        if (o == null) throw new IllegalStateException("Er loopt geen overstap");
        return o;
    }

    private static Map<String, Object> con(Map<String, Object> c) {
        Map<String, Object> k = Json.map(c, "console");
        if (k == null) { k = Json.obj(); c.put("console", k); }
        return k;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Map<String, Object> o, String key) {
        Object v = o.get(key);
        if (!(v instanceof List)) { v = new ArrayList<>(); o.put(key, v); }
        return (List<Object>) v;
    }

    private static Map<String, Object> mapOf(Map<String, Object> o, String key) {
        Map<String, Object> m = Json.asMap(o.get(key));
        if (m == null) { m = Json.obj(); o.put(key, m); }
        return m;
    }

    static void log(Map<String, Object> o, String text) {
        List<Object> l = list(o, "log");
        l.add(Json.obj("at", System.currentTimeMillis(), "text", text));
        while (l.size() > 60) l.remove(0);
    }

    private static String van(Map<String, Object> o, String k) { return Json.str(o, "van", k); }

    private static boolean central(Map<String, Object> o) { return Json.truthy(Json.path(o, "van", "central")); }

    private static boolean needsDns(Map<String, Object> o) { return !"sub".equals(van(o, "mode")); }

    private static boolean dienstNaar(Map<String, Object> o) { return !"zelf".equals(Json.str(o, "naar")); }

    private static boolean has(Map<String, Object> o, String key) { return o.get(key) != null; }

    private static boolean gedaan(Map<String, Object> o, String id) { return list(o, "gedaan").contains(id); }

    private static String zoneOf(String domain) { return domain.substring(domain.indexOf('.') + 1); }

    private static boolean readyToSwitch(Map<String, Object> o) {
        if ("zelf".equals(Json.str(o, "naar"))) return has(o, "zelf");
        Map<String, Object> b = Json.map(o, "bestelling");
        if (b == null) return false;
        String status = Json.str(b, "status");
        if ("ready".equals(status)) return true;
        if (!"provisioning".equals(status) || central(o)) return false;
        for (Object s : Json.listAt(b, "steps")) {
            if ("dns-zone".equals(Json.str(s, "id")) && "busy".equals(Json.str(s, "state")) && WAIT_RELEASE.equals(Json.str(s, "detail"))) return true;
        }
        return false;
    }

    static String stapOf(Map<String, Object> o) {
        String stap = Json.str(o, "stap");
        if (RUNNING.contains(stap)) return stap;
        if ("zelf".equals(Json.str(o, "naar"))) return has(o, "zelf") ? "gereed" : "zelf";
        if (!has(o, "token")) return "inloggen";
        if (!has(o, "orderId")) return "bestellen";
        return readyToSwitch(o) ? "gereed" : "betalen";
    }

    /** Estimated minutes offline (minutesOffline in overstap.ts). */
    public static long minutesOffline(Map<String, Object> o) {
        Number b = Json.num(o, "schatting", "bytes");
        double bytes = b == null ? 0 : b.doubleValue();
        boolean vooraf = "zelf".equals(Json.str(o, "naar")) || central(o);
        return 15 + (vooraf ? 2 : (long) Math.ceil(bytes / 3e8));
    }

    private static List<String[]> labels(Map<String, Object> o) {
        String vanNaam = van(o, "naam"), naarNaam = Json.str(o, "naarNaam");
        List<String[]> l = new ArrayList<>();
        l.add(new String[] {"voorbereiden", "Nieuwe plek klaarzetten"});
        l.add(new String[] {"slapen", "Je cloud laten slapen bij " + vanNaam});
        if (needsDns(o)) l.add(new String[] {"dns", "DNS vrijgeven bij " + vanNaam});
        l.add(new String[] {"nieuw", dienstNaar(o) ? naarNaam + " zet alles klaar" : "Je DNS bij deSEC aanmaken"});
        l.add(new String[] {"kopieren", "Gegevens overzetten"});
        l.add(new String[] {"omzetten", "Instellingen omzetten naar " + naarNaam});
        l.add(new String[] {"wekken", "Wakker worden bij " + naarNaam});
        l.add(new String[] {"opruimen", "Abonnement bij " + vanNaam + " opzeggen"});
        return l;
    }

    private static List<String[]> terugLabels(Map<String, Object> o) {
        String vanNaam = van(o, "naam"), naarNaam = Json.str(o, "naarNaam");
        return Arrays.asList(new String[] {"terug:servers", "Servers bij " + naarNaam + " weghalen"},
                new String[] {"terug:instellingen", "Instellingen terug naar " + vanNaam},
                new String[] {"terug:dns", "DNS terug naar " + vanNaam},
                new String[] {"terug:wekken", "Wakker worden bij " + vanNaam});
    }

    /** GET /api/overstap (no keys). */
    public static Map<String, Object> view(Map<String, Object> c) {
        Map<String, Object> o = Json.map(c, "console", "overstap");
        if (o == null) return Json.obj("actief", false);
        String stap = stapOf(o);
        boolean terug = "terug".equals(stap) || "teruggezet".equals(stap);
        List<Object> steps = new ArrayList<>();
        for (String[] l : terug ? terugLabels(o) : labels(o)) {
            String state = gedaan(o, l[0]) ? "done" : l[0].equals(Json.str(o, "fase")) ? (has(o, "fout") ? "fail" : "busy") : "wait";
            Map<String, Object> s = Json.obj("id", l[0], "label", l[1], "state", state);
            String detail = Json.str(o, "details", l[0]);
            if (detail != null && !detail.isEmpty()) s.put("detail", detail);
            steps.add(s);
        }
        Map<String, Object> sch = Json.map(o, "schatting");
        List<Object> log = Json.listAt(o, "log");
        boolean pre = Arrays.asList("inloggen", "bestellen", "betalen", "zelf", "gereed").contains(stap);
        return Json.obj("actief", true, "naar", o.get("naar"), "naarNaam", o.get("naarNaam"), "stap", stap, "started", o.get("started"),
                "van", Json.obj("url", van(o, "url"), "naam", van(o, "naam"), "domain", van(o, "domain"), "mode", van(o, "mode"), "central", central(o)),
                "email", o.get("email"), "loggedIn", has(o, "token"), "orderId", o.get("orderId"), "bundle", o.get("bundle"), "checkoutUrl", o.get("checkoutUrl"),
                "bestelling", o.get("bestelling"),
                "zelf", "zelf".equals(Json.str(o, "naar")) ? Json.obj("sleutel", has(o, "zelf")) : null,
                "dnsNodig", needsDns(o),
                "schatting", sch == null ? null : Json.obj("bytes", sch.get("bytes"), "objects", sch.get("objects"), "minuten", minutesOffline(o)),
                "stappen", pre ? Json.list() : steps,
                "kopie", o.get("kopie"),
                "log", new ArrayList<>(log.subList(Math.max(0, log.size() - 20), log.size())),
                "fout", o.get("fout"),
                "kanTerug", ("mislukt".equals(stap) && !gedaan(o, "wekken")) || ("terug".equals(stap) && has(o, "fout")),
                "klaar", o.get("klaar"), "preview", TransferPreview.preview(o, readyToSwitch(o), minutesOffline(o)));
    }

    // ───────── Beginnen, inloggen, bestellen ─────────

    private static Object call(String base, String method, String path, Object body, String token) throws IOException {
        return Extras.dienstCall(base, method, path, body, token);
    }

    /** POST /api/overstap/start. */
    public static Map<String, Object> start(Map<String, Object> c, String naarIn, String defaultBase) throws IOException {
        Map<String, Object> cur = Json.map(c, "console", "overstap");
        if (cur != null && Arrays.asList("overzetten", "terug", "mislukt").contains(Json.str(cur, "stap"))) throw new IllegalStateException("Er loopt al een overstap. Rond die eerst af of ga terug.");
        if (cur != null && has(cur, "orderId") && !Arrays.asList("teruggezet", "klaar").contains(Json.str(cur, "stap"))) throw new IllegalStateException("Je hebt al besteld bij een andere aanbieder. Stop eerst die overstap.");
        if (!Json.truthy(Json.path(c, "console", "done"))) throw new IllegalStateException("Je cloud is nog niet gestart. Kies in de assistent gewoon een andere aanbieder.");
        Map<String, Object> d = Json.map(c, "console", "dienst");
        if (d == null || !has(d, "orderId") || !has(d, "token") || !Json.truthy(d.get("applied"))) throw new IllegalStateException("Je hebt geen abonnement bij een aanbieder");
        String vanUrl = Extras.baseOf(c, defaultBase);
        String naar = "zelf".equals(naarIn) ? "zelf" : Extras.cleanDienstUrl(naarIn == null ? "" : naarIn);
        if (naar.equals(vanUrl)) throw new IllegalArgumentException("Je zit al bij deze aanbieder");
        String orderId = Json.str(d, "orderId"), token = Json.str(d, "token");
        Object order = call(vanUrl, "GET", "/v1/orders/" + orderId, null, token);
        if (!Arrays.asList("ready", "payment_problem").contains(Json.str(order, "status"))) throw new IllegalStateException("Overstappen kan als je abonnement loopt (niet opgezegd of opgeschort)");
        String mode = Json.str(order, "domainMode");
        String transferCode = Json.str(d, "transferCode");
        if ("sub".equals(mode) && transferCode == null) {
            try { transferCode = Json.str(call(vanUrl, "GET", "/v1/orders/" + orderId + "/kit", null, token), "dns", "transferCode"); } catch (IOException e) { transferCode = null; }
        }
        boolean central = "sub".equals(mode) && transferCode != null;
        String vanNaam;
        try { vanNaam = Json.str(Extras.dienstBrand(vanUrl), "name"); } catch (IOException | RuntimeException e) { vanNaam = null; }
        if (vanNaam == null) vanNaam = "je huidige aanbieder";
        String domain = Json.jsString(c.get("domain"));
        if ("sub".equals(mode) && !central) {
            throw new IllegalArgumentException("Je adres " + domain + " hoort bij " + vanNaam + " zelf en kan niet mee naar een andere plek. Een ander adres kiezen kan bij een draaiende cloud (nog) niet; vraag " + vanNaam + " om hulp.");
        }
        String naarNaam = "Zelf beheren";
        if ("zelf".equals(naar)) {
            if (central) throw new IllegalArgumentException("Je gratis adres " + domain + " kan alleen bij een aanbieder blijven: het hoort bij de gedeelde adressendienst. Kies een andere aanbieder, of neem eerst een eigen domein.");
        } else {
            Map<String, Object> b = Extras.dienstBrand(naar);
            naarNaam = Json.str(b, "name");
            if (central && !zoneOf(domain).equals(Json.str(b, "freeZone"))) throw new IllegalArgumentException(naarNaam + " gebruikt de gedeelde adressendienst niet; je adres " + domain + " kan daar niet mee naartoe. Kies een andere aanbieder.");
        }
        Map<String, Object> schatting = null;
        try {
            Map<String, Object> src = null;
            for (Map<String, Object> s : ClusterConfig.stores(c)) if ("replica".equals(s.get("purpose"))) { src = s; break; }
            if (src == null) src = ClusterConfig.stores(c).get(0);
            long bytes = 0, objects = 0;
            for (ObjectStore.Entry e : Stores.make(src).list("")) {
                if (skip(e.key)) continue;
                bytes += e.size;
                objects++;
            }
            schatting = Json.obj("bytes", bytes, "objects", objects);
        } catch (IOException | RuntimeException e) {
            schatting = null;
        }
        Map<String, Object> vanObj = Json.obj("url", vanUrl, "naam", vanNaam, "orderId", orderId, "token", token, "domain", domain, "mode", mode, "central", central);
        if (central) vanObj.put("transferCode", transferCode);
        Map<String, Object> o = Json.obj("naar", naar, "naarNaam", naarNaam, "started", System.currentTimeMillis(), "stap", "inloggen", "van", vanObj);
        if (!"zelf".equals(naar) && cur != null && naar.equals(cur.get("naar")) && has(cur, "token")) {
            o.put("email", cur.get("email"));
            o.put("token", cur.get("token"));
        }
        if (schatting != null) o.put("schatting", schatting);
        o.put("gedaan", new ArrayList<>());
        o.put("log", new ArrayList<>());
        if (!"zelf".equals(naar) && !has(o, "email") && d.get("email") != null) o.put("email", d.get("email"));
        log(o, "zelf".equals(naar) ? "Overstap naar zelf beheren begonnen" : "Overstap naar " + naarNaam + " begonnen");
        o.put("stap", stapOf(o));
        con(c).put("overstap", o);
        return view(c);
    }

    /** POST /api/overstap/login. */
    public static Map<String, Object> login(Map<String, Object> c, String email) throws IOException {
        Map<String, Object> o = st(c);
        if (!dienstNaar(o)) throw new IllegalStateException("Bij zelf beheren log je niet in");
        if (has(o, "orderId")) throw new IllegalStateException("Je hebt al besteld");
        String e = Extras.dienstStartLogin(Json.str(o, "naar"), email);
        o.put("email", e);
        o.remove("token");
        return Json.obj("ok", true, "email", e);
    }

    /** POST /api/overstap/verify. */
    public static Map<String, Object> verify(Map<String, Object> c, String code) throws IOException {
        Map<String, Object> o = st(c);
        if (!has(o, "email")) throw new IllegalStateException("Vul eerst je e-mailadres in");
        o.put("token", Extras.dienstFinishLogin(Json.str(o, "naar"), Json.str(o, "email"), code));
        o.put("stap", stapOf(o));
        return Json.obj("ok", true, "email", o.get("email"));
    }

    /** POST /api/overstap/order. */
    public static Map<String, Object> order(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> o = st(c);
        if (!dienstNaar(o)) throw new IllegalStateException("Bij zelf beheren bestel je niets");
        if (!has(o, "token")) throw new IllegalStateException("Log eerst in bij " + o.get("naarNaam"));
        if (has(o, "orderId")) throw new IllegalStateException("Je hebt al besteld");
        if (!Json.truthy(b.get("acceptTerms"))) throw new IllegalArgumentException("Ga akkoord met de voorwaarden om verder te gaan");
        if (!Json.truthy(b.get("bundle"))) throw new IllegalArgumentException("Kies een bundel");
        Map<String, Object> domain = Json.obj("mode", "own", "name", van(o, "domain"));
        Object registrant = null;
        String mode = van(o, "mode");
        if (central(o)) { domain.put("mode", "sub"); domain.put("transferCode", van(o, "transferCode")); }
        else if ("register".equals(mode) || "transfer".equals(mode)) {
            Object a = call(van(o, "url"), "GET", "/v1/orders/" + van(o, "orderId") + "/authcode", null, van(o, "token"));
            domain.put("mode", "transfer");
            domain.put("authCode", Json.str(a, "authCode"));
            registrant = b.get("registrant");
        }
        Map<String, Object> body = Json.obj("bundle", b.get("bundle"), "domain", domain);
        if (registrant != null) body.put("registrant", registrant);
        body.put("acceptTerms", true);
        Object r = call(Json.str(o, "naar"), "POST", "/v1/orders", body, Json.str(o, "token"));
        o.put("orderId", Json.str(r, "orderId"));
        o.put("bundle", b.get("bundle"));
        o.put("checkoutUrl", Json.str(r, "checkoutUrl"));
        log(o, "Besteld bij " + o.get("naarNaam"));
        o.put("stap", stapOf(o));
        return Json.obj("ok", true, "orderId", Json.str(r, "orderId"), "checkoutUrl", Json.str(r, "checkoutUrl"));
    }

    private static Map<String, Object> bestelling(Object r) {
        Map<String, Object> b = Json.obj("status", Json.str(r, "status"), "steps", Json.copy(Json.listAt(r, "steps")));
        if (Json.str(r, "error") != null) b.put("error", Json.str(r, "error"));
        if (Json.map(r, "monthly") != null) b.put("monthly", Json.copy(Json.map(r, "monthly")));
        return b;
    }

    /** Updates the order at the new provider (waiting screen); true when it changed. */
    public static boolean refresh(Map<String, Object> c) {
        Map<String, Object> o = Json.map(c, "console", "overstap");
        if (o == null || !has(o, "orderId") || !has(o, "token") || !Arrays.asList("betalen", "gereed").contains(stapOf(o))) return false;
        Object r;
        try { r = call(Json.str(o, "naar"), "GET", "/v1/orders/" + Json.str(o, "orderId"), null, Json.str(o, "token")); } catch (IOException | RuntimeException e) { return false; }
        String before = Json.stringify(o.get("bestelling"));
        o.put("bestelling", bestelling(r));
        o.put("stap", stapOf(o));
        return !Json.stringify(o.get("bestelling")).equals(before);
    }

    /** POST /api/overstap/zelf. */
    public static Map<String, Object> zelf(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> o = st(c);
        if (!"zelf".equals(Json.str(o, "naar"))) throw new IllegalStateException("Dit hoort bij zelf beheren");
        if (!"zelf".equals(Json.str(o, "stap")) && !"gereed".equals(Json.str(o, "stap"))) throw new IllegalStateException("Het overzetten is al begonnen");
        String[] keys = Extras.scwKeys(Json.str(b, "accessKey"), Json.str(b, "secretKey"));
        String projectId = Extras.scwProject(keys[0], keys[1], Json.str(b, "projectId"));
        String desecToken = Json.str(b, "desecToken") == null ? "" : Json.str(b, "desecToken").trim();
        if (desecToken.isEmpty()) throw new IllegalArgumentException("Vul een token van je eigen deSEC-account in; daar komt je DNS");
        Http.Response r;
        try { r = Http.request("GET", Endpoints.DESEC + "/domains/", Http.headers("authorization", "Token " + desecToken), null, 20_000); } catch (IOException e) { r = null; }
        if (r == null || r.status == 401 || r.status == 403) throw new IllegalArgumentException("deSEC accepteert dit token niet");
        if (!r.ok()) throw new IOException("deSEC antwoordt " + r.status);
        o.put("zelf", Json.obj("accessKey", keys[0], "secretKey", keys[1], "projectId", projectId, "desecToken", desecToken));
        o.put("stap", stapOf(o));
        log(o, "Sleutels voor zelf beheren gecontroleerd");
        return view(c);
    }

    // ───────── Opslag kopiëren ─────────

    /** Progress of {@link #copyStores}. */
    public static final class CopyProgress {
        public long objects, bytes, done, doneBytes, skipped, verified;

        public Map<String, Object> toJson() { return Json.obj("objects", objects, "bytes", bytes, "done", done, "doneBytes", doneBytes, "skipped", skipped, "verified", verified); }
    }

    /** Receives progress updates. */
    public interface ProgressListener { void progress(CopyProgress p); }

    static boolean skip(String key) {
        for (String s : SKIP) if (key.startsWith(s)) return true;
        return false;
    }

    /** copyStores() in overstap.ts: per target the source with the same purpose; resumable; verified afterwards. */
    public static CopyProgress copyStores(List<ObjectStore> from, List<ObjectStore> to, ProgressListener l) throws IOException {
        CopyProgress p = new CopyProgress();
        List<Object[]> plans = new ArrayList<>();
        for (ObjectStore t : to) {
            ObjectStore f = null;
            for (ObjectStore x : from) if (x.purpose().equals(t.purpose())) { f = x; break; }
            if (f == null) for (ObjectStore x : from) if ("replica".equals(x.purpose())) { f = x; break; }
            if (f == null) f = from.get(0);
            List<ObjectStore.Entry> src = new ArrayList<>();
            for (ObjectStore.Entry e : f.list("")) if (!skip(e.key)) src.add(e);
            Map<String, Long> dst = new HashMap<>();
            for (ObjectStore.Entry e : t.list("")) dst.put(e.key, e.size);
            plans.add(new Object[] {f, t, src, dst});
            p.objects += src.size();
            for (ObjectStore.Entry e : src) p.bytes += e.size;
        }
        if (l != null) l.progress(p);
        for (Object[] plan : plans) {
            ObjectStore f = (ObjectStore) plan[0], t = (ObjectStore) plan[1];
            @SuppressWarnings("unchecked") List<ObjectStore.Entry> src = (List<ObjectStore.Entry>) plan[2];
            @SuppressWarnings("unchecked") Map<String, Long> dst = (Map<String, Long>) plan[3];
            ConcurrentLinkedQueue<ObjectStore.Entry> queue = new ConcurrentLinkedQueue<>(src);
            AtomicReference<IOException> err = new AtomicReference<>();
            Runnable worker = () -> {
                for (ObjectStore.Entry e = queue.poll(); e != null && err.get() == null; e = queue.poll()) {
                    try {
                        boolean fixed = e.key.startsWith("db/") || e.key.startsWith("blobs/");
                        Long have = dst.get(e.key);
                        boolean skipped = TransferIO.copyVerified(f, t, e.key, e.size, fixed && have != null && have == e.size);
                        synchronized (p) { if (skipped) p.skipped++; p.done++; p.doneBytes += e.size; p.verified++; if (l != null) l.progress(p); }
                    } catch (IOException ex) {
                        err.compareAndSet(null, ex);
                    } catch (RuntimeException ex) {
                        err.compareAndSet(null, new IOException(ex.getMessage(), ex));
                    }
                }
            };
            Thread[] ts = new Thread[2];
            for (int i = 0; i < ts.length; i++) { ts[i] = new Thread(worker, "eigen-kopie"); ts[i].start(); }
            for (Thread th : ts) {
                try { th.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Onderbroken"); }
            }
            if (err.get() != null) throw err.get();
            Map<String, Long> after = new HashMap<>(), still = new HashMap<>();
            for (ObjectStore.Entry e : t.list("")) after.put(e.key, e.size);
            for (ObjectStore.Entry e : f.list("")) still.put(e.key, e.size);
            List<String> missing = new ArrayList<>();
            for (ObjectStore.Entry e : src) {
                Long s = still.get(e.key), a = after.get(e.key);
                if (s != null && s == e.size && (a == null || a != e.size)) missing.add(e.key);
            }
            if (!missing.isEmpty()) throw new IOException(missing.size() + " " + (missing.size() == 1 ? "bestand ontbreekt" : "bestanden ontbreken") + " in " + t.name() + " na het kopiëren (bijv. " + missing.get(0) + ")");
        }
        return p;
    }

    // ───────── Plekken ─────────

    static Map<String, Object> plekVan(Map<String, Object> c) {
        Map<String, Object> k = con(c);
        Map<String, Object> pol = Json.map(c, "policy");
        Map<String, Object> consolePart = Json.obj();
        for (String key : PLEK_KEYS) if (k.get(key) != null) consolePart.put(key, k.get(key));
        return Json.copy(Json.obj("stores", c.get("stores") == null ? Json.list() : c.get("stores"), "providers", c.get("providers") == null ? Json.obj() : c.get("providers"),
                "dns", c.get("dns") == null ? Json.list() : c.get("dns"),
                "policy", Json.obj("placement", Json.path(pol, "placement"), "minDataNodes", Json.path(pol, "minDataNodes"), "witnesses", Json.path(pol, "witnesses")),
                "console", consolePart));
    }

    static void zetPlek(Map<String, Object> c, Map<String, Object> p) {
        Map<String, Object> copy = Json.copy(p);
        c.put("stores", copy.get("stores"));
        c.put("providers", copy.get("providers"));
        c.put("dns", copy.get("dns"));
        Map<String, Object> pol = Json.map(c, "policy");
        if (pol == null) { pol = ClusterConfig.defaultPolicy(); c.put("policy", pol); }
        Map<String, Object> np = Json.map(copy, "policy");
        if (np != null) for (Map.Entry<String, Object> e : np.entrySet()) if (e.getValue() != null) pol.put(e.getKey(), e.getValue());
        Map<String, Object> k = con(c);
        Map<String, Object> cp = Json.map(copy, "console");
        for (String key : PLEK_KEYS) {
            Object v = cp == null ? null : cp.get(key);
            if (v == null) k.remove(key); else k.put(key, v);
        }
    }

    private static Map<String, Object> kladblok(Map<String, Object> c, Map<String, Object> o) {
        Map<String, Object> t = Json.copy(c);
        Map<String, Object> k = con(t);
        k.remove("overstap");
        Map<String, Object> doel = Json.map(o, "doel");
        t.put("stores", doel != null && doel.get("stores") != null ? Json.copy(doel.get("stores")) : new ArrayList<>());
        t.put("providers", Json.obj());
        t.put("dns", new ArrayList<>());
        k.remove("dienst");
        k.put("catalog", Json.obj());
        k.put("mailRelay", "");
        k.put("spfExtra", "");
        k.put("extraDns", new ArrayList<>());
        k.remove("temDomainId");
        return t;
    }

    private static Map<String, Object> doelVanKit(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        Map<String, Object> kit = Json.asMap(call(Json.str(o, "naar"), "GET", "/v1/orders/" + Json.str(o, "orderId") + "/kit", null, Json.str(o, "token")));
        if (kit == null) throw new IOException("Leeg pakket van " + o.get("naarNaam"));
        if (!van(o, "domain").equals(Json.str(kit, "domain"))) throw new IOException("Het pakket van " + o.get("naarNaam") + " is voor " + Json.str(kit, "domain") + ", niet voor " + van(o, "domain"));
        Map<String, Object> t = kladblok(c, o);
        Extras.applyKit(t, kit, deps.catalog());
        Map<String, Object> p = plekVan(t);
        Map<String, Object> tk = con(t);
        Map<String, Object> dienst = Json.obj("url", o.get("naar"), "email", o.get("email"), "token", o.get("token"), "orderId", o.get("orderId"), "bundle", o.get("bundle"), "applied", true);
        String code = Json.str(kit, "dns", "transferCode");
        if (code != null) dienst.put("transferCode", code);
        p.put("console", Json.obj("mailRelay", tk.get("mailRelay") == null ? "" : tk.get("mailRelay"), "spfExtra", tk.get("spfExtra") == null ? "" : tk.get("spfExtra"),
                "extraDns", Json.list(), "maxUsers", tk.get("maxUsers") == null ? (Object) 0L : tk.get("maxUsers"), "dnsMode", "dienst",
                "nameservers", Json.copy(kit.get("nameservers")), "preset", "dienst", "dienst", dienst));
        if (!Json.listAt(kit, "ds").isEmpty()) p.put("ds", Json.copy(kit.get("ds")));
        return p;
    }

    private static Map<String, Object> doelZelf(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        Map<String, Object> z = Json.map(o, "zelf");
        Map<String, Object> t = kladblok(c, o);
        Map<String, String> fields = new HashMap<>();
        fields.put("secretKey", Json.str(z, "secretKey"));
        fields.put("projectId", Json.str(z, "projectId"));
        List<Console.RegionSizes> regions = Console.connectProvider(t, deps.catalog(), "scaleway", fields);
        boolean priced = false;
        String firstError = null;
        for (Console.RegionSizes r : regions) { if (r.data != null) priced = true; if (firstError == null && r.error != null && !r.error.isEmpty()) firstError = r.error; }
        if (!priced) throw new IOException("Scaleway gaf geen serverprijzen: " + (firstError != null ? firstError : "onbekend"));
        String[][] stores = {{"nl-ams", "replica"}, {"fr-par", "backup"}};
        for (String[] s : stores) {
            Console.StoreSetup r = Console.addStore(t, deps.catalog(), "scaleway", s[0], null, Json.str(z, "accessKey"), Json.str(z, "secretKey"), null, s[1]);
            if (!r.ok) {
                StringBuilder why = new StringBuilder();
                for (Admin.StepResult x : r.steps) if (!x.ok) why.append(x.label).append(x.detail != null ? " (" + x.detail + ")" : "").append(", ");
                throw new IOException("Opslag " + r.name + ": " + why.toString().replaceAll(", $", ""));
            }
            Map<String, Object> doel = Json.map(o, "doel");
            if (doel == null) { doel = plekVan(t); o.put("doel", doel); }
            doel.put("stores", Json.copy(t.get("stores")));
            deps.saveVault();
        }
        Console.choosePreset(t, deps.catalog(), "nl");
        try {
            Extras.scwMail(t, Json.str(z, "secretKey"), Json.str(z, "projectId"));
        } catch (IOException | RuntimeException e) {
            con(t).put("mailRelay", "");
            log(o, "Mail versturen via Scaleway lukte niet (" + e.getMessage() + "); je kunt dit later bij Mail regelen");
        }
        Map<String, Object> p = plekVan(t);
        p.put("dns", Json.list(Json.obj("type", "desec", "name", "desec", "token", Json.str(z, "desecToken"), "zone", van(o, "domain"))));
        Map<String, Object> tk = con(t);
        Map<String, Object> cp = Json.obj("mailRelay", tk.get("mailRelay") == null ? "" : tk.get("mailRelay"), "spfExtra", tk.get("spfExtra") == null ? "" : tk.get("spfExtra"),
                "extraDns", tk.get("extraDns") == null ? Json.list() : tk.get("extraDns"), "maxUsers", 0L, "dnsMode", "desec", "nameservers", Json.list("ns1.desec.io", "ns2.desec.org"),
                "preset", "nl", "quick", "scaleway");
        if (tk.get("temDomainId") != null) cp.put("temDomainId", tk.get("temDomainId"));
        cp.put("catalog", tk.get("catalog"));
        p.put("console", cp);
        return p;
    }

    // ───────── Het overzetten ─────────

    private static volatile Thread running;

    /** Whether a switch (or a way back) is running in the background. */
    public static boolean busy() { Thread t = running; return t != null && t.isAlive(); }

    /** POST /api/overstap/nu. */
    public static Map<String, Object> overzetten(Deps deps, Object confirm) throws IOException {
        Map<String, Object> c = deps.cfg();
        Map<String, Object> o = st(c);
        if (!Boolean.TRUE.equals(confirm)) throw new IllegalArgumentException("Bevestig dat je wilt overstappen: je cloud is daarbij een tijdje offline");
        String s = stapOf(o);
        if (!"gereed".equals(s) && !"mislukt".equals(s) && !"overzetten".equals(s)) throw new IllegalStateException("terug".equals(s) || "teruggezet".equals(s) ? "Je cloud gaat (of ging) terug; begin opnieuw met overstappen" : "Nog niet klaar om over te zetten");
        if (!"overzetten".equals(Json.str(o, "stap"))) { o.put("stap", "overzetten"); o.remove("fout"); log(o, "Overzetten begonnen"); deps.saveVault(); }
        ensureRunning(deps);
        return view(c);
    }

    /** After a restart of the app: continue a running switch (or way back). */
    public static synchronized void ensureRunning(Deps deps) {
        Map<String, Object> c = deps.cfg();
        Map<String, Object> o = c == null ? null : Json.map(c, "console", "overstap");
        if (busy() || o == null || has(o, "fout") || (!"overzetten".equals(Json.str(o, "stap")) && !"terug".equals(Json.str(o, "stap")))) return;
        boolean terug = "terug".equals(Json.str(o, "stap"));
        Thread t = new Thread(() -> {
            try {
                if (terug) runTerug(deps, c); else runOver(deps, c);
            } catch (RuntimeException e) {
                o.put("fout", "Er ging iets mis: " + e);
                if (!terug) o.put("stap", "mislukt");
                try { deps.saveVault(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
            }
        }, "eigen-overstap");
        t.setDaemon(true);
        running = t;
        t.start();
    }

    private interface Fase { void run(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException; }

    private static void runOver(Deps deps, Map<String, Object> c) {
        Map<String, Object> o = st(c);
        for (String f : FASES) {
            if (gedaan(o, f)) continue;
            if ("dns".equals(f) && !needsDns(o)) { list(o, "gedaan").add(f); continue; }
            o.put("fase", f);
            try {
                deps.saveVault();
                fase(f).run(deps, c, o);
                list(o, "gedaan").add(f);
                deps.saveVault();
            } catch (IOException | RuntimeException e) {
                o.put("fout", e.getMessage() != null ? e.getMessage() : e.toString());
                o.put("stap", "mislukt");
                log(o, "Mislukt bij " + f + ": " + o.get("fout"));
                try { deps.saveVault(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
                return;
            }
        }
        o.remove("fase");
        o.put("stap", "klaar");
        log(o, "Klaar: je cloud draait bij " + o.get("naarNaam"));
        try { deps.save(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
    }

    private static void detail(Map<String, Object> o, String id, String text) { mapOf(o, "details").put(id, text); }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static Fase fase(String f) {
        switch (f) {
            case "voorbereiden": return Overstap::voorbereiden;
            case "slapen": return Overstap::slapen;
            case "dns": return Overstap::dnsVrijgeven;
            case "nieuw": return Overstap::nieuw;
            case "kopieren": return (deps, c, o) -> kopieer(deps, c, o, "kopieren");
            case "omzetten": return Overstap::omzetten;
            case "wekken": return (deps, c, o) -> wekOp(deps, c, o, "wekken", true);
            case "opruimen": return Overstap::opruimen;
            default: throw new IllegalStateException(f);
        }
    }

    private static void voorbereiden(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        Admin.Status s = Admin.clusterStatus(c, Console.knownUrls(c));
        if (s.leaderUrl != null) {
            Map<String, Object> info = null;
            try { info = Transport.rpcObject(ClusterConfig.keysFor(c).cluster, s.leaderUrl, Json.obj("type", "nodeInfo"), 5000); } catch (IOException | RuntimeException ignored) { /* oudere server */ }
            if (info != null && !Json.listAt(info, "features").contains("overstap")) throw new IOException("Je cloud draait nog een oudere versie. Werk hem eerst bij (op het overzicht) en probeer het daarna opnieuw.");
        } else if (s.manifest == null || !"asleep".equals(s.manifest.get("state"))) throw new IOException("Je cloud is niet bereikbaar. Maak hem eerst wakker of vraag je aanbieder om hulp.");
        if (dienstNaar(o)) {
            refresh(c);
            if ("ready".equals(Json.str(o, "bestelling", "status")) && !has(o, "doel")) o.put("doel", doelVanKit(deps, c, o));
        } else if (Json.listAt(o, "doel", "dns").isEmpty()) o.put("doel", doelZelf(deps, c, o));
        deps.saveVault();
        if (has(o, "doel") && s.leaderUrl != null) {
            detail(o, "voorbereiden", "Gegevens alvast kopiëren terwijl je cloud nog draait");
            kopieer(deps, c, o, "voorbereiden");
            detail(o, "voorbereiden", "Alvast gekopieerd; je cloud draaide nog");
        }
    }

    private static void slapen(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        long end = System.currentTimeMillis() + sleepMs;
        boolean asked = false;
        for (;;) {
            Admin.Status s = Admin.clusterStatus(c, Console.knownUrls(c));
            if (s.leaderUrl != null && !Json.truthy(Json.path(s.live, "sleeping")) && !asked) {
                Map<String, Object> r = Admin.sendJob(c, s.leaderUrl, "sleep", null);
                if (!Json.truthy(r.get("ok"))) throw new IOException(Json.str(r, "error") != null ? Json.str(r, "error") : "Slapen lukte niet");
                asked = true;
                log(o, "Je cloud gaat slapen");
            }
            if (s.leaderUrl == null && s.manifest != null && "asleep".equals(s.manifest.get("state")) && Admin.probeCluster(c, s.manifest).isEmpty()) {
                o.put("term", s.manifest.get("term"));
                break;
            }
            if (s.leaderUrl == null && s.manifest == null) throw new IOException("Geen manifest in je opslag gevonden");
            if (System.currentTimeMillis() > end) throw new IOException("Slapen duurt te lang. Probeer het opnieuw.");
            detail(o, "slapen", asked ? "Alles wordt weggeschreven en gecontroleerd" : "Wachten op je cloud");
            sleep(pollMs);
        }
        int n = 0;
        Map<String, Object> providers = Json.map(c, "providers");
        if (providers != null) for (Map.Entry<String, Object> e : providers.entrySet()) {
            try {
                Provider p = Providers.make(e.getKey(), Json.asMap(e.getValue()));
                for (Provider.ServerRef sv : p.list(Json.jsString(c.get("cluster")))) { p.destroy(sv.serverId); n++; }
            } catch (IOException | RuntimeException ex) {
                log(o, "Servers bij " + e.getKey() + " nakijken lukte niet: " + ex.getMessage());
            }
        }
        detail(o, "slapen", n > 0 ? "Slaapt; " + n + " achtergebleven server(s) weggehaald" : "Slaapt; alles staat in de opslag");
    }

    private static void dnsVrijgeven(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        Object r = call(van(o, "url"), "POST", "/v1/orders/" + van(o, "orderId") + "/dns-vrijgeven", Json.obj("overstap", true), van(o, "token"));
        String dnssec = Json.str(r, "dnssec");
        mapOf(o, "klaar").put("dnssec", dnssec);
        detail(o, "dns", "uitgezet".equals(dnssec) ? "Vrijgegeven; DNSSEC staat even uit" : "mislukt".equals(dnssec) ? "Vrijgegeven; DNSSEC uitzetten lukte niet" : "Vrijgegeven");
        log(o, "DNS van " + van(o, "domain") + " vrijgegeven bij " + van(o, "naam"));
    }

    private static void nieuw(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        long end = System.currentTimeMillis() + newMs;
        if (dienstNaar(o)) {
            for (;;) {
                Object r = call(Json.str(o, "naar"), "GET", "/v1/orders/" + Json.str(o, "orderId"), null, Json.str(o, "token"));
                o.put("bestelling", bestelling(r));
                String status = Json.str(r, "status");
                if ("ready".equals(status)) break;
                if ("failed".equals(status)) throw new IOException(o.get("naarNaam") + ": " + (Json.str(r, "error") != null ? Json.str(r, "error") : "klaarzetten mislukt"));
                if (!"paid".equals(status) && !"provisioning".equals(status)) throw new IOException("Je bestelling bij " + o.get("naarNaam") + " staat op " + status);
                Object busyStep = null;
                for (Object x : Json.listAt(r, "steps")) if ("busy".equals(Json.str(x, "state"))) { busyStep = x; break; }
                detail(o, "nieuw", busyStep != null ? Json.str(busyStep, "label") + (Json.str(busyStep, "detail") != null ? ": " + Json.str(busyStep, "detail") : "") : "Bezig");
                if (System.currentTimeMillis() > end) throw new IOException(o.get("naarNaam") + " is nog niet klaar. Probeer het straks opnieuw.");
                deps.saveVault();
                sleep(pollMs);
            }
            if (!has(o, "doel") || !Json.jsString(Json.path(o, "doel", "console", "dienst", "orderId")).equals(Json.str(o, "orderId"))) o.put("doel", doelVanKit(deps, c, o));
            detail(o, "nieuw", "Klaar");
            return;
        }
        String token = Json.str(o, "zelf", "desecToken"), d = van(o, "domain");
        Map<String, String> h = Http.headers("authorization", "Token " + token, "content-type", "application/json");
        for (;;) {
            Http.Response g = Http.request("GET", Endpoints.DESEC + "/domains/" + d + "/", h, null, 20_000);
            if (g.ok()) {
                List<Object> ds = new ArrayList<>();
                for (Object k : Json.listAt(Json.parse(g.text()), "keys")) ds.addAll(Json.listAt(k, "ds"));
                if (!ds.isEmpty()) Json.map(o, "doel").put("ds", ds);
                break;
            }
            Http.Response cr = Http.request("POST", Endpoints.DESEC + "/domains/", h, Bytes.utf8(Json.stringify(Json.obj("name", d))), 20_000);
            if (cr.ok()) { o.put("zoneZelf", true); deps.saveVault(); continue; }
            if (cr.status != 409 && cr.status != 400) throw new IOException("Je domein bij deSEC aanmaken lukte niet (" + cr.status + "): " + Bytes.head(cr.text(), 160));
            if (System.currentTimeMillis() > end) throw new IOException("Je domein staat nog bij een ander deSEC-account. Probeer het straks opnieuw.");
            detail(o, "nieuw", WAIT_RELEASE);
            sleep(pollMs);
        }
        detail(o, "nieuw", "Je domein staat in je eigen deSEC-account");
    }

    private static void omzetten(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        if (!has(o, "vorige")) o.put("vorige", plekVan(c));
        zetPlek(c, Json.map(o, "doel"));
        deps.saveVault();
        Admin.saveAdminCopy(c);
        detail(o, "omzetten", "Opslag, servers, DNS en mail van de nieuwe plek");
    }

    private static void opruimen(Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        Map<String, Object> k = mapOf(o, "klaar");
        List<Object> ds = Json.listAt(o, "doel", "ds");
        if (!ds.isEmpty() && "own".equals(van(o, "mode"))) k.put("ds", Json.copy(ds));
        if ("zelf".equals(Json.str(o, "naar")) && ("register".equals(van(o, "mode")) || "transfer".equals(van(o, "mode")))) {
            try {
                Object a = call(van(o, "url"), "GET", "/v1/orders/" + van(o, "orderId") + "/authcode", null, van(o, "token"));
                if (Json.str(a, "authCode") != null) k.put("authCode", Json.str(a, "authCode"));
            } catch (IOException | RuntimeException ignored) { /* zonder verhuiscode */ }
            if (!ds.isEmpty()) k.put("ds", Json.copy(ds));
        }
        Object r = call(van(o, "url"), "POST", "/v1/orders/" + van(o, "orderId") + "/cancel", Json.obj(), van(o, "token"));
        k.put("endsAt", Json.path(r, "endsAt"));
        detail(o, "opruimen", "Opgezegd; " + van(o, "naam") + " ruimt je oude opslag op");
        log(o, "Abonnement bij " + van(o, "naam") + " opgezegd");
    }

    private static String mb(long b) {
        if (b < 1_000_000) return Math.max(0, Math.round(b / 1e3)) + " kB";
        return new java.math.BigDecimal(b / 1e6).setScale(1, java.math.RoundingMode.HALF_UP).toPlainString().replace(".", ",") + " MB";
    }

    private static void kopieer(Deps deps, Map<String, Object> c, Map<String, Object> o, String stap) throws IOException {
        Map<String, Object> from = has(o, "vorige") ? Json.map(o, "vorige") : plekVan(c);
        List<ObjectStore> src = new ArrayList<>(), dst = new ArrayList<>();
        for (Object s : Json.listAt(from, "stores")) src.add(Stores.make(Json.asMap(s)));
        for (Object s : Json.listAt(o, "doel", "stores")) dst.add(Stores.make(Json.asMap(s)));
        long[] last = {0};
        CopyProgress p = copyStores(src, dst, x -> {
            o.put("kopie", x.toJson());
            detail(o, stap, x.done + " van " + x.objects + " bestanden (" + mb(x.doneBytes) + " van " + mb(x.bytes) + ")");
            if (System.currentTimeMillis() - last[0] > 3000) {
                last[0] = System.currentTimeMillis();
                try { deps.saveVault(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
            }
        });
        o.put("kopie", p.toJson());
        detail(o, stap, p.objects + " bestanden (" + mb(p.bytes) + ") staan op de nieuwe plek");
        log(o, "Gekopieerd: " + (p.done - p.skipped) + " nieuw, " + p.skipped + " waren er al");
    }

    private static Admin.Leader leaderAt(Map<String, Object> c, String url) {
        try { return Admin.findLeader(c, java.util.Collections.singletonList(url)); } catch (RuntimeException e) { return null; }
    }

    private static void wekOp(Deps deps, Map<String, Object> c, Map<String, Object> o, String stap, boolean override) throws IOException {
        String keyStep = "wekken".equals(stap) ? "wake" : "terugWake";
        String clusterUrl = Json.str(o, keyStep, "clusterUrl");
        Number at = Json.num(o, keyStep, "at");
        if (clusterUrl != null && leaderAt(c, clusterUrl) == null && System.currentTimeMillis() - (at == null ? 0 : at.longValue()) > wakeMs) {
            if (override) { try { removeServers(c, o); } catch (IOException | RuntimeException ignored) { /* opnieuw */ } }
            clusterUrl = null;
        }
        if (clusterUrl == null) {
            Map<String, Object> m = Admin.readManifest(c);
            Admin.FirstNode first = null;
            if (!override) for (Object t : Json.listAt(m, "topology")) if ("data".equals(Json.str(t, "kind"))) { first = new Admin.FirstNode(Json.str(t, "provider"), Json.str(t, "region"), Json.str(t, "size")); break; }
            if (first == null) first = Console.firstPlacement(c);
            if (first == null) throw new IOException("Geen plek voor een server in de nieuwe instellingen");
            Number mt = Json.num(m, "term"), ot = Json.num(o, "term");
            long term = (mt != null ? mt.longValue() : ot != null ? ot.longValue() : 0) + 1;
            Map<String, Object> settings = Admin.consoleSettings(c, "");
            clusterUrl = deps.launch(c, first, term, override ? Json.obj("settings", settings) : null);
            at = System.currentTimeMillis();
            o.put(keyStep, Json.obj("clusterUrl", clusterUrl, "at", at));
            deps.saveVault();
        }
        long end = (at == null ? System.currentTimeMillis() : at.longValue()) + wakeMs;
        detail(o, stap, "Server opstarten en je gegevens terugzetten");
        for (;;) {
            Admin.Leader l = leaderAt(c, clusterUrl);
            if (l != null) {
                try { Admin.pushAdminConfig(c, "", l.url); } catch (IOException | RuntimeException ignored) { /* de cloud heeft het al */ }
                break;
            }
            if (System.currentTimeMillis() > end) throw new IOException("Je cloud komt niet op bij de nieuwe plek");
            sleep(pollMs);
        }
        detail(o, stap, "Je cloud draait weer; de overige servers komen er vanzelf bij");
    }

    private static int removeServers(Map<String, Object> c, Map<String, Object> o) throws IOException {
        Map<String, Object> doel = Json.map(o, "doel");
        if (doel == null) return 0;
        int n = 0;
        Map<String, Object> providers = Json.map(doel, "providers");
        if (providers != null) for (Map.Entry<String, Object> e : providers.entrySet()) {
            Object before = Json.path(o, "vorige", "providers", e.getKey());
            if (Json.stringify(before).equals(Json.stringify(e.getValue()))) continue;
            Provider p = Providers.make(e.getKey(), Json.asMap(e.getValue()));
            for (Provider.ServerRef sv : p.list(Json.jsString(c.get("cluster")))) { p.destroy(sv.serverId); n++; }
        }
        return n;
    }

    // ───────── Terug naar de vorige aanbieder ─────────

    /** POST /api/overstap/terug. */
    public static Map<String, Object> terug(Deps deps) throws IOException {
        Map<String, Object> c = deps.cfg();
        Map<String, Object> o = st(c);
        String s = stapOf(o);
        if (!"mislukt".equals(s) && !("terug".equals(s) && has(o, "fout"))) throw new IllegalStateException("klaar".equals(s) ? "Je cloud draait al bij de nieuwe plek" : "Terug kan alleen als het overzetten mislukte");
        if (gedaan(o, "wekken")) throw new IllegalStateException("Je cloud draait al bij " + o.get("naarNaam") + "; terug kan niet meer zonder gegevens te verliezen");
        o.put("stap", "terug");
        o.remove("fout");
        o.remove("fase");
        log(o, "Terug naar " + van(o, "naam"));
        deps.saveVault();
        ensureRunning(deps);
        return view(c);
    }

    private static void runTerug(Deps deps, Map<String, Object> c) {
        Map<String, Object> o = st(c);
        for (String f : TERUG) {
            String id = "terug:" + f;
            if (gedaan(o, id)) continue;
            o.put("fase", id);
            try {
                deps.saveVault();
                terugFase(f, deps, c, o);
                list(o, "gedaan").add(id);
                deps.saveVault();
            } catch (IOException | RuntimeException e) {
                o.put("fout", e.getMessage() != null ? e.getMessage() : e.toString());
                log(o, "Teruggaan lukte niet bij " + f + ": " + o.get("fout"));
                try { deps.saveVault(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
                return;
            }
        }
        o.remove("fase");
        o.put("stap", "teruggezet");
        log(o, "Je cloud draait weer bij " + van(o, "naam"));
        try { deps.save(); } catch (IOException | RuntimeException ignored) { /* volgende keer */ }
    }

    private static void terugFase(String f, Deps deps, Map<String, Object> c, Map<String, Object> o) throws IOException {
        switch (f) {
            case "servers": {
                int n = gedaan(o, "omzetten") || has(o, "wake") ? removeServers(c, o) : 0;
                detail(o, "terug:servers", n > 0 ? n + " server(s) weggehaald" : "Er stonden geen servers");
                return;
            }
            case "instellingen":
                if (has(o, "vorige")) zetPlek(c, Json.map(o, "vorige"));
                o.remove("wake");
                deps.saveVault();
                Admin.saveAdminCopy(c);
                detail(o, "terug:instellingen", "Opslag, servers, DNS en mail van je vorige aanbieder");
                return;
            case "dns": {
                String naar = Json.str(o, "naar"), token = Json.str(o, "token"), orderId = Json.str(o, "orderId");
                if (dienstNaar(o) && orderId != null) {
                    if (central(o)) {
                        String code = null;
                        try { code = Json.str(call(naar, "GET", "/v1/orders/" + orderId + "/kit", null, token), "dns", "transferCode"); } catch (IOException | RuntimeException ignored) { /* nog niet overgenomen */ }
                        if (code != null) call(van(o, "url"), "POST", "/v1/orders/" + van(o, "orderId") + "/dns-terug", Json.obj("transferCode", code), van(o, "token"));
                    }
                    try { call(naar, "POST", "/v1/orders/" + orderId + "/cancel", Json.obj(), token); } catch (IOException e) { log(o, "Opzeggen bij " + o.get("naarNaam") + ": " + e.getMessage()); }
                    if (!central(o) && gedaan(o, "dns")) {
                        try { call(naar, "POST", "/v1/orders/" + orderId + "/dns-vrijgeven", Json.obj("overstap", true), token); } catch (IOException e) { log(o, "DNS vrijgeven bij " + o.get("naarNaam") + ": " + e.getMessage()); }
                    }
                }
                if ("zelf".equals(naar) && Json.truthy(o.get("zoneZelf"))) {
                    Http.Response r = Http.request("DELETE", Endpoints.DESEC + "/domains/" + van(o, "domain") + "/", Http.headers("authorization", "Token " + Json.str(o, "zelf", "desecToken")), null, 20_000);
                    if (!r.ok() && r.status != 404) throw new IOException("Je domein bij deSEC weghalen lukte niet (" + r.status + ")");
                    o.remove("zoneZelf");
                }
                if (needsDns(o) && gedaan(o, "dns")) {
                    long end = System.currentTimeMillis() + newMs;
                    for (;;) {
                        try {
                            Object r = call(van(o, "url"), "POST", "/v1/orders/" + van(o, "orderId") + "/dns-terug", Json.obj(), van(o, "token"));
                            if (!Json.listAt(r, "ds").isEmpty() && "own".equals(van(o, "mode"))) mapOf(o, "klaar").put("ds", Json.copy(Json.listAt(r, "ds")));
                            break;
                        } catch (IOException e) {
                            if (System.currentTimeMillis() > end || e.getMessage() == null || !e.getMessage().contains("staat nog bij")) throw e;
                            detail(o, "terug:dns", "Wacht tot de nieuwe aanbieder je DNS vrijgeeft");
                            sleep(pollMs);
                        }
                    }
                }
                detail(o, "terug:dns", "Je DNS staat weer bij je vorige aanbieder");
                return;
            }
            case "wekken": {
                long end = System.currentTimeMillis() + sleepMs;
                for (;;) {
                    Admin.Status s = Admin.clusterStatus(c, Console.knownUrls(c));
                    if (s.leaderUrl != null && !Json.truthy(Json.path(s.live, "sleeping")) && !has(o, "terugWake")) { detail(o, "terug:wekken", "Je cloud is wakker"); return; }
                    if (s.leaderUrl == null || has(o, "terugWake")) break;
                    if (System.currentTimeMillis() > end) throw new IOException("Je cloud is nog aan het inslapen. Probeer het straks opnieuw.");
                    detail(o, "terug:wekken", "Wachten tot je cloud slaapt");
                    sleep(pollMs);
                }
                wekOp(deps, c, o, "terug:wekken", false);
                return;
            }
            default:
                throw new IllegalStateException(f);
        }
    }

    /** POST /api/overstap/stoppen: stop before switching (cancel the order at the new provider), or dismiss the result. */
    public static Map<String, Object> stoppen(Deps deps) throws IOException {
        Map<String, Object> c = deps.cfg();
        Map<String, Object> o = Json.map(c, "console", "overstap");
        if (o == null) return Json.obj("ok", true);
        String s = stapOf(o);
        if ("overzetten".equals(s) || "terug".equals(s) || "mislukt".equals(s)) throw new IllegalStateException("mislukt".equals(s) ? "Kies eerst Terug naar " + van(o, "naam") + " of probeer het opnieuw" : "Het overzetten loopt; wacht tot het klaar is");
        if (has(o, "orderId") && has(o, "token") && !"klaar".equals(s) && !"teruggezet".equals(s)) {
            String naar = Json.str(o, "naar"), token = Json.str(o, "token"), orderId = Json.str(o, "orderId");
            if (central(o) && !"ready".equals(Json.str(o, "bestelling", "status")) && !"awaiting_payment".equals(Json.str(o, "bestelling", "status"))) {
                refresh(c);
                if (!"ready".equals(Json.str(o, "bestelling", "status"))) throw new IllegalStateException("Wacht even tot " + o.get("naarNaam") + " klaar is; je adres staat daar al. Daarna kun je stoppen.");
            }
            if (central(o) && "ready".equals(Json.str(o, "bestelling", "status"))) {
                String code = Json.str(call(naar, "GET", "/v1/orders/" + orderId + "/kit", null, token), "dns", "transferCode");
                if (code != null) call(van(o, "url"), "POST", "/v1/orders/" + van(o, "orderId") + "/dns-terug", Json.obj("transferCode", code), van(o, "token"));
            }
            call(naar, "POST", "/v1/orders/" + orderId + "/cancel", Json.obj(), token);
        }
        con(c).remove("overstap");
        deps.save();
        return Json.obj("ok", true);
    }
}
