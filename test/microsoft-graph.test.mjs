import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrosoftGraphTransport, graphConfigurationReady } from '../microsoft-graph.mjs';

const env = {
  MS_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  MS_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  MS_CLIENT_SECRET: 'synthetic-test-secret-do-not-use',
  MAIL_FROM: 'website@example.test', QUOTE_TO: 'operator@example.test',
};
const message = () => ({ from: env.MAIL_FROM, to: env.QUOTE_TO, subject: "Reggie's quote REG-TEST", text: 'Synthetic quote details. Photos are in the protected enquiry inbox.', messageId: '<synthetic@example.test>', replyTo: 'customer@example.test', attachments: [] });
const tokenResponse = (accessToken = 'synthetic-token', extra = {}) => new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, ...extra }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Graph transport uses client credentials at fixed HTTPS endpoints and sends Mail.Send text JSON', async () => {
  const calls = [];
  const transport = createMicrosoftGraphTransport(env, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.includes('login.microsoftonline.com') ? tokenResponse() : new Response(null, { status: 202 });
  } });
  assert.deepEqual(await transport.sendMail(message()), { accepted: [env.QUOTE_TO], rejected: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`);
  assert.equal(calls[1].url, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`);
  const credentials = new URLSearchParams(calls[0].options.body);
  assert.equal(credentials.get('grant_type'), 'client_credentials');
  assert.equal(credentials.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(credentials.get('client_secret'), env.MS_CLIENT_SECRET);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-token');
  for (const call of calls) { assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal instanceof AbortSignal); }
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.message.body.contentType, 'Text');
  assert.equal(payload.message.toRecipients[0].emailAddress.address, env.QUOTE_TO);
  assert.equal(payload.message.replyTo[0].emailAddress.address, 'customer@example.test');
  assert.equal(payload.message.attachments, undefined);
  assert.equal(payload.saveToSentItems, true);
  assert.ok(!calls[1].options.body.includes(env.MS_CLIENT_SECRET));
  transport.close();
});

test('Graph caches tokens, shares an in-flight token request and refreshes before expiry', async () => {
  let currentTime = 0;
  let requests = 0;
  const transport = createMicrosoftGraphTransport(env, { now: () => currentTime, fetchImpl: async url => {
    if (url.includes('login.microsoftonline.com')) { requests++; await Promise.resolve(); return tokenResponse(`token-${requests}`); }
    return new Response(null, { status: 202 });
  } });
  await Promise.all([transport.sendMail(message()), transport.sendMail(message())]);
  assert.equal(requests, 1);
  currentTime = 3_539_000;
  await transport.sendMail(message());
  assert.equal(requests, 1);
  currentTime = 3_541_000;
  await transport.sendMail(message());
  assert.equal(requests, 2);
  transport.close();
});

test('Graph refreshes once on 401 and never marks an arbitrary 2xx as accepted', async () => {
  let tokens = 0;
  let sends = 0;
  const authorizations = [];
  const transport = createMicrosoftGraphTransport(env, { fetchImpl: async (url, options) => {
    if (url.includes('login.microsoftonline.com')) return tokenResponse(`token-${++tokens}`);
    authorizations.push(options.headers.Authorization);
    return new Response(null, { status: ++sends === 1 ? 401 : 202 });
  } });
  await transport.sendMail(message());
  assert.deepEqual(authorizations, ['Bearer token-1', 'Bearer token-2']);
  transport.close();
  const unexpected = createMicrosoftGraphTransport(env, { fetchImpl: async url => url.includes('login.microsoftonline.com') ? tokenResponse() : new Response(null, { status: 200 }) });
  await assert.rejects(unexpected.sendMail(message()), { message: 'microsoft_graph_send_failed' });
  unexpected.close();
});

