import crypto from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/** Leidt een subsleutel af van de hoofdsleutel (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: string, len = 32): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from("eigen-cloud"), purpose, len));
}

export function parseKey(hex: string): Buffer {
  const k = Buffer.from(hex.trim(), "hex");
  if (k.length !== 32) throw new Error("Sleutel moet 32 bytes (64 hex-tekens) zijn");
  return k;
}

export function randomKeyHex() {
  return crypto.randomBytes(32).toString("hex");
}

// ───────── Kleine berichten (AES-256-GCM) ─────────
// Formaat: [0x01][nonce 12][ciphertext][tag 16]

export function seal(key: Buffer, data: Buffer | string, aad?: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(typeof data === "string" ? Buffer.from(data) : data), c.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, ct, c.getAuthTag()]);
}

export function open(key: Buffer, buf: Buffer, aad?: string): Buffer {
  if (buf.length < 29 || buf[0] !== 1) throw new Error("Ongeldig versleuteld bericht");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(13, buf.length - 16)), d.final()]);
}

export const sealJson = (key: Buffer, obj: unknown, aad?: string) => seal(key, JSON.stringify(obj), aad);
export const openJson = <T>(key: Buffer, buf: Buffer, aad?: string): T => JSON.parse(open(key, buf, aad).toString("utf8"));

// ───────── Grote bestanden (stream, in blokken) ─────────
// Formaat: "EC1\n" + basis-nonce(8) + blokken van [lengte u32 (hoogste bit = laatste blok)][ciphertext][tag 16].
// Elk blok heeft nonce = basis || teller, zodat blokken niet verwisseld, weggelaten of afgekapt kunnen worden.

const MAGIC = Buffer.from("EC1\n");
export const CHUNK = 1024 * 1024;
const FINAL = 0x80000000;

function chunkNonce(base: Buffer, i: number) {
  const n = Buffer.alloc(12);
  base.copy(n, 0);
  n.writeUInt32BE(i, 8);
  return n;
}

export function encryptedSize(plainSize: number) {
  const chunks = plainSize === 0 ? 1 : Math.ceil(plainSize / CHUNK);
  return MAGIC.length + 8 + chunks * 20 + plainSize;
}

export class EncryptStream extends Transform {
  private buf: Buffer[] = [];
  private len = 0;
  private i = 0;
  private base = crypto.randomBytes(8);
  constructor(private key: Buffer) {
    super();
    this.push(Buffer.concat([MAGIC, this.base]));
  }
  private emit1(plain: Buffer, final: boolean) {
    const c = crypto.createCipheriv("aes-256-gcm", this.key, chunkNonce(this.base, this.i++));
    c.setAAD(Buffer.from([final ? 1 : 0]));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE((plain.length | (final ? FINAL : 0)) >>> 0);
    this.push(Buffer.concat([head, ct, c.getAuthTag()]));
  }
  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.buf.push(chunk);
    this.len += chunk.length;
    // Houd altijd iets achter zodat het laatste blok als "laatste" gemarkeerd kan worden.
    while (this.len > CHUNK) {
      const all = Buffer.concat(this.buf);
      this.emit1(all.subarray(0, CHUNK), false);
      const rest = all.subarray(CHUNK);
      this.buf = [rest];
      this.len = rest.length;
    }
    cb();
  }
  _flush(cb: TransformCallback) {
    this.emit1(Buffer.concat(this.buf), true);
    cb();
  }
}

export class DecryptStream extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private base: Buffer | null = null;
  private i = 0;
  private done = false;
  constructor(private key: Buffer) {
    super();
  }
  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }
  private drain() {
    if (!this.base) {
      if (this.buf.length < 12) return;
      if (!this.buf.subarray(0, 4).equals(MAGIC)) throw new Error("Geen versleuteld Eigen Cloud-bestand");
      this.base = Buffer.from(this.buf.subarray(4, 12));
      this.buf = this.buf.subarray(12);
    }
    while (this.buf.length >= 4) {
      if (this.done) throw new Error("Extra data na laatste blok");
      const head = this.buf.readUInt32BE(0);
      const final = (head & FINAL) !== 0;
      const len = head & ~FINAL;
      if (len > CHUNK) throw new Error("Ongeldige bloklengte");
      if (this.buf.length < 4 + len + 16) return;
      const d = crypto.createDecipheriv("aes-256-gcm", this.key, chunkNonce(this.base, this.i++));
      d.setAAD(Buffer.from([final ? 1 : 0]));
      d.setAuthTag(this.buf.subarray(4 + len, 4 + len + 16));
      this.push(Buffer.concat([d.update(this.buf.subarray(4, 4 + len)), d.final()]));
      this.buf = this.buf.subarray(4 + len + 16);
      if (final) this.done = true;
    }
  }
  _flush(cb: TransformCallback) {
    if (!this.done || this.buf.length) return cb(new Error("Versleuteld bestand is afgekapt of beschadigd"));
    cb();
  }
}

export function encryptBuffer(key: Buffer, plain: Buffer): Promise<Buffer> {
  return collect(plain, new EncryptStream(key));
}
export function decryptBuffer(key: Buffer, enc: Buffer): Promise<Buffer> {
  return collect(enc, new DecryptStream(key));
}
function collect(input: Buffer, t: Transform): Promise<Buffer> {
  return new Promise((res, rej) => {
    const out: Buffer[] = [];
    t.on("data", (c: Buffer) => out.push(c));
    t.on("end", () => res(Buffer.concat(out)));
    t.on("error", rej);
    t.end(input);
  });
}
