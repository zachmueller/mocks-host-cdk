/**
 * Unit tests for the multi-page gallery builder.
 *
 * The fixture mirrors the real Design Composer export that motivated this
 * feature: `.dc.html` sources beside a `support.js` runtime and a `_ds/` design
 * system, self-contained `.html` bundles, an extension-less `.thumbnail`, and
 * working directories nothing links to. `private/` is gitignored, so the
 * committed fixture is synthetic; one test at the bottom runs against the real
 * archive when it happens to be present locally.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8 } from 'fflate';
import {
  buildGallery,
  assignSlugs,
  slugify,
  stripPageExt,
  pageNameFor,
  encodePath,
  escapeHtml,
  extractThumbSvg,
  findPreview,
  redirectStub,
  designComposerRecognizer,
  genericRecognizer,
  type PageDraft,
} from '../lib/lambda/gallery';
import { processBundle } from '../lib/lambda/handler';

const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** A page with an embedded Design Composer thumbnail, as the real ones carry. */
function pageWithThumb(bg: string, extra = ''): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
    `<div id="__bundler_thumbnail">` +
    `<svg sc-camel-view-box="0 0 1200 800" xmlns="http://www.w3.org/2000/svg" width="1200">` +
    `<rect width="1200" height="800" fill="${bg}"></rect></svg>` +
    '</div>' +
    extra +
    '</body></html>'
  );
}

const META = {
  uid: 'ABCD1234',
  title: 'Medworld passport',
  description: 'Workspace export',
  originalFilename: 'Medworld passport.zip',
  shareBaseUrl: 'https://mocks.example.com',
};

/** Synthetic stand-in for the real export's shape. */
function exportFixture(): Record<string, Uint8Array> {
  return {
    '.thumbnail': WEBP,
    'Credentials Filter Options.dc.html': strToU8('<x-dc>filters</x-dc>'),
    'Medworld Passport.html': strToU8(pageWithThumb('#0F5F4E')),
    'Passport Progress Variations.dc.html': strToU8(pageWithThumb('#0F68EF')),
    'Passport Progress Variations.html': strToU8(pageWithThumb('#0F68EF')),
    'Passport.dc.html': strToU8('<x-dc>passport</x-dc>'),
    'support.js': strToU8('// dc runtime'),
    '_ds/pulse-abc123/styles.css': strToU8('body{}'),
    '_ds/pulse-abc123/readme.md': strToU8('# ds'),
    'screenshots/one.png': strToU8('PNG'),
    'uploads/pasted-1.png': strToU8('PNG'),
  };
}

describe('slug helpers', () => {
  it.each([
    ['Passport Progress Variations', 'passport-progress-variations'],
    ['TOE Signature Variations', 'toe-signature-variations'],
    ['  Trailing & leading  ', 'trailing-leading'],
    ['Café Ünicode', 'cafe-unicode'],
    ['___', ''],
  ])('slugify(%j) -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('caps slug length so keys stay reasonable', () => {
    expect(slugify('x'.repeat(200)).length).toBe(60);
  });

  it.each([
    ['Passport.dc.html', 'Passport'],
    ['Passport.html', 'Passport'],
    ['a/b/Deep Page.htm', 'a/b/Deep Page'],
  ])('stripPageExt(%j) -> %j', (input, expected) => {
    expect(stripPageExt(input)).toBe(expected);
  });

  it('pageNameFor drops directories and the page extension', () => {
    expect(pageNameFor('sub/dir/My Page.dc.html')).toBe('My Page');
  });

  it('encodePath escapes segments but keeps separators', () => {
    expect(encodePath('a b/c&d.html')).toBe('a%20b/c%26d.html');
  });

  it('escapeHtml neutralizes markup in page names', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });
});

