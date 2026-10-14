package nl.eigencloud.core;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.agenda.AgendaEvent;
import nl.eigencloud.core.agenda.Ics;

/**
 * ICS schrijven en lezen ({@link Ics}): byte-gelijk aan exportIcs uit src/calendar/ics.ts (golden), teruglezen,
 * randgevallen (vouwen, escaping, tijdzones, hele dagen, herhalingen, losse herhalingen, herinneringen), en een
 * reservekopie zoals de telefoon hem maakt voor de controle met importIcs (scripts/telefoon-golden.ts controleer).
 */
public class AgendaIcsTest {
    static final ZoneId AMS = ZoneId.of("Europe/Amsterdam");

    static long ams(int y, int m, int d, int h, int min) { return LocalDateTime.of(y, m, d, h, min).atZone(AMS).toInstant().toEpochMilli(); }

    static long utc(int y, int m, int d, int h, int min) { return LocalDateTime.of(y, m, d, h, min).toInstant(ZoneOffset.UTC).toEpochMilli(); }

    static long day(int y, int m, int d) { return utc(y, m, d, 0, 0); }

    public static void main(String[] args) {
        T.main("AgendaIcsTest", () -> {
            golden();
            units();
            googleExport();
            timezones();
            phoneBackup();
        });
    }

    /** Zelfde uitvoer als exportIcs, en teruglezen geeft dezelfde afspraken. */
    static void golden() throws Exception {
        Map<String, Object> g = Json.parseObject(new String(Files.readAllBytes(new File(T.buildDir(), "telefoon-golden.json").toPath()), "UTF-8"));
        List<AgendaEvent> events = new ArrayList<>();
        for (Object o : Json.asList(g.get("events"))) {
            Map<String, Object> r = Json.asMap(o);
            AgendaEvent e = new AgendaEvent();
            String uid = Json.str(r, "uid");
            int hash = uid.indexOf('#');
            e.uid = hash < 0 ? uid : uid.substring(0, hash);
            if (hash >= 0) e.recurrenceId = Long.parseLong(uid.substring(hash + 1));
            e.title = Json.str(r, "title");
            e.description = Json.str(r, "description");
            e.location = Json.str(r, "location");
            e.start = Json.num(r, "start").longValue();
            e.end = Json.num(r, "end").longValue();
            e.allDay = Json.num(r, "all_day").intValue() == 1;
            e.tz = Json.str(r, "tz");
            e.rrule = Json.str(r, "rrule");
            for (Object x : Json.asList(Json.parse(Json.str(r, "exdates")))) e.exdates.add(((Number) x).longValue());
            if (Json.num(r, "reminder_min") != null) e.reminders.add(Json.num(r, "reminder_min").intValue());
            if (Json.num(r, "updated") != null) e.updated = Json.num(r, "updated").longValue();
            events.add(e);
        }
        String expected = Json.str(g, "ics");
        T.eq(expected, Ics.write("Werk & privé, thuis", events, false), "Ics.write = exportIcs (byte voor byte)");

        Ics.Calendar back = Ics.parse(expected, AMS);
        T.eq("Werk & privé, thuis", back.name, "naam terug");
        T.eq(0, back.skipped, "niets overgeslagen");
        T.eq(events.size(), back.events.size(), "aantal terug");
        for (int i = 0; i < events.size() && i < back.events.size(); i++) T.eq(events.get(i), back.events.get(i), "terug gelezen: " + events.get(i).uid);
        // Opnieuw schrijven geeft weer precies hetzelfde.
        T.eq(expected, Ics.write("Werk & privé, thuis", back.events, false), "schrijven(lezen(x)) = x");
    }

