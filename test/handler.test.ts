/**
 * Unit tests for the pure processor/helper logic in the Lambda handler.
 * No AWS mocking — exercises generateUid, contentTypeFor/sniffContentType,
 * isUnsafePath, commonTopLevelDir/stripCommonTopLevelDir, looksLikeZip, and the
 * full processBundle entrypoint cascade with fflate-built zip fixtures.
 */
import { zipSync, strToU8 } from 'fflate';
import {
  generateUid,
  contentTypeFor,
  sniffContentType,
  contentTypeForEntry,
  isUnsafePath,
  commonTopLevelDir,
  stripCommonTopLevelDir,
  looksLikeZip,
  processBundle,
  isPreconditionError,
} from '../lib/lambda/handler';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{8}$/; // uppercase, no I L O U

function makeZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries);
}

const decode = (u: Uint8Array) => Buffer.from(u).toString('utf-8');

/** Minimal valid-enough headers for the magic-byte sniffer. */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

describe('generateUid', () => {
  it('produces 8-symbol uppercase Crockford base32', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateUid()).toMatch(CROCKFORD);
    }
  });

  it('is effectively unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateUid());
    expect(seen.size).toBeGreaterThan(995);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['a/b/style.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['photo.JPG', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['data.json', 'application/json; charset=utf-8'],
    ['shot.webp', 'image/webp'],
    ['readme.md', 'text/markdown; charset=utf-8'],
    ['page.dc.html', 'text/html; charset=utf-8'],
    ['weird.bin', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s -> %s', (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });

  // Design-system exports ship unbuilt sources next to the bundle. Serving them
  // as text/javascript would make them executable via <script src>.
  it.each(['Button.jsx', 'types.ts', 'App.tsx'])('%s is inert text/plain', (path) => {
    expect(contentTypeFor(path)).toBe('text/plain; charset=utf-8');
  });
});

describe('sniffContentType', () => {
  it.each([
    [WEBP, 'image/webp'],
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [strToU8('GIF89a...'), 'image/gif'],
    [strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
    [strToU8('  <!DOCTYPE HTML><h1>hi</h1>'), 'text/html; charset=utf-8'],
  ])('recognizes %#', (data, expected) => {
    expect(sniffContentType(data)).toBe(expected);
  });

  it.each([strToU8('just some prose'), new Uint8Array([1, 2]), new Uint8Array()])(
    'returns null for unrecognized input %#',
    (data) => {
      expect(sniffContentType(data)).toBeNull();
    },
  );
});

describe('contentTypeForEntry', () => {
  it('prefers the extension when it is known', () => {
    // Contents disagree with the name; the name wins.
    expect(contentTypeForEntry('a.css', PNG)).toBe('text/css; charset=utf-8');
  });

  it('sniffs extension-less files rather than serving octet-stream', () => {
    // A Design Composer export ships its workspace preview as `.thumbnail`,
    // which is really a WebP. As octet-stream a browser downloads it.
    expect(contentTypeFor('.thumbnail')).toBe('application/octet-stream');
    expect(contentTypeForEntry('.thumbnail', WEBP)).toBe('image/webp');
  });

  it('falls back to octet-stream when neither name nor bytes are recognizable', () => {
    expect(contentTypeForEntry('blob', new Uint8Array([7, 7, 7, 7]))).toBe(
      'application/octet-stream',
    );
  });
});

describe('isUnsafePath (zip-slip guard)', () => {
  it.each([
    '../escape.html',
    'a/../../etc/passwd',
    '/abs/path.html',
    'win\\style\\path.html',
    '..',
    './x.html',
    '',
    'a//b.html',
  ])('rejects %s', (p) => {
    expect(isUnsafePath(p)).toBe(true);
  });

  it.each(['index.html', 'assets/logo.png', 'a/b/c/style.css', 'deep/nested/file.js'])(
    'allows %s',
    (p) => {
      expect(isUnsafePath(p)).toBe(false);
    },
  );
});

describe('commonTopLevelDir / stripCommonTopLevelDir', () => {
  it('detects a single wrapping directory', () => {
    expect(commonTopLevelDir(['proj/index.html', 'proj/assets/a.css'])).toBe('proj');
  });
  it('returns null when a top-level file exists', () => {
    expect(commonTopLevelDir(['index.html', 'proj/a.css'])).toBeNull();
  });
  it('returns null with two different top dirs', () => {
    expect(commonTopLevelDir(['a/x.html', 'b/y.css'])).toBeNull();
  });
  it('strips the common prefix', () => {
    const stripped = stripCommonTopLevelDir({
      'proj/index.html': strToU8('hi'),
      'proj/assets/a.css': strToU8('css'),
    });
    expect(Object.keys(stripped).sort()).toEqual(['assets/a.css', 'index.html']);
  });
});

describe('looksLikeZip', () => {
  it('true for a real zip', () => {
    expect(looksLikeZip(makeZip({ 'index.html': '<h1>hi</h1>' }))).toBe(true);
  });
  it('false for plain HTML', () => {
    expect(looksLikeZip(strToU8('<!doctype html><h1>hi</h1>'))).toBe(false);
  });
});

describe('processBundle', () => {
  it('treats a single HTML upload as index.html', () => {
    const html = '<!doctype html><title>x</title>';
    const out = processBundle('mock.html', strToU8(html));
    expect(Object.keys(out.files)).toEqual(['index.html']);
    expect(decode(out.files['index.html'])).toBe(html);
  });

  it('rejects an empty upload', () => {
    expect(() => processBundle('x.html', new Uint8Array())).toThrow(/empty/i);
  });

  it('keeps top-level index.html and nested assets', () => {
    const zip = makeZip({
      'index.html': '<h1>home</h1>',
      'assets/style.css': 'body{}',
      'assets/app.js': 'console.log(1)',
    });
    const out = processBundle('site.zip', zip);
    expect(Object.keys(out.files).sort()).toEqual([
      'assets/app.js',
      'assets/style.css',
      'index.html',
    ]);
    expect(decode(out.files['index.html'])).toContain('home');
  });

  it('strips a common top-level directory (Claude Code export shape)', () => {
    const zip = makeZip({
      'my-project/index.html': '<h1>wrapped</h1>',
      'my-project/assets/logo.png': 'PNGDATA',
    });
    const out = processBundle('my-project.zip', zip);
    expect(Object.keys(out.files).sort()).toEqual(['assets/logo.png', 'index.html']);
  });

  it('promotes the sole .html to index.html when none is named index', () => {
    const zip = makeZip({
      'page.html': '<h1>only page</h1>',
      'style.css': 'body{}',
    });
    const out = processBundle('thing.zip', zip);
    // Both the original and a copy at index.html exist.
    expect(out.files['index.html']).toBeDefined();
    expect(out.files['page.html']).toBeDefined();
    expect(decode(out.files['index.html'])).toContain('only page');
  });

  it('errors when the zip has no HTML', () => {
    const zip = makeZip({ 'style.css': 'body{}', 'app.js': '1' });
    expect(() => processBundle('nohtml.zip', zip)).toThrow(/No HTML/i);
  });

  it('prefers top-level index.html even when other html files exist', () => {
    const zip = makeZip({
      'index.html': '<h1>main</h1>',
      'about.html': '<h1>about</h1>',
    });
    const out = processBundle('multi.zip', zip);
    expect(decode(out.files['index.html'])).toContain('main');
    // An author-supplied entry page is never second-guessed with a gallery.
    expect(out.pages).toBeUndefined();
  });

  it('rejects a zip-slip attempt', () => {
    // Build a zip whose entry escapes the prefix. Strip won't apply because
    // there is also an index.html at top level.
    const zip = makeZip({
      'index.html': '<h1>ok</h1>',
      '../evil.html': '<h1>evil</h1>',
    });
    expect(() => processBundle('evil.zip', zip)).toThrow(/Unsafe path/i);
  });

  it('drops OS and editor cruft before it costs memory or an S3 object', () => {
    const zip = makeZip({
      'index.html': '<h1>ok</h1>',
      '__MACOSX/._index.html': 'junk',
      '.DS_Store': 'junk',
      'assets/Thumbs.db': 'junk',
      'assets/._logo.png': 'junk',
      '.git/config': 'junk',
    });
    const out = processBundle('macos.zip', zip);
    expect(Object.keys(out.files)).toEqual(['index.html']);
  });

  it('rejects an archive with too many entries', () => {
    // Enforced from the unzip filter against the central directory, so the
    // archive is rejected without inflating it. The decompressed-byte cap uses
    // the same mechanism.
    const many: Record<string, string> = { 'index.html': '<h1>x</h1>' };
    for (let i = 0; i < 5001; i++) many[`f${i}.txt`] = 'x';
    expect(() => processBundle('many.zip', makeZip(many))).toThrow(/too many files/i);
  });
});

describe('processBundle — multi-page bundles (generated gallery)', () => {
  it('generates a gallery index instead of rejecting a multi-page zip', () => {
    // This shape — several pages, no index.html — used to be a hard error and is
    // exactly what a design-tool workspace export looks like.
    const zip = makeZip({
      'Alpha Page.html': '<h1>alpha</h1>',
      'Beta Page.html': '<h1>beta</h1>',
      'style.css': 'body{}',
    });
    const out = processBundle('export.zip', zip);

    expect(out.pages?.map((p) => p.slug)).toEqual(['alpha-page', 'beta-page']);
    const index = decode(out.files['index.html']);
    expect(index).toContain('<!doctype html>');
    expect(index).toContain('Alpha Page');
    expect(index).toContain('Beta Page');
    expect(out.contentTypes?.['index.html']).toBe('text/html; charset=utf-8');
  });

  it('keeps the original pages untouched and adds slug redirects beside them', () => {
    const zip = makeZip({ 'One.html': '<h1>1</h1>', 'Two.html': '<h1>2</h1>' });
    const out = processBundle('export.zip', zip);

    // Originals are byte-identical: an export's runtime resolves siblings by
    // their real filenames, so renaming or dropping them breaks the pages.
    expect(decode(out.files['One.html'])).toBe('<h1>1</h1>');
    expect(decode(out.files['Two.html'])).toBe('<h1>2</h1>');

    // Slugs are separate, extension-less objects that redirect.
    expect(decode(out.files['one'])).toContain('One.html');
    expect(out.contentTypes?.['one']).toBe('text/html; charset=utf-8');
  });

  it('exposes an extension-less preview image at a typed key', () => {
    const entries: Record<string, Uint8Array> = {
      'a.html': strToU8('<h1>a</h1>'),
      'b.html': strToU8('<h1>b</h1>'),
      '.thumbnail': WEBP,
    };
    const out = processBundle('export.zip', zipSync(entries));
    expect(out.preview).toBe('_preview.webp');
    expect(out.files['_preview.webp']).toEqual(WEBP);
    expect(out.files['.thumbnail']).toEqual(WEBP); // original still served
    expect(decode(out.files['index.html'])).toContain('src="_preview.webp"');
  });

  it('emits og:image only when it can build an absolute URL', () => {
    const entries: Record<string, Uint8Array> = {
      'a.html': strToU8('<h1>a</h1>'),
      'b.html': strToU8('<h1>b</h1>'),
      '.thumbnail': WEBP,
    };
    const zip = zipSync(entries);

    const withDomain = processBundle('e.zip', zip, {
      uid: 'ABCD1234',
      shareBaseUrl: 'https://mocks.example.com',
    });
    expect(decode(withDomain.files['index.html'])).toContain(
      'content="https://mocks.example.com/ABCD1234/_preview.webp"',
    );

    // No domain configured: a relative og:image would be useless to a crawler.
    expect(decode(processBundle('e.zip', zip).files['index.html'])).not.toContain(
      'og:image',
    );
  });

  it('carries the upload title and description into the page', () => {
    const zip = makeZip({ 'a.html': '<h1>a</h1>', 'b.html': '<h1>b</h1>' });
    const out = processBundle('export.zip', zip, {
      title: 'Passport concepts',
      description: 'Round 3 review',
    });
    const index = decode(out.files['index.html']);
    expect(index).toContain('<title>Passport concepts</title>');
    expect(index).toContain('Round 3 review');
  });
});

describe('isPreconditionError (optimistic concurrency retry guard)', () => {
  it.each([
    { name: 'PreconditionFailed' },
    { name: 'ConditionalRequestConflict' },
    { $metadata: { httpStatusCode: 412 } },
    { $metadata: { httpStatusCode: 409 } },
    { Code: 'PreconditionFailed' },
  ])('treats %j as a precondition conflict', (err) => {
    expect(isPreconditionError(err)).toBe(true);
  });

  it.each([
    { name: 'NoSuchKey' },
    { $metadata: { httpStatusCode: 500 } },
    { name: 'AccessDenied' },
    {},
  ])('treats %j as non-retryable', (err) => {
    expect(isPreconditionError(err)).toBe(false);
  });
});
