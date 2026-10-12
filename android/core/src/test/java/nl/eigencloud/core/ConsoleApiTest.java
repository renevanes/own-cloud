package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/**
 * The phone console's /api router (ConsoleApi) from first screen to launch, with S3 storage on moto_server
 * (MOTO_URL) and a fake Hetzner API: the same steps the web-console screens take on the phone.
 */
public class ConsoleApiTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    public static void main(String[] args) {
        T.main("ConsoleApiTest", () -> {
            String moto = T.env("MOTO_URL");
            if (moto == null) throw new IllegalStateException("MOTO_URL niet gezet");
            Map<String, Object> g = T.golden();
            Catalog cat;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { cat = Catalog.load(in); }
            File dir = Files.createTempDirectory("console-api").toFile();
            File vaultFile = new File(dir, "beheer/kluis.json");
            final String[] ready = {null};
            api = new ConsoleApi(vaultFile, cat, url -> ready[0] = url);

            try (FakeApi hz = new FakeApi()) {
                hz.json("^GET /hz/server_types\\?per_page=50$", 200, Json.path(g, "apiResponses", "hetzner"))
                        .json("^GET /hz/servers\\?", 200, Json.parse("{\"servers\":[],\"meta\":{\"pagination\":{\"next_page\":null}}}"))
                        .json("^POST /hz/servers$", 201, Json.parse("{\"server\":{\"id\":42,\"public_net\":{\"ipv4\":{\"ip\":\"127.0.0.1\"},\"ipv6\":{\"ip\":\"::1/64\"}},\"server_type\":{\"prices\":[{\"location\":\"fsn1\",\"price_monthly\":{\"gross\":\"4.5100\"}}]}}}"))
                        .json("change_dns_ptr", 201, Json.obj());
                Endpoints.HETZNER = hz.base() + "/hz";

                // ── Eerste scherm ──
                Map<String, Object> st = call(200, "GET", "/api/state", null);
                T.eq(false, st.get("vault"), "no vault yet");
                T.eq(true, st.get("phone"), "phone flag for the screens");
                T.check(!Json.listAt(st, "offers", "servers").isEmpty(), "server offers from catalog.json");
                call(401, "GET", "/api/config", null);

                // ── Jij en je domein ──
                Map<String, Object> e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "appPassword", "kort", "passphrase", "x".repeat(14)));
                T.check(Json.str(e, "error").contains("10 tekens"), "app password length checked");
                e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "passphrase", "kort"));
                T.check(Json.str(e, "error").contains("12 tekens"), "passphrase length checked");
                e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@vanes.test", "passphrase", "vier losse woorden hier"));
                T.check(Json.str(e, "error").contains("buiten je eigen domein"), "alert address outside own domain");
                call(200, "POST", "/api/setup/create", Json.obj("domain", "https://Vanes.test/", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
                String raw = new String(Files.readAllBytes(vaultFile.toPath()), "UTF-8");
                T.check(!raw.contains("vanes") && !raw.contains("rene@"), "vault file is encrypted");
                call(409, "POST", "/api/setup/create", Json.obj("domain", "x.test", "mailbox", "a", "appPassword", "0123456789", "passphrase", "vier losse woorden hier"));
                st = call(200, "GET", "/api/state", null);
                T.eq(true, st.get("unlocked"), "unlocked after create");
                T.eq("vanes.test", st.get("domain"), "domain normalised");
                T.eq("sleutel", st.get("step"), "next step: key");

                // ── Herstelsleutel ──
                Map<String, Object> key = call(200, "GET", "/api/key", null);
                List<Object> groups = Json.listAt(key, "groups");
                T.eq(8, groups.size(), "8 key groups");
                // Eén groep, door de server gekozen en bewaard; fout → melding, geen slot; terug → andere groep; later → herinnering.
                long ask = ((Number) key.get("ask")).longValue();
                T.check(ask >= 1 && ask <= 8, "ask 1–8");
                T.eq(ask, ((Number) call(200, "GET", "/api/key", null).get("ask")).longValue(), "same group after reload");
                T.eq("open", call(200, "GET", "/api/config", null).get("keyCheck"), "keyCheck open");
                for (int i = 0; i < 4; i++) {
                    Map<String, Object> w = call(400, "POST", "/api/key/confirm", Json.obj("group", ask, "value", "00000000"));
                    T.eq("Dat is niet groep " + ask + ". Kijk nog eens op je herstelblad.", w.get("error"), "wrong group message");
                    T.eq(ask, ((Number) w.get("ask")).longValue(), "wrong: ask");
                }
                long other = ask % 8 + 1;
                T.eq(ask, ((Number) call(409, "POST", "/api/key/confirm", Json.obj("group", other, "value", groups.get((int) other - 1))).get("ask")).longValue(), "other group refused");
                long next = ((Number) call(200, "POST", "/api/key/new-group", null).get("ask")).longValue();
                T.check(next != ask, "new group after going back");
                T.eq(next, ((Number) call(200, "GET", "/api/key", null).get("ask")).longValue(), "new group kept");
                T.eq("{\"ok\":true,\"later\":true}", Json.stringify(call(200, "POST", "/api/key/later", null)), "later");
                T.eq("later", call(200, "GET", "/api/config", null).get("keyCheck"), "keyCheck later");
                T.eq(true, call(200, "GET", "/api/key", null).get("later"), "key later");
                for (Object x : Json.asList(call(200, "GET", "/api/checklist", null).get("_")))
                    if ("sleutel".equals(Json.str(x, "id"))) T.eq(false, Json.path(x, "required"), "later: launch not blocked");
                String kg = Json.jsString(groups.get((int) next - 1));
                String sloppy = (" " + kg.substring(0, 4) + " " + kg.substring(4) + " ").toUpperCase().replace('0', 'O').replace('1', 'l');
                call(200, "POST", "/api/key/confirm", Json.obj("group", next, "value", sloppy));
                T.eq("ok", call(200, "GET", "/api/config", null).get("keyCheck"), "keyCheck ok");
                T.eq(false, call(200, "GET", "/api/key", null).get("later"), "no reminder after check");
                T.eq("{\"ok\":true,\"later\":false}", Json.stringify(call(200, "POST", "/api/key/later", null)), "later after check");
                // De oude vorm (groep 3 en 7) werkt nog.
                call(400, "POST", "/api/key/confirm", Json.obj("g3", "fout", "g7", groups.get(6)));
                call(200, "POST", "/api/key/confirm", Json.obj("g3", " " + Json.jsString(groups.get(2)).toUpperCase() + " ", "g7", groups.get(6)));
                String sheet = api.recoverySheet();
                for (Object gr : groups) T.check(sheet.contains(Json.jsString(gr)), "recovery sheet has group " + gr);
                call(200, "POST", "/api/step", Json.obj("step", "opslag"));

                // ── Opslag (S3 op moto) ──
                Map<String, Object> s1 = call(200, "POST", "/api/stores", Json.obj("offer", "custom", "region", "eigen", "endpoint", moto, "accessKey", "testing", "secretKey", "testing", "purpose", "replica"));
                T.eq(true, s1.get("ok"), "store prepared: " + Json.stringify(s1.get("steps")));
                Map<String, Object> s2 = call(200, "POST", "/api/stores", Json.obj("offer", "custom", "region", "eigen", "endpoint", moto, "accessKey", "testing", "secretKey", "testing", "purpose", "backup"));
                T.eq(true, s2.get("ok"), "backup store prepared");
                Map<String, Object> conf = call(200, "GET", "/api/config", null);
                T.eq(2, Json.listAt(conf, "stores").size(), "two stores");
                T.check(Json.str(conf, "stores", 0, "accessKey").startsWith("••"), "access key masked");
                T.eq("••••••••", Json.str(conf, "stores", 0, "secretKey"), "secret key masked");
                e = call(400, "POST", "/api/stores", Json.obj("offer", "custom", "region", "eigen", "endpoint", "ftp://x", "accessKey", "a", "secretKey", "b", "purpose", "replica"));
                T.check(Json.str(e, "error").contains("endpoint"), "endpoint validated");

                // ── Servers (nep-Hetzner) ──
                Map<String, Object> pr = call(200, "POST", "/api/providers", Json.obj("id", "hetzner", "fields", Json.obj("token", "hz-geheim-token")));
                T.eq(3, Json.listAt(pr, "regions").size(), "sizes for 3 Hetzner regions");
                conf = call(200, "GET", "/api/config", null);
                T.eq("••••••••oken", Json.str(conf, "providers", "hetzner", "token"), "provider token masked");
                Map<String, Object> presets = call(200, "GET", "/api/presets", null);
                String choose = null;
                for (Object p : Json.listAt(presets, "presets")) if (Json.path(p, "missing") == null && choose == null) choose = Json.str(p, "id");
                T.check(choose != null, "a preset is possible with Hetzner alone");
                Map<String, Object> ch = call(200, "POST", "/api/presets/choose", Json.obj("id", choose));
                T.eq(choose, Json.str(ch, "preset", "id"), "preset chosen");
                call(400, "POST", "/api/presets/choose", Json.obj("id", "nl"));

                // ── Domein en mail ──
                Map<String, Object> dns = call(200, "POST", "/api/dns", Json.obj("mode", "manual"));
                T.eq(true, dns.get("ok"), "manual DNS");
                call(200, "POST", "/api/mail", Json.obj("relay", null, "spfExtra", " include:spf.test "));
                T.eq("include:spf.test", Json.str(call(200, "GET", "/api/config", null), "spfExtra"), "spf extra stored");
                for (Object x : Json.asList(call(200, "GET", "/api/checklist", null).get("_"))) {
                    if (Json.truthy(Json.path(x, "required"))) T.check(Json.truthy(Json.path(x, "ok")), "checklist: " + Json.str(x, "label"));
                }

                // ── Op slot, ontgrendelen, vingerafdruk-sleutel ──
                byte[] bioKey = api.vault.exportKey();
                call(200, "POST", "/api/lock", null);
                call(401, "GET", "/api/config", null);
                call(401, "POST", "/api/unlock", Json.obj("passphrase", "verkeerd wachtwoord"));
                call(200, "POST", "/api/unlock", Json.obj("passphrase", "vier losse woorden hier"));
                api.vault.lock();
                api.vault.unlockWithKey(bioKey);
                T.eq("vanes.test", Json.str(call(200, "GET", "/api/config", null), "domain"), "unlock with exported (biometric) key");
                api.idleMs = 1;
                Thread.sleep(20);
                call(401, "GET", "/api/config", null);
                api.idleMs = 15 * 60_000L;
                call(200, "POST", "/api/unlock", Json.obj("passphrase", "vier losse woorden hier"));

                // ── Starten ──
                Map<String, Object> l = call(200, "POST", "/api/launch", null);
                T.check(Json.str(l, "nodeId") != null, "first node id");
                T.check(hz.find("^POST /hz/servers$") != null, "server created at Hetzner");
                T.eq("Bearer hz-geheim-token", hz.find("^POST /hz/servers$").headers.get("authorization"), "with the stored token");
                Map<String, Object> launch = call(200, "GET", "/api/launch", null);
                T.eq("done", Json.str(launch, "steps", 0, "state"), "step 1 done: " + Json.str(launch, "steps", 0, "detail"));
                T.eq("IP-adres 127.0.0.1", Json.str(launch, "steps", 0, "detail"), "IP shown");
                call(409, "POST", "/api/launch", null);
                T.eq("starting", Json.str(call(200, "GET", "/api/status", null), "state"), "dashboard: starting");
                T.eq(true, Json.path(call(200, "GET", "/api/state", null), "done"), "console marked done");
                ObjectStore store = Stores.make(Json.asMap(ClusterConfig.stores(api.vault.config()).get(0)));
                T.check(!store.list("bootstrap/").isEmpty(), "bootstrap for the new node written to storage");

                call(200, "DELETE", "/api/providers/hetzner", null);
                T.check(Json.map(call(200, "GET", "/api/config", null), "providers", "hetzner") == null, "provider removed");
                call(404, "GET", "/api/bestaat-niet", null);
                T.check(ready[0] == null, "cloud not reported ready before it answers");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
