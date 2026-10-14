package nl.eigencloud.core.gmail;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Makes mail HTML safe to show: an allow-list of tags and attributes, no scripts, event handlers, forms, frames,
 * objects or SVG, links only to http(s)/mailto/tel. Images: {@code cid:} goes through {@code cidUrl}, remote
 * images are dropped unless {@code allowRemote} (they would tell the sender you read the mail). The viewer adds a
 * Content-Security-Policy and a sandboxed frame on top of this, so a mistake here is not the only line of defence.
 */
public final class HtmlSanitizer {
    private HtmlSanitizer() {}

    public static final class Result {
        public String html;
        /** Remote images (and remote CSS backgrounds) that were blocked. */
        public int blocked;
        /** cid: references that were used (those images are not shown as separate attachments). */
        public final Set<String> cids = new HashSet<>();
    }

    private static final Set<String> TAGS = new HashSet<>(Arrays.asList(
            "a", "abbr", "address", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup",
            "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
            "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "style", "sub", "sup",
            "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "var", "wbr", "article", "section", "header", "footer",
            "main", "nav", "aside", "time", "picture", "summary", "details"));
    /** Dropped together with everything inside. */
    private static final Set<String> DROP = new HashSet<>(Arrays.asList(
            "script", "title", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "svg", "math",
            "textarea", "select", "button", "audio", "video", "canvas", "noembed", "noframes", "xml", "head-script"));
    private static final Set<String> VOID = new HashSet<>(Arrays.asList("br", "hr", "img", "col", "wbr", "input", "meta", "link", "base", "source", "area", "param"));
    private static final Set<String> ATTRS = new HashSet<>(Arrays.asList(
            "style", "class", "id", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing",
            "colspan", "rowspan", "dir", "lang", "title", "alt", "face", "size", "start", "type", "href", "src", "nowrap", "span",
            "datetime", "cite", "reversed", "headers", "scope", "abbr", "summary", "hspace", "vspace", "frame", "rules", "open"));

    private static final Pattern TAG = Pattern.compile("<(/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>|<!--.*?-->|<!\\[CDATA\\[.*?\\]\\]>|<![^>]*>|<\\?[^>]*>", Pattern.DOTALL);
    private static final Pattern ATTR = Pattern.compile("([^\\s\"'>/=]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?");
    private static final Pattern CSS_URL = Pattern.compile("(?i)url\\s*\\(\\s*(['\"]?)(.*?)\\1\\s*\\)");

    /**
     * @param cidUrl maps a Content-ID (without angle brackets) to a local URL, or null to drop the image
     */
    public static Result sanitize(String html, boolean allowRemote, Function<String, String> cidUrl) {
        Result r = new Result();
        StringBuilder out = new StringBuilder(html.length());
        Deque<String> open = new ArrayDeque<>();
        Matcher m = TAG.matcher(html);
        int last = 0;
        String dropping = null;
        int dropDepth = 0;
        boolean inStyle = false;
        StringBuilder style = null;
        while (m.find()) {
            String text = html.substring(last, m.start());
            last = m.end();
            if (dropping == null) {
                if (inStyle) style.append(text);
                else out.append(escapeText(text));
            }
            if (m.group(2) == null) continue; // comment, doctype, CDATA, processing instruction
            boolean closing = !m.group(1).isEmpty();
            String name = m.group(2).toLowerCase(Locale.ROOT);
            if (dropping != null) {
                if (name.equals(dropping)) dropDepth += closing ? -1 : 1;
                if (dropDepth <= 0) dropping = null;
                continue;
            }
            if (DROP.contains(name)) {
                if (!closing && !m.group(3).trim().endsWith("/")) { dropping = name; dropDepth = 1; }
                continue;
            }
            if (name.equals("style")) {
                if (!closing) { inStyle = true; style = new StringBuilder(); }
                else if (inStyle) {
                    inStyle = false;
                    out.append("<style>").append(cleanCss(style.toString(), allowRemote, r).replace("</", "<\\/")).append("</style>");
                }
                continue;
            }
            if (inStyle) continue;
            if (!TAGS.contains(name)) continue; // unknown or not allowed: drop the tag, keep its text
            if (closing) {
                if (VOID.contains(name)) continue;
                if (open.contains(name)) {
                    while (!open.isEmpty()) {
                        String t = open.pop();
                        out.append("</").append(t).append('>');
                        if (t.equals(name)) break;
                    }
                }
                continue;
            }
            StringBuilder tag = new StringBuilder("<").append(name);
            boolean keep = attributes(name, m.group(3), tag, allowRemote, cidUrl, r);
            if (!keep) continue;
            if (name.equals("a")) tag.append(" target=\"_blank\" rel=\"noopener noreferrer\"");
            tag.append('>');
            out.append(tag);
            if (!VOID.contains(name)) open.push(name);
        }
        if (dropping == null && !inStyle) out.append(escapeText(html.substring(last)));
        while (!open.isEmpty()) out.append("</").append(open.pop()).append('>');
        r.html = out.toString();
        return r;
    }

