package nl.eigencloud.app;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PersistableBundle;
import android.provider.MediaStore;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Alles wat op de achtergrond gebeurt, in één taak: foto-back-up, agenda bijwerken, mail- en
 * gezondheidsmeldingen en kijken of er een nieuwe versie is. Android plant hem zuinig in (elk kwartier,
 * en meteen als er een nieuwe foto bij komt).
 */
public final class SyncJob extends JobService {
    static final int PERIODIC = 1, MEDIA = 2, NOW = 3, SHARE_BASE = 100;
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private volatile boolean stopped;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        ComponentName me = new ComponentName(c, SyncJob.class);
        if (js.getPendingJob(PERIODIC) == null) {
            js.schedule(new JobInfo.Builder(PERIODIC, me)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(15 * 60_000L)
                    .setPersisted(true)
                    .build());
        }
        scheduleMediaTrigger(c);
    }

    /** Eenmalige taak die start zodra er een foto of video bij komt (moet na elke keer opnieuw worden ingepland). */
    static void scheduleMediaTrigger(Context c) {
        if (!Prefs.flag(c, Prefs.BACKUP_PHOTOS)) return;
        JobScheduler js = c.getSystemService(JobScheduler.class);
        js.schedule(new JobInfo.Builder(MEDIA, new ComponentName(c, SyncJob.class))
                .addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .addTriggerContentUri(new JobInfo.TriggerContentUri(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(10_000)
                .setTriggerContentMaxDelay(120_000)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .build());
    }

    /** Nu meteen (knop "Nu bijwerken"). */
    static void runNow(Context c) {
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(NOW, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setOverrideDeadline(1_000)
                .build());
    }

    /** Gedeelde foto's uploaden; de leesrechten op de bestanden gaan via ClipData mee naar de taak. */
    static void share(Context c, ClipData clip) {
        PersistableBundle extras = new PersistableBundle();
        extras.putBoolean("share", true);
        int id = SHARE_BASE + (int) (System.currentTimeMillis() % 100_000);
        c.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(id, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setClipData(clip, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .setExtras(extras)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        stopped = false;
        Context c = getApplicationContext();
        POOL.execute(() -> {
            boolean again = false;
            try {
                if (params.getExtras().getBoolean("share")) again = shareUpload(c, params.getClipData());
                else again = runAll(c, params.getJobId() != PERIODIC);
            } finally {
                if (params.getJobId() == MEDIA) scheduleMediaTrigger(c);
                jobFinished(params, again && !stopped);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true;
        return true; // later opnieuw
    }

    /** Geeft true als het werk nog niet af is (wordt dan later herhaald). */
    private boolean runAll(Context c, boolean eager) {
        Prefs.setNum(c, "sync.last", System.currentTimeMillis());
        Updater.periodic(c);
        CloudApi api = CloudApi.fromApp(c);
        if (api == null) { Prefs.setStr(c, "sync.error", "Log in in de app om op de achtergrond bij te werken"); return false; }
        Prefs.setStr(c, "sync.error", null);
        try {
            Watch.mail(c, api);
            Watch.health(c, api);
        } catch (CloudApi.NotLoggedIn e) {
            Prefs.setStr(c, "sync.error", "Log opnieuw in in de app");
            return false;
        } catch (IOException | RuntimeException e) {
            Prefs.setStr(c, "sync.error", "Je cloud was niet bereikbaar (" + e.getMessage() + ")");
        }
        try {
            if (eager || System.currentTimeMillis() - Prefs.num(c, "calendar.last") > 14 * 60_000L) CalendarSync.run(c, api);
        } catch (IOException | RuntimeException e) {
            Prefs.setStr(c, "calendar.error", e.getMessage());
        }
        PhotoBackup.Result r = PhotoBackup.run(c, api, () -> stopped);
        Prefs.setStr(c, "backup.state", r.stopped);
        return "later verder".equals(r.stopped) || "verbinding weg".equals(r.stopped);
    }

    private boolean shareUpload(Context c, ClipData clip) {
        CloudApi api = CloudApi.fromApp(c);
        if (api == null || clip == null) return false;
        int ok = 0, total = clip.getItemCount();
        for (int i = 0; i < total && !stopped; i++) {
            Uri u = clip.getItemAt(i).getUri();
            if (u == null) continue;
            String mime = c.getContentResolver().getType(u);
            String name = ShareActivity.displayName(c, u);
            Notify.show(c, Notify.ID_SHARE, Notify.builder(c, Notify.BACKUP).setContentTitle("Delen met je eigen cloud")
                    .setContentText((i + 1) + " van " + total).setProgress(total, i, false).setOngoing(true).build());
            try (java.io.InputStream in = c.getContentResolver().openInputStream(u)) {
                if (in == null) continue;
                java.util.Map<String, Object> res = api.upload(PhotoBackup.fileName(name, mime, i), mime, System.currentTimeMillis(), in, -1);
                if (res.get("error") == null) ok++;
            } catch (IOException | SecurityException e) {
                // volgende
            }
        }
        Notify.show(c, Notify.ID_SHARE, Notify.builder(c, Notify.BACKUP).setContentTitle(ok == total ? "Gedeeld met je eigen cloud" : ok + " van " + total + " gedeeld")
                .setContentText(ok == total ? total + (total == 1 ? " foto of video" : " foto's en video's") + " staan in Foto's" : "Probeer de rest later opnieuw")
                .setContentIntent(Notify.openApp(c, "#fotos", 4)).setAutoCancel(true).build());
        return false;
    }
}
