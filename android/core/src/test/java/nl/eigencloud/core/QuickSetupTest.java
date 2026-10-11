package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Nieuwe gebruiker zonder gedoe (zoals test/quick-setup.test.ts): met één Scaleway-sleutel zet de telefoonconsole
 * opslag, servers en mail klaar, en je kunt terug naar "zelf per onderdeel" of helemaal opnieuw beginnen (met
 * opruimen bij de aanbieder). Nep-Scaleway via {@link FakeApi} (sleutelinfo, servers en prijzen, maildomein/TEM);
 * de opslag draait op moto_server (MOTO_URL).
 */
public class QuickSetupTest {
    static final String AK = "SCWABCDEFGHJKMNPQRST", SK = "11111111-2222-3333-4444-555555555555", PROJECT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    static final String TEM = "/transactional-email/v1alpha1/regions/fr-par/domains";

    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    private static String query(FakeApi.Call c, String name) {
        if (c.query == null) return null;
        for (String kv : c.query.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(name)) return Bytes.decodeURIComponent(kv.substring(i + 1));
        }
        return null;
    }

    private static FakeApi.Reply json(int status, Object j) { return new FakeApi.Reply(status, Json.stringify(j), "application/json"); }

    /** Nep-Scaleway; tem = de aangemelde maildomeinen. */
    static FakeApi fakeScaleway(List<Map<String, Object>> tem) throws Exception {
        FakeApi api = new FakeApi();
        api.on("", c -> {
            synchronized (tem) {
                if (!SK.equals(c.headers.get("x-auth-token"))) return json(401, Json.obj("message", "authentication is denied"));
                String p = c.path;
                java.util.regex.Matcher m;
                if ((m = java.util.regex.Pattern.compile("^/iam/v1alpha1/api-keys/([^/]+)$").matcher(p)).matches()) {
                    return AK.equals(m.group(1)) ? json(200, Json.obj("access_key", AK, "default_project_id", PROJECT, "user_id", "u-1")) : json(404, Json.obj("message", "not found"));
                }
                if (p.matches("^/instance/v1/zones/[^/]+/servers$")) return json(200, Json.obj("servers", Json.list()));
                if (p.matches("^/instance/v1/zones/[^/]+/products/servers$")) {
                    return json(200, Json.obj("servers", Json.obj(
                            "DEV1-S", Json.obj("ncpus", 2L, "ram", 2L * 1024 * 1024 * 1024, "arch", "x86_64", "monthly_price", 6.42),
                            "STARDUST1-S", Json.obj("ncpus", 1L, "ram", 1024L * 1024 * 1024, "arch", "x86_64", "monthly_price", 0.5))));
                }
                if (p.equals(TEM) && "GET".equals(c.method)) {
                    List<Object> out = new ArrayList<>();
                    for (Map<String, Object> d : tem) if (d.get("project_id").equals(query(c, "project_id")) && d.get("name").equals(query(c, "name"))) out.add(d);
                    return json(200, Json.obj("domains", out));
                }
                if (p.equals(TEM) && "POST".equals(c.method)) {
                    String name = Json.str(c.json, "domain_name"), proj = Json.str(c.json, "project_id");
                    Map<String, Object> d = Json.obj("id", "tem-" + (tem.size() + 1), "name", name, "project_id", proj, "status", "pending",
                            "records", Json.obj("dkim", Json.obj("name", proj + "._domainkey." + name, "value", "v=DKIM1; h=sha256; k=rsa; p=MIIB"),
                                    "spf", Json.obj("name", name, "value", "v=spf1 include:_spf.tem.scaleway.com -all")));
                    tem.add(d);
                    return json(200, d);
                }
                if ((m = java.util.regex.Pattern.compile("^" + TEM + "/([^/]+)(/revoke)?$").matcher(p)).matches()) {
                    for (Map<String, Object> d : tem) {
                        if (!d.get("id").equals(m.group(1))) continue;
                        if (m.group(2) != null) d.put("status", "revoked");
                        return json(200, d);
                    }
                    return json(404, Json.obj());
                }
                return json(599, Json.obj("message", "onbekend: " + c.method + " " + p));
            }
        });
        return api;
    }

    /** Buckets op moto die bij deze test horen (clusternaam "snelstart"). */
    static List<String> ourBuckets(String moto) throws Exception {
        S3Store s = new S3Store(Json.obj("name", "x", "type", "s3", "endpoint", moto, "region", "us-east-1", "bucket", "", "accessKey", "test", "secretKey", "test"));
        List<String> out = new ArrayList<>();
        for (String b : s.listBuckets()) if (b.startsWith("snelstart-")) out.add(b);
        return out;
    }

    public static void main(String[] args) {
        T.main("QuickSetupTest", () -> {
            String moto = T.env("MOTO_URL");
            T.check(moto != null && !moto.isEmpty(), "MOTO_URL gezet");

            // ── Losse hulpjes ──
            String[] k = Extras.scwKeys(" " + AK.toLowerCase() + " ", " \"" + SK.toUpperCase() + "\" ");
            T.eq(AK, k[0], "access key cleaned and upper-cased");
            T.eq(SK, k[1], "secret key cleaned and lower-cased");
            T.throwsWith("begint met SCW", () -> Extras.scwKeys("abc", SK), "access key shape");
            T.throwsWith("8-4-4-4-12", () -> Extras.scwKeys(AK, "nee"), "secret key shape");
            T.eq(PROJECT, Extras.scwProject(AK, SK, " " + PROJECT + " "), "explicit project id used without a call");
            T.eq("p._domainkey", Extras.subnameOf("p._domainkey.vanes.nl.", "vanes.nl"), "subnameOf full name");
            T.eq("", Extras.subnameOf("@", "vanes.nl"), "subnameOf apex");
            Map<String, Object> legacy = Extras.temRecords(Json.obj("dkim_config", "v=DKIM1; p=X", "spf_config", "v=spf1 include:a.example include:b.example -all"), "proj");
            T.eq("proj._domainkey", Json.str(legacy, "dkim", "name"), "temRecords: legacy dkim_config");
            T.eq("include:a.example include:b.example", legacy.get("spfExtra"), "temRecords: includes from spf_config");
            T.throwsWith("Kies eerst een vrije naam", () -> Extras.normalizeDomain("zonder punt", "sub"), "sub mode: own error text");
            T.eq("rene.eigencloud.nl", Extras.normalizeDomain("Rene.eigencloud.nl", "sub"), "sub mode: like a normal domain");

            // Bestellen met een gratis adres van de dienst: mode "sub", geen houdergegevens.
            try (FakeApi dienst = new FakeApi()) {
                dienst.json("^POST /v1/orders$", 200, Json.obj("orderId", "o-1", "checkoutUrl", "https://mollie.test/checkout/1"));
                Map<String, Object> c = Json.obj("domain", "rene.eigencloud.nl", "console", Json.obj("domainMode", "sub", "dienst", Json.obj("token", "t")));
                Extras.dienstOrder(dienst.base(), c, Json.obj("bundle", "basis", "mode", "register", "registrant", Json.obj("firstName", "Rene"), "acceptTerms", true));
                T.eq("sub", Json.str(dienst.last().json, "domain", "mode"), "order mode sub from console.domainMode");
                T.check(!Json.asMap(dienst.last().json).containsKey("registrant"), "no registrant for sub");
                Map<String, Object> d2 = Json.obj("domain", "x.dedyn.io", "console", Json.obj("dienst", Json.obj("token", "t")));
                T.throwsWith("of een gratis adres van de dienst", () -> Extras.dienstOrder(dienst.base(), d2, Json.obj("bundle", "basis", "mode", "own", "acceptTerms", true)), "dedyn.io message");
            }

            // Catalogus met de Scaleway-opslag op moto (in het echt: s3.nl-ams.scw.cloud enz.)
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) if ("scaleway".equals(Json.str(o, "id"))) for (Object r : Json.listAt(o, "regions")) Json.asMap(r).put("endpoint", moto);
            Catalog cat = new Catalog(Json.stringify(catJson));

            File dir = Files.createTempDirectory("quick-setup").toFile();
            File vaultFile = new File(dir, "kluis.json");
            api = new ConsoleApi(vaultFile, cat, null);
            List<Map<String, Object>> tem = new ArrayList<>();
            try (FakeApi scw = fakeScaleway(tem)) {
                Endpoints.SCALEWAY = scw.base();
                T.check(ourBuckets(moto).isEmpty(), "no buckets of this test yet");

                call(200, "POST", "/api/setup/create", Json.obj("domain", "snelstart.nl", "domainMode", "own", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                Map<String, Object> st = call(200, "GET", "/api/state", null);
                T.eq(Extras.SCW_SIGNUP_URL, Json.str(st, "scaleway", "signup"), "state: signup link");
                T.check(Json.str(st, "scaleway", "keys").startsWith("https://console.scaleway.com/iam/api-keys"), "state: keys link");
                T.eq(null, call(200, "GET", "/api/config", null).get("quick"), "config: quick null at first");

                // ── Sleutels controleren: vorm en echtheid ──
                Map<String, Object> e = call(400, "POST", "/api/quick/scaleway", Json.obj("accessKey", "abc", "secretKey", SK));
                T.check(Json.str(e, "error").contains("begint met SCW"), "wrong access key shape");
                T.check(Json.listAt(e, "steps").isEmpty() && e.containsKey("steps"), "error reply carries steps");
                e = call(400, "POST", "/api/quick/scaleway", Json.obj("accessKey", AK, "secretKey", "nee"));
                T.check(Json.str(e, "error").contains("8-4-4-4-12"), "wrong secret key shape");
                e = call(400, "POST", "/api/quick/scaleway", Json.obj("accessKey", AK, "secretKey", "99999999-2222-3333-4444-555555555555"));
                T.check(Json.str(e, "error").contains("accepteert deze sleutel niet"), "unknown key refused: " + Json.str(e, "error"));
                T.check(ourBuckets(moto).isEmpty(), "nothing created with a wrong key");
                T.check(tem.isEmpty(), "no mail domain with a wrong key");

                // ── Alles klaarzetten met één sleutel (geplakt met spaties en kleine letters) ──
                Map<String, Object> r = call(200, "POST", "/api/quick/scaleway", Json.obj("accessKey", " " + AK.toLowerCase() + " ", "secretKey", " \"" + SK.toUpperCase() + "\" "));
                boolean allOk = true;
                for (Object s : Json.listAt(r, "steps")) allOk &= Json.truthy(Json.path(s, "ok"));
                T.check(allOk, "all steps ok: " + Json.stringify(r.get("steps")));
                T.eq(6, Json.listAt(r, "steps").size(), "six steps");
                T.eq(13.34, Json.num(r, "monthly").doubleValue(), "monthly = 2 × DEV1-S + STARDUST1-S");
                T.check(Json.str(r, "steps", 4, "label").startsWith("Servers: ") && Json.str(r, "steps", 4, "detail").equals("ongeveer € 13,34 per maand bij Scaleway, plus een paar euro voor opslag"), "preset step text");
                Map<String, Object> conf = call(200, "GET", "/api/config", null);
                T.eq("scaleway", conf.get("quick"), "quick flag");
                T.eq(PROJECT, Json.str(conf, "providers", "scaleway", "projectId"), "project id stored");
                List<String> names = new ArrayList<>();
                for (Object s : Json.listAt(conf, "stores")) names.add(Json.str(s, "name") + "/" + Json.str(s, "purpose"));
                java.util.Collections.sort(names);
                T.eq("[scaleway-fr-par-backup/backup, scaleway-nl-ams/replica]", names.toString(), "two stores");
                List<String> buckets = ourBuckets(moto);
                T.eq(2, buckets.size(), "two buckets on moto: " + buckets);
                List<String> pl = new ArrayList<>();
                for (Object p : Json.listAt(conf, "policy", "placement")) if (pl.size() < 3) pl.add(Json.str(p, "kind") + "/" + Json.str(p, "region"));
                T.eq("[data/nl-ams-1, data/nl-ams-2, witness/nl-ams-3]", pl.toString(), "all in the Netherlands");
                T.eq("nl", conf.get("preset"), "preset nl");
                T.eq("smtp.tem.scaleway.com", Json.str(conf, "mailRelay", "host"), "relay host");
                T.eq(PROJECT, Json.str(conf, "mailRelay", "user"), "relay user = project");
                T.eq("include:_spf.tem.scaleway.com", conf.get("spfExtra"), "spf include");
                T.eq(1, tem.size(), "one TEM domain");
                Map<String, Object> raw = api.vault.config();
                T.eq("[{\"sub\":\"" + PROJECT + "._domainkey\",\"type\":\"TXT\",\"value\":\"v=DKIM1; h=sha256; k=rsa; p=MIIB\"}]", Json.stringify(Json.path(raw, "console", "extraDns")), "extraDns: Scaleway DKIM");
                T.eq(Json.stringify(Json.path(raw, "console", "extraDns")), Console.initialSettings(raw).get("extra_dns"), "initialSettings carry extra_dns");
                T.eq("tem-1", Json.str(raw, "console", "temDomainId"), "TEM domain id kept");

                // Nog een keer (bijv. na Vorige stap): dezelfde buckets en hetzelfde maildomein, niets dubbel.
                call(200, "POST", "/api/quick/scaleway", Json.obj("accessKey", AK, "secretKey", SK));
                T.eq(buckets.toString(), ourBuckets(moto).toString(), "same buckets on a rerun");
                T.eq(1, tem.size(), "no second mail domain");

                // ── Ander domein: mail wordt opnieuw aangemeld ──
                Map<String, Object> dr = call(200, "POST", "/api/setup/domain", Json.obj("domain", "snelstart.eu", "domainMode", "own"));
                T.eq("snelstart.eu", dr.get("domain"), "domain changed");
                T.eq(2, tem.size(), "new TEM domain");
                T.eq("snelstart.eu", tem.get(1).get("name"), "TEM domain for the new name");
                T.eq("revoked", tem.get(0).get("status"), "old TEM domain revoked");
                T.eq("tem-2", Json.str(api.vault.config(), "console", "temDomainId"), "new TEM id");

                // ── Zelf per onderdeel: markering eraf, gekoppelde dingen blijven ──
                call(200, "POST", "/api/quick/off", null);
                conf = call(200, "GET", "/api/config", null);
                T.eq(null, conf.get("quick"), "quick flag off");
                T.eq(2, Json.listAt(conf, "stores").size(), "stores stay");

                // ── Opnieuw beginnen met opruimen: buckets (ook de onveranderbare) en maildomein weg ──
                r = call(200, "POST", "/api/setup/reset", Json.obj("cleanup", true));
                T.eq("[]", Json.stringify(r.get("left")), "nothing left behind: " + Json.stringify(r));
                T.eq(3, Json.listAt(r, "done").size(), "two buckets and the mail domain: " + Json.stringify(r.get("done")));
                T.check(ourBuckets(moto).isEmpty(), "buckets gone on moto: " + ourBuckets(moto));
                boolean revoked = true;
                for (Map<String, Object> d : tem) revoked &= "revoked".equals(d.get("status"));
                T.check(revoked, "all TEM domains revoked");
                T.check(!vaultFile.exists(), "vault file removed");
                T.eq(false, call(200, "GET", "/api/state", null).get("vault"), "state: no vault");
                call(401, "GET", "/api/config", null);

                // ── Na de start kan opnieuw beginnen niet meer ──
                call(200, "POST", "/api/setup/create", Json.obj("domain", "snelstart.nl", "domainMode", "own", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "passphrase", "vier losse woorden hier"));
                Json.map(api.vault.config(), "console").put("firstLaunch", Json.obj("at", System.currentTimeMillis(), "nodeId", "n1", "provider", "scaleway", "region", "nl-ams-1"));
                api.vault.save();
                call(200, "POST", "/api/lock", null);
                call(200, "POST", "/api/unlock", Json.obj("passphrase", "vier losse woorden hier"));
                e = call(409, "POST", "/api/setup/reset", Json.obj("cleanup", false));
                T.check(Json.str(e, "error").contains("al gestart"), "409 text");
                T.check(vaultFile.exists(), "vault kept after a launch");

                // ── Wachtwoordzin vergeten: kluis wissen zonder te ontgrendelen ──
                call(200, "POST", "/api/lock", null);
                call(400, "POST", "/api/vault/forget", Json.obj());
                T.check(vaultFile.exists(), "no wipe without confirm");
                call(200, "POST", "/api/vault/forget", Json.obj("confirm", true));
                T.check(!vaultFile.exists(), "vault wiped");
                T.eq(false, call(200, "GET", "/api/state", null).get("vault"), "start screen again");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
