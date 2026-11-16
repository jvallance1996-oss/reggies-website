# Reggie's website and quote enquiries

The rebuilt site gives lawn mowing, rubbish removal and acreage mowing/slashing equal prominence. It preserves every existing service and locality URL, adds `/acreage-mowing-slashing/` and `/service-areas/`, improves gardening content, and uses one consistent enquiry form throughout. Original branding, work photos, search verification and the scheduled Google review refresh are retained.

## DigitalOcean launch

This change includes a backend. A static-site-only component cannot process `/api/quotes`; do not launch the new form by publishing only the HTML files.

1. Use the existing GitHub repository and a Node.js **Web Service** on DigitalOcean. Build with `pnpm build`, run with `pnpm start`, and expose port `8080`. The root directory remains the website's public source; no URL migration is needed.
2. Set `NODE_ENV=production`, `PORT=8080`, `HOST=0.0.0.0`, `PUBLIC_DIR=.`, and `PUBLIC_ORIGIN=https://reggies.com.au` in the service environment.
3. Supply `DATABASE_URL` for a backed-up PostgreSQL database and its provider CA if needed. Choose the Microsoft 365 option in [MAIL-SETUP.md](MAIL-SETUP.md), or configure the existing SMTP option. Set `QUOTE_TO=jack@reggies.com.au`. Store credentials directly in DigitalOcean's secret environment settings; never commit them or paste them into a pull request.
4. Redirect alternate hostnames to the canonical HTTPS domain. Set `TRUST_PROXY_HOPS` only after confirming the actual trusted edge chain. Set a strong `ADMIN_PASSWORD` for the private enquiry inbox; this is required with Microsoft Graph because notifications link to the original photos there.
5. Run the PostgreSQL integration against a disposable test database. Confirm `/healthz`, complete one clearly labelled end-to-end test through the deployed form, verify its stored photos and actual inbox receipt, then enable the production release. An email accepted by the test transport is not evidence of inbox delivery.
6. Check the homepage, all three services, two local landing pages and the sitemap on the final host. Keep the prior working deployment available for rollback, and monitor both enquiry errors and notifications.

For the separate DigitalOcean static component, select the Node.js environment, build with `pnpm build:static`, and set its output directory to `dist`. That build contains only public pages, frontend files and assets. Route `/api` and `/admin` to the web service with the full path prefix preserved; route `/` to the static component. Backend source, tests, environment examples and setup documents are excluded from the static output.

Hosting and mail credentials belong in the deployment environment, not this source repository. The production handler fails closed when required configuration is absent; it does not pretend to receive a lead.

`pnpm test` runs the backend suite and checks every sitemap page, internal link, asset, fragment, canonical, shared form and original URL. The GitHub pull-request workflow also runs against an isolated PostgreSQL 17 service. Local development uses SQLite and can be tested without sending real email.

## Backend

Portable Node.js 24 HTTP server for the existing static website. Keep the existing pages and assets in the repository root; put `server.mjs`, `store.mjs`, `validation.mjs`, `microsoft-graph.mjs`, `package.json` and this environment example alongside them. This server replaces a static-only launch command. It is not a serverless function and must run continuously so the notification worker can retry failed alerts.

## Run locally

```sh
pnpm install --frozen-lockfile
cp .env.example .env
node --env-file=.env server.mjs
```

Open `http://localhost:8080`. The `.env` file is loaded only when passed with `--env-file`; the production `pnpm start` command reads the environment supplied by the host. A development request is retained in `data/quotes.sqlite` even when email is unset. Notifications remain pending until the selected mail provider is configured. Do not mistake this development mode for an operational production deployment.

`PUBLIC_DIR` defaults to the current directory. An allowlist serves route `index.html` pages, `styles.css`, `script.js`, `quote-form.js`, `robots.txt`, `sitemap.xml`, `google-reviews.json` and safe assets under `/assets/`. Extra root frontend scripts can be listed in `PUBLIC_JS_FILES`. The server rejects source files, package/config files, dotfiles, scripts, tests, database paths, extensionless regular files and symlinks escaping the public root.

## Production configuration

Use Node 24 and run `pnpm start` with `NODE_ENV=production`. Configure an external managed PostgreSQL database with backups and `DATABASE_URL`; local SQLite is never a production fallback. Choose `MAIL_PROVIDER=microsoft-graph` with its app settings and private inbox password, or `MAIL_PROVIDER=smtp` with the six SMTP/recipient settings. Both need a single canonical HTTPS `PUBLIC_ORIGIN`, for example `https://reggies.com.au`. Missing required settings cause `/api/quotes` and `/healthz` to return 503; the server will not claim to save enquiries to an ephemeral local file. See [MAIL-SETUP.md](MAIL-SETUP.md).

Production PostgreSQL uses TLS with certificate verification. If the provider requires its own CA, supply its PEM certificate in `DATABASE_CA_CERT`. The explicit TLS policy takes precedence over connection-string SSL parameters, which are removed before connecting. Do not disable certificate validation. Test the actual provider connection before launch.

Use the platform's HTTPS edge and redirect every noncanonical hostname to `PUBLIC_ORIGIN` before serving the website. In particular, if the canonical origin is `https://reggies.com.au`, redirect `https://www.reggies.com.au` to it. Requests from a different origin are deliberately rejected. Set `TRUST_PROXY_HOPS` to the real number of trusted proxy hops for per-client rate limiting; leave it at 0 when connecting directly. Only trust a proxy that handles forwarded client addresses correctly.

