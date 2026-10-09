package nl.eigencloud.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Na herstarten of bijwerken van de app de achtergrondtaken opnieuw inplannen. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (Prefs.cloudUrl(c) != null) SyncJob.schedule(c);
    }
}
