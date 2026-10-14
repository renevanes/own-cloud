package nl.eigencloud.core;

import java.io.File;
import java.nio.file.Files;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.agenda.AgendaEvent;
import nl.eigencloud.core.agenda.AndroidAgenda;
import nl.eigencloud.core.agenda.BackupStore;
import nl.eigencloud.core.agenda.Ics;
import nl.eigencloud.core.agenda.Restore;

/**
 * Agenda op de telefoon: rijen van Android → afspraken (venster, uitzonderingen, herinneringen), afspraak → wat er
 * naar Android gaat, formulierinvoer, de vergelijking voor "Herstel uit reservekopie", en de map met kopieën.
 * Eindigt met een volledige ronde: telefoon → kopie → (agenda raakt dingen kwijt) → terugzetten → alles gelijk.
 */
public class AgendaBackupTest {
    static final ZoneId AMS = ZoneId.of("Europe/Amsterdam");
    static final long DAY = 86_400_000L;

    static long ams(int y, int m, int d, int h, int min) { return LocalDateTime.of(y, m, d, h, min).atZone(AMS).toInstant().toEpochMilli(); }

    static long day(int y, int m, int d) { return LocalDateTime.of(y, m, d, 0, 0).toInstant(ZoneOffset.UTC).toEpochMilli(); }

    public static void main(String[] args) {
        T.main("AgendaBackupTest", () -> {
            formats();
            rows();
            writes();
            input();
            restorePlan();
            store();
            roundTrip();
        });
    }

    static void formats() {
        T.eq(3_600_000L, AndroidAgenda.parseDuration("P3600S"), "P3600S");
        T.eq(DAY, AndroidAgenda.parseDuration("P1D"), "P1D");
        T.eq("P3600S", AndroidAgenda.formatDuration(3_600_000L, false), "uur");
        T.eq("P2D", AndroidAgenda.formatDuration(2 * DAY, true), "twee hele dagen");
        T.eq("P90S", AndroidAgenda.formatDuration(90_000L, true), "hele dag maar geen veelvoud: seconden");
        T.eq(List.of(ams(2026, 1, 12, 9, 0)), AndroidAgenda.parseExdates("20260112T080000Z"), "UTC");
        T.eq(List.of(ams(2026, 1, 12, 9, 0), ams(2026, 1, 19, 9, 0)), AndroidAgenda.parseExdates("Europe/Amsterdam;20260112T090000,20260119T090000"), "tijdzone;tijden");
        T.eq(List.of(day(2026, 4, 27)), AndroidAgenda.parseExdates("20260427"), "hele dag");
        T.eq(List.of(ams(2026, 1, 12, 9, 0), day(2026, 4, 27)), AndroidAgenda.parseExdates("20260112T080000Z\n20260427\n"), "meerdere regels");
        T.eq(List.of(), AndroidAgenda.parseExdates("onzin,2026"), "onleesbaar overgeslagen");
        T.eq(List.of(), AndroidAgenda.parseExdates(null), "leeg");
        T.eq("20260112T080000Z,20260119T080000Z", AndroidAgenda.formatExdates(List.of(ams(2026, 1, 19, 9, 0), ams(2026, 1, 12, 9, 0)), false), "gesorteerd, UTC");
        T.eq("20260427", AndroidAgenda.formatExdates(List.of(day(2026, 4, 27)), true), "hele dag");
        T.eq(null, AndroidAgenda.formatExdates(List.of(), false), "geen");
        // Wat we schrijven, lezen we zelf weer (en Android met RecurrenceSet ook: "datum" of "datumTtijdZ").
        List<Long> some = List.of(ams(2026, 3, 30, 9, 0), ams(2026, 3, 23, 9, 0));
        T.eq(List.of(ams(2026, 3, 23, 9, 0), ams(2026, 3, 30, 9, 0)), AndroidAgenda.parseExdates(AndroidAgenda.formatExdates(some, false)), "heen en terug");
        long now = LocalDateTime.of(2026, 10, 13, 12, 0).toInstant(ZoneOffset.UTC).toEpochMilli();
        T.eq(LocalDateTime.of(2025, 10, 13, 12, 0).toInstant(ZoneOffset.UTC).toEpochMilli(), AndroidAgenda.cutoff(now, 12), "12 maanden terug");
        T.eq(Long.MIN_VALUE, AndroidAgenda.cutoff(now, 0), "0 = alles");
    }

