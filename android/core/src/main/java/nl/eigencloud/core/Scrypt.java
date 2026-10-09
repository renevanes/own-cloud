package nl.eigencloud.core;

/**
 * scrypt (RFC 7914) and the password hash of src/auth.ts ({@code scrypt$<salt hex>$<hash hex>}, N=16384,
 * r=8, p=1, 64 bytes), so the phone can set the app's login password during setup.
 */
public final class Scrypt {
    private Scrypt() {}

    /** hashPassword() from src/auth.ts. */
    public static String hashPassword(String password) { return hashPassword(password, Bytes.random(16)); }

    /** hashPassword() with a given salt (tests). */
    public static String hashPassword(String password, byte[] salt) {
        byte[] hash = scrypt(Bytes.utf8(password), salt, 16384, 8, 1, 64);
        return "scrypt$" + Bytes.hex(salt) + "$" + Bytes.hex(hash);
    }

    /** verifyPassword() from src/auth.ts. */
    public static boolean verifyPassword(String password, String stored) {
        String[] p = stored.split("\\$");
        if (p.length != 3 || !"scrypt".equals(p[0])) return false;
        byte[] want = Bytes.fromHex(p[2]);
        byte[] got = scrypt(Bytes.utf8(password), Bytes.fromHex(p[1]), 16384, 8, 1, want.length);
        return Bytes.equal(want, got);
    }

    /** scrypt key derivation. */
    public static byte[] scrypt(byte[] passwd, byte[] salt, int n, int r, int p, int dkLen) {
        if (n < 2 || (n & (n - 1)) != 0) throw new IllegalArgumentException("N moet een macht van 2 zijn");
        byte[] b = pbkdf2(passwd, salt, 1, p * 128 * r);
        int[] xy = new int[64 * r];
        int[] v = new int[32 * r * n];
        for (int i = 0; i < p; i++) romix(b, i * 128 * r, r, n, v, xy);
        return pbkdf2(passwd, b, 1, dkLen);
    }

    /** PBKDF2-HMAC-SHA256 on raw bytes. */
    static byte[] pbkdf2(byte[] pw, byte[] salt, int iterations, int len) {
        byte[] out = new byte[len];
        int blocks = (len + 31) / 32;
        for (int i = 1; i <= blocks; i++) {
            byte[] u = Bytes.hmacSha256(pw, Bytes.concat(salt, new byte[] {(byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i}));
            byte[] t = u.clone();
            for (int k = 1; k < iterations; k++) {
                u = Bytes.hmacSha256(pw, u);
                for (int j = 0; j < t.length; j++) t[j] ^= u[j];
            }
            int off = (i - 1) * 32;
            System.arraycopy(t, 0, out, off, Math.min(32, len - off));
        }
        return out;
    }

    private static void romix(byte[] b, int off, int r, int n, int[] v, int[] xy) {
        int words = 32 * r;
        int[] x = new int[words];
        for (int i = 0; i < words; i++) {
            int j = off + i * 4;
            x[i] = (b[j] & 0xff) | (b[j + 1] & 0xff) << 8 | (b[j + 2] & 0xff) << 16 | (b[j + 3] & 0xff) << 24;
        }
        for (int i = 0; i < n; i++) {
            System.arraycopy(x, 0, v, i * words, words);
            blockMix(x, r, xy);
        }
        for (int i = 0; i < n; i++) {
            int j = x[(2 * r - 1) * 16] & (n - 1);
            for (int k = 0; k < words; k++) x[k] ^= v[j * words + k];
            blockMix(x, r, xy);
        }
        for (int i = 0; i < words; i++) {
            int j = off + i * 4;
            b[j] = (byte) x[i];
            b[j + 1] = (byte) (x[i] >>> 8);
            b[j + 2] = (byte) (x[i] >>> 16);
            b[j + 3] = (byte) (x[i] >>> 24);
        }
    }

    private static void blockMix(int[] b, int r, int[] y) {
        int[] x = new int[16];
        System.arraycopy(b, (2 * r - 1) * 16, x, 0, 16);
        for (int i = 0; i < 2 * r; i++) {
            for (int k = 0; k < 16; k++) x[k] ^= b[i * 16 + k];
            salsa8(x);
            System.arraycopy(x, 0, y, i * 16, 16);
        }
        for (int i = 0; i < r; i++) System.arraycopy(y, (2 * i) * 16, b, i * 16, 16);
        for (int i = 0; i < r; i++) System.arraycopy(y, (2 * i + 1) * 16, b, (r + i) * 16, 16);
    }

    private static int rotl(int a, int s) { return (a << s) | (a >>> (32 - s)); }

    private static void salsa8(int[] b) {
        int[] x = b.clone();
        for (int i = 0; i < 8; i += 2) {
            x[4] ^= rotl(x[0] + x[12], 7); x[8] ^= rotl(x[4] + x[0], 9);
            x[12] ^= rotl(x[8] + x[4], 13); x[0] ^= rotl(x[12] + x[8], 18);
            x[9] ^= rotl(x[5] + x[1], 7); x[13] ^= rotl(x[9] + x[5], 9);
            x[1] ^= rotl(x[13] + x[9], 13); x[5] ^= rotl(x[1] + x[13], 18);
            x[14] ^= rotl(x[10] + x[6], 7); x[2] ^= rotl(x[14] + x[10], 9);
            x[6] ^= rotl(x[2] + x[14], 13); x[10] ^= rotl(x[6] + x[2], 18);
            x[3] ^= rotl(x[15] + x[11], 7); x[7] ^= rotl(x[3] + x[15], 9);
            x[11] ^= rotl(x[7] + x[3], 13); x[15] ^= rotl(x[11] + x[7], 18);
            x[1] ^= rotl(x[0] + x[3], 7); x[2] ^= rotl(x[1] + x[0], 9);
            x[3] ^= rotl(x[2] + x[1], 13); x[0] ^= rotl(x[3] + x[2], 18);
            x[6] ^= rotl(x[5] + x[4], 7); x[7] ^= rotl(x[6] + x[5], 9);
            x[4] ^= rotl(x[7] + x[6], 13); x[5] ^= rotl(x[4] + x[7], 18);
            x[11] ^= rotl(x[10] + x[9], 7); x[8] ^= rotl(x[11] + x[10], 9);
            x[9] ^= rotl(x[8] + x[11], 13); x[10] ^= rotl(x[9] + x[8], 18);
            x[12] ^= rotl(x[15] + x[14], 7); x[13] ^= rotl(x[12] + x[15], 9);
            x[14] ^= rotl(x[13] + x[12], 13); x[15] ^= rotl(x[14] + x[13], 18);
        }
        for (int i = 0; i < 16; i++) b[i] += x[i];
    }
}
