/**
 * Multi-action Lambda for the mocks host.
 *
 * A single function serves two invocation paths, dispatched by event shape:
 *
 *  - HTTP API (Cognito-authorized) -> router: `presign`, `list`, `edit`,
 *    `delete`. Every action re-checks the caller's email against the
 *    ALLOWED_EMAILS allowlist (defense in depth behind the JWT authorizer).
 *  - S3 `OBJECT_CREATED` event (staging bucket, prefix `uploads/`) -> processor:
 *    sniff zip vs single HTML, unzip, strip a common top-level dir, pick the
 *    entrypoint (or generate a gallery index for a multi-page bundle), reject
 *    zip-slip, write assets under `<uid>/`, then always write
 *    `status/<uid>.json` (and upsert metadata on success only).
 *
 * Reserved concurrency = 1 on this function serializes every metadata.json
 * read-modify-write across both paths.
 *
 * The pure helpers (`generateUid`, `processBundle`, `contentTypeFor`,
 * `isUnsafePath`, `stripCommonTopLevelDir`) carry the interesting logic and are
 * exported for unit testing without any AWS mocking. The multi-page gallery
 * logic lives in `./gallery`, and Content-Type resolution in `./media-type`.
 */
import { randomBytes } from 'node:crypto';
import { unzipSync } from 'fflate';
import { buildGallery, type GalleryMeta, type PageEntry } from './gallery';
import { contentTypeForEntry } from './media-type';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const UPLOAD_PREFIX = 'uploads/';
const META_PREFIX = 'meta/';
const STATUS_PREFIX = 'status/';

/**
 * Guards against zip bombs. Both are enforced from the unzip *filter*, against
 * sizes read from the central directory, so an oversized archive is rejected
 * before any of it is inflated into memory.
 */
const MAX_TOTAL_DECOMPRESSED_BYTES = 400 * 1024 * 1024; // 400 MB
const MAX_FILE_COUNT = 5000;

/**
 * Ceiling on the raw upload. The admin UI caps the file picker at 50 MB, but a
 * presigned PUT has no size limit of its own, so the processor re-checks the
 * object size from the S3 event before pulling the bytes into memory.
 */
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB

/**
 * Editor and OS cruft that routinely rides along in a hand-zipped folder.
 * Dropped before decompression so it costs neither memory nor an S3 object.
 */
const JUNK_ENTRY =
  /(?:^|\/)(?:__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\.git\/|\.svn\/|\._)/i;

/** Concurrent PutObject calls while writing a processed bundle. */
const PUT_CONCURRENCY = 12;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

// ---------------------------------------------------------------------------
// Lazily-constructed AWS clients (region from the Lambda runtime env)
// ---------------------------------------------------------------------------

let _s3: S3Client | undefined;
let _cf: CloudFrontClient | undefined;
const s3 = (): S3Client => (_s3 ??= new S3Client({}));
const cloudfront = (): CloudFrontClient => (_cf ??= new CloudFrontClient({}));

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Mint an 8-symbol (40-bit) uppercase Crockford base32 UID. */
export function generateUid(): string {
  const bytes = randomBytes(5); // 40 bits
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let uid = '';
  for (let i = 0; i < 8; i++) {
    const idx = Number((bits >> BigInt(5 * (7 - i))) & 31n);
    uid += CROCKFORD[idx];
  }
  return uid;
}

// Content-Type resolution lives in ./media-type; re-exported here because it is
// part of this module's tested surface.
export { contentTypeFor, sniffContentType, contentTypeForEntry } from './media-type';

/**
 * Reject paths that would escape the `<uid>/` prefix (zip-slip): absolute
 * paths, Windows separators, empty/`.`/`..` segments.
 */
export function isUnsafePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return true;
  if (path.includes('\0')) return true;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return true;
  }
  return false;
}

/**
 * If every entry shares a single top-level directory (the common Claude Code
 * export shape, e.g. `my-project/...`), return that dir name; else null.
 */
export function commonTopLevelDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const tops = new Set<string>();
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash === -1) return null; // a top-level file exists -> no wrapping dir
    tops.add(p.slice(0, slash));
  }
  return tops.size === 1 ? [...tops][0] : null;
}

/** Strip a common top-level directory from all paths, if one exists. */
export function stripCommonTopLevelDir(
  files: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  const paths = Object.keys(files);
  const common = commonTopLevelDir(paths);
  if (!common) return files;
  const out: Record<string, Uint8Array> = {};
  const prefix = common + '/';
  for (const [p, data] of Object.entries(files)) {
    out[p.slice(prefix.length)] = data;
  }
  return out;
}

