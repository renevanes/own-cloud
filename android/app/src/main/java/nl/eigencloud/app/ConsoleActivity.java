package nl.eigencloud.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nl.eigencloud.core.ConsoleApi;
import nl.eigencloud.core.Json;

/**
 * De beheerconsole op de telefoon: zelf je cloud opzetten bij Hetzner, Scaleway of UpCloud, opslag en DNS
 * koppelen, starten, laten slapen en wekken. De schermen zijn dezelfde als op de computer; het werk doet de
 * Java-kern ({@link ConsoleBackend}). Je sleutels staan versleuteld op deze telefoon.
 */
public final class ConsoleActivity extends Activity {
    private WebView web;
    private ConsoleApi backend;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());

    static void open(Context c) { c.startActivity(new Intent(c, ConsoleActivity.class)); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // Geen schermafbeeldingen of voorbeeld in "recente apps": hier staan je herstelsleutel en API-tokens.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        backend = ConsoleBackend.get(this);
        updateBiometricState(true);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return Assets.ours(r.getUrl()) ? Assets.serve(ConsoleActivity.this, r.getUrl()) : null;
            }

            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (Assets.ours(r.getUrl())) return false;
                openExternal(r.getUrl());
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "EigenNative");
        if (b != null) web.restoreState(b);
        else web.loadUrl(Assets.ORIGIN + "/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    private static final int REQ_PAY = 7;
    private volatile boolean wasUnlocked, autoBio = true;
    private WebView printView;

    @Override
    protected void onPause() {
        super.onPause();
        UpdateCheck.paused(this);
        wasUnlocked = backend.unlocked();
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_PAY) paid();
    }

    /** Terug van betalen (in de app of via een bank-app en de browser): de console werkt de status bij. */
    private void paid() { web.evaluateJavascript("window.__eigenPaid && window.__eigenPaid()", null); }

    @Override
    protected void onResume() {
        super.onResume();
        paid();
        UpdateCheck.resumed(this);
        // Is de kluis intussen op slot gegaan (15 minuten niets gedaan)? Dan meteen het slotscherm.
        if (wasUnlocked && !backend.unlocked()) { autoBio = true; web.reload(); }
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

    private void updateBiometricState(boolean auto) {
        backend.biometric = Json.obj("available", Biometrics.available(this), "enrolled", Biometrics.enrolled(this), "auto", auto);
    }

    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (RuntimeException ignored) { /* geen browser */ }
    }

    private void reply(int id, int status, String body) {
        main.post(() -> web.evaluateJavascript("window.__eigenReply(" + id + "," + status + "," + Json.quote(body) + ")", null));
    }

    /** Wat de schermen van de console kunnen aanroepen (alleen vanaf de eigen pagina's van de app). */
    final class Bridge {
        @JavascriptInterface
        public void call(int id, String method, String path, String body) {
            if (!onOurPage()) return;
            if ("POST".equals(method) && "/api/unlock/biometric".equals(path)) { biometricUnlock(id); return; }
            if ("POST".equals(method) && "/api/biometric/enroll".equals(path)) { biometricEnroll(id); return; }
            pool.execute(() -> {
                if ("GET".equals(method) && "/api/state".equals(path)) { updateBiometricState(autoBio); autoBio = false; }
                ConsoleApi.Reply r = backend.handle(method, path, body);
                reply(id, r.status, r.body);
            });
        }

        @JavascriptInterface
        public void printRecoverySheet() {
            if (!onOurPage()) return;
            main.post(ConsoleActivity.this::print);
        }

        /** Afrekenen bij Mollie binnen de app. */
        @JavascriptInterface
        public void openPay(String url) {
            if (!onOurPage() || url == null || !url.startsWith("https://")) return;
            main.post(() -> startActivityForResult(new Intent(ConsoleActivity.this, PayActivity.class).putExtra(PayActivity.EXTRA_URL, url), REQ_PAY));
        }

        /** Een HTML-document afdrukken of als pdf bewaren (bijv. een factuur). */
        @JavascriptInterface
        public void printHtml(String title, String html) {
            if (!onOurPage() || html == null) return;
            main.post(() -> printDocument(title == null ? "Eigen Cloud" : title, html));
        }

        @JavascriptInterface
        public void openCloud(String url) {
            if (!onOurPage()) return;
            try {
                String u = CloudApi.normalize(url);
                Prefs.setStr(ConsoleActivity.this, Prefs.CLOUD_URL, u);
                startActivity(new Intent(ConsoleActivity.this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
            } catch (IllegalArgumentException e) {
                openExternal(Uri.parse(url));
            }
        }

        /** Tekst op het klembord (voor "Plakken" bij de Scaleway-sleutels); leeg als er niets is of het niet mag. */
        @JavascriptInterface
        public String clipboard() {
            if (!onOurPage()) return "";
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm == null ? null : cm.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence t = clip.getItemAt(0).coerceToText(ConsoleActivity.this);
                return t == null ? "" : t.toString();
            } catch (RuntimeException e) {
                return ""; // geen focus of geen toestemming (Android 10+): niets
            }
        }

        /** Uitnodiging van een aanbieder (eigencloud://uitnodiging-link): {"dienst":"https://…","code":"…"} of null. */
        @JavascriptInterface
        public String pendingInvite() {
            if (!onOurPage()) return "null";
            String dienst = Prefs.str(ConsoleActivity.this, Prefs.INVITE_DIENST), code = Prefs.str(ConsoleActivity.this, Prefs.INVITE_CODE);
            if (dienst == null || code == null) return "null";
            return Json.stringify(Json.obj("dienst", dienst, "code", code));
        }

        /** De uitnodiging is verwerkt (of afgewezen): vergeten. */
        @JavascriptInterface
        public void clearInvite() {
            if (!onOurPage()) return;
            Prefs.setStr(ConsoleActivity.this, Prefs.INVITE_DIENST, null);
            Prefs.setStr(ConsoleActivity.this, Prefs.INVITE_CODE, null);
        }

        /** Voor aanbieders: het beheer van de eigen Dienst openen (zelfde scherm als vanuit de app, met vingerafdruk). */
        @JavascriptInterface
        public void openDienst(String url) {
            if (!onOurPage()) return;
            main.post(() -> {
                try {
                    String u = DienstActivity.normalize(url);
                    Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_URL, u);
                    DienstActivity.open(ConsoleActivity.this, u);
                } catch (IllegalArgumentException e) {
                    Uri x = Uri.parse(url);
                    if ("https".equals(x.getScheme())) openExternal(x);
                }
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (!onOurPage()) return;
            Uri u = Uri.parse(url);
            if ("https".equals(u.getScheme()) || "http".equals(u.getScheme())) openExternal(u);
        }
    }

    private volatile String currentUrl = "";

    /** De pagina kan alleen van de app komen (andere adressen gaan naar de browser), maar controleer toch. */
    private boolean onOurPage() { return currentUrl.startsWith(Assets.ORIGIN + "/"); }

    private void biometricUnlock(int id) {
        Biometrics.unlock(this, new Biometrics.Done() {
            @Override public void ok(byte[] key) {
                pool.execute(() -> {
                    try {
                        backend.vault.unlockWithKey(key);
                        backend.touch();
                        reply(id, 200, "{\"ok\":true}");
                    } catch (Exception e) {
                        Biometrics.forget(ConsoleActivity.this);
                        updateBiometricState(false);
                        reply(id, 401, Json.stringify(Json.obj("error", "Dat lukte niet; ontgrendel met je wachtwoordzin")));
                    }
                });
            }

            @Override public void fail(String message) {
                updateBiometricState(false);
                reply(id, 401, Json.stringify(Json.obj("error", message)));
            }
        });
    }

    private void biometricEnroll(int id) {
        if (!backend.unlocked() || !Biometrics.available(this)) { reply(id, 400, Json.stringify(Json.obj("error", "Niet beschikbaar"))); return; }
        Biometrics.enroll(this, backend.vault.exportKey(), new Biometrics.Done() {
            @Override public void ok(byte[] unused) { updateBiometricState(false); reply(id, 200, "{\"ok\":true}"); }

            @Override public void fail(String message) { reply(id, 400, Json.stringify(Json.obj("error", message))); }
        });
    }

    /** Herstelblad via Android-afdrukken (daar kun je ook "Opslaan als pdf" kiezen). */
    private void print() {
        final String html;
        try { html = backend.recoverySheet(); } catch (SecurityException e) { return; }
        printDocument("Herstelblad Eigen Cloud", html);
    }

    private void printDocument(String title, String html) {
        WebView pv = new WebView(this);
        printView = pv; // vasthouden tot het afdrukken klaar is
        pv.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return Assets.ours(r.getUrl()) ? Assets.serve(ConsoleActivity.this, r.getUrl()) : null;
            }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }

            @Override public void onPageFinished(WebView v, String url) {
                PrintManager pm = getSystemService(PrintManager.class);
                pm.print(title, v.createPrintDocumentAdapter(title),
                        new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
            }
        });
        pv.loadDataWithBaseURL(Assets.ORIGIN + "/", html, "text/html", "utf-8", null);
    }
}
