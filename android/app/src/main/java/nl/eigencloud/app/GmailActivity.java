package nl.eigencloud.app;

import android.accounts.AccountManager;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.gmail.GmailApi;
import nl.eigencloud.core.gmail.GmailStore;
import nl.eigencloud.core.gmail.GmailSync;

/**
 * "Gmail op deze telefoon": the screens (www/gmail.html) on top of {@link GmailBackend}. The page calls the Java
 * core through the bridge {@code EigenGmail}; a message is shown in a sandboxed frame from
 * {@code /gmail/view/<id>} (sanitized HTML, strict Content-Security-Policy: no scripts, remote images only after
 * "Afbeeldingen tonen"). Links open in the browser; mailto: opens a new message here.
 */
public final class GmailActivity extends Activity {
    static final String EXTRA_OPEN = "gmailOpen";
    private static final int REQ_ACCOUNT = 7231, REQ_FILES = 7232, REQ_SAVE = 7233, REQ_NOTIFY = 7234;
    private static final long MAX_ATTACH = 25L * 1024 * 1024;

    private WebView web;
    private GmailBackend backend;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String currentUrl = "";
    private byte[] pendingSave;

    static void open(Context c) {
        c.startActivity(new Intent(c, GmailActivity.class));
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Notify.channels(this);
        backend = GmailBackend.get(this);
        if (GmailBackend.configured(this)) GmailJob.schedule(this);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setBlockNetworkLoads(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (Assets.ours(u) && u.getPath() != null && u.getPath().startsWith("/gmail/")) return content(u);
                return Assets.ours(u) ? Assets.serve(GmailActivity.this, u) : null;
            }

            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (Assets.ours(u)) return false;
                if ("mailto".equals(u.getScheme())) {
                    event(Json.obj("type", "mailto", "to", u.getSchemeSpecificPart().replaceAll("\\?.*$", "")));
                    return true;
                }
                if ("https".equals(u.getScheme()) || "http".equals(u.getScheme()) || "tel".equals(u.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { /* no app */ }
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "EigenGmail");
        String open = getIntent().getStringExtra(EXTRA_OPEN);
        if (b != null) web.restoreState(b);
        else web.loadUrl(Assets.ORIGIN + "/gmail.html" + (open != null && open.matches("\\d+") ? "#msg/" + open : ""));
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        String open = i.getStringExtra(EXTRA_OPEN);
        if (open != null && open.matches("\\d+")) web.loadUrl(Assets.ORIGIN + "/gmail.html#msg/" + open);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        GmailBackend.visible = true;
        Notify.cancel(this, GmailBackend.NOTIFY_ID);
        startLoop();
        event(Json.obj("type", "resume"));
    }

    @Override
    protected void onPause() {
        super.onPause();
        GmailBackend.visible = false;
        backend.stopLoop();
    }

    @Override
    protected void onStop() {
        super.onStop();
        pool.execute(() -> { GmailSync s = backend.api.sync(); if (s != null) s.closeInteractive(); });
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        pool.shutdown();
        web.destroy();
        super.onDestroy();
    }

    private void startLoop() {
        if (!GmailBackend.configured(this)) return;
        backend.startLoop(r -> event(Json.obj("type", "sync", "ok", r.ok, "error", r.error, "fresh", (long) r.fresh.size(), "more", r.more)));
    }

    private void event(Object detail) {
        String js = "window.dispatchEvent(new CustomEvent('gmail',{detail:" + Json.stringify(detail) + "}))";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    private boolean onOurPage() { return currentUrl.startsWith(Assets.ORIGIN + "/gmail.html"); }

    // ───────── Message content for the frame ─────────

    private WebResourceResponse content(Uri u) {
        List<String> seg = u.getPathSegments(); // gmail, view|part, id[, section]
        try {
            if (seg.size() == 3 && seg.get(1).equals("view") && seg.get(2).matches("\\d+")) {
                boolean images = "1".equals(u.getQueryParameter("img"));
                byte[] html = backend.api.viewDocument(seg.get(2), images).getBytes(StandardCharsets.UTF_8);
                Map<String, String> h = new HashMap<>();
                h.put("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src " + Assets.ORIGIN + " data:" + (images ? " https: http:" : "")
                        + "; font-src data:; base-uri 'none'; form-action 'none'");
                h.put("Cache-Control", "no-store");
                h.put("Referrer-Policy", "no-referrer");
                return new WebResourceResponse("text/html", "utf-8", 200, "OK", h, new ByteArrayInputStream(html));
            }
            if (seg.size() == 4 && seg.get(1).equals("part") && seg.get(2).matches("\\d+") && seg.get(3).matches("[0-9.]+")) {
                String type = null;
                for (GmailStore.PartRow p : backend.store.parts(seg.get(2))) if (p.section.equals(seg.get(3))) type = p.type;
                byte[] data = type != null && type.startsWith("image/") ? backend.api.partData(seg.get(2), seg.get(3), false) : null;
                if (data != null) {
                    Map<String, String> h = new HashMap<>();
                    h.put("Cache-Control", "no-store");
                    h.put("Content-Security-Policy", "default-src 'none'");
                    return new WebResourceResponse(type, null, 200, "OK", h, new ByteArrayInputStream(data));
                }
            }
        } catch (IOException | RuntimeException e) {
            // fall through to 404
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    // ───────── Bridge ─────────

    final class Bridge {
        @JavascriptInterface
        public void call(int id, String method, String path, String body) {
            if (!onOurPage()) return;
            pool.execute(() -> {
                GmailApi.Reply r = backend.api.handle(method, path, body);
                if (r.status == 200 && ("/api/setup".equals(path) || "/api/sync".equals(path) || "/api/settings".equals(path))) {
                    main.post(GmailActivity.this::startLoop);
                }
                if ("/api/forget".equals(path)) backend.stopLoop();
                main.post(() -> web.evaluateJavascript("window.__gmailReply(" + id + "," + r.status + "," + Json.quote(r.body) + ")", null));
            });
        }

        /** Reads the app password from the clipboard (it stays in Java); returns {ok, masked} or {ok:false, error}. */
        @JavascriptInterface
        public String pastePassword() {
            if (!onOurPage()) return "null";
            String text = "";
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            try {
                ClipData clip = cm == null ? null : cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence t = clip.getItemAt(0).coerceToText(GmailActivity.this);
                    text = t == null ? "" : t.toString();
                }
            } catch (RuntimeException e) {
                text = "";
            }
            Map<String, Object> res = backend.api.pastePassword(text);
            if (Boolean.TRUE.equals(res.get("ok")) && cm != null && Build.VERSION.SDK_INT >= 28) {
                try { cm.clearPrimaryClip(); } catch (RuntimeException ignored) { /* not allowed: leave it */ }
            }
            return Json.stringify(res);
        }

        /** The phone's account picker (no permission needed); answer as event {type:"account", address}. */
        @JavascriptInterface
        public void pickAccount() {
            if (!onOurPage()) return;
            main.post(() -> {
                try {
                    Intent i = AccountManager.newChooseAccountIntent(null, null, new String[]{"com.google"}, null, null, null, null);
                    startActivityForResult(i, REQ_ACCOUNT);
                } catch (ActivityNotFoundException | SecurityException e) {
                    event(Json.obj("type", "account", "error", "Kies je account hier niet; vul je adres in"));
                }
            });
        }

        @JavascriptInterface
        public void openAppPasswords() {
            if (!onOurPage()) return;
            main.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://myaccount.google.com/apppasswords")));
                } catch (ActivityNotFoundException e) {
                    event(Json.obj("type", "error", "error", "Geen browser gevonden om Google te openen"));
                }
            });
        }

        /** Fingerprint or the phone's PIN; answer as event {type:"confirm", ok, error}. */
        @JavascriptInterface
        public void confirm(String title) {
            if (!onOurPage()) return;
            main.post(() -> GmailConfirm.ask(GmailActivity.this, title == null || title.isEmpty() ? "Gmail-instellingen" : title, (ok, msg) -> {
                if (ok) backend.confirmedUntil = System.currentTimeMillis() + 5 * 60_000L;
                event(Json.obj("type", "confirm", "ok", ok, "error", msg));
            }));
        }

        /** The system file picker; picked files are copied for the new message: event {type:"files", files:[{token,name,size,type}]}. */
        @JavascriptInterface
        public void pickFiles() {
            if (!onOurPage()) return;
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_FILES);
                } catch (ActivityNotFoundException e) {
                    event(Json.obj("type", "files", "error", "Geen bestandskiezer gevonden"));
                }
            });
        }

        /** Opens an attachment with another app (downloaded from Gmail first when needed). */
        @JavascriptInterface
        public void openAttachment(String id, String section) {
            if (!onOurPage() || id == null || !id.matches("\\d+") || section == null || !section.matches("[0-9.]+")) return;
            pool.execute(() -> {
                try {
                    String name = partName(id, section);
                    byte[] data = backend.api.partData(id, section, true);
                    Uri uri = GmailFiles.share(GmailActivity.this, name, data);
                    Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, GmailFiles.mimeFor(name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    main.post(() -> {
                        try {
                            startActivity(Intent.createChooser(i, name));
                            event(Json.obj("type", "attachment", "ok", true, "section", section));
                        } catch (ActivityNotFoundException e) {
                            event(Json.obj("type", "attachment", "section", section, "error", "Geen app om dit te openen. Kies Bewaren."));
                        }
                    });
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "attachment", "section", section, "error", GmailSync.friendly(e)));
                }
            });
        }

        /** Saves an attachment where you choose (system "save as"). */
        @JavascriptInterface
        public void saveAttachment(String id, String section) {
            if (!onOurPage() || id == null || !id.matches("\\d+") || section == null || !section.matches("[0-9.]+")) return;
            pool.execute(() -> {
                try {
                    String name = partName(id, section);
                    byte[] data = backend.api.partData(id, section, true);
                    main.post(() -> {
                        pendingSave = data;
                        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(GmailFiles.mimeFor(name)).putExtra(Intent.EXTRA_TITLE, name);
                        try {
                            startActivityForResult(i, REQ_SAVE);
                        } catch (ActivityNotFoundException e) {
                            pendingSave = null;
                            event(Json.obj("type", "attachment", "section", section, "error", "Bewaren kan hier niet"));
                        }
                    });
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "attachment", "section", section, "error", GmailSync.friendly(e)));
                }
            });
        }

        @JavascriptInterface
        public boolean notificationsAllowed() { return Notify.allowed(GmailActivity.this); }

        /** Android 13+: asks once for permission to show notifications. */
        @JavascriptInterface
        public void askNotifications() {
            if (!onOurPage() || Build.VERSION.SDK_INT < 33 || Notify.allowed(GmailActivity.this)) return;
            main.post(() -> requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY));
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (!onOurPage() || url == null) return;
            Uri u = Uri.parse(url);
            if (!"https".equals(u.getScheme())) return;
            main.post(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { /* no browser */ }
            });
        }

        /** Back to the rest of the app (start screen or cloud). */
        @JavascriptInterface
        public void openApp() {
            if (!onOurPage()) return;
            main.post(() -> {
                startActivity(new Intent(GmailActivity.this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
                finish();
            });
        }
    }

    private String partName(String id, String section) {
        for (GmailStore.PartRow p : backend.store.parts(id)) if (p.section.equals(section)) return p.toPart().displayName();
        return "bijlage";
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req == REQ_NOTIFY) event(Json.obj("type", "notifications", "allowed", results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED));
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (GmailConfirm.activityResult(req, result)) return;
        if (req == REQ_ACCOUNT) {
            String name = result == RESULT_OK && data != null ? data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME) : null;
            event(Json.obj("type", "account", "address", name));
        } else if (req == REQ_FILES) {
            List<Uri> uris = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
                else if (data.getData() != null) uris.add(data.getData());
            }
            pool.execute(() -> copyPicked(uris));
        } else if (req == REQ_SAVE) {
            byte[] bytes = pendingSave;
            pendingSave = null;
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            if (bytes == null || uri == null) return;
            pool.execute(() -> {
                try (OutputStream o = getContentResolver().openOutputStream(uri)) {
                    if (o == null) throw new IOException("Kon niet schrijven");
                    o.write(bytes);
                    event(Json.obj("type", "attachment", "ok", true, "saved", true));
                } catch (IOException | RuntimeException e) {
                    event(Json.obj("type", "attachment", "error", "Bewaren mislukt: " + e.getMessage()));
                }
            });
        }
    }

    /** Copies picked files into the app (tmp/<token>) so the message can be built later, even offline. */
    private void copyPicked(List<Uri> uris) {
        List<Object> files = new ArrayList<>();
        String error = null;
        File dir = backend.api.tmpDir();
        for (Uri u : uris) {
            String name = "bijlage", type = getContentResolver().getType(u);
            try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (RuntimeException ignored) {
                // keep the default name
            }
            String token = Bytes.hex(Bytes.random(16));
            File f = new File(dir, token);
            long size = 0;
            try (InputStream in = getContentResolver().openInputStream(u); OutputStream o = new FileOutputStream(f)) {
                if (in == null) throw new IOException("Kon het bestand niet lezen");
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) {
                    size += n;
                    if (size > MAX_ATTACH) throw new IOException(name + " is groter dan 25 MB; dat neemt Gmail niet aan");
                    o.write(buf, 0, n);
                }
                files.add(Json.obj("token", token, "name", name, "size", size, "type", type == null ? "application/octet-stream" : type));
            } catch (IOException | SecurityException e) {
                f.delete();
                error = e.getMessage();
            }
        }
        event(Json.obj("type", "files", "files", files, "error", error));
    }
}
