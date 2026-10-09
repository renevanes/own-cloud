package nl.eigencloud.core;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URISyntaxException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Minimal SMTP client to verify relay credentials (the console's POST /api/mail uses nodemailer's verify()):
 * connect, EHLO, STARTTLS (unless implicit TLS), AUTH PLAIN or LOGIN, optionally one test message, QUIT.
 */
public final class SmtpCheck {
    private SmtpCheck() {}

    /** Transport security. */
    public enum Security {
        /** TLS from the first byte (smtps, usually port 465). */
        IMPLICIT_TLS,
        /** Plain connect, then STARTTLS (required: fails when the server does not offer it). */
        STARTTLS,
        /** No TLS at all — only for tests against a local server. */
        NONE
    }

    /** Relay settings as the console stores them (console.mailRelay is a URL built from these). */
    public static final class Relay {
        public String host;
        public int port;
        /** null when the relay needs no login. */
        public String user;
        public String password;
        /** true = smtps (implicit TLS). */
        public boolean secure;

        public Relay(String host, int port, String user, String password, boolean secure) {
            this.host = host;
            this.port = port;
            this.user = user;
            this.password = password;
            this.secure = secure;
        }

        /** {host, port, user, secure} without the password (like the console's sanitized view). */
        public Map<String, Object> toPublicJson() { return Json.obj("host", host, "port", (long) port, "user", user == null ? "" : user, "secure", secure); }
    }

    /** A test message. */
    public static final class Message {
        public final String from, to, subject, text;

        public Message(String from, String to, String subject, String text) {
            this.from = from;
            this.to = to;
            this.subject = subject;
            this.text = text;
        }
    }

    /** Builds the relay URL exactly as the console does: smtp[s]://user:pass@host:port. */
    public static String relayUrl(Relay r) {
        String auth = r.user != null && !r.user.isEmpty() ? Bytes.encodeURIComponent(r.user) + ":" + Bytes.encodeURIComponent(r.password == null ? "" : r.password) + "@" : "";
        return (r.secure ? "smtps" : "smtp") + "://" + auth + r.host + ":" + r.port;
    }

