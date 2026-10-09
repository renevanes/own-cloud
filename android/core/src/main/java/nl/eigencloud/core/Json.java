package nl.eigencloud.core;

import java.math.BigDecimal;
import java.math.MathContext;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON parser and serializer that is compatible with JavaScript's {@code JSON.parse} and
 * {@code JSON.stringify}.
 *
 * <p>Value model: objects are {@code LinkedHashMap<String,Object>} (insertion order preserved, like JS),
 * arrays are {@code ArrayList<Object>}, strings are {@code String}, numbers are {@code Long} (integers up
 * to 2^53) or {@code Double}, booleans are {@code Boolean} and JSON null is Java {@code null}.
 *
 * <p>{@link #stringify(Object)} produces byte-identical output to {@code JSON.stringify} for the same
 * value. This matters for signatures: the admin proof is an HMAC over the serialized payload, and the
 * Node leader re-serializes the parsed payload to verify it. Note: JS {@code undefined} has no Java
 * counterpart; remove a key from the map instead of setting it to {@code null} when JS would omit it.
 */
public final class Json {
    private Json() {}

    private static final double MAX_SAFE = 9007199254740992d; // 2^53

    // ───────── Parsing ─────────

    /** Parses JSON text. Throws {@link IllegalArgumentException} on malformed input. */
    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != text.length()) throw p.err("Onverwachte tekens na JSON-waarde");
        return v;
    }

    /** Parses JSON text that must be an object. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object v = parse(text);
        if (!(v instanceof Map)) throw new IllegalArgumentException("JSON-object verwacht");
        return (Map<String, Object>) v;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) { this.s = s; }

        IllegalArgumentException err(String m) { return new IllegalArgumentException(m + " (positie " + i + ")"); }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }

        Object value() {
            if (i >= s.length()) throw err("Onverwacht einde van JSON");
            char c = s.charAt(i);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': lit("true"); return Boolean.TRUE;
                case 'f': lit("false"); return Boolean.FALSE;
                case 'n': lit("null"); return null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number();
                    throw err("Ongeldig teken in JSON");
            }
        }

        void lit(String w) {
            if (!s.startsWith(w, i)) throw err("Ongeldige JSON");
            i += w.length();
        }

        Map<String, Object> object() {
            LinkedHashMap<String, Object> m = new LinkedHashMap<>();
            i++;
            ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            for (;;) {
                ws();
                if (i >= s.length() || s.charAt(i) != '"') throw err("Sleutel verwacht");
                String k = string();
                ws();
                if (i >= s.length() || s.charAt(i) != ':') throw err("':' verwacht");
                i++;
                ws();
                Object v = value();
                // JS: a duplicate key keeps its first position but takes the last value (same as LinkedHashMap.put).
                m.put(k, v);
                ws();
                if (i >= s.length()) throw err("Onverwacht einde van JSON");
                char c = s.charAt(i++);
                if (c == '}') return m;
                if (c != ',') throw err("',' of '}' verwacht");
            }
        }

        List<Object> array() {
            ArrayList<Object> a = new ArrayList<>();
            i++;
            ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
            for (;;) {
                ws();
                a.add(value());
                ws();
                if (i >= s.length()) throw err("Onverwacht einde van JSON");
                char c = s.charAt(i++);
                if (c == ']') return a;
                if (c != ',') throw err("',' of ']' verwacht");
            }
        }

        String string() {
            i++; // opening quote
            StringBuilder b = new StringBuilder();
            for (;;) {
                if (i >= s.length()) throw err("Tekst niet afgesloten");
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c < 0x20) throw err("Stuurteken in tekst");
                if (c != '\\') { b.append(c); continue; }
                if (i >= s.length()) throw err("Tekst niet afgesloten");
                char e = s.charAt(i++);
                switch (e) {
                    case '"': b.append('"'); break;
                    case '\\': b.append('\\'); break;
                    case '/': b.append('/'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'u':
                        if (i + 4 > s.length()) throw err("Ongeldige \\u-code");
                        int cp = 0;
                        for (int k = 0; k < 4; k++) {
                            int d = Character.digit(s.charAt(i + k), 16);
                            if (d < 0) throw err("Ongeldige \\u-code");
                            cp = cp * 16 + d;
                        }
                        i += 4;
                        b.append((char) cp);
                        break;
                    default: throw err("Ongeldige escape");
                }
            }
        }

        Object number() {
            int start = i;
            if (s.charAt(i) == '-') i++;
            if (i >= s.length()) throw err("Ongeldig getal");
            if (s.charAt(i) == '0') i++;
            else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') { while (i < s.length() && Character.isDigit(s.charAt(i))) i++; }
            else throw err("Ongeldig getal");
            boolean integral = true;
            if (i < s.length() && s.charAt(i) == '.') {
                integral = false;
                i++;
                int d = i;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                if (d == i) throw err("Ongeldig getal");
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                integral = false;
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                int d = i;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                if (d == i) throw err("Ongeldig getal");
            }
            String t = s.substring(start, i);
            return normalizeNumber(integral ? null : Double.parseDouble(t), integral ? t : null);
        }
    }

    /** Integers (that JS can represent exactly) become Long, everything else Double. */
    private static Object normalizeNumber(Double d, String intText) {
        if (intText != null) {
            if (intText.length() <= 16) {
                long l = Long.parseLong(intText);
                if (Math.abs(l) <= 9007199254740992L) {
                    if (l == 0 && intText.startsWith("-")) return -0.0d;
                    return l;
                }
            }
            return Double.parseDouble(intText);
        }
        double v = d;
        if (v == Math.rint(v) && Math.abs(v) <= MAX_SAFE && !(v == 0 && 1 / v < 0)) return (long) v;
        return v;
    }

    // ───────── Serialization ─────────

    /** Serializes like {@code JSON.stringify(value)}. */
    public static String stringify(Object value) {
        StringBuilder b = new StringBuilder();
        write(b, value, null, "");
        return b.toString();
    }

    /** Serializes like {@code JSON.stringify(value, null, indent)}. */
    public static String stringify(Object value, int indent) {
        if (indent <= 0) return stringify(value);
        StringBuilder sp = new StringBuilder();
        for (int i = 0; i < Math.min(indent, 10); i++) sp.append(' ');
        StringBuilder b = new StringBuilder();
        write(b, value, sp.toString(), "");
        return b.toString();
    }

    private static void write(StringBuilder b, Object v, String gap, String indent) {
        if (v == null) { b.append("null"); return; }
        if (v instanceof String) { quote(b, (String) v); return; }
        if (v instanceof Boolean) { b.append(v.toString()); return; }
        if (v instanceof Number) { b.append(numberToString((Number) v)); return; }
        if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            if (m.isEmpty()) { b.append("{}"); return; }
            String inner = gap == null ? "" : indent + gap;
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : jsPropertyOrder(m)) {
                if (!first) b.append(',');
                first = false;
                if (gap != null) b.append('\n').append(inner);
                quote(b, String.valueOf(e.getKey()));
                b.append(':');
                if (gap != null) b.append(' ');
                write(b, e.getValue(), gap, inner);
            }
            if (gap != null) b.append('\n').append(indent);
            b.append('}');
            return;
        }
        if (v instanceof List || v instanceof Object[]) {
            List<?> l = v instanceof List ? (List<?>) v : java.util.Arrays.asList((Object[]) v);
            if (l.isEmpty()) { b.append("[]"); return; }
            String inner = gap == null ? "" : indent + gap;
            b.append('[');
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) b.append(',');
                if (gap != null) b.append('\n').append(inner);
                write(b, l.get(i), gap, inner);
            }
            if (gap != null) b.append('\n').append(indent);
            b.append(']');
            return;
        }
        throw new IllegalArgumentException("Kan " + v.getClass().getName() + " niet als JSON schrijven");
    }

    /**
     * JS own-property order: array-index keys ("0" … "4294967294", canonical form) first in ascending numeric
     * order, then all other keys in insertion order.
     */
    private static Iterable<? extends Map.Entry<?, ?>> jsPropertyOrder(Map<?, ?> m) {
        List<Map.Entry<?, ?>> idx = null;
        for (Map.Entry<?, ?> e : m.entrySet()) {
            if (arrayIndex(String.valueOf(e.getKey())) >= 0) {
                if (idx == null) idx = new ArrayList<>();
                idx.add(e);
            }
        }
        if (idx == null) return m.entrySet();
        idx.sort((a, c) -> Long.compare(arrayIndex(String.valueOf(a.getKey())), arrayIndex(String.valueOf(c.getKey()))));
        List<Map.Entry<?, ?>> all = new ArrayList<>(idx);
        for (Map.Entry<?, ?> e : m.entrySet()) if (arrayIndex(String.valueOf(e.getKey())) < 0) all.add(e);
        return all;
    }

    /** The numeric value of a canonical array-index key, or -1. */
    private static long arrayIndex(String k) {
        int n = k.length();
        if (n == 0 || n > 10) return -1;
        if (n > 1 && k.charAt(0) == '0') return -1;
        long v = 0;
        for (int i = 0; i < n; i++) {
            char c = k.charAt(i);
            if (c < '0' || c > '9') return -1;
            v = v * 10 + (c - '0');
        }
        return v <= 4294967294L ? v : -1;
    }

    /** Quotes a string exactly like JSON.stringify (well-formed variant, ES2019+). */
    public static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        quote(b, s);
        return b.toString();
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static void quote(StringBuilder b, String s) {
        b.append('"');
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); continue;
                case '\\': b.append("\\\\"); continue;
                case '\b': b.append("\\b"); continue;
                case '\f': b.append("\\f"); continue;
                case '\n': b.append("\\n"); continue;
                case '\r': b.append("\\r"); continue;
                case '\t': b.append("\\t"); continue;
                default: break;
            }
            if (c < 0x20) { hexEscape(b, c); continue; }
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < n && Character.isLowSurrogate(s.charAt(i + 1))) { b.append(c).append(s.charAt(++i)); }
                else hexEscape(b, c);
                continue;
            }
            if (Character.isLowSurrogate(c)) { hexEscape(b, c); continue; }
            b.append(c);
        }
        b.append('"');
    }

    private static void hexEscape(StringBuilder b, char c) {
        b.append("\\u").append(HEX[(c >> 12) & 15]).append(HEX[(c >> 8) & 15]).append(HEX[(c >> 4) & 15]).append(HEX[c & 15]);
    }

    /** Formats a number like JavaScript's {@code Number.prototype.toString()} (as used by JSON.stringify). */
    public static String numberToString(Number n) {
        if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) {
            long l = n.longValue();
            if (Math.abs((double) l) < 1e21) return Long.toString(l);
            return numberToString((double) l);
        }
        return numberToString(n.doubleValue());
    }

    /** JS Number#toString for a double; NaN/Infinity become "null" as in JSON. */
    public static String numberToString(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == 0) return "0";
        boolean neg = d < 0;
        double a = Math.abs(d);
        // Shortest decimal digits that round-trip (portable: does not rely on Double.toString's algorithm).
        BigDecimal exact = new BigDecimal(a);
        BigDecimal r = null;
        for (int p = 1; p <= 17; p++) {
            BigDecimal t = exact.round(new MathContext(p, java.math.RoundingMode.HALF_EVEN));
            if (t.doubleValue() == a) { r = t; break; }
        }
        if (r == null) r = exact.round(new MathContext(17));
        r = r.stripTrailingZeros();
        String digits = r.unscaledValue().toString();
        int k = digits.length();
        int nExp = k - r.scale(); // value = 0.digits × 10^nExp
        StringBuilder b = new StringBuilder();
        if (neg) b.append('-');
        if (k <= nExp && nExp <= 21) {
            b.append(digits);
            for (int i = 0; i < nExp - k; i++) b.append('0');
        } else if (0 < nExp && nExp <= 21) {
            b.append(digits, 0, nExp).append('.').append(digits, nExp, k);
        } else if (-6 < nExp && nExp <= 0) {
            b.append("0.");
            for (int i = 0; i < -nExp; i++) b.append('0');
            b.append(digits);
        } else {
            int e = nExp - 1;
            b.append(digits.charAt(0));
            if (k > 1) b.append('.').append(digits, 1, k);
            b.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
        }
        return b.toString();
    }

    // ───────── Convenience accessors ─────────

    /** New empty object. */
    public static Map<String, Object> obj() { return new LinkedHashMap<>(); }

    /** Object from alternating key/value pairs: {@code obj("a", 1, "b", "x")}. */
    public static Map<String, Object> obj(Object... kv) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], normalize(kv[i + 1]));
        return m;
    }

    /** New list with the given items. */
    public static List<Object> list(Object... items) {
        ArrayList<Object> l = new ArrayList<>();
        for (Object o : items) l.add(normalize(o));
        return l;
    }

    private static Object normalize(Object o) {
        if (o instanceof Integer || o instanceof Short || o instanceof Byte) return ((Number) o).longValue();
        if (o instanceof Float) return ((Float) o).doubleValue();
        return o;
    }

    /** Deep copy of a JSON value (maps and lists are copied, scalars shared). */
    @SuppressWarnings("unchecked")
    public static <T> T copy(T v) {
        if (v instanceof Map) {
            LinkedHashMap<String, Object> m = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) m.put(e.getKey(), copy(e.getValue()));
            return (T) m;
        }
        if (v instanceof List) {
            ArrayList<Object> l = new ArrayList<>();
            for (Object o : (List<Object>) v) l.add(copy(o));
            return (T) l;
        }
        return v;
    }

    /** Casts to an object map, or null. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> asMap(Object v) { return v instanceof Map ? (Map<String, Object>) v : null; }

    /** Casts to a list, or null. */
    @SuppressWarnings("unchecked")
    public static List<Object> asList(Object v) { return v instanceof List ? (List<Object>) v : null; }

    /** Walks a path of object keys / list indices; returns null when any step is missing (like JS ?.). */
    public static Object path(Object root, Object... keys) {
        Object cur = root;
        for (Object k : keys) {
            if (cur == null) return null;
            if (k instanceof Integer && cur instanceof List) {
                List<?> l = (List<?>) cur;
                int i = (Integer) k;
                cur = i >= 0 && i < l.size() ? l.get(i) : null;
            } else if (cur instanceof Map) cur = ((Map<?, ?>) cur).get(String.valueOf(k));
            else return null;
        }
        return cur;
    }

    /** String value at a path, or null. */
    public static String str(Object root, Object... keys) {
        Object v = path(root, keys);
        return v instanceof String ? (String) v : null;
    }

    /** Number value at a path, or null. */
    public static Number num(Object root, Object... keys) {
        Object v = path(root, keys);
        return v instanceof Number ? (Number) v : null;
    }

    /** Map at a path, or null. */
    public static Map<String, Object> map(Object root, Object... keys) { return asMap(path(root, keys)); }

    /** List at a path, or an empty list (like JS {@code ?? []}). */
    public static List<Object> listAt(Object root, Object... keys) {
        List<Object> l = asList(path(root, keys));
        return l != null ? l : new ArrayList<>();
    }

    /** JS truthiness of a JSON value. */
    public static boolean truthy(Object v) {
        if (v == null) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return !((String) v).isEmpty();
        if (v instanceof Number) { double d = ((Number) v).doubleValue(); return d != 0 && !Double.isNaN(d); }
        return true;
    }

    /** JS {@code String(v)} for scalars (numbers formatted like JS). */
    public static String jsString(Object v) {
        if (v == null) return "null";
        if (v instanceof Number) {
            String s = numberToString((Number) v);
            if (s.equals("null")) { double d = ((Number) v).doubleValue(); return Double.isNaN(d) ? "NaN" : d > 0 ? "Infinity" : "-Infinity"; }
            return s;
        }
        return v.toString();
    }
}
