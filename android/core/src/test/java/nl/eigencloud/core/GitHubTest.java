package nl.eigencloud.core;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * "Op de lijst" via GitHub (GitHub.java vs src/console/github.ts): the same scenario as test/github-lijst.test.ts against
 * the same fake GitHub and two real Diensten (scripts/android-github.ts; GITHUB_INFO), plus the golden cases of
 * mergeLijst/branchFor, the status of voorwaarden en privacy (DienstVoorwaarden) and the zone limit at deSEC (ZoneLimiet).
 */
public class GitHubTest {
    private static Map<String, Object> info;

    private static String err(T.ThrowingRunnable r) {
        try { r.run(); return ""; } catch (Exception e) { return e.getMessage(); }
    }

    private static Map<String, Object> cfgFor(String d) {
        return Json.obj("console", Json.obj("aanbieder", Json.obj("step", "klaar", "url", Json.str(info, d, "url"), "secret", Json.str(info, d, "secret"),
                "server", Json.obj("provider", "scaleway", "region", "nl-ams-1", "size", "DEV1-S", "serverId", "s1", "createdAt", 1L))));
    }

    private static Map<String, Object> state() throws Exception {
        return Json.parseObject(Http.request("GET", Json.str(info, "github") + "/_control/state", null, null, 5000).text());
    }

    private static List<String> callsSince(int from) throws Exception {
        List<String> out = new ArrayList<>();
        List<Object> all = Json.listAt(state(), "calls");
        for (int i = from; i < all.size(); i++) out.add(Json.jsString(all.get(i)));
        return out;
    }

    private static int callCount() throws Exception { return Json.listAt(state(), "calls").size(); }

    private static void control(String what) throws Exception { Http.request("POST", Json.str(info, "github") + "/_control/" + what, null, new byte[0], 5000); }

    private static String branchFile(String repo, String branch) throws Exception {
        Http.Response r = Http.request("GET", Json.str(info, "github") + "/repos/" + repo + "/contents/aanbieders.json?ref=" + branch, Http.headers("user-agent", "Eigen-Cloud"), null, 5000);
        return Bytes.utf8(java.util.Base64.getMimeDecoder().decode(Json.str(Json.parse(r.text()), "content")));
    }

    private static String token(String k) { return Json.str(info, "tokens", k); }

