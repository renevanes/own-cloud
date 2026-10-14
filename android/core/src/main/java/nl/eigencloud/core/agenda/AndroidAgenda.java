package nl.eigencloud.core.agenda;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

/**
 * Vertaling tussen de agenda-opslag van Android (CalendarContract.Events) en {@link AgendaEvent}, zonder
 * Android-code: de app vult {@link Row}s uit een Cursor en zet een {@link Write} in ContentValues.
 *
 * <p>Formaten zoals Android ze gebruikt: DURATION als "P3600S" of "P1D" (verplicht bij een herhaling, dan geen
 * DTEND), EXDATE als door komma's gescheiden tijden ("20250101T090000Z", of "Europe/Amsterdam;20250101T090000",
 * of "20250101" bij hele dagen; meerdere regels met "\n"). Hele dagen staan op middernacht UTC met tijdzone UTC.
 */
public final class AndroidAgenda {
    private AndroidAgenda() {}

    static final long DAY = 86_400_000L;

    /** Eén rij uit CalendarContract.Events (alleen wat we nodig hebben). */
    public static final class Row {
        public long id;
        public long calendarId;
        public String accountType;
        public String uid2445;
        public String syncId;
        public String title;
        public String description;
        public String location;
        public Long dtstart;
        public Long dtend;
        public String duration;
        public boolean allDay;
        public String timezone;
        public String rrule;
        public String exdate;
        public Long originalId;
        public String originalSyncId;
        public Long originalInstanceTime;
        /** CalendarContract.Events.STATUS: 0 voorlopig, 1 bevestigd, 2 geannuleerd. */
        public Integer status;
        /** CalendarContract.Events.LAST_DATE: einde van de laatste herhaling, null = gaat altijd door. */
        public Long lastDate;
    }

    /** Wat er in ContentValues moet bij invoegen of bijwerken. Precies één van {@link #dtend} en {@link #duration} is gezet. */
    public static final class Write {
        public long dtstart;
        public Long dtend;
        public String duration;
        public String timezone;
        public boolean allDay;
        public String rrule;
        public String exdate;
        public String title;
        public String description;
        public String location;
        public final List<Integer> reminders = new ArrayList<>();
    }

    // ───────── Formaten ─────────

    /** "P3600S", "PT1H", "P1D", "P2W" → ms; null als het niet te lezen is. */
    public static Long parseDuration(String d) { return Ics.durationMs(d); }

    /** Duur zoals Android hem schrijft: hele dagen "P2D", anders "P5400S". */
    public static String formatDuration(long ms, boolean allDay) {
        long v = Math.max(0, ms);
        if (allDay && v % DAY == 0) return "P" + (v / DAY) + "D";
        return "P" + (v / 1000) + "S";
    }

    /** EXDATE-tekst van Android → tijdstippen (ms). Onleesbare delen worden overgeslagen. */
    public static List<Long> parseExdates(String s) {
        List<Long> out = new ArrayList<>();
        if (s == null || s.trim().isEmpty()) return out;
        for (String line : s.split("\n")) {
            String l = line.trim();
            if (l.isEmpty()) continue;
            ZoneId zone = ZoneOffset.UTC;
            int semi = l.indexOf(';');
            if (semi >= 0) {
                ZoneId z = Ics.zone(l.substring(0, semi).trim());
                if (z != null) zone = z;
                l = l.substring(semi + 1);
            }
            for (String part : l.split(",")) {
                Long ms = parseStamp(part.trim(), zone);
                if (ms != null && !out.contains(ms)) out.add(ms);
            }
        }
        return out;
    }

