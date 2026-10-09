package nl.eigencloud.core;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Port of src/console/catalog.ts. The offer data itself (STORE_OFFERS / SERVER_OFFERS) is not duplicated:
 * it is exported by scripts/export-catalog.ts to catalog.json ({stores, servers}) and loaded here.
 */
public final class Catalog {
    private final List<Map<String, Object>> stores = new ArrayList<>();
    private final List<Map<String, Object>> servers = new ArrayList<>();

    /** Parses catalog.json text ({stores: StoreOffer[], servers: ServerOffer[]}). */
    public Catalog(String json) {
        Map<String, Object> root = Json.parseObject(json);
        for (Object o : Json.listAt(root, "stores")) stores.add(Json.asMap(o));
        for (Object o : Json.listAt(root, "servers")) servers.add(Json.asMap(o));
    }

    /** Loads catalog.json from a stream (e.g. Android assets). */
    public static Catalog load(InputStream in) throws IOException { return new Catalog(Bytes.utf8(Bytes.readAll(in))); }

    /** StoreOffer objects: {id, name, owner, regions:[{id,label,country,endpoint}], customEndpoint?, help, signupUrl}. */
    public List<Map<String, Object>> storeOffers() { return stores; }

    /** ServerOffer objects: {id, name, owner, home, regions:[{id,label,country,city}], fields:[{key,label,secret?,help?}], signupUrl}. */
    public List<Map<String, Object>> serverOffers() { return servers; }

    public Map<String, Object> storeOffer(String id) { return find(stores, id); }

    public Map<String, Object> serverOffer(String id) { return find(servers, id); }

    private static Map<String, Object> find(List<Map<String, Object>> l, String id) {
        for (Map<String, Object> m : l) if (id.equals(m.get("id"))) return m;
        return null;
    }

    /** Regions of a server offer as typed objects. */
    public List<RegionInfo> serverRegions(String offerId) {
        List<RegionInfo> out = new ArrayList<>();
        Map<String, Object> o = serverOffer(offerId);
        if (o != null) for (Object r : Json.listAt(o, "regions")) out.add(RegionInfo.fromJson(Json.asMap(r)));
        return out;
    }

    // ───────── Types ─────────

    /** A server region: {id, label, country, city}. */
    public static final class RegionInfo {
        public final String id, label, country, city;

        public RegionInfo(String id, String label, String country, String city) {
            this.id = id;
            this.label = label;
            this.country = country;
            this.city = city;
        }

        public static RegionInfo fromJson(Map<String, Object> m) {
            return new RegionInfo(Json.str(m, "id"), Json.str(m, "label"), Json.str(m, "country"), Json.str(m, "city"));
        }

        public Map<String, Object> toJson() { return Json.obj("id", id, "label", label, "country", country, "city", city); }
    }

    /** A server size: {size, label, ramGb, cpus, monthly|null}. */
    public static final class SizeOption {
        public final String size, label;
        public final double ramGb;
        public final double cpus;
        /** Monthly price in euro, or null when unknown. */
        public final Double monthly;

        public SizeOption(String size, String label, double ramGb, double cpus, Double monthly) {
            this.size = size;
            this.label = label;
            this.ramGb = ramGb;
            this.cpus = cpus;
            this.monthly = monthly;
        }

        public static SizeOption fromJson(Map<String, Object> m) {
            if (m == null) return null;
            Number mo = Json.num(m, "monthly");
            return new SizeOption(Json.str(m, "size"), Json.str(m, "label"), Json.num(m, "ramGb").doubleValue(), Json.num(m, "cpus").doubleValue(), mo == null ? null : mo.doubleValue());
        }

        public Map<String, Object> toJson() { return Json.obj("size", size, "label", label, "ramGb", ramGb, "cpus", cpus, "monthly", monthly); }
    }

    /** A provider region with its chosen sizes (input for {@link #buildPresets}). */
    public static final class Available {
        public final String provider;
        public final RegionInfo region;
        public final SizeOption data, witness;

        public Available(String provider, RegionInfo region, SizeOption data, SizeOption witness) {
            this.provider = provider;
            this.region = region;
            this.data = data;
            this.witness = witness;
        }
    }

