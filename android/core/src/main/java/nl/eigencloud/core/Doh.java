package nl.eigencloud.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * DNS lookups via DNS-over-HTTPS (RFC 8484: the binary DNS message with GET ?dns=…), at European resolvers that do not
 * keep users' IP addresses and do not filter: Quad9 without threat blocking (foundation in Switzerland) and DNS4EU unfiltered (Whalebone, Czech Republic, EU);
 * see {@link Endpoints#DOH}. Port of src/console/doh.ts: the desktop console and the app give the same answer to
 * "where is the DNS of this domain". JSON (application/dns-json) is not documented by Quad9, hence the standard format.
 */
public final class Doh {
    private Doh() {}

    /** How long to wait for one resolver (DOH_TIMEOUT_MS). */
    public static final int TIMEOUT_MS = 4000;

    /** One answer: rcode (0 found, 3 NXDOMAIN) and the values of the asked type (see doh.ts). */
    public static final class Answer {
        public final int rcode;
        public final List<String> values;

        Answer(int rcode, List<String> values) {
            this.rcode = rcode;
            this.values = values;
        }
    }

    static int typeCode(String type) {
        switch (type) {
            case "A": return 1;
            case "NS": return 2;
            case "AAAA": return 28;
            case "DS": return 43;
            default: throw new IllegalArgumentException("Onbekend type " + type);
        }
    }

    /** The question as a DNS message (id 0, recursion desired, one question, class IN). */
    public static byte[] encodeQuery(String name, String type) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(new byte[] {0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}, 0, 12);
        for (String l : name.replaceAll("\\.$", "").split("\\.")) {
            if (l.isEmpty()) continue;
            byte[] b = l.toLowerCase(Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            if (b.length > 63) throw new IllegalArgumentException("Te lange naam");
            out.write(b.length);
            out.write(b, 0, b.length);
        }
        int t = typeCode(type);
        out.write(0);
        out.write(t >> 8);
        out.write(t & 255);
        out.write(0);
        out.write(1);
        return out.toByteArray();
    }

    private static int u8(byte[] m, int i) { return m[i] & 0xff; }

    private static int u16(byte[] m, int i) { return (u8(m, i) << 8) | u8(m, i + 1); }

    /** A name from the message (with pointers, RFC 1035 4.1.4): {name, end of the field}. */
    private static Object[] readName(byte[] m, int at) {
        List<String> labels = new ArrayList<>();
        int pos = at, end = -1, jumps = 0;
        for (;;) {
            if (pos >= m.length) throw new IllegalStateException("Kapot DNS-antwoord");
            int len = u8(m, pos);
            if ((len & 0xc0) == 0xc0) {
                if (pos + 1 >= m.length || ++jumps > 20) throw new IllegalStateException("Kapot DNS-antwoord");
                if (end < 0) end = pos + 2;
                pos = ((len & 0x3f) << 8) | u8(m, pos + 1);
                continue;
            }
            if (len == 0) { if (end < 0) end = pos + 1; break; }
            if (pos + 1 + len > m.length) throw new IllegalStateException("Kapot DNS-antwoord");
            labels.add(new String(m, pos + 1, len, java.nio.charset.StandardCharsets.ISO_8859_1));
            pos += 1 + len;
        }
        return new Object[] {String.join(".", labels).toLowerCase(Locale.ROOT), end};
    }

    /** IPv6 as in RFC 5952 (ipv6Text in doh.ts). */
    public static String ipv6Text(byte[] b, int off) {
        int[] g = new int[8];
        for (int i = 0; i < 8; i++) g[i] = (u8(b, off + 2 * i) << 8) | u8(b, off + 2 * i + 1);
        int best = -1, bestLen = 0;
        for (int i = 0; i < 8;) {
            if (g[i] != 0) { i++; continue; }
            int j = i;
            while (j < 8 && g[j] == 0) j++;
            if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
            i = j;
        }
        List<String> hex = new ArrayList<>();
        for (int x : g) hex.add(Integer.toHexString(x));
        if (best < 0) return String.join(":", hex);
        return String.join(":", hex.subList(0, best)) + "::" + String.join(":", hex.subList(best + bestLen, 8));
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** Reads an answer message; only records of the asked type count (decodeAnswer in doh.ts). */
    public static Answer decodeAnswer(byte[] m, String type) {
        if (m.length < 12) throw new IllegalStateException("Kapot DNS-antwoord");
        int want = typeCode(type);
        int rcode = u8(m, 3) & 0x0f;
        int qd = u16(m, 4), an = u16(m, 6);
        int pos = 12;
        for (int i = 0; i < qd; i++) pos = (Integer) readName(m, pos)[1] + 4;
        List<String> values = new ArrayList<>();
        for (int i = 0; i < an; i++) {
            pos = (Integer) readName(m, pos)[1];
            if (pos + 10 > m.length) throw new IllegalStateException("Kapot DNS-antwoord");
            int t = u16(m, pos), len = u16(m, pos + 8);
            int rd = pos + 10;
            if (rd + len > m.length) throw new IllegalStateException("Kapot DNS-antwoord");
            if (t == want) {
                if (t == 1 && len == 4) values.add(u8(m, rd) + "." + u8(m, rd + 1) + "." + u8(m, rd + 2) + "." + u8(m, rd + 3));
                else if (t == 28 && len == 16) values.add(ipv6Text(m, rd));
                else if (t == 2) values.add((String) readName(m, rd)[0]);
                else if (t == 43 && len > 4) {
                    StringBuilder hex = new StringBuilder();
                    for (int k = rd + 4; k < rd + len; k++) hex.append(HEX[u8(m, k) >> 4]).append(HEX[u8(m, k) & 15]);
                    values.add(u16(m, rd) + " " + u8(m, rd + 2) + " " + u8(m, rd + 3) + " " + hex);
                }
            }
            pos = rd + len;
        }
        return new Answer(rcode, values);
    }

    /** Lookup at the first resolver that answers (else the next); null when none gave a usable answer. */
    public static Answer lookup(String name, String type) {
        String q = Base64.getUrlEncoder().withoutPadding().encodeToString(encodeQuery(name, type));
        for (String base : Endpoints.DOH) {
            try {
                Http.Response r = Http.request("GET", base + (base.contains("?") ? "&" : "?") + "dns=" + q, Http.headers("accept", "application/dns-message"), null, TIMEOUT_MS);
                if (!r.ok()) continue;
                Answer a = decodeAnswer(r.body, type);
                if (a.rcode != 0 && a.rcode != 3) continue;
                return a;
            } catch (IOException | RuntimeException ignored) {
                // next resolver
            }
        }
        return null;
    }

    private static final String[][] NS_NAMES = {
        {"(^|\\.)desec\\.(io|org)$", "deSEC"},
        {"(^|\\.)openprovider\\.(nl|be|eu|com)$", "Openprovider"},
        {"(^|\\.)transip\\.(net|nl|eu)$", "TransIP"},
        {"(^|\\.)hetzner\\.(com|de)$", "Hetzner"},
        {"(^|\\.)dom\\.scw\\.cloud$", "Scaleway"},
        {"(^|\\.)(ovh\\.net|ovh\\.ca|anycast\\.me)$", "OVHcloud"},
        {"(^|\\.)exoscale\\.(ch|com|io|net)$", "Exoscale"},
        {"(^|\\.)cloudflare\\.com$", "Cloudflare"},
        {"(^|\\.)domaincontrol\\.com$", "GoDaddy"},
        {"(^|\\.)registrar-servers\\.com$", "Namecheap"},
        {"(^|\\.)gandi\\.net$", "Gandi"},
        {"(^|\\.)versio\\.(nl|eu)$", "Versio"},
        {"(^|\\.)strato\\.(de|nl)$", "Strato"},
        {"(^|\\.)mijndomein\\.nl$", "Mijndomein"},
        {"(^|\\.)hostnet\\.nl$", "Hostnet"},
        {"(^|\\.)antagonist\\.nl$", "Antagonist"},
        {"(^|\\.)vimexx\\.nl$", "Vimexx"},
        {"(^|\\.)one\\.com$", "one.com"},
        {"(^|\\.)(ui-dns\\.(com|org|de|biz)|ionos\\.\\w+)$", "IONOS"},
        {"(^|\\.)hostinger\\.\\w+$", "Hostinger"},
        {"(^|\\.)awsdns-\\d+\\.\\w+$", "Amazon"},
        {"(^|\\.)azure-dns\\.\\w+$", "Microsoft Azure"},
        {"(^|\\.)(googledomains\\.com|google\\.com)$", "Google"},
    };
    private static final List<Object[]> NS_PATTERNS = new ArrayList<>();
    static {
        for (String[] x : NS_NAMES) NS_PATTERNS.add(new Object[] {Pattern.compile(x[0]), x[1]});
    }

    private static String norm(String x) { return x.toLowerCase(Locale.ROOT).replaceAll("\\.$", ""); }

    /** Name of the DNS provider of these nameservers (the first one recognized), or null (nsProvider). */
    public static String nsProvider(List<String> ns) {
        for (String n : ns) for (Object[] p : NS_PATTERNS) if (((Pattern) p[0]).matcher(norm(n)).find()) return (String) p[1];
        return null;
    }

    /** Are all expected nameservers among the domain's (case and trailing dot do not matter)? (nsMatch) */
    public static boolean nsMatch(List<String> have, List<String> want) {
        if (want.isEmpty()) return false;
        java.util.Set<String> h = new java.util.HashSet<>();
        for (String x : have) h.add(norm(x));
        for (String w : want) if (!h.contains(norm(w))) return false;
        return true;
    }
}
