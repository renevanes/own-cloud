package nl.eigencloud.core;

import java.io.File;
import java.nio.file.Files;
import java.util.Map;

/**
 * Vault: create/unlock/save/lock, unlockWithKey/exportKey, wrong passphrase, file format. Also writes a vault
 * to java-out/ for golden-verify.ts (Node decrypts it with pbkdf2 + open). And console flows that need no
 * network (new config, key confirmation, recovery helpers, policy change, dashboard state).
 */
public class VaultTest {
    public static void main(String[] args) {
        T.main("VaultTest", () -> {
            File dir = new File(T.buildDir(), "java-out");
            dir.mkdirs();
            File f = new File(dir, "kluis.json");
            f.delete();
            Map<String, Object> cfg = Console.newAdminConfig("https://Vanes.NL/pad", "rene", "rene@example.org", "lang-genoeg-123");
            T.eq("vanes.nl", cfg.get("domain"), "domain normalized");
            T.eq("vanes", cfg.get("cluster"), "cluster from domain");
            T.check(Scrypt.verifyPassword("lang-genoeg-123", Json.str(cfg, "console", "appPasswordHash")), "app password hashed with scrypt");

            Vault v = new Vault(f);
            T.check(!v.exists(), "no vault yet");
            T.throwsWith("minstens 12 tekens", () -> v.create("kort", cfg), "short passphrase refused");
            String pass = "een lange wachtwoordzin ü";
            long t0 = System.currentTimeMillis();
            v.create(pass, cfg);
            System.out.println("  (PBKDF2 310000 iteraties: " + (System.currentTimeMillis() - t0) + " ms)");
            T.check(v.exists() && v.isUnlocked(), "created and unlocked");
            Map<String, Object> file = Json.parseObject(new String(Files.readAllBytes(f.toPath()), "UTF-8"));
            T.eq("[v, kdf, iter, salt, data]", file.keySet().toString(), "file keys");
            T.eq(310000L, file.get("iter"), "iterations");
            T.eq(16, Bytes.fromBase64(Json.str(file, "salt")).length, "salt length");

            byte[] key = v.exportKey();
            v.lock();
            T.check(!v.isUnlocked() && v.config() == null, "locked");
            T.throwsWith("op slot", v::save, "save while locked");
            T.throwsWith("Wachtwoordzin klopt niet", () -> v.unlock("verkeerde wachtwoordzin"), "wrong passphrase");
            v.unlock(pass);
            T.eq(Json.stringify(cfg), Json.stringify(v.config()), "unlock gives the config back");

            v.config().put("extra", "waarde");
            v.save();
            v.lock();
            v.unlockWithKey(key);
            T.eq("waarde", v.config().get("extra"), "unlockWithKey after save");
            T.throwsWith("Sleutel past niet", () -> new Vault(f).unlockWithKey(new byte[32]), "wrong key");
            T.writeOut("vault.json", Json.obj("file", f.getName(), "passphrase", pass, "expected", Json.stringify(v.config())));

            // Key confirmation and checklist
            T.eq(8, Console.keyGroups(cfg).size(), "8 key groups");
            T.throwsWith("groep 3 en 7", () -> Console.confirmKey(cfg, "x", "y"), "wrong groups refused");
            T.eq("0a1b1c1d", Console.normGroup(" OA iB Lc ld "), "normGroup: spaces, case, o→0, i/l→1");
            for (int i = 0; i < 50; i++) { long n = Console.pickKeyGroup(3L); T.check(n >= 1 && n <= 8 && n != 3, "pickKeyGroup"); }
            Console.confirmKey(cfg, " " + Console.keyGroups(cfg).get(2).toUpperCase() + " ", Console.keyGroups(cfg).get(6));
            T.eq(Boolean.TRUE, Json.path(cfg, "console", "keyConfirmed"), "key confirmed");
            T.eq("Nog niet klaar: opslag gekoppeld, serverplekken gekozen", Console.launchBlocker(cfg), "launch blocker");

            // Validation messages
            T.throwsWith("domeinnaam", () -> Console.newAdminConfig("geen-domein", "rene", null, "lang-genoeg-123"), "bad domain");
            T.throwsWith("deel vóór de @", () -> Console.newAdminConfig("a.nl", "re ne", null, "lang-genoeg-123"), "bad mailbox");
            T.throwsWith("minstens 10 tekens", () -> Console.newAdminConfig("a.nl", "rene", null, "kort"), "short app password");
            T.throwsWith("buiten je eigen domein", () -> Console.newAdminConfig("a.nl", "rene", "x@a.nl", "lang-genoeg-123"), "alert inside own domain");
            T.throwsWith("64 tekens", () -> Console.normalizeMasterKey("abc"), "short master key");
            T.eq("ab".repeat(32), Console.normalizeMasterKey("ABAB ABAB-" + "ab".repeat(28)), "master key normalized");

            // Policy change, wake target and dashboard state
            Map<String, Object> pol = Console.policyChange(cfg, Json.obj("minDataNodes", 3, "witnesses", 0, "placement", Json.list(), "hack", true));
            T.eq("{\"minDataNodes\":3,\"witnesses\":0}", Json.stringify(pol), "policy change filtered");
            T.eq(3L, Json.path(cfg, "policy", "minDataNodes"), "policy applied");
            Map<String, Object> manifest = Json.parseObject("{\"state\":\"asleep\",\"term\":4,\"topology\":[{\"kind\":\"witness\",\"provider\":\"x\",\"region\":\"r\",\"size\":\"s\"},{\"kind\":\"data\",\"provider\":\"hetzner\",\"region\":\"fsn1\",\"size\":\"cx23\"}]}");
            Admin.FirstNode w = Console.wakeTarget(cfg, manifest);
            T.eq("hetzner/fsn1/cx23", w.provider + "/" + w.region + "/" + w.size, "wake target from topology");
            T.eq(5L, Console.wakeTerm(manifest), "wake term");
            T.eq("{\"mail_from\":\"rene@vanes.nl\",\"password_hash\":\"" + Json.str(cfg, "console", "appPasswordHash") + "\",\"alert_email\":\"rene@example.org\"}", Json.stringify(Console.initialSettings(cfg)), "initialSettings");

            // Mail relay URL round trip
            SmtpCheck.Relay relay = new SmtpCheck.Relay("smtp.example.org", 587, "rene@vanes.nl", "p@ss:wo rd/é", false);
            String url = SmtpCheck.relayUrl(relay);
            T.eq("smtp://rene%40vanes.nl:p%40ss%3Awo%20rd%2F%C3%A9@smtp.example.org:587", url, "relay URL like encodeURIComponent");
            SmtpCheck.Relay back = SmtpCheck.parseRelayUrl(url);
            T.eq("rene@vanes.nl|p@ss:wo rd/é|587|false", back.user + "|" + back.password + "|" + back.port + "|" + back.secure, "relay URL parsed back");
        });
    }
}