    /** Writes allowed attributes; returns false when the element should be dropped (an image without a usable source). */
    private static boolean attributes(String tag, String raw, StringBuilder out, boolean allowRemote, Function<String, String> cidUrl, Result r) {
        Matcher a = ATTR.matcher(raw);
        boolean isImg = tag.equals("img");
        boolean hasSrc = false;
        Set<String> seen = new HashSet<>();
        while (a.find()) {
            String name = a.group(1).toLowerCase(Locale.ROOT);
            String value = a.group(2) != null ? a.group(2) : a.group(3) != null ? a.group(3) : a.group(4) != null ? a.group(4) : "";
            value = Mime.decodeEntities(value);
            if (!ATTRS.contains(name) || name.startsWith("on") || !seen.add(name)) continue;
            if (name.equals("href")) {
                if (!tag.equals("a")) continue;
                String v = value.trim();
                String low = v.toLowerCase(Locale.ROOT).replaceAll("[\\s\\x00-\\x1f]", "");
                if (!(low.startsWith("http://") || low.startsWith("https://") || low.startsWith("mailto:") || low.startsWith("tel:"))) continue;
                value = v;
            } else if (name.equals("src")) {
                if (!isImg) continue;
                String v = value.trim(), low = v.toLowerCase(Locale.ROOT);
                if (low.startsWith("cid:")) {
                    String cid = v.substring(4).replaceAll("^<|>$", "");
                    String local = cidUrl == null ? null : cidUrl.apply(cid);
                    if (local == null) continue;
                    r.cids.add(cid);
                    value = local;
                } else if (low.matches("data:image/(png|gif|jpe?g|webp);base64,[a-z0-9+/=\\s]*")) {
                    value = v;
                } else if (low.startsWith("http://") || low.startsWith("https://") || low.startsWith("//")) {
                    if (!allowRemote) { r.blocked++; continue; }
                    value = low.startsWith("//") ? "https:" + v : v;
                } else continue;
                hasSrc = true;
            } else if (name.equals("style")) {
                value = cleanCss(value, allowRemote, r);
                if (value.isEmpty()) continue;
            } else if (name.equals("cite")) {
                continue; // a URL, and not shown anyway
            }
            out.append(' ').append(name).append("=\"").append(escapeAttr(value)).append('"');
        }
        return !isImg || hasSrc;
    }

    /** CSS without imports, scripts or (unless allowed) remote resources. */
    static String cleanCss(String css, boolean allowRemote, Result r) {
        String c = css.replaceAll("(?is)/\\*.*?\\*/", " ");
        c = c.replaceAll("(?i)@import[^;]*;?", "")
                .replaceAll("(?i)expression\\s*\\(", "x(")
                .replaceAll("(?i)(-moz-binding|behavior)\\s*:", "x-blocked:")
                .replaceAll("(?i)javascript:", "");
        Matcher m = CSS_URL.matcher(c);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String url = m.group(2).trim().toLowerCase(Locale.ROOT);
            boolean ok = url.startsWith("data:image/") || (allowRemote && (url.startsWith("https://") || url.startsWith("http://")));
            if (!ok && (url.startsWith("http") || url.startsWith("//"))) r.blocked++;
            m.appendReplacement(out, ok ? Matcher.quoteReplacement(m.group()) : "none");
        }
        m.appendTail(out);
        return out.toString().replace("<", "").trim();
    }

    /** Text between tags: entities are kept; stray "<" and ">" escaped. */
    private static String escapeText(String s) {
        return s.replace("<", "&lt;").replace(">", "&gt;");
    }

    static String escapeAttr(String s) {
        return s.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;");
    }

    public static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }

    private static final Pattern URL = Pattern.compile("(https?://[^\\s<>\"']+[^\\s<>\"'.,;:!?)\\]])");

    /** Plain text as HTML: escaped, URLs as links, line breaks kept. */
    public static String textToHtml(String text) {
        String esc = escape(text == null ? "" : text);
        Matcher m = URL.matcher(esc);
        StringBuffer out = new StringBuffer();
        while (m.find()) {
            String u = m.group(1);
            m.appendReplacement(out, Matcher.quoteReplacement("<a href=\"" + u + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + u + "</a>"));
        }
        m.appendTail(out);
        return "<div style=\"white-space:pre-wrap;word-wrap:break-word\">" + out + "</div>";
    }
}