    public static void main(String[] args) {
        T.main("GitHubTest", () -> {
            Map<String, Object> g = T.golden();
            // Pure functions: same output as TypeScript (scripts/golden.ts).
            for (Object o : Json.listAt(g, "lijstMerge")) {
                Object[] r = GitHub.mergeLijst(Json.listAt(o, "lijst"), Json.map(o, "entry"));
                T.eq(Json.str(o, "out", "tekst"), r[0], "mergeLijst " + Json.str(o, "entry", "naam"));
                T.eq(Json.path(o, "out", "nieuw"), r[1], "mergeLijst nieuw " + Json.str(o, "entry", "naam"));
            }
            for (Object o : Json.listAt(g, "branchFor")) T.eq(Json.str(o, "out"), GitHub.branchFor(Json.str(o, "url")), "branchFor " + Json.str(o, "url"));
            T.eq("https://github.com/settings/tokens/new?scopes=public_repo&description=Eigen%20Cloud", GitHub.TOKEN_URL, "token url");

            info = Json.parseObject(new String(Files.readAllBytes(new File(T.env("GITHUB_INFO")).toPath()), "UTF-8"));
            Endpoints.GITHUB = Json.str(info, "github");
            Endpoints.AANBIEDERS = Json.str(info, "raw");
            Endpoints.DESEC = Json.str(info, "desec");
            GitHub.pollMs = 5;
            final String vanesUrl = Json.str(info, "vanes", "url"), esapeUrl = Json.str(info, "esape", "url");
            Aanbieder.reach = url -> url.equals(vanesUrl) ? Json.str(info, "vanes", "reach") : url.equals(esapeUrl) ? Json.str(info, "esape", "reach") : url;
            final String initial = new String(Files.readAllBytes(new File("aanbieders.json").toPath()), "UTF-8");
            final List<Object> initialList = Json.asList(Json.parse(initial));
            final int[] saves = {0};
            GitHub.Saver deps = () -> saves[0]++;
            final Map<String, Object> c = cfgFor("vanes");

            // GitHub koppelen: alleen een klassiek token met public_repo
            T.eq("Plak het token dat je op GitHub hebt gemaakt", err(() -> GitHub.koppelen(c, Json.obj("token", " "))), "empty token");
            T.eq("Dit is een fijnmazig token. Maak met de link in de app een klassiek token (met public_repo): alleen daarmee kan de app een fork en een voorstel maken.", err(() -> GitHub.koppelen(c, Json.obj("token", token("fijn")))), "fine-grained");
            T.eq("Dit lijkt geen GitHub-token. Kopieer het token helemaal (het begint meestal met ghp_).", err(() -> GitHub.koppelen(c, Json.obj("token", "geen token!"))), "garbage");
            T.eq("GitHub accepteert dit token niet. Kopieer het opnieuw, of maak een nieuw token.", err(() -> GitHub.koppelen(c, Json.obj("token", token("onbekend")))), "unknown token");
            T.eq("Dit token mist het recht public_repo. Maak met de link in de app een nieuw token: dan staat dat vinkje al aan.", err(() -> GitHub.koppelen(c, Json.obj("token", token("zonder")))), "no scope");
            T.eq("Dit is geen klassiek token. Maak met de link in de app een klassiek token (met public_repo).", err(() -> GitHub.koppelen(c, Json.obj("token", token("oauthloos")))), "no scopes header");
            T.eq(null, Json.path(c, "console", "github", "token"), "nothing stored after an error");
            T.eq("{\"ok\":true,\"login\":\"vanes-diensten\",\"beheerder\":false}", Json.stringify(GitHub.koppelen(c, Json.obj("token", " " + token("ander") + " "))), "koppelen");
            T.eq(token("ander"), Json.path(c, "console", "github", "token"), "token in the vault");

            // Vóór het aanmelden
            Map<String, Object> v = GitHub.view(c, deps);
            T.eq("{\"gekoppeld\":true,\"login\":\"vanes-diensten\",\"beheerder\":false}", Json.stringify(v.get("github")), "view github");
            T.eq(Json.stringify(Json.obj("naam", "Van Es", "url", "https://dienst.vanes.test", "land", "NL", "contact", "hallo@vanes.test", "omschrijving", "", "sleutel", Json.str(info, "vanes", "publicKey"))),
                    Json.stringify(v.get("regel")), "view regel");
            T.eq("[false,false,false,null,null,null,{\"termsUrl\":null,\"privacyUrl\":null}]", Json.stringify(Json.list(v.get("opLijst"), v.get("sleutelKlopt"), v.get("actueel"), v.get("voorstel"), v.get("dienstFout"), v.get("lijstFout"), v.get("voorwaarden"))), "view before");
            T.eq("[\"" + GitHub.TOKEN_URL + "\",\"renevanes/own-cloud\",\"https://github.com/renevanes/own-cloud/edit/main/aanbieders.json\"]", Json.stringify(Json.list(v.get("tokenUrl"), v.get("repo"), v.get("editUrl"))), "view links");
            T.check(!Json.stringify(v).contains(token("ander")), "never the token in a reply");
            T.eq("[\"github\",\"tokenUrl\",\"repo\",\"regel\",\"dienstFout\",\"voorwaarden\",\"opLijst\",\"sleutelKlopt\",\"actueel\",\"lijstFout\",\"voorstel\",\"editUrl\"]", Json.stringify(new ArrayList<Object>(v.keySet())), "view keys in TS order");

            // Aanmelden: fork, branch, aanbieders.json en een voorstel
            T.eq("Land als landcode van twee letters, bijvoorbeeld NL", err(() -> GitHub.aanmelden(c, Json.obj("land", "België", "omschrijving", "x"))), "bad land");
            StringBuilder lang = new StringBuilder();
            for (int i = 0; i < 141; i++) lang.append('x');
            T.eq("Houd de omschrijving kort: hooguit 140 tekens", err(() -> GitHub.aanmelden(c, Json.obj("land", "NL", "omschrijving", lang.toString()))), "long omschrijving");
            int before = callCount();
            Map<String, Object> r = GitHub.aanmelden(c, Json.obj("land", "nl", "omschrijving", "  Eigen Cloud   vanuit Rotterdam "));
            T.check(Json.path(r, "voorstel", "at") instanceof Number, "at is a time");
            Json.map(r, "voorstel").put("at", 0L);
            T.eq("{\"ok\":true,\"gewijzigd\":true,\"voorstel\":{\"nummer\":1,\"url\":\"https://github.com/renevanes/own-cloud/pull/1\",\"titel\":\"Aanbieder toevoegen: Van Es\",\"status\":\"open\",\"at\":0,\"samengevoegdOp\":null},\"bericht\":\"Je voorstel staat op GitHub. De beheerders van het project kijken ernaar.\"}",
                    Json.stringify(r), "aanmelden");
            List<String> calls = callsSince(before), flow = new ArrayList<>();
            int readyChecks = 0;
            for (String x : calls) if (x.equals("GET /repos/vanes-diensten/own-cloud/git/ref/heads/main")) readyChecks++; else flow.add(x);
            T.eq(Json.stringify(Json.list("GET /repos/renevanes/own-cloud", "GET /repos/renevanes/own-cloud/git/ref/heads/main", "GET /repos/renevanes/own-cloud/contents/aanbieders.json?ref=main",
                    "POST /repos/renevanes/own-cloud/forks", "POST /repos/vanes-diensten/own-cloud/merge-upstream",
                    "GET /repos/vanes-diensten/own-cloud/git/ref/heads/aanbieder-dienst-vanes-test", "POST /repos/vanes-diensten/own-cloud/git/refs",
                    "GET /repos/vanes-diensten/own-cloud/contents/aanbieders.json?ref=aanbieder-dienst-vanes-test", "PUT /repos/vanes-diensten/own-cloud/contents/aanbieders.json",
                    "commit vanes-diensten/own-cloud:aanbieder-dienst-vanes-test aanbieders.json: Van Es toevoegen",
                    "GET /repos/renevanes/own-cloud/pulls?state=open&head=vanes-diensten%3Aaanbieder-dienst-vanes-test", "POST /repos/renevanes/own-cloud/pulls")), Json.stringify(flow), "GitHub calls (fork path)");
            T.eq(3, readyChecks, "waited until the fork was ready");
            Map<String, Object> pr = Json.asMap(Json.listAt(state(), "prs").get(0));
            T.eq("[\"vanes-diensten:aanbieder-dienst-vanes-test\",\"main\",true,\"Aanbieder toevoegen: Van Es\"]", Json.stringify(Json.list(Json.path(pr, "head", "label"), Json.path(pr, "base", "ref"), pr.get("maintainer_can_modify"), pr.get("title"))), "pull request");
            T.check(Json.str(pr, "body").startsWith("Van Es (https://dienst.vanes.test) vraagt om op de lijst van aanbieders te komen.\n\nGemaakt met de Eigen Cloud-app (Je dienst → Op de lijst).\n\n- Adres van de Dienst: https://dienst.vanes.test\n- Contact: hallo@vanes.test\n- Land: NL\n- Voorwaarden: nog niet ingesteld\n- Privacyverklaring: nog niet ingesteld\n\nVoor de beheerders: controleer of de Dienst antwoordt (https://dienst.vanes.test/v1/info)"), "pr body: " + Json.str(pr, "body"));
            List<Object> want = new ArrayList<>(initialList);
            want.add(Json.obj("naam", "Van Es", "url", "https://dienst.vanes.test", "land", "NL", "contact", "hallo@vanes.test", "omschrijving", "Eigen Cloud vanuit Rotterdam", "sleutel", Json.str(info, "vanes", "publicKey")));
            T.eq(initial, Json.str(state(), "main"), "main untouched until merged");
            T.eq(Json.stringify(want, 2) + "\n", branchFile("vanes-diensten/own-cloud", "aanbieder-dienst-vanes-test"), "aanbieders.json in the fork");
            T.eq("{\"land\":\"NL\",\"omschrijving\":\"Eigen Cloud vanuit Rotterdam\"}", Json.stringify(Json.path(c, "console", "github", "regel")), "remembered");

            // Het open voorstel bijwerken
            before = callCount();
            r = GitHub.aanmelden(c, Json.obj("land", "NL", "omschrijving", "Vanuit Rotterdam"));
            T.eq("[true,1,\"Je voorstel is bijgewerkt.\"]", Json.stringify(Json.list(r.get("gewijzigd"), Json.path(r, "voorstel", "nummer"), r.get("bericht"))), "update open pr");
            calls = callsSince(before);
            T.check(calls.contains("PATCH /repos/vanes-diensten/own-cloud/git/refs/heads/aanbieder-dienst-vanes-test"), "branch reset to the newest main");
            T.check(!calls.contains("POST /repos/renevanes/own-cloud/pulls"), "no second pr");
            T.eq(1, Json.listAt(state(), "prs").size(), "one pr");
            v = GitHub.view(c, deps);
            T.eq("[\"open\",false,\"Vanuit Rotterdam\"]", Json.stringify(Json.list(Json.path(v, "voorstel", "status"), v.get("opLijst"), Json.path(v, "regel", "omschrijving"))), "view open");

            // Samengevoegd door de beheerders
            control("merge?n=1");
            int s0 = saves[0];
            v = GitHub.view(c, deps);
            T.eq("[\"samengevoegd\",true,true,true]", Json.stringify(Json.list(Json.path(v, "voorstel", "status"), v.get("opLijst"), v.get("sleutelKlopt"), v.get("actueel"))), "merged");
            T.check(Json.path(v, "voorstel", "samengevoegdOp") instanceof Number, "merged at");
            T.eq(s0 + 1, saves[0], "new status saved");
            r = GitHub.aanmelden(c, Json.obj("land", "NL", "omschrijving", "Vanuit Rotterdam"));
            T.eq("[true,false,\"Je regel staat al zo op de lijst.\",\"samengevoegd\"]", Json.stringify(Json.list(r.get("ok"), r.get("gewijzigd"), r.get("bericht"), Json.path(r, "voorstel", "status"))), "unchanged");

            // Later bijwerken; gesloten zonder samenvoegen
            r = GitHub.aanmelden(c, Json.obj("land", "NL", "omschrijving", "Nu ook in Utrecht"));
            T.eq("[2,\"Aanbieder bijwerken: Van Es\",\"open\"]", Json.stringify(Json.list(Json.path(r, "voorstel", "nummer"), Json.path(r, "voorstel", "titel"), Json.path(r, "voorstel", "status"))), "update later");
            T.check(Json.str(Json.listAt(state(), "prs").get(1), "body").startsWith("Van Es (https://dienst.vanes.test) werkt zijn regel op de lijst van aanbieders bij."), "pr body update");
            List<Object> list = Json.asList(Json.parse(branchFile("vanes-diensten/own-cloud", "aanbieder-dienst-vanes-test")));
            T.eq("[[\"ESAPE\"," + Json.quote(Json.str(initialList.get(0), "omschrijving")) + "],[\"Van Es\",\"Nu ook in Utrecht\"]]",
                    Json.stringify(Json.list(Json.list(Json.str(list.get(0), "naam"), Json.str(list.get(0), "omschrijving")), Json.list(Json.str(list.get(1), "naam"), Json.str(list.get(1), "omschrijving")))), "line replaced in place");
            control("close?n=2");
            v = GitHub.view(c, deps);
            T.eq("[\"gesloten\",null,true,true,false]", Json.stringify(Json.list(Json.path(v, "voorstel", "status"), Json.path(v, "voorstel", "samengevoegdOp"), v.get("opLijst"), v.get("sleutelKlopt"), v.get("actueel"))), "closed");

            // Zelf samenvoegen alleen met schrijfrechten
            T.eq("Er is geen open voorstel", err(() -> GitHub.samenvoegen(c, Json.obj("confirm", true))), "no open pr");
            GitHub.aanmelden(c, Json.obj("land", "NL", "omschrijving", "Nu ook in Utrecht en Gouda"));
            T.eq("Bevestig dat je het voorstel zelf wilt samenvoegen", err(() -> GitHub.samenvoegen(c, Json.obj())), "confirm");
            T.eq("Alleen de beheerders van het project kunnen een voorstel zelf samenvoegen", err(() -> GitHub.samenvoegen(c, Json.obj("confirm", true))), "no push rights");

            // De beheerders
            final Map<String, Object> e = cfgFor("esape");
            T.eq("{\"ok\":true,\"login\":\"renevanes\",\"beheerder\":true}", Json.stringify(GitHub.koppelen(e, Json.obj("token", token("rene")))), "koppelen maintainer");
            v = GitHub.view(e, deps);
            Object omschrijving = Json.path(initialList.get(0), "omschrijving");
            T.eq(Json.stringify(Json.obj("naam", "ESAPE", "url", "https://dienst.esape.nl", "land", "NL", "contact", "support@esape.nl", "omschrijving", omschrijving, "sleutel", Json.str(info, "esape", "publicKey"), "standaard", true, "adressen", "https://adressen.esape.nl")),
                    Json.stringify(v.get("regel")), "esape regel");
            T.eq("[true,true,false,false]", Json.stringify(Json.list(Json.path(v, "github", "beheerder"), v.get("opLijst"), v.get("sleutelKlopt"), v.get("actueel"))), "esape before");
            before = callCount();
            r = GitHub.aanmelden(e, Json.obj("land", "NL", "omschrijving", omschrijving));
            T.eq("[4,\"Aanbieder bijwerken: ESAPE\"]", Json.stringify(Json.list(Json.path(r, "voorstel", "nummer"), Json.path(r, "voorstel", "titel"))), "maintainer pr");
            calls = callsSince(before);
            boolean fork = false;
            for (String x : calls) if (x.contains("/forks") || x.contains("merge-upstream")) fork = true;
            T.check(!fork, "no fork needed");
            T.check(calls.contains("POST /repos/renevanes/own-cloud/git/refs"), "branch in the repository itself");
            T.eq("aanbieder-dienst-esape-nl", Json.str(Json.listAt(state(), "prs").get(3), "head", "label"), "same-repo head");
            T.eq("Bevestig dat je het voorstel zelf wilt samenvoegen", err(() -> GitHub.samenvoegen(e, Json.obj())), "confirm maintainer");
            Map<String, Object> m = GitHub.samenvoegen(e, Json.obj("confirm", true));
            T.eq("[true,\"samengevoegd\"]", Json.stringify(Json.list(m.get("ok"), Json.path(m, "voorstel", "status"))), "merged by maintainer");
            T.check(Json.path(m, "voorstel", "samengevoegdOp") instanceof Number, "merged at (maintainer)");
            T.check(callsSince(before).contains("merge 4 squash Aanbieder bijwerken: ESAPE (#4)"), "merge call");
            List<Object> main = Json.asList(Json.parse(Json.str(state(), "main")));
            T.eq("[\"naam\",\"url\",\"land\",\"contact\",\"omschrijving\",\"sleutel\",\"standaard\",\"adressen\"]", Json.stringify(new ArrayList<Object>(Json.asMap(main.get(0)).keySet())), "esape keys");
            T.eq(Json.stringify(Json.list(Json.str(info, "esape", "publicKey"), true, "Van Es", "Vanuit Rotterdam")),
                    Json.stringify(Json.list(Json.path(main.get(0), "sleutel"), Json.path(main.get(0), "standaard"), Json.path(main.get(1), "naam"), Json.path(main.get(1), "omschrijving"))), "main after merge");
            v = GitHub.view(e, deps);
            T.eq("[\"samengevoegd\",true,true,true]", Json.stringify(Json.list(Json.path(v, "voorstel", "status"), v.get("opLijst"), v.get("sleutelKlopt"), v.get("actueel"))), "esape on the list");
            T.eq("Er is geen open voorstel", err(() -> GitHub.samenvoegen(e, Json.obj("confirm", true))), "nothing open");
            control("revoke?token=" + token("rene"));
            T.eq("GitHub accepteert je token niet meer. Koppel GitHub opnieuw.", err(() -> GitHub.aanmelden(e, Json.obj("land", "NL", "omschrijving", "Anders"))), "revoked");
            T.eq("{\"ok\":true}", Json.stringify(GitHub.ontkoppelen(e)), "ontkoppelen");
            v = GitHub.view(e, deps);
            T.eq("[{\"gekoppeld\":false,\"login\":null,\"beheerder\":false},\"samengevoegd\"]", Json.stringify(Json.list(v.get("github"), Json.path(v, "voorstel", "status"))), "after ontkoppelen");
            T.eq("Koppel eerst GitHub", err(() -> GitHub.aanmelden(e, Json.obj("land", "NL", "omschrijving", "Anders"))), "not linked");

            // Zonder Dienst of als de Dienst niet antwoordt
            T.eq("Er draait nog geen Dienst", err(() -> GitHub.view(Json.obj("console", Json.obj()), deps)), "no dienst");
            Aanbieder.Reach keep = Aanbieder.reach;
            Aanbieder.reach = url -> "http://127.0.0.1:9";
            Map<String, Object> weg = Json.obj("console", Json.obj("aanbieder", Json.obj("url", "https://weg.example", "secret", "5555555555555555555555555555555555555555555555555555555555555555", "server", Json.obj())));
            v = GitHub.view(weg, deps);
            T.eq("[null,\"Je Dienst is nu niet bereikbaar. Probeer het zo opnieuw.\",false]", Json.stringify(Json.list(v.get("regel"), v.get("dienstFout"), v.get("opLijst"))), "dienst unreachable");

            // Voorwaarden en privacy
            Aanbieder.reach = keep;
            Map<String, Object> j = DienstVoorwaarden.status(c);
            T.eq("{\"bereikbaar\":true,\"documenten\":[{\"soort\":\"voorwaarden\",\"titel\":\"Algemene voorwaarden\",\"versie\":null,\"gewijzigd\":null,\"url\":null},{\"soort\":\"privacy\",\"titel\":\"Privacyverklaring\",\"versie\":null,\"gewijzigd\":null,\"url\":null},{\"soort\":\"verwerkersovereenkomst\",\"titel\":\"Verwerkersovereenkomst\",\"versie\":null,\"gewijzigd\":null,\"url\":null}],\"termsUrl\":null,\"privacyUrl\":null,\"fout\":null}",
                    Json.stringify(j), "juridisch before");
            Http.request("POST", Json.str(info, "control") + "/publiceer?dienst=vanes", null, new byte[0], 10_000);
            j = DienstVoorwaarden.status(c);
            Map<String, Object> d0 = Json.asMap(Json.listAt(j, "documenten").get(0));
            T.eq("[\"https://dienst.vanes.test/voorwaarden\",null,1,\"https://dienst.vanes.test/voorwaarden\"]", Json.stringify(Json.list(j.get("termsUrl"), j.get("privacyUrl"), d0.get("versie"), d0.get("url"))), "juridisch after");
            T.check(d0.get("gewijzigd") instanceof Number, "gewijzigd is a time");
            Aanbieder.reach = url -> "http://127.0.0.1:9";
            j = DienstVoorwaarden.status(c);
            Aanbieder.reach = keep;
            T.eq("[false,\"Je Dienst is nu niet bereikbaar\",3]", Json.stringify(Json.list(j.get("bereikbaar"), j.get("fout"), Json.listAt(j, "documenten").size())), "juridisch unreachable");

            // Zonelimiet bij deSEC
            Map<String, Object> z = Json.obj("console", Json.obj("aanbieder", Json.obj("step", "klaar", "url", "https://dienst.esape.nl", "accounts", Json.obj("desecToken", "dienst-tok"),
                    "adressen", Json.obj("zone", "eigencloud.nl", "desecToken", "adres-tok", "host", "adressen.esape.nl"))));
            T.eq("{\"welke\":\"adressen\",\"zone\":\"eigencloud.nl\",\"account\":\"rene@esape.nl\",\"zones\":502,\"limiet\":15,\"support\":\"support@desec.io\",\"fout\":null}", Json.stringify(ZoneLimiet.status(z, "adressen")), "zones adressen");
            T.eq("{\"welke\":\"dienst\",\"zone\":null,\"account\":null,\"zones\":502,\"limiet\":null,\"support\":\"support@desec.io\",\"fout\":\"Dit token mag de accountgegevens niet lezen; deSEC laat de limiet dan niet zien.\"}", Json.stringify(ZoneLimiet.status(z, "dienst")), "zones dienst");
            Json.map(z, "console", "aanbieder", "accounts").put("desecToken", "fout");
            T.eq("{\"welke\":\"dienst\",\"zone\":null,\"account\":null,\"zones\":null,\"limiet\":null,\"support\":\"support@desec.io\",\"fout\":\"deSEC accepteert dit token niet.\"}", Json.stringify(ZoneLimiet.status(z, "x")), "zones bad token");
            Json.map(z, "console", "aanbieder").remove("adressen");
            T.eq("De gratis-adressendienst draait niet op de server van je Dienst", err(() -> ZoneLimiet.status(z, "adressen")), "no adressendienst");
            T.eq("Er is nog geen deSEC-token (Accounts en sleutels)", err(() -> ZoneLimiet.status(Json.obj("console", Json.obj()), "dienst")), "no token");
            T.eq("[\"https://desec.io/api/v1/domains/?cursor=abc\",null,null]", Json.stringify(Json.list(ZoneLimiet.nextLink("<https://desec.io/api/v1/domains/?cursor=>; rel=\"first\", <https://desec.io/api/v1/domains/?cursor=abc>; rel=\"next\""), ZoneLimiet.nextLink(null), ZoneLimiet.nextLink("<x>; rel=\"prev\""))), "nextLink");
            Endpoints.reset();
        });
    }
}