`GET /healthz` checks required configuration and database availability. It does not prove inbox delivery. Verify an explicitly authorised test enquiry through the actual deployment and confirm that its notification is accepted and arrives in the operator inbox before launch. This test suite never sends real email.

## API contract

`POST /api/quotes` requires `Content-Type: application/json` and an `Origin` matching the site's origin. The maximum JSON body is 20 MiB, with no more than two simultaneous body-processing requests per server process. The default limiter permits 20 posts per client address per hour and 500 globally per process per hour. Deploy one application instance initially; a shared edge limiter is needed if scaling to multiple instances.

```json
{
  "requestId": "UUID generated once for this submission",
  "name": "Customer name",
  "suburb": "Eynesbury",
  "service": "lawn-mowing",
  "contactPreference": "sms",
  "phone": "Australian mobile number",
  "email": "",
  "details": "Optional description",
  "timing": "Optional preferred timing",
  "jobType": "Optional regular/one-off/etc.",
  "photos": [],
  "website": ""
}
```

Allowed services: `lawn-mowing`, `rubbish-removal`, `acreage-mowing-slashing`, `gardening`, `pressure-washing`. Reply preference is `sms`, `email` or `call`. The chosen contact method must be valid; SMS requires an Australian mobile. Optional provided contact details are also validated. `details` supports up to 4,000 characters. Unknown fields, invalid UUIDs and a filled honeypot (`website`) are rejected.

Each optional photo is `{ "name": "original filename", "type": "image/jpeg", "data": "raw base64" }`. Send the base64 part only, without a `data:` prefix. Up to four JPEG, PNG or WebP images are accepted, each at most 3 MiB decoded. Both MIME and binary signature are checked; filenames are replaced with safe generated names. Photo bytes stay in the same durable database transaction as the enquiry, not in a public directory or temporary app filesystem.

A new successful request returns HTTP 201 and `{ "ok": true, "reference": "REG-..." }`. A retry with the same request ID and identical normalised details returns HTTP 200 with the same receipt. Reusing the ID with different details returns 409. Keep the request ID unchanged after a network failure so retrying cannot create another lead. Generate a new ID only for a new enquiry. The response is sent only after the quote and photos have committed to storage.

Failures return `{ "ok": false, "error": "Message", "fields": {} }`, with `fields` included for validation errors. Typical statuses are 400 malformed JSON, 403 wrong origin, 413 body too large, 415 wrong content type, 422 invalid fields, 429 rate limit and 503 unavailable/storage failure. The frontend must retain entered details, show errors and offer retry or text/call when unsuccessful; it must not show confirmation simply because the button was clicked.

## Notification delivery and private inbox

The database stores notification state and each attempt. The worker runs every 30 seconds and after a new request. It claims a request immediately before sending, using row leases so another replica does not normally send the same pending request. Failure retries use bounded exponential intervals from 30 seconds up to 30 minutes, with eight attempts maximum. A provider `Retry-After` can extend the delay, capped at 24 hours. Exhausted attempts stay marked `failed`; the enquiry and photos remain available. Monitor the `quote_notification_retry`, `quote_notification_exhausted` and worker-error operational events, plus the private inbox, to investigate delivery problems. Logs never include customer fields, IP addresses, provider replies or credentials.

Alerts are at-least-once: a crash after provider acceptance but before recording success may produce a duplicate alert when a lease expires. Alerts retain the same quote reference; SMTP also reuses its message ID, while Graph uses a custom reference header. A successful form response means the enquiry was retained; it does not claim an email has reached an inbox. Graph's 202 response records provider acceptance, not final delivery.

Set your own `ADMIN_PASSWORD` to enable the read-only `/admin/quotes` inbox; the username is `jack`. This is required in Graph mode, where email includes authenticated photo links and originals stay in the database. SMTP continues to attach the photos directly. The private inbox shows the latest 100 enquiries, contact preference, notification state and protected photo links. No password is generated or included in source. With the setting empty, the route returns 404. Serve it over the host's HTTPS edge. It sets `no-store` and `noindex`, escapes all customer text, and applies an authentication attempt limit. Do not put database backups or exports under the public website paths.

## Tests

```sh
pnpm test
# Optional: point only at a dedicated disposable test database, never production.
TEST_DATABASE_URL='postgresql://…' pnpm test
```

The suite uses temporary SQLite files, localhost servers, synthetic enquiries, injected fake SMTP and mocked Microsoft HTTPS requests. It covers persistence after reopening the database, stored photo bytes, idempotence/conflicts, malformed and unsafe inputs, photo restrictions, origin enforcement, provider configuration, storage failure, token caching/expiry, redacted errors, Graph throttling, notification retries/exhaustion, private inbox rendering, static path protection and rate limiting. The PostgreSQL integration is skipped unless `TEST_DATABASE_URL` is supplied; run it against the actual database engine before deployment. Its test-only rows are removed afterward. These checks do not replace the authorised delivery test through the final host.

Runtime dependencies are pinned to `nodemailer` 10.5.0 and `pg` 8.23.1, verified against their primary npm package pages on 15 November 2026. Commit the package manager lockfile generated during installation. SQLite uses Node 24's built-in `node:sqlite` module.
