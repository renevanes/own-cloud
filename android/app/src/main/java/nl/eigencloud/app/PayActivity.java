package nl.eigencloud.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.net.URISyntaxException;

/**
 * Afrekenen bij Mollie (iDEAL, kaart, …) binnen de app. Zodra Mollie terugstuurt naar de bedankpagina van de
 * dienst, sluit dit scherm en werkt de beheerconsole zichzelf bij. Bank-apps (iDEAL) openen gewoon; kom je daarna
 * via de browser terug, dan werkt de console bij bij het openen.
 */
public final class PayActivity extends Activity {
    static final String EXTRA_URL = "url";
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || !url.startsWith("https://")) { finish(); return; }
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); // Mollie's betaalpagina heeft het nodig
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.equals("https") || scheme.equals("http")) {
                    if (u.getPath() != null && u.getPath().startsWith("/betaald")) { setResult(RESULT_OK); finish(); return true; }
                    return false;
                }
                // Bank-app (iDEAL) of andere app: doorgeven aan Android.
                try {
                    Intent i = scheme.equals("intent") ? Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, u);
                    i.addCategory(Intent.CATEGORY_BROWSABLE);
                    i.setComponent(null);
                    i.setSelector(null);
                    startActivity(i);
                } catch (URISyntaxException | ActivityNotFoundException e) {
                    String fallback = scheme.equals("intent") ? fallbackUrl(u.toString()) : null;
                    if (fallback != null) v.loadUrl(fallback);
                }
                return true;
            }
        });
        web.loadUrl(url);
    }

    private static String fallbackUrl(String intentUri) {
        try {
            String f = Intent.parseUri(intentUri, Intent.URI_INTENT_SCHEME).getStringExtra("browser_fallback_url");
            return f != null && f.startsWith("https://") ? f : null;
        } catch (URISyntaxException e) {
            return null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else { setResult(RESULT_CANCELED); super.onBackPressed(); }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
