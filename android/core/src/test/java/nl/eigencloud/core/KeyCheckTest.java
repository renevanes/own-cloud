package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/**
 * "Sleutels controleren" (port of test/key-check.test.ts): every provider against the fake answers in
 * test/fixtures/key-checks.json (the SAME file the TypeScript test uses, so the console and the app show exactly the
 * same list), storage on moto_server (MOTO_URL), and the console route POST /api/check. Only GET/HEAD allowed.
 */
public class KeyCheckTest {
    @SuppressWarnings("unchecked")
    static Map<String, Object> call(ConsoleApi api, int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    /** Routes from the fixture: "METHOD path?query" (exact) or "METHOD path"; unknown = 500. */
    static void serve(FakeApi api, Map<String, Object> routes) {
        api.reset();
        api.on(".*", c -> {
            Object hit = routes.get(c.method + " " + c.path + (c.query != null ? "?" + c.query : ""));
            if (hit == null) hit = routes.get(c.method + " " + c.path);
            if (hit == null) return new FakeApi.Reply(500, "niet nagebootst", "text/plain");
            int st = Json.num(hit, "status").intValue();
            if (Json.path(hit, "text") != null) return new FakeApi.Reply(st, Json.str(hit, "text"), "text/plain");
            return new FakeApi.Reply(st, Json.stringify(Json.path(hit, "json")), "application/json");
        });
    }

    static boolean onlyReads(FakeApi api) {
        synchronized (api.calls) {
            for (FakeApi.Call c : api.calls) if (!"GET".equals(c.method) && !"HEAD".equals(c.method)) return false;
        }
        return true;
    }

    public static void main(String[] args) {
        T.main("KeyCheckTest", () -> {
            String moto = T.env("MOTO_URL");
            if (moto == null) throw new IllegalStateException("MOTO_URL niet gezet");
            Map<String, Object> fixture = Json.parseObject(new String(Files.readAllBytes(new File("test/fixtures/key-checks.json").toPath()), "UTF-8"));
            List<Object> scenarios = Json.listAt(fixture, "scenarios");
            T.check(scenarios.size() >= 20, "fixture loaded");
            try (FakeApi api = new FakeApi()) {
                // Base URLs such that the paths are the same as on the real hosts (and in the TS test).
                Endpoints.HETZNER = api.base() + "/v1";
                Endpoints.SCALEWAY = api.base();
                Endpoints.UPCLOUD = api.base() + "/1.3";
                Endpoints.DESEC = api.base() + "/api/v1";
                Endpoints.EXOSCALE = api.base() + "/v2";
                Endpoints.OVH = api.base() + "/1.0";

                // ── Per provider: exactly the same list as TypeScript ──
                for (Object sc : scenarios) {
                    String name = Json.str(sc, "name");
                    serve(api, Json.map(sc, "routes"));
                    Adapters.Adapter a = Adapters.get(Json.str(sc, "adapter"));
                    Map<String, Object> fields = Json.copy(Json.map(sc, "fields"));
                    List<Object> got = "servers".equals(Json.str(sc, "kind")) ? a.servers.check.check(fields)
                            : a.dns.check.check(fields, Json.str(sc, "zone") == null ? "" : Json.str(sc, "zone"));
                    T.eq(Json.stringify(Json.path(sc, "expect")), Json.stringify(got), name);
                    T.check(onlyReads(api), name + ": only reading requests");
                    T.check(!api.calls.toString().contains("undefined"), name + ": " + api.calls);
                }
                for (String id : new String[] {"scaleway", "hetzner", "upcloud", "exoscale", "ovh"}) T.check(Adapters.get(id).servers.check != null, id + " has a servers check");
                for (String id : new String[] {"desec", "scaleway", "hetzner", "exoscale", "ovh"}) T.check(Adapters.get(id).dns.check != null, id + " has a DNS check");

                // ── OVH rules with * ──
                List<Object> rules = Json.list(Json.obj("method", "GET", "path", "/cloud/project/*"), Json.obj("method", "POST", "path", "/cloud/project/*/instance"));
                T.check(KeyCheck.ruleCovers(rules, "GET", "/cloud/project/p/instance"), "GET * covers");
                T.check(KeyCheck.ruleCovers(rules, "POST", "/cloud/project/p/instance"), "POST */instance covers");
                T.check(!KeyCheck.ruleCovers(rules, "POST", "/cloud/project/p/instance/x/reboot"), "POST */instance does not cover deeper");
                T.check(!KeyCheck.ruleCovers(rules, "DELETE", "/cloud/project/p/instance/x"), "DELETE missing");
                T.check(!KeyCheck.ruleCovers(Json.list(Json.obj("method", "GET", "path", "/cloud/project/a.b")), "GET", "/cloud/project/aXb"), "dot is no wildcard");

                // ── Storage on moto ──
                String bucket = "keycheck-" + Long.toHexString(System.nanoTime());
                Map<String, Object> cfg = Json.obj("name", "test", "type", "s3", "purpose", "replica", "endpoint", moto, "region", "us-east-1", "accessKey", "testing", "secretKey", "testing", "bucket", bucket);
                List<Object> r = KeyCheck.storage(cfg);
                T.eq("login", Json.str(r.get(0), "id"), "storage: login row");
                T.eq(true, Json.path(r.get(0), "ok"), "storage: login ok");
                T.check(Json.str(r.get(0), "detail").startsWith("Buckets: "), "storage: bucket count");
                T.eq(Json.stringify(Json.list(KeyCheck.row("bucket", "Bucket bekijken", null, bucket + " bestaat nog niet; de console maakt hem aan bij het koppelen."),
                        KeyCheck.row("objects", "Bestanden bekijken", null, "Niet gecontroleerd, want de bucket is niet te bekijken"))), Json.stringify(r.subList(1, 3)), "storage: bucket does not exist yet");
                T.check(!new S3Store(cfg).bucketExists(), "nothing created");
                new S3Store(cfg).createBucket(false);
                r = KeyCheck.storage(cfg);
                T.eq("[true,\"" + bucket + " gevonden\",true,\"\"]", Json.stringify(Json.list(Json.path(r.get(1), "ok"), Json.path(r.get(1), "detail"), Json.path(r.get(2), "ok"), Json.path(r.get(2), "detail"))), "storage: bucket and objects");

                // Storage that refuses keys (same texts as the TS test).
                for (String[] x : new String[][] {
                        {"InvalidAccessKeyId", "De opslag herkent deze toegangssleutel niet. Kopieer hem opnieuw of maak een nieuwe."},
                        {"SignatureDoesNotMatch", "De geheime sleutel hoort niet bij deze toegangssleutel. Kopieer hem opnieuw."}}) {
                    api.reset();
                    api.on(".*", c -> new FakeApi.Reply(403, "<Error><Code>" + x[0] + "</Code></Error>", "application/xml"));
                    Map<String, Object> bad = Json.copy(cfg);
                    bad.put("endpoint", api.base());
                    T.eq(Json.stringify(Json.list(KeyCheck.row("login", "Inloggen lukt", false, x[1]), KeyCheck.row("bucket", "Bucket bekijken", null, KeyCheck.NOT_CHECKED),
                            KeyCheck.row("objects", "Bestanden bekijken", null, KeyCheck.NOT_CHECKED))), Json.stringify(KeyCheck.storage(bad)), "storage: " + x[0]);
                }
                api.reset();
                api.on(".*", c -> new FakeApi.Reply(403, "HEAD".equals(c.method) ? "" : "<Error><Code>AccessDenied</Code></Error>", "application/xml"));
                Map<String, Object> denied = Json.copy(cfg);
                denied.put("endpoint", api.base());
                List<Object> d = KeyCheck.storage(denied);
                T.eq(null, Json.path(d.get(0), "ok"), "storage: listing buckets not allowed is fine");
                T.eq(Json.stringify(KeyCheck.row("bucket", "Bucket bekijken", false, "Geen toegang tot " + bucket + ". Bestaat hij al bij iemand anders, of mag de sleutel er niet bij?")), Json.stringify(d.get(1)), "storage: no access to the bucket");

                // ── Console: POST /api/check and the list after a failed link ──
                Catalog cat;
                try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { cat = Catalog.load(in); }
                File dir = Files.createTempDirectory("keycheck").toFile();
                ConsoleApi console = new ConsoleApi(new File(dir, "kluis.json"), cat, url -> { });
                call(console, 401, "POST", "/api/check", Json.obj("kind", "servers", "id", "hetzner"));
                call(console, 200, "POST", "/api/setup/create", Json.obj("domain", "vanes.nl", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                Object hz = null, hz401 = null, desec401 = null;
                for (Object sc : scenarios) {
                    if ("Hetzner servers: alles in orde".equals(Json.str(sc, "name"))) hz = sc;
                    if ("Hetzner servers: token onbekend".equals(Json.str(sc, "name"))) hz401 = sc;
                    if ("deSEC: token onbekend".equals(Json.str(sc, "name"))) desec401 = sc;
                }
                serve(api, Json.map(hz401, "routes"));
                Map<String, Object> e = call(console, 400, "POST", "/api/providers", Json.obj("id", "hetzner", "fields", Json.obj("token", "fout")));
                T.check(Json.str(e, "error").contains("Inloggen bij Hetzner Cloud lukt niet"), "link failure");
                T.eq(Json.stringify(Json.path(hz401, "expect")), Json.stringify(e.get("checks")), "link failure: with the list");

                Map<String, Object> routes = Json.copy(Json.map(hz, "routes"));
                routes.put("GET /v1/server_types", Json.parse("{\"status\":200,\"json\":{\"server_types\":[{\"name\":\"cx22\",\"cores\":2,\"memory\":4,\"architecture\":\"x86\",\"prices\":[{\"location\":\"fsn1\",\"price_monthly\":{\"gross\":\"4.5\"}}]}]}}"));
                serve(api, routes);
                call(console, 200, "POST", "/api/providers", Json.obj("id", "hetzner", "fields", Json.obj("token", "hz-goed")));
                serve(api, Json.map(hz, "routes"));
                Map<String, Object> ok = call(console, 200, "POST", "/api/check", Json.obj("kind", "servers", "id", "hetzner"));
                T.eq(Json.stringify(Json.obj("checks", Json.path(hz, "expect"))), Json.stringify(ok), "check with the stored key");
                T.check(onlyReads(api) && !api.calls.isEmpty(), "only GET");
                T.eq("Bearer hz-goed", api.calls.get(0).headers.get("authorization"), "stored token used");
                serve(api, Json.map(hz401, "routes"));
                ok = call(console, 200, "POST", "/api/check", Json.obj("kind", "servers", "id", "hetzner", "fields", Json.obj("token", "ander")));
                T.eq(Json.stringify(Json.path(hz401, "expect")), Json.stringify(ok.get("checks")), "check with another token");
                T.eq("••••••••goed", Json.str(call(console, 200, "GET", "/api/config", null), "providers", "hetzner", "token"), "vault unchanged");

                // DNS at Hetzner with the same key; the zone is the cloud's domain.
                serve(api, Json.obj("GET /v1/zones?name=vanes.nl", Json.parse("{\"status\":200,\"json\":{\"zones\":[{\"name\":\"vanes.nl\"}]}}")));
                ok = call(console, 200, "POST", "/api/check", Json.obj("kind", "dns", "id", "hetzner"));
                T.eq("vanes.nl gevonden", Json.str(Json.listAt(ok, "checks").get(1), "detail"), "DNS check: zone found");
                // Linking DNS fails: the list comes along.
                Map<String, Object> dr = Json.copy(Json.map(desec401, "routes"));
                dr.put("GET /api/v1/domains/vanes.nl/", Json.parse("{\"status\":401,\"json\":{}}"));
                serve(api, dr);
                e = call(console, 400, "POST", "/api/dns", Json.obj("mode", "desec", "token", "fout"));
                T.eq("deSEC accepteert dit token niet", Json.str(e, "error"), "DNS link failure");
                T.eq("[false,null,null]", Json.stringify(Json.list(Json.path(e, "checks", 0, "ok"), Json.path(e, "checks", 1, "ok"), Json.path(e, "checks", 2, "ok"))), "DNS link failure: with the list");
                T.eq("DNS-zone bekijken", Json.str(e, "checks", 1, "label"), "DNS zone label");

                // Storage by the name of the linked store.
                Map<String, Object> st = call(console, 200, "POST", "/api/stores", Json.obj("offer", "custom", "region", "eigen", "endpoint", moto, "accessKey", "testing", "secretKey", "testing", "purpose", "replica"));
                ok = call(console, 200, "POST", "/api/check", Json.obj("kind", "storage", "id", Json.str(st, "name")));
                T.eq("[true,true,true]", Json.stringify(Json.list(Json.path(ok, "checks", 0, "ok"), Json.path(ok, "checks", 1, "ok"), Json.path(ok, "checks", 2, "ok"))), "storage check via the console");

                T.eq("Onbekende opslag", Json.str(call(console, 400, "POST", "/api/check", Json.obj("kind", "storage", "id", "bestaat-niet")), "error"), "unknown store");
                T.eq("Onbekende aanbieder", Json.str(call(console, 400, "POST", "/api/check", Json.obj("kind", "servers", "id", "local")), "error"), "unknown provider");
                call(console, 400, "POST", "/api/check", Json.obj("kind", "iets"));
            } finally {
                Endpoints.reset();
            }
        });
    }
}
