import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request } from "undici";

export interface StoreConfig {
  name: string;
  type: "s3" | "fs";
  /** replica = werkopslag (mag opruimen), backup = alleen toevoegen, nooit verwijderen (zet versiebeheer/object-lock aan bij de aanbieder). */
  purpose: "replica" | "backup";
  country?: string;
  // s3
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  pathStyle?: boolean;
  prefix?: string;
  // fs (NAS, USB-schijf, tests)
  dir?: string;
}

export interface ObjectStore {
  readonly name: string;
  readonly purpose: "replica" | "backup";
  readonly config: StoreConfig;
  put(key: string, body: Buffer | Readable, size?: number): Promise<void>;
  get(key: string): Promise<Readable | null>;
  getBuffer(key: string): Promise<Buffer | null>;
  head(key: string): Promise<boolean>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  delete(key: string): Promise<void>;
  /** Tijdelijke download-URL zonder inloggegevens (voor het opstarten van nieuwe nodes). */
  presignGet(key: string, seconds: number): string;
}

async function toBuffer(r: Readable): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of r) out.push(c as Buffer);
  return Buffer.concat(out);
}

// ───────── Bestandssysteem ─────────

export class FsStore implements ObjectStore {
  readonly name: string;
  readonly purpose: "replica" | "backup";
  private dir: string;
  constructor(readonly config: StoreConfig) {
    this.name = config.name;
    this.purpose = config.purpose;
    this.dir = path.resolve(config.dir!);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private p(key: string) {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(this.dir + path.sep)) throw new Error("Ongeldige sleutel");
    return full;
  }
  async put(key: string, body: Buffer | Readable) {
    const f = this.p(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    if (Buffer.isBuffer(body)) fs.writeFileSync(tmp, body);
    else await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, f);
  }
  async get(key: string) {
    const f = this.p(key);
    return fs.existsSync(f) ? fs.createReadStream(f) : null;
  }
  async getBuffer(key: string) {
    const f = this.p(key);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }
  async head(key: string) {
    return fs.existsSync(this.p(key));
  }
  async list(prefix: string) {
    const base = path.join(this.dir, prefix);
    const start = fs.existsSync(base) && fs.statSync(base).isDirectory() ? base : path.dirname(base);
    const out: { key: string; size: number }[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (!e.name.endsWith(".tmp")) {
          const key = path.relative(this.dir, full).split(path.sep).join("/");
          if (key.startsWith(prefix)) out.push({ key, size: fs.statSync(full).size });
        }
      }
    };
    walk(start);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async delete(key: string) {
    fs.rmSync(this.p(key), { force: true });
  }
  presignGet(key: string) {
    return "file://" + this.p(key);
  }
}

// ───────── S3-compatibel (Hetzner, Scaleway, UpCloud, OVH, Exoscale, MinIO …) ─────────

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encKey = (k: string) => k.split("/").map(enc).join("/");
const sha256hex = (d: string | Buffer) => crypto.createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => crypto.createHmac("sha256", k).update(d).digest();

export class S3Store implements ObjectStore {
  readonly name: string;
  readonly purpose: "replica" | "backup";
  private endpoint: URL;
  constructor(readonly config: StoreConfig) {
    this.name = config.name;
    this.purpose = config.purpose;
    this.endpoint = new URL(config.endpoint!);
  }

  private url(key: string, query: Record<string, string> = {}) {
    const k = (this.config.prefix ? this.config.prefix.replace(/\/$/, "") + "/" : "") + key;
    const pathStyle = this.config.pathStyle !== false;
    const host = pathStyle ? this.endpoint.host : `${this.config.bucket}.${this.endpoint.host}`;
    const p = (pathStyle ? `/${this.config.bucket}` : "") + (k ? "/" + encKey(k) : pathStyle ? "" : "/");
    const qs = Object.keys(query).sort().map((q) => `${enc(q)}=${enc(query[q])}`).join("&");
    return { host, path: p || "/", qs, href: `${this.endpoint.protocol}//${host}${p || "/"}${qs ? "?" + qs : ""}` };
  }

  private signingKey(date: string) {
    const region = this.config.region ?? "us-east-1";
    const k = hmac(hmac(hmac(hmac("AWS4" + this.config.secretKey, date), region), "s3"), "aws4_request");
    return { k, scope: `${date}/${region}/s3/aws4_request` };
  }