    /** A placement proposal. */
    public static final class Preset {
        public final String id, title, description;
        public final List<Object> placement;
        public final Double monthly;
        public final List<String> countries;
        /** What is missing to make this preset possible (null when it is possible). */
        public final String missing;

        Preset(String id, String title, String description, List<Object> placement, Double monthly, List<String> countries, String missing) {
            this.id = id;
            this.title = title;
            this.description = description;
            this.placement = placement;
            this.monthly = monthly;
            this.countries = countries;
            this.missing = missing;
        }

        public Map<String, Object> toJson() {
            Map<String, Object> m = Json.obj("id", id, "title", title, "description", description, "placement", placement, "monthly", monthly, "countries", new ArrayList<Object>(countries));
            if (missing != null) m.put("missing", missing);
            return m;
        }
    }

    // ───────── Live sizes ─────────

    private static Object get(String url, Map<String, String> headers) throws IOException {
        Http.Response r = Http.request("GET", url, headers, null, 15_000);
        if (!r.ok()) throw new HttpException(r.status + " " + Bytes.head(r.text(), 200), r.status, r.text());
        return Json.parse(r.text());
    }

    private static final Pattern SCW_TYPES = Pattern.compile("^(DEV1|PLAY2|PRO2|GP1|STARDUST|POP2)", Pattern.CASE_INSENSITIVE);
    private static final Pattern UPC_PLAN = Pattern.compile("^\\d+xCPU-\\d+GB$");

