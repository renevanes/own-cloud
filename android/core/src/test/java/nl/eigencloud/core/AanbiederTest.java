package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Aanbieder worden vanuit de telefoonconsole (zelfde routes en JSON als src/console/aanbieder.ts): bedrijf, accounts
 * (live gecontroleerd tegen nep-Scaleway/-Mollie/-deSEC/-Openprovider en een lokale SMTP-server), adres, opzetten
 * (project, back-upsleutel, bucket op moto_server, server met user-data), status, opnieuw opzetten en verwijderen.
 */
public class AanbiederTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    private static String text(String method, String path) { return api.handle(method, path, "").body; }

    /** Nep-Scaleway: alleen met de juiste sleutel. */
    private static FakeApi.Handler auth(FakeApi.Handler h) {
        return c -> KEY.equals(c.headers.get("x-auth-token")) ? h.handle(c) : new FakeApi.Reply(401, "{\"message\":\"authentication is denied\"}", "application/json");
    }

    static final String KEY = "12345678-aaaa-bbbb-cccc-1234567890ab", ORG = "87654321-dddd-eeee-ffff-ba0987654321";

    public static void main(String[] args) {
        T.main("AanbiederTest", () -> {
            String moto = T.env("MOTO_URL");
            Map<String, Object> smtpInfo = Json.parseObject(new String(Files.readAllBytes(new File(T.env("SMTP_INFO")).toPath()), "UTF-8"));
            int smtpPort = Json.num(smtpInfo, "plain").intValue();
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) if ("scaleway".equals(Json.str(o, "id"))) for (Object r : Json.listAt(o, "regions")) Json.asMap(r).put("endpoint", moto);
            Catalog cat = new Catalog(Json.stringify(catJson));
            File dir = Files.createTempDirectory("aanbieder").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);

            final List<Map<String, Object>> servers = new ArrayList<>();
            final Map<String, String> userData = new java.util.HashMap<>();
            final boolean[] closing = {false};
            final String[] dienstSecret = {null};
            try (FakeApi f = new FakeApi()) {
                f.on("^GET /scw/account/v3/projects\\?organization_id=" + ORG + "&page_size=1$", auth(c -> new FakeApi.Reply(200, "{\"projects\":[]}", "application/json")));
                final List<Object> projects = new ArrayList<>();
                f.on("^GET /scw/account/v3/projects\\?.*name=eigen-cloud-dienst", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("projects", projects)), "application/json")));
                f.on("^POST /scw/account/v3/projects$", auth(c -> { Map<String, Object> p = Json.obj("id", "proj-1", "name", Json.str(c.json, "name")); projects.add(p); return new FakeApi.Reply(200, Json.stringify(p), "application/json"); }));
                f.on("^GET /scw/iam/v1alpha1/applications\\?", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("applications", Json.list())), "application/json")));
                f.on("^POST /scw/iam/v1alpha1/applications$", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("id", "app-1")), "application/json")));
                f.on("^GET /scw/iam/v1alpha1/policies\\?", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("policies", Json.list())), "application/json")));
                f.on("^POST /scw/iam/v1alpha1/policies$", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("id", "pol-1")), "application/json")));
                f.on("^POST /scw/iam/v1alpha1/api-keys$", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("access_key", "SCWBACKUP000000000001", "secret_key", "aaaaaaaa-bbbb-cccc-dddd-000000000001")), "application/json")));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/ips$", auth(c -> new FakeApi.Reply(201, Json.stringify(Json.obj("ip", Json.obj("id", "ip-" + servers.size(), "address", "192.0.2." + (10 + servers.size())))), "application/json")));
                f.on("^GET /scw/marketplace/v2/local-images\\?image_label=ubuntu_noble&zone=nl-ams-1", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("local_images", Json.list(Json.obj("id", "img-1")))), "application/json")));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/servers$", auth(c -> {
                    Map<String, Object> s = Json.obj("id", "srv-" + servers.size(), "project", Json.str(c.json, "project"), "commercial_type", Json.str(c.json, "commercial_type"));
                    servers.add(s);
                    return new FakeApi.Reply(201, Json.stringify(Json.obj("server", s)), "application/json");
                }));
                f.on("^PATCH /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/user_data/cloud-init$", auth(c -> { userData.put(c.path.split("/")[7], c.rawBody); return new FakeApi.Reply(204, "", "text/plain"); }));
                f.on("^DELETE /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/user_data/cloud-init$", auth(c -> { userData.remove(c.path.split("/")[7]); return new FakeApi.Reply(204, "", "text/plain"); }));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/action$", auth(c -> {
                    if ("terminate".equals(Json.str(c.json, "action"))) { String id = c.path.split("/")[7]; servers.removeIf(s -> id.equals(s.get("id"))); }
                    return new FakeApi.Reply(202, "{}", "application/json");
                }));
                f.on("^DELETE /scw/instance/v1/zones/nl-ams-1/ips/", auth(c -> new FakeApi.Reply(204, "", "text/plain")));
                f.on("^GET /mollie/methods$", c -> "Bearer test_mollie".equals(c.headers.get("authorization")) ? new FakeApi.Reply(200, "{\"count\":1}", "application/json") : new FakeApi.Reply(401, "{}", "application/json"));
                f.on("^GET /desec/domains/$", c -> "Token desec-dienst".equals(c.headers.get("authorization")) ? new FakeApi.Reply(200, "[]", "application/json") : new FakeApi.Reply(401, "{\"detail\":\"Invalid token.\"}", "application/json"));
                f.on("^POST /op/auth/login$", c -> "op-geheim".equals(Json.str(c.json, "password")) ? new FakeApi.Reply(200, "{\"code\":0,\"data\":{\"token\":\"t\"}}", "application/json") : new FakeApi.Reply(401, "{\"code\":196}", "application/json"));
                f.on("^GET /dienst/v1/status$", c -> new FakeApi.Reply(200, Json.stringify(Json.obj("version", "1.9.0.4", "uptime", 60, "lastBackupAt", 1760000000000L, "backup", "aan", "closing", closing[0])), "application/json"));
                f.on("^POST /dienst/v1/status/handover$", c -> {
                    if (!("Beheer " + Aanbieder.beheerToken(dienstSecret[0])).equals(c.headers.get("authorization"))) return new FakeApi.Reply(401, "{\"error\":\"Geen toegang\"}", "application/json");
                    closing[0] = true;
                    return new FakeApi.Reply(200, "{\"ok\":true,\"lastBackupAt\":1760000005000,\"backup\":true}", "application/json");
                });
                f.on("^GET /doh\\?name=dienst\\.vanes\\.nl&type=A$", c -> new FakeApi.Reply(200, Json.stringify(Json.obj("Status", 0, "Answer", servers.isEmpty() ? Json.list() : Json.list(Json.obj("type", 1, "data", "192.0.2." + (10 + servers.size() - 1))))), "application/json"));
                Endpoints.SCALEWAY = f.base() + "/scw";
                Endpoints.MOLLIE = f.base() + "/mollie";
                Endpoints.DESEC = f.base() + "/desec";
                Endpoints.OPENPROVIDER = f.base() + "/op";
                Endpoints.DOH = new String[] {f.base() + "/doh"};
                Aanbieder.reach = url -> f.base() + "/dienst";
                Aanbieder.plainSmtp = SmtpCheck.Security.NONE;
                Aanbieder.retryDelayMs = 10;

                // Een draaiende cloud met DNS die hij zelf beheert.
                call(200, "POST", "/api/setup/create", Json.obj("domain", "vanes.nl", "domainMode", "own", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                Map<String, Object> cfg = api.vault.config();
                Json.map(cfg, "console").put("done", true);
                Json.map(cfg, "console").put("mailRelay", "smtp://projectid:geheim@smtp.tem.scaleway.com:587");
                cfg.put("dns", Json.list(Json.obj("type", "desec", "name", "desec", "token", "cloud-dns-token", "zone", "vanes.nl")));
                api.vault.save();

                // 1. Bedrijf
                Map<String, Object> v = call(200, "GET", "/api/aanbieder", null);
                T.eq(false, v.get("started"), "not started");
                T.eq("https://dienst.vanes.nl", v.get("defaultUrl"), "default url");
                call(200, "POST", "/api/aanbieder/stap", Json.obj("step", "bedrijf"));
                call(400, "POST", "/api/aanbieder/stap", Json.obj("step", "klaar"));
                call(200, "POST", "/api/aanbieder/stap", Json.obj("step", "uit"));
                T.eq(false, call(200, "GET", "/api/aanbieder", null).get("started"), "stoppen vergeet alles");
                Map<String, Object> e = call(400, "POST", "/api/aanbieder/bedrijf", Json.obj("name", "Van Es", "kvk", "123", "email", "rene@elders.example"));
                T.check(Json.str(e, "error").contains("8 cijfers"), "kvk checked");
                Map<String, Object> r = call(200, "POST", "/api/aanbieder/bedrijf", Json.obj("name", "Rene's Diensten", "address", "Blaak 10\n\n3011 TA Rotterdam ", "kvk", "1234 5678", "vat", "nl0012.34567.b01", "email", "Rene@Elders.example"));
                T.eq("accounts", r.get("step"), "next step accounts");
                T.eq("{\"name\":\"Rene's Diensten\",\"address\":[\"Blaak 10\",\"3011 TA Rotterdam\"],\"kvk\":\"12345678\",\"vat\":\"NL001234567B01\",\"email\":\"rene@elders.example\"}",
                        Json.stringify(call(200, "GET", "/api/aanbieder", null).get("company")), "company stored");

                // 2. Accounts
                r = call(200, "POST", "/api/aanbieder/accounts", Json.obj("scalewaySecretKey", "99999999-aaaa-bbbb-cccc-1234567890ab", "scalewayOrgId", ORG, "mollieKey", "test_fout", "desecToken", "nee", "smtpUrl", "smtp://127.0.0.1:" + smtpPort));
                T.eq(false, r.get("ok"), "wrong keys");
                T.check(Json.str(r, "checks", 0, "detail").contains("accepteert deze sleutel niet"), "scaleway refused");
                T.check(Json.str(r, "checks", 1, "detail").contains("accepteert deze sleutel niet"), "mollie refused");
                T.check(Json.str(r, "checks", 2, "detail").contains("accepteert dit token niet"), "desec refused");
                T.eq(true, Json.path(r, "checks", 3, "ok"), "smtp works: " + Json.str(r, "checks", 3, "detail"));
                r = call(200, "POST", "/api/aanbieder/accounts", Json.obj("scalewaySecretKey", " \"" + KEY.toUpperCase() + "\" ", "mollieKey", "test_mollie", "desecToken", "desec-dienst", "openproviderUser", "rene", "openproviderPass", "fout"));
                T.eq(true, r.get("ok"), "all good: " + Json.stringify(r.get("checks")));
                T.eq(false, Json.path(r, "checks", 4, "ok"), "openprovider optional and failing");
                r = call(200, "POST", "/api/aanbieder/accounts", Json.obj("scalewaySecretKey", "••••••••90ab", "openproviderPass", "op-geheim"));
                T.eq(true, Json.path(r, "checks", 4, "ok"), "openprovider ok");
                T.eq("adres", r.get("step"), "next step adres");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("••••••••90ab", Json.str(v, "accounts", "scalewaySecretKey"), "masked key");
                T.eq("test", Json.str(v, "accounts", "mollieMode"), "mollie test mode");

                // 3. Adres
                e = call(400, "POST", "/api/aanbieder/adres", Json.obj("url", "http://dienst.vanes.nl/pad"));
                T.check(Json.str(e, "error").contains("alleen een adres"), "bad url");
                r = call(200, "POST", "/api/aanbieder/adres", Json.obj());
                T.eq("https://dienst.vanes.nl", r.get("url"), "default url used");
                T.eq("{\"host\":\"dienst.vanes.nl\",\"sub\":\"dienst\",\"managed\":true,\"value\":null}", Json.stringify(r.get("dns")), "dns managed by the cloud");

                // 4. Opzetten
                r = call(200, "POST", "/api/aanbieder/opzetten", null);
                for (Object st : Json.listAt(r, "steps")) T.eq(true, Json.path(st, "ok"), "step " + Json.str(st, "label"));
                T.eq(1, servers.size(), "one server");
                T.eq("proj-1", servers.get(0).get("project"), "server in the dienst project");
                T.eq("DEV1-S", servers.get(0).get("commercial_type"), "size");
                Map<String, Object> pol = Json.asMap(f.find("^POST /scw/iam/v1alpha1/policies$").json);
                T.eq("[{\"permission_set_names\":[\"ObjectStorageFullAccess\"],\"project_ids\":[\"proj-1\"]}]", Json.stringify(pol.get("rules")), "backup key only for storage in the project");
                String ud = userData.get("srv-0");
                T.check(ud != null && ud.contains("\nMOLLIE_API_KEY=test_mollie\n") && ud.contains("\nBROKER_PUBLIC_URL=https://dienst.vanes.nl\n") && ud.contains("\nBROKER_COMPANY_ADDRESS=Blaak 10\\n3011 TA Rotterdam\n"), "env file in user-data");
                java.util.regex.Matcher sm = java.util.regex.Pattern.compile("\nBROKER_SECRET=([0-9a-f]{64})\n").matcher(ud);
                T.check(sm.find(), "secret in user-data");
                dienstSecret[0] = sm.group(1);
                Map<String, Object> raw = api.vault.config();
                T.eq(Aanbieder.serverUserData(raw, Json.map(raw, "console", "aanbieder")), ud, "user-data as generated");
                for (String secret : new String[] {"test_mollie", "desec-dienst", KEY, "aaaaaaaa-bbbb-cccc-dddd-000000000001", dienstSecret[0], "op-geheim"}) {
                    T.check(!Json.stringify(r).contains(secret), "no secret in the reply");
                    T.check(!text("GET", "/api/aanbieder").contains(secret), "no secret in GET /api/aanbieder");
                    T.check(!text("GET", "/api/config").contains(secret), "no secret in GET /api/config");
                }
                T.eq("[{\"sub\":\"dienst\",\"type\":\"A\",\"value\":\"192.0.2.10\"},{\"sub\":\"dienst\",\"type\":\"AAAA\",\"value\":\"\"}]",
                        Json.str(Admin.consoleSettings(api.vault.config(), ""), "extra_dns"), "cloud publishes the A record");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("klaar", v.get("step"), "step klaar");
                T.check(Json.str(v, "backup", "bucket").startsWith("vanes-dienst-backup-"), "backup bucket");
                T.check(new S3Store(Json.obj("name", "b", "type", "s3", "purpose", "backup", "endpoint", moto, "region", "fr-par", "bucket", Json.str(v, "backup", "bucket"), "accessKey", "x", "secretKey", "y")).bucketExists(), "bucket exists on moto");

                // 5. Status
                r = call(200, "GET", "/api/aanbieder/status", null);
                T.eq(true, r.get("reachable"), "reachable");
                T.eq("1.9.0.4", r.get("version"), "version");
                T.eq("{\"host\":\"dienst.vanes.nl\",\"want\":\"192.0.2.10\",\"have\":[\"192.0.2.10\"],\"ok\":true}", Json.stringify(r.get("dns")), "dns ok");
                T.check(!userData.containsKey("srv-0"), "user-data removed at Scaleway");

                // Opnieuw opzetten: laatste back-up, nieuwe server, oude weg
                r = call(200, "POST", "/api/aanbieder/opzetten", null);
                T.eq(true, r.get("replaced"), "replaced");
                T.eq(true, closing[0], "handover called with the right token");
                for (int i = 0; i < 100 && servers.size() > 1; i++) Thread.sleep(20);
                T.eq(1, servers.size(), "old server gone");
                T.eq("srv-1", servers.get(0).get("id"), "new server stays");
                T.eq("192.0.2.11", Json.str(call(200, "GET", "/api/aanbieder", null), "server", "ipv4"), "new address");

                // Verwijderen
                e = call(400, "POST", "/api/aanbieder/verwijderen", Json.obj("confirm", "ja"));
                T.check(Json.str(e, "error").contains("Typ dienst.vanes.nl"), "confirmation needed");
                r = call(200, "POST", "/api/aanbieder/verwijderen", Json.obj("confirm", " Dienst.Vanes.nl "));
                T.eq(true, r.get("finalBackup"), "final backup");
                for (int i = 0; i < 100 && !servers.isEmpty(); i++) Thread.sleep(20);
                T.eq(0, servers.size(), "server removed");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq(true, v.get("removed"), "removed");
                T.eq("[{\"sub\":\"dienst\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"dienst\",\"type\":\"AAAA\",\"value\":\"\"}]",
                        Json.str(Admin.consoleSettings(api.vault.config(), ""), "extra_dns"), "record removed");
                T.eq("{\"reachable\":false,\"server\":false,\"removed\":true}", Json.stringify(call(200, "GET", "/api/aanbieder/status", null)), "status after removal");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
