package nl.eigencloud.core;

import java.io.FileInputStream;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * S3Store against a real S3-compatible server (moto_server; URL via MOTO_URL), plus the admin functions that
 * use storage: prepareStore, saveAdminCopy/recoverAdminConfig, readManifest (TS-sealed) and
 * provisionFirstNode (fake Hetzner API, real bootstrap object in S3 fetched via its presigned URL).
 */
public class S3MotoTest {
    static Map<String, Object> store(String endpoint, String name, String bucket, String purpose) {
        return Json.obj("name", name, "type", "s3", "purpose", purpose, "country", "NL", "endpoint", endpoint, "region", "us-east-1",
                "bucket", bucket, "accessKey", "testing", "secretKey", "testing");
    }

    public static void main(String[] args) {
        T.main("S3MotoTest", () -> {
            String moto = T.env("MOTO_URL");
            if (moto == null) throw new IllegalStateException("MOTO_URL niet gezet");
            Map<String, Object> g = T.golden();
            String suffix = Bytes.hex(Bytes.random(3));

            // ── Basic object operations ──
            S3Store s = new S3Store(store(moto, "moto", "basis-" + suffix, "replica"));
            T.check(!s.bucketExists(), "bucket does not exist yet");
            s.createBucket(false);
            T.check(s.bucketExists(), "bucket created");
            s.createBucket(false); // again: must not throw (already owned / 200)
            String[] keys = {"a.txt", "a b/c+d=é!'()*~.txt", "x&y<z>\"q'.txt", "dir/sub/😀.bin"};
            for (String k : keys) s.put(k, Bytes.utf8("inhoud van " + k));
            for (String k : keys) T.eq("inhoud van " + k, Bytes.utf8(s.getBuffer(k)), "get " + k);
            T.check(s.head("a.txt"), "head existing");
            T.check(!s.head("bestaat-niet"), "head missing");
            T.eq(null, s.getBuffer("bestaat-niet"), "get missing → null");
            List<ObjectStore.Entry> all = s.list("");
            T.eq(4, all.size(), "list all");
            boolean special = false;
            for (ObjectStore.Entry e : all) if (e.key.equals("x&y<z>\"q'.txt")) special = e.size == ("inhoud van " + e.key).getBytes("UTF-8").length;
            T.check(special, "list unescapes XML and gives sizes");
            T.eq("[dir/sub/😀.bin (" + Bytes.utf8("inhoud van dir/sub/😀.bin").length + ")]", s.list("dir/").toString(), "list with prefix");
            s.delete("a.txt");
            s.delete("bestaat-niet");
            T.check(!s.head("a.txt"), "deleted");
            s.put("leeg", new byte[0]);
            T.eq(0, s.getBuffer("leeg").length, "empty object");

            // Pagination (ListObjectsV2 continuation, > 1000 keys)
            for (int i = 0; i < 1003; i++) s.put("veel/" + String.format("%05d", i), new byte[] {(byte) i});
            List<ObjectStore.Entry> many = s.list("veel/");
            T.eq(1003, many.size(), "list follows continuation tokens");

            // Presigned GET without credentials
            String url = s.presignGet("a b/c+d=é!'()*~.txt", 600);
            Http.Response r = Http.request("GET", url, null, null, 10_000);
            T.eq(200, r.status, "presigned GET status");
            T.eq("inhoud van a b/c+d=é!'()*~.txt", r.text(), "presigned GET body");

            // Store with a key prefix
            Map<String, Object> pc = store(moto, "pre", "basis-" + suffix, "replica");
            pc.put("prefix", "pre/fix/");
            S3Store p = new S3Store(pc);
            p.put("k1", Bytes.utf8("1"));
            T.eq("[k1 (1)]", p.list("").toString(), "prefix stripped in list");
            T.check(s.head("pre/fix/k1"), "prefix applied on put");

            // Versioning + region with LocationConstraint + object-lock bucket
            Map<String, Object> vc = store(moto, "v", "versie-" + suffix, "backup");
            vc.put("region", "eu-west-1");
            S3Store v = new S3Store(vc);
            v.createBucket(true);
            T.check(v.bucketExists(), "bucket with LocationConstraint + object lock");
            T.check(v.putBucketConfig("versioning", "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Status>Enabled</Status></VersioningConfiguration>"), "putBucketConfig versioning");
            Map.Entry<String, Map<String, String>> sig = v.sign("GET", "", Collections.singletonMap("versioning", ""), Collections.<String, String>emptyMap(), System.currentTimeMillis());
            T.check(Http.request("GET", sig.getKey(), sig.getValue(), null, 10_000).text().contains("<Status>Enabled</Status>"), "versioning is enabled");
            T.check(!v.putBucketConfig("lifecycle", "<niet-geldig/>"), "invalid config → false");

            // ── prepareStore ──
            List<Admin.StepResult> rep = Admin.prepareStore(store(moto, "rep", "rep-" + suffix, "replica"));
            T.eq("[✓ Verbinding met " + new S3Store(store(moto, "x", "x", "replica")).endpointHost() + ", ✓ Bucket 'rep-" + suffix + "' aangemaakt, ✓ Schrijven en teruglezen]", rep.toString(), "prepareStore replica");
            List<Admin.StepResult> bak = Admin.prepareStore(store(moto, "bak", "bak-" + suffix, "backup"));
            T.eq(5, bak.size(), "prepareStore backup has 5 steps");
            T.eq("Bucket 'bak-" + suffix + "' aangemaakt (met object-lock)", bak.get(1).label, "backup bucket with object lock");
            T.check(bak.get(2).ok, "backup: versioning on");
            T.check(Admin.storeStepsOk(bak), "backup store accepted");
            List<Admin.StepResult> again = Admin.prepareStore(store(moto, "rep", "rep-" + suffix, "replica"));
            T.eq("Bucket 'rep-" + suffix + "' bestaat al", again.get(1).label, "existing bucket");
            List<Admin.StepResult> down = Admin.prepareStore(store("http://127.0.0.1:1", "dood", "x", "replica"));
            T.eq("Verbinding en inloggen", down.get(0).label, "unreachable store");
            T.check(!down.get(0).ok && !Admin.storeStepsOk(down), "unreachable store refused");

            // ── Admin copy + recovery ──
            String masterHex = Json.str(g, "masterKey");
            Map<String, Object> cfg = Json.copy(Json.map(g, "sampleConfig"));
            cfg.put("stores", Json.list(store(moto, "rep", "rep-" + suffix, "replica"), store(moto, "bak", "bak-" + suffix, "backup")));
            T.eq(2, Admin.saveAdminCopy(cfg), "admin copy in both stores");
            Map<String, Object> rec = Admin.recoverAdminConfig(masterHex, store(moto, "bak", "bak-" + suffix, "backup"));
            T.eq(Json.stringify(cfg), Json.stringify(rec), "recoverAdminConfig");
            T.throwsWith("Deze sleutel past niet bij deze opslag", () -> Admin.recoverAdminConfig(EigenCrypto.randomKeyHex(), store(moto, "bak", "bak-" + suffix, "backup")), "wrong key");
            T.throwsWith("geen Eigen Cloud-configuratie", () -> Admin.recoverAdminConfig(masterHex, store(moto, "v", "versie-" + suffix, "backup")), "no admin copy");
            Map<String, Object> rc = Console.recoverAdminConfig(" " + masterHex.toUpperCase() + " ", store(moto, "rep", "rep-" + suffix, "replica"));
            T.eq("klaar", Json.str(rc, "console", "step"), "console recovery marks done");
            // Bucket vergeten: de console zoekt zelf in alle buckets van deze sleutel.
            Map<String, Object> found = Admin.findAdminConfig(masterHex, store(moto, "zoek", "", "replica"));
            T.eq(Json.str(cfg, "domain"), Json.str(Json.map(found, "config"), "domain"), "findAdminConfig without bucket");
            T.check(Json.str(found, "store", "bucket").endsWith(suffix), "findAdminConfig reports the bucket it used");
            T.throwsWith("past niet", () -> Admin.findAdminConfig(EigenCrypto.randomKeyHex(), store(moto, "zoek", "", "replica")), "wrong key, no bucket");
            Map<String, Object> rc2 = Console.recoverAdminConfig(masterHex, store(moto, "zoek", "", "replica"));
            T.eq("klaar", Json.str(rc2, "console", "step"), "console recovery without bucket");

            // ── readManifest: newest TS-sealed manifest wins ──
            byte[] tsManifest = Bytes.fromBase64(Json.str(Json.listAt(g, "sealJson").get(0), "sealed"));
            new S3Store(store(moto, "rep", "rep-" + suffix, "replica")).put("manifest.enc", tsManifest);
            Map<String, Object> newer = Json.copy(Json.map(Json.listAt(g, "sealJson").get(0), "value"));
            newer.put("updated", 1760000000001L);
            newer.put("term", 4L);
            new S3Store(store(moto, "bak", "bak-" + suffix, "backup")).put("manifest.enc", EigenCrypto.sealJson(ClusterConfig.keysFor(cfg).manifest, newer, "manifest"));
            Map<String, Object> m = Admin.readManifest(cfg);
            T.eq(4L, m.get("term"), "newest manifest");
            T.eq("bak", m.get("_store"), "manifest _store");
            new S3Store(store(moto, "bak", "bak-" + suffix, "backup")).put("manifest.enc", Bytes.utf8("rommel"));
            T.eq("rep", Admin.readManifest(cfg).get("_store"), "broken manifest skipped, TS-sealed one read");

            // ── provisionFirstNode with a fake Hetzner and real storage ──
            new S3Store(store(moto, "rep", "rep-" + suffix, "replica")).put("images/eigen-cloud.tar.gz", Bytes.utf8("image"));
            try (FakeApi api = new FakeApi()) {
                api.json("^POST /v1/servers$", 201, Json.parse("{\"server\":{\"id\":77,\"public_net\":{\"ipv4\":{\"ip\":\"5.6.7.8\"},\"ipv6\":{\"ip\":\"2a01:4f8:1::/64\"}},\"server_type\":{\"prices\":[]}}}"))
                        .json("change_dns_ptr", 201, Json.obj());
                cfg.put("providers", Json.obj("hetzner", Json.obj("token", "tok")));
                Admin.FirstNode fn = new Admin.FirstNode("hetzner", "fsn1", "cx23");
                fn.term = 3;
                fn.initialSettings = Json.obj("mail_from", "rene@vanes.nl");
                Admin.Provisioned pr = Admin.provisionFirstNode(cfg, fn, new HetznerProvider(Json.map(cfg, "providers", "hetzner")).baseUrl(api.base() + "/v1"));
                T.eq("http://5.6.7.8:7946", pr.clusterUrl, "cluster URL");
                T.check(pr.nodeId.matches("n-[0-9a-f]{6}"), "node id");
                String ud = Json.str(api.calls.get(0).json, "user_data");
                T.check(ud.contains("curl -fsSL --retry 5 \"" + moto + "/rep-" + suffix + "/images/eigen-cloud.tar.gz?"), "image URL from storage");
                T.check(ud.contains("docker pull ghcr.io/renevanes/eigen-caddy:latest"), "caddy pulled (not in storage)");
                T.check(!ud.contains(masterHex) && !ud.contains(Json.str(g, "derived", "cluster")), "user-data does not contain the master key");
                Matcher bu = Pattern.compile("BOOTSTRAP_URL=(\\S+)").matcher(ud), jt = Pattern.compile("JOIN_TOKEN=(\\S+)").matcher(ud);
                T.check(bu.find() && jt.find(), "bootstrap URL and token in user-data");
                Http.Response b = Http.request("GET", bu.group(1), null, null, 10_000);
                T.eq(200, b.status, "bootstrap object downloadable via presigned URL");
                Map<String, Object> nodeCfg = Json.asMap(EigenCrypto.openJson(EigenCrypto.deriveKey(Bytes.fromHex(jt.group(1)), "bootstrap"), b.body, "bootstrap"));
                T.eq(pr.nodeId, nodeCfg.get("nodeId"), "node config: nodeId");
                T.eq(Boolean.TRUE, nodeCfg.get("bootstrapLeader"), "node config: bootstrapLeader");
                T.eq(3L, nodeCfg.get("bootstrapTerm"), "node config: term");
                T.check(!nodeCfg.containsKey("console") && !nodeCfg.containsKey("joinToken"), "node config: no console, no joinToken");
                T.eq("{\"clusterUrl\":\"http://5.6.7.8:7946\",\"apiUrl\":\"https://5.6.7.8\",\"ipv4\":\"5.6.7.8\",\"ipv6\":\"2a01:4f8:1::1\"}", Json.stringify(nodeCfg.get("advertise")), "node config: advertise");
                T.eq("{\"provider\":\"hetzner\",\"region\":\"fsn1\",\"size\":\"cx23\",\"serverId\":\"77\",\"country\":\"DE\"}", Json.stringify(nodeCfg.get("selfInfo")), "node config: selfInfo");
                T.eq("{\"mail_from\":\"rene@vanes.nl\"}", Json.stringify(nodeCfg.get("initialSettings")), "node config: initialSettings");
                T.eq(masterHex, nodeCfg.get("masterKey"), "node config carries the master key (encrypted)");
                T.eq(2L, api.calls.stream().filter(c -> c.path.contains("change_dns_ptr")).count(), "PTR set for mail.<domain>");
                T.eq("{\"ip\":\"5.6.7.8\",\"dns_ptr\":\"mail.vanes.nl\"}", api.calls.get(1).rawBody, "PTR body");
            }

            // ── Console store step with the catalog's "custom" offer ──
            Catalog cat;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file", "../app/src/main/assets/catalog.json"))) { cat = Catalog.load(in); }
            Map<String, Object> ac = Console.newAdminConfig("vanes.nl", "rene", null, "lang-genoeg-123");
            Console.StoreSetup st = Console.addStore(ac, cat, "custom", "eigen", moto, "testing", "testing", null, "replica");
            T.check(st.ok, "addStore ok: " + st.steps);
            T.eq("custom-eigen", st.name, "store name");
            T.check(Json.str(ac, "stores", 0, "bucket").matches("vanes-data-[0-9a-f]{6}"), "generated bucket name");
            T.eq("us-east-1", Json.str(ac, "stores", 0, "region"), "custom store region");
            Console.StoreSetup st2 = Console.addStore(ac, cat, "custom", "eigen", moto, "", "", Json.str(ac, "stores", 0, "bucket"), "replica");
            T.check(st2.ok && ClusterConfig.stores(ac).size() == 1, "re-adding reuses keys and replaces the entry");
            T.throwsWith("endpoint-URL", () -> Console.addStore(ac, cat, "custom", "eigen", "ftp://x", "a", "b", null, "replica"), "endpoint validated");
            T.throwsWith("Kies een aanbieder", () -> Console.addStore(ac, cat, "custom", "nergens", moto, "a", "b", null, "replica"), "region validated");
            Console.StoreSetup bad = Console.addStore(ac, cat, "custom", "eigen", "http://127.0.0.1:1", "a", "b", "x", "backup");
            T.check(!bad.ok && ClusterConfig.stores(ac).size() == 1, "failed store not added");
            T.eq("Nog niet klaar: serverplekken gekozen", Console.launchBlocker(withKey(ac)), "launch blocker after store");
        });
    }

    private static Map<String, Object> withKey(Map<String, Object> c) {
        Json.map(c, "console").put("keyConfirmed", true);
        return c;
    }
}
