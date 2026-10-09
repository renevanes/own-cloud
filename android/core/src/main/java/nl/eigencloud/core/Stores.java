package nl.eigencloud.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** makeStore() from src/cluster/stores.ts. */
public final class Stores {
    private Stores() {}

    /** "fs" → {@link FsStore}, anything else → {@link S3Store}. */
    public static ObjectStore make(Map<String, Object> storeConfig) {
        return "fs".equals(Json.str(storeConfig, "type")) ? new FsStore(storeConfig) : new S3Store(storeConfig);
    }

    /** All stores of a cluster config. */
    public static List<ObjectStore> all(Map<String, Object> clusterConfig) {
        List<ObjectStore> out = new ArrayList<>();
        for (Map<String, Object> s : ClusterConfig.stores(clusterConfig)) out.add(make(s));
        return out;
    }
}
