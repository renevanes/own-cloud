package nl.eigencloud.app;

import android.content.Context;
import android.net.Uri;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.agenda.AgendaEvent;
import nl.eigencloud.core.agenda.AndroidAgenda;
import nl.eigencloud.core.agenda.BackupStore;
import nl.eigencloud.core.agenda.Ics;
import nl.eigencloud.core.agenda.Restore;

/**
 * Eigen reservekopie van de agenda's op de telefoon, los van Google: elke dag een .ics-bestand per agenda in de
 * map van de app (de afgelopen 12 maanden en alles wat nog komt; instelbaar), met "Herstel uit reservekopie" naar
 * een agenda naar keuze. De bestanden zijn ook te bewaren als bestand en in je cloud te importeren.
 */
final class CalendarBackup {
    private CalendarBackup() {}

    static File root(Context c) { return new File(new File(c.getFilesDir(), "telefoon"), "agenda"); }

    static BackupStore store(Context c) { return new BackupStore(root(c)); }

    /** Agenda's die in de reservekopie gaan: alles waarin je kunt schrijven, behalve "Eigen Cloud" en wat je uitzette. */
    static List<PhoneCalendar.Cal> included(Context c) {
        Set<String> exclude = excluded(c);
        List<PhoneCalendar.Cal> out = new ArrayList<>();
        for (PhoneCalendar.Cal k : PhoneCalendar.calendars(c)) if (k.writable() && !exclude.contains(k.key())) out.add(k);
        return out;
    }

    static Set<String> excluded(Context c) {
        return new HashSet<>(OnPhonePrefs.get(c).getStringSet(OnPhonePrefs.CAL_EXCLUDE, new HashSet<>()));
    }

    static void setIncluded(Context c, String key, boolean on) {
        Set<String> s = excluded(c);
        if (on) s.remove(key);
        else s.add(key);
        OnPhonePrefs.get(c).edit().putStringSet(OnPhonePrefs.CAL_EXCLUDE, s).apply();
    }

    /** Eens per dag (op de achtergrond), zodra je "Agenda op deze telefoon" een keer hebt geopend. */
    static boolean due(Context c) {
        return OnPhonePrefs.flag(c, OnPhonePrefs.CAL_BACKUP) && OnPhonePrefs.flag(c, OnPhonePrefs.CAL_SEEN) && CalendarSync.permitted(c)
                && System.currentTimeMillis() - OnPhonePrefs.num(c, OnPhonePrefs.CAL_LAST) > 20 * 3_600_000L;
    }

    /** Nu een reservekopie maken van alle gekozen agenda's. */
    static synchronized Map<String, Object> run(Context c) {
        if (!CalendarSync.permitted(c)) return Json.obj("error", "Geef de app toegang tot je agenda");
        long now = System.currentTimeMillis();
        long cutoff = AndroidAgenda.cutoff(now, OnPhonePrefs.integer(c, OnPhonePrefs.CAL_MONTHS));
        int keep = Math.max(1, OnPhonePrefs.integer(c, OnPhonePrefs.CAL_KEEP));
        BackupStore store = store(c);
        int saved = 0, unchanged = 0, events = 0;
        List<String> errors = new ArrayList<>();
        for (PhoneCalendar.Cal k : included(c)) {
            try {
                List<AgendaEvent> ev = PhoneCalendar.events(c, k, cutoff);
                String ics = Ics.write(k.name + (k.account != null && !k.account.equals(k.name) ? " (" + k.account + ")" : ""), ev);
                BackupStore.Saved s = store.save(k.key(), k.name, k.account, ics, ev.size(), now, keep);
                if (s.unchanged) unchanged++;
                else saved++;
                events += ev.size();
            } catch (IOException | RuntimeException e) {
                errors.add(k.name + ": " + e.getMessage());
            }
        }
        OnPhonePrefs.setNum(c, OnPhonePrefs.CAL_LAST, now);
        OnPhonePrefs.setNum(c, OnPhonePrefs.CAL_SAVED, events);
        OnPhonePrefs.setStr(c, OnPhonePrefs.CAL_ERROR, errors.isEmpty() ? null : String.join("; ", errors));
        return Json.obj("saved", saved, "unchanged", unchanged, "events", events, "errors", new ArrayList<Object>(errors));
    }

