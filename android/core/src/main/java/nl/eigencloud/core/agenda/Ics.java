package nl.eigencloud.core.agenda;

import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * iCalendar (RFC 5545) schrijven en lezen, zonder bibliotheken. Schrijven volgt {@code exportIcs} in
 * src/calendar/ics.ts regel voor regel (zelfde volgorde, escaping en vouwen op 74 bytes), zodat een reservekopie
 * van de telefoon ook in je cloud te importeren is. Lezen volgt {@code importIcs}: hele dagen, TZID, UTC en
 * zwevende tijden, RRULE, EXDATE, RECURRENCE-ID (gewijzigde en geschrapte losse herhalingen), DURATION en
 * VALARM-herinneringen.
 */
public final class Ics {
    private Ics() {}

    /** Resultaat van {@link #parse}. */
    public static final class Calendar {
        public String name;
        public final List<AgendaEvent> events = new ArrayList<>();
        /** Afspraken die niet te lezen waren of geannuleerd zijn. */
        public int skipped;
    }

    // ───────────── Schrijven ─────────────

    /** Eén agenda als .ics-tekst, met VTIMEZONE-blokken voor de gebruikte tijdzones (zie {@link #write(String, List, boolean)}). */
    public static String write(String name, List<AgendaEvent> events) { return write(name, events, true); }

