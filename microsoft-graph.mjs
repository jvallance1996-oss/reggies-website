const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const MAX_RESPONSE_BYTES = 65_536;

export function graphConfigurationReady(env) {
  return GUID.test(env.MS_TENANT_ID || '') && GUID.test(env.MS_CLIENT_ID || '')
    && typeof env.MS_CLIENT_SECRET === 'string' && Boolean(env.MS_CLIENT_SECRET.trim())
    && !/[\u0000-\u001f\u007f]/.test(env.MS_CLIENT_SECRET)
    && typeof env.MAIL_FROM === 'string' && env.MAIL_FROM.length <= 254 && ADDRESS.test(env.MAIL_FROM)
    && typeof env.QUOTE_TO === 'string' && env.QUOTE_TO.length <= 254 && ADDRESS.test(env.QUOTE_TO);
}

function failure(code, retryAfterMs = 0) {
  // Only fixed operational codes leave this transport. Provider replies can contain secrets or client data.
  const error = new Error(code);
  error.code = code;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function retryAfter(response, now) {
  const header = response.headers.get('retry-after') || '';
  const milliseconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(86_400_000, milliseconds)) : 0;
}

async function discard(response) {
  // Disposing a response stream must not expose its diagnostic or overturn Graph's accepted status.
  try { await response.body?.cancel(); } catch {}
}

async function tokenJSON(response) {
  if (Number(response.headers.get('content-length') || '0') > MAX_RESPONSE_BYTES) throw failure('microsoft_graph_token_response_invalid');
  const reader = response.body?.getReader();
  if (!reader) throw failure('microsoft_graph_token_response_invalid');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('microsoft_graph_token_response_invalid'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw failure('microsoft_graph_token_response_invalid'); }
  finally { reader.releaseLock(); }
}

export function createMicrosoftGraphTransport(env, { fetchImpl = fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  if (!graphConfigurationReady(env)) throw failure('microsoft_graph_configuration_invalid');
  const tokenURL = `https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0/token`;
  const sendURL = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`;
  let accessToken = null;
  let validUntil = 0;
  let tokenRequest = null;
  let closed = false;

  async function request(url, options) {
    if (closed) throw failure('microsoft_graph_transport_closed');
    try { return await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw failure('microsoft_graph_network_failed'); }
  }

  async function token() {
    if (accessToken && now() < validUntil) return accessToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const response = await request(tokenURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
      });
      if (response.status !== 200) {
        const delay = retryAfter(response, now());
        await discard(response);
        throw failure('microsoft_graph_token_failed', delay);
      }
      const data = await tokenJSON(response);
      const expiresIn = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32_768
        || /\s/.test(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer'
        || !Number.isFinite(expiresIn) || expiresIn < 1 || expiresIn > 86_400) throw failure('microsoft_graph_token_response_invalid');
      accessToken = data.access_token;
      validUntil = now() + expiresIn * 1000 - Math.min(60_000, expiresIn * 100);
      return accessToken;
    })();
    try { return await tokenRequest; }
    finally { tokenRequest = null; }
  }

  return {
    async sendMail(message) {
      if (closed) throw failure('microsoft_graph_transport_closed');
      // Graph uses Mail.Send only. Photo originals are reached through the protected site inbox.
      if (message.attachments?.length) throw failure('microsoft_graph_attachments_not_supported');
      if (message.from !== env.MAIL_FROM || message.to !== env.QUOTE_TO) throw failure('microsoft_graph_recipient_invalid');
      const body = JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: 'Text', content: message.text },
          toRecipients: [{ emailAddress: { address: env.QUOTE_TO } }],
          ...(message.replyTo ? { replyTo: [{ emailAddress: { address: message.replyTo } }] } : {}),
          internetMessageHeaders: [{ name: 'x-reggies-message-id', value: message.messageId }],
        },
        saveToSentItems: true,
      });
      if (Buffer.byteLength(body) > 64_000) throw failure('microsoft_graph_message_too_large');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(sendURL, {
          method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body,
        });
        const status = response.status;
        const delay = retryAfter(response, now());
        await discard(response);
        if (status === 202) return { accepted: [env.QUOTE_TO], rejected: [] };
        if (status === 401 && attempt === 0) { accessToken = null; validUntil = 0; continue; }
        throw failure('microsoft_graph_send_failed', delay);
      }
      throw failure('microsoft_graph_send_failed');
    },
    close() { closed = true; accessToken = null; validUntil = 0; },
  };
}
