/**
 * Gallery builder for multi-page zip bundles.
 *
 * A design-tool export is not a website: it has no `index.html`, several
 * independently-viewable HTML pages, and a pile of working files nothing links
 * to. When the processor's entrypoint cascade finds 2+ HTML files and no
 * `index.html`, this module synthesizes the missing landing page — a gallery of
 * every page in the bundle, plus clean per-page URLs.
 *
 * Everything here is pure: `buildGallery` takes the unzipped file map and
 * returns the objects to write. No AWS, no I/O, so it unit-tests directly.
 *
 * Two invariants come from how these exports behave at view time, and both are
 * load-bearing:
 *
 *  1. **Real files keep their exact original paths.** Design Composer's runtime
 *     resolves sibling pages by fetching `./<ComponentName>.dc.html` relative to
 *     the current URL, so renaming or relocating a page silently breaks every
 *     cross-page reference (it renders as an empty placeholder).
 *  2. **Pretty URLs are redirects, never renames or iframes.** That same runtime
 *     derives the root component name from `location.pathname` and requires it to
 *     end in `.dc.html`. Serving `Passport.dc.html` at `/<uid>/passport` yields
 *     the wrong root name and a blank page. So a slug is a tiny redirect stub
 *     that lands the browser on the real path.
 */
import { contentTypeForEntry, formatBytes } from './media-type';

/** How much of each HTML file to scan for an embedded thumbnail. */
const HEAD_SCAN_BYTES = 32 * 1024;
/** Refuse to inline an extracted SVG larger than this. */
const MAX_THUMB_SVG_BYTES = 16 * 1024;
/** Cap the per-directory file list rendered in the "Other files" section. */
const MAX_LISTED_PER_GROUP = 200;
const MAX_SLUG_LENGTH = 60;

const PAGE_EXT = /\.html?$/i;
const DC_PAGE_EXT = /\.dc\.html?$/i;

export type PageKind = 'bundled' | 'source' | 'page';

export interface PageEntry {
  /** Real key under `<uid>/`, e.g. `Passport.dc.html`. Never rewritten. */
  path: string;
  /** Clean single-segment alias, e.g. `passport`. A redirect stub lives here. */
  slug: string;
  /** Display name, from the filename (`<title>` is unreliable in exports). */
  name: string;
  kind: PageKind;
  /** Section heading in the gallery. */
  group: string;
  /** Short caveat shown on the card, e.g. the network dependency. */
  note?: string;
  bytes: number;
  /** Inline SVG preview lifted out of the page, when it has one. */
  thumbSvg?: string;
}

export interface OtherEntry {
  path: string;
  bytes: number;
}

export interface OtherGroup {
  /** Top-level directory, or `''` for files at the bundle root. */
  dir: string;
  label: string;
  bytes: number;
  files: OtherEntry[];
}

export interface Recognizer {
  id: string;
  /** Does this recognizer understand the bundle's shape? */
  detect(paths: string[]): boolean;
  /** Section order in the gallery. Groups not listed here render last. */
  groups: string[];
  /** Turn HTML paths into page drafts (slugs are assigned later). */
  classify(htmlPaths: string[], files: Record<string, Uint8Array>): PageDraft[];
}

export type PageDraft = Omit<PageEntry, 'slug' | 'thumbSvg'>;

export interface GalleryMeta {
  uid: string;
  title: string | null;
  description: string | null;
  originalFilename: string;
  /** Absolute origin, e.g. `https://mocks.example.com`. `''` skips `og:image`. */
  shareBaseUrl: string;
}