    /**
     * Eén agenda als .ics-tekst (CRLF, gevouwen regels), zoals {@code exportIcs(events, name)}. Met
     * {@code timezones} komen er VTIMEZONE-blokken bij: zonder die blokken leest ical.js (de import van de cloud)
     * een tijd met TZID als "zwevend" en verschuift hij met de tijdzone van de server.
     */
    public static String write(String name, List<AgendaEvent> events, boolean timezones) {
        List<String> lines = new ArrayList<>();
        lines.add("BEGIN:VCALENDAR");
        lines.add("VERSION:2.0");
        lines.add("PRODID:-//eigen-cloud//NL");
        lines.add("X-WR-CALNAME:" + esc(name == null ? "Eigen Agenda" : name));
        lines.add("CALSCALE:GREGORIAN");
        if (timezones) {
            java.util.Set<String> done = new java.util.TreeSet<>();
            for (AgendaEvent e : events) if (!e.allDay && e.tz != null && zone(e.tz) != null) done.add(e.tz);
            for (String tz : done) lines.addAll(vtimezone(tz, zone(tz)));
        }
        for (AgendaEvent e : events) {
            lines.add("BEGIN:VEVENT");
            lines.add("UID:" + (e.uid == null ? "" : e.uid));
            lines.add("DTSTAMP:" + utcStamp(e.updated != null ? e.updated : e.start));
            if (e.recurrenceId != null) lines.add("RECURRENCE-ID:" + (e.allDay ? dateStamp(e.recurrenceId) : utcStamp(e.recurrenceId)));
            ZoneId zone = e.allDay ? null : zone(e.tz);
            if (e.allDay) {
                lines.add("DTSTART;VALUE=DATE:" + dateStamp(e.start));
                lines.add("DTEND;VALUE=DATE:" + dateStamp(e.end));
            } else if (zone != null && e.tz != null) {
                // Lokale tijd + TZID, zodat herhalingen correct over zomer-/wintertijd lopen.
                lines.add("DTSTART;TZID=" + e.tz + ":" + localStamp(e.start, zone));
                lines.add("DTEND;TZID=" + e.tz + ":" + localStamp(e.end, zone));
            } else {
                lines.add("DTSTART:" + utcStamp(e.start));
                lines.add("DTEND:" + utcStamp(e.end));
            }
            lines.add("SUMMARY:" + esc(e.title == null ? "" : e.title));
            if (e.description != null && !e.description.isEmpty()) lines.add("DESCRIPTION:" + esc(e.description));
            if (e.location != null && !e.location.isEmpty()) lines.add("LOCATION:" + esc(e.location));
            if (e.rrule != null && !e.rrule.isEmpty()) lines.add("RRULE:" + stripRrule(e.rrule));
            for (Long x : e.exdates) lines.add(e.allDay ? "EXDATE;VALUE=DATE:" + dateStamp(x) : "EXDATE:" + utcStamp(x));
            for (Integer m : e.reminders) {
                lines.add("BEGIN:VALARM");
                lines.add("ACTION:DISPLAY");
                lines.add("DESCRIPTION:" + esc(e.title == null ? "" : e.title));
                lines.add("TRIGGER:-PT" + m + "M");
                lines.add("END:VALARM");
            }
            lines.add("END:VEVENT");
        }
        lines.add("END:VCALENDAR");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) out.append("\r\n");
            out.append(fold(lines.get(i)));
        }
        return out.append("\r\n").toString();
    }

    /**
     * VTIMEZONE voor een tijdzone, met de huidige regels voor zomer- en wintertijd als RRULE (zoals Google en Outlook
     * die ook schrijven). Een zone zonder overgangen krijgt één STANDARD-blok met de huidige afwijking.
     */
    static List<String> vtimezone(String tzid, ZoneId zone) {
        List<String> l = new ArrayList<>();
        l.add("BEGIN:VTIMEZONE");
        l.add("TZID:" + tzid);
        java.time.zone.ZoneRules rules = zone.getRules();
        List<java.time.zone.ZoneOffsetTransitionRule> trs = rules.getTransitionRules();
        if (trs.isEmpty()) {
            ZoneOffset now = rules.getOffset(Instant.now());
            l.add("BEGIN:STANDARD");
            l.add("DTSTART:19700101T000000");
            l.add("TZOFFSETFROM:" + offset(now));
            l.add("TZOFFSETTO:" + offset(now));
            l.add("END:STANDARD");
        } else {
            for (java.time.zone.ZoneOffsetTransitionRule r : trs) {
                boolean standard = r.getOffsetAfter().equals(r.getStandardOffset());
                LocalDateTime before = r.createTransition(1970).getDateTimeBefore();
                String rule = "FREQ=YEARLY;BYMONTH=" + r.getMonth().getValue();
                int dom = r.getDayOfMonthIndicator();
                if (r.getDayOfWeek() == null) rule += ";BYMONTHDAY=" + dom;
                else {
                    String day = r.getDayOfWeek().name().substring(0, 2);
                    boolean lastWeek = dom == -1 || (dom > 0 && r.getMonth().minLength() == r.getMonth().maxLength() && dom + 6 == r.getMonth().maxLength());
                    if (lastWeek) rule += ";BYDAY=-1" + day;
                    else if (dom > 0 && (dom - 1) % 7 == 0) rule += ";BYDAY=" + ((dom - 1) / 7 + 1) + day;
                    else {
                        // "op of na dag dom" (of "op of vóór", negatief): een van de zeven dagen vanaf dom
                        List<String> days = new ArrayList<>();
                        for (int i = 0; i < 7; i++) days.add(String.valueOf(dom > 0 ? dom + i : dom - i));
                        rule += ";BYMONTHDAY=" + String.join(",", days) + ";BYDAY=" + day;
                    }
                }
                l.add(standard ? "BEGIN:STANDARD" : "BEGIN:DAYLIGHT");
                l.add("DTSTART:" + String.format(Locale.ROOT, "%04d%02d%02dT%02d%02d%02d", before.getYear(), before.getMonthValue(), before.getDayOfMonth(),
                        before.getHour(), before.getMinute(), before.getSecond()));
                l.add("RRULE:" + rule);
                l.add("TZOFFSETFROM:" + offset(r.getOffsetBefore()));
                l.add("TZOFFSETTO:" + offset(r.getOffsetAfter()));
                l.add(standard ? "END:STANDARD" : "END:DAYLIGHT");
            }
        }
        l.add("END:VTIMEZONE");
        return l;
    }

    static String offset(ZoneOffset o) {
        int s = o.getTotalSeconds(), a = Math.abs(s);
        return (s < 0 ? "-" : "+") + String.format(Locale.ROOT, "%02d%02d", a / 3600, (a / 60) % 60) + (a % 60 != 0 ? String.format(Locale.ROOT, "%02d", a % 60) : "");
    }

    static String esc(String s) {
        String t = s.replace("\r\n", "\n").replace("\r", "\n");
        return t.replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;");
    }

    private static int utf8Len(CharSequence s) { return s.toString().getBytes(StandardCharsets.UTF_8).length; }

    /** Vouwt een regel op 74 bytes (UTF-8), vervolgregels beginnen met een spatie. Splitst nooit een teken. */
    static String fold(String line) {
        List<String> out = new ArrayList<>();
        String rest = line;
        while (utf8Len(rest) > 74) {
            int cut = Math.min(74, rest.length());
            while (cut > 1 && utf8Len(rest.substring(0, cut)) > 74) cut--;
            if (cut > 1 && Character.isHighSurrogate(rest.charAt(cut - 1))) cut--;
            out.add(rest.substring(0, cut));
            rest = " " + rest.substring(cut);
        }
        out.add(rest);
        return String.join("\r\n", out);
    }

    /** "20250815T142000Z" */
    public static String utcStamp(long ms) {
        ZonedDateTime t = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC);
        return String.format(Locale.ROOT, "%04d%02d%02dT%02d%02d%02dZ", t.getYear(), t.getMonthValue(), t.getDayOfMonth(), t.getHour(), t.getMinute(), t.getSecond());
    }

    /** "20250815" (datum in UTC) */
    public static String dateStamp(long ms) {
        LocalDate d = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate();
        return String.format(Locale.ROOT, "%04d%02d%02d", d.getYear(), d.getMonthValue(), d.getDayOfMonth());
    }

    static String localStamp(long ms, ZoneId zone) {
        ZonedDateTime t = Instant.ofEpochMilli(ms).atZone(zone);
        return String.format(Locale.ROOT, "%04d%02d%02dT%02d%02d%02d", t.getYear(), t.getMonthValue(), t.getDayOfMonth(), t.getHour(), t.getMinute(), t.getSecond());
    }

    static String stripRrule(String r) {
        String s = r.trim();
        return s.regionMatches(true, 0, "RRULE:", 0, 6) ? s.substring(6) : s;
    }

    // ───────────── Lezen ─────────────

    /** Eén property-regel: naam, parameters (hoofdletters) en waarde. */
    static final class Prop {
        final String name;
        final Map<String, String> params;
        final String value;

        Prop(String name, Map<String, String> params, String value) { this.name = name; this.params = params; this.value = value; }

        String param(String k) { return params.get(k); }
    }

    /** Leest .ics-tekst. Zwevende tijden (zonder TZID of Z) gelden in {@code floating}. */
    public static Calendar parse(String text, ZoneId floating) {
        Calendar cal = new Calendar();
        List<String> lines = unfold(text);
        Map<String, ZoneId> vtz = new HashMap<>();
        ZoneId defaultZone = floating == null ? ZoneOffset.UTC : floating;

        // Eerste ronde: VTIMEZONE-blokken (voor TZID's die Java niet kent) en X-WR-TIMEZONE.
        String tzid = null;
        String offset = null;
        boolean inStandard = false;
        for (String l : lines) {
            Prop p = prop(l);
            if (p == null) continue;
            if (p.name.equals("X-WR-TIMEZONE")) { ZoneId z = zone(p.value.trim()); if (z != null && floating == null) defaultZone = z; }
            if (p.name.equals("BEGIN") && p.value.equalsIgnoreCase("VTIMEZONE")) { tzid = null; offset = null; }
            else if (p.name.equals("BEGIN") && p.value.equalsIgnoreCase("STANDARD")) inStandard = true;
            else if (p.name.equals("END") && p.value.equalsIgnoreCase("STANDARD")) inStandard = false;
            else if (p.name.equals("TZID") && tzid == null) tzid = unquote(p.value.trim());
            else if (p.name.equals("TZOFFSETTO") && (inStandard || offset == null)) offset = p.value.trim();
            else if (p.name.equals("END") && p.value.equalsIgnoreCase("VTIMEZONE") && tzid != null && offset != null) {
                try { vtz.put(tzid, ZoneOffset.of(offset.length() == 5 ? offset.substring(0, 3) + ":" + offset.substring(3) : offset)); } catch (DateTimeException e) { /* onbekende offset */ }
            }
        }

        List<Prop> ev = null;
        List<List<Prop>> alarms = null;
        List<Prop> alarm = null;
        List<String> stack = new ArrayList<>();
        List<AgendaEvent> cancelled = new ArrayList<>();
        for (String l : lines) {
            Prop p = prop(l);
            if (p == null) continue;
            if (p.name.equals("BEGIN")) {
                String what = p.value.trim().toUpperCase(Locale.ROOT);
                stack.add(what);
                if (what.equals("VEVENT") && ev == null) { ev = new ArrayList<>(); alarms = new ArrayList<>(); }
                else if (what.equals("VALARM") && ev != null) alarm = new ArrayList<>();
                continue;
            }
            if (p.name.equals("END")) {
                String what = p.value.trim().toUpperCase(Locale.ROOT);
                if (!stack.isEmpty()) stack.remove(stack.size() - 1);
                if (what.equals("VALARM") && alarm != null) { alarms.add(alarm); alarm = null; }
                else if (what.equals("VEVENT") && ev != null) {
                    AgendaEvent e = null;
                    boolean isCancelled = false;
                    try {
                        for (Prop x : ev) if (x.name.equals("STATUS") && x.value.trim().equalsIgnoreCase("CANCELLED")) isCancelled = true;
                        e = event(ev, alarms, vtz, defaultZone);
                    } catch (RuntimeException ex) {
                        e = null;
                    }
                    if (e == null) cal.skipped++;
                    else if (isCancelled && e.recurrenceId == null) cal.skipped++;
                    else if (isCancelled) { cancelled.add(e); cal.skipped++; }
                    else cal.events.add(e);
                    ev = null; alarms = null;
                }
                continue;
            }
            if (alarm != null) alarm.add(p);
            else if (ev != null && stack.size() >= 1 && stack.get(stack.size() - 1).equals("VEVENT")) ev.add(p);
            else if (ev == null && p.name.equals("X-WR-CALNAME")) cal.name = unesc(p.value);
        }
        // Geschrapte losse herhalingen horen bij de hoofdafspraak.
        Map<String, AgendaEvent> masters = new LinkedHashMap<>();
        for (AgendaEvent e : cal.events) if (e.recurrenceId == null) masters.put(e.uid, e);
        for (AgendaEvent c : cancelled) {
            AgendaEvent m = masters.get(c.uid);
            if (m != null && !m.exdates.contains(c.recurrenceId)) m.exdates.add(c.recurrenceId);
        }
        return cal;
    }

    private static AgendaEvent event(List<Prop> props, List<List<Prop>> alarms, Map<String, ZoneId> vtz, ZoneId floating) {
        Map<String, Prop> first = new HashMap<>();
        for (Prop p : props) first.putIfAbsent(p.name, p);
        Prop dtstart = first.get("DTSTART");
        if (dtstart == null) return null;
        Time s = time(dtstart, vtz, floating);
        if (s == null) return null;
        AgendaEvent e = new AgendaEvent();
        e.allDay = s.date;
        e.start = s.ms;
        Prop dtend = first.get("DTEND");
        Prop dur = first.get("DURATION");
        Time t = dtend != null ? time(dtend, vtz, floating) : null;
        if (t != null) e.end = t.ms;
        else if (dur != null && durationMs(dur.value) != null) e.end = e.start + durationMs(dur.value);
        else e.end = e.start + (e.allDay ? 86_400_000L : 3_600_000L);
        if (e.end < e.start) e.end = e.start;
        e.tz = e.allDay ? null : s.zone;

        Prop summary = first.get("SUMMARY");
        String title = summary == null ? "" : unesc(summary.value);
        e.title = title.isEmpty() ? "(zonder titel)" : title;
        Prop d = first.get("DESCRIPTION");
        if (d != null && !unesc(d.value).isEmpty()) e.description = unesc(d.value);
        Prop loc = first.get("LOCATION");
        if (loc != null && !unesc(loc.value).isEmpty()) e.location = unesc(loc.value);
        Prop uid = first.get("UID");
        e.uid = uid != null && !uid.value.trim().isEmpty() ? uid.value.trim()
                : UUID.nameUUIDFromBytes((e.title + "|" + e.start + "|" + e.end).getBytes(StandardCharsets.UTF_8)).toString();
        Prop rec = first.get("RECURRENCE-ID");
        if (rec != null) {
            Time r = time(rec, vtz, floating);
            if (r == null) return null;
            e.recurrenceId = r.ms;
        }
        Prop rr = first.get("RRULE");
        if (rr != null && e.recurrenceId == null) {
            String rule = stripRrule(rr.value);
            if (!rule.toUpperCase(Locale.ROOT).contains("FREQ=") || rule.length() > 1000) return null;
            e.rrule = rule;
        }
        for (Prop p : props) {
            if (!p.name.equals("EXDATE")) continue;
            for (String v : p.value.split(",")) {
                Time x = time(new Prop("EXDATE", p.params, v.trim()), vtz, floating);
                if (x != null && !e.exdates.contains(x.ms)) e.exdates.add(x.ms);
            }
        }
        Prop lm = first.containsKey("LAST-MODIFIED") ? first.get("LAST-MODIFIED") : first.get("DTSTAMP");
        if (lm != null) { Time u = time(lm, vtz, floating); if (u != null) e.updated = u.ms; }
        for (List<Prop> a : alarms) {
            for (Prop p : a) {
                if (!p.name.equals("TRIGGER")) continue;
                if ("DATE-TIME".equalsIgnoreCase(p.param("VALUE")) || "END".equalsIgnoreCase(p.param("RELATED"))) continue;
                Long ms = durationMs(p.value);
                if (ms == null || ms > 0) continue;
                int minutes = (int) Math.round(-ms / 60_000.0);
                if (!e.reminders.contains(minutes)) e.reminders.add(minutes);
            }
        }
        return e;
    }

    /** Tijdstip met soort: hele dag of niet, en de tijdzone (IANA) als er een is. */
    static final class Time {
        long ms;
        boolean date;
        String zone;
    }

    static Time time(Prop p, Map<String, ZoneId> vtz, ZoneId floating) {
        String v = p.value.trim();
        Time t = new Time();
        try {
            if ("DATE".equalsIgnoreCase(p.param("VALUE")) || v.length() == 8) {
                LocalDate d = LocalDate.of(Integer.parseInt(v.substring(0, 4)), Integer.parseInt(v.substring(4, 6)), Integer.parseInt(v.substring(6, 8)));
                t.ms = d.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
                t.date = true;
                return t;
            }
            if (v.length() < 13 || v.charAt(8) != 'T') return null;
            boolean utc = v.endsWith("Z") || v.endsWith("z");
            String digits = utc ? v.substring(0, v.length() - 1) : v;
            int sec = digits.length() >= 15 ? Integer.parseInt(digits.substring(13, 15)) : 0;
            LocalDateTime l = LocalDateTime.of(Integer.parseInt(digits.substring(0, 4)), Integer.parseInt(digits.substring(4, 6)), Integer.parseInt(digits.substring(6, 8)),
                    Integer.parseInt(digits.substring(9, 11)), Integer.parseInt(digits.substring(11, 13)), sec);
            if (utc) { t.ms = l.toInstant(ZoneOffset.UTC).toEpochMilli(); return t; }
            String id = p.param("TZID");
            ZoneId z = null;
            if (id != null) {
                String clean = unquote(id);
                z = zone(clean);
                if (z == null) z = vtz.get(clean);
            }
            if (z == null) z = floating == null ? ZoneOffset.UTC : floating;
            t.ms = l.atZone(z).toInstant().toEpochMilli();
            t.zone = zoneName(z);
            return t;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Naam voor de tijdzone zoals Android en de cloud hem kennen; null voor UTC. */
    static String zoneName(ZoneId z) {
        if (z == null) return null;
        if (z instanceof ZoneOffset) {
            ZoneOffset o = (ZoneOffset) z;
            return o.getTotalSeconds() == 0 ? null : "GMT" + o.getId();
        }
        String id = z.getId();
        return id.equals("UTC") || id.equals("Etc/UTC") || id.equals("Z") || id.equals("GMT") ? null : id;
    }

    private static final Map<String, String> WINDOWS = new HashMap<>();
    static {
        WINDOWS.put("W. Europe Standard Time", "Europe/Berlin");
        WINDOWS.put("Romance Standard Time", "Europe/Paris");
        WINDOWS.put("Central Europe Standard Time", "Europe/Budapest");
        WINDOWS.put("Central European Standard Time", "Europe/Warsaw");
        WINDOWS.put("GMT Standard Time", "Europe/London");
        WINDOWS.put("Greenwich Standard Time", "Atlantic/Reykjavik");
        WINDOWS.put("E. Europe Standard Time", "Europe/Chisinau");
        WINDOWS.put("FLE Standard Time", "Europe/Kiev");
        WINDOWS.put("Eastern Standard Time", "America/New_York");
        WINDOWS.put("Central Standard Time", "America/Chicago");
        WINDOWS.put("Mountain Standard Time", "America/Denver");
        WINDOWS.put("Pacific Standard Time", "America/Los_Angeles");
        WINDOWS.put("UTC", "UTC");
    }

    /** Tijdzone uit een TZID: IANA-naam, Outlook/Windows-naam of een pad als "/mozilla.org/.../Europe/Amsterdam". */
    public static ZoneId zone(String tzid) {
        if (tzid == null || tzid.isEmpty()) return null;
        String id = unquote(tzid.trim());
        if (WINDOWS.containsKey(id)) id = WINDOWS.get(id);
        try {
            return ZoneId.of(id);
        } catch (DateTimeException e) {
            // "/citadel.org/20190101_1/Europe/Amsterdam" → probeer steeds kortere staarten
            String[] parts = id.split("/");
            for (int i = 1; i < parts.length; i++) {
                String tail = String.join("/", java.util.Arrays.copyOfRange(parts, i, parts.length));
                try { return ZoneId.of(tail); } catch (DateTimeException ignored) { /* volgende */ }
            }
            return null;
        }
    }

    /** RFC 5545-duur ("-PT15M", "P1D", "PT1H30M", "P2W", "P3600S") in ms; null als het geen duur is. */
    public static Long durationMs(String v) {
        if (v == null) return null;
        String s = v.trim().toUpperCase(Locale.ROOT);
        if (s.isEmpty()) return null;
        int sign = 1, i = 0;
        if (s.charAt(0) == '-' || s.charAt(0) == '+') { if (s.charAt(0) == '-') sign = -1; i = 1; }
        if (i >= s.length() || s.charAt(i) != 'P') return null;
        i++;
        long total = 0;
        boolean timePart = false, any = false;
        long num = -1;
        for (; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == 'T') { timePart = true; continue; }
            if (c >= '0' && c <= '9') { num = (num < 0 ? 0 : num) * 10 + (c - '0'); if (num > 1_000_000_000L) return null; continue; }
            if (num < 0) return null;
            long unit;
            switch (c) {
                case 'W': unit = 7 * 86_400_000L; break;
                case 'D': unit = 86_400_000L; break;
                case 'H': if (!timePart) return null; unit = 3_600_000L; break;
                case 'M': if (!timePart) return null; unit = 60_000L; break;
                case 'S': unit = 1000L; break;
                default: return null;
            }
            total += num * unit;
            num = -1;
            any = true;
        }
        if (!any || num >= 0) return null;
        return sign * total;
    }

    static List<String> unfold(String text) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        String t = text;
        if (!t.isEmpty() && t.charAt(0) == '﻿') t = t.substring(1);
        for (String raw : t.split("\r\n|\n|\r", -1)) {
            if (!raw.isEmpty() && (raw.charAt(0) == ' ' || raw.charAt(0) == '\t') && !out.isEmpty()) {
                out.set(out.size() - 1, out.get(out.size() - 1) + raw.substring(1));
            } else if (!raw.isEmpty()) out.add(raw);
        }
        return out;
    }

    /** "DTSTART;TZID=\"Europe/Amsterdam\";X=1:20250101T090000" → naam, parameters, waarde. */
    static Prop prop(String line) {
        int i = 0, n = line.length();
        while (i < n && line.charAt(i) != ';' && line.charAt(i) != ':') i++;
        if (i >= n) return null;
        String name = line.substring(0, i).trim().toUpperCase(Locale.ROOT);
        Map<String, String> params = new HashMap<>();
        while (i < n && line.charAt(i) == ';') {
            int k = ++i;
            while (i < n && line.charAt(i) != '=' && line.charAt(i) != ';' && line.charAt(i) != ':') i++;
            String key = line.substring(k, i).trim().toUpperCase(Locale.ROOT);
            StringBuilder val = new StringBuilder();
            if (i < n && line.charAt(i) == '=') {
                i++;
                boolean quoted = false;
                while (i < n) {
                    char c = line.charAt(i);
                    if (c == '"') quoted = !quoted;
                    else if (!quoted && (c == ';' || c == ':')) break;
                    val.append(c);
                    i++;
                }
            }
            params.put(key, val.toString());
        }
        if (i >= n || line.charAt(i) != ':') return null;
        return new Prop(name, params, line.substring(i + 1));
    }

    static String unquote(String s) {
        return s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"") ? s.substring(1, s.length() - 1) : s;
    }

    static String unesc(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char d = s.charAt(++i);
                if (d == 'n' || d == 'N') b.append('\n');
                else b.append(d);
            } else b.append(c);
        }
        return b.toString();
    }
}
