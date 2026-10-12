package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/**
 * De telefoonconsole regelt alles zelf: (A) gratis deSEC-account met naam.dedyn.io (nep-deSEC), en
 * (B) de hele route via de Eigen Cloud Dienst tegen de ECHTE dienst (src/broker, met nep-Mollie/-Openprovider/
 * -deSEC/-Scaleway; DIENST_INFO) en opslag op moto_server (MOTO_URL).
 */
public class ConsoleExtrasTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    private static String get(String url) throws Exception { return Http.request("GET", url, null, null, 10_000).text(); }

    private static Object post(String url, Object body) throws Exception {
        Http.Response r = Http.request("POST", url, Http.headers("content-type", "application/json"), Bytes.utf8(Json.stringify(body)), 10_000);
        T.check(r.ok(), "control " + url + " → " + r.status + " " + r.text());
        return Json.parse(r.text());
    }

    /** The newest login code mailed after the first {@code seen} mails. */
    private static String loginCode(String control, int seen) throws Exception {
        for (int i = 0; i < 100; i++) {
            List<Object> ms = Json.asList(Json.parse(get(control + "/mails")));
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

    private static int mailCount(String control) throws Exception { return Json.asList(Json.parse(get(control + "/mails"))).size(); }

    public static void main(String[] args) {
        T.main("ConsoleExtrasTest", () -> {
            String moto = T.env("MOTO_URL");
            Map<String, Object> info = Json.parseObject(new String(Files.readAllBytes(new File(T.env("DIENST_INFO")).toPath()), "UTF-8"));
            // Catalogus met de Scaleway-opslag op moto (in het echt: s3.nl-ams.scw.cloud enz.)
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) if ("scaleway".equals(Json.str(o, "id"))) for (Object r : Json.listAt(o, "regions")) Json.asMap(r).put("endpoint", moto);
            Catalog cat = new Catalog(Json.stringify(catJson));

            File dir = Files.createTempDirectory("console-extras").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);
            api.dienstUrl = Json.str(info, "url");

            try (FakeApi desec = new FakeApi()) {
                final boolean[] active = {false};
                desec.json("^POST /desec/captcha/$", 201, Json.obj("id", "cap-1", "challenge", "cG5n", "kind", "image"))
                        .on("^POST /desec/auth/$", c -> "ABC12".equals(Json.str(c.json, "captcha", "solution"))
                                ? new FakeApi.Reply(202, "{\"detail\":\"Welcome!\"}", "application/json")
                                : new FakeApi.Reply(400, "{\"captcha\":[\"CAPTCHA could not be validated.\"]}", "application/json"))
                        .on("^POST /desec/auth/login/$", c -> active[0] ? new FakeApi.Reply(200, "{\"token\":\"login-1\"}", "application/json") : new FakeApi.Reply(403, "{\"detail\":\"Invalid\"}", "application/json"))
                        .json("^POST /desec/auth/tokens/$", 201, Json.obj("token", "blijvend-token-1234"))
                        .json("^GET /desec/domains/vanes\\.dedyn\\.io/$", 200, Json.obj("name", "vanes.dedyn.io"));
                Endpoints.DESEC = desec.base() + "/desec";

                // ── A. Gratis: naam.dedyn.io en een deSEC-account vanuit de app ──
                Map<String, Object> st = call(200, "GET", "/api/state", null);
                T.eq(true, st.get("dienst"), "dienst offered");
                Map<String, Object> e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes", "domainMode", "free", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "passphrase", "vier losse woorden hier"));
                T.check(Json.str(e, "error").contains("meldadres"), "free name needs an alert address");
                call(200, "POST", "/api/setup/create", Json.obj("domain", "Vanes", "domainMode", "free", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                T.eq("vanes.dedyn.io", Json.str(call(200, "GET", "/api/config", null), "domain"), "free domain");
                T.eq("free", Json.path(call(200, "GET", "/api/state", null), "domainMode"), "domainMode in state");
                T.eq("cap-1", Json.str(call(200, "POST", "/api/desec/captcha", null), "id"), "captcha");
                e = call(400, "POST", "/api/desec/register", Json.obj("captchaId", "cap-1", "solution", "fout"));
                T.check(Json.str(e, "error").contains("plaatje"), "wrong captcha explained");
                call(200, "POST", "/api/desec/register", Json.obj("captchaId", "cap-1", "solution", "ABC12"));
                T.eq("vanes.dedyn.io", Json.str(desec.find("^POST /desec/auth/$").json, "domain"), "dedyn name requested at registration");
                T.eq(true, call(200, "POST", "/api/desec/finish", null).get("pending"), "pending until confirmed");
                active[0] = true;
                Map<String, Object> fin = call(200, "POST", "/api/desec/finish", null);
                T.eq(true, fin.get("delegated"), "dedyn.io delegated at once");
                T.eq("Token login-1", desec.find("^POST /desec/auth/tokens/$").headers.get("authorization"), "permanent token made with login token");
                Map<String, Object> conf = call(200, "GET", "/api/config", null);
                T.eq("desec", conf.get("dnsMode"), "dns mode desec");
                T.check(Json.str(conf, "dns", 0, "token").endsWith("1234") && Json.str(conf, "dns", 0, "token").startsWith("••"), "token masked");
            } finally {
                Endpoints.reset();
            }

            // ── B. Alles via de Eigen Cloud Dienst ──
            Map<String, Object> dinfo = call(200, "GET", "/api/dienst/info", null);
            List<Object> bundles = Json.listAt(dinfo, "bundles");
            T.check(!bundles.isEmpty(), "bundles from the service");
            String bundle = Json.str(bundles.get(0), "id");
            T.eq("vanes.nl", Json.str(call(200, "GET", "/api/dienst/check?name=Vanes.nl", null), "domain"), "domain check");
            Map<String, Object> e = call(400, "POST", "/api/dienst/order", Json.obj("bundle", bundle, "mode", "register", "acceptTerms", true));
            T.check(Json.str(e, "error").contains("Log eerst in"), "login first");
            call(200, "POST", "/api/dienst/login", Json.obj("email", "rene@elders.example"));
            String code = null;
            for (int i = 0; i < 100 && code == null; i++) {
                for (Object m : Json.asList(Json.parse(get(Json.str(info, "control") + "/mails")))) {
                    java.util.regex.Matcher mm = java.util.regex.Pattern.compile("inlogcode: (\\d{6})").matcher(Json.str(m, "data"));
                    if (mm.find()) code = mm.group(1);
                }
                if (code == null) Thread.sleep(50);
            }
            T.check(code != null, "login code mailed");
            call(400, "POST", "/api/dienst/verify", Json.obj("code", "000000"));
            call(200, "POST", "/api/dienst/verify", Json.obj("code", code));
            e = call(400, "POST", "/api/dienst/order", Json.obj("bundle", bundle, "mode", "register", "acceptTerms", true));
            T.check(Json.str(e, "error").contains("eigen domeinnaam"), "dedyn.io not with the service");
            call(200, "POST", "/api/setup/domain", Json.obj("domain", "vanes.nl", "domainMode", "buy"));
            T.check(Json.path(call(200, "GET", "/api/config", null), "dnsMode") == null, "old DNS link cleared");
            Map<String, Object> reg = Json.obj("firstName", "Rene", "lastName", "van Es", "street", "Coolsingel", "number", "40", "zipcode", "3011 AD", "city", "Rotterdam", "country", "NL", "phone", "+31 6 12345678", "email", "rene@elders.example");
            Map<String, Object> o = call(200, "POST", "/api/dienst/order", Json.obj("bundle", bundle, "mode", "register", "registrant", reg, "acceptTerms", true));
            T.check(Json.str(o, "checkoutUrl").startsWith("https://mollie.test/checkout/"), "checkout URL");
            T.eq("awaiting_payment", Json.str(call(200, "GET", "/api/dienst/status", null), "status"), "awaiting payment");
            Http.request("POST", Json.str(info, "control") + "/pay?order=" + Json.str(o, "orderId"), null, new byte[0], 10_000);
            String status = "";
            for (int i = 0; i < 200 && !"ready".equals(status); i++) {
                status = Json.str(call(200, "GET", "/api/dienst/status", null), "status");
                if (!"ready".equals(status)) Thread.sleep(100);
            }
            T.eq("ready", status, "service ready");
            Map<String, Object> ap = call(200, "POST", "/api/dienst/apply", null);
            T.eq(2, Json.listAt(ap, "stores").size(), "two stores prepared (buckets on moto)");
            Map<String, Object> conf = call(200, "GET", "/api/config", null);
            T.eq("dienst", conf.get("dnsMode"), "dns via the service");
            T.check(Json.str(conf, "dns", 0, "api").endsWith("/v1/desec"), "dns api points at the service proxy");
            T.eq("smtp.tem.scaleway.com", Json.str(conf, "mailRelay", "host"), "mail relay from the kit");
            T.check(Json.str(conf, "providers", "scaleway", "secretKey").startsWith("••"), "scoped key stored, masked");
            boolean allScw = true;
            for (Object p : Json.listAt(conf, "policy", "placement")) allScw &= "scaleway".equals(Json.str(p, "provider"));
            T.check(allScw && !Json.listAt(conf, "policy", "placement").isEmpty(), "placement from the bundle");
            for (Object x : Json.asList(call(200, "GET", "/api/checklist", null).get("_"))) {
                if (Json.truthy(Json.path(x, "required")) && !"sleutel".equals(Json.str(x, "id"))) T.check(Json.truthy(Json.path(x, "ok")), "checklist: " + Json.str(x, "label"));
            }

            // ── C. Abonnement regelen vanuit de app ──
            Map<String, Object> bill = call(200, "GET", "/api/dienst/billing", null);
            T.eq("ready", Json.str(bill, "status"), "billing status");
            List<Object> pays = Json.listAt(bill, "payments");
            T.eq(1, pays.size(), "one payment");
            String inv = Json.str(pays.get(0), "invoiceId");
            T.check(inv != null, "first payment has an invoice");
            T.check(Json.str(call(200, "GET", "/api/dienst/invoice?id=" + inv, null), "html").matches("(?s).*EC-\\d{4}-\\d{4}.*"), "invoice html");
            call(400, "GET", "/api/dienst/invoice?id=..%2Fx", null);
            String other = null;
            for (Object x : Json.listAt(bill, "bundles")) if (!Json.truthy(Json.path(x, "current"))) other = Json.str(x, "id");
            T.eq(other, Json.str(call(200, "POST", "/api/dienst/bundle", Json.obj("bundle", other)), "bundle", "id"), "bundle changed");
            T.eq(other, Json.str(call(200, "GET", "/api/config", null), "dienst", "bundle"), "bundle kept in the vault");
            T.check(Json.str(call(200, "POST", "/api/dienst/payment-method", null), "checkoutUrl").startsWith("https://mollie.test/checkout/"), "new mandate via checkout");
            T.check(Json.str(call(400, "POST", "/api/dienst/settle", null), "error").contains("niets open"), "nothing to settle");
            T.eq("vanes.nl", Json.str(call(200, "GET", "/api/dienst/authcode", null), "domain"), "authcode");

            // ── C2. Aanbieders: lijst, huisstijl, uitnodiging, hulpvragen, berichten, extra gebruikers, gezondheid ──
            String control = Json.str(info, "control"), dienst = Json.str(info, "url");
            T.eq("https://vanes.example", Extras.cleanDienstUrl(" Vanes.Example/ "), "provider url: https added, lowercased, trailing slash off");
            T.eq("https://x.nl/pad", Extras.cleanDienstUrl("https://x.nl:443/pad//"), "provider url: default port and slashes dropped");
            T.eq("http://10.0.2.2:8080", Extras.cleanDienstUrl("http://10.0.2.2:8080/"), "provider url: http allowed for the emulator host");
            T.throwsWith("begint met https://", () -> Extras.cleanDienstUrl("http://evil.example"), "provider url: plain http refused");
            T.throwsWith("begint met https://", () -> Extras.cleanDienstUrl("ftp://nee"), "provider url: ftp refused");
            T.throwsWith("geen geldig adres", () -> Extras.cleanDienstUrl("https://u:p@x.nl"), "provider url: no userinfo");
            T.throwsWith("geen geldig adres", () -> Extras.cleanDienstUrl("https://x.nl/?a=1"), "provider url: no query");
            T.throwsWith("geen geldig adres", () -> Extras.cleanDienstUrl("https://x.nl/#a"), "provider url: no hash");
            try {
                Endpoints.AANBIEDERS = "http://127.0.0.1:1/aanbieders.json";
                List<Object> none = Json.listAt(call(200, "GET", "/api/aanbieders", null), "aanbieders");
                T.eq(1, none.size(), "list unreachable: only the default");
                T.eq(dienst, Json.str(none.get(0), "url"), "list unreachable: default provider");
                T.eq("Eigen Cloud Dienst", Json.str(none.get(0), "naam"), "default provider name");
                Endpoints.AANBIEDERS = control + "/aanbieders.json";
                Map<String, Object> al = call(200, "GET", "/api/aanbieders", null);
                List<Object> urls = new java.util.ArrayList<>();
                for (Object a : Json.listAt(al, "aanbieders")) urls.add(Json.str(a, "url"));
                T.eq(Json.list(dienst, "https://ander.example"), urls, "invalid entries skipped, default not doubled");
                T.eq("NL", Json.str(al, "aanbieders", 0, "land"), "extra fields kept");
                T.eq(null, al.get("gekozen"), "nothing chosen yet");
                // Standaardaanbieder uit de lijst (zonder vaste standaard in de app): alleen als hij antwoordt.
                String keepUrl = api.dienstUrl;
                try {
                    api.dienstUrl = "";
                    Extras.resetAanbiedersCache();
                    Endpoints.AANBIEDERS = control + "/aanbieders-standaard.json";
                    List<Object> std = Json.listAt(call(200, "GET", "/api/aanbieders", null), "aanbieders");
                    T.eq(Json.stringify(Json.list(
                            Json.obj("naam", "Dienst Test", "url", dienst, "land", "NL", "standaard", true, "adressen", "https://adressen.example", "bereikbaar", true),
                            Json.obj("naam", "Ander", "url", "http://127.0.0.1:1", "bereikbaar", false),
                            Json.obj("naam", "Ook standaard", "url", "http://127.0.0.1:2", "bereikbaar", false))), Json.stringify(std), "standaard vooraan, alleen de eerste, met bereikbaar");
                    T.eq(dienst, Extras.defaultBase(""), "bereikbare standaard wordt de standaard");
                    T.eq(dienst, Extras.baseOf(null, ""), "baseOf valt terug op de standaard uit de lijst");
                    Extras.resetAanbiedersCache();
                    Endpoints.AANBIEDERS = control + "/aanbieders-nog-niet.json";
                    List<Object> nn = Json.listAt(call(200, "GET", "/api/aanbieders", null), "aanbieders");
                    T.eq(Json.stringify(Json.list(Json.obj("naam", "Nog niet", "url", "http://127.0.0.1:3", "standaard", true, "bereikbaar", false))), Json.stringify(nn), "standaard die niet antwoordt");
                    T.eq("", Extras.defaultBase(""), "geen standaard zolang hij niet antwoordt");
                    // Zonder lijst op internet: de meegeleverde (aanbieders.json uit de app)
                    Extras.resetAanbiedersCache();
                    Endpoints.AANBIEDERS = "http://127.0.0.1:1/aanbieders.json";
                    String keepBundled = Extras.bundledAanbieders;
                    Extras.bundledAanbieders = "[{\"naam\":\"Meegeleverd\",\"url\":\"http://127.0.0.1:4\",\"standaard\":true}]";
                    try {
                        T.eq("Meegeleverd", Json.str(call(200, "GET", "/api/aanbieders", null), "aanbieders", 0, "naam"), "meegeleverde lijst");
                    } finally {
                        Extras.bundledAanbieders = keepBundled;
                    }
                } finally {
                    api.dienstUrl = keepUrl;
                    Extras.resetAanbiedersCache();
                }
            } finally {
                Endpoints.reset();
            }

            // Huisstijl (met logo) en een uitnodigingscode bij de aanbieder
            byte[] png = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0};
            post(control + "/brand", Json.obj("name", "Van Es Cloud", "accentColor", "#123abc", "contact", Json.obj("email", "hulp@vanes.test"), "logoPng", Bytes.base64(png)));
            Map<String, Object> br = call(200, "GET", "/api/aanbieder/brand?url=" + Bytes.encodeURIComponent(dienst), null);
            T.eq("Van Es Cloud", br.get("name"), "brand name");
            T.eq("#123abc", br.get("accentColor"), "brand colour");
            T.eq("hulp@vanes.test", Json.str(br, "contact", "email"), "brand contact");
            T.eq(dienst, br.get("url"), "brand url");
            T.check(!Json.listAt(br, "bundles").isEmpty(), "brand carries the bundles");
            T.eq("eigencloud.test", br.get("freeZone"), "brand carries the free zone");
            T.eq("data:image/png;base64," + Bytes.base64(png), br.get("logo"), "logo as data URL");
            T.check(Json.str(call(400, "GET", "/api/aanbieder/brand?url=" + Bytes.encodeURIComponent("http://elders.example"), null), "error").contains("https://"), "brand: https only");
            String invite = Json.str(post(control + "/invite", Json.obj("label", "test")), "code");
            T.eq(true, call(200, "GET", "/api/aanbieder/invite?url=" + Bytes.encodeURIComponent(dienst) + "&code=" + invite, null).get("valid"), "invite valid");
            T.eq(false, call(200, "GET", "/api/aanbieder/invite?url=" + Bytes.encodeURIComponent(dienst) + "&code=NEPCODE1", null).get("valid"), "unknown invite not valid");
            T.check(Json.str(call(400, "GET", "/api/aanbieder/invite?url=" + Bytes.encodeURIComponent(dienst) + "&code=x", null), "error").contains("klopt niet"), "malformed invite code");
            T.check(Json.str(call(400, "POST", "/api/dienst/select", Json.obj("url", "https://ander.example")), "error").contains("al een abonnement"), "no switching with a running subscription");
            call(400, "POST", "/api/dienst/select", Json.obj("url", dienst, "invite", "NEPCODE1"));
            T.eq(null, Json.path(call(200, "GET", "/api/config", null), "dienst", "url"), "failed select changes nothing");
            T.eq("Van Es Cloud", call(200, "POST", "/api/dienst/select", Json.obj("url", dienst + "/", "invite", invite)).get("name"), "select returns the brand");
            conf = call(200, "GET", "/api/config", null);
            T.eq(dienst, Json.str(conf, "dienst", "url"), "provider kept in the vault");
            T.eq(invite, Json.str(conf, "dienst", "invite"), "invite kept in the vault");
            T.eq(Json.str(o, "orderId"), Json.str(conf, "dienst", "orderId"), "existing order kept");
            T.eq(true, Json.path(conf, "dienst", "loggedIn"), "login kept");
            Map<String, Object> st2 = call(200, "GET", "/api/state", null);
            T.eq(dienst, st2.get("aanbieder"), "state: chosen provider");
            T.eq(true, st2.get("dienst"), "state: service offered");
            T.eq("Van Es Cloud", call(200, "GET", "/api/dienst/brand", null).get("name"), "brand of the chosen provider");

            // Hulpvraag stellen, antwoord van de aanbieder lezen, reageren
            Map<String, Object> tk = call(200, "POST", "/api/dienst/tickets", Json.obj("subject", "Mail komt niet aan", "message", "Sinds vanochtend geen mail."));
            String tid = Json.str(tk, "id");
            T.check(tid != null, "ticket id");
            post(control + "/staff-reply", Json.obj("ticket", tid, "message", "We kijken ernaar."));
            Map<String, Object> tv = call(200, "GET", "/api/dienst/ticket?id=" + tid, null);
            List<Object> from = new java.util.ArrayList<>();
            for (Object x : Json.listAt(tv, "messages")) from.add(Json.str(x, "from"));
            T.eq(Json.list("customer", "staff"), from, "customer question and staff answer");
            T.eq(Json.str(o, "orderId"), Json.str(tv, "orderId"), "ticket linked to the order");
            call(200, "POST", "/api/dienst/ticket/reply", Json.obj("id", tid, "message", "Dank je!"));
            T.eq(3, Json.listAt(call(200, "GET", "/api/dienst/ticket?id=" + tid, null), "messages").size(), "reply added");
            T.eq(1, Json.listAt(call(200, "GET", "/api/dienst/tickets", null), "tickets").size(), "one ticket");
            T.check(Json.str(call(400, "GET", "/api/dienst/ticket?id=x", null), "error").contains("bestaat niet"), "bad ticket id");

            // Bericht van de aanbieder
            post(control + "/announcement", Json.obj("title", "Onderhoud zondag", "body", "Even geen mail tussen 2 en 3 uur.", "severity", "onderhoud"));
            T.eq("Onderhoud zondag", Json.str(call(200, "GET", "/api/dienst/announcements", null), "announcements", 0, "title"), "announcement");

            // Extra gebruikers: het aantal voor de cloud
            long included = Json.num(call(200, "GET", "/api/dienst/billing", null), "users", "included").longValue();
            Map<String, Object> us = call(200, "POST", "/api/dienst/users", Json.obj("count", 2));
            T.eq(included + 2, Json.num(us, "maxUsers").longValue(), "maxUsers after buying users");
            T.eq(2L, Json.num(us, "users", "extra").longValue(), "service reply passed through");
            T.eq(included + 2, Json.num(call(200, "GET", "/api/config", null), "maxUsers").longValue(), "maxUsers in the config");

            // Wat de cloud meekrijgt: het aantal gebruikers en waar hij zijn gezondheid meldt
            Map<String, Object> vc = api.vault.config();
            Map<String, Object> cs = Admin.consoleSettings(vc, api.dienstUrl);
            T.eq(String.valueOf(included + 2), cs.get("max_users"), "settings: max_users");
            Map<String, Object> rep = Json.parseObject((String) cs.get("dienst_report"));
            T.eq(Json.list("url", "orderId", "token"), new java.util.ArrayList<Object>(rep.keySet()), "dienst_report fields in TS order");
            T.eq(dienst, rep.get("url"), "dienst_report url");
            T.eq(Json.str(o, "orderId"), rep.get("orderId"), "dienst_report order");
            T.eq(Json.str(vc, "dns", 0, "token"), rep.get("token"), "dienst_report token = the service DNS token");
            T.eq(Json.obj("url", dienst, "orderId", Json.str(o, "orderId"), "token", rep.get("token")), Extras.dienstReport(vc, api.dienstUrl), "dienstReport");
            Map<String, Object> init = Console.initialSettings(vc, api.dienstUrl);
            T.eq(cs.get("max_users"), init.get("max_users"), "initialSettings: max_users");
            T.eq(cs.get("dienst_report"), init.get("dienst_report"), "initialSettings: dienst_report");
            Map<String, Object> bare = Json.copy(vc);
            Json.map(bare, "console").remove("maxUsers");
            Json.map(bare, "console", "dienst").put("applied", false);
            Map<String, Object> csb = Admin.consoleSettings(bare, api.dienstUrl);
            T.eq("0", csb.get("max_users"), "settings: max_users 0 without subscription users");
            T.eq("", csb.get("dienst_report"), "settings: no report before the kit is applied");
            T.check(!Console.initialSettings(bare, api.dienstUrl).containsKey("max_users") && !Console.initialSettings(bare, api.dienstUrl).containsKey("dienst_report"), "initialSettings without users/report");
            Json.map(bare, "console", "dienst").remove("url");
            Json.map(bare, "console", "dienst").put("applied", true);
            T.eq("", Admin.consoleSettings(bare, "").get("dienst_report"), "settings: no report without any provider url");
            T.check(((String) Admin.consoleSettings(bare, dienst + "/").get("dienst_report")).contains("\"url\":\"" + dienst + "\""), "settings: build default without trailing slash");
            // ...en dat token werkt echt bij de aanbieder
            Http.Response h = Http.request("POST", rep.get("url") + "/v1/orders/" + rep.get("orderId") + "/health", Http.headers("content-type", "application/json", "authorization", "Token " + rep.get("token")),
                    Bytes.utf8(Json.stringify(Json.obj("version", "1.8", "healthy", true, "problems", Json.list(), "storageUsedBytes", 1234, "users", 3, "nodes", Json.list()))), 10_000);
            T.eq(200, h.status, "health report accepted by the provider (" + h.text() + ")");

            // ── D. Nieuw toestel: herstellen met alleen e-mail, code en herstelsleutel ──
            String masterKey = Json.str(api.vault.config(), "masterKey");
            Map<String, Object> dienstCfg = Json.copy(api.vault.config());
            Json.asMap(dienstCfg.get("console")).put("done", true);
            T.check(Admin.saveAdminCopy(dienstCfg) >= 1, "admin copy in the service storage");
            ConsoleApi first = api;
            api = new ConsoleApi(new File(dir, "kluis-nieuw.json"), cat, null);
            api.dienstUrl = Json.str(info, "url");
            T.check(Json.str(call(400, "POST", "/api/setup/recover-dienst", Json.obj("masterKey", masterKey, "passphrase", "vier losse woorden hier")), "error").contains("Log eerst in"), "recover needs login");
            int seen = Json.asList(Json.parse(get(Json.str(info, "control") + "/mails"))).size();
            call(200, "POST", "/api/recover/dienst/login", Json.obj("email", "rene@elders.example"));
            String code2 = null;
            for (int i = 0; i < 100 && code2 == null; i++) {
                List<Object> ms = Json.asList(Json.parse(get(Json.str(info, "control") + "/mails")));
                for (Object m : ms.subList(Math.min(seen, ms.size()), ms.size())) {
                    java.util.regex.Matcher mm = java.util.regex.Pattern.compile("inlogcode: (\\d{6})").matcher(Json.str(m, "data"));
                    if (mm.find()) code2 = mm.group(1);
                }
                if (code2 == null) Thread.sleep(50);
            }
            T.check(code2 != null, "recovery code mailed");
            call(200, "POST", "/api/recover/dienst/verify", Json.obj("code", code2));
            call(400, "POST", "/api/setup/recover-dienst", Json.obj("masterKey", "kort", "passphrase", "vier losse woorden hier"));
            call(200, "POST", "/api/setup/recover-dienst", Json.obj("masterKey", masterKey, "passphrase", "vier losse woorden hier"));
            Map<String, Object> rconf = call(200, "GET", "/api/config", null);
            T.eq("vanes.nl", Json.str(rconf, "domain"), "recovered domain");
            T.eq(Json.str(first.vault.config(), "console", "dienst", "orderId"), Json.str(rconf, "dienst", "orderId"), "recovered service order");
            T.eq("ready", Json.str(call(200, "GET", "/api/dienst/billing", null), "status"), "billing works after recovery");
            T.eq(null, Json.path(rconf, "dienst", "url"), "recovered at the build default: no provider url stored");
            T.eq(included + 2, Json.num(rconf, "maxUsers").longValue(), "recovered maxUsers from the kit");

            // ── E. Herstellen bij een gekozen aanbieder (versie zonder standaarddienst) ──
            api = new ConsoleApi(new File(dir, "kluis-aanbieder.json"), cat, null);
            T.eq(false, call(200, "GET", "/api/state", null).get("dienst"), "no default and no list: no service");
            T.check(Json.str(call(400, "POST", "/api/recover/dienst/login", Json.obj("email", "rene@elders.example")), "error").contains("Kies eerst een aanbieder"), "no provider chosen");
            T.check(Json.str(call(400, "POST", "/api/recover/dienst/login", Json.obj("email", "rene@elders.example", "url", "http://elders.example")), "error").contains("https://"), "recover: provider url checked");
            int seen3 = mailCount(control);
            call(200, "POST", "/api/recover/dienst/login", Json.obj("email", "rene@elders.example", "url", dienst + "/"));
            String code3 = loginCode(control, seen3);
            T.check(code3 != null, "recovery code mailed (chosen provider)");
            call(200, "POST", "/api/recover/dienst/verify", Json.obj("code", code3));
            call(200, "POST", "/api/setup/recover-dienst", Json.obj("masterKey", masterKey, "passphrase", "vier losse woorden hier"));
            Map<String, Object> aconf = call(200, "GET", "/api/config", null);
            T.eq(dienst, Json.str(aconf, "dienst", "url"), "recovered: provider url stored");
            T.eq(included + 2, Json.num(aconf, "maxUsers").longValue(), "recovered: maxUsers");
            Map<String, Object> st3 = call(200, "GET", "/api/state", null);
            T.eq(true, st3.get("dienst"), "state: service via the vault's provider");
            T.eq(dienst, st3.get("aanbieder"), "state: provider");
            T.eq("ready", Json.str(call(200, "GET", "/api/dienst/billing", null), "status"), "billing via the vault's provider");
            T.eq("Van Es Cloud", call(200, "GET", "/api/dienst/brand", null).get("name"), "brand via the vault's provider");
        });
    }
}
