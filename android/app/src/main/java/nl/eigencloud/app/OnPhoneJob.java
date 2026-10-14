package nl.eigencloud.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Achtergrondwerk van "Agenda en foto's op deze telefoon", los van {@link SyncJob}: elke paar uur de
 * agenda-reservekopie (eens per dag) en de foto's uit je cloud bijwerken; de Takeout-import in rondes van een paar
 * minuten tot hij klaar is.
 */
public final class OnPhoneJob extends JobService {
    static final int PERIODIC = 7101, TAKEOUT = 7102, PHOTOS = 7103;
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;

    /** De periodieke taak inplannen (als hij er nog niet is) en een lopende import weer oppakken. */
    static void ensure(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js.getPendingJob(PERIODIC) == null) {
            js.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(c, OnPhoneJob.class))
                    .setPeriodic(3 * 3_600_000L)
                    .setPersisted(true)
                    .build());
        }
        if (TakeoutRun.active(c) && js.getPendingJob(TAKEOUT) == null) takeout(c);
    }

    /** Volgende ronde van de Takeout-import (alleen via wifi, tenzij anders ingesteld). */
    static void takeout(Context c) {
        boolean wifi = OnPhonePrefs.flag(c, OnPhonePrefs.TK_WIFI);
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(TAKEOUT, new ComponentName(c, OnPhoneJob.class))
                .setRequiredNetworkType(wifi ? JobInfo.NETWORK_TYPE_UNMETERED : JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    /** Foto's uit je cloud nu bijwerken (knop "Nu bijwerken" of na een andere instelling). */
    static void photosNow(Context c) {
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(PHOTOS, new ComponentName(c, OnPhoneJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        stopped = false;
        Context c = getApplicationContext();
        int id = params.getJobId();
        POOL.execute(() -> {
            boolean more = false;
            long deadline = System.currentTimeMillis() + 8 * 60_000L; // JobScheduler geeft ongeveer 10 minuten
            try {
                if (id == TAKEOUT) {
                    more = TakeoutRun.run(c, () -> stopped, deadline);
                } else if (id == PHOTOS) {
                    PhotoLibrary.sync(c, () -> stopped, deadline, true);
                } else {
                    if (CalendarBackup.due(c)) CalendarBackup.run(c);
                    PhotoLibrary.sync(c, () -> stopped, deadline - 2 * 60_000L, false);
                }
            } catch (RuntimeException e) {
                // volgende ronde opnieuw
            } finally {
                jobFinished(params, false);
                // Pas na jobFinished: een taak met hetzelfde nummer inplannen terwijl hij loopt, zou hem stoppen.
                if (id == TAKEOUT && more && !stopped) takeout(c);
                if (id == PERIODIC && TakeoutRun.active(c) && c.getSystemService(JobScheduler.class).getPendingJob(TAKEOUT) == null) takeout(c);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true;
        return true; // later opnieuw
    }
}
