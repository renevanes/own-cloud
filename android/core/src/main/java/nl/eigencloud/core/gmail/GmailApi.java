package nl.eigencloud.core.gmail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import nl.eigencloud.core.Json;

/**
 * What the screens of "Gmail op deze telefoon" call (JSON over the WebView bridge, like the console's ConsoleApi):
 * setup with a pasted app password, folders, lists, search (here and at Gmail), reading, actions, writing and
 * settings. Network work happens in the caller's thread; actions are local first and queued for Gmail.
 */
public final class GmailApi {
    public static final class Reply {
        public final int status;
        public final String body;

        Reply(int status, Object json) {
            this.status = status;
            this.body = Json.stringify(json);
        }
    }

    /** What the app provides: the encrypted credentials and the fingerprint check. */
    public interface Host {
        /** {address, password} or null when not set up. */
        String[] credentials();

        void saveCredentials(String address, String password) throws IOException;

        void forgetCredentials();

        /** The user confirmed with fingerprint or screen lock in the last few minutes. */
        boolean confirmed();
    }

    public final GmailStore store;
    final Host host;
    final Imap.Config imapCfg;
    final Smtp.Server smtpCfg;
    /** URL prefix the WebView serves message content under, e.g. "https://appassets.androidplatform.net/gmail/". */
    public String contentBase = "/gmail/";
    private volatile GmailSync sync;
    /** Pasted app password waiting for "Verbinden" (never sent to the page). */
    private volatile String pendingPassword;

    public GmailApi(GmailStore store, Host host, Imap.Config imapCfg, Smtp.Server smtpCfg) {
        this.store = store;
        this.host = host;
        this.imapCfg = imapCfg;
        this.smtpCfg = smtpCfg;
    }

    /** The sync engine, or null when no account is set up. */
    public GmailSync sync() {
        if (host.credentials() == null) return null;
        if (sync == null) {
            synchronized (this) {
                if (sync == null) {
                    sync = new GmailSync(store, new GmailSync.Account() {
                        @Override public String address() { String[] c = host.credentials(); return c == null ? "" : c[0]; }

                        @Override public String password() { String[] c = host.credentials(); return c == null ? "" : c[1]; }
                    }, imapCfg, smtpCfg);
                }
            }
        }
        return sync;
    }

    /** Clipboard text from the app: keeps the app password here and returns what the page may show. */
    public Map<String, Object> pastePassword(String clipboard) {
        String pw = AppPassword.normalize(clipboard);
        if (pw == null) return Json.obj("ok", false, "error", clipboard == null || clipboard.trim().isEmpty()
                ? "Het klembord is leeg. Kopieer eerst het app-wachtwoord bij Google."
                : "Op het klembord staat geen app-wachtwoord (16 letters). Kopieer het opnieuw bij Google.");
        pendingPassword = pw;
        return Json.obj("ok", true, "masked", AppPassword.mask(pw));
    }

    public Reply handle(String method, String path, String body) {
        try {
            Map<String, Object> b = body == null || body.isEmpty() ? Json.obj() : Json.parseObject(body);
            String route = path, query = "";
            int qi = path.indexOf('?');
            if (qi >= 0) { route = path.substring(0, qi); query = path.substring(qi + 1); }
            Map<String, String> q = parseQuery(query);
            switch (method + " " + route) {
                case "GET /api/state": return ok(state());
                case "POST /api/setup": return setup(b);
                case "GET /api/mailboxes": return ok(mailboxes());
                case "GET /api/messages": return ok(messages(q));
                case "GET /api/message": return message(q.get("id"));
                case "POST /api/action": return action(b);
                case "POST /api/remote-search": return remoteSearch(Json.str(b, "q"));
                case "GET /api/compose": return ok(compose(q.get("id"), q.get("mode")));
                case "POST /api/send": return send(b);
                case "POST /api/outbox/retry": return outboxRetry(b);
                case "POST /api/outbox/delete": return outboxDelete(b);
                case "POST /api/sync": return syncNow();
                case "PUT /api/settings": return settings(b);
                case "GET /api/account": return account();
                case "POST /api/forget": return forget();
                case "POST /api/free": return free();
                default: return new Reply(404, Json.obj("error", "Onbekende vraag"));
            }
        } catch (IllegalArgumentException e) {
            return new Reply(400, Json.obj("error", e.getMessage()));
        } catch (IOException e) {
            return new Reply(502, Json.obj("error", GmailSync.friendly(e)));
        } catch (RuntimeException e) {
            return new Reply(500, Json.obj("error", "Er ging iets mis: " + e.getMessage()));
        }
    }