    static void units() {
        // Vouwen: elke regel hooguit 74 bytes, geen gesplitst teken, en na ontvouwen weer gelijk.
        String title = "😀 Verjaardag van de buurvrouw 🎂 met taart, koffie en heel veel gezelligheid — tot laat in de avond 🎉🎉🎉 en daarna nog meer";
        AgendaEvent e = new AgendaEvent();
        e.uid = "x"; e.title = title; e.start = utc(2026, 1, 1, 10, 0); e.end = e.start + 3_600_000;
        String ics = Ics.write("t", List.of(e), false);
        for (String line : ics.split("\r\n")) {
            T.check(line.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 74, "regel ≤ 74 bytes: " + line);
            T.check(line.isEmpty() || !Character.isLowSurrogate(line.charAt(line.startsWith(" ") && line.length() > 1 ? 1 : 0)), "geen halve emoji aan het begin: " + line);
        }
        T.eq(title, Ics.parse(ics, AMS).events.get(0).title, "gevouwen titel terug");

        // Escaping heen en terug
        AgendaEvent f = e.copy();
        f.title = "a,b;c\\d\ne";
        f.description = "regel 1\r\nregel 2";
        AgendaEvent g = Ics.parse(Ics.write("t", List.of(f), false), AMS).events.get(0);
        T.eq("a,b;c\\d\ne", g.title, "titel met , ; \\ en enter");
        T.eq("regel 1\nregel 2", g.description, "CRLF wordt LF");

        // Duur
        T.eq(-900_000L, Ics.durationMs("-PT15M"), "-PT15M");
        T.eq(86_400_000L, Ics.durationMs("P1D"), "P1D");
        T.eq(5_400_000L, Ics.durationMs("PT1H30M"), "PT1H30M");
        T.eq(1_209_600_000L, Ics.durationMs("P2W"), "P2W");
        T.eq(3_600_000L, Ics.durationMs("P3600S"), "P3600S (Android)");
        T.eq(90_061_000L, Ics.durationMs("P1DT1H1M1S"), "P1DT1H1M1S");
        T.eq(null, Ics.durationMs("P1M"), "maanden zijn geen vaste duur");
        T.eq(null, Ics.durationMs("PT"), "lege duur");
        T.eq(null, Ics.durationMs("15M"), "zonder P");

        // Hele dag zonder DTEND = één dag; tijd zonder DTEND = één uur (zoals importIcs)
        Ics.Calendar c = Ics.parse("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:d1\nDTSTART;VALUE=DATE:20260501\nSUMMARY:Vrij\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:d2\nDTSTART:20260501T100000Z\nSUMMARY:Bellen\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:d3\nDTSTART:20260501T100000Z\nDURATION:PT45M\nSUMMARY:\nEND:VEVENT\nEND:VCALENDAR\n", AMS);
        T.eq(3, c.events.size(), "drie afspraken");
        T.eq(day(2026, 5, 2), c.events.get(0).end, "hele dag: einde = volgende dag");
        T.check(c.events.get(0).allDay && c.events.get(0).tz == null, "hele dag zonder tijdzone");
        T.eq(utc(2026, 5, 1, 11, 0), c.events.get(1).end, "zonder einde: één uur");
        T.eq(utc(2026, 5, 1, 10, 45), c.events.get(2).end, "DURATION");
        T.eq("(zonder titel)", c.events.get(2).title, "lege titel zoals importIcs");
        T.eq(null, c.events.get(1).tz, "UTC-tijd heeft geen tijdzone");

        // Kapotte afspraken worden overgeslagen, de rest niet
        Ics.Calendar bad = Ics.parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:geen begin\r\nEND:VEVENT\r\n"
                + "BEGIN:VEVENT\r\nUID:y\r\nDTSTART:2026XXXX\r\nEND:VEVENT\r\n"
                + "BEGIN:VEVENT\r\nUID:z\r\nDTSTART:20260101T100000Z\r\nRRULE:BYDAY=MO\r\nEND:VEVENT\r\n"
                + "BEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20260101T100000Z\r\nSUMMARY:goed\r\nEND:VEVENT\r\nEND:VCALENDAR", AMS);
        T.eq(1, bad.events.size(), "alleen de goede blijft");
        T.eq(3, bad.skipped, "drie overgeslagen");
        T.eq(0, Ics.parse("", AMS).events.size(), "leeg bestand");
        T.eq(0, Ics.parse("geen agenda", AMS).events.size(), "geen agenda");