    private static double d(Object v) {
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v == null) return Double.NaN;
        String s = v.toString().trim();
        return s.isEmpty() ? 0 : Double.parseDouble(s);
    }

    private static double jsRound(double x) { return Math.floor(x + 0.5); }

    /** Live sizes and prices from the provider API (base URLs from {@link Endpoints}). */
    public static List<SizeOption> fetchSizes(String provider, Map<String, Object> cfg, String region) throws IOException {
        List<SizeOption> out = new ArrayList<>();
        if ("hetzner".equals(provider)) {
            Object j = get(Endpoints.HETZNER + "/server_types?per_page=50", Http.headers("authorization", "Bearer " + Json.jsString(cfg.get("token"))));
            for (Object t : Json.listAt(j, "server_types")) {
                if (Json.truthy(Json.path(t, "deprecation")) || !"x86".equals(Json.str(t, "architecture"))) continue;
                Object price = null;
                for (Object p : Json.listAt(t, "prices")) if (region.equals(Json.str(p, "location"))) { price = p; break; }
                if (price == null) continue;
                Object mem = Json.path(t, "memory"), cores = Json.path(t, "cores");
                out.add(new SizeOption(Json.str(t, "name"), Json.jsString(cores) + " vCPU, " + Json.jsString(mem) + " GB", d(mem), d(cores), d(Json.path(price, "price_monthly", "gross"))));
            }
            sortBy(out, s -> s.monthly != null ? s.monthly : 0);
            return out;
        }
        if ("scaleway".equals(provider)) {
            Object j = get(Endpoints.SCALEWAY + "/instance/v1/zones/" + region + "/products/servers?per_page=100", Http.headers("x-auth-token", Json.jsString(cfg.get("secretKey"))));
            Map<String, Object> srv = Json.map(j, "servers");
            if (srv == null) throw new IOException("Scaleway: onverwacht antwoord");
            for (Map.Entry<String, Object> e : srv.entrySet()) {
                Object s = e.getValue();
                if (!SCW_TYPES.matcher(e.getKey()).find() || !"x86_64".equals(Json.str(s, "arch"))) continue;
                double ram = jsRound(d(Json.path(s, "ram")) / Math.pow(1024, 3));
                Object ncpus = Json.path(s, "ncpus");
                Object mp = Json.path(s, "monthly_price");
                Double monthly;
                if (mp != null) monthly = d(mp);
                else {
                    Object hp = Json.path(s, "hourly_price");
                    monthly = Json.truthy(hp) ? jsRound(d(hp) * 730 * 100) / 100 : null;
                }
                out.add(new SizeOption(e.getKey(), Json.jsString(ncpus) + " vCPU, " + Json.numberToString(ram) + " GB", ram, d(ncpus), monthly));
            }
            sortBy(out, s -> s.monthly != null ? s.monthly : 999);
            return out;
        }
        if ("upcloud".equals(provider)) {
            Object j = get(Endpoints.UPCLOUD + "/plan", Http.headers("authorization", "Bearer " + Json.jsString(cfg.get("token"))));
            for (Object p : Json.listAt(j, "plans", "plan")) {
                String name = Json.str(p, "name");
                if (name == null || !UPC_PLAN.matcher(name).find()) continue;
                double ram = d(Json.path(p, "memory_amount")) / 1024;
                Object cores = Json.path(p, "core_number");
                out.add(new SizeOption(name, Json.jsString(cores) + " vCPU, " + Json.numberToString(ram) + " GB", ram, d(cores), null));
            }
            Collections.sort(out, new Comparator<SizeOption>() {
                @Override public int compare(SizeOption a, SizeOption b) {
                    int c = Double.compare(a.ramGb, b.ramGb);
                    return c != 0 ? c : Double.compare(a.cpus, b.cpus);
                }
            });
            return out;
        }
        if ("local".equals(provider)) out.add(new SizeOption("s", "proces op deze computer", 4, 1, 0.0));
        return out;
    }

    private interface Key { double of(SizeOption s); }

    private static void sortBy(List<SizeOption> l, final Key k) {
        Collections.sort(l, new Comparator<SizeOption>() {
            @Override public int compare(SizeOption a, SizeOption b) { return Double.compare(k.of(a), k.of(b)); }
        });
    }

    /** Smallest suitable size: data ≥ 2 GB memory, witness as small as possible (≥ 0.5 GB). Null when none fits. */
    public static SizeOption pickSize(List<SizeOption> sizes, String kind) {
        List<SizeOption> ok = new ArrayList<>();
        for (SizeOption s : sizes) if ("data".equals(kind) ? s.ramGb >= 2 : s.ramGb >= 0.5) ok.add(s);
        sortBy(ok, s -> s.monthly != null ? s.monthly : s.ramGb * 3);
        return ok.isEmpty() ? null : ok.get(0);
    }

    // ───────── Presets ─────────

    private static Available distinct(List<Available> list, List<Available> avoid) {
        for (Available a : list) {
            boolean clash = false;
            for (Available x : avoid) if (x.provider.equals(a.provider)) { clash = true; break; }
            if (!clash) return a;
        }
        for (Available a : list) {
            boolean clash = false;
            for (Available x : avoid) if (x.provider.equals(a.provider) && x.region.id.equals(a.region.id)) { clash = true; break; }
            if (!clash) return a;
        }
        return null;
    }

    private static List<Available> nonNull(Available... xs) {
        List<Available> l = new ArrayList<>();
        for (Available x : xs) if (x != null) l.add(x);
        return l;
    }

    private static Available first(List<Available> l) { return l.isEmpty() ? null : l.get(0); }

    private static Preset mk(String id, String title, String description, Available d1, Available d2, Available w, String need) {
        if (d1 == null || d2 == null || w == null || d1.data == null || d2.data == null || w.witness == null) {
            return new Preset(id, title, description, new ArrayList<Object>(), null, new ArrayList<String>(), need);
        }
        List<Object> placement = Json.list(
                ClusterConfig.placement(d1.provider, d1.region.id, d1.data.size, d1.region.country, "data"),
                ClusterConfig.placement(d2.provider, d2.region.id, d2.data.size, d2.region.country, "data"),
                ClusterConfig.placement(w.provider, w.region.id, w.witness.size, w.region.country, "witness"));
        Double[] prices = {d1.data.monthly, d2.data.monthly, w.witness.monthly};
        Double monthly = null;
        if (prices[0] != null && prices[1] != null && prices[2] != null) {
            double sum = 0;
            for (Double p : prices) sum += p;
            monthly = jsRound(sum * 100) / 100;
        }
        Set<String> countries = new LinkedHashSet<>();
        for (Object p : placement) countries.add(Json.str(p, "country"));
        return new Preset(id, title, description, placement, monthly, new ArrayList<>(countries), null);
    }

    /** Three choices based on the providers the user has connected (same results as the TS version). */
    public static List<Preset> buildPresets(List<Available> available) {
        List<Available> nl = new ArrayList<>(), neighbours = new ArrayList<>(), far = new ArrayList<>();
        for (Available a : available) {
            String c = a.region.country;
            if ("NL".equals(c)) nl.add(a);
            if ("DE".equals(c) || "BE".equals(c)) neighbours.add(a);
            if (!"NL".equals(c) && !"DE".equals(c) && !"BE".equals(c)) far.add(a);
        }
        Available nl1 = first(nl);
        Available nl2 = distinct(nl, nonNull(nl1));
        Available nlw = distinct(nl, nonNull(nl1, nl2));
        if (nlw == null) for (Available a : nl) if (a != nl1 && a != nl2) { nlw = a; break; }

        Available nb = distinct(neighbours, nonNull(nl1));
        if (nb == null) nb = first(neighbours);
        Available w2 = distinct(far, nonNull(nl1, nb));
        if (w2 == null) w2 = distinct(neighbours, nonNull(nl1, nb));
        if (w2 == null) w2 = nlw;
        Available w3 = distinct(far, nonNull(nl1, nb));
        if (w3 == null) w3 = first(far);

        List<Preset> out = new ArrayList<>();
        out.add(mk("nl", "Alles in Nederland", "Beide data-servers en de witness in Amsterdam, verdeeld over aparte datacenters. Kortste afstand, geen data over de grens.", nl1, nl2, nlw, "Koppel een aanbieder met Amsterdam (Scaleway of UpCloud)"));
        out.add(mk("buren", "Nederland en Duitsland", "Data in Amsterdam en Duitsland, de witness ergens anders. Valt een land of aanbieder weg, dan draait de rest door.", nl1, nb, w2, "Koppel een aanbieder in Nederland én een in Duitsland"));
        out.add(mk("europa", "Spreid over Europa", "Drie landen en zo veel mogelijk verschillende aanbieders. Het meest bestand tegen grote storingen.", nl1 != null ? nl1 : first(neighbours), nb, w3, "Koppel aanbieders in minstens drie landen (bijv. Scaleway + Hetzner)"));
        return out;
    }

    /**
     * The "available" list as the console builds it from {@code console.catalog}
     * ({providerId: {regionId: {data?, witness?}}}), in offer and region order.
     */
    public List<Available> available(Map<String, Object> consoleCatalog) {
        List<Available> out = new ArrayList<>();
        if (consoleCatalog == null) return out;
        for (Map<String, Object> o : servers) {
            String pid = Json.str(o, "id");
            for (Object r : Json.listAt(o, "regions")) {
                RegionInfo ri = RegionInfo.fromJson(Json.asMap(r));
                Map<String, Object> entry = Json.map(consoleCatalog, pid, ri.id);
                if (entry == null) continue;
                out.add(new Available(pid, ri, SizeOption.fromJson(Json.map(entry, "data")), SizeOption.fromJson(Json.map(entry, "witness"))));
            }
        }
        return out;
    }

    /**
     * Placement for a chosen preset plus reserve places for self-healing (lower preference), de-duplicated by
     * kind/provider/region — as POST /api/presets/choose does. Throws with the preset's "missing" text.
     */
    public static List<Object> placementFor(String presetId, List<Available> available) {
        Preset p = null;
        for (Preset x : buildPresets(available)) if (x.id.equals(presetId)) p = x;
        if (p == null || p.placement.isEmpty()) throw new IllegalArgumentException(p != null && p.missing != null ? p.missing : "Onbekende keuze");
        List<Object> all = new ArrayList<>(p.placement);
        for (Available a : available) {
            if (a.data != null) all.add(ClusterConfig.placement(a.provider, a.region.id, a.data.size, a.region.country, "data"));
            if (a.witness != null) all.add(ClusterConfig.placement(a.provider, a.region.id, a.witness.size, a.region.country, "witness"));
        }
        List<Object> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < all.size(); i++) {
            Object x = all.get(i);
            boolean reserve = i >= p.placement.size();
            if (reserve && "nl".equals(presetId) && !"NL".equals(Json.str(x, "country"))) continue;
            String k = Json.str(x, "kind") + "/" + Json.str(x, "provider") + "/" + Json.str(x, "region");
            if (seen.add(k)) out.add(x);
        }
        return out;
    }
}
