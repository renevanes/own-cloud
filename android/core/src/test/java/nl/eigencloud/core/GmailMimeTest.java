package nl.eigencloud.core;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.gmail.AppPassword;
import nl.eigencloud.core.gmail.BodyStructure;
import nl.eigencloud.core.gmail.HtmlSanitizer;
import nl.eigencloud.core.gmail.Imap;
import nl.eigencloud.core.gmail.MUtf7;
import nl.eigencloud.core.gmail.MailBuilder;
import nl.eigencloud.core.gmail.Mime;

/** Gmail on the phone, without a network: MIME edge cases, sanitizing, building, codecs and the IMAP parser. */
public class GmailMimeTest {
    static byte[] b(String s) { return s.replace("\r\n", "\n").replace("\n", "\r\n").getBytes(StandardCharsets.UTF_8); }

    static byte[] latin1(String s) { return s.replace("\r\n", "\n").replace("\n", "\r\n").getBytes(StandardCharsets.ISO_8859_1); }

    public static void main(String[] args) {
        T.main("GmailMimeTest", () -> {
            appPassword();
            mutf7();
            encodedWords();
            multipart();
            charsets();
            rfc2231();
            broken();
            addressesAndDates();
            sanitizer();
            builder();
            imapParser();
            bodyStructure();
        });
    }

    static void appPassword() {
        T.eq("abcdefghijklmnop", AppPassword.normalize("abcd efgh ijkl mnop"), "grouped with spaces");
        T.eq("abcdefghijklmnop", AppPassword.normalize(" abcd efgh ijkl mnop\n"), "non-breaking spaces and newline");
        T.eq("abcdefghijklmnop", AppPassword.normalize("ABCDEFGHIJKLMNOP"), "upper case, no spaces");
        T.eq("abcdefghijklmnop", AppPassword.normalize("\"abcd efgh ijkl mnop\""), "quoted");
        T.eq("abcdefghijklmnop", AppPassword.normalize("ab​cd efgh ijkl mnop"), "zero-width space");
        T.eq("qwerasdfzxcvtyui", AppPassword.normalize("Your app password for your device\nqwer asdf zxcv tyui\nHow to use it"), "inside Google's text");
        T.eq(null, AppPassword.normalize("abcd efgh ijkl"), "too short");
        T.eq(null, AppPassword.normalize("abcd efgh ijkl mnop qrst"), "too long");
        T.eq(null, AppPassword.normalize("hunter2"), "something else");
        T.eq(null, AppPassword.normalize(""), "empty");
        T.eq("abcd •••• •••• mnop", AppPassword.mask("abcdefghijklmnop"), "mask");
        T.eq("jij@gmail.com", AppPassword.address(" Jij@Gmail.com "), "address normalised");
        T.eq(null, AppPassword.address("jij@gmail"), "address without tld");
    }

    static void mutf7() {
        T.eq("&AMk-n", MUtf7.encode("Én"), "mUTF-7 encode");
        T.eq("&AMkA6Q-n", MUtf7.encode("Één"), "mUTF-7 two characters");
        T.eq("Én", MUtf7.decode("&AMk-n"), "mUTF-7 decode");
        T.eq("A&-B", MUtf7.encode("A&B"), "ampersand");
        T.eq("A&B", MUtf7.decode("A&-B"), "ampersand back");
        T.eq("&ZeVnLIqe-", MUtf7.encode("日本語"), "CJK (RFC 3501 example)");
        T.eq("[Gmail]/Prullenbak", MUtf7.decode("[Gmail]/Prullenbak"), "plain ascii unchanged");
        String emoji = "Reizen ✈️ 2024 😀";
        T.eq(emoji, MUtf7.decode(MUtf7.encode(emoji)), "round trip with emoji (surrogates)");
    }

