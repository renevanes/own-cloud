package nl.eigencloud.core.fotos;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;
import java.util.zip.ZipException;

/**
 * Leest een zip via de centrale inhoudsopgave, met willekeurige toegang (een bestand dat via het systeem-kiesvenster
 * is gekozen, als FileChannel). Werkt met ZIP64 (Takeout-bestanden van 4 GB en groter, meer dan 65535 bestanden),
 * opgeslagen en ingepakte (deflate) bestanden, ook als de groottes pas ná de gegevens staan. Elk bestand wordt
 * gecontroleerd op grootte en CRC.
 */
public final class ZipReader implements Closeable {
    public static final class Entry {
        public final String name;
        public final long size;
        final long csize;
        final int method;
        final int flags;
        final long crc;
        final long localOffset;
        public final int index;
        /** Tijd uit de zip (DOS-tijd, gelezen als UTC), of 0. */
        public final long time;

        Entry(String name, long size, long csize, int method, int flags, long crc, long localOffset, int index, long time) {
            this.name = name; this.size = size; this.csize = csize; this.method = method; this.flags = flags; this.crc = crc; this.localOffset = localOffset; this.index = index;
            this.time = time;
        }

        public boolean directory() { return name.endsWith("/"); }
    }

    private final SeekableByteChannel ch;
    private final List<Entry> entries;

    public ZipReader(SeekableByteChannel ch) throws IOException {
        this.ch = ch;
        this.entries = Collections.unmodifiableList(readDirectory());
    }

    public List<Entry> entries() { return entries; }

    @Override
    public void close() throws IOException { ch.close(); }