/** Detect the PKZIP local-file / empty-archive magic bytes. */
export function looksLikeZip(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 && // P
    data[1] === 0x4b && // K
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07) &&
    (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08)
  );
}

/** Page summary recorded in metadata.json so the admin app can deep-link. */
export interface PageSummary {
  slug: string;
  name: string;
  group: string;
}

export interface ProcessedBundle {
  files: Record<string, Uint8Array>;
  entrypoint: string; // always 'index.html'
  /**
   * Explicit Content-Type for generated objects, keyed by path. Slug redirect
   * stubs are extension-less, so the type must be stated rather than inferred.
   */
  contentTypes?: Record<string, string>;
  /** Present only for a generated gallery; absent for single-page bundles. */
  pages?: PageSummary[];
  /** Key of the bundle preview image under `<uid>/`, when one was found. */
  preview?: string | null;
}

/**
 * Turn a raw upload into the set of files to write under `<uid>/`.
 *
 * - Single (non-zip) upload -> served as `index.html`.
 * - Zip -> unzip (dropping directory entries and OS cruft), strip a common
 *   top-level dir, reject zip-slip, then resolve the entrypoint:
 *
 *     top-level index.html   -> serve it as-is
 *     exactly one .html      -> promote it to index.html so `/<uid>` resolves
 *     no .html at all        -> throw
 *     2+ .html, no index     -> generate a gallery index + slug redirects
 *
 * The last branch is what makes design-tool exports shareable: they carry
 * several independently-viewable pages and no entry page, and used to be
 * rejected outright.
 *
 * Throws a human-readable Error on any condition that should surface to the
 * uploader as a `status: "error"`.
 */