    static void encodedWords() {
        T.eq("Café ☕", Mime.decodeWords("=?UTF-8?B?Q2Fmw6kg4piV?="), "B word");
        T.eq("Café ok", Mime.decodeWords("=?iso-8859-1?Q?Caf=E9_ok?="), "Q word latin1");
        T.eq("ab", Mime.decodeWords("=?UTF-8?Q?a?=  \r\n =?UTF-8?Q?b?="), "adjacent words joined");
        // a 3-byte character split across two words
        T.eq("€uro", Mime.decodeWords("=?UTF-8?B?4oI=?= =?UTF-8?B?rHVybw==?="), "character split across words");
        T.eq("a =?x b", Mime.decodeWords("a =?x b"), "not a word");
        T.eq("Re: Hallo wereld", Mime.decodeWords("Re: =?utf-8*nl?q?Hallo_wereld?="), "language suffix (RFC 2231)");
        String enc = Mime.encodeWord("Groeten uit Zürich, met een heel lange onderwerpregel die zeker gesplitst moet worden 🙂");
        T.check(enc.startsWith("=?UTF-8?B?") && enc.contains("\r\n "), "long subject encoded and folded");
        T.eq("Groeten uit Zürich, met een heel lange onderwerpregel die zeker gesplitst moet worden 🙂", Mime.decodeWords(enc.replace("\r\n", "")), "encode/decode round trip");
        T.eq("plain", Mime.encodeWord("plain"), "ascii untouched");
    }

    static void multipart() {
        String raw = "From: Anna <anna@example.org>\n"
                + "To: Rene <rene@gmail.com>, \"Jansen, Piet\" <piet@example.org>\n"
                + "Subject: =?UTF-8?Q?Foto=27s_van_de_reis?=\n"
                + "Date: Tue, 1 Jul 2025 10:52:37 +0200\n"
                + "Message-ID: <abc@example.org>\n"
                + "References: <r1@x> <r2@x>\n"
                + "MIME-Version: 1.0\n"
                + "Content-Type: multipart/mixed; boundary=\"outer\"\n"
                + "\n"
                + "preamble\n"
                + "--outer\n"
                + "Content-Type: multipart/alternative; boundary=inner\n"
                + "\n"
                + "--inner\n"
                + "Content-Type: text/plain; charset=utf-8\n"
                + "Content-Transfer-Encoding: quoted-printable\n"
                + "\n"
                + "Hoi Rene, kijk eens =E2=82=AC 5 en een heel lange regel die doorloopt=\n"
                + " op de volgende.\n"
                + "--inner\n"
                + "Content-Type: multipart/related; boundary=rel\n"
                + "\n"
                + "--rel\n"
                + "Content-Type: text/html; charset=\"utf-8\"\n"
                + "\n"
                + "<p>Hoi <b>Rene</b><img src=\"cid:img1@x\"></p>\n"
                + "--rel\n"
                + "Content-Type: image/png\n"
                + "Content-ID: <img1@x>\n"
                + "Content-Transfer-Encoding: base64\n"
                + "\n"
                + "iVBORw0KGgo=\n"
                + "--rel--\n"
                + "--inner--\n"
                + "--outer\n"
                + "Content-Type: application/pdf; name=\"reis.pdf\"\n"
                + "Content-Disposition: attachment; filename=\"reis.pdf\"\n"
                + "Content-Transfer-Encoding: base64\n"
                + "\n"
                + "JVBERi0xLjQK\n"
                + "--outer\n"
                + "Content-Type: message/rfc822\n"
                + "\n"
                + "Subject: binnen\n\nbericht\n"
                + "--outer--\n"
                + "epilogue\n";
        Mime.Message m = Mime.parse(b(raw));
        T.eq("Foto's van de reis", m.subject, "subject Q-decoded");
        T.eq("anna@example.org", m.from.get(0).email, "from");
        T.eq("Anna", m.from.get(0).name, "from name");
        T.eq(2, m.to.size(), "two recipients (comma in quoted name)");
        T.eq("Jansen, Piet", m.to.get(1).name, "quoted name with comma");
        T.eq("<abc@example.org>", m.messageId, "message id");
        T.eq("<r1@x> <r2@x>", m.references, "references");
        T.eq(1751359957000L, m.date, "date with zone");
        List<String> sections = new ArrayList<>();
        for (Mime.Part p : m.parts) sections.add(p.section + " " + p.type);
        T.eq(Arrays.asList("1.1 text/plain", "1.2.1 text/html", "1.2.2 image/png", "2 application/pdf", "3 message/rfc822"), sections, "IMAP section numbers");
        T.eq("Hoi Rene, kijk eens € 5 en een heel lange regel die doorloopt op de volgende.", m.textPart().text(), "QP soft break and UTF-8");
        T.check(m.htmlPart().text().contains("<b>Rene</b>"), "html part");
        T.eq("img1@x", m.parts.get(2).cid, "content id without brackets");
        T.eq(8, m.parts.get(2).data.length, "base64 decoded image");
        T.eq("reis.pdf", m.parts.get(3).filename, "attachment name");
        T.eq("%PDF-1.4\n", new String(m.parts.get(3).data, StandardCharsets.ISO_8859_1), "pdf bytes");
        T.eq("bericht.eml", m.parts.get(4).displayName(), "message/rfc822 name");
        T.eq(3, m.attachments().size(), "attachments: image, pdf, message");
        // single part
        Mime.Message single = Mime.parse(b("Subject: x\nContent-Type: text/plain\n\nhallo\n"));
        T.eq("1", single.parts.get(0).section, "single part is section 1");
        T.eq("hallo\r\n", single.textPart().text(), "single part body");
    }

