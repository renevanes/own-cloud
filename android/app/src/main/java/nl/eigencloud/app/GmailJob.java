package nl.eigencloud.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nl.eigencloud.core.gmail.GmailSync;

/**
 * Gmail op deze telefoon, op de achtergrond: elk kwartier bijwerken (nieuwe mail, wijzigingen beide kanten op, de
 * wachtrij en het versturen), en zolang de eerste keer nog niet klaar is een vervolg zodra dat mag: grote downloads
 * alleen via wifi (of een ander onbeperkt netwerk), tenzij je mobiele data hebt toegestaan.
 */
public final class GmailJob extends JobService {
    static final int PERIODIC = 7201, MORE = 7202;
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(PERIODIC) != null) return;
        js.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(c, GmailJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build());
    }

    /** The first sync is not finished: continue soon, on wifi unless mobile data is allowed. */
    static void more(Context c, boolean mobileData) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        js.schedule(new JobInfo.Builder(MORE, new ComponentName(c, GmailJob.class))
                .setRequiredNetworkType(mobileData ? JobInfo.NETWORK_TYPE_ANY : JobInfo.NETWORK_TYPE_UNMETERED)
                .setMinimumLatency(30_000)
                .setPersisted(true)
                .build());
    }

    static void cancel(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) return;
        js.cancel(PERIODIC);
        js.cancel(MORE);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        stopped = false;
        Context c = getApplicationContext();
        if (!GmailBackend.configured(c)) { cancel(c); return false; }
        POOL.execute(() -> {
            try {
                GmailBackend b = GmailBackend.get(c);
                GmailSync.Result r = b.background(stopped);
                if (r != null && r.more && !r.authFailed && b.api.sync() != null) more(c, b.api.sync().settings().mobileData);
            } catch (RuntimeException e) {
                // the next run tries again
            } finally {
                jobFinished(params, false);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true;
        return true;
    }
}
