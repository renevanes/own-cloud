package nl.eigencloud.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteProgram;
import android.database.sqlite.SQLiteStatement;

import java.util.ArrayList;
import java.util.List;

import nl.eigencloud.core.gmail.Sql;

/**
 * SQLite on the phone for {@link nl.eigencloud.core.gmail.GmailStore}. Arguments are bound with their real type
 * (not all as text, which rawQuery would do), so comparisons and LIMITs behave as in the JVM tests.
 */
final class GmailSql extends SQLiteOpenHelper implements Sql {
    GmailSql(Context c) {
        super(c.getApplicationContext(), "gmail.db", null, 1);
        setWriteAheadLoggingEnabled(true);
    }

    @Override public void onCreate(SQLiteDatabase db) { /* GmailStore creates its tables */ }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { /* GmailStore migrates itself */ }

    private static void bind(SQLiteProgram p, Object[] args) {
        for (int i = 0; i < args.length; i++) {
            Object a = args[i];
            int idx = i + 1;
            if (a == null) p.bindNull(idx);
            else if (a instanceof Boolean) p.bindLong(idx, (Boolean) a ? 1 : 0);
            else if (a instanceof Double || a instanceof Float) p.bindDouble(idx, ((Number) a).doubleValue());
            else if (a instanceof Number) p.bindLong(idx, ((Number) a).longValue());
            else if (a instanceof byte[]) p.bindBlob(idx, (byte[]) a);
            else p.bindString(idx, a.toString());
        }
    }

    @Override
    public void exec(String sql, Object... args) {
        SQLiteStatement st = getWritableDatabase().compileStatement(sql);
        try {
            bind(st, args);
            st.execute();
        } finally {
            st.close();
        }
    }

    @Override
    public List<Object[]> query(String sql, Object... args) {
        List<Object[]> rows = new ArrayList<>();
        Cursor c = getWritableDatabase().rawQueryWithFactory((db, driver, table, q) -> {
            bind(q, args);
            return new SQLiteCursor(driver, table, q);
        }, sql, null, null);
        try {
            int n = c.getColumnCount();
            while (c.moveToNext()) {
                Object[] row = new Object[n];
                for (int i = 0; i < n; i++) {
                    switch (c.getType(i)) {
                        case Cursor.FIELD_TYPE_INTEGER: row[i] = c.getLong(i); break;
                        case Cursor.FIELD_TYPE_FLOAT: row[i] = c.getDouble(i); break;
                        case Cursor.FIELD_TYPE_STRING: row[i] = c.getString(i); break;
                        case Cursor.FIELD_TYPE_BLOB: row[i] = c.getBlob(i); break;
                        default: row[i] = null;
                    }
                }
                rows.add(row);
            }
        } finally {
            c.close();
        }
        return rows;
    }

    @Override public void begin() { getWritableDatabase().beginTransactionNonExclusive(); }

    @Override
    public void commit() {
        SQLiteDatabase db = getWritableDatabase();
        db.setTransactionSuccessful();
        db.endTransaction();
    }

    @Override public void rollback() { getWritableDatabase().endTransaction(); }
}