    static void charsets() {
        Mime.Message w = Mime.parse(concat(latin1("Subject: x\nContent-Type: text/plain; charset=windows-1252\nContent-Transfer-Encoding: 8bit\n\n"), new byte[]{(byte) 0x80, ' ', (byte) 0x93, 'q', (byte) 0x94}));
        T.eq("€ “q”", w.textPart().text(), "windows-1252 euro and quotes");
        Mime.Message l = Mime.parse(concat(latin1("Content-Type: text/plain; charset=ISO-8859-1\n\n"), new byte[]{'c', 'a', 'f', (byte) 0xe9, (byte) 0x80}));
        T.eq("café€", l.textPart().text(), "latin-1 label read as windows-1252 (like browsers)");
        Mime.Message bad = Mime.parse(concat(latin1("Content-Type: text/plain; charset=utf-8\n\n"), new byte[]{'c', 'a', 'f', (byte) 0xe9}));
        T.eq("café", bad.textPart().text(), "invalid UTF-8 falls back to windows-1252");
        Mime.Message none = Mime.parse(b("Content-Type: text/plain\n\nhé ✓"));
        T.eq("hé ✓", none.textPart().text().trim(), "no charset: UTF-8 when valid");
        Mime.Message rawHeader = Mime.parse(concat(latin1("Subject: caf"), new byte[]{(byte) 0xe9}, latin1("\n\nx")));
        T.eq("café", rawHeader.subject, "raw 8-bit latin-1 header");
        Mime.Message utfHeader = Mime.parse(b("Subject: Grüße ✓\n\nx"));
        T.eq("Grüße ✓", utfHeader.subject, "raw UTF-8 header (RFC 6532)");
        T.eq("€uro", new String(Mime.trimPartialUtf8(new byte[]{(byte) 0xe2, (byte) 0x82, (byte) 0xac, 'u', 'r', 'o'}, "utf-8"), StandardCharsets.UTF_8), "complete UTF-8 kept");
        T.eq("ab", new String(Mime.trimPartialUtf8(new byte[]{'a', 'b', (byte) 0xe2, (byte) 0x82}, null), StandardCharsets.UTF_8), "cut-off character dropped");
    }

