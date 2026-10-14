package nl.eigencloud.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Locale;

/**
 * Lets another app open a Gmail attachment ("Openen"): the bytes are copied to the app's cache and handed out
 * read-only through a content:// address with a one-time read permission. Not exported; nothing else is reachable.
 */
public final class GmailFiles extends ContentProvider {
    static final String AUTHORITY = "nl.eigencloud.app.gmailfiles";

    private static File base(Context c) { return new File(c.getCacheDir(), "gmail-open"); }

    /** Copies {@code data} under a fresh random folder and returns its content:// address. */
    static Uri share(Context c, String name, byte[] data) throws IOException {
        File root = base(c);
        // old copies go first (they were only needed while the other app opened them)
        File[] old = root.listFiles();
        long cutoff = System.currentTimeMillis() - 24 * 3600_000L;
        if (old != null) for (File d : old) if (d.lastModified() < cutoff) deleteDir(d);
        String token = Long.toHexString(new java.security.SecureRandom().nextLong() & Long.MAX_VALUE);
        File dir = new File(root, token);
        if (!dir.mkdirs()) throw new IOException("Kon geen tijdelijke map maken");
        String safe = name.replaceAll("[\\\\/\\x00-\\x1f]", "_");
        if (safe.isEmpty() || safe.startsWith(".")) safe = "bijlage" + safe;
        try (FileOutputStream o = new FileOutputStream(new File(dir, safe))) { o.write(data); }
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(token).appendPath(safe).build();
    }

    static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String t = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return t == null ? "application/octet-stream" : t;
    }

    private File file(Uri uri) throws FileNotFoundException {
        if (uri.getPathSegments().size() != 2) throw new FileNotFoundException();
        String token = uri.getPathSegments().get(0), name = uri.getPathSegments().get(1);
        if (!token.matches("[0-9a-f]{1,16}") || name.contains("/") || name.startsWith(".")) throw new FileNotFoundException();
        File f = new File(new File(base(getContext()), token), name);
        try {
            if (!f.getCanonicalPath().startsWith(base(getContext()).getCanonicalPath() + File.separator)) throw new FileNotFoundException();
        } catch (IOException e) {
            throw new FileNotFoundException();
        }
        if (!f.isFile()) throw new FileNotFoundException();
        return f;
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Alleen lezen");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try { f = file(uri); } catch (FileNotFoundException e) { return null; }
        String[] cols = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override public String getType(Uri uri) { return mimeFor(uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment()); }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }

    private static void deleteDir(File d) {
        File[] fs = d.listFiles();
        if (fs != null) for (File f : fs) f.delete();
        d.delete();
    }
}
