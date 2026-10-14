package nl.eigencloud.core;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import nl.eigencloud.core.fotos.CloudPhotos;
import nl.eigencloud.core.fotos.PhotoCache;

/**
 * Foto's uit je cloud op de telefoon ({@link PhotoCache}): recente maanden helemaal, oudere als miniatuur,
 * zelf geopende originelen als laatst-geopend-blijft, opruimen bij te weinig ruimte of verwijderd in de cloud, en
 * de regels voor mobiele data.
 */
public class FotoCacheTest {
    static final long MB = 1024L * 1024;
    static final long NOW = LocalDateTime.of(2026, 10, 13, 12, 0).toInstant(ZoneOffset.UTC).toEpochMilli();
    static final long DAY = 86_400_000L;

    public static void main(String[] args) {
        T.main("FotoCacheTest", () -> {
            window();
            budget();
            onDemand();
            eviction();
            network();
        });
    }

    /** Tijdlijn: één foto per {@code stepDays} dagen terug vanaf nu, nieuwste eerst; elke 10e een video. */
    static List<CloudPhotos.Photo> timeline(int n, int stepDays) {
        List<CloudPhotos.Photo> l = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            CloudPhotos.Photo p = new CloudPhotos.Photo();
            p.id = 10_000 - i;
            p.takenAt = NOW - (long) i * stepDays * DAY;
            p.filename = "IMG_" + i + ".jpg";
            p.video = i % 10 == 9;
            p.thumb = true;
            l.add(p);
        }
        return l;
    }

    static Set<Long> ids(List<PhotoCache.Want> w, PhotoCache.Kind k) {
        Set<Long> s = new HashSet<>();
        for (PhotoCache.Want x : w) if (x.kind == k) s.add(x.photo.id);
        return s;
    }

    static void window() {
        List<CloudPhotos.Photo> tl = timeline(40, 30); // 40 maanden, één per maand
        PhotoCache.Settings s = new PhotoCache.Settings();
        PhotoCache.Plan p = PhotoCache.plan(tl, List.of(), s, NOW);
        T.eq(13, p.recent, "laatste 12 maanden (incl. vandaag): 13 foto's");
        T.eq(27, p.older, "ouder: 27");
        T.eq(40, ids(p.fetch, PhotoCache.Kind.THUMB).size(), "miniaturen van alles");
        Set<Long> originals = ids(p.fetch, PhotoCache.Kind.ORIGINAL);
        T.eq(12, originals.size(), "originelen van recente foto's (video's niet)");
        T.check(!originals.contains(10_000L - 9), "video niet helemaal zonder instelling");
        T.eq(PhotoCache.Kind.THUMB, p.fetch.get(0).kind, "eerst miniaturen van recente foto's");
        T.eq(10_000L, p.fetch.get(13).photo.id, "dan originelen, nieuwste eerst");
        T.eq(PhotoCache.Kind.ORIGINAL, p.fetch.get(13).kind, "origineel");
        T.eq(PhotoCache.Kind.THUMB, p.fetch.get(p.fetch.size() - 1).kind, "als laatste miniaturen van oudere foto's");
        s.videos = true;
        T.eq(13, ids(PhotoCache.plan(tl, List.of(), s, NOW).fetch, PhotoCache.Kind.ORIGINAL).size(), "met video's");
        s.videos = false;
        s.months = 3;
        T.eq(4, PhotoCache.plan(tl, List.of(), s, NOW).recent, "3 maanden");
        s.months = 0;
        PhotoCache.Plan none = PhotoCache.plan(tl, List.of(), s, NOW);
        T.check(none.recent == 0 && ids(none.fetch, PhotoCache.Kind.ORIGINAL).isEmpty(), "0 maanden: alleen miniaturen");
        s.months = 12;
        s.olderThumbs = false;
        T.eq(13, ids(PhotoCache.plan(tl, List.of(), s, NOW).fetch, PhotoCache.Kind.THUMB).size(), "zonder miniaturen van oudere foto's");
        // Foto zonder miniatuur in de cloud (bijv. video zonder ffmpeg): geen miniatuur ophalen.
        tl.get(0).thumb = false;
        T.check(!ids(PhotoCache.plan(tl, List.of(), new PhotoCache.Settings(), NOW).fetch, PhotoCache.Kind.THUMB).contains(10_000L), "geen miniatuur in de cloud");
    }

    static void budget() {
        List<CloudPhotos.Photo> tl = timeline(400, 1); // ruim een jaar, elke dag een foto
        PhotoCache.Settings s = new PhotoCache.Settings();
        s.maxBytes = 200 * MB; // 50 MB voor zelf geopend, 150 MB voor vooraf
        PhotoCache.Plan p = PhotoCache.plan(tl, List.of(), s, NOW);
        long thumbs = ids(p.fetch, PhotoCache.Kind.THUMB).size(), originals = ids(p.fetch, PhotoCache.Kind.ORIGINAL).size();
        T.check(p.bytes <= 150 * MB, "binnen de ruimte: " + p.bytes);
        T.eq(366L + 34L, thumbs, "alle miniaturen passen");
        T.check(originals > 0 && originals < 330, "originelen: zoveel als past (" + originals + ")");
        // Wat past, zijn de nieuwste originelen.
        long newest = Long.MAX_VALUE, oldest = 0;
        for (PhotoCache.Want w : p.fetch) if (w.kind == PhotoCache.Kind.ORIGINAL) { newest = Math.min(newest, 10_000 - w.photo.id); oldest = Math.max(oldest, 10_000 - w.photo.id); }
        T.eq(0L, newest, "nieuwste origineel erbij");
        T.check(oldest < 60, "oudste origineel hooguit enkele weken oud (" + oldest + " dagen)");
        // Met echte groottes van wat er al staat: kleine originelen → er passen er meer.
        List<PhotoCache.Cached> have = new ArrayList<>();
        for (int i = 0; i < 300; i++) have.add(new PhotoCache.Cached(10_000 - i, PhotoCache.Kind.ORIGINAL, 200 * 1024, NOW - DAY));
        PhotoCache.Plan q = PhotoCache.plan(tl, have, s, NOW);
        T.eq(270, q.full.size() - ids(q.fetch, PhotoCache.Kind.ORIGINAL).size(), "al aanwezige originelen blijven (270 foto's)");
        T.check(q.evict.isEmpty(), "niets weg: de 30 video's blijven als zelf geopend");
        s.maxBytes = 0;
        T.eq(0, PhotoCache.plan(tl, List.of(), s, NOW).fetch.size(), "geen ruimte: niets vooraf");
    }

    static void onDemand() {
        List<CloudPhotos.Photo> tl = timeline(100, 30); // tot ruim 8 jaar terug
        PhotoCache.Settings s = new PhotoCache.Settings();
        s.maxBytes = 1000 * MB;
        s.onDemandBytes = 10 * MB;
        List<PhotoCache.Cached> have = new ArrayList<>();
        // Vier oude originelen zelf geopend (4 MB elk); de twee laatst geopende passen in 10 MB.
        for (int i = 0; i < 4; i++) have.add(new PhotoCache.Cached(10_000 - 50 - i, PhotoCache.Kind.ORIGINAL, 4 * MB, NOW - (4 - i) * DAY));
        PhotoCache.Plan p = PhotoCache.plan(tl, have, s, NOW);
        Set<Long> gone = new HashSet<>();
        for (PhotoCache.Cached c : p.evict) gone.add(c.id);
        T.eq(Set.of(10_000L - 50, 10_000L - 51), gone, "oudst geopende eerst weg");
        T.check(!p.full.contains(10_000L - 53), "zelf geopend telt niet als 'helemaal'");
        // Zelf geopende miniatuur (oudere miniaturen staan uit) valt ook onder het eigen deel.
        s.olderThumbs = false;
        PhotoCache.Plan t = PhotoCache.plan(tl, List.of(new PhotoCache.Cached(10_000 - 80, PhotoCache.Kind.THUMB, 40 * 1024, NOW)), s, NOW);
        T.check(t.evict.isEmpty(), "geopende miniatuur blijft");
    }

    static void eviction() {
        List<CloudPhotos.Photo> tl = timeline(30, 20);
        PhotoCache.Settings s = new PhotoCache.Settings();
        List<PhotoCache.Cached> have = new ArrayList<>();
        have.add(new PhotoCache.Cached(42, PhotoCache.Kind.ORIGINAL, 3 * MB, NOW)); // niet meer in de cloud
        have.add(new PhotoCache.Cached(42, PhotoCache.Kind.THUMB, 30_000, NOW));
        have.add(new PhotoCache.Cached(10_000, PhotoCache.Kind.ORIGINAL, 3 * MB, NOW));
        PhotoCache.Plan p = PhotoCache.plan(tl, have, s, NOW);
        T.eq(2, p.evict.size(), "verwijderd in de cloud: ook van de telefoon");
        for (PhotoCache.Cached c : p.evict) T.eq(42L, c.id, "foto 42 weg");
        T.check(!ids(p.fetch, PhotoCache.Kind.ORIGINAL).contains(10_000L), "wat er al staat niet opnieuw ophalen");
        // Minder ruimte ingesteld: recente originelen die niet meer passen gaan weg (oudste eerst).
        List<PhotoCache.Cached> full = new ArrayList<>();
        for (CloudPhotos.Photo ph : tl) if (ph.takenAt >= PhotoCache.cutoff(NOW, 12) && !ph.video) full.add(new PhotoCache.Cached(ph.id, PhotoCache.Kind.ORIGINAL, 10 * MB, NOW - DAY));
        s.maxBytes = 120 * MB; // 30 MB eigen deel (max kwart), 90 MB vooraf
        PhotoCache.Plan q = PhotoCache.plan(tl, full, s, NOW);
        T.check(!q.evict.isEmpty(), "te veel: opruimen");
        long kept = 0;
        for (PhotoCache.Cached c : full) if (!q.evict.contains(c)) kept += c.bytes;
        T.check(kept <= 120 * MB, "blijft binnen de ruimte: " + kept / MB + " MB");
        T.check(q.full.contains(10_000L), "nieuwste blijft helemaal");
        T.eq(PhotoCache.cutoff(NOW, 12), LocalDateTime.of(2025, 10, 13, 12, 0).toInstant(ZoneOffset.UTC).toEpochMilli(), "12 maanden = kalendermaanden");
    }

    static void network() {
        PhotoCache.Settings s = new PhotoCache.Settings();
        T.check(PhotoCache.prefetchAllowed(false, s), "wifi: vooraf ophalen");
        T.check(!PhotoCache.prefetchAllowed(true, s), "mobiele data: niet vooraf");
        T.eq(PhotoCache.Open.READY, PhotoCache.open(true, true, s, false), "staat er al: meteen");
        T.eq(PhotoCache.Open.FETCH, PhotoCache.open(false, false, s, false), "wifi: ophalen");
        T.eq(PhotoCache.Open.ASK, PhotoCache.open(false, true, s, false), "mobiel: eerst vragen");
        T.eq(PhotoCache.Open.FETCH, PhotoCache.open(false, true, s, true), "mobiel, bevestigd: ophalen");
        s.mobile = true;
        T.check(PhotoCache.prefetchAllowed(true, s), "mobiele data toegestaan");
        T.eq(PhotoCache.Open.FETCH, PhotoCache.open(false, true, s, false), "mobiel toegestaan: zonder vragen");
    }
}