    static AndroidAgenda.Row row(long id, String title, long start, Long end) {
        AndroidAgenda.Row r = new AndroidAgenda.Row();
        r.id = id; r.calendarId = 7; r.accountType = "com.google"; r.title = title; r.dtstart = start; r.dtend = end; r.timezone = "Europe/Amsterdam"; r.status = 1;
        return r;
    }

    static void rows() {
        long now = ams(2026, 10, 13, 12, 0);
        long cutoff = AndroidAgenda.cutoff(now, 12);
        List<AndroidAgenda.Row> rows = new ArrayList<>();
        AndroidAgenda.Row single = row(1, "Kapper", ams(2026, 9, 1, 10, 0), ams(2026, 9, 1, 10, 30));
        single.syncId = "abc"; single.description = ""; single.location = "Hoofdstraat";
        rows.add(single);
        AndroidAgenda.Row old = row(2, "Heel oud", ams(2024, 1, 1, 10, 0), ams(2024, 1, 1, 11, 0));
        rows.add(old);
        AndroidAgenda.Row series = row(3, "Stand-up", ams(2025, 1, 6, 9, 0), null);
        series.dtend = null; series.duration = "P900S"; series.rrule = "FREQ=WEEKLY;BYDAY=MO"; series.exdate = "20260112T080000Z"; series.syncId = "reeks"; series.uid2445 = "reeks@google.com";
        rows.add(series);
        AndroidAgenda.Row ended = row(4, "Cursus (afgelopen)", ams(2023, 1, 2, 19, 0), null);
        ended.dtend = null; ended.duration = "P3600S"; ended.rrule = "FREQ=WEEKLY;COUNT=10"; ended.lastDate = ams(2023, 3, 6, 20, 0);
        rows.add(ended);
        AndroidAgenda.Row cancelledInstance = row(5, "Stand-up", ams(2026, 2, 2, 9, 0), ams(2026, 2, 2, 9, 15));
        cancelledInstance.originalId = 3L; cancelledInstance.originalInstanceTime = ams(2026, 2, 2, 9, 0); cancelledInstance.status = 2;
        rows.add(cancelledInstance);
        AndroidAgenda.Row moved = row(6, "Stand-up (later)", ams(2026, 2, 9, 11, 0), ams(2026, 2, 9, 11, 15));
        moved.originalSyncId = "reeks"; moved.originalInstanceTime = ams(2026, 2, 9, 9, 0);
        rows.add(moved);
        AndroidAgenda.Row cancelled = row(7, "Afgezegd", ams(2026, 9, 2, 10, 0), ams(2026, 9, 2, 11, 0));
        cancelled.status = 2;
        rows.add(cancelled);
        AndroidAgenda.Row allDay = row(8, "Vrij", day(2026, 12, 24), day(2026, 12, 27));
        allDay.allDay = true; allDay.timezone = "UTC";
        rows.add(allDay);
        AndroidAgenda.Row local = row(9, "Lokaal", ams(2026, 11, 1, 10, 0), ams(2026, 11, 1, 11, 0));
        local.accountType = "LOCAL";
        rows.add(local);
        Map<Long, List<Integer>> reminders = new HashMap<>();
        reminders.put(1L, new ArrayList<>(List.of(60, 10, 10)));
        reminders.put(3L, new ArrayList<>(List.of(5)));

        List<AgendaEvent> ev = AndroidAgenda.toEvents(rows, reminders, cutoff);
        List<String> keys = new ArrayList<>();
        for (AgendaEvent e : ev) keys.add(e.key());
        T.eq(5, ev.size(), "vijf afspraken (oud, afgelopen reeks en geannuleerd vallen weg): " + keys);
        AgendaEvent k = ev.get(0);
        T.eq("abc@google.com", k.uid, "UID uit synchronisatie-id (Google)");
        T.eq(null, k.description, "lege beschrijving = geen");
        T.eq(List.of(10, 60), k.reminders, "herinneringen uniek en gesorteerd");
        T.eq("Europe/Amsterdam", k.tz, "tijdzone");
        T.eq(1L, k.localId, "rij-id bewaard");
        AgendaEvent s = ev.get(1);
        T.eq("reeks@google.com", s.uid, "UID_2445 gaat voor");
        T.eq(ams(2025, 1, 6, 9, 15), s.end, "einde uit DURATION");
        T.eq(List.of(ams(2026, 1, 12, 9, 0), ams(2026, 2, 2, 9, 0)), s.exdates, "EXDATE + geannuleerde herhaling");
        T.eq(List.of(5), s.reminders, "herinnering reeks");
        AgendaEvent hd = ev.get(2);
        T.check(hd.allDay && hd.tz == null && hd.end == day(2026, 12, 27), "hele dagen");
        T.eq("telefoon-7-9@eigen-cloud", ev.get(3).uid, "lokale afspraak: UID uit de rij");
        AgendaEvent o = ev.get(4);
        T.eq("reeks@google.com", o.uid, "losse herhaling hoort bij de reeks (via ORIGINAL_SYNC_ID)");
        T.eq(ams(2026, 2, 9, 9, 0), o.recurrenceId, "oorspronkelijk tijdstip");
        T.eq(null, o.rrule, "geen herhaling in losse herhaling");

        AndroidAgenda.Row other = row(10, "x", 0, 0L);
        other.syncId = "123"; other.accountType = "org.dmfs.caldav.account";
        T.eq("123@sync.telefoon", AndroidAgenda.uidFor(other), "andere synchronisatie");
        other.syncId = "event-1@nextcloud";
        T.eq("event-1@nextcloud", AndroidAgenda.uidFor(other), "synchronisatie-id met @");
        T.eq(7,AndroidAgenda.toEvents(rows, reminders, Long.MIN_VALUE).size(), "zonder venster: zeven (alleen geannuleerde vallen weg)");
    }

