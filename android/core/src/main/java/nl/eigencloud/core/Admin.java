package nl.eigencloud.core;

import java.io.IOException;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Port of src/cluster/admin.ts: admin actions from outside the cluster — start/wake the first node, read
 * status, give the cluster signed jobs, and keep the admin configuration safely in storage.
 *
 * <p>All methods block (run them off the UI thread). Configs are JSON maps shaped like the TS ClusterConfig.
 */
public final class Admin {
    private Admin() {}

    /** Result of a step in {@link #prepareStore}. */
    public static final class StepResult {
        public final String label;
        public final boolean ok;
        /** null when there is no detail. */
        public final String detail;

        public StepResult(String label, boolean ok, String detail) {
            this.label = label;
            this.ok = ok;
            this.detail = detail;
        }

        public Map<String, Object> toJson() {
            Map<String, Object> m = Json.obj("label", label, "ok", ok);
            if (detail != null) m.put("detail", detail);
            return m;
        }

        @Override public String toString() { return (ok ? "✓ " : "✗ ") + label + (detail != null ? " — " + detail : ""); }
    }

    /** The leader that answered, with its status reply. */
    public static final class Leader {
        public final String url;
        public final Map<String, Object> status;

        Leader(String url, Map<String, Object> status) {
            this.url = url;
            this.status = status;
        }
    }

    /** clusterStatus() result: manifest (or null), leader URL (or null) and the live clusterSummary (or null). */
    public static final class Status {
        public final Map<String, Object> manifest;
        public final String leaderUrl;
        public final Map<String, Object> live;

        Status(Map<String, Object> manifest, String leaderUrl, Map<String, Object> live) {
            this.manifest = manifest;
            this.leaderUrl = leaderUrl;
            this.live = live;
        }

        public Map<String, Object> toJson() { return Json.obj("manifest", manifest, "leaderUrl", leaderUrl, "live", live); }
    }

    /** provisionFirstNode() result. */
    public static final class Provisioned {
        public final String nodeId;
        public final Provider.ServerInfo info;
        public final String clusterUrl;

        Provisioned(String nodeId, Provider.ServerInfo info, String clusterUrl) {
            this.nodeId = nodeId;
            this.info = info;
            this.clusterUrl = clusterUrl;
        }
    }

    /** Options for {@link #provisionFirstNode}. */
    public static final class FirstNode {
        public String provider, region, size, country;
        public long term;
        /** One-time settings for a brand-new cluster (null when waking). */
        public Map<String, Object> initialSettings;

        public FirstNode(String provider, String region, String size) {
            this.provider = provider;
            this.region = region;
            this.size = size;
        }
    }

    // ───────── Manifest ─────────

    /** Newest manifest over all stores (with "_store" = store name), or null. */
    public static Map<String, Object> readManifest(Map<String, Object> c) {
        ClusterConfig.Keys keys = ClusterConfig.keysFor(c);
        Map<String, Object> best = null;
        for (Map<String, Object> sc : ClusterConfig.stores(c)) {
            try {
                ObjectStore s = Stores.make(sc);
                byte[] buf = s.getBuffer("manifest.enc");
                if (buf == null) continue;
                Map<String, Object> m = Json.asMap(EigenCrypto.openJson(keys.manifest, buf, "manifest"));
                if (m == null) continue;
                Number upd = Json.num(m, "updated");
                Number bestUpd = best == null ? null : Json.num(best, "updated");
                if (best == null || (upd != null && (bestUpd == null || upd.doubleValue() > bestUpd.doubleValue()))) {
                    best = m;
                    best.put("_store", s.name());
                }
            } catch (IOException | RuntimeException ignored) {
                // next store
            }
        }
        return best;
    }

    // ───────── Signed commands ─────────

    /** Signed command {ts, mac}: HMAC-SHA256(deriveKey(master,"admin"), ts + ":" + JSON.stringify(payload)). */
    public static Map<String, Object> adminProof(String masterKeyHex, Object payload) {
        return adminProof(masterKeyHex, payload, System.currentTimeMillis());
    }