test('Graph errors redact provider response bodies, credentials and network diagnostics', async () => {
  const rejectedToken = createMicrosoftGraphTransport(env, { fetchImpl: async () => new Response(`error includes ${env.MS_CLIENT_SECRET}`, { status: 401 }) });
  await assert.rejects(rejectedToken.sendMail(message()), error => error.message === 'microsoft_graph_token_failed' && !String(error).includes(env.MS_CLIENT_SECRET));
  rejectedToken.close();
  const rejectedSend = createMicrosoftGraphTransport(env, { fetchImpl: async url => url.includes('login.microsoftonline.com') ? tokenResponse() : new Response('private customer content in diagnostic', { status: 403 }) });
  await assert.rejects(rejectedSend.sendMail(message()), { message: 'microsoft_graph_send_failed' });
  rejectedSend.close();
  const networkFailure = createMicrosoftGraphTransport(env, { fetchImpl: async () => { throw new Error(`URL or credential ${env.MS_CLIENT_SECRET}`); } });
  await assert.rejects(networkFailure.sendMail(message()), { message: 'microsoft_graph_network_failed' });
  networkFailure.close();
});

test('response stream disposal cannot overturn accepted status or expose provider diagnostics', async () => {
  const brokenBody = status => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private provider stream diagnostic')); } }), { status });
  for (const status of [202, 403]) {
    const transport = createMicrosoftGraphTransport(env, { fetchImpl: async url => url.includes('login.microsoftonline.com') ? tokenResponse() : brokenBody(status) });
    if (status === 202) assert.deepEqual(await transport.sendMail(message()), { accepted: [env.QUOTE_TO], rejected: [] });
    else await assert.rejects(transport.sendMail(message()), { message: 'microsoft_graph_send_failed' });
    transport.close();
  }
  const transport = createMicrosoftGraphTransport(env, { fetchImpl: async () => brokenBody(401) });
  await assert.rejects(transport.sendMail(message()), { message: 'microsoft_graph_token_failed' });
  transport.close();
});

test('Graph honours a bounded Retry-After signal for the durable worker', async () => {
  const transport = createMicrosoftGraphTransport(env, { fetchImpl: async url => url.includes('login.microsoftonline.com') ? tokenResponse() : new Response(null, { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(transport.sendMail(message()), error => error.code === 'microsoft_graph_send_failed' && error.retryAfterMs === 120_000);
  transport.close();
});

test('Graph rejects invalid configuration, token responses, wrong recipients and attachment use', async () => {
  assert.equal(graphConfigurationReady(env), true);
  for (const invalid of [{ ...env, MS_TENANT_ID: '../../common?bad' }, { ...env, MS_CLIENT_SECRET: '' }, { ...env, MAIL_FROM: 'x@example.test\r\nBcc:x' }]) {
    assert.equal(graphConfigurationReady(invalid), false);
    assert.throws(() => createMicrosoftGraphTransport(invalid), { message: 'microsoft_graph_configuration_invalid' });
  }
  for (const response of [tokenResponse('token', { expires_in: 0 }), tokenResponse('token', { token_type: 'other' }), tokenResponse('bad token'), new Response('x'.repeat(65_537), { status: 200 })]) {
    const transport = createMicrosoftGraphTransport(env, { fetchImpl: async () => response });
    await assert.rejects(transport.sendMail(message()), { message: 'microsoft_graph_token_response_invalid' });
    transport.close();
  }
  let calls = 0;
  const transport = createMicrosoftGraphTransport(env, { fetchImpl: async () => { calls++; throw new Error('must not call'); } });
  await assert.rejects(transport.sendMail({ ...message(), attachments: [{ content: Buffer.alloc(3 * 1024 * 1024) }] }), { message: 'microsoft_graph_attachments_not_supported' });
  await assert.rejects(transport.sendMail({ ...message(), to: 'other@example.test' }), { message: 'microsoft_graph_recipient_invalid' });
  assert.equal(calls, 0);
  transport.close();
  await assert.rejects(transport.sendMail(message()), { message: 'microsoft_graph_transport_closed' });
});

test('Graph network operations have an abort deadline', async () => {
  const transport = createMicrosoftGraphTransport(env, { timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_done, reject) => {
    const timer = setTimeout(() => reject(new Error('test deadline not applied')), 500);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
  }) });
  await assert.rejects(transport.sendMail(message()), { message: 'microsoft_graph_network_failed' });
  transport.close();
});
