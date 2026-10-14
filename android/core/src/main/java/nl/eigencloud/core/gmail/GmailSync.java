package nl.eigencloud.core.gmail;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;

import nl.eigencloud.core.Json;

/**
 * Keeps the phone's copy in step with Gmail, both ways.
 *
 * <p>Gmail → phone: "[Gmail]/All Mail" is the canonical folder (every message once, with its labels); Trash and
 * Spam are separate because their messages are not in All Mail. Messages are keyed by X-GM-MSGID, so a message that
 * moves between folders (or a folder that is renumbered: UIDVALIDITY) is never downloaded twice. Each run: new UIDs,
 * flag/label changes (CONDSTORE CHANGEDSINCE), deletions (count check, then per-batch comparison), then
 * the first sync newest-first: headers of the window, bodies of the window, the rest of the headers.
 *
 * <p>Phone → Gmail: changes made in the app are applied locally at once and queued; each run first replays the queue in
 * order, then sends the outbox (SMTP; Gmail files it in Sent). A queued change for a message Gmail deleted is dropped
 * (Gmail wins); otherwise the phone's change is applied, so it is the last writer.
 */
public final class GmailSync {
    public interface Account {
        String address();

        String password();
    }

    public static final String NO_ALL_MAIL = "De map 'Alle e-mail' is niet zichtbaar via IMAP. Zet in Gmail bij Instellingen → Labels 'Alle e-mail' op 'Weergeven in IMAP'.";
    public static final String AUTH_FAILED = "Gmail accepteert dit app-wachtwoord niet (meer). Maak een nieuw app-wachtwoord aan en plak het bij Instellingen.";

    public static final class Settings {
        /** Months downloaded completely; 0 = everything. */
        public int months = 12;
        public long attachLimit = 10L * 1024 * 1024;
        /** Also download the window over mobile data. */
        public boolean mobileData;
        public boolean notify = true;

        public Map<String, Object> toJson() { return Json.obj("months", (long) months, "attachLimitMb", attachLimit / (1024 * 1024), "mobileData", mobileData, "notify", notify); }
    }

    public static final class Options {
        public long budgetMs = 60_000;
        /** Unmetered network (or the user allows mobile data): the full body pass may run. */
        public boolean unmetered = true;
        /** Started by the user: ignore backoff and an earlier password error. */
        public boolean interactive;
    }

    public static final class Result {
        public boolean ok, more, authFailed;
        public String error;
        /** New unread inbox messages that arrived during this run (after the first sync). */
        public final List<GmailStore.Msg> fresh = new ArrayList<>();
        public int changed;
    }

    final GmailStore store;
    final Account account;
    final Imap.Config imapCfg;
    final Smtp.Server smtp;
    /** For tests: the current time. */
    public java.util.function.LongSupplier clock = System::currentTimeMillis;
    private final Object runLock = new Object();
    private volatile boolean wake;
    private Imap cached;
    private final Object cachedLock = new Object();

    public GmailSync(GmailStore store, Account account, Imap.Config imapCfg, Smtp.Server smtp) {
        this.store = store;
        this.account = account;
        this.imapCfg = imapCfg;
        this.smtp = smtp;
    }

    long now() { return clock.getAsLong(); }

    // ───────── Settings and status ─────────

    public Settings settings() {
        Map<String, Object> j = store.json("settings");
        Settings s = new Settings();
        if (j.get("months") instanceof Number) s.months = ((Number) j.get("months")).intValue();
        if (j.get("attachLimitMb") instanceof Number) s.attachLimit = Math.max(1, ((Number) j.get("attachLimitMb")).longValue()) * 1024 * 1024;
        s.mobileData = Boolean.TRUE.equals(j.get("mobileData"));
        if (j.containsKey("notify")) s.notify = Boolean.TRUE.equals(j.get("notify"));
        return s;
    }

    public void saveSettings(Settings s) {
        store.putJson("settings", s.toJson());
        applyRetention(s);
    }

    /** Start of the window (ms); 0 = everything. */
    public long windowStart(Settings s) {
        if (s.months <= 0) return 0;
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.setTimeInMillis(now());
        c.add(java.util.Calendar.MONTH, -s.months);
        return c.getTimeInMillis();
    }

    public Map<String, Object> status() { return store.json("status"); }

    private void status(String key, Object value) {
        synchronized (store) {
            Map<String, Object> s = store.json("status");
            s.put(key, value);
            store.putJson("status", s);
        }
    }

    // ───────── Connecting ─────────

    Imap connect() throws IOException {
        Imap imap = new Imap(imapCfg);
        try {
            imap.login(account.address(), account.password());
            if (!imap.has("X-GM-EXT-1")) throw new IOException("Dit is geen Gmail-server (X-GM-EXT-1 ontbreekt)");
            return imap;
        } catch (IOException | RuntimeException e) {
            imap.close();
            throw e;
        }
    }

    /** Setup check: logs in to IMAP and SMTP and finds All Mail. Returns {allMail, total}. */
    public static Map<String, Object> test(String address, String password, Imap.Config cfg, Smtp.Server smtp) throws IOException {
        Imap imap = new Imap(cfg);
        try {
            imap.login(address, password);
            String all = null;
            for (Imap.ListEntry e : imap.list()) if (e.has("\\all")) all = e.raw;
            if (all == null) throw new IOException(NO_ALL_MAIL);
            Imap.Mailbox mb = imap.select(all, true);
            imap.logout();
            if (smtp != null) Smtp.verify(smtp, address, password);
            return Json.obj("allMail", MUtf7.decode(all), "total", mb.exists);
        } finally {
            imap.close();
        }
    }

