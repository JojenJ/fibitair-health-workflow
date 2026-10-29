// Explicit integration check against your deployment. Never prints credentials or health values.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const workerUrl = process.env.HEALTH_WORKER_URL?.trim();
if (!workerUrl)
  throw new Error('Set HEALTH_WORKER_URL to your deployed HTTPS origin before running this check.');
let workerOrigin;
try {
  workerOrigin = new URL(workerUrl);
} catch {
  throw new Error(
    'HEALTH_WORKER_URL must be a valid HTTPS origin without a path, query, or credentials.',
  );
}
if (
  workerOrigin.protocol !== 'https:' ||
  workerOrigin.username ||
  workerOrigin.password ||
  workerOrigin.pathname !== '/' ||
  workerOrigin.search ||
  workerOrigin.hash
)
  throw new Error(
    'HEALTH_WORKER_URL must be an HTTPS origin without a path, query, or credentials.',
  );
const base = workerOrigin.origin;
const resource = `${base}/live-mcp`;
const ownerKey = (await readFile('secrets/MCP_OWNER_KEY.txt', 'utf8')).trim();
const cookies = new Map();
async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  const r = await fetch(new URL(path, base), {
    ...options,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  for (const cookie of r.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return r;
}
const unauth = await request('/live-mcp', { method: 'POST' });
assert.equal(unauth.status, 401);
assert.ok(unauth.headers.get('WWW-Authenticate')?.includes('resource_metadata'));
const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
assert.ok(metadata.authorization_response_iss_parameter_supported);
const registration = await request('/oauth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'fibitair integration test',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
assert.equal(registration.status, 201);
const client = await registration.json();
const verifier = randomBytes(32).toString('base64url');
const query = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  response_type: 'code',
  resource,
  scope: 'health:read offline_access',
  state: randomBytes(16).toString('hex'),
  code_challenge_method: 'S256',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
});
const page = await request(`/authorize?${query}`);
assert.equal(page.status, 200);
assert.equal(
  page.headers.get('Referrer-Policy'),
  'same-origin',
  'Browser form POST must preserve its same-origin Origin',
);
const html = await page.text();
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
assert.ok(handle);
const form = new URLSearchParams({ handle, decision: 'approve', owner_key: ownerKey });
const noCookie = await fetch(`${base}/authorize`, {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form,
  redirect: 'manual',
  signal: AbortSignal.timeout(30000),
});
assert.equal(noCookie.status, 400);
assert.ok((await noCookie.text()).includes('not started in this browser'));
const csrf = await request('/authorize', {
  method: 'POST',
  headers: {
    Origin: 'https://attacker.invalid',
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: form,
});
assert.equal(csrf.status, 403);
for (const origin of ['null', undefined]) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (origin) headers.Origin = origin;
  const invalidOrigin = await request('/authorize', { method: 'POST', headers, body: form });
  assert.equal(invalidOrigin.status, 403);
}
const denied = await request('/authorize', {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ handle, decision: 'approve', owner_key: 'wrong' }),
});
assert.equal(denied.status, 403);
const approval = await request('/authorize', {
  method: 'POST',
  headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form,
});
assert.equal(approval.status, 302);
const callback = new URL(approval.headers.get('Location'));
assert.equal(callback.searchParams.get('state'), query.get('state'));
assert.equal(callback.searchParams.get('iss'), metadata.issuer);
const exchangeBody = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  code: callback.searchParams.get('code'),
  code_verifier: verifier,
  resource,
});
const exchange = await request('/oauth/token', { method: 'POST', body: exchangeBody });
assert.equal(exchange.status, 200, `OAuth code exchange failed (HTTP ${exchange.status})`);
let token = await exchange.json();
assert.ok(token.access_token);
assert.ok(token.refresh_token);
const adminAttempt = await request('/status', {
  headers: { Authorization: `Bearer ${token.access_token}` },
});
assert.equal(adminAttempt.status, 401);
async function rpc(method, params, id) {
  const r = await request('/live-mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  const result = JSON.parse(
    text.startsWith('{')
      ? text
      : text
          .split('\n')
          .find((l) => l.startsWith('data: '))
          .slice(6),
  );
  assert.ok(!result.error, 'MCP returned an error response');
  return result.result;
}
const tools = await rpc('tools/list', {}, 1);
assert.ok(tools.tools.some((t) => t.name === 'fetch_latest_health'));
const result = await rpc('tools/call', { name: 'fetch_latest_health', arguments: { days: 7 } }, 2);
assert.ok(!result.isError);
const data = JSON.parse(result.content[0].text);
assert.equal(data.refreshSucceeded, true);
console.log(
  JSON.stringify({
    oauth: 'passed',
    csrf: 'rejected',
    wrongOwner: 'rejected',
    codeReplay: 'rejected',
    adminEscalation: 'rejected',
    liveFetch: true,
    requestedAt: data.requestedAt,
    completedAt: data.refreshCompletedAt,
    streams: data.refreshStatus,
  }),
);
const refreshed = await request('/oauth/token', {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.client_id,
    refresh_token: token.refresh_token,
    resource,
  }),
});
assert.equal(refreshed.status, 200);
token = await refreshed.json();
await rpc('tools/list', {}, 3);
console.log('OAuth refresh: passed');
const replay = await request('/oauth/token', { method: 'POST', body: exchangeBody });
assert.equal(replay.status, 400);
if (metadata.revocation_endpoint) {
  const revoked = await request(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      token: token.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: client.client_id,
    }),
  });
  assert.equal(revoked.status, 200);
  console.log('Test grant revoked');
}
