package nl.eigencloud.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.Json;

/**
 * Je eigen cloud als app: mail, agenda en foto's (dezelfde schermen als in de browser), plus wat alleen een
 * app kan: automatische foto-back-up, je agenda in de agenda-app van de telefoon, meldingen en delen.
 */
public final class MainActivity extends Activity {
    static final String EXTRA_HASH = "hash";
    private static final int REQ_FILES = 1, REQ_PERMS = 2;

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private volatile String currentUrl = "";
    private String pendingFlag;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Notify.channels(this);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " EigenCloudApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Phone(), "EigenPhone");
        web.setDownloadListener((url, ua, disposition, mime, length) -> download(url, disposition, mime));
        if (b != null) web.restoreState(b);
        else open(getIntent());
        if (Prefs.cloudUrl(this) != null) SyncJob.schedule(this);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        open(i);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        CookieManager.getInstance().flush();
        // Bij openen meteen bijwerken (mail, agenda, nieuwe foto's), niet pas na een kwartier.
        if (Prefs.cloudUrl(this) != null && CloudApi.sessionToken(Prefs.cloudUrl(this)) != null) SyncJob.runNow(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private void open(Intent i) {
        String cloud = Prefs.cloudUrl(this);
        if (cloud == null) { web.loadUrl(Assets.ORIGIN + "/start.html"); return; }
        String hash = i != null ? i.getStringExtra(EXTRA_HASH) : null;
        web.loadUrl(cloud + "/" + (hash != null && hash.startsWith("#") ? hash : ""));
    }

    private boolean isCloud(Uri u) {
        String cloud = Prefs.cloudUrl(this);
        if (cloud == null || u == null) return false;
        Uri c = Uri.parse(cloud);
        return c.getScheme().equals(u.getScheme()) && c.getHost().equals(u.getHost()) && c.getPort() == u.getPort();
    }

    /** Alleen onze eigen pagina's (de cloud zelf en het startscherm van de app) mogen de brug gebruiken. */
    private boolean trusted() {
        Uri u = Uri.parse(currentUrl);
        return isCloud(u) || (Assets.ours(u) && "/start.html".equals(u.getPath()));
    }

    private void event(Object detail) {
        String js = "window.dispatchEvent(new CustomEvent('eigenphone',{detail:" + Json.stringify(detail) + "}))";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    private final class Client extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            return Assets.ours(r.getUrl()) ? Assets.serve(MainActivity.this, r.getUrl()) : null;
        }

        @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (isCloud(u) || Assets.ours(u)) return false;
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (RuntimeException ignored) { /* niets om mee te openen */ }
            return true;
        }

        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame() && isCloud(r.getUrl())) v.loadUrl(Assets.ORIGIN + "/start.html#offline");
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, REQ_FILES);
            } catch (RuntimeException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        if (req != REQ_FILES || fileCallback == null) { super.onActivityResult(req, result, data); return; }
        List<Uri> uris = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        fileCallback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        fileCallback = null;
    }

    /** Bijlagen en foto's downloaden, met je inlogsessie, naar de map Downloads. */
    private void download(String url, String disposition, String mime) {
        Uri u = Uri.parse(url);
        if (!isCloud(u)) { startActivity(new Intent(Intent.ACTION_VIEW, u)); return; }
        DownloadManager.Request r = new DownloadManager.Request(u);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) r.addRequestHeader("Cookie", cookie);
        String name = URLUtil.guessFileName(url, disposition, mime);
        r.setTitle(name);
        r.setMimeType(mime);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        getSystemService(DownloadManager.class).enqueue(r);
        Toast.makeText(this, "Downloaden: " + name, Toast.LENGTH_SHORT).show();
    }

    // ───────── Toestemmingen ─────────

    private String[] permissionsFor(String flag) {
        switch (flag) {
            case Prefs.BACKUP_PHOTOS:
                if (Build.VERSION.SDK_INT >= 33) return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.ACCESS_MEDIA_LOCATION"};
                if (Build.VERSION.SDK_INT >= 29) return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, "android.permission.ACCESS_MEDIA_LOCATION"};
                return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
            case Prefs.CALENDAR:
                return new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR};
            case Prefs.NOTIFY_MAIL:
            case Prefs.NOTIFY_HEALTH:
            case Prefs.UPDATES:
                return Build.VERSION.SDK_INT >= 33 ? new String[]{"android.permission.POST_NOTIFICATIONS"} : new String[0];
            default:
                return new String[0];
        }
    }

    private boolean granted(String[] perms) {
        for (String p : perms) {
            if (p.equals("android.permission.ACCESS_MEDIA_LOCATION")) continue; // fijn, niet nodig
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req != REQ_PERMS || pendingFlag == null) return;
        String flag = pendingFlag;
        pendingFlag = null;
        boolean ok = granted(permissionsFor(flag));
        if (ok) enable(flag);
        else Prefs.setFlag(this, flag, false);
        event(Json.obj("type", "changed", "flag", flag, "denied", !ok));
    }

    private void enable(String flag) {
        Prefs.setFlag(this, flag, true);
        if (flag.equals(Prefs.BACKUP_PHOTOS)) SyncJob.scheduleMediaTrigger(this);
        SyncJob.runNow(this);
    }

    // ───────── Brug voor de cloud-pagina's ─────────

    /** Wat de cloud (web/app.js, Instellingen → Telefoon) en het startscherm van de app kunnen aanroepen. */
    final class Phone {
        @JavascriptInterface
        public String info() {
            if (!trusted()) return "null";
            MainActivity c = MainActivity.this;
            String cloud = Prefs.cloudUrl(c);
            Map<String, Object> backup = Json.obj("photos", Prefs.flag(c, Prefs.BACKUP_PHOTOS), "videos", Prefs.flag(c, Prefs.BACKUP_VIDEOS),
                    "wifiOnly", Prefs.flag(c, Prefs.BACKUP_WIFI_ONLY), "chargingOnly", Prefs.flag(c, Prefs.BACKUP_CHARGING_ONLY),
                    "permitted", PhotoBackup.permitted(c), "pending", Prefs.flag(c, Prefs.BACKUP_PHOTOS) ? PhotoBackup.pending(c) : null,
                    "last", Prefs.num(c, "backup.last"), "state", Prefs.str(c, "backup.state"), "blocker", Prefs.flag(c, Prefs.BACKUP_PHOTOS) ? PhotoBackup.blocker(c) : null);
            return Json.stringify(Json.obj("version", BuildConfig.VERSION_NAME, "cloud", cloud,
                    "backgroundLogin", cloud != null && CloudApi.sessionToken(cloud) != null,
                    "backup", backup,
                    "calendar", Json.obj("on", Prefs.flag(c, Prefs.CALENDAR), "permitted", CalendarSync.permitted(c), "last", Prefs.num(c, "calendar.last"),
                            "count", Prefs.num(c, "calendar.count"), "error", Prefs.str(c, "calendar.error")),
                    "notify", Json.obj("mail", Prefs.flag(c, Prefs.NOTIFY_MAIL), "health", Prefs.flag(c, Prefs.NOTIFY_HEALTH), "permitted", Notify.allowed(c)),
                    "updates", Json.obj("on", Prefs.flag(c, Prefs.UPDATES), "status", Updater.status(c)),
                    "sync", Json.obj("last", Prefs.num(c, "sync.last"), "error", Prefs.str(c, "sync.error")),
                    "biometric", Biometrics.available(c), "console", ConsoleBackend.get(c).vault.exists()));
        }

        @JavascriptInterface
        public void set(String flag, boolean on) {
            if (!trusted()) return;
            main.post(() -> {
                if (!on) {
                    Prefs.setFlag(MainActivity.this, flag, false);
                    if (flag.equals(Prefs.CALENDAR)) new Thread(() -> CalendarSync.remove(MainActivity.this)).start();
                    event(Json.obj("type", "changed", "flag", flag));
                    return;
                }
                String[] perms = permissionsFor(flag);
                if (granted(perms)) { enable(flag); event(Json.obj("type", "changed", "flag", flag)); return; }
                pendingFlag = flag;
                requestPermissions(perms, REQ_PERMS);
            });
        }

        /** "all" = ook alles wat al op de telefoon staat; "now" = alleen nieuwe foto's vanaf nu. */
        @JavascriptInterface
        public void backupFrom(String mode) {
            if (!trusted()) return;
            if ("now".equals(mode)) PhotoBackup.startFromNow(MainActivity.this);
            else { Prefs.setNum(MainActivity.this, "mark.images.added", 0); Prefs.setNum(MainActivity.this, "mark.images.id", 0); Prefs.setNum(MainActivity.this, "mark.video.added", 0); Prefs.setNum(MainActivity.this, "mark.video.id", 0); }
            event(Json.obj("type", "changed"));
        }

        @JavascriptInterface
        public void syncNow() {
            if (!trusted()) return;
            SyncJob.runNow(MainActivity.this);
        }

        @JavascriptInterface
        public void openConsole() {
            if (!trusted()) return;
            ConsoleActivity.open(MainActivity.this);
        }

        @JavascriptInterface
        public void checkUpdate() {
            if (!trusted()) return;
            new Thread(() -> {
                try {
                    Updater.Release r = Updater.check(MainActivity.this);
                    event(Json.obj("type", "update", "available", r != null ? r.version : null));
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "update", "error", "Kon niet kijken: " + e.getMessage()));
                }
            }).start();
        }

        @JavascriptInterface
        public void installUpdate() {
            if (!trusted()) return;
            String url = Prefs.str(MainActivity.this, "update.url");
            if (url != null && url.startsWith("https://")) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }

        /** Startscherm: verbinden met een bestaande cloud. Antwoord komt als event {type:"connect"}. */
        @JavascriptInterface
        public void connect(String address) {
            if (!trusted()) return;
            new Thread(() -> {
                try {
                    String url = CloudApi.normalize(address);
                    CloudApi.probe(url);
                    Prefs.setStr(MainActivity.this, Prefs.CLOUD_URL, url);
                    main.post(() -> { SyncJob.schedule(MainActivity.this); web.loadUrl(url + "/"); });
                } catch (IOException | IllegalArgumentException e) {
                    event(Json.obj("type", "connect", "error", e.getMessage()));
                }
            }).start();
        }

        @JavascriptInterface
        public void retry() {
            if (!trusted()) return;
            main.post(() -> open(null));
        }

        /** Loskoppelen: vergeet het adres en de sessie op deze telefoon (je cloud zelf blijft gewoon bestaan). */
        @JavascriptInterface
        public void forget() {
            if (!trusted()) return;
            main.post(() -> {
                Prefs.setStr(MainActivity.this, Prefs.CLOUD_URL, null);
                Prefs.setFlag(MainActivity.this, Prefs.BACKUP_PHOTOS, false);
                CookieManager.getInstance().removeAllCookies(null);
                new Thread(() -> CalendarSync.remove(MainActivity.this)).start();
                Prefs.setFlag(MainActivity.this, Prefs.CALENDAR, false);
                web.clearHistory();
                web.loadUrl(Assets.ORIGIN + "/start.html");
            });
        }
    }
}
