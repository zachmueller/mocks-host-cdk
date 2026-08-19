# mocks-host-cdk

Serverless host for sharing "vibe-coded" mockups (single `.html` files or `.zip`
bundles of html/js/css/assets) via immutable, public share URLs:

```
https://<domain>/<uid>
```

An admin app — gated to a short email allowlist via Google sign-in — handles
upload, list, edit (title/description), and delete. Built to be cheap,
serverless, and low-ops: CloudFront + S3 + a single Lambda + Cognito.

## Architecture

```
                              ┌───────────────────────────────────────────┐
   browser (admin app) ──────▶│ CloudFront (one distribution, OAC)        │
                              │  /                → 302 /login            │
                              │  /login /admin /upload → app/*.html       │
                              │  /app/*           → admin SPA + config    │
                              │  /status/*        → status JSON (~5s TTL) │
                              │  /<UID>           → 301 /<UID>/           │
                              │  /<UID>/          → <UID>/index.html      │
                              │  /<UID>/*         → mock assets (1yr TTL) │
                              └───────────────┬───────────────────────────┘
                                              │ OAC (private)
                                       ┌──────▼────────┐
                                       │ assets bucket │  <uid>/  app/  status/
                                       └──────▲────────┘
   browser ──presigned PUT──▶ staging bucket ─┘ (S3 event, prefix uploads/)
        ▲                          │
        │                          ▼
   HTTP API (Cognito JWT)    ┌──────────────┐    ┌─────────────────┐
   presign/list/edit/delete  │  Lambda      │───▶│ metadata bucket │ metadata.json
        └───────────────────▶│ (handler.ts) │    └─────────────────┘
                             └──────────────┘
```

- **Three S3 buckets** (all block public access):
  - `staging` — presigned `PUT` target; 30-day lifecycle; `OBJECT_CREATED`
    notification (prefix `uploads/`) triggers the processor. A `meta/<uid>.json`
    sidecar (title/description/filename) is written by `presign`.
  - `assets` — private, served only via CloudFront OAC. Holds `<uid>/...`,
    the admin SPA under `app/...`, and `status/<uid>.json`.
  - `metadata` — private, Lambda-only. Holds the `metadata.json` index.
- **One Lambda** (`lib/lambda/handler.ts`, `reservedConcurrentExecutions: 1`)
  dispatches by event shape:
  - **S3 event → processor:** unzip (`fflate`, with the size/count caps and
    OS-cruft filter applied *before* inflation), strip a common top-level dir,
    reject zip-slip, resolve the entrypoint (see below), set `Content-Type` per
    extension (falling back to magic bytes), write under `<uid>/` with bounded
    concurrency, then always write `status/<uid>.json` (and upsert metadata on
    success only).
  - **HTTP API → router:** `presign`, `list`, `edit`, `delete`. Every action
    re-checks the caller's email against `ALLOWED_EMAILS`.
- **Cognito** user pool federated with Google (Hosted UI, PKCE public client).
  A `PreSignUp` trigger blocks any email outside the allowlist.
- **Admin SPA** — vanilla HTML/CSS/JS, no build step, under `admin-app/`.

## Entrypoint resolution & multi-page bundles

```
top-level index.html   → served as-is                      (author's choice wins)
exactly one .html      → promoted to index.html
no .html at all        → error
2+ .html, no index     → a gallery index.html is generated
```

That last case is the shape a design-tool workspace export has: several
independently-viewable pages and no entry page. For it, the processor
(`lib/lambda/gallery.ts`) writes three extra kinds of object under `<uid>/`:

- **`index.html`** — a generated, self-contained landing page listing every HTML
  page in the bundle, with previews, sizes, and a collapsed list of the
  remaining files. Neutral light styling that follows `prefers-color-scheme`.
- **`<slug>`** — one extension-less redirect stub per page (~350 bytes), so
  `Passport Progress Variations.dc.html` is also reachable at
  `/<uid>/passport-progress-variations`.
