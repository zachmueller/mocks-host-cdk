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
  - **S3 event → processor:** unzip (`fflate`), strip a common top-level dir,
    pick the entrypoint (`index.html` at top → else the sole `.html` → else
    error), reject zip-slip, set `Content-Type` per extension, write under
    `<uid>/`, then always write `status/<uid>.json` (and upsert metadata on
    success only).
  - **HTTP API → router:** `presign`, `list`, `edit`, `delete`. Every action
    re-checks the caller's email against `ALLOWED_EMAILS`.
- **Cognito** user pool federated with Google (Hosted UI, PKCE public client).
  A `PreSignUp` trigger blocks any email outside the allowlist.
- **Admin SPA** — vanilla HTML/CSS/JS, no build step, under `admin-app/`.

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
| `lib/lambda/pre-signup.ts` | Cognito allowlist trigger |
| `lib/cloudfront-functions/*.js` | Viewer-request URL rewriting |
| `admin-app/` | Vanilla static admin SPA |
| `test/` | Stack assertions + handler unit tests |

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
`https://<domain>/<uid>` (no trailing slash).
