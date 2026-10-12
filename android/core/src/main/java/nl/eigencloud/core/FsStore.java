package nl.eigencloud.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Port of FsStore (directory on a local file system). Mainly for tests and for clusters set up with a
 * local folder store; on a phone only useful when that folder is reachable.
 */
public final class FsStore implements ObjectStore {
    private final Map<String, Object> config;
    private final File dir;

    public FsStore(Map<String, Object> config) {
        this.config = config;
        this.dir = new File(Json.str(config, "dir")).getAbsoluteFile();
        dir.mkdirs();
    }

    @Override public String name() { return Json.str(config, "name"); }
    @Override public String purpose() { return Json.str(config, "purpose"); }
    @Override public Map<String, Object> config() { return config; }

    private File p(String key) throws IOException {
        File f = new File(dir, key).getCanonicalFile();
        if (!f.getPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new IOException("Ongeldige sleutel");
        return f;
    }

    @Override
    public void put(String key, byte[] body) throws IOException {
        File f = p(key);
        f.getParentFile().mkdirs();
        File tmp = new File(f.getPath() + "." + Bytes.hex(Bytes.random(4)) + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(body); }
        if (!tmp.renameTo(f)) throw new IOException("Schrijven mislukt: " + f);
    }

    @Override
    public byte[] getBuffer(String key) throws IOException {
        File f = p(key);
        if (!f.isFile()) return null;
        try (FileInputStream in = new FileInputStream(f)) { return Bytes.readAll(in); }
    }

    @Override public boolean head(String key) throws IOException { return p(key).exists(); }
    @Override public void download(String key, File dest) throws IOException { Files.copy(p(key).toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    @Override public void putFile(String key, File file) throws IOException {
        File dest = p(key); dest.getParentFile().mkdirs();
        File tmp = new File(dest.getPath() + "." + Bytes.hex(Bytes.random(4)) + ".tmp");
        try { Files.copy(file.toPath(), tmp.toPath(), StandardCopyOption.REPLACE_EXISTING); if (!tmp.renameTo(dest)) throw new IOException("Schrijven mislukt: " + dest); }
        finally { tmp.delete(); }
    }

    @Override
    public List<Entry> list(String prefix) throws IOException {
        List<Entry> out = new ArrayList<>();
        walk(dir, prefix, out);
        Collections.sort(out, (a, b) -> a.key.compareTo(b.key));
        return out;
    }

    private void walk(File d, String prefix, List<Entry> out) {
        File[] files = d.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) walk(f, prefix, out);
            else if (!f.getName().endsWith(".tmp")) {
                String key = dir.toURI().relativize(f.toURI()).getPath();
                if (key.startsWith(prefix)) out.add(new Entry(key, f.length()));
            }
        }
    }

    @Override public void delete(String key) throws IOException { p(key).delete(); }

    @Override
    public String presignGet(String key, int seconds) {
        try {
            return "file://" + p(key).getPath();
        } catch (IOException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
    }
}
