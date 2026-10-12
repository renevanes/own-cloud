package nl.eigencloud.core;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * "Op de lijst" via a pull request on GitHub (port of src/console/github.ts; the routes /api/aanbieder/lijst…,
 * /api/github/… return the same JSON). The provider links GitHub once with a classic token (scope public_repo); the
 * Dienst gives its own line (GET /v1/status/lijst with the beheer token); without push rights on renevanes/own-cloud the
 * app forks, otherwise (the maintainers) it uses a branch in the repository itself; aanbieders.json gets the line
 * (same url replaced, the rest kept, 2-space JSON like the file) and a pull request is opened or updated. The token lives
 * only in the vault (console.github). Blocking; call off the UI thread.
 */
public final class GitHub {
    private GitHub() {}

    public static final String LIJST_REPO = "renevanes/own-cloud";
    public static final String LIJST_PAD = "aanbieders.json";
    public static final String TOKEN_URL = "https://github.com/settings/tokens/new?scopes=public_repo&description=Eigen%20Cloud";
    /** How long the app waits for a new fork (tests make this short). */
    public static volatile long pollMs = 2000;
    public static volatile int polls = 30;

    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9_]{20,255}$");
    private static final Pattern LAND = Pattern.compile("^[A-Z]{2}$");
    private static final Pattern SPACES = Pattern.compile("(?U)\\s+");

    private static Map<String, Object> state(Map<String, Object> c) {
        Map<String, Object> con = Json.map(c, "console");
        Map<String, Object> g = Json.map(con, "github");
        if (g == null) { g = Json.obj(); con.put("github", g); }
        return g;
    }

    // ───────── GitHub ─────────

    private static final class Res {
        final int status;
        final Object json;
        final String scopes;

        Res(int status, Object json, String scopes) {
            this.status = status;
            this.json = json;
            this.scopes = scopes;
        }

        boolean ok() { return status >= 200 && status < 300; }
    }

    private static Res gh(String token, String method, String path, Object body) throws IOException {
        Map<String, String> h = Http.headers("accept", "application/vnd.github+json", "x-github-api-version", "2022-11-28", "user-agent", "Eigen-Cloud");
        if (token != null) h.put("authorization", "Bearer " + token);
        if (body != null) h.put("content-type", "application/json");
        Http.Response r;
        try {
            r = Http.request(method, Endpoints.GITHUB.replaceAll("/+$", "") + path, h, body == null ? null : Bytes.utf8(Json.stringify(body)), 20_000);
        } catch (IOException e) {
            throw new IOException("GitHub is nu niet bereikbaar. Probeer het zo opnieuw.");
        }
        Object j = null;
        String t = r.text();
        try { j = t.isEmpty() ? null : Json.parse(t); } catch (RuntimeException e) { j = null; }
        return new Res(r.status, j, r.headers.get("x-oauth-scopes"));
    }

    private static IOException ghFail(Res r, String what) {
        if (r.status == 401) return new IOException("GitHub accepteert je token niet meer. Koppel GitHub opnieuw.");
        Object m = Json.path(r.json, "message");
        String msg = m instanceof String ? (String) m : "";
        if (r.status == 403 && msg.toLowerCase(Locale.ROOT).contains("rate limit")) return new IOException("GitHub laat even geen verzoeken meer toe. Probeer het over een uur opnieuw.");
        if (r.status == 403 || r.status == 404) return new IOException(what + ": dit mag niet met je token (GitHub antwoordt " + r.status + "). Maak een nieuw token met de link in de app.");
        return new IOException(what + ": GitHub antwoordt " + r.status + (msg.isEmpty() ? "" : " (" + msg + ")"));
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    private static String str(Object v, String dflt) { return v == null ? dflt : Json.jsString(v); }

    // ───────── De lijst ─────────

    static String norm(Object u) { return (u == null ? "" : Json.jsString(u)).trim().replaceAll("/+$", "").toLowerCase(Locale.ROOT); }

    /** The line as it goes on the list (mergeRegel in github.ts). */
    public static Map<String, Object> mergeRegel(Map<String, Object> cur, Map<String, Object> entry) {
        Map<String, Object> out = Json.obj();
        for (Map.Entry<String, Object> e : entry.entrySet()) if (!"standaard".equals(e.getKey()) && !"adressen".equals(e.getKey())) out.put(e.getKey(), e.getValue());
        if (cur != null) for (Map.Entry<String, Object> e : cur.entrySet()) {
            if (!out.containsKey(e.getKey()) && !"standaard".equals(e.getKey()) && !"adressen".equals(e.getKey())) out.put(e.getKey(), e.getValue());
        }
        if (cur != null && Boolean.TRUE.equals(cur.get("standaard"))) out.put("standaard", true);
        Object ea = entry.get("adressen"), ca = cur == null ? null : cur.get("adressen");
        String adressen = ea instanceof String && !((String) ea).isEmpty() ? (String) ea : ca instanceof String ? (String) ca : null;
        if (adressen != null && !adressen.isEmpty()) out.put("adressen", adressen);
        return out;
    }

    /** The new aanbieders.json and whether the line is new (mergeLijst in github.ts). */
    public static Object[] mergeLijst(List<Object> lijst, Map<String, Object> entry) {
        int i = -1;
        for (int k = 0; k < lijst.size(); k++) {
            Map<String, Object> x = Json.asMap(lijst.get(k));
            if (x != null && norm(x.get("url")).equals(norm(entry.get("url")))) { i = k; break; }
        }
        List<Object> next = new ArrayList<>(lijst);
        if (i >= 0) next.set(i, mergeRegel(Json.asMap(next.get(i)), entry)); else next.add(mergeRegel(null, entry));
        return new Object[] {Json.stringify(next, 2) + "\n", i < 0};
    }

    /** dienst.esape.nl → aanbieder-dienst-esape-nl (branchFor in github.ts). */
    public static String branchFor(String url) {
        String host = url;
        try {
            URI u = new URI(url);
            if (u.getHost() != null) {
                int p = u.getPort();
                boolean dflt = p == -1 || ("https".equalsIgnoreCase(u.getScheme()) && p == 443) || ("http".equalsIgnoreCase(u.getScheme()) && p == 80);
                host = u.getHost() + (dflt ? "" : ":" + p);
            }
        } catch (URISyntaxException e) { /* zoals het is */ }
        String b = host.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return "aanbieder-" + Bytes.head(b, 60);
    }

    private static Map<String, Object> needDienst(Map<String, Object> c) {
        Map<String, Object> a = Json.map(c, "console", "aanbieder");
        String url = Json.str(a, "url"), secret = Json.str(a, "secret");
        if (url == null || url.isEmpty() || secret == null || secret.isEmpty() || Json.path(a, "server") == null) throw new IllegalArgumentException("Er draait nog geen Dienst");
        return a;
    }

    /** {entry, voorwaarden} from the Dienst (GET /v1/status/lijst with the beheer token). */
    private static Map<String, Object> dienstRegel(Map<String, Object> a) throws IOException {
        Http.Response r;
        try {
            r = Http.request("GET", Aanbieder.reach.base(Json.str(a, "url")) + "/v1/status/lijst", Http.headers("authorization", "Beheer " + Aanbieder.beheerToken(Json.str(a, "secret"))), null, 10_000);
        } catch (IOException e) {
            throw new IOException("Je Dienst is nu niet bereikbaar. Probeer het zo opnieuw.");
        }
        Object j = null;
        try { j = Json.parse(r.text()); } catch (RuntimeException e) { j = null; }
        if (r.status == 404) throw new IOException("Je Dienst kent dit nog niet: werk hem eerst bij (Updates), of zet je regel met de hand op de lijst.");
        if (!r.ok() || Json.map(j, "entry") == null) throw new IOException("Je Dienst gaf zijn regel niet (" + r.status + ")");
        return Json.obj("entry", Json.map(j, "entry"), "voorwaarden", Json.path(j, "voorwaarden"));
    }

    private static Map<String, Object> withOverrides(Map<String, Object> entry, Map<String, Object> g) {
        Map<String, Object> regel = Json.map(g, "regel");
        if (regel == null) return entry;
        Map<String, Object> out = Json.obj();
        for (Map.Entry<String, Object> e : entry.entrySet()) {
            out.put(e.getKey(), "land".equals(e.getKey()) ? regel.get("land") : "omschrijving".equals(e.getKey()) ? regel.get("omschrijving") : e.getValue());
        }
        return out;
    }

    private static Map<String, Object> cleanRegel(Map<String, Object> b) {
        String land = str(b.get("land"), "").trim().toUpperCase(Locale.ROOT);
        if (!LAND.matcher(land).matches()) throw new IllegalArgumentException("Land als landcode van twee letters, bijvoorbeeld NL");
        String omschrijving = SPACES.matcher(str(b.get("omschrijving"), "")).replaceAll(" ").trim();
        if (omschrijving.length() > 140) throw new IllegalArgumentException("Houd de omschrijving kort: hooguit 140 tekens");
        return Json.obj("land", land, "omschrijving", omschrijving);
    }

    private static Map<String, Object> voorstelView(Map<String, Object> v) {
        return Json.obj("nummer", v.get("nummer"), "url", v.get("url"), "titel", v.get("titel"), "status", v.get("status"), "at", v.get("at"), "samengevoegdOp", v.get("samengevoegdOp"));
    }

    private static boolean refreshVoorstel(Map<String, Object> g) {
        Map<String, Object> v = Json.map(g, "voorstel");
        if (v == null || !"open".equals(v.get("status"))) return false;
        try {
            Res r = gh(Json.str(g, "token"), "GET", "/repos/" + LIJST_REPO + "/pulls/" + Json.jsString(v.get("nummer")), null);
            if (!r.ok()) return false;
            Object mergedAt = Json.path(r.json, "merged_at");
            String status = Boolean.TRUE.equals(Json.path(r.json, "merged")) || Json.truthy(mergedAt) ? "samengevoegd" : "closed".equals(Json.path(r.json, "state")) ? "gesloten" : "open";
            if (status.equals(v.get("status"))) return false;
            v.put("status", status);
            Object at = null;
            if ("samengevoegd".equals(status)) {
                long t;
                try { t = java.time.Instant.parse(Json.jsString(mergedAt)).toEpochMilli(); } catch (RuntimeException e) { t = 0; }
                at = t != 0 ? t : System.currentTimeMillis();
            }
            v.put("samengevoegdOp", at);
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    // ───────── Routes ─────────

    /** Saving the vault (the console's save). */
    public interface Saver { void save() throws IOException; }

    /** GET /api/aanbieder/lijst */
    public static Map<String, Object> view(Map<String, Object> c, Saver deps) throws IOException {
        Map<String, Object> a = needDienst(c);
        Map<String, Object> g = state(c);
        Map<String, Object> regel = null;
        Object voorwaarden = null;
        String dienstFout = null;
        try {
            Map<String, Object> r = dienstRegel(a);
            regel = withOverrides(Json.map(r, "entry"), g);
            voorwaarden = r.get("voorwaarden");
        } catch (IOException | RuntimeException e) {
            dienstFout = e.getMessage();
        }
        Map<String, Object> cur = null;
        String lijstFout = null;
        try {
            Http.Response r;
            try {
                r = Http.request("GET", Endpoints.AANBIEDERS, Http.headers("accept", "application/json"), null, 10_000);
            } catch (IOException e) {
                throw new IOException("niet bereikbaar");
            }
            if (!r.ok()) throw new IOException("HTTP " + r.status);
            Object list;
            try { list = Json.parse(r.text()); } catch (RuntimeException e) { list = null; }
            if (!(list instanceof List)) throw new IOException("geen lijst");
            Object url = regel != null && regel.get("url") != null ? regel.get("url") : Json.str(a, "url");
            for (Object x : Json.asList(list)) {
                Map<String, Object> m = Json.asMap(x);
                if (m != null && norm(m.get("url")).equals(norm(url))) { cur = m; break; }
            }
        } catch (IOException e) {
            lijstFout = "De openbare lijst is nu niet te lezen (" + e.getMessage() + ")";
        }
        if (refreshVoorstel(g)) deps.save();
        boolean linked = Json.truthy(g.get("token"));
        Map<String, Object> v = Json.map(g, "voorstel");
        return Json.obj(
                "github", Json.obj("gekoppeld", linked, "login", linked && g.get("login") != null ? g.get("login") : null, "beheerder", linked && Boolean.TRUE.equals(g.get("beheerder"))),
                "tokenUrl", TOKEN_URL, "repo", LIJST_REPO,
                "regel", regel, "dienstFout", dienstFout, "voorwaarden", voorwaarden,
                "opLijst", cur != null, "sleutelKlopt", cur != null && regel != null && Objects.equals(cur.get("sleutel"), regel.get("sleutel")),
                "actueel", cur != null && regel != null && Json.stringify(mergeRegel(cur, regel)).equals(Json.stringify(cur)),
                "lijstFout", lijstFout,
                "voorstel", v != null ? voorstelView(v) : null,
                "editUrl", "https://github.com/" + LIJST_REPO + "/edit/main/" + LIJST_PAD);
    }

    /** POST /api/github/koppelen {token} */
    public static Map<String, Object> koppelen(Map<String, Object> c, Map<String, Object> b) throws IOException {
        String token = str(b.get("token"), "").trim();
        if (token.isEmpty()) throw new IllegalArgumentException("Plak het token dat je op GitHub hebt gemaakt");
        if (token.startsWith("github_pat_")) throw new IllegalArgumentException("Dit is een fijnmazig token. Maak met de link in de app een klassiek token (met public_repo): alleen daarmee kan de app een fork en een voorstel maken.");
        if (!TOKEN.matcher(token).matches()) throw new IllegalArgumentException("Dit lijkt geen GitHub-token. Kopieer het token helemaal (het begint meestal met ghp_).");
        Res u = gh(token, "GET", "/user", null);
        if (u.status == 401) throw new IOException("GitHub accepteert dit token niet. Kopieer het opnieuw, of maak een nieuw token.");
        if (!u.ok() || !(Json.path(u.json, "login") instanceof String)) throw ghFail(u, "Inloggen bij GitHub");
        if (u.scopes == null) throw new IOException("Dit is geen klassiek token. Maak met de link in de app een klassiek token (met public_repo).");
        boolean scope = false;
        for (String s : u.scopes.split(",", -1)) if (s.trim().equals("public_repo") || s.trim().equals("repo")) scope = true;
        if (!scope) throw new IOException("Dit token mist het recht public_repo. Maak met de link in de app een nieuw token: dan staat dat vinkje al aan.");
        Res repo = gh(token, "GET", "/repos/" + LIJST_REPO, null);
        if (!repo.ok()) throw ghFail(repo, "De lijst van aanbieders lezen");
        Map<String, Object> g = state(c);
        g.put("token", token);
        g.put("login", Json.path(u.json, "login"));
        g.put("at", System.currentTimeMillis());
        g.put("beheerder", Boolean.TRUE.equals(Json.path(repo.json, "permissions", "push")));
        return Json.obj("ok", true, "login", g.get("login"), "beheerder", g.get("beheerder"));
    }

    /** POST /api/github/ontkoppelen */
    public static Map<String, Object> ontkoppelen(Map<String, Object> c) {
        Map<String, Object> g = state(c);
        g.remove("token");
        g.remove("login");
        g.remove("at");
        g.remove("beheerder");
        return Json.obj("ok", true);
    }

    /** POST /api/aanbieder/lijst/aanmelden {land, omschrijving} */
    public static Map<String, Object> aanmelden(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> a = needDienst(c);
        Map<String, Object> g = state(c);
        if (!Json.truthy(g.get("token"))) throw new IllegalArgumentException("Koppel eerst GitHub");
        g.put("regel", cleanRegel(b));
        Map<String, Object> dr = dienstRegel(a);
        Map<String, Object> entry = withOverrides(Json.map(dr, "entry"), g);
        Object voorwaarden = dr.get("voorwaarden");
        String t = Json.str(g, "token");

        Res repo = gh(t, "GET", "/repos/" + LIJST_REPO, null);
        if (!repo.ok()) throw ghFail(repo, "De lijst van aanbieders lezen");
        String base = str(Json.path(repo.json, "default_branch"), "main");
        boolean push = Boolean.TRUE.equals(Json.path(repo.json, "permissions", "push"));
        g.put("beheerder", push);
        Res ref = gh(t, "GET", "/repos/" + LIJST_REPO + "/git/ref/heads/" + base, null);
        if (!ref.ok()) throw ghFail(ref, "De lijst van aanbieders lezen");
        String baseSha = str(Json.path(ref.json, "object", "sha"), "");
        Res file = gh(t, "GET", "/repos/" + LIJST_REPO + "/contents/" + LIJST_PAD + "?ref=" + Bytes.encodeURIComponent(base), null);
        if (!file.ok()) throw ghFail(file, "De lijst van aanbieders lezen");
        String huidig = Bytes.utf8(java.util.Base64.getDecoder().decode(str(Json.path(file.json, "content"), "").replaceAll("\\s", "")));
        Object lijst;
        try { lijst = Json.parse(huidig); } catch (RuntimeException e) { throw new IOException("De lijst van aanbieders op GitHub is nu geen geldige JSON; probeer het later opnieuw"); }
        if (!(lijst instanceof List)) throw new IOException("De lijst van aanbieders op GitHub is nu geen lijst; probeer het later opnieuw");
        Object[] merged = mergeLijst(Json.asList(lijst), entry);
        String tekst = (String) merged[0];
        boolean nieuw = (Boolean) merged[1];
        Map<String, Object> vOld = Json.map(g, "voorstel");
        if (tekst.equals(huidig)) return Json.obj("ok", true, "gewijzigd", false, "voorstel", vOld != null ? voorstelView(vOld) : null, "bericht", "Je regel staat al zo op de lijst.");
        Map<String, Object> open = vOld != null && "open".equals(vOld.get("status")) ? vOld : null;

        String target = LIJST_REPO, owner = LIJST_REPO.split("/")[0];
        if (!push) {
            Res f = gh(t, "POST", "/repos/" + LIJST_REPO + "/forks", Json.obj("default_branch_only", true));
            if (!f.ok() || !(Json.path(f.json, "full_name") instanceof String)) throw ghFail(f, "Een fork maken");
            target = (String) Json.path(f.json, "full_name");
            Object ol = Json.path(f.json, "owner", "login");
            owner = ol != null ? Json.jsString(ol) : g.get("login") != null ? Json.jsString(g.get("login")) : target.split("/")[0];
            boolean ready = false;
            for (int i = 0; i < polls && !ready; i++) {
                ready = gh(t, "GET", "/repos/" + target + "/git/ref/heads/" + base, null).ok();
                if (!ready) sleep(pollMs);
            }
            if (!ready) throw new IOException("GitHub is nog bezig met je fork. Probeer het over een paar minuten opnieuw.");
            try { gh(t, "POST", "/repos/" + target + "/merge-upstream", Json.obj("branch", base)); } catch (IOException e) { /* zoals in TS: niet erg */ }
        }
        String branch = branchFor(Json.jsString(entry.get("url")));
        boolean exists = gh(t, "GET", "/repos/" + target + "/git/ref/heads/" + branch, null).ok();
        Res mk = exists
                ? gh(t, "PATCH", "/repos/" + target + "/git/refs/heads/" + branch, Json.obj("sha", baseSha, "force", true))
                : gh(t, "POST", "/repos/" + target + "/git/refs", Json.obj("ref", "refs/heads/" + branch, "sha", baseSha));
        if (!mk.ok()) {
            if (!push && mk.status == 422) throw new IOException("Je fork op GitHub loopt achter en kon niet vanzelf worden bijgewerkt. Kies op GitHub bij je fork Sync fork en probeer het opnieuw.");
            throw ghFail(mk, "Een branch maken");
        }
        String naam = str(entry.get("naam"), "");
        String titel = (nieuw ? "Aanbieder toevoegen" : "Aanbieder bijwerken") + ": " + naam;
        Res cur = gh(t, "GET", "/repos/" + target + "/contents/" + LIJST_PAD + "?ref=" + Bytes.encodeURIComponent(branch), null);
        if (!cur.ok()) throw ghFail(cur, "De lijst in je branch lezen");
        Res put = gh(t, "PUT", "/repos/" + target + "/contents/" + LIJST_PAD, Json.obj(
                "message", "aanbieders.json: " + naam + " " + (nieuw ? "toevoegen" : "bijwerken"), "content", Bytes.base64(Bytes.utf8(tekst)), "sha", Json.path(cur.json, "sha"), "branch", branch));
        if (!put.ok()) throw ghFail(put, "De lijst bijwerken");
        String head = push ? branch : owner + ":" + branch;
        Res found = gh(t, "GET", "/repos/" + LIJST_REPO + "/pulls?state=open&head=" + Bytes.encodeURIComponent(owner + ":" + branch), null);
        Map<String, Object> pr = found.ok() && found.json instanceof List && !Json.asList(found.json).isEmpty() ? Json.asMap(Json.asList(found.json).get(0)) : null;
        if (pr == null) {
            String url = str(entry.get("url"), "");
            Object contact = entry.get("contact");
            Object terms = Json.path(voorwaarden, "termsUrl"), privacy = Json.path(voorwaarden, "privacyUrl");
            String body = String.join("\n", java.util.Arrays.asList(
                    nieuw ? naam + " (" + url + ") vraagt om op de lijst van aanbieders te komen." : naam + " (" + url + ") werkt zijn regel op de lijst van aanbieders bij.",
                    "", "Gemaakt met de Eigen Cloud-app (Je dienst → Op de lijst).", "",
                    "- Adres van de Dienst: " + url, "- Contact: " + (Json.truthy(contact) ? Json.jsString(contact) : "nog niet ingevuld"), "- Land: " + str(entry.get("land"), ""),
                    "- Voorwaarden: " + (terms != null ? Json.jsString(terms) : "nog niet ingesteld"), "- Privacyverklaring: " + (privacy != null ? Json.jsString(privacy) : "nog niet ingesteld"),
                    "", "Voor de beheerders: controleer of de Dienst antwoordt (" + url + "/v1/info) en of contact, voorwaarden en privacyverklaring kloppen (zie CONTRIBUTING.md)."));
            Res created = gh(t, "POST", "/repos/" + LIJST_REPO + "/pulls", Json.obj("title", titel, "head", head, "base", base, "body", body, "maintainer_can_modify", true));
            if (!created.ok()) throw ghFail(created, "Het voorstel maken");
            pr = Json.asMap(created.json);
        }
        Map<String, Object> v = Json.obj("nummer", ((Number) pr.get("number")).longValue(), "url", str(pr.get("html_url"), ""), "titel", str(pr.get("title"), titel), "status", "open",
                "repo", target, "branch", branch, "at", System.currentTimeMillis(), "samengevoegdOp", null);
        g.put("voorstel", v);
        boolean same = open != null && Objects.equals(Json.jsString(open.get("nummer")), Json.jsString(v.get("nummer")));
        return Json.obj("ok", true, "gewijzigd", true, "voorstel", voorstelView(v),
                "bericht", same ? "Je voorstel is bijgewerkt." : "Je voorstel staat op GitHub. De beheerders van het project kijken ernaar.");
    }

    /** POST /api/aanbieder/lijst/samenvoegen {confirm: true}: only for the maintainers (push rights). */
    public static Map<String, Object> samenvoegen(Map<String, Object> c, Map<String, Object> b) throws IOException {
        Map<String, Object> g = state(c);
        if (!Json.truthy(g.get("token"))) throw new IllegalArgumentException("Koppel eerst GitHub");
        Map<String, Object> v = Json.map(g, "voorstel");
        if (v == null || !"open".equals(v.get("status"))) throw new IllegalArgumentException("Er is geen open voorstel");
        if (!Boolean.TRUE.equals(b.get("confirm"))) throw new IllegalArgumentException("Bevestig dat je het voorstel zelf wilt samenvoegen");
        String t = Json.str(g, "token");
        Res repo = gh(t, "GET", "/repos/" + LIJST_REPO, null);
        if (!repo.ok()) throw ghFail(repo, "De repository lezen");
        if (!Boolean.TRUE.equals(Json.path(repo.json, "permissions", "push"))) {
            g.put("beheerder", false);
            throw new IOException("Alleen de beheerders van het project kunnen een voorstel zelf samenvoegen");
        }
        String n = Json.jsString(v.get("nummer"));
        Res r = gh(t, "PUT", "/repos/" + LIJST_REPO + "/pulls/" + n + "/merge", Json.obj("merge_method", "squash", "commit_title", Json.jsString(v.get("titel")) + " (#" + n + ")"));
        if (r.status == 405) {
            Object m = Json.path(r.json, "message");
            throw new IOException("GitHub kan dit voorstel nu niet samenvoegen" + (Json.truthy(m) ? ": " + Json.jsString(m) : ""));
        }
        if (r.status == 409) throw new IOException("Het voorstel is intussen gewijzigd. Vernieuw en probeer het opnieuw.");
        if (!r.ok() || !Boolean.TRUE.equals(Json.path(r.json, "merged"))) throw ghFail(r, "Samenvoegen");
        v.put("status", "samengevoegd");
        v.put("samengevoegdOp", System.currentTimeMillis());
        return Json.obj("ok", true, "voorstel", voorstelView(v));
    }
}
