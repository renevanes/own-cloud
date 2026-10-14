package nl.eigencloud.app;

import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * Zet je cloud-agenda in de agenda-app van de telefoon (alleen lezen: afspraken maak en wijzig je in Eigen
 * Cloud, de telefoon volgt binnen een kwartier). Werkt met een lokale agenda; er is geen Google-account voor nodig.
 */
final class CalendarSync {
    private CalendarSync() {}

    static final String ACCOUNT = "Eigen Cloud";
    private static final long PAST = 60L * 86_400_000, FUTURE = 330L * 86_400_000;

    static boolean permitted(Context c) {
        return c.checkSelfPermission("android.permission.READ_CALENDAR") == PackageManager.PERMISSION_GRANTED
                && c.checkSelfPermission("android.permission.WRITE_CALENDAR") == PackageManager.PERMISSION_GRANTED;
    }

    private static Uri asSync(Uri u) {
        return u.buildUpon().appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
                .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, ACCOUNT)
                .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL).build();
    }

    private static long calendarId(ContentResolver cr, boolean create) {
        try (Cursor cur = cr.query(CalendarContract.Calendars.CONTENT_URI, new String[]{CalendarContract.Calendars._ID},
                CalendarContract.Calendars.ACCOUNT_NAME + " = ? AND " + CalendarContract.Calendars.ACCOUNT_TYPE + " = ?",
                new String[]{ACCOUNT, CalendarContract.ACCOUNT_TYPE_LOCAL}, null)) {
            if (cur != null && cur.moveToFirst()) return cur.getLong(0);
        }
        if (!create) return -1;
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Calendars.ACCOUNT_NAME, ACCOUNT);
        v.put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL);
        v.put(CalendarContract.Calendars.NAME, "eigen-cloud");
        v.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, "Eigen Cloud");
        v.put(CalendarContract.Calendars.CALENDAR_COLOR, 0xff3f6f4a);
        v.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_READ);
        v.put(CalendarContract.Calendars.OWNER_ACCOUNT, ACCOUNT);
        v.put(CalendarContract.Calendars.VISIBLE, 1);
        v.put(CalendarContract.Calendars.SYNC_EVENTS, 1);
        v.put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, TimeZone.getDefault().getID());
        Uri u = cr.insert(asSync(CalendarContract.Calendars.CONTENT_URI), v);
        return u == null ? -1 : ContentUris.parseId(u);
    }

    /** Agenda van de telefoon weghalen (als je de koppeling uitzet). */
    static void remove(Context c) {
        if (!permitted(c)) return;
        ContentResolver cr = c.getContentResolver();
        long id = calendarId(cr, false);
        if (id >= 0) cr.delete(asSync(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI, id)), null, null);
    }

    /** Haalt de afspraken op en past alleen de verschillen toe. Geeft het aantal afspraken terug. */
    static int run(Context c, CloudApi api) throws IOException {
        if (!Prefs.flag(c, Prefs.CALENDAR) || !permitted(c)) return -1;
        long now = System.currentTimeMillis();
        List<Object> events = Json.asList(api.getJson("/api/events?from=" + (now - PAST) + "&to=" + (now + FUTURE)));
        if (events == null) throw new IOException("Onverwacht antwoord van /api/events");
        // Staat Google Agenda zelf al op de telefoon (Android synchroniseert hem), dan de in de cloud gevolgde
        // Google-agenda's ("Google: …") niet nog eens als Eigen Cloud tonen: anders staat alles dubbel.
        java.util.Set<Object> skip = new java.util.HashSet<>();
        if (OnPhonePrefs.flag(c, OnPhonePrefs.CAL_SKIP_FOLLOWED) && PhoneCalendar.googleSynced(c)) {
            List<Object> cals = Json.asList(api.getJson("/api/calendars"));
            if (cals != null) for (Object o : cals) {
                String name = Json.str(o, "name");
                if (name != null && name.startsWith("Google: ")) skip.add(Json.jsString(Json.path(o, "id")));
            }
        }
        if (!skip.isEmpty()) {
            List<Object> kept = new ArrayList<>();
            for (Object o : events) if (!skip.contains(Json.jsString(Json.path(o, "calendar_id")))) kept.add(o);
            events = kept;
        }
        ContentResolver cr = c.getContentResolver();
        long cal = calendarId(cr, true);
        if (cal < 0) throw new IOException("Agenda aanmaken op de telefoon lukt niet");

        // Wat staat er al? sleutel (SYNC_DATA1) → [rij-id, inhoud-hash (SYNC_DATA2)]
        Map<String, long[]> have = new HashMap<>();
        Map<String, String> haveHash = new HashMap<>();
        try (Cursor cur = cr.query(asSync(CalendarContract.Events.CONTENT_URI), new String[]{CalendarContract.Events._ID, CalendarContract.Events.SYNC_DATA1, CalendarContract.Events.SYNC_DATA2},
                CalendarContract.Events.CALENDAR_ID + " = ?", new String[]{String.valueOf(cal)}, null)) {
            while (cur != null && cur.moveToNext()) {
                have.put(cur.getString(1), new long[]{cur.getLong(0)});
                haveHash.put(cur.getString(1), cur.getString(2));
            }
        }

        // Eerst verzamelen wat er moet gebeuren; daarna in porties toepassen.
        List<Uri> deletes = new ArrayList<>();
        List<ContentValues> inserts = new ArrayList<>();
        List<Integer> reminders = new ArrayList<>();
        for (Object o : events) {
            Map<String, Object> e = Json.asMap(o);
            if (e == null || Json.num(e, "occurrence_start") == null || Json.num(e, "occurrence_end") == null) continue;
            String key = Json.jsString(e.get("id")) + ":" + Json.jsString(e.get("occurrence_start"));
            String hash = Bytes.sha256Hex(Bytes.utf8(Json.stringify(Json.obj("t", e.get("title"), "l", e.get("location"), "d", e.get("description"),
                    "s", e.get("occurrence_start"), "e", e.get("occurrence_end"), "a", e.get("all_day"), "r", e.get("reminder_min"))))).substring(0, 16);
            long[] existing = have.remove(key);
            if (existing != null && hash.equals(haveHash.get(key))) continue;
            if (existing != null) deletes.add(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existing[0]));
            boolean allDay = Json.truthy(e.get("all_day"));
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.CALENDAR_ID, cal);
            v.put(CalendarContract.Events.TITLE, Json.jsString(e.get("title")));
            if (e.get("location") != null) v.put(CalendarContract.Events.EVENT_LOCATION, Json.jsString(e.get("location")));
            if (e.get("description") != null) v.put(CalendarContract.Events.DESCRIPTION, Json.jsString(e.get("description")));
            v.put(CalendarContract.Events.DTSTART, Json.num(e, "occurrence_start").longValue());
            v.put(CalendarContract.Events.DTEND, Json.num(e, "occurrence_end").longValue());
            v.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
            // Hele dagen staan in de cloud op middernacht UTC; zo verschuiven ze niet.
            v.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
            Number rem = Json.num(e, "reminder_min");
            v.put(CalendarContract.Events.HAS_ALARM, rem != null ? 1 : 0);
            v.put(CalendarContract.Events.SYNC_DATA1, key);
            v.put(CalendarContract.Events.SYNC_DATA2, hash);
            inserts.add(v);
            reminders.add(rem == null ? null : rem.intValue());
        }
        for (long[] gone : have.values()) deletes.add(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, gone[0]));

        try {
            ArrayList<ContentProviderOperation> batch = new ArrayList<>();
            for (Uri d : deletes) {
                batch.add(ContentProviderOperation.newDelete(asSync(d)).build());
                if (batch.size() >= 200) { cr.applyBatch(CalendarContract.AUTHORITY, batch); batch = new ArrayList<>(); }
            }
            for (int i = 0; i < inserts.size(); i++) {
                int index = batch.size();
                batch.add(ContentProviderOperation.newInsert(asSync(CalendarContract.Events.CONTENT_URI)).withValues(inserts.get(i)).build());
                Integer rem = reminders.get(i);
                if (rem != null) {
                    batch.add(ContentProviderOperation.newInsert(asSync(CalendarContract.Reminders.CONTENT_URI))
                            .withValueBackReference(CalendarContract.Reminders.EVENT_ID, index)
                            .withValue(CalendarContract.Reminders.MINUTES, rem)
                            .withValue(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                            .build());
                }
                if (batch.size() >= 200) { cr.applyBatch(CalendarContract.AUTHORITY, batch); batch = new ArrayList<>(); }
            }
            if (!batch.isEmpty()) cr.applyBatch(CalendarContract.AUTHORITY, batch);
        } catch (android.os.RemoteException | android.content.OperationApplicationException e) {
            throw new IOException("Agenda bijwerken op de telefoon mislukt: " + e.getMessage(), e);
        }
        Prefs.setNum(c, "calendar.last", System.currentTimeMillis());
        Prefs.setNum(c, "calendar.count", events.size());
        return events.size();
    }
}
