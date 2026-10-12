package nl.eigencloud.core;

import java.io.IOException;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

/** Port of the ObjectStore interface from src/cluster/stores.ts (whole-buffer variant). */
public interface ObjectStore {
    /** A listed object. */
    final class Entry {
        public final String key;
        public final long size;

        public Entry(String key, long size) {
            this.key = key;
            this.size = size;
        }

        @Override public String toString() { return key + " (" + size + ")"; }
    }

    String name();

    /** "replica" or "backup". */
    String purpose();

    /** The StoreConfig JSON object this store was made from. */
    Map<String, Object> config();

    void put(String key, byte[] body) throws IOException;

    /** Object contents, or null when it does not exist. */
    byte[] getBuffer(String key) throws IOException;

    /** Streaming variants are implemented by both production stores. Defaults support small test adapters. */
    default void download(String key, File dest) throws IOException {
        byte[] body = getBuffer(key);
        if (body == null) throw new IOException("Bronbestand ontbreekt: " + key);
        Files.write(dest.toPath(), body);
    }
    default void putFile(String key, File file) throws IOException { put(key, Files.readAllBytes(file.toPath())); }

    boolean head(String key) throws IOException;

    List<Entry> list(String prefix) throws IOException;

    void delete(String key) throws IOException;

    /** Temporary download URL without credentials. */
    String presignGet(String key, int seconds);
}
