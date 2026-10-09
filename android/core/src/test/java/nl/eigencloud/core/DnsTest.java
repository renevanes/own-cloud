package nl.eigencloud.core;

import java.util.Arrays;
import java.util.Map;

/** DNS step: DoH JSON parsing, deSEC/Hetzner flows and the delegation check against a fake API. */
public class DnsTest {
    public static void main(String[] args) {
        T.main("DnsTest", () -> {
            // DoH answer formats (Quad9 / Cloudflare style)
            String doh = "{\"Status\":0,\"TC\":false,\"Question\":[{\"name\":\"vanes.nl.\",\"type\":2}],\"Answer\":[{\"name\":\"vanes.nl.\",\"type\":2,\"TTL\":3600,\"data\":\"NS1.deSEC.io.\"},{\"name\":\"vanes.nl.\",\"type\":2,\"TTL\":3600,\"data\":\"ns2.desec.org.\"},{\"name\":\"x\",\"type\":46,\"data\":\"RRSIG …\"}]}";
            T.eq(Arrays.asList("ns1.desec.io", "ns2.desec.org"), DnsSetup.parseDohNs(doh), "parse NS answer");
            T.eq(0, DnsSetup.parseDohNs("{\"Status\":3,\"Answer\":[{\"type\":2,\"data\":\"a.\"}]}").size(), "NXDOMAIN → none");
            T.eq(0, DnsSetup.parseDohNs("{\"Status\":0}").size(), "no answer");

            try (FakeApi api = new FakeApi()) {
                Endpoints.DESEC = api.base() + "/desec";
                Endpoints.HETZNER = api.base() + "/hz";
                Endpoints.DOH = new String[] {api.base() + "/kapot", api.base() + "/doh"};
                api.json("^GET /kapot", 500, Json.obj())
                        .on("^GET /doh\\?name=vanes\\.nl&type=NS$", c -> new FakeApi.Reply("application/dns-json".equals(c.headers.get("accept")) ? 200 : 400, doh, "application/dns-json"))
                        .on("^GET /doh\\?name=other\\.nl", c -> new FakeApi.Reply(200, "{\"Status\":0,\"Answer\":[{\"type\":2,\"data\":\"hydrogen.ns.hetzner.com.\"}]}", "application/dns-json"))
                        .json("^GET /desec/domains/vanes\\.nl/$", 404, Json.obj())
                        .json("^POST /desec/domains/$", 201, Json.obj("name", "vanes.nl"))
                        .json("^GET /desec/domains/fout\\.nl/$", 401, Json.obj())
                        .json("^GET /hz/zones\\?name=other\\.nl$", 200, Json.parse("{\"zones\":[{\"authoritative_nameservers\":{\"assigned\":[\"hydrogen.ns.hetzner.com\",\"oxygen.ns.hetzner.com\"]}}]}"))
                        .json("^GET /hz/zones\\?name=leeg\\.nl$", 200, Json.parse("{\"zones\":[]}"));

                T.eq(Arrays.asList("ns1.desec.io", "ns2.desec.org"), DnsSetup.resolveNs("vanes.nl"), "resolveNs falls back to second resolver");
                T.check(DnsSetup.delegated("vanes.nl", Arrays.asList("ns1.desec.io", "NS2.desec.org")), "delegated (case-insensitive)");
                T.check(!DnsSetup.delegated("vanes.nl", Arrays.asList("ns1.desec.io", "ns3.desec.org")), "not delegated");

                Map<String, Object> c = Json.obj("domain", "vanes.nl", "dns", Json.list(), "console", Json.obj());
                DnsSetup.Result r = DnsSetup.configure(c, "desec", " tok ");
                T.eq("{\"ok\":true,\"ns\":[\"ns1.desec.io\",\"ns2.desec.org\"],\"delegated\":true}", Json.stringify(r.toJson()), "deSEC result");
                T.eq("Token tok", api.find("GET /desec/domains/vanes").headers.get("authorization"), "deSEC auth header");
                T.eq("{\"name\":\"vanes.nl\"}", api.find("POST /desec/domains/").rawBody, "deSEC domain created");
                T.eq("[{\"type\":\"desec\",\"name\":\"desec\",\"token\":\"tok\",\"zone\":\"vanes.nl\"}]", Json.stringify(c.get("dns")), "dns config stored");
                T.eq("desec", Json.str(c, "console", "dnsMode"), "dnsMode");
                DnsSetup.configure(c, "desec", "••••tok");
                T.eq("tok", Json.str(c, "dns", 0, "token"), "masked token reuses stored token");

                Map<String, Object> bad = Json.obj("domain", "fout.nl", "console", Json.obj());
                T.throwsWith("deSEC accepteert dit token niet", () -> DnsSetup.configure(bad, "desec", "x"), "deSEC bad token");
                T.throwsWith("Vul je API-token in", () -> DnsSetup.configure(bad, "hetzner", null), "token required");

                Map<String, Object> h = Json.obj("domain", "other.nl", "console", Json.obj());
                DnsSetup.Result hr = DnsSetup.configure(h, "hetzner", "ht");
                T.eq("[hydrogen.ns.hetzner.com, oxygen.ns.hetzner.com]", hr.ns.toString(), "Hetzner nameservers");
                T.eq(Boolean.FALSE, hr.delegated, "Hetzner not yet delegated");
                T.eq("Bearer ht", api.find("GET /hz/zones").headers.get("authorization"), "Hetzner auth");
                T.throwsWith("Maak eerst de zone leeg.nl aan", () -> DnsSetup.configure(Json.obj("domain", "leeg.nl"), "hetzner", "t"), "Hetzner zone missing");
                T.throwsWith("Hetzner accepteert dit token niet", () -> DnsSetup.configure(Json.obj("domain", "zzz.nl"), "hetzner", "t"), "Hetzner error");

                DnsSetup.Result m = DnsSetup.configure(h, "manual", null);
                T.eq("{\"ok\":true,\"ns\":null,\"delegated\":null}", Json.stringify(m.toJson()), "manual mode");
                T.eq("[]", Json.stringify(h.get("dns")), "manual clears dns");
            } finally {
                Endpoints.reset();
            }
        });
    }
}
