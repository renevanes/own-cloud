package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The adapter framework (port of test/adapters.test.ts): Exoscale and OVHcloud against fake APIs that check the
 * signature of every request themselves (computed independently from the documentation, not with the adapter
 * code), Scaleway DNS, registry completeness against catalog.json, and adding an own provider that then shows up in
 * the console (ConsoleApi) everywhere, including the DNS step with a reused key.
 */
public class AdaptersTest {
    static final String EXO_KEY = "EXO29147e9f89102b7ac1e88514", EXO_SECRET = "geheim-exo";
    static final Map<String, Object> OVH = Json.obj("appKey", "ak-123", "appSecret", "as-geheim", "consumerKey", "ck-456", "projectId", "proj-789");
    /** OVH's clock runs ahead: the adapter must use /auth/time. */
    static final long OVH_SKEW = 137;

    public static void main(String[] args) {
        T.main("AdaptersTest", () -> {
            ExoscaleProvider.pollMs = 0;
            OvhProvider.pollMs = 0;
            try (FakeApi api = new FakeApi()) {
                Endpoints.EXOSCALE = api.base() + "/exo/{zone}/v2";
                Endpoints.OVH = api.base() + "/1.0";
                Endpoints.SCALEWAY = api.base() + "/scw";
                Endpoints.DOH = new String[] {api.base() + "/doh"};
                exoscale(api);
                exoscaleSizes(api);
                exoscaleDns(api);
                ovh(api);
                ovhSizes(api);
                ovhDns(api);
                ovhRules();
                scalewayDns(api);
                helpers();
                registry();
                ownProvider(api);
            } finally {
                Endpoints.reset();
            }
        });
    }

    static FakeApi.Reply json(int status, Object j) { return new FakeApi.Reply(status, j == null ? "" : Json.stringify(j), "application/json"); }

    static FakeApi.Reply json(Object j) { return json(200, j); }

