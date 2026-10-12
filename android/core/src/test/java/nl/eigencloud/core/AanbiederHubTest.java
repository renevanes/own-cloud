package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Aanbieder worden zonder eigen cloud en "Je dienst" in de telefoonconsole (zelfde routes en JSON als
 * test/aanbieder-hub.test.ts): kluis alleen voor de Dienst, eigen DNS-koppeling via een nep-adapter (records zetten,
 * bijwerken bij een ander IP-adres, weghalen), de onderdelen met links naar /beheer, wat nog niet is toegepast,
 * kerncijfers, de hersteltest (back-up uit TS, golden.json), de herstelkopie, opnieuw beginnen geweigerd, een eigen
 * cloud erbij, en de diepe links naar het beheer.
 */
public class AanbiederHubTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    static final String KEY = "12345678-aaaa-bbbb-cccc-1234567890ab", ORG = "87654321-dddd-eeee-ffff-ba0987654321";
    static final String PASS = "vier losse woorden hier", DNS_TOKEN = "dns-geheim";

    private static FakeApi.Handler auth(FakeApi.Handler h) {
        return c -> KEY.equals(c.headers.get("x-auth-token")) ? h.handle(c) : new FakeApi.Reply(401, "{\"message\":\"authentication is denied\"}", "application/json");
    }

    private static FakeApi.Reply json(int status, Object body) { return new FakeApi.Reply(status, Json.stringify(body), "application/json"); }

    public static void main(String[] args) {
        T.main("AanbiederHubTest", () -> {
            String moto = T.env("MOTO_URL");
            Map<String, Object> smtpInfo = Json.parseObject(new String(Files.readAllBytes(new File(T.env("SMTP_INFO")).toPath()), "UTF-8"));
            int smtpPort = Json.num(smtpInfo, "plain").intValue();
            Map<String, Object> g = Json.parseObject(new String(Files.readAllBytes(new File(System.getProperty("build.dir"), "golden.json").toPath()), "UTF-8"));
            String catText;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { catText = Bytes.utf8(Bytes.readAll(in)); }
            Map<String, Object> catJson = Json.parseObject(catText);
            for (Object o : Json.listAt(catJson, "stores")) for (Object r : Json.listAt(o, "regions")) if (!Json.str(r, "endpoint").isEmpty()) Json.asMap(r).put("endpoint", moto);
            // Een DNS-aanbieder (nep): gegevens in de catalogus, code in de registry; records in het geheugen.
            Json.listAt(catJson, "dns").add(Json.obj("id", "testdns", "name", "Test-DNS", "owner", "Test (Nederland)", "home", "NL",
                    "fields", Json.list(Json.obj("key", "token", "label", "Token", "secret", true)), "keyHelp", "Maak een token bij Test-DNS.", "signupUrl", ""));
            Catalog cat = new Catalog(Json.stringify(catJson));
            final Map<String, List<String>> records = new LinkedHashMap<>();
            final List<String> writes = new ArrayList<>();
            final boolean[] dnsFail = {false};
            final List<String> zones = new ArrayList<>();
            Runnable unregister = Adapters.register(new Adapters.Adapter("testdns", null, false, new Adapters.Dns(
                    (fields, zone) -> {
                        if (!DNS_TOKEN.equals(fields.get("token"))) throw new IOException("Test-DNS accepteert dit token niet");
                        zones.add(zone);
                        return java.util.Arrays.asList("ns1.test-dns.example", "ns2.test-dns.example");
                    },
                    (name, fields, zone) -> new DnsProvider() {
                        @Override public String name() { return name; }

                        @Override public void setRecords(String sub, String type, List<String> values, int ttl) throws IOException {
                            if (dnsFail[0]) throw new IOException("Test-DNS is even weg");
                            T.eq(DNS_TOKEN, fields.get("token"), "token for setRecords");
                            String k = (sub.isEmpty() ? "" : sub + ".") + zone + " " + type;
                            writes.add(k + "=" + String.join(",", values));
                            if (values.isEmpty()) records.remove(k); else records.put(k, new ArrayList<>(values));
                        }
                    }, null)));
            File dir = Files.createTempDirectory("aanbieder-hub").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);

            final List<Map<String, Object>> servers = new ArrayList<>();
            final String[] dienstSecret = {null};
            try (FakeApi f = new FakeApi()) {
                final List<Object> projects = new ArrayList<>();
                f.on("^GET /scw/account/v3/projects\\?organization_id=" + ORG + "&page_size=1$", auth(c -> json(200, Json.obj("projects", Json.list()))));
                f.on("^GET /scw/account/v3/projects\\?.*name=eigen-cloud-dienst", auth(c -> json(200, Json.obj("projects", projects))));
                f.on("^POST /scw/account/v3/projects$", auth(c -> { Map<String, Object> p = Json.obj("id", "proj-1", "name", Json.str(c.json, "name")); projects.add(p); return json(200, p); }));
                f.on("^GET /scw/iam/v1alpha1/applications\\?", auth(c -> json(200, Json.obj("applications", Json.list()))));
                f.on("^POST /scw/iam/v1alpha1/applications$", auth(c -> json(200, Json.obj("id", "app-1"))));
                f.on("^GET /scw/iam/v1alpha1/policies\\?", auth(c -> json(200, Json.obj("policies", Json.list()))));
                f.on("^POST /scw/iam/v1alpha1/policies$", auth(c -> json(200, Json.obj("id", "pol-1"))));
                f.on("^POST /scw/iam/v1alpha1/api-keys$", auth(c -> json(200, Json.obj("access_key", "SCWBACKUP000000000001", "secret_key", "aaaaaaaa-bbbb-cccc-dddd-000000000001"))));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/ips$", auth(c -> json(201, Json.obj("ip", Json.obj("id", "ip-" + servers.size(), "address", "192.0.2." + (10 + servers.size()))))));
                f.on("^GET /scw/marketplace/v2/local-images\\?image_label=ubuntu_noble&zone=nl-ams-1", auth(c -> json(200, Json.obj("local_images", Json.list(Json.obj("id", "img-1"))))));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/servers$", auth(c -> {
                    Map<String, Object> s = Json.obj("id", "srv-" + servers.size(), "project", Json.str(c.json, "project"), "commercial_type", Json.str(c.json, "commercial_type"));
                    servers.add(s);
                    return json(201, Json.obj("server", s));
                }));
                f.on("^PATCH /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/user_data/cloud-init$", auth(c -> new FakeApi.Reply(204, "", "text/plain")));
                f.on("^DELETE /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/user_data/cloud-init$", auth(c -> new FakeApi.Reply(204, "", "text/plain")));
                f.on("^POST /scw/instance/v1/zones/nl-ams-1/servers/([^/]+)/action$", auth(c -> json(202, Json.obj())));
                f.on("^DELETE /scw/instance/v1/zones/nl-ams-1/ips/", auth(c -> new FakeApi.Reply(204, "", "text/plain")));
                f.on("^GET /scw/instance/v1/zones/[^/]+/products/servers", auth(c -> json(200, Json.obj("servers", Json.obj(
                        "DEV1-S", Json.obj("ncpus", 2, "ram", 2147483648L, "arch", "x86_64", "monthly_price", 6.42))))));
                f.on("^GET /mollie/methods$", c -> "Bearer test_mollie".equals(c.headers.get("authorization")) ? json(200, Json.obj("count", 1)) : json(401, Json.obj()));
                f.on("^GET /desec/domains/$", c -> "Token desec-dienst".equals(c.headers.get("authorization")) ? json(200, Json.list()) : json(401, Json.obj("detail", "Invalid token.")));
                f.on("^GET /dienst/v1/status$", c -> json(200, Json.obj("version", "1.9.0.4", "uptime", 60, "lastBackupAt", 1760000000000L, "backup", "aan", "closing", false)));
                FakeApi.Handler beheer = c -> ("Beheer " + Aanbieder.beheerToken(dienstSecret[0])).equals(c.headers.get("authorization")) ? null : json(401, Json.obj("error", "Geen toegang"));
                f.on("^GET /dienst/v1/status/overzicht$", c -> {
                    FakeApi.Reply no = beheer.handle(c);
                    return no != null ? no : json(200, Json.obj("version", "1.9.0.4", "klanten", 3, "actief", 2, "achterstanden", 0, "openHulpvragen", 1,
                            "omzetMaand", Json.obj("month", "2026-10", "net", "49.90", "count", 2), "bundels", 2));
                });
                f.on("^POST /dienst/v1/status/instellingen$", c -> {
                    FakeApi.Reply no = beheer.handle(c);
                    return no != null ? no : json(200, Json.obj("ok", true, "keys", new ArrayList<>(Json.asMap(Json.path(c.json, "env")).keySet()), "restart", true));
                });
                f.on("^POST /dienst/v1/status/handover$", c -> {
                    FakeApi.Reply no = beheer.handle(c);
                    return no != null ? no : json(200, Json.obj("ok", true, "lastBackupAt", 1760000005000L, "backup", true));
                });
                Endpoints.SCALEWAY = f.base() + "/scw";
                Endpoints.MOLLIE = f.base() + "/mollie";
                Endpoints.DESEC = f.base() + "/desec";
                Aanbieder.reach = url -> f.base() + "/dienst";
                Aanbieder.plainSmtp = SmtpCheck.Security.NONE;
                Aanbieder.retryDelayMs = 10;
                final String[] ip = {""};
                Aanbieder.resolver = host -> ip[0].isEmpty() ? new ArrayList<>() : new ArrayList<>(java.util.Collections.singletonList(ip[0]));

                // Kluis alleen voor de Dienst
                T.check(Json.str(call(400, "POST", "/api/setup/aanbieder", Json.obj("passphrase", "kort")), "error").contains("12"), "short passphrase refused");
                call(200, "POST", "/api/setup/aanbieder", Json.obj("passphrase", PASS));
                call(409, "POST", "/api/setup/aanbieder", Json.obj("passphrase", PASS));
                Map<String, Object> st = call(200, "GET", "/api/state", null);
                T.eq("[true,true,\"sleutel\",false,null]", Json.stringify(Json.list(st.get("vault"), st.get("unlocked"), st.get("step"), st.get("done"), st.get("domain"))), "state");
                Map<String, Object> cfg = call(200, "GET", "/api/config", null);
                T.eq(true, cfg.get("alleenDienst"), "alleenDienst");
                Map<String, Object> k = call(200, "GET", "/api/key", null);
                call(200, "POST", "/api/key/confirm", Json.obj("g3", Json.listAt(k, "groups").get(2), "g7", Json.listAt(k, "groups").get(6)));
                call(200, "POST", "/api/step", Json.obj("step", "dienst"));
                Map<String, Object> v = call(200, "GET", "/api/aanbieder", null);
                T.eq("{\"started\":false,\"step\":null,\"defaultUrl\":null,\"defaultEmail\":null}", Json.stringify(v), "not started, no defaults without cloud");

                // Stappen zonder cloud
                call(200, "POST", "/api/aanbieder/bedrijf", Json.obj("name", "ESAPE", "address", "Coolsingel 1\n3011 AD Rotterdam", "kvk", "12345678", "email", "support@esape.nl"));
                Map<String, Object> r = call(200, "POST", "/api/aanbieder/accounts", Json.obj("scalewaySecretKey", KEY, "scalewayOrgId", ORG, "mollieKey", "test_mollie", "desecToken", "desec-dienst"));
                T.eq(false, r.get("ok"), "no mail server without a cloud");
                T.check(Json.str(r, "checks", 3, "detail").contains("Vul een mailserver in"), "smtp needed");
                r = call(200, "POST", "/api/aanbieder/accounts", Json.obj("smtpUrl", "smtp://127.0.0.1:" + smtpPort));
                T.eq(true, r.get("ok"), "accounts ok: " + Json.stringify(r.get("checks")));
                call(400, "POST", "/api/aanbieder/adres", Json.obj());
                r = call(200, "POST", "/api/aanbieder/adres", Json.obj("url", "dienst.esape.nl"));
                T.eq("{\"host\":\"dienst.esape.nl\",\"sub\":null,\"managed\":false,\"value\":null,\"mode\":\"handmatig\",\"provider\":null,\"zone\":null}", Json.stringify(r.get("dns")), "manual without cloud");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("noreply@esape.nl", Json.str(v, "accounts", "mailFrom"), "mail from under the Dienst's domain");
                T.eq("[false,true,\"esape.nl\",null,null,null]", Json.stringify(Json.list(v.get("cloudDns"), v.get("alleenDienst"), v.get("defaultZone"), v.get("dnsKeuze"), v.get("dnsLink"), v.get("hub"))), "view without dienst");

                // Eigen DNS-koppeling
                T.check(Json.str(call(400, "POST", "/api/aanbieder/dns", Json.obj("provider", "cloud")), "error").startsWith("Je cloud kan dienst.esape.nl niet in de DNS zetten"), "no cloud dns");
                T.eq("Kies een DNS-aanbieder", Json.str(call(400, "POST", "/api/aanbieder/dns", Json.obj("provider", "nergens")), "error"), "unknown provider");
                T.eq("Vul in: Token", Json.str(call(400, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns")), "error"), "token needed");
                T.eq("dienst.esape.nl valt niet onder ander.nl", Json.str(call(400, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns", "zone", "ander.nl", "fields", Json.obj("token", DNS_TOKEN))), "error"), "zone must contain host");
                T.check(Json.str(call(400, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns", "fields", Json.obj("token", "fout"))), "error").startsWith("Test-DNS: Test-DNS accepteert dit token niet"), "wrong token");
                r = call(200, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns", "fields", Json.obj("token", " " + DNS_TOKEN + " ")));
                T.eq("{\"ok\":true,\"dns\":{\"host\":\"dienst.esape.nl\",\"sub\":\"dienst\",\"managed\":true,\"value\":null,\"mode\":\"eigen\",\"provider\":\"testdns\",\"zone\":\"esape.nl\"},"
                        + "\"nameservers\":[\"ns1.test-dns.example\",\"ns2.test-dns.example\"],\"synced\":null,\"detail\":null}", Json.stringify(r), "dns linked (same JSON as TS)");
                T.eq("[esape.nl]", zones.toString(), "zone connected");
                T.eq(0, writes.size(), "no records without a server");
                call(200, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns", "fields", Json.obj("token", "••••••••heim")));
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("{\"provider\":\"testdns\",\"zone\":\"esape.nl\",\"fields\":[\"token\"],\"records\":[],\"error\":null,\"at\":null,\"nameservers\":[\"ns1.test-dns.example\",\"ns2.test-dns.example\"]}",
                        Json.stringify(v.get("dnsLink")), "dns link view");
                T.eq("testdns", v.get("dnsKeuze"), "dns choice");
                T.check(!Json.stringify(v).contains(DNS_TOKEN) && !api.handle("GET", "/api/config", "").body.contains(DNS_TOKEN), "token never in a reply");

                // Opzetten: de console zet het record
                call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway", "region", "nl-ams-1"));
                call(200, "POST", "/api/aanbieder/backup", Json.obj("provider", "scaleway", "region", "fr-par"));
                r = call(200, "POST", "/api/aanbieder/opzetten", null);
                ip[0] = Json.str(r, "server", "ipv4");
                List<Object> steps = Json.listAt(r, "steps");
                T.eq("{\"label\":\"dienst.esape.nl wijst naar " + ip[0] + "\",\"ok\":true,\"detail\":\"De console zet dit record bij Test-DNS\"}", Json.stringify(steps.get(steps.size() - 1)), "dns step");
                T.eq("{dienst.esape.nl A=[" + ip[0] + "]}", records.toString(), "A record set");
                dienstSecret[0] = Json.str(api.vault.config(), "console", "aanbieder", "secret");
                v = call(200, "GET", "/api/aanbieder", null);
                T.check(Json.str(v, "backup", "bucket").startsWith("eigen-dienst-backup-"), "bucket name without cloud");
                T.eq("[{\"sub\":\"dienst\",\"type\":\"A\",\"value\":\"" + ip[0] + "\"}]", Json.stringify(Json.path(v, "dnsLink", "records")), "records in view");
                T.eq("[]", Json.str(Admin.consoleSettings(api.vault.config(), ""), "extra_dns"), "no cloud: no extra_dns");
                List<String> hub = new ArrayList<>();
                for (Object x : Json.listAt(v, "hub")) hub.add(Json.str(x, "id") + " " + Json.str(x, "waar") + " " + Json.str(x, "link"));
                T.eq("[overzicht console null, bedrijf console null, accounts console null, aanbod dienst https://dienst.esape.nl/beheer#/aanbod, huisstijl dienst https://dienst.esape.nl/beheer#/huisstijl, "
                        + "voorwaarden beide https://dienst.esape.nl/beheer#/voorwaarden, medewerkers dienst https://dienst.esape.nl/beheer#/medewerkers, klanten dienst https://dienst.esape.nl/beheer#/klanten, hulpvragen dienst https://dienst.esape.nl/beheer#/hulpvragen, "
                        + "berichten dienst https://dienst.esape.nl/beheer#/berichten, adressendienst beide null, lijst beide https://dienst.esape.nl/beheer#/lijst, server console null, "
                        + "kosten beide https://dienst.esape.nl/beheer#/kosten, updates console null]", hub.toString(), "hub sections and links");
                T.eq("[\"geen\",[]]", Json.stringify(Json.list(v.get("wijzigingen"), v.get("pending"))), "nothing pending");

                // Status met kerncijfers
                r = call(200, "GET", "/api/aanbieder/status", null);
                T.eq("{\"host\":\"dienst.esape.nl\",\"want\":\"" + ip[0] + "\",\"have\":[\"" + ip[0] + "\"],\"ok\":true,\"mode\":\"eigen\",\"error\":null}", Json.stringify(r.get("dns")), "status dns");
                T.eq(3L, Json.num(r, "overzicht", "klanten").longValue(), "overzicht from the Dienst");
                T.eq("49.90", Json.str(r, "overzicht", "omzetMaand", "net"), "omzet");

                // Nog niet toegepast, per onderdeel
                call(200, "POST", "/api/aanbieder/bedrijf", Json.obj("name", "ESAPE", "address", "Coolsingel 1\n3011 AD Rotterdam", "kvk", "12345678", "email", "support@esape.nl", "vatPercent", "9"));
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("[\"toepassen\",[\"bedrijf\"]]", Json.stringify(Json.list(v.get("wijzigingen"), v.get("pending"))), "bedrijf pending");
                call(200, "POST", "/api/aanbieder/accounts", Json.obj("mailFrom", "dienst@esape.nl"));
                T.eq("[\"bedrijf\",\"accounts\"]", Json.stringify(call(200, "GET", "/api/aanbieder", null).get("pending")), "accounts pending too");
                call(200, "POST", "/api/aanbieder/toepassen", null);
                T.eq("[]", Json.stringify(call(200, "GET", "/api/aanbieder", null).get("pending")), "applied");
                call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway", "region", "fr-par-1"));
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("[\"opnieuw\",[\"server\"]]", Json.stringify(Json.list(v.get("wijzigingen"), v.get("pending"))), "other place: new server");
                call(200, "POST", "/api/aanbieder/server", Json.obj("provider", "scaleway", "region", "nl-ams-1"));

                // Hersteltest met een back-up zoals de Dienst (TypeScript) hem maakt
                Map<String, Object> gb = Json.map(g, "dienstBackup");
                Map<String, Object> raw = api.vault.config();
                Map<String, Object> a = Json.map(raw, "console", "aanbieder");
                String realSecret = Json.str(a, "secret");
                a.put("secret", Json.str(gb, "secret"));
                Map<String, Object> bk = Json.map(a, "backup");
                new S3Store(Json.obj("name", "b", "type", "s3", "purpose", "backup", "endpoint", bk.get("endpoint"), "region", bk.get("region"), "bucket", bk.get("bucket"),
                        "accessKey", bk.get("accessKey"), "secretKey", bk.get("secretKey"))).put(Json.str(gb, "name"), Bytes.fromBase64(Json.str(gb, "enc")));
                r = call(200, "POST", "/api/aanbieder/hersteltest", null);
                T.eq(true, r.get("ok"), "hersteltest ok: " + r.get("detail"));
                T.eq("Terug te zetten: aanbieder.key, dienst.sqlite (database 3 KB)", r.get("detail"), "hersteltest detail");
                T.eq(1760000000000L, Json.num(r, "backupAt").longValue(), "backup time from the pack");
                T.eq(Json.stringify(r), Json.stringify(call(200, "GET", "/api/aanbieder", null).get("hersteltest")), "kept in the view");
                a.put("secret", "22".repeat(32));
                r = call(200, "POST", "/api/aanbieder/hersteltest", null);
                T.eq("De back-up is niet te openen met de sleutel van je Dienst", r.get("detail"), "wrong key");
                a.put("secret", realSecret);

                // Ander IP-adres: bijwerken, ook na een storing
                Json.map(a, "server").put("ipv4", "192.0.2.99");
                Json.map(a, "server").put("ipv6", "2001:db8::99");
                ip[0] = "192.0.2.99";
                dnsFail[0] = true;
                r = call(200, "GET", "/api/aanbieder/status", null);
                T.eq("Test-DNS: Test-DNS is even weg", Json.str(r, "dns", "error"), "dns error shown");
                dnsFail[0] = false;
                r = call(200, "GET", "/api/aanbieder/status", null);
                T.eq(null, Json.path(r, "dns", "error"), "dns error gone");
                T.eq("{dienst.esape.nl A=[192.0.2.99], dienst.esape.nl AAAA=[2001:db8::99]}", records.toString(), "records updated");
                int n = writes.size();
                call(200, "GET", "/api/aanbieder/status", null);
                T.eq(n, writes.size(), "nothing changed: nothing written");

                // Herstelkopie in de back-upbucket
                S3Store bucket = new S3Store(Json.obj("name", "b", "type", "s3", "purpose", "backup", "endpoint", bk.get("endpoint"), "region", bk.get("region"), "bucket", bk.get("bucket"),
                        "accessKey", bk.get("accessKey"), "secretKey", bk.get("secretKey")));
                byte[] copy = null;
                for (int i = 0; i < 100 && copy == null; i++) { copy = bucket.getBuffer("admin-config.enc"); if (copy == null) Thread.sleep(50); }
                T.check(copy != null, "admin copy in the backup bucket");
                Object opened = EigenCrypto.openJson(ClusterConfig.keysFor(raw).manifest, copy, "admin-config");
                T.eq("ESAPE", Json.str(opened, "console", "aanbieder", "company", "name"), "admin copy opens with the master key");

                // Opnieuw beginnen kan niet
                T.check(Json.str(call(409, "POST", "/api/setup/reset", Json.obj("cleanup", false)), "error").contains("Eigen Cloud Dienst"), "reset refused");

                // Andere keuze: oude records weg
                r = call(200, "POST", "/api/aanbieder/dns", Json.obj("provider", "handmatig"));
                T.eq(null, r.get("detail"), "removed cleanly");
                T.eq(0, records.size(), "records removed");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("[\"handmatig\",null,\"handmatig\"]", Json.stringify(Json.list(v.get("dnsKeuze"), v.get("dnsLink"), Json.path(v, "dns", "mode"))), "manual chosen");
                r = call(200, "POST", "/api/aanbieder/dns", Json.obj("provider", "testdns", "fields", Json.obj("token", DNS_TOKEN)));
                T.eq(true, r.get("synced"), "set again");
                T.eq("[dienst.esape.nl A, dienst.esape.nl AAAA]", records.keySet().toString(), "records back");

                // Verwijderen: records weg
                r = call(200, "POST", "/api/aanbieder/verwijderen", Json.obj("confirm", "dienst.esape.nl"));
                T.eq(true, r.get("dns"), "dns cleaned");
                T.eq(0, records.size(), "no records");
                v = call(200, "GET", "/api/aanbieder", null);
                T.eq("[]", Json.stringify(Json.path(v, "dnsLink", "records")), "no records in view");
                T.eq(null, Json.path(Json.listAt(v, "hub").get(6), "link"), "no server: no links");

                // Toch een eigen cloud
                call(400, "POST", "/api/setup/cloud", Json.obj("domain", "vanes.nl", "mailbox", "rene", "appPassword", "kort"));
                r = call(200, "POST", "/api/setup/cloud", Json.obj("domain", "vanes.nl", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example"));
                T.eq("regelen", r.get("step"), "next: where the cloud runs");
                cfg = call(200, "GET", "/api/config", null);
                T.eq("[false,\"vanes.nl\",\"rene@vanes.nl\",\"vanes\"]", Json.stringify(Json.list(cfg.get("alleenDienst"), cfg.get("domain"), cfg.get("mailFrom"), cfg.get("cluster"))), "cloud added");
                call(409, "POST", "/api/setup/cloud", Json.obj("domain", "x.nl", "mailbox", "a", "appPassword", "mijn-cloud-wachtwoord"));
            } finally {
                unregister.run();
            }

            // Cloud met DNS + eigen koppeling: de cloud haalt alleen namen buiten die zone weg (aanbiederDns in TS).
            Map<String, Object> c = Json.obj("domain", "vanes.nl", "console", Json.obj("aanbieder", Json.obj("url", "https://dienst.vanes.nl", "server", Json.obj("ipv4", "192.0.2.1"),
                    "dnsRemove", Json.list("oud"), "adressen", Json.obj("host", "adressen.vanes.nl"))));
            T.eq("[{\"sub\":\"oud\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"oud\",\"type\":\"AAAA\",\"value\":\"\"},{\"sub\":\"dienst\",\"type\":\"A\",\"value\":\"192.0.2.1\"},{\"sub\":\"dienst\",\"type\":\"AAAA\",\"value\":\"\"},"
                    + "{\"sub\":\"adressen\",\"type\":\"A\",\"value\":\"192.0.2.1\"},{\"sub\":\"adressen\",\"type\":\"AAAA\",\"value\":\"\"}]", Json.stringify(Admin.aanbiederDns(c)), "cloud publishes");
            Json.map(c, "console", "aanbieder").put("dns", Json.obj("zone", "vanes.nl"));
            T.eq("[]", Json.stringify(Admin.aanbiederDns(c)), "all under the own link");
            Json.map(c, "console", "aanbieder").put("dns", Json.obj("zone", "dienst.vanes.nl"));
            T.eq("[{\"sub\":\"oud\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"oud\",\"type\":\"AAAA\",\"value\":\"\"},{\"sub\":\"adressen\",\"type\":\"A\",\"value\":\"\"},{\"sub\":\"adressen\",\"type\":\"AAAA\",\"value\":\"\"}]",
                    Json.stringify(Admin.aanbiederDns(c)), "only names outside the zone");

            // Diepe links naar het beheer
            T.eq("klanten", BeheerLink.page("https://dienst.esape.nl/beheer#/klanten"), "page with slash");
            T.eq("klanten", BeheerLink.page("https://dienst.esape.nl/beheer#klanten"), "page without slash");
            T.eq("klant/ord_12", BeheerLink.page("https://x/beheer#/klant/ord_12"), "page with argument");
            T.eq("klanten?q=vanes", BeheerLink.page("https://x/beheer#/klanten?q=vanes"), "page with query");
            T.eq("", BeheerLink.page("https://x/beheer#/onbekend"), "unknown page");
            T.eq("", BeheerLink.page("https://x/beheer#/klanten\"><script>"), "nothing odd");
            T.eq("", BeheerLink.page("https://x/beheer"), "no page");
            T.eq("https://x/beheer/#/aanbod", BeheerLink.url("https://x", "aanbod"), "url with page");
            T.eq("https://x/beheer/", BeheerLink.url("https://x", ""), "url without page");
            T.eq("https://dienst.esape.nl/beheer#/klanten", Aanbieder.beheerLink("https://dienst.esape.nl", "klanten"), "beheerLink as in TS");
            T.eq("[esape.nl, esape.nl, b.esape.nl, null]", java.util.Arrays.asList(Aanbieder.defaultZone("dienst.esape.nl"), Aanbieder.defaultZone("esape.nl"), Aanbieder.defaultZone("a.b.esape.nl"), Aanbieder.defaultZone(null)).toString(), "defaultZone");
        });
    }
}
