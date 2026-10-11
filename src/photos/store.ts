import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import exifr from "exifr";
import { db } from "../db.js";
import { paths } from "../config.js";
import { blobWritten, relData } from "../blobs.js";

const run = promisify(execFile);

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".avif", ".dng", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".mts"]);
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff", ".avif": "image/avif",
  ".dng": "image/x-adobe-dng", ".bmp": "image/bmp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
  ".3gp": "video/3gpp", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mts": "video/mp2t",
};

export function isMediaFile(name: string) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

let ffmpegAvailable: boolean | undefined;
async function hasFfmpeg() {
  if (ffmpegAvailable === undefined) ffmpegAvailable = await run("ffmpeg", ["-version"]).then(() => true, () => false);
  return ffmpegAvailable;
}

async function makeThumb(src: string, dest: string, isVideo: boolean): Promise<{ ok: boolean; width?: number; height?: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    let input = src;
    let tmp: string | undefined;
    if (isVideo || [".heic", ".heif", ".dng"].includes(path.extname(src).toLowerCase())) {
      // Video's (en HEIC/DNG die sharp vaak niet kan lezen) via ffmpeg naar een tijdelijk frame.
      if (!(await hasFfmpeg())) {
        if (isVideo) return { ok: false };
      } else {
        tmp = dest + ".frame.jpg";
        await run("ffmpeg", ["-y", "-loglevel", "error", ...(isVideo ? ["-ss", "1"] : []), "-i", src, "-frames:v", "1", tmp]).catch(() =>
          run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-frames:v", "1", tmp!]));
        input = tmp;
      }
    }
    const img = sharp(input, { failOn: "none" }).rotate();
    const meta = await sharp(input, { failOn: "none" }).metadata();
    await img.resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(dest);
    if (tmp) fs.rmSync(tmp, { force: true });
    const swap = (meta.orientation ?? 1) >= 5;
    return { ok: true, width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
  } catch {
    return { ok: false };
  }
}

export interface PhotoMeta {
  filename?: string;
  takenAt?: number;      // overschrijft EXIF (bijv. uit Google Takeout-JSON)
  lat?: number; lon?: number;
  description?: string;
  favorite?: boolean;
  albums?: string[];
}

/** Voegt een foto/video toe vanaf een bestand. Geeft {id, duplicate} terug. */
export async function addPhotoFromFile(src: string, meta: PhotoMeta = {}, opts: { move?: boolean; userId?: number } = {}) {
  const userId = opts.userId ?? 1;
  const filename = meta.filename ?? path.basename(src);
  const ext = path.extname(filename).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  const sha = await sha256File(src);

  const existing = db.prepare("SELECT id FROM photos WHERE sha256 = ? AND user_id = ?").get(sha, userId) as { id: number } | undefined;
  if (existing) {
    addToAlbums(existing.id, meta.albums, userId);
    if (opts.move) fs.rmSync(src, { force: true });
    return { id: existing.id, duplicate: true };
  }

  let exif: Record<string, unknown> | undefined;
  if (!isVideo) exif = await exifr.parse(src, { gps: true, pick: ["DateTimeOriginal", "CreateDate", "Make", "Model", "latitude", "longitude", "OffsetTimeOriginal"] }).catch(() => undefined);

  const exifDate = (exif?.DateTimeOriginal ?? exif?.CreateDate) as Date | undefined;
  const takenAt = meta.takenAt ?? (exifDate instanceof Date && !isNaN(exifDate.getTime()) ? exifDate.getTime() : fs.statSync(src).mtimeMs);
  const d = new Date(takenAt);
  const rel = path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), sha + ext);
  const dest = path.join(paths.photoOriginals, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Zelfde inhoud bij een andere gebruiker: het bestand (op inhoud geadresseerd) is er al, alleen de gegevens zijn per gebruiker.
  const other = fs.existsSync(dest)
    ? (db.prepare("SELECT thumb_path, width, height FROM photos WHERE path = ? LIMIT 1").get(relData(dest)) as { thumb_path: string | null; width: number | null; height: number | null } | undefined)
    : undefined;
  if (other) { if (opts.move) fs.rmSync(src, { force: true }); }
  else if (opts.move) {
    try { fs.renameSync(src, dest); } catch { fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
  } else fs.copyFileSync(src, dest);

  const thumbPath = path.join(paths.photoThumbs, sha.slice(0, 2), sha + ".webp");
  const thumb = other?.thumb_path && fs.existsSync(thumbPath)
    ? { ok: true, width: other.width ?? undefined, height: other.height ?? undefined }
    : await makeThumb(dest, thumbPath, isVideo);

  const camera = [exif?.Make, exif?.Model].filter(Boolean).join(" ") || null;
  const destRel = relData(dest);
  const thumbRel = thumb.ok ? relData(thumbPath) : null;
  const id = db.transaction(() => {
    const r = db.prepare(`INSERT INTO photos (sha256, filename, mime, size, width, height, taken_at, lat, lon, camera, description, is_video, is_favorite, path, thumb_path, added, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sha, filename, MIME[ext] ?? "application/octet-stream", fs.statSync(dest).size, thumb.width ?? null, thumb.height ?? null, Math.round(takenAt),
      meta.lat ?? (exif?.latitude as number | undefined) ?? null, meta.lon ?? (exif?.longitude as number | undefined) ?? null,
      camera, meta.description ?? null, isVideo ? 1 : 0, meta.favorite ? 1 : 0, destRel, thumbRel, Date.now(), userId);
    blobWritten(destRel);
    if (thumbRel) blobWritten(thumbRel);
    return Number(r.lastInsertRowid);
  })();
  addToAlbums(id, meta.albums, userId);
  return { id, duplicate: false };
}

function addToAlbums(photoId: number, albums: string[] | undefined, userId: number) {
  for (const name of albums ?? []) {
    db.prepare("INSERT OR IGNORE INTO albums (name, user_id) VALUES (?, ?)").run(name, userId);
    const a = db.prepare("SELECT id FROM albums WHERE name = ? AND user_id = ?").get(name, userId) as { id: number };
    db.prepare("INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)").run(a.id, photoId);
  }
}
