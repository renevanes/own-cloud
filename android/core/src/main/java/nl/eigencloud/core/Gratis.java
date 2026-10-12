package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Aanbieder worden "zo gratis mogelijk" (port of src/console/gratis.ts; the routes /api/aanbieder/modus, /gratis-adres,
 * /proef and /verhuizen return the same JSON): the choice at the top of "Wat je nodig hebt" (console.aanbiederModus),
 * a free name.dedyn.io address at deSEC, a server on start credit at UpCloud or Exoscale (backups at the same provider
 * when the console can arrange that itself, otherwise at Scaleway), the credit and end date with warnings, and moving to
 * the cheapest suitable paid server through the regular "opnieuw opzetten". Sources and dates are in the TypeScript file.
 * Blocking; call off the UI thread.
 */
public final class Gratis {
    private Gratis() {}

    /** Tests: a fixed clock. */
    public interface Clock { long now(); }

    public static volatile Clock clock = System::currentTimeMillis;

    private static long now() { return clock.now(); }

    public static final long DAG = 86_400_000L;
    public static final String DEDYN = "dedyn.io";
    private static final List<String> DESEC_NS = Arrays.asList("ns1.desec.io", "ns2.desec.org");
    public static final double VANAF = 6;
    public static final String MAIL_KOSTEN = "gratis tot 300 mails per maand, daarna € 0,25 per 1.000 (volgens Scaleway)";
    public static final String BACKUP_KOSTEN = "minder dan € 0,01 per maand";
    public static final List<String> PROEF_IDS = Collections.unmodifiableList(Arrays.asList("upcloud", "exoscale"));

    /** What the providers with start credit say (checked on 12-10-2026; PROEF in TS). */
    public static final class Proef {
        public final String naam, aanmelden, wat, tijdens, einde, eindeKort, backup, backupUitleg, bron;
        public final Integer dagen;
        public final Double startTegoed;

        Proef(String naam, String aanmelden, String wat, String tijdens, String einde, String eindeKort, Integer dagen, Double startTegoed, String backup, String backupUitleg, String bron) {
            this.naam = naam; this.aanmelden = aanmelden; this.wat = wat; this.tijdens = tijdens; this.einde = einde; this.eindeKort = eindeKort;
            this.dagen = dagen; this.startTegoed = startTegoed; this.backup = backup; this.backupUitleg = backupUitleg; this.bron = bron;
        }
    }

    public static final Proef UPCLOUD = new Proef("UpCloud", "https://hub.upcloud.com",
            "Volgens UpCloud: elk nieuw account krijgt een gratis proefperiode van 7 dagen (met een actie soms langer, bijvoorbeeld 30 dagen met € 500 tegoed). Je bevestigt je identiteit met een creditcard; UpCloud belast die niet.",
            "Tijdens de proef: hooguit 2 processors en 4 GB geheugen, en naar buiten alleen de webpoorten (80 en 443). Mail via SMTP kan dan niet; je Dienst verstuurt mail daarom via de webkoppeling van Scaleway.",
            "Na de proef haalt UpCloud weg wat je hebt gemaakt, tenzij je vóór het einde minstens € 10 stort. Verhuis je Dienst daarom op tijd naar een betaalde server; de app doet dat met één tik.",
            "Daarna haalt UpCloud je server weg, tenzij je minstens € 10 stort.", 7, null, "scaleway",
            "Opslag bij UpCloud moet je met de hand aanmaken, en verdwijnt na de proef. Daarom komen de back-ups bij Scaleway: minder dan € 0,01 per maand, en ze blijven bestaan.",
            "https://upcloud.com/docs/getting-started/free-trial/");
    public static final Proef EXOSCALE = new Proef("Exoscale", "https://portal.exoscale.com/register",
            "Volgens Exoscale: € 20 tegoed (of CHF 20) direct na het aanmelden. Je slaat een creditcard op en kiest achteraf betalen; de kaart wordt pas belast als je meer gebruikt dan het tegoed.",
            "Maak bij IAM een rol met Compute en Object Storage (SOS), en een API-sleutel met die rol. Met dezelfde sleutel komen de back-ups ook bij Exoscale, betaald van je tegoed.",
            "Is het tegoed op, dan draait je server gewoon door en betaal je met je creditcard. Hoe lang het tegoed geldig is, zegt Exoscale niet precies. Verhuizen naar een goedkopere server kan altijd met één tik.",
            "Daarna betaal je Exoscale met je creditcard.", null, 20.0, "zelf",
            "De back-ups komen bij Exoscale (Object Storage), met dezelfde sleutel: betaald van je tegoed, daarna een klein bedrag voor een paar MB.",
            "https://community.exoscale.com/platform/quick-start/");