    static Long parseStamp(String v, ZoneId zone) {
        try {
            if (v.length() == 8) return LocalDate.of(Integer.parseInt(v.substring(0, 4)), Integer.parseInt(v.substring(4, 6)), Integer.parseInt(v.substring(6, 8)))
                    .atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
            if (v.length() < 15 || v.charAt(8) != 'T') return null;
            LocalDateTime l = LocalDateTime.of(Integer.parseInt(v.substring(0, 4)), Integer.parseInt(v.substring(4, 6)), Integer.parseInt(v.substring(6, 8)),
                    Integer.parseInt(v.substring(9, 11)), Integer.parseInt(v.substring(11, 13)), Integer.parseInt(v.substring(13, 15)));
            boolean utc = v.length() > 15 && (v.charAt(15) == 'Z' || v.charAt(15) == 'z');
            return l.atZone(utc ? ZoneOffset.UTC : zone).toInstant().toEpochMilli();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Tijdstippen → EXDATE-tekst voor Android ("20250101T090000Z,..."; hele dagen "20250101,..."). */
    public static String formatExdates(Collection<Long> times, boolean allDay) {
        if (times == null || times.isEmpty()) return null;
        StringBuilder b = new StringBuilder();
        for (Long t : new TreeSet<>(times)) {
            if (b.length() > 0) b.append(',');
            b.append(allDay ? Ics.dateStamp(t) : Ics.utcStamp(t));
        }
        return b.toString();
    }

    // ───────── Telefoon → afspraak ─────────

    /** Begin van het venster: "de afgelopen {@code months} maanden" vanaf {@code now} (0 of minder = alles). */
    public static long cutoff(long now, int months) {
        if (months <= 0) return Long.MIN_VALUE;
        return Instant.ofEpochMilli(now).atZone(ZoneOffset.UTC).minusMonths(months).toInstant().toEpochMilli();
    }

    static long endOf(Row r) {
        if (r.dtend != null) return r.dtend;
        Long d = parseDuration(r.duration);
        long start = r.dtstart == null ? 0 : r.dtstart;
        return start + (d != null ? d : (r.allDay ? DAY : 0));
    }

    /** Valt deze hoofdafspraak (of losse afspraak) in het venster van de reservekopie? */
    public static boolean inWindow(Row r, long cutoff) {
        if (cutoff == Long.MIN_VALUE) return true;
        boolean recurring = r.rrule != null && !r.rrule.trim().isEmpty();
        if (recurring) return r.lastDate == null || r.lastDate >= cutoff;
        return endOf(r) >= cutoff;
    }

    /** Vaste UID voor een rij: de iCalendar-UID als de agenda die kent, anders afgeleid van de synchronisatie-id of de rij. */
    public static String uidFor(Row r) {
        if (r.uid2445 != null && !r.uid2445.trim().isEmpty()) return r.uid2445.trim();
        if (r.syncId != null && !r.syncId.trim().isEmpty()) {
            String s = r.syncId.trim();
            if (s.contains("@")) return s;
            return s + ("com.google".equals(r.accountType) ? "@google.com" : "@sync.telefoon");
        }
        return "telefoon-" + r.calendarId + "-" + r.id + "@eigen-cloud";
    }

    /**
     * Rijen van één agenda → afspraken voor een reservekopie. Gewijzigde losse herhalingen worden een afspraak met
     * {@code recurrenceId}; geannuleerde losse herhalingen gaan in EXDATE van de hoofdafspraak. Afspraken buiten het
     * venster (zie {@link #cutoff}) en geannuleerde hoofdafspraken vallen weg.
     */
    public static List<AgendaEvent> toEvents(List<Row> rows, Map<Long, List<Integer>> reminders, long cutoff) {
        Map<Long, AgendaEvent> byId = new HashMap<>();
        Map<String, AgendaEvent> bySync = new HashMap<>();
        List<AgendaEvent> out = new ArrayList<>();
        for (Row r : rows) {
            if (r.originalId != null || (r.originalSyncId != null && !r.originalSyncId.isEmpty())) continue;
            if (r.dtstart == null) continue;
            if (r.status != null && r.status == 2) continue;
            if (!inWindow(r, cutoff)) continue;
            AgendaEvent e = base(r, reminders);
            e.uid = uidFor(r);
            if (r.rrule != null && !r.rrule.trim().isEmpty()) e.rrule = Ics.stripRrule(r.rrule);
            for (Long x : parseExdates(r.exdate)) if (!e.exdates.contains(x)) e.exdates.add(x);
            byId.put(r.id, e);
            if (r.syncId != null && !r.syncId.isEmpty()) bySync.put(r.syncId, e);
            out.add(e);
        }
        for (Row r : rows) {
            if (r.originalId == null && (r.originalSyncId == null || r.originalSyncId.isEmpty())) continue;
            AgendaEvent master = r.originalId != null ? byId.get(r.originalId) : null;
            if (master == null && r.originalSyncId != null) master = bySync.get(r.originalSyncId);
            if (master == null || r.originalInstanceTime == null) continue;
            if (r.status != null && r.status == 2) {
                if (!master.exdates.contains(r.originalInstanceTime)) master.exdates.add(r.originalInstanceTime);
                continue;
            }
            if (r.dtstart == null) continue;
            AgendaEvent e = base(r, reminders);
            e.uid = master.uid;
            e.recurrenceId = r.originalInstanceTime;
            out.add(e);
        }
        for (AgendaEvent e : out) java.util.Collections.sort(e.exdates);
        return out;
    }

    private static AgendaEvent base(Row r, Map<Long, List<Integer>> reminders) {
        AgendaEvent e = new AgendaEvent();
        e.localId = r.id;
        e.title = r.title == null ? "" : r.title;
        e.description = r.description == null || r.description.isEmpty() ? null : r.description;
        e.location = r.location == null || r.location.isEmpty() ? null : r.location;
        e.allDay = r.allDay;
        e.start = r.dtstart;
        e.end = Math.max(e.start, endOf(r));
        if (!e.allDay && r.timezone != null && !r.timezone.isEmpty()) {
            ZoneId z = Ics.zone(r.timezone);
            e.tz = z == null ? null : Ics.zoneName(z);
        }
        List<Integer> rem = reminders == null ? null : reminders.get(r.id);
        if (rem != null) for (Integer m : rem) if (m != null && m >= 0 && !e.reminders.contains(m)) e.reminders.add(m);
        java.util.Collections.sort(e.reminders);
        return e;
    }

    // ───────── Afspraak → telefoon ─────────

    /**
     * Wat er naar de agenda-opslag gaat voor deze afspraak. {@code extraExdates} komen bij de geschrapte herhalingen
     * (bij terugzetten: de tijdstippen van gewijzigde losse herhalingen, die als eigen afspraak terugkomen).
     */
    public static Write toWrite(AgendaEvent e, Collection<Long> extraExdates) {
        Write w = new Write();
        w.allDay = e.allDay;
        long start = e.start, end = Math.max(e.end, e.start);
        if (e.allDay) {
            start = Math.floorDiv(start, DAY) * DAY;
            end = Math.max(start + DAY, ((end + DAY - 1) / DAY) * DAY);
            w.timezone = "UTC";
        } else {
            w.timezone = e.tz != null && Ics.zone(e.tz) != null ? e.tz : "UTC";
        }
        w.dtstart = start;
        if (e.recurring() && e.recurrenceId == null) {
            w.rrule = Ics.stripRrule(e.rrule);
            w.duration = formatDuration(end - start, e.allDay);
            List<Long> ex = new ArrayList<>(e.exdates);
            if (extraExdates != null) for (Long x : extraExdates) if (!ex.contains(x)) ex.add(x);
            w.exdate = formatExdates(ex, e.allDay);
        } else {
            w.dtend = end;
        }
        w.title = e.title == null ? "" : e.title;
        w.description = e.description;
        w.location = e.location;
        w.reminders.addAll(e.reminders);
        return w;
    }

    /** Herhaling zoals in het formulier te kiezen. */
    public static String rruleFor(String repeat) {
        switch (repeat == null ? "" : repeat.toUpperCase(Locale.ROOT)) {
            case "DAILY": return "FREQ=DAILY";
            case "WEEKLY": return "FREQ=WEEKLY";
            case "MONTHLY": return "FREQ=MONTHLY";
            case "YEARLY": return "FREQ=YEARLY";
            default: return null;
        }
    }

    /** Welke keuze uit het formulier past bij deze regel ("" = niet, "CUSTOM" = iets anders dat we laten staan). */
    public static String repeatOf(String rrule) {
        if (rrule == null || rrule.trim().isEmpty()) return "";
        String r = Ics.stripRrule(rrule).toUpperCase(Locale.ROOT);
        for (String f : new String[]{"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}) {
            String rest = r.replace("FREQ=" + f, "").replaceAll("(^|;)WKST=[A-Z]{2}", "").replaceAll("(^|;)INTERVAL=1(?=;|$)", "").replace(";", "");
            if (r.contains("FREQ=" + f) && rest.isEmpty()) return f;
        }
        return "CUSTOM";
    }

    /**
     * Invoer uit het formulier → afspraak, met controle. Begin en einde: ms (hele dag: middernacht UTC, einde
     * exclusief). {@code repeat}: "", DAILY, WEEKLY, MONTHLY, YEARLY of KEEP (bestaande regel {@code keepRrule}).
     * {@code reminder}: minuten, of negatief voor geen.
     */
    public static AgendaEvent fromInput(String title, String description, String location, boolean allDay, long start, long end,
                                        String tz, String repeat, String keepRrule, int reminder) {
        String t = title == null ? "" : title.trim();
        if (t.isEmpty()) throw new IllegalArgumentException("Vul een titel in");
        if (t.length() > 500) throw new IllegalArgumentException("De titel is te lang");
        if (end < start) throw new IllegalArgumentException("Het einde ligt vóór het begin");
        if (allDay && (start % DAY != 0 || end % DAY != 0)) throw new IllegalArgumentException("Een hele dag begint en eindigt om middernacht");
        if (allDay && end == start) end = start + DAY;
        if (end - start > 366L * DAY * 5) throw new IllegalArgumentException("Een afspraak kan hooguit vijf jaar duren");
        AgendaEvent e = new AgendaEvent();
        e.title = t;
        e.description = description == null || description.trim().isEmpty() ? null : description;
        e.location = location == null || location.trim().isEmpty() ? null : location.trim();
        e.allDay = allDay;
        e.start = start;
        e.end = end;
        e.tz = allDay ? null : tz;
        e.rrule = "KEEP".equalsIgnoreCase(repeat) ? (keepRrule == null || keepRrule.isEmpty() ? null : Ics.stripRrule(keepRrule)) : rruleFor(repeat);
        if (reminder >= 0) {
            if (reminder > 40 * 24 * 60) throw new IllegalArgumentException("Een herinnering kan hooguit 40 dagen vooraf");
            e.reminders.add(reminder);
        }
        return e;
    }
}
