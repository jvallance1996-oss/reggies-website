import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { SQLiteStore, PostgresStore } from './store.mjs';
import { validateQuote, MAX_BODY_BYTES } from './validation.mjs';
import { createMicrosoftGraphTransport, graphConfigurationReady } from './microsoft-graph.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf',
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'QUOTE_TO'];
const mailAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);

function originOf(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value.replace(/\/$/, '') ? url.origin : null; }
  catch { return null; }
}

function json(res, status, body, extra = {}) {
  const value = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(value), 'Cache-Control': 'no-store', ...(status >= 400 ? { Connection: 'close' } : {}), ...extra });
  res.end(value);
}

function codeError(status, message) { const error = new Error(message); error.status = status; return error; }

async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw codeError(415, 'Send the form as JSON.');
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw codeError(413, 'The request is too large. Use up to four photos, 3 MB each.');
  const chunks = [];
  let length = 0;
  await new Promise((done, reject) => {
    let failed = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (failed) return;
      if (length > MAX_BODY_BYTES) {
        failed = true; chunks.length = 0;
        reject(codeError(413, 'The request is too large. Use up to four photos, 3 MB each.'));
      } else chunks.push(chunk);
    });
    req.on('end', done);
    req.on('error', () => reject(codeError(400, 'The request was interrupted. Please try again.')));
    req.on('aborted', () => reject(codeError(400, 'The request was interrupted. Please try again.')));
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw codeError(400, 'The quote could not be read. Please try again.'); }
}

function clientIP(req, hops) {
  if (!hops) return req.socket.remoteAddress || 'unknown';
  const supplied = String(req.headers['x-forwarded-for'] || '').split(',').map(item => item.trim()).filter(item => isIP(item));
  const chain = [...supplied.slice(-8), req.socket.remoteAddress || 'unknown'];
  return chain[Math.max(0, chain.length - 1 - hops)];
}

function makeLimiter({ limit = 20, windowMs = 3_600_000, globalLimit = 500 } = {}) {
  const windows = new Map();
  let global = { starts: Date.now(), count: 0 };
  return key => {
    const now = Date.now();
    if (now - global.starts >= windowMs) global = { starts: now, count: 0 };
    for (const [id, entry] of windows) { if (now - entry.starts >= windowMs) windows.delete(id); }
    let entry = windows.get(key);
    if (!entry) {
      if (windows.size >= 10_000) return false;
      entry = { starts: now, count: 0 }; windows.set(key, entry);
    }
    if (entry.count >= limit || global.count >= globalLimit) return false;
    entry.count++; global.count++;
    return true;
  };
}

