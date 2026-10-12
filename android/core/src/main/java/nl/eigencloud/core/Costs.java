package nl.eigencloud.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Kosten en budget, like src/cluster/costs.ts (the rules) and src/console/costs.ts (GET /api/costs, POST
 * /api/costs/budget). Estimated monthly cost per provider and in total: servers (price the provider gave at create
 * time, else the catalog price of that size; nothing while asleep) plus storage (bytes in each bucket × the provider's
 * list price per GB per month from catalog.json, null = unknown). Egress is not counted. Same JSON as TS (golden test).
 */
public final class Costs {
    private Costs() {}

    /** Math.round(n * 100) / 100 */
    static double r2(double n) { return Math.round(n * 100) / 100.0; }

    /** serverPrices: "provider/region/size" → monthly price from console.catalog (known prices only). */
    public static Map<String, Object> serverPrices(Map<String, Object> catalog) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (catalog == null) return out;
        for (Map.Entry<String, Object> p : catalog.entrySet()) {
            Map<String, Object> regions = Json.asMap(p.getValue());
            if (regions == null) continue;
            for (Map.Entry<String, Object> r : regions.entrySet()) {
                Map<String, Object> picks = Json.asMap(r.getValue());
                for (String kind : new String[] {"data", "witness"}) {
                    Map<String, Object> s = Json.map(picks, kind);
                    String size = Json.str(s, "size");
                    Object monthly = s == null ? null : s.get("monthly");
                    if (size != null && !size.isEmpty() && monthly instanceof Number) out.put(p.getKey() + "/" + r.getKey() + "/" + size, monthly);
                }
            }
        }
        return out;
    }

    /** serverPrice: monthly_cost from the provider, else the catalog price, else null. */
    static Double serverPrice(Map<String, Object> prices, Map<String, Object> n) {
        Object mc = n.get("monthly_cost");
        if (mc instanceof Number) return ((Number) mc).doubleValue();
        Object p = prices.get(Json.str(n, "provider") + "/" + orEmpty(n.get("region")) + "/" + orEmpty(n.get("size")));
        return p instanceof Number ? ((Number) p).doubleValue() : null;
    }

    private static String orEmpty(Object v) { return v == null ? "" : Json.jsString(v); }

    /** storeOfferId: the provider of a store named "<provider>-<region>[-backup]" (longest match), or null. */
    public static String storeOfferId(String storeName, List<String> ids) {
        String best = null;
        for (String id : ids) if (storeName.startsWith(id + "-") && (best == null || id.length() > best.length())) best = id;
        return best;
    }

    private static final Pattern AMOUNT = Pattern.compile("^\\d+([.,]\\d+)?$");

    /** parseBudget: a positive amount rounded to cents, else null. */
    public static Double parseBudget(Object v) {
        double n;
        if (v instanceof Number) n = ((Number) v).doubleValue();
        else if (v instanceof String && AMOUNT.matcher(((String) v).trim()).matches()) n = Double.parseDouble(((String) v).trim().replace(",", "."));
        else return null;
        return !Double.isNaN(n) && !Double.isInfinite(n) && n > 0 ? r2(n) : null;
    }

    /** A server that costs money: provider, region, size, monthly_cost (as runningServers in src/console/costs.ts). */
    static final class Running {
        final boolean sleeping;
        final List<Map<String, Object>> nodes;

        Running(boolean sleeping, List<Map<String, Object>> nodes) {
            this.sleeping = sleeping;
            this.nodes = nodes;
        }
    }

    static Running runningServers(Map<String, Object> manifest, Map<String, Object> live) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (live != null && Json.truthy(live.get("leader"))) {
            for (Object o : Json.listAt(live, "nodes")) {
                Map<String, Object> n = Json.asMap(o);
                String status = Json.str(n, "status");
                if ("removed".equals(status) || "failed".equals(status) || "manual".equals(Json.str(n, "provider"))) continue;
                out.add(Json.obj("provider", n.get("provider"), "region", n.get("region"), "size", n.get("size"), "monthly_cost", n.get("monthly_cost")));
            }
            return new Running(false, out);
        }
        if (manifest != null && "asleep".equals(manifest.get("state"))) return new Running(true, out);
        for (Object o : Json.listAt(manifest, "topology")) {
            Map<String, Object> t = Json.asMap(o);
            if ("manual".equals(Json.str(t, "provider"))) continue;
            out.add(Json.obj("provider", t.get("provider"), "region", t.get("region"), "size", t.get("size"), "monthly_cost", null));
        }
        return new Running(false, out);
    }

    /** Provider name for the overview (the adapter name from catalog.json, else the id). */
    public interface Names { String of(String id); }

    private static final class Acc {
        Double servers = 0d, storage = 0d, bytes = 0d;
    }

    /** compute() from src/console/costs.ts: the costs for the config, the cluster status and measured bytes per store. */
    public static Map<String, Object> compute(Map<String, Object> c, Map<String, Object> manifest, Map<String, Object> live, Map<String, Object> bytes,
                                              List<Map<String, Object>> storeOffers, Names names) {
        Running run = runningServers(manifest, live);
        Map<String, Object> prices = serverPrices(Json.map(c, "console", "catalog"));
        List<String> ids = new ArrayList<>();
        for (Map<String, Object> o : storeOffers) ids.add(Json.str(o, "id"));
        Map<String, Acc> map = new LinkedHashMap<>();
        for (Map<String, Object> n : run.nodes) {
            Acc p = map.computeIfAbsent(Json.str(n, "provider"), k -> new Acc());
            Double m = serverPrice(prices, n);
            p.servers = m == null || p.servers == null ? null : p.servers + m;
        }
        for (Object o : Json.listAt(c, "stores")) {
            String name = Json.str(o, "name");
            String provider = storeOfferId(name, ids);
            Double price = null;
            for (Map<String, Object> so : storeOffers) {
                if (provider != null && provider.equals(Json.str(so, "id"))) {
                    Object pp = so.get("pricePerGbMonth");
                    price = pp instanceof Number ? ((Number) pp).doubleValue() : null;
                    break;
                }
            }
            Object bv = bytes == null ? null : bytes.get(name);
            Double b = bv instanceof Number ? ((Number) bv).doubleValue() : null;
            Acc p = map.computeIfAbsent(provider != null ? provider : name, k -> new Acc());
            p.bytes = b == null || p.bytes == null ? null : p.bytes + b;
            p.storage = b == null || price == null || p.storage == null ? null : p.storage + (b / 1e9) * price;
        }
        double total = 0;
        boolean complete = true;
        List<Object> providers = new ArrayList<>();
        for (Map.Entry<String, Acc> e : map.entrySet()) {
            Acc p = e.getValue();
            Double sv = p.servers == null ? null : r2(p.servers);
            Double st = p.storage == null ? null : r2(p.storage);
            if (sv == null || st == null) complete = false;
            double t = r2((sv == null ? 0 : sv) + (st == null ? 0 : st));
            total += t;
            providers.add(Json.obj("id", e.getKey(), "name", names.of(e.getKey()), "servers", sv, "storage", st, "bytes", p.bytes, "total", t, "source", "geschat"));
        }
        Double budget = parseBudget(Json.path(c, "console", "budget"));
        double tot = r2(total);
        return Json.obj("providers", providers, "total", tot, "complete", complete, "sleeping", run.sleeping, "budget", budget,
                "overBudget", budget != null && tot > budget);
    }

    // ───────── Opslaggebruik meten (hooguit eens per uur) ─────────

    private static final long MEASURE_MS = 3600_000L;
    private static final Map<String, long[]> measuredAt = new HashMap<>(); // name → {at}
    private static final Map<String, Long> measuredBytes = new HashMap<>(); // name → bytes (absent: unknown)

    /** Only for tests: forget measurements. */
    public static synchronized void forgetMeasurements() { measuredAt.clear(); measuredBytes.clear(); }

    private static void measure(Map<String, Object> c, boolean fresh) {
        List<Thread> threads = new ArrayList<>();
        for (Object o : Json.listAt(c, "stores")) {
            final Map<String, Object> s = Json.asMap(o);
            final String name = Json.str(s, "name");
            synchronized (Costs.class) {
                long[] at = measuredAt.get(name);
                if (at != null && !fresh && System.currentTimeMillis() - at[0] < MEASURE_MS) continue;
            }
            Thread t = new Thread(() -> {
                Long bytes;
                try {
                    long sum = 0;
                    for (ObjectStore.Entry e : Stores.make(s).list("")) sum += e.size;
                    bytes = sum;
                } catch (IOException | RuntimeException e) {
                    bytes = null;
                }
                synchronized (Costs.class) {
                    measuredAt.put(name, new long[] {System.currentTimeMillis()});
                    if (bytes != null) measuredBytes.put(name, bytes); else measuredBytes.remove(name);
                }
            }, "eigen-costs");
            t.setDaemon(true);
            t.start();
            threads.add(t);
        }
        for (Thread t : threads) {
            try { t.join(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    /** GET /api/costs: compute() with freshly measured (or cached) bytes, plus updatedAt (oldest measurement). */
    public static Map<String, Object> view(Map<String, Object> c, Map<String, Object> manifest, Map<String, Object> live, Catalog catalog, boolean fresh) {
        measure(c, fresh);
        Map<String, Object> bytes = Json.obj();
        long updated = Long.MAX_VALUE;
        boolean any = false;
        synchronized (Costs.class) {
            for (Object o : Json.listAt(c, "stores")) {
                String name = Json.str(o, "name");
                bytes.put(name, measuredBytes.get(name));
                long[] at = measuredAt.get(name);
                updated = Math.min(updated, at != null ? at[0] : System.currentTimeMillis());
                any = true;
            }
        }
        Map<String, Object> out = compute(c, manifest, live, bytes, catalog.storeOffers(), id -> {
            Map<String, Object> a = catalog.adapter(id);
            String n = Json.str(a, "name");
            return n != null ? n : id;
        });
        out.put("updatedAt", any ? updated : System.currentTimeMillis());
        return out;
    }

    /** POST /api/costs/budget: set the budget (euro per month); empty, 0 or null removes it. */
    public static Map<String, Object> setBudget(Map<String, Object> c, Object v) {
        Map<String, Object> con = Json.map(c, "console");
        if (v == null || "".equals(v) || "0".equals(v) || (v instanceof Number && ((Number) v).doubleValue() == 0)) {
            if (con != null) con.remove("budget");
            return Json.obj("ok", true, "budget", null);
        }
        Double b = parseBudget(v);
        if (b == null || b > 100000) throw new IllegalArgumentException("Vul een bedrag in euro per maand in, bijvoorbeeld 25");
        if (con != null) con.put("budget", b == Math.rint(b) ? (Object) (long) (double) b : (Object) b);
        return Json.obj("ok", true, "budget", b);
    }
}