export function processBundle(
  originalFilename: string,
  data: Uint8Array,
  meta: Partial<Omit<GalleryMeta, 'originalFilename'>> = {},
): ProcessedBundle {
  if (!data || data.length === 0) {
    throw new Error('Uploaded file is empty.');
  }

  // Single HTML page (anything that isn't a zip is treated as the page itself).
  if (!looksLikeZip(data)) {
    return { files: { 'index.html': data }, entrypoint: 'index.html' };
  }

  // Enforce the zip-bomb guards from inside the filter: `originalSize` comes
  // from the central directory, so an oversized archive is rejected before it
  // is inflated. A cap trip is recorded rather than thrown, because throwing
  // here would be swallowed by the "could not read the archive" wrapper below.
  let capError: string | null = null;
  let entryCount = 0;
  let totalBytes = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data, {
      filter: (file) => {
        if (capError) return false;
        if (file.name.endsWith('/')) return false; // directory entry
        if (JUNK_ENTRY.test(file.name)) return false;
        entryCount++;
        totalBytes += file.originalSize;
        if (entryCount > MAX_FILE_COUNT) {
          capError = `The .zip archive has too many files (over ${MAX_FILE_COUNT}).`;
          return false;
        }
        if (totalBytes > MAX_TOTAL_DECOMPRESSED_BYTES) {
          capError = 'The .zip archive is too large when decompressed.';
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    throw new Error(
      `Could not read the .zip archive${
        originalFilename ? ` (${originalFilename})` : ''
      }: ${(err as Error).message}`,
    );
  }
  if (capError) throw new Error(capError);

  // The filter already dropped directory entries; re-check defensively, since a
  // zip can describe a directory without the trailing-slash convention.
  const fileEntries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue;
    fileEntries[path] = content;
  }

  if (Object.keys(fileEntries).length === 0) {
    throw new Error('The .zip archive contains no usable files.');
  }

  const stripped = stripCommonTopLevelDir(fileEntries);

  // Zip-slip / path safety check after stripping.
  for (const path of Object.keys(stripped)) {
    if (isUnsafePath(path)) {
      throw new Error(`Unsafe path in archive: "${path}".`);
    }
  }

  // Entrypoint cascade.
  const files: Record<string, Uint8Array> = { ...stripped };
  if (files['index.html']) return { files, entrypoint: 'index.html' };

  const htmls = Object.keys(files).filter((p) => /\.html?$/i.test(p));
  if (htmls.length === 0) {
    throw new Error(
      'No HTML file found in the archive. Include an index.html (or a single .html file).',
    );
  }
  if (htmls.length === 1) {
    files['index.html'] = files[htmls[0]];
    return { files, entrypoint: 'index.html' };
  }

  // Multi-page bundle: synthesize the landing page the export never had.
  const gallery = buildGallery(stripped, {
    uid: meta.uid ?? '',
    title: meta.title ?? null,
    description: meta.description ?? null,
    originalFilename,
    shareBaseUrl: meta.shareBaseUrl ?? '',
  });

  const contentTypes: Record<string, string> = {
    'index.html': 'text/html; charset=utf-8',
  };
  files['index.html'] = Buffer.from(gallery.indexHtml, 'utf-8');
  for (const [slug, html] of Object.entries(gallery.stubs)) {
    files[slug] = Buffer.from(html, 'utf-8');
    contentTypes[slug] = 'text/html; charset=utf-8';
  }
  // Copy (by reference — no extra bytes) the preview to a stable, typed key.
  if (gallery.previewSource && gallery.previewKey) {
    files[gallery.previewKey] = stripped[gallery.previewSource];
  }

  return {
    files,
    entrypoint: 'index.html',
    contentTypes,
    pages: gallery.pages.map((p: PageEntry) => ({
      slug: p.slug,
      name: p.name,
      group: p.group,
    })),
    preview: gallery.previewKey,
  };
}

// ---------------------------------------------------------------------------
// Env / small utilities
// ---------------------------------------------------------------------------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function allowlist(): string[] {
  return (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function readBytes(bucket: string, key: string): Promise<Uint8Array> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body!.transformToByteArray();
}

async function readJson<T>(bucket: string, key: string): Promise<T | null> {
  try {
    const bytes = await readBytes(bucket, key);
    return JSON.parse(Buffer.from(bytes).toString('utf-8')) as T;
  } catch (err: any) {
    const code = err?.name ?? err?.Code;
    if (code === 'NoSuchKey' || code === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

async function writeJson(
  bucket: string,
  key: string,
  obj: unknown,
  cacheControl: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(obj),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: cacheControl,
    }),
  );
}

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err: any) {
    const code = err?.name ?? err?.Code;
    if (code === 'NotFound' || code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

interface MetadataEntry {
  uid: string;
  title: string | null;
  description: string | null;
  'original-filename': string;
  'created-at': string;
  /**
   * Multi-page bundle extras. All optional: entries written before gallery
   * support existed have none of them, and the admin app must render without.
   */
  pages?: PageSummary[];
  preview?: string | null;
  'file-count'?: number;
}
type Metadata = Record<string, MetadataEntry>;

const metadataKey = () => env('METADATA_KEY');

/** Read metadata.json with its current ETag (etag=null when it doesn't exist). */
async function readMetadataWithEtag(): Promise<{ meta: Metadata; etag: string | null }> {
  try {
    const res = await s3().send(
      new GetObjectCommand({ Bucket: env('METADATA_BUCKET'), Key: metadataKey() }),
    );
    const bytes = await res.Body!.transformToByteArray();
    const meta = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Metadata;
    return { meta, etag: res.ETag ?? null };
  } catch (err: any) {
    const code = err?.name ?? err?.Code;
    if (code === 'NoSuchKey' || code === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
      return { meta: {}, etag: null };
    }
    throw err;
  }
}

/** Read-only metadata access (for the `list` action). */
async function readMetadata(): Promise<Metadata> {
  return (await readMetadataWithEtag()).meta;
}

export function isPreconditionError(err: any): boolean {
  const code = err?.name ?? err?.Code;
  const status = err?.$metadata?.httpStatusCode;
  return (
    code === 'PreconditionFailed' ||
    code === 'ConditionalRequestConflict' ||
    status === 412 ||
    status === 409
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomically read-modify-write metadata.json using S3 conditional writes
 * (optimistic concurrency). `mutate` receives the current metadata and mutates
 * it in place (or returns a replacement). The write is guarded by `IfMatch` on
 * the read ETag (or `IfNoneMatch: *` when creating), and the whole cycle is
 * retried on a precondition failure caused by a concurrent writer.
 *
 * This replaces the original reserved-concurrency=1 serialization: correctness
 * no longer depends on any account concurrency quota.
 */
async function mutateMetadata(
  mutate: (meta: Metadata) => Metadata | void,
): Promise<Metadata> {
  const bucket = env('METADATA_BUCKET');
  const key = metadataKey();
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { meta, etag } = await readMetadataWithEtag();
    const next = (mutate(meta) ?? meta) as Metadata;
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(next),
          ContentType: 'application/json; charset=utf-8',
          CacheControl: NO_CACHE,
          // Guard the write: match the version we read, or require absence on
          // first creation. A concurrent writer invalidates one of these.
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return next;
    } catch (err) {
      if (isPreconditionError(err) && attempt < maxAttempts - 1) {
        await sleep(50 * 2 ** attempt + Math.floor(Math.random() * 50));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not update metadata after repeated conflicts.');
}

// ---------------------------------------------------------------------------
// Processor (S3 event)
// ---------------------------------------------------------------------------

function uidFromUploadKey(key: string): string {
  // Key shape is uploads/<uid>/<filename>; trust the S3 prefix filter and take
  // the second segment as the UID.
  const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  return decoded.split('/')[1] ?? '';
}

interface Sidecar {
  uid: string;
  title: string | null;
  description: string | null;
  originalFilename: string;
}

/**
 * Write every processed file under `<uid>/` with bounded concurrency.
 *
 * A design export is dozens of objects (and two of them can be 7.6 MB), which
 * a serial loop turns into minutes of round-trips. This is SDK concurrency
 * inside one invocation and is unrelated to the account's Lambda concurrency
 * limit.
 */
async function writeBundle(
  bucket: string,
  uid: string,
  bundle: ProcessedBundle,
): Promise<void> {
  const entries = Object.entries(bundle.files);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      const [path, content] = entries[i];
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${uid}/${path}`,
          Body: content,
          ContentType: bundle.contentTypes?.[path] ?? contentTypeForEntry(path, content),
          CacheControl: IMMUTABLE_CACHE,
        }),
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, entries.length) }, worker),
  );
}

/** Public origin for absolute URLs in generated pages (og:image). */
function shareBaseUrl(): string {
  return (process.env.SHARE_BASE_URL ?? '').replace(/\/+$/, '');
}

async function handleS3Event(event: any): Promise<void> {
  const staging = env('STAGING_BUCKET');
  const assets = env('ASSETS_BUCKET');

  for (const record of event.Records ?? []) {
    const key: string = record.s3.object.key;
    const decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
    const uid = uidFromUploadKey(key);
    if (!uid) continue;

    let originalFilename = decodedKey.split('/').slice(2).join('/') || 'upload';
    try {
      // Reject an oversized object from its event metadata, before the bytes are
      // ever pulled into memory. The browser caps the picker at 50 MB, but the
      // presigned PUT itself has no size limit.
      const uploadedBytes: number = record.s3.object.size ?? 0;
      if (uploadedBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Upload is too large (${Math.round(uploadedBytes / 1048576)} MB); ` +
            `the limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`,
        );
      }

      // Sidecar with title/description/filename written by `presign`.
      const sidecar = await readJson<Sidecar>(staging, `${META_PREFIX}${uid}.json`);
      if (sidecar?.originalFilename) originalFilename = sidecar.originalFilename;

      const data = await readBytes(staging, decodedKey);
      const bundle = processBundle(originalFilename, data, {
        uid,
        title: sidecar?.title ?? null,
        description: sidecar?.description ?? null,
        shareBaseUrl: shareBaseUrl(),
      });

      // Write every processed file under <uid>/ with a 1-year immutable cache.
      await writeBundle(assets, uid, bundle);

      // Success: mark ready, then upsert metadata (last, per design).
      await writeJson(assets, `${STATUS_PREFIX}${uid}.json`, { status: 'ready' }, NO_CACHE);

      await mutateMetadata((meta) => {
        meta[uid] = {
          uid,
          title: sidecar?.title ?? null,
          description: sidecar?.description ?? null,
          'original-filename': originalFilename,
          'created-at': new Date().toISOString(),
          ...(bundle.pages?.length ? { pages: bundle.pages } : {}),
          ...(bundle.preview ? { preview: bundle.preview } : {}),
          'file-count': Object.keys(bundle.files).length,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // metadata.json is intentionally NOT written on failure.
      await writeJson(
        assets,
        `${STATUS_PREFIX}${uid}.json`,
        { status: 'error', error: message },
        NO_CACHE,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Router (HTTP API)
// ---------------------------------------------------------------------------

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event: any): any {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function callerEmail(event: any): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  return String(claims.email ?? '').trim().toLowerCase();
}

function actionFromPath(event: any): string {
  const path: string = event.requestContext?.http?.path ?? event.rawPath ?? '';
  const seg = path.split('/').filter(Boolean).pop() ?? '';
  return seg.toLowerCase();
}

/** Keep only the basename and strip anything path-like or unusual. */
function sanitizeFilename(name: string): string {
  const base = (name || 'upload').split(/[\\/]/).pop() ?? 'upload';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length ? cleaned.slice(0, 200) : 'upload';
}

async function actionPresign(event: any) {
  const assets = env('ASSETS_BUCKET');
  const staging = env('STAGING_BUCKET');
  const body = parseBody(event);

  const filename = sanitizeFilename(String(body.filename ?? 'upload'));
  const title = body.title != null ? String(body.title).slice(0, 200) : null;
  const description =
    body.description != null ? String(body.description).slice(0, 2000) : null;

  // Mint a UID, retrying on the astronomically rare collision (status file
  // already present for that UID in the assets bucket).
  let uid = generateUid();
  for (let i = 0; i < 5; i++) {
    if (!(await objectExists(assets, `${STATUS_PREFIX}${uid}.json`))) break;
    uid = generateUid();
  }

  // Sidecar carries title/description/filename to the processor (under meta/,
  // which is excluded from the S3 notification).
  const sidecar: Sidecar = { uid, title, description, originalFilename: filename };
  await writeJson(staging, `${META_PREFIX}${uid}.json`, sidecar, NO_CACHE);

  // Pre-create the status object so polling never hits a cached 403/404.
  await writeJson(assets, `${STATUS_PREFIX}${uid}.json`, { status: 'processing' }, NO_CACHE);

  // Server controls the key; the browser PUTs the bytes to this exact URL.
  const uploadKey = `${UPLOAD_PREFIX}${uid}/${filename}`;
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: staging, Key: uploadKey }),
    { expiresIn: 900 },
  );

  return json(200, { uid, uploadUrl, key: uploadKey });
}

async function actionList() {
  const meta = await readMetadata();
  const items = Object.values(meta).sort((a, b) =>
    (b['created-at'] ?? '').localeCompare(a['created-at'] ?? ''),
  );
  return json(200, { items });
}

async function actionEdit(event: any) {
  const body = parseBody(event);
  const uid = String(body.uid ?? '').toUpperCase();
  if (!uid) return json(400, { error: 'uid is required' });

  let notFound = false;
  let edited: MetadataEntry | undefined;
  await mutateMetadata((meta) => {
    const entry = meta[uid];
    if (!entry) {
      notFound = true;
      return;
    }
    if ('title' in body) entry.title = body.title != null ? String(body.title).slice(0, 200) : null;
    if ('description' in body) {
      entry.description = body.description != null ? String(body.description).slice(0, 2000) : null;
    }
    edited = entry;
  });

  if (notFound) return json(404, { error: 'No such upload' });
  return json(200, { item: edited });
}

async function deleteByPrefix(bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const listed = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) {
      await s3().send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
      );
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
}

async function actionDelete(event: any) {
  const assets = env('ASSETS_BUCKET');
  const body = parseBody(event);
  const uid = String(body.uid ?? '').toUpperCase();
  if (!uid || !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(uid)) {
    return json(400, { error: 'A valid uid is required' });
  }

  // Remove all assets under <uid>/ and the status file.
  await deleteByPrefix(assets, `${uid}/`);
  await s3()
    .send(new DeleteObjectCommand({ Bucket: assets, Key: `${STATUS_PREFIX}${uid}.json` }))
    .catch(() => undefined);

  // Remove the metadata entry.
  await mutateMetadata((meta) => {
    delete meta[uid];
  });

  // Invalidate the edge cache for this UID (the one break in immutability).
  const distId = process.env.DISTRIBUTION_ID;
  if (distId) {
    await cloudfront()
      .send(
        new CreateInvalidationCommand({
          DistributionId: distId,
          InvalidationBatch: {
            CallerReference: `del-${uid}-${Date.now()}`,
            Paths: { Quantity: 1, Items: [`/${uid}/*`] },
          },
        }),
      )
      .catch((e) => console.error('CloudFront invalidation failed', e));
  }

  return json(200, { deleted: uid });
}

async function handleHttp(event: any) {
  const email = callerEmail(event);
  if (!allowlist().includes(email)) {
    return json(403, { error: 'Not authorized' });
  }

  const action = actionFromPath(event);
  try {
    switch (action) {
      case 'presign':
        return await actionPresign(event);
      case 'list':
        return await actionList();
      case 'edit':
        return await actionEdit(event);
      case 'delete':
        return await actionDelete(event);
      default:
        return json(404, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Action failed', action, err);
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

// ---------------------------------------------------------------------------
// Entry point — dispatch by event shape
// ---------------------------------------------------------------------------

export const handler = async (event: any): Promise<any> => {
  if (event && Array.isArray(event.Records) && event.Records[0]?.s3) {
    await handleS3Event(event);
    return;
  }
  return handleHttp(event);
};
