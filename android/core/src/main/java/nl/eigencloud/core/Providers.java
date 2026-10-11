package nl.eigencloud.core;

import java.util.Map;

/**
 * makeProvider() from src/cluster/providers.ts. The providers themselves are listed in the registry
 * ({@link Adapters}); the desktop test provider "local" is not available on the phone.
 */
public final class Providers {
    private Providers() {}

    /** Picks the adapter by {@code cfg.type ?? name}; "Onbekende aanbieder …" when it has no servers. */
    public static Provider make(String name, Map<String, Object> cfg) { return Adapters.makeProvider(name, cfg); }
}