    public static Proef proefInfo(String id) { return "upcloud".equals(id) ? UPCLOUD : "exoscale".equals(id) ? EXOSCALE : null; }

    private static boolean nonEmpty(String v) { return v != null && !v.isEmpty(); }

    private static String hostOf(String url) {
        if (url == null || url.isEmpty()) return null;
        try { return new java.net.URI(url).getHost(); } catch (java.net.URISyntaxException e) { return null; }
    }

    /** Is this a free deSEC address (name.dedyn.io)? */
    public static boolean isDedyn(String host) { return host != null && host.endsWith("." + DEDYN) && host.split("\\.", -1).length == 3; }

    // ───────── Opmaak ─────────

    public static String euro(double n) { return "€ " + ConsoleApi.euro(n); }

    private static String geld(double n, String valuta) { return "EUR".equals(valuta) ? euro(n) : valuta + " " + ConsoleApi.euro(n); }

    private static final String[] MAANDEN = {"januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"};

    private static int[] ymd(long ms) {
        Calendar k = Calendar.getInstance(TimeZone.getTimeZone("Europe/Amsterdam"));
        k.setTimeInMillis(ms);
        return new int[] {k.get(Calendar.YEAR), k.get(Calendar.MONTH) + 1, k.get(Calendar.DAY_OF_MONTH)};
    }

    /** "19 oktober" (with the year when it is not this year). */
    public static String datum(long ms) {
        int[] d = ymd(ms), n = ymd(now());
        return d[2] + " " + MAANDEN[d[1] - 1] + (d[0] != n[0] ? " " + d[0] : "");
    }

    /** "2026-10-19". */
    public static String isoDatum(long ms) {
        int[] d = ymd(ms);
        return String.format(Locale.ROOT, "%04d-%02d-%02d", d[0], d[1], d[2]);
    }