    private ByteBuffer read(long pos, int len) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(len).order(ByteOrder.LITTLE_ENDIAN);
        while (b.hasRemaining()) {
            ch.position(pos + b.position());
            if (ch.read(b) < 0) throw new ZipException("Zip is korter dan verwacht");
        }
        ((Buffer) b).flip(); // via Buffer: ByteBuffer.flip() bestaat pas vanaf Android 11
        return b;
    }

    private List<Entry> readDirectory() throws IOException {
        long size = ch.size();
        if (size < 22) throw new ZipException("Dit is geen zip-bestand");
        int tail = (int) Math.min(size, 65_557);
        ByteBuffer end = read(size - tail, tail);
        int eocd = -1;
        for (int i = tail - 22; i >= 0; i--) {
            if (end.getInt(i) == 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new ZipException("Dit is geen (volledig) zip-bestand. Is het downloaden klaar?");
        long count = end.getShort(eocd + 10) & 0xffff;
        long cdSize = end.getInt(eocd + 12) & 0xffffffffL;
        long cdOffset = end.getInt(eocd + 16) & 0xffffffffL;
        // ZIP64: zoeker 20 bytes vóór het einde-record
        if (eocd >= 20 && end.getInt(eocd - 20) == 0x07064b50) {
            long z64 = end.getLong(eocd - 20 + 8);
            ByteBuffer r = read(z64, 56);
            if (r.getInt(0) != 0x06064b50) throw new ZipException("ZIP64-gegevens kloppen niet");
            count = r.getLong(32);
            cdSize = r.getLong(40);
            cdOffset = r.getLong(48);
        }
        if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > size || count < 0 || count > 10_000_000) throw new ZipException("Inhoudsopgave van de zip klopt niet");
        if (cdSize > Integer.MAX_VALUE - 16) throw new ZipException("Inhoudsopgave van de zip is te groot");
        ByteBuffer cd = read(cdOffset, (int) cdSize);
        List<Entry> out = new ArrayList<>((int) Math.min(count, 200_000));
        int p = 0;
        for (long i = 0; i < count; i++) {
            if (p + 46 > cd.limit() || cd.getInt(p) != 0x02014b50) throw new ZipException("Inhoudsopgave van de zip is beschadigd");
            int flags = cd.getShort(p + 8) & 0xffff;
            int method = cd.getShort(p + 10) & 0xffff;
            long time = dosTime(cd.getShort(p + 12) & 0xffff, cd.getShort(p + 14) & 0xffff);
            long crc = cd.getInt(p + 16) & 0xffffffffL;
            long csize = cd.getInt(p + 20) & 0xffffffffL;
            long usize = cd.getInt(p + 24) & 0xffffffffL;
            int nameLen = cd.getShort(p + 28) & 0xffff, extraLen = cd.getShort(p + 30) & 0xffff, commentLen = cd.getShort(p + 32) & 0xffff;
            long offset = cd.getInt(p + 42) & 0xffffffffL;
            if (p + 46 + nameLen + extraLen + commentLen > cd.limit()) throw new ZipException("Inhoudsopgave van de zip is beschadigd");
            byte[] nameBytes = new byte[nameLen];
            ((Buffer) cd).position(p + 46);
            cd.get(nameBytes);
            String name = new String(nameBytes, StandardCharsets.UTF_8);
            // ZIP64-extra: de echte waarden staan hier als het veld 0xFFFFFFFF is (in deze volgorde).
            int x = p + 46 + nameLen, xEnd = x + extraLen;
            while (x + 4 <= xEnd) {
                int id = cd.getShort(x) & 0xffff, len = cd.getShort(x + 2) & 0xffff;
                if (id == 0x0001) {
                    int q = x + 4;
                    if (usize == 0xffffffffL && q + 8 <= x + 4 + len) { usize = cd.getLong(q); q += 8; }
                    if (csize == 0xffffffffL && q + 8 <= x + 4 + len) { csize = cd.getLong(q); q += 8; }
                    if (offset == 0xffffffffL && q + 8 <= x + 4 + len) { offset = cd.getLong(q); }
                }
                x += 4 + len;
            }
            if (usize < 0 || csize < 0 || offset < 0 || offset >= size) throw new ZipException("Inhoudsopgave van de zip is beschadigd");
            out.add(new Entry(name, usize, csize, method, flags, crc, offset, (int) i, time));
            p += 46 + nameLen + extraLen + commentLen;
        }
        return out;
    }

    static long dosTime(int time, int date) {
        if (date == 0) return 0;
        try {
            return java.time.LocalDateTime.of(1980 + (date >> 9), (date >> 5) & 0xf, date & 0x1f, time >> 11, (time >> 5) & 0x3f, Math.min(59, (time & 0x1f) * 2))
                    .toInstant(java.time.ZoneOffset.UTC).toEpochMilli();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    /** De inhoud van een bestand in de zip (uitgepakt en gecontroleerd). Sluit de stream na gebruik. */
    public InputStream open(Entry e) throws IOException {
        if ((e.flags & 1) != 0) throw new ZipException(e.name + " is versleuteld");
        ByteBuffer h = read(e.localOffset, 30);
        if (h.getInt(0) != 0x04034b50) throw new ZipException("Bestand in de zip is beschadigd: " + e.name);
        long data = e.localOffset + 30 + (h.getShort(26) & 0xffff) + (h.getShort(28) & 0xffff);
        if (data + e.csize > ch.size()) throw new ZipException("Zip is korter dan verwacht (" + e.name + ")");
        InputStream raw = new Range(data, e.csize);
        InputStream content;
        if (e.method == 0) {
            if (e.csize != e.size) throw new ZipException("Bestand in de zip is beschadigd: " + e.name);
            content = raw;
        } else if (e.method == 8) {
            content = new Inflate(raw);
        } else {
            throw new ZipException(e.name + ": inpakmethode " + e.method + " wordt niet ondersteund");
        }
        return new Checked(content, e);
    }

    /** Leest [start, start+len) uit het kanaal, onafhankelijk van andere lezers. */
    private final class Range extends InputStream {
        private long pos;
        private final long end;

        Range(long start, long len) { this.pos = start; this.end = start + len; }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (pos >= end) return -1;
            int n = (int) Math.min(len, end - pos);
            ByteBuffer buf = ByteBuffer.wrap(b, off, n);
            ch.position(pos);
            int r = ch.read(buf);
            if (r < 0) throw new ZipException("Zip is korter dan verwacht");
            pos += r;
            return r;
        }
    }

    /** Raw deflate (zonder zlib-kop), met het extra lege byte dat Inflater soms nodig heeft. */
    private static final class Inflate extends InputStream {
        private final InputStream in;
        private final Inflater inf = new Inflater(true);
        private final byte[] buf = new byte[64 * 1024];
        private boolean dummy;

        Inflate(InputStream in) { this.in = in; }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n;
            while ((n = read(one, 0, 1)) == 0) { /* opnieuw */ }
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            try {
                while (true) {
                    int n = inf.inflate(b, off, len);
                    if (n > 0) return n;
                    if (inf.finished()) return -1;
                    if (inf.needsDictionary()) throw new ZipException("Ongeldige ingepakte gegevens");
                    if (inf.needsInput()) {
                        int r = in.read(buf, 0, buf.length);
                        if (r < 0) {
                            if (dummy) throw new ZipException("Ingepakte gegevens houden te vroeg op");
                            dummy = true;
                            buf[0] = 0;
                            inf.setInput(buf, 0, 1);
                        } else inf.setInput(buf, 0, r);
                    }
                }
            } catch (DataFormatException e) {
                throw new ZipException("Ongeldige ingepakte gegevens: " + e.getMessage());
            }
        }

        @Override
        public void close() throws IOException {
            inf.end();
            in.close();
        }
    }

    /** Telt bytes en CRC; geeft een fout bij te veel/te weinig bytes of een verkeerde CRC. */
    private static final class Checked extends InputStream {
        private final InputStream in;
        private final Entry e;
        private final CRC32 crc = new CRC32();
        private long count;
        private boolean verified;

        Checked(InputStream in, Entry e) { this.in = in; this.e = e; }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n;
            while ((n = read(one, 0, 1)) == 0) { /* opnieuw */ }
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = in.read(b, off, len);
            if (n < 0) {
                if (!verified) {
                    verified = true;
                    if (count != e.size) throw new ZipException(e.name + ": grootte klopt niet");
                    if (crc.getValue() != e.crc) throw new ZipException(e.name + " is beschadigd (CRC)");
                }
                return -1;
            }
            count += n;
            if (count > e.size) throw new ZipException(e.name + " is groter dan de zip zegt");
            crc.update(b, off, n);
            return n;
        }

        @Override
        public void close() throws IOException { in.close(); }
    }
}
