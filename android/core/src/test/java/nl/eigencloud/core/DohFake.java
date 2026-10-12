package nl.eigencloud.core;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** A fake DNS-over-HTTPS resolver for FakeApi (RFC 8484 GET ?dns=…): answers from a map "name TYPE" → values. */
final class DohFake {
    private DohFake() {}

    /** "vanes.nl NS" for the question in this request. */
    static String question(FakeApi.Call c) {
        byte[] q = query(c);
        StringBuilder name = new StringBuilder();
        int pos = 12;
        while (q[pos] != 0) {
            if (name.length() > 0) name.append('.');
            name.append(new String(q, pos + 1, q[pos], java.nio.charset.StandardCharsets.US_ASCII));
            pos += 1 + q[pos];
        }
        int t = ((q[pos + 1] & 0xff) << 8) | (q[pos + 2] & 0xff);
        String type = t == 1 ? "A" : t == 2 ? "NS" : t == 28 ? "AAAA" : t == 43 ? "DS" : String.valueOf(t);
        return name.toString().toLowerCase(Locale.ROOT) + " " + type;
    }

    private static byte[] query(FakeApi.Call c) {
        for (String part : c.query.split("&")) if (part.startsWith("dns=")) return Base64.getUrlDecoder().decode(part.substring(4));
        throw new IllegalArgumentException("geen dns=");
    }

    private static void name(ByteArrayOutputStream o, String n) {
        for (String l : n.replaceAll("\\.$", "").split("\\.")) {
            if (l.isEmpty()) continue;
            o.write(l.length());
            byte[] b = l.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            o.write(b, 0, b.length);
        }
        o.write(0);
    }

    /** The answer (rcode 0, also without records; 3 = NXDOMAIN when {@code nx}). Only A and NS values are encoded. */
    static FakeApi.Reply reply(FakeApi.Call c, Map<String, List<String>> records, boolean nx) {
        if (!"application/dns-message".equals(c.headers.get("accept"))) return new FakeApi.Reply(400, "", "text/plain");
        byte[] q = query(c);
        String key = question(c);
        List<String> vals = records.get(key);
        int n = vals == null ? 0 : vals.size();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0); o.write(0); o.write(0x81); o.write(nx ? 0x83 : 0x80);
        o.write(0); o.write(1); o.write(0); o.write(n); o.write(0); o.write(0); o.write(0); o.write(0);
        o.write(q, 12, q.length - 12);
        int type = key.endsWith(" A") ? 1 : 2;
        for (int i = 0; i < n; i++) {
            ByteArrayOutputStream rd = new ByteArrayOutputStream();
            if (type == 1) for (String x : vals.get(i).split("\\.")) rd.write(Integer.parseInt(x));
            else name(rd, vals.get(i));
            o.write(0xc0); o.write(12); o.write(0); o.write(type); o.write(0); o.write(1);
            o.write(0); o.write(0); o.write(1); o.write(0x2c);
            o.write(rd.size() >> 8); o.write(rd.size() & 255);
            byte[] b = rd.toByteArray();
            o.write(b, 0, b.length);
        }
        return new FakeApi.Reply(200, o.toByteArray(), "application/dns-message");
    }

    static FakeApi.Reply reply(FakeApi.Call c, Map<String, List<String>> records) { return reply(c, records, false); }
}
