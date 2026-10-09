package nl.eigencloud.core;

import java.util.Map;

/** makeProvider() from src/cluster/providers.ts (the "local" test provider is not available on the phone). */
public final class Providers {
    private Providers() {}

    /** Picks the adapter by {@code cfg.type ?? name}. */
    public static Provider make(String name, Map<String, Object> cfg) {
        if (cfg == null) throw new IllegalArgumentException("Geen instellingen voor aanbieder " + name);
        String type = cfg.get("type") != null ? Json.jsString(cfg.get("type")) : name;
        switch (type) {
            case "hetzner": return new HetznerProvider(cfg);
            case "scaleway": return new ScalewayProvider(cfg);
            case "upcloud": return new UpCloudProvider(cfg);
            default: throw new IllegalArgumentException("Onbekende aanbieder " + name);
        }
    }
}