describe('assignSlugs', () => {
  const draft = (p: string, kind: PageDraft['kind']): PageDraft => ({
    path: p,
    name: pageNameFor(p),
    kind,
    group: 'g',
    bytes: 1,
  });

  it('gives the self-contained page the clean slug and the source sibling -source', () => {
    // The real collision: an export ships Foo.html and Foo.dc.html side by side.
    const out = assignSlugs(
      [
        draft('Passport Progress Variations.dc.html', 'source'),
        draft('Passport Progress Variations.html', 'bundled'),
      ],
      [],
    );
    const bySlug = Object.fromEntries(out.map((p) => [p.path, p.slug]));
    expect(bySlug['Passport Progress Variations.html']).toBe(
      'passport-progress-variations',
    );
    expect(bySlug['Passport Progress Variations.dc.html']).toBe(
      'passport-progress-variations-source',
    );
  });

  it('preserves the input order of pages', () => {
    const out = assignSlugs([draft('b.html', 'page'), draft('a.html', 'page')], []);
    expect(out.map((p) => p.path)).toEqual(['b.html', 'a.html']);
  });

  it('falls back to a numeric suffix when slugify collapses distinct names', () => {
    const out = assignSlugs(
      [draft('a+b.html', 'bundled'), draft('a-b.html', 'bundled')],
      [],
    );
    expect(out.map((p) => p.slug).sort()).toEqual(['a-b', 'a-b-2']);
  });

  it('never shadows a real file in the bundle', () => {
    // A stub written at `passport` would hide a real object of that name.
    const out = assignSlugs([draft('Passport.html', 'bundled')], ['passport']);
    expect(out[0].slug).toBe('passport-2');
  });

  it('produces a usable slug even when the name has no alphanumerics', () => {
    const out = assignSlugs([draft('---.html', 'page'), draft('+++.html', 'page')], []);
    for (const p of out) expect(p.slug).toMatch(/^page(-\d+)?$/);
    expect(new Set(out.map((p) => p.slug)).size).toBe(2);
  });
});

describe('extractThumbSvg', () => {
  it('lifts the embedded SVG and repairs the camelCase attribute escape', () => {
    const svg = extractThumbSvg(strToU8(pageWithThumb('#123456')))!;
    expect(svg).toContain('viewBox="0 0 1200 800"');
    expect(svg).not.toContain('sc-camel-view-box');
    // Fixed dimensions are stripped from the root tag so CSS can size the card.
    expect(svg).not.toMatch(/^<svg[^>]*\swidth=/);
    expect(svg).toContain('fill="#123456"');
  });

  it('returns undefined when the page has no thumbnail', () => {
    expect(extractThumbSvg(strToU8('<html><body><h1>hi</h1></body></html>'))).toBeUndefined();
  });

  it.each([
    ['a script tag', '<script>alert(1)</script>'],
    ['an event handler', '<rect onload="alert(1)"></rect>'],
    ['a javascript: url', '<a href="javascript:alert(1)"></a>'],
  ])('refuses SVG containing %s', (_label, payload) => {
    const html =
      '<div id="__bundler_thumbnail"><svg viewBox="0 0 10 10">' + payload + '</svg></div>';
    expect(extractThumbSvg(strToU8(html))).toBeUndefined();
  });

  it('refuses an SVG with no viewBox, which could not scale anyway', () => {
    const html = '<div id="__bundler_thumbnail"><svg><rect/></svg></div>';
    expect(extractThumbSvg(strToU8(html))).toBeUndefined();
  });

  it('ignores a thumbnail buried past the head-scan window', () => {
    // Bundled pages can be ~8 MB of inlined base64; only the head is scanned so
    // the builder never regexes the whole body.
    const html =
      '<html><body>' +
      'x'.repeat(40 * 1024) +
      '<div id="__bundler_thumbnail"><svg viewBox="0 0 1 1"></svg></div></body></html>';
    expect(extractThumbSvg(strToU8(html))).toBeUndefined();
  });
});

describe('findPreview', () => {
  it('types an extension-less .thumbnail from its magic bytes', () => {
    expect(findPreview(['.thumbnail'], { '.thumbnail': WEBP })).toEqual({
      source: '.thumbnail',
      key: '_preview.webp',
      contentType: 'image/webp',
    });
  });

  it('ignores a .thumbnail that is not actually an image', () => {
    expect(findPreview(['.thumbnail'], { '.thumbnail': strToU8('nope') })).toBeNull();
  });

  it('returns null when there is no preview candidate', () => {
    expect(findPreview(['index.html'], { 'index.html': strToU8('x') })).toBeNull();
  });
});

