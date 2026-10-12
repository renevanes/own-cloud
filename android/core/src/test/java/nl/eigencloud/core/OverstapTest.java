package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Overstappen op de telefoon, tegen twee echte Diensten (scripts/android-dienst.ts: Dienst A en B met nep-Mollie/
 * -Openprovider/-deSEC/-Scaleway) en opslag op moto: een cloud met een eigen domein bij A (slapend, met een
 * nagemaakt manifest) gaat naar B. B wacht op de DNS, A geeft hem vrij, de opslag wordt gekopieerd en de
 * instellingen omgezet. Wakker worden bij B lukt niet (de nep-servers starten nooit): terug naar A, met de DNS en
 * de instellingen van A. Elk antwoord (view) wordt vergeleken met dat van de TS-console bij dezelfde toestand.
 */
public class OverstapTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    private static String get(String url) throws Exception { return Http.request("GET", url, null, null, 10_000).text(); }

    private static String loginCode(String control, String dienst, int seen) throws Exception {
        for (int i = 0; i < 200; i++) {
            List<Object> ms = Json.asList(Json.parse(get(control + "/mails" + (dienst != null ? "?dienst=" + dienst : ""))));
            String code = null;
            for (Object m : ms.subList(Math.min(seen, ms.size()), ms.size())) {
                java.util.regex.Matcher mm = java.util.regex.Pattern.compile("inlogcode: (\\d{6})").matcher(Json.str(m, "data"));
                if (mm.find()) code = mm.group(1);
            }
            if (code != null) return code;
            Thread.sleep(50);
        }
        return null;
    }

    private static int mails(String control, String dienst) throws Exception {
        return Json.asList(Json.parse(get(control + "/mails" + (dienst != null ? "?dienst=" + dienst : "")))).size();
    }

    private static String control;

    /** View, en dezelfde toestand door de TS-console: precies hetzelfde antwoord (velden, volgorde, waarden). */
    private static Map<String, Object> view() throws Exception {
        Map<String, Object> v = call(200, "GET", "/api/overstap", null);
        Object state = Json.copy(Json.path(api.vault.config(), "console", "overstap"));
        if (state != null) {
            Http.Response r = Http.request("POST", control + "/overstap-view", Http.headers("content-type", "application/json"), Bytes.utf8(Json.stringify(Json.obj("state", state))), 10_000);
            Map<String, Object> java = Overstap.view(Json.obj("console", Json.obj("overstap", state)));
            T.eq(Json.stringify(Json.parse(r.text())), Json.stringify(Json.parse(Json.stringify(java))), "zelfde antwoord als TS (" + Json.str(java, "stap") + ")");
            compared++;
        }
        return v;
    }

    private static int compared;

    private interface Cond { boolean ok(Map<String, Object> v); }

    private static Map<String, Object> until(String what, Cond cond, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        Map<String, Object> v = null;
        while (System.currentTimeMillis() < end) {
            v = call(200, "GET", "/api/overstap", null);
            if (cond.ok(v)) { view(); return v; }
            Thread.sleep(150);
        }
        T.check(false, "timeout: " + what + " " + Json.stringify(v));
        return v;
    }

    private static String zoneAccount(String control, String name) throws Exception {
        Http.Response r = Http.request("GET", control + "/zone?name=" + name, null, null, 10_000);
        return r.ok() ? Json.str(Json.parse(r.text()), "account") : null;
    }

    private static String orderStatus(String control, String dienst, String id) throws Exception {
        return Json.str(Json.parse(get(control + "/order?id=" + id + (dienst != null ? "&dienst=" + dienst : ""))), "status");
    }

    public static void main(String[] args) {
        T.main("OverstapTest", () -> {
            String moto = T.env("MOTO_URL");
            Map<String, Object> info = Json.parseObject(new String(Files.readAllBytes(new File(T.env("DIENST_INFO")).toPath()), "UTF-8"));
            control = Json.str(info, "control");
            String dienstA = Json.str(info, "url"), dienstB = Json.str(info, "b");
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) if ("scaleway".equals(Json.str(o, "id"))) for (Object r : Json.listAt(o, "regions")) Json.asMap(r).put("endpoint", moto);
            Catalog cat = new Catalog(Json.stringify(catJson));
            Endpoints.SCALEWAY = Json.str(info, "upstream") + "/scw";
            Overstap.pollMs = 150;
            Overstap.wakeMs = 4000;
            Overstap.sleepMs = 10_000;
            Overstap.newMs = 30_000;
            File dir = Files.createTempDirectory("overstap").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);
            api.dienstUrl = dienstA;
            try {
                // ── Een cloud met een eigen domein bij A ──
                call(200, "POST", "/api/setup/create", Json.obj("domain", "overstap.nl", "domainMode", "own", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                int seen = mails(control, null);
                call(200, "POST", "/api/dienst/login", Json.obj("email", "overstap@elders.example"));
                call(200, "POST", "/api/dienst/verify", Json.obj("code", loginCode(control, null, seen)));
                String bundle = Json.str(Json.listAt(call(200, "GET", "/api/dienst/info", null), "bundles").get(0), "id");
                Map<String, Object> oa = call(200, "POST", "/api/dienst/order", Json.obj("bundle", bundle, "mode", "own", "acceptTerms", true));
                String orderA = Json.str(oa, "orderId");
                Http.request("POST", control + "/pay?order=" + orderA, null, new byte[0], 10_000);
                for (int i = 0; i < 200 && !"ready".equals(Json.str(call(200, "GET", "/api/dienst/status", null), "status")); i++) Thread.sleep(100);
                call(200, "POST", "/api/dienst/apply", null);
                T.eq("dienst", zoneAccount(control, "overstap.nl"), "zone bij A");

                T.eq(Json.obj("actief", false), call(200, "GET", "/api/overstap", null), "nog geen overstap");
                T.check(Json.str(call(400, "POST", "/api/overstap/start", Json.obj("naar", dienstB)), "error").contains("nog niet gestart"), "eerst starten");

                // Een slapende cloud nabootsen: manifest en wat gegevens in de opslag van A.
                Map<String, Object> c = api.vault.config();
                Json.map(c, "console").put("done", true);
                api.vault.save();
                ClusterConfig.Keys keys = ClusterConfig.keysFor(c);
                Map<String, Object> manifest = Json.obj("cluster", c.get("cluster"), "state", "asleep", "term", 3L, "lastSeq", 7L, "updated", System.currentTimeMillis(), "leader", "n-1",
                        "nodes", Json.list(), "topology", Json.list(Json.obj("kind", "data", "provider", "scaleway", "region", "nl-ams-1", "size", "DEV1-S")));
                List<String> bucketsA = new ArrayList<>();
                for (ObjectStore s : Stores.all(c)) {
                    s.put("manifest.enc", EigenCrypto.sealJson(keys.manifest, manifest, "manifest"));
                    s.put("db/snapshot-1.enc", Bytes.utf8("snapshot"));
                    s.put("blobs/ab/cdef", Bytes.utf8("foto"));
                    s.put("bootstrap/n-1.enc", Bytes.utf8("niet mee"));
                    bucketsA.add(Json.str(s.config(), "bucket"));
                }

                // ── Beginnen, inloggen en bestellen bij B ──
                T.check(Json.str(call(400, "POST", "/api/overstap/start", Json.obj("naar", dienstA)), "error").contains("al bij deze aanbieder"), "niet naar dezelfde");
                Map<String, Object> v = call(200, "POST", "/api/overstap/start", Json.obj("naar", dienstB));
                T.eq("inloggen", v.get("stap"), "stap inloggen");
                T.eq("Dienst B", v.get("naarNaam"), "naam van B");
                T.eq(Json.obj("url", dienstA, "naam", Json.str(Extras.dienstBrand(dienstA), "name"), "domain", "overstap.nl", "mode", "own", "central", false), v.get("van"), "van A, eigen domein");
                T.eq(true, v.get("dnsNodig"), "DNS moet mee");
                T.eq(3L, Json.num(v, "schatting", "objects").longValue(), "drie bestanden (zonder bootstrap/)");
                T.eq(Json.list("actief", "naar", "naarNaam", "stap", "started", "van", "email", "loggedIn", "orderId", "bundle", "checkoutUrl", "bestelling", "zelf", "dnsNodig", "schatting", "stappen", "kopie", "log", "fout", "kanTerug", "klaar", "preview"),
                        new ArrayList<Object>(v.keySet()), "velden in dezelfde volgorde als TS");
                view();
                int seenB = mails(control, "b");
                call(200, "POST", "/api/overstap/login", Json.obj("email", "overstap@elders.example"));
                call(200, "POST", "/api/overstap/verify", Json.obj("code", loginCode(control, "b", seenB)));
                T.eq("bestellen", view().get("stap"), "stap bestellen");
                T.eq(dienstA, Extras.baseOf(api.vault.config(), api.dienstUrl), "sessie bij A blijft tot het omzetten");
                Map<String, Object> ob = call(200, "POST", "/api/overstap/order", Json.obj("bundle", bundle, "acceptTerms", true));
                String orderB = Json.str(ob, "orderId");
                T.eq("own", Json.str(Json.parse(get(control + "/order?dienst=b&id=" + orderB)), "domainMode"), "B: eigen domein");
                T.check(Json.str(call(400, "POST", "/api/overstap/nu", Json.obj("confirm", true)), "error").contains("Nog niet klaar"), "eerst betalen");
                Http.request("POST", control + "/pay?dienst=b&order=" + orderB, null, new byte[0], 10_000);
                v = until("klaar om over te zetten (B wacht op de DNS)", x -> "gereed".equals(x.get("stap")), 30_000);
                T.eq("provisioning", Json.str(v, "bestelling", "status"), "B wacht");
                T.check(Json.str(call(400, "POST", "/api/overstap/nu", Json.obj()), "error").contains("Bevestig"), "alleen met bevestiging");

                // ── Overzetten: wakker worden bij B lukt niet (nep-servers) ──
                v = call(200, "POST", "/api/overstap/nu", Json.obj("confirm", true));
                T.eq("overzetten", v.get("stap"), "overzetten loopt");
                v = until("mislukt bij wekken", x -> "mislukt".equals(x.get("stap")), 120_000);
                T.check(Json.str(v, "fout").contains("komt niet op"), "fout: " + v.get("fout"));
                T.eq(true, v.get("kanTerug"), "terug kan");
                List<Object> states = new ArrayList<>();
                for (Object s : Json.listAt(v, "stappen")) states.add(Json.str(s, "id") + ":" + Json.str(s, "state"));
                T.eq(Json.list("voorbereiden:done", "slapen:done", "dns:done", "nieuw:done", "kopieren:done", "omzetten:done", "wekken:fail", "opruimen:wait"), states, "stappen tot het wekken");
                T.eq("b", zoneAccount(control, "overstap.nl"), "zone bij B");
                T.eq(dienstB, Json.str(call(200, "GET", "/api/config", null), "dienst", "url"), "instellingen van B");
                Map<String, Object> cb = api.vault.config();
                boolean copied = true;
                for (ObjectStore s : Stores.all(cb)) {
                    T.check(!bucketsA.contains(Json.str(s.config(), "bucket")), "nieuwe bucket " + s.name());
                    copied &= s.getBuffer("db/snapshot-1.enc") != null && s.getBuffer("blobs/ab/cdef") != null && s.getBuffer("manifest.enc") != null && s.getBuffer("bootstrap/n-1.enc") == null;
                }
                T.check(copied, "gegevens gekopieerd (zonder bootstrap/)");
                T.check(Json.num(v, "kopie", "objects").longValue() >= 3, "voortgang van het kopiëren");
                T.check(Json.str(call(400, "POST", "/api/overstap/stoppen", null), "error").contains("Terug naar"), "stoppen kan nu niet");

                // ── Terug naar A: B opgezegd, DNS weer bij A, instellingen van A ──
                v = call(200, "POST", "/api/overstap/terug", null);
                T.eq("terug", v.get("stap"), "terug loopt");
                v = until("terug tot het wekken", x -> "terug".equals(x.get("stap")) && x.get("fout") != null, 120_000);
                states.clear();
                for (Object s : Json.listAt(v, "stappen")) states.add(Json.str(s, "id") + ":" + Json.str(s, "state"));
                T.eq(Json.list("terug:servers:done", "terug:instellingen:done", "terug:dns:done", "terug:wekken:fail"), states, "terug tot het wekken (ook A's nep-server start niet)");
                T.eq("dienst", zoneAccount(control, "overstap.nl"), "zone weer bij A");
                T.eq("cancelled", orderStatus(control, "b", orderB), "B opgezegd");
                T.eq("ready", orderStatus(control, null, orderA), "A loopt door");
                Map<String, Object> conf = call(200, "GET", "/api/config", null);
                T.eq(Json.str(oa, "orderId"), Json.str(conf, "dienst", "orderId"), "abonnement van A");
                T.check(Json.str(conf, "dns", 0, "api").startsWith(dienstA), "DNS via A");
                List<String> bucketsNow = new ArrayList<>();
                for (ObjectStore s : Stores.all(api.vault.config())) bucketsNow.add(Json.str(s.config(), "bucket"));
                T.eq(bucketsA, bucketsNow, "opslag van A");
                T.eq(true, v.get("kanTerug"), "terug opnieuw proberen kan");
                T.check(compared >= 5, "antwoorden vergeleken met TS: " + compared);
            } finally {
                Endpoints.reset();
            }
        });
    }
}