    static void writes() {
        AgendaEvent e = new AgendaEvent();
        e.uid = "r"; e.title = "Yoga"; e.tz = "Europe/Amsterdam"; e.rrule = "RRULE:FREQ=WEEKLY"; e.start = ams(2026, 1, 7, 19, 0); e.end = ams(2026, 1, 7, 20, 30);
        e.exdates.add(ams(2026, 1, 14, 19, 0));
        e.reminders.add(15);
        AndroidAgenda.Write w = AndroidAgenda.toWrite(e, List.of(ams(2026, 1, 21, 19, 0), ams(2026, 1, 14, 19, 0)));
        T.eq(null, w.dtend, "herhaling: geen DTEND");
        T.eq("P5400S", w.duration, "herhaling: DURATION");
        T.eq("FREQ=WEEKLY", w.rrule, "RRULE: weggehaald");
        T.eq("20260114T180000Z,20260121T180000Z", w.exdate, "EXDATE samengevoegd zonder dubbele");
        T.eq("Europe/Amsterdam", w.timezone, "tijdzone");
        T.eq(List.of(15), w.reminders, "herinnering");
        AgendaEvent s = new AgendaEvent();
        s.title = "Los"; s.start = 1000; s.end = 500;
        AndroidAgenda.Write ws = AndroidAgenda.toWrite(s, null);
        T.check(ws.dtend != null && ws.dtend == 1000 && ws.duration == null && ws.rrule == null, "los: DTEND, niet vóór begin");
        T.eq("UTC", ws.timezone, "zonder tijdzone: UTC");
        AgendaEvent h = new AgendaEvent();
        h.title = "Vrij"; h.allDay = true; h.start = day(2026, 5, 1) + 3_600_000L; h.end = day(2026, 5, 1) + 7_200_000L; h.tz = "Europe/Amsterdam";
        AndroidAgenda.Write wh = AndroidAgenda.toWrite(h, null);
        T.check(wh.dtstart == day(2026, 5, 1) && wh.dtend == day(2026, 5, 2) && "UTC".equals(wh.timezone), "hele dag: middernacht UTC, minstens één dag");
        AgendaEvent bad = s.copy();
        bad.tz = "Geen/Zone";
        T.eq("UTC", AndroidAgenda.toWrite(bad, null).timezone, "onbekende tijdzone: UTC");
    }

