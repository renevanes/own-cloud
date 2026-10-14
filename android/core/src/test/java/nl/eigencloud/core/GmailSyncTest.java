package nl.eigencloud.core;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import nl.eigencloud.core.gmail.GmailApi;
import nl.eigencloud.core.gmail.GmailStore;
import nl.eigencloud.core.gmail.GmailSync;
import nl.eigencloud.core.gmail.Imap;
import nl.eigencloud.core.gmail.Mime;
import nl.eigencloud.core.gmail.Smtp;

/**
 * Gmail on the phone against a fake Gmail (GmailFake, IMAP + SMTP) and real SQLite (GmailNodeSql): first sync with the
 * window, on-demand content, changes both ways, offline queue and conflicts, UIDVALIDITY, sending, search, IDLE and the
 * fallbacks for servers without MOVE/CONDSTORE/ESEARCH/COMPRESS.
 */
public class GmailSyncTest {
    static final long DAY = 24 * 3600_000L;
    static final long NOW = System.currentTimeMillis();

    static final class Host implements GmailApi.Host {
        String[] cred;
        boolean confirmed;

        @Override public String[] credentials() { return cred; }

        @Override public void saveCredentials(String a, String p) { cred = new String[]{a, p}; }

        @Override public void forgetCredentials() { cred = null; }

        @Override public boolean confirmed() { return confirmed; }
    }

    static GmailFake fake;
    static File root;
    static int stores;

    static Imap.Config imap(int port) {
        Imap.Config c = new Imap.Config();
        c.host = "127.0.0.1";
        c.port = port;
        c.tls = false;
        c.timeoutMs = 10_000;
        return c;
    }

    static Smtp.Server smtp() {
        Smtp.Server s = new Smtp.Server("127.0.0.1", fake.smtpPort(), Smtp.Security.NONE);
        s.timeoutMs = 10_000;
        return s;
    }

    static GmailApi api(Host host) throws IOException {
        File dir = new File(root, "store" + (++stores));
        GmailStore store = new GmailStore(new GmailNodeSql(null), dir);
        GmailApi api = new GmailApi(store, host, imap(fake.imapPort()), smtp());
        api.contentBase = "https://appassets.androidplatform.net/gmail/";
        return api;
    }

    static Host host() {
        Host h = new Host();
        h.cred = new String[]{fake.user, fake.password};
        return h;
    }

    static Map<String, Object> call(GmailApi api, String method, String path, Object body) {
        GmailApi.Reply r = api.handle(method, path, body == null ? null : Json.stringify(body));
        Map<String, Object> j = Json.parseObject(r.body);
        if (r.status != 200) j.put("_status", (long) r.status);
        return j;
    }

    static GmailSync.Result run(GmailApi api) {
        GmailSync.Options o = new GmailSync.Options();
        o.budgetMs = 60_000;
        o.interactive = true;
        return api.sync().run(o);
    }

    static String raw(String from, String to, String subject, String body, String extra) {
        return "From: " + from + "\nTo: " + to + "\nSubject: " + subject + "\nDate: Mon, 1 Jan 2024 10:00:00 +0000\nMessage-ID: <" + Math.abs(subject.hashCode()) + "." + (fakeSeq++) + "@example.org>\n"
                + (extra == null ? "" : extra) + "MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n" + body + "\n";
    }

    static int fakeSeq;

    static String idOf(GmailFake.Msg m) { return String.valueOf(m.gmid); }

    public static void main(String[] args) {
        T.main("GmailSyncTest", () -> {
            root = Files.createTempDirectory("gmail-test").toFile();
            fake = new GmailFake();
            try {
                setupAndFirstSync();
            } finally {
                fake.close();
            }
        });
    }

    static GmailFake.Msg firstAdded, inboxNew, old, big, reply, original, trashed, spam, werk, draft, accent;