    /** Friendly Dutch text for an error. */
    public static String friendly(Throwable e) {
        if (e instanceof Imap.ImapException && ((Imap.ImapException) e).authFailed()) return AUTH_FAILED;
        if (e instanceof Smtp.SmtpException && ((Smtp.SmtpException) e).auth) return AUTH_FAILED;
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.ConnectException || e instanceof java.net.NoRouteToHostException) return "Geen verbinding met Gmail. Heb je internet?";
        if (e instanceof java.net.SocketTimeoutException) return "Gmail reageerde niet op tijd. Het wordt later opnieuw geprobeerd.";
        if (e instanceof Imap.ImapException && ((Imap.ImapException) e).throttled()) return "Gmail vraagt om even te wachten (limiet bereikt). Het gaat later vanzelf verder.";
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m.length() > 300 ? m.substring(0, 300) : m;
    }

    /** A connection for things the user waits for (open a message, search). Reused while it works. */
    public <T> T interactive(ImapTask<T> task) throws IOException {
        synchronized (cachedLock) {
            for (int attempt = 0; ; attempt++) {
                try {
                    if (cached == null) { cached = connect(); discover(cached); }
                    return task.run(cached);
                } catch (Imap.ImapException e) {
                    if ("BYE".equals(e.status) && attempt == 0) { closeInteractive(); continue; }
                    throw e;
                } catch (IOException e) {
                    closeInteractive();
                    if (attempt == 0 && !(e instanceof java.net.UnknownHostException)) continue;
                    throw e;
                }
            }
        }
    }

    public interface ImapTask<T> {
        T run(Imap imap) throws IOException;
    }

    public void closeInteractive() {
        synchronized (cachedLock) {
            if (cached != null) cached.close();
            cached = null;
        }
    }

    // ───────── Folders ─────────

    /** LIST with SPECIAL-USE: roles by attribute, never by (localised) name. Labels are the selectable rest. */
    void discover(Imap imap) throws IOException {
        List<String[]> folders = new ArrayList<>();
        boolean all = false;
        for (Imap.ListEntry e : imap.list()) {
            String role = "";
            if (e.raw.equalsIgnoreCase("INBOX")) role = "inbox";
            else if (e.has("\\all")) role = "all";
            else if (e.has("\\trash")) role = "trash";
            else if (e.has("\\junk")) role = "spam";
            else if (e.has("\\sent")) role = "sent";
            else if (e.has("\\drafts")) role = "drafts";
            else if (e.has("\\flagged")) role = "starred";
            else if (e.has("\\important")) role = "important";
            else if (e.has("\\noselect") || e.has("\\nonexistent")) continue;
            if (role.equals("all")) all = true;
            folders.add(new String[]{e.name, e.raw, role});
        }
        if (!all) throw new IOException(NO_ALL_MAIL);
        store.saveFolders(folders);
    }

    static String boxRole(String box) { return box; } // "all", "trash", "spam" are both box names and roles

    // ───────── One run ─────────

    /** Lets a waiting {@link #idleLoop} run now (the user changed something). */
    public void wake() { wake = true; }

    public Result run(Options o) {
        synchronized (runLock) {
            Result r = new Result();
            Map<String, Object> st = status();
            long t0 = now();
            if (!o.interactive) {
                if (Boolean.TRUE.equals(st.get("authFailed"))) { r.authFailed = true; r.error = AUTH_FAILED; return r; }
                Number until = (Number) st.get("backoffUntil");
                if (until != null && until.longValue() > t0) { r.error = (String) st.get("error"); r.more = true; return r; }
            }
            long deadline = t0 + o.budgetMs;
            status("running", true);
            status("lastRun", t0);
            Imap imap = null;
            try {
                imap = connect();
                discover(imap);
                replay(imap);
                sendOutbox(imap);
                Settings s = settings();
                // New UIDs everywhere first, then deletions: a message that moved (All Mail → Trash) is found in its
                // new folder before it disappears from the old one, so it is never deleted and downloaded again.
                for (String box : new String[]{GmailStore.ALL, GmailStore.TRASH, GmailStore.SPAM}) pull(imap, box, r);
                for (String box : new String[]{GmailStore.ALL, GmailStore.TRASH, GmailStore.SPAM}) r.changed += deletions(imap, box);
                r.changed += store.deleteOrphans();
                r.more = backfill(imap, s, o, deadline);
                applyRetention(s);
                progress(s, o);
                imap.logout();
                r.ok = true;
                synchronized (store) {
                    Map<String, Object> ns = store.json("status");
                    ns.put("lastOk", now());
                    ns.put("error", null);
                    ns.put("authFailed", false);
                    ns.put("failures", 0L);
                    ns.put("backoffUntil", null);
                    ns.put("running", false);
                    ns.put("more", r.more);
                    store.putJson("status", ns);
                }
            } catch (IOException | RuntimeException e) {
                if (imap != null) imap.close();
                r.error = friendly(e);
                r.authFailed = AUTH_FAILED.equals(r.error);
                synchronized (store) {
                    Map<String, Object> ns = store.json("status");
                    long failures = (ns.get("failures") instanceof Number ? ((Number) ns.get("failures")).longValue() : 0) + 1;
                    long wait = Math.min(60L * 60_000, 60_000L << Math.min(6, failures - 1));
                    if (e instanceof Imap.ImapException && ((Imap.ImapException) e).throttled()) wait = Math.max(wait, 15 * 60_000L);
                    ns.put("failures", failures);
                    ns.put("backoffUntil", r.authFailed ? null : now() + wait);
                    ns.put("authFailed", r.authFailed);
                    ns.put("error", r.error);
                    ns.put("running", false);
                    store.putJson("status", ns);
                }
                r.more = !r.authFailed;
            }
            return r;
        }
    }

    // ───────── Gmail → phone ─────────

    private Map<String, Object> boxState(String box) { return store.json("box." + box); }

    private void saveBoxState(String box, Map<String, Object> st) { store.putJson("box." + box, st); }

    private static long n(Map<String, Object> m, String k) { return m.get(k) instanceof Number ? ((Number) m.get(k)).longValue() : 0; }

    private String rawFor(String box) { return store.folderRaw(boxRole(box)); }

    /** New messages, changed flags/labels and deletions in one server folder. */
    void pull(Imap imap, String box, Result r) throws IOException {
        String raw = rawFor(box);
        if (raw == null) return;
        Imap.Mailbox mb = imap.select(raw, false);
        Map<String, Object> st = boxState(box);
        if (n(st, "uidvalidity") != mb.uidValidity) {
            if (n(st, "uidvalidity") != 0) store.resetBox(box);
            st = Json.obj("uidvalidity", mb.uidValidity, "top", Math.max(1, mb.uidNext), "cursor", Math.max(1, mb.uidNext), "modseq", mb.highestModseq,
                    "exists", mb.exists, "walkDone", mb.exists == 0, "windowDone", mb.exists == 0);
            if (mb.exists == 0 && store.hasOld(box)) store.finishReset(box);
            saveBoxState(box, st);
            return; // the walk fetches everything below "top"
        }
        long top = n(st, "top");
        // 1. new UIDs
        if (mb.uidNext == 0 || mb.uidNext > top) {
            long[] maxSeen = {top - 1};
            fetchHeaders(imap, box, top + ":*", top, (m, isNew) -> {
                if (isNew && box.equals(GmailStore.ALL) && m.labels.contains("\\Inbox") && !m.seen) r.fresh.add(m);
                r.changed++;
            }, maxSeen);
            top = Math.max(top, Math.max(mb.uidNext, maxSeen[0] + 1));
            st.put("top", top);
        }
        long cursor = Math.max(1, n(st, "cursor"));
        // 2. changed flags and labels
        long modseq = n(st, "modseq");
        if (imap.condstore() && mb.highestModseq > 0) {
            if (modseq > 0 && mb.highestModseq != modseq && top > cursor) {
                imap.uidFetch(cursor + ":" + (top - 1), "(UID FLAGS X-GM-LABELS X-GM-MSGID MODSEQ)", "(CHANGEDSINCE " + modseq + ")", f -> {
                    if (applyState(box, f)) r.changed++;
                });
            }
            st.put("modseq", mb.highestModseq);
        } else if (top > cursor) {
            // No CONDSTORE: refresh the newest 500 and a rotating slice of the rest.
            List<Long> newest = store.uids(box, Math.max(cursor, top - 2000), top - 1);
            List<Long> slice = new ArrayList<>(newest.subList(Math.max(0, newest.size() - 500), newest.size()));
            long rot = n(st, "rotate");
            List<Long> older = store.uidsAfter(box, rot, top - 1, 500);
            st.put("rotate", older.size() < 500 ? 0L : older.get(older.size() - 1));
            slice.addAll(older);
            if (!slice.isEmpty()) imap.uidFetch(Imap.set(slice), "(UID FLAGS X-GM-LABELS X-GM-MSGID)", null, f -> { if (applyState(box, f)) r.changed++; });
        }
        st.put("exists", imap.selected.exists);
        saveBoxState(box, st);
    }

    /** Deletions in one folder (after every folder's new UIDs are in). */
    private int deletions(Imap imap, String box) throws IOException {
        String raw = rawFor(box);
        Map<String, Object> st = boxState(box);
        if (raw == null || st.isEmpty()) return 0;
        Imap.Mailbox mb = imap.select(raw, false);
        if (mb.uidValidity != n(st, "uidvalidity")) return 0; // renumbered meanwhile: the next run starts over
        int c = expunges(imap, box, Math.max(1, n(st, "cursor")), n(st, "top") - 1, mb);
        st.put("exists", imap.selected.exists);
        saveBoxState(box, st);
        return c;
    }

    /** Server state of a known message (unless the phone has a change for it still waiting). */
    private boolean applyState(String box, Imap.Fetch f) {
        String id = Imap.str(f.get("X-GM-MSGID"));
        if (id.isEmpty()) id = store.idFor(box, f.uid());
        if (id == null || id.isEmpty() || !store.exists(id)) return false;
        if (store.hasPending(id)) return false; // the phone's change goes to Gmail first
        Set<String> flags = new HashSet<>();
        for (String x : f.strings("FLAGS")) flags.add(x.toLowerCase(Locale.ROOT));
        Set<String> labels = labels(f);
        GmailStore.Msg cur = store.get(id);
        boolean seen = flags.contains("\\seen"), flagged = flags.contains("\\flagged") || labels.remove("\\Starred"), answered = flags.contains("\\answered"),
                draft = flags.contains("\\draft") || labels.contains("\\Draft");
        long modseq = modseqOf(f);
        if (cur.seen == seen && cur.flagged == flagged && cur.answered == answered && cur.draft == draft && cur.box.equals(box) && cur.labels.equals(labels)) {
            return false;
        }
        store.updateState(id, seen, flagged, answered, draft, labels, box, modseq);
        return true;
    }

    private static long modseqOf(Imap.Fetch f) {
        Object m = f.get("MODSEQ");
        if (m instanceof List && !((List<?>) m).isEmpty()) return Imap.num(((List<?>) m).get(0));
        return 0;
    }

    /** X-GM-LABELS decoded; \Starred is a flag here, Trash/Spam are folders. */
    static Set<String> labels(Imap.Fetch f) {
        Set<String> out = new LinkedHashSet<>();
        for (String l : f.strings("X-GM-LABELS")) {
            String name = l.startsWith("\\") ? "\\" + Character.toUpperCase(l.charAt(1)) + l.substring(2) : MUtf7.decode(l);
            if (name.equals("\\Trash") || name.equals("\\Spam")) continue;
            out.add(name);
        }
        return out;
    }

    /** Deletions in [lo, hi]: compare counts, then per batch of 1000 the actual UIDs. Repairs gaps the other way too. */
    private int expunges(Imap imap, String box, long lo, long hi, Imap.Mailbox mb) throws IOException {
        if (hi < lo) return 0;
        long local = store.countUids(box, lo, hi);
        long server;
        if (imap.has("ESEARCH")) server = imap.uidSearchCount("UID " + lo + ":" + hi);
        else if (lo <= 1) server = imap.selected.exists - countAbove(imap, hi);
        else server = imap.uidSearch("UID " + lo + ":" + hi).size();
        if (server == local) return 0;
        int changes = 0;
        long after = lo - 1;
        for (;;) {
            List<Long> chunk = store.uidsAfter(box, after, hi, 1000);
            long a = after + 1, b = chunk.isEmpty() ? hi : (chunk.size() < 1000 ? hi : chunk.get(chunk.size() - 1));
            if (imap.has("ESEARCH") && imap.uidSearchCount("UID " + a + ":" + b) == chunk.size()) {
                if (chunk.size() < 1000 || b >= hi) break;
                after = b;
                continue;
            }
            List<Long> onServer = imap.uidSearch("UID " + a + ":" + b);
            Set<Long> s = new HashSet<>(onServer);
            for (Long u : chunk) if (!s.contains(u)) { store.unmapKeep(box, u); changes++; }
            Set<Long> known = new HashSet<>(chunk);
            List<Long> missing = new ArrayList<>();
            for (Long u : onServer) if (u >= a && u <= b && !known.contains(u)) missing.add(u);
            if (!missing.isEmpty()) fetchHeaders(imap, box, Imap.set(missing), 0, (m, isNew) -> { }, new long[1]);
            if (chunk.size() < 1000 || b >= hi) break;
            after = b;
        }
        return changes;
    }

    /** Messages with UID above hi (new ones that arrived after our fetch), via UID SEARCH. */
    private static long countAbove(Imap imap, long hi) throws IOException {
        List<Long> above = imap.uidSearch("UID " + (hi + 1) + ":*");
        long c = 0;
        for (Long u : above) if (u > hi) c++;
        return c;
    }

    interface Seen {
        void saved(GmailStore.Msg m, boolean isNew);
    }

    static final String HEADER_FIELDS = "BODY.PEEK[HEADER.FIELDS (FROM TO CC REPLY-TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE CONTENT-TRANSFER-ENCODING)]";

    /**
     * Headers, flags, labels and a snippet (from the first 2 KB of the body) for {@code set}; only UIDs >= minUid.
     * Messages already known by X-GM-MSGID only get the new UID mapping and state.
     */
    void fetchHeaders(Imap imap, String box, String set, long minUid, Seen seen, long[] maxUid) throws IOException {
        String items = "(UID FLAGS INTERNALDATE RFC822.SIZE X-GM-MSGID X-GM-THRID X-GM-LABELS " + (imap.condstore() ? "MODSEQ " : "") + HEADER_FIELDS + " BODY.PEEK[TEXT]<0.2048>)";
        boolean resetting = store.hasOld(box);
        imap.uidFetch(set, items, null, f -> {
            long uid = f.uid();
            if (uid < minUid) return;
            maxUid[0] = Math.max(maxUid[0], uid);
            String id = Imap.str(f.get("X-GM-MSGID"));
            if (id.isEmpty() || !id.matches("\\d+")) return;
            boolean known = store.exists(id);
            store.map(box, uid, id);
            if (resetting) store.dropOld(box, id);
            if (known) {
                applyState(box, f);
                seen.saved(store.get(id), false);
                return;
            }
            GmailStore.Msg m = headerMsg(f, box, id);
            store.save(m);
            seen.saved(m, true);
        });
    }

    static GmailStore.Msg headerMsg(Imap.Fetch f, String box, String id) {
        GmailStore.Msg m = new GmailStore.Msg();
        m.id = id;
        m.thr = Imap.str(f.get("X-GM-THRID"));
        m.box = box;
        byte[] head = null;
        for (Map.Entry<String, Object> e : f.items.entrySet()) if (e.getKey().startsWith("BODY[HEADER")) head = e.getValue() instanceof byte[] ? (byte[]) e.getValue() : Imap.str(e.getValue()).getBytes(StandardCharsets.UTF_8);
        Mime.Message hm = new Mime.Message();
        Mime.Headers h = head == null ? new Mime.Headers() : Mime.parseHeaders(head, 0, head.length);
        Mime.fillEnvelope(hm, h);
        m.subject = hm.subject;
        if (!hm.from.isEmpty()) { m.fromName = hm.from.get(0).name; m.fromAddr = hm.from.get(0).email; }
        m.to = Mime.formatList(hm.to);
        m.cc = Mime.formatList(hm.cc);
        m.msgId = hm.messageId;
        m.inReplyTo = hm.inReplyTo;
        m.refs = hm.references;
        if (!hm.replyTo.isEmpty()) m.replyTo = Mime.formatList(hm.replyTo);
        long internal = Imap.internalDate(Imap.str(f.get("INTERNALDATE")));
        m.date = internal > 0 ? internal : hm.date;
        m.size = Math.max(0, Imap.num(f.get("RFC822.SIZE")));
        Set<String> flags = new HashSet<>();
        for (String x : f.strings("FLAGS")) flags.add(x.toLowerCase(Locale.ROOT));
        Set<String> labels = labels(f);
        m.seen = flags.contains("\\seen");
        m.flagged = flags.contains("\\flagged") || labels.remove("\\Starred");
        m.answered = flags.contains("\\answered");
        m.draft = flags.contains("\\draft") || labels.contains("\\Draft");
        m.labels.addAll(labels);
        m.modseq = modseqOf(f);
        Mime.ContentType ct = Mime.parseContentType(h.get("Content-Type"));
        m.attach = ct.mime().equals("multipart/mixed");
        byte[] text = f.body("BODY[TEXT]");
        if (text != null && text.length > 0) m.snippet = snippetFrom(head, text);
        return m;
    }

    /** A preview from the header fields and the start of the body (multipart, QP, base64 and HTML all handled). */
    static String snippetFrom(byte[] head, byte[] start) {
        byte[] h = head == null ? new byte[0] : head;
        int hl = h.length;
        while (hl > 0 && (h[hl - 1] == '\n' || h[hl - 1] == '\r')) hl--;
        byte[] raw = new byte[hl + 4 + start.length];
        System.arraycopy(h, 0, raw, 0, hl);
        raw[hl] = '\r';
        raw[hl + 1] = '\n';
        raw[hl + 2] = '\r';
        raw[hl + 3] = '\n';
        System.arraycopy(start, 0, raw, hl + 4, start.length);
        // base64 cut in the middle of a group: drop the incomplete tail before decoding
        Mime.Message m = Mime.parse(raw);
        Mime.Part t = m.textPart(), html = m.htmlPart();
        for (Mime.Part p : new Mime.Part[]{t, html}) if (p != null && p.data != null) p.data = Mime.trimPartialUtf8(p.data, p.charset);
        if (t != null && !t.text().trim().isEmpty()) return Mime.snippet(t.text(), 200);
        if (html != null) return Mime.snippet(Mime.htmlToText(html.text().replaceAll("<[^>]*$", "")), 200);
        return "";
    }

    // ───────── First sync and window ─────────

    /** Headers of the window (newest first), then bodies of the window, then Trash/Spam, then older headers. */
    private boolean backfill(Imap imap, Settings s, Options o, long deadline) throws IOException {
        long since = windowStart(s);
        if (!walk(imap, GmailStore.ALL, since, true, deadline)) return true;
        if (bodies(imap, s, o, deadline)) return true;
        for (String box : new String[]{GmailStore.TRASH, GmailStore.SPAM}) if (!walk(imap, box, 0, false, deadline)) return true;
        if (!walk(imap, GmailStore.ALL, 0, false, deadline)) return true;
        // UIDs follow arrival, not the Date: header (imports), so the full walk can still find window messages
        return bodies(imap, s, o, deadline);
    }

    /**
     * Walks headers downward from the cursor. With {@code windowOnly}, stops once the batch reaches messages older than
     * {@code since}. Returns true when done (for this purpose), false when time ran out.
     */
    private boolean walk(Imap imap, String box, long since, boolean windowOnly, long deadline) throws IOException {
        String raw = rawFor(box);
        if (raw == null) return true;
        Map<String, Object> st = boxState(box);
        if (st.isEmpty() || Boolean.TRUE.equals(st.get("walkDone"))) return true;
        if (windowOnly && Boolean.TRUE.equals(st.get("windowDone"))) return true;
        if (imap.selected == null || !raw.equals(imap.selected.name)) imap.select(raw, false);
        long cursor = n(st, "cursor"), step = Math.max(1, n(st, "step") == 0 ? initialStep : n(st, "step"));
        boolean first = true;
        while (cursor > 1) {
            if (!first && now() > deadline) { saveBoxState(box, st); return false; }
            first = false; // every run makes at least one batch of progress
            long lo = Math.max(1, cursor - step);
            long[] oldest = {Long.MAX_VALUE};
            int[] count = {0};
            fetchHeaders(imap, box, lo + ":" + (cursor - 1), lo, (m, isNew) -> {
                count[0]++;
                if (m != null && m.date > 0) oldest[0] = Math.min(oldest[0], m.date);
            }, new long[1]);
            cursor = lo;
            // aim for about 300 messages per command; Gmail UIDs can be sparse
            step = count[0] < 100 ? Math.min(20_000, step * 2) : count[0] > 600 ? Math.max(100, step / 2) : step;
            if (step < initialStep) step = initialStep;
            st.put("cursor", cursor);
            st.put("step", step);
            boolean windowReached = since > 0 && oldest[0] < since;
            if (windowReached) st.put("windowDone", true);
            saveBoxState(box, st);
            if (windowOnly && windowReached) return true;
        }
        st.put("walkDone", true);
        st.put("windowDone", true);
        saveBoxState(box, st);
        if (store.hasOld(box)) store.finishReset(box);
        return true;
    }

    /**
     * Downloads content for the window, newest first. On a metered network (unless allowed) only small, recent
     * messages; the rest waits for wifi. Returns true when time ran out with work left.
     */
    private boolean bodies(Imap imap, Settings s, Options o, long deadline) throws IOException {
        boolean full = o.unmetered || s.mobileData;
        long since = full ? windowStart(s) : Math.max(windowStart(s), now() - 3L * 24 * 3600_000);
        long maxSize = full ? s.attachLimit : 512 * 1024;
        Set<String> skip = new HashSet<>();
        for (boolean first = true; ; first = false) {
            if (!first && now() > deadline) return true;
            List<GmailStore.Msg> need = store.needingBody(since, 60 + skip.size());
            need.removeIf(m -> skip.contains(m.id));
            if (need.isEmpty()) return false;
            // per folder, small ones together (at most ~4 MB per command), large ones by structure
            Map<String, List<Object[]>> byBox = new LinkedHashMap<>();
            for (GmailStore.Msg m : need) {
                Object[] loc = store.location(m.id);
                if (loc == null || (!full && m.size > maxSize)) { skip.add(m.id); continue; }
                byBox.computeIfAbsent((String) loc[0], k -> new ArrayList<>()).add(new Object[]{m, loc[1]});
            }
            if (byBox.isEmpty()) return false;
            for (Map.Entry<String, List<Object[]>> e : byBox.entrySet()) {
                String raw = rawFor(e.getKey());
                if (raw == null) { for (Object[] x : e.getValue()) skip.add(((GmailStore.Msg) x[0]).id); continue; }
                if (imap.selected == null || !raw.equals(imap.selected.name)) imap.select(raw, false);
                List<Long> batch = new ArrayList<>();
                Map<Long, GmailStore.Msg> byUid = new HashMap<>();
                long bytes = 0;
                for (Object[] x : e.getValue()) {
                    GmailStore.Msg m = (GmailStore.Msg) x[0];
                    long uid = ((Number) x[1]).longValue();
                    if (m.size > s.attachLimit) {
                        if (!fetchStructured(imap, m.id, uid, s.attachLimit)) skip.add(m.id);
                        continue;
                    }
                    batch.add(uid);
                    byUid.put(uid, m);
                    bytes += m.size;
                    if (bytes > 4L * 1024 * 1024) {
                        fetchFull(imap, batch, byUid, skip);
                        batch.clear();
                        bytes = 0;
                        if (now() > deadline) return true;
                    }
                }
                if (!batch.isEmpty()) fetchFull(imap, batch, byUid, skip);
            }
        }
    }

    private void fetchFull(Imap imap, List<Long> uids, Map<Long, GmailStore.Msg> byUid, Set<String> skip) throws IOException {
        Set<Long> got = new HashSet<>();
        imap.uidFetch(Imap.set(uids), "(UID X-GM-MSGID BODY.PEEK[])", null, f -> {
            byte[] raw = f.body("BODY[]");
            String id = Imap.str(f.get("X-GM-MSGID"));
            if (raw == null || id.isEmpty() || !store.exists(id)) return;
            got.add(f.uid());
            storeFull(id, raw);
        });
        for (Long u : uids) if (!got.contains(u)) skip.add(byUid.get(u).id);
    }

    void storeFull(String id, byte[] raw) throws IOException {
        Mime.Message pm = Mime.parse(raw);
        store.saveParts(id, pm.parts, pm.headers);
        GmailStore.Msg cur = store.get(id);
        if (cur != null && cur.snippet.isEmpty()) {
            Mime.Part t = pm.textPart(), h = pm.htmlPart();
            String text = t != null ? t.text() : h != null ? Mime.htmlToText(h.text()) : "";
            if (!text.isEmpty()) store.setSnippet(id, Mime.snippet(text, 200));
        }
    }

    /** Large message: structure first, then the text and every part up to the limit; the rest on demand. */
    boolean fetchStructured(Imap imap, String id, long uid, long limit) throws IOException {
        Object[] bs = new Object[2];
        imap.uidFetch(String.valueOf(uid), "(UID BODYSTRUCTURE BODY.PEEK[HEADER])", null, f -> {
            bs[0] = f.get("BODYSTRUCTURE");
            bs[1] = f.body("BODY[HEADER]");
        });
        if (bs[0] == null) return false;
        List<Mime.Part> parts = BodyStructure.parse(bs[0]);
        StringBuilder items = new StringBuilder();
        for (Mime.Part p : parts) if (p.isBodyCandidate() || p.size <= limit) items.append(" BODY.PEEK[").append(p.section).append(']');
        if (items.length() > 0) {
            imap.uidFetch(String.valueOf(uid), "(UID" + items + ")", null, f -> {
                for (Mime.Part p : parts) {
                    byte[] enc = f.body("BODY[" + p.section + "]");
                    if (enc != null) { p.data = Mime.decodeTransfer(enc, p.encoding); p.size = p.data.length; }
                }
            });
        }
        byte[] head = (byte[]) bs[1];
        store.saveParts(id, parts, head == null ? null : Mime.parseHeaders(head, 0, head.length));
        return true;
    }

    /** Opening a message whose content is not here yet: fetch it now and keep it ("pinned" when outside the window). */
    public GmailStore.Msg fetchBody(String id) throws IOException {
        GmailStore.Msg m = store.get(id);
        if (m == null) throw new IOException("Dit bericht staat niet (meer) op de telefoon");
        Settings s = settings();
        interactive(imap -> {
            Object[] loc = locate(imap, id);
            if (loc == null) throw new IOException("Dit bericht staat niet meer in Gmail");
            long uid = ((Number) loc[1]).longValue();
            if (m.size > s.attachLimit) fetchStructured(imap, id, uid, s.attachLimit);
            else {
                byte[][] raw = new byte[1][];
                imap.uidFetch(String.valueOf(uid), "(UID BODY.PEEK[])", null, f -> raw[0] = f.body("BODY[]"));
                if (raw[0] == null) throw new IOException("Dit bericht staat niet meer in Gmail");
                storeFull(id, raw[0]);
            }
            return null;
        });
        if (m.date < windowStart(s)) store.setFlag(id, "pinned", true);
        return store.get(id);
    }

    /** One part (a large attachment) on demand. */
    public byte[] fetchPart(String id, String section) throws IOException {
        byte[] have = store.readPart(id, section);
        if (have != null) return have;
        GmailStore.PartRow row = null;
        for (GmailStore.PartRow p : store.parts(id)) if (p.section.equals(section)) row = p;
        if (row == null) throw new IOException("Deze bijlage bestaat niet");
        final String enc = row.encoding;
        byte[] data = interactive(imap -> {
            Object[] loc = locate(imap, id);
            if (loc == null) throw new IOException("Dit bericht staat niet meer in Gmail");
            byte[][] out = new byte[1][];
            imap.uidFetch(String.valueOf(loc[1]), "(UID BODY.PEEK[" + section + "])", null, f -> {
                byte[] b = f.body("BODY[" + section + "]");
                if (b != null) out[0] = Mime.decodeTransfer(b, enc);
            });
            if (out[0] == null) throw new IOException("Deze bijlage kon niet worden opgehaald");
            return out[0];
        });
        store.savePartData(id, section, data);
        if (store.get(id) != null && store.get(id).date < windowStart(settings())) store.setFlag(id, "pinned", true);
        return data;
    }

    /** Selects the folder that holds the message; {box, uid} or null when Gmail no longer has it. */
    private Object[] locate(Imap imap, String id) throws IOException {
        Object[] loc = store.location(id);
        if (loc != null) {
            String raw = rawFor((String) loc[0]);
            if (raw != null) {
                if (imap.selected == null || !raw.equals(imap.selected.name)) imap.select(raw, false);
                return loc;
            }
        }
        for (String box : new String[]{GmailStore.ALL, GmailStore.TRASH, GmailStore.SPAM}) {
            String raw = rawFor(box);
            if (raw == null) continue;
            imap.select(raw, false);
            List<Long> u = imap.uidSearch("X-GM-MSGID " + id);
            if (!u.isEmpty()) {
                store.map(box, u.get(0), id);
                return new Object[]{box, u.get(0)};
            }
        }
        return null;
    }

    // ───────── Search at Gmail ─────────

    /** Gmail's own search (X-GM-RAW, same syntax as the search box in Gmail); newest 100 hits, stored as headers. */
    public List<String> remoteSearch(String query) throws IOException {
        return interactive(imap -> {
            String raw = rawFor(GmailStore.ALL);
            imap.select(raw, false);
            Object q = Imap.astring(query);
            List<Long> uids = q instanceof Imap.Lit ? imap.uidSearch("CHARSET UTF-8 X-GM-RAW ", q) : imap.uidSearch("X-GM-RAW ", q);
            uids.sort((a, b) -> Long.compare(b, a));
            if (uids.size() > 100) uids = new ArrayList<>(uids.subList(0, 100));
            List<Long> unknown = new ArrayList<>();
            for (Long u : uids) if (store.idFor(GmailStore.ALL, u) == null) unknown.add(u);
            if (!unknown.isEmpty()) fetchHeaders(imap, GmailStore.ALL, Imap.set(unknown), 0, (m, isNew) -> { }, new long[1]);
            List<String> ids = new ArrayList<>();
            for (Long u : uids) {
                String id = store.idFor(GmailStore.ALL, u);
                if (id != null) ids.add(id);
            }
            return ids;
        });
    }

    // ───────── Phone → Gmail ─────────

    /** Queues a change that the app already applied locally. Stores where the message is now, in case it is gone later. */
    public void queue(String id, String op, Map<String, Object> args) {
        Map<String, Object> a = args == null ? Json.obj() : new LinkedHashMap<>(args);
        Object[] loc = store.location(id);
        if (loc != null) { a.put("box", loc[0]); a.put("uid", loc[1]); }
        store.enqueue(id, op, a);
        wake();
    }

    /** Replays queued changes in order. Network errors stop the replay (kept for later); refusals are retried a few times. */
    void replay(Imap imap) throws IOException {
        for (int round = 0; round < 20; round++) {
            List<GmailStore.Op> ops = store.ops(200);
            if (ops.isEmpty()) return;
            for (GmailStore.Op op : ops) {
                try {
                    apply(imap, op);
                    store.opDone(op.seq);
                } catch (Imap.ImapException e) {
                    if ("BYE".equals(e.status)) throw e;
                    if (op.tries >= 3) store.opDone(op.seq); // Gmail keeps refusing: its state wins
                    else store.opFailed(op.seq, e.getMessage());
                }
            }
        }
    }

    private void apply(Imap imap, GmailStore.Op op) throws IOException {
        Object[] loc = store.location(op.id);
        if (loc == null && op.args.get("box") != null) loc = new Object[]{op.args.get("box"), op.args.get("uid")};
        if (loc == null) return; // never on the server or already gone: nothing to do
        String box = (String) loc[0];
        long uid = ((Number) loc[1]).longValue();
        String raw = rawFor(box);
        if (raw == null) return;
        if (imap.selected == null || !raw.equals(imap.selected.name)) imap.select(raw, false);
        String u = String.valueOf(uid);
        Imap.StoreResult res = null;
        switch (op.op) {
            case "seen": res = imap.uidStore(u, null, "+FLAGS", "(\\Seen)"); break;
            case "unseen": res = imap.uidStore(u, null, "-FLAGS", "(\\Seen)"); break;
            case "flag": res = imap.uidStore(u, null, "+FLAGS", "(\\Flagged)"); break;
            case "unflag": res = imap.uidStore(u, null, "-FLAGS", "(\\Flagged)"); break;
            case "answered": res = imap.uidStore(u, null, "+FLAGS", "(\\Answered)"); break;
            case "label":
            case "unlabel": {
                if (!box.equals(GmailStore.ALL)) return; // labels belong to messages in All Mail
                String label = String.valueOf(op.args.get("label"));
                res = imap.uidStore(u, null, (op.op.equals("label") ? "+" : "-") + "X-GM-LABELS", "(" + Imap.label(label) + ")");
                break;
            }
            case "archive":
                if (!box.equals(GmailStore.ALL)) return;
                res = imap.uidStore(u, null, "-X-GM-LABELS", "(\\Inbox)");
                break;
            case "inbox":
                if (box.equals(GmailStore.ALL)) res = imap.uidStore(u, null, "+X-GM-LABELS", "(\\Inbox)");
                else move(imap, box, uid, op.id, store.folderRaw("inbox"));
                break;
            case "trash":
                if (!box.equals(GmailStore.TRASH)) move(imap, box, uid, op.id, rawFor(GmailStore.TRASH));
                break;
            case "spam":
                if (!box.equals(GmailStore.SPAM)) move(imap, box, uid, op.id, rawFor(GmailStore.SPAM));
                break;
            case "delete":
                if (box.equals(GmailStore.ALL)) { move(imap, box, uid, op.id, rawFor(GmailStore.TRASH)); break; }
                imap.uidStore(u, null, "+FLAGS.SILENT", "(\\Deleted)");
                imap.uidExpunge(u);
                store.unmap(box, uid);
                break;
            default:
                return;
        }
        if (res != null && !res.touched.contains(uid) && imap.uidSearch("UID " + u).isEmpty()) {
            // Gmail no longer has it in this folder: its state wins; the pull settles where it went (or that it is gone).
            store.unmapKeep(box, uid);
        }
    }

    private void move(Imap imap, String box, long uid, String id, String destRaw) throws IOException {
        if (destRaw == null) throw new Imap.ImapException("NO", null, "Deze map is niet zichtbaar in IMAP");
        if (imap.uidSearch("UID " + uid).isEmpty()) { store.unmapKeep(box, uid); return; }
        imap.uidMove(String.valueOf(uid), destRaw);
        // Remove only this mapping; the destination folder's pull maps it again under its new UID.
        store.unmapKeep(box, uid);
    }

    // ───────── Sending ─────────

    /** Sends what is in the outbox. A message stays until Gmail confirmed it (or the user deletes a refused one). */
    void sendOutbox(Imap imap) throws IOException {
        for (GmailStore.Outgoing o : store.outbox()) {
            if (!o.state.equals("queued") && !o.state.equals("unknown")) continue;
            if (o.nextAt > now()) continue;
            if (o.state.equals("unknown") && o.msgId != null) {
                // Did it go out last time? Gmail files sent mail in All Mail with the same Message-ID.
                String raw = rawFor(GmailStore.ALL);
                if (raw != null) {
                    imap.select(raw, false);
                    if (!imap.uidSearch("HEADER Message-ID ", Imap.astring(o.msgId)).isEmpty()) { store.outboxSent(o.seq); continue; }
                }
            }
            sendOne(o);
        }
    }

    /** Sends one outbox entry now (also used by "Opnieuw proberen"). */
    public void sendOne(GmailStore.Outgoing o) {
        File f = store.outboxFile(o.seq);
        if (!f.exists()) { store.outboxState(o.seq, "failed", "Het bericht is niet meer op de telefoon", 0); return; }
        store.outboxState(o.seq, "sending", null, 0);
        try {
            Smtp.send(smtp, account.address(), account.password(), account.address(), o.rcpt, () -> new FileInputStream(f));
            store.outboxSent(o.seq);
        } catch (Smtp.SmtpException e) {
            long wait = Math.min(60L * 60_000, 60_000L << Math.min(6, o.tries));
            if (e.auth) store.outboxState(o.seq, "queued", AUTH_FAILED, now() + 15 * 60_000L);
            else if (e.permanent) store.outboxState(o.seq, "failed", "Gmail weigert dit bericht: " + e.getMessage(), 0);
            else if (e.maybeSent) store.outboxState(o.seq, "unknown", "Niet zeker of het verstuurd is; de app kijkt het na", now() + 60_000L);
            else store.outboxState(o.seq, "queued", "Nog niet verstuurd: " + friendly(e), now() + wait);
        } catch (IOException | RuntimeException e) {
            store.outboxState(o.seq, "queued", "Nog niet verstuurd: " + friendly(e), now() + 60_000L);
        }
    }

    // ───────── Window and space ─────────

    /** Content of messages that fell out of the window goes (except what was opened on purpose). */
    public int applyRetention(Settings s) {
        long since = windowStart(s);
        if (since <= 0) return 0;
        int n = 0;
        for (;;) {
            List<String> ids = store.bodiesOutside(since, false, 500);
            if (ids.isEmpty()) return n;
            for (String id : ids) store.dropBody(id);
            n += ids.size();
        }
    }

    /** "Vrijmaken": also the messages opened on purpose outside the window. Returns bytes freed. */
    public long freeSpace() {
        long before = store.storageBytes();
        long since = windowStart(settings());
        if (since > 0) {
            for (;;) {
                List<String> ids = store.bodiesOutside(since, true, 500);
                if (ids.isEmpty()) break;
                for (String id : ids) store.dropBody(id);
            }
        }
        return Math.max(0, before - store.storageBytes());
    }

    private void progress(Settings s, Options o) {
        long since = windowStart(s);
        long headers = store.count("m.box != ''"), total = 0;
        for (String box : new String[]{GmailStore.ALL, GmailStore.TRASH, GmailStore.SPAM}) total += n(boxState(box), "exists");
        long inWindow = store.count("m.box != 'spam' AND m.date >= ?", since), withBody = store.count("m.box != 'spam' AND m.date >= ? AND m.body > 0", since);
        synchronized (store) {
            Map<String, Object> ns = store.json("status");
            ns.put("headers", Json.obj("done", Math.min(headers, Math.max(total, headers)), "total", Math.max(total, headers)));
            ns.put("bodies", Json.obj("done", withBody, "total", inWindow));
            ns.put("walkDone", Boolean.TRUE.equals(boxState(GmailStore.ALL).get("walkDone")));
            ns.put("waitingForWifi", !o.unmetered && !s.mobileData && withBody < inWindow);
            store.putJson("status", ns);
        }
    }

    // ───────── While the app is open ─────────

    public interface Listener {
        void changed(Result r);
    }

    /**
     * Keeps Gmail and the phone in step while the app is open: a run, then IDLE on INBOX (new mail arrives at once),
     * at most {@code pollMs} so other folders are checked too, and straight away when the user changed something.
     */
    public void idleLoop(BooleanSupplier stop, long pollMs, Listener listener) {
        Imap idle = null;
        while (!stop.getAsBoolean()) {
            wake = false;
            Options o = new Options();
            o.budgetMs = 45_000;
            o.unmetered = unmetered.getAsBoolean();
            Result r = run(o);
            listener.changed(r);
            if (r.authFailed) return;
            if (r.more && r.ok) continue;
            if (!r.ok) {
                if (idle != null) { idle.close(); idle = null; }
                sleep(Math.min(pollMs, 30_000), stop);
                continue;
            }
            try {
                if (idle == null) {
                    idle = connect();
                    idle.select(store.folderRaw("inbox") == null ? "INBOX" : store.folderRaw("inbox"), true);
                }
                idle.idle(pollMs, () -> stop.getAsBoolean() || wake);
            } catch (IOException | RuntimeException e) {
                if (idle != null) idle.close();
                idle = null;
                sleep(5_000, stop);
            }
        }
        if (idle != null) idle.logout();
    }

    /** UIDs per header batch at the start of a walk (it adapts to how dense the UIDs are). */
    public long initialStep = 400;

    /** Whether the current network is unmetered (set by the app; tests leave it true). */
    public BooleanSupplier unmetered = () -> true;

    private void sleep(long ms, BooleanSupplier stop) {
        long until = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < until && !stop.getAsBoolean() && !wake) {
            try { Thread.sleep(200); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }
}
