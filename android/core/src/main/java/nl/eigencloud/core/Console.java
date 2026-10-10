package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * The setup/management steps of the desktop console (src/console/server.ts) without the web server: admin
 * config creation and recovery, the recovery key and sheet, stores, providers, presets, the launch checklist
 * and dashboard state. Methods mutate the admin config map in place; the caller saves the {@link Vault}
 * (and, once launched, calls {@link Admin#saveAdminCopy} / {@link Admin#pushAdminConfig}, as the console's
 * save() does).
 */
public final class Console {
    private Console() {}

    private static final Pattern DOMAIN = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+$");
    private static final Pattern MAILBOX = Pattern.compile("^[a-z0-9._+-]+$", Pattern.CASE_INSENSITIVE);
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", Pattern.CASE_INSENSITIVE);

    // ───────── New / recovered admin config ─────────

    /**
     * New admin config, as POST /api/setup/create builds it (validates input; Dutch error messages via
     * {@link IllegalArgumentException}). {@code alertEmail} may be null or empty.
     */
    public static Map<String, Object> newAdminConfig(String domainInput, String mailbox, String alertEmail, String appPassword) {
        String domain = (domainInput == null ? "" : domainInput).trim().toLowerCase(java.util.Locale.ROOT).replaceFirst("^https?://", "").replaceFirst("/[\\s\\S]*$", "");
        if (!DOMAIN.matcher(domain).matches()) throw new IllegalArgumentException("Vul een domeinnaam in, zoals vanes.nl");
        if (!MAILBOX.matcher(mailbox == null ? "" : mailbox).matches()) throw new IllegalArgumentException("Vul het deel vóór de @ in, zoals rene");
        if ((appPassword == null ? "" : appPassword).length() < 10) throw new IllegalArgumentException("Kies een inlogwachtwoord van minstens 10 tekens");
        if (alertEmail != null && !alertEmail.isEmpty() && !EMAIL.matcher(alertEmail).matches()) throw new IllegalArgumentException("Het meldadres is geen geldig e-mailadres");
        if (alertEmail != null && alertEmail.endsWith("@" + domain)) throw new IllegalArgumentException("Kies voor meldingen een adres buiten je eigen domein, zodat een melding je ook bereikt als je mail stuk is");
        String cluster = domain.split("\\.")[0].replaceAll("[^a-z0-9-]", "");
        cluster = Bytes.head(cluster, 20);
        if (cluster.isEmpty()) cluster = "eigen";
        Map<String, Object> c = Json.obj(
                "cluster", cluster, "nodeId", "beheer", "kind", "data", "masterKey", EigenCrypto.randomKeyHex(), "clusterPort", 7946L,
                "advertise", Json.obj("clusterUrl", ""), "seeds", Json.list(), "domain", domain,
                "stores", Json.list(), "providers", Json.obj(), "dns", Json.list(),
                "image", Json.obj("ref", "ghcr.io/renevanes/eigen-cloud:latest", "caddyRef", "ghcr.io/renevanes/eigen-caddy:latest"),
                "appEnv", Json.obj("MAIL_DOMAINS", domain, "MAIL_FROM", mailbox + "@" + domain, "HOSTNAME_FQDN", "mail." + domain, "NODE_ENV", "production"),
                "policy", ClusterConfig.defaultPolicy(),
                "console", Json.obj("step", "sleutel", "done", false, "keyConfirmed", false, "appPasswordHash", Scrypt.hashPassword(appPassword), "alertEmail", alertEmail == null ? "" : alertEmail));
        return c;
    }

    /** Cleans a typed master key (keeps hex digits, lowercase); throws when it is not 64 characters. */
    public static String normalizeMasterKey(String input) {
        String key = (input == null ? "" : input).replaceAll("[^0-9a-fA-F]", "").toLowerCase(java.util.Locale.ROOT);
        if (key.length() != 64) throw new IllegalArgumentException("De sleutel bestaat uit 64 tekens (0–9 en a–f)");
        return key;
    }

    /** POST /api/setup/recover: the admin config from storage, marked as set up. */
    public static Map<String, Object> recoverAdminConfig(String masterKeyInput, Map<String, Object> store) throws IOException {
        Map<String, Object> c = Json.map(Admin.findAdminConfig(normalizeMasterKey(masterKeyInput), store), "config");
        Map<String, Object> con = Json.map(c, "console");
        Map<String, Object> nc = con != null ? con : Json.obj();
        nc.put("step", "klaar");
        nc.put("done", true);
        nc.put("keyConfirmed", true);
        c.put("console", nc);
        return c;
    }

    // ───────── Recovery key ─────────

    /** The master key in 8 groups of 8 characters. */
    public static List<String> keyGroups(Map<String, Object> c) {
        String k = Json.str(c, "masterKey");
        List<String> g = new ArrayList<>();
        for (int i = 0; i + 8 <= k.length(); i += 8) g.add(k.substring(i, i + 8));
        return g;
    }

    /** Check code: first 6 hex chars of sha256(master key hex text). */
    public static String keyCheck(Map<String, Object> c) { return Bytes.sha256Hex(Bytes.utf8(Json.str(c, "masterKey"))).substring(0, 6); }

    /** Confirms that groups 3 and 7 were written down; sets console.keyConfirmed. */
    public static void confirmKey(Map<String, Object> c, String g3, String g7) {
        List<String> g = keyGroups(c);
        if (!norm(g3).equals(g.get(2)) || !norm(g7).equals(g.get(6))) throw new IllegalArgumentException("Dat klopt niet met je sleutel. Kijk nog eens naar groep 3 en 7.");
        console(c).put("keyConfirmed", true);
    }

    private static String norm(String x) { return (x == null ? "" : x).replaceAll("\\s", "").toLowerCase(java.util.Locale.ROOT); }

    private static Map<String, Object> console(Map<String, Object> c) {
        Map<String, Object> con = Json.map(c, "console");
        if (con == null) { con = Json.obj(); c.put("console", con); }
        return con;
    }

    private static final String[] MONTHS = {"januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"};

    /** Dutch long date like {@code toLocaleDateString("nl-NL", {dateStyle: "long"})}: "9 oktober 2026". */
    public static String dutchLongDate(Date d, TimeZone tz) {
        Calendar cal = Calendar.getInstance(tz);
        cal.setTime(d);
        return cal.get(Calendar.DAY_OF_MONTH) + " " + MONTHS[cal.get(Calendar.MONTH)] + " " + cal.get(Calendar.YEAR);
    }

    private static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '&': b.append("&amp;"); break;
                case '<': b.append("&lt;"); break;
                case '>': b.append("&gt;"); break;
                case '"': b.append("&quot;"); break;
                default: b.append(ch);
            }
        }
        return b.toString();
    }

    /** The printable recovery sheet (HTML), dated today in the device's time zone. */
    public static String recoverySheet(Map<String, Object> c) { return recoverySheet(c, dutchLongDate(new Date(), TimeZone.getDefault())); }

    /** The recovery sheet with an explicit date text (byte-identical to the console's HTML). */
    public static String recoverySheet(Map<String, Object> c, String dateText) {
        List<String> g = keyGroups(c);
        String check = keyCheck(c);
        List<Map<String, Object>> stores = ClusterConfig.stores(c);
        Map<String, Object> store = stores.isEmpty() ? null : stores.get(0);
        String domain = c.get("domain") != null ? Json.jsString(c.get("domain")) : null;
        StringBuilder keys = new StringBuilder();
        for (int i = 0; i < g.size(); i++) keys.append("<div>").append(g.get(i)).append("<small>groep ").append(i + 1).append("</small></div>");
        String storeText = "";
        if (store != null) {
            Object b = store.get("bucket") != null ? store.get("bucket") : store.get("dir") != null ? store.get("dir") : "";
            storeText = " (bijvoorbeeld <b>" + esc(Json.jsString(store.get("name"))) + "</b>, bucket <b>" + esc(Json.jsString(b)) + "</b>)";
        }
        return "<!doctype html><html lang=\"nl\"><head><meta charset=\"utf-8\"><title>Herstelblad " + esc(domain != null ? domain : "") + "</title>\n"
                + "<link rel=\"stylesheet\" href=\"/shared/tokens.css\"><style>\n"
                + "body{font-family:var(--font);color:#1d2a2f;background:#fff;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.5}\n"
                + "h1{font-size:28px;margin:0 0 4px}.sub{color:#5b6b70;margin:0 0 28px}\n"
                + ".key{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.key div{border:1.5px solid #1d2a2f;border-radius:8px;padding:12px 8px;text-align:center;font-size:22px;letter-spacing:.06em;font-variant-numeric:tabular-nums}\n"
                + ".key small{display:block;font-size:11px;color:#5b6b70;letter-spacing:0}\n"
                + "ol li{margin:6px 0}.box{border-left:4px solid #3f6f4a;background:#eef3ef;padding:12px 16px;border-radius:6px;margin:22px 0}\n"
                + "@media print{button{display:none}body{margin:0 auto}}\n"
                + "</style></head><body>\n"
                + "<h1>Herstelblad</h1><p class=\"sub\">Eigen Cloud van " + esc(domain != null ? domain : Json.jsString(c.get("cluster"))) + " · gemaakt op " + dateText + "</p>\n"
                + "<p>Met deze sleutel en de toegang tot één opslagplaats krijg je alles terug: mail, agenda, foto's en de instellingen van je cloud. Zonder deze sleutel kan niemand je back-ups lezen — ook jij niet.</p>\n"
                + "<div class=\"key\">" + keys + "</div>\n"
                + "<p>Controlegetal: <b>" + check + "</b></p>\n"
                + "<div class=\"box\"><b>Bewaar dit blad op twee plekken</b>, bijvoorbeeld thuis in een map met belangrijke papieren en bij iemand die je vertrouwt. Niet als foto op je telefoon.</div>\n"
                + "<h2>Zo haal je alles terug</h2>\n"
                + "<ol><li>Installeer de Eigen Cloud-beheerconsole op een computer en start hem.</li>\n"
                + "<li>Kies <b>Ik heb al een Eigen Cloud</b>.</li>\n"
                + "<li>Vul deze sleutel in en de gegevens van één opslag" + storeText + ".</li>\n"
                + "<li>Kies <b>Wakker maken</b>. Binnen een kwartier draait je cloud weer.</li></ol>\n"
                + "<button onclick=\"print()\">Afdrukken</button></body></html>";
    }

    // ───────── Checklist ─────────

    /** The launch checklist: [{id, label, ok, required}]. */
    public static List<Map<String, Object>> checklist(Map<String, Object> c) {
        Map<String, Object> con = console(c);
        List<Map<String, Object>> stores = ClusterConfig.stores(c);
        Set<Object> countries = new HashSet<>();
        boolean replica = false, backup = false;
        for (Map<String, Object> s : stores) {
            countries.add(s.get("country"));
            if ("replica".equals(s.get("purpose"))) replica = true;
            if ("backup".equals(s.get("purpose"))) backup = true;
        }
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(Json.obj("id", "sleutel", "label", "Herstelsleutel bewaard", "ok", con.get("keyConfirmed"), "required", true));
        out.add(Json.obj("id", "opslag", "label", "Opslag gekoppeld", "ok", replica, "required", true));
        out.add(Json.obj("id", "opslag-spreiding", "label", "Back-up op een tweede plek, in een ander land", "ok", stores.size() >= 2 && countries.size() >= 2 && backup, "required", false));
        out.add(Json.obj("id", "servers", "label", "Serverplekken gekozen", "ok", !Json.listAt(c, "policy", "placement").isEmpty(), "required", true));
        out.add(Json.obj("id", "dns", "label", "Domein gekoppeld", "ok", Json.truthy(con.get("dnsMode")), "required", false));
        out.add(Json.obj("id", "mail", "label", "Uitgaande mail via een relay", "ok", Json.truthy(con.get("mailRelay")), "required", false));
        out.add(Json.obj("id", "meldingen", "label", "Meldadres buiten je eigen domein", "ok", Json.truthy(con.get("alertEmail")), "required", false));
        return out;
    }

    /** null when ready to launch, otherwise "Nog niet klaar: …" (as POST /api/launch answers). */
    public static String launchBlocker(Map<String, Object> c) {
        List<String> missing = new ArrayList<>();
        for (Map<String, Object> x : checklist(c)) {
            if (Boolean.TRUE.equals(x.get("required")) && !Json.truthy(x.get("ok"))) missing.add(((String) x.get("label")).toLowerCase(java.util.Locale.ROOT));
        }
        return missing.isEmpty() ? null : "Nog niet klaar: " + String.join(", ", missing);
    }

    // ───────── Stores ─────────

    /** Outcome of {@link #addStore}. */
    public static final class StoreSetup {
        public final boolean ok;
        public final List<Admin.StepResult> steps;
        public final String name;

        StoreSetup(boolean ok, List<Admin.StepResult> steps, String name) {
            this.ok = ok;
            this.steps = steps;
            this.name = name;
        }
    }

    /**
     * POST /api/stores: builds the store config from a catalog offer, tests and prepares it, and adds it to
     * the config when it works. Empty access/secret keys reuse those of an existing store with the same name.
     * {@code purpose}: "replica" or "backup". Throws {@link IllegalArgumentException} for missing input.
     */
    public static StoreSetup addStore(Map<String, Object> c, Catalog catalog, String offerId, String regionId, String endpoint, String accessKey, String secretKey, String bucket, String purpose) {
        Map<String, Object> offer = catalog.storeOffer(offerId == null ? "" : offerId);
        Map<String, Object> region = null;
        if (offer != null) for (Object r : Json.listAt(offer, "regions")) if (regionId != null && regionId.equals(Json.str(r, "id"))) region = Json.asMap(r);
        if (offer == null || region == null) throw new IllegalArgumentException("Kies een aanbieder en locatie");
        boolean isBackup = "backup".equals(purpose);
        String name = offerId + "-" + regionId + (isBackup ? "-backup" : "");
        Map<String, Object> existing = null;
        for (Map<String, Object> s : ClusterConfig.stores(c)) if (name.equals(s.get("name"))) existing = s;
        String ep = Json.truthy(offer.get("customEndpoint")) ? endpoint : Json.str(region, "endpoint");
        if (ep == null || !ep.matches("^https?://[\\s\\S]*")) throw new IllegalArgumentException("Vul de endpoint-URL in (begint met https://)");
        String ak = accessKey != null && !accessKey.isEmpty() ? accessKey : existing != null ? Json.str(existing, "accessKey") : null;
        String sk = secretKey != null && !secretKey.isEmpty() ? secretKey : existing != null ? Json.str(existing, "secretKey") : null;
        Map<String, Object> store = Json.obj("name", name, "type", "s3", "purpose", purpose, "country", region.get("country"), "endpoint", ep,
                "region", "eigen".equals(regionId) ? "us-east-1" : regionId,
                "bucket", bucket != null && !bucket.isEmpty() ? bucket : Json.jsString(c.get("cluster")) + "-" + (isBackup ? "backup" : "data") + "-" + Bytes.hex(Bytes.random(3)));
        if (ak != null) store.put("accessKey", ak);
        if (sk != null) store.put("secretKey", sk);
        if (ak == null || ak.isEmpty() || sk == null || sk.isEmpty()) throw new IllegalArgumentException("Vul de toegangssleutel en geheime sleutel in");
        List<Admin.StepResult> steps = Admin.prepareStore(store);
        boolean ok = Admin.storeStepsOk(steps);
        if (ok) {
            List<Object> next = new ArrayList<>();
            for (Map<String, Object> s : ClusterConfig.stores(c)) if (!name.equals(s.get("name"))) next.add(s);
            next.add(store);
            c.put("stores", next);
        }
        return new StoreSetup(ok, steps, name);
    }

    /** DELETE /api/stores/:name. */
    public static void removeStore(Map<String, Object> c, String name) {
        List<Object> next = new ArrayList<>();
        for (Map<String, Object> s : ClusterConfig.stores(c)) if (!name.equals(s.get("name"))) next.add(s);
        c.put("stores", next);
    }

    // ───────── Providers ─────────

    /** Per-region result of {@link #connectProvider}: sizes picked, or an error. */
    public static final class RegionSizes {
        public final String region;
        public final Catalog.SizeOption data, witness;
        public final String error;

        RegionSizes(String region, Catalog.SizeOption data, Catalog.SizeOption witness, String error) {
            this.region = region;
            this.data = data;
            this.witness = witness;
            this.error = error;
        }
    }

    /**
     * POST /api/providers: merges the fields (values starting with "••" are masked and ignored), checks the
     * login by listing servers, fetches sizes per region and stores providers[id] and console.catalog[id].
     * Throws {@link IOException} "Inloggen bij … lukt niet: …" when the login fails.
     */
    public static List<RegionSizes> connectProvider(Map<String, Object> c, Catalog catalog, String id, Map<String, String> fields) throws IOException {
        Map<String, Object> offer = catalog.serverOffer(id == null ? "" : id);
        if (offer == null) throw new IllegalArgumentException("Onbekende aanbieder");
        Map<String, Object> providers = Json.map(c, "providers");
        if (providers == null) { providers = Json.obj(); c.put("providers", providers); }
        Map<String, Object> f = Json.obj();
        Map<String, Object> old = Json.map(providers, id);
        if (old != null) f.putAll(old);
        if (fields != null) for (Map.Entry<String, String> e : fields.entrySet()) {
            String v = e.getValue();
            if (v != null && !v.isEmpty() && !v.startsWith("••")) f.put(e.getKey(), v.trim());
        }
        try {
            Providers.make(id, f).list(Json.jsString(c.get("cluster")));
        } catch (IOException | RuntimeException e) {
            String m = String.valueOf(e.getMessage()).replaceFirst("https?://\\S+", "");
            throw new IOException("Inloggen bij " + Json.str(offer, "name") + " lukt niet: " + Bytes.head(m, 160), e);
        }
        List<RegionSizes> regions = new ArrayList<>();
        Map<String, Object> cat = Json.obj();
        for (Catalog.RegionInfo r : catalog.serverRegions(id)) {
            try {
                List<Catalog.SizeOption> sizes = Catalog.fetchSizes(id, f, r.id);
                Catalog.SizeOption d = Catalog.pickSize(sizes, "data"), w = Catalog.pickSize(sizes, "witness");
                regions.add(new RegionSizes(r.id, d, w, null));
                if (d != null) {
                    Map<String, Object> entry = Json.obj("data", d.toJson());
                    if (w != null) entry.put("witness", w.toJson());
                    cat.put(r.id, entry);
                }
            } catch (IOException | RuntimeException e) {
                regions.add(new RegionSizes(r.id, null, null, e.getMessage()));
            }
        }
        providers.put(id, f);
        Map<String, Object> con = console(c);
        Map<String, Object> all = Json.map(con, "catalog");
        if (all == null) { all = Json.obj(); con.put("catalog", all); }
        all.put(id, cat);
        return regions;
    }

    /** DELETE /api/providers/:id. */
    public static void removeProvider(Map<String, Object> c, String id) {
        Map<String, Object> p = Json.map(c, "providers");
        if (p != null) p.remove(id);
        Map<String, Object> cat = Json.map(c, "console", "catalog");
        if (cat != null) cat.remove(id);
    }

    // ───────── Presets ─────────

    /** GET /api/presets. */
    public static List<Catalog.Preset> presets(Map<String, Object> c, Catalog catalog) {
        return Catalog.buildPresets(catalog.available(Json.map(c, "console", "catalog")));
    }

    /** POST /api/presets/choose: sets policy.placement (with reserves) and console.preset. */
    public static void choosePreset(Map<String, Object> c, Catalog catalog, String presetId) {
        List<Object> placement = Catalog.placementFor(presetId, catalog.available(Json.map(c, "console", "catalog")));
        Map<String, Object> pol = Json.map(c, "policy");
        if (pol == null) { pol = ClusterConfig.defaultPolicy(); c.put("policy", pol); }
        pol.put("placement", placement);
        console(c).put("preset", presetId);
    }

    // ───────── Launch and dashboard ─────────

    /** First data placement for a launch (null when none). */
    public static Admin.FirstNode firstPlacement(Map<String, Object> c) {
        for (Object p : Json.listAt(c, "policy", "placement")) {
            if (!"witness".equals(Json.str(p, "kind"))) {
                Admin.FirstNode f = new Admin.FirstNode(Json.str(p, "provider"), Json.str(p, "region"), Json.str(p, "size"));
                f.country = Json.str(p, "country");
                return f;
            }
        }
        return null;
    }

    /** Where to wake a sleeping cluster: the manifest's first data topology entry, else the first placement. */
    public static Admin.FirstNode wakeTarget(Map<String, Object> c, Map<String, Object> manifest) {
        for (Object t : Json.listAt(manifest, "topology")) {
            if ("data".equals(Json.str(t, "kind"))) return new Admin.FirstNode(Json.str(t, "provider"), Json.str(t, "region"), Json.str(t, "size"));
        }
        return firstPlacement(c);
    }

    /** Term to wake with: manifest.term + 1 (1 without manifest). */
    public static long wakeTerm(Map<String, Object> manifest) {
        Number t = Json.num(manifest, "term");
        return (t == null ? 0 : t.longValue()) + 1;
    }

    /** initialSettings for the first launch of a new cluster (mail_from, password_hash, alert_email, mail_relay, spf_extra). */
    public static Map<String, Object> initialSettings(Map<String, Object> c) {
        Map<String, Object> con = console(c);
        Map<String, Object> s = Json.obj("mail_from", Json.path(c, "appEnv", "MAIL_FROM"));
        if (Json.truthy(con.get("appPasswordHash"))) s.put("password_hash", con.get("appPasswordHash"));
        if (Json.truthy(con.get("alertEmail"))) s.put("alert_email", con.get("alertEmail"));
        if (Json.truthy(con.get("mailRelay"))) s.put("mail_relay", con.get("mailRelay"));
        if (Json.truthy(con.get("spfExtra"))) s.put("spf_extra", con.get("spfExtra"));
        return s;
    }

    /** Marks a successful first launch on the config (console.firstLaunch, done, step "klaar"). */
    public static void markLaunched(Map<String, Object> c, Admin.FirstNode first, Admin.Provisioned r) {
        Map<String, Object> fl = Json.obj("at", System.currentTimeMillis(), "nodeId", r.nodeId, "provider", first.provider, "region", first.region, "clusterUrl", r.clusterUrl);
        if (r.info.apiUrl != null) fl.put("apiUrl", r.info.apiUrl);
        Map<String, Object> con = console(c);
        con.put("firstLaunch", fl);
        con.put("done", true);
        con.put("step", "klaar");
    }

    /** https://cloud.&lt;domain&gt; (null without domain). */
    public static String appUrl(Map<String, Object> c) {
        return Json.truthy(c.get("domain")) ? "https://cloud." + Json.jsString(c.get("domain")) : null;
    }

    /** Extra URLs to find the cluster with (the first launched node). */
    public static List<String> knownUrls(Map<String, Object> c) {
        List<String> l = new ArrayList<>();
        String u = Json.str(c, "console", "firstLaunch", "clusterUrl");
        if (u != null && !u.isEmpty()) l.add(u);
        return l;
    }

    /** Dashboard state as GET /api/status: starting, falling-asleep, awake, asleep, unreachable or new. */
    public static String state(Admin.Status st, boolean launching) {
        if (launching) return "starting";
        if (st.live != null && Json.truthy(st.live.get("leader"))) return Json.truthy(st.live.get("sleeping")) ? "falling-asleep" : "awake";
        if (st.manifest != null && "asleep".equals(st.manifest.get("state"))) return "asleep";
        return st.manifest != null ? "unreachable" : "new";
    }

    /** Allowed keys for a policy change (PUT /api/policy) — the rest is ignored. */
    public static Map<String, Object> policyChange(Map<String, Object> c, Map<String, Object> change) {
        Map<String, Object> pol = Json.obj();
        for (Map.Entry<String, Object> e : change.entrySet()) {
            String k = e.getKey();
            if (k.equals("minDataNodes") || k.equals("witnesses") || k.equals("autoHeal") || k.equals("autoReplaceAfterMin")) pol.put(k, e.getValue());
        }
        Map<String, Object> cur = Json.map(c, "policy");
        if (cur != null) cur.putAll(pol);
        return pol;
    }
}
