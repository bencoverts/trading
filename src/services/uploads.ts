import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg';

export interface DetectedImage {
  kind: ImageKind;
  mime: string;
  extension: string;
}

/**
 * File type detection from magic bytes (never from the extension or the
 * client-provided mime type).
 */
export function detectImage(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { kind: 'png', mime: 'image/png', extension: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'jpeg', mime: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'webp', mime: 'image/webp', extension: 'webp' };
  }
  const head = buffer
    .toString('utf8', 0, Math.min(buffer.length, 512))
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!DOCTYPE svg')) {
    return { kind: 'svg', mime: 'image/svg+xml', extension: 'svg' };
  }
  return null;
}

/**
 * Minimal SVG sanitiser: drops scripts, event handlers, external references and
 * javascript: URLs. Anything else that looks dangerous rejects the upload.
 */
export function sanitizeSvg(source: string): string {
  // eslint-disable-next-line no-control-regex
  let svg = source.replace(/\u0000/g, '').slice(0, 512 * 1024);
  svg = svg.replace(/<\?xml[\s\S]*?\?>/gi, '');
  svg = svg.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '');
  svg = svg.replace(/<(iframe|object|embed|foreignObject|use|image|animate|set|handler)[\s\S]*?<\/\1>/gi, '');
  svg = svg.replace(/<(iframe|object|embed|foreignObject|script|use|image|animate|set|handler)\b[^>]*\/?>/gi, '');
  svg = svg.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  svg = svg.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  svg = svg.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  svg = svg.replace(/(href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, '');
  svg = svg.replace(/@import[^;]*;/gi, '');
  if (/<script/i.test(svg) || /javascript:/i.test(svg) || /<foreignObject/i.test(svg)) {
    throw new AppError('UPLOAD_INVALID', 422, 'SVG mengandung konten yang tidak diizinkan');
  }
  if (!/<svg[\s>]/i.test(svg)) throw new AppError('UPLOAD_INVALID', 422, 'File SVG tidak valid');
  return svg.trim();
}

export interface StoredUpload {
  /** path relative to the uploads root, stored in the database */
  relativePath: string;
  url: string;
  bytes: number;
  kind: ImageKind;
}

/**
 * Stores validated images outside the source tree under `uploads/<folder>/`.
 * File names are random; the extension comes from the detected type only.
 */
export class UploadService {
  constructor(
    private readonly rootDir: string,
    private readonly maxBytes: number,
    private readonly logger: Logger,
  ) {
    mkdirSync(rootDir, { recursive: true });
  }

  get root(): string {
    return this.rootDir;
  }

  store(buffer: Buffer, opts: { folder: string; maxBytes?: number }): StoredUpload {
    const max = opts.maxBytes ?? this.maxBytes;
    if (!buffer?.length) throw new AppError('UPLOAD_INVALID', 422, 'File kosong');
    if (buffer.length > max) {
      throw new AppError('PAYLOAD_TOO_LARGE', 413, `Ukuran file maksimal ${Math.round(max / 1024)} KB`);
    }
    const detected = detectImage(buffer);
    if (!detected) {
      throw new AppError('UPLOAD_INVALID', 422, 'Format file harus PNG, JPG, WEBP, atau SVG');
    }
    const folder = opts.folder.replace(/[^a-z0-9_-]/gi, '');
    const dir = path.join(this.rootDir, folder);
    mkdirSync(dir, { recursive: true });
    const filename = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.${detected.extension}`;
    const absolute = path.join(dir, filename);
    const payload = detected.kind === 'svg' ? Buffer.from(sanitizeSvg(buffer.toString('utf8')), 'utf8') : buffer;
    writeFileSync(absolute, payload, { mode: 0o644 });
    const relativePath = `${folder}/${filename}`;
    this.logger.info({ file: relativePath, bytes: payload.length, kind: detected.kind }, 'upload disimpan');
    return { relativePath, url: `/uploads/${relativePath}`, bytes: payload.length, kind: detected.kind };
  }

  remove(relativePath: string | null | undefined): void {
    if (!relativePath) return;
    const absolute = path.join(this.rootDir, relativePath);
    if (!absolute.startsWith(this.rootDir) || !existsSync(absolute)) return;
    try {
      unlinkSync(absolute);
    } catch (err) {
      this.logger.warn({ err, relativePath }, 'gagal menghapus upload');
    }
  }
}