export interface Gallery {
  pages: PageEntry[];
  others: OtherGroup[];
  /** Slug key -> redirect stub HTML. Written as `<uid>/<slug>`. */
  stubs: Record<string, string>;
  indexHtml: string;
  /** Path of the file the hero image came from, if any. */
  previewSource: string | null;
  /** Key the hero image is copied to, e.g. `_preview.webp`. */
  previewKey: string | null;
  /** Which recognizer shaped the gallery (for logging/tests). */
  recognizerId: string;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Percent-encode each path segment, leaving the separators intact. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Drop a trailing `.dc.html`, `.html` or `.htm`. */
export function stripPageExt(path: string): string {
  return path.replace(DC_PAGE_EXT, '').replace(PAGE_EXT, '');
}

/** Filename without directories or page extension. */
export function pageNameFor(path: string): string {
  const base = path.split('/').pop() ?? path;
  return stripPageExt(base) || base;
}

/** Lowercase, hyphenated, single path segment. Lossy by design. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining marks left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/**
 * Lift the inline SVG preview out of an export's page.
 *
 * Only the first 32 KB is scanned — the thumbnail sits at the top of `<body>`,
 * and some bundled pages are 7.6 MB of inlined base64 that must never be
 * regexed. The result is inlined into the gallery, so this is a sanitization
 * boundary: anything with a script, an event handler or a `javascript:` URL is
 * rejected outright rather than cleaned.
 */
export function extractThumbSvg(data: Uint8Array): string | undefined {
  if (!data || data.length === 0) return undefined;
  const head = Buffer.from(data.subarray(0, HEAD_SCAN_BYTES)).toString('utf-8');

  const anchor = head.indexOf('__bundler_thumbnail');
  if (anchor === -1) return undefined;
  const start = head.indexOf('<svg', anchor);
  if (start === -1) return undefined;
  const end = head.indexOf('</svg>', start);
  if (end === -1) return undefined;

  let svg = head.slice(start, end + '</svg>'.length);
  if (Buffer.byteLength(svg, 'utf-8') > MAX_THUMB_SVG_BYTES) return undefined;
  if (/<script|<foreignObject|javascript:|\son[a-z]+\s*=/i.test(svg)) return undefined;

  // Design Composer emits camelCase SVG attributes in a `sc-camel-*` escape
  // hatch (`sc-camel-view-box` -> `viewBox`). Without a real viewBox the SVG
  // won't scale to the card.
  svg = svg.replace(/\bsc-camel-([a-z-]+)=/gi, (_m, attr: string) =>
    `${attr.replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase())}=`,
  );

  // Let CSS size the card: strip fixed dimensions from the root tag only.
  const openEnd = svg.indexOf('>');
  if (openEnd !== -1) {
    const open = svg.slice(0, openEnd).replace(/\s(?:width|height)="[^"]*"/gi, '');
    svg = open + svg.slice(openEnd);
  }
  if (!/\sviewBox="/.test(svg)) return undefined; // unscalable, not worth showing
  return svg;
}

/**
 * A ~350-byte HTML redirect from a slug to the page's real path.
 *
 * `location.replace` (not `assign`) so the Back button skips the stub. The
 * `<meta refresh>` and the `<a>` cover script-disabled viewers. Relative href:
 * the stub is served at `/<uid>/<slug>`, so the browser resolves it against
 * `/<uid>/` and lands on `/<uid>/<real path>`.
 */
export function redirectStub(targetPath: string, name: string): string {
  const href = encodePath(targetPath);
  const attr = escapeHtml(href);
  const label = escapeHtml(name);
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${label}</title>` +
    '<meta name="robots" content="noindex">' +
    `<link rel="canonical" href="${attr}">` +
    `<meta http-equiv="refresh" content="0; url=${attr}">` +
    `<script>location.replace(${JSON.stringify(href)})</script>` +
    `</head><body><p><a href="${attr}">${label}</a></p></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Recognizers — first match wins
// ---------------------------------------------------------------------------

const DC_NOTE = 'Loads its runtime from the network';
const GROUP_BUNDLED = 'Self-contained pages';
const GROUP_SOURCE = 'Source pages';
const GROUP_PAGES = 'Pages';

/**
 * Design Composer workspace export: `.dc.html` sources next to a `support.js`
 * runtime. The distinction is worth surfacing — a plain `.html` here is a fully
 * self-contained bundle that will render forever, while a `.dc.html` fetches
 * React and Babel from a public CDN every time someone opens it. Self-contained
 * pages lead, being the more durable thing to hand someone.
 */
export const designComposerRecognizer: Recognizer = {
  id: 'design-composer',
  groups: [GROUP_BUNDLED, GROUP_SOURCE],
  detect: (paths) =>
    paths.some((p) => p === 'support.js' || p.endsWith('/support.js')) &&
    paths.some((p) => DC_PAGE_EXT.test(p)),
  classify: (htmlPaths, files) =>
    htmlPaths.map((path) => {
      const source = DC_PAGE_EXT.test(path);
      return {
        path,
        name: pageNameFor(path),
        kind: source ? ('source' as const) : ('bundled' as const),
        group: source ? GROUP_SOURCE : GROUP_BUNDLED,
        note: source ? DC_NOTE : undefined,
        bytes: files[path]?.length ?? 0,
      };
    }),
};

/** Fallback: every HTML file is just a page. */
export const genericRecognizer: Recognizer = {
  id: 'generic',
  groups: [GROUP_PAGES],
  detect: () => true,
  classify: (htmlPaths, files) =>
    htmlPaths.map((path) => ({
      path,
      name: pageNameFor(path),
      kind: 'page' as const,
      group: GROUP_PAGES,
      bytes: files[path]?.length ?? 0,
    })),
};

export const RECOGNIZERS: Recognizer[] = [designComposerRecognizer, genericRecognizer];

// ---------------------------------------------------------------------------
// Slug assignment
// ---------------------------------------------------------------------------

/** Self-contained pages claim the bare slug ahead of their source siblings. */
const slugRank = (kind: PageKind): number => (kind === 'source' ? 1 : 0);

/**
 * Give every page a unique, collision-free slug.
 *
 * `slugify` is lossy, so collisions are real: a Design Composer export commonly
 * ships `Foo.html` and `Foo.dc.html` side by side, and both slug to `foo`. The
 * self-contained page wins the clean slug, the source sibling takes `-source`,
 * and anything still colliding falls back to `-2`, `-3`.
 *
 * `reserved` must contain every real file path so a stub can never shadow a
 * file the bundle actually needs.
 */
export function assignSlugs(drafts: PageDraft[], reserved: Iterable<string>): PageEntry[] {
  const used = new Set(reserved);
  const byBase = new Map<string, PageDraft[]>();

  for (const draft of drafts) {
    const base = slugify(stripPageExt(draft.path)) || 'page';
    const bucket = byBase.get(base);
    if (bucket) bucket.push(draft);
    else byBase.set(base, [draft]);
  }

  const out = new Map<PageDraft, string>();
  for (const [base, bucket] of byBase) {
    bucket.sort(
      (a, b) => slugRank(a.kind) - slugRank(b.kind) || a.path.localeCompare(b.path),
    );
    bucket.forEach((draft, i) => {
      const candidate = i === 0 ? base : draft.kind === 'source' ? `${base}-source` : base;
      let slug = candidate;
      let n = 1;
      while (used.has(slug)) slug = `${candidate}-${++n}`;
      used.add(slug);
      out.set(draft, slug);
    });
  }

  // Preserve the caller's page order; only the slug is decided above.
  return drafts.map((draft) => ({ ...draft, slug: out.get(draft)! }));
}

// ---------------------------------------------------------------------------
// Preview image
// ---------------------------------------------------------------------------

const PREVIEW_EXT: Record<string, string> = {
  'image/webp': '.webp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

/**
 * Find a bundle-level preview image. Design Composer ships an extension-less
 * `.thumbnail` (really a WebP), which is why the type comes from magic bytes
 * rather than the filename.
 */
export function findPreview(
  paths: string[],
  files: Record<string, Uint8Array>,
): { source: string; key: string; contentType: string } | null {
  const candidates = paths.filter((p) =>
    /^(?:\.thumbnail|thumbnail(?:\.[a-z0-9]+)?|preview(?:\.[a-z0-9]+)?)$/i.test(p),
  );
  for (const source of candidates.sort()) {
    const contentType = contentTypeForEntry(source, files[source]);
    const ext = PREVIEW_EXT[contentType];
    if (ext) return { source, key: `_preview${ext}`, contentType };
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Other files" grouping
// ---------------------------------------------------------------------------

function groupOthers(
  paths: string[],
  files: Record<string, Uint8Array>,
  exclude: Set<string>,
): OtherGroup[] {
  const groups = new Map<string, OtherGroup>();
  for (const path of paths) {
    if (exclude.has(path)) continue;
    const slash = path.indexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    let group = groups.get(dir);
    if (!group) {
      group = { dir, label: dir || 'Bundle root', bytes: 0, files: [] };
      groups.set(dir, group);
    }
    const bytes = files[path]?.length ?? 0;
    group.bytes += bytes;
    group.files.push({ path, bytes });
  }
  for (const group of groups.values()) {
    group.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  // Named directories first (alphabetical), loose root files last.
  return [...groups.values()].sort((a, b) => {
    if (!a.dir !== !b.dir) return a.dir ? -1 : 1;
    return a.dir.localeCompare(b.dir);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const GALLERY_CSS = `
*{box-sizing:border-box}
:root{
  --bg:#fbfbf9;--panel:#fff;--border:#e6e4df;--text:#1b1a18;--muted:#6d6b66;
  --accent:#2b56cc;--pill:#f0efeb;--shadow:0 1px 2px rgba(0,0,0,.05),0 6px 16px rgba(0,0,0,.04);
  --radius:12px;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#131417;--panel:#1b1d21;--border:#2b2e35;--text:#e9e8e6;--muted:#9a9b9f;
  --accent:#84a6ff;--pill:#24272d;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 16px rgba(0,0,0,.25);
}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.5}
main{max-width:1000px;margin:0 auto;padding:48px 24px 96px}
a{color:inherit}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
h1{font-size:30px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px;font-weight:650}
.desc{color:var(--muted);margin:0;max-width:62ch}
.facts{color:var(--muted);font-size:13px;margin:14px 0 0}
/* Bundle previews are screenshots of unpredictable aspect ratio. Anchor to the
   top so the crop keeps the recognizable part, and stay short enough that the
   page cards are still visible without scrolling. */
.hero{display:block;width:100%;height:200px;object-fit:cover;object-position:center top;
  border:1px solid var(--border);border-radius:var(--radius);margin:28px 0 0;background:var(--pill)}
section{margin-top:44px}
h2{font-size:14px;font-weight:650;letter-spacing:.01em;margin:0;display:flex;align-items:baseline;gap:10px}
h2 .count{color:var(--muted);font-weight:400}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0;max-width:62ch}
.grid{list-style:none;padding:0;margin:18px 0 0;display:grid;gap:18px;
  grid-template-columns:repeat(auto-fill,minmax(212px,1fr))}
.grid a{display:block;text-decoration:none;background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);
  transition:transform .12s ease,border-color .12s ease}
.grid a:hover{transform:translateY(-2px);border-color:var(--accent)}
.grid a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.thumb{display:block;aspect-ratio:16/10;background:var(--pill);border-bottom:1px solid var(--border)}
.thumb svg{display:block;width:100%;height:100%}
.tile{display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:600;
  color:#fff;height:100%;letter-spacing:-.02em}
.card-body{padding:12px 14px 14px}
.name{display:block;font-weight:600;font-size:14px;line-height:1.35;word-break:break-word}
.meta{display:block;color:var(--muted);font-size:12px;margin-top:5px}
.pill{display:inline-block;margin-top:8px;font-size:11px;color:var(--muted);background:var(--pill);
  border-radius:999px;padding:2px 8px}
details{margin-top:44px;border-top:1px solid var(--border);padding-top:18px}
summary{cursor:pointer;font-size:14px;font-weight:650}
summary::marker{color:var(--muted)}
.dir{margin:20px 0 0}
.dir h3{font-family:var(--mono);font-size:12px;font-weight:600;margin:0 0 8px;color:var(--muted)}
.files{list-style:none;padding:0;margin:0;display:grid;gap:2px;
  grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.files a{font-family:var(--mono);font-size:12px;color:var(--accent);text-decoration:none;
  display:block;padding:3px 0;word-break:break-all}
.files a:hover{text-decoration:underline}
.files .size{color:var(--muted)}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--border);
  color:var(--muted);font-size:12px}
footer .mono{font-family:var(--mono)}
`.trim();

/** Deterministic hue from a name, so fallback tiles are stable across rebuilds. */
function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function thumbMarkup(page: PageEntry): string {
  if (page.thumbSvg) return `<span class="thumb">${page.thumbSvg}</span>`;
  const letter = escapeHtml((page.name.trim()[0] ?? '?').toUpperCase());
  const hue = hueFor(page.name);
  return (
    `<span class="thumb"><span class="tile" aria-hidden="true" ` +
    `style="background:linear-gradient(140deg,hsl(${hue} 46% 52%),hsl(${(hue + 28) % 360} 46% 42%))"` +
    `>${letter}</span></span>`
  );
}

function cardMarkup(page: PageEntry): string {
  return (
    `<li><a href="${escapeHtml(page.slug)}">` +
    thumbMarkup(page) +
    '<span class="card-body">' +
    `<span class="name">${escapeHtml(page.name)}</span>` +
    `<span class="meta">${escapeHtml(formatBytes(page.bytes))}</span>` +
    (page.note ? `<span class="pill">${escapeHtml(page.note)}</span>` : '') +
    '</span></a></li>'
  );
}

function sectionMarkup(group: string, pages: PageEntry[], hint: string | null): string {
  return (
    '<section>' +
    `<h2>${escapeHtml(group)} <span class="count">${pages.length}</span></h2>` +
    (hint ? `<p class="hint">${escapeHtml(hint)}</p>` : '') +
    `<ul class="grid">${pages.map(cardMarkup).join('')}</ul>` +
    '</section>'
  );
}

const GROUP_HINTS: Record<string, string> = {
  [GROUP_BUNDLED]:
    'Everything is inlined in the file — these keep working with no network access.',
  [GROUP_SOURCE]:
    'Rendered live in the browser. They fetch their component runtime from a public CDN, ' +
    'so they need an internet connection and can break if that CDN changes.',
};

function othersMarkup(others: OtherGroup[]): string {
  if (!others.length) return '';
  const count = others.reduce((n, g) => n + g.files.length, 0);
  const bytes = others.reduce((n, g) => n + g.bytes, 0);
  const dirs = others
    .map((group) => {
      const shown = group.files.slice(0, MAX_LISTED_PER_GROUP);
      const hidden = group.files.length - shown.length;
      // The directory is already the heading; show each file relative to it so
      // rows don't repeat a long prefix (these bundles nest under a UUID dir).
      const trim = group.dir ? group.dir.length + 1 : 0;
      const items = shown
        .map(
          (f) =>
            `<li><a href="${escapeHtml(encodePath(f.path))}">` +
            `${escapeHtml(f.path.slice(trim))}` +
            ` <span class="size">${escapeHtml(formatBytes(f.bytes))}</span></a></li>`,
        )
        .join('');
      return (
        '<div class="dir">' +
        `<h3>${escapeHtml(group.label)} — ${group.files.length} file` +
        `${group.files.length === 1 ? '' : 's'}, ${escapeHtml(formatBytes(group.bytes))}</h3>` +
        `<ul class="files">${items}</ul>` +
        (hidden > 0 ? `<p class="hint">+ ${hidden} more not listed</p>` : '') +
        '</div>'
      );
    })
    .join('');
  return (
    '<details><summary>Other files ' +
    `(${count}, ${escapeHtml(formatBytes(bytes))})</summary>${dirs}</details>`
  );
}

function renderGallery(
  pages: PageEntry[],
  others: OtherGroup[],
  meta: GalleryMeta,
  previewKey: string | null,
  totals: { files: number; bytes: number },
  groupOrder: string[],
): string {
  const heading = meta.title?.trim() || stripPageExt(meta.originalFilename) || meta.uid;
  const pageWord = pages.length === 1 ? 'page' : 'pages';
  const summary = `${pages.length} ${pageWord} in this bundle`;
  const ogImage =
    previewKey && meta.shareBaseUrl
      ? `${meta.shareBaseUrl.replace(/\/+$/, '')}/${meta.uid}/${previewKey}`
      : null;

  // Sections follow the recognizer's declared order; anything it didn't declare
  // falls in behind, in first-appearance order.
  const present = pages.map((p) => p.group);
  const groups = [
    ...groupOrder.filter((g) => present.includes(g)),
    ...present.filter((g) => !groupOrder.includes(g)),
  ].filter((g, i, all) => all.indexOf(g) === i);

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // The canonical share URL has no trailing slash (`/<uid>`), and CloudFront
    // serves index.html for it by internal rewrite — the browser's URL is
    // unchanged, so a relative href would resolve against `/` instead of
    // `/<uid>/`. Anchoring every relative link here makes the page correct
    // whichever form of the URL someone opens.
    meta.uid ? `<base href="/${encodeURIComponent(meta.uid)}/">` : '',
    `<title>${escapeHtml(heading)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description || summary)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escapeHtml(heading)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description || summary)}">`,
    ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : '',
    ogImage
      ? '<meta name="twitter:card" content="summary_large_image">'
      : '<meta name="twitter:card" content="summary">',
    `<style>${GALLERY_CSS}</style>`,
  ]
    .filter(Boolean)
    .join('');

  const body = [
    '<main>',
    `<p class="eyebrow">Shared mockup</p>`,
    `<h1>${escapeHtml(heading)}</h1>`,
    meta.description ? `<p class="desc">${escapeHtml(meta.description)}</p>` : '',
    `<p class="facts">${escapeHtml(summary)} · ${totals.files} files · ` +
      `${escapeHtml(formatBytes(totals.bytes))}</p>`,
    previewKey ? `<img class="hero" src="${escapeHtml(previewKey)}" alt="">` : '',
    ...groups.map((group) =>
      sectionMarkup(
        group,
        pages.filter((p) => p.group === group),
        GROUP_HINTS[group] ?? null,
      ),
    ),
    othersMarkup(others),
    '<footer>Uploaded from <span class="mono">' +
      `${escapeHtml(meta.originalFilename)}</span>. ` +
      'This index was generated because the bundle has no <span class="mono">index.html</span>.' +
      '</footer>',
    '</main>',
  ]
    .filter(Boolean)
    .join('');

  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the generated landing page and slug redirects for a multi-page bundle.
 * The caller writes `indexHtml` at `<uid>/index.html`, each `stubs` entry at
 * `<uid>/<slug>`, and copies `previewSource` to `<uid>/<previewKey>`.
 */
export function buildGallery(
  files: Record<string, Uint8Array>,
  meta: GalleryMeta,
): Gallery {
  const paths = Object.keys(files).sort((a, b) => a.localeCompare(b));
  const htmlPaths = paths.filter((p) => PAGE_EXT.test(p));

  const recognizer = RECOGNIZERS.find((r) => r.detect(paths)) ?? genericRecognizer;
  const drafts = recognizer.classify(htmlPaths, files);

  const preview = findPreview(paths, files);

  // Reserve every real path so a slug stub can never shadow a file the bundle
  // needs, plus the two keys the processor writes itself.
  const reserved = new Set(paths);
  reserved.add('index.html');
  if (preview) reserved.add(preview.key);

  const pages = assignSlugs(drafts, reserved).map((page) => ({
    ...page,
    thumbSvg: extractThumbSvg(files[page.path]),
  }));

  const excluded = new Set(pages.map((p) => p.path));
  if (preview) excluded.add(preview.source);
  const others = groupOthers(paths, files, excluded);

  const stubs: Record<string, string> = {};
  for (const page of pages) stubs[page.slug] = redirectStub(page.path, page.name);

  const totals = {
    files: paths.length,
    bytes: paths.reduce((n, p) => n + (files[p]?.length ?? 0), 0),
  };

  return {
    pages,
    others,
    stubs,
    indexHtml: renderGallery(
      pages,
      others,
      meta,
      preview?.key ?? null,
      totals,
      recognizer.groups,
    ),
    previewSource: preview?.source ?? null,
    previewKey: preview?.key ?? null,
    recognizerId: recognizer.id,
  };
}
