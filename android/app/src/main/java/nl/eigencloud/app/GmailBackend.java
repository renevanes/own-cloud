package nl.eigencloud.app;

import android.app.Notification;
import android.content.Context;
import android.content.Intent;
import android.app.PendingIntent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.io.File;
import java.io.IOException;
import java.util.List;

import nl.eigencloud.core.gmail.GmailApi;
import nl.eigencloud.core.gmail.GmailStore;
import nl.eigencloud.core.gmail.GmailSync;
import nl.eigencloud.core.gmail.Imap;
import nl.eigencloud.core.gmail.Smtp;

/**
 * "Gmail op deze telefoon": the copy of Gmail in app-private storage (SQLite + files under files/gmail), the API
 * the screens call, the loop that keeps it in step while the screen is open (IDLE), and background runs
 * ({@link GmailJob}). The phone talks directly to imap.gmail.com and smtp.gmail.com; the cloud is not involved.
 * The app password is in {@link DeviceSecrets} (Keystore, no fingerprint needed, so background sync works while
 * the phone is locked); showing or changing the account needs the fingerprint ({@link GmailConfirm}).
 */
final class GmailBackend {
    static final String SECRET_ADDRESS = "gmail.address", SECRET_PASSWORD = "gmail.appPassword";
    static final int NOTIFY_ID = 7210;
    private static GmailBackend instance;

    final Context app;
    final GmailStore store;
    final GmailApi api;
    private volatile String[] cred;
    private volatile boolean credLoaded;
    /** Until when the fingerprint/PIN confirmation counts (5 minutes). */
    volatile long confirmedUntil;
    /** The Gmail screen is in front: no notifications, the loop runs. */
    static volatile boolean visible;

    private Thread loop;
    private volatile boolean stopLoop;

    static synchronized GmailBackend get(Context c) {
        if (instance == null) instance = new GmailBackend(c.getApplicationContext());
        return instance;
    }

    private static android.content.SharedPreferences flags(Context c) { return c.getApplicationContext().getSharedPreferences("gmail", Context.MODE_PRIVATE); }

    /** Set up on this phone (a flag; nothing is decrypted). */
    static boolean configured(Context c) { return flags(c).getBoolean("configured", false); }

    private GmailBackend(Context app) {
        this.app = app;
        store = new GmailStore(new GmailSql(app), new File(app.getFilesDir(), "gmail"));
        api = new GmailApi(store, new GmailApi.Host() {
            @Override public String[] credentials() { return GmailBackend.this.credentials(); }

            @Override public void saveCredentials(String address, String password) throws IOException {
                if (!DeviceSecrets.put(app, SECRET_ADDRESS, address) || !DeviceSecrets.put(app, SECRET_PASSWORD, password)) {
                    throw new IOException("Kon het app-wachtwoord niet veilig op de telefoon bewaren");
                }
                cred = new String[]{address, password};
                credLoaded = true;
                flags(app).edit().putBoolean("configured", true).apply();
                GmailJob.schedule(app);
            }

            @Override public void forgetCredentials() {
                DeviceSecrets.remove(app, SECRET_ADDRESS);
                DeviceSecrets.remove(app, SECRET_PASSWORD);
                cred = null;
                credLoaded = true;
                flags(app).edit().putBoolean("configured", false).apply();
                GmailJob.cancel(app);
                Notify.cancel(app, NOTIFY_ID);
            }

            @Override public boolean confirmed() { return System.currentTimeMillis() < confirmedUntil; }
        }, Imap.Config.gmail(), Smtp.Server.gmail());
        api.contentBase = Assets.ORIGIN + "/gmail/";
    }

    String[] credentials() {
        if (!credLoaded) {
            String a = DeviceSecrets.get(app, SECRET_ADDRESS), p = DeviceSecrets.get(app, SECRET_PASSWORD);
            cred = a != null && p != null ? new String[]{a, p} : null;
            credLoaded = true;
        }
        return cred;
    }

    static boolean unmetered(Context c) {
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        if (cm == null) return false;
        Network n = cm.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    private GmailSync prepared() {
        GmailSync s = api.sync();
        if (s != null) s.unmetered = () -> unmetered(app);
        return s;
    }

    // ───────── While the screen is open ─────────

    synchronized void startLoop(GmailSync.Listener listener) {
        GmailSync s = prepared();
        if (s == null || (loop != null && loop.isAlive())) return;
        stopLoop = false;
        loop = new Thread(() -> s.idleLoop(() -> stopLoop || api.sync() != s, 3 * 60_000L, r -> {
            if (!visible) notifyNew(r.fresh);
            listener.changed(r);
        }), "gmail-idle");
        loop.setDaemon(true);
        loop.start();
    }

    synchronized void stopLoop() {
        stopLoop = true;
        GmailSync s = api.sync();
        if (s != null) s.wake();
    }

    boolean loopActive() { Thread t = loop; return t != null && t.isAlive() && !stopLoop; }

    /** A background run (from {@link GmailJob}); null when not set up or the screen's loop is already busy. */
    GmailSync.Result background(boolean stopped) {
        GmailSync s = prepared();
        if (s == null || loopActive() || stopped) return null;
        GmailSync.Options o = new GmailSync.Options();
        o.budgetMs = 8 * 60_000L;
        o.unmetered = unmetered(app);
        GmailSync.Result r = s.run(o);
        s.closeInteractive();
        if (!visible) notifyNew(r.fresh);
        return r;
    }

    // ───────── Notifications ─────────

    void notifyNew(List<GmailStore.Msg> fresh) {
        if (fresh == null || fresh.isEmpty() || !Notify.allowed(app)) return;
        GmailSync s = api.sync();
        if (s == null || !s.settings().notify) return;
        GmailStore.Msg first = fresh.get(0);
        Intent open = new Intent(app, GmailActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (fresh.size() == 1) open.putExtra(GmailActivity.EXTRA_OPEN, first.id);
        PendingIntent pi = PendingIntent.getActivity(app, NOTIFY_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Notify.builder(app, Notify.MAIL).setContentIntent(pi).setAutoCancel(true).setNumber(fresh.size())
                .setCategory(Notification.CATEGORY_EMAIL).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (fresh.size() == 1) {
            b.setContentTitle(first.fromName.isEmpty() ? first.fromAddr : first.fromName).setContentText(first.subject.isEmpty() ? "(geen onderwerp)" : first.subject)
                    .setStyle(new Notification.BigTextStyle().bigText(first.subject + (first.snippet.isEmpty() ? "" : "\n" + first.snippet)));
        } else {
            Notification.InboxStyle style = new Notification.InboxStyle();
            for (int i = 0; i < Math.min(5, fresh.size()); i++) {
                GmailStore.Msg m = fresh.get(i);
                style.addLine((m.fromName.isEmpty() ? m.fromAddr : m.fromName) + ": " + m.subject);
            }
            b.setContentTitle(fresh.size() + " nieuwe berichten in Gmail").setContentText(first.subject).setStyle(style);
        }
        b.setPublicVersion(Notify.builder(app, Notify.MAIL).setContentTitle("Nieuwe mail in Gmail").build());
        Notify.show(app, NOTIFY_ID, b.build());
    }
}
