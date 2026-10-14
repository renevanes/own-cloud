package nl.eigencloud.app;

import android.accounts.Account;
import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

import nl.eigencloud.core.Json;
import nl.eigencloud.core.agenda.AgendaEvent;
import nl.eigencloud.core.agenda.AndroidAgenda;
import nl.eigencloud.core.agenda.BackupStore;

/**
 * De agenda's op de telefoon (CalendarContract). Google-agenda's staan er als het Google-account op de telefoon
 * staat: Android's eigen Google-synchronisatie houdt ze in twee richtingen gelijk met Google. Deze app schrijft als
 * gewone app (niet als synchronisatie-adapter): Android markeert een nieuwe, gewijzigde of verwijderde afspraak
 * dan als "dirty" en stuurt hem bij de volgende synchronisatie naar Google (CalendarProvider2: DIRTY=1, DELETED=1,
 * en een synchronisatieverzoek bij het einde van de transactie). Er is geen wachtwoord of Google-koppeling nodig.
 */
final class PhoneCalendar {
    private PhoneCalendar() {}

    static final String GOOGLE = "com.google";

    static final class Cal {
        long id;
        String account;
        String accountType;
        String name;
        int color;
        int access;
        boolean sync;
        boolean visible;
        boolean primary;

        /** De agenda "Eigen Cloud" die {@link CalendarSync} beheert (alleen lezen). */
        boolean ours() { return CalendarContract.ACCOUNT_TYPE_LOCAL.equals(accountType) && CalendarSync.ACCOUNT.equals(account); }

        boolean google() { return GOOGLE.equals(accountType); }

        boolean writable() { return access >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR && !ours(); }

        String key() { return BackupStore.keyFor(account, name); }

        Map<String, Object> json() {
            return Json.obj("id", id, "account", account, "type", google() ? "google" : ours() ? "eigen" : CalendarContract.ACCOUNT_TYPE_LOCAL.equals(accountType) ? "lokaal" : "anders",
                    "name", name, "color", String.format(java.util.Locale.ROOT, "#%06x", color & 0xffffff), "writable", writable(), "sync", sync,
                    "visible", visible, "primary", primary, "key", key());
        }
    }

    private static final String[] CAL_COLS = {CalendarContract.Calendars._ID, CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.ACCOUNT_TYPE,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.CALENDAR_COLOR, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
            CalendarContract.Calendars.SYNC_EVENTS, CalendarContract.Calendars.VISIBLE, CalendarContract.Calendars.IS_PRIMARY};

