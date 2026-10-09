package nl.eigencloud.core;

import java.util.List;

/** Provider adapters against a local fake API: same requests and results as test/providers.test.ts. */
public class ProvidersTest {
    public static void main(String[] args) {
        T.main("ProvidersTest", () -> {
            try (FakeApi api = new FakeApi()) {
                hetzner(api);
                scaleway(api);
                upcloud(api);
                makeProvider();
            }
        });
    }

    static void hetzner(FakeApi api) throws Exception {
        api.reset();
        api.json("^POST /v1/servers$", 201, Json.parse("{\"server\":{\"id\":42,\"public_net\":{\"ipv4\":{\"ip\":\"1.2.3.4\"},\"ipv6\":{\"ip\":\"2a01:4f8::/64\"}},\"server_type\":{\"prices\":[{\"location\":\"fsn1\",\"price_monthly\":{\"gross\":\"4.5100\"}}]}}}"))
                .json("^POST .*change_dns_ptr", 201, Json.obj())
                .json("^DELETE /v1/servers/42", 200, Json.obj())
                .on("^GET /v1/servers\\?label_selector=.*page=1$", c -> new FakeApi.Reply(200, "{\"servers\":[{\"id\":42,\"labels\":{\"node\":\"n-1\"}}],\"meta\":{\"pagination\":{\"next_page\":2}}}", "application/json"))
                .on("^GET /v1/servers\\?label_selector=.*page=2$", c -> new FakeApi.Reply(200, "{\"servers\":[{\"id\":43,\"labels\":{\"node\":\"n-2\"}}],\"meta\":{\"pagination\":{\"next_page\":null}}}", "application/json"));
        HetznerProvider p = new HetznerProvider(Json.obj("token", "tok", "sshKey", "mijn-sleutel")).baseUrl(api.base() + "/v1");
        Provider.ServerInfo info = p.create(new Provider.CreateSpec("Eigen", "N_1", "data", "fsn1", "cx23", "#!/bin/bash"));
        T.eq("{\"serverId\":\"42\",\"ipv4\":\"1.2.3.4\",\"ipv6\":\"2a01:4f8::1\",\"monthlyCost\":4.51,\"country\":\"DE\"}", Json.stringify(info.toJson()), "Hetzner create result");
        FakeApi.Call c0 = api.calls.get(0);
        T.eq("Bearer tok", c0.headers.get("authorization"), "Hetzner auth header");
        T.eq("application/json", c0.headers.get("content-type"), "Hetzner content-type");
        T.eq("{\"name\":\"eigen-n-1\",\"server_type\":\"cx23\",\"image\":\"ubuntu-24.04\",\"location\":\"fsn1\",\"user_data\":\"#!/bin/bash\",\"labels\":{\"cluster\":\"Eigen\",\"node\":\"N_1\",\"kind\":\"data\"},\"public_net\":{\"enable_ipv4\":true,\"enable_ipv6\":true},\"ssh_keys\":[\"mijn-sleutel\"]}",
                c0.rawBody, "Hetzner create body (same JSON as TS)");
        p.setPtr(info, "mail.jouwdomein.nl");
        T.eq(2L, api.calls.stream().filter(c -> c.path.contains("change_dns_ptr")).count(), "two PTR calls (IPv4 + IPv6)");
        T.eq("{\"ip\":\"2a01:4f8::1\",\"dns_ptr\":\"mail.jouwdomein.nl\"}", api.last().rawBody, "PTR body");
        List<Provider.ServerRef> list = p.list("eigen");
        T.eq("[42/n-1, 43/n-2]", list.toString(), "Hetzner list with pagination");
        T.eq("label_selector=cluster%3Deigen&per_page=50&page=1", api.find("GET /v1/servers\\?").query, "Hetzner list query");
        p.destroy("42");
        T.eq("DELETE /v1/servers/42", api.last().toString(), "Hetzner destroy");
        api.reset();
        api.json("^DELETE /v1/servers/7", 404, Json.obj("error", "not found"));
        p.destroy("7"); // 404 is fine
        api.json("^POST /v1/servers$", 422, Json.obj("error", Json.obj("message", "invalid")));
        T.throwsWith("POST " + api.base() + "/v1/servers → 422 {\"error\"", () -> p.create(new Provider.CreateSpec("e", "n", "data", "fsn1", "cx23", "")), "Hetzner error message like TS");
        T.eq("FI", p.country("hel1"), "Hetzner country hel1");
        T.eq("DE", p.country("nbg1"), "Hetzner country nbg1");
    }

