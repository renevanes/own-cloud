package nl.eigencloud.core.agenda;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Eén afspraak, los van Android of de cloud. Tijden zijn milliseconden in UTC; een hele dag begint om middernacht
 * UTC (zoals in de cloud en in de agenda-opslag van Android). Een gewijzigde losse herhaling van een terugkerende
 * afspraak is een eigen {@code AgendaEvent} met dezelfde {@link #uid} en een {@link #recurrenceId}; een
 * geschrapte herhaling staat in {@link #exdates} van de hoofdafspraak.
 */
public final class AgendaEvent {
    /** UID uit iCalendar (zonder "#..."). */
    public String uid;
    /** Oorspronkelijk begin van de herhaling die deze afspraak vervangt; null voor een gewone of hoofdafspraak. */
    public Long recurrenceId;
    public String title = "";
    public String description;
    public String location;
    public long start;
    public long end;
    public boolean allDay;
    /** Tijdzone (IANA, bijv. Europe/Amsterdam) voor afspraken met een tijd; null = UTC. Niet gebruikt bij hele dagen. */
    public String tz;
    /** Herhaalregel zonder "RRULE:", of null. */
    public String rrule;
    /** Geschrapte herhalingen (begin in ms). */
    public final List<Long> exdates = new ArrayList<>();
    /** Herinneringen in minuten vóór het begin. */
    public final List<Integer> reminders = new ArrayList<>();
    /** Laatst gewijzigd (ms), of null. */
    public Long updated;
    /** Rij op de telefoon (CalendarContract.Events._ID); -1 als onbekend. Komt niet in een ICS-bestand. */
    public long localId = -1;

    /** Sleutel waarmee twee kopieën van dezelfde afspraak gevonden worden: UID, en bij een losse herhaling ook het tijdstip. */
    public String key() { return (uid == null ? "" : uid) + (recurrenceId != null ? "#" + recurrenceId : ""); }

    public boolean recurring() { return rrule != null && !rrule.isEmpty(); }

    public AgendaEvent copy() {
        AgendaEvent e = new AgendaEvent();
        e.uid = uid; e.recurrenceId = recurrenceId; e.title = title; e.description = description; e.location = location;
        e.start = start; e.end = end; e.allDay = allDay; e.tz = tz; e.rrule = rrule; e.updated = updated; e.localId = localId;
        e.exdates.addAll(exdates);
        e.reminders.addAll(reminders);
        return e;
    }

    @Override
    public String toString() {
        return "AgendaEvent{" + key() + " '" + title + "' " + start + "-" + end + (allDay ? " heledag" : "") + (tz != null ? " " + tz : "")
                + (rrule != null ? " " + rrule : "") + (exdates.isEmpty() ? "" : " ex" + exdates) + (reminders.isEmpty() ? "" : " rem" + reminders) + "}";
    }

    @Override
    public boolean equals(Object o) {
        if (!(o instanceof AgendaEvent)) return false;
        AgendaEvent e = (AgendaEvent) o;
        return Objects.equals(uid, e.uid) && Objects.equals(recurrenceId, e.recurrenceId) && Objects.equals(title, e.title)
                && Objects.equals(description, e.description) && Objects.equals(location, e.location) && start == e.start && end == e.end
                && allDay == e.allDay && Objects.equals(tz, e.tz) && Objects.equals(rrule, e.rrule) && exdates.equals(e.exdates)
                && reminders.equals(e.reminders);
    }

    @Override
    public int hashCode() { return Objects.hash(uid, recurrenceId, title, start, end); }
}
