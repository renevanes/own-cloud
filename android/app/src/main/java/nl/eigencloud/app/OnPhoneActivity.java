package nl.eigencloud.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.CalendarContract;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nl.eigencloud.core.Json;
import nl.eigencloud.core.agenda.AgendaEvent;
import nl.eigencloud.core.agenda.AndroidAgenda;

/**
 * "Op deze telefoon": je Google-agenda en je foto's op de telefoon, met een eigen reservekopie, "Uit Google Foto's
 * halen" en wat het aan ruimte kost. De schermen zijn een pagina in de app (www/telefoon.html); deze activity geeft
 * ze via de brug {@code EigenDevice} toegang tot de agenda-opslag, de galerij en de foto's uit je cloud.
 */
public final class OnPhoneActivity extends Activity {
    static final String EXTRA_HASH = "hash";
    private static final int REQ_PERMS = 1, REQ_ZIPS = 2, REQ_SAVE = 3;
    private static final ExecutorService WORK = Executors.newFixedThreadPool(2);

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String currentUrl = "";
    private String pendingPermission;
    private String pendingBackupScope;
    private String[] pendingSave;

    static void open(Context c, String hash) {
        Intent i = new Intent(c, OnPhoneActivity.class).putExtra(EXTRA_HASH, validHash(hash));
        if (!(c instanceof Activity)) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    static PendingIntent pending(Context c, String hash) {
        Intent i = new Intent(c, OnPhoneActivity.class).putExtra(EXTRA_HASH, validHash(hash)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(c, 30, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static String validHash(String h) {
        return h != null && h.matches("#(agenda|fotos|galerij|opslag)") ? h : "";
    }

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
        web.setWebViewClient(new Client());
        web.addJavascriptInterface(new Bridge(), "EigenDevice");
        web.loadUrl(Assets.ORIGIN + "/telefoon.html" + validHash(getIntent().getStringExtra(EXTRA_HASH)));
        OnPhoneJob.ensure(this);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        String h = validHash(i.getStringExtra(EXTRA_HASH));
        if (!h.isEmpty()) web.loadUrl(Assets.ORIGIN + "/telefoon.html" + h);
    }

    @Override
    protected void onResume() {
        super.onResume();
        event(Json.obj("type", "changed")); // terug uit de instellingen van Android
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private boolean trusted() {
        Uri u = Uri.parse(currentUrl);
        return Assets.ours(u) && "/telefoon.html".equals(u.getPath());
    }

    private void event(Object detail) {
        String js = "window.dispatchEvent(new CustomEvent('eigendevice',{detail:" + Json.stringify(detail) + "}))";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    private final class Client extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (!Assets.ours(u)) return null;
            String p = u.getPath() == null ? "" : u.getPath();
            if (p.startsWith("/foto/")) return PhotoLibrary.serve(OnPhoneActivity.this, u, r.getRequestHeaders());
            return Assets.serve(OnPhoneActivity.this, u);
        }

        @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (Assets.ours(u)) return false;
            view(u);
            return true;
        }
    }

    private void view(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { /* niets om mee te openen */ }
    }

    private void settings(Intent i) {
        try { startActivity(i); } catch (ActivityNotFoundException e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
    }

    // ───────── Toestemmingen ─────────

    private static String[] perms(String what) {
        if ("agenda".equals(what)) return new String[]{"android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"};
        if (Build.VERSION.SDK_INT >= 34) return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED", "android.permission.ACCESS_MEDIA_LOCATION"};
        if (Build.VERSION.SDK_INT >= 33) return new String[]{"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.ACCESS_MEDIA_LOCATION"};
        if (Build.VERSION.SDK_INT >= 29) return new String[]{"android.permission.READ_EXTERNAL_STORAGE", "android.permission.ACCESS_MEDIA_LOCATION"};
        return new String[]{"android.permission.READ_EXTERNAL_STORAGE"};
    }

    private boolean has(String what) { return "agenda".equals(what) ? CalendarSync.permitted(this) : PhotoBackup.permitted(this); }

    private void ask(String what) {
        if (has(what)) { granted(what); return; }
        pendingPermission = what;
        requestPermissions(perms(what), REQ_PERMS);
    }

    private void granted(String what) {
        if ("fotos".equals(what) && pendingBackupScope != null) {
            if ("now".equals(pendingBackupScope)) PhotoBackup.startFromNow(this);
            else for (String k : new String[]{"mark.images.added", "mark.images.id", "mark.video.added", "mark.video.id"}) Prefs.setNum(this, k, 0);
            Prefs.setFlag(this, Prefs.BACKUP_PHOTOS, true);
            SyncJob.scheduleMediaTrigger(this);
            SyncJob.runNow(this);
            pendingBackupScope = null;
        }
        if ("agenda".equals(what)) OnPhoneJob.ensure(this);
        event(Json.obj("type", "permission", "what", what, "granted", true));
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(req, permissions, results);
        if (req != REQ_PERMS || pendingPermission == null) return;
        String what = pendingPermission;
        pendingPermission = null;
        if (has(what)) granted(what);
        else { pendingBackupScope = null; event(Json.obj("type", "permission", "what", what, "granted", false)); }
    }

    // ───────── Bestanden kiezen en bewaren ─────────

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        if (req == REQ_ZIPS) {
            List<Uri> uris = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
                else if (data.getData() != null) uris.add(data.getData());
            }
            if (uris.isEmpty()) { event(Json.obj("type", "takeout", "cancelled", true)); return; }
            WORK.execute(() -> {
                try {
                    TakeoutRun.choose(this, uris);
                    event(Json.obj("type", "takeout", "chosen", uris.size()));
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "takeout", "error", e.getMessage()));
                }
            });
            return;
        }
        if (req == REQ_SAVE) {
            String[] what = pendingSave;
            pendingSave = null;
            if (result != RESULT_OK || data == null || data.getData() == null || what == null) return;
            Uri target = data.getData();
            WORK.execute(() -> {
                try {
                    CalendarBackup.saveTo(this, what[0], what[1], target);
                    event(Json.obj("type", "saved"));
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "saved", "error", e.getMessage()));
                }
            });
            return;
        }
        super.onActivityResult(req, result, data);
    }

    // ───────── Brug ─────────

    /** Alles gaat via call(id, methode, json); het antwoord komt als event {type:"result", id, ok, data|error}. */
    final class Bridge {
        @JavascriptInterface
        public void call(String id, String method, String argsJson) {
            if (!trusted()) return;
            Map<String, Object> args;
            try { args = argsJson == null || argsJson.isEmpty() ? Json.obj() : Json.asMap(Json.parse(argsJson)); } catch (RuntimeException e) { args = null; }
            if (args == null) { event(Json.obj("type", "result", "id", id, "ok", false, "error", "Ongeldige vraag")); return; }
            Map<String, Object> a = args;
            if (onMain(method, a)) { event(Json.obj("type", "result", "id", id, "ok", true)); return; }
            WORK.execute(() -> {
                try {
                    Object data = handle(method, a);
                    event(Json.obj("type", "result", "id", id, "ok", true, "data", data));
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "result", "id", id, "ok", false, "error", e.getMessage() == null ? e.toString() : e.getMessage()));
                }
            });
        }
    }

    private static long num(Map<String, Object> a, String k, long def) { Number n = Json.num(a, k); return n == null ? def : n.longValue(); }

    private static String str(Map<String, Object> a, String k) { return Json.str(a, k); }

    /** Wat een scherm of kiesvenster opent (UI-thread). Geeft true als de methode hier hoort. */
    private boolean onMain(String method, Map<String, Object> a) {
        switch (method) {
            case "permission":
                if ("fotos".equals(str(a, "what"))) pendingBackupScope = str(a, "scope");
                main.post(() -> ask("agenda".equals(str(a, "what")) ? "agenda" : "fotos"));
                return true;
            case "open.syncSettings":
                main.post(() -> settings(new Intent(Settings.ACTION_SYNC_SETTINGS).putExtra(Settings.EXTRA_AUTHORITIES, new String[]{CalendarContract.AUTHORITY})));
                return true;
            case "open.addAccount":
                main.post(() -> settings(new Intent(Settings.ACTION_ADD_ACCOUNT).putExtra(Settings.EXTRA_ACCOUNT_TYPES, new String[]{PhoneCalendar.GOOGLE})));
                return true;
            case "open.appSettings":
                main.post(() -> settings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))));
                return true;
            case "close":
                main.post(this::finish);
                return true;
            case "open.takeout":
                main.post(() -> view(Uri.parse("https://takeout.google.com/")));
                return true;
            case "open.cloud": {
                String hash = str(a, "hash");
                main.post(() -> {
                    Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    if (hash != null && hash.matches("#[a-z/]{1,40}")) i.putExtra(MainActivity.EXTRA_HASH, hash);
                    startActivity(i);
                    finish();
                });
                return true;
            }
            case "takeout.pick":
                main.post(() -> {
                    Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                            .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/zip", "application/x-zip-compressed", "application/x-zip"})
                            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    try { startActivityForResult(i, REQ_ZIPS); } catch (ActivityNotFoundException e) { event(Json.obj("type", "takeout", "error", "Deze telefoon heeft geen bestandskiezer")); }
                });
                return true;
            case "agenda.saveFile": {
                String key = str(a, "key"), file = str(a, "file"), name = str(a, "name");
                main.post(() -> {
                    pendingSave = new String[]{key, file};
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/calendar")
                            .putExtra(Intent.EXTRA_TITLE, (name == null ? "agenda" : name.replaceAll("[^\\p{L}\\p{N} ._-]", "_")) + " " + file);
                    try { startActivityForResult(i, REQ_SAVE); } catch (ActivityNotFoundException e) { event(Json.obj("type", "saved", "error", "Deze telefoon heeft geen bestandskiezer")); }
                });
                return true;
            }
            default:
                return false;
        }
    }

    /** Alles wat even kan duren (achtergrondthread). */
    private Object handle(String method, Map<String, Object> a) throws IOException {
        Context c = this;
        switch (method) {
            // ── Agenda ──
            case "agenda.status": {
                if (!Json.truthy(a.get("peek")) && CalendarSync.permitted(c) && !OnPhonePrefs.flag(c, OnPhonePrefs.CAL_SEEN)) OnPhonePrefs.setFlag(c, OnPhonePrefs.CAL_SEEN, true);
                List<Object> accounts = new ArrayList<>(), others = new ArrayList<>();
                Map<String, Map<String, Object>> byAccount = new java.util.LinkedHashMap<>();
                Set<String> excluded = CalendarBackup.excluded(c);
                for (PhoneCalendar.Cal k : PhoneCalendar.calendars(c)) {
                    Map<String, Object> j = k.json();
                    j.put("backup", k.writable() && !excluded.contains(k.key()));
                    if (k.google()) {
                        Map<String, Object> acc = byAccount.get(k.account);
                        if (acc == null) {
                            acc = Json.obj("name", k.account, "sync", PhoneCalendar.syncState(k.account), "calendars", new ArrayList<Object>());
                            byAccount.put(k.account, acc);
                            accounts.add(acc);
                        }
                        Json.asList(acc.get("calendars")).add(j);
                    } else others.add(j);
                }
                return Json.obj("permitted", CalendarSync.permitted(c), "accounts", accounts, "others", others,
                        "eigenCloud", Json.obj("on", Prefs.flag(c, Prefs.CALENDAR), "skipFollowed", OnPhonePrefs.flag(c, OnPhonePrefs.CAL_SKIP_FOLLOWED)),
                        "cloud", Prefs.cloudUrl(c) != null,
                        "backup", Json.obj("on", OnPhonePrefs.flag(c, OnPhonePrefs.CAL_BACKUP), "months", OnPhonePrefs.integer(c, OnPhonePrefs.CAL_MONTHS),
                                "keep", OnPhonePrefs.integer(c, OnPhonePrefs.CAL_KEEP), "last", OnPhonePrefs.num(c, OnPhonePrefs.CAL_LAST),
                                "events", OnPhonePrefs.num(c, OnPhonePrefs.CAL_SAVED), "error", OnPhonePrefs.str(c, OnPhonePrefs.CAL_ERROR)),
                        "zone", PhoneCalendar.zone());
            }
            case "agenda.events": {
                Set<Long> ids = new HashSet<>();
                List<Object> l = Json.asList(a.get("calendars"));
                if (l != null) for (Object o : l) if (o instanceof Number) ids.add(((Number) o).longValue());
                return PhoneCalendar.instances(c, num(a, "from", 0), num(a, "to", 0), ids);
            }
            case "agenda.event":
                return PhoneCalendar.event(c, num(a, "id", -1));
            case "agenda.save": {
                boolean allDay = Json.truthy(a.get("allDay"));
                AgendaEvent e;
                try {
                    e = AndroidAgenda.fromInput(str(a, "title"), str(a, "description"), str(a, "location"), allDay, num(a, "start", 0), num(a, "end", 0),
                            PhoneCalendar.zone(), str(a, "repeat"), str(a, "rrule"), (int) num(a, "reminder", -1));
                } catch (IllegalArgumentException ex) {
                    throw new IOException(ex.getMessage());
                }
                long id = PhoneCalendar.save(c, num(a, "id", -1), num(a, "calendar", -1), e, str(a, "scope"), num(a, "instance", 0));
                return Json.obj("id", id);
            }
            case "agenda.delete":
                PhoneCalendar.delete(c, num(a, "id", -1), str(a, "scope"), num(a, "instance", 0));
                return Json.obj("ok", true);
            case "agenda.settings": {
                if (a.containsKey("backup")) OnPhonePrefs.setFlag(c, OnPhonePrefs.CAL_BACKUP, Json.truthy(a.get("backup")));
                if (a.containsKey("months")) OnPhonePrefs.setInt(c, OnPhonePrefs.CAL_MONTHS, (int) Math.max(0, Math.min(120, num(a, "months", 12))));
                if (a.containsKey("keep")) OnPhonePrefs.setInt(c, OnPhonePrefs.CAL_KEEP, (int) Math.max(1, Math.min(60, num(a, "keep", 14))));
                if (a.containsKey("skipFollowed")) {
                    OnPhonePrefs.setFlag(c, OnPhonePrefs.CAL_SKIP_FOLLOWED, Json.truthy(a.get("skipFollowed")));
                    Prefs.setNum(c, "calendar.last", 0);
                    SyncJob.runNow(c);
                }
                if (str(a, "include") != null) CalendarBackup.setIncluded(c, str(a, "include"), Json.truthy(a.get("on")));
                return Json.obj("ok", true);
            }
            case "agenda.backupNow":
                return CalendarBackup.run(c);
            case "agenda.backups":
                return CalendarBackup.list(c);
            case "agenda.preview":
                return CalendarBackup.preview(c, str(a, "key"), str(a, "file"), num(a, "calendar", -1));
            case "agenda.restore":
                return CalendarBackup.restore(c, str(a, "key"), str(a, "file"), num(a, "calendar", -1), Json.truthy(a.get("changed")));

            // ── Foto's ──
            case "fotos.status": {
                Map<String, Object> backup = Json.obj("on", Prefs.flag(c, Prefs.BACKUP_PHOTOS), "permitted", PhotoBackup.permitted(c),
                        "pending", Prefs.flag(c, Prefs.BACKUP_PHOTOS) ? PhotoBackup.pending(c) : null, "last", Prefs.num(c, "backup.last"),
                        "blocker", Prefs.flag(c, Prefs.BACKUP_PHOTOS) ? PhotoBackup.blocker(c) : null);
                return Json.obj("gallery", PhotoLibrary.gallery(c), "backup", backup, "cache", PhotoLibrary.status(c), "takeout", TakeoutRun.status(c),
                        "cloud", Prefs.cloudUrl(c) != null);
            }
            case "fotos.backupOff":
                Prefs.setFlag(c, Prefs.BACKUP_PHOTOS, false);
                return Json.obj("ok", true);
            case "fotos.settings": {
                if (a.containsKey("on")) OnPhonePrefs.setFlag(c, OnPhonePrefs.PH_CACHE, Json.truthy(a.get("on")));
                if (a.containsKey("months")) OnPhonePrefs.setInt(c, OnPhonePrefs.PH_MONTHS, (int) Math.max(0, Math.min(120, num(a, "months", 12))));
                if (a.containsKey("maxGb")) OnPhonePrefs.setInt(c, OnPhonePrefs.PH_MAX_GB, (int) Math.max(1, Math.min(512, num(a, "maxGb", 5))));
                if (a.containsKey("mobile")) OnPhonePrefs.setFlag(c, OnPhonePrefs.PH_MOBILE, Json.truthy(a.get("mobile")));
                if (a.containsKey("videos")) OnPhonePrefs.setFlag(c, OnPhonePrefs.PH_VIDEOS, Json.truthy(a.get("videos")));
                if (OnPhonePrefs.flag(c, OnPhonePrefs.PH_CACHE)) OnPhoneJob.photosNow(c);
                return Json.obj("ok", true);
            }
            case "fotos.refresh":
                OnPhoneJob.photosNow(c);
                return Json.obj("ok", true);
            case "fotos.page":
                return PhotoLibrary.page(c, (int) num(a, "offset", 0), (int) num(a, "limit", 200));
            case "fotos.prepare":
                return PhotoLibrary.prepare(c, num(a, "id", -1), Json.truthy(a.get("confirmed")));
            case "takeout.status":
                return TakeoutRun.status(c);
            case "takeout.pause":
                TakeoutRun.pause(c, Json.truthy(a.get("on")));
                return TakeoutRun.status(c);
            case "takeout.wifi":
                OnPhonePrefs.setFlag(c, OnPhonePrefs.TK_WIFI, Json.truthy(a.get("on")));
                if (TakeoutRun.active(c)) OnPhoneJob.takeout(c);
                return TakeoutRun.status(c);
            case "takeout.stop":
                TakeoutRun.stop(c);
                return TakeoutRun.status(c);

            // ── Opslag ──
            case "opslag.status":
                return Json.obj("agenda", CalendarBackup.storage(c), "fotos", PhotoLibrary.storage(c), "takeout", TakeoutRun.bytes(c),
                        "gallery", PhotoLibrary.gallery(c), "app", OnPhoneStorage.appBytes(c), "free", c.getFilesDir().getUsableSpace(),
                        "parts", OnPhoneStorage.otherParts(c));
            case "opslag.free": {
                String part = str(a, "part");
                if ("agenda".equals(part)) return Json.obj("removed", CalendarBackup.free(c));
                if ("fotos".equals(part)) return Json.obj("bytes", PhotoLibrary.free(c, str(a, "scope")));
                if ("takeout".equals(part)) {
                    if (TakeoutRun.active(c)) throw new IOException("Er loopt nog een import. Stop die eerst.");
                    TakeoutRun.stop(c);
                    return Json.obj("ok", true);
                }
                throw new IOException("Onbekend onderdeel");
            }
            case "app.info":
                return Json.obj("cloud", Prefs.cloudUrl(c), "loggedIn", CloudApi.fromApp(c) != null, "sdk", Build.VERSION.SDK_INT,
                        "notifications", Notify.allowed(c), "calendarPerm", checkSelfPermission("android.permission.READ_CALENDAR") == PackageManager.PERMISSION_GRANTED);
            default:
                throw new IOException("Onbekende vraag: " + method);
        }
    }
}