    static void input() {
        T.throwsWith("titel", () -> AndroidAgenda.fromInput("  ", null, null, false, 0, 1, "Europe/Amsterdam", "", null, -1), "titel verplicht");
        T.throwsWith("vóór het begin", () -> AndroidAgenda.fromInput("x", null, null, false, 10, 5, "Europe/Amsterdam", "", null, -1), "einde vóór begin");
        T.throwsWith("middernacht", () -> AndroidAgenda.fromInput("x", null, null, true, 10, DAY, null, "", null, -1), "hele dag op middernacht");
        T.throwsWith("40 dagen", () -> AndroidAgenda.fromInput("x", null, null, false, 0, 1, null, "", null, 100_000), "herinnering te ver vooraf");
        AgendaEvent e = AndroidAgenda.fromInput(" Etentje ", " ", " Bij Jan ", false, 0, 3_600_000L, "Europe/Amsterdam", "WEEKLY", null, 30);
        T.eq("Etentje", e.title, "titel getrimd");
        T.eq(null, e.description, "lege beschrijving");
        T.eq("Bij Jan", e.location, "plaats");
        T.eq("FREQ=WEEKLY", e.rrule, "elke week");
        T.eq(List.of(30), e.reminders, "herinnering");
        AgendaEvent h = AndroidAgenda.fromInput("Vrij", null, null, true, day(2026, 5, 1), day(2026, 5, 1), null, "", null, -1);
        T.eq(day(2026, 5, 2), h.end, "hele dag zonder einde: één dag");
        AgendaEvent keep = AndroidAgenda.fromInput("x", null, null, false, 0, 1, null, "KEEP", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1", -1);
        T.eq("FREQ=MONTHLY;BYMONTHDAY=-1", keep.rrule, "bestaande regel blijft");
        T.eq("WEEKLY", AndroidAgenda.repeatOf("FREQ=WEEKLY;WKST=MO"), "WKST telt niet");
        T.eq("DAILY", AndroidAgenda.repeatOf("RRULE:FREQ=DAILY;INTERVAL=1"), "INTERVAL=1 telt niet");
        T.eq("CUSTOM", AndroidAgenda.repeatOf("FREQ=WEEKLY;BYDAY=MO,WE"), "andere regel");
        T.eq("", AndroidAgenda.repeatOf(null), "geen");
    }

    static AgendaEvent ev(String uid, String title, long start, long end) {
        AgendaEvent e = new AgendaEvent();
        e.uid = uid; e.title = title; e.start = start; e.end = end; e.tz = "Europe/Amsterdam";
        return e;
    }

    static void restorePlan() {
        AgendaEvent a = ev("a", "Tandarts", ams(2026, 3, 1, 9, 0), ams(2026, 3, 1, 9, 30));
        AgendaEvent b = ev("b", "Verjaardag", ams(2026, 4, 1, 18, 0), ams(2026, 4, 1, 22, 0));
        AgendaEvent c = ev("c", "Weg", ams(2026, 5, 1, 9, 0), ams(2026, 5, 1, 10, 0));
        AgendaEvent d = ev("d", "Teruggezet eerder", ams(2026, 6, 1, 9, 0), ams(2026, 6, 1, 10, 0));
        AgendaEvent r = ev("r", "Reeks", ams(2026, 1, 5, 9, 0), ams(2026, 1, 5, 9, 15));
        r.rrule = "FREQ=WEEKLY;BYDAY=MO;WKST=MO";
        r.exdates.add(ams(2026, 1, 12, 9, 0));
        AgendaEvent ro = ev("r", "Reeks (verplaatst)", ams(2026, 1, 20, 9, 0), ams(2026, 1, 20, 9, 15));
        ro.recurrenceId = ams(2026, 1, 19, 9, 0);
        List<AgendaEvent> backup = List.of(a, b, c, d, r, ro);

        AgendaEvent a2 = a.copy();
        AgendaEvent b2 = b.copy(); b2.title = "Verjaardag Piet";
        AgendaEvent d2 = d.copy(); d2.uid = "nieuwe-uid@google.com"; d2.localId = 42;
        AgendaEvent r2 = r.copy(); r2.rrule = "WKST=MO;BYDAY=MO;FREQ=WEEKLY"; r2.exdates.clear();
        r2.exdates.add(ams(2026, 1, 19, 9, 0)); r2.exdates.add(ams(2026, 1, 12, 9, 0));  // na terugzetten: losse herhaling als EXDATE…
        AgendaEvent ro2 = ro.copy(); ro2.uid = "los@google.com"; ro2.recurrenceId = null; // …en als losse afspraak
        AgendaEvent extra = ev("e", "Nieuw", ams(2026, 7, 1, 9, 0), ams(2026, 7, 1, 10, 0));
        Restore.Plan p = Restore.plan(backup, List.of(a2, b2, d2, r2, ro2, extra));
        T.eq(List.of(c), p.missing, "ontbreekt: c");
        T.eq(1, p.changed.size(), "één anders");
        T.check(p.changed.size() == 1 && p.changed.get(0).backup == b && p.changed.get(0).current == b2, "b is anders");
        T.eq("titel", p.changed.isEmpty() ? null : Restore.difference(p.changed.get(0)), "wat er anders is");
        T.eq(4, p.same.size(), "gelijk: a, d (op titel+begin), reeks (RRULE in andere volgorde, losse herhaling als EXDATE), losse herhaling");
        T.eq(List.of(extra), p.onlyCurrent, "alleen in de agenda: blijft staan");

        AgendaEvent a3 = a.copy(); a3.reminders.add(10);
        AgendaEvent a4 = a.copy(); a4.location = "Elders";
        AgendaEvent a5 = a.copy(); a5.end += 60_000;
        AgendaEvent a6 = a.copy(); a6.title = "(zonder titel)";
        AgendaEvent a7 = a.copy(); a7.title = "";
        T.eq("herinnering", Restore.difference(Restore.plan(List.of(a), List.of(a3)).changed.get(0)), "herinnering anders");
        T.eq("plaats", Restore.difference(Restore.plan(List.of(a), List.of(a4)).changed.get(0)), "plaats anders");
        T.eq("tijd", Restore.difference(Restore.plan(List.of(a), List.of(a5)).changed.get(0)), "tijd anders");
        T.eq(1, Restore.plan(List.of(a6), List.of(a7)).same.size(), "lege titel = (zonder titel)");
        T.eq(1, Restore.plan(List.of(), List.of(a)).onlyCurrent.size(), "lege kopie: niets terug");
        // Twee gelijke afspraken in de kopie, één in de agenda: één ontbreekt.
        AgendaEvent twin = a.copy(); twin.uid = "a-tweeling";
        T.eq(1, Restore.plan(List.of(a, twin), List.of(a2)).missing.size(), "tweeling: één ontbreekt");
    }

    static void store() throws Exception {
        File root = Files.createTempDirectory("agenda-kopie").toFile();
        try {
            BackupStore s = new BackupStore(root);
            String key = BackupStore.keyFor("rene@example.com", "Werk");
            T.eq(key, BackupStore.keyFor("rene@example.com", "Werk"), "vaste sleutel");
            T.check(!key.equals(BackupStore.keyFor("rene@example.com", "Privé")), "andere agenda, andere sleutel");
            long t0 = LocalDateTime.of(2026, 10, 1, 7, 0).toInstant(ZoneOffset.UTC).toEpochMilli();
            BackupStore.Saved a = s.save(key, "Werk", "rene@example.com", "ICS-1", 3, t0, 3);
            T.eq("20261001-070000.ics", a.file, "bestandsnaam = tijd");
            T.check(!a.unchanged, "eerste kopie");
            BackupStore.Saved same = s.save(key, "Werk", "rene@example.com", "ICS-1", 3, t0 + DAY, 3);
            T.check(same.unchanged && same.file.equals(a.file), "zelfde inhoud: niet opnieuw bewaard");
            s.save(key, "Werk", "rene@example.com", "ICS-2", 4, t0 + DAY, 3);
            BackupStore.Saved sameSecond = s.save(key, "Werk", "rene@example.com", "ICS-3", 5, t0 + DAY, 3);
            T.eq("20261002-070000-1.ics", sameSecond.file, "zelfde seconde: volgnummer");
            s.save(key, "Werk", "rene@example.com", "ICS-4", 6, t0 + 2 * DAY, 3);
            s.save(BackupStore.keyFor("rene@example.com", "Privé"), "Privé", "rene@example.com", "P-1", 1, t0, 3);
            List<BackupStore.Cal> list = s.list();
            T.eq(2, list.size(), "twee agenda's");
            T.eq("Privé", list.get(0).name, "op naam gesorteerd");
            BackupStore.Cal werk = list.get(1);
            T.eq(3, werk.copies.size(), "hooguit 3 kopieën bewaard");
            T.eq("20261003-070000.ics", werk.copies.get(0).file, "nieuwste eerst");
            T.eq("20261002-070000-1.ics", werk.copies.get(1).file, "volgnummer telt mee in de volgorde");
            T.eq(6, werk.copies.get(0).events, "aantal afspraken bewaard");
            T.eq("ICS-4", s.read(key, werk.copies.get(0).file), "lezen");
            T.throwsWith("Onbekende", () -> s.read(key, "../../etc/passwd"), "geen pad buiten de map");
            T.throwsWith("Onbekende", () -> s.read("../x", "20261003-070000.ics"), "geen vreemde sleutel");
            T.eq(4, s.count(), "vier kopieën in totaal");
            T.check(s.bytes() > 0, "ruimte geteld");
            T.eq(2, s.prune(1), "vrijmaken: alleen de nieuwste per agenda");
            T.eq(1, s.list().get(1).copies.size(), "één over");
            T.eq(6, s.list().get(1).copies.get(0).events, "telling blijft bij het overgebleven bestand");
        } finally {
            deleteTree(root);
        }
    }

    /** Volledige ronde zoals de app hem doet. */
    static void roundTrip() throws Exception {
        // Telefoon: een reeks met geschrapte en verplaatste herhaling, een losse afspraak en een hele dag.
        List<AndroidAgenda.Row> phone = new ArrayList<>();
        AndroidAgenda.Row series = row(1, "Stand-up", ams(2026, 9, 7, 9, 0), null);
        series.dtend = null; series.duration = "P900S"; series.rrule = "FREQ=WEEKLY;BYDAY=MO"; series.syncId = "s1"; series.exdate = "20260914T070000Z";
        phone.add(series);
        AndroidAgenda.Row moved = row(2, "Stand-up (dinsdag)", ams(2026, 9, 22, 9, 0), ams(2026, 9, 22, 9, 15));
        moved.originalId = 1L; moved.originalInstanceTime = ams(2026, 9, 21, 9, 0); moved.syncId = "s1_20260921";
        phone.add(moved);
        AndroidAgenda.Row single = row(3, "Tandarts", ams(2026, 10, 20, 8, 30), ams(2026, 10, 20, 9, 0));
        single.syncId = "s2"; single.description = "Controle\nmet foto's";
        phone.add(single);
        AndroidAgenda.Row free = row(4, "Herfstvakantie", day(2026, 10, 24), day(2026, 11, 2));
        free.allDay = true; free.timezone = "UTC"; free.syncId = "s3";
        phone.add(free);
        Map<Long, List<Integer>> rem = new HashMap<>();
        rem.put(3L, new ArrayList<>(List.of(60)));
        long now = ams(2026, 10, 13, 9, 0);
        List<AgendaEvent> before = AndroidAgenda.toEvents(phone, rem, AndroidAgenda.cutoff(now, 12));
        String ics = Ics.write("Werk", before);

        // De kopie teruglezen; de agenda is intussen leeg geraakt (bijv. per ongeluk een account verwijderd).
        List<AgendaEvent> backup = Ics.parse(ics, AMS).events;
        Restore.Plan p = Restore.plan(backup, List.of());
        T.eq(4, p.missing.size(), "alles ontbreekt");

        // Terugzetten zoals de app: hoofdafspraken met de tijdstippen van verplaatste herhalingen als EXDATE,
        // verplaatste herhalingen als losse afspraak. Android geeft nieuwe rij-id's en (na synchronisatie) nieuwe UID's.
        Map<String, List<Long>> overrides = new HashMap<>();
        for (AgendaEvent e : p.missing) if (e.recurrenceId != null) overrides.computeIfAbsent(e.uid, k -> new ArrayList<>()).add(e.recurrenceId);
        List<AndroidAgenda.Row> restored = new ArrayList<>();
        Map<Long, List<Integer>> restoredRem = new HashMap<>();
        long id = 100;
        for (AgendaEvent e : p.missing) {
            AndroidAgenda.Write w = AndroidAgenda.toWrite(e, e.recurrenceId == null ? overrides.get(e.uid) : null);
            AndroidAgenda.Row r = new AndroidAgenda.Row();
            r.id = ++id; r.calendarId = 7; r.accountType = "com.google"; r.syncId = "nieuw" + id; r.title = w.title; r.description = w.description; r.location = w.location;
            r.dtstart = w.dtstart; r.dtend = w.dtend; r.duration = w.duration; r.allDay = w.allDay; r.timezone = w.timezone; r.rrule = w.rrule; r.exdate = w.exdate;
            restored.add(r);
            if (!w.reminders.isEmpty()) restoredRem.put(r.id, new ArrayList<>(w.reminders));
        }
        List<AgendaEvent> after = AndroidAgenda.toEvents(restored, restoredRem, AndroidAgenda.cutoff(now, 12));
        Restore.Plan again = Restore.plan(backup, after);
        T.eq(0, again.missing.size(), "na terugzetten ontbreekt niets: " + again.missing);
        T.eq(0, again.changed.size(), "na terugzetten is niets anders: " + (again.changed.isEmpty() ? "" : Restore.difference(again.changed.get(0)) + " " + again.changed.get(0).backup + " / " + again.changed.get(0).current));
        T.eq(4, again.same.size(), "alles gelijk");
        T.eq(0, again.onlyCurrent.size(), "niets extra");
        // En een nieuwe kopie van de teruggezette agenda leest de cloud net zo (zelfde afspraken op dezelfde tijden).
        List<AgendaEvent> reread = Ics.parse(Ics.write("Werk", after), AMS).events;
        T.eq(4, Restore.plan(backup, reread).same.size(), "kopie van de teruggezette agenda = oorspronkelijke kopie");
    }

    static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File x : fs) deleteTree(x);
        f.delete();
    }
}
