package nl.eigencloud.core.agenda;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * Vergelijkt een reservekopie met wat er nu in een agenda staat: wat ontbreekt, wat is anders, wat is gelijk, en wat
 * staat alleen in de agenda (nieuw sinds de kopie; dat blijft altijd staan). Afspraken worden gekoppeld op UID (en
 * bij een losse herhaling ook het tijdstip); lukt dat niet, dan op titel + begin + hele dag. Zo worden ook
 * afspraken herkend die eerder zijn teruggezet (de agenda geeft ze dan een nieuwe UID).
 */
public final class Restore {
    private Restore() {}

    public static final class Change {
        public final AgendaEvent backup;
        public final AgendaEvent current;

        Change(AgendaEvent backup, AgendaEvent current) { this.backup = backup; this.current = current; }
    }

    public static final class Plan {
        /** In de kopie, niet in de agenda: terugzetten. */
        public final List<AgendaEvent> missing = new ArrayList<>();
        /** In beide, maar anders. */
        public final List<Change> changed = new ArrayList<>();
        public final List<AgendaEvent> same = new ArrayList<>();
        /** Alleen in de agenda. */
        public final List<AgendaEvent> onlyCurrent = new ArrayList<>();
    }

    public static Plan plan(List<AgendaEvent> backup, List<AgendaEvent> current) {
        Plan p = new Plan();
        Map<String, List<AgendaEvent>> byKey = new HashMap<>();
        Map<String, List<AgendaEvent>> byPrint = new HashMap<>();
        for (AgendaEvent c : current) {
            if (c.uid != null) byKey.computeIfAbsent(c.key(), k -> new ArrayList<>()).add(c);
            byPrint.computeIfAbsent(fingerprint(c), k -> new ArrayList<>()).add(c);
        }
        Map<String, Set<Long>> backupOverrides = overrideTimes(backup);
        Map<String, Set<Long>> currentOverrides = overrideTimes(current);
        Map<AgendaEvent, Boolean> used = new IdentityHashMap<>();
        for (AgendaEvent b : backup) {
            AgendaEvent match = take(byKey.get(b.key()), used);
            if (match == null) match = take(byPrint.get(fingerprint(b)), used);
            if (match == null) { p.missing.add(b); continue; }
            used.put(match, Boolean.TRUE);
            if (sameContent(b, match, backupOverrides.get(b.uid), currentOverrides.get(match.uid))) p.same.add(b);
            else p.changed.add(new Change(b, match));
        }
        for (AgendaEvent c : current) if (!used.containsKey(c)) p.onlyCurrent.add(c);
        return p;
    }

    private static AgendaEvent take(List<AgendaEvent> list, Map<AgendaEvent, Boolean> used) {
        if (list == null) return null;
        for (AgendaEvent e : list) if (!used.containsKey(e)) return e;
        return null;
    }

    /** Tijdstippen van gewijzigde losse herhalingen per UID: die tellen als geschrapt in de reeks zelf. */
    static Map<String, Set<Long>> overrideTimes(List<AgendaEvent> events) {
        Map<String, Set<Long>> m = new HashMap<>();
        for (AgendaEvent e : events) if (e.recurrenceId != null && e.uid != null) m.computeIfAbsent(e.uid, k -> new HashSet<>()).add(e.recurrenceId);
        return m;
    }

    static String fingerprint(AgendaEvent e) {
        return normTitle(e.title) + "\u0000" + e.start + "\u0000" + e.allDay;
    }

    static String normTitle(String t) {
        String s = t == null ? "" : t.trim();
        return s.equals("(zonder titel)") ? "" : s;
    }

    static String norm(String s) {
        if (s == null) return "";
        return s.replace("\r\n", "\n").trim();
    }

    /** RRULE-onderdelen gesorteerd, zodat "FREQ=WEEKLY;BYDAY=MO" en "BYDAY=MO;FREQ=WEEKLY" gelijk zijn. */
    static String normRule(String r) {
        if (r == null || r.trim().isEmpty()) return "";
        TreeSet<String> parts = new TreeSet<>();
        for (String p : Ics.stripRrule(r).toUpperCase(Locale.ROOT).split(";")) if (!p.isEmpty() && !p.equals("INTERVAL=1")) parts.add(p);
        return String.join(";", parts);
    }

    static boolean sameContent(AgendaEvent a, AgendaEvent b, Set<Long> overridesA, Set<Long> overridesB) {
        if (!normTitle(a.title).equals(normTitle(b.title))) return false;
        if (!norm(a.description).equals(norm(b.description)) || !norm(a.location).equals(norm(b.location))) return false;
        if (a.start != b.start || a.end != b.end || a.allDay != b.allDay) return false;
        if (!normRule(a.rrule).equals(normRule(b.rrule))) return false;
        if (!a.allDay && !normRule(a.rrule).isEmpty() && !Objects.equals(zoneOrUtc(a.tz), zoneOrUtc(b.tz))) return false;
        Set<Long> exA = new TreeSet<>(a.exdates), exB = new TreeSet<>(b.exdates);
        if (a.recurring() && overridesA != null) exA.addAll(overridesA);
        if (b.recurring() && overridesB != null) exB.addAll(overridesB);
        if (!exA.equals(exB)) return false;
        return new TreeSet<>(a.reminders).equals(new TreeSet<>(b.reminders));
    }

    private static String zoneOrUtc(String tz) { return tz == null || tz.isEmpty() ? "UTC" : tz; }

    /** Korte beschrijving van wat er anders is, voor op het scherm. */
    public static String difference(Change c) {
        AgendaEvent a = c.backup, b = c.current;
        List<String> what = new ArrayList<>();
        if (!normTitle(a.title).equals(normTitle(b.title))) what.add("titel");
        if (a.start != b.start || a.end != b.end || a.allDay != b.allDay) what.add("tijd");
        if (!norm(a.location).equals(norm(b.location))) what.add("plaats");
        if (!norm(a.description).equals(norm(b.description))) what.add("beschrijving");
        if (!normRule(a.rrule).equals(normRule(b.rrule)) || !new TreeSet<>(a.exdates).equals(new TreeSet<>(b.exdates))) what.add("herhaling");
        if (!new TreeSet<>(a.reminders).equals(new TreeSet<>(b.reminders))) what.add("herinnering");
        return what.isEmpty() ? "details" : String.join(", ", what);
    }
}
