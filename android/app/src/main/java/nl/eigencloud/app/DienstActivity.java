package nl.eigencloud.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Locale;

import nl.eigencloud.core.BeheerLink;
import nl.eigencloud.core.Bytes;
import nl.eigencloud.core.Json;

/**
 * Het beheer van een Eigen Cloud Dienst (voor aanbieders en hun medewerkers): de pagina's op {@code <dienst>/beheer}.
 * De app geeft die pagina's de brug {@code EigenNative} (zie BROKER.md, "Brug met de app"), zodat een medewerker de
 * tweede inlogstap met zijn vingerafdruk doet: per Dienst een sleutelpaar in de beveiligde hardware van de telefoon.
 */
public final class DienstActivity extends Activity {
    static final String EXTRA_URL = "dienstUrl";
    /** Pagina van het beheer om mee te openen (bijv. "klanten"); zie {@link BeheerLink}. */
    static final String EXTRA_PAGE = "dienstPage";
    private static final String PREFIX = "eigen-dienst-login:";

    private WebView web;
    private Uri dienst;
    private volatile String currentUrl = "";
    private final Handler main = new Handler(Looper.getMainLooper());
    private CancellationSignal prompting;

    /**
     * Opent het beheer van de Dienst op {@code url} (wordt eerst gecontroleerd; zie {@link #normalize}). Met een pagina in
     * het adres ({@code …/beheer#/klanten}) meteen op die pagina. Staat het beheer van deze Dienst al open, dan gaat die
     * (met de bestaande inlog) naar voren en naar de pagina, zodat je niet steeds opnieuw inlogt.
     */
    static void open(Context c, String url) {
        Intent i = new Intent(c, DienstActivity.class).putExtra(EXTRA_URL, normalize(url)).putExtra(EXTRA_PAGE, BeheerLink.page(url))
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        if (!(c instanceof Activity)) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(i);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        String base;
        try { base = normalize(i.getStringExtra(EXTRA_URL)); } catch (IllegalArgumentException e) { return; }
        String page = i.getStringExtra(EXTRA_PAGE);
        if (web == null) return;
        if (!Uri.parse(base).equals(dienst)) {
            // Een andere Dienst: opnieuw beginnen op dat adres.
            setIntent(i);
            dienst = Uri.parse(base);
            setTitle("Beheer " + dienst.getHost());
            web.loadUrl(BeheerLink.url(base, page));
            return;
        }
        if (page != null && !page.isEmpty()) {
            String js = "location.hash = " + Json.quote("#/" + page);
            main.post(() -> { if (web != null && trusted()) web.evaluateJavascript(js, null); else if (web != null) web.loadUrl(BeheerLink.url(base, page)); });
        }
    }

