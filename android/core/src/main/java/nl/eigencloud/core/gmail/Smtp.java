package nl.eigencloud.core.gmail;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Sends one message through smtp.gmail.com (implicit TLS on 465, or STARTTLS on 587) with AUTH PLAIN or LOGIN.
 * Gmail files what you send in "Sent" by itself. Errors say whether the message may have gone out anyway
 * ({@link SmtpException#maybeSent}: the connection broke after the data was handed over).
 */
public final class Smtp {
    private Smtp() {}

    public enum Security { IMPLICIT_TLS, STARTTLS, NONE }

    public static final class Server {
        public final String host;
        public final int port;
        public final Security security;
        public int timeoutMs = 60_000;

        public Server(String host, int port, Security security) {
            this.host = host;
            this.port = port;
            this.security = security;
        }

        public static Server gmail() { return new Server("smtp.gmail.com", 465, Security.IMPLICIT_TLS); }
    }

    public static final class SmtpException extends IOException {
        private static final long serialVersionUID = 1L;
        public final int code;
        /** 5xx: retrying will not help (wrong address, refused content). */
        public final boolean permanent;
        /** The message data was sent but no confirmation came back: Gmail may have it. */
        public final boolean maybeSent;
        public final boolean auth;

        SmtpException(String msg, int code, boolean maybeSent, boolean auth) {
            super(msg);
            this.code = code;
            this.permanent = code >= 500 && code < 600;
            this.maybeSent = maybeSent;
            this.auth = auth;
        }
    }

    public interface Body {
        InputStream open() throws IOException;
    }

    /** Only logs in (setup check). */
    public static void verify(Server s, String user, String password) throws IOException {
        send(s, user, password, null, null, null);
    }

    public static void send(Server s, String user, String password, String from, List<String> rcpt, Body body) throws IOException {
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(s.host, s.port), Math.min(s.timeoutMs, 20_000));
        raw.setSoTimeout(s.timeoutMs);
        Conn c = null;
        boolean dataSent = false;
        try {
            c = new Conn(s.security == Security.IMPLICIT_TLS ? tls(raw, s.host, s.port) : raw);
            c.expect(220);
            List<String> ext = c.ehlo();
            if (s.security == Security.STARTTLS) {
                c.cmd("STARTTLS", 220);
                c = new Conn(tls(c.sock, s.host, s.port));
                ext = c.ehlo();
            }
            String auth = "";
            for (String e : ext) if (e.toUpperCase(Locale.ROOT).startsWith("AUTH")) auth = " " + e.toUpperCase(Locale.ROOT).substring(5) + " ";
            try {
                if (auth.contains(" PLAIN ")) {
                    c.cmd("AUTH PLAIN " + b64("\0" + user + "\0" + password), 235);
                } else if (auth.contains(" LOGIN ")) {
                    c.cmd("AUTH LOGIN", 334);
                    c.cmd(b64(user), 334);
                    c.cmd(b64(password), 235);
                } else throw new SmtpException("De mailserver biedt geen inlogmethode die de app kent", 0, false, false);
            } catch (SmtpException e) {
                if (e.code == 535 || e.code == 534 || e.code == 530) throw new SmtpException("Gmail accepteert dit app-wachtwoord niet om te versturen", e.code, false, true);
                throw e;
            }
            if (body == null) { quit(c); return; }
            c.cmd("MAIL FROM:<" + from + ">", 250);
            int ok = 0;
            SmtpException last = null;
            for (String r : rcpt) {
                try {
                    c.cmd("RCPT TO:<" + r + ">", 250, 251);
                    ok++;
                } catch (SmtpException e) {
                    last = e;
                    if (!e.permanent) throw e;
                }
            }
            if (ok == 0 || last != null) throw new SmtpException(last != null ? "Dit adres wordt niet geaccepteerd: " + last.getMessage() : "Geen ontvangers", last != null ? last.code : 554, false, false);
            c.cmd("DATA", 354);
            dataSent = true;
            try (InputStream in = new BufferedInputStream(body.open())) { c.dotStuff(in); }
            c.out.write(".\r\n".getBytes(StandardCharsets.US_ASCII));
            c.out.flush();
            c.expect(250);
            quit(c);
        } catch (SmtpException e) {
            throw dataSent && !e.permanent && e.code == 0 ? new SmtpException(e.getMessage(), 0, true, false) : e;
        } catch (IOException e) {
            throw new SmtpException(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(), 0, dataSent, false);
        } finally {
            try { if (c != null) c.sock.close(); } catch (IOException ignored) { /* closing */ }
            try { raw.close(); } catch (IOException ignored) { /* closing */ }
        }
    }

    private static void quit(Conn c) {
        try { c.cmd("QUIT", 221); } catch (IOException ignored) { /* some servers just close */ }
    }

    private static String b64(String s) { return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8)); }

    static Socket tls(Socket plain, String host, int port) throws IOException {
        SSLSocket t = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(plain, host, port, true);
        SSLParameters p = t.getSSLParameters();
        p.setEndpointIdentificationAlgorithm("HTTPS");
        t.setSSLParameters(p);
        t.startHandshake();
        return t;
    }

    private static final class Conn {
        final Socket sock;
        final InputStream in;
        final OutputStream out;

        Conn(Socket s) throws IOException {
            sock = s;
            in = new BufferedInputStream(s.getInputStream());
            out = new BufferedOutputStream(s.getOutputStream(), 64 * 1024);
        }

        String line() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            int c;
            while ((c = in.read()) != -1 && c != '\n') if (c != '\r') b.write(c);
            if (c == -1 && b.size() == 0) throw new IOException("De verbinding met de mailserver is verbroken");
            return new String(b.toByteArray(), StandardCharsets.UTF_8);
        }

        List<String> reply() throws IOException {
            List<String> lines = new ArrayList<>();
            for (;;) {
                String l = line();
                lines.add(l);
                if (l.length() < 4 || l.charAt(3) != '-') return lines;
            }
        }

        List<String> expect(int... codes) throws IOException {
            List<String> r = reply();
            String first = r.get(0);
            int code = 0;
            try { code = Integer.parseInt(first.substring(0, Math.min(3, first.length()))); } catch (NumberFormatException ignored) { /* 0 */ }
            for (int c : codes) if (c == code) return r;
            StringBuilder msg = new StringBuilder();
            for (String l : r) msg.append(l.length() > 4 ? l.substring(4) : l).append(' ');
            throw new SmtpException(msg.toString().trim(), code, false, false);
        }

        void cmd(String line, int... codes) throws IOException {
            out.write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            expect(codes);
        }

        List<String> ehlo() throws IOException {
            out.write("EHLO eigen-cloud-app\r\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
            List<String> r = expect(250);
            List<String> ext = new ArrayList<>();
            for (int i = 1; i < r.size(); i++) ext.add(r.get(i).length() > 4 ? r.get(i).substring(4).trim() : "");
            return ext;
        }

        /** Copies the message with CRLF line ends, doubling dots at line starts. */
        void dotStuff(InputStream in) throws IOException {
            int prev = '\n', c;
            while ((c = in.read()) != -1) {
                if (c == '\n' && prev != '\r') out.write('\r');
                if (prev == '\n' && c == '.') out.write('.');
                out.write(c);
                prev = c;
            }
            if (prev != '\n') { out.write('\r'); out.write('\n'); }
        }
    }
}
