package nl.eigencloud.core;

import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Deep links into the admin pages of an Eigen Cloud Dienst ({@code /beheer}, web-dienst/app.js): the console's "Je dienst"
 * opens {@code https://dienst.x.nl/beheer#/klanten} (beheerLink in src/console/aanbieder.ts). The app only passes on a
 * known page with a harmless argument; anything else opens the overview.
 */
public final class BeheerLink {
    private BeheerLink() {}

    /** Pages of web-dienst/app.js (KNOWN_PAGES there). */
    public static final List<String> PAGES = Arrays.asList("overzicht", "klanten", "klant", "hulpvragen", "hulpvraag", "berichten", "geld", "kosten",
            "aanbod", "uitnodigingen", "huisstijl", "medewerkers", "logboek", "account", "lijst", "adressen");

    private static final Pattern PAGE = Pattern.compile("^([a-z]+)(/[A-Za-z0-9_.-]{1,64})?(\\?[A-Za-z0-9_.=&%+-]{0,200})?$");

    /** "https://x/beheer#/klanten" (or "#klanten") → "klanten"; "" when there is no (known) page. */
    public static String page(String url) {
        if (url == null) return "";
        int i = url.indexOf('#');
        if (i < 0) return "";
        String f = url.substring(i + 1);
        if (f.startsWith("/")) f = f.substring(1);
        Matcher m = PAGE.matcher(f);
        if (!m.matches() || !PAGES.contains(m.group(1))) return "";
        return f;
    }

    /** The URL the app loads: {@code <base>/beheer/} plus {@code #/<page>} when there is one. */
    public static String url(String base, String page) {
        return base + "/beheer/" + (page == null || page.isEmpty() ? "" : "#/" + page);
    }

    /** https://dienst.x.nl/beheer#/klanten (beheerLink in aanbieder.ts). */
    public static String of(String dienstUrl, String page) { return dienstUrl + "/beheer#/" + page; }
}
