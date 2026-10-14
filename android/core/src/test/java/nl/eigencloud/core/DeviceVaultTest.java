package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;

/**
 * De kluis achter de vingerafdruk (zonder wachtwoordzin) naast de kluis met wachtwoordzin: bestandsformaat, een
 * wachtwoordzin erbij, overstappen (migratie), vingerafdrukken veranderd, de console-routes van de telefoon, de
 * herstelkopie (zonder wachtwoordzin te openen met alleen de herstelsleutel), wachtwoorden maken en plakken (gelijk aan
 * web-console/secrets.js) en de inlog achter de vingerafdruk (LoginBox). MOTO_URL: S3 voor de herstelkopie.
 */
public class DeviceVaultTest {
    private static ConsoleApi api;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> call(int status, String method, String path, Object body) {
        ConsoleApi.Reply r = api.handle(method, path, body == null ? "" : Json.stringify(body));
        T.eq(status, r.status, method + " " + path + " → " + status + (r.status != status ? " (" + r.body + ")" : ""));
        Object j = Json.parse(r.body);
        return j instanceof Map ? (Map<String, Object>) j : Json.obj("_", j);
    }

    private static Map<String, Object> readJson(File f) throws Exception { return Json.parseObject(new String(Files.readAllBytes(f.toPath()), "UTF-8")); }

