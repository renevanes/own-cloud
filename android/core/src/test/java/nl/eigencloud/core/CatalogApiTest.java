package nl.eigencloud.core;

import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * fetchSizes() against a fake API serving the same responses golden.ts gave the TS version (results must be
 * identical), plus the console's provider step (connectProvider → console.catalog → presets).
 */
public class CatalogApiTest {
    public static void main(String[] args) {
        T.main("CatalogApiTest", () -> {
            Map<String, Object> g = T.golden();
            final boolean[] deny = {false};
            try (FakeApi api = new FakeApi()) {
                Map<String, Object> responses = Json.map(g, "apiResponses");
                api.json("^GET /hz/server_types\\?per_page=50$", 200, responses.get("hetzner"))
                        .json("^GET /scw/instance/v1/zones/[a-z0-9-]+/products/servers\\?per_page=100$", 200, responses.get("scaleway"))
                        .json("^GET /upc/plan$", 200, responses.get("upcloud"))
                        .json("^GET /exo/[a-z0-9-]+/v2/instance-type$", 200, responses.get("exoscale"))
                        .json("^GET /ovh/auth/time$", 200, responses.get("ovhTime"))
                        .json("^GET /ovh/cloud/project/p/flavor\\?region=[A-Z0-9]+$", 200, responses.get("ovhFlavors"))
                        .json("^GET /ovh/order/catalog/public/cloud\\?ovhSubsidiary=FR$", 200, responses.get("ovhCatalog"))
                        .on("^GET /hz/servers\\?", c -> deny[0] ? new FakeApi.Reply(401, "{\"error\":\"unauthorized\"}", "application/json")
                                : new FakeApi.Reply(200, "{\"servers\":[],\"meta\":{\"pagination\":{\"next_page\":null}}}", "application/json"));
                Endpoints.HETZNER = api.base() + "/hz";
                Endpoints.SCALEWAY = api.base() + "/scw";
                Endpoints.UPCLOUD = api.base() + "/upc";
                Endpoints.EXOSCALE = api.base() + "/exo/{zone}/v2";
                Endpoints.OVH = api.base() + "/ovh";
                Map<String, Object> sizeCfg = Json.obj("token", "t", "secretKey", "s", "apiKey", "EXOk", "apiSecret", "geheim", "appKey", "ak", "appSecret", "as", "consumerKey", "ck", "projectId", "p");
                for (Object o : Json.listAt(g, "fetchSizes")) {
                    List<Object> got = new ArrayList<>();
                    for (Catalog.SizeOption s : Catalog.fetchSizes(Json.str(o, "provider"), sizeCfg, Json.str(o, "region"))) got.add(s.toJson());
                    T.eq(Json.stringify(Json.path(o, "result")), Json.stringify(got), "fetchSizes " + Json.str(o, "provider") + "/" + Json.str(o, "region"));
                }
                T.eq("Bearer t", api.find("server_types").headers.get("authorization"), "Hetzner sizes auth");
                T.eq("s", api.find("products/servers").headers.get("x-auth-token"), "Scaleway sizes auth");
                T.check(api.find("instance-type").headers.get("authorization").startsWith("EXO2-HMAC-SHA256 credential=EXOk,expires="), "Exoscale sizes signed");
                T.check(api.find("/ovh/cloud/project/p/flavor").headers.get("x-ovh-signature").startsWith("$1$"), "OVH sizes signed");

                api.json("^GET /upc/fout", 401, Json.obj());
                Endpoints.UPCLOUD = api.base() + "/upc/fout";
                T.throwsWith("401 {}", () -> Catalog.fetchSizes("upcloud", Json.obj("token", "x"), "nl-ams1"), "fetchSizes error text like TS");

                // Console provider step: login check, sizes per region, catalog stored, presets.
                Catalog cat;
                try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file", "../app/src/main/assets/catalog.json"))) { cat = Catalog.load(in); }
                Map<String, Object> c = Console.newAdminConfig("vanes.nl", "rene", "", "lang-genoeg-123");
                List<Console.RegionSizes> regions = Console.connectProvider(c, cat, "hetzner", java.util.Collections.singletonMap("token", " nieuw-token "));
                T.eq(3, regions.size(), "regions fetched");
                T.eq("nieuw-token", Json.str(c, "providers", "hetzner", "token"), "token trimmed and stored");
                T.eq("cx23", Json.str(c, "console", "catalog", "hetzner", "fsn1", "data", "size"), "catalog stored per region");
                T.eq("cx53", Json.str(c, "console", "catalog", "hetzner", "nbg1", "witness", "size"), "nbg1 only offers cx53");
                Console.connectProvider(c, cat, "hetzner", java.util.Collections.singletonMap("token", "••••oken"));
                T.eq("nieuw-token", Json.str(c, "providers", "hetzner", "token"), "masked value ignored");
                deny[0] = true;
                T.throwsWith("Inloggen bij Hetzner Cloud lukt niet: GET  → 401", () -> Console.connectProvider(c, cat, "hetzner", java.util.Collections.singletonMap("token", "fout")), "login failure message (URL stripped)");
                List<Catalog.Preset> presets = Console.presets(c, cat);
                T.eq(3, presets.size(), "three presets");
                T.check(presets.get(0).missing != null, "nl preset needs Amsterdam");
                Console.removeProvider(c, "hetzner");
                T.check(Json.map(c, "providers", "hetzner") == null && Json.map(c, "console", "catalog", "hetzner") == null, "removeProvider");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
