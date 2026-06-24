/**
 * Unit tests for the pure processor/helper logic in the Lambda handler.
 * No AWS mocking — exercises generateUid, contentTypeFor, isUnsafePath,
 * commonTopLevelDir/stripCommonTopLevelDir, looksLikeZip, and the full
 * processBundle entrypoint cascade with fflate-built zip fixtures.
 */
import { zipSync, strToU8 } from 'fflate';
import {
  generateUid,
  contentTypeFor,
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
    ['weird.bin', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s -> %s', (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
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

  it('errors on multiple HTML files with no top-level index.html', () => {
    const zip = makeZip({ 'a.html': '<h1>a</h1>', 'b.html': '<h1>b</h1>' });
    expect(() => processBundle('multi.zip', zip)).toThrow(/Multiple HTML/i);
  });

  it('prefers top-level index.html even when other html files exist', () => {
    const zip = makeZip({
      'index.html': '<h1>main</h1>',
      'about.html': '<h1>about</h1>',
    });
    const out = processBundle('multi.zip', zip);
    expect(decode(out.files['index.html'])).toContain('main');
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
