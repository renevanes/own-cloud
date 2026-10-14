package nl.eigencloud.core.fotos;

import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Welke foto's uit je cloud er op de telefoon staan: de laatste {@link Settings#months} maanden helemaal
 * (miniatuur + origineel), oudere als miniatuur, en originelen die je zelf opent als "op aanvraag" (de laatst
 * geopende blijven, tot een eigen deel van de ruimte). Alles samen blijft onder {@link Settings#maxBytes}.
 *
 * <p>Voorrang als de ruimte op is: eerst miniaturen van recente foto's, dan recente originelen (nieuwste eerst),
 * dan miniaturen van oudere foto's. Vooraf ophalen alleen via wifi (of als mobiele data mag); een foto die je
 * opent haalt de app altijd, maar via mobiele data pas nadat je dat bevestigt.
 */
public final class PhotoCache {
    private PhotoCache() {}

    public static final long THUMB_ESTIMATE = 40 * 1024L;
    public static final long PHOTO_ESTIMATE = 3_500 * 1024L;
    public static final long VIDEO_ESTIMATE = 60L * 1024 * 1024;

    public static final class Settings {
        /** Hoeveel maanden helemaal op de telefoon; 0 = geen (alleen miniaturen). */
        public int months = 12;
        public long maxBytes = 5L * 1024 * 1024 * 1024;
        /** Ruimte voor originelen die je zelf opent (binnen maxBytes). */
        public long onDemandBytes = 512L * 1024 * 1024;
        /** Ook via mobiele data vooraf ophalen. */
        public boolean mobile;
        /** Ook video's van de laatste maanden helemaal. */
        public boolean videos;
        /** Miniaturen van oudere foto's vooraf ophalen. */
        public boolean olderThumbs = true;
    }

    public enum Kind { THUMB, ORIGINAL }

    /** Een bestand dat al op de telefoon staat. */
    public static final class Cached {
        public final long id;
        public final Kind kind;
        public final long bytes;
        public final long lastAccess;

        public Cached(long id, Kind kind, long bytes, long lastAccess) { this.id = id; this.kind = kind; this.bytes = bytes; this.lastAccess = lastAccess; }
    }

    /** Op te halen bestand, in volgorde van voorrang. */
    public static final class Want {
        public final CloudPhotos.Photo photo;
        public final Kind kind;
        public final long estimate;

        Want(CloudPhotos.Photo photo, Kind kind, long estimate) { this.photo = photo; this.kind = kind; this.estimate = estimate; }
    }

    public static final class Plan {
        public final List<Want> fetch = new ArrayList<>();
        public final List<Cached> evict = new ArrayList<>();
        /** Foto's die helemaal op de telefoon horen (binnen de ruimte). */
        public final Set<Long> full = new HashSet<>();
        public final Set<Long> thumbs = new HashSet<>();
        public int recent;
        public int older;
        /** Wat er na het plan op de telefoon staat (geschat voor wat nog moet komen). */
        public long bytes;
    }

    /** Begin van de periode die helemaal op de telefoon staat. */
    public static long cutoff(long now, int months) {
        if (months <= 0) return Long.MAX_VALUE;
        return Instant.ofEpochMilli(now).atZone(ZoneOffset.UTC).minusMonths(months).toInstant().toEpochMilli();
    }

    static long estimate(CloudPhotos.Photo p, Kind k) {
        if (k == Kind.THUMB) return THUMB_ESTIMATE;
        return p.video ? VIDEO_ESTIMATE : PHOTO_ESTIMATE;
    }

    static String key(long id, Kind k) { return id + (k == Kind.THUMB ? "m" : "o"); }

    /**
     * Het plan voor deze tijdlijn ({@code photos}, nieuwste eerst, zoals /api/photos) en wat er al staat.
     * Bestanden van foto's die niet meer in je cloud staan, gaan weg.
     */
    public static Plan plan(List<CloudPhotos.Photo> photos, List<Cached> cached, Settings s, long now) {
        Plan p = new Plan();
        Map<String, Cached> have = new HashMap<>();
        for (Cached c : cached) have.put(key(c.id, c.kind), c);
        long cut = cutoff(now, s.months);
        List<CloudPhotos.Photo> recent = new ArrayList<>(), older = new ArrayList<>();
        Set<Long> ids = new HashSet<>();
        for (CloudPhotos.Photo ph : photos) {
            ids.add(ph.id);
            if (ph.takenAt >= cut) recent.add(ph);
            else older.add(ph);
        }
        p.recent = recent.size();
        p.older = older.size();
        List<Want> order = new ArrayList<>();
        for (CloudPhotos.Photo ph : recent) if (ph.thumb) order.add(new Want(ph, Kind.THUMB, estimate(ph, Kind.THUMB)));
        for (CloudPhotos.Photo ph : recent) if (!ph.video || s.videos) order.add(new Want(ph, Kind.ORIGINAL, estimate(ph, Kind.ORIGINAL)));
        if (s.olderThumbs) for (CloudPhotos.Photo ph : older) if (ph.thumb) order.add(new Want(ph, Kind.THUMB, estimate(ph, Kind.THUMB)));

        long reserve = Math.min(Math.max(0, s.onDemandBytes), s.maxBytes / 4);
        long budget = Math.max(0, s.maxBytes - reserve);
        long used = 0;
        Set<String> keep = new HashSet<>();
        for (Want w : order) {
            Cached c = have.get(key(w.photo.id, w.kind));
            long size = c != null ? c.bytes : w.estimate;
            if (used + size > budget) continue;
            used += size;
            keep.add(key(w.photo.id, w.kind));
            if (w.kind == Kind.ORIGINAL) p.full.add(w.photo.id);
            else p.thumbs.add(w.photo.id);
            if (c == null) p.fetch.add(w);
        }
        // Zelf geopend: de laatst geopende blijven, binnen het eigen deel (en de totale ruimte).
        long allowance = Math.min(reserve, Math.max(0, s.maxBytes - used));
        List<Cached> extra = new ArrayList<>();
        for (Cached c : cached) {
            if (!ids.contains(c.id)) { p.evict.add(c); continue; }
            if (!keep.contains(key(c.id, c.kind))) extra.add(c);
        }
        extra.sort((a, b) -> Long.compare(b.lastAccess, a.lastAccess));
        long od = 0;
        for (Cached c : extra) {
            if (od + c.bytes <= allowance) { od += c.bytes; continue; }
            p.evict.add(c);
        }
        p.bytes = used + od;
        return p;
    }

    /** Mag de app nu vooraf ophalen (achtergrond)? */
    public static boolean prefetchAllowed(boolean metered, Settings s) { return !metered || s.mobile; }

    public enum Open { READY, FETCH, ASK }

    /** Een origineel openen: staat het er al, ophalen, of eerst vragen (mobiele data)? */
    public static Open open(boolean cached, boolean metered, Settings s, boolean confirmed) {
        if (cached) return Open.READY;
        if (!metered || s.mobile || confirmed) return Open.FETCH;
        return Open.ASK;
    }
}
