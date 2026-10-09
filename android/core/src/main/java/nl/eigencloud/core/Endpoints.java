package nl.eigencloud.core;

/**
 * Base URLs of external APIs. Overridable (e.g. for tests against a local fake server); providers read
 * them when constructed, the catalog and DNS helpers on each call.
 */
public final class Endpoints {
    private Endpoints() {}

    public static volatile String HETZNER = "https://api.hetzner.cloud/v1";
    /** Scaleway API root (instance and marketplace APIs live below it). */
    public static volatile String SCALEWAY = "https://api.scaleway.com";
    public static volatile String UPCLOUD = "https://api.upcloud.com/1.3";
    public static volatile String DESEC = "https://desec.io/api/v1";
    /** DNS-over-HTTPS JSON resolvers, tried in order. */
    public static volatile String[] DOH = {"https://dns.quad9.net:5053/dns-query", "https://cloudflare-dns.com/dns-query"};

    /** Restores all defaults. */
    public static void reset() {
        HETZNER = "https://api.hetzner.cloud/v1";
        SCALEWAY = "https://api.scaleway.com";
        UPCLOUD = "https://api.upcloud.com/1.3";
        DESEC = "https://desec.io/api/v1";
        DOH = new String[] {"https://dns.quad9.net:5053/dns-query", "https://cloudflare-dns.com/dns-query"};
    }
}