    static void scaleway(FakeApi api) throws Exception {
        api.reset();
        api.json("^POST .*/ips$", 200, Json.parse("{\"ip\":{\"id\":\"ip-1\",\"address\":\"51.15.0.1\"}}"))
                .json("^GET .*local-images", 200, Json.parse("{\"local_images\":[{\"id\":\"img-1\"}]}"))
                .json("^POST .*/servers$", 200, Json.parse("{\"server\":{\"id\":\"srv-1\"}}"))
                .on("^PATCH .*user_data/cloud-init", c -> new FakeApi.Reply(204, "", "text/plain"))
                .json("^POST .*/action$", 202, Json.obj());
        ScalewayProvider p = new ScalewayProvider(Json.obj("secretKey", "sk", "projectId", "proj")).baseUrl(api.base());
        Provider.ServerInfo info = p.create(new Provider.CreateSpec("eigen", "n-2", "data", "nl-ams-1", "DEV1-S", "#!/bin/bash"));
        T.eq("{\"serverId\":\"nl-ams-1/srv-1/ip-1\",\"ipv4\":\"51.15.0.1\",\"country\":\"NL\"}", Json.stringify(info.toJson()), "Scaleway create result");
        T.eq("[POST /instance/v1/zones/nl-ams-1/ips, GET /marketplace/v2/local-images?image_label=ubuntu_noble&zone=nl-ams-1&type=instance_sbs, POST /instance/v1/zones/nl-ams-1/servers, PATCH /instance/v1/zones/nl-ams-1/servers/srv-1/user_data/cloud-init, POST /instance/v1/zones/nl-ams-1/servers/srv-1/action]",
                api.calls.toString(), "Scaleway call sequence");
        T.eq("{\"project\":\"proj\",\"type\":\"routed_ipv4\",\"tags\":[\"cluster=eigen\",\"node=n-2\"]}", api.calls.get(0).rawBody, "Scaleway IP body");
        T.eq("sk", api.calls.get(0).headers.get("x-auth-token"), "Scaleway auth header");
        FakeApi.Call srv = api.find("POST .*/servers$");
        T.eq("{\"name\":\"eigen-n-2\",\"commercial_type\":\"DEV1-S\",\"image\":\"img-1\",\"project\":\"proj\",\"public_ips\":[\"ip-1\"],\"tags\":[\"cluster=eigen\",\"node=n-2\",\"kind=data\"]}", srv.rawBody, "Scaleway server body");
        FakeApi.Call ci = api.find("PATCH");
        T.eq("#!/bin/bash", ci.rawBody, "Scaleway cloud-init body");
        T.eq("text/plain", ci.headers.get("content-type"), "Scaleway cloud-init content-type");
        T.eq("{\"action\":\"poweron\"}", api.last().rawBody, "Scaleway poweron");

        // Failure: no image → IP is released and the error is rethrown.
        api.reset();
        api.json("^POST .*/ips$", 200, Json.parse("{\"ip\":{\"id\":\"ip-9\",\"address\":\"x\"}}"))
                .json("^GET .*local-images", 200, Json.parse("{\"local_images\":[]}"))
                .on("^DELETE .*/ips/ip-9", c -> new FakeApi.Reply(204, "", "text/plain"));
        T.throwsWith("geen image", () -> p.create(new Provider.CreateSpec("eigen", "n-3", "data", "nl-ams-1", "DEV1-S", "")), "Scaleway create fails without image");
        T.check(api.find("^DELETE .*/ips/ip-9$") != null, "Scaleway IP is cleaned up");

        // Failure later on (server POST) also releases the IP.
        api.reset();
        api.json("^POST .*/ips$", 200, Json.parse("{\"ip\":{\"id\":\"ip-8\",\"address\":\"x\"}}"))
                .json("^GET .*local-images", 200, Json.parse("{\"local_images\":[{\"id\":\"img\"}]}"))
                .json("^POST .*/servers$", 403, Json.obj("message", "quota"))
                .on("^DELETE .*/ips/ip-8", c -> new FakeApi.Reply(404, "", "text/plain"));
        T.throwsWith("→ 403", () -> p.create(new Provider.CreateSpec("eigen", "n-4", "data", "fr-par-1", "DEV1-S", "")), "Scaleway create fails on server POST");
        T.check(api.find("^DELETE .*/ips/ip-8$") != null, "Scaleway IP cleaned up after server failure");

        // destroy: terminate, then release IP with retry on 409
        api.reset();
        final int[] attempts = {0};
        api.json("^POST .*/servers/srv-1/action$", 202, Json.obj())
                .on("^DELETE .*/ips/ip-1$", c -> new FakeApi.Reply(++attempts[0] < 3 ? 409 : 204, "", "application/json"));
        p.retryDelay(1).destroy("nl-ams-1/srv-1/ip-1");
        T.eq("{\"action\":\"terminate\"}", api.calls.get(0).rawBody, "Scaleway terminate");
        T.eq(3, attempts[0], "Scaleway IP release retried until free");

        // list over all zones; failing zones are skipped
        api.reset();
        api.on("^GET /instance/v1/zones/nl-ams-1/servers\\?tags=cluster%3Deigen&per_page=100$", c -> new FakeApi.Reply(200, "{\"servers\":[{\"id\":\"s1\",\"tags\":[\"cluster=eigen\",\"node=n-7\"],\"public_ips\":[{\"id\":\"ip-7\"}]},{\"id\":\"s2\",\"tags\":[]}]}", "application/json"))
                .json("^GET /instance/v1/zones/fr-par-1/", 500, Json.obj());
        List<Provider.ServerRef> l = p.list("eigen");
        T.eq("[nl-ams-1/s1/ip-7/n-7, nl-ams-1/s2//]", l.toString(), "Scaleway list");
        T.eq(9, api.calls.size(), "Scaleway list asks all 9 zones");
        T.eq("PL", p.country("pl-waw-2"), "Scaleway country");
    }