    public static void main(String[] args) {
        T.main("DeviceVaultTest", () -> {
            Map<String, Object> g = T.golden();
            File dir = Files.createTempDirectory("kluis-vinger").toFile();

            // ───────── Vault: formaat achter de vingerafdruk ─────────
            FakeDeviceLock lock = new FakeDeviceLock();
            Map<String, Object> cfg = Console.newAdminConfig("vanes.nl", "rene", "rene@example.org", "lang-genoeg-123");
            File f = new File(dir, "kluis.json");
            Vault v = new Vault(f);
            lock.cancelNext = true;
            T.throwsWith("Geannuleerd", () -> v.createDevice(cfg, lock), "cancelled prompt");
            T.check(!f.exists(), "nothing written when the fingerprint is cancelled");
            T.throwsWith("alleen in de app", () -> v.createDevice(cfg, null), "no device lock (desktop)");
            v.createDevice(cfg, lock);
            T.check(v.isUnlocked() && Vault.DEVICE.equals(v.mode()), "device vault created and unlocked");
            Map<String, Object> file = readJson(f);
            T.eq("[v, kdf, device, data]", file.keySet().toString(), "device file keys (no salt, no passphrase)");
            T.eq("device", file.get("kdf"), "kdf device");
            T.check(!new String(Files.readAllBytes(f.toPath()), "UTF-8").contains("vanes"), "config encrypted");
            T.eq("{\"mode\":\"device\",\"passphrase\":false}", Json.stringify(v.describe()), "describe device vault");
            T.check(!v.hasPassphrase(), "no passphrase");
            byte[] k1 = v.exportKey();
            v.lock();
            T.throwsWith("geen wachtwoordzin", () -> v.unlock("een lange wachtwoordzin"), "passphrase refused on device-only vault");
            v.unlockDevice(lock, null);
            T.eq(Json.stringify(cfg), Json.stringify(v.config()), "unlock with the fingerprint gives the config back");
            v.config().put("extra", "x");
            v.save();
            v.lock();
            new Vault(f).unlockWithKey(k1);
            T.throwsWith("Sleutel past niet", () -> new Vault(f).unlockWithKey(new byte[32]), "wrong key refused");

            // Een wachtwoordzin erbij (voor als de vingerafdrukken veranderen)
            v.unlockDevice(lock, "pin");
            T.eq("pin", lock.lastVia, "via pin passed to the phone");
            T.throwsWith("12 tekens", () -> v.addPassphrase("kort"), "short passphrase refused");
            String pass = "vier losse woorden ü";
            v.addPassphrase(pass);
            file = readJson(f);
            T.eq("[v, kdf, device, pass, data]", file.keySet().toString(), "device file with passphrase");
            T.eq("[kdf, iter, salt, key]", Json.map(file, "pass").keySet().toString(), "pass wrapper keys");
            T.check(v.checkPassphrase(pass) && !v.checkPassphrase("verkeerd"), "checkPassphrase");
            v.lock();
            T.throwsWith("klopt niet", () -> v.unlock("verkeerde wachtwoordzin"), "wrong passphrase");
            v.unlock(pass);
            T.eq("x", v.config().get("extra"), "unlock with the added passphrase");
            T.writeOut("vault-device.json", Json.obj("file", "kluis-vinger.json", "passphrase", pass, "expected", Json.stringify(v.config())));
            Files.copy(f.toPath(), new File(new File(T.buildDir(), "java-out"), "kluis-vinger.json").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);

            // Vingerafdrukken veranderd: sleutel ongeldig → wachtwoordzin → nieuwe sleutel
            lock.invalidateAll();
            Map<String, Object> oldWrap = v.deviceWrap();
            T.check(lock.invalidated(oldWrap), "invalidated detected without prompt");
            v.lock();
            T.throwsWith("werkt de sleutel", () -> v.unlockDevice(lock, null), "invalidated key → Invalidated");
            v.unlock(pass);
            v.useDevice(lock);
            T.check(lock.released.contains(Json.str(oldWrap, "alias")), "old device key released after rewrap");
            T.check(!lock.invalidated(v.deviceWrap()), "new device key works");
            v.lock();
            v.unlockDevice(lock, null);
            v.lock();
            v.unlock(pass);
            T.eq("x", v.config().get("extra"), "passphrase still works after rewrap");

            // Migratie: een kluis met wachtwoordzin (oud formaat) gaat over op de vingerafdruk; de wachtwoordzin blijft werken
            File f2 = new File(dir, "oud.json");
            Vault old = new Vault(f2);
            String oldPass = "oude wachtwoordzin hier";
            old.create(oldPass, Console.newDienstConfig());
            T.eq("[v, kdf, iter, salt, data]", readJson(f2).keySet().toString(), "passphrase vault: original format");
            T.eq("{\"mode\":\"passphrase\",\"passphrase\":true}", Json.stringify(old.describe()), "describe passphrase vault");
            byte[] legacyKey = old.exportKey(); // zoals de oude "Voortaan met vingerafdruk" hem bewaart
            old.useDevice(lock);
            Map<String, Object> mf = readJson(f2);
            T.eq("[v, kdf, device, pass, data]", mf.keySet().toString(), "migrated file keys");
            T.eq("[kdf, iter, salt]", Json.map(mf, "pass").keySet().toString(), "migrated: passphrase derives the key directly");
            T.check(Bytes.equal(legacyKey, old.exportKey()), "vault key unchanged by the migration");
            old.lock();
            old.unlock(oldPass);
            T.check(Json.truthy(Json.path(old.config(), "console", "alleenDienst")), "old passphrase opens the migrated vault");
            old.lock();
            old.unlockDevice(lock, null);
            old.lock();
            old.unlockWithKey(legacyKey);
            T.check(old.isUnlocked(), "legacy fingerprint key still opens it");
            T.throwsWith("al een wachtwoordzin", () -> { Vault p = new Vault(new File(dir, "p.json")); p.create("nog een wachtwoordzin", Console.newDienstConfig()); p.addPassphrase("en nog een wachtwoordzin"); }, "addPassphrase on passphrase vault");

            // ───────── Wachtwoorden maken (zelfde regels als secrets.js) ─────────
            Map<String, Object> sg = Json.map(g, "secrets");
            T.eq(Json.str(sg, "alphabet"), Passwords.ALPHABET, "alphabet == secrets.js");
            T.eq(Json.str(sg, "pattern"), Passwords.PATTERN, "pattern == secrets.js");
            T.eq(Json.num(sg, "groups").intValue() * Json.num(sg, "groupLength").intValue(), Passwords.GROUPS * Passwords.GROUP_LENGTH, "length == secrets.js");
            T.check(Passwords.bits() > 98, "at least 98 bits (" + Passwords.bits() + ")");
            Set<String> seen = new HashSet<>();
            Set<Character> chars = new HashSet<>();
            boolean allMatch = true;
            for (int i = 0; i < 2000; i++) {
                String p = Passwords.generate();
                allMatch &= p.matches(Passwords.PATTERN) && p.length() >= 10;
                seen.add(p);
                for (char c : p.replace("-", "").toCharArray()) chars.add(c);
            }
            T.check(allMatch, "generated passwords match the pattern");
            T.eq(2000, seen.size(), "no repeats in 2000");
            T.eq(Passwords.ALPHABET.length(), chars.size(), "every character of the alphabet occurs");
            for (char bad : "ilo01ILO".toCharArray()) T.check(!chars.contains(bad), "no look-alike character " + bad);

            // Plakken: zelfde uitkomst als normalizeSecret in secrets.js
            int n = 0;
            for (Object o : Json.listAt(sg, "normalize")) {
                T.eq(Json.str(o, "out"), Passwords.normalizePaste(Json.str(o, "in")), "normalizePaste #" + (n++) + " == secrets.js");
            }
            T.check(n >= 20, "paste cases from golden");
            T.eq("", Passwords.normalizePaste(null), "null → empty");

            // ───────── Inlog achter de vingerafdruk (LoginBox, RSA-OAEP met MGF1-SHA1 zoals de Keystore) ─────────
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
            kpg.initialize(2048);
            KeyPair kp = kpg.generateKeyPair();
            Map<String, Object> box = LoginBox.seal(kp.getPublic(), "https://cloud.vanes.nl", "rene@vanes.nl", "kq7mx-2hfpw-9rtzc-v4nsd");
            T.eq("[v, url, key, data]", box.keySet().toString(), "login box keys");
            T.check(!Json.stringify(box).contains("kq7mx"), "password not readable in the box");
            Cipher dc = LoginBox.decryptCipher(kp.getPrivate());
            String[] up = LoginBox.open(dc, box);
            T.eq("rene@vanes.nl|kq7mx-2hfpw-9rtzc-v4nsd", up[0] + "|" + up[1], "login box opens with the private key");
            Map<String, Object> moved = Json.copy(box);
            moved.put("url", "https://cloud.andere.nl");
            T.throwsWith(null, () -> LoginBox.open(LoginBox.decryptCipher(kp.getPrivate()), moved), "box bound to its cloud address");
            KeyPair other = kpg.generateKeyPair();
            T.throwsWith(null, () -> LoginBox.open(LoginBox.decryptCipher(other.getPrivate()), box), "other key refused");

            // ───────── Console-routes van de telefoon ─────────
            Catalog cat;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { cat = Catalog.load(in); }
            File vf = new File(dir, "telefoon/kluis.json");
            String[] ready = {null, null, null};
            api = new ConsoleApi(vf, cat, new ConsoleApi.Listener() {
                @Override public void cloudReady(String url) { ready[0] = url; }

                @Override public void cloudLogin(String url, String user, String password) { ready[1] = user; ready[2] = password; }
            });
            FakeDeviceLock phone = new FakeDeviceLock();
            api.deviceLock = phone;
            Map<String, Object> shapes = Json.map(g, "consoleShapes");
            Map<String, Object> st = call(200, "GET", "/api/state", null);
            for (Object k : Json.listAt(shapes, "state")) T.check(st.containsKey(Json.jsString(k)), "state has " + k + " (same as the desktop)");
            for (Object k : Json.listAt(shapes, "stateDevice")) T.check(Json.map(st, "device").containsKey(Json.jsString(k)), "state.device has " + k);
            T.eq(null, st.get("vaultMode"), "no vault yet");
            T.eq(false, st.get("vaultPassphrase"), "no passphrase yet");
            T.eq(true, Json.path(st, "device", "available"), "fingerprint available");

            phone.available = false;
            Map<String, Object> e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "generatePassword", true, "vault", "device"));
            T.eq(true, e.get("unavailable"), "no fingerprint on the phone → unavailable");
            T.eq(Json.path(shapes, "deviceUnavailable", "keys").toString(), "[" + String.join(", ", e.keySet()) + "]", "unavailable shape == desktop");
            T.check(!vf.exists(), "no vault after unavailable");
            phone.available = true;
            phone.cancelNext = true;
            e = call(400, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "generatePassword", true, "vault", "device"));
            T.eq(true, e.get("cancelled"), "cancelled fingerprint");
            T.check(!vf.exists(), "no vault after cancel");
            call(200, "POST", "/api/setup/create", Json.obj("domain", "vanes.test", "mailbox", "rene", "alertEmail", "rene@elders.example", "generatePassword", true, "vault", "device"));
            st = call(200, "GET", "/api/state", null);
            T.eq("device", st.get("vaultMode"), "vault mode device");
            T.eq(false, st.get("vaultPassphrase"), "no passphrase");
            T.eq(true, st.get("unlocked"), "unlocked after create");
            T.eq(false, Json.path(st, "device", "invalidated"), "device key valid");
            Map<String, Object> conf = call(200, "GET", "/api/config", null);
            T.eq("{\"stored\":true,\"generated\":true}", Json.stringify(conf.get("appLogin")), "appLogin: generated password stored");
            String pw = Json.str(api.vault.config(), "console", "appPassword");
            T.check(pw != null && pw.matches(Passwords.PATTERN), "generated cloud password in the vault");
            T.check(Scrypt.verifyPassword(pw, Json.str(api.vault.config(), "console", "appPasswordHash")), "cloud gets the hash of that password");
            T.check(!new String(Files.readAllBytes(vf.toPath()), "UTF-8").contains(pw), "password not readable in the vault file");
            T.eq("https://cloud.vanes.test|rene@vanes.test|" + pw, Json.str(api.appLogin(), "url") + "|" + Json.str(api.appLogin(), "user") + "|" + Json.str(api.appLogin(), "password"), "appLogin for the app");