    static void populate() {
        for (int i = 0; i < 24; i++) {
            GmailFake.Msg n = fake.add(raw("Nieuwsbrief <news@shop.nl>", "rene.test@gmail.com", "Aanbieding " + i, "Korting nummer " + i + " deze week.", null), NOW - (i * 20 + 5) * DAY, i % 3 == 0 ? "\\Inbox" : "Nieuws", "\\Seen");
            if (i == 0) firstAdded = n;
        }
        original = fake.add("From: Anna <anna@example.org>\nTo: rene.test@gmail.com, piet@example.org\nCc: kees@example.org\nReply-To: anna.prive@example.org\nSubject: Reis naar Lissabon\nDate: Tue, 1 Jul 2025 10:00:00 +0200\nMessage-ID: <reis1@example.org>\nReferences: <eerder@example.org>\n"
                + "MIME-Version: 1.0\nContent-Type: multipart/alternative; boundary=b1\n\n--b1\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nZullen we in mei gaan? Het kost =E2=82=AC 400.\n--b1\nContent-Type: text/html; charset=utf-8\n\n<p>Zullen we in <b>mei</b> gaan? <img src=\"https://tracker.example/p.gif\"></p>\n--b1--\n",
                NOW - 10 * DAY, "\\Inbox", "\\Important");
        reply = fake.add("From: Piet <piet@example.org>\nTo: anna@example.org\nSubject: Re: Reis naar Lissabon\nDate: Wed, 2 Jul 2025 10:00:00 +0200\nMessage-ID: <reis2@example.org>\nIn-Reply-To: <reis1@example.org>\nReferences: <eerder@example.org> <reis1@example.org>\n\nGoed plan!\n",
                NOW - 9 * DAY, "\\Inbox");
        StringBuilder blob = new StringBuilder();
        for (int i = 0; i < 50_000; i++) blob.append("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=").append(i % 2 == 0 ? "" : "\n");
        big = fake.add("From: Fotograaf <foto@example.org>\nTo: rene.test@gmail.com\nSubject: Grote bijlage\nMessage-ID: <groot@example.org>\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=bb\n\n--bb\nContent-Type: text/plain\n\nHierbij de foto's.\n"
                + "--bb\nContent-Type: application/zip; name=\"fotos.zip\"\nContent-Disposition: attachment; filename=\"fotos.zip\"\nContent-Transfer-Encoding: base64\n\n" + blob + "\n--bb--\n", NOW - 3 * DAY, "\\Inbox");
        old = fake.add(raw("Oom <oom@example.org>", "rene.test@gmail.com", "Oude herinnering", "Weet je nog, de camping in 2019? " + "Het was een mooie tijd met veel zon en gezelligheid. ".repeat(6) + "Het geheime woord was zeldzaamwoord. Groet, oom", null), NOW - 900 * DAY, "\\Seen", "Herinneringen");
        werk = fake.add(raw("Baas <baas@werk.nl>", "rene.test@gmail.com", "Planning", "Maandag overleg.", null), NOW - 30 * DAY, "Werk", "Reizen/2024");
        accent = fake.add(raw("Élise <elise@example.org>", "rene.test@gmail.com", "=?UTF-8?Q?Caf=C3=A9_morgen?=", "Zullen we naar het café?", null), NOW - 2 * DAY, "\\Inbox", "Én");
        draft = fake.add(raw("rene.test@gmail.com", "x@example.org", "Concept", "nog niet af", null), NOW - DAY, "\\Draft", "\\Seen");
        draft.flags.add("\\Draft");
        trashed = fake.add(raw("Spammer <s@example.org>", "rene.test@gmail.com", "Weggegooid", "weg ermee", null), NOW - 4 * DAY, "trash");
        spam = fake.add(raw("Prins <prins@example.org>", "rene.test@gmail.com", "Erfenis", "stuur geld", null), NOW - 5 * DAY, "spam");
        inboxNew = fake.add(raw("Moeder <mama@example.org>", "rene.test@gmail.com", "Zondag eten?", "Kom je zondag eten?", null), NOW - DAY / 2, "\\Inbox");
    }

