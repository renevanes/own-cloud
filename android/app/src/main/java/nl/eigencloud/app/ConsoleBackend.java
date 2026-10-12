package nl.eigencloud.app;

import android.content.Context;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;

import nl.eigencloud.core.Catalog;
import nl.eigencloud.core.ConsoleApi;
import nl.eigencloud.core.Extras;

/**
 * De beheerconsole op de telefoon: dezelfde /api-aanroepen als op de computer (src/console/server.ts), maar
 * uitgevoerd door de Java-kern ({@link ConsoleApi}). De kluis staat in de app-map, alleen voor deze app leesbaar.
 */
final class ConsoleBackend {
    private ConsoleBackend() {}

    private static ConsoleApi instance;

    static synchronized ConsoleApi get(Context c) {
        if (instance == null) {
            Context app = c.getApplicationContext();
            Catalog catalog;
            try {
                catalog = Catalog.load(app.getAssets().open("catalog.json"));
            } catch (IOException e) {
                throw new IllegalStateException("catalog.json ontbreekt in de app", e);
            }
            // Zodra een nieuw gestarte cloud bereikbaar is, weet de app waar hij is.
            instance = new ConsoleApi(new File(new File(app.getFilesDir(), "beheer"), "kluis.json"), catalog, url -> {
                if (Prefs.cloudUrl(app) == null) Prefs.setStr(app, Prefs.CLOUD_URL, url);
            });
            instance.dienstUrl = BuildConfig.DIENST_URL;
            // De lijst van aanbieders bij deze versie: gebruikt als de lijst op GitHub niet op te halen is.
            try (InputStream in = app.getAssets().open("www/aanbieders.json")) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                Extras.bundledAanbieders = new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
            } catch (IOException e) {
                // zonder meegeleverde lijst
            }
        }
        return instance;
    }
}
