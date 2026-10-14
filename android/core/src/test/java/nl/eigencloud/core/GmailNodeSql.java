package nl.eigencloud.core;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import nl.eigencloud.core.gmail.Sql;

/**
 * {@link Sql} for the JVM tests: the same SQLite the phone uses, through Node's better-sqlite3
 * (android/core/src/test/node/sqlite-bridge.cjs). Values come back as Long, Double, String or null, like on Android.
 */
final class GmailNodeSql implements Sql, AutoCloseable {
    private final Process proc;
    private final OutputStream in;
    private final BufferedReader out;

    GmailNodeSql(File dbFile) throws IOException {
        String bridge = System.getenv("SQLITE_BRIDGE");
        if (bridge == null) bridge = new File("android/core/src/test/node/sqlite-bridge.cjs").getAbsolutePath();
        String repo = new File(bridge).getParentFile().getParentFile().getParentFile().getParentFile().getParentFile().getParent();
        List<String> cmd = new ArrayList<>(java.util.Arrays.asList("node", bridge, repo));
        if (dbFile != null) cmd.add(dbFile.getAbsolutePath());
        proc = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        in = proc.getOutputStream();
        out = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
    }

    private synchronized Map<String, Object> call(String op, String sql, Object[] args) {
        try {
            List<Object> a = new ArrayList<>();
            for (Object o : args) a.add(o instanceof Boolean ? ((Boolean) o ? 1L : 0L) : o instanceof Integer ? (long) (Integer) o : o);
            in.write((Json.stringify(Json.obj("op", op, "sql", sql, "args", a)) + "\n").getBytes(StandardCharsets.UTF_8));
            in.flush();
            String line = out.readLine();
            if (line == null) throw new IllegalStateException("sqlite-bridge stopped");
            Map<String, Object> r = Json.parseObject(line);
            if (r.get("error") != null) throw new IllegalStateException("SQL: " + r.get("error") + " in " + sql);
            return r;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override public void exec(String sql, Object... args) { call("exec", sql, args); }

    @Override public List<Object[]> query(String sql, Object... args) {
        List<Object[]> rows = new ArrayList<>();
        for (Object r : Json.listAt(call("query", sql, args), "rows")) rows.add(Json.asList(r).toArray());
        return rows;
    }

    @Override public void begin() { exec("BEGIN"); }

    @Override public void commit() { exec("COMMIT"); }

    @Override public void rollback() { exec("ROLLBACK"); }

    @Override public void close() {
        try { in.close(); } catch (IOException ignored) { /* closing */ }
        try { proc.waitFor(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