describe('redirectStub', () => {
  const stub = redirectStub('Passport Progress Variations.dc.html', 'Progress');

  it('points at the percent-encoded real path', () => {
    // Relative: served at /<uid>/<slug>, so it resolves against /<uid>/.
    expect(stub).toContain('href="Passport%20Progress%20Variations.dc.html"');
    expect(stub).toContain('content="0; url=Passport%20Progress%20Variations.dc.html"');
  });

  it('uses location.replace so Back skips the stub', () => {
    expect(stub).toContain('location.replace("Passport%20Progress%20Variations.dc.html")');
    expect(stub).not.toContain('location.assign');
  });

  it('works without JavaScript', () => {
    expect(stub).toContain('http-equiv="refresh"');
    expect(stub).toContain('<a href=');
  });

  it('stays small — one extra object per page', () => {
    expect(stub.length).toBeLessThan(600);
  });

  it('cannot be broken out of by a hostile filename', () => {
    const evil = redirectStub('a"><script>alert(1)</script>.html', 'x');
    expect(evil).not.toContain('<script>alert(1)');
    expect(evil).toContain('%3Cscript%3E');
  });
});

describe('recognizers', () => {
  it('detects a Design Composer export from support.js + .dc.html', () => {
    expect(designComposerRecognizer.detect(['support.js', 'Passport.dc.html'])).toBe(true);
  });

  it.each([
    ['support.js without any .dc.html', ['support.js', 'index.html']],
    ['.dc.html without the runtime', ['Passport.dc.html']],
    ['a plain static site', ['index.html', 'about.html', 'style.css']],
  ])('does not claim %s', (_label, paths) => {
    expect(designComposerRecognizer.detect(paths)).toBe(false);
  });

  it('falls through to the generic recognizer for an ordinary multi-page site', () => {
    const g = buildGallery(
      {
        'about.html': strToU8('<h1>about</h1>'),
        'contact.html': strToU8('<h1>contact</h1>'),
      },
      { ...META, title: null, description: null },
    );
    expect(g.recognizerId).toBe('generic');
    expect(g.pages.map((p) => p.group)).toEqual(['Pages', 'Pages']);
    expect(g.pages.every((p) => !p.note)).toBe(true);
  });

  it('the generic recognizer always matches', () => {
    expect(genericRecognizer.detect([])).toBe(true);
  });
});

