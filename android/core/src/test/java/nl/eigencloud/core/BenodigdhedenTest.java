package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * "Wat je nodig hebt" (Benodigdheden) tegen dezelfde nep-aanbieders als de TypeScript-test (scripts/android-nodig.ts,
 * NODIG_INFO): hetzelfde scenario draait eerst in Java en daarna in TypeScript (via het bedieningsadres), en elk
 * antwoord moet precies gelijk zijn (zonder tijdstempels). Plus losse controles van DoH, Openprovider-records,
 * telefoonnummers en DNSSEC-sleutels.
 */
public class BenodigdhedenTest {
    private static String control;

    private static Object post(String path, Object body) throws IOException {
        Http.Response r = Http.request("POST", control + path, Http.headers("content-type", "application/json"), Bytes.utf8(Json.stringify(body == null ? Json.obj() : body)), 60_000);
        if (!r.ok()) throw new IOException(path + ": " + r.status + " " + r.text());
        return Json.parse(r.text());
    }

    /** Tijdstempels en het willekeurige deSEC-wachtwoord tellen niet mee. */
    @SuppressWarnings("unchecked")
    static Object norm(Object v) {
        if (v instanceof Map) {
            Map<String, Object> m = Json.copy((Map<String, Object>) v);
            for (Iterator<String> it = m.keySet().iterator(); it.hasNext();) {
                String k = it.next();
                if (k.equals("at") || k.equals("checkAt") || k.equals("password")) it.remove();
            }
            for (Map.Entry<String, Object> e : m.entrySet()) e.setValue(norm(e.getValue()));
            return m;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<Object>) v) out.add(norm(x));
            return out;
        }
        return v;
    }

    static Map<String, Object> newConfig() {
        return Json.parseObject("{\"cluster\":\"eigen\",\"nodeId\":\"beheer\",\"kind\":\"data\",\"masterKey\":\"" + new String(new char[64]).replace('\0', '0')
                + "\",\"clusterPort\":7946,\"advertise\":{\"clusterUrl\":\"\"},\"seeds\":[],\"stores\":[],\"providers\":{},\"dns\":[],\"image\":{},\"appEnv\":{},\"policy\":{},"
                + "\"console\":{\"step\":\"sleutel\",\"done\":false,\"keyConfirmed\":true,\"alleenDienst\":true}}");
    }

    /** Eén stap: "fake" (nep-aanbieders veranderen), "server" (Dienst draait: in beide kluizen gelijk) of een functie. */
    static Object[] fake(Object... kv) { return new Object[] {"fake", Json.obj(kv)}; }

    static Object[] call(String fn, Map<String, Object> body) { return new Object[] {fn, body, false}; }

    static Object[] fresh(String fn) { return new Object[] {fn, Json.obj(), true}; }

    static Object[] quiet(String fn, Map<String, Object> body) { return new Object[] {fn, body, false, "quiet"}; }

    static List<Object[]> scenario() {
        Map<String, Object> houder = Json.obj("voornaam", "Rene", "achternaam", "van Es", "straat", "Blaak", "huisnummer", "10", "postcode", "3011 TA", "plaats", "Rotterdam", "telefoon", "+31 6 12345678");
        Map<String, Object> zonderTel = Json.copy(houder);
        zonderTel.put("telefoon", "");
        return Arrays.asList(
                fresh("benodigdheden"),
                quiet("saveBedrijf", Json.obj("name", "ESAPE", "email", "rene@esape.nl")),
                quiet("saveAdres", Json.obj("url", "dienst.esape.nl")),
                fake("op", "dns", "name", "esape.nl", "rec", Json.obj("NS", Json.list("ns0.transip.net", "ns1.transip.nl", "ns2.transip.eu"))),
                fresh("benodigdheden"),
                call("scaleway", Json.obj("accessKey", "SCW123", "secretKey", "x")),
                call("scaleway", Json.obj("accessKey", "SCWPERSONAL000000001", "secretKey", "11111111-2222-3333-4444-555555555555")),
                fake("op", "scwKey", "key", Json.obj("access_key", "SCWPERSONAL000000002", "secret_key", "22222222-2222-3333-4444-555555555555", "user_id", "00000000-1111-2222-3333-444444444444")),
                fake("op", "scwRules", "rules", Json.list(Json.obj("permission_set_names", Json.list("ProjectManager"), "organization_id", "0a000000-1111-2222-3333-444444444444"))),
                call("scaleway", Json.obj("accessKey", "scwpersonal000000002", "secretKey", " 22222222-2222-3333-4444-555555555555 ", "verwijderen", false)),
                call("mollie", Json.obj("key", "geen-sleutel")),
                call("mollie", Json.obj("key", "test_onbekend")),
                call("mollie", Json.obj("key", "test_abc123")),
                fake("op", "set", "path", "mollie.first", "value", Json.list("ideal", "creditcard")),
                fake("op", "set", "path", "mollie.recurring", "value", Json.list("directdebit")),
                call("mollie", Json.obj("key", "live_xyz789")),
                fake("op", "set", "path", "mollie.status", "value", "verified"),
                call("mollie", Json.obj()),
                call("desecRegister", Json.obj("captchaId", "cap-1", "solution", "fout")),
                call("desecRegister", Json.obj("captchaId", "cap-1", "solution", " abc ")),
                call("desecFinish", Json.obj()),
                call("benodigdheden", Json.obj()),
                fake("op", "desecConfirm"),
                call("desecFinish", Json.obj("adressen", true)),
                call("desecFinish", Json.obj("adressen", true)),
                quiet("saveDns", Json.obj("provider", "desec", "zone", "esape.nl")),
                call("domein", Json.obj()),
                fresh("benodigdheden"),
                call("openprovider", Json.obj()),
                call("openprovider", Json.obj("gebruiker", "vanes", "wachtwoord", "fout")),
                call("openprovider", Json.obj("gebruiker", "vanes", "wachtwoord", "geheim")),
                fake("op", "opDomain", "domain", Json.obj("id", 501, "domain", Json.obj("name", "esape", "extension", "nl"), "name_servers", Json.list(Json.obj("name", "ns0.transip.net")))),
                call("domein", Json.obj()),
                call("delegeren", Json.obj()),
                call("domein", Json.obj()),
                fresh("benodigdheden"),
                call("domein", Json.obj("voor", "adressen", "zone", "eigencloud.nl")),
                call("kopen", Json.obj("voor", "adressen", "zone", "eigencloud.nl", "prijs", "7.50", "houder", houder)),
                call("kopen", Json.obj("voor", "adressen", "zone", "eigencloud.nl", "prijs", "6.00", "akkoord", true, "houder", houder)),
                call("kopen", Json.obj("voor", "adressen", "zone", "eigencloud.nl", "prijs", "7.50", "akkoord", true, "houder", zonderTel)),
                call("kopen", Json.obj("voor", "adressen", "zone", "eigencloud.nl", "prijs", "7.50", "akkoord", true, "houder", houder)),
                call("kopen", Json.obj("voor", "adressen", "zone", "eigencloud.nl", "prijs", "7.50", "akkoord", true)),
                call("domein", Json.obj("voor", "adressen", "zone", "duur.nl")),
                call("kopen", Json.obj("voor", "adressen", "zone", "duur.nl", "prijs", "9.00", "akkoord", true, "houder", houder)),
                call("mail", Json.obj("manier", "cloud")),
                call("mail", Json.obj("manier", "scaleway")),
                call("benodigdheden", Json.obj()),
                fake("op", "temStatus", "status", "checked"),
                call("mailStatus", Json.obj()),
                call("mail", Json.obj("manier", "scaleway")),
                new Object[] {"server"},
                call("openprovider", Json.obj()),
                call("openprovider", Json.obj()),
                fake("op", "set", "path", "op.allow", "value", Json.list()),
                call("openprovider", Json.obj()),
                fake("op", "set", "path", "dienst.opCheck", "value", Json.obj("ok", false, "detail", "Openprovider laat de server van je Dienst niet inloggen: zet het IP-adres van de server op de lijst")),
                call("openproviderCheck", Json.obj()),
                fresh("benodigdheden"),
                new Object[] {"voorstel"},
                fresh("benodigdheden"),
                fake("op", "set", "path", "dienst.lijst", "value", Json.obj("opLijst", true, "sleutelKlopt", false)),
                fresh("benodigdheden"),
                fake("op", "set", "path", "dienst.termsUrl", "value", "https://dienst.esape.nl/voorwaarden"),
                fresh("benodigdheden"),
                fake("op", "set", "path", "dienst.privacyUrl", "value", "https://dienst.esape.nl/privacy"),
                fake("op", "set", "path", "dienst.lijst", "value", Json.obj("opLijst", true, "sleutelKlopt", true)),
                fake("op", "set", "path", "dienst.opCheck", "value", Json.obj("ok", true, "detail", "De server van je Dienst kan bij Openprovider")),
                call("openproviderCheck", Json.obj()),
                call("benodigdheden", Json.obj()),
                fresh("benodigdheden"));
    }

    /** Een open voorstel op GitHub voor de lijst (zoals GitHub.aanmelden het bewaart; in beide kluizen gelijk). */
    @SuppressWarnings("unchecked")
    static void voorstel(Map<String, Object> c) {
        ((Map<String, Object>) Json.map(c, "console")).put("github", Json.obj("voorstel", Json.obj("nummer", 12L, "url", "https://github.com/renevanes/own-cloud/pull/12", "titel", "ESAPE",
                "status", "open", "repo", "x/own-cloud", "branch", "b", "at", 1L, "samengevoegdOp", null)));
    }

    /** De Dienst draait (in beide kluizen precies gelijk). */
    @SuppressWarnings("unchecked")
    static void server(Map<String, Object> c) {
        Map<String, Object> a = (Map<String, Object>) Json.map(c, "console", "aanbieder");
        a.put("hosting", Json.obj("provider", "scaleway", "region", "nl-ams-1", "size", "DEV1-S", "monthly", 7.99));
        a.put("backup", Json.obj("provider", "scaleway", "endpoint", "https://s3.fr-par.scw.cloud", "region", "fr-par", "bucket", "b"));
        a.put("server", Json.obj("provider", "scaleway", "region", "nl-ams-1", "size", "DEV1-S", "serverId", "s1", "ipv4", "198.51.100.7", "createdAt", 1L));
        a.put("secret", new String(new char[32]).replace("\0", "ab"));
        a.put("lastHealth", Json.obj("at", 1L, "reachable", true, "version", "1.15", "uptime", 5L, "lastBackupAt", 1L, "backup", "aan", "closing", false));
    }

    static Object java(String fn, Map<String, Object> c, Map<String, Object> b, boolean fresh, Aanbieder.Deps deps) {
        try {
            switch (fn) {
                case "benodigdheden": return Benodigdheden.benodigdheden(c, fresh, deps);
                case "scaleway": return Benodigdheden.scaleway(c, b, deps);
                case "mollie": return Benodigdheden.mollie(c, b);
                case "desecRegister": return Benodigdheden.desecRegister(c, b);
                case "desecFinish": return Benodigdheden.desecFinish(c, b);
                case "domein": return Benodigdheden.domein(c, b, deps);
                case "delegeren": return Benodigdheden.delegeren(c, b, deps);
                case "kopen": return Benodigdheden.kopen(c, b, deps);
                case "mail": return Benodigdheden.mail(c, b, deps);
                case "mailStatus": return Benodigdheden.mailStatus(c, deps);
                case "openprovider": return Benodigdheden.openprovider(c, b, deps);
                case "openproviderCheck": return Benodigdheden.openproviderCheck(c, deps);
                case "saveBedrijf": return Aanbieder.saveBedrijf(c, b);
                case "saveAdres": return Aanbieder.saveAdres(c, b);
                case "saveDns": return Aanbieder.saveDns(c, b, deps);
                default: throw new IllegalStateException("onbekend " + fn);
            }
        } catch (Benodigdheden.StepsException e) {
            return Json.obj("error", e.getMessage(), "steps", e.steps);
        } catch (IOException | IllegalArgumentException e) {
            return Json.obj("error", e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) {
        T.main("BenodigdhedenTest", () -> {
            // ── Losse onderdelen ──
            T.eq("000001000001000000000000056573617065026e6c0000020001", Bytes.hex(Doh.encodeQuery("Esape.NL.", "NS")), "DoH-vraag");
            T.eq("2001:db8::1", Doh.ipv6Text(Bytes.fromHex("20010db8000000000000000000000001"), 0), "IPv6 kort");
            T.eq("2001:db8:1:0:1::1", Doh.ipv6Text(Bytes.fromHex("20010db8000100000001000000000001"), 0), "IPv6 langste reeks");
            T.eq("::", Doh.ipv6Text(new byte[16], 0), "IPv6 nul");
            T.eq(Arrays.asList("TransIP", "deSEC", null, "Hetzner"), Arrays.asList(Doh.nsProvider(Arrays.asList("ns0.transip.net")), Doh.nsProvider(Arrays.asList("NS1.deSEC.io.")),
                    Doh.nsProvider(Arrays.asList("x.example")), Doh.nsProvider(Arrays.asList("hydrogen.ns.hetzner.com"))), "aanbieders herkennen");
            T.check(Doh.nsMatch(Arrays.asList("ns1.desec.io", "ns2.desec.org"), Arrays.asList("NS2.desec.org.")), "nsMatch");
            T.check(!Doh.nsMatch(Arrays.asList("ns1.desec.io"), new ArrayList<String>()), "nsMatch zonder verwachting");
            T.eq("{\"country_code\":\"+31\",\"area_code\":\"6\",\"subscriber_number\":\"12345678\"}", Json.stringify(Benodigdheden.parsePhone("+31 6 12345678")), "telefoon");
            T.eq("{\"country_code\":\"+31\",\"area_code\":\"10\",\"subscriber_number\":\"1234567\"}", Json.stringify(Benodigdheden.parsePhone("010-1234567")), "telefoon vast");
            T.eq(null, Benodigdheden.parsePhone("12"), "telefoon fout");
            T.eq("{\"flags\":257,\"protocol\":3,\"alg\":13,\"pub_key\":\"QUJDREVG\"}", Json.stringify(Benodigdheden.parseDnskey("257 3 13 QUJD REVG")), "dnskey");
            T.eq("\"v=spf1 -all\"", Benodigdheden.txtRecord("v=spf1 -all"), "txt");
            T.eq("{\"name\":\"\",\"type\":\"MX\",\"ttl\":3600,\"value\":\"mail.vanes.nl\",\"prio\":10}", Json.stringify(Openprovider.record("", "MX", "10 mail.vanes.nl.", 3600)), "openprovider MX");
            T.eq("{\"name\":\"x\",\"type\":\"TXT\",\"ttl\":900,\"value\":\"v=spf1 -all\"}", Json.stringify(Openprovider.record("x", "TXT", "\"v=spf1 \" \"-all\"", 60)), "openprovider TXT");
            T.eq("dienst", Openprovider.sub("Dienst.Vanes.nl.", "vanes.nl"), "openprovider naam");

            // ── Hetzelfde scenario in Java en in TypeScript ──
            Map<String, Object> inf = Json.parseObject(new String(Files.readAllBytes(new File(System.getenv("NODIG_INFO")).toPath()), java.nio.charset.StandardCharsets.UTF_8));
            control = Json.str(inf, "control");
            Map<String, Object> env = Json.map(inf, "env");
            Endpoints.SCALEWAY = Json.str(env, "EIGEN_SCW_API");
            Endpoints.MOLLIE = Json.str(env, "EIGEN_MOLLIE_URL");
            Endpoints.DESEC = Json.str(env, "EIGEN_DESEC_URL");
            Endpoints.OPENPROVIDER = Json.str(env, "EIGEN_OPENPROVIDER_URL");
            Endpoints.DOH = Json.str(env, "EIGEN_DOH_URLS").split(",");
            Endpoints.TEM_SMTP = Json.str(env, "EIGEN_TEM_SMTP");
            Endpoints.AANBIEDERS = Json.str(env, "EIGEN_AANBIEDERS_URL");
            final String dienst = Json.str(inf, "dienst");
            Aanbieder.reach = url -> dienst;
            Aanbieder.plainSmtp = SmtpCheck.Security.NONE;
            Benodigdheden.retryDelayMs = 0;
            Catalog cat;
            try (FileInputStream in = new FileInputStream(System.getProperty("catalog.file"))) { cat = Catalog.load(in); }
            final Catalog fc = cat;
            Aanbieder.Deps deps = new Aanbieder.Deps() {
                @Override public List<Map<String, Object>> serverOffers() { return fc.serverOffers(); }

                @Override public List<Map<String, Object>> storeOffers() { return fc.storeOffers(); }

                @Override public List<Map<String, Object>> dnsOffers() { return fc.dnsOffers(); }

                @Override public void save() {}
            };
            List<Object[]> sc = scenario();

            post("/reset", null);
            Benodigdheden.resetCache();
            Openprovider.resetTokens();
            Map<String, Object> cj = newConfig();
            List<Object> outJ = new ArrayList<>();
            for (Object[] s : sc) {
                if ("fake".equals(s[0])) { post("/mutate", s[1]); continue; }
                if ("server".equals(s[0])) { server(cj); continue; }
                if ("voorstel".equals(s[0])) { voorstel(cj); continue; }
                Object r = java((String) s[0], cj, (Map<String, Object>) Json.copy(s[1]), (Boolean) s[2], deps);
                outJ.add(s.length > 3 ? null : r);
            }

            // PUT /contacts/{id}: de rest van de contactpersoon gaat ongewijzigd mee, alleen-lezen velden niet.
            T.eq("{\"api_access_enabled\":true,\"email\":\"rene@esape.nl\",\"name\":{\"first_name\":\"Rene\",\"last_name\":\"van Es\"},\"rcp_client_ip_list\":{\"allow\":[],\"deny\":[]},\"role\":\"admin\","
                    + "\"api_client_ip_list\":{\"allow\":[\"203.0.113.5\",\"198.51.100.7\"],\"deny\":[]}}", Json.stringify(Json.path(post("/get", Json.obj("path", "op.contactPut")), "value")), "IP-lijst: contactpersoon blijft heel");

            post("/reset", null);
            Object ct = newConfig();
            List<Object> outT = new ArrayList<>();
            for (Object[] s : sc) {
                if ("fake".equals(s[0])) { post("/mutate", s[1]); continue; }
                if ("server".equals(s[0])) { server((Map<String, Object>) ct); continue; }
                if ("voorstel".equals(s[0])) { voorstel((Map<String, Object>) ct); continue; }
                Object r = post("/ts", Json.obj("fn", s[0], "config", ct, "body", s[1], "fresh", s[2]));
                ct = Json.path(r, "config");
                outT.add(s.length > 3 ? null : Json.path(r, "json"));
            }
            T.eq(outT.size(), outJ.size(), "zelfde aantal stappen");
            int i = 0;
            for (Object[] s : sc) {
                if ("fake".equals(s[0]) || "server".equals(s[0]) || "voorstel".equals(s[0])) continue;
                T.eq(Json.stringify(norm(outT.get(i))), Json.stringify(norm(outJ.get(i))), "zelfde antwoord als TypeScript: " + s[0] + " (stap " + (i + 1) + ")");
                i++;
            }
            T.eq(Json.stringify(norm(Json.path(ct, "console", "aanbieder"))), Json.stringify(norm(Json.path(cj, "console", "aanbieder"))), "zelfde kluis als TypeScript");

            // ── Openprovider-DNS (adapter): zone maken, records zetten, vervangen en weghalen ──
            post("/reset", null);
            Openprovider.resetTokens();
            Map<String, Object> f = Json.obj("username", "vanes", "password", "geheim");
            T.eq("[ns1.openprovider.nl, ns2.openprovider.be, ns3.openprovider.eu]", Adapters.get("openprovider").dns.connect.connect(f, "vanes.nl").toString(), "Openprovider-nameservers");
            DnsProvider op = Adapters.get("openprovider").dns.create.make("t", f, "vanes.nl");
            op.setRecords("dienst", "A", Arrays.asList("192.0.2.10"), 300);
            op.setRecords("", "MX", Arrays.asList("10 mail.vanes.nl."), 3600);
            op.setRecords("", "TXT", Arrays.asList("\"v=spf1 \" \"-all\""), 3600);
            T.eq("[{\"name\":\"dienst.vanes.nl\",\"type\":\"A\",\"ttl\":900,\"value\":\"192.0.2.10\"},{\"name\":\"vanes.nl\",\"type\":\"MX\",\"ttl\":3600,\"value\":\"mail.vanes.nl\",\"prio\":10},{\"name\":\"vanes.nl\",\"type\":\"TXT\",\"ttl\":3600,\"value\":\"v=spf1 -all\"}]",
                    Json.stringify(Json.path(post("/op-zone", Json.obj("name", "vanes.nl")), "records")), "Openprovider-records");
            op.setRecords("dienst", "A", Arrays.asList("192.0.2.11"), 300);
            op.setRecords("", "MX", new ArrayList<String>(), 3600);
            List<String> left = new ArrayList<>();
            for (Object r : Json.listAt(post("/op-zone", Json.obj("name", "vanes.nl")), "records")) left.add(Json.str(r, "name") + " " + Json.str(r, "type") + " " + Json.str(r, "value"));
            T.eq("[vanes.nl TXT v=spf1 -all, dienst.vanes.nl A 192.0.2.11]", left.toString(), "Openprovider vervangen en weghalen");
            T.throwsWith("Openprovider laat deze gebruiker niet inloggen", () -> Adapters.get("openprovider").dns.connect.connect(Json.obj("username", "x", "password", "y"), "vanes.nl"), "Openprovider fout wachtwoord");
            List<Object> chk = Openprovider.check(f, "vanes.nl");
            T.eq("[true, true, null]", Arrays.asList(Json.path(chk, 0, "ok"), Json.path(chk, 1, "ok"), Json.path(chk, 2, "ok")).toString(), "Openprovider controleren");

            // En een paar dingen op zichzelf.
            Map<String, Object> eerst = (Map<String, Object>) outJ.get(0);
            T.eq(11, Json.listAt(eerst, "items").size(), "elf onderdelen");
            T.eq("{\"label\":\"Regelen\",\"soort\":\"paneel\",\"doel\":\"domein\"}", Json.stringify(Json.path(eerst, "items", 0, "actie")), "actie domein");
            Object laatste = outJ.get(outJ.size() - 1);
            List<String> st = new ArrayList<>();
            for (Object x : Json.listAt(laatste, "items")) st.add(Json.str(x, "id") + "=" + Json.str(x, "status"));
            T.eq("[domein=ok, dns=ok, server=ok, scaleway=ok, mollie=ok, mail=ok, desec=ok, openprovider=ok, adressendienst=open, voorwaarden=ok, lijst=ok]", st.toString(), "alles klaar");
            T.eq("8/8", Json.path(laatste, "klaar") + "/" + Json.path(laatste, "totaal"), "8 van 8");
            T.eq("[\"Je sleutel werkt\",\"Applicatie eigen-cloud-dienst\",\"Rechten: projecten, sleutels, servers, opslag en mail\",\"Eigen sleutel voor je Dienst\",\"Je eigen sleutel is weggegooid\"]",
                    labels(outJ.get(5)), "Scaleway met één sleutel");
            T.eq("Bestond al en werkt", Json.str(outJ.get(6), "steps", 3, "detail"), "Scaleway opnieuw: sleutel blijft");
            Map<String, String> lijstDetail = new java.util.LinkedHashMap<>();
            for (Object r : outJ) {
                if (!(r instanceof Map) || Json.path(r, "items") == null) continue;
                for (Object x : Json.listAt(r, "items")) if ("lijst".equals(Json.str(x, "id")) || "voorwaarden".equals(Json.str(x, "id"))) lijstDetail.put(Json.str(x, "id") + ":" + Json.str(x, "detail"), Json.str(x, "status"));
            }
            T.check("bijna".equals(lijstDetail.get("lijst:Voorstel #12 wacht op de beheerders")), "lijst: open voorstel");
            T.check("bijna".equals(lijstDetail.get("lijst:Je regel staat erop, maar met een andere sleutel")), "lijst: andere sleutel");
            T.check("bijna".equals(lijstDetail.get("voorwaarden:Je privacyverklaring ontbreekt nog")), "voorwaarden: privacy ontbreekt");
            T.eq("duur.nl is een premium-domein met een andere prijs. Koop het in het controlepaneel van Openprovider.", Json.str(outJ.get(indexOf(sc, "kopen", "duur.nl")), "error"), "premium niet kopen");
            String geheimen = Json.stringify(laatste);
            T.check(!geheimen.contains("live_xyz789") && !geheimen.contains(Json.str(cj, "console", "aanbieder", "accounts", "scalewaySecretKey")), "geen geheimen in de lijst");
        });
    }

    /** De plek in de uitkomsten van de eerste stap {@code fn} met deze zone. */
    @SuppressWarnings("unchecked")
    static int indexOf(List<Object[]> sc, String fn, String zone) {
        int i = 0;
        for (Object[] s : sc) {
            if ("fake".equals(s[0]) || "server".equals(s[0]) || "voorstel".equals(s[0])) continue;
            if (fn.equals(s[0]) && zone.equals(Json.str((Map<String, Object>) s[1], "zone"))) return i;
            i++;
        }
        return -1;
    }

    static String labels(Object r) {
        List<Object> out = new ArrayList<>();
        for (Object s : Json.listAt(r, "steps")) out.add(Json.str(s, "label"));
        return Json.stringify(out);
    }
}