function sameSecret(candidate, expected) {
  const actualHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function authorised(req, password) {
  if (!password || !/^Basic [A-Za-z0-9+/]+=*$/i.test(req.headers.authorization || '')) return false;
  const credentials = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
  return sameSecret(credentials, `jack:${password}`);
}

function emailMessage(quote, photos, env) {
  const p = quote.payload;
  const graph = env.MAIL_PROVIDER === 'microsoft-graph';
  const photoNote = graph ? [
    '', `${photos.length} photo(s) saved with this enquiry.`,
    `Private enquiry inbox: ${new URL('/admin/quotes', env.PUBLIC_ORIGIN).href}`,
    ...(photos.map(photo => `${photo.name}: ${new URL(`/admin/quotes/${quote.requestId}/photos/${photo.position}`, env.PUBLIC_ORIGIN).href}`)),
    'Sign in with your private enquiry inbox credentials to view the original photos.',
  ] : ['', `${photos.length} photo(s) attached.`];
  const lines = [
    `Quote reference: ${quote.reference}`, `Name: ${p.name}`, `Suburb: ${p.suburb}`,
    `Service: ${p.service}`, `Reply by: ${p.contactPreference}`, `Phone: ${p.phone || 'Not provided'}`,
    `Email: ${p.email || 'Not provided'}`, `Job type: ${p.jobType || 'Not provided'}`,
    `Timing: ${p.timing || 'Not provided'}`, '', 'Job details:', p.details || 'Not provided',
    ...photoNote,
  ];
  return {
    from: graph ? env.MAIL_FROM : env.SMTP_FROM, to: env.QUOTE_TO,
    ...(p.email ? { replyTo: p.email } : {}),
    subject: `Reggie's quote ${quote.reference}`,
    text: lines.join('\n'),
    messageId: `<${quote.requestId}@${new URL(env.PUBLIC_ORIGIN || 'https://reggies.com.au').hostname}>`,
    attachments: graph ? [] : photos.map(photo => ({ filename: photo.name, content: photo.bytes, contentType: photo.type })),
    disableFileAccess: true, disableUrlAccess: true,
  };
}

export async function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  const publicDir = resolve(options.publicDir || env.PUBLIC_DIR || '.');
  const publicJS = new Set(['script.js', 'quote-form.js', ...String(env.PUBLIC_JS_FILES || '').split(',').map(item => item.trim()).filter(item => /^[a-z0-9][a-z0-9-]*\.js$/.test(item))]);
  const configuredOrigin = originOf(env.PUBLIC_ORIGIN || '');
  const mailProvider = env.MAIL_PROVIDER || 'smtp';
  const knownProvider = ['smtp', 'microsoft-graph'].includes(mailProvider);
  const smtpReady = smtpKeys.every(key => Boolean(env[key])) && /^\d+$/.test(env.SMTP_PORT || '') && Number(env.SMTP_PORT) > 0 && Number(env.SMTP_PORT) <= 65535 && mailAddress(env.SMTP_FROM) && mailAddress(env.QUOTE_TO);
  const graphReady = graphConfigurationReady(env) && Boolean(env.ADMIN_PASSWORD && configuredOrigin?.startsWith('https://'));
  const mailReady = mailProvider === 'microsoft-graph' ? graphReady : smtpReady;
  const configurationReady = knownProvider && (!production || Boolean(env.DATABASE_URL && configuredOrigin?.startsWith('https://') && mailReady));
  let store = options.store;
  let transport = options.transport;
  if (!store && configurationReady) {
    const pgOptions = { ...(production || env.DATABASE_CA_CERT ? { ssl: { ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT.replaceAll('\\n', '\n') } : {}), rejectUnauthorized: true } } : {}), ...options.pgOptions };
    store = env.DATABASE_URL ? await PostgresStore.connect(env.DATABASE_URL, pgOptions) : new SQLiteStore(env.QUOTE_DB_PATH || './data/quotes.sqlite');
  }
  if (!transport && mailProvider === 'microsoft-graph' && graphReady) transport = createMicrosoftGraphTransport(env, options.graphOptions);
  if (!transport && mailProvider === 'smtp' && smtpReady) {
    const { default: nodemailer } = await import('nodemailer');
    const secure = env.SMTP_SECURE === 'true' || Number(env.SMTP_PORT) === 465;
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT), secure,
      requireTLS: !secure, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
    });
  }
  const limit = makeLimiter(options.rateLimit);
  const loginLimit = makeLimiter({ limit: 30, windowMs: 15 * 60_000, globalLimit: 500 });
  const hops = Math.max(0, Math.min(8, Number.parseInt(env.TRUST_PROXY_HOPS || '0', 10) || 0));
  const log = options.log || (event => console.error(event));
  let sending = false;
  let closing = false;
  let activeUploads = 0;

  async function processNotifications(now = Date.now()) {
    if (!store || !transport || sending || closing || !configurationReady || (mailProvider === 'microsoft-graph' && !graphReady)) return;
    sending = true;
    const startedAt = Date.now();
    try {
      for (let processed = 0; processed < 5; processed++) {
        // Claim immediately before sending so queued messages do not use up their lease waiting behind SMTP.
        const claimTime = now + (Date.now() - startedAt);
        const [quote] = await store.claimNotifications(claimTime, 1);
        if (!quote) break;
        try {
          const photos = await store.photos(quote.requestId);
          const result = await transport.sendMail(emailMessage(quote, photos, env));
          if (Array.isArray(result?.rejected) && result.rejected.length) throw new Error('recipient-rejected');
          await store.finishNotification(quote.requestId, 'sent', 0);
        } catch (error) {
          const exhausted = quote.notificationAttempts >= 8;
          const providerDelay = Number.isFinite(error?.retryAfterMs) ? Math.max(0, Math.min(86_400_000, error.retryAfterMs)) : 0;
          const delay = Math.max(providerDelay, Math.min(30 * 60_000, 30_000 * (2 ** Math.min(quote.notificationAttempts - 1, 6))));
          await store.finishNotification(quote.requestId, exhausted ? 'failed' : 'retry', now + (Date.now() - startedAt) + delay, 'notification-delivery-failed');
          // Log operational state only. Never log client content, SMTP responses, addresses, IPs or credentials.
          log(exhausted ? 'quote_notification_exhausted' : 'quote_notification_retry');
        }
      }
    } catch { log('quote_notification_worker_error'); }
    finally { sending = false; }
  }

  async function admin(req, res, pathname) {
    if (!env.ADMIN_PASSWORD) { res.writeHead(404); res.end('Not found'); return; }
    if (production && !configuredOrigin?.startsWith('https://')) { res.writeHead(503); res.end('Unavailable'); return; }
    const key = clientIP(req, hops);
    if (!authorised(req, env.ADMIN_PASSWORD)) {
      if (!loginLimit(key)) { res.writeHead(429, { 'Retry-After': '900' }); res.end('Try again later'); return; }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reggie\'s enquiries", charset="UTF-8"', 'Cache-Control': 'no-store' });
      res.end('Authentication required'); return;
    }
    if (!store || !configurationReady) { res.writeHead(503); res.end('Unavailable'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const photoMatch = /^\/admin\/quotes\/([0-9a-f-]{36})\/photos\/([0-3])$/.exec(pathname);
    if (photoMatch) {
      const photo = (await store.photos(photoMatch[1])).find(item => item.position === Number(photoMatch[2]));
      if (!photo) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': photo.type, 'Content-Length': photo.bytes.length, 'Content-Disposition': `inline; filename="${photo.name}"`, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : photo.bytes); return;
    }
    if (pathname !== '/admin/quotes' && pathname !== '/admin/quotes/') { res.writeHead(404); res.end('Not found'); return; }
    const quotes = await store.recent(100);
    const cards = [];
    for (const quote of quotes) {
      const p = quote.payload;
      const photos = await store.photos(quote.requestId);
      const text = [p.name, `${p.service} · ${p.suburb}`, `Reply: ${p.contactPreference}`, p.phone, p.email,
        `Job type: ${p.jobType || 'Not specified'}`, `Timing: ${p.timing || 'Not specified'}`, p.details || 'No details provided'].filter(Boolean);
      cards.push(`<article><h2>${escapeHTML(quote.reference)}</h2><p>${escapeHTML(new Date(quote.createdAt).toISOString())}</p><pre>${text.map(escapeHTML).join('\n')}</pre><p>Notification: ${escapeHTML(quote.notificationStatus)} · attempts ${quote.notificationAttempts}</p><p>${photos.map(photo => `<a href="/admin/quotes/${quote.requestId}/photos/${photo.position}">${escapeHTML(photo.name)}</a>`).join(' · ')}</p></article>`);
    }
    const body = `<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Reggie's enquiries</title><style>body{font:16px system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;color:#17382b;background:#f6f7f3}article{background:white;border:1px solid #ccd5cf;padding:1rem;margin:1rem 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#154d37}</style><h1>Reggie's enquiries</h1><p>Latest 100 requests. A saved request remains here if its email notification fails. Reply using the customer's selected method.</p>${cards.join('') || '<p>No enquiries yet.</p>'}</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function staticFile(req, res, rawPath) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(rawPath); }
    catch { res.writeHead(400); res.end('Invalid path'); return; }
    // Reject traversal before resolve; also verify the final real path to reject symlink escape.
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const segments = pathname.split('/').filter(Boolean);
    const blocked = new Set(['server', 'backend', 'test', 'tests', 'scripts', 'data', 'work', 'node_modules', 'coverage']);
    const routeIndex = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/){0,3}(?:index\.html)?$/.test(pathname)
      || /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/){0,2}[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pathname);
    const publicRootFile = ['/styles.css', '/robots.txt', '/sitemap.xml', '/google-reviews.json', ...[...publicJS].map(name => `/${name}`)].includes(pathname);
    const publicAsset = /^\/assets\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp|avif|gif|svg|ico|woff2?)$/i.test(pathname);
    if (segments.some(part => blocked.has(part)) || !(routeIndex || publicRootFile || publicAsset)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    let file = resolve(publicDir, `.${pathname}`);
    if (file !== publicDir && !file.startsWith(`${publicDir}${sep}`)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) { res.writeHead(308, { Location: `${rawPath}/${new URL(req.url, 'http://local.invalid').search}` }); res.end(); return; }
        file = resolve(file, 'index.html'); info = await stat(file);
      }
      if (!info.isFile()) throw new Error('not-file');
      if (!(publicRootFile || publicAsset) && file.split(sep).at(-1) !== 'index.html') throw new Error('not-public-file');
      const [actualRoot, actualFile] = await Promise.all([realpath(publicDir), realpath(file)]);
      if (actualFile !== actualRoot && !actualFile.startsWith(`${actualRoot}${sep}`)) throw new Error('outside-root');
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(actualFile);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const rawPath = String(req.url || '/').split('?')[0];
      if (rawPath === '/healthz') {
        if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET, HEAD' }); return; }
        let healthy = configurationReady && Boolean(store);
        if (healthy) { try { await store.ping(); } catch { healthy = false; } }
        json(res, healthy ? 200 : 503, { ok: healthy }); return;
      }
      if (rawPath.startsWith('/admin')) { await admin(req, res, rawPath); return; }
      if (rawPath === '/api/quotes') {
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'POST' }); return; }
        if (!configurationReady || !store) { json(res, 503, { ok: false, error: 'The quote form is temporarily unavailable. Please text or call Jack on 0437 844 844.' }); return; }
        const expectedOrigin = configuredOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
          json(res, 403, { ok: false, error: 'Open the quote form on this website and try again.' }); return;
        }
        if (!limit(clientIP(req, hops))) {
          json(res, 429, { ok: false, error: 'Too many requests. Please wait or text Jack on 0437 844 844.' }, { 'Retry-After': '3600' }); return;
        }
        if (activeUploads >= 2) {
          json(res, 503, { ok: false, error: 'The quote form is busy. Please try again shortly or text Jack on 0437 844 844.' }, { 'Retry-After': '30' }); return;
        }
        activeUploads++;
        try {
        const validated = validateQuote(await readJSON(req));
        if (validated.fields) { json(res, 422, { ok: false, error: 'Check the highlighted details and try again.', fields: validated.fields }); return; }
        const digest = createHash('sha256').update(JSON.stringify({ payload: validated.payload, photos: validated.photos.map(photo => ({ type: photo.type, data: photo.bytes.toString('base64') })) })).digest('hex');
        const result = await store.save({ ...validated, digest, reference: `REG-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, createdAt: Date.now() });
        if (result.conflict) { json(res, 409, { ok: false, error: 'This request has already been sent with different details. Start a new quote request.' }); return; }
        json(res, result.duplicate ? 200 : 201, { ok: true, reference: result.quote.reference });
        if (options.autoNotify !== false) setImmediate(() => { void processNotifications(); });
        return;
        } finally { activeUploads--; }
      }
      if (rawPath.startsWith('/api/')) { json(res, 404, { ok: false, error: 'Not found.' }); return; }
      await staticFile(req, res, rawPath);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!error.status) log('quote_request_server_error');
      json(res, error.status || 503, { ok: false, error: error.status ? error.message : 'We could not save your request. Please try again or text Jack on 0437 844 844.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const interval = options.autoNotify === false ? null : setInterval(() => { void processNotifications(); }, 30_000);
  interval?.unref();
  return {
    server, store, processNotifications,
    async close() {
      closing = true;
      clearInterval(interval);
      await new Promise((done, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()));
      // Finish an in-flight SMTP attempt before closing its store. SMTP has bounded timeouts.
      while (sending) await new Promise(done => setTimeout(done, 25));
      transport?.close?.();
      await store?.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().then(app => {
    const port = Number(process.env.PORT || 8080);
    app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Reggie's web server listening on port ${port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      app.close().then(() => process.exit(0)).catch(() => process.exit(1));
    });
  }).catch(() => { console.error('server_start_failed'); process.exitCode = 1; });
}
