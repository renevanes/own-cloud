package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Registry of providers — port of src/cluster/adapters.ts and the ONLY place in the Java core where providers are
 * listed. {@link Providers#make}, {@link #makeDns}, {@link Catalog#fetchSizes}, the DNS step ({@link DnsSetup}) and
 * the Caddyfile ({@link CloudInit#caddyfile}) are derived from it.
 *
 * <p>The data part of an adapter (name, fields, regions, help texts) is not duplicated here: it comes from
 * catalog.json, exported from the TypeScript registry by scripts/export-catalog.ts. This registry holds the code part:
 * making servers, live sizes, connecting DNS and setting records. A Java adapter for every adapter in catalog.json
 * with servers or DNS is checked by ProvidersTest ("registry complete").
 *
 * <p>Adding a provider: write {@code <Naam>Provider.java} with a static {@code ADAPTER} (see ExoscaleProvider or
 * OvhProvider for signed requests), add it to {@link #BUILTIN} below, and test it against a fake API (FakeApi).
 */
public final class Adapters {
    private Adapters() {}

    /** new Provider(fields) — may throw IllegalArgumentException for missing fields. */
    public interface MakeProvider { Provider make(Map<String, Object> fields); }

    /** Live sizes and prices in a region (servers.fetchSizes). */
    public interface FetchSizes { List<Catalog.SizeOption> fetch(Map<String, Object> fields, String region) throws IOException; }

    /** dns.connect: checks the key and the zone (or creates it); returns the nameservers. Dutch errors. */
    public interface Connect { List<String> connect(Map<String, Object> fields, String zone) throws IOException; }

    /** dns.create: the DnsProvider that sets records. */
    public interface MakeDns { DnsProvider make(String name, Map<String, Object> fields, String zone); }

    /** dns.caddy: the Caddy DNS-01 line (only for adapters whose module is in Dockerfile.caddy). */
    public interface Caddy { String line(Map<String, Object> fields); }

    /** Servers capability. */
    public static final class Servers {
        public final MakeProvider create;
        public final FetchSizes fetchSizes;

        public Servers(MakeProvider create, FetchSizes fetchSizes) {
            this.create = create;
            this.fetchSizes = fetchSizes;
        }
    }

    /** DNS capability. */
    public static final class Dns {
        public final Connect connect;
        public final MakeDns create;
        /** Null when Caddy has no module for this provider (it then uses HTTP-01). */
        public final Caddy caddy;

        public Dns(Connect connect, MakeDns create, Caddy caddy) {
            this.connect = connect;
            this.create = create;
            this.caddy = caddy;
        }
    }

    /** One provider: its id (as in catalog.json) and what it can do. */
    public static final class Adapter {
        public final String id;
        /** Null when the provider has no servers. */
        public final Servers servers;
        /** Whether it offers S3 storage (the storage code is generic: S3Store). */
        public final boolean storage;
        /** Null when the provider has no DNS. */
        public final Dns dns;

        public Adapter(String id, Servers servers, boolean storage, Dns dns) {
            this.id = id;
            this.servers = servers;
            this.storage = storage;
            this.dns = dns;
        }
    }

    /** Only storage: any S3-compatible storage with its own endpoint (adapters/custom.ts). */
    static final Adapter CUSTOM = new Adapter("custom", null, true, null);

    /** Order = order in the console (same as BUILTIN in src/cluster/adapters.ts, without the test provider "local"). */
    private static final List<Adapter> BUILTIN = Arrays.asList(
            Desec.ADAPTER, ScalewayProvider.ADAPTER, HetznerProvider.ADAPTER, UpCloudProvider.ADAPTER,
            ExoscaleProvider.ADAPTER, OvhProvider.ADAPTER, CUSTOM);

    private static final List<Adapter> registry = new ArrayList<>(BUILTIN);

    /** All adapters, in console order. */
    public static synchronized List<Adapter> all() { return Collections.unmodifiableList(new ArrayList<>(registry)); }

    /** The adapter with this id, or null. */
    public static synchronized Adapter get(String id) {
        for (Adapter a : registry) if (a.id.equals(id)) return a;
        return null;
    }

    /**
     * Adds an adapter at runtime (tests, or a build that adds one). Replaces one with the same id. Returns a
     * Runnable that removes it again (registerAdapter).
     */
    public static synchronized Runnable register(final Adapter a) {
        int i = -1;
        for (int k = 0; k < registry.size(); k++) if (registry.get(k).id.equals(a.id)) i = k;
        final Adapter before = i >= 0 ? registry.get(i) : null;
        if (i >= 0) registry.set(i, a); else registry.add(a);
        return () -> {
            synchronized (Adapters.class) {
                int j = registry.indexOf(a);
                if (j < 0) return;
                if (before != null) registry.set(j, before); else registry.remove(j);
            }
        };
    }

    // ───────── makeProvider / makeDns (src/cluster/providers.ts, src/cluster/dns.ts) ─────────

    /** Provider for config.providers[name] ({@code type} picks another adapter than the name). */
    public static Provider makeProvider(String name, Map<String, Object> cfg) {
        if (cfg == null) throw new IllegalArgumentException("Geen instellingen voor aanbieder " + name);
        String type = cfg.get("type") != null ? Json.jsString(cfg.get("type")) : name;
        Adapter a = get(type);
        if (a == null || a.servers == null) throw new IllegalArgumentException("Onbekende aanbieder " + name);
        return a.servers.create.make(cfg);
    }

    /** All credentials of a DNS config as one field map: {...fields, token?, api?} (dnsFields). */
    public static Map<String, Object> dnsFields(Map<String, Object> c) {
        Map<String, Object> f = Json.obj();
        Map<String, Object> extra = Json.map(c, "fields");
        if (extra != null) f.putAll(extra);
        if (Json.truthy(c.get("token"))) f.put("token", c.get("token"));
        if (Json.truthy(c.get("api"))) f.put("api", c.get("api"));
        return f;
    }

    /**
     * DnsProvider for a DNS config {type, name, token?, zone, fields?, api?}. An unknown type only fails when used
     * (so the rest carries on). Type "file" (tests on the desktop) is not available here and counts as unknown.
     */
    public static DnsProvider makeDns(Map<String, Object> c) {
        final String type = Json.str(c, "type");
        final String name = Json.str(c, "name");
        Adapter a = type == null ? null : get(type);
        if (a == null || a.dns == null) {
            return new DnsProvider() {
                @Override public String name() { return name; }

                @Override public void setRecords(String sub, String t, List<String> values, int ttl) throws IOException {
                    throw new IOException("Onbekende DNS-aanbieder " + type);
                }
            };
        }
        return a.dns.create.make(name, dnsFields(c), Json.str(c, "zone"));
    }

    /** Value of a credential field as a string ("" when missing), like `${fields.x}` would give for set fields. */
    static String field(Map<String, Object> f, String key) {
        Object v = f == null ? null : f.get(key);
        return v == null ? "" : Json.jsString(v);
    }

    /** Like TS {@code fields.x} in a template string: "undefined" when missing. */
    static String fieldJs(Map<String, Object> f, String key) {
        Object v = f == null ? null : f.get(key);
        return v == null ? "undefined" : Json.jsString(v);
    }
}
