package nl.eigencloud.core.gmail;

import java.util.List;

/**
 * The few things {@link GmailStore} needs from SQLite. On the phone this is android.database.sqlite; the JVM tests
 * use the same SQLite through Node (better-sqlite3). Keep the SQL to what Android 8's SQLite (3.18) understands:
 * no UPSERT, RETURNING, window or JSON functions.
 * Values: Long, Double, String or null (booleans as 0/1).
 */
public interface Sql {
    void exec(String sql, Object... args);

    List<Object[]> query(String sql, Object... args);

    void begin();

    void commit();

    void rollback();
}
