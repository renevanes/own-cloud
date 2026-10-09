package nl.eigencloud.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Crypto interoperability with the TS code: HKDF, TS-sealed → Java open (seal, sealJson, rpc, manifest,
 * admin-config, bootstrap), adminProof at a fixed ts; writes Java-sealed data to java-out/crypto.json for
 * scripts/golden-verify.ts (Java seal → TS open, Java proof → TS verifyAdminProof).
 */
public class CryptoGoldenTest {
    public static void main(String[] args) {
        T.main("CryptoGoldenTest", () -> {
            Map<String, Object> g = T.golden();
            String masterHex = Json.str(g, "masterKey");
            byte[] master = Bytes.fromHex(masterHex);

            // 1. HKDF
            for (Map.Entry<String, Object> e : Json.map(g, "derived").entrySet()) {
                T.eq(e.getValue(), Bytes.hex(EigenCrypto.deriveKey(master, e.getKey())), "deriveKey(" + e.getKey() + ")");
            }
            T.eq(Json.str(g, "derived16"), Bytes.hex(EigenCrypto.deriveKey(master, "kort", 16)), "deriveKey len 16");
            T.eq(Json.str(g, "derived64"), Bytes.hex(EigenCrypto.deriveKey(master, "lang", 64)), "deriveKey len 64");
            ClusterConfig.Keys keys = ClusterConfig.keysForMaster(masterHex);
            T.eq(Json.str(g, "derived", "cluster"), Bytes.hex(keys.cluster), "keysFor.cluster");
            T.eq(Json.str(g, "derived", "manifest"), Bytes.hex(keys.manifest), "keysFor.manifest");
            T.throwsWith("64 hex-tekens", () -> EigenCrypto.parseKey("abcd"), "parseKey rejects short keys");
            T.eq(64, EigenCrypto.randomKeyHex().length(), "randomKeyHex length");

            // 2. TS seal → Java open
            int n = 0;
            for (Object o : Json.listAt(g, "seals")) {
                byte[] k = EigenCrypto.deriveKey(master, Json.str(o, "purpose"));
                String aad = Json.str(o, "aad");
                byte[] plain = EigenCrypto.open(k, Bytes.fromBase64(Json.str(o, "sealed")), aad);
                T.eq(Json.str(o, "plain"), Bytes.base64(plain), "open TS seal #" + n++ + " aad=" + aad);
            }
            Object first = Json.listAt(g, "seals").get(1);
            T.throwsWith("Ontsleutelen mislukt", () -> EigenCrypto.open(EigenCrypto.deriveKey(master, "cluster"), Bytes.fromBase64(Json.str(first, "sealed")), "rpc"), "wrong AAD refused");
            T.throwsWith("Ongeldig versleuteld bericht", () -> EigenCrypto.open(keys.cluster, new byte[10]), "short buffer refused");

            for (Object o : Json.listAt(g, "sealJson")) {
                Object v = EigenCrypto.openJson(keys.manifest, Bytes.fromBase64(Json.str(o, "sealed")), Json.str(o, "aad"));
                T.eq(Json.stringify(Json.path(o, "value")), Json.stringify(v), "openJson aad=" + Json.str(o, "aad"));
            }
            Object rpcMsg = Transport.openMsg(keys.cluster, Bytes.fromBase64(Json.str(g, "rpc", "sealed")));
            T.eq(Json.stringify(Json.path(g, "rpc", "msg")), Json.stringify(rpcMsg), "openMsg of TS sealMsg");
            T.throwsWith("al eerder ontvangen", () -> Transport.openMsg(keys.cluster, Bytes.fromBase64(Json.str(g, "rpc", "sealed"))), "replay refused");
            String jt = Json.str(g, "bootstrap", "joinToken");
            Object boot = EigenCrypto.openJson(EigenCrypto.deriveKey(Bytes.fromHex(jt), "bootstrap"), Bytes.fromBase64(Json.str(g, "bootstrap", "sealed")), "bootstrap");
            T.eq(Json.stringify(Json.path(g, "bootstrap", "value")), Json.stringify(boot), "open TS bootstrap config");

            // 3. adminProof at a fixed ts equals the TS mac
            for (Object o : Json.listAt(g, "proofs")) {
                Map<String, Object> p = Admin.adminProof(masterHex, Json.path(o, "payload"), Json.num(o, "ts").longValue());
                T.eq(Json.str(o, "mac"), p.get("mac"), "adminProof mac " + Json.stringify(Json.path(o, "payload")));
            }

            // Java → TS
            Map<String, Object> out = Json.obj("masterKey", masterHex);
            List<Object> seals = new ArrayList<>();
            String[] plains = {"", "hallo", "ü-€-😀 \u0000 einde", "lone \ud800 surrogate"};
            for (String purpose : new String[] {"cluster", "manifest"}) {
                for (String aad : new String[] {null, "rpc", "admin-config", "ü"}) {
                    for (String p : plains) {
                        seals.add(Json.obj("purpose", purpose, "aad", aad, "plain", Bytes.base64(Bytes.utf8(p)),
                                "sealed", Bytes.base64(EigenCrypto.seal(EigenCrypto.deriveKey(master, purpose), p, aad))));
                    }
                }
            }
            out.put("seals", seals);
            Map<String, Object> manifest = Json.parseObject("{\"cluster\":\"vanes\",\"state\":\"asleep\",\"term\":7,\"updated\":1760000000000,\"nodes\":[],\"topology\":[{\"kind\":\"data\",\"provider\":\"hetzner\",\"region\":\"fsn1\",\"size\":\"cx23\"}]}");
            out.put("manifest", Json.obj("value", manifest, "sealed", Bytes.base64(EigenCrypto.sealJson(keys.manifest, manifest, "manifest"))));
            Map<String, Object> cfg = Json.map(g, "sampleConfig");
            out.put("adminConfig", Json.obj("value", cfg, "sealed", Bytes.base64(EigenCrypto.sealJson(keys.manifest, cfg, "admin-config"))));
            String token = Bytes.hex(Bytes.random(32));
            out.put("bootstrap", Json.obj("joinToken", token, "value", cfg, "sealed", Bytes.base64(EigenCrypto.sealJson(EigenCrypto.deriveKey(Bytes.fromHex(token), "bootstrap"), cfg, "bootstrap"))));
            Map<String, Object> msg = Json.obj("type", "adminJob", "job", Json.obj("type", "snapshot", "params", Json.obj()), "x", 0.1);
            out.put("rpc", Json.obj("msg", msg, "sealed", Bytes.base64(Transport.sealMsg(keys.cluster, msg))));

            // Proofs over nasty payloads (TS verifies them over JSON.parse of the serialized payload).
            List<Object> proofs = new ArrayList<>();
            List<Object> payloads = Json.list(
                    Json.obj("type", "snapshot", "params", Json.obj()),
                    Json.obj("type", "spawn", "params", Json.obj("kind", "data", "provider", "hetzner", "region", "fsn1", "size", "cx23", "country", "DE")),
                    Json.obj("stores", Json.list(Json.obj("name", "s\"1\\", "secretKey", "a/b+c=", "n", 4.51, "big", 1e21, "small", 1e-7, "neg", -0.0)),
                            "settings", Json.obj("mail_relay", "smtps://u%40x:p%3A@mail.example.org:465", "spf_extra", "include:_spf.example.org", "ctrl", "\u0000\u001f\b\f\n\r\t\u007f "),
                            "uni", "😀 é ü \ud800 \udc00", "empty", Json.obj(), "list", Json.list(), "nul", null, "t", true,
                            "2", "index-key", "1", "first", "x", Json.obj("10", 1, "9", 2, "a", 3)),
                    Json.parse(Json.str(Json.listAt(g, "json").get(9), "input")));
            for (Object p : payloads) {
                Map<String, Object> proof = Admin.adminProof(masterHex, p);
                T.check(Admin.verifyAdminProof(masterHex, p, proof), "Java verifies own proof");
                T.check(Admin.verifyAdminProof(masterHex, Json.parse(Json.stringify(p)), proof), "Java verifies after JSON round trip");
                proofs.add(Json.obj("payloadJson", Json.stringify(p), "proof", proof));
            }
            Map<String, Object> stale = Admin.adminProof(masterHex, payloads.get(0), System.currentTimeMillis() - 200_000);
            T.check(!Admin.verifyAdminProof(masterHex, payloads.get(0), stale), "stale proof refused");
            out.put("proofs", proofs);
            T.writeOut("crypto.json", out);
        });
    }
}
