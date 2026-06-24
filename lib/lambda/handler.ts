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
 *    entrypoint, reject zip-slip, write assets under `<uid>/`, then always write
 *    `status/<uid>.json` (and upsert metadata on success only).
 *
 * Reserved concurrency = 1 on this function serializes every metadata.json
 * read-modify-write across both paths.
 *
 * The pure helpers (`generateUid`, `processBundle`, `contentTypeFor`,
 * `isUnsafePath`, `stripCommonTopLevelDir`) carry the interesting logic and are
 * exported for unit testing without any AWS mocking.
 */
import { randomBytes } from 'node:crypto';
import { unzipSync } from 'fflate';
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

/** Guards against zip bombs in the processor. */
const MAX_TOTAL_DECOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_FILE_COUNT = 5000;

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
  xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
};

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

/** Content-Type for a path, by extension; octet-stream when unknown. */
export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

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

export interface ProcessedBundle {
  files: Record<string, Uint8Array>;
  entrypoint: string; // always 'index.html'
}

/**
 * Turn a raw upload into the set of files to write under `<uid>/`.
 *
 * - Single (non-zip) upload -> served as `index.html`.
 * - Zip -> unzip, drop directory entries, strip a common top-level dir, then
 *   pick the entrypoint: top-level `index.html`, else the sole `.html` anywhere
 *   (also copied to `index.html` so `/<uid>` resolves), else throw.
 *
 * Throws a human-readable Error on any condition that should surface to the
 * uploader as a `status: "error"`.
 */
export function processBundle(
  originalFilename: string,
  data: Uint8Array,
): ProcessedBundle {
  if (!data || data.length === 0) {
    throw new Error('Uploaded file is empty.');
  }

  // Single HTML page (anything that isn't a zip is treated as the page itself).
  if (!looksLikeZip(data)) {
    return { files: { 'index.html': data }, entrypoint: 'index.html' };
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(data);
  } catch (err) {
    throw new Error(
      `Could not read the .zip archive${
        originalFilename ? ` (${originalFilename})` : ''
      }: ${(err as Error).message}`,
    );
  }

  // Drop directory entries (keys ending in '/') and empty placeholders.
  const fileEntries: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  for (const [path, content] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue;
    fileEntries[path] = content;
    totalBytes += content.length;
  }

  const count = Object.keys(fileEntries).length;
  if (count === 0) throw new Error('The .zip archive contains no files.');
  if (count > MAX_FILE_COUNT) {
    throw new Error(`The .zip archive has too many files (${count}).`);
  }
  if (totalBytes > MAX_TOTAL_DECOMPRESSED_BYTES) {
    throw new Error('The .zip archive is too large when decompressed.');
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
  if (!files['index.html']) {
    const htmls = Object.keys(files).filter((p) => /\.html?$/i.test(p));
    if (htmls.length === 1) {
      files['index.html'] = files[htmls[0]];
    } else if (htmls.length === 0) {
      throw new Error(
        'No HTML file found in the archive. Include an index.html (or a single .html file).',
      );
    } else {
      throw new Error(
        'Multiple HTML files found and none is a top-level index.html. ' +
          'Name your entry page index.html.',
      );
    }
  }

  return { files, entrypoint: 'index.html' };
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
      // Sidecar with title/description/filename written by `presign`.
      const sidecar = await readJson<Sidecar>(staging, `${META_PREFIX}${uid}.json`);
      if (sidecar?.originalFilename) originalFilename = sidecar.originalFilename;

      const data = await readBytes(staging, decodedKey);
      const { files } = processBundle(originalFilename, data);

      // Write every processed file under <uid>/ with a 1-year immutable cache.
      for (const [path, content] of Object.entries(files)) {
        await s3().send(
          new PutObjectCommand({
            Bucket: assets,
            Key: `${uid}/${path}`,
            Body: content,
            ContentType: contentTypeFor(path),
            CacheControl: IMMUTABLE_CACHE,
          }),
        );
      }

      // Success: mark ready, then upsert metadata (last, per design).
      await writeJson(assets, `${STATUS_PREFIX}${uid}.json`, { status: 'ready' }, NO_CACHE);

      await mutateMetadata((meta) => {
        meta[uid] = {
          uid,
          title: sidecar?.title ?? null,
          description: sidecar?.description ?? null,
          'original-filename': originalFilename,
          'created-at': new Date().toISOString(),
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