    /** {@link #adminProof(String, Object)} at a given time. */
    public static Map<String, Object> adminProof(String masterKeyHex, Object payload, long ts) {
        byte[] k = EigenCrypto.deriveKey(Bytes.fromHex(masterKeyHex), "admin");
        String mac = Bytes.hex(Bytes.hmacSha256(k, ts + ":" + Json.stringify(payload)));
        return Json.obj("ts", ts, "mac", mac);
    }

    /** Verifies a proof (120 s window). */
    public static boolean verifyAdminProof(String masterKeyHex, Object payload, Map<String, Object> proof) {
        if (proof == null) return false;
        Number ts = Json.num(proof, "ts");
        String mac = Json.str(proof, "mac");
        if (ts == null || mac == null || Math.abs(System.currentTimeMillis() - ts.doubleValue()) > 120_000) return false;
        byte[] k = EigenCrypto.deriveKey(Bytes.fromHex(masterKeyHex), "admin");
        String good = Bytes.hex(Bytes.hmacSha256(k, Json.jsString(ts) + ":" + Json.stringify(payload)));
        return good.length() == mac.length() && Bytes.equal(Bytes.utf8(good), Bytes.utf8(mac));
    }

    // ───────── Finding the cluster ─────────

    private static List<String> memberUrls(Map<String, Object> m, Map<String, Object> c) {
        List<String> out = new ArrayList<>();
        for (Object n : Json.listAt(m, "nodes")) {
            if ("removed".equals(Json.str(n, "status"))) continue;
            out.add(nodeUrl(n, c));
        }
        return out;
    }

    private static String nodeUrl(Object n, Map<String, Object> c) {
        Object cu = Json.path(n, "clusterUrl");
        return cu != null ? Json.jsString(cu) : "http://" + Json.jsString(Json.path(n, "ipv4")) + ":" + Json.jsString(c.get("clusterPort"));
    }

    /** Finds the leader by asking the given nodes (and following their member lists). */
    public static Leader findLeader(Map<String, Object> c, List<String> urls) {
        ClusterConfig.Keys keys = ClusterConfig.keysFor(c);
        Set<String> tried = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>(urls);
        while (!queue.isEmpty()) {
            String url = queue.pollFirst();
            if (url == null || !tried.add(url)) continue;
            try {
                Map<String, Object> st = Transport.rpcObject(keys.cluster, url, Json.obj("type", "status"), 3000);
                if ("leader".equals(st.get("role"))) return new Leader(url, st);
                Object leaderId = st.get("leaderId");
                List<Object> members = Json.listAt(st, "members");
                for (Object mb : members) {
                    if (leaderId != null && leaderId.equals(Json.path(mb, "id"))) { queue.addFirst(Json.jsString(Json.path(mb, "clusterUrl"))); break; }
                }
                for (Object mb : members) queue.addLast(Json.jsString(Json.path(mb, "clusterUrl")));
            } catch (IOException | RuntimeException ignored) {
                // unreachable
            }
        }
        return null;
    }

