package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Aanbieder worden vanuit de telefoonconsole (zelfde routes en JSON als src/console/aanbieder.ts): bedrijf, accounts
 * (live gecontroleerd tegen nep-Scaleway/-Mollie/-deSEC/-Openprovider en een lokale SMTP-server), adres, server en
 * back-ups (aanbieder en regio met prijzen), opzetten (project, back-upsleutel, bucket op moto_server, server met
 * user-data), status, opnieuw opzetten bij Hetzner (oude Scaleway-server weg) en verwijderen. Daarna: een oude kluis
 * (alleen Scaleway) en een Dienst bij Hetzner met back-ups in een gekoppelde opslag.
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
    static final String HZ = "hetzner-dienst-token";

    private static Map<String, Object> price(String loc, String eur) { return Json.obj("location", loc, "price_monthly", Json.obj("gross", eur)); }

    /** Nep-Hetzner Cloud (servers en formaten) onder /hz. */
    private static void hetzner(FakeApi f, final List<Map<String, Object>> hz) {
        FakeApi.Handler types = c -> new FakeApi.Reply(200, Json.stringify(Json.obj("server_types", Json.list(
                Json.obj("name", "cx11", "cores", 1, "memory", 1, "architecture", "x86", "prices", Json.list(price("fsn1", "3.0000"), price("nbg1", "3.0000"))),
                Json.obj("name", "cax11", "cores", 2, "memory", 4, "architecture", "arm", "prices", Json.list(price("fsn1", "3.9900"))),
                Json.obj("name", "cx23", "cores", 2, "memory", 4, "architecture", "x86", "prices", Json.list(price("fsn1", "4.5100"), price("nbg1", "4.5100"))),
                Json.obj("name", "cx33", "cores", 4, "memory", 8, "architecture", "x86", "prices", Json.list(price("fsn1", "7.0000"), price("hel1", "7.2000")))))), "application/json");
        f.on("^GET /hz/server_types", hzAuth(types));
        f.on("^GET /hz/servers\\?label_selector=", hzAuth(c -> {
            List<Object> out = new ArrayList<>();
            synchronized (hz) { for (Map<String, Object> x : hz) if (c.query.contains("cluster%3D" + Json.str(x, "labels", "cluster"))) out.add(x); }
            return new FakeApi.Reply(200, Json.stringify(Json.obj("servers", out, "meta", Json.obj("pagination", Json.obj("next_page", null)))), "application/json");
        }));
        f.on("^POST /hz/servers$", hzAuth(c -> {
            Map<String, Object> x = Json.copy(Json.asMap(c.json));
            synchronized (hz) {
                long id = 101 + hz.size() + hzCount[0]++;
                x.put("id", id);
                x.put("public_net", Json.obj("ipv4", Json.obj("ip", "198.51.100." + (id - 100)), "ipv6", Json.obj("ip", "2001:db8:" + id + "::/64")));
                hz.add(x);
            }
            return new FakeApi.Reply(201, Json.stringify(Json.obj("server", x)), "application/json");
        }));
        f.on("^DELETE /hz/servers/(\\d+)$", hzAuth(c -> {
            String id = c.path.substring(c.path.lastIndexOf('/') + 1);
            synchronized (hz) { if (!hz.removeIf(x -> id.equals(Json.jsString(x.get("id"))))) return new FakeApi.Reply(404, "{\"error\":{\"code\":\"not_found\"}}", "application/json"); }
            return new FakeApi.Reply(200, "{\"action\":{}}", "application/json");
        }));
    }

    private static final int[] hzCount = {0};

    private static FakeApi.Handler hzAuth(FakeApi.Handler h) {
        return c -> ("Bearer " + HZ).equals(c.headers.get("authorization")) ? h.handle(c) : new FakeApi.Reply(401, "{\"error\":{\"code\":\"unauthorized\",\"message\":\"unable to authenticate\"}}", "application/json");
    }

    private static String envOf(String ud, String k) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\n" + k + "=([^\n]*)\n").matcher(ud);
        return m.find() ? m.group(1) : null;
    }

    public static void main(String[] args) {
        T.main("AanbiederTest", () -> {
            String moto = T.env("MOTO_URL");
            Map<String, Object> smtpInfo = Json.parseObject(new String(Files.readAllBytes(new File(T.env("SMTP_INFO")).toPath()), "UTF-8"));
            int smtpPort = Json.num(smtpInfo, "plain").intValue();
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) for (Object r : Json.listAt(o, "regions")) if (!Json.str(r, "endpoint").isEmpty()) Json.asMap(r).put("endpoint", moto);
            Catalog cat = new Catalog(Json.stringify(catJson));
            File dir = Files.createTempDirectory("aanbieder").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);

            final List<Map<String, Object>> servers = new ArrayList<>();
            final List<Map<String, Object>> hz = new ArrayList<>();
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
                f.on("^GET /scw/instance/v1/zones/[^/]+/products/servers", auth(c -> new FakeApi.Reply(200, Json.stringify(Json.obj("servers", Json.obj(
                        "DEV1-S", Json.obj("ncpus", 2, "ram", 2147483648L, "arch", "x86_64", "monthly_price", 6.42),
                        "STARDUST1-S", Json.obj("ncpus", 1, "ram", 1073741824L, "arch", "x86_64", "monthly_price", 0.5)))), "application/json")));
                hetzner(f, hz);
                f.on("^GET /mollie/methods$", c -> "Bearer test_mollie".equals(c.headers.get("authorization")) ? new FakeApi.Reply(200, "{\"count\":1}", "application/json") : new FakeApi.Reply(401, "{}", "application/json"));
                f.on("^GET /desec/domains/$", c -> "Token desec-dienst".equals(c.headers.get("authorization")) ? new FakeApi.Reply(200, "[]", "application/json") : new FakeApi.Reply(401, "{\"detail\":\"Invalid token.\"}", "application/json"));
                f.on("^POST /op/auth/login$", c -> "op-geheim".equals(Json.str(c.json, "password")) ? new FakeApi.Reply(200, "{\"code\":0,\"data\":{\"token\":\"t\"}}", "application/json") : new FakeApi.Reply(401, "{\"code\":196}", "application/json"));
                f.on("^GET /dienst/v1/status$", c -> new FakeApi.Reply(200, Json.stringify(Json.obj("version", "1.9.0.4", "uptime", 60, "lastBackupAt", 1760000000000L, "backup", "aan", "closing", closing[0])), "application/json"));
                f.on("^POST /dienst/v1/status/handover$", c -> {
                    if (!("Beheer " + Aanbieder.beheerToken(dienstSecret[0])).equals(c.headers.get("authorization"))) return new FakeApi.Reply(401, "{\"error\":\"Geen toegang\"}", "application/json");
                    closing[0] = true;
                    return new FakeApi.Reply(200, "{\"ok\":true,\"lastBackupAt\":1760000005000,\"backup\":true}", "application/json");
                });
                // Instellingen toepassen zonder nieuwe server, en de gratis-adressendienst (deSEC-account van de gedeelde zone).
                final Object[] instellingen = {null};
                f.on("^POST /dienst/v1/status/instellingen$", c -> {
                    if (!("Beheer " + Aanbieder.beheerToken(dienstSecret[0])).equals(c.headers.get("authorization"))) return new FakeApi.Reply(401, "{\"error\":\"Geen toegang\"}", "application/json");
                    instellingen[0] = c.json;
                    return new FakeApi.Reply(200, Json.stringify(Json.obj("ok", true, "keys", new ArrayList<>(Json.asMap(Json.path(c.json, "env")).keySet()), "restart", true)), "application/json");
                });
                f.on("^GET /desec/domains/eigencloud\\.nl/$", c -> "Token desec-centraal".equals(c.headers.get("authorization")) || "Token zonder-recht".equals(c.headers.get("authorization"))
                        ? new FakeApi.Reply(200, "{\"name\":\"eigencloud.nl\"}", "application/json") : new FakeApi.Reply(404, "{\"detail\":\"Not found.\"}", "application/json"));
                f.on("^GET /desec/auth/tokens/$", c -> "Token desec-centraal".equals(c.headers.get("authorization")) ? new FakeApi.Reply(200, "[]", "application/json")
                        : new FakeApi.Reply(403, "{\"detail\":\"You do not have permission to perform this action.\"}", "application/json"));
                f.on("^GET /doh\\?name=dienst\\.vanes\\.nl&type=A$", c -> new FakeApi.Reply(200, Json.stringify(Json.obj("Status", 0, "Answer", servers.isEmpty() ? Json.list() : Json.list(Json.obj("type", 1, "data", "192.0.2." + (10 + servers.size() - 1))))), "application/json"));
                Endpoints.SCALEWAY = f.base() + "/scw";
                Endpoints.HETZNER = f.base() + "/hz";
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
                T.eq("server", r.get("step"), "next step server");

                // 4. Server en back-ups
                T.check(Json.str(call(400, "POST", "/api/aanbieder/server", Json.obj("provider", "hetzner")), "error").contains("Vul in: API-token"), "token needed");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/server", Json.obj("provider", "hetzner", "fields", Json.obj("token", "fout"))), "error").contains("Inloggen bij Hetzner Cloud lukt niet"), "wrong token");
                r = call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "hetzner", "fields", Json.obj("token", " " + HZ + " ")));
                T.eq("[{\"region\":\"fsn1\",\"label\":\"Falkenstein\",\"city\":\"Falkenstein\",\"country\":\"DE\",\"size\":\"cx23\",\"sizeLabel\":\"2 vCPU, 4 GB\",\"monthly\":4.51},"
                        + "{\"region\":\"nbg1\",\"label\":\"Neurenberg\",\"city\":\"Neurenberg\",\"country\":\"DE\",\"size\":\"cx23\",\"sizeLabel\":\"2 vCPU, 4 GB\",\"monthly\":4.51},"
                        + "{\"region\":\"hel1\",\"label\":\"Helsinki\",\"city\":\"Helsinki\",\"country\":\"FI\",\"size\":\"cx33\",\"sizeLabel\":\"4 vCPU, 8 GB\",\"monthly\":7.2}]",
                        Json.stringify(r.get("regions")), "smallest suitable size per region with price");
                T.eq(null, f.find("^POST /hz/"), "only looked");
                r = call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway"));
                for (Object x : Json.listAt(r, "regions")) T.eq("DEV1-S 6.42", Json.str(x, "size") + " " + Json.stringify(Json.path(x, "monthly")), "scaleway size " + Json.str(x, "region"));
                call(400, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway", "region", "nl-ams-9"));
                r = call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway", "region", "nl-ams-1"));
                T.eq("{\"provider\":\"scaleway\",\"name\":\"Scaleway\",\"region\":\"nl-ams-1\",\"regionLabel\":\"Amsterdam 1\",\"city\":\"Amsterdam\",\"country\":\"NL\",\"size\":\"DEV1-S\",\"monthly\":6.42}",
                        Json.stringify(r.get("hosting")), "hosting chosen");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/opzetten", null), "error").contains("Kies eerst waar de back-ups komen"), "backup needed");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/backup", Json.obj("provider", "hetzner", "region", "fsn1")), "error").contains("toegangssleutel en geheime sleutel"), "keys needed");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/backup", Json.obj("store", "bestaat-niet")), "error").contains("gekoppelde opslag"), "unknown store");
                r = call(200, "POST", "/api/aanbieder/backup", Json.obj("provider", "scaleway", "region", "fr-par"));
                T.eq("{\"provider\":\"scaleway\",\"name\":\"Scaleway Object Storage\",\"region\":\"fr-par\",\"regionLabel\":\"Parijs\",\"country\":\"FR\",\"bucket\":null,\"auto\":true}",
                        Json.stringify(r.get("backup")), "backup at Scaleway, key made by the console");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq(true, Json.path(v, "ready", "server"), "ready server");
                T.eq("[\"scaleway\",\"hetzner\"]", Json.stringify(v.get("hostingKeys")), "hosting keys");
                T.check(!Json.stringify(v).contains(HZ), "no hetzner token in the view");
                call(200, "POST", "/api/aanbieder/stap", Json.obj("step", "opzetten"));

                // 5. Opzetten
                r = call(200, "POST", "/api/aanbieder/opzetten", null);
                for (Object st : Json.listAt(r, "steps")) T.eq(true, Json.path(st, "ok"), "step " + Json.str(st, "label"));
                T.eq("Back-upopslag bij Scaleway Object Storage (Parijs), 30 dagen niet te wissen", Json.str(r, "steps", 2, "label"), "backup step label");
                T.eq("Server bij Scaleway in Amsterdam (DEV1-S)", Json.str(r, "steps", 3, "label"), "server step label");
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
                for (String secret : new String[] {"test_mollie", "desec-dienst", KEY, "aaaaaaaa-bbbb-cccc-dddd-000000000001", dienstSecret[0], "op-geheim", HZ}) {
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
                T.eq("scaleway", Json.str(v, "server", "provider"), "server provider");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/backup", Json.obj("provider", "hetzner", "region", "fsn1", "accessKey", "a", "secretKey", "b")), "error").contains("staan al in vanes-dienst-backup-"), "backup place fixed");

                // 5. Status
                r = call(200, "GET", "/api/aanbieder/status", null);
                T.eq(true, r.get("reachable"), "reachable");
                T.eq("1.9.0.4", r.get("version"), "version");
                T.eq("{\"host\":\"dienst.vanes.nl\",\"want\":\"192.0.2.10\",\"have\":[\"192.0.2.10\"],\"ok\":true}", Json.stringify(r.get("dns")), "dns ok");
                T.check(!userData.containsKey("srv-0"), "user-data removed at Scaleway");

                // Instellingen wijzigen zonder nieuwe server (toepassen)
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("geen", v.get("wijzigingen"), "alles toegepast na opzetten");
                call(200, "POST", "/api/aanbieder/bedrijf", Json.obj("name", "Rene's Diensten", "address", "Blaak 10\n3011 TA Rotterdam", "kvk", "12345678", "vat", "NL001234567B01", "email", "rene@elders.example", "vatPercent", "9", "enforce", true));
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("toepassen", v.get("wijzigingen"), "btw gewijzigd: toepassen");
                r = call(200, "POST", "/api/aanbieder/toepassen", null);
                T.eq(true, r.get("restart"), "dienst start opnieuw");
                T.eq("9", Json.str(instellingen[0], "env", "BROKER_VAT_PERCENT"), "btw meegestuurd");
                T.eq("1", Json.str(instellingen[0], "env", "BROKER_ENFORCE"), "bewaker meegestuurd");
                T.eq(null, Json.path(instellingen[0], "env", "BROKER_SECRET"), "geen BROKER_SECRET");
                T.eq(null, Json.path(instellingen[0], "env", "BROKER_PUBLIC_URL"), "adres hoort bij de server");
                T.check(Json.num(instellingen[0], "at").longValue() > Json.num(api.vault.config(), "console", "aanbieder", "envAt").longValue(), "nieuwer dan dienst.env");
                T.eq("geen", call(200, "GET", "/api/aanbieder", null).get("wijzigingen"), "toegepast");

                // Gratis-adressendienst op dezelfde server
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("adressen.vanes.nl", v.get("defaultAdressenHost"), "standaardhost");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/adressen", Json.obj("zone", "geen zone")), "error").contains("gedeelde zone"), "zone nodig");
                r = call(200, "POST", "/api/aanbieder/adressen", Json.obj("zone", "EigenCloud.nl.", "desecToken", "zonder-recht"));
                T.eq(false, r.get("ok"), "token zonder tokenbeheer");
                T.check(Json.str(r, "checks", 1, "detail").contains("geen tokens beheren"), "uitleg perm_manage_tokens");
                T.eq(null, r.get("adressen"), "niet bewaard");
                r = call(200, "POST", "/api/aanbieder/adressen", Json.obj("zone", "eigencloud.nl", "desecToken", "desec-centraal"));
                T.eq(true, r.get("ok"), "adressendienst gecontroleerd: " + Json.stringify(r.get("checks")));
                T.eq("{\"zone\":\"eigencloud.nl\",\"desecToken\":\"••••••••raal\",\"host\":\"adressen.vanes.nl\",\"url\":\"https://adressen.vanes.nl\"}", Json.stringify(r.get("adressen")), "adressendienst bewaard");
                T.eq("opnieuw", call(200, "GET", "/api/aanbieder", null).get("wijzigingen"), "adressendienst vraagt een nieuwe server");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/toepassen", null), "error").contains("nieuwe server"), "toepassen weigert");

                // Opnieuw opzetten bij Hetzner: laatste back-up, nieuwe server, oude weg bij Scaleway
                r = call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "hetzner", "region", "fsn1"));
                T.eq(true, r.get("pending"), "pending until redeploy");
                r = call(200, "POST", "/api/aanbieder/opzetten", null);
                T.eq(true, r.get("replaced"), "replaced");
                T.eq(true, closing[0], "handover called with the right token");
                boolean server = false, project = false;
                for (Object st : Json.listAt(r, "steps")) {
                    server |= "Server bij Hetzner Cloud in Falkenstein (cx23)".equals(Json.str(st, "label"));
                    project |= Json.str(st, "label").startsWith("Project") || Json.str(st, "label").startsWith("Sleutel voor");
                }
                T.check(server && !project, "server at Hetzner, no new project or key: " + Json.stringify(r.get("steps")));
                for (int i = 0; i < 100 && !servers.isEmpty(); i++) Thread.sleep(20);
                T.eq(0, servers.size(), "old Scaleway server gone");
                T.eq(1, hz.size(), "one Hetzner server");
                T.eq("fsn1 cx23 eigen-cloud-dienst", Json.str(hz.get(0), "location") + " " + Json.str(hz.get(0), "server_type") + " " + Json.str(hz.get(0), "labels", "cluster"), "Hetzner server");
                T.eq(KEY, envOf(Json.str(hz.get(0), "user_data"), "SCW_SECRET_KEY"), "Scaleway key stays for customer clouds");
                T.eq(Json.str(v, "backup", "bucket"), envOf(Json.str(hz.get(0), "user_data"), "BROKER_BACKUP_BUCKET"), "same backups (still at Scaleway)");
                String hud = Json.str(hz.get(0), "user_data");
                T.eq(Aanbieder.ADRESSEN_LOCAL, envOf(hud, "BROKER_ADRES_URL"), "Dienst gebruikt de adressendienst op dezelfde server");
                T.eq("https://adressen.vanes.nl", envOf(hud, "BROKER_ADRES_PUBLIEK"), "openbaar adres van de adressendienst");
                T.check(hud.contains("\nadressen.vanes.nl {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:4200\n}\n"), "Caddy voor de adressendienst");
                T.check(hud.contains("\nADRES_ZONE=eigencloud.nl\nADRES_DESEC_TOKEN=desec-centraal\n"), "adressen.env");
                T.check(hud.contains("    command: [\"node\", \"dist/adressen/main.js\"]\n"), "adressendienst in docker-compose");
                T.check(hud.length() < 32 * 1024, "user-data past bij Hetzner (32 KiB): " + hud.length());
                T.eq("9", envOf(hud, "BROKER_VAT_PERCENT"), "btw in dienst.env");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("hetzner 198.51.100.1 2001:db8:101::1", Json.str(v, "server", "provider") + " " + Json.str(v, "server", "ipv4") + " " + Json.str(v, "server", "ipv6"), "new address");

                // Verwijderen
                e = call(400, "POST", "/api/aanbieder/verwijderen", Json.obj("confirm", "ja"));
                T.check(Json.str(e, "error").contains("Typ dienst.vanes.nl"), "confirmation needed");
                r = call(200, "POST", "/api/aanbieder/verwijderen", Json.obj("confirm", " Dienst.Vanes.nl "));
                T.eq(true, r.get("finalBackup"), "final backup");
                for (int i = 0; i < 100 && !hz.isEmpty(); i++) Thread.sleep(20);
                T.eq(0, hz.size(), "server removed at Hetzner");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq(true, v.get("removed"), "removed");
                T.eq("[{\"sub\":\"dienst\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"dienst\",\"type\":\"AAAA\",\"value\":\"\"},{\"sub\":\"adressen\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"adressen\",\"type\":\"AAAA\",\"value\":\"\"}]",
                        Json.str(Admin.consoleSettings(api.vault.config(), ""), "extra_dns"), "records removed (Dienst en adressendienst)");
                T.eq("{\"reachable\":false,\"server\":false,\"removed\":true}", Json.stringify(call(200, "GET", "/api/aanbieder/status", null)), "status after removal");

                // Een oude kluis (alleen Scaleway): bijgewerkt bij het lezen, oude server weg via de Provider van Scaleway.
                Aanbieder.Offers offers = Aanbieder.offers(cat);
                Aanbieder.Deps deps = new Aanbieder.Deps() {
                    @Override public List<Map<String, Object>> serverOffers() { return offers.serverOffers(); }

                    @Override public List<Map<String, Object>> storeOffers() { return offers.storeOffers(); }

                    @Override public void save() {}
                };
                Map<String, Object> base = Json.obj("url", "https://dienst.vanes.nl", "company", Json.obj("name", "Van Es", "address", Json.list("Blaak 10"), "kvk", "", "vat", "", "email", "rene@elders.example"),
                        "accounts", Json.obj("scalewaySecretKey", KEY, "scalewayOrgId", ORG, "mollieKey", "test_x", "desecToken", "d"),
                        "checked", Json.obj("scaleway", true, "mollie", true, "desec", true, "smtp", true), "secret", "ab".repeat(32));
                servers.add(Json.obj("id", "srv-oud"));
                Map<String, Object> legacy = Json.copy(base);
                legacy.putAll(Json.obj("step", "klaar", "projectId", "proj-1",
                        "backup", Json.obj("endpoint", moto, "region", "fr-par", "bucket", "vanes-dienst-backup-oud", "accessKey", "SCWAK", "secretKey", "s", "applicationId", "app-1", "policyId", "pol-1"),
                        "server", Json.obj("provider", "scaleway", "region", "nl-ams-1", "size", "DEV1-S", "serverId", "nl-ams-1/srv-nu/ip-nu", "ipv4", "192.0.2.10", "createdAt", 1),
                        "retired", Json.list("nl-ams-1/srv-oud/ip-oud")));
                Map<String, Object> c1 = Json.obj("cluster", "vanes", "domain", "vanes.nl", "providers", Json.obj(), "stores", Json.list(), "dns", Json.list(), "image", Json.obj(), "console", Json.obj("done", true, "aanbieder", legacy));
                v = Aanbieder.view(c1, offers);
                T.eq("{\"provider\":\"scaleway\",\"name\":\"Scaleway\",\"region\":\"nl-ams-1\",\"regionLabel\":\"Amsterdam 1\",\"city\":\"Amsterdam\",\"country\":\"NL\",\"size\":\"DEV1-S\",\"monthly\":null}", Json.stringify(v.get("hosting")), "legacy hosting");
                T.eq("[{\"provider\":\"scaleway\",\"serverId\":\"nl-ams-1/srv-oud/ip-oud\"}]", Json.stringify(legacy.get("retired")), "legacy retired migrated");
                Aanbieder.cleanupRetired(c1, deps);
                T.eq(null, legacy.get("retired"), "legacy retired cleaned");
                T.check(servers.stream().noneMatch(x -> "srv-oud".equals(x.get("id"))), "old Scaleway server destroyed");

                // Nieuw: server bij Hetzner met de sleutel van de cloud, back-ups in een gekoppelde opslag (eigen endpoint).
                Map<String, Object> st2 = Json.copy(base);
                st2.put("step", "server");
                Map<String, Object> c2 = Json.obj("cluster", "vanes", "domain", "vanes.nl", "providers", Json.obj("hetzner", Json.obj("token", HZ)), "dns", Json.list(), "image", Json.obj(),
                        "stores", Json.list(Json.obj("name", "eigen-backup", "type", "s3", "purpose", "backup", "country", "DE", "endpoint", moto, "region", "de-fra-1", "bucket", "vanes-backup-x", "accessKey", "EIGENAK", "secretKey", "eigen-geheim")),
                        "console", Json.obj("done", true, "aanbieder", st2));
                Aanbieder.Offers real = Aanbieder.offers(new Catalog(catText));
                Aanbieder.Deps deps2 = new Aanbieder.Deps() {
                    @Override public List<Map<String, Object>> serverOffers() { return real.serverOffers(); }

                    @Override public List<Map<String, Object>> storeOffers() { return real.storeOffers(); }

                    @Override public void save() {}
                };
                r = Aanbieder.saveServer(c2, Json.obj("provider", "hetzner", "region", "nbg1"), deps2);
                T.eq("{\"provider\":\"hetzner\",\"name\":\"Hetzner Cloud\",\"region\":\"nbg1\",\"regionLabel\":\"Neurenberg\",\"city\":\"Neurenberg\",\"country\":\"DE\",\"size\":\"cx23\",\"monthly\":4.51}", Json.stringify(r.get("hosting")), "hosting at Hetzner");
                T.eq("{\"hetzner\":{\"token\":\"" + HZ + "\"}}", Json.stringify(st2.get("keys")), "cloud key copied");
                r = Aanbieder.saveBackup(c2, Json.obj("store", "eigen-backup"), deps2);
                String motoHost = new java.net.URI(moto).getHost();
                T.eq("{\"provider\":\"custom\",\"name\":\"Eigen opslag (NAS, MinIO, Garage)\",\"region\":\"de-fra-1\",\"regionLabel\":\"" + motoHost + "\",\"country\":\"DE\",\"bucket\":null,\"auto\":false}", Json.stringify(r.get("backup")), "backup in a linked store");
                int callsBefore = f.calls.size();
                r = Aanbieder.opzetten(c2, deps2);
                T.eq("Back-upopslag bij Eigen opslag (NAS, MinIO, Garage) (" + motoHost + "), 30 dagen niet te wissen", Json.str(r, "steps", 0, "label"), "first step: bucket");
                T.eq("Server bij Hetzner Cloud in Neurenberg (cx23)", Json.str(r, "steps", 1, "label"), "server step");
                boolean scw = false;
                synchronized (f.calls) { for (FakeApi.Call x : f.calls.subList(callsBefore, f.calls.size())) scw |= x.path.startsWith("/scw/"); }
                T.check(!scw, "nothing at Scaleway for server or backups");
                T.eq(null, st2.get("projectId"), "no Scaleway project");
                Map<String, Object> hsrv = hz.get(hz.size() - 1);
                String ud2 = Json.str(hsrv, "user_data");
                T.eq("nbg1 cx23", Json.str(hsrv, "location") + " " + Json.str(hsrv, "server_type"), "Hetzner server nbg1");
                T.eq(moto + " de-fra-1 EIGENAK eigen-geheim", envOf(ud2, "BROKER_BACKUP_ENDPOINT") + " " + envOf(ud2, "BROKER_BACKUP_REGION") + " " + envOf(ud2, "BROKER_BACKUP_ACCESS_KEY") + " " + envOf(ud2, "BROKER_BACKUP_SECRET_KEY"), "backup env");
                String bucket2 = envOf(ud2, "BROKER_BACKUP_BUCKET");
                T.check(bucket2.startsWith("vanes-dienst-backup-"), "own bucket");
                T.check(new S3Store(Json.obj("name", "b", "type", "s3", "purpose", "backup", "endpoint", moto, "region", "de-fra-1", "bucket", bucket2, "accessKey", "x", "secretKey", "y")).bucketExists(), "bucket on moto");
                v = Aanbieder.view(c2, deps2);
                T.check(!Json.stringify(v).contains(HZ) && !Json.stringify(v).contains("eigen-geheim"), "no secrets in the view");
                Aanbieder.verwijderen(c2, Json.obj("confirm", "dienst.vanes.nl"), deps2);
                for (int i = 0; i < 100 && !hz.isEmpty(); i++) Thread.sleep(20);
                T.eq(0, hz.size(), "server removed at Hetzner");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