    static void setupAndFirstSync() throws Exception {
        populate();
        // ── setup: paste, test, store ──
        Host h = new Host();
        GmailApi api = api(h);
        T.eq(false, call(api, "GET", "/api/state", null).get("configured"), "not configured");
        Map<String, Object> bad = api.pastePassword("geen wachtwoord");
        T.eq(false, bad.get("ok"), "clipboard without app password refused");
        Map<String, Object> pasted = api.pastePassword("wxyz wxyz wxyz wxyz");
        T.eq("wxyz •••• •••• wxyz", pasted.get("masked"), "masked paste");
        Map<String, Object> wrong = call(api, "POST", "/api/setup", Json.obj("address", "rene.test@gmail.com"));
        T.eq(400L, wrong.get("_status"), "wrong app password refused");
        T.eq(GmailSync.AUTH_FAILED, wrong.get("error"), "friendly auth error");
        T.eq(null, h.cred, "nothing stored after a failed test");
        api.pastePassword("  abcd efgh ijkl mnop\n");
        Map<String, Object> ok = call(api, "POST", "/api/setup", Json.obj("address", " Rene.Test@Gmail.com "));
        T.eq(true, ok.get("ok"), "setup ok: " + ok);
        T.eq("rene.test@gmail.com", h.cred[0], "address stored normalised");
        T.eq("abcdefghijklmnop", h.cred[1], "password stored without spaces");
        T.check(fake.smtpLog.contains("AUTH PLAIN …"), "SMTP login checked during setup");
        Map<String, Object> again = call(api, "POST", "/api/setup", Json.obj("address", "rene.test@gmail.com", "password", "abcd efgh ijkl mnop"));
        T.eq(403L, again.get("_status"), "changing the account needs the fingerprint");
        T.eq(403L, call(api, "GET", "/api/account", null).get("_status"), "showing the account needs the fingerprint");
        h.confirmed = true;
        T.eq("abcd •••• •••• mnop", call(api, "GET", "/api/account", null).get("password"), "account shown masked after confirming");
        h.confirmed = false;

        // ── first sync, resumable, newest first ──
        api.sync().initialStep = 5;
        GmailSync.Options tiny = new GmailSync.Options();
        tiny.budgetMs = 1;
        tiny.interactive = true;
        GmailSync.Result first = api.sync().run(tiny);
        T.check(first.ok && first.more, "first run stops early with more to do: " + first.error);
        T.check(api.store.exists(idOf(inboxNew)), "newest message first");
        T.check(!api.store.exists(idOf(firstAdded)), "lowest UID not yet");
        Map<String, Object> st = Json.map(call(api, "GET", "/api/state", null), "status");
        T.check(Json.num(st, "headers", "done").longValue() < Json.num(st, "headers", "total").longValue(), "progress shows partial headers: " + st);
        int runs = 1;
        GmailSync.Result r = first;
        while (r.more && runs < 60) { r = api.sync().run(tiny); runs++; }
        T.check(r.ok && !r.more, "first sync completes over several runs (" + runs + ")");
        T.check(runs > 3, "it really took several runs");
        T.check(fake.log.contains("COMPRESS DEFLATE"), "COMPRESS=DEFLATE used");
        T.check(fake.log.stream().anyMatch(l -> l.startsWith("ENABLE CONDSTORE")), "CONDSTORE enabled");
        T.check(fake.log.stream().anyMatch(l -> l.startsWith("SELECT [Gmail]/Alle berichten")), "All Mail found by \\All, not by name");

        GmailStore s = api.store;
        int allMail = 0;
        for (GmailFake.Msg m : fake.msgs) if (m.loc.equals("all")) allMail++;
        T.eq((long) allMail, s.count("m.box = 'all'"), "every All Mail message once");
        T.eq("trash", s.get(idOf(trashed)).box, "trash message in trash");
        T.eq("spam", s.get(idOf(spam)).box, "spam message in spam");
        T.check(s.get(idOf(inboxNew)).labels.contains("\\Inbox"), "inbox label");
        T.check(s.get(idOf(werk)).labels.containsAll(Arrays.asList("Werk", "Reizen/2024")), "user labels incl. nested");
        T.check(s.get(idOf(accent)).labels.contains("Én"), "non-ASCII label decoded (mUTF-7)");
        T.eq("Café morgen", s.get(idOf(accent)).subject, "encoded subject");
        T.eq(true, s.get(idOf(draft)).draft, "draft");
        T.eq(s.get(idOf(original)).thr, s.get(idOf(reply)).thr, "thread id shared");
        List<String> folderNames = new ArrayList<>();
        for (String[] f : s.folders()) folderNames.add(f[0] + "=" + f[2]);
        T.check(folderNames.contains("Én=") && folderNames.contains("Reizen/2024=") && folderNames.contains("[Gmail]/Prullenbak=trash"), "folders with roles: " + folderNames);
        // window: recent complete, old headers + snippet only
        GmailStore.Msg o = s.get(idOf(old));
        T.eq(GmailStore.NONE, o.body, "old message: no content");
        T.check(o.snippet.startsWith("Weet je nog"), "old message: snippet from the partial fetch: " + o.snippet);
        GmailStore.Msg orig = s.get(idOf(original));
        T.eq(GmailStore.COMPLETE, orig.body, "recent message complete");
        T.eq("Zullen we in mei gaan? Het kost € 400.", orig.snippet, "snippet decoded (QP, UTF-8)");
        T.eq("anna.prive@example.org", orig.replyTo, "Reply-To kept");
        T.eq(true, orig.labels.contains("\\Important"), "important label");
        Map<String, Object> state = call(api, "GET", "/api/state", null);
        T.check(Json.num(state, "storage").longValue() > 1000, "storage counted");
        T.eq(true, Json.map(state, "status").get("walkDone"), "walk done");

        // ── big message: text yes, attachment above the limit on demand ──
        GmailSync.Settings set = api.sync().settings();
        T.eq(12, set.months, "default window 12 months");
        GmailStore.Msg bg = s.get(idOf(big));
        smallLimitForBig(api);

        // ── reading ──
        Map<String, Object> msg = call(api, "GET", "/api/message?id=" + idOf(original), null);
        T.eq(true, msg.get("hasHtml"), "html message");
        T.eq(1L, msg.get("remoteImages"), "one remote image blocked");
        T.eq(2, Json.listAt(msg, "thread").size(), "thread of two");
        String doc = api.viewDocument(idOf(original), false);
        T.check(doc.contains("<b>mei</b>") && !doc.contains("tracker.example"), "view: sanitized, tracker blocked");
        T.check(api.viewDocument(idOf(original), true).contains("tracker.example"), "view with images allowed");

        // ── on demand: old message ──
        Map<String, Object> om = call(api, "GET", "/api/message?id=" + idOf(old), null);
        T.eq(null, om.get("fetchError"), "fetched on open");
        GmailStore.Msg o2 = s.get(idOf(old));
        T.eq(GmailStore.COMPLETE, o2.body, "old message complete after opening");
        T.eq(true, o2.pinned, "kept (pinned) because opened on purpose");
        T.check(api.viewDocument(idOf(old), false).contains("zeldzaamwoord"), "old message readable");

        // ── search ──
        List<Object> local = Json.listAt(call(api, "GET", "/api/messages?view=inbox&q=lissabon", null), "messages");
        T.eq(2, local.size(), "local search in subject");
        T.eq(0, Json.listAt(call(api, "GET", "/api/messages?view=inbox&q=lissabon%20zzz", null), "messages").size(), "all words must match");
        T.eq(1, Json.listAt(call(api, "GET", "/api/messages?q=%C3%A9lise&scope=everywhere&view=inbox", null), "messages").size(), "search in sender name with accent, everywhere");

        incrementalGmailToPhone(api);
        phoneToGmail(api);
        offlineAndConflicts(api);
        sending(api);
        remoteSearch(api);
        uidValidity(api);
        windowAndSpace(api);
        idle(api);
        fallbacks();
        authFailure(api);
        forget(api, h);
    }