        // Zonder UID: vaste UID uit de inhoud (dubbel importeren maakt geen dubbele afspraken)
        String noUid = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260101T100000Z\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR";
        T.eq(Ics.parse(noUid, AMS).events.get(0).uid, Ics.parse(noUid, AMS).events.get(0).uid, "UID zonder UID is vast");
    }

    /** Zoals Google Agenda exporteert (Takeout): VTIMEZONE, gewijzigde en geschrapte herhalingen, alarmen. */
    static void googleExport() {
        String ics = String.join("\r\n",
                "BEGIN:VCALENDAR",
                "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
                "VERSION:2.0",
                "X-WR-CALNAME:rene@example.com",
                "X-WR-TIMEZONE:Europe/Amsterdam",
                "BEGIN:VTIMEZONE",
                "TZID:Europe/Amsterdam",
                "X-LIC-LOCATION:Europe/Amsterdam",
                "BEGIN:DAYLIGHT",
                "TZOFFSETFROM:+0100",
                "TZOFFSETTO:+0200",
                "TZNAME:CEST",
                "DTSTART:19700329T020000",
                "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
                "END:DAYLIGHT",
                "BEGIN:STANDARD",
                "TZOFFSETFROM:+0200",
                "TZOFFSETTO:+0100",
                "TZNAME:CET",
                "DTSTART:19701025T030000",
                "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
                "END:STANDARD",
                "END:VTIMEZONE",
                "BEGIN:VTIMEZONE",
                "TZID:Mijn Eigen Zone",
                "BEGIN:STANDARD",
                "DTSTART:19700101T000000",
                "TZOFFSETFROM:+0530",
                "TZOFFSETTO:+0530",
                "END:STANDARD",
                "END:VTIMEZONE",
                "BEGIN:VEVENT",
                "DTSTART;TZID=Europe/Amsterdam:20260105T090000",
                "DTEND;TZID=Europe/Amsterdam:20260105T093000",
                "RRULE:FREQ=WEEKLY;BYDAY=MO",
                "EXDATE;TZID=Europe/Amsterdam:20260112T090000,20260119T090000",
                "EXDATE;TZID=Europe/Amsterdam:20260126T090000",
                "DTSTAMP:20261001T080000Z",
                "UID:3k1@google.com",
                "SUMMARY:Stand-up",
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "TRIGGER:-PT10M",
                "END:VALARM",
                "BEGIN:VALARM",
                "ACTION:EMAIL",
                "TRIGGER:-P1D",
                "END:VALARM",
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "TRIGGER;VALUE=DATE-TIME:20260101T080000Z",
                "END:VALARM",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=Europe/Amsterdam:20260203T100000",
                "DTEND;TZID=Europe/Amsterdam:20260203T103000",
                "RECURRENCE-ID;TZID=Europe/Amsterdam:20260202T090000",
                "UID:3k1@google.com",
                "SUMMARY:Stand-up (dinsdag)",
                "LOCATION:Kamer 2\\, boven",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=Europe/Amsterdam:20260209T090000",
                "DTEND;TZID=Europe/Amsterdam:20260209T093000",
                "RECURRENCE-ID;TZID=Europe/Amsterdam:20260209T090000",
                "UID:3k1@google.com",
                "STATUS:CANCELLED",
                "SUMMARY:Stand-up",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=\"Mijn Eigen Zone\":20260301T120000",
                "DTEND;TZID=\"Mijn Eigen Zone\":20260301T130000",
                "UID:eigen-zone",
                "SUMMARY:Lunch in eigen zone",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=W. Europe Standard Time:20260302T120000",
                "DTEND;TZID=W. Europe Standard Time:20260302T130000",
                "UID:outlook",
                "SUMMARY:Outlook",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART:20260303T120000",
                "DTEND:20260303T130000",
                "UID:zwevend",
                "SUMMARY:Zwevende tijd",
                "DESCRIPTION:Een lange beschrijving die over meerdere regels is gevouwen door",
                "\t een tab en",
                "  een spatie.",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=Europe/Amsterdam:20260304T120000",
                "DTEND;TZID=Europe/Amsterdam:20260304T130000",
                "UID:geannuleerd",
                "STATUS:CANCELLED",
                "SUMMARY:Gaat niet door",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "DTSTART;TZID=/citadel.org/20190101_1/Europe/Amsterdam:20260305T120000",
                "DURATION:PT2H",
                "UID:pad",
                "SUMMARY:Tijdzone als pad",
                "END:VEVENT",
                "END:VCALENDAR", "");
        Ics.Calendar c = Ics.parse(ics, null);
        T.eq("rene@example.com", c.name, "naam");
        T.eq(2, c.skipped, "geschrapte herhaling en geannuleerde afspraak overgeslagen");
        T.eq(6, c.events.size(), "zes afspraken");
        AgendaEvent m = c.events.get(0);
        T.eq("3k1@google.com", m.uid, "uid");
        T.eq(ams(2026, 1, 5, 9, 0), m.start, "begin in Amsterdam");
        T.eq("Europe/Amsterdam", m.tz, "tijdzone");
        T.eq("FREQ=WEEKLY;BYDAY=MO", m.rrule, "herhaling");
        T.eq(List.of(ams(2026, 1, 12, 9, 0), ams(2026, 1, 19, 9, 0), ams(2026, 1, 26, 9, 0), ams(2026, 2, 9, 9, 0)), m.exdates,
                "EXDATE (meerdere waarden en regels) + geschrapte losse herhaling");
        T.eq(List.of(10, 1440), m.reminders, "herinneringen; tijdstip-alarm genegeerd");
        T.eq(utc(2026, 10, 1, 8, 0), m.updated, "DTSTAMP");
        AgendaEvent o = c.events.get(1);
        T.eq(ams(2026, 2, 2, 9, 0), o.recurrenceId, "losse herhaling: RECURRENCE-ID");
        T.eq("3k1@google.com#" + ams(2026, 2, 2, 9, 0), o.key(), "sleutel losse herhaling");
        T.eq("Kamer 2, boven", o.location, "LOCATION ont-escaped");
        T.eq(null, o.rrule, "losse herhaling heeft geen RRULE");
        AgendaEvent eigen = c.events.get(2);
        T.eq(LocalDateTime.of(2026, 3, 1, 12, 0).toInstant(ZoneOffset.ofHoursMinutes(5, 30)).toEpochMilli(), eigen.start, "TZID uit VTIMEZONE (+05:30)");
        T.eq("GMT+05:30", eigen.tz, "vaste afwijking als tijdzone");
        T.eq(ams(2026, 3, 2, 12, 0), c.events.get(3).start, "Windows-tijdzone");
        AgendaEvent zw = c.events.get(4);
        T.eq(ams(2026, 3, 3, 12, 0), zw.start, "zwevende tijd in X-WR-TIMEZONE");
        T.eq("Een lange beschrijving die over meerdere regels is gevouwen door een tab en een spatie.", zw.description, "ontvouwen (tab en spatie)");
        AgendaEvent pad = c.events.get(5);
        T.eq(ams(2026, 3, 5, 12, 0), pad.start, "TZID als pad");
        T.eq(ams(2026, 3, 5, 14, 0), pad.end, "DURATION PT2H");
    }

    static void timezones() {
        String ams = String.join("\n", writeTz("Europe/Amsterdam"));
        T.check(ams.contains("BEGIN:DAYLIGHT") && ams.contains("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU") && ams.contains("TZOFFSETTO:+0200"), "Amsterdam zomertijd: " + ams);
        T.check(ams.contains("BEGIN:STANDARD") && ams.contains("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU") && ams.contains("TZOFFSETTO:+0100"), "Amsterdam wintertijd");
        String ny = String.join("\n", writeTz("America/New_York"));
        T.check(ny.contains("BYMONTH=3;BYDAY=2SU") && ny.contains("BYMONTH=11;BYDAY=1SU") && ny.contains("TZOFFSETTO:-0400"), "New York: " + ny);
        String tokyo = String.join("\n", writeTz("Asia/Tokyo"));
        T.check(tokyo.contains("TZOFFSETFROM:+0900") && !tokyo.contains("RRULE"), "Tokio zonder zomertijd: " + tokyo);
        // Met VTIMEZONE vindt ook een lezer die de naam niet kent de afwijking (hier: wintertijd = standaard).
        AgendaEvent e = new AgendaEvent();
        e.uid = "tz"; e.title = "Wintertijd"; e.tz = "Europe/Amsterdam"; e.start = ams(2026, 1, 15, 9, 0); e.end = ams(2026, 1, 15, 10, 0);
        String withTz = Ics.write("t", List.of(e));
        T.check(withTz.contains("BEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam"), "VTIMEZONE bij reservekopie");
        T.check(!Ics.write("t", List.of(e), false).contains("VTIMEZONE"), "zonder VTIMEZONE als exportIcs");
        T.eq(e.start, Ics.parse(withTz.replace("Europe/Amsterdam", "Onbekend/Plaats"), ZoneOffset.UTC).events.get(0).start, "onbekende naam: afwijking uit VTIMEZONE");
        AgendaEvent allDay = new AgendaEvent();
        allDay.uid = "hd"; allDay.title = "Hele dag"; allDay.allDay = true; allDay.tz = "Europe/Amsterdam"; allDay.start = day(2026, 1, 1); allDay.end = day(2026, 1, 2);
        T.check(!Ics.write("t", List.of(allDay)).contains("VTIMEZONE"), "hele dag: geen tijdzone nodig");
    }

    static List<String> writeTz(String id) {
        AgendaEvent e = new AgendaEvent();
        e.uid = "x"; e.title = "x"; e.tz = id; e.start = utc(2026, 1, 1, 0, 0); e.end = e.start;
        String ics = Ics.write("t", List.of(e));
        List<String> out = new ArrayList<>();
        boolean in = false;
        for (String l : ics.split("\r\n")) {
            if (l.equals("BEGIN:VTIMEZONE")) in = true;
            if (in) out.add(l);
            if (l.equals("END:VTIMEZONE")) in = false;
        }
        return out;
    }

    /** Een reservekopie zoals de telefoon hem maakt; scripts/telefoon-golden.ts controleert hem met importIcs. */
    static void phoneBackup() throws Exception {
        List<AgendaEvent> events = new ArrayList<>();
        AgendaEvent a = new AgendaEvent();
        a.uid = "abc123@google.com"; a.title = "Huisarts"; a.location = "Dorpsstraat 3"; a.description = "Uitslag bespreken";
        a.tz = "Europe/Amsterdam"; a.start = ams(2026, 11, 2, 14, 15); a.end = ams(2026, 11, 2, 14, 30);
        a.reminders.add(30); a.reminders.add(1440);
        events.add(a);
        AgendaEvent b = new AgendaEvent();
        b.uid = "sport@google.com"; b.title = "Hardlopen"; b.tz = "Europe/Amsterdam"; b.rrule = "FREQ=WEEKLY;BYDAY=TU,TH";
        b.start = ams(2026, 3, 3, 19, 0); b.end = ams(2026, 3, 3, 20, 0);
        b.exdates.add(ams(2026, 3, 5, 19, 0)); b.exdates.add(ams(2026, 3, 31, 19, 0)); // voor én na de zomertijd
        events.add(b);
        AgendaEvent bo = new AgendaEvent();
        bo.uid = "sport@google.com"; bo.recurrenceId = ams(2026, 4, 2, 19, 0); bo.title = "Hardlopen (later)"; bo.tz = "Europe/Amsterdam";
        bo.start = ams(2026, 4, 2, 20, 0); bo.end = ams(2026, 4, 2, 21, 0);
        events.add(bo);
        AgendaEvent c = new AgendaEvent();
        c.uid = "ny@telefoon"; c.title = "Call met New York"; c.tz = "America/New_York"; c.start = LocalDateTime.of(2026, 3, 10, 10, 0).atZone(ZoneId.of("America/New_York")).toInstant().toEpochMilli();
        c.end = c.start + 3_600_000L;
        events.add(c);
        AgendaEvent d = new AgendaEvent();
        d.uid = "utc@telefoon"; d.title = "In UTC"; d.start = utc(2026, 6, 1, 6, 0); d.end = utc(2026, 6, 1, 7, 0);
        events.add(d);
        AgendaEvent f = new AgendaEvent();
        f.uid = "vrij@telefoon"; f.title = "Koningsdag"; f.allDay = true; f.start = day(2026, 4, 27); f.end = day(2026, 4, 28); f.rrule = "FREQ=YEARLY";
        f.exdates.add(day(2027, 4, 27));
        events.add(f);
        String ics = Ics.write("Werk (rene@example.com)", events);
        // Teruglezen in Java geeft hetzelfde.
        Ics.Calendar back = Ics.parse(ics, AMS);
        T.eq(events.size(), back.events.size(), "reservekopie: aantal terug");
        for (int i = 0; i < events.size() && i < back.events.size(); i++) T.eq(events.get(i), back.events.get(i), "reservekopie terug: " + events.get(i).key());

        // Wat importIcs (de cloud) ervan moet maken: één rij per afspraak, losse herhaling als "uid#tijd",
        // tijdstip van de losse herhaling ook bij de geschrapte van de reeks; eerste herinnering.
        List<Object> expected = new ArrayList<>();
        for (AgendaEvent e : events) {
            List<Object> ex = new ArrayList<>();
            List<Long> all = new ArrayList<>(e.exdates);
            for (AgendaEvent o : events) if (o.recurrenceId != null && o.uid.equals(e.uid) && e.recurrenceId == null) all.add(o.recurrenceId);
            java.util.Collections.sort(all);
            ex.addAll(all);
            expected.add(Json.obj("uid", e.key(), "title", e.title, "description", e.description, "location", e.location, "start", e.start, "end", e.end,
                    "all_day", e.allDay ? 1 : 0, "tz", e.allDay ? null : e.tz == null ? "UTC" : e.tz, "rrule", e.rrule, "exdates", ex,
                    "reminder_min", e.reminders.isEmpty() ? null : e.reminders.get(0)));
        }
        File dir = new File(T.buildDir(), "java-out");
        dir.mkdirs();
        try (FileOutputStream o = new FileOutputStream(new File(dir, "agenda-telefoon.ics"))) { o.write(Bytes.utf8(ics)); }
        T.writeOut("agenda-telefoon.json", expected);
    }
}
