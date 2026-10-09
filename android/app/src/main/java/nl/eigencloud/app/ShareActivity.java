package nl.eigencloud.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.widget.Toast;

import java.util.ArrayList;

/** "Delen → Eigen Cloud": zet de gedeelde foto's en video's in je cloud, op de achtergrond. */
public final class ShareActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Intent in = getIntent();
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(in.getAction())) {
            Uri u = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
            ArrayList<Uri> l = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) uris.addAll(l);
        }
        if (uris.isEmpty()) { finish(); return; }
        if (CloudApi.fromApp(this) == null) {
            Toast.makeText(this, "Open eerst Eigen Cloud en log in", Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }
        ClipData clip = ClipData.newRawUri("media", uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        Notify.channels(this);
        SyncJob.share(this, clip);
        Toast.makeText(this, uris.size() == 1 ? "Wordt in je cloud gezet" : uris.size() + " bestanden worden in je cloud gezet", Toast.LENGTH_SHORT).show();
        finish();
    }

    static String displayName(Context c, Uri u) {
        try (Cursor cur = c.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cur != null && cur.moveToFirst() && !cur.isNull(0)) return cur.getString(0);
        } catch (RuntimeException ignored) {
            // geen naam
        }
        String last = u.getLastPathSegment();
        return last == null ? "gedeeld" : last;
    }
}
