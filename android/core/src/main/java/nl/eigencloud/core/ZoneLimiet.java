package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Zone limit at deSEC (port of src/console/zonelimiet.ts; GET /api/aanbieder/zonelimiet returns the same JSON): the
 * number of zones (GET /domains/?cursor=, 500 per page, next page in the Link header) and the account limit
 * (GET /auth/account/ → limit_domains; only with a token that may manage tokens, otherwise 403). The mail asking deSEC
 * (support@desec.io) for a higher limit is composed by web-console/console.js.
 */
public final class ZoneLimiet {
    private ZoneLimiet() {}

    public static final String DESEC_SUPPORT = "support@desec.io";
    private static final Pattern NEXT = Pattern.compile("<([^>]+)>\\s*;\\s*rel=\"?next\"?");

    /** The next page from a Link header, or null (nextLink in zonelimiet.ts). */
    public static String nextLink(String link) {
        if (link == null) return null;
        for (String part : link.split(",", -1)) {
            Matcher m = NEXT.matcher(part.trim());
            if (m.find()) return m.group(1);
        }
        return null;
    }

    private static Http.Response get(String url, String token) throws IOException {
        try {
            return Http.request("GET", url, Http.headers("authorization", "Token " + token, "accept", "application/json"), null, 10_000);
        } catch (IOException e) {
            throw new IOException("deSEC is nu niet bereikbaar");
        }
    }

    /** GET /api/aanbieder/zonelimiet?welke=adressen|dienst */
    public static Map<String, Object> status(Map<String, Object> c, String welke) {
        Map<String, Object> a = Json.map(c, "console", "aanbieder");
        String w = "adressen".equals(welke) ? "adressen" : "dienst";
        String token = "adressen".equals(w) ? Json.str(a, "adressen", "desecToken") : Json.str(a, "accounts", "desecToken");
        if (a == null || token == null || token.isEmpty()) throw new IllegalArgumentException("adressen".equals(w) ? "De gratis-adressendienst draait niet op de server van je Dienst" : "Er is nog geen deSEC-token (Accounts en sleutels)");
        String base = Endpoints.DESEC.replaceAll("/+$", "");
        List<String> fouten = new ArrayList<>();
        Object account = null, limiet = null, zones = null;
        try {
            Http.Response r = get(base + "/auth/account/", token);
            if (r.status == 401) throw new IOException("deSEC accepteert dit token niet");
            if (r.status == 403) fouten.add("Dit token mag de accountgegevens niet lezen; deSEC laat de limiet dan niet zien.");
            else if (!r.ok()) fouten.add("deSEC antwoordt " + r.status + " op de accountgegevens.");
            else {
                Object j;
                try { j = Json.parse(r.text()); } catch (RuntimeException e) { throw new IOException("deSEC gaf geen geldige accountgegevens"); }
                account = Json.path(j, "email") instanceof String ? Json.path(j, "email") : null;
                limiet = Json.path(j, "limit_domains") instanceof Number ? Json.path(j, "limit_domains") : null;
            }
            String url = base + "/domains/?cursor=";
            long n = 0;
            for (int page = 0; url != null && page < 100; page++) {
                Http.Response d = get(url, token);
                if (d.status == 401 || d.status == 403) throw new IOException("deSEC accepteert dit token niet");
                if (!d.ok()) throw new IOException("deSEC antwoordt " + d.status + " op de lijst met zones");
                Object list;
                try { list = Json.parse(d.text()); } catch (RuntimeException e) { throw new IOException("deSEC gaf geen geldige lijst met zones"); }
                n += list instanceof List ? Json.asList(list).size() : 0;
                url = nextLink(d.headers.get("link"));
            }
            zones = n;
        } catch (IOException e) {
            String m = e.getMessage();
            fouten.add(m.endsWith(".") ? m : m + ".");
        }
        return Json.obj("welke", w, "zone", "adressen".equals(w) ? Json.str(a, "adressen", "zone") : null, "account", account, "zones", zones, "limiet", limiet,
                "support", DESEC_SUPPORT, "fout", fouten.isEmpty() ? null : String.join(" ", fouten));
    }
}