    private static Reply ok(Object o) { return new Reply(200, o); }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> m = new LinkedHashMap<>();
        for (String kv : q.split("&")) {
            if (kv.isEmpty()) continue;
            int e = kv.indexOf('=');
            m.put(nl.eigencloud.core.Bytes.decodeURIComponent(e < 0 ? kv : kv.substring(0, e)), e < 0 ? "" : nl.eigencloud.core.Bytes.decodeURIComponent(kv.substring(e + 1).replace('+', ' ')));
        }
        return m;
    }

    // ───────── State and setup ─────────

    Map<String, Object> state() {
        String[] c = host.credentials();
        GmailSync s = sync();
        List<Object> outbox = new ArrayList<>();
        for (GmailStore.Outgoing o : store.outbox()) outbox.add(o.toJson());
        return Json.obj("configured", c != null, "address", c == null ? null : c[0], "status", store.json("status"),
                "settings", s == null ? new GmailSync.Settings().toJson() : s.settings().toJson(), "storage", store.storageBytes(),
                "unread", c == null ? 0L : store.unread("inbox"), "outbox", outbox, "pending", store.pendingOps());
    }

    private Reply setup(Map<String, Object> b) throws IOException {
        if (host.credentials() != null && !host.confirmed()) return new Reply(403, Json.obj("error", "Bevestig eerst met je vingerafdruk", "confirm", true));
        String address = AppPassword.address(Json.str(b, "address"));
        if (address == null) throw new IllegalArgumentException("Vul je Gmail-adres in (bijv. jij@gmail.com)");
        String pw = Json.str(b, "password") != null ? AppPassword.normalize(Json.str(b, "password")) : pendingPassword;
        if (pw == null) throw new IllegalArgumentException("Plak eerst het app-wachtwoord");
        Map<String, Object> res;
        try {
            res = GmailSync.test(address, pw, imapCfg, smtpCfg);
        } catch (IOException e) {
            return new Reply(400, Json.obj("error", GmailSync.friendly(e)));
        }
        String[] old = host.credentials();
        if (old != null && !old[0].equalsIgnoreCase(address)) store.wipe(); // another account: start fresh
        host.saveCredentials(address, pw);
        pendingPassword = null;
        synchronized (this) { sync = null; }
        // A new password ends an earlier "password not accepted" pause.
        Map<String, Object> st = store.json("status");
        st.put("authFailed", false);
        st.put("error", null);
        st.put("backoffUntil", null);
        store.putJson("status", st);
        GmailSync s = sync();
        if (s != null) s.wake();
        return ok(Json.obj("ok", true, "address", address, "total", res.get("total")));
    }

    private Reply account() {
        String[] c = host.credentials();
        if (c == null) return ok(Json.obj("configured", false));
        if (!host.confirmed()) return new Reply(403, Json.obj("error", "Bevestig eerst met je vingerafdruk", "confirm", true));
        return ok(Json.obj("configured", true, "address", c[0], "password", AppPassword.mask(c[1])));
    }

    private Reply forget() {
        if (host.credentials() != null && !host.confirmed()) return new Reply(403, Json.obj("error", "Bevestig eerst met je vingerafdruk", "confirm", true));
        GmailSync s = sync;
        if (s != null) s.closeInteractive();
        host.forgetCredentials();
        synchronized (this) { sync = null; }
        store.wipe();
        return ok(Json.obj("ok", true));
    }

    private GmailSync need() {
        GmailSync s = sync();
        if (s == null) throw new IllegalArgumentException("Stel eerst je Gmail-account in");
        return s;
    }

    private Reply syncNow() {
        GmailSync s = need();
        Map<String, Object> st = store.json("status");
        st.put("backoffUntil", null);
        store.putJson("status", st);
        s.wake();
        return ok(Json.obj("ok", true));
    }

    private Reply settings(Map<String, Object> b) {
        GmailSync s = need();
        GmailSync.Settings cur = s.settings();
        if (b.get("months") instanceof Number) {
            int m = ((Number) b.get("months")).intValue();
            if (m != 0 && m != 3 && m != 6 && m != 12 && m != 24) throw new IllegalArgumentException("Kies 3, 6, 12 of 24 maanden, of alles");
            cur.months = m;
        }
        if (b.get("attachLimitMb") instanceof Number) cur.attachLimit = Math.max(1, Math.min(25, ((Number) b.get("attachLimitMb")).longValue())) * 1024 * 1024;
        if (b.get("mobileData") instanceof Boolean) cur.mobileData = (Boolean) b.get("mobileData");
        if (b.get("notify") instanceof Boolean) cur.notify = (Boolean) b.get("notify");
        s.saveSettings(cur);
        s.wake();
        return ok(state());
    }

    private Reply free() {
        long freed = need().freeSpace();
        return ok(Json.obj("freed", freed, "storage", store.storageBytes()));
    }

    // ───────── Folders and lists ─────────

    private static final String[][] SYSTEM = {
            {"inbox", "Inbox"}, {"starred", "Met ster"}, {"important", "Belangrijk"}, {"sent", "Verzonden"}, {"drafts", "Concepten"},
            {"all", "Alle e-mail"}, {"spam", "Spam"}, {"trash", "Prullenbak"}};

    List<Object> mailboxes() {
        List<Object> out = new ArrayList<>();
        Set<String> roles = new HashSet<>();
        for (String[] f : store.folders()) roles.add(f[2]);
        for (String[] s : SYSTEM) {
            if (s[0].equals("important") && !roles.contains("important")) continue;
            if (s[0].equals("spam") && !roles.contains("spam")) continue;
            out.add(Json.obj("view", s[0], "name", s[1], "unread", s[0].equals("inbox") || s[0].equals("spam") ? store.unread(s[0]) : 0L, "system", true));
        }
        for (String[] f : store.folders()) {
            if (!f[2].isEmpty()) continue;
            out.add(Json.obj("view", "label:" + f[0], "name", f[0], "unread", store.unread("label:" + f[0]), "system", false));
        }
        return out;
    }

    Map<String, Object> messages(Map<String, String> q) {
        String view = q.get("view");
        String query = q.get("q");
        if (query != null && query.trim().isEmpty()) query = null;
        long before = q.get("before") == null ? 0 : Long.parseLong(q.get("before"));
        List<Object> list = new ArrayList<>();
        List<GmailStore.Msg> msgs = store.list(view == null || view.isEmpty() || (query != null && "everywhere".equals(q.get("scope"))) ? null : view, before, q.get("beforeId"), 51, query);
        boolean more = msgs.size() > 50;
        for (int i = 0; i < Math.min(50, msgs.size()); i++) list.add(summary(msgs.get(i)));
        return Json.obj("messages", list, "more", more);
    }

    static Map<String, Object> summary(GmailStore.Msg m) {
        Map<String, Object> j = m.toJson();
        j.remove("to");
        j.remove("cc");
        return j;
    }

    // ───────── Reading ─────────

    private Reply message(String id) {
        GmailSync s = need();
        GmailStore.Msg m = id == null ? null : store.get(id);
        if (m == null) return new Reply(404, Json.obj("error", "Dit bericht staat niet (meer) op de telefoon"));
        String fetchError = null;
        if (m.body == GmailStore.NONE) {
            try {
                m = s.fetchBody(id);
            } catch (IOException e) {
                fetchError = GmailSync.friendly(e);
                if (store.get(id) == null) return new Reply(404, Json.obj("error", fetchError));
            }
        }
        if (!m.seen) {
            store.setFlag(id, "seen", true);
            s.queue(id, "seen", null);
            m.seen = true;
        }
        Map<String, Object> j = m.toJson();
        List<Object> atts = new ArrayList<>();
        Set<String> inline = inlineCids(id);
        boolean hasHtml = false;
        for (GmailStore.PartRow p : store.parts(id)) {
            boolean body = p.toPart().isBodyCandidate();
            if (body && p.type.equals("text/html")) hasHtml = true;
            if (body) continue;
            if (!p.cid.isEmpty() && inline.contains(p.cid)) continue;
            atts.add(Json.obj("section", p.section, "name", p.toPart().displayName(), "type", p.type, "size", p.size, "downloaded", p.file));
        }
        j.put("attachments", atts);
        j.put("hasHtml", hasHtml);
        j.put("remoteImages", m.body == GmailStore.NONE ? 0L : (long) render(id, false).blocked);
        j.put("fetchError", fetchError);
        List<Object> thread = new ArrayList<>();
        for (GmailStore.Msg t : store.thread(m.thr)) thread.add(Json.obj("id", t.id, "date", t.date, "fromName", t.fromName, "fromAddr", t.fromAddr, "snippet", t.snippet, "seen", t.seen, "current", t.id.equals(id)));
        j.put("thread", thread);
        j.put("contentUrl", contentBase + "view/" + id);
        return ok(j);
    }

    private Set<String> inlineCids(String id) {
        try {
            return render(id, false).cids;
        } catch (RuntimeException e) {
            return new HashSet<>();
        }
    }

    /** The message as a complete, sanitized HTML document for the sandboxed frame. */
    public HtmlSanitizer.Result render(String id, boolean images) {
        GmailStore.Msg m = store.get(id);
        HtmlSanitizer.Result r = new HtmlSanitizer.Result();
        if (m == null) { r.html = ""; return r; }
        String html = null, text = null;
        Map<String, String> cidToSection = new LinkedHashMap<>();
        for (GmailStore.PartRow p : store.parts(id)) {
            Mime.Part part = p.toPart();
            if (!p.cid.isEmpty() && p.file) cidToSection.put(p.cid, p.section);
            if (!part.isBodyCandidate() || !p.file) continue;
            try {
                byte[] data = store.readPart(id, p.section);
                if (data == null) continue;
                part.data = data;
                if (p.type.equals("text/html") && html == null) html = part.text();
                if (p.type.equals("text/plain") && text == null) text = part.text();
            } catch (IOException e) {
                // missing file: show what there is
            }
        }
        if (html != null) {
            r = HtmlSanitizer.sanitize(html, images, cid -> cidToSection.containsKey(cid) ? contentBase + "part/" + id + "/" + cidToSection.get(cid) : null);
        } else {
            r.html = HtmlSanitizer.textToHtml(text != null ? text : m.snippet);
        }
        return r;
    }

    public String viewDocument(String id, boolean images) {
        HtmlSanitizer.Result r = render(id, images);
        return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                + "<base target=\"_blank\"><style>body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:#111;background:#fff;overflow-wrap:anywhere}"
                + "img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>" + r.html + "</body></html>";
    }

    /** A part's bytes for the app (opening or saving an attachment), fetched from Gmail when needed. */
    public byte[] partData(String id, String section, boolean fetch) throws IOException {
        byte[] b = store.readPart(id, section);
        if (b != null || !fetch) return b;
        return need().fetchPart(id, section);
    }

    // ───────── Actions ─────────

    private Reply action(Map<String, Object> b) {
        GmailSync s = need();
        String op = Json.str(b, "op");
        List<Object> ids = Json.listAt(b, "ids");
        if (op == null || ids == null || ids.isEmpty()) throw new IllegalArgumentException("Welke berichten?");
        String label = Json.str(b, "label");
        for (Object o : ids) {
            String id = String.valueOf(o);
            GmailStore.Msg m = store.get(id);
            if (m == null) continue;
            switch (op) {
                case "seen": store.setFlag(id, "seen", true); s.queue(id, "seen", null); break;
                case "unseen": store.setFlag(id, "seen", false); s.queue(id, "unseen", null); break;
                case "flag": store.setFlag(id, "flagged", true); s.queue(id, "flag", null); break;
                case "unflag": store.setFlag(id, "flagged", false); s.queue(id, "unflag", null); break;
                case "archive": store.removeLabel(id, "\\Inbox"); s.queue(id, "archive", null); break;
                case "inbox":
                    store.addLabel(id, "\\Inbox");
                    s.queue(id, "inbox", null);
                    store.setBox(id, GmailStore.ALL);
                    break;
                case "trash": s.queue(id, "trash", null); store.setBox(id, GmailStore.TRASH); break;
                case "spam": s.queue(id, "spam", null); store.setBox(id, GmailStore.SPAM); break;
                case "delete": {
                    // forever, from Trash or Spam: gone here at once; the queued change carries where it was
                    if (m.box.equals(GmailStore.ALL)) throw new IllegalArgumentException("Verwijder eerst naar de prullenbak");
                    Object[] loc = store.location(id);
                    store.delete(id);
                    if (loc != null) { store.enqueue(id, "delete", Json.obj("box", loc[0], "uid", loc[1])); s.wake(); }
                    break;
                }
                case "label":
                case "unlabel":
                    if (label == null || label.trim().isEmpty() || label.startsWith("\\")) throw new IllegalArgumentException("Welk label?");
                    if (op.equals("label")) store.addLabel(id, label.trim()); else store.removeLabel(id, label.trim());
                    s.queue(id, op, Json.obj("label", label.trim()));
                    break;
                case "move": {
                    // to a label: add it and leave the inbox (like "Verplaatsen naar" in Gmail)
                    if (label == null || label.trim().isEmpty()) throw new IllegalArgumentException("Waarheen?");
                    String from = Json.str(b, "from");
                    if (m.box.equals(GmailStore.TRASH) || m.box.equals(GmailStore.SPAM)) { s.queue(id, "inbox", null); store.setBox(id, GmailStore.ALL); }
                    store.addLabel(id, label.trim());
                    s.queue(id, "label", Json.obj("label", label.trim()));
                    if (from != null && from.startsWith("label:")) {
                        store.removeLabel(id, from.substring(6));
                        s.queue(id, "unlabel", Json.obj("label", from.substring(6)));
                    } else {
                        store.removeLabel(id, "\\Inbox");
                        s.queue(id, "archive", null);
                    }
                    break;
                }
                default: throw new IllegalArgumentException("Onbekende actie");
            }
        }
        return ok(Json.obj("ok", true, "pending", store.pendingOps()));
    }

    private Reply remoteSearch(String q) throws IOException {
        if (q == null || q.trim().isEmpty()) throw new IllegalArgumentException("Waar zoek je naar?");
        List<String> ids = need().remoteSearch(q.trim());
        List<Object> list = new ArrayList<>();
        for (String id : ids) {
            GmailStore.Msg m = store.get(id);
            if (m != null) list.add(summary(m));
        }
        return ok(Json.obj("messages", list, "more", false));
    }

    // ───────── Writing ─────────

    Map<String, Object> compose(String id, String mode) throws IOException {
        if (id == null) return Json.obj("to", "", "cc", "", "subject", "", "text", "");
        GmailStore.Msg m = store.get(id);
        if (m == null) throw new IllegalArgumentException("Dit bericht staat niet (meer) op de telefoon");
        if (m.body == GmailStore.NONE) m = need().fetchBody(id);
        String[] cred = host.credentials();
        String me = cred == null ? "" : cred[0];
        String body = bodyText(id);
        String when = new SimpleDateFormat("d MMM yyyy 'om' HH:mm", new Locale("nl", "NL")).format(new Date(m.date));
        String who = m.fromName.isEmpty() ? m.fromAddr : m.fromName + " <" + m.fromAddr + ">";
        Map<String, Object> out = Json.obj("replyTo", id);
        if ("forward".equals(mode)) {
            out.put("to", "");
            out.put("cc", "");
            out.put("subject", prefixed("Fwd: ", m.subject, "(fwd|fw|doorgestuurd|wg):"));
            out.put("text", "\n\n---------- Doorgestuurd bericht ----------\nVan: " + who + "\nDatum: " + when + "\nOnderwerp: " + m.subject + "\nAan: " + m.to + "\n\n" + body);
            List<Object> atts = new ArrayList<>();
            for (GmailStore.PartRow p : store.parts(id)) {
                if (p.toPart().isBodyCandidate()) continue;
                atts.add(Json.obj("section", p.section, "name", p.toPart().displayName(), "size", p.size));
            }
            out.put("forwardAttachments", atts);
            out.put("mode", "forward");
            return out;
        }
        List<Mime.Address> replyTo = Mime.parseAddresses(m.replyTo);
        List<Mime.Address> to = new ArrayList<>(replyTo.isEmpty() ? java.util.Collections.singletonList(new Mime.Address(m.fromName, m.fromAddr)) : replyTo);
        // replying to your own sent message: to its recipients
        if (m.fromAddr.equalsIgnoreCase(me) && !m.to.isEmpty()) to = Mime.parseAddresses(m.to);
        List<Mime.Address> cc = new ArrayList<>();
        if ("all".equals(mode)) {
            Set<String> seen = new HashSet<>();
            seen.add(me.toLowerCase(Locale.ROOT));
            for (Mime.Address a : to) seen.add(a.email.toLowerCase(Locale.ROOT));
            for (Mime.Address a : Mime.parseAddresses(m.to + ", " + m.cc)) if (!a.email.isEmpty() && seen.add(a.email.toLowerCase(Locale.ROOT))) cc.add(a);
        }
        out.put("to", Mime.formatList(to));
        out.put("cc", Mime.formatList(cc));
        out.put("subject", prefixed("Re: ", m.subject, "(re|antw|aw|sv):"));
        StringBuilder quoted = new StringBuilder();
        for (String line : body.split("\n", -1)) quoted.append("> ").append(line).append('\n');
        out.put("text", "\n\nOp " + when + " schreef " + who + ":\n" + quoted);
        out.put("mode", "all".equals(mode) ? "all" : "reply");
        return out;
    }

    private static String prefixed(String prefix, String subject, String existing) {
        String s = subject == null ? "" : subject.trim();
        return s.toLowerCase(Locale.ROOT).matches("^" + existing + ".*") ? s : prefix + s;
    }

    private String bodyText(String id) {
        String html = null;
        for (GmailStore.PartRow p : store.parts(id)) {
            Mime.Part part = p.toPart();
            if (!part.isBodyCandidate() || !p.file) continue;
            try {
                part.data = store.readPart(id, p.section);
            } catch (IOException e) {
                continue;
            }
            if (part.data == null) continue;
            if (p.type.equals("text/plain")) return part.text().replace("\r\n", "\n").trim();
            if (html == null) html = part.text();
        }
        return html == null ? "" : Mime.htmlToText(html);
    }

    /** Where the app puts files picked for a new message (token = file name). */
    public File tmpDir() {
        File d = new File(store.dir, "tmp");
        d.mkdirs();
        return d;
    }

    private Reply send(Map<String, Object> b) throws IOException {
        GmailSync s = need();
        String[] cred = host.credentials();
        MailBuilder.Draft d = new MailBuilder.Draft();
        d.from = new Mime.Address(Json.str(b, "fromName") == null ? "" : Json.str(b, "fromName").trim(), cred[0]);
        d.to = recipients(Json.str(b, "to"));
        d.cc = recipients(Json.str(b, "cc"));
        d.bcc = recipients(Json.str(b, "bcc"));
        if (d.recipients().isEmpty()) throw new IllegalArgumentException("Aan wie? Vul een e-mailadres in.");
        d.subject = Json.str(b, "subject") == null ? "" : Json.str(b, "subject");
        d.text = Json.str(b, "text") == null ? "" : Json.str(b, "text");
        String replyTo = Json.str(b, "replyTo");
        GmailStore.Msg parent = replyTo == null ? null : store.get(replyTo);
        boolean forward = "forward".equals(Json.str(b, "mode"));
        if (parent != null && !forward) {
            d.inReplyTo = parent.msgId;
            d.references = parent.refs;
        }
        long total = 0;
        List<File> temps = new ArrayList<>();
        List<Object> files = Json.listAt(b, "files");
        if (files != null) {
            for (Object o : files) {
                Map<String, Object> f = Json.asMap(o);
                String token = Json.str(f, "token");
                if (token == null || !token.matches("[a-f0-9]{16,64}")) throw new IllegalArgumentException("Bijlage niet gevonden");
                File file = new File(tmpDir(), token);
                if (!file.exists()) throw new IllegalArgumentException("Bijlage niet gevonden; kies hem opnieuw");
                d.attachments.add(new MailBuilder.Attachment(Json.str(f, "name"), Json.str(f, "type"), file));
                temps.add(file);
                total += file.length();
            }
        }
        List<Object> fwd = Json.listAt(b, "forwardAttachments");
        if (forward && parent != null && fwd != null) {
            for (Object o : fwd) {
                String section = String.valueOf(o);
                GmailStore.PartRow row = null;
                for (GmailStore.PartRow p : store.parts(replyTo)) if (p.section.equals(section)) row = p;
                if (row == null) continue;
                byte[] data = partData(replyTo, section, true);
                d.attachments.add(new MailBuilder.Attachment(row.toPart().displayName(), row.type, data));
                total += data.length;
            }
        }
        if (total > 25L * 1024 * 1024) throw new IllegalArgumentException("De bijlagen zijn samen groter dan 25 MB; dat neemt Gmail niet aan");
        String msgId = MailBuilder.newMessageId(cred[0]);
        long seq = store.outboxCreate(msgId, d.subject, d.recipients(), replyTo);
        File out = store.outboxFile(seq);
        File tmp = new File(out.getPath() + ".tmp");
        try (OutputStream o = new FileOutputStream(tmp)) {
            MailBuilder.write(d, System.currentTimeMillis(), msgId, o);
        }
        if (!tmp.renameTo(out)) throw new IOException("Kon het bericht niet bewaren");
        store.outboxReady(seq);
        for (File t : temps) t.delete();
        if (parent != null && !forward) {
            store.setFlag(replyTo, "answered", true);
            s.queue(replyTo, "answered", null);
        }
        s.wake();
        return ok(Json.obj("ok", true, "seq", seq));
    }

    static List<Mime.Address> recipients(String v) {
        List<Mime.Address> out = new ArrayList<>();
        if (v == null || v.trim().isEmpty()) return out;
        for (Mime.Address a : Mime.parseAddresses(v)) {
            if (AppPassword.address(a.email) == null) throw new IllegalArgumentException("Dit is geen geldig e-mailadres: " + (a.email.isEmpty() ? a.name : a.email));
            out.add(a);
        }
        return out;
    }

    private Reply outboxRetry(Map<String, Object> b) {
        GmailSync s = need();
        long seq = Json.num(b, "seq") == null ? -1 : Json.num(b, "seq").longValue();
        for (GmailStore.Outgoing o : store.outbox()) {
            if (o.seq != seq) continue;
            store.outboxState(seq, "queued", null, 0);
            s.wake();
            return ok(Json.obj("ok", true));
        }
        return new Reply(404, Json.obj("error", "Niet gevonden"));
    }

    private Reply outboxDelete(Map<String, Object> b) {
        long seq = Json.num(b, "seq") == null ? -1 : Json.num(b, "seq").longValue();
        for (GmailStore.Outgoing o : store.outbox()) {
            if (o.seq != seq) continue;
            if (o.state.equals("sending")) throw new IllegalArgumentException("Dit bericht wordt nu verstuurd");
            store.outboxSent(seq); // removes file and row
            return ok(Json.obj("ok", true));
        }
        return new Reply(404, Json.obj("error", "Niet gevonden"));
    }
}
