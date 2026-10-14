package nl.eigencloud.core;

import java.security.SecureRandom;

/**
 * Passwords nobody has to invent or type, and pasting secrets from a provider's page. Same rules as
 * web-console/secrets.js (golden tests compare both).
 *
 * <p>{@link #generate()}: 4 groups of 5 characters from 31 easy-to-read characters (no i, l, o, 0, 1), e.g.
 * {@code kq7mx-2hfpw-9rtzc-v4nsd}: about 99 bits, readable when you do need to type it somewhere.
 */
public final class Passwords {
    private Passwords() {}

    public static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
    public static final int GROUPS = 4, GROUP_LENGTH = 5;
    /** Regex for a generated password. */
    public static final String PATTERN = "^[" + ALPHABET + "]{5}(-[" + ALPHABET + "]{5}){3}$";
    private static final SecureRandom RANDOM = new SecureRandom();

    public static String generate() {
        StringBuilder b = new StringBuilder(GROUPS * (GROUP_LENGTH + 1));
        for (int g = 0; g < GROUPS; g++) {
            if (g > 0) b.append('-');
            for (int i = 0; i < GROUP_LENGTH; i++) b.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
        }
        return b.toString();
    }

    /** Strength of {@link #generate()} in bits. */
    public static double bits() { return GROUPS * GROUP_LENGTH * Math.log(ALPHABET.length()) / Math.log(2); }

    private static final String INVISIBLE = "[\\u00AD\\u200B\\u200C\\u200D\\u2060\\uFEFF]";
    private static final String SPACES = "[\\t\\u000B\\f\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]";
    private static final String LINES = "\\r\\n|[\\r\\n\\u0085\\u2028\\u2029]";
    private static final String[][] QUOTES = {{"\"", "\""}, {"'", "'"}, {"`", "`"}, {"“", "”"}, {"„", "”"}, {"‘", "’"}, {"«", "»"}};
    public static final int MAX_PASTE = 4096;

    private static String trimSpaces(String s) {
        int a = 0, z = s.length();
        while (a < z && s.charAt(a) == ' ') a++;
        while (z > a && s.charAt(z - 1) == ' ') z--;
        return s.substring(a, z);
    }

    /**
     * A key or token from the clipboard, as the field wants it: invisible characters out, odd spaces become normal
     * spaces, the first non-empty line, trimmed, without one pair of surrounding quotes, at most 4096 characters.
     */
    public static String normalizePaste(String text) {
        if (text == null) return "";
        String s = text.replaceAll(INVISIBLE, "").replaceAll(SPACES, " ");
        String line = "";
        for (String l : s.split(LINES, -1)) {
            String t = trimSpaces(l);
            if (!t.isEmpty()) { line = t; break; }
        }
        for (String[] q : QUOTES) {
            if (line.length() >= 2 && line.startsWith(q[0]) && line.endsWith(q[1])) { line = trimSpaces(line.substring(q[0].length(), line.length() - q[1].length())); break; }
        }
        return line.length() > MAX_PASTE ? line.substring(0, MAX_PASTE) : line;
    }
}
