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
    /** Exoscale Compute/DNS API v2 per zone; "{zone}" is replaced by e.g. "de-fra-1" (EIGEN_EXO_API on the desktop). */
    public static volatile String EXOSCALE = "https://api-{zone}.exoscale.com/v2";
    /** OVHcloud API (EIGEN_OVH_API on the desktop); also the public price catalogue below it. */
    public static volatile String OVH = "https://eu.api.ovh.com/1.0";
    /** Mollie API (alleen om de sleutel van een aanbieder te controleren). */
    public static volatile String MOLLIE = "https://api.mollie.com/v2";
    /** Openprovider API (alleen om de gebruiker van een aanbieder te controleren). */
    public static volatile String OPENPROVIDER = "https://api.openprovider.eu/v1beta";
    /** DNS-over-HTTPS JSON resolvers, tried in order. */
    public static volatile String[] DOH = {"https://dns.quad9.net:5053/dns-query", "https://cloudflare-dns.com/dns-query"};
    /** Public list of providers (aanbieders.json in the repository; EIGEN_AANBIEDERS_URL on the desktop). */
    public static volatile String AANBIEDERS = "https://raw.githubusercontent.com/renevanes/own-cloud/main/aanbieders.json";

    /** Restores all defaults. */
    public static void reset() {
        HETZNER = "https://api.hetzner.cloud/v1";
        SCALEWAY = "https://api.scaleway.com";
        UPCLOUD = "https://api.upcloud.com/1.3";
        DESEC = "https://desec.io/api/v1";
        EXOSCALE = "https://api-{zone}.exoscale.com/v2";
        OVH = "https://eu.api.ovh.com/1.0";
        MOLLIE = "https://api.mollie.com/v2";
        OPENPROVIDER = "https://api.openprovider.eu/v1beta";
        DOH = new String[] {"https://dns.quad9.net:5053/dns-query", "https://cloudflare-dns.com/dns-query"};
        AANBIEDERS = "https://raw.githubusercontent.com/renevanes/own-cloud/main/aanbieders.json";
    }
}
