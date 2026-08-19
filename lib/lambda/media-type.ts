/**
 * Content-Type resolution for processed bundle files.
 *
 * Two layers, in order:
 *
 *  1. `contentTypeFor(path)` — by extension. Covers everything a normal
 *     html/js/css/assets bundle contains.
 *  2. `sniffContentType(data)` — magic bytes, consulted only when the extension
 *     lookup falls through to `application/octet-stream`. Real exports carry
 *     extension-less files (a Design Composer export ships a `.thumbnail` that
 *     is really a WebP), and serving those as octet-stream makes the browser
 *     download them instead of rendering them.
 *
 * `contentTypeForEntry(path, data)` is the combined entry point the processor
 * uses. Split into its own module so both the handler and the gallery builder
 * can use it without a circular import.
 */

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
  // Unbuilt sources. Deliberately text/plain and NOT text/javascript: they ship
  // alongside design-system bundles as reference material and must never be
  // executable if something manages to <script src> them.
  jsx: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
};

export const OCTET_STREAM = 'application/octet-stream';

/** Content-Type for a path, by extension; octet-stream when unknown. */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? OCTET_STREAM;
}

const ascii = (data: Uint8Array, len: number): string =>
  Buffer.from(data.subarray(0, len)).toString('latin1');

/**
 * Content-Type from magic bytes, or null when nothing matches. Only the formats
 * that plausibly show up extension-less in a design export.
 */
export function sniffContentType(data: Uint8Array): string | null {
  if (!data || data.length < 4) return null;

  // RIFF....WEBP
  if (
    data.length >= 12 &&
    ascii(data, 4) === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // \x89PNG\r\n\x1a\n
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  // JPEG SOI
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  // GIF87a / GIF89a
  if (ascii(data, 4) === 'GIF8') return 'image/gif';

  // Text-ish formats: sniff a short prefix, skipping a BOM and leading space.
  let text = Buffer.from(data.subarray(0, 512)).toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const head = text.replace(/^\s+/, '').toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return 'text/html; charset=utf-8';
  }
  return null;
}

/**
 * The Content-Type to store an entry with: extension first, magic bytes as a
 * fallback, octet-stream as the floor.
 */
export function contentTypeForEntry(path: string, data: Uint8Array): string {
  const byExt = contentTypeFor(path);
  if (byExt !== OCTET_STREAM) return byExt;
  return sniffContentType(data) ?? OCTET_STREAM;
}

/** Human-readable byte size for gallery labels ("124 KB", "7.6 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
