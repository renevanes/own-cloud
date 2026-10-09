package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/**
 * Pure functions vs TS output: S3 presign (AWS vector + golden) and header signing, cloud-init, Caddyfile,
 * pickSize/buildPresets, recovery sheet, checklist, Dutch dates, PBKDF2 (vault KDF) and scrypt password hash.
 */
public class FormatsGoldenTest {
    private static Catalog.SizeOption size(Object o) { return Catalog.SizeOption.fromJson(Json.asMap(o)); }

    public static void main(String[] args) {
        T.main("FormatsGoldenTest", () -> {
            Map<String, Object> g = T.golden();

            // 4. AWS documented presign vector (virtual-hosted style).
            S3Store aws = new S3Store(Json.obj("name", "aws", "endpoint", "https://s3.amazonaws.com", "region", "us-east-1", "bucket", "examplebucket",
                    "accessKey", "AKIAIOSFODNN7EXAMPLE", "secretKey", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "pathStyle", false));
            String url = aws.presignGet("test.txt", 86400, java.time.Instant.parse("2013-05-24T00:00:00Z").toEpochMilli());
            T.eq("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
                    url, "AWS presign vector");

            for (Object o : Json.listAt(g, "presign")) {
                S3Store s = new S3Store(Json.map(o, "cfg"));
                T.eq(Json.str(o, "url"), s.presignGet(Json.str(o, "key"), Json.num(o, "seconds").intValue(), Json.num(o, "now").longValue()), "presign " + Json.str(o, "cfg", "name") + " " + Json.str(o, "key"));
            }
            for (Object o : Json.listAt(g, "sign")) {
                S3Store s = new S3Store(Json.map(o, "cfg"));
                Map<String, String> q = new java.util.LinkedHashMap<>(), extra = new java.util.LinkedHashMap<>();
                for (Map.Entry<String, Object> e : Json.map(o, "query").entrySet()) q.put(e.getKey(), (String) e.getValue());
                for (Map.Entry<String, Object> e : Json.map(o, "extra").entrySet()) extra.put(e.getKey(), (String) e.getValue());
                Map.Entry<String, Map<String, String>> r = s.sign(Json.str(o, "method"), Json.str(o, "key"), q, extra, Json.num(o, "now").longValue());
                String what = "sign " + Json.str(o, "cfg", "name") + " " + Json.str(o, "method") + " " + Json.str(o, "key");
                T.eq(Json.str(o, "result", "url"), r.getKey(), what + " url");
                T.eq(Json.stringify(Json.map(o, "result", "headers")), Json.stringify(r.getValue()), what + " headers");
            }

            // 6. cloud-init
            for (Object o : Json.listAt(g, "userData")) {
                Map<String, Object> op = Json.map(o, "opts");
                CloudInit.Options opts = new CloudInit.Options(Json.str(op, "nodeId"), Json.str(op, "kind"), Json.str(op, "bootstrapUrl"), Json.str(op, "joinToken"))
                        .images(Json.str(op, "imageUrl"), Json.str(op, "caddyUrl"));
                T.eq(Json.str(o, "out"), CloudInit.userData(Json.map(o, "cfg"), opts), "userData " + Json.str(op, "nodeId"));
            }
            for (Object o : Json.listAt(g, "caddyfile")) T.eq(Json.str(o, "out"), CloudInit.caddyfile(Json.map(o, "cfg")), "caddyfile");

            // 8. pickSize / buildPresets
            for (Object o : Json.listAt(g, "pickSize")) {
                List<Catalog.SizeOption> sizes = new ArrayList<>();
                for (Object s : Json.listAt(o, "sizes")) sizes.add(size(s));
                Catalog.SizeOption r = Catalog.pickSize(sizes, Json.str(o, "kind"));
                T.eq(Json.stringify(Json.path(o, "result")), r == null ? "null" : Json.stringify(r.toJson()), "pickSize " + Json.str(o, "name") + "/" + Json.str(o, "kind"));
            }
            for (Object o : Json.listAt(g, "presets")) {
                List<Catalog.Available> av = new ArrayList<>();
                for (Object a : Json.listAt(o, "available")) {
                    av.add(new Catalog.Available(Json.str(a, "provider"), Catalog.RegionInfo.fromJson(Json.map(a, "region")), size(Json.path(a, "data")), size(Json.path(a, "witness"))));
                }
                List<Object> got = new ArrayList<>();
                for (Catalog.Preset p : Catalog.buildPresets(av)) got.add(p.toJson());
                T.eq(Json.stringify(Json.path(o, "presets")), Json.stringify(got), "buildPresets " + Json.str(o, "name"));
            }

            // Catalog asset exported by scripts/export-catalog.ts
            File asset = new File(System.getProperty("catalog.file", "../app/src/main/assets/catalog.json"));
            try (FileInputStream in = new FileInputStream(asset)) {
                Catalog cat = Catalog.load(in);
                T.check(cat.storeOffers().size() >= 4 && cat.serverOffers().size() >= 3, "catalog.json loaded");
                T.eq("Amsterdam 1", cat.serverRegions("scaleway").get(0).label, "catalog regions");
                T.eq("https://s3.nl-ams.scw.cloud", Json.str(cat.storeOffer("scaleway"), "regions", 0, "endpoint"), "store offer endpoint");
                // available() from a console catalog + placementFor
                Map<String, Object> consoleCat = Json.obj(
                        "scaleway", Json.obj("nl-ams-1", Json.obj("data", Json.obj("size", "DEV1-S", "label", "2 vCPU, 2 GB", "ramGb", 2, "cpus", 2, "monthly", 6.42), "witness", Json.obj("size", "STARDUST1-S", "label", "1 vCPU, 1 GB", "ramGb", 1, "cpus", 1, "monthly", 0.1)),
                                "nl-ams-2", Json.obj("data", Json.obj("size", "DEV1-S", "label", "x", "ramGb", 2, "cpus", 2, "monthly", 6.42), "witness", Json.obj("size", "STARDUST1-S", "label", "x", "ramGb", 1, "cpus", 1, "monthly", 0.1))),
                        "hetzner", Json.obj("hel1", Json.obj("data", Json.obj("size", "cx23", "label", "x", "ramGb", 4, "cpus", 2, "monthly", 4.51), "witness", Json.obj("size", "cx23", "label", "x", "ramGb", 4, "cpus", 2, "monthly", 4.51)),
                                "fsn1", Json.obj("data", Json.obj("size", "cx23", "label", "x", "ramGb", 4, "cpus", 2, "monthly", 4.51), "witness", Json.obj("size", "cx23", "label", "x", "ramGb", 4, "cpus", 2, "monthly", 4.51))));
                List<Catalog.Available> av = cat.available(consoleCat);
                T.eq(4, av.size(), "available() count");
                T.eq("fsn1", av.get(2).region.id, "available() follows offer region order");
                List<Object> pl = Catalog.placementFor("buren", av);
                T.eq("[\"data/scaleway/nl-ams-1\",\"data/hetzner/fsn1\",\"witness/hetzner/hel1\",\"witness/scaleway/nl-ams-1\",\"data/scaleway/nl-ams-2\",\"witness/scaleway/nl-ams-2\",\"witness/hetzner/fsn1\",\"data/hetzner/hel1\"]",
                        Json.stringify(keysOf(pl)), "placementFor(buren) with reserves");
                T.throwsWith("Amsterdam", () -> Catalog.placementFor("nl", av), "placementFor(nl) needs a third NL place");
                List<Object> eu = Catalog.placementFor("europa", av);
                T.eq("hel1", Json.str(eu.get(2), "region"), "placementFor(europa) witness in FI");
                T.throwsWith("Koppel", () -> Catalog.placementFor("europa", cat.available(Json.obj())), "placementFor missing");
            }

            // Recovery sheet and checklist (extracted from src/console/server.ts by golden.ts)
            T.eq(Json.str(g, "sheetDateText"), Console.dutchLongDate(new Date(java.time.Instant.parse("2026-10-09T10:00:00Z").toEpochMilli()), TimeZone.getTimeZone("UTC")), "Dutch long date");
            for (Object o : Json.listAt(g, "dates")) {
                T.eq(Json.str(o, "text"), Console.dutchLongDate(new Date(Json.num(o, "t").longValue()), TimeZone.getTimeZone("UTC")), "date " + Json.str(o, "text"));
            }
            for (Object o : Json.listAt(g, "sheets")) {
                T.eq(Json.str(o, "html"), Console.recoverySheet(Json.map(o, "cfg"), Json.str(g, "sheetDateText")), "recoverySheet " + Json.str(o, "cfg", "cluster"));
            }
            for (Object o : Json.listAt(g, "checklists")) {
                List<Object> got = new ArrayList<Object>(Console.checklist(Json.copy(Json.map(o, "cfg"))));
                T.eq(Json.stringify(Json.path(o, "out")), Json.stringify(got), "checklist");
            }

            // Vault KDF (PBKDF2-HMAC-SHA256 over NFKC) and scrypt password hash
            for (Object o : Json.listAt(g, "pbkdf2")) {
                byte[] k = Vault.deriveKey(Json.str(o, "pass"), Bytes.fromBase64(Json.str(o, "salt")), Json.num(o, "iter").intValue());
                T.eq(Json.str(o, "key"), Bytes.hex(k), "PBKDF2 " + Json.str(o, "pass"));
                byte[] manual = Scrypt.pbkdf2(Bytes.utf8(java.text.Normalizer.normalize(Json.str(o, "pass"), java.text.Normalizer.Form.NFKC)), Bytes.fromBase64(Json.str(o, "salt")), Math.min(1000, Json.num(o, "iter").intValue()), 32);
                if (Json.num(o, "iter").intValue() <= 1000) T.eq(Json.str(o, "key"), Bytes.hex(manual), "manual PBKDF2 " + Json.str(o, "pass"));
            }
            for (Object o : Json.listAt(g, "passwords")) {
                T.eq(Json.str(o, "hash"), Scrypt.hashPassword(Json.str(o, "password"), Bytes.fromHex(Json.str(o, "salt"))), "scrypt hashPassword " + Json.str(o, "password"));
                T.check(Scrypt.verifyPassword(Json.str(o, "password"), Json.str(o, "hash")), "verifyPassword");
                T.check(!Scrypt.verifyPassword("fout", Json.str(o, "hash")), "verifyPassword wrong");
            }
            // RFC 7914 test vector
            T.eq("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
                    Bytes.hex(Scrypt.scrypt(Bytes.utf8("password"), Bytes.utf8("NaCl"), 1024, 8, 16, 64)), "scrypt RFC 7914 vector");
        });
    }

    private static List<Object> keysOf(List<Object> pl) {
        List<Object> l = new ArrayList<>();
        for (Object p : pl) l.add(Json.str(p, "kind") + "/" + Json.str(p, "provider") + "/" + Json.str(p, "region"));
        return l;
    }
}
