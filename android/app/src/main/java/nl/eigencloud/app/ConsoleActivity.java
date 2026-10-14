package nl.eigencloud.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
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

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import nl.eigencloud.core.ConsoleApi;
import nl.eigencloud.core.Json;
import nl.eigencloud.core.Passwords;

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

    /** Route van de console om mee te openen, bijv. "#aanbieder" (Je dienst / aanbieder worden). */
    static final String EXTRA_HASH = "consoleHash";

    static void open(Context c) { c.startActivity(new Intent(c, ConsoleActivity.class)); }

    /** De console op een route openen; alleen "#aanbieder", "#aanbieder/<onderdeel>" en "#jij" (toch een eigen cloud). */
    static void open(Context c, String hash) {
        Intent i = new Intent(c, ConsoleActivity.class);
        if (hash != null && hash.matches("^#(aanbieder(/[a-z]{1,20})?|jij)$")) i.putExtra(EXTRA_HASH, hash);
        c.startActivity(i);
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // Geen schermafbeeldingen of voorbeeld in "recente apps": hier staan je herstelsleutel en API-tokens.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        backend = ConsoleBackend.get(this);
        // De kluis achter je vingerafdruk: de vragen verschijnen boven deze activity.
        Biometrics.LOCK.attach(this);
        backend.deviceLock = Biometrics.LOCK;
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
        else {
            String hash = getIntent().getStringExtra(EXTRA_HASH);
            web.loadUrl(Assets.ORIGIN + "/index.html" + (hash != null && hash.matches("^#(aanbieder(/[a-z]{1,20})?|jij)$") ? hash : ""));
        }
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
        Biometrics.LOCK.attach(this);
        paid();
        // Terug uit bijv. de instellingen van Android (vingerafdruk ingesteld?): de console kijkt opnieuw.
        web.evaluateJavascript("window.__eigenResume && window.__eigenResume()", null);
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
        Biometrics.LOCK.detach(this);
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
                // Kluis net overgezet naar de vingerafdruk: de oude vingerafdruk-ontgrendeling (wachtwoordzin-kluis) is niet meer nodig.
                if ("POST".equals(method) && "/api/vault/device".equals(path) && r.status == 200) { Biometrics.forget(ConsoleActivity.this); updateBiometricState(false); }
                reply(id, r.status, r.body);
            });
        }

        /** "Vingerafdruk instellen": de instellingen van Android (daarna kijkt de console opnieuw, zie onResume). */
        @JavascriptInterface
        public void openSecuritySettings() {
            if (!onOurPage()) return;
            main.post(() -> Biometrics.openSecuritySettings(ConsoleActivity.this));
        }

        /**
         * "Plakken" bij een sleutel of token: het klembord lezen en daarna leegmaken (Android 9+), zodat het geheim niet
         * op het klembord blijft staan. {"text": opgeschoond, "raw": zoals gekopieerd, "cleared": true/false}.
         */
        @JavascriptInterface
        public String takeClipboard() {
            if (!onOurPage()) return "{\"text\":\"\",\"cleared\":false}";
            String raw = clipboard();
            boolean cleared = !raw.isEmpty() && clearClip();
            String r = raw.length() > 8192 ? raw.substring(0, 8192) : raw;
            return Json.stringify(Json.obj("text", Passwords.normalizePaste(r), "raw", r, "cleared", cleared));
        }

        /** Het klembord leegmaken (na automatisch invullen van gekopieerde sleutels). */
        @JavascriptInterface
        public boolean clearClipboard() {
            return onOurPage() && clearClip();
        }

        /** Een geheim (bijv. het wachtwoord van je cloud) naar het klembord: gemarkeerd als gevoelig, na een minuut weer weg. */
        @JavascriptInterface
        public void copySecret(String text) {
            if (!onOurPage() || text == null) return;
            main.post(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) return;
                ClipData clip = ClipData.newPlainText("Eigen Cloud", text);
                android.os.PersistableBundle extras = new android.os.PersistableBundle();
                extras.putBoolean("android.content.extra.IS_SENSITIVE", true); // ClipDescription.EXTRA_IS_SENSITIVE (Android 13+)
                clip.getDescription().setExtras(extras);
                cm.setPrimaryClip(clip);
                main.postDelayed(() -> {
                    try {
                        ClipData now = cm.getPrimaryClip();
                        if (now != null && now.getItemCount() > 0 && text.contentEquals(now.getItemAt(0).coerceToText(ConsoleActivity.this))) clearClip();
                    } catch (RuntimeException ignored) { /* niet meer bij het klembord */ }
                }, 60_000);
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
            final String u;
            try {
                u = CloudApi.normalize(url);
            } catch (IllegalArgumentException e) {
                openExternal(Uri.parse(url));
                return;
            }
            Prefs.setStr(ConsoleActivity.this, Prefs.CLOUD_URL, u);
            // Opgezet op deze telefoon? Dan logt de app zelf in met het wachtwoord uit de kluis: niets te typen.
            Map<String, Object> login = backend.appLogin();
            pool.execute(() -> {
                if (login != null && CloudApi.sessionToken(u) == null) {
                    try {
                        if (u.equals(CloudApi.normalize(Json.str(login, "url")))) {
                            CloudLogin.login(u, Json.str(login, "user"), Json.str(login, "password"), null);
                            CloudLogin.remember(ConsoleActivity.this, u, Json.str(login, "user"), Json.str(login, "password"));
                        }
                    } catch (IOException | RuntimeException ignored) {
                        // dan het inlogscherm van de app
                    }
                }
                main.post(() -> startActivity(new Intent(ConsoleActivity.this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)));
            });
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

        /**
         * Voor aanbieders: het beheer van de eigen Dienst openen (zelfde scherm als vanuit de app, met vingerafdruk), ook
         * meteen op een pagina: {@code https://dienst.x.nl/beheer#/klanten}.
         */
        @JavascriptInterface
        public void openDienst(String url) {
            if (!onOurPage()) return;
            main.post(() -> {
                try {
                    String u = DienstActivity.normalize(url);
                    Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_URL, u);
                    DienstActivity.open(ConsoleActivity.this, url);
                } catch (IllegalArgumentException e) {
                    Uri x = Uri.parse(url);
                    if ("https".equals(x.getScheme())) openExternal(x);
                }
            });
        }

        /** Je eigen Dienst onthouden voor het startscherm van de app ("<naam> beheren"); lege waarden = vergeten. */
        @JavascriptInterface
        public void rememberDienst(String url, String name, String alleen) {
            if (!onOurPage()) return;
            Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_OWN_ONLY, "1".equals(alleen) ? "1" : null);
            String u = url == null ? "" : url.trim(), n = name == null ? "" : name.trim();
            if (u.isEmpty()) {
                Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_OWN_URL, null);
                Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_OWN_NAME, null);
                return;
            }
            try { u = DienstActivity.normalize(u); } catch (IllegalArgumentException e) { return; }
            Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_OWN_URL, u);
            Prefs.setStr(ConsoleActivity.this, Prefs.DIENST_OWN_NAME, n.length() > 60 ? n.substring(0, 60) : n);
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

    /** Het klembord leegmaken: Android 9+ kan dat netjes; daarvoor een leeg klembord. */
    private boolean clearClip() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
            else cm.setPrimaryClip(ClipData.newPlainText("", ""));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
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