describe('buildGallery', () => {
  const gallery = buildGallery(exportFixture(), META);

  it('recognizes the export and splits self-contained from source pages', () => {
    expect(gallery.recognizerId).toBe('design-composer');
    const byGroup = new Map<string, string[]>();
    for (const p of gallery.pages) {
      byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p.name]);
    }
    expect(byGroup.get('Self-contained pages')).toEqual([
      'Medworld Passport',
      'Passport Progress Variations',
    ]);
    expect(byGroup.get('Source pages')).toEqual([
      'Credentials Filter Options',
      'Passport Progress Variations',
      'Passport',
    ]);
  });

  it('leads with self-contained pages, the more durable thing to share', () => {
    const html = gallery.indexHtml;
    expect(html.indexOf('Self-contained pages')).toBeLessThan(
      html.indexOf('Source pages'),
    );
  });

  it('flags the network dependency on source pages only', () => {
    for (const page of gallery.pages) {
      if (page.group === 'Source pages') expect(page.note).toMatch(/network/i);
      else expect(page.note).toBeUndefined();
    }
  });

  it('writes one stub per page, none shadowing a real file', () => {
    const real = new Set(Object.keys(exportFixture()));
    expect(Object.keys(gallery.stubs).length).toBe(gallery.pages.length);
    for (const slug of Object.keys(gallery.stubs)) expect(real.has(slug)).toBe(false);
  });

  it('lists non-page files by directory, excluding the pages and the preview', () => {
    const dirs = gallery.others.map((g) => g.dir);
    expect(dirs).toEqual(['_ds', 'screenshots', 'uploads', '']);
    const listed = gallery.others.flatMap((g) => g.files.map((f) => f.path));
    expect(listed).toContain('support.js');
    expect(listed).toContain('_ds/pulse-abc123/readme.md');
    expect(listed).not.toContain('.thumbnail'); // shown as the hero instead
    expect(listed).not.toContain('Passport.dc.html'); // it's a page
  });

  it('inlines extracted thumbnails and falls back for pages without one', () => {
    const withThumb = gallery.pages.filter((p) => p.thumbSvg);
    expect(withThumb.map((p) => p.path).sort()).toEqual([
      'Medworld Passport.html',
      'Passport Progress Variations.dc.html',
      'Passport Progress Variations.html',
    ]);
    // Pages with no embedded SVG get a deterministic letter tile.
    expect(gallery.indexHtml).toContain('class="tile"');
  });

  it('produces self-contained HTML — it cannot link the admin stylesheet', () => {
    expect(gallery.indexHtml).toContain('<style>');
    expect(gallery.indexHtml).not.toContain('/app/styles.css');
    expect(gallery.indexHtml).toContain('prefers-color-scheme:dark');
  });

  it('escapes page names in the rendered output', () => {
    // Zip entry names may legitimately contain angle brackets and quotes; the
    // gallery renders them as text, and the slug drops them entirely.
    const g = buildGallery(
      {
        '<img src=x onerror="alert(1)">.html': strToU8('a'),
        'safe.html': strToU8('b'),
      },
      META,
    );
    expect(g.indexHtml).not.toContain('<img src=x');
    expect(g.indexHtml).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(g.pages.map((p) => p.slug).sort()).toEqual(['img-src-x-onerror-alert-1', 'safe']);
  });

  it('escapes a page name even when the filename contains slashes', () => {
    const g = buildGallery(
      { '</script>.html': strToU8('a'), 'safe.html': strToU8('b') },
      META,
    );
    expect(g.indexHtml).not.toContain('</script>.html');
    expect(g.indexHtml).toContain('script&gt;');
  });

  it('is deterministic — the same bundle renders byte-identical HTML', () => {
    // Nothing may depend on clock or randomness; galleries are cached for a year.
    expect(buildGallery(exportFixture(), META).indexHtml).toBe(gallery.indexHtml);
  });
});

// ---------------------------------------------------------------------------
// The real archive, when a developer has it locally. `private/` is gitignored,
// so this is skipped in CI rather than failing.
// ---------------------------------------------------------------------------

const REAL_ZIP = path.join(__dirname, '..', 'private', 'Medworld passport.zip');
const maybe = fs.existsSync(REAL_ZIP) ? describe : describe.skip;

maybe('the real Medworld passport export', () => {
  const out = processBundle(
    'Medworld passport.zip',
    new Uint8Array(fs.readFileSync(REAL_ZIP)),
    { uid: 'ABCD1234', shareBaseUrl: 'https://mocks.example.com' },
  );

  it('produces a gallery rather than the old hard error', () => {
    expect(out.pages).toHaveLength(8);
    expect(out.preview).toBe('_preview.webp');
  });

  it('assigns the expected slugs, including the real collision', () => {
    expect(out.pages?.map((p) => p.slug).sort()).toEqual([
      'credentials-filter-options',
      'medworld-passport',
      'medworld-passport-standalone',
      'passport',
      'passport-progress-variations',
      'passport-progress-variations-source',
      'passport-standalone',
      'toe-signature-variations',
    ]);
  });

  it('keeps every original file plus the generated objects', () => {
    // 42 archive entries + index.html + 8 stubs + _preview.webp
    expect(Object.keys(out.files)).toHaveLength(52);
    expect(out.files['support.js']).toBeDefined();
    expect(out.files['Passport.dc.html']).toBeDefined();
    expect(out.files['uploads/DX design - Medworld passport - Mocks.jpg']).toBeDefined();
  });
});