    static byte[] concat(byte[]... parts) { return Bytes.concat(parts); }

    static void rfc2231() {
        Map<String, String> p = Mime.parseParams("; filename*=UTF-8''%E2%82%AC%20rekening.pdf");
        T.eq("€ rekening.pdf", p.get("filename"), "RFC 2231 charset and percent-encoding");
        Map<String, String> c = Mime.parseParams("; filename*0*=utf-8''Lange%20na; filename*1=\"am deel twee\"; filename*2*=%E2%9C%93.txt");
        T.eq("Lange naam deel twee✓.txt", c.get("filename"), "RFC 2231 continuations, mixed encoded/plain");
        Map<String, String> q = Mime.parseParams("; name=\"=?UTF-8?B?w6lsw6huZS5wZGY=?=\"; x=\"a\\\"b\"");
        T.eq("élène.pdf", q.get("name"), "RFC 2047 inside a quoted parameter (common in practice)");
        T.eq("a\"b", q.get("x"), "escaped quote");
        Mime.Message m = Mime.parse(b("Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nx\n--b\nContent-Type: application/octet-stream\nContent-Disposition: attachment;\n filename*=iso-8859-1'nl'caf%E9.txt\n\nabc\n--b--\n"));
        T.eq("café.txt", m.parts.get(1).filename, "folded disposition with RFC 2231 latin-1");
    }

    static void broken() {
        Mime.Message noEnd = Mime.parse(b("Content-Type: multipart/mixed; boundary=zz\n\n--zz\nContent-Type: text/plain\n\neerste\n--zz\nContent-Type: text/plain; name=a.txt\n\ntweede zonder einde"));
        T.eq(2, noEnd.parts.size(), "missing closing boundary: last part until the end");
        T.eq("eerste", noEnd.textPart().text(), "first part");
        Mime.Message noBoundary = Mime.parse(b("Content-Type: multipart/mixed\n\nzomaar tekst"));
        T.eq(1, noBoundary.parts.size(), "multipart without boundary shown as text");
        Mime.Message lf = Mime.parse("Subject: lf\nContent-Type: text/plain\n\nalleen LF\n".getBytes(StandardCharsets.UTF_8));
        T.eq("lf", lf.subject, "LF-only line ends");
        T.eq("alleen LF\n", lf.textPart().text(), "LF-only body");
        T.eq("hello", new String(Mime.decodeBase64("aGVs\r\nbG8".getBytes(StandardCharsets.US_ASCII)), StandardCharsets.US_ASCII), "base64 without padding, with line breaks");
        T.eq("a=b =G", new String(Mime.decodeQP("a=3Db =G".getBytes(StandardCharsets.US_ASCII), false), StandardCharsets.US_ASCII), "QP invalid escape kept");
        T.eq("ab", new String(Mime.decodeQP("a= \r\nb".getBytes(StandardCharsets.US_ASCII), false), StandardCharsets.US_ASCII), "QP soft break with trailing space");
        Mime.Message html = Mime.parse(b("Content-Type: text/html\n\n<html><head><style>p{}</style><title>t</title></head><body><p>Een&nbsp;&amp; twee</p><div>drie</div></body></html>"));
        T.eq("Een & twee\ndrie", Mime.htmlToText(html.htmlPart().text()).replace(" \n", "\n"), "html to text (nbsp becomes a space)");
        T.eq("Hallo…", Mime.snippet("Hallo daar\n> quoted", 5), "snippet shortened");
        T.eq("Hallo daar", Mime.snippet("Hallo\n\n daar\n> geciteerd\n", 50), "snippet drops quoted lines and collapses space");
    }

