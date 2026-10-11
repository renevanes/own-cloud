package nl.eigencloud.core;

import java.io.IOException;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Port of the DnsProvider interface from src/cluster/adapters/types.ts: sets all records of one name and type at a
 * DNS provider. The implementations live next to their provider (HetznerProvider.Dns, ScalewayProvider.Dns,
 * ExoscaleProvider.Dns, OvhProvider.Dns, Desec.Dns) and are created through {@link Adapters}.
 */
public interface DnsProvider {
    String name();

    /**
     * Replaces all records of {@code sub} (relative to the zone, "" = the zone itself) and {@code type}
     * ("A", "AAAA", "MX", "TXT"). Values in zone-file notation: A/AAAA an address, MX "10 mail.voorbeeld.nl.",
     * TXT quoted (long values as "…" "…"). An empty list removes the records.
     */
    void setRecords(String sub, String type, List<String> values, int ttl) throws IOException;

    // ───────── Helpers from src/cluster/adapters/http.ts ─────────

    /** Zone-file notation → raw value: {@code "a" "b"} → {@code ab} (unquoteTxt). */
    static String unquoteTxt(String v) {
        return v.replaceAll("\"\\s*\"", "").replaceAll("^\"|\"$", "");
    }

    /** An MX value split into priority and host (without trailing dot). */
    final class Mx {
        public final long priority;
        public final String host;

        Mx(long priority, String host) {
            this.priority = priority;
            this.host = host;
        }
    }

    /** "10 mail.voorbeeld.nl." → {priority 10, host "mail.voorbeeld.nl"} (parseMx). */
    static Mx parseMx(String v) {
        Matcher m = Pattern.compile("^(\\d+)\\s+(\\S+?)\\.?$").matcher(v.trim());
        if (m.find()) return new Mx(Long.parseLong(m.group(1)), m.group(2));
        return new Mx(10, v.trim().replaceAll("\\.$", ""));
    }
}