  /** AWS Signature V4 (header-variant) met UNSIGNED-PAYLOAD. */
  private sign(method: string, key: string, query: Record<string, string>, extra: Record<string, string> = {}) {
    const u = this.url(key, query);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { host: u.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": amzDate, ...extra };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canon = [method, u.path, u.qs, names.map((h) => `${h}:${String(headers[h]).trim()}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
    const { k, scope } = this.signingKey(amzDate.slice(0, 8));
    const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canon)].join("\n");
    const sig = crypto.createHmac("sha256", k).update(sts).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    return { url: u.href, headers };
  }

  private async req(method: "GET" | "PUT" | "HEAD" | "DELETE", key: string, query: Record<string, string> = {}, body?: Buffer | Readable, size?: number) {
    const extra: Record<string, string> = {};
    if (method === "PUT") extra["content-length"] = String(Buffer.isBuffer(body) ? body.length : size);
    const { url, headers } = this.sign(method, key, query, extra);
    return request(url, { method, headers, body, headersTimeout: 60_000, bodyTimeout: 300_000 });
  }

  async put(key: string, body: Buffer | Readable, size?: number) {
    if (!Buffer.isBuffer(body) && size === undefined) body = await toBuffer(body);
    const r = await this.req("PUT", key, {}, body, size);
    const text = await r.body.text();
    if (r.statusCode >= 300) throw new Error(`${this.name}: PUT ${key} → ${r.statusCode} ${text.slice(0, 200)}`);
  }
  async get(key: string) {
    const r = await this.req("GET", key);
    if (r.statusCode === 404) { await r.body.dump(); return null; }
    if (r.statusCode >= 300) throw new Error(`${this.name}: GET ${key} → ${r.statusCode} ${(await r.body.text()).slice(0, 200)}`);
    return Readable.from(r.body);
  }
  async getBuffer(key: string) {
    const s = await this.get(key);
    return s ? toBuffer(s) : null;
  }
  async head(key: string) {
    const r = await this.req("HEAD", key);
    await r.body.dump();
    if (r.statusCode === 404) return false;
    if (r.statusCode >= 300) throw new Error(`${this.name}: HEAD ${key} → ${r.statusCode}`);
    return true;
  }
  async list(prefix: string) {
    const out: { key: string; size: number }[] = [];
    const pfx = (this.config.prefix ? this.config.prefix.replace(/\/$/, "") + "/" : "") + prefix;
    let token: string | undefined;
    do {
      const q: Record<string, string> = { "list-type": "2", prefix: pfx };
      if (token) q["continuation-token"] = token;
      const r = await this.req("GET", "", q);
      const xml = await r.body.text();
      if (r.statusCode >= 300) throw new Error(`${this.name}: LIST → ${r.statusCode} ${xml.slice(0, 200)}`);
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? "";
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
        const key = k.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        out.push({ key: this.config.prefix ? key.slice(this.config.prefix.replace(/\/$/, "").length + 1) : key, size });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    } while (token);
    return out;
  }
  async delete(key: string) {
    const r = await this.req("DELETE", key);
    await r.body.dump();
    if (r.statusCode >= 300 && r.statusCode !== 404) throw new Error(`${this.name}: DELETE ${key} → ${r.statusCode}`);
  }

  /** Presigned GET (query-variant van SigV4). */
  presignGet(key: string, seconds: number, now = new Date()) {
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const { k, scope } = this.signingKey(amzDate.slice(0, 8));
    const q = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(seconds),
      "X-Amz-SignedHeaders": "host",
    };
    const u = this.url(key, q);
    const canon = ["GET", u.path, u.qs, `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canon)].join("\n");
    return `${u.href}&X-Amz-Signature=${crypto.createHmac("sha256", k).update(sts).digest("hex")}`;
  }
}

export function makeStore(c: StoreConfig): ObjectStore {
  return c.type === "fs" ? new FsStore(c) : new S3Store(c);
}

/** Download via (presigned) URL of file://-pad. */
export async function fetchUrl(url: string): Promise<Buffer | null> {
  if (url.startsWith("file://")) {
    const f = url.slice(7);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }
  const r = await request(url);
  if (r.statusCode === 404 || r.statusCode === 403) { await r.body.dump(); return null; }
  if (r.statusCode >= 300) throw new Error(`Download mislukt: ${r.statusCode}`);
  return Buffer.from(await r.body.arrayBuffer());
}