    static String hmacB64(String secret, String msg) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(secret.getBytes("UTF-8"), "HmacSHA256"));
        return Base64.getEncoder().encodeToString(m.doFinal(msg.getBytes("UTF-8")));
    }

    static Map<String, String> query(String q) throws Exception {
        Map<String, String> m = new LinkedHashMap<>();
        if (q == null || q.isEmpty()) return m;
        for (String part : q.split("&")) {
            int eq = part.indexOf('=');
            m.put(java.net.URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), "UTF-8"), eq < 0 ? "" : java.net.URLDecoder.decode(part.substring(eq + 1), "UTF-8"));
        }
        return m;
    }

    // ───────── Exoscale: signature as in https://openapi-v2.exoscale.com/topic/topic-api-request-signature ─────────

    static final Pattern EXO_AUTH = Pattern.compile("^EXO2-HMAC-SHA256 credential=([^,]+)(?:,signed-query-args=([^,]*))?,expires=(\\d+),signature=(\\S+)$");

    /** Independently computed: 5-line message, HMAC-SHA256 with the secret, base64. Null = fine, else why not. */
    static String exoCheck(FakeApi.Call c) throws Exception {
        String h = c.headers.get("authorization");
        Matcher m = EXO_AUTH.matcher(h == null ? "" : h);
        if (!m.find()) return "geen EXO2-header";
        if (!EXO_KEY.equals(m.group(1))) return "verkeerde sleutel";
        if (Long.parseLong(m.group(3)) < System.currentTimeMillis() / 1000) return "verlopen";
        List<String> names = m.group(2) == null ? new ArrayList<>() : Arrays.asList(m.group(2).split(";"));
        Map<String, String> q = query(c.query);
        List<String> a = new ArrayList<>(names), b = new ArrayList<>(q.keySet());
        Collections.sort(a);
        Collections.sort(b);
        if (!a.equals(b)) return "signed-query-args klopt niet";
        StringBuilder vals = new StringBuilder();
        for (String n : names) vals.append(q.get(n));
        String msg = c.method + " " + c.path + "\n" + c.rawBody + "\n" + vals + "\n\n" + m.group(3);
        return hmacB64(EXO_SECRET, msg).equals(m.group(4)) ? null : "handtekening klopt niet";
    }

    static final class ExoState {
        final List<Map<String, Object>> sgs = new ArrayList<>();
        final Map<String, Map<String, Object>> instances = new LinkedHashMap<>(); // id → {id, zone, labels, body}
        final Map<String, String> ops = new LinkedHashMap<>();
        final List<Map<String, Object>> domains = new ArrayList<>();
        List<Map<String, Object>> records = new ArrayList<>();
        int n = 0;

        Map<String, Object> op(String ref) {
            String id = "op-" + (++n);
            ops.put(id, ref);
            return Json.obj("id", id, "state", "pending", "reference", Json.obj("id", ref));
        }
    }

    static Map<String, Object> obj(String json) { return Json.parseObject(json); }

    static ExoState exoFake(FakeApi api) {
        api.reset();
        final ExoState st = new ExoState();
        st.domains.add(obj("{\"id\":\"dom-1\",\"unicode-name\":\"vanes.nl\"}"));
        st.records.add(obj("{\"id\":\"r-ns\",\"name\":\"\",\"type\":\"NS\",\"content\":\"ns1.exoscale.ch\",\"ttl\":3600,\"system-record\":true}"));
        st.records.add(obj("{\"id\":\"r-1\",\"name\":\"cloud\",\"type\":\"A\",\"content\":\"1.1.1.1\",\"ttl\":300}"));
        st.records.add(obj("{\"id\":\"r-2\",\"name\":\"cloud\",\"type\":\"A\",\"content\":\"2.2.2.2\",\"ttl\":300}"));
        final Pattern route = Pattern.compile("^/exo/([a-z0-9-]+)/v2(/.*)$");
        api.on("^GET /doh", c -> new FakeApi.Reply(200, "{\"Status\":0,\"Answer\":[]}", "application/dns-json"));
        api.on("^[A-Z]+ /exo/", c -> {
            try {
                Matcher rm = route.matcher(c.path);
                if (!rm.find() || !ExoscaleProvider.ZONES.contains(rm.group(1))) return json(404, Json.obj("message", "onbekende zone"));
                String why = exoCheck(c);
                if (why != null) return json(403, Json.obj("message", why));
                String zone = rm.group(1), p = rm.group(2), k = c.method + " " + p;
                Matcher mm;
                List<Object> all = new ArrayList<Object>(ExoscaleProvider.ZONES);
                if (k.equals("GET /template")) {
                    T.eq("public", query(c.query).get("visibility"), "template query");
                    return json(Json.obj("templates", Json.list(
                            Json.obj("id", "tpl-oud", "name", "Linux Ubuntu 24.04 LTS 64-bit", "created-at", "2024-05-01T00:00:00Z", "zones", all),
                            Json.obj("id", "tpl-nieuw", "name", "Linux Ubuntu 24.04 LTS 64-bit", "created-at", "2025-06-01T00:00:00Z", "zones", all),
                            Json.obj("id", "tpl-22", "name", "Linux Ubuntu 22.04 LTS 64-bit", "created-at", "2026-01-01T00:00:00Z"))));
                }
                if (k.equals("GET /instance-type")) {
                    long gb = 1024L * 1024 * 1024;
                    return json(Json.obj("instance-types", Json.list(
                            Json.obj("id", "it-micro", "family", "standard", "size", "micro", "cpus", 1L, "memory", 512L * 1024 * 1024, "authorized", true, "zones", all),
                            Json.obj("id", "it-small", "family", "standard", "size", "small", "cpus", 2L, "memory", 2 * gb, "authorized", true, "zones", all),
                            Json.obj("id", "it-medium", "family", "standard", "size", "medium", "cpus", 2L, "memory", 4 * gb, "authorized", true, "zones", all),
                            Json.obj("id", "it-large", "family", "standard", "size", "large", "cpus", 4L, "memory", 8 * gb, "authorized", false, "zones", all),
                            Json.obj("id", "it-gpu", "family", "gpu", "size", "small", "cpus", 12L, "memory", 56 * gb, "authorized", true, "zones", Json.list("ch-gva-2")),
                            Json.obj("id", "it-ch", "family", "standard", "size", "huge", "cpus", 8L, "memory", 32 * gb, "authorized", true, "zones", Json.list("ch-gva-2")))));
                }
                if (k.equals("GET /security-group")) {
                    List<Object> l = new ArrayList<>();
                    for (Map<String, Object> g : st.sgs) l.add(Json.obj("id", g.get("id"), "name", g.get("name")));
                    return json(Json.obj("security-groups", l));
                }
                if (k.equals("POST /security-group")) {
                    Map<String, Object> g = Json.obj("id", "sg-" + (++st.n), "name", Json.str(c.json, "name"), "rules", Json.list());
                    st.sgs.add(g);
                    return json(st.op(Json.str(g, "id")));
                }
                if ((mm = Pattern.compile("^POST /security-group/([^/]+)/rules$").matcher(k)).find()) {
                    for (Map<String, Object> g : st.sgs) if (mm.group(1).equals(g.get("id"))) Json.listAt(g, "rules").add(c.json);
                    return json(st.op(mm.group(1)));
                }
                if ((mm = Pattern.compile("^GET /operation/(.+)$").matcher(k)).find()) return json(Json.obj("id", mm.group(1), "state", "success", "reference", Json.obj("id", st.ops.get(mm.group(1)))));
                if (k.equals("POST /instance")) {
                    String id = "inst-" + (++st.n);
                    st.instances.put(id, Json.obj("id", id, "zone", zone, "labels", Json.path(c.json, "labels"), "body", c.json));
                    return json(st.op(id));
                }
                if (k.equals("GET /instance")) {
                    List<Object> l = new ArrayList<>();
                    for (Map<String, Object> i : st.instances.values()) if (zone.equals(i.get("zone"))) l.add(Json.obj("id", i.get("id"), "name", Json.path(i, "body", "name"), "labels", i.get("labels")));
                    return json(Json.obj("instances", l));
                }
                if ((mm = Pattern.compile("^GET /instance/(.+)$").matcher(k)).find()) return json(Json.obj("id", mm.group(1), "public-ip", "194.182.0.7", "ipv6-address", "2a04:c43::7"));
                if ((mm = Pattern.compile("^DELETE /instance/(.+)$").matcher(k)).find()) return st.instances.remove(mm.group(1)) != null ? json(st.op(mm.group(1))) : json(404, Json.obj());
                if ((mm = Pattern.compile("^POST /reverse-dns/instance/(.+)$").matcher(k)).find()) return json(st.op(mm.group(1)));
                // DNS
                if (k.equals("GET /dns-domain")) return json(Json.obj("dns-domains", new ArrayList<Object>(st.domains)));
                if (k.equals("POST /dns-domain")) {
                    Map<String, Object> d = Json.obj("id", "dom-" + (++st.n), "unicode-name", Json.str(c.json, "unicode-name"));
                    st.domains.add(d);
                    return json(st.op(Json.str(d, "id")));
                }
                if (Pattern.compile("^GET /dns-domain/([^/]+)/record$").matcher(k).find()) return json(Json.obj("dns-domain-records", new ArrayList<Object>(st.records)));
                if (Pattern.compile("^POST /dns-domain/([^/]+)/record$").matcher(k).find()) {
                    Map<String, Object> rec = Json.obj("id", "r-" + (++st.n));
                    rec.putAll(Json.asMap(c.json));
                    st.records.add(rec);
                    return json(st.op(Json.str(rec, "id")));
                }
                if ((mm = Pattern.compile("^PUT /dns-domain/([^/]+)/record/(.+)$").matcher(k)).find()) {
                    for (Map<String, Object> r : st.records) if (mm.group(2).equals(r.get("id"))) r.putAll(Json.asMap(c.json));
                    return json(st.op(mm.group(2)));
                }
                if ((mm = Pattern.compile("^DELETE /dns-domain/([^/]+)/record/(.+)$").matcher(k)).find()) {
                    final String id = mm.group(2);
                    st.records.removeIf(r -> id.equals(r.get("id")));
                    return json(st.op(id));
                }
                return json(500, Json.obj("message", "niet nagebootst: " + k));
            } catch (Exception e) {
                return json(500, Json.obj("message", e.toString()));
            }
        });
        return st;
    }

    static List<FakeApi.Call> calls(FakeApi api) {
        synchronized (api.calls) { return new ArrayList<>(api.calls); }
    }

    static void exoscale(FakeApi api) throws Exception {
        ExoState st = exoFake(api);
        Map<String, Object> keys = Json.obj("apiKey", EXO_KEY, "apiSecret", EXO_SECRET);
        Provider p = Providers.make("exoscale", keys);
        Provider.ServerInfo info = p.create(new Provider.CreateSpec("eigen", "n-1a2b3c", "data", "de-fra-1", "standard.small", "#!/bin/bash\necho hoi"));
        String id = st.instances.keySet().iterator().next();
        T.eq("{\"serverId\":\"de-fra-1/" + id + "\",\"ipv4\":\"194.182.0.7\",\"ipv6\":\"2a04:c43::7\",\"country\":\"DE\"}", Json.stringify(info.toJson()), "Exoscale create result");
        boolean sameZone = true, signedQuery = false;
        for (FakeApi.Call c : calls(api)) {
            if (!c.path.startsWith("/exo/de-fra-1/")) sameZone = false;
            if ("visibility=public".equals(c.query) && c.headers.get("authorization").contains("signed-query-args=visibility,")) signedQuery = true;
        }
        T.check(sameZone, "everything in the server's zone");
        T.check(signedQuery, "query parameters are signed too");
        Map<String, Object> inst = Json.map(st.instances.get(id), "body");
        T.eq("#!/bin/bash\necho hoi", new String(Base64.getDecoder().decode(Json.str(inst, "user-data")), "UTF-8"), "user-data in base64");
        String sg = Json.str(st.sgs.get(0), "id");
        T.eq("{\"name\":\"eigen-n-1a2b3c\",\"instance-type\":{\"id\":\"it-small\"},\"template\":{\"id\":\"tpl-nieuw\"},\"disk-size\":25,\"user-data\":\"" + Json.str(inst, "user-data")
                + "\",\"labels\":{\"cluster\":\"eigen\",\"node\":\"n-1a2b3c\",\"kind\":\"data\"},\"security-groups\":[{\"id\":\"" + sg + "\"}],\"public-ip-assignment\":\"inet4\",\"ipv6-enabled\":true,\"auto-start\":true}",
                Json.stringify(inst), "Exoscale instance body (newest Ubuntu 24.04, labels, IPv6, security group)");
        T.eq(1, st.sgs.size(), "security group created once");
        T.eq(4, Json.listAt(st.sgs.get(0), "rules").size(), "four rules");
        T.eq("{\"flow-direction\":\"ingress\",\"protocol\":\"icmpv6\",\"network\":\"::/0\",\"icmp\":{\"type\":-1,\"code\":-1}}", Json.stringify(Json.listAt(st.sgs.get(0), "rules").get(3)), "ICMPv6 rule");

        // Second server (other provider object): the security group is reused.
        Providers.make("exoscale", keys).create(new Provider.CreateSpec("ander", "n-9", "witness", "de-fra-1", "standard.micro", "x"));
        T.eq(1, st.sgs.size(), "security group reused");

        T.eq("[de-fra-1/" + id + "/n-1a2b3c]", p.list("eigen").toString(), "Exoscale list (only this cluster)");
        T.check(p.supportsPtr(), "Exoscale has reverse DNS");
        p.setPtr(info, "mail.vanes.nl");
        T.eq("{\"domain-name\":\"mail.vanes.nl\"}", api.last().rawBody, "PTR body");
        T.eq("/exo/de-fra-1/v2/reverse-dns/instance/" + id, api.last().path, "PTR path");
        p.destroy(info.serverId);
        p.destroy(info.serverId); // already gone: no error
        T.eq("[]", p.list("eigen").toString(), "destroyed");
        T.throwsWith("bestaat niet", () -> p.create(new Provider.CreateSpec("eigen", "n-2", "data", "de-fra-1", "standard.reuze", "x")), "unknown size");
        // Wrong secret: the fake refuses (403) and checking the login fails.
        T.throwsWith("403", () -> Providers.make("exoscale", Json.obj("apiKey", EXO_KEY, "apiSecret", "fout")).list("eigen"), "wrong secret refused");
        T.eq("CH", p.country("ch-gva-2"), "Exoscale country");
    }

    static void exoscaleSizes(FakeApi api) throws Exception {
        exoFake(api);
        List<Catalog.SizeOption> sizes = Catalog.fetchSizes("exoscale", Json.obj("apiKey", EXO_KEY, "apiSecret", EXO_SECRET), "at-vie-1");
        List<String> got = new ArrayList<>();
        for (Catalog.SizeOption s : sizes) got.add(Json.stringify(Json.list(s.size, s.ramGb, s.cpus, s.monthly)));
        T.eq("[[\"standard.micro\",0.5,1,null], [\"standard.small\",2,2,null], [\"standard.medium\",4,2,null]]", got.toString(), "Exoscale sizes (standard, allowed, in the zone, no price)");
        T.eq("0.5", Json.numberToString(sizes.get(0).ramGb), "ramGb 0.5");
        T.eq("1 vCPU, 0.5 GB", sizes.get(0).label, "label");
        T.eq("standard.small", Catalog.pickSize(sizes, "data").size, "pickSize data");
        T.eq("standard.micro", Catalog.pickSize(sizes, "witness").size, "pickSize witness");
    }

    static void exoscaleDns(FakeApi api) throws Exception {
        ExoState st = exoFake(api);
        Map<String, Object> f = Json.obj("apiKey", EXO_KEY, "apiSecret", EXO_SECRET);
        Adapters.Adapter a = Adapters.get("exoscale");
        T.eq(4, a.dns.connect.connect(f, "vanes.nl").size(), "four nameservers");
        boolean posted = false;
        for (FakeApi.Call c : calls(api)) if (c.method.equals("POST")) posted = true;
        T.check(!posted, "existing zone not created again");
        a.dns.connect.connect(f, "nieuw.nl");
        boolean created = false;
        for (Map<String, Object> d : st.domains) if ("nieuw.nl".equals(d.get("unicode-name"))) created = true;
        T.check(created, "zone created");
        T.throwsWith("Exoscale accepteert deze sleutel niet voor DNS", () -> a.dns.connect.connect(Json.obj("apiKey", EXO_KEY, "apiSecret", "fout"), "vanes.nl"), "bad key for DNS");

        DnsProvider dns = Adapters.makeDns(Json.obj("type", "exoscale", "name", "exo", "zone", "vanes.nl", "fields", f));
        api.calls.clear();
        dns.setRecords("cloud", "A", Arrays.asList("2.2.2.2", "3.3.3.3"), 300);
        List<String> writes = new ArrayList<>();
        for (FakeApi.Call c : calls(api)) if (!c.method.equals("GET")) writes.add(c.method + " " + c.path.substring(c.path.lastIndexOf('/') + 1));
        T.eq("[PUT r-1]", writes.toString(), "2.2.2.2 stays, 1.1.1.1 becomes 3.3.3.3");
        List<String> cloud = new ArrayList<>();
        for (Map<String, Object> r : st.records) if ("cloud".equals(r.get("name"))) cloud.add(Json.str(r, "content"));
        Collections.sort(cloud);
        T.eq("[2.2.2.2, 3.3.3.3]", cloud.toString(), "cloud records");

        dns.setRecords("", "MX", Collections.singletonList("10 mail.vanes.nl."), 3600);
        dns.setRecords("", "TXT", Collections.singletonList("\"v=spf1 a:mail.vanes.nl -all\""), 3600);
        dns.setRecords("eigen._domainkey", "TXT", Collections.singletonList("\"v=DKIM1; k=rsa; p=AAA\" \"BBB\""), 3600);
        Map<String, Object> mx = null, spf = null, dkim = null;
        for (Map<String, Object> r : st.records) {
            if ("MX".equals(r.get("type"))) mx = r;
            if ("TXT".equals(r.get("type")) && "".equals(r.get("name"))) spf = r;
            if ("eigen._domainkey".equals(r.get("name"))) dkim = r;
        }
        T.eq("{\"id\":\"" + Json.str(mx, "id") + "\",\"name\":\"\",\"type\":\"MX\",\"content\":\"mail.vanes.nl\",\"ttl\":3600,\"priority\":10}", Json.stringify(mx), "MX without dot, with priority");
        T.eq("v=spf1 a:mail.vanes.nl -all", Json.str(spf, "content"), "TXT without quotes");
        T.eq("v=DKIM1; k=rsa; p=AAABBB", Json.str(dkim, "content"), "long TXT joined");

        api.calls.clear();
        dns.setRecords("", "MX", Collections.singletonList("10 mail.vanes.nl."), 3600);
        boolean wrote = false;
        for (FakeApi.Call c : calls(api)) if (!c.method.equals("GET")) wrote = true;
        T.check(!wrote, "nothing changed: nothing written");
        dns.setRecords("cloud", "A", Collections.<String>emptyList(), 300);
        boolean anyCloud = false, ns = false;
        for (Map<String, Object> r : st.records) {
            if ("cloud".equals(r.get("name"))) anyCloud = true;
            if ("NS".equals(r.get("type"))) ns = true;
        }
        T.check(!anyCloud, "empty list removes the records");
        T.check(ns, "system records stay");
        T.throwsWith("Exoscale DNS: zone elders.nl niet gevonden", () -> Adapters.makeDns(Json.obj("type", "exoscale", "name", "x", "zone", "elders.nl", "fields", f)).setRecords("", "A", Arrays.asList("1.1.1.1"), 300), "unknown zone");
    }

    // ───────── OVHcloud: "$1$" + sha1(AS+CK+METHOD+URL+BODY+TS) ─────────

    static String ovhCheck(FakeApi api, FakeApi.Call c) throws Exception {
        if (!"ak-123".equals(c.headers.get("x-ovh-application"))) return "verkeerde application key";
        if (!"ck-456".equals(c.headers.get("x-ovh-consumer"))) return "verkeerde consumer key";
        long ts = Long.parseLong(c.headers.get("x-ovh-timestamp"));
        if (Math.abs(ts - (System.currentTimeMillis() / 1000 + OVH_SKEW)) > 5) return "tijd klopt niet";
        String url = api.base() + c.url();
        String plain = "as-geheim+ck-456+" + c.method + "+" + url + "+" + c.rawBody + "+" + ts;
        StringBuilder hex = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-1").digest(plain.getBytes("UTF-8"))) hex.append(String.format("%02x", b));
        return ("$1$" + hex).equals(c.headers.get("x-ovh-signature")) ? null : "handtekening klopt niet";
    }

    static final class OvhState {
        final Map<String, Map<String, Object>> instances = new LinkedHashMap<>();
        final Map<String, Object> bodies = new LinkedHashMap<>();
        List<Map<String, Object>> records = new ArrayList<>();
        int refreshes = 0, n = 100, polls = 0;
    }

    static OvhState ovhFake(final FakeApi api) {
        api.reset();
        final OvhState st = new OvhState();
        st.records.add(obj("{\"id\":1,\"subDomain\":\"cloud\",\"fieldType\":\"A\",\"target\":\"9.9.9.9\",\"ttl\":300}"));
        st.records.add(obj("{\"id\":2,\"subDomain\":\"\",\"fieldType\":\"TXT\",\"target\":\"\\\"oud\\\"\",\"ttl\":3600}"));
        st.records.add(obj("{\"id\":3,\"subDomain\":\"www\",\"fieldType\":\"TXT\",\"target\":\"\\\"blijft\\\"\",\"ttl\":3600}"));
        final Set<String> zones = new HashSet<>(Arrays.asList("vanes.nl", "vanes.test"));
        api.on("^GET /doh", c -> new FakeApi.Reply(200, "{\"Status\":0,\"Answer\":[]}", "application/dns-json"));
        api.on("^[A-Z]+ /1\\.0/", c -> {
            try {
                String p = c.path.substring(4), k = c.method + " " + p;
                Map<String, String> q = query(c.query);
                if (k.equals("GET /auth/time")) return json(System.currentTimeMillis() / 1000 + OVH_SKEW);
                if (k.equals("GET /order/catalog/public/cloud")) return json(obj("{\"addons\":[{\"planCode\":\"d2-2.consumption\",\"pricings\":[{\"price\":1000000}]},{\"planCode\":\"b3-8.consumption\",\"pricings\":[{\"price\":4000000}]}]}"));
                String why = ovhCheck(api, c);
                if (why != null) return json(403, Json.obj("message", why));
                Matcher mm;
                String pr = "/cloud/project/proj-789";
                if (k.equals("GET " + pr + "/image")) {
                    T.check(q.get("region") != null && q.get("region").matches("^(GRA11|DE1)$"), "image region");
                    T.eq("linux", q.get("osType"), "image osType");
                    return json(Json.parse("[{\"id\":\"img-22\",\"name\":\"Ubuntu 22.04\"},{\"id\":\"img-24\",\"name\":\"Ubuntu 24.04\"},{\"id\":\"img-24w\",\"name\":\"Ubuntu 24.04 - Docker\"}]"));
                }
                if (k.equals("GET " + pr + "/flavor")) return json(Json.parse("["
                        + "{\"id\":\"fl-d2-2\",\"name\":\"d2-2\",\"ram\":2,\"vcpus\":1,\"osType\":\"linux\",\"available\":true,\"planCodes\":{\"hourly\":\"d2-2.consumption\",\"monthly\":\"d2-2.monthly\"}},"
                        + "{\"id\":\"fl-b3-8\",\"name\":\"b3-8\",\"ram\":8,\"vcpus\":2,\"osType\":\"linux\",\"available\":true,\"planCodes\":{\"hourly\":\"b3-8.consumption\"}},"
                        + "{\"id\":\"fl-d2-4\",\"name\":\"d2-4\",\"ram\":4,\"vcpus\":2,\"osType\":\"linux\",\"available\":true,\"planCodes\":{\"hourly\":\"onbekend\"}},"
                        + "{\"id\":\"fl-win\",\"name\":\"win-b2-7\",\"ram\":7,\"vcpus\":2,\"osType\":\"windows\",\"available\":true},"
                        + "{\"id\":\"fl-gpu\",\"name\":\"t1-45\",\"ram\":45,\"vcpus\":8,\"osType\":\"linux\",\"available\":true},"
                        + "{\"id\":\"fl-weg\",\"name\":\"d2-8\",\"ram\":8,\"vcpus\":4,\"osType\":\"linux\",\"available\":false}]"));
                if (k.equals("POST " + pr + "/instance")) {
                    String id = "i-" + (++st.n);
                    Map<String, Object> i = Json.obj("id", id, "name", Json.str(c.json, "name"), "region", Json.str(c.json, "region"), "status", "BUILD", "ipAddresses", Json.list());
                    st.instances.put(id, i);
                    st.bodies.put(id, c.json);
                    return json(i);
                }
                if (k.equals("GET " + pr + "/instance")) return json(new ArrayList<Object>(st.instances.values()));
                if ((mm = Pattern.compile("^GET /cloud/project/proj-789/instance/(.+)$").matcher(k)).find()) {
                    Map<String, Object> i = st.instances.get(mm.group(1));
                    if (++st.polls >= 2) {
                        i.put("status", "ACTIVE");
                        i.put("ipAddresses", Json.parse("[{\"ip\":\"10.0.0.5\",\"type\":\"private\",\"version\":4},{\"ip\":\"51.38.0.9\",\"type\":\"public\",\"version\":4},{\"ip\":\"2001:41d0::9\",\"type\":\"public\",\"version\":6}]"));
                    }
                    return json(i);
                }
                if ((mm = Pattern.compile("^DELETE /cloud/project/proj-789/instance/(.+)$").matcher(k)).find()) return st.instances.remove(mm.group(1)) != null ? json(null) : json(404, Json.obj("message", "weg"));
                // DNS
                if ((mm = Pattern.compile("^GET /domain/zone/([^/]+)$").matcher(k)).find()) {
                    if (!zones.contains(mm.group(1))) return json(404, Json.obj("message", "niet gevonden"));
                    return json(Json.obj("name", mm.group(1), "nameServers", Json.list("dns11.ovh.net", "ns11.ovh.net")));
                }
                if ((mm = Pattern.compile("^GET /domain/zone/([^/]+)/record$").matcher(k)).find()) {
                    List<Object> ids = new ArrayList<>();
                    for (Map<String, Object> x : st.records) if (q.get("fieldType").equals(x.get("fieldType")) && (!q.containsKey("subDomain") || q.get("subDomain").equals(x.get("subDomain")))) ids.add(x.get("id"));
                    return json(ids);
                }
                if ((mm = Pattern.compile("^GET /domain/zone/([^/]+)/record/(\\d+)$").matcher(k)).find()) {
                    for (Map<String, Object> x : st.records) if (Long.parseLong(mm.group(2)) == ((Number) x.get("id")).longValue()) {
                        Map<String, Object> r = Json.obj("zone", mm.group(1));
                        r.putAll(x);
                        return json(r);
                    }
                    return json(404, Json.obj());
                }
                if ((mm = Pattern.compile("^DELETE /domain/zone/([^/]+)/record/(\\d+)$").matcher(k)).find()) {
                    final long id = Long.parseLong(mm.group(2));
                    st.records.removeIf(x -> ((Number) x.get("id")).longValue() == id);
                    return json(null);
                }
                if (Pattern.compile("^POST /domain/zone/([^/]+)/record$").matcher(k).find()) {
                    Map<String, Object> rec = Json.obj("id", (long) ++st.n);
                    rec.putAll(Json.asMap(c.json));
                    st.records.add(rec);
                    return json(rec);
                }
                if (Pattern.compile("^POST /domain/zone/([^/]+)/refresh$").matcher(k).find()) {
                    st.refreshes++;
                    return json(null);
                }
                return json(500, Json.obj("message", "niet nagebootst: " + k));
            } catch (Exception e) {
                return json(500, Json.obj("message", e.toString()));
            }
        });
        return st;
    }

    static Map<String, Object> ovhWith(String k, Object v) {
        Map<String, Object> m = Json.copy(OVH);
        m.put(k, v);
        return m;
    }

    static void ovh(FakeApi api) throws Exception {
        OvhState st = ovhFake(api);
        Provider p = Providers.make("ovh", Json.copy(OVH));
        Provider.ServerInfo info = p.create(new Provider.CreateSpec("eigen", "n-a1b2c3", "data", "GRA11", "d2-2", "#!/bin/bash\necho hoi"));
        T.eq("{\"serverId\":\"i-101\",\"ipv4\":\"51.38.0.9\",\"ipv6\":\"2001:41d0::9\",\"country\":\"FR\"}", Json.stringify(info.toJson()), "OVH create result (waits for the public IPv4)");
        int times = 0;
        for (FakeApi.Call c : calls(api)) if (c.path.equals("/1.0/auth/time")) times++;
        T.eq(1, times, "server time asked once");
        T.eq("{\"name\":\"eigen-n-a1b2c3\",\"region\":\"GRA11\",\"flavorId\":\"fl-d2-2\",\"imageId\":\"img-24\",\"userData\":\"#!/bin/bash\\necho hoi\",\"monthlyBilling\":false}", Json.stringify(st.bodies.get("i-101")), "OVH instance body");

        p.create(new Provider.CreateSpec("eigen-x", "n-1", "witness", "DE1", "d2-2", "x"));
        st.instances.put("i-hand", Json.obj("id", "i-hand", "name", "eigen-mijn-eigen-server"));
        T.eq("[i-101/n-a1b2c3]", p.list("eigen").toString(), "other clusters and hand-made servers stay out of view");
        T.eq("[i-102/n-1]", p.list("eigen-x").toString(), "list eigen-x");
        T.eq("DE", p.country("DE1"), "country DE1");
        T.eq("PL", p.country("WAW1"), "country WAW1");
        T.eq("GB", p.country("UK1"), "country UK1");
        T.eq("FR", p.country("SBG5"), "country SBG5");
        p.destroy("i-101");
        p.destroy("i-101");
        T.eq("[]", p.list("eigen").toString(), "destroyed");
        T.check(!p.supportsPtr(), "no PTR via the API");
        T.throwsWith("403", () -> Providers.make("ovh", ovhWith("appSecret", "fout")).list("eigen"), "wrong secret refused");
        T.throwsWith("project-ID", () -> Providers.make("ovh", ovhWith("projectId", "")), "project id required");
        T.throwsWith("OVHcloud: formaat d9-9 bestaat niet in GRA11", () -> p.create(new Provider.CreateSpec("eigen", "n-2", "data", "GRA11", "d9-9", "x")), "unknown flavour");
    }

    static void ovhSizes(FakeApi api) throws Exception {
        ovhFake(api);
        List<Catalog.SizeOption> sizes = Catalog.fetchSizes("ovh", Json.copy(OVH), "GRA11");
        List<String> got = new ArrayList<>();
        for (Catalog.SizeOption s : sizes) got.add(Json.stringify(Json.list(s.size, s.ramGb, s.cpus, s.monthly)));
        T.eq("[[\"d2-2\",2,1,7.3], [\"d2-4\",4,2,null], [\"b3-8\",8,2,29.2]]", got.toString(), "OVH sizes and prices from the public catalogue");
        T.check(!api.find("order/catalog").headers.containsKey("x-ovh-signature"), "catalogue without key");
        T.eq("d2-2", Catalog.pickSize(sizes, "data").size, "pickSize data");
    }

    static void ovhDns(FakeApi api) throws Exception {
        OvhState st = ovhFake(api);
        Adapters.Adapter a = Adapters.get("ovh");
        T.eq("[dns11.ovh.net, ns11.ovh.net]", a.dns.connect.connect(OVH, "vanes.nl").toString(), "OVH nameservers");
        T.throwsWith("staat niet bij OVHcloud", () -> a.dns.connect.connect(OVH, "elders.nl"), "zone missing");
        T.throwsWith("accepteert deze sleutels niet", () -> a.dns.connect.connect(ovhWith("consumerKey", "fout"), "vanes.nl"), "bad keys");

        DnsProvider dns = Adapters.makeDns(Json.obj("type", "ovh", "name", "ovh", "zone", "vanes.nl", "fields", Json.obj("appKey", "ak-123", "appSecret", "as-geheim", "consumerKey", "ck-456")));
        dns.setRecords("cloud", "A", Arrays.asList("1.2.3.4", "5.6.7.8"), 300);
        List<String> cloud = new ArrayList<>();
        for (Map<String, Object> r : st.records) if ("cloud".equals(r.get("subDomain"))) cloud.add(Json.str(r, "target"));
        Collections.sort(cloud);
        T.eq("[1.2.3.4, 5.6.7.8]", cloud.toString(), "A records replaced");
        T.eq(1, st.refreshes, "zone refreshed");
        dns.setRecords("", "TXT", Collections.singletonList("\"v=spf1 a:mail.vanes.nl -all\""), 3600);
        List<String> txt = new ArrayList<>();
        for (Map<String, Object> r : st.records) if ("TXT".equals(r.get("fieldType"))) txt.add(r.get("subDomain") + "=" + r.get("target"));
        Collections.sort(txt);
        T.eq("[=\"v=spf1 a:mail.vanes.nl -all\", www=\"blijft\"]", txt.toString(), "only the right name replaced");
        dns.setRecords("", "MX", Collections.singletonList("10 mail.vanes.nl."), 3600);
        String mx = null;
        for (Map<String, Object> r : st.records) if ("MX".equals(r.get("fieldType"))) mx = Json.str(r, "target");
        T.eq("10 mail.vanes.nl.", mx, "MX in zone-file notation");
        int before = st.refreshes;
        dns.setRecords("cloud", "A", Arrays.asList("5.6.7.8", "1.2.3.4"), 300);
        T.eq(before, st.refreshes, "already right: no change and no refresh");
        T.check(api.find("^DELETE .*/record/3$") == null, "www record untouched");
        T.eq("{\"fieldType\":\"MX\",\"subDomain\":\"\",\"target\":\"10 mail.vanes.nl.\",\"ttl\":3600}", lastMatching(api, "^POST /1\\.0/domain/zone/vanes\\.nl/record$").rawBody, "record body");
    }

    static FakeApi.Call lastMatching(FakeApi api, String regex) {
        Pattern p = Pattern.compile(regex);
        FakeApi.Call hit = null;
        for (FakeApi.Call c : calls(api)) if (p.matcher(c.method + " " + c.url()).find()) hit = c;
        return hit;
    }

    static void ovhRules() {
        List<String[]> rules = OvhProvider.accessRules("proj-789", "vanes.nl");
        String[][] used = {
                {"GET", "/cloud/project/proj-789/image"}, {"GET", "/cloud/project/proj-789/flavor"}, {"POST", "/cloud/project/proj-789/instance"},
                {"GET", "/cloud/project/proj-789/instance"}, {"GET", "/cloud/project/proj-789/instance/i-1"}, {"DELETE", "/cloud/project/proj-789/instance/i-1"},
                {"GET", "/domain/zone/vanes.nl"}, {"GET", "/domain/zone/vanes.nl/record"}, {"GET", "/domain/zone/vanes.nl/record/1"},
                {"POST", "/domain/zone/vanes.nl/record"}, {"DELETE", "/domain/zone/vanes.nl/record/1"}, {"POST", "/domain/zone/vanes.nl/refresh"}};
        for (String[] u : used) {
            boolean covered = false;
            for (String[] r : rules) {
                if (!r[0].equals(u[0])) continue;
                if (r[1].equals(u[1]) || (r[1].endsWith("/*") && u[1].startsWith(r[1].substring(0, r[1].length() - 1)))) covered = true;
            }
            T.check(covered, "access rules cover " + u[0] + " " + u[1]);
        }
    }

    // ───────── Scaleway DNS ─────────

    static void scalewayDns(FakeApi api) throws Exception {
        api.reset();
        final List<Object> bodies = new ArrayList<>();
        api.on("^[A-Z]+ /scw/", c -> {
            if (!"sk".equals(c.headers.get("x-auth-token"))) return json(401, Json.obj());
            if (c.method.equals("GET") && c.path.equals("/scw/domain/v2beta1/dns-zones")) {
                boolean hit = "dns_zone=vanes.nl".equals(c.query);
                return json(Json.obj("dns_zones", hit ? Json.list(Json.obj("domain", "vanes.nl", "subdomain", "", "ns", Json.list("ns0.dom.scw.cloud", "ns1.dom.scw.cloud"), "project_id", "proj-1")) : Json.list()));
            }
            if (c.method.equals("GET") && c.path.equals("/scw/account/v3/projects/proj-1")) return json(Json.obj("id", "proj-1", "organization_id", "org-1"));
            if (c.method.equals("PATCH") && c.path.equals("/scw/domain/v2beta1/dns-zones/vanes.nl/records")) {
                bodies.add(c.json);
                return json(Json.obj("records", Json.list()));
            }
            return json(500, Json.obj());
        });
        Adapters.Adapter a = Adapters.get("scaleway");
        Map<String, Object> f = Json.obj("secretKey", "sk");
        T.eq("[ns0.dom.scw.cloud, ns1.dom.scw.cloud]", a.dns.connect.connect(f, "vanes.nl").toString(), "Scaleway nameservers");
        T.eq("org-1", f.get("organizationId"), "organization ID looked up (Caddy DNS-01)");
        Map<String, Object> given = Json.obj("secretKey", "sk", "organizationId", "eigen");
        a.dns.connect.connect(given, "vanes.nl");
        T.eq("eigen", given.get("organizationId"), "given organization ID kept");
        T.throwsWith("Domains and DNS", () -> a.dns.connect.connect(Json.obj("secretKey", "sk"), "elders.nl"), "zone missing");
        T.throwsWith("accepteert deze sleutel niet", () -> a.dns.connect.connect(Json.obj("secretKey", "fout"), "vanes.nl"), "bad key");
        DnsProvider dns = Adapters.makeDns(Json.obj("type", "scaleway", "name", "scw", "zone", "vanes.nl", "fields", Json.obj("secretKey", "sk")));
        dns.setRecords("", "MX", Collections.singletonList("10 mail.vanes.nl."), 3600);
        dns.setRecords("", "TXT", Collections.singletonList("\"v=spf1 a:mail.vanes.nl -all\""), 3600);
        dns.setRecords("cloud", "AAAA", Collections.<String>emptyList(), 300);
        T.eq("[{\"changes\":[{\"set\":{\"id_fields\":{\"name\":\"\",\"type\":\"MX\"},\"records\":[{\"name\":\"\",\"type\":\"MX\",\"ttl\":3600,\"data\":\"mail.vanes.nl.\",\"priority\":10}]}}],\"return_all_records\":false},"
                + "{\"changes\":[{\"set\":{\"id_fields\":{\"name\":\"\",\"type\":\"TXT\"},\"records\":[{\"name\":\"\",\"type\":\"TXT\",\"ttl\":3600,\"data\":\"v=spf1 a:mail.vanes.nl -all\"}]}}],\"return_all_records\":false},"
                + "{\"changes\":[{\"delete\":{\"id_fields\":{\"name\":\"cloud\",\"type\":\"AAAA\"}}}],\"return_all_records\":false}]",
                Json.stringify(bodies), "Scaleway DNS bodies (set / delete)");
    }

    static void helpers() throws Exception {
        T.eq("ab", DnsProvider.unquoteTxt("\"a\" \"b\""), "unquoteTxt");
        T.eq("v=x", DnsProvider.unquoteTxt("v=x"), "unquoteTxt plain");
        T.eq(20L, DnsProvider.parseMx(" 20 mx.example.org. ").priority, "parseMx priority");
        T.eq("mx.example.org", DnsProvider.parseMx("20 mx.example.org.").host, "parseMx host");
        T.eq("mail.x.nl", DnsProvider.parseMx("mail.x.nl.").host, "parseMx without priority");
        T.eq(10L, DnsProvider.parseMx("mail.x.nl.").priority, "parseMx default priority");
        T.throwsWith("Onbekende DNS-aanbieder bestaatniet", () -> Adapters.makeDns(Json.obj("type", "bestaatniet", "name", "x")).setRecords("", "A", Arrays.asList("1.1.1.1"), 300), "unknown DNS type fails on use");
        String c = CloudInit.caddyfile(Json.obj("domain", "vanes.nl", "dns", Json.list(Json.obj("type", "ovh", "name", "o", "fields", Json.obj("appKey", "a")))));
        T.check(!c.contains("tls"), "OVH without all keys: HTTP-01");
        c = CloudInit.caddyfile(Json.obj("domain", "vanes.nl", "dns", Json.list(Json.obj("type", "exoscale", "name", "e", "fields", Json.obj("apiKey", "EXO1", "apiSecret", "x")))));
        T.check(!c.contains("tls"), "no Caddy module for Exoscale: HTTP-01");
        c = CloudInit.caddyfile(Json.obj("domain", "vanes.nl", "dns", Json.list(Json.obj("type", "scaleway", "name", "s"), Json.obj("type", "hetzner", "name", "h", "token", "htok"))));
        T.check(c.contains("tls {\n\t\tdns hetzner htok\n\t}"), "first DNS link with a complete Caddy line");
        c = CloudInit.caddyfile(Json.obj("domain", "vanes.nl", "dns", Json.list(Json.obj("type", "ovh", "name", "o", "fields", Json.obj("appKey", "ak", "appSecret", "as", "consumerKey", "ck")))));
        T.check(c.contains("tls {\n\t\tdns ovh {\n\t\t\tendpoint ovh-eu\n\t\t\tapplication_key ak\n\t\t\tapplication_secret as\n\t\t\tconsumer_key ck\n\t\t}\n\t}"), "OVH DNS-01");
        c = CloudInit.caddyfile(Json.obj("domain", "vanes.nl", "dns", Json.list(Json.obj("type", "scaleway", "name", "s", "fields", Json.obj("secretKey", "sk", "organizationId", "org-1")))));
        T.check(c.contains("tls {\n\t\tdns scaleway {\n\t\t\tsecret_key sk\n\t\t\torganization_id org-1\n\t\t}\n\t}"), "Scaleway DNS-01");
    }

    // ───────── Registry ─────────

    static Catalog loadCatalog() throws Exception {
        try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file", "../app/src/main/assets/catalog.json"))) { return Catalog.load(in); }
    }

    static void registry() throws Exception {
        Catalog cat = loadCatalog();
        T.eq(2, cat.version(), "catalog.json version 2");
        Set<String> ids = new HashSet<>();
        for (Adapters.Adapter a : Adapters.all()) {
            T.check(ids.add(a.id), "unique id " + a.id);
            T.check(a.id.matches("^[a-z][a-z0-9-]*$"), "id format " + a.id);
            T.check(cat.adapter(a.id) != null, a.id + ": in catalog.json");
        }
        for (Map<String, Object> d : cat.adapters()) {
            String id = Json.str(d, "id");
            Adapters.Adapter a = Adapters.get(id);
            T.check(a != null, id + ": Java adapter exists (port it to android/core)");
            if (a == null) continue;
            T.eq(Json.path(d, "capabilities", "servers"), a.servers != null, id + ": servers capability matches");
            T.eq(Json.path(d, "capabilities", "storage"), a.storage, id + ": storage capability matches");
            T.eq(Json.path(d, "capabilities", "dns"), a.dns != null, id + ": DNS capability matches");
            // Construct without network.
            Map<String, Object> fields = Json.obj();
            for (Catalog.Field f : Catalog.fields(d)) fields.put(f.key, "x");
            for (Catalog.Field f : Catalog.fields(cat.dnsOffer(id))) fields.put(f.key, "x");
            if (a.servers != null) T.check(Providers.make(id, fields) != null, id + ": provider can be made");
            if (a.dns != null) T.check(Adapters.makeDns(Json.obj("type", id, "name", id, "zone", "vanes.nl", "token", "x", "fields", fields)) != null, id + ": DNS can be made");
            if (a.servers != null) T.check(cat.serverOffer(id) != null && !Json.listAt(cat.serverOffer(id), "regions").isEmpty(), id + ": server offer with regions");
            if (a.dns != null) T.check(cat.dnsOffer(id) != null && !Catalog.fields(cat.dnsOffer(id)).isEmpty(), id + ": DNS offer with fields");
        }
        List<String> servers = new ArrayList<>(), dns = new ArrayList<>(), stores = new ArrayList<>();
        for (Map<String, Object> o : cat.serverOffers()) servers.add(Json.str(o, "id"));
        for (Map<String, Object> o : cat.dnsOffers()) dns.add(Json.str(o, "id") + ":" + Json.str(o, "sharesKeyWith"));
        for (Map<String, Object> o : cat.storeOffers()) stores.add(Json.str(o, "id"));
        T.eq("[scaleway, hetzner, upcloud, exoscale, ovh]", servers.toString(), "server offers");
        T.eq("[desec:null, scaleway:scaleway, hetzner:hetzner, exoscale:exoscale, ovh:ovh]", dns.toString(), "DNS offers");
        T.eq("[scaleway, hetzner, upcloud, exoscale, ovh, custom]", stores.toString(), "store offers");
        T.eq("API-sleutel (begint met EXO)", Catalog.fields(cat.serverOffer("exoscale")).get(0).label, "field label");
        T.check(Catalog.fields(cat.serverOffer("ovh")).get(2).secret, "OVH consumer key is secret");
        T.check(!cat.isSecretField("ovh", "appKey") && cat.isSecretField("ovh", "consumerKey") && cat.isSecretField("exoscale", "apiSecret") && !cat.isSecretField("scaleway", "projectId"), "isSecretField from the field definitions");
        T.check(cat.isSecretField("onbekend", "password") && cat.isSecretField("onbekend", "consumerKey") && !cat.isSecretField("onbekend", "baseDir"), "isSecretField by name for unknown fields");
        T.check(Json.str(cat.storeOffer("exoscale"), "home").equals("CH") && Json.listAt(cat.storeOffer("exoscale"), "regions").size() == 7, "Exoscale storage: 7 zones, home CH");
        T.eq("https://s3.gra.io.cloud.ovh.net", Json.str(cat.storeOffer("ovh"), "regions", 0, "endpoint"), "OVH storage endpoint");
        T.eq(true, Json.path(cat.adapter("scaleway"), "capabilities", "quick"), "Scaleway quick route");
        T.throwsWith("Onbekende aanbieder bestaatniet", () -> Providers.make("bestaatniet", Json.obj()), "unknown provider");
        T.throwsWith("Onbekende aanbieder desec", () -> Providers.make("desec", Json.obj()), "DNS-only adapter has no servers");
    }

    // ───────── Adding an own provider ─────────

    /** A (fake) provider "voorbeeld" with servers, storage and DNS, registered at runtime. */
    static final class VoorbeeldProvider implements Provider {
        static final Map<String, String[]> SERVERS = new LinkedHashMap<>(); // id → {nodeId, cluster}
        private final Map<String, Object> cfg;

        VoorbeeldProvider(Map<String, Object> cfg) {
            if (!Json.truthy(cfg.get("token"))) throw new IllegalArgumentException("token ontbreekt");
            this.cfg = cfg;
        }

        @Override public String name() { return "voorbeeld"; }

        @Override public String country(String region) { return region.startsWith("ams") ? "NL" : "DE"; }

        @Override public ServerInfo create(CreateSpec s) {
            String id = "vb-" + (SERVERS.size() + 1);
            SERVERS.put(id, new String[] {s.nodeId, s.cluster});
            ServerInfo i = new ServerInfo();
            i.serverId = id;
            i.ipv4 = "192.0.2.1";
            i.country = country(s.region);
            return i;
        }

        @Override public void destroy(String id) { SERVERS.remove(id); }

        @Override public List<ServerRef> list(String cluster) throws java.io.IOException {
            if (!"goed".equals(cfg.get("token"))) throw new java.io.IOException("401 token onjuist");
            List<ServerRef> out = new ArrayList<>();
            for (Map.Entry<String, String[]> e : SERVERS.entrySet()) if (e.getValue()[1].equals(cluster)) out.add(new ServerRef(e.getKey(), e.getValue()[0]));
            return out;
        }

        @Override public void setPtr(ServerInfo server, String hostname) { /* none */ }

        @Override public boolean supportsPtr() { return false; }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> call(ConsoleApi api, int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " " + (body == null ? "" : Json.stringify(body)) + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    static void ownProvider(FakeApi api) throws Exception {
        final List<String> dnsLog = new ArrayList<>();
        Adapters.Adapter voorbeeld = new Adapters.Adapter("voorbeeld",
                new Adapters.Servers(VoorbeeldProvider::new, (f, region) -> Arrays.asList(
                        new Catalog.SizeOption("klein", "1 vCPU, 1 GB", 1, 1, 3.0), new Catalog.SizeOption("midden", "2 vCPU, 4 GB", 4, 2, 6.0))),
                true,
                new Adapters.Dns((f, zone) -> {
                    if (!"goed".equals(f.get("token"))) throw new java.io.IOException("Voorbeeld accepteert dit token niet");
                    return Arrays.asList("ns1.voorbeeld.example", "ns2.voorbeeld.example");
                }, (name, f, zone) -> new DnsProvider() {
                    @Override public String name() { return name; }

                    @Override public void setRecords(String sub, String type, List<String> values, int ttl) {
                        dnsLog.add(zone + " " + sub + "/" + type + "=" + String.join(",", values) + " (" + f.get("token") + ")");
                    }
                }, null));
        Runnable unregister = Adapters.register(voorbeeld);
        try {
            // The data part comes from catalog.json (exported from the TS registry); here we add it to a copy.
            Map<String, Object> raw = Json.parseObject(new String(Files.readAllBytes(new File(System.getProperty("catalog.file", "../app/src/main/assets/catalog.json")).toPath()), "UTF-8"));
            Object fields = Json.list(Json.obj("key", "token", "label", "API-token", "secret", true));
            Map<String, Object> common = Json.obj("id", "voorbeeld", "name", "Voorbeeld Cloud", "owner", "Voorbeeld BV (Nederland)", "home", "NL");
            Map<String, Object> server = Json.copy(common);
            server.put("regions", Json.parse("[{\"id\":\"ams-a\",\"label\":\"Amsterdam A\",\"country\":\"NL\",\"city\":\"Amsterdam\"},{\"id\":\"ams-b\",\"label\":\"Amsterdam B\",\"country\":\"NL\",\"city\":\"Amsterdam\"},"
                    + "{\"id\":\"ams-c\",\"label\":\"Amsterdam C\",\"country\":\"NL\",\"city\":\"Amsterdam\"},{\"id\":\"fra\",\"label\":\"Frankfurt\",\"country\":\"DE\",\"city\":\"Frankfurt\"}]"));
            server.put("fields", fields);
            server.put("signupUrl", "https://voorbeeld.example");
            server.put("keyHelp", "Voorbeeld-console → Instellingen → API-token (lezen en schrijven).");
            Json.listAt(raw, "servers").add(server);
            Map<String, Object> dnsOffer = Json.copy(common);
            dnsOffer.put("fields", fields);
            dnsOffer.put("keyHelp", "Voorbeeld-console → Instellingen → API-token (lezen en schrijven).");
            dnsOffer.put("signupUrl", "https://voorbeeld.example");
            dnsOffer.put("sharesKeyWith", "voorbeeld");
            Json.listAt(raw, "dns").add(dnsOffer);
            Map<String, Object> ad = Json.copy(common);
            ad.put("fields", fields);
            ad.put("capabilities", Json.obj("servers", true, "storage", true, "dns", true, "quick", false));
            Json.listAt(raw, "adapters").add(ad);
            Catalog cat = new Catalog(Json.stringify(raw));

            File dir = Files.createTempDirectory("adapters").toFile();
            ConsoleApi console = new ConsoleApi(new File(dir, "kluis.json"), cat, url -> { });
            Map<String, Object> state = call(console, 200, "GET", "/api/state", null);
            List<String> dnsIds = new ArrayList<>();
            for (Object o : Json.listAt(state, "offers", "dns")) dnsIds.add(Json.str(o, "id"));
            T.eq("[desec, scaleway, hetzner, exoscale, ovh, voorbeeld]", dnsIds.toString(), "DNS step offers (from the registry)");
            boolean srv = false;
            for (Object o : Json.listAt(state, "offers", "servers")) if ("voorbeeld".equals(Json.str(o, "id"))) srv = true;
            T.check(srv, "servers step offers voorbeeld");
            T.eq("Exoscale DNS", Json.str(Json.listAt(state, "offers", "dns").get(3), "name"), "DNS offer name");

            call(console, 200, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "appPassword", "mijn-cloud-wachtwoord", "alertEmail", "rene@elders.example", "passphrase", "vier losse woorden hier"));
            Map<String, Object> r = call(console, 400, "POST", "/api/providers", Json.obj("id", "voorbeeld", "fields", Json.obj("token", "fout")));
            T.check(Json.str(r, "error").contains("Inloggen bij Voorbeeld Cloud lukt niet"), "login failure");
            r = call(console, 200, "POST", "/api/providers", Json.obj("id", "voorbeeld", "fields", Json.obj("token", "goed")));
            List<String> regs = new ArrayList<>();
            for (Object x : Json.listAt(r, "regions")) regs.add(Json.str(x, "region") + "=" + Json.str(x, "data", "size"));
            T.eq("[ams-a=midden, ams-b=midden, ams-c=midden, fra=midden]", regs.toString(), "sizes per region");
            T.eq("••••••••goed", Json.str(call(console, 200, "GET", "/api/config", null), "providers", "voorbeeld", "token"), "secret field masked");

            Map<String, Object> presets = call(console, 200, "GET", "/api/presets", null);
            Object nl = Json.listAt(presets, "presets").get(0);
            List<String> pl = new ArrayList<>();
            for (Object x : Json.listAt(nl, "placement")) pl.add(Json.str(x, "provider") + "/" + Json.str(x, "region") + "/" + Json.str(x, "kind"));
            T.eq("[voorbeeld/ams-a/data, voorbeeld/ams-b/data, voorbeeld/ams-c/witness]", pl.toString(), "all in the Netherlands with this provider alone");
            T.eq(15L, Json.path(nl, "monthly"), "monthly 6 + 6 + 3");

            // DNS with the same key as under Servers: nothing to fill in.
            r = call(console, 200, "POST", "/api/dns", Json.obj("mode", "voorbeeld"));
            T.eq("[\"ns1.voorbeeld.example\",\"ns2.voorbeeld.example\"]", Json.stringify(r.get("ns")), "nameservers");
            T.eq(false, r.get("delegated"), "not delegated yet");
            Map<String, Object> conf = call(console, 200, "GET", "/api/config", null);
            T.eq("voorbeeld", conf.get("dnsMode"), "dnsMode");
            T.eq("{\"type\":\"voorbeeld\",\"name\":\"voorbeeld\",\"token\":\"••••••••goed\",\"zone\":\"vanes.test\"}", Json.stringify(Json.listAt(conf, "dns").get(0)), "dns link (token masked)");
            Adapters.makeDns(Json.obj("type", "voorbeeld", "name", "vb", "zone", "vanes.test", "token", "goed")).setRecords("cloud", "A", Arrays.asList("192.0.2.1"), 300);
            T.eq("[vanes.test cloud/A=192.0.2.1 (goed)]", dnsLog.toString(), "records via the own adapter");

            // An unknown or test provider cannot be chosen; a provider without a key asks for its fields.
            T.check(Json.str(call(console, 400, "POST", "/api/dns", Json.obj("mode", "local")), "error").contains("Kies een DNS-aanbieder"), "local refused");
            T.eq("Vul in: API-sleutel (begint met EXO), Geheim", Json.str(call(console, 400, "POST", "/api/dns", Json.obj("mode", "exoscale")), "error"), "exoscale without key");
            T.eq("Vul je API-token in", Json.str(call(console, 400, "POST", "/api/dns", Json.obj("mode", "hetzner", "token", "••••oud")), "error"), "masked token does not count");

            // OVHcloud DNS with fields filled in; then again without: the stored keys are reused.
            OvhState ost = ovhFake(api);
            r = call(console, 200, "POST", "/api/dns", Json.obj("mode", "ovh", "fields", Json.obj("appKey", " ak-123 ", "appSecret", "as-geheim", "consumerKey", "ck-456", "projectId", "genegeerd")));
            T.eq("[\"dns11.ovh.net\",\"ns11.ovh.net\"]", Json.stringify(r.get("ns")), "OVH nameservers");
            conf = call(console, 200, "GET", "/api/config", null);
            T.eq("{\"type\":\"ovh\",\"name\":\"ovh\",\"zone\":\"vanes.test\",\"fields\":{\"appKey\":\"ak-123\",\"appSecret\":\"••••••••heim\",\"consumerKey\":\"••••••••-456\"}}", Json.stringify(Json.listAt(conf, "dns").get(0)), "OVH link: fields stored, secrets masked, no token");
            r = call(console, 200, "POST", "/api/dns", Json.obj("mode", "ovh", "fields", Json.obj("appKey", "", "appSecret", "••••••••heim", "consumerKey", "")));
            T.check(ost.refreshes == 0, "connect only reads");
            T.eq("ovh", Json.str(call(console, 200, "GET", "/api/config", null), "dnsMode"), "OVH again with the stored keys");

            // Exoscale: link servers (login + sizes in all zones), then DNS without filling in anything.
            exoFake(api);
            r = call(console, 200, "POST", "/api/providers", Json.obj("id", "exoscale", "fields", Json.obj("apiKey", EXO_KEY, "apiSecret", EXO_SECRET)));
            T.eq(7, Json.listAt(r, "regions").size(), "Exoscale: 7 zones");
            T.eq("standard.small", Json.str(Json.listAt(r, "regions").get(0), "data", "size"), "Exoscale data size");
            r = call(console, 200, "POST", "/api/dns", Json.obj("mode", "exoscale"));
            T.eq(4, Json.listAt(r, "ns").size(), "Exoscale nameservers");
            conf = call(console, 200, "GET", "/api/config", null);
            T.eq("{\"type\":\"exoscale\",\"name\":\"exoscale\",\"zone\":\"vanes.test\",\"fields\":{\"apiKey\":\"" + EXO_KEY + "\",\"apiSecret\":\"••••••••-exo\"}}", Json.stringify(Json.listAt(conf, "dns").get(0)), "Exoscale DNS with the key from Servers");
            T.eq("••••••••-exo", Json.str(conf, "providers", "exoscale", "apiSecret"), "provider secret masked");
            T.eq(EXO_KEY, Json.str(conf, "providers", "exoscale", "apiKey"), "provider key shown");

            r = call(console, 200, "POST", "/api/dns", Json.obj("mode", "manual"));
            T.eq("{\"ok\":true,\"ns\":null,\"delegated\":null}", Json.stringify(r), "manual");
        } finally {
            unregister.run();
        }
        T.check(Adapters.get("voorbeeld") == null, "unregistered");
    }
}