    private static long parseDatum(String v) {
        Matcher m = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})$").matcher(v.trim());
        if (m.find()) {
            Calendar u = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            u.clear();
            u.setLenient(true);
            u.set(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)) - 1, Integer.parseInt(m.group(3)), 12, 0, 0);
            long ms = u.getTimeInMillis();
            if (isoDatum(ms).equals(v.trim())) return ms;
        }
        throw new IllegalArgumentException("Vul de datum in als 2026-10-19");
    }

    // ───────── De keuze ─────────

    /** "gratis" or "standaard" (no choice: standaard, as it always was). */
    public static String modus(Map<String, Object> c) { return "gratis".equals(Json.str(c, "console", "aanbiederModus")) ? "gratis" : "standaard"; }

    public static Map<String, Object> setModus(Map<String, Object> c, Map<String, Object> b) {
        String m = Json.str(b, "modus");
        if (!"gratis".equals(m) && !"standaard".equals(m)) throw new IllegalArgumentException("Kies hoe je wilt beginnen");
        Json.map(c, "console").put("aanbiederModus", m);
        return Json.obj("ok", true, "modus", m);
    }

    // ───────── Starttegoed ─────────

    /** The trial as the console shows it (no network; the credit is the last one read). proefView in TS. */
    public static Map<String, Object> proefView(Map<String, Object> a) {
        Map<String, Object> p = a == null ? null : Json.map(a, "proef");
        Proef info = p == null ? null : proefInfo(Json.str(p, "provider"));
        if (p == null || info == null) return null;
        long t = now();
        String plek = a.get("server") != null ? Json.str(a, "server", "provider") : Json.truthy(a.get("removed")) ? null : Json.str(a, "hosting", "provider");
        boolean actief = Json.str(p, "provider").equals(plek);
        Number eindN = Json.num(p, "eind");
        Long eind = eindN == null ? null : eindN.longValue();
        Long dagenOver = eind == null ? null : (long) Math.ceil((eind - t) / (double) DAG);
        Map<String, Object> tg = Json.map(p, "tegoed");
        Number startN = Json.num(p, "startTegoed");
        Double start = startN == null ? null : startN.doubleValue();
        double bedrag = tg == null ? 0 : Json.num(tg, "bedrag").doubleValue();
        String valuta = tg == null ? "EUR" : Json.str(tg, "valuta");
        Long procent = tg != null && start != null && start != 0 ? Math.max(0L, Math.min(100L, Math.round(bedrag / start * 100))) : null;
        boolean verlopen = eind != null && t >= eind;
        String eindBron = Json.str(p, "eindBron");
        String eindTekst = eind == null ? null : ("geschat".equals(eindBron) ? "ongeveer " : "") + datum(eind);
        String soort = null, waarschuwing = null;
        if (actief) {
            if (verlopen) { soort = "verlopen"; waarschuwing = "Je proefperiode bij " + info.naam + " is voorbij. " + info.eindeKort + " Verhuis je Dienst nu naar een betaalde server."; }
            else if (dagenOver != null && dagenOver <= 3) {
                soort = "dagen";
                waarschuwing = "Je proefperiode bij " + info.naam + " loopt " + (dagenOver <= 1 ? "binnen een dag" : "over " + dagenOver + " dagen") + " af (" + eindTekst + "). " + info.eindeKort + " Verhuis je Dienst op tijd naar een betaalde server.";
            } else if (tg != null && (bedrag <= 0 || (procent != null && procent < 20))) {
                soort = "tegoed";
                waarschuwing = "Je starttegoed bij " + info.naam + " is bijna op (nog " + geld(Math.max(0, bedrag), valuta) + "). " + info.eindeKort + " Verhuis je Dienst op tijd naar een betaalde server.";
            }
        }
        String titel = "verlopen".equals(soort) ? "Proefperiode voorbij" : "dagen".equals(soort) ? "Proefperiode bijna voorbij" : "tegoed".equals(soort) ? "Starttegoed bijna op" : null;
        return Json.obj("provider", Json.str(p, "provider"), "naam", info.naam, "actief", actief, "verhuisd", Json.truthy(p.get("verhuisd")) && !actief,
                "eind", eind, "eindBron", eindBron, "eindTekst", eindTekst, "eindDatum", eind == null ? null : isoDatum(eind), "dagenOver", dagenOver,
                "tegoed", tg == null ? null : Json.obj("bedrag", bedrag, "valuta", valuta, "at", tg.get("at")), "startTegoed", start, "procent", procent,
                "tegoedTekst", tg == null ? null : geld(bedrag, valuta) + (start != null && start != 0 ? " van " + geld(start, valuta) : ""),
                "verlopen", verlopen, "soort", soort, "titel", titel, "waarschuwing", waarschuwing,
                "wat", info.wat, "tijdens", info.tijdens, "einde", info.einde, "bron", info.bron, "aanmelden", info.aanmelden);
    }

    /** Read the credit at the provider (read only; leesTegoed in TS): UpCloud credits in cents, Exoscale live-balance. */
    public static boolean leesTegoed(Map<String, Object> a) {
        Map<String, Object> p = Json.map(a, "proef");
        String id = p == null ? null : Json.str(p, "provider");
        Map<String, Object> f = id == null ? null : Json.map(a, "keys", id);
        if (p == null || f == null) return false;
        try {
            double bedrag;
            String valuta = "EUR";
            if ("upcloud".equals(id)) {
                Http.Response r = Http.request("GET", Endpoints.UPCLOUD.replaceAll("/+$", "") + "/account", Http.headers("authorization", UpCloudProvider.auth(f)), null, 8000);
                if (!r.ok()) return false;
                Number cents = Json.num(Json.parse(r.text()), "account", "credits");
                if (cents == null || Double.isNaN(cents.doubleValue()) || Double.isInfinite(cents.doubleValue())) return false;
                bedrag = Math.round(cents.doubleValue()) / 100.0;
            } else {
                String url = ExoscaleProvider.base(Endpoints.EXOSCALE, "ch-gva-2") + "/live-balance";
                String auth = ExoscaleProvider.sign("GET", url, "", nz(Json.str(f, "apiKey")), nz(Json.str(f, "apiSecret")), System.currentTimeMillis() / 1000 + 600);
                Http.Response r = Http.request("GET", url, Http.headers("authorization", auth), null, 8000);
                if (!r.ok()) return false;
                Object j = Json.parse(r.text());
                Number b = Json.num(j, "balance");
                if (b == null) return false;
                bedrag = Math.round(b.doubleValue() * 100) / 100.0;
                String cur = Json.str(j, "currency");
                valuta = (nonEmpty(cur) ? cur : "EUR").toUpperCase(Locale.ROOT);
            }
            p.put("tegoed", Json.obj("bedrag", bedrag, "valuta", valuta, "at", now()));
            Proef info = proefInfo(id);
            Number st = Json.num(p, "startTegoed");
            double basis = st != null ? st.doubleValue() : info.startTegoed != null ? info.startTegoed : 0;
            p.put("startTegoed", Math.max(bedrag, basis));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private static String nz(String v) { return v == null ? "" : v; }

    /** Read the credit again when the last reading is older than 10 minutes (or {@code fresh}). verversTegoed in TS. */
    public static boolean verversTegoed(Map<String, Object> c, boolean fresh) {
        Map<String, Object> a = Aanbieder.existing(c);
        Map<String, Object> p = a == null ? null : Json.map(a, "proef");
        Map<String, Object> v = proefView(a);
        if (p == null || v == null || !Json.truthy(v.get("actief"))) return false;
        Number at = Json.num(p, "tegoed", "at");
        if (!fresh && at != null && now() - at.longValue() < 10 * 60_000L) return false;
        return leesTegoed(a);
    }

    // ───────── De goedkoopste betaalde server ─────────

    private static final Map<String, Object[]> SIZE_CACHE = new ConcurrentHashMap<>(); // key → {at, SizeOption or null}

    /** Tests only. */
    public static void resetCache() { SIZE_CACHE.clear(); }

    /** The linked providers with servers and their credentials (Scaleway: the key at Accounts). gekoppeld in TS. */
    private static List<Object[]> gekoppeld(Map<String, Object> c, Map<String, Object> a) {
        List<Object[]> out = new ArrayList<>();
        String key = Json.str(a, "accounts", "scalewaySecretKey");
        if (nonEmpty(key) && Boolean.TRUE.equals(Json.path(a, "checked", "scaleway"))) out.add(new Object[] {"scaleway", Json.obj("secretKey", key, "projectId", nz(Json.str(a, "projectId")))});
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        Map<String, Object> prov = Json.map(c, "providers"), keys = Json.map(a, "keys");
        if (prov != null) ids.addAll(prov.keySet());
        if (keys != null) ids.addAll(keys.keySet());
        ids.remove("scaleway");
        for (String id : ids) {
            Map<String, Object> f = Json.obj();
            if (Json.map(prov, id) != null) f.putAll(Json.copy(Json.map(prov, id)));
            if (Json.map(keys, id) != null) f.putAll(Json.copy(Json.map(keys, id)));
            out.add(new Object[] {id, f});
        }
        return out;
    }

    private static int cmp(Object x, Object y) {
        Number a = Json.num(x, "monthly"), b = Json.num(y, "monthly");
        return Double.compare(a == null ? Double.POSITIVE_INFINITY : a.doubleValue(), b == null ? Double.POSITIVE_INFINITY : b.doubleValue());
    }

    private static int indexOf(List<Map<String, Object>> offers, String id) {
        for (int i = 0; i < offers.size(); i++) if (id.equals(offers.get(i).get("id"))) return i;
        return -1;
    }

    /** Per linked provider (except {@code zonder}) the cheapest region with the smallest suitable size; kandidaten in TS. */
    @SuppressWarnings("unchecked")
    public static List<Object> kandidaten(Map<String, Object> c, Map<String, Object> a, boolean fresh, String zonder, Aanbieder.Offers deps) {
        final List<Map<String, Object>> offers = deps.serverOffers();
        List<Object> out = new ArrayList<>();
        for (Object[] g : gekoppeld(c, a)) {
            String id = (String) g[0];
            Map<String, Object> fields = (Map<String, Object>) g[1];
            if (id.equals(zonder) || indexOf(offers, id) < 0) continue;
            Map<String, Object> offer = offers.get(indexOf(offers, id));
            String sleutel = Bytes.sha256Hex(Bytes.utf8(Json.stringify(fields))).substring(0, 12);
            List<Object> ok = new ArrayList<>();
            for (Object r : Json.listAt(offer, "regions")) {
                String rid = Json.str(r, "id");
                String k = id + "/" + rid + "/" + sleutel;
                Object[] hit = SIZE_CACHE.get(k);
                Catalog.SizeOption s;
                if (!fresh && hit != null && System.currentTimeMillis() - (Long) hit[0] < 10 * 60_000L) s = (Catalog.SizeOption) hit[1];
                else {
                    try { s = Catalog.pickSize(Catalog.fetchSizes(id, fields, rid), "data"); } catch (IOException | RuntimeException e) { s = null; }
                    SIZE_CACHE.put(k, new Object[] {System.currentTimeMillis(), s});
                }
                if (s != null) ok.add(Json.obj("provider", id, "naam", offer.get("name"), "region", rid, "regionLabel", Json.str(r, "label"), "city", Json.str(r, "city"),
                        "country", Json.str(r, "country"), "size", s.size, "sizeLabel", s.label, "monthly", s.monthly));
            }
            if (ok.isEmpty()) continue;
            List<Object> sorted = new ArrayList<>(ok);
            sorted.sort(Gratis::cmp);
            out.add(sorted.get(0));
        }
        out.sort((x, y) -> { int d = cmp(x, y); return d != 0 ? d : Integer.compare(indexOf(offers, Json.str(x, "provider")), indexOf(offers, Json.str(y, "provider"))); });
        return out;
    }

    /** What the server costs once the start credit is spent (prijsNa in TS). */
    public static Map<String, Object> prijsNa(Map<String, Object> c, Map<String, Object> a, boolean fresh, Aanbieder.Offers deps) {
        String zonder = Json.str(a, "proef", "provider");
        for (Object k : kandidaten(c, a, fresh, zonder, deps)) {
            if (Json.num(k, "monthly") != null) return Json.obj("bedrag", Json.num(k, "monthly").doubleValue(), "vanaf", false, "provider", Json.str(k, "provider"), "naam", Json.str(k, "naam"));
        }
        Double best = null;
        String bp = null;
        Map<String, Object> cat = Json.map(c, "console", "catalog");
        if (cat != null) for (Map.Entry<String, Object> e : cat.entrySet()) {
            if (e.getKey().equals(zonder) || !(e.getValue() instanceof Map)) continue;
            for (Object picks : ((Map<?, ?>) e.getValue()).values()) {
                Number m = Json.num(picks, "data", "monthly");
                if (m != null && (best == null || m.doubleValue() < best)) { best = m.doubleValue(); bp = e.getKey(); }
            }
        }
        if (best != null) {
            Object naam = bp;
            for (Map<String, Object> o : deps.serverOffers()) if (bp.equals(o.get("id"))) naam = o.get("name");
            return Json.obj("bedrag", best, "vanaf", false, "provider", bp, "naam", naam);
        }
        return Json.obj("bedrag", VANAF, "vanaf", true, "provider", null, "naam", null);
    }

    public static String naTekst(Map<String, Object> na) {
        return na == null ? "een paar euro per maand" : (Json.truthy(na.get("vanaf")) ? "vanaf ongeveer " : "ongeveer ") + euro(Json.num(na, "bedrag").doubleValue()) + " per maand";
    }

    // ───────── Gratis adres bij deSEC ─────────

    private static String naamOf(Object raw) {
        String v = (raw == null ? "" : Json.jsString(raw)).trim().toLowerCase(Locale.ROOT).replaceFirst("^https?://", "").replaceFirst("/.*$", "").replaceFirst("\\.$", "").replaceFirst("\\.dedyn\\.io$", "");
        if (!v.matches("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")) throw new IllegalArgumentException("Kies een naam van letters, cijfers en streepjes (niet aan het begin of eind), bijvoorbeeld jouwbedrijf");
        return v;
    }

    /** {status, json, text} of a deSEC call. */
    private static Object[] desecReq(String method, String path, String token, Object body, int ms) throws IOException {
        Http.Response r = Http.request(method, Endpoints.DESEC.replaceAll("/+$", "") + path, Http.headers("authorization", "Token " + token, "content-type", "application/json"),
                body == null ? null : Bytes.utf8(Json.stringify(body)), ms);
        Object j = null;
        try { j = r.text().isEmpty() ? null : Json.parse(r.text()); } catch (RuntimeException e) { j = null; }
        return new Object[] {r.status, j, r.text()};
    }

    private static List<String> desecZones(String token) throws IOException {
        Object[] r = desecReq("GET", "/domains/", token, null, 20_000);
        int s = (Integer) r[0];
        if (s == 401 || s == 403) throw new IOException("deSEC accepteert het token van je Dienst niet");
        if (s < 200 || s >= 300) throw new IOException("deSEC antwoordt " + s);
        List<String> out = new ArrayList<>();
        for (Object x : Json.asList(r[1]) == null ? new ArrayList<>() : Json.asList(r[1])) out.add(Json.str(x, "name") == null ? "" : Json.str(x, "name"));
        return out;
    }

    /** true (at deSEC), "anders", false (not there) or null (unknown). */
    private static Object inDns(String fqdn) {
        Doh.Answer ns = Doh.lookup(fqdn, "NS");
        return ns == null ? null : Doh.nsMatch(ns.values, DESEC_NS) ? (Object) Boolean.TRUE : !ns.values.isEmpty() ? (Object) "anders" : (Object) Boolean.FALSE;
    }

    /** The free address: check {naam}, or create and use it {naam, maken: true} (gratisAdres in TS). */
    public static Map<String, Object> gratisAdres(final Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        final Map<String, Object> a = Aanbieder.state(c);
        String naam = naamOf(b.get("naam") != null ? b.get("naam") : Json.str(a, "gratisAdres", "naam"));
        final String fqdn = naam + "." + DEDYN;
        String token = Json.str(a, "accounts", "desecToken");
        if (!nonEmpty(token)) throw new IllegalArgumentException("Maak eerst je gratis deSEC-account (bij deSEC, verderop in de lijst). Daarmee maakt de app het adres.");
        List<String> zones;
        try { zones = desecZones(token); } catch (java.net.SocketTimeoutException e) { throw new IOException("deSEC reageert nu niet. Probeer het zo opnieuw.", e); }
        String ander = null;
        for (String z : zones) if (isDedyn(z) && !z.equals(fqdn)) { ander = z; break; }
        boolean vanJou = zones.contains(fqdn);
        String host = hostOf(Json.str(a, "url"));
        final String fAnder = ander;
        java.util.function.BiFunction<String, String, Map<String, Object>> view = (status, uitleg) -> {
            String h = hostOf(Json.str(a, "url"));
            return Json.obj("ok", true, "naam", fqdn, "status", status, "uitleg", uitleg, "ander", fAnder, "gebruikt", fqdn.equals(h),
                    "pending", a.get("server") != null && fqdn.equals(h) && "opnieuw".equals(Aanbieder.wijzigingen(c, a)));
        };
        if (!vanJou && ander != null) return view.apply("ander", "Je deSEC-account heeft al een gratis adres: " + ander + ". deSEC geeft één gratis adres per account. Gebruik dat adres, of haal het eerst weg bij deSEC.");
        if (!Boolean.TRUE.equals(b.get("maken"))) {
            if (vanJou) {
                Object d = inDns(fqdn);
                Map<String, Object> ga = Json.map(a, "gratisAdres");
                if (Boolean.TRUE.equals(d) && ga != null && fqdn.equals(Json.str(ga, "naam")) && !Json.truthy(ga.get("klaar"))) { ga.put("klaar", true); deps.save(); }
                return fqdn.equals(host)
                        ? view.apply(Boolean.TRUE.equals(d) ? "klaar" : "wacht", Boolean.TRUE.equals(d) ? fqdn + " werkt en staat bij deSEC." : "deSEC zet " + fqdn + " nu klaar. Dat duurt meestal een paar minuten; de app kijkt vanzelf.")
                        : view.apply("van-jou", fqdn + " is van jou (in je deSEC-account). Kies \"Maak dit adres\" om het te gebruiken.");
            }
            Object d = inDns(fqdn);
            return d == null ? view.apply("onbekend", "Kon niet nagaan of " + fqdn + " vrij is. Probeer het gewoon; is hij bezet, dan zegt deSEC dat.")
                    : Boolean.FALSE.equals(d) ? view.apply("vrij", fqdn + " is vrij.")
                    : view.apply("bezet", fqdn + " is al bezet. Kies een andere naam.");
        }
        if (!vanJou) {
            Object[] r;
            try {
                r = desecReq("POST", "/domains/", token, Json.obj("name", fqdn), 60_000);
            } catch (IOException e) {
                // Kwam het antwoord niet, dan kan het adres toch gemaakt zijn.
                List<String> z;
                try { z = desecZones(token); } catch (IOException | RuntimeException e2) { z = new ArrayList<>(); }
                if (!z.contains(fqdn)) throw new IOException("deSEC reageert nu niet. Probeer het zo opnieuw; als het adres toch is gemaakt, ziet de app dat vanzelf.", e);
                r = new Object[] {201, null, ""};
            }
            int s = (Integer) r[0];
            if (s == 401 || s == 403) throw new IOException("deSEC accepteert het token van je Dienst niet");
            if (s == 429) throw new IOException("deSEC vraagt even te wachten. Probeer het over een minuut opnieuw.");
            if (s < 200 || s >= 300) {
                String t = ((String) r[2]).toLowerCase(Locale.ROOT);
                if (s == 409 || Pattern.compile("conflict|unavailable|already|taken|exists").matcher(t).find()) throw new IOException(fqdn + " is al bezet. Kies een andere naam.");
                if (Pattern.compile("limit|one domain|maximum|exceed").matcher(t).find()) throw new IOException("deSEC geeft één gratis adres per account, en je account heeft er al een.");
                throw new IOException("deSEC: " + Extras.desecError(r[1]));
            }
        }
        Map<String, Object> oud = Json.map(a, "gratisAdres");
        Map<String, Object> ga = Json.obj("naam", fqdn, "at", now(), "klaar", oud != null && fqdn.equals(Json.str(oud, "naam")) && Json.truthy(oud.get("klaar")));
        a.put("gratisAdres", ga);
        Aanbieder.saveAdres(c, Json.obj("url", fqdn));
        deps.save();
        Aanbieder.saveDns(c, Json.obj("provider", "desec", "zone", fqdn), deps);
        Object d = inDns(fqdn);
        if (Boolean.TRUE.equals(d)) ga.put("klaar", true);
        deps.save();
        Map<String, Object> out = view.apply(Boolean.TRUE.equals(d) ? "klaar" : "wacht", Boolean.TRUE.equals(d) ? fqdn + " is gemaakt en werkt."
                : fqdn + " is gemaakt. deSEC zet hem nu klaar in dedyn.io; dat duurt meestal een paar minuten. De app kijkt vanzelf.");
        out.put("url", "https://" + fqdn);
        return out;
    }

    // ───────── Server op starttegoed ─────────

    private static final List<String> LANDEN = Arrays.asList("NL", "DE", "BE", "FR", "AT", "CH", "FI", "SE", "PL", "BG");

    private static int rank(Object r) { int i = LANDEN.indexOf(Json.str(r, "country")); return i < 0 ? LANDEN.size() : i; }

    /** Link UpCloud or Exoscale with start credit, or set the trial's end date (proef in TS). */
    public static Map<String, Object> proef(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        String id = Json.str(b, "provider");
        if (!nonEmpty(id)) {
            Map<String, Object> p = Json.map(a, "proef");
            if (p == null) throw new IllegalArgumentException("Kies eerst UpCloud of Exoscale");
            if (!b.containsKey("eind")) throw new IllegalArgumentException("Vul de einddatum in");
            Proef info = proefInfo(Json.str(p, "provider"));
            Object e = b.get("eind");
            if (e == null || Json.jsString(e).trim().isEmpty()) {
                if (info.dagen != null) { p.put("eind", Json.num(p, "at").longValue() + info.dagen * DAG); p.put("eindBron", "geschat"); }
                else { p.put("eind", null); p.put("eindBron", null); }
            } else { p.put("eind", parseDatum(Json.jsString(e))); p.put("eindBron", "ingevuld"); }
            deps.save();
            return Json.obj("ok", true, "proef", proefView(a));
        }
        Proef info = proefInfo(id);
        if (info == null) throw new IllegalArgumentException("Kies UpCloud of Exoscale");
        Map<String, Object> r = Aanbieder.saveServer(c, Json.obj("provider", id, "fields", b.get("fields")), deps);
        Object kies = null;
        for (Object x : Json.listAt(r, "regions")) if (x instanceof Map && ((Map<?, ?>) x).get("error") == null && Json.truthy(Json.path(x, "size")) && (kies == null || rank(x) < rank(kies))) kies = x;
        if (kies == null) throw new IOException("Bij " + info.naam + " lukt het ophalen van de formaten niet. Probeer het zo opnieuw.");
        String region = Json.str(kies, "region");
        Aanbieder.saveServer(c, Json.obj("provider", id, "region", region), deps);
        String backupUitleg;
        if (nonEmpty(Json.str(a, "backup", "bucket"))) backupUitleg = "De back-ups blijven waar ze al staan; die plek ligt vast.";
        else if ("zelf".equals(info.backup) && "exoscale".equals(id)) {
            Map<String, Object> f = Json.map(a, "keys", "exoscale");
            Aanbieder.saveBackup(c, Json.obj("provider", "exoscale", "region", region, "accessKey", Json.str(f, "apiKey"), "secretKey", Json.str(f, "apiSecret")), deps);
            backupUitleg = info.backupUitleg;
        } else {
            Aanbieder.saveBackup(c, Json.obj("provider", "scaleway", "region", Aanbieder.BACKUP_REGION), deps);
            backupUitleg = info.backupUitleg;
        }
        long t = now();
        Map<String, Object> oud = Json.map(a, "proef");
        boolean zelfde = oud != null && id.equals(Json.str(oud, "provider"));
        Map<String, Object> p = Json.obj("provider", id,
                "at", zelfde ? oud.get("at") : (Object) t,
                "eind", zelfde ? oud.get("eind") : info.dagen != null ? (Object) (t + info.dagen * DAG) : null,
                "eindBron", zelfde ? oud.get("eindBron") : info.dagen != null ? "geschat" : null,
                "tegoed", zelfde ? oud.get("tegoed") : null,
                "startTegoed", zelfde ? oud.get("startTegoed") : null);
        a.put("proef", p);
        Object eind = b.get("eind");
        if (eind != null && !Json.jsString(eind).isEmpty()) { p.put("eind", parseDatum(Json.jsString(eind))); p.put("eindBron", "ingevuld"); }
        deps.save();
        leesTegoed(a);
        deps.save();
        Map<String, Object> v = Aanbieder.view(c, deps);
        return Json.obj("ok", true, "provider", id, "hosting", Json.truthy(v.get("started")) ? v.get("hosting") : null, "backup", Json.truthy(v.get("started")) ? v.get("backup") : null,
                "backupUitleg", backupUitleg, "proef", proefView(a));
    }

    // ───────── Verhuizen naar een betaalde server ─────────

    /** Without {@code akkoord}: the cheapest choice; with {provider, region, akkoord}: move there (verhuizen in TS). */
    public static Map<String, Object> verhuizen(Map<String, Object> c, Map<String, Object> b, Aanbieder.Deps deps) throws IOException {
        Map<String, Object> a = Aanbieder.state(c);
        if (a.get("server") == null) throw new IllegalArgumentException("Er draait nog geen Dienst om te verhuizen");
        Map<String, Object> pv = proefView(a);
        String zonder = pv != null && Json.truthy(pv.get("actief")) ? Json.str(a, "proef", "provider") : Json.str(a, "server", "provider");
        List<Object> k = kandidaten(c, a, true, zonder, deps);
        if (!Boolean.TRUE.equals(b.get("akkoord"))) {
            String bp = Json.str(a, "backup", "provider");
            Proef bi = proefInfo(zonder);
            String backup = nonEmpty(bp) && bp.equals(zonder) ? "De back-ups blijven bij " + (bi != null ? bi.naam : zonder) + "; die plek ligt vast." : "De back-ups blijven waar ze staan.";
            return Json.obj("ok", true, "keuze", k.isEmpty() ? null : k.get(0), "kandidaten", k, "backup", backup,
                    "uitleg", k.isEmpty() ? "Koppel eerst een aanbieder voor een betaalde server, bijvoorbeeld Scaleway (die heb je al voor de clouds van je klanten)." : null);
        }
        Object keus = null;
        for (Object x : k) if (Json.str(x, "provider").equals(Json.str(b, "provider")) && (!nonEmpty(Json.str(b, "region")) || Json.str(x, "region").equals(Json.str(b, "region")))) { keus = x; break; }
        if (keus == null) throw new IllegalArgumentException("Kies een gekoppelde aanbieder voor je nieuwe server");
        Aanbieder.saveServer(c, Json.obj("provider", Json.str(keus, "provider"), "region", Json.str(keus, "region")), deps);
        deps.save();
        Map<String, Object> r = Aanbieder.opzetten(c, deps);
        Map<String, Object> p = Json.map(a, "proef");
        if (p != null) p.put("verhuisd", now());
        deps.save();
        Map<String, Object> out = Json.copy(r);
        out.put("verhuisd", true);
        return out;
    }
}