            int before = phone.prompts;
            Map<String, Object> shown = call(200, "POST", "/api/app-password/show", null);
            T.eq(pw, shown.get("password"), "show password after fingerprint");
            T.eq("rene@vanes.test", shown.get("user"), "with the login name");
            T.eq(before + 1, phone.prompts, "showing asks for the fingerprint");
            T.eq("Wachtwoord tonen", phone.lastConfirm, "prompt title");
            phone.cancelNext = true;
            T.eq(true, call(400, "POST", "/api/app-password/show", null).get("cancelled"), "cancelled → no password");

            // Op slot en weer open; vingerafdrukken veranderd
            call(200, "POST", "/api/lock", null);
            T.eq(null, api.appLogin(), "no appLogin while locked");
            call(401, "GET", "/api/config", null);
            Map<String, Object> u = call(401, "POST", "/api/unlock", Json.obj("passphrase", "een wachtwoordzin hier"));
            T.check(Json.str(u, "error").contains("geen wachtwoordzin"), "passphrase unlock explains there is none");
            phone.cancelNext = true;
            T.eq(true, call(400, "POST", "/api/unlock/device", null).get("cancelled"), "cancelled unlock");
            call(200, "POST", "/api/unlock/device", Json.obj("via", "pin"));
            T.eq("pin", phone.lastVia, "PIN alternative passed on");
            call(400, "POST", "/api/vault/passphrase", Json.obj("passphrase", "kort"));
            call(200, "POST", "/api/vault/passphrase", Json.obj("passphrase", "mijn reserve wachtwoordzin"));
            T.eq(true, call(200, "GET", "/api/state", null).get("vaultPassphrase"), "passphrase added");
            phone.invalidateAll();
            T.eq(true, Json.path(call(200, "GET", "/api/state", null), "device", "invalidated"), "state shows invalidated key");
            call(200, "POST", "/api/lock", null);
            Map<String, Object> inv = call(409, "POST", "/api/unlock/device", null);
            T.eq(true, inv.get("invalidated"), "unlock → invalidated");
            T.eq(true, inv.get("passphrase"), "… and says the passphrase still works");
            call(200, "POST", "/api/unlock", Json.obj("passphrase", "mijn reserve wachtwoordzin"));
            call(200, "POST", "/api/vault/device", null);
            T.eq(false, Json.path(call(200, "GET", "/api/state", null), "device", "invalidated"), "fingerprint set up again");
            call(200, "POST", "/api/lock", null);
            call(200, "POST", "/api/unlock/device", null);

