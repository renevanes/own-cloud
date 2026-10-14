package nl.eigencloud.core.gmail;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * IMAP BODYSTRUCTURE → leaf parts with the same section numbers {@link Mime#parse} gives, so a part can be
 * fetched on its own with BODY.PEEK[section] (large attachments, on demand).
 */
public final class BodyStructure {
    private BodyStructure() {}

    public static List<Mime.Part> parse(Object bs) {
        List<Mime.Part> out = new ArrayList<>();
        if (!(bs instanceof List)) return out;
        List<?> l = (List<?>) bs;
        if (!l.isEmpty() && l.get(0) instanceof List) walk(l, "", out, 0);
        else out.add(leaf(l, "1"));
        return out;
    }

    private static void walk(List<?> l, String prefix, List<Mime.Part> out, int depth) {
        int n = 0;
        for (Object o : l) {
            if (!(o instanceof List)) break;
            List<?> child = (List<?>) o;
            n++;
            String sec = prefix.isEmpty() ? String.valueOf(n) : prefix + "." + n;
            if (!child.isEmpty() && child.get(0) instanceof List && depth < 20) walk(child, sec, out, depth + 1);
            else out.add(leaf(child, sec));
        }
    }

    private static Mime.Part leaf(List<?> l, String section) {
        Mime.Part p = new Mime.Part();
        p.section = section;
        String type = s(l, 0).toLowerCase(Locale.ROOT), sub = s(l, 1).toLowerCase(Locale.ROOT);
        p.type = (type.isEmpty() ? "text" : type) + "/" + (sub.isEmpty() ? "plain" : sub);
        Map<String, String> params = params(l.size() > 2 ? l.get(2) : null);
        p.charset = params.get("charset");
        String id = s(l, 3);
        if (!id.isEmpty()) p.cid = id.trim().replaceAll("^<|>$", "");
        p.encoding = s(l, 5).isEmpty() ? null : s(l, 5).toLowerCase(Locale.ROOT);
        long size = Imap.num(l.size() > 6 ? l.get(6) : null);
        p.size = size < 0 ? 0 : "base64".equals(p.encoding) ? size * 3 / 4 : size;
        // extension data: text has "lines"; message/rfc822 has envelope, body and lines
        int ext = 7;
        if (type.equals("text")) ext = 8;
        else if (type.equals("message") && sub.equals("rfc822")) ext = 10;
        int dispIdx = ext + 1; // md5 first
        Object disp = l.size() > dispIdx ? l.get(dispIdx) : null;
        if (disp instanceof List && !((List<?>) disp).isEmpty()) {
            List<?> d = (List<?>) disp;
            p.disposition = Imap.str(d.get(0)).toLowerCase(Locale.ROOT);
            Map<String, String> dp = params(d.size() > 1 ? d.get(1) : null);
            p.filename = dp.get("filename");
        }
        if (p.filename == null || p.filename.isEmpty()) p.filename = params.get("name");
        if (p.filename != null && p.filename.trim().isEmpty()) p.filename = null;
        return p;
    }

    /** ("name" "value" ...) → decoded map (RFC 2231 and RFC 2047 handled like in headers). */
    private static Map<String, String> params(Object o) {
        if (!(o instanceof List)) return new LinkedHashMap<>();
        List<?> l = (List<?>) o;
        StringBuilder b = new StringBuilder();
        for (int i = 0; i + 1 < l.size(); i += 2) {
            b.append("; ").append(Imap.str(l.get(i))).append("=\"").append(Imap.str(l.get(i + 1)).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }
        return Mime.parseParams(b.toString());
    }

    private static String s(List<?> l, int i) { return l.size() > i && l.get(i) != null ? Imap.str(l.get(i)) : ""; }
}