    static void smallLimitForBig(GmailApi api) throws IOException {
        GmailStore s = api.store;
        // 1 MB limit: the 1.4 MB zip stays on Gmail until asked for
        Map<String, Object> st = call(api, "PUT", "/api/settings", Json.obj("attachLimitMb", 1L));
        T.eq(1L, Json.num(st, "settings", "attachLimitMb"), "limit saved");
        s.dropBody(idOf(big));
        GmailSync.Result r = run(api);
        T.check(r.ok, "run after limit change");
        GmailStore.Msg bg = s.get(idOf(big));
        T.eq(GmailStore.PARTIAL, bg.body, "big message partial");
        List<GmailStore.PartRow> parts = s.parts(idOf(big));
        T.eq(2, parts.size(), "two parts from BODYSTRUCTURE");
        T.eq(true, parts.get(0).file, "text downloaded");
        T.eq(false, parts.get(1).file, "zip left on Gmail");
        T.eq("fotos.zip", parts.get(1).name, "zip name");
        T.check(api.viewDocument(idOf(big), false).contains("Hierbij de foto"), "text readable");
        byte[] zip = api.partData(idOf(big), parts.get(1).section, true);
        T.eq(50_000 * 26, zip.length, "attachment fetched on demand and decoded (concatenated base64 blocks)");
        T.eq("ABCDEFGHIJKLMNOPQRSTUVWXYZ", new String(zip, 0, 26, StandardCharsets.US_ASCII), "attachment bytes");
        T.eq(GmailStore.COMPLETE, s.get(idOf(big)).body, "complete after fetching the attachment");
        call(api, "PUT", "/api/settings", Json.obj("attachLimitMb", 10L));
    }

    static int bodyFetches() {
        int n = 0;
        synchronized (fake.log) { for (String l : fake.log) if (l.contains("BODY.PEEK[]")) n++; }
        return n;
    }

    static void incrementalGmailToPhone(GmailApi api) throws IOException {
        GmailStore s = api.store;
        GmailFake.Msg n1 = fake.add(raw("Buurman <buur@example.org>", "rene.test@gmail.com", "Pakketje", "Ik heb je pakket.", null), NOW, "\\Inbox");
        GmailSync.Result r = run(api);
        T.check(r.ok && s.exists(idOf(n1)), "new mail arrives");
        T.eq(1, r.fresh.size(), "reported as new for a notification");
        T.eq("Pakketje", r.fresh.get(0).subject, "notification subject");
        T.eq(GmailStore.COMPLETE, s.get(idOf(n1)).body, "new mail downloaded completely");
        // flags and labels changed in Gmail
        fake.change(inboxNew, () -> { inboxNew.flags.add("\\Seen"); inboxNew.flags.add("\\Flagged"); });
        fake.change(werk, () -> { werk.labels.remove("Reizen/2024"); werk.labels.add("\\Inbox"); });
        fake.change(n1, () -> n1.labels.remove("\\Inbox"));
        int before = bodyFetches();
        fake.change(reply, () -> reply.loc = "trash");
        GmailFake.Msg gone = accent;
        fake.remove(gone);
        r = run(api);
        T.check(r.ok, "incremental run");
        T.check(fake.log.stream().anyMatch(l -> l.contains("CHANGEDSINCE")), "CONDSTORE CHANGEDSINCE used");
        GmailStore.Msg in = s.get(idOf(inboxNew));
        T.check(in.seen && in.flagged, "read and starred in Gmail → phone");
        T.check(s.get(idOf(werk)).labels.contains("\\Inbox") && !s.get(idOf(werk)).labels.contains("Reizen/2024"), "labels changed in Gmail → phone");
        T.check(!s.get(idOf(n1)).labels.contains("\\Inbox"), "archived in Gmail → phone");
        T.eq("trash", s.get(idOf(reply)).box, "moved to trash in Gmail → phone");
        T.eq(GmailStore.COMPLETE, s.get(idOf(reply)).body, "content kept when moving to trash");
        T.eq(before, bodyFetches(), "no download again for a moved message");
        T.check(!s.exists(idOf(gone)), "deleted in Gmail → deleted on the phone");
        T.check(!s.msgDir(idOf(gone)).exists(), "its files are gone too");
        // back from trash
        fake.change(reply, () -> { reply.loc = "all"; reply.labels.add("\\Inbox"); });
        run(api);
        T.eq("all", s.get(idOf(reply)).box, "restored in Gmail → phone");
    }

