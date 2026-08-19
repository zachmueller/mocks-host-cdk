/**
 * Tests for the default-behavior CloudFront viewer-request function.
 *
 * The source is plain ES5 for the CloudFront Functions runtime and has no module
 * exports, so it is read and evaluated here the same way the runtime loads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'cloudfront-functions', 'clean-url.js'),
  'utf-8',
);

type Result = {
  uri?: string;
  statusCode?: number;
  headers?: Record<string, { value: string }>;
  querystring?: Record<string, { value: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const handler: (event: any) => Result = new Function(
  `${SRC}; return handler;`,
)() as any;

const req = (uri: string, querystring: Record<string, { value: string }> = {}) =>
  handler({ request: { uri, querystring } });

describe('clean-url viewer-request function', () => {
  it('sends the site root to the admin login page', () => {
    const res = req('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location.value).toBe('/login');
  });

  it('uppercases a lowercase UID so share links reach the canonical S3 keys', () => {
    expect(req('/abcd1234/support.js').uri).toBe('/ABCD1234/support.js');
  });

  describe('canonical share URL', () => {
    // Serving index.html for /<uid> by internal rewrite would leave the browser
    // at /<uid>, where relative links resolve against the site root. Redirecting
    // to the directory form first is what makes a multi-page bundle work.
    it('redirects /<uid> to /<uid>/', () => {
      const res = req('/ABCD1234');
      expect(res.statusCode).toBe(301);
      expect(res.headers!.location.value).toBe('/ABCD1234/');
    });

    it('uppercases the UID while redirecting', () => {
      expect(req('/abcd1234').headers!.location.value).toBe('/ABCD1234/');
    });

    it('preserves the query string across the redirect', () => {
      const res = req('/ABCD1234', { v: { value: '2' }, debug: { value: '' } });
      expect(res.headers!.location.value).toMatch(/^\/ABCD1234\/\?/);
      expect(res.headers!.location.value).toContain('v=2');
      expect(res.headers!.location.value).toContain('debug');
    });

    it('serves index.html for the directory form', () => {
      expect(req('/ABCD1234/').uri).toBe('/ABCD1234/index.html');
    });
  });

  describe('bundle contents', () => {
    it('passes concrete assets straight through', () => {
      expect(req('/ABCD1234/_ds/pulse/tokens/fonts.css').uri).toBe(
        '/ABCD1234/_ds/pulse/tokens/fonts.css',
      );
    });

    it('passes a page with a double extension through', () => {
      expect(req('/ABCD1234/Passport.dc.html').uri).toBe('/ABCD1234/Passport.dc.html');
    });

    it('passes an extension-less slug stub through to the origin object', () => {
      // Generated slug redirects are real S3 objects at /<uid>/<slug>; they must
      // not be rewritten or lowercased.
      expect(req('/ABCD1234/passport-progress-variations').uri).toBe(
        '/ABCD1234/passport-progress-variations',
      );
    });

    it('leaves the extension-less workspace preview alone', () => {
      expect(req('/ABCD1234/.thumbnail').uri).toBe('/ABCD1234/.thumbnail');
    });

    it('passes a deeper extension-less path through', () => {
      expect(req('/ABCD1234/some/deep/path').uri).toBe('/ABCD1234/some/deep/path');
    });
  });
});
