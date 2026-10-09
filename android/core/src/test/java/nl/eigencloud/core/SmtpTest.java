package nl.eigencloud.core;

import java.io.File;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/** SmtpCheck against local smtp-server instances (scripts/android-smtp-server.ts; info file via SMTP_INFO). */
public class SmtpTest {
    public static void main(String[] args) {
        T.main("SmtpTest", () -> {
            String infoPath = T.env("SMTP_INFO");
            if (infoPath == null) throw new IllegalStateException("SMTP_INFO niet gezet");
            Map<String, Object> info = Json.parseObject(new String(Files.readAllBytes(new File(infoPath).toPath()), "UTF-8"));
            int plain = Json.num(info, "plain").intValue(), loginOnly = Json.num(info, "loginOnly").intValue(), starttls = Json.num(info, "starttls").intValue();
            String user = "rene@vanes.nl", pass = "geheim wachtwoord/é";

            SmtpCheck.verify("127.0.0.1", plain, user, pass, SmtpCheck.Security.NONE, 5000, null);
            T.check(true, "AUTH PLAIN ok");
            SmtpCheck.verify("127.0.0.1", loginOnly, user, pass, SmtpCheck.Security.NONE, 5000, null);
            T.check(true, "AUTH LOGIN ok");
            T.throwsWith("Inloggen mislukt", () -> SmtpCheck.verify("127.0.0.1", plain, user, "fout", SmtpCheck.Security.NONE, 5000, null), "wrong password (PLAIN)");
            T.throwsWith("Inloggen mislukt", () -> SmtpCheck.verify("127.0.0.1", loginOnly, user, "fout", SmtpCheck.Security.NONE, 5000, null), "wrong password (LOGIN)");
            T.throwsWith("geen STARTTLS", () -> SmtpCheck.verify("127.0.0.1", plain, user, pass, SmtpCheck.Security.STARTTLS, 5000, null), "STARTTLS required in STARTTLS mode");
            T.throwsWith(null, () -> SmtpCheck.verify("127.0.0.1", starttls, user, pass, SmtpCheck.Security.STARTTLS, 5000, null), "untrusted self-signed certificate refused");
            T.throwsWith(null, () -> SmtpCheck.verify("127.0.0.1", 1, user, pass, SmtpCheck.Security.NONE, 2000, null), "connection refused");

            String text = "De verbinding met je mail-relay werkt.\n.regel met punt\nü";
            SmtpCheck.verify("127.0.0.1", plain, user, pass, SmtpCheck.Security.NONE, 5000, new SmtpCheck.Message(user, "melding@example.org", "Test vanuit je Eigen Cloud-beheerconsole é", text));
            List<String> lines = Files.readAllLines(new File(Json.str(info, "messages")).toPath());
            T.eq(1, lines.size(), "one message delivered");
            Map<String, Object> m = Json.parseObject(lines.get(0));
            T.eq(user, m.get("from"), "envelope from");
            T.eq("[\"melding@example.org\"]", Json.stringify(m.get("to")), "envelope to");
            String data = Json.str(m, "data");
            T.check(data.contains("Subject: =?UTF-8?B?" + Bytes.base64(Bytes.utf8("Test vanuit je Eigen Cloud-beheerconsole é")) + "?="), "encoded subject");
            String b64 = data.substring(data.indexOf("\r\n\r\n") + 4).replaceAll("\\s", "");
            T.eq(text, Bytes.utf8(Bytes.fromBase64(b64)), "body decoded");

            // Console mail step on an admin config (relay URL stored only when verify works).
            Map<String, Object> c = Json.obj("appEnv", Json.obj("MAIL_FROM", "rene@vanes.nl"), "console", Json.obj("alertEmail", "melding@example.org"));
            SmtpCheck.Relay bad = new SmtpCheck.Relay("127.0.0.1", plain, user, "fout", false);
            T.throwsWith("Verbinden met 127.0.0.1 lukt niet: ", () -> SmtpCheck.configure(c, bad, " include:x ", false), "console mail step error message");
            T.check(!Json.truthy(Json.path(c, "console", "mailRelay")), "relay not stored after failure");
            T.eq("include:x", Json.str(c, "console", "spfExtra"), "spfExtra stored");
            SmtpCheck.Relay good = new SmtpCheck.Relay("127.0.0.1", plain, user, pass, false);
            T.check(SmtpCheck.configure(c, good, "", true, SmtpCheck.Security.NONE), "console mail step with test message");
            T.eq("smtp://rene%40vanes.nl:geheim%20wachtwoord%2F%C3%A9@127.0.0.1:" + plain, Json.str(c, "console", "mailRelay"), "relay URL stored");
            SmtpCheck.Relay noPass = new SmtpCheck.Relay("127.0.0.1", plain, user, "", false);
            SmtpCheck.configure(c, noPass, "", false, SmtpCheck.Security.NONE);
            T.check(true, "empty password reuses the stored one");
            List<String> after = Files.readAllLines(new File(Json.str(info, "messages")).toPath());
            T.eq(2, after.size(), "test message sent to alert address");
            T.eq("[\"melding@example.org\"]", Json.stringify(Json.parseObject(after.get(1)).get("to")), "test message recipient");
            SmtpCheck.configure(c, null, "", false);
            T.eq("", Json.str(c, "console", "mailRelay"), "relay cleared");
        });
    }
}
