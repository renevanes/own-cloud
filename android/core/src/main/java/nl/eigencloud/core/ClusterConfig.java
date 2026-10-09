package nl.eigencloud.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Port of src/cluster/config.ts. A cluster configuration is kept as a JSON object (see {@link Json}) with the
 * same shape as the TS {@code ClusterConfig} (and {@code AdminConfig} = ClusterConfig + "console"), so that it
 * round-trips unchanged through the vault, the storage copy and the running cluster.
 */
public final class ClusterConfig {
    private ClusterConfig() {}

    /** Keys derived from a configuration (master-only fields are null for witness configs). */
    public static final class Keys {
        public final byte[] master;
        public final byte[] cluster;
        public final byte[] db;
        public final byte[] blobs;
        public final byte[] manifest;

        Keys(byte[] master, byte[] cluster, byte[] db, byte[] blobs, byte[] manifest) {
            this.master = master;
            this.cluster = cluster;
            this.db = db;
            this.blobs = blobs;
            this.manifest = manifest;
        }
    }

    /** keysFor(): masterKey → cluster/db/blobs/manifest subkeys, or clusterKey only. */
    public static Keys keysFor(Map<String, Object> c) {
        String mk = Json.str(c, "masterKey");
        if (mk != null && !mk.isEmpty()) {
            byte[] m = EigenCrypto.parseKey(mk);
            return new Keys(m, EigenCrypto.deriveKey(m, "cluster"), EigenCrypto.deriveKey(m, "db"), EigenCrypto.deriveKey(m, "blobs"), EigenCrypto.deriveKey(m, "manifest"));
        }
        String ck = Json.str(c, "clusterKey");
        if (ck != null && !ck.isEmpty()) return new Keys(null, EigenCrypto.parseKey(ck), null, null, null);
        throw new IllegalArgumentException("Geen sleutel in clusterconfiguratie");
    }

    /** Keys for just a master key hex string. */
    public static Keys keysForMaster(String masterKeyHex) { return keysFor(Json.obj("masterKey", masterKeyHex)); }

    /** DEFAULT_POLICY (new copy each call, same key order as TS). */
    public static Map<String, Object> defaultPolicy() {
        return Json.obj(
                "minDataNodes", 2L,
                "witnesses", 1L,
                "autoHeal", true,
                "autoReplaceAfterMin", 15L,
                "placement", new ArrayList<Object>(),
                "snapshotEveryHours", 24L,
                "retentionDays", 30L,
                "drillEveryDays", 7L,
                "segmentEverySec", 5L);
    }

    /** Applies the defaults of loadClusterConfig() in place and returns the same map. */
    public static Map<String, Object> normalize(Map<String, Object> c) {
        Map<String, Object> pol = defaultPolicy();
        Map<String, Object> cur = Json.map(c, "policy");
        if (cur != null) pol.putAll(cur);
        c.put("policy", pol);
        if (c.get("seeds") == null) c.put("seeds", new ArrayList<Object>());
        if (c.get("stores") == null) c.put("stores", new ArrayList<Object>());
        if (c.get("providers") == null) c.put("providers", Json.obj());
        if (c.get("dns") == null) c.put("dns", new ArrayList<Object>());
        if (c.get("image") == null) c.put("image", Json.obj());
        if (c.get("appEnv") == null) c.put("appEnv", Json.obj());
        return c;
    }

    /** A placement entry ({provider, region, size, country?, kind?}); null fields are omitted. */
    public static Map<String, Object> placement(String provider, String region, String size, String country, String kind) {
        Map<String, Object> p = Json.obj("provider", provider, "region", region, "size", size);
        if (country != null) p.put("country", country);
        if (kind != null) p.put("kind", kind);
        return p;
    }

    /** The configured stores as maps. */
    public static List<Map<String, Object>> stores(Map<String, Object> c) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : Json.listAt(c, "stores")) if (o instanceof Map) out.add(Json.asMap(o));
        return out;
    }

    /** clusterPort as int (default 7946). */
    public static int clusterPort(Map<String, Object> c) {
        Number n = Json.num(c, "clusterPort");
        return n == null ? 7946 : n.intValue();
    }
}
