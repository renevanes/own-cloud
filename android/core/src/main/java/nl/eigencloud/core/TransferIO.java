package nl.eigencloud.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** File-based streaming keeps provider transfers bounded on phones and verifies every ciphertext. */
public final class TransferIO {
    private TransferIO() {}
    private static byte[] hash(File f) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new IOException(e); }
        try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[128 * 1024]; for (int n; (n = in.read(b)) != -1;) digest.update(b, 0, n); }
        return digest.digest();
    }
    public static boolean copyVerified(ObjectStore source, ObjectStore target, String key, long bytes, boolean maySkip) throws IOException {
        File first = Files.createTempFile("eigen-copy-", ".bin").toFile(), second = null;
        try {
            if (bytes < 0 || bytes > (first.getUsableSpace() - 64 * 1024 * 1024) / 2) throw new IOException("Niet genoeg tijdelijke ruimte om dit bestand veilig over te zetten");
            second = Files.createTempFile("eigen-check-", ".bin").toFile();
            source.download(key, first);
            if (first.length() != bytes) throw new IOException("Bronbestand is gewijzigd: " + key);
            byte[] expected = hash(first);
            if (maySkip && target.head(key)) {
                target.download(key, second);
                if (second.length() == bytes && MessageDigest.isEqual(expected, hash(second))) return true;
            }
            target.putFile(key, first);
            if (!target.head(key)) throw new IOException("1 bestand ontbreekt in " + target.name() + " na het kopiëren (bijv. " + key + ")");
            target.download(key, second);
            if (second.length() != bytes || !MessageDigest.isEqual(expected, hash(second))) throw new IOException("Bestand beschadigd in " + target.name() + " na het kopiëren: " + key);
            return false;
        } finally { first.delete(); if (second != null) second.delete(); }
    }
}