    /**
     * Maakt van wat iemand intypt het adres van de Dienst ({@code https://host[:poort]}). Zonder schema wordt het https.
     * Gewone http mag alleen voor een Dienst op je eigen computer of netwerk (testen), net als bij de cloud.
     */
    static String normalize(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) throw new IllegalArgumentException("Vul het adres van je dienst in");
        if (!s.contains("://")) s = "https://" + s;
        URL u;
        try { u = new URL(s); } catch (MalformedURLException e) { throw new IllegalArgumentException("Dat is geen geldig adres"); }
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty() || u.getUserInfo() != null) throw new IllegalArgumentException("Dat is geen geldig adres");
        String proto = u.getProtocol().toLowerCase(Locale.ROOT);
        boolean local = host.equals("10.0.2.2") || host.equals("127.0.0.1") || host.equals("localhost") || host.startsWith("192.168.");
        if (!"https".equals(proto) && !("http".equals(proto) && local)) throw new IllegalArgumentException("De dienst moet via https bereikbaar zijn");
        return proto + "://" + host + (u.getPort() == -1 ? "" : ":" + u.getPort());
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        // Geen schermafbeeldingen of voorbeeld in "recente apps": hier staan klantgegevens en betalingen.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        String base;
        try {
            base = normalize(getIntent().getStringExtra(EXTRA_URL));
        } catch (IllegalArgumentException e) {
            finish();
            return;
        }
        dienst = Uri.parse(base);
        setTitle("Beheer " + dienst.getHost());
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " EigenCloudApp/" + BuildConfig.VERSION_NAME);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { currentUrl = url == null ? "" : url; }

            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (sameOrigin(r.getUrl())) return false;
                openExternal(r.getUrl());
                return true;
            }

            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && sameOrigin(r.getUrl())) offline(v);
            }
        });
        web.addJavascriptInterface(new Bridge(), "EigenNative");
        if (b != null) web.restoreState(b);
        else web.loadUrl(BeheerLink.url(base, getIntent().getStringExtra(EXTRA_PAGE)));
    }

    /** Eenvoudige melding als de Dienst niet bereikbaar is (zonder brug: de pagina heeft geen dienst-adres). */
    private void offline(WebView v) {
        String host = dienst.getHost();
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='font-family:sans-serif;padding:24px;line-height:1.5'>"
                + "<h2>De dienst is niet bereikbaar</h2>"
                + "<p>Kon " + host + " niet bereiken. Heb je internet, en klopt het adres?</p>"
                + "<p><a href='" + dienst + "/beheer/'>Opnieuw proberen</a></p>";
        v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        UpdateCheck.resumed(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        UpdateCheck.paused(this);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (prompting != null) prompting.cancel();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private boolean sameOrigin(Uri u) {
        if (u == null || dienst == null || u.getScheme() == null || u.getHost() == null) return false;
        return dienst.getScheme().equalsIgnoreCase(u.getScheme()) && dienst.getHost().equalsIgnoreCase(u.getHost()) && port(dienst) == port(u);
    }

    private static int port(Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : "http".equalsIgnoreCase(u.getScheme()) ? 80 : -1;
    }

    /** Alleen de pagina's van de geopende Dienst mogen de brug gebruiken, en alleen voor hun eigen origin. */
    private boolean trusted() { return sameOrigin(Uri.parse(currentUrl)); }

    private boolean trusted(String origin) {
        if (!trusted() || origin == null) return false;
        Uri o = Uri.parse(origin.trim());
        return sameOrigin(o) && (o.getPath() == null || o.getPath().isEmpty() || "/".equals(o.getPath()));
    }

    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (RuntimeException ignored) { /* niets om mee te openen */ }
    }

    /** Antwoord van de app later aan de pagina geven (zie BROKER.md): {@code window.<fn>(waarde, fout)}. */
    private void deliver(String fn, String value, String error) {
        String js = "window." + fn + " && window." + fn + "(" + (value == null ? "null" : Json.quote(value)) + "," + (error == null ? "null" : Json.quote(error)) + ")";
        main.post(() -> { if (web != null && trusted()) web.evaluateJavascript(js, null); });
    }

    // ───────── Sleutels per Dienst ─────────

    /** Eén sleutel per Dienst; de naam komt uit de origin zodat Diensten elkaars sleutel nooit gebruiken. */
    private String alias() {
        String origin = dienst.getScheme() + "://" + dienst.getHost() + ":" + port(dienst);
        return "dienst:" + Bytes.sha256Hex(origin.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8)).substring(0, 32);
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    /** De publieke sleutel (SPKI, DER) als base64; maakt het sleutelpaar aan als het er nog niet is. */
    private String publicKey() throws Exception {
        KeyStore ks = keyStore();
        String alias = alias();
        if (ks.containsAlias(alias)) {
            Certificate cert = ks.getCertificate(alias);
            if (cert != null) return Bytes.base64(cert.getPublicKey().getEncoded());
            ks.deleteEntry(alias);
        }
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        else spec.setUserAuthenticationValidityDurationSeconds(-1);
        g.initialize(spec.build());
        PublicKey pub = g.generateKeyPair().getPublic();
        return Bytes.base64(pub.getEncoded());
    }

    private void forgetKey() {
        try { keyStore().deleteEntry(alias()); } catch (Exception ignored) { /* er was geen sleutel */ }
    }

    private void sign(String challenge) {
        if (Build.VERSION.SDK_INT < 28) { deliver("eigenDienstSigned", null, "Inloggen met je vingerafdruk kan pas vanaf Android 9. Gebruik een authenticator-app."); return; }
        if (challenge == null || !challenge.matches("[A-Za-z0-9_=-]{8,512}")) { deliver("eigenDienstSigned", null, "Ongeldige inlogvraag"); return; }
        final Signature sig;
        try {
            KeyStore ks = keyStore();
            PrivateKey key = (PrivateKey) ks.getKey(alias(), null);
            if (key == null) { deliver("eigenDienstSigned", null, "Deze telefoon is nog niet gekoppeld aan deze dienst"); return; }
            sig = Signature.getInstance("SHA256withECDSA");
            sig.initSign(key);
        } catch (KeyPermanentlyInvalidatedException e) {
            forgetKey();
            deliver("eigenDienstSigned", null, "De vingerafdrukken op deze telefoon zijn gewijzigd, dus de koppeling werkt niet meer. Log in met je authenticator-app of vraag een eigenaar om je tweede stap te wissen.");
            return;
        } catch (Exception e) {
            deliver("eigenDienstSigned", null, "Ondertekenen lukte niet: " + e.getMessage());
            return;
        }
        byte[] message = (PREFIX + challenge).getBytes(StandardCharsets.UTF_8);
        main.post(() -> prompt(sig, message));
    }

    @android.annotation.TargetApi(28)
    private void prompt(Signature sig, byte[] message) {
        if (Build.VERSION.SDK_INT < 28) { deliver("eigenDienstSigned", null, "Gebruik een authenticator-app op deze Android-versie."); return; }
        if (isFinishing() || isDestroyed()) { deliver("eigenDienstSigned", null, "Afgebroken"); return; }
        if (prompting != null) prompting.cancel();
        CancellationSignal cancel = new CancellationSignal();
        prompting = cancel;
        BiometricPrompt p = new BiometricPrompt.Builder(this)
                .setTitle("Inloggen bij " + dienst.getHost())
                .setSubtitle("Bevestig met je vingerafdruk")
                .setNegativeButton("Annuleren", getMainExecutor(), (d, w) -> {
                    if (prompting == cancel) prompting = null;
                    deliver("eigenDienstSigned", null, "Geannuleerd");
                })
                .build();
        p.authenticate(new BiometricPrompt.CryptoObject(sig), cancel, getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                if (prompting == cancel) prompting = null;
                try {
                    Signature s = result.getCryptoObject() != null && result.getCryptoObject().getSignature() != null ? result.getCryptoObject().getSignature() : sig;
                    s.update(message);
                    deliver("eigenDienstSigned", Bytes.base64(s.sign()), null);
                } catch (Exception e) {
                    deliver("eigenDienstSigned", null, "Ondertekenen lukte niet: " + e.getMessage());
                }
            }

            @Override public void onAuthenticationError(int code, CharSequence msg) {
                if (prompting == cancel) prompting = null;
                deliver("eigenDienstSigned", null, code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED
                        ? "Geannuleerd" : code == BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS
                        ? "Stel eerst een vingerafdruk in op deze telefoon (Instellingen van Android)" : String.valueOf(msg));
            }
        });
    }

    /** Wat de beheerpagina's van de Dienst kunnen aanroepen (BROKER.md, "Brug met de app"). */
    final class Bridge {
        /** Publieke sleutel van deze Dienst; direct als tekst, of bij een fout leeg en later {@code eigenDienstKey(null, fout)}. */
        @JavascriptInterface
        public String dienstKey(String origin) {
            if (!trusted(origin)) return "";
            if (Build.VERSION.SDK_INT < 28) { deliver("eigenDienstKey", null, "Inloggen met je vingerafdruk kan pas vanaf Android 9. Gebruik een authenticator-app."); return ""; }
            try {
                return publicKey();
            } catch (Exception e) {
                // Zonder ingestelde vingerafdruk weigert de Keystore een sleutel die biometrie vereist.
                String m = e instanceof IllegalStateException || e.getCause() instanceof IllegalStateException
                        ? "Stel eerst een vingerafdruk in op deze telefoon (Instellingen van Android)"
                        : "Kon geen sleutel maken: " + e.getMessage();
                deliver("eigenDienstKey", null, m);
                return "";
            }
        }

        /** Vraagt om de vingerafdruk en ondertekent; antwoord later via {@code eigenDienstSigned(handtekening, fout)}. */
        @JavascriptInterface
        public String dienstSign(String challenge, String origin) {
            if (!trusted(origin)) return "";
            sign(challenge);
            return "";
        }

        @JavascriptInterface
        public String deviceName() {
            if (!trusted()) return "";
            return Build.MANUFACTURER + " " + Build.MODEL;
        }

        @JavascriptInterface
        public void openUrl(String url) {
            if (!trusted() || url == null) return;
            Uri u = Uri.parse(url);
            if ("https".equals(u.getScheme()) || "http".equals(u.getScheme()) || "mailto".equals(u.getScheme())) main.post(() -> openExternal(u));
        }
    }
}