    /** Alle reservekopieën, per agenda (nieuwste eerst). */
    static List<Object> list(Context c) {
        List<Object> out = new ArrayList<>();
        for (BackupStore.Cal k : store(c).list()) {
            List<Object> copies = new ArrayList<>();
            for (BackupStore.Copy cp : k.copies) copies.add(Json.obj("file", cp.file, "time", cp.time, "bytes", cp.bytes, "events", cp.events));
            out.add(Json.obj("key", k.key, "name", k.name, "account", k.account, "copies", copies));
        }
        return out;
    }

    private static List<AgendaEvent> backup(Context c, String key, String file) throws IOException {
        return Ics.parse(store(c).read(key, file), ZoneId.systemDefault()).events;
    }

    private static Map<String, Object> brief(AgendaEvent e) {
        return Json.obj("title", e.title, "start", e.start, "allDay", e.allDay, "recurring", e.recurring());
    }

    /** Wat terugzetten in deze agenda zou doen. */
    static Map<String, Object> preview(Context c, String key, String file, long calendarId) throws IOException {
        PhoneCalendar.Cal target = PhoneCalendar.calendar(c, calendarId);
        if (target == null || !target.writable()) throw new IOException("Kies een agenda waarin je kunt schrijven");
        Restore.Plan p = Restore.plan(backup(c, key, file), PhoneCalendar.events(c, target, Long.MIN_VALUE));
        List<Object> missing = new ArrayList<>(), changed = new ArrayList<>();
        for (AgendaEvent e : p.missing) if (missing.size() < 50) missing.add(brief(e));
        for (Restore.Change ch : p.changed) {
            if (changed.size() >= 50) break;
            Map<String, Object> m = brief(ch.backup);
            m.put("what", Restore.difference(ch));
            changed.add(m);
        }
        return Json.obj("missing", p.missing.size(), "changed", p.changed.size(), "same", p.same.size(), "only", p.onlyCurrent.size(),
                "missingList", missing, "changedList", changed, "calendar", target.name);
    }

    /** Terugzetten: ontbrekende afspraken toevoegen, en (als {@code alsoChanged}) gewijzigde terugzetten. */
    static Map<String, Object> restore(Context c, String key, String file, long calendarId, boolean alsoChanged) throws IOException {
        PhoneCalendar.Cal target = PhoneCalendar.calendar(c, calendarId);
        if (target == null || !target.writable()) throw new IOException("Kies een agenda waarin je kunt schrijven");
        Restore.Plan p = Restore.plan(backup(c, key, file), PhoneCalendar.events(c, target, Long.MIN_VALUE));
        List<AgendaEvent[]> change = new ArrayList<>();
        if (alsoChanged) for (Restore.Change ch : p.changed) change.add(new AgendaEvent[]{ch.backup, ch.current});
        int[] r = PhoneCalendar.restore(c, calendarId, p.missing, change);
        return Json.obj("added", r[0], "updated", r[1], "calendar", target.name, "google", target.google());
    }

    /** Een kopie als .ics-bestand bewaren op een plek naar keuze (systeem-kiesvenster). */
    static void saveTo(Context c, String key, String file, Uri uri) throws IOException {
        String ics = store(c).read(key, file);
        try (OutputStream o = c.getContentResolver().openOutputStream(uri, "w")) {
            if (o == null) throw new IOException("Bestand kan niet geschreven worden");
            o.write(Bytes.utf8(ics));
        }
    }

    static Map<String, Object> storage(Context c) {
        BackupStore s = store(c);
        return Json.obj("bytes", s.bytes(), "copies", s.count());
    }

    /** Vrijmaken: alleen de nieuwste kopie per agenda houden. */
    static int free(Context c) { return store(c).prune(1); }
}
