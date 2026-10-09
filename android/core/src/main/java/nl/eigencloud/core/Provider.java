package nl.eigencloud.core;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Port of the Provider interface from src/cluster/providers.ts. */
public interface Provider {
    /** What to create. */
    final class CreateSpec {
        public final String cluster, nodeId, kind, region, size, userData;

        /** @param kind "data" or "witness" */
        public CreateSpec(String cluster, String nodeId, String kind, String region, String size, String userData) {
            this.cluster = cluster;
            this.nodeId = nodeId;
            this.kind = kind;
            this.region = region;
            this.size = size;
            this.userData = userData;
        }
    }

    /** A created server. Null fields are "undefined" in TS. */
    final class ServerInfo {
        public String serverId;
        public String ipv4;
        public String ipv6;
        public Double monthlyCost;
        public String country;
        /** Overrides the default http://&lt;ipv4&gt;:7946. */
        public String clusterUrl;
        public String apiUrl;

        /** JSON object with the TS key order, undefined fields omitted. */
        public Map<String, Object> toJson() {
            Map<String, Object> m = Json.obj("serverId", serverId);
            if (ipv4 != null) m.put("ipv4", ipv4);
            if (ipv6 != null) m.put("ipv6", ipv6);
            if (monthlyCost != null) m.put("monthlyCost", monthlyCost);
            if (country != null) m.put("country", country);
            if (clusterUrl != null) m.put("clusterUrl", clusterUrl);
            if (apiUrl != null) m.put("apiUrl", apiUrl);
            return m;
        }

        @Override public String toString() { return Json.stringify(toJson()); }
    }

    /** A server of a cluster as listed by the provider. */
    final class ServerRef {
        public final String serverId, nodeId;

        public ServerRef(String serverId, String nodeId) {
            this.serverId = serverId;
            this.nodeId = nodeId;
        }

        @Override public String toString() { return serverId + "/" + nodeId; }
    }

    String name();

    ServerInfo create(CreateSpec spec) throws IOException;

    void destroy(String serverId) throws IOException;

    List<ServerRef> list(String cluster) throws IOException;

    /** Sets reverse DNS; providers without support do nothing. */
    void setPtr(ServerInfo server, String hostname) throws IOException;

    /** Whether {@link #setPtr} does anything. */
    boolean supportsPtr();

    /** ISO country code of a region. */
    String country(String region);
}