            // Herstelkopie: alleen de herstelsleutel nodig, ook zonder wachtwoordzin (MOTO_URL)
            String moto = T.env("MOTO_URL");
            if (moto == null) throw new IllegalStateException("MOTO_URL niet gezet");
            String bucket = "vinger-" + Bytes.hex(Bytes.random(4));
            Map<String, Object> store = Json.obj("name", "nep-opslag", "type", "s3", "purpose", "replica", "country", "NL", "endpoint", moto, "region", "us-east-1",
                    "bucket", bucket, "accessKey", "testing", "secretKey", "testing");
            new S3Store(store).createBucket(false);
            Map<String, Object> c = api.vault.config();
            Json.asList(c.get("stores")).add(store);
            Json.map(c, "console").put("done", true);
            api.vault.save();
            T.eq(1, Admin.saveAdminCopy(c), "recovery copy written");
            String masterKey = Json.str(c, "masterKey");

            File vf2 = new File(dir, "nieuwe-telefoon/kluis.json");
            ConsoleApi phone2 = new ConsoleApi(vf2, cat, url -> { });
            FakeDeviceLock lock2 = new FakeDeviceLock();
            phone2.deviceLock = lock2;
            api = phone2;
            Map<String, Object> bad = call(400, "POST", "/api/setup/recover", Json.obj("masterKey", masterKey, "store", store, "passphrase", "kort"));
            T.check(Json.str(bad, "error").contains("12 tekens"), "passphrase checked before recovering");
            Map<String, Object> noStore = Json.copy(store);
            noStore.remove("bucket");
            call(200, "POST", "/api/setup/recover", Json.obj("masterKey", masterKey.toUpperCase(), "store", noStore, "vault", "device"));
            T.eq("device", call(200, "GET", "/api/state", null).get("vaultMode"), "recovered into a fingerprint vault");
            T.eq("vanes.test", Json.str(call(200, "GET", "/api/config", null), "domain"), "config back with only the recovery key");
            T.eq(pw, Json.str(phone2.vault.config(), "console", "appPassword"), "cloud password came along (no typing on the new phone)");
            call(200, "POST", "/api/lock", null);
            call(200, "POST", "/api/unlock/device", null);
            T.eq(masterKey, Json.str(phone2.vault.config(), "masterKey"), "same master key");
            call(200, "POST", "/api/vault/forget", Json.obj("confirm", true));
            T.check(!vf2.exists() && lock2.released.size() == 1, "forget: vault gone and its device key released");

