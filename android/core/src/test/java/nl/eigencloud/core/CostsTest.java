package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/**
 * Kosten en budget in the phone console (GET /api/costs, POST /api/costs/budget), like test/costs.test.ts: storage
 * measured on moto_server (MOTO_URL), a test price per GB from a modified catalog.json, and the budget going into
 * the settings for the cluster. The rules themselves are compared with TS in FormatsGoldenTest (golden "costs").
 */
public class CostsTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    public static void main(String[] args) {
        T.main("CostsTest", () -> {
            String moto = T.env("MOTO_URL");
            if (moto == null) throw new IllegalStateException("MOTO_URL niet gezet");
            Map<String, Object> raw;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { raw = Json.parseObject(Bytes.utf8(Bytes.readAll(in))); }
            Object real = null;
            for (Object o : Json.listAt(raw, "stores")) {
                if ("scaleway".equals(Json.str(o, "id"))) { real = Json.path(o, "pricePerGbMonth"); Json.asMap(o).put("pricePerGbMonth", 1000L); }
            }
            T.eq(0.01606, real, "catalog.json: Scaleway price per GB per month");
            for (Object o : Json.listAt(raw, "stores")) {
                if ("hetzner".equals(Json.str(o, "id"))) T.check(Json.asMap(o).containsKey("pricePerGbMonth") && Json.path(o, "pricePerGbMonth") == null, "catalog.json: Hetzner price unknown (null)");
            }
            Catalog cat = new Catalog(Json.stringify(raw));
            File dir = Files.createTempDirectory("costs").toFile();
            api = new ConsoleApi(new File(dir, "kluis.json"), cat, null);

            call(401, "GET", "/api/costs", null);
            call(200, "POST", "/api/setup/create", Json.obj("domain", "kosten.test", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
            Map<String, Object> s = call(200, "POST", "/api/stores", Json.obj("offer", "custom", "region", "eigen", "endpoint", moto, "accessKey", "testing", "secretKey", "testing", "purpose", "replica"));
            T.eq(true, s.get("ok"), "store on moto");

            // Nog als "custom": prijs onbekend.
            Map<String, Object> k = call(200, "GET", "/api/costs?fresh=1", null);
            List<Object> ps = Json.listAt(k, "providers");
            T.eq(1, ps.size(), "one provider");
            T.eq("custom", Json.str(ps.get(0), "id"), "custom store");
            T.eq(null, Json.path(ps.get(0), "storage"), "custom: storage unknown");
            T.eq(false, k.get("complete"), "incomplete");
            T.eq(false, k.get("sleeping"), "not asleep (new)");
            T.check(k.get("updatedAt") instanceof Number, "updatedAt");

            // Dezelfde bucket als Scaleway-opslag, met 20 kB erin: 20000 / 1e9 × 1000 = € 0,02.
            Map<String, Object> store = Json.asMap(Json.listAt(api.vault.config(), "stores").get(0));
            store.put("name", "scaleway-nl-ams");
            Stores.make(store).put("foto.bin", new byte[20_000]);
            k = call(200, "GET", "/api/costs?fresh=1", null);
            T.eq("[{\"id\":\"scaleway\",\"name\":\"Scaleway\",\"servers\":0,\"storage\":0.02,\"bytes\":20000,\"total\":0.02,\"source\":\"geschat\"}]",
                    Json.stringify(k.get("providers")), "scaleway storage priced");
            T.eq("{\"total\":0.02,\"complete\":true,\"sleeping\":false,\"budget\":null,\"overBudget\":false}",
                    Json.stringify(Json.obj("total", k.get("total"), "complete", k.get("complete"), "sleeping", k.get("sleeping"), "budget", k.get("budget"), "overBudget", k.get("overBudget"))), "totals");

            // Budget
            T.check(Json.str(call(400, "POST", "/api/costs/budget", Json.obj("budget", "abc")), "error").contains("bedrag"), "invalid budget");
            call(400, "POST", "/api/costs/budget", Json.obj("budget", 200000));
            T.eq("{\"ok\":true,\"budget\":0.01}", Json.stringify(call(200, "POST", "/api/costs/budget", Json.obj("budget", "0,01"))), "budget saved");
            k = call(200, "GET", "/api/costs", null);
            T.eq(0.01, k.get("budget"), "budget in view");
            T.eq(true, k.get("overBudget"), "over budget");
            Map<String, Object> settings = Admin.consoleSettings(api.vault.config(), "");
            T.eq("0.01", settings.get("budget_month"), "budget_month for the cluster");
            T.eq("{}", settings.get("cost_servers"), "cost_servers (no catalog yet)");
            T.eq("{\"ok\":true,\"budget\":null}", Json.stringify(call(200, "POST", "/api/costs/budget", Json.obj("budget", null))), "budget removed");
            T.eq(null, call(200, "GET", "/api/costs", null).get("budget"), "no budget");
            T.eq("", Admin.consoleSettings(api.vault.config(), "").get("budget_month"), "budget_month cleared");
        });
    }
}
