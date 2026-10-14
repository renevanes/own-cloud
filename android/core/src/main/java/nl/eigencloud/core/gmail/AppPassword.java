package nl.eigencloud.core.gmail;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Google app passwords: 16 letters, shown as "abcd efgh ijkl mnop". From the clipboard, without typing. */
public final class AppPassword {
    private AppPassword() {}

    /** Four groups of four letters on one line, not part of a longer run of letter groups. */
    private static final String SEP = "[ \\t\\u00a0\\u2007\\u202f-]";
    private static final Pattern GROUPED = Pattern.compile("(?<![A-Za-z]" + SEP + "?)(?<![A-Za-z])([A-Za-z]{4})" + SEP + "?([A-Za-z]{4})" + SEP + "?([A-Za-z]{4})" + SEP
            + "?([A-Za-z]{4})(?!" + SEP + "?[A-Za-z])");

    /**
     * The 16 letters (lower case) from what was copied: spaces (also non-breaking and zero-width), quotes and
     * surrounding text are ignored. Null when there is no app password in it.
     */
    public static String normalize(String clip) {
        if (clip == null) return null;
        String s = clip.replaceAll("[\\u200b\\u200c\\u200d\\u2060\\ufeff]", "").trim();
        String compact = s.replaceAll("[\\s\\u00a0\\u2007\\u202f\"'“”‘’]", "");
        if (compact.matches("[A-Za-z]{16}")) return compact.toLowerCase(Locale.ROOT);
        Matcher m = GROUPED.matcher(s);
        String found = null;
        while (m.find()) {
            if (found != null) return null; // two candidates: do not guess
            found = (m.group(1) + m.group(2) + m.group(3) + m.group(4)).toLowerCase(Locale.ROOT);
        }
        return found;
    }

    /** "abcd •••• •••• mnop" to show that something was pasted, without showing it. */
    public static String mask(String pw) {
        if (pw == null || pw.length() != 16) return "";
        return pw.substring(0, 4) + " •••• •••• " + pw.substring(12);
    }

    /** A plausible address (Gmail or Google Workspace). */
    public static String address(String a) {
        if (a == null) return null;
        String s = a.trim().toLowerCase(Locale.ROOT);
        return s.matches("[^@\\s<>\"]+@[^@\\s<>\"]+\\.[a-z]{2,}") ? s : null;
    }
}
