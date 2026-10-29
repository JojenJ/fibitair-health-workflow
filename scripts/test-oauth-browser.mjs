// Isolated headless QA of our own deployed consent page. No user browser/profile is accessed.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

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
const callbackUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const key = (await readFile('secrets/MCP_OWNER_KEY.txt', 'utf8')).trim();
let phase = 'start';
const browserProxy = process.env.HEALTH_BROWSER_PROXY?.trim();
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  ...(browserProxy ? { proxy: { server: browserProxy } } : {}),
});
try {
  phase = 'register';
  const registration = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'fibitair isolated browser QA',
      redirect_uris: [callbackUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: callbackUri,
    response_type: 'code',
    resource: `${base}/live-mcp`,
    scope: 'health:read offline_access',
    state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const context = await browser.newContext();
  let callback;
  // Never send a test callback to the user's ChatGPT account.
  let captureCallback;
  const captured = new Promise((resolve) => {
    captureCallback = resolve;
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      console.log('Browser reported a Content Security Policy violation');
  });
  page.on('request', (request) => {
    if (new URL(request.url()).origin === base)
      console.log('Browser request', request.method(), new URL(request.url()).pathname);
  });
  page.on('response', (response) => {
    if (new URL(response.url()).origin === base)
      console.log('Browser response', response.status(), new URL(response.url()).pathname);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // CDP intercepts redirect hops too; Playwright route() only handles a redirect chain's first URL.
  cdp.on('Fetch.requestPaused', async (event) => {
    const target = new URL(event.request.url);
    if (
      target.origin === 'https://chatgpt.com' &&
      target.pathname === '/connector_platform_oauth_redirect'
    ) {
      callback = target;
      await cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from('<!doctype html><html><body>QA callback captured</body></html>').toString(
          'base64',
        ),
      });
      captureCallback(target);
    } else {
      await cdp.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'BlockedByClient',
      });
    }
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: 'https://chatgpt.com/*', requestStage: 'Request' }],
  });
  const blocked = [];
  cdp.on('Network.responseReceivedExtraInfo', (info) => {
    for (const c of info.blockedCookies ?? []) blocked.push(...c.blockedReasons);
  });
  phase = 'load consent';
  const response = await page.goto(`${base}/authorize?${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  assert.equal(response.status(), 200);
  const cookies = await context.cookies(base);
  const bindingCookie = cookies.find((c) => c.name.startsWith('__Host-oauth-consent-'));
  assert.ok(bindingCookie?.secure && bindingCookie.httpOnly && bindingCookie.path === '/');
  assert.equal(bindingCookie.sameSite, 'Lax');
  assert.ok(
    response
      .headers()
      ['content-security-policy'].includes("form-action 'self' https://chatgpt.com"),
  );
  console.log(
    JSON.stringify({
      browser: 'isolated Edge',
      consentStatus: response.status(),
      bindingCookiesStored: cookies.filter((c) => c.name.startsWith('__Host-oauth-consent-'))
        .length,
      blockedCookieReasons: blocked,
    }),
  );
  phase = 'fill owner key';
  await page.locator('input[name="owner_key"]').fill(key);
  const received = page.waitForResponse(
    (r) => r.url().startsWith(`${base}/authorize`) && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  phase = 'submit consent';
  const [result] = await Promise.all([
    received,
    page.getByRole('button', { name: '允许连接', exact: true }).click(),
  ]);
  const text = result.status() === 302 ? 'redirect' : await result.text();
  console.log(
    JSON.stringify({
      submitStatus: result.status(),
      cookieError: text.includes('not started in this browser'),
      blockedCookieReasons: blocked,
    }),
  );
  assert.equal(result.status(), 302);
  phase = 'browser callback';
  await Promise.race([
    captured,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Browser callback was not reached')), 15000),
    ),
  ]);
  await page.waitForLoadState('domcontentloaded');
  console.log('Browser callback reached', callback.origin, callback.pathname);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), base);
  phase = 'exchange code';
  const exchange = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: callbackUri,
      code: callback.searchParams.get('code'),
      code_verifier: verifier,
      resource: `${base}/live-mcp`,
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(exchange.status, 200);
  const token = await exchange.json();
  // Revocation endpoint is discovered rather than inferred.
  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  if (metadata.revocation_endpoint)
    await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        token: token.refresh_token,
        client_id: client.client_id,
        token_type_hint: 'refresh_token',
      }),
    });
  console.log('Real browser consent and token exchange passed; test grant revoked.');
} catch (error) {
  // Browser errors can include filled field values; do not print the raw error or call log.
  const summary = String(error.message)
    .split('\n')[0]
    .replaceAll(key, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[url]');
  console.error(`Browser OAuth check failed at phase: ${phase}; ${error.name}: ${summary}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