    static void phoneToGmail(GmailApi api) {
        GmailStore s = api.store;
        String id = idOf(original);
        T.eq(true, call(api, "POST", "/api/action", Json.obj("ids", Json.list(id), "op", "flag")).get("ok"), "star");
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(id), "op", "unseen"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(id), "op", "label", "label", "Één ✓"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(werk)), "op", "archive"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(inboxNew)), "op", "move", "label", "Familie", "from", "inbox"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(big)), "op", "trash"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(spam)), "op", "inbox"));
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(trashed)), "op", "delete"));
        T.check(s.get(id).flagged && !s.get(id).seen, "applied locally at once");
        T.eq("trash", s.get(idOf(big)).box, "trash locally at once");
        T.check(!s.exists(idOf(trashed)), "deleted forever locally at once");
        T.check(s.pendingOps() >= 8, "queued: " + s.pendingOps());
        GmailSync.Result r = run(api);
        T.check(r.ok, "replay run");
        T.eq(0L, s.pendingOps(), "queue empty");
        T.check(original.flags.contains("\\Flagged") && !original.flags.contains("\\Seen"), "star and unread → Gmail");
        T.check(original.labels.contains("Één ✓"), "label with accents → Gmail (mUTF-7): " + original.labels);
        T.check(!werk.labels.contains("\\Inbox"), "archive → Gmail");
        T.check(inboxNew.labels.contains("Familie") && !inboxNew.labels.contains("\\Inbox"), "move to label → Gmail");
        T.eq("trash", big.loc, "trash → Gmail (MOVE)");
        T.check(fake.log.stream().anyMatch(l -> l.startsWith("UID MOVE")), "UID MOVE used");
        T.eq("all", spam.loc, "not spam → Gmail");
        T.check(spam.labels.contains("\\Inbox"), "back in the inbox");
        T.check(!fake.msgs.contains(trashed), "deleted forever → Gmail");
        // the phone agrees with Gmail after the pull
        T.eq("trash", s.get(idOf(big)).box, "phone: big in trash");
        T.eq("all", s.get(idOf(spam)).box, "phone: spam in inbox");
        T.check(s.get(idOf(inboxNew)).labels.contains("Familie"), "phone: label");
        T.check(s.get(id).labels.contains("Één ✓"), "phone: accented label survived the pull");
    }

    static void offlineAndConflicts(GmailApi api) throws IOException {
        GmailStore s = api.store;
        // offline: an API on a dead port shares the same store
        Host h = host();
        GmailApi offline = new GmailApi(s, h, imap(closedPort()), smtp());
        String a = idOf(original), b = idOf(werk), c = idOf(inboxNew);
        call(offline, "POST", "/api/action", Json.obj("ids", Json.list(a), "op", "unflag"));
        call(offline, "POST", "/api/action", Json.obj("ids", Json.list(a), "op", "flag"));
        call(offline, "POST", "/api/action", Json.obj("ids", Json.list(a), "op", "unflag"));
        call(offline, "POST", "/api/action", Json.obj("ids", Json.list(b), "op", "seen"));
        call(offline, "POST", "/api/action", Json.obj("ids", Json.list(c), "op", "flag"));
        GmailSync.Options o = new GmailSync.Options();
        GmailSync.Result r = offline.sync().run(o);
        T.check(!r.ok && r.error.startsWith("Geen verbinding"), "offline run fails gently: " + r.error);
        Map<String, Object> st = s.json("status");
        T.check(Json.num(st, "backoffUntil").longValue() > System.currentTimeMillis(), "backoff after a failure");
        GmailSync.Result skipped = offline.sync().run(o);
        T.check(!skipped.ok && skipped.more, "background run waits during backoff");
        T.eq(5L, s.pendingOps(), "changes kept while offline");
        // meanwhile in Gmail: b unread + starred (conflict on "read"), c deleted (Gmail wins), a untouched
        fake.change(werk, () -> { werk.flags.remove("\\Seen"); werk.flags.add("\\Flagged"); });
        fake.remove(inboxNew);
        r = run(api);
        T.check(r.ok, "back online");
        T.eq(0L, s.pendingOps(), "queue replayed");
        T.check(!original.flags.contains("\\Flagged"), "replayed in order: unflag, flag, unflag → not starred");
        T.check(werk.flags.contains("\\Seen"), "conflict on read: the phone's change is the last write");
        T.check(werk.flags.contains("\\Flagged"), "Gmail's star on the same message kept (other field)");
        GmailStore.Msg w = s.get(b);
        T.check(w.seen && w.flagged, "phone shows the merged state");
        T.check(!s.exists(c), "deleted in Gmail while the phone starred it: Gmail wins");
        T.check(fake.byGmid(Long.parseLong(c)) == null, "and it was not recreated");
    }

    static int closedPort() throws IOException {
        try (java.net.ServerSocket ss = new java.net.ServerSocket(0)) { return ss.getLocalPort(); }
    }

    static void sending(GmailApi api) throws IOException {
        GmailStore s = api.store;
        String id = idOf(original);
        Map<String, Object> c = call(api, "GET", "/api/compose?id=" + id + "&mode=all", null);
        T.eq("anna.prive@example.org", c.get("to"), "reply goes to Reply-To");
        T.eq("piet@example.org, kees@example.org", c.get("cc"), "reply all: others in cc, not myself");
        T.eq("Re: Reis naar Lissabon", c.get("subject"), "Re: prefix");
        T.check(String.valueOf(c.get("text")).contains("schreef Anna <anna@example.org>:\n> Zullen we in mei gaan?"), "quoted text: " + c.get("text"));
        Map<String, Object> fw = call(api, "GET", "/api/compose?id=" + idOf(big) + "&mode=forward", null);
        T.eq("Fwd: Grote bijlage", fw.get("subject"), "Fwd: prefix");
        T.eq(1, Json.listAt(fw, "forwardAttachments").size(), "forward offers the attachment");
        T.eq("Re: Reis naar Lissabon", call(api, "GET", "/api/compose?id=" + idOf(reply) + "&mode=reply", null).get("subject"), "no double Re:");

        // attachment picked with the file picker (the app copies it into tmp/<token>)
        File tmp = new File(api.tmpDir(), "0123456789abcdef");
        Files.write(tmp.toPath(), "plattegrond".getBytes(StandardCharsets.UTF_8));
        Map<String, Object> sent = call(api, "POST", "/api/send", Json.obj("to", c.get("to"), "cc", c.get("cc"), "bcc", "geheim@example.org",
                "subject", c.get("subject"), "text", "Prima!\n.\nTot dan." + c.get("text"), "replyTo", id, "mode", "all",
                "files", Json.list(Json.obj("token", "0123456789abcdef", "name", "kaart lissabon.txt", "type", "text/plain"))));
        T.eq(true, sent.get("ok"), "queued for sending: " + sent);
        T.check(!tmp.exists(), "temporary attachment cleaned up");
        T.eq(1, s.outbox().size(), "in the outbox");
        T.eq(true, s.get(id).answered, "answered locally");
        GmailSync.Result r = run(api);
        T.check(r.ok, "send run: " + r.error);
        T.eq(0, s.outbox().size(), "outbox empty after Gmail confirmed");
        T.eq(1, fake.sent.size(), "Gmail got one message");
        Mime.Message m = Mime.parse(fake.sent.get(0));
        T.eq("<reis1@example.org>", m.inReplyTo, "In-Reply-To");
        T.check(m.references.contains("<eerder@example.org>") && m.references.endsWith("<reis1@example.org>"), "References chain: " + m.references);
        T.eq("rene.test@gmail.com", m.from.get(0).email, "From is the Gmail address");
        T.check(m.headers.get("Bcc") == null, "no Bcc header");
        T.check(fake.smtpLog.contains("RCPT TO:<geheim@example.org>"), "bcc in the envelope");
        T.eq("kaart lissabon.txt", m.parts.get(1).filename, "attachment name");
        T.eq("plattegrond", new String(m.parts.get(1).data, StandardCharsets.UTF_8), "attachment content");
        T.check(m.textPart().text().startsWith("Prima!\r\n.\r\nTot dan."), "lone dot survived SMTP");
        T.check(original.flags.contains("\\Answered"), "answered flag → Gmail");
        List<Object> sentView = Json.listAt(call(api, "GET", "/api/messages?view=sent", null), "messages");
        T.check(sentView.stream().anyMatch(x -> "Re: Reis naar Lissabon".equals(Json.str(x, "subject"))), "sent message in Verzonden (filed by Gmail, pulled back)");

        // temporary failure: stays, error shown, then goes
        fake.smtpDataReply = 451;
        call(api, "POST", "/api/send", Json.obj("to", "piet@example.org", "subject", "Tweede", "text", "x"));
        run(api);
        List<GmailStore.Outgoing> out = s.outbox();
        T.eq(1, out.size(), "kept after a temporary refusal");
        T.eq("queued", out.get(0).state, "will be retried");
        T.check(out.get(0).error.startsWith("Nog niet verstuurd"), "reason shown: " + out.get(0).error);
        fake.smtpDataReply = 250;
        call(api, "POST", "/api/outbox/retry", Json.obj("seq", out.get(0).seq));
        run(api);
        T.eq(0, s.outbox().size(), "sent on retry");
        T.eq(2, fake.sent.size(), "second message delivered");

        // permanent: unknown address; the user decides
        call(api, "POST", "/api/send", Json.obj("to", "bounce@example.org", "subject", "Fout adres", "text", "x"));
        run(api);
        out = s.outbox();
        T.eq("failed", out.get(0).state, "refused address: failed, kept for the user");
        T.check(out.get(0).error.contains("niet geaccepteerd") || out.get(0).error.contains("weigert"), "explained: " + out.get(0).error);
        T.eq(true, call(api, "POST", "/api/outbox/delete", Json.obj("seq", out.get(0).seq)).get("ok"), "user deletes it");
        T.eq(0, s.outbox().size(), "gone");

        // connection lost after the data: maybe sent → check Gmail before sending again
        fake.smtpDropAfterData = true;
        call(api, "POST", "/api/send", Json.obj("to", "piet@example.org", "subject", "Misschien", "text", "x"));
        run(api);
        out = s.outbox();
        T.eq("unknown", out.get(0).state, "maybe sent");
        T.eq(3, fake.sent.size(), "Gmail did get it");
        fake.smtpDropAfterData = false;
        s.outboxState(out.get(0).seq, "unknown", null, 0);
        run(api);
        T.eq(0, s.outbox().size(), "found in Gmail by Message-ID: not sent twice");
        T.eq(3, fake.sent.size(), "still three");
        T.check(String.valueOf(call(api, "POST", "/api/send", Json.obj("to", "geen adres", "text", "x")).get("error")).contains("geldig e-mailadres"), "bad address refused");
    }

    static void remoteSearch(GmailApi api) {
        GmailStore s = api.store;
        s.dropBody(idOf(old));
        T.eq(0, Json.listAt(call(api, "GET", "/api/messages?q=zeldzaamwoord&scope=everywhere&view=inbox", null), "messages").size(), "word deep in an old body: not in the local copy");
        List<Object> hits = Json.listAt(call(api, "POST", "/api/remote-search", Json.obj("q", "zeldzaamwoord")), "messages");
        T.eq(1, hits.size(), "found at Gmail (X-GM-RAW)");
        T.eq(idOf(old), Json.str(hits.get(0), "id"), "the right message");
        call(api, "POST", "/api/remote-search", Json.obj("q", "café"));
        T.check(fake.log.stream().anyMatch(l -> l.contains("CHARSET UTF-8 X-GM-RAW {literal:café}")), "non-ASCII search as a literal");
    }

    static void uidValidity(GmailApi api) {
        GmailStore s = api.store;
        long before = s.count("m.box != ''");
        int fetches = bodyFetches();
        fake.renumber(GmailFake.ALL);
        GmailFake.Msg vanished = werk;
        fake.remove(vanished);
        GmailSync.Result r = run(api);
        while (r.more) r = run(api);
        T.check(r.ok, "run after UIDVALIDITY change");
        T.eq(before - 1, s.count("m.box != ''"), "same messages (minus the one deleted meanwhile)");
        T.check(!s.exists(idOf(vanished)), "deleted message noticed after the new walk");
        T.eq(fetches, bodyFetches(), "nothing downloaded again (matched by X-GM-MSGID)");
        T.check(!s.hasOld(GmailStore.ALL), "old numbering cleaned up");
        // and changes keep working with the new UIDs
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(original)), "op", "seen"));
        run(api);
        T.check(original.flags.contains("\\Seen"), "STORE with the new UID");
    }

    static void windowAndSpace(GmailApi api) {
        GmailStore s = api.store;
        GmailFake.Msg mid = fake.add(raw("Tante <tante@example.org>", "rene.test@gmail.com", "Vier maanden geleden", "Hallo", null), NOW - 120 * DAY, "\\Inbox");
        run(api);
        T.eq(GmailStore.COMPLETE, s.get(idOf(mid)).body, "4 months old: inside the 12-month window");
        call(api, "GET", "/api/message?id=" + idOf(old), null); // opened on purpose again
        T.eq(true, s.get(idOf(old)).pinned, "old one pinned");
        call(api, "PUT", "/api/settings", Json.obj("months", 3L));
        T.eq(GmailStore.NONE, s.get(idOf(mid)).body, "window 3 months: content of older mail removed");
        T.check(!s.get(idOf(mid)).snippet.isEmpty(), "headers and snippet stay");
        T.eq(GmailStore.COMPLETE, s.get(idOf(old)).body, "opened-on-purpose message kept");
        Map<String, Object> f = call(api, "POST", "/api/free", null);
        T.check(Json.num(f, "freed").longValue() > 0, "vrijmaken frees space");
        T.eq(GmailStore.NONE, s.get(idOf(old)).body, "also the pinned old one");
        T.eq(400L, call(api, "PUT", "/api/settings", Json.obj("months", 5L)).get("_status"), "only 3/6/12/24/all");
        call(api, "PUT", "/api/settings", Json.obj("months", 12L));
        run(api);
        T.eq(GmailStore.COMPLETE, s.get(idOf(mid)).body, "window back to 12 months: downloaded again");
        // metered network: only small recent ones, the rest waits for wifi
        GmailFake.Msg recentBig = fake.add("From: x@example.org\nSubject: Groot via mobiel\nContent-Type: text/plain\n\n" + "x".repeat(600_000), NOW - DAY, "\\Inbox");
        GmailSync.Options o = new GmailSync.Options();
        o.unmetered = false;
        o.interactive = true;
        GmailSync.Result r = api.sync().run(o);
        T.check(r.ok, "metered run");
        T.eq(GmailStore.NONE, s.get(idOf(recentBig)).body, "large message waits for wifi");
        T.eq(true, s.json("status").get("waitingForWifi"), "status says: waiting for wifi");
        run(api);
        T.eq(GmailStore.COMPLETE, s.get(idOf(recentBig)).body, "downloaded on wifi");
    }

    static void idle(GmailApi api) throws Exception {
        GmailStore s = api.store;
        AtomicBoolean stop = new AtomicBoolean();
        AtomicInteger runs = new AtomicInteger();
        List<GmailStore.Msg> fresh = new java.util.concurrent.CopyOnWriteArrayList<>();
        Thread t = new Thread(() -> api.sync().idleLoop(stop::get, 20_000, r -> { runs.incrementAndGet(); fresh.addAll(r.fresh); }));
        t.start();
        long until = System.currentTimeMillis() + 10_000;
        while (runs.get() < 1 && System.currentTimeMillis() < until) Thread.sleep(50);
        Thread.sleep(500); // in IDLE now
        GmailFake.Msg n = fake.add(raw("Snel <snel@example.org>", "rene.test@gmail.com", "Direct binnen", "via IDLE", null), NOW, "\\Inbox");
        until = System.currentTimeMillis() + 10_000;
        while (!s.exists(idOf(n)) && System.currentTimeMillis() < until) Thread.sleep(50);
        T.check(s.exists(idOf(n)), "IDLE: new mail arrives without waiting for the poll");
        while (fresh.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(50); // the listener runs when the run ends
        T.check(fresh.stream().anyMatch(m -> m.subject.equals("Direct binnen")), "IDLE: reported for a notification");
        T.check(fake.log.stream().anyMatch(l -> l.equals("IDLE")), "IDLE command used");
        call(api, "POST", "/api/action", Json.obj("ids", Json.list(idOf(n)), "op", "flag"));
        until = System.currentTimeMillis() + 10_000;
        while (!n.flags.contains("\\Flagged") && System.currentTimeMillis() < until) Thread.sleep(50);
        T.check(n.flags.contains("\\Flagged"), "a change on the phone wakes the loop and reaches Gmail at once");
        stop.set(true);
        t.join(15_000);
        T.check(!t.isAlive(), "loop stops");
    }

    static void fallbacks() throws Exception {
        fake.move = false;
        fake.condstore = false;
        fake.esearch = false;
        fake.compress = false;
        fake.log.clear();
        try {
            GmailApi api = api(host());
            GmailSync.Result r = run(api);
            while (r.more) r = run(api);
            T.check(r.ok, "first sync without MOVE/CONDSTORE/ESEARCH/COMPRESS: " + r.error);
            GmailStore s = api.store;
            T.check(!fake.log.contains("COMPRESS DEFLATE") && fake.log.stream().noneMatch(l -> l.contains("CHANGEDSINCE")), "no extensions used");
            GmailFake.Msg target = null;
            for (GmailFake.Msg m : fake.msgs) if (m.loc.equals("all") && m.labels.contains("\\Inbox")) { target = m; break; }
            String id = idOf(target);
            call(api, "POST", "/api/action", Json.obj("ids", Json.list(id), "op", "trash"));
            run(api);
            T.eq("trash", target.loc, "trash via COPY + \\Deleted + EXPUNGE");
            T.check(fake.log.stream().anyMatch(l -> l.startsWith("UID COPY")), "COPY fallback used");
            T.eq("trash", s.get(id).box, "phone agrees");
            final GmailFake.Msg t2 = target;
            fake.change(t2, () -> t2.flags.add("\\Flagged"));
            run(api);
            T.eq(true, s.get(id).flagged, "flag change seen without CONDSTORE");
            GmailFake.Msg other = null;
            for (GmailFake.Msg m : fake.msgs) if (m.loc.equals("all") && m != target && api.store.exists(idOf(m))) { other = m; break; }
            fake.remove(other);
            run(api);
            T.check(!s.exists(idOf(other)), "deletion seen without ESEARCH");
        } finally {
            fake.move = true;
            fake.condstore = true;
            fake.esearch = true;
            fake.compress = true;
        }
    }

    static void authFailure(GmailApi api) {
        String good = fake.password;
        fake.password = "zzzzzzzzzzzzzzzz";
        try {
            GmailSync.Options o = new GmailSync.Options();
            GmailSync.Result r = api.sync().run(o);
            T.check(r.authFailed && GmailSync.AUTH_FAILED.equals(r.error), "password revoked: clear message");
            int logins = fake.logins;
            r = api.sync().run(o);
            T.check(r.authFailed && fake.logins == logins, "no more attempts in the background (no lockout)");
            T.eq(true, Json.map(call(api, "GET", "/api/state", null), "status").get("authFailed"), "state shows it");
        } finally {
            fake.password = good;
        }
        T.check(run(api).ok, "works again once the password is right (interactive run)");
    }

    static void forget(GmailApi api, Host h) {
        T.eq(403L, call(api, "POST", "/api/forget", null).get("_status"), "removing needs the fingerprint");
        h.confirmed = true;
        T.eq(true, call(api, "POST", "/api/forget", null).get("ok"), "removed");
        T.eq(null, h.cred, "credentials gone");
        T.eq(0L, api.store.count("1 = 1"), "messages gone");
        T.check(!new File(api.store.dir, "m").exists(), "files gone");
        T.eq(false, call(api, "GET", "/api/state", null).get("configured"), "not configured any more");
    }
}