    /** IDs of manifest nodes that answer a status RPC (in parallel). */
    public static List<String> probeCluster(Map<String, Object> c, Map<String, Object> m) {
        ClusterConfig.Keys keys = ClusterConfig.keysFor(c);
        List<String> alive = Collections.synchronizedList(new ArrayList<String>());
        List<Object> nodes = new ArrayList<>();
        for (Object n : Json.listAt(m, "nodes")) if (!"removed".equals(Json.str(n, "status"))) nodes.add(n);
        if (nodes.isEmpty()) return alive;
        ExecutorService ex = Executors.newFixedThreadPool(Math.min(nodes.size(), 8));
        for (Object n : nodes) {
            ex.submit(() -> {
                try {
                    Transport.rpc(keys.cluster, nodeUrl(n, c), Json.obj("type", "status"), 3000);
                    alive.add(Json.jsString(Json.path(n, "id")));
                } catch (IOException | RuntimeException ignored) {
                    // gone
                }
            });
        }
        ex.shutdown();
        try {
            ex.awaitTermination(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return new ArrayList<>(alive);
    }

    /** Live overview from the leader, falling back to the manifest. */
    public static Status clusterStatus(Map<String, Object> c, List<String> extraUrls) {
        Map<String, Object> m = readManifest(c);
        List<String> urls = new ArrayList<>(extraUrls == null ? Collections.<String>emptyList() : extraUrls);
        if (m != null) urls.addAll(memberUrls(m, c));
        Leader leader = urls.isEmpty() ? null : findLeader(c, urls);
        Map<String, Object> live = null;
        if (leader != null) {
            try {
                live = Transport.rpcObject(ClusterConfig.keysFor(c).cluster, leader.url, Json.obj("type", "clusterSummary"), 5000);
            } catch (IOException | RuntimeException ignored) {
                live = null;
            }
        }
        return new Status(m, leader != null ? leader.url : null, live);
    }

    public static Status clusterStatus(Map<String, Object> c) { return clusterStatus(c, null); }

    /** Sends a signed job (spawn, move, remove, sleep, drill, snapshot). Reply: {ok, id?, error?}. */
    public static Map<String, Object> sendJob(Map<String, Object> c, String leaderUrl, String type, Map<String, Object> params) throws IOException {
        Map<String, Object> payload = Json.obj("type", type, "params", params == null ? Json.obj() : params);
        Map<String, Object> msg = Json.obj("type", "adminJob", "job", payload, "proof", adminProof(Json.str(c, "masterKey"), payload));
        return Transport.rpcObject(ClusterConfig.keysFor(c).cluster, leaderUrl, msg, 5000);
    }

    /** Sends a signed policy change (as the console's PUT /api/policy does). */
    public static Map<String, Object> setPolicy(Map<String, Object> c, String leaderUrl, Map<String, Object> policy) throws IOException {
        Map<String, Object> msg = Json.obj("type", "setPolicy", "policy", policy, "proof", adminProof(Json.str(c, "masterKey"), policy));
        return Transport.rpcObject(ClusterConfig.keysFor(c).cluster, leaderUrl, msg, 5000);
    }

    // ───────── First node ─────────

    /** Starts the first node of a (new or sleeping) cluster. */
    public static Provisioned provisionFirstNode(Map<String, Object> c, FirstNode opts) throws IOException {
        Map<String, Object> provCfg = Json.map(c, "providers", opts.provider);
        Provider prov = Providers.make(opts.provider, provCfg);
        return provisionFirstNode(c, opts, prov);
    }

    /** Same, with an explicit provider instance (for tests or custom endpoints). */
    public static Provisioned provisionFirstNode(Map<String, Object> c, FirstNode opts, Provider prov) throws IOException {
        String nodeId = "n-" + Bytes.hex(Bytes.random(3));
        String token = Bytes.hex(Bytes.random(32));
        List<Map<String, Object>> storeCfgs = ClusterConfig.stores(c);
        if (storeCfgs.isEmpty()) throw new IOException("Geen opslag ingesteld");
        ObjectStore store = null;
        for (Map<String, Object> sc : storeCfgs) if ("replica".equals(sc.get("purpose"))) { store = Stores.make(sc); break; }
        if (store == null) store = Stores.make(storeCfgs.get(0));
        String key = "bootstrap/" + nodeId + ".enc";
        CloudInit.Options ud = CloudInit.imageUrls(store, new CloudInit.Options(nodeId, "data", store.presignGet(key, 7200), token));
        Provider.ServerInfo info = prov.create(new Provider.CreateSpec(Json.jsString(c.get("cluster")), nodeId, "data", opts.region, opts.size, CloudInit.userData(c, ud)));

        Map<String, Object> nodeCfg = Json.copy(c);
        nodeCfg.put("nodeId", nodeId);
        nodeCfg.put("kind", "data");
        nodeCfg.put("bootstrapLeader", true);
        nodeCfg.put("bootstrapTerm", opts.term);
        nodeCfg.remove("joinToken");
        nodeCfg.put("seeds", Json.list());
        Map<String, Object> adv = Json.obj("clusterUrl", info.clusterUrl != null ? info.clusterUrl : "http://" + info.ipv4 + ":" + Json.jsString(c.get("clusterPort")),
                "apiUrl", info.apiUrl != null ? info.apiUrl : "https://" + info.ipv4);
        if (info.ipv4 != null) adv.put("ipv4", info.ipv4);
        if (info.ipv6 != null) adv.put("ipv6", info.ipv6);
        nodeCfg.put("advertise", adv);
        String country = info.country != null ? info.country : opts.country != null ? opts.country : prov.country(opts.region);
        nodeCfg.put("selfInfo", Json.obj("provider", opts.provider, "region", opts.region, "size", opts.size, "serverId", info.serverId, "country", country));
        if (opts.initialSettings != null) nodeCfg.put("initialSettings", opts.initialSettings);
        else nodeCfg.remove("initialSettings");
        nodeCfg.remove("console");
        store.put(key, EigenCrypto.sealJson(EigenCrypto.deriveKey(Bytes.fromHex(token), "bootstrap"), nodeCfg, "bootstrap"));
        if (Json.truthy(c.get("domain")) && prov.supportsPtr()) {
            try {
                prov.setPtr(info, "mail." + Json.jsString(c.get("domain")));
            } catch (IOException | RuntimeException ignored) {
                // optional
            }
        }
        return new Provisioned(nodeId, info, Json.str(adv, "clusterUrl"));
    }

    // ───────── Admin configuration in storage ─────────

    /** Writes admin-config.enc (sealed with the manifest key, AAD "admin-config") to every store; returns how many succeeded. */
    public static int saveAdminCopy(Map<String, Object> c) {
        ClusterConfig.Keys keys = ClusterConfig.keysFor(c);
        byte[] body = EigenCrypto.sealJson(keys.manifest, c, "admin-config");
        int ok = 0;
        for (Map<String, Object> sc : ClusterConfig.stores(c)) {
            try {
                Stores.make(sc).put("admin-config.enc", body);
                ok++;
            } catch (IOException | RuntimeException ignored) {
                // next
            }
        }
        return ok;
    }

    /** Recovery with only the master key and the details of one store. */
    public static Map<String, Object> recoverAdminConfig(String masterKeyHex, Map<String, Object> store) throws IOException {
        ClusterConfig.Keys keys = ClusterConfig.keysForMaster(masterKeyHex);
        byte[] buf = Stores.make(store).getBuffer("admin-config.enc");
        if (buf == null) throw new IOException("In deze opslag staat geen Eigen Cloud-configuratie");
        try {
            Map<String, Object> m = Json.asMap(EigenCrypto.openJson(keys.manifest, buf, "admin-config"));
            if (m == null) throw new IllegalArgumentException();
            return m;
        } catch (RuntimeException e) {
            throw new IOException("Deze sleutel past niet bij deze opslag");
        }
    }

    // ───────── Testing and preparing storage ─────────

    private static String host(String endpoint) {
        try {
            URL u = new URL(endpoint);
            boolean dflt = u.getPort() == -1 || u.getPort() == u.getDefaultPort();
            return u.getHost() + (dflt ? "" : ":" + u.getPort());
        } catch (IOException e) {
            return endpoint;
        }
    }

    private static String msg(Exception e) { return e.getMessage() != null ? e.getMessage() : e.toString(); }

    /** Tests a store and sets it up (bucket, versioning/object-lock for backups, write+read check). */
    public static List<StepResult> prepareStore(Map<String, Object> cfg) {
        List<StepResult> steps = new ArrayList<>();
        ObjectStore s;
        try {
            s = Stores.make(cfg);
        } catch (RuntimeException e) {
            steps.add(new StepResult("Verbinding en inloggen", false, msg(e)));
            return steps;
        }
        boolean backup = "backup".equals(cfg.get("purpose"));
        String bucket = Json.jsString(cfg.get("bucket"));
        if (s instanceof S3Store) {
            S3Store s3 = (S3Store) s;
            boolean exists;
            try {
                exists = s3.bucketExists();
                steps.add(new StepResult("Verbinding met " + host(Json.str(cfg, "endpoint")), true, null));
            } catch (IOException | RuntimeException e) {
                steps.add(new StepResult("Verbinding en inloggen", false, msg(e)));
                return steps;
            }
            if (!exists) {
                try {
                    s3.createBucket(backup);
                    steps.add(new StepResult("Bucket '" + bucket + "' aangemaakt" + (backup ? " (met object-lock)" : ""), true, null));
                } catch (IOException | RuntimeException e) {
                    steps.add(new StepResult("Bucket '" + bucket + "' aanmaken", false, msg(e)));
                    return steps;
                }
            } else steps.add(new StepResult("Bucket '" + bucket + "' bestaat al", true, null));

            if (backup) {
                boolean v = quietConfig(s3, "versioning", "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Status>Enabled</Status></VersioningConfiguration>");
                steps.add(new StepResult("Versiebeheer aan (overschrijven bewaart de oude versie)", v, v ? null : "Niet ondersteund — zet het zo mogelijk zelf aan in de console van de aanbieder"));
                boolean l = quietConfig(s3, "object-lock", "<ObjectLockConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>");
                steps.add(new StepResult("Onveranderbaar: 30 dagen niet te wissen (object-lock)", l, l ? null : "Niet ondersteund door deze opslag; back-ups worden alsnog nooit door Eigen Cloud verwijderd"));
            }
        }
        try {
            String probe = "test/" + Bytes.hex(Bytes.random(4));
            s.put(probe, Bytes.utf8("eigen-cloud"));
            byte[] back = s.getBuffer(probe);
            if (back == null || !"eigen-cloud".equals(Bytes.utf8(back))) throw new IOException("teruglezen gaf iets anders");
            if ("replica".equals(cfg.get("purpose"))) s.delete(probe);
            steps.add(new StepResult("Schrijven en teruglezen", true, null));
        } catch (IOException | RuntimeException e) {
            steps.add(new StepResult("Schrijven en teruglezen", false, msg(e)));
        }
        return steps;
    }

    private static boolean quietConfig(S3Store s, String sub, String xml) {
        try {
            return s.putBucketConfig(sub, xml);
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** Whether the console would accept a store after prepareStore (versioning/object-lock failures are allowed). */
    public static boolean storeStepsOk(List<StepResult> steps) {
        for (StepResult s : steps) if (!s.ok && !s.label.matches("(?s).*(Versiebeheer|Onveranderbaar).*")) return false;
        return true;
    }

    /** Sends changed admin settings to the running cluster (signed). Returns false when no leader is reachable. */
    public static boolean pushAdminConfig(Map<String, Object> c) throws IOException {
        Status st = clusterStatus(c);
        if (st.leaderUrl == null) return false;
        Map<String, Object> settings = Json.obj();
        Map<String, Object> con = Json.map(c, "console");
        if (con != null) {
            settings.put("mail_relay", con.get("mailRelay") != null ? con.get("mailRelay") : "");
            settings.put("spf_extra", con.get("spfExtra") != null ? con.get("spfExtra") : "");
            if (Json.truthy(con.get("alertEmail"))) settings.put("alert_email", con.get("alertEmail"));
        }
        Map<String, Object> update = Json.obj();
        putDefined(update, "stores", c, "stores");
        putDefined(update, "providers", c, "providers");
        putDefined(update, "dns", c, "dns");
        putDefined(update, "placement", Json.map(c, "policy"), "placement");
        update.put("settings", settings);
        Map<String, Object> msg = Json.obj("type", "adminConfig", "update", update, "proof", adminProof(Json.str(c, "masterKey"), update));
        Map<String, Object> r = Transport.rpcObject(ClusterConfig.keysFor(c).cluster, st.leaderUrl, msg, 8000);
        return Boolean.TRUE.equals(r.get("ok"));
    }

    /** JS omits undefined members: only copy keys that exist. */
    private static void putDefined(Map<String, Object> m, String k, Map<String, Object> from, String fromKey) {
        if (from != null && from.containsKey(fromKey)) m.put(k, from.get(fromKey));
    }
}
