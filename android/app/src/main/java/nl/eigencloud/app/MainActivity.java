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

import nl.eigencloud.core.Http;
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
    /** Inloggen (start.html#inloggen): bij welke cloud, waar daarna naartoe, en (alleen in het geheugen) de inlog voor de code-stap. */
    private volatile String loginUrl, loginHash = "", mfaUser, mfaPassword;
    private volatile boolean mfaRemember;

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
        if (b == null) invite(getIntent());
        // Altijd inplannen: ook zonder cloud (tijdens het opzetten) moet de app zichzelf bijwerken.
        SyncJob.schedule(this);
        WhatsNew.maybeShow(this);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        if (invite(i)) return; // de huidige pagina blijft staan; de console gaat erboven open
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
        event(Json.obj("type", "changed")); // bijv. terug uit de instelling "onbekende apps installeren"
        UpdateCheck.resumed(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        UpdateCheck.paused(this);
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
        String h = hash != null && hash.startsWith("#") ? hash : "";
        // Niet (meer) ingelogd (bijv. na 30 dagen): het inlogscherm van de app, met je vingerafdruk als je die bewaarde.
        if (CloudApi.sessionToken(cloud) == null) {
            loginUrl = cloud;
            loginHash = h;
            web.loadUrl(Assets.ORIGIN + "/start.html#inloggen");
            return;
        }
        web.loadUrl(cloud + "/" + h);
    }

    /** Ingelogd: de cloud openen (en de inlog achter je vingerafdruk bewaren als je dat wilde). */
    private void loggedIn(String url, String user, String password, boolean remember) {
        Prefs.setStr(this, Prefs.CLOUD_URL, url);
        boolean stored = remember && CloudLogin.remember(this, url, user, password);
        if (!remember) CloudLogin.forget(this);
        mfaUser = null;
        mfaPassword = null;
        String h = loginHash == null ? "" : loginHash;
        loginHash = "";
        main.post(() -> {
            SyncJob.schedule(MainActivity.this);
            if (stored) Toast.makeText(MainActivity.this, "Voortaan log je in met je vingerafdruk", Toast.LENGTH_SHORT).show();
            web.loadUrl(url + "/" + h);
        });
    }

    /** Inloggen in de achtergrond; fouten als event {type:"login", error, mfa, wrong} voor start.html. */
    private void tryLogin(String url, String user, String password, String code, boolean remember) {
        try {
            CloudLogin.login(url, user, password, code);
            loggedIn(url, user, password, remember);
        } catch (CloudLogin.Failed e) {
            if (e.mfa) { mfaUser = user; mfaPassword = password; mfaRemember = remember; }
            event(Json.obj("type", "login", "error", e.getMessage(), "mfa", e.mfa, "wrong", e.wrong));
        } catch (IOException e) {
            event(Json.obj("type", "login", "error", e.getMessage()));
        }
    }

    /** Wat het inlogscherm moet weten; vraagt de cloud of er meer gebruikers zijn (dan ook je adres). Niet op de UI-thread. */
    private Map<String, Object> loginState(String url, String type) {
        boolean multi = false;
        try {
            Http.Response r = Http.request("GET", url + "/api/login/info", Http.headers("accept", "application/json"), null, 10_000);
            multi = r.ok() && Json.truthy(Json.path(Json.parse(r.text()), "multiUser"));
        } catch (IOException | RuntimeException ignored) {
            // dan alleen het wachtwoord, zoals de cloud zelf
        }
        return Json.obj("type", type, "login", true, "url", url, "host", Uri.parse(url).getHost(), "multiUser", multi,
                "fingerprint", CloudLogin.has(this, url), "remember", CloudLogin.available(this));
    }

    /** Alleen het startscherm van de app (niet de cloud-pagina's) mag inloggen met het bewaarde wachtwoord. */
    private boolean startPage() {
        Uri u = Uri.parse(currentUrl);
        return Assets.ours(u) && "/start.html".equals(u.getPath());
    }

    /**
     * Uitnodiging van een aanbieder: {@code eigencloud://uitnodiging?dienst=<https-adres, url-gecodeerd>&code=<code>}.
     * Wordt bewaard tot de console hem ophaalt ({@code EigenNative.pendingInvite()}), en de console gaat open.
     */
    private boolean invite(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        if ((i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false; // uit "recente apps": al verwerkt
        Uri u = i.getData();
        if (!"eigencloud".equals(u.getScheme()) || !"uitnodiging".equals(u.getHost())) return false;
        String dienst = validDienst(u.getQueryParameter("dienst"));
        String code = u.getQueryParameter("code");
        if (dienst == null || code == null || !code.matches("[A-Za-z0-9-]{4,40}")) {
            Toast.makeText(this, "Deze uitnodigingslink klopt niet. Vraag je aanbieder om een nieuwe.", Toast.LENGTH_LONG).show();
            return true;
        }
        Prefs.setStr(this, Prefs.INVITE_DIENST, dienst);
        Prefs.setStr(this, Prefs.INVITE_CODE, code);
        Toast.makeText(this, "Uitnodiging van " + Uri.parse(dienst).getHost(), Toast.LENGTH_SHORT).show();
        ConsoleActivity.open(this);
        return true;
    }

    /** Alleen een https-adres zonder inlognaam, query of anker; zonder / aan het eind. */
    static String validDienst(String s) {
        if (s == null) return null;
        Uri d = Uri.parse(s.trim());
        if (!"https".equalsIgnoreCase(d.getScheme()) || d.getHost() == null || d.getHost().isEmpty() || d.getUserInfo() != null
                || d.getQuery() != null || d.getFragment() != null) return null;
        String path = d.getPath() == null ? "" : d.getPath().replaceAll("/+$", "");
        if (!path.isEmpty() && !path.matches("(/[A-Za-z0-9._~-]+)+")) return null;
        return "https://" + d.getHost().toLowerCase(java.util.Locale.ROOT) + (d.getPort() == -1 ? "" : ":" + d.getPort()) + path;
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
                if (Build.VERSION.SDK_INT >= 34) return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED", "android.permission.ACCESS_MEDIA_LOCATION"};
                if (Build.VERSION.SDK_INT >= 33) return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.ACCESS_MEDIA_LOCATION"};
                if (Build.VERSION.SDK_INT >= 29) return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, "android.permission.ACCESS_MEDIA_LOCATION"};
                return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
            case Prefs.CALENDAR:
                return new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR};
            case Prefs.NOTIFY_MAIL:
            case Prefs.NOTIFY_HEALTH:
            case Prefs.UPDATES:
            case Prefs.AUTO_INSTALL:
                return Build.VERSION.SDK_INT >= 33 ? new String[]{"android.permission.POST_NOTIFICATIONS"} : new String[0];
            default:
                return new String[0];
        }
    }

    private boolean granted(String[] perms) {
        for (String p : perms) if (p.equals("android.permission.READ_MEDIA_IMAGES")) return PhotoBackup.permitted(this);
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
            return Json.stringify(Json.obj("version", BuildConfig.VERSION_NAME, "versionCode", BuildConfig.VERSION_CODE, "repo", BuildConfig.UPDATE_REPO,
                    "android", android.os.Build.VERSION.RELEASE, "device", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL, "cloud", cloud,
                    "backgroundLogin", cloud != null && CloudApi.sessionToken(cloud) != null,
                    "backup", backup,
                    "calendar", Json.obj("on", Prefs.flag(c, Prefs.CALENDAR), "permitted", CalendarSync.permitted(c), "last", Prefs.num(c, "calendar.last"),
                            "count", Prefs.num(c, "calendar.count"), "error", Prefs.str(c, "calendar.error")),
                    "notify", Json.obj("mail", Prefs.flag(c, Prefs.NOTIFY_MAIL), "health", Prefs.flag(c, Prefs.NOTIFY_HEALTH), "permitted", Notify.allowed(c)),
                    "updates", Json.obj("on", Prefs.flag(c, Prefs.UPDATES), "status", Updater.status(c)),
                    "sync", Json.obj("last", Prefs.num(c, "sync.last"), "error", Prefs.str(c, "sync.error")),
                    "biometric", Biometrics.available(c), "console", ConsoleBackend.get(c).vault.exists(),
                    "login", Json.obj("fingerprint", cloud != null && CloudLogin.has(c, cloud), "available", CloudLogin.available(c)),
                    "dienst", Prefs.str(c, Prefs.DIENST_URL),
                    "dienstOwn", Prefs.str(c, Prefs.DIENST_OWN_URL), "dienstName", Prefs.str(c, Prefs.DIENST_OWN_NAME),
                    "dienstOnly", "1".equals(Prefs.str(c, Prefs.DIENST_OWN_ONLY))));
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

        /** De console op een route openen: "#aanbieder" (aanbieder worden, of je eigen Dienst beheren). */
        @JavascriptInterface
        public void openConsoleAt(String hash) {
            if (!trusted()) return;
            ConsoleActivity.open(MainActivity.this, hash);
        }

        /** "Op deze telefoon": "#agenda" (Google-agenda), "#fotos" (foto's en Takeout) of "#opslag" (ruimte). */
        @JavascriptInterface
        public void openOnPhone(String hash) {
            if (!trusted()) return;
            main.post(() -> OnPhoneActivity.open(MainActivity.this, hash));
        }

        /** Voor aanbieders: het beheer van je Eigen Cloud Dienst openen. Bij een fout komt er een event {type:"dienst", error}. */
        @JavascriptInterface
        public void openDienst(String url) {
            if (!trusted()) return;
            main.post(() -> {
                try {
                    String u = DienstActivity.normalize(url);
                    Prefs.setStr(MainActivity.this, Prefs.DIENST_URL, u);
                    DienstActivity.open(MainActivity.this, url);
                    event(Json.obj("type", "dienst", "url", u));
                } catch (IllegalArgumentException e) {
                    event(Json.obj("type", "dienst", "error", e.getMessage()));
                }
            });
        }

        @JavascriptInterface
        public void whatsNew() {
            if (!trusted()) return;
            main.post(() -> WhatsNew.showAll(MainActivity.this));
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
            if (!Updater.canInstall(MainActivity.this)) { startActivity(Updater.installPermissionIntent(MainActivity.this)); return; }
            new Thread(() -> {
                try {
                    Updater.Release r = Updater.check(MainActivity.this);
                    if (r == null) { event(Json.obj("type", "update", "available", null)); return; }
                    event(Json.obj("type", "update", "installing", r.version));
                    Updater.install(MainActivity.this, r);
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "update", "error", e.getMessage()));
                }
            }).start();
        }

        /** Opent de instelling waarmee Eigen Cloud zelf updates mag installeren. */
        @JavascriptInterface
        public void allowInstalls() {
            if (!trusted()) return;
            startActivity(Updater.installPermissionIntent(MainActivity.this));
        }

        /**
         * Startscherm: verbinden met een bestaande cloud. Al ingelogd: de cloud gaat open. Anders komt er een event
         * {type:"connect", login:true, …} en vraagt start.html om in te loggen (zie {@link #loginStart()}).
         */
        @JavascriptInterface
        public void connect(String address) {
            if (!trusted()) return;
            new Thread(() -> {
                try {
                    String url = CloudApi.normalize(address);
                    CloudApi.probe(url);
                    if (CloudApi.sessionToken(url) != null) {
                        Prefs.setStr(MainActivity.this, Prefs.CLOUD_URL, url);
                        main.post(() -> { SyncJob.schedule(MainActivity.this); web.loadUrl(url + "/"); });
                        return;
                    }
                    loginUrl = url;
                    loginHash = "";
                    event(loginState(url, "connect"));
                } catch (IOException | IllegalArgumentException e) {
                    event(Json.obj("type", "connect", "error", e.getMessage()));
                }
            }).start();
        }

        /** Het inlogscherm (start.html#inloggen) wil weten bij welke cloud en hoe: antwoord als event {type:"login", form:true, …}. */
        @JavascriptInterface
        public void loginStart() {
            if (!startPage()) return;
            String url = loginUrl != null ? loginUrl : Prefs.cloudUrl(MainActivity.this);
            if (url == null) { event(Json.obj("type", "login", "error", "Vul eerst het adres van je cloud in", "noCloud", true)); return; }
            new Thread(() -> {
                loginUrl = url;
                // Op deze telefoon opgezet en de kluis is open? Dan logt de app zelf in.
                Map<String, Object> v = ConsoleBackend.get(MainActivity.this).appLogin();
                if (v != null && url.equals(Json.str(v, "url"))) {
                    try {
                        CloudLogin.login(url, Json.str(v, "user"), Json.str(v, "password"), null);
                        loggedIn(url, Json.str(v, "user"), Json.str(v, "password"), true);
                        return;
                    } catch (IOException e) {
                        // dan gewoon het formulier
                    }
                }
                event(loginState(url, "login"));
            }).start();
        }

        /** Inloggen met wat je typte; met {@code remember} komt de inlog achter je vingerafdruk. */
        @JavascriptInterface
        public void login(String user, String password, String code, boolean remember) {
            if (!startPage()) return;
            String url = loginUrl;
            if (url == null) return;
            String pw = (password == null || password.isEmpty()) && code != null && !code.isEmpty() && mfaPassword != null ? mfaPassword : password;
            String u = (user == null || user.isEmpty()) && mfaUser != null ? mfaUser : user;
            boolean keep = (password == null || password.isEmpty()) && mfaPassword != null ? mfaRemember : remember;
            new Thread(() -> tryLogin(url, u, pw, code, keep)).start();
        }

        /** Inloggen met je vingerafdruk (de bewaarde inlog voor deze cloud). */
        @JavascriptInterface
        public void fingerprintLogin() {
            if (!startPage()) return;
            String url = loginUrl;
            if (url == null) return;
            CloudLogin.unlock(MainActivity.this, url, new CloudLogin.Unlocked() {
                @Override public void ok(String user, String password) {
                    new Thread(() -> {
                        try {
                            CloudLogin.login(url, user, password, null);
                            loggedIn(url, user, password, true);
                        } catch (CloudLogin.Failed e) {
                            if (e.mfa) {
                                mfaUser = user;
                                mfaPassword = password;
                                mfaRemember = true;
                                event(Json.obj("type", "login", "error", e.getMessage(), "mfa", true));
                            } else if (e.wrong) {
                                CloudLogin.forget(MainActivity.this);
                                event(Json.obj("type", "login", "error", "Je wachtwoord is veranderd. Log één keer in met je nieuwe wachtwoord; daarna werkt je vingerafdruk weer.", "fingerprint", false));
                            } else {
                                event(Json.obj("type", "login", "error", e.getMessage()));
                            }
                        } catch (IOException e) {
                            event(Json.obj("type", "login", "error", e.getMessage()));
                        }
                    }).start();
                }

                @Override public void fail(String message, boolean cancelled, boolean invalid) {
                    event(Json.obj("type", "login", "error", cancelled ? null : message, "cancelled", cancelled, "fingerprint", !invalid));
                }
            });
        }

        /** "Inloggen met je vingerafdruk" uitzetten (Over Eigen Cloud). */
        @JavascriptInterface
        public void forgetLogin() {
            if (!trusted()) return;
            CloudLogin.forget(MainActivity.this);
            event(Json.obj("type", "changed"));
        }

        @JavascriptInterface
        public void retry() {
            if (!trusted()) return;
            main.post(() -> open(null));
        }

        /**
         * Opnieuw instellen. "console": alleen de beheerkluis van deze telefoon wissen (met je herstelsleutel haal je
         * hem terug). "all": de app helemaal leeg, alsof hij net is geïnstalleerd. Je cloud zelf blijft altijd bestaan.
         */
        @JavascriptInterface
        public void resetApp(String scope) {
            if (!trusted()) return;
            main.post(() -> {
                MainActivity c = MainActivity.this;
                ConsoleBackend.get(c).vault.destroy();
                Biometrics.forgetAll(c);
                if ("all".equals(scope)) {
                    CloudLogin.forget(c);
                    DeviceSecrets.clear(c);
                    c.getSystemService(android.app.job.JobScheduler.class).cancelAll();
                    new Thread(() -> { CalendarSync.remove(c); OnPhoneStorage.reset(c); }).start();
                    Prefs.get(c).edit().clear().apply();
                    CookieManager.getInstance().removeAllCookies(null);
                    android.webkit.WebStorage.getInstance().deleteAllData();
                    c.getSystemService(android.app.NotificationManager.class).cancelAll();
                    SyncJob.schedule(c); // updates van de app blijven komen
                }
                web.clearHistory();
                web.loadUrl(Assets.ORIGIN + "/start.html");
            });
        }

        /** Loskoppelen: vergeet het adres en de sessie op deze telefoon (je cloud zelf blijft gewoon bestaan). */
        @JavascriptInterface
        public void forget() {
            if (!trusted()) return;
            main.post(() -> {
                Prefs.setStr(MainActivity.this, Prefs.CLOUD_URL, null);
                CloudLogin.forget(MainActivity.this);
                Prefs.setFlag(MainActivity.this, Prefs.BACKUP_PHOTOS, false);
                CookieManager.getInstance().removeAllCookies(null);
                new Thread(() -> { CalendarSync.remove(MainActivity.this); OnPhoneStorage.forgetCloud(MainActivity.this); }).start();
                Prefs.setFlag(MainActivity.this, Prefs.CALENDAR, false);
                web.clearHistory();
                web.loadUrl(Assets.ORIGIN + "/start.html");
            });
        }
    }
}
