package nl.eigencloud.app;

import android.content.Context;

import java.io.File;
import java.io.IOException;

import nl.eigencloud.core.Catalog;
import nl.eigencloud.core.ConsoleApi;

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
        }
        return instance;
    }
}