    /** Parses a relay URL back into settings (null when it is not a valid smtp/smtps URL). */
    public static Relay parseRelayUrl(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            URI u = new URI(url);
            String scheme = u.getScheme();
            if (!"smtp".equals(scheme) && !"smtps".equals(scheme)) return null;
            String user = null, pass = null;
            String ui = u.getRawUserInfo();
            if (ui != null) {
                int i = ui.indexOf(':');
                user = Bytes.decodeURIComponent(i >= 0 ? ui.substring(0, i) : ui);
                pass = i >= 0 ? Bytes.decodeURIComponent(ui.substring(i + 1)) : "";
            }
            return new Relay(u.getHost(), u.getPort(), user, pass, "smtps".equals(scheme));
        } catch (URISyntaxException e) {
            return null;
        }
    }

    /**
     * The console's mail step: sets console.spfExtra and console.mailRelay on the admin config after
     * verifying the relay (and, when {@code sendTest} and an alert address exist, sending a test message to
     * it). A null relay clears it. Returns whether a test message was requested. On failure throws
     * "Verbinden met host lukt niet: …" and leaves the relay unchanged.
     */
    public static boolean configure(Map<String, Object> c, Relay relay, String spfExtra, boolean sendTest) throws IOException {
        return configure(c, relay, spfExtra, sendTest, null);
    }

    /** {@link #configure(Map, Relay, String, boolean)} with explicit security (null = from relay.secure). */
    public static boolean configure(Map<String, Object> c, Relay relay, String spfExtra, boolean sendTest, Security security) throws IOException {
        Map<String, Object> console = Json.map(c, "console");
        if (console == null) { console = Json.obj(); c.put("console", console); }
        console.put("spfExtra", spfExtra == null ? "" : spfExtra.trim());
        if (relay == null) {
            console.put("mailRelay", "");
            return false;
        }
        if ((relay.password == null || relay.password.isEmpty()) && Json.truthy(console.get("mailRelay"))) {
            Relay old = parseRelayUrl(Json.str(console, "mailRelay"));
            if (old != null) relay.password = old.password;
        }
        String url = relayUrl(relay);
        try {
            Message m = null;
            String alert = Json.str(console, "alertEmail");
            if (sendTest && alert != null && !alert.isEmpty()) {
                m = new Message(Json.str(c, "appEnv", "MAIL_FROM"), alert, "Test vanuit je Eigen Cloud-beheerconsole", "De verbinding met je mail-relay werkt.");
            }
            verify(relay.host, relay.port, relay.user, relay.password, security != null ? security : relay.secure ? Security.IMPLICIT_TLS : Security.STARTTLS, 10_000, m);
        } catch (IOException | RuntimeException e) {
            throw new IOException("Verbinden met " + relay.host + " lukt niet: " + e.getMessage(), e);
        }
        console.put("mailRelay", url);
        return sendTest;
    }

    /**
     * Connects and logs in (when {@code user} is non-empty); sends {@code message} when not null.
     * Throws {@link IOException} describing the failing step.
     */
    public static void verify(String host, int port, String user, String password, Security security, int timeoutMs, Message message) throws IOException {
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), timeoutMs);
        raw.setSoTimeout(timeoutMs);
        Session s = null;
        try {
            Socket sock = security == Security.IMPLICIT_TLS ? tls(raw, host, port) : raw;
            s = new Session(sock);
            s.expect(220, "begroeting");
            List<String> ext = s.ehlo();
            if (security == Security.STARTTLS) {
                if (!has(ext, "STARTTLS")) throw new IOException("De server biedt geen STARTTLS aan");
                s.cmd("STARTTLS", 220);
                s = new Session(tls(s.sock, host, port));
                ext = s.ehlo();
            }
            if (user != null && !user.isEmpty()) {
                String pw = password == null ? "" : password;
                String auth = authLine(ext);
                if (auth != null && auth.contains("PLAIN")) {
                    s.cmd("AUTH PLAIN " + Bytes.base64(Bytes.utf8("\0" + user + "\0" + pw)), 235);
                } else if (auth != null && auth.contains("LOGIN")) {
                    s.cmd("AUTH LOGIN", 334);
                    s.cmd(Bytes.base64(Bytes.utf8(user)), 334);
                    s.cmd(Bytes.base64(Bytes.utf8(pw)), 235);
                } else throw new IOException("De server ondersteunt geen inlogmethode die we kennen (PLAIN of LOGIN)");
            }
            if (message != null) send(s, message);
            try {
                s.cmd("QUIT", 221);
            } catch (IOException ignored) {
                // some servers just close
            }
        } finally {
            try {
                if (s != null) s.sock.close();
            } catch (IOException ignored) {
                // closing
            }
            raw.close();
        }
    }

    private static boolean has(List<String> ext, String word) {
        for (String e : ext) if (e.toUpperCase(Locale.ROOT).equals(word) || e.toUpperCase(Locale.ROOT).startsWith(word + " ")) return true;
        return false;
    }

    private static String authLine(List<String> ext) {
        for (String e : ext) {
            String u = e.toUpperCase(Locale.ROOT);
            if (u.startsWith("AUTH ") || u.startsWith("AUTH=")) return " " + u.substring(5) + " ";
        }
        return null;
    }

    private static Socket tls(Socket plain, String host, int port) throws IOException {
        SSLSocket t = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(plain, host, port, true);
        SSLParameters p = t.getSSLParameters();
        p.setEndpointIdentificationAlgorithm("HTTPS"); // verify the certificate's host name
        t.setSSLParameters(p);
        t.startHandshake();
        return t;
    }

    private static void send(Session s, Message m) throws IOException {
        s.cmd("MAIL FROM:<" + m.from + ">", 250);
        s.cmd("RCPT TO:<" + m.to + ">", 250, 251);
        s.cmd("DATA", 354);
        SimpleDateFormat df = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", Locale.US);
        String domain = m.from.contains("@") ? m.from.substring(m.from.indexOf('@') + 1) : "localhost";
        StringBuilder b = new StringBuilder();
        b.append("From: ").append(m.from).append("\r\n");
        b.append("To: ").append(m.to).append("\r\n");
        b.append("Subject: ").append(encodeHeader(m.subject)).append("\r\n");
        b.append("Date: ").append(df.format(new Date())).append("\r\n");
        b.append("Message-ID: <").append(Bytes.hex(Bytes.random(12))).append('@').append(domain).append(">\r\n");
        b.append("MIME-Version: 1.0\r\n");
        b.append("Content-Type: text/plain; charset=utf-8\r\n");
        b.append("Content-Transfer-Encoding: base64\r\n\r\n");
        String body = Bytes.base64(Bytes.utf8(m.text));
        for (int i = 0; i < body.length(); i += 76) b.append(body, i, Math.min(body.length(), i + 76)).append("\r\n");
        b.append(".");
        s.cmd(b.toString(), 250);
    }

    private static String encodeHeader(String v) {
        for (int i = 0; i < v.length(); i++) if (v.charAt(i) > 126 || v.charAt(i) < 32) return "=?UTF-8?B?" + Bytes.base64(Bytes.utf8(v)) + "?=";
        return v;
    }

    /** One SMTP connection: line I/O and reply parsing. */
    private static final class Session {
        final Socket sock;
        final InputStream in;
        final OutputStream out;

        Session(Socket sock) throws IOException {
            this.sock = sock;
            this.in = new BufferedInputStream(sock.getInputStream());
            this.out = sock.getOutputStream();
        }

        String line() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int c;
            while ((c = in.read()) != -1 && c != '\n') if (c != '\r') b.write(c);
            if (c == -1 && b.size() == 0) throw new IOException("Verbinding gesloten door de server");
            return Bytes.utf8(b.toByteArray());
        }

        /** Reads a (multi-line) reply; returns the lines, first element starting with the code. */
        List<String> reply() throws IOException {
            List<String> lines = new ArrayList<>();
            for (;;) {
                String l = line();
                lines.add(l);
                if (l.length() < 4 || l.charAt(3) != '-') return lines;
            }
        }

        static int code(List<String> r) {
            try {
                return Integer.parseInt(r.get(r.size() - 1).substring(0, 3));
            } catch (RuntimeException e) {
                return -1;
            }
        }

        void expect(int want, String what) throws IOException {
            List<String> r = reply();
            if (code(r) != want) throw new IOException("Onverwacht antwoord (" + what + "): " + r.get(r.size() - 1));
        }

        List<String> cmd(String line, int... ok) throws IOException {
            out.write(Bytes.utf8(line + "\r\n"));
            out.flush();
            List<String> r = reply();
            int c = code(r);
            for (int o : ok) if (o == c) return r;
            String shown = line.startsWith("AUTH") || ok.length > 0 && ok[0] == 334 || ok.length > 0 && ok[0] == 235 ? "inloggen" : line.split("\r\n")[0];
            if (c == 535 || c == 534) throw new IOException("Inloggen mislukt: " + r.get(r.size() - 1));
            throw new IOException("Onverwacht antwoord op " + shown + ": " + r.get(r.size() - 1));
        }

        List<String> ehlo() throws IOException {
            List<String> r = cmd("EHLO eigen-cloud-beheer", 250);
            List<String> ext = new ArrayList<>();
            for (int i = 1; i < r.size(); i++) ext.add(r.get(i).length() > 4 ? r.get(i).substring(4).trim() : "");
            return ext;
        }
    }
}
