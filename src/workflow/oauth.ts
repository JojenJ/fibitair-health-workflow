import { timingSafeEqual } from 'node:crypto';
import {
  AuthorizationError,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { WorkflowEnv } from './core';
import { handleMcp } from './mcp';

type OAuthEnv = WorkflowEnv & { OAUTH_PROVIDER: OAuthHelpers };
// Only deployment configuration defines the issuer; never trust an incoming Host/Origin.
export function publicOrigin(value?: string) {
  if (!value) throw new Error('PUBLIC_ORIGIN is required for OAuth');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin');
  return url.origin;
}
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function ownerMatches(value: string, expected?: string) {
  if (!expected || expected.length < 32) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function allowedRedirect(value: string) {
  const u = new URL(value);
  return (
    u.origin === 'https://chatgpt.com' &&
    !u.search &&
    !u.hash &&
    (u.pathname === '/connector_platform_oauth_redirect' ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname))
  );
}
async function authorize(req: Request, env: OAuthEnv) {
  const oauth = env.OAUTH_PROVIDER;
  if (!env.MCP_OWNER_KEY) return new Response('Owner access is not configured', { status: 503 });
  try {
    if (req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      if (!allowedRedirect(request.redirectUri))
        return new Response('Only the ChatGPT callback is allowed', { status: 400 });
      if (!request.codeChallenge || request.codeChallengeMethod !== 'S256')
        return new Response('PKCE S256 required', { status: 400 });
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      consent.headers.set(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
      );
      consent.headers.set('Cache-Control', 'no-store');
      // no-referrer makes a browser's HTML form POST send Origin: null.
      // Keep same-origin form submissions compatible with the strict Origin guard,
      // while still withholding the authorization URL from cross-origin destinations.
      consent.headers.set('Referrer-Policy', 'same-origin');
      return new Response(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 fibitair</title><style>body{font:17px/1.7 system-ui;max-width:600px;margin:48px auto;padding:24px}input{box-sizing:border-box;width:100%;padding:12px}button{padding:12px;margin:18px 12px 0 0}</style><h1>连接 fibitair 健康数据</h1><p>请求应用：${htmlEscape(details.clientName)}。注册名称不代表身份已验证。</p><p>授权结果将返回：<strong>${htmlEscape(details.redirectHost)}</strong></p><p>允许 ChatGPT 在你提问时读取 Google Health 最新数据和归档。不会获得管理令牌、Google 令牌或修改健康记录的权限。</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${htmlEscape(consent.handle)}"><label>本机保存的 MCP_OWNER_KEY<input type="password" name="owner_key" autocomplete="off" required maxlength="128"></label><p>该连接的权限：health:read（健康查询）；支持续期。只在你刚从 ChatGPT 发起连接时批准。</p><button name="decision" value="approve">允许连接</button><button name="decision" value="deny" formnovalidate>取消</button></form></html>`,
        { headers: consent.headers },
      );
    }
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    if (req.headers.get('Origin') !== publicOrigin(env.PUBLIC_ORIGIN))
      return new Response('Invalid origin', { status: 403 });
    const body = await req.text();
    if (body.length > 4096) return new Response(null, { status: 413 });
    const form = new URLSearchParams(body);
    const handle = form.get('handle') ?? '';
    if (form.get('decision') !== 'approve') {
      const result = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: result.headers });
    }
    const key = `owner-key:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}:${Math.floor(Date.now() / 900000)}`;
    const count = await env.DB.prepare('SELECT count FROM oauth_attempts WHERE key=?')
      .bind(key)
      .all<{ count: number }>();
    if ((count.results[0]?.count ?? 0) >= 10)
      return new Response('Too many attempts; try later', { status: 429 });
    if (!ownerMatches(form.get('owner_key') ?? '', env.MCP_OWNER_KEY)) {
      await env.DB.prepare(
        'INSERT INTO oauth_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
      )
        .bind(key, Date.now() + 900000)
        .run();
      return new Response('Owner key incorrect. Return to the consent page and retry.', {
        status: 403,
      });
    }
    const approved = await oauth.approveConsent(req, handle, {
      scope: ['health:read', 'offline_access'],
    });
    if (!allowedRedirect(approved.request.redirectUri))
      return new Response('Invalid callback', { status: 400 });
    const result = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      scope: approved.request.scope,
      metadata: { label: 'Personal health ChatGPT' },
      props: { userId: 'owner' },
    });
    approved.headers.set('Location', result.redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    if (err instanceof AuthorizationError)
      return new Response(htmlEscape(err.description), { status: 400 });
    return new Response('Connection could not be completed. Retry from ChatGPT.', { status: 503 });
  }
}
const liveApp = new Hono<{ Bindings: WorkflowEnv }>();
liveApp.post('/live-mcp', handleMcp);
function createOAuthWorker(origin: string) {
  return new OAuthProvider<OAuthEnv>({
    apiRoute: '/live-mcp',
    apiHandler: {
      fetch(req, env, ctx) {
        const auth = (ctx as OAuthResourceContext<{ userId: string }>).auth;
        if (auth.userId !== 'owner' || !auth.scope.includes('health:read'))
          return new Response(null, { status: 403 });
        return liveApp.fetch(req, env, ctx);
      },
    },
    defaultHandler: { fetch: authorize },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['health:read', 'offline_access'],
    requiredScopes: ['health:read'],
    resourceMetadata: { resource: `${origin}/live-mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: false,
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 86400,
    refreshTokenIdleTTL: 90 * 86400,
  });
}
export function oauthFetch(req: Request, env: WorkflowEnv, ctx: ExecutionContext) {
  let origin: string;
  try {
    origin = publicOrigin(env.PUBLIC_ORIGIN);
  } catch {
    return new Response('Set PUBLIC_ORIGIN to your Worker HTTPS origin before connecting OAuth', {
      status: 503,
    });
  }
  if (new URL(req.url).origin !== origin) return new Response('Invalid origin', { status: 403 });
  return createOAuthWorker(origin).fetch(req, env as OAuthEnv, ctx);
}