    static void addressesAndDates() {
        List<Mime.Address> a = Mime.parseAddresses("=?UTF-8?B?w4lsaXNl?= <elise@x.nl>, bob@y.org (Bob B), Groep: c@z.nl, d@z.nl;, <e@q.nl>");
        T.eq(5, a.size(), "five addresses including a group");
        T.eq("Élise", a.get(0).name, "encoded display name");
        T.eq("Bob B", a.get(1).name, "comment as name");
        T.eq("c@z.nl", a.get(2).email, "group member");
        T.eq("e@q.nl", a.get(4).email, "angle address only");
        T.eq("=?UTF-8?B?w4lsaXNl?= <elise@x.nl>", a.get(0).header(), "header form encodes non-ascii");
        T.eq("\"Jansen, Piet\" <p@x.nl>", new Mime.Address("Jansen, Piet", "p@x.nl").header(), "header form quotes specials");
        T.eq(0L, Mime.parseDate("geen datum"), "bad date");
        T.eq(1704067200000L, Mime.parseDate("1 Jan 2024 00:00:00 GMT"), "no weekday, named zone");
        T.eq(1704085200000L, Mime.parseDate("Mon, 1 Jan 2024 00:00 -0500"), "no seconds, negative offset");
        T.eq(946684800000L, Mime.parseDate("Sat, 1 Jan 00 00:00:00 +0000"), "two-digit year");
        T.eq(1720000000000L, Imap.internalDate("03-Jul-2024 09:46:40 +0000"), "INTERNALDATE");
    }

    static void sanitizer() {
        String evil = "<html><head><script>alert(1)</script><style>@import url(http://x/a.css); p{color:red;background:url(https://track.er/p.gif)}</style></head>"
                + "<body onload=\"x()\"><p style=\"color:blue;background-image:url('http://t.co/x.png')\" onclick=\"y()\">Hoi</p>"
                + "<a href=\"javascript:alert(1)\">a</a><a href=\" JaVaScRiPt:alert(1)\">b</a><a href=\"https://ok.nl/?a=1&amp;b=2\">c</a>"
                + "<img src=\"https://track.er/pixel.gif\" width=1><img src=\"cid:logo@x\"><img src=\"cid:missing\"><img src=\"data:image/png;base64,iVBOR\">"
                + "<iframe src=\"https://x\"></iframe><form action=\"https://phish\"><input name=p></form><svg><script>z()</script></svg>"
                + "<object data=x>inside object</object><table><tr><td bgcolor=\"#fff\" colspan=2>cel</td></tr></table>"
                + "<p>unclosed <b>bold</body>";
        HtmlSanitizer.Result r = HtmlSanitizer.sanitize(evil, false, cid -> cid.equals("logo@x") ? "https://appassets.androidplatform.net/gmail/part/1/2" : null);
        String h = r.html.toLowerCase();
        T.check(!h.contains("<script") && !h.contains("alert(1)") && !h.contains("z()"), "no scripts");
        T.check(!h.contains("onload") && !h.contains("onclick"), "no event handlers");
        T.check(!h.contains("javascript:"), "no javascript: links");
        T.check(!h.contains("@import") && !h.contains("track.er") && !h.contains("t.co"), "no remote resources without permission");
        T.check(!h.contains("<iframe") && !h.contains("<form") && !h.contains("<input") && !h.contains("<object") && !h.contains("<svg"), "no frames, forms, objects, svg");
        T.check(!h.contains("inside object"), "object content dropped");
        T.check(h.contains("href=\"https://ok.nl/?a=1&amp;b=2\"") && h.contains("rel=\"noopener noreferrer\""), "safe link kept, opens outside");
        T.check(h.contains("src=\"https://appassets.androidplatform.net/gmail/part/1/2\""), "cid image rewritten");
        T.check(h.contains("src=\"data:image/png;base64,ivbor\""), "inline data image kept");
        T.check(h.contains("<td bgcolor=\"#fff\" colspan=\"2\">cel</td>"), "table attributes kept");
        T.check(h.contains("</b></p>"), "open tags closed");
        T.eq(3, r.blocked, "blocked: pixel, css background, style url (@import removed, not counted)");
        T.check(r.cids.contains("logo@x") && !r.cids.contains("missing"), "used cids");
        HtmlSanitizer.Result allowed = HtmlSanitizer.sanitize(evil, true, cid -> null);
        T.check(allowed.html.contains("https://track.er/pixel.gif"), "remote image shown when allowed");
        T.check(!allowed.html.toLowerCase().contains("javascript:"), "still no javascript when images allowed");
        T.check(HtmlSanitizer.sanitize("<a href=\"https://x\" onmouseover=a>1 < 2 > 0</a>", false, null).html.equals("<a href=\"https://x\" target=\"_blank\" rel=\"noopener noreferrer\">1 &lt; 2 &gt; 0</a>"), "stray < and > escaped");
        T.check(HtmlSanitizer.sanitize("<scr<script>ipt>alert(1)</script>", false, null).html.indexOf("<script") < 0, "nested script trick");
        T.check(HtmlSanitizer.textToHtml("zie https://eigen.cloud/a?b=1. <b>").contains("<a href=\"https://eigen.cloud/a?b=1\""), "text links");
        T.check(HtmlSanitizer.textToHtml("<b>").contains("&lt;b&gt;"), "text escaped");
    }