- **`_preview.webp`** — a copy of a bundle-level preview image (e.g. an
  extension-less `.thumbnail`) at a typed key, used as the gallery hero and as
  `og:image` for link unfurls.

Two constraints shape this, both from how these exports behave at view time:

1. **Original paths are never rewritten.** The runtime resolves sibling pages by
   fetching `./<ComponentName>.dc.html` relative to the current URL, so renaming
   or moving a page silently breaks cross-page references.
2. **Slugs redirect rather than rename or wrap.** The runtime derives its root
   component name from `location.pathname` and needs it to end in `.dc.html`;
   serving the file at a slug path would render a blank page.

A small `Recognizer` in `gallery.ts` adds format-specific labelling (a Design
Composer export distinguishes self-contained `.html` bundles from `.dc.html`
sources that fetch React from a public CDN). Anything it doesn't recognize falls
through to a flat, generic page list.

Because `/<uid>` has no trailing slash, CloudFront **301s it to `/<uid>/`** so
that relative links inside any bundle resolve against `/<uid>/` rather than the
site root. Generated galleries additionally carry `<base href="/<uid>/">`.

## UID format

8-symbol [Crockford base32](https://www.crockford.com/base32.html) (uppercase,
alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, ~1.1T values). A fresh UID is minted
on every upload — share links are immutable and never overwritten.

## Project layout

| Path | Purpose |
|---|---|
| `bin/mocks-host.ts` | CDK app entry |
| `lib/mocks-host-stack.ts` | The single stack (all infra + wiring) |
| `lib/lambda/handler.ts` | Multi-action Lambda (router + S3 processor) |
| `lib/lambda/gallery.ts` | Generated index + slug redirects for multi-page bundles |
| `lib/lambda/media-type.ts` | Content-Type by extension, with a magic-byte fallback |
| `lib/lambda/pre-signup.ts` | Cognito allowlist trigger |
| `lib/cloudfront-functions/*.js` | Viewer-request URL rewriting |
| `admin-app/` | Vanilla static admin SPA |
| `test/` | Stack assertions + handler, gallery and viewer-function unit tests |

## Configuration (CDK context)

Set in `cdk.json` or via `-c key=value` on the CLI:

| Key | Meaning |
|---|---|
| `mocksHost:allowedEmails` | Comma-separated allowlist (e.g. `a@x.com,b@y.com`) |
| `mocksHost:hostedUiPrefix` | Cognito Hosted-UI domain prefix (globally unique) |
| `mocksHost:customDomain` | Future custom domain (added to callback URLs + CORS) |
| `mocksHost:googleClientId` | Google OAuth client id (leave blank to synth without Google) |
| `mocksHost:googleClientSecret` | Google OAuth client secret |

When the Google client id is blank, the stack skips the Google IdP so `synth`
and tests still pass; supply real values before a usable deploy.

## Commands

```bash
npm install
npm run build      # tsc
npm test           # jest (stack assertions + handler unit tests)
npx cdk synth      # synthesize CloudFormation
npx cdk deploy     # deploy to the current AWS account/region (us-east-1)
```

## Post-deploy manual steps

These are intentionally **not** managed by CDK:

1. **Google OAuth:** create an OAuth client in Google Cloud Console; set its
   authorized redirect URI to the Cognito Hosted-UI callback
   (`https://<hostedUiPrefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`);
   re-deploy with `googleClientId`/`googleClientSecret` set.
2. **Allowlisted users:** because Google sign-in JIT-provisions users, no manual
   invite is needed — just ensure each person's email is in `allowedEmails`.
3. **Custom domain (`mocks.jessicaxu.com`):** request an ACM cert in `us-east-1`,
   add the alternate domain name to the CloudFront distribution, and CNAME the
   subdomain to the distribution domain. Callback URLs + CORS already include it.

The canonical share URL produced by the admin UI's copy button is
`https://<domain>/<uid>` (no trailing slash); CloudFront 301s it to
`https://<domain>/<uid>/` so relative links inside the bundle resolve. For a
multi-page bundle, each page also has its own link at
`https://<domain>/<uid>/<slug>`, listed with a copy button in `/admin`.