    /** Alle agenda's op de telefoon (ook "Eigen Cloud" en alleen-lezen-agenda's). */
    static List<Cal> calendars(Context c) {
        List<Cal> out = new ArrayList<>();
        if (!CalendarSync.permitted(c)) return out;
        try (Cursor cur = c.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, CAL_COLS, null, null,
                CalendarContract.Calendars.ACCOUNT_NAME + " ASC, " + CalendarContract.Calendars.CALENDAR_DISPLAY_NAME + " ASC")) {
            while (cur != null && cur.moveToNext()) {
                Cal k = new Cal();
                k.id = cur.getLong(0);
                k.account = cur.getString(1);
                k.accountType = cur.getString(2);
                k.name = cur.getString(3) == null ? "Agenda" : cur.getString(3);
                k.color = cur.isNull(4) ? 0x3f6f4a : cur.getInt(4);
                k.access = cur.isNull(5) ? 0 : cur.getInt(5);
                k.sync = !cur.isNull(6) && cur.getInt(6) != 0;
                k.visible = !cur.isNull(7) && cur.getInt(7) != 0;
                k.primary = !cur.isNull(8) && cur.getInt(8) != 0;
                out.add(k);
            }
        } catch (RuntimeException e) {
            // geen toegang of geen agenda-opslag op dit toestel
        }
        return out;
    }

    static Cal calendar(Context c, long id) {
        for (Cal k : calendars(c)) if (k.id == id) return k;
        return null;
    }

    /** Staan er Google-agenda's op de telefoon die gesynchroniseerd worden? */
    static boolean googleSynced(Context c) {
        for (Cal k : calendars(c)) if (k.google() && k.sync) return true;
        return false;
    }

    /** Synchronisatie van de agenda voor dit Google-account, en de algemene schakelaar (READ_SYNC_SETTINGS). */
    static Map<String, Object> syncState(String account) {
        try {
            boolean master = ContentResolver.getMasterSyncAutomatically();
            boolean auto = ContentResolver.getSyncAutomatically(new Account(account, GOOGLE), CalendarContract.AUTHORITY);
            return Json.obj("master", master, "auto", auto, "known", true);
        } catch (RuntimeException e) {
            return Json.obj("known", false);
        }
    }

    // ───────── Afspraken bekijken ─────────

    private static final String[] INSTANCE_COLS = {CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
            CalendarContract.Instances.TITLE, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.CALENDAR_ID, CalendarContract.Instances.DISPLAY_COLOR, CalendarContract.Instances.RRULE,
            CalendarContract.Instances.ORIGINAL_ID};

    /** Afspraken (ook herhalingen, uitgerekend door Android) tussen {@code from} en {@code to} in deze agenda's. */
    static List<Object> instances(Context c, long from, long to, Collection<Long> calendarIds) {
        List<Object> out = new ArrayList<>();
        if (calendarIds.isEmpty() || !CalendarSync.permitted(c)) return out;
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, from);
        ContentUris.appendId(b, to);
        StringBuilder in = new StringBuilder();
        for (Long id : calendarIds) { if (in.length() > 0) in.append(','); in.append(id.longValue()); }
        try (Cursor cur = c.getContentResolver().query(b.build(), INSTANCE_COLS, CalendarContract.Instances.CALENDAR_ID + " IN (" + in + ")", null,
                CalendarContract.Instances.BEGIN + " ASC")) {
            while (cur != null && cur.moveToNext()) {
                boolean recurring = !cur.isNull(8) && !cur.getString(8).isEmpty();
                out.add(Json.obj("id", cur.getLong(0), "begin", cur.getLong(1), "end", cur.getLong(2), "title", cur.getString(3), "location", cur.getString(4),
                        "allDay", !cur.isNull(5) && cur.getInt(5) != 0, "calendar", cur.getLong(6),
                        "color", String.format(java.util.Locale.ROOT, "#%06x", (cur.isNull(7) ? 0x3f6f4a : cur.getInt(7)) & 0xffffff),
                        "recurring", recurring, "exception", !cur.isNull(9)));
                if (out.size() >= 3000) break;
            }
        }
        return out;
    }

    private static final String[] EVENT_COLS = {CalendarContract.Events._ID, CalendarContract.Events.CALENDAR_ID, CalendarContract.Events.UID_2445,
            CalendarContract.Events._SYNC_ID, CalendarContract.Events.TITLE, CalendarContract.Events.DESCRIPTION, CalendarContract.Events.EVENT_LOCATION,
            CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND, CalendarContract.Events.DURATION, CalendarContract.Events.ALL_DAY,
            CalendarContract.Events.EVENT_TIMEZONE, CalendarContract.Events.RRULE, CalendarContract.Events.EXDATE, CalendarContract.Events.ORIGINAL_ID,
            CalendarContract.Events.ORIGINAL_SYNC_ID, CalendarContract.Events.ORIGINAL_INSTANCE_TIME, CalendarContract.Events.STATUS,
            CalendarContract.Events.LAST_DATE};

    private static AndroidAgenda.Row row(Cursor cur, String accountType) {
        AndroidAgenda.Row r = new AndroidAgenda.Row();
        r.id = cur.getLong(0);
        r.calendarId = cur.getLong(1);
        r.accountType = accountType;
        r.uid2445 = cur.getString(2);
        r.syncId = cur.getString(3);
        r.title = cur.getString(4);
        r.description = cur.getString(5);
        r.location = cur.getString(6);
        r.dtstart = cur.isNull(7) ? null : cur.getLong(7);
        r.dtend = cur.isNull(8) ? null : cur.getLong(8);
        r.duration = cur.getString(9);
        r.allDay = !cur.isNull(10) && cur.getInt(10) != 0;
        r.timezone = cur.getString(11);
        r.rrule = cur.getString(12);
        r.exdate = cur.getString(13);
        r.originalId = cur.isNull(14) ? null : cur.getLong(14);
        r.originalSyncId = cur.getString(15);
        r.originalInstanceTime = cur.isNull(16) ? null : cur.getLong(16);
        r.status = cur.isNull(17) ? null : cur.getInt(17);
        r.lastDate = cur.isNull(18) ? null : cur.getLong(18);
        return r;
    }

    /** Eén afspraak met herinneringen, voor het formulier. */
    static Map<String, Object> event(Context c, long id) throws IOException {
        try (Cursor cur = c.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), EVENT_COLS, null, null, null)) {
            if (cur == null || !cur.moveToFirst()) throw new IOException("Deze afspraak bestaat niet meer");
            AndroidAgenda.Row r = row(cur, null);
            Map<Long, List<Integer>> rem = reminders(c, java.util.Collections.singletonList(id));
            long end = r.dtend != null ? r.dtend : (r.dtstart == null ? 0 : r.dtstart) + nz(AndroidAgenda.parseDuration(r.duration));
            List<Integer> mins = rem.get(id);
            return Json.obj("id", r.id, "calendar", r.calendarId, "title", r.title, "description", r.description, "location", r.location,
                    "start", r.dtstart, "end", end, "allDay", r.allDay, "tz", r.timezone, "rrule", r.rrule, "repeat", AndroidAgenda.repeatOf(r.rrule),
                    "reminder", mins == null || mins.isEmpty() ? -1 : mins.get(0), "exception", r.originalId != null);
        }
    }

    private static long nz(Long v) { return v == null ? 0 : v; }

    // ───────── Afspraken maken, wijzigen en verwijderen ─────────

    static ContentValues values(AndroidAgenda.Write w, boolean withExdate) {
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Events.DTSTART, w.dtstart);
        if (w.dtend != null) {
            v.put(CalendarContract.Events.DTEND, w.dtend);
            v.putNull(CalendarContract.Events.DURATION);
        } else {
            v.putNull(CalendarContract.Events.DTEND);
            v.put(CalendarContract.Events.DURATION, w.duration);
        }
        v.put(CalendarContract.Events.EVENT_TIMEZONE, w.timezone);
        v.put(CalendarContract.Events.ALL_DAY, w.allDay ? 1 : 0);
        if (w.rrule != null) v.put(CalendarContract.Events.RRULE, w.rrule);
        else v.putNull(CalendarContract.Events.RRULE);
        if (withExdate) {
            if (w.exdate != null) v.put(CalendarContract.Events.EXDATE, w.exdate);
            else v.putNull(CalendarContract.Events.EXDATE);
        }
        v.put(CalendarContract.Events.TITLE, w.title);
        v.put(CalendarContract.Events.DESCRIPTION, w.description);
        v.put(CalendarContract.Events.EVENT_LOCATION, w.location);
        v.put(CalendarContract.Events.HAS_ALARM, w.reminders.isEmpty() ? 0 : 1);
        return v;
    }

    private static void replaceReminders(ContentResolver cr, long eventId, List<Integer> minutes) {
        cr.delete(CalendarContract.Reminders.CONTENT_URI, CalendarContract.Reminders.EVENT_ID + " = ?", new String[]{String.valueOf(eventId)});
        for (Integer m : minutes) {
            ContentValues r = new ContentValues();
            r.put(CalendarContract.Reminders.EVENT_ID, eventId);
            r.put(CalendarContract.Reminders.MINUTES, m);
            r.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
            cr.insert(CalendarContract.Reminders.CONTENT_URI, r);
        }
    }

    /**
     * Nieuwe afspraak ({@code id} &lt; 0), hele reeks wijzigen ({@code scope} "all"), of alleen deze keer van een
     * herhaling ({@code scope} "this", met {@code instanceBegin}). Geeft het id van de (nieuwe) afspraak.
     */
    static long save(Context c, long id, long calendarId, AgendaEvent e, String scope, long instanceBegin) throws IOException {
        Cal cal = calendar(c, calendarId);
        if (cal == null || !cal.writable()) throw new IOException("In deze agenda kun je geen afspraken maken");
        ContentResolver cr = c.getContentResolver();
        try {
            if (id < 0) {
                ContentValues v = values(AndroidAgenda.toWrite(e, null), true);
                v.put(CalendarContract.Events.CALENDAR_ID, calendarId);
                Uri u = cr.insert(CalendarContract.Events.CONTENT_URI, v);
                if (u == null) throw new IOException("Opslaan in de agenda lukte niet");
                long nid = ContentUris.parseId(u);
                replaceReminders(cr, nid, e.reminders);
                return nid;
            }
            if ("this".equals(scope)) {
                // Uitzondering op de reeks: Android maakt er een losse afspraak van en past de reeks aan.
                AgendaEvent one = e.copy();
                one.rrule = null;
                AndroidAgenda.Write w = AndroidAgenda.toWrite(one, null);
                ContentValues v = new ContentValues();
                v.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, instanceBegin);
                v.put(CalendarContract.Events.DTSTART, w.dtstart);
                v.put(CalendarContract.Events.DURATION, AndroidAgenda.formatDuration(w.dtend - w.dtstart, w.allDay));
                v.put(CalendarContract.Events.EVENT_TIMEZONE, w.timezone);
                v.put(CalendarContract.Events.ALL_DAY, w.allDay ? 1 : 0);
                v.put(CalendarContract.Events.TITLE, w.title);
                v.put(CalendarContract.Events.DESCRIPTION, w.description);
                v.put(CalendarContract.Events.EVENT_LOCATION, w.location);
                v.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CONFIRMED);
                v.put(CalendarContract.Events.HAS_ALARM, e.reminders.isEmpty() ? 0 : 1);
                Uri u = cr.insert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI, id), v);
                if (u == null) throw new IOException("Deze keer wijzigen lukte niet");
                long nid = ContentUris.parseId(u);
                replaceReminders(cr, nid, e.reminders);
                return nid;
            }
            // Hele afspraak/reeks: geschrapte herhalingen (EXDATE) blijven zoals ze waren.
            ContentValues v = values(AndroidAgenda.toWrite(e, null), false);
            if (cr.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), v, null, null) < 1) throw new IOException("Deze afspraak bestaat niet meer");
            replaceReminders(cr, id, e.reminders);
            return id;
        } catch (IllegalArgumentException | SecurityException ex) {
            throw new IOException("De agenda weigerde dit: " + ex.getMessage(), ex);
        }
    }

    /** Verwijderen: alles, of alleen deze keer van een herhaling (uitzondering met status "geannuleerd"). */
    static void delete(Context c, long id, String scope, long instanceBegin) throws IOException {
        ContentResolver cr = c.getContentResolver();
        try {
            if ("this".equals(scope)) {
                ContentValues v = new ContentValues();
                v.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, instanceBegin);
                v.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CANCELED);
                if (cr.insert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI, id), v) == null) throw new IOException("Deze keer verwijderen lukte niet");
                return;
            }
            if (cr.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null) < 1) throw new IOException("Deze afspraak bestaat niet meer");
        } catch (IllegalArgumentException | SecurityException ex) {
            throw new IOException("De agenda weigerde dit: " + ex.getMessage(), ex);
        }
    }

    // ───────── Reservekopie en terugzetten ─────────

    /** Alle (niet-verwijderde) rijen van één agenda. */
    static List<AndroidAgenda.Row> rows(Context c, Cal cal) {
        List<AndroidAgenda.Row> out = new ArrayList<>();
        try (Cursor cur = c.getContentResolver().query(CalendarContract.Events.CONTENT_URI, EVENT_COLS,
                CalendarContract.Events.CALENDAR_ID + " = ? AND " + CalendarContract.Events.DELETED + " = 0", new String[]{String.valueOf(cal.id)}, null)) {
            while (cur != null && cur.moveToNext()) out.add(row(cur, cal.accountType));
        }
        return out;
    }

    /** Herinneringen (minuten) per afspraak: meldingen en wekkers, geen e-mail of sms. */
    static Map<Long, List<Integer>> reminders(Context c, List<Long> eventIds) {
        Map<Long, List<Integer>> out = new HashMap<>();
        for (int i = 0; i < eventIds.size(); i += 400) {
            StringBuilder in = new StringBuilder();
            for (Long id : eventIds.subList(i, Math.min(eventIds.size(), i + 400))) { if (in.length() > 0) in.append(','); in.append(id.longValue()); }
            try (Cursor cur = c.getContentResolver().query(CalendarContract.Reminders.CONTENT_URI,
                    new String[]{CalendarContract.Reminders.EVENT_ID, CalendarContract.Reminders.MINUTES, CalendarContract.Reminders.METHOD},
                    CalendarContract.Reminders.EVENT_ID + " IN (" + in + ")", null, null)) {
                while (cur != null && cur.moveToNext()) {
                    int method = cur.isNull(2) ? 0 : cur.getInt(2);
                    if (method != CalendarContract.Reminders.METHOD_DEFAULT && method != CalendarContract.Reminders.METHOD_ALERT && method != CalendarContract.Reminders.METHOD_ALARM) continue;
                    int minutes = cur.isNull(1) ? -1 : cur.getInt(1);
                    if (minutes < 0) minutes = 10; // "standaard" van de agenda; meestal 10 minuten
                    out.computeIfAbsent(cur.getLong(0), k -> new ArrayList<>()).add(minutes);
                }
            }
        }
        return out;
    }

    /** Afspraken van een agenda zoals ze in een reservekopie gaan (venster vanaf {@code cutoff}). */
    static List<AgendaEvent> events(Context c, Cal cal, long cutoff) {
        List<AndroidAgenda.Row> rows = rows(c, cal);
        List<Long> ids = new ArrayList<>();
        for (AndroidAgenda.Row r : rows) ids.add(r.id);
        return AndroidAgenda.toEvents(rows, reminders(c, ids), cutoff);
    }

    /**
     * Zet afspraken terug in een agenda (als gewone app, dus Android synchroniseert ze naar Google). Reeksen krijgen
     * de tijdstippen van hun gewijzigde losse herhalingen als EXDATE; die losse herhalingen komen als eigen afspraak.
     * Geeft {toegevoegd, bijgewerkt}.
     */
    static int[] restore(Context c, long calendarId, List<AgendaEvent> add, List<AgendaEvent[]> change) throws IOException {
        Cal cal = calendar(c, calendarId);
        if (cal == null || !cal.writable()) throw new IOException("In deze agenda kun je geen afspraken terugzetten");
        Map<String, List<Long>> overrides = new HashMap<>();
        List<AgendaEvent> all = new ArrayList<>(add);
        for (AgendaEvent[] ch : change) all.add(ch[0]);
        for (AgendaEvent e : all) if (e.recurrenceId != null) overrides.computeIfAbsent(e.uid, k -> new ArrayList<>()).add(e.recurrenceId);
        ContentResolver cr = c.getContentResolver();
        int added = 0, updated = 0;
        try {
            ArrayList<ContentProviderOperation> batch = new ArrayList<>();
            for (AgendaEvent e : add) {
                AndroidAgenda.Write w = AndroidAgenda.toWrite(e, e.recurrenceId == null ? overrides.get(e.uid) : null);
                ContentValues v = values(w, true);
                v.put(CalendarContract.Events.CALENDAR_ID, calendarId);
                int index = batch.size();
                batch.add(ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(v).build());
                for (Integer m : w.reminders) {
                    batch.add(ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI)
                            .withValueBackReference(CalendarContract.Reminders.EVENT_ID, index)
                            .withValue(CalendarContract.Reminders.MINUTES, m)
                            .withValue(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT).build());
                }
                added++;
                if (batch.size() >= 150) { cr.applyBatch(CalendarContract.AUTHORITY, batch); batch = new ArrayList<>(); }
            }
            if (!batch.isEmpty()) cr.applyBatch(CalendarContract.AUTHORITY, batch);
            for (AgendaEvent[] ch : change) {
                AgendaEvent b = ch[0];
                long id = ch[1].localId;
                if (id < 0) continue;
                AndroidAgenda.Write w = AndroidAgenda.toWrite(b, b.recurrenceId == null ? overrides.get(b.uid) : null);
                if (cr.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), values(w, true), null, null) > 0) {
                    replaceReminders(cr, id, w.reminders);
                    updated++;
                }
            }
        } catch (android.os.RemoteException | android.content.OperationApplicationException | IllegalArgumentException | SecurityException e) {
            throw new IOException("Terugzetten lukte niet helemaal (" + added + " toegevoegd): " + e.getMessage(), e);
        }
        return new int[]{added, updated};
    }

    /** Tijdzone van de telefoon, voor nieuwe afspraken. */
    static String zone() { return TimeZone.getDefault().getID(); }
}
