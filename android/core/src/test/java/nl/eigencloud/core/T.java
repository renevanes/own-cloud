package nl.eigencloud.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Map;
import java.util.Objects;

/** Minimal test harness (no JUnit available): assertions, failure count, fixtures and outputs. */
final class T {
    private T() {}

    static int failures = 0;
    static int checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            failures++;
            System.out.println("  FAIL: " + what);
        }
    }

    static void eq(Object expected, Object actual, String what) {
        checks++;
        if (!Objects.equals(expected, actual)) {
            failures++;
            String e = String.valueOf(expected), a = String.valueOf(actual);
            if (e.length() > 400 || a.length() > 400) {
                int i = 0;
                while (i < e.length() && i < a.length() && e.charAt(i) == a.charAt(i)) i++;
                int from = Math.max(0, i - 60);
                e = "…" + e.substring(from, Math.min(e.length(), i + 120));
                a = "…" + a.substring(from, Math.min(a.length(), i + 120));
            }
            System.out.println("  FAIL: " + what + "\n    expected: " + e + "\n    actual:   " + a);
        }
    }

    /** Asserts that the runnable throws and the message contains {@code part}. */
    static void throwsWith(String part, ThrowingRunnable r, String what) {
        checks++;
        try {
            r.run();
            failures++;
            System.out.println("  FAIL: " + what + " (no exception)");
        } catch (Exception e) {
            if (part != null && (e.getMessage() == null || !e.getMessage().contains(part))) {
                failures++;
                System.out.println("  FAIL: " + what + " (message: " + e.getMessage() + ")");
            }
        }
    }

    interface ThrowingRunnable { void run() throws Exception; }

    /** Runs a test body and exits with 0/1, printing a summary. */
    static void main(String name, ThrowingRunnable body) {
        try {
            body.run();
        } catch (Throwable e) {
            failures++;
            System.out.println("  FAIL: uncaught " + e);
            e.printStackTrace(System.out);
        }
        System.out.println("  " + name + ": " + (checks - failures) + "/" + checks + " checks passed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static String buildDir() { return System.getProperty("build.dir", "build"); }

    static Map<String, Object> golden() throws IOException {
        File f = new File(buildDir(), "golden.json");
        return Json.parseObject(new String(Files.readAllBytes(f.toPath()), "UTF-8"));
    }

    static void writeOut(String name, Object json) throws IOException {
        File dir = new File(buildDir(), "java-out");
        dir.mkdirs();
        try (FileOutputStream o = new FileOutputStream(new File(dir, name))) { o.write(Bytes.utf8(Json.stringify(json, 1))); }
    }

    static String env(String k) { return System.getenv(k); }
}
