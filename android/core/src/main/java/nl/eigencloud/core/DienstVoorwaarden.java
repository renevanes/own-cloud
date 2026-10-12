package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * "Voorwaarden en privacy" in Je dienst (port of src/console/voorwaarden.ts; GET /api/aanbieder/juridisch returns the
 * same JSON): what the Dienst hosts (GET /v1/juridisch) and which links the app shows (GET /v1/brand). Creating and
 * editing happens in the Dienst's /beheer (page Voorwaarden en privacy).
 */
public final class DienstVoorwaarden {
    private DienstVoorwaarden() {}

    static final String[][] DOCUMENTEN = {{"voorwaarden", "Algemene voorwaarden"}, {"privacy", "Privacyverklaring"}, {"verwerkersovereenkomst", "Verwerkersovereenkomst"}};

    private static Object[] get(String url) throws IOException {
        Http.Response r = Http.request("GET", url, Http.headers("accept", "application/json"), null, 8000);
        Object j;
        try { j = Json.parse(r.text()); } catch (RuntimeException e) { j = null; }
        return new Object[] {r.status, j};
    }

    private static Map<String, Object> leeg(String fout, boolean bereikbaar) {
        List<Object> docs = new ArrayList<>();
        for (String[] d : DOCUMENTEN) docs.add(Json.obj("soort", d[0], "titel", d[1], "versie", null, "gewijzigd", null, "url", null));
        return Json.obj("bereikbaar", bereikbaar, "documenten", docs, "termsUrl", null, "privacyUrl", null, "fout", fout);
    }

    /** GET /api/aanbieder/juridisch */
    public static Map<String, Object> status(Map<String, Object> c) {
        Map<String, Object> a = Json.map(c, "console", "aanbieder");
        String url = Json.str(a, "url");
        if (url == null || url.isEmpty() || Json.path(a, "server") == null) throw new IllegalArgumentException("Er draait nog geen Dienst");
        String base = Aanbieder.reach.base(url);
        Object[] j, b;
        try {
            j = get(base + "/v1/juridisch");
            b = get(base + "/v1/brand");
        } catch (IOException e) {
            return leeg("Je Dienst is nu niet bereikbaar", false);
        }
        if ((Integer) b[0] != 200 || b[1] == null) return leeg("Je Dienst antwoordt " + b[0], false);
        List<Object> found = (Integer) j[0] == 200 && Json.path(j[1], "documents") instanceof List ? Json.listAt(j[1], "documents") : new ArrayList<Object>();
        List<Object> docs = new ArrayList<>();
        for (String[] d : DOCUMENTEN) {
            Map<String, Object> x = null;
            for (Object o : found) if (d[0].equals(Json.path(o, "kind"))) { x = Json.asMap(o); break; }
            Object v = Json.path(x, "version"), at = Json.path(x, "updatedAt"), u = Json.path(x, "url");
            docs.add(Json.obj("soort", d[0], "titel", d[1], "versie", v instanceof Number ? v : null, "gewijzigd", at instanceof Number ? at : null, "url", u instanceof String ? u : null));
        }
        Object terms = Json.path(b[1], "termsUrl"), privacy = Json.path(b[1], "privacyUrl");
        return Json.obj("bereikbaar", true, "documenten", docs, "termsUrl", terms instanceof String ? terms : null, "privacyUrl", privacy instanceof String ? privacy : null,
                "fout", (Integer) j[0] == 404 ? "Je Dienst kan dit nog niet: hij werkt zichzelf vannacht bij (zie Updates)." : null);
    }
}
