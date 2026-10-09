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
        });
    }
}