    static void builder() {
        MailBuilder.Draft d = new MailBuilder.Draft();
        d.from = new Mime.Address("René van Es", "rene@gmail.com");
        d.to.add(new Mime.Address("Jansen, Piet", "piet@example.org"));
        d.cc.add(new Mime.Address("", "anna@example.org"));
        d.bcc.add(new Mime.Address("", "geheim@example.org"));
        d.subject = "Re: Café ☕ morgen";
        d.text = "Hallo Piet,\n.\n.punt aan het begin\nRegel met € en een heel lange tekst die over de zesenzeventig tekens heen gaat zodat er een zachte regelafbreking komt.\n";
        d.inReplyTo = "<abc@example.org>";
        d.references = "<r1@x> <r2@x>";
        d.attachments.add(new MailBuilder.Attachment("rekening €.pdf", "application/pdf", "%PDF-1.4 inhoud".getBytes(StandardCharsets.ISO_8859_1)));
        d.attachments.add(new MailBuilder.Attachment("foto.jpg", "image/jpeg", new byte[200]));
        byte[] raw = MailBuilder.build(d, 1751359957000L, "<id1@gmail.com>");
        String s = new String(raw, StandardCharsets.UTF_8);
        T.check(!s.contains("geheim@example.org"), "bcc not in the message");
        T.check(s.contains("In-Reply-To: <abc@example.org>") && s.contains("References: <r1@x>\r\n <r2@x>\r\n <abc@example.org>"), "reply headers");
        T.eq(Arrays.asList("piet@example.org", "anna@example.org", "geheim@example.org"), d.recipients(), "envelope recipients");
        for (String line : s.split("\r\n")) T.check(line.length() <= 998, "line length within RFC 5322");
        Mime.Message back = Mime.parse(raw);
        T.eq("Re: Café ☕ morgen", back.subject, "subject round trip");
        T.eq("René van Es", back.from.get(0).name, "from name round trip");
        T.eq("Jansen, Piet", back.to.get(0).name, "quoted to round trip");
        T.eq("<id1@gmail.com>", back.messageId, "message id");
        T.eq(d.text.replace("\n", "\r\n"), back.textPart().text(), "text round trip (QP, dots, euro)");
        T.eq(3, back.parts.size(), "text + 2 attachments");
        T.eq("rekening €.pdf", back.parts.get(1).filename, "RFC 2231 filename round trip");
        T.eq("%PDF-1.4 inhoud", new String(back.parts.get(1).data, StandardCharsets.ISO_8859_1), "attachment bytes");
        T.eq(200, back.parts.get(2).data.length, "binary attachment size");
        T.eq("<a@x> <b@x>", MailBuilder.references("<a@x>", "<b@x>").replace("\r\n", ""), "references chain");
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 30; i++) many.append("<m").append(i).append("@x> ");
        String[] ids = MailBuilder.references(many.toString(), "<last@x>").split("\\s+");
        T.eq(20, ids.length, "references capped at 20");
        T.eq("<m0@x>", ids[0], "thread root kept");
        T.eq("<last@x>", ids[19], "parent last");
        // plain message without attachments: quoted-printable, no lone dot lines
        MailBuilder.Draft p = new MailBuilder.Draft();
        p.from = new Mime.Address("", "rene@gmail.com");
        p.to.add(new Mime.Address("", "x@y.nl"));
        p.text = ".";
        String ps = new String(MailBuilder.build(p, 0, "<p@x>"), StandardCharsets.US_ASCII);
        T.check(ps.endsWith("\r\n\r\n=2E"), "a lone dot is encoded");
    }

    static void imapParser() {
        List<Object> seg = new ArrayList<>();
        seg.add("* 12 FETCH (UID 345 FLAGS (\\Seen \\Flagged) X-GM-LABELS (\"\\\\Inbox\" \"\\\\Important\" Werk \"Mijn label\" &AMk-n) X-GM-MSGID 1278455344230334865 BODY[HEADER.FIELDS (FROM SUBJECT)] ");
        seg.add("From: a@b\r\nSubject: hi\r\n\r\n".getBytes(StandardCharsets.UTF_8));
        seg.add(" BODY[TEXT]<0> ");
        seg.add("abc".getBytes(StandardCharsets.UTF_8));
        seg.add(" ENVELOPE (NIL \"x\" NIL NIL NIL NIL NIL NIL NIL NIL))");
        Imap.Response r = Imap.parse(seg);
        T.eq(12L, r.number, "sequence number");
        T.eq("FETCH", r.type, "type");
        Imap.Fetch f = toFetch(r);
        T.eq(345L, f.uid(), "uid");
        T.eq(Arrays.asList("\\Seen", "\\Flagged"), f.strings("FLAGS"), "flags");
        T.eq(Arrays.asList("\\Inbox", "\\Important", "Werk", "Mijn label", "&AMk-n"), f.strings("X-GM-LABELS"), "labels: quoted, escaped, atoms, mUTF-7");
        T.eq("1278455344230334865", Imap.str(f.get("X-GM-MSGID")), "64-bit msgid as text");
        T.eq("From: a@b\r\nSubject: hi\r\n\r\n", new String(f.body("BODY[HEADER.FIELDS"), StandardCharsets.UTF_8), "section with spaces and literal");
        T.eq("abc", new String(f.body("BODY[TEXT]"), StandardCharsets.UTF_8), "partial body key");
        List<Object> env = Json.asList(f.get("ENVELOPE"));
        T.eq(null, env.get(0), "NIL is null");
        Imap.Response st = Imap.parse(new ArrayList<>(Arrays.asList("A7 OK [MODIFIED 7,9:11] Conditional STORE failed")));
        T.eq("OK", st.status, "status");
        T.eq("MODIFIED 7,9:11", st.code, "response code");
        T.eq(Arrays.asList(7L, 9L, 10L, 11L), Imap.parseSet("7,9:11"), "uid set parse");
        T.eq("1:3,5,7:8", Imap.set(Arrays.asList(8L, 1L, 2L, 3L, 5L, 7L)), "uid set build");
        Imap.Response list = Imap.parse(new ArrayList<>(Arrays.asList("* LIST (\\HasNoChildren \\Trash) \"/\" \"[Gmail]/Prullenbak\"")));
        T.eq("[Gmail]/Prullenbak", list.data.get(2), "list name");
        T.check(Imap.astring("abc") instanceof String && Imap.astring("café") instanceof Imap.Lit, "astring: quoted or literal");
        T.eq("\"a\\\"b\\\\\"", Imap.quoted("a\"b\\"), "quoting");
        T.eq("\\Inbox", Imap.label("\\Inbox"), "system label as atom");
        T.eq("\"&AMk-n\"", Imap.label("Én"), "user label quoted mUTF-7");
    }

    @SuppressWarnings("unchecked")
    static Imap.Fetch toFetch(Imap.Response r) {
        Imap.Fetch f = new Imap.Fetch();
        List<Object> l = (List<Object>) r.data.get(0);
        for (int i = 0; i + 1 < l.size(); i += 2) f.items.put(Imap.str(l.get(i)).toUpperCase(), l.get(i + 1));
        return f;
    }

    static void bodyStructure() {
        // As Gmail sends it for mixed(alternative(plain, related(html, png)), pdf with RFC 2231 name, rfc822)
        String bs = "* 1 FETCH (UID 1 BODYSTRUCTURE (((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"UTF-8\") NIL NIL \"QUOTED-PRINTABLE\" 120 3 NIL NIL NIL)"
                + "((\"TEXT\" \"HTML\" (\"CHARSET\" \"utf-8\") NIL NIL \"7BIT\" 60 1 NIL NIL NIL)(\"IMAGE\" \"PNG\" NIL \"<img1@x>\" NIL \"BASE64\" 12 NIL NIL NIL) \"RELATED\" (\"BOUNDARY\" \"rel\") NIL NIL)"
                + " \"ALTERNATIVE\" (\"BOUNDARY\" \"inner\") NIL NIL)"
                + "(\"APPLICATION\" \"PDF\" (\"NAME\" \"x.pdf\") NIL NIL \"BASE64\" 16000000 NIL (\"ATTACHMENT\" (\"FILENAME*\" \"utf-8''%E2%82%AC.pdf\")) NIL NIL)"
                + "(\"MESSAGE\" \"RFC822\" NIL NIL NIL \"7BIT\" 30 (NIL \"binnen\" NIL NIL NIL NIL NIL NIL NIL NIL) (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 7 1) 3 NIL (\"INLINE\" NIL) NIL NIL)"
                + " \"MIXED\" (\"BOUNDARY\" \"outer\") NIL NIL NIL))";
        Imap.Fetch f = toFetch(Imap.parse(new ArrayList<>(Arrays.asList(bs))));
        List<Mime.Part> parts = BodyStructure.parse(f.get("BODYSTRUCTURE"));
        List<String> got = new ArrayList<>();
        for (Mime.Part p : parts) got.add(p.section + " " + p.type);
        T.eq(Arrays.asList("1.1 text/plain", "1.2.1 text/html", "1.2.2 image/png", "2 application/pdf", "3 message/rfc822"), got, "same sections as the MIME parser");
        T.eq("utf-8", parts.get(0).charset.toLowerCase(), "charset");
        T.eq("quoted-printable", parts.get(0).encoding, "encoding");
        T.eq("img1@x", parts.get(2).cid, "cid");
        T.eq("€.pdf", parts.get(3).filename, "RFC 2231 file name from disposition");
        T.eq("attachment", parts.get(3).disposition, "disposition");
        T.eq(12_000_000L, parts.get(3).size, "base64 size estimated as decoded");
        T.eq("inline", parts.get(4).disposition, "message/rfc822 extension fields at the right place");
        List<Mime.Part> single = BodyStructure.parse(toFetch(Imap.parse(new ArrayList<>(Arrays.asList("* 1 FETCH (BODYSTRUCTURE (\"TEXT\" \"PLAIN\" (\"CHARSET\" \"iso-8859-1\") NIL NIL \"8BIT\" 5 1 NIL NIL NIL))")))).get("BODYSTRUCTURE"));
        T.eq("1", single.get(0).section, "single part is 1");
    }
}
