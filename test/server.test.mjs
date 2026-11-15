import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { SQLiteStore, PostgresStore } from '../store.mjs';
import { MAX_BODY_BYTES, MAX_PHOTO_BYTES } from '../validation.mjs';

const tinyPNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
const smtp = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'test-user', SMTP_PASS: 'test-only-not-a-credential', SMTP_FROM: 'website@example.test', QUOTE_TO: 'operator@example.test' };
const quote = (overrides = {}) => ({ requestId: randomUUID(), name: 'Test Customer', suburb: 'Eynesbury', service: 'lawn-mowing', contactPreference: 'sms', phone: '0400 000 000', email: '', details: 'One-off lawn tidy-up.', timing: '', jobType: 'one-off', photos: [], website: '', ...overrides });

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reggies-backend-test-'));
  const publicDir = join(dir, 'site');
  await mkdir(join(publicDir, 'melton'), { recursive: true });
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  await mkdir(join(publicDir, 'scripts'), { recursive: true });
  await writeFile(join(publicDir, 'index.html'), '<h1>Public homepage</h1>');
  await writeFile(join(publicDir, 'melton', 'index.html'), '<h1>Melton</h1>');
  await writeFile(join(publicDir, 'styles.css'), 'body{color:green}');
  await writeFile(join(publicDir, 'quote-form.js'), '/* frontend */');
  await writeFile(join(publicDir, 'server.mjs'), 'private source');
  await writeFile(join(publicDir, 'package.json'), 'private package');
  await writeFile(join(publicDir, '.env'), 'private config');
  await writeFile(join(publicDir, 'deployment-secret'), 'private extensionless file');
  await writeFile(join(publicDir, 'scripts', 'private.py'), 'private script');
  await writeFile(join(dir, 'outside.png'), 'private file');
  await symlink(join(dir, 'outside.png'), join(publicDir, 'assets', 'escape.png'));
  const dbPath = join(dir, 'data', 'quotes.sqlite');
  const store = options.store || new SQLiteStore(dbPath);
  const app = await createApp({ env: { NODE_ENV: 'test', ...options.env }, store, publicDir, autoNotify: false, log: () => {}, ...options });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const post = (payload, headers = {}) => fetch(`${origin}/api/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { ...app, origin, dbPath, dir, publicDir, post, close };
}

function rawRequest(origin, path, headers = {}, method = 'GET') {
  return new Promise((done, reject) => {
    const req = http.request(`${origin}`, { method, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

test('quote and photo bytes survive closing and reopening the SQLite database', async t => {
  const app = await harness(t);
  const request = quote({ photos: [{ name: '../../unsafe.png', type: 'image/png', data: tinyPNG }] });
  const response = await app.post(request);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.deepEqual(Object.keys(receipt).sort(), ['ok', 'reference']);
  assert.equal(receipt.ok, true);
  assert.match(receipt.reference, /^REG-[0-9A-F]{12}$/);
  await app.close();
  const reopened = new SQLiteStore(app.dbPath);
  try {
    const saved = await reopened.get(request.requestId);
    assert.equal(saved.payload.name, request.name);
    assert.equal(saved.payload.phone, '0400000000');
    assert.equal(saved.reference, receipt.reference);
    assert.equal(saved.notificationStatus, 'pending');
    const photos = await reopened.photos(request.requestId);
    assert.equal(photos[0].name, 'job-photo-1.png');
    assert.equal(photos[0].bytes.toString('base64'), tinyPNG);
  } finally { await reopened.close(); }
});

test('retrying the same request is idempotent and conflicting reuse is rejected', async t => {
  const app = await harness(t);
  const request = quote();
  const original = await (await app.post(request)).json();
  const duplicate = await app.post(request);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), original);
  assert.equal((await app.store.recent()).length, 1);
  const conflict = await app.post({ ...request, details: 'Changed details' });
  assert.equal(conflict.status, 409);
  assert.equal((await app.store.get(request.requestId)).payload.details, request.details);
});

test('malformed JSON, unsupported content type, cross-origin and missing Origin are rejected', async t => {
  const app = await harness(t);
  assert.equal((await app.post('{')).status, 400);
  assert.equal((await app.post(quote(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.post(quote(), { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await app.post(quote(), { Origin: '' })).status, 403);
  assert.equal((await app.post(quote(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.store.recent()).length, 0);
});

test('invalid contact details, header injection, unsupported fields and honeypot do not save leads', async t => {
  const app = await harness(t, { rateLimit: { limit: 100 } });
  const invalid = [
    quote({ contactPreference: 'sms', phone: '03 9000 0000' }),
    quote({ contactPreference: 'email', email: '' }),
    quote({ email: 'test@example.test\r\nBcc: victim@example.test' }),
    quote({ name: '<script>alert(1)</script>' }),
    quote({ service: 'not-offered' }),
    quote({ website: 'spam.example' }),
    quote({ details: 'x'.repeat(4001) }),
    quote({ unexpected: 'no' }),
    JSON.stringify(quote()).replace('{', '{"__proto__":{"polluted":true},'),
  ];
  for (const payload of invalid) {
    const response = await app.post(payload);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal((await app.store.recent()).length, 0);
  assert.equal({}.polluted, undefined);
});

test('photo MIME/signature/encoding/count/size validation rejects unsupported uploads', async t => {
  const app = await harness(t, { rateLimit: { limit: 100 } });
  const photo = { name: 'test.png', type: 'image/png', data: tinyPNG };
  const invalid = [
    [{ ...photo, type: 'image/svg+xml' }],
    [{ ...photo, data: Buffer.from('<script>bad</script>').toString('base64') }],
    [{ ...photo, data: `data:image/png;base64,${tinyPNG}` }],
    [{ ...photo, data: 'not base64!' }],
    Array.from({ length: 5 }, () => photo),
    [{ ...photo, data: Buffer.alloc(MAX_PHOTO_BYTES + 1).toString('base64') }],
  ];
  for (const photos of invalid) {
    const response = await app.post(quote({ photos }));
    assert.equal(response.status, 422);
    assert.ok((await response.json()).fields.photos);
  }
  assert.equal((await app.store.recent()).length, 0);
});

test('oversized declared body is rejected before allocation', async t => {
  const app = await harness(t);
  const response = await rawRequest(app.origin, '/api/quotes', { 'Content-Type': 'application/json', 'Content-Length': MAX_BODY_BYTES + 1, Origin: app.origin }, 'POST');
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).ok, false);
});

test('production fails closed without durable database, SMTP or canonical HTTPS origin configuration', async t => {
  const cases = [
    { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://reggies.com.au', ...smtp },
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://configured.example.test/quotes', PUBLIC_ORIGIN: 'https://reggies.com.au' },
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://configured.example.test/quotes', ...smtp },
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://configured.example.test/quotes', PUBLIC_ORIGIN: 'http://reggies.com.au', ...smtp },
  ];
  for (const env of cases) {
    const app = await harness(t, { env, transport: { async sendMail() { throw new Error('must not send'); } } });
    const response = await app.post(quote(), { Origin: 'https://reggies.com.au' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
    assert.equal((await app.store.recent()).length, 0);
    assert.equal((await fetch(`${app.origin}/healthz`)).status, 503);
    await app.close();
  }
});

test('database failure returns a failure response, never a false success', async t => {
  const store = { async save() { throw new Error('private database failure details'); }, async ping() {}, async close() {} };
  const app = await harness(t, { store });
  const response = await app.post(quote());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!body.error.includes('private database'));
});

test('durable notification retry survives a failed SMTP attempt and sends photo bytes on retry', async t => {
  const messages = [];
  const transport = { async sendMail(message) { messages.push(message); if (messages.length === 1) throw new Error('private SMTP response'); return { accepted: [smtp.QUOTE_TO], rejected: [] }; } };
  const app = await harness(t, { env: smtp, transport });
  const request = quote({ photos: [{ name: 'job.png', type: 'image/png', data: tinyPNG }] });
  assert.equal((await app.post(request)).status, 201);
  const now = Date.now();
  await app.processNotifications(now);
  let saved = await app.store.get(request.requestId);
  assert.equal(saved.notificationStatus, 'retry');
  assert.equal(saved.notificationAttempts, 1);
  assert.equal(saved.notificationError, 'notification-delivery-failed');
  await app.processNotifications(now + 29_000);
  assert.equal(messages.length, 1);
  await app.processNotifications(saved.nextAttemptAt + 1);
  saved = await app.store.get(request.requestId);
  assert.equal(saved.notificationStatus, 'sent');
  assert.equal(saved.notificationAttempts, 2);
  assert.equal(messages[1].attachments[0].content.toString('base64'), tinyPNG);
  assert.equal(messages[1].from, smtp.SMTP_FROM);
  assert.equal(messages[1].to, smtp.QUOTE_TO);
  assert.equal(messages[1].messageId, messages[0].messageId);
});

test('notification attempts stop after eight failures while the enquiry remains stored', async t => {
  const app = await harness(t, { env: smtp, transport: { async sendMail() { throw new Error('test SMTP unavailable'); } } });
  const request = quote();
  await app.post(request);
  let now = Date.now();
  for (let attempt = 0; attempt < 8; attempt++) { await app.processNotifications(now); now += 1_900_000; }
  let saved = await app.store.get(request.requestId);
  assert.equal(saved.notificationStatus, 'failed');
  assert.equal(saved.notificationAttempts, 8);
  await app.processNotifications(now + 10_000_000);
  saved = await app.store.get(request.requestId);
  assert.equal(saved.notificationAttempts, 8);
  assert.equal(saved.payload.name, request.name);
});

test('admin inbox requires configured credentials and safely renders plain text job details', async t => {
  const app = await harness(t, { env: { ADMIN_PASSWORD: 'test-only-operator-password' } });
  const request = quote({ details: "'); DROP TABLE quotes; -- <script>alert('x')</script>", photos: [{ name: 'job.png', type: 'image/png', data: tinyPNG }] });
  await app.post(request);
  assert.equal((await fetch(`${app.origin}/admin/quotes`)).status, 401);
  const headers = { Authorization: `Basic ${Buffer.from('jack:test-only-operator-password').toString('base64')}` };
  const response = await fetch(`${app.origin}/admin/quotes`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.ok(body.includes('&lt;script&gt;'));
  assert.ok(!body.includes('<script>'));
  assert.ok(body.includes('DROP TABLE quotes'));
  const photo = await fetch(`${app.origin}/admin/quotes/${request.requestId}/photos/0`, { headers });
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await photo.arrayBuffer()).toString('base64'), tinyPNG);
  assert.equal((await app.store.recent()).length, 1);
});

test('admin is unavailable when no password is configured', async t => {
  const app = await harness(t);
  assert.equal((await fetch(`${app.origin}/admin/quotes`)).status, 404);
});

test('static allowlist preserves slash routes and blocks source, traversal and escaping symlinks', async t => {
  const app = await harness(t);
  assert.equal((await fetch(app.origin)).status, 200);
  assert.equal((await fetch(`${app.origin}/melton/`)).status, 200);
  const redirect = await fetch(`${app.origin}/melton?source=test`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/melton/?source=test');
  for (const path of ['/server.mjs', '/package.json', '/.env', '/deployment-secret', '/scripts/private.py', '/assets/escape.png', '/data/quotes.sqlite', '/%2e%2e/private', '/assets%5c..%5cprivate']) {
    assert.equal((await rawRequest(app.origin, path)).status, 404, path);
  }
  assert.equal((await fetch(`${app.origin}/quote-form.js`)).status, 200);
  assert.equal((await fetch(`${app.origin}/api/quotes`)).status, 405);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
});

test('rate limit rejects excess posts without adding more enquiries', async t => {
  const app = await harness(t, { rateLimit: { limit: 2, windowMs: 3_600_000, globalLimit: 10 } });
  assert.equal((await app.post(quote())).status, 201);
  assert.equal((await app.post(quote())).status, 201);
  const response = await app.post(quote());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3600');
  assert.equal((await app.store.recent()).length, 2);
});

test('concurrent upload cap rejects excess body buffering and frees slots after abort', async t => {
  const app = await harness(t);
  const openSlowUpload = async () => {
    const received = new Promise(done => app.server.once('request', req => req.once('data', () => setImmediate(done))));
    const req = http.request(`${app.origin}/api/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100', Origin: app.origin } }, res => res.resume());
    req.on('error', () => {});
    req.write('{"name":');
    await received;
    return req;
  };
  const first = await openSlowUpload();
  const second = await openSlowUpload();
  const response = await app.post(quote());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
  first.destroy(); second.destroy();
  await new Promise(done => setTimeout(done, 20));
  assert.equal((await app.post(quote())).status, 201);
});

test('optional PostgreSQL integration: transactions persist quote and photo idempotently', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const store = await PostgresStore.connect(process.env.TEST_DATABASE_URL);
  const requestId = randomUUID();
  try {
    const input = { requestId, reference: `TEST-${randomUUID()}`, digest: 'test-digest', createdAt: Date.now(), payload: { name: 'Database test only' }, photos: [{ name: 'job.png', type: 'image/png', bytes: Buffer.from(tinyPNG, 'base64') }] };
    assert.equal((await store.save(input)).duplicate, false);
    assert.equal((await store.save(input)).duplicate, true);
    assert.equal((await store.photos(requestId))[0].bytes.toString('base64'), tinyPNG);
    assert.equal((await store.get(requestId)).payload.name, 'Database test only');
  } finally {
    await store.pool.query('DELETE FROM quotes WHERE request_id=$1', [requestId]);
    await store.close();
  }
});