    static void upcloud(FakeApi api) throws Exception {
        api.reset();
        api.json("^GET /1\\.3/storage/template", 200, Json.parse("{\"storages\":{\"storage\":[{\"title\":\"Debian\",\"uuid\":\"tpl-0\"},{\"title\":\"Ubuntu Server 24.04 LTS (Noble Numbat)\",\"uuid\":\"tpl-1\"}]}}"))
                .json("^POST /1\\.3/server$", 202, Json.parse("{\"server\":{\"uuid\":\"u-1\",\"ip_addresses\":{\"ip_address\":[{\"access\":\"public\",\"family\":\"IPv4\",\"address\":\"94.237.0.1\"},{\"access\":\"utility\",\"family\":\"IPv4\",\"address\":\"10.0.0.1\"},{\"access\":\"public\",\"family\":\"IPv6\",\"address\":\"2a04::1\"}]}}}"));
        UpCloudProvider p = new UpCloudProvider(Json.obj("token", "ut")).baseUrl(api.base() + "/1.3");
        Provider.ServerInfo info = p.create(new Provider.CreateSpec("eigen", "n-4", "witness", "nl-ams1", "1xCPU-1GB", "#!/bin/bash"));
        T.eq("{\"serverId\":\"u-1\",\"ipv4\":\"94.237.0.1\",\"ipv6\":\"2a04::1\",\"country\":\"NL\"}", Json.stringify(info.toJson()), "UpCloud create result");
        Object body = api.calls.get(1).json;
        T.eq("nl-ams1", Json.str(body, "server", "zone"), "UpCloud zone");
        T.eq("tpl-1", Json.str(body, "server", "storage_devices", "storage_device", 0, "storage"), "UpCloud template");
        T.eq("#!/bin/bash", Json.str(body, "server", "user_data"), "UpCloud user_data");
        T.eq("{\"server\":{\"zone\":\"nl-ams1\",\"title\":\"eigen-n-4\",\"hostname\":\"n-4.eigen\",\"plan\":\"1xCPU-1GB\",\"metadata\":\"yes\",\"user_data\":\"#!/bin/bash\",\"labels\":{\"label\":[{\"key\":\"cluster\",\"value\":\"eigen\"},{\"key\":\"node\",\"value\":\"n-4\"},{\"key\":\"kind\",\"value\":\"witness\"}]},\"storage_devices\":{\"storage_device\":[{\"action\":\"clone\",\"storage\":\"tpl-1\",\"title\":\"root\",\"size\":25,\"tier\":\"maxiops\"}]},\"networking\":{\"interfaces\":{\"interface\":[{\"type\":\"public\",\"ip_addresses\":{\"ip_address\":[{\"family\":\"IPv4\"}]}},{\"type\":\"public\",\"ip_addresses\":{\"ip_address\":[{\"family\":\"IPv6\"}]}},{\"type\":\"utility\",\"ip_addresses\":{\"ip_address\":[{\"family\":\"IPv4\"}]}}]}},\"login_user\":{\"username\":\"root\",\"create_password\":\"no\"}}}",
                api.calls.get(1).rawBody, "UpCloud full body (same JSON as TS)");
        T.eq("Bearer ut", api.calls.get(0).headers.get("authorization"), "UpCloud bearer auth");

        UpCloudProvider basic = new UpCloudProvider(Json.obj("username", "rene", "password", "p@ss")).baseUrl(api.base() + "/1.3");
        api.reset();
        api.json("^GET /1\\.3/server\\?label=cluster%3Deigen$", 200, Json.parse("{\"servers\":{\"server\":[{\"uuid\":\"u-1\",\"labels\":{\"label\":[{\"key\":\"cluster\",\"value\":\"eigen\"},{\"key\":\"node\",\"value\":\"n-4\"}]}},{\"uuid\":\"u-2\"}]}}"));
        T.eq("[u-1/n-4, u-2/]", basic.list("eigen").toString(), "UpCloud list");
        T.eq("Basic " + Bytes.base64(Bytes.utf8("rene:p@ss")), api.last().headers.get("authorization"), "UpCloud basic auth");

        api.reset();
        final int[] polls = {0};
        api.json("^POST /1\\.3/server/u-1/stop$", 409, Json.obj())
                .on("^GET /1\\.3/server/u-1$", c -> new FakeApi.Reply(200, ++polls[0] < 2 ? "{\"server\":{\"state\":\"maintenance\"}}" : "{\"server\":{\"state\":\"stopped\"}}", "application/json"))
                .json("^DELETE /1\\.3/server/u-1\\?storages=1&backups=delete$", 204, null);
        p.pollDelay(1).destroy("u-1");
        T.eq("{\"stop_server\":{\"stop_type\":\"hard\",\"timeout\":\"60\"}}", api.calls.get(0).rawBody, "UpCloud stop body");
        T.eq("DELETE /1.3/server/u-1?storages=1&backups=delete", api.last().toString(), "UpCloud delete with storages");
        T.eq(2, polls[0], "UpCloud polls until stopped");
        api.reset();
        api.json("^POST /1\\.3/server/u-9/stop$", 404, Json.obj());
        p.destroy("u-9");
        T.eq(1, api.calls.size(), "UpCloud destroy of missing server stops early");

        api.reset();
        api.json("^GET /1\\.3/storage/template", 200, Json.parse("{\"storages\":{\"storage\":[]}}"));
        T.throwsWith("UpCloud: template Ubuntu Server 24.04 niet gevonden", () -> p.create(new Provider.CreateSpec("e", "n", "data", "de-fra1", "x", "")), "UpCloud missing template");
        T.eq("DE", p.country("de-fra1"), "UpCloud country");
    }

    static void makeProvider() {
        T.eq("hetzner", Providers.make("hetzner", Json.obj("token", "x")).name(), "make hetzner");
        T.eq("scaleway", Providers.make("x", Json.obj("type", "scaleway")).name(), "make by type");
        T.throwsWith("Onbekende aanbieder local", () -> Providers.make("local", Json.obj()), "local not supported");
    }
}