            // Aanbieder worden met de vingerafdruk; zonder DeviceLock (zoals de computer) geen vingerafdruk en geen gemaakt wachtwoord
            call(200, "POST", "/api/setup/aanbieder", Json.obj("vault", "device"));
            T.eq("device", call(200, "GET", "/api/state", null).get("vaultMode"), "aanbieder vault with fingerprint");
            api = new ConsoleApi(new File(dir, "zonder/kluis.json"), cat, url -> { });
            st = call(200, "GET", "/api/state", null);
            T.check(!st.containsKey("device"), "no device info without DeviceLock");
            T.eq(true, call(400, "POST", "/api/setup/aanbieder", Json.obj("vault", "device")).get("unavailable"), "device vault refused without DeviceLock");
            T.check(Json.str(call(400, "POST", "/api/setup/create", Json.obj("domain", "a.test", "mailbox", "a", "generatePassword", true, "passphrase", "vier losse woorden hier")), "error").contains("10 tekens"), "no generated password without the app");
            call(200, "POST", "/api/setup/create", Json.obj("domain", "a.test", "mailbox", "a", "appPassword", "mijn-cloud-wachtwoord", "passphrase", "vier losse woorden hier"));
            T.eq("{\"stored\":false,\"generated\":false}", Json.stringify(call(200, "GET", "/api/config", null).get("appLogin")), "desktop-like: password not stored");
            Map<String, Object> ns = call(404, "POST", "/api/app-password/show", null);
            T.eq(Json.path(shapes, "appPasswordNotStored", "error"), ns.get("error"), "not stored: same error as the desktop");
            T.eq(Json.path(shapes, "vaultHasPassphrase", "error"), call(409, "POST", "/api/vault/passphrase", Json.obj("passphrase", "nog een wachtwoordzin")).get("error"), "passphrase vault: same error as the desktop");
        });
    }
}
