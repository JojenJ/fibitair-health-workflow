import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const config = 'wrangler.workflow.toml';
const cli = require.resolve('wrangler/bin/wrangler.js');
async function wrangler(args: string[], input?: string, capture = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      windowsHide: true,
      stdio: ['pipe', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let output = '';
    child.stdout?.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Wrangler exited ${code}`)),
    );
    child.stdin?.end(input);
  });
}
async function secret(name: string, value: string) {
  await wrangler(['secret', 'put', name, '-c', config], value);
}
async function provision() {
  try {
    await readFile(config);
    throw new Error('Config already exists; edit it or continue with authorize/deploy.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let template = await readFile('wrangler.workflow.toml.example', 'utf8');
  for (const binding of ['TOKENS', 'CACHE', 'OAUTH']) {
    const output = await wrangler(
      ['kv', 'namespace', 'create', `personal-health-${binding.toLowerCase()}`],
      undefined,
      true,
    );
    const id =
      output.match(/"id"\s*:\s*"([a-f0-9]{32})"/)?.[1] ??
      output.match(/id\s*=\s*"([a-f0-9]{32})"/)?.[1];
    if (!id) throw new Error('Cannot parse namespace ID; inspect Cloudflare dashboard.');
    template = template.replace(`REPLACE_${binding}_ID`, id);
  }
  const output = await wrangler(['d1', 'create', 'personal-health-archive'], undefined, true);
  const id = output.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0];
  if (!id) throw new Error('Cannot parse D1 ID; inspect Cloudflare dashboard.');
  await writeFile(config, template.replace('REPLACE_DATABASE_ID', id));
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '-c', config]);
  await wrangler(['deploy', '-c', config]);
  await initializeAccess();
  await initializeAccess(['MCP_OWNER_KEY']);
  console.log('Provisioned. Save secrets/ securely; next authorize health and gmail.');
}
async function initializeAccess(names = ['ADMIN_TOKEN', 'READ_TOKEN']) {
  await mkdir('secrets', { recursive: true });
  for (const name of names) {
    const path = `secrets/${name}.txt`;
    let value: string;
    try {
      value = (await readFile(path, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid saved ${name}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      value = randomBytes(32).toString('hex');
      await writeFile(path, value, { mode: 0o600, flag: 'wx' });
    }
    await secret(name, value);
  }
  console.log('Access secrets installed. Existing local tokens were preserved.');
}
async function authorize(mode: string, path: string) {
  if (!['health', 'health-device', 'gmail'].includes(mode))
    throw new Error('Mode must be health, health-device or gmail');
  const file = JSON.parse(await readFile(path, 'utf8'));
  const client = file.web;
  if (!client?.client_id || !client?.client_secret)
    throw new Error('Download Web application OAuth client JSON');
  const redirect = 'http://127.0.0.1:8787/oauth/callback';
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const scopes =
    mode === 'health' || mode === 'health-device'
      ? [
          'googlehealth.activity_and_fitness.readonly',
          'googlehealth.health_metrics_and_measurements.readonly',
          'googlehealth.sleep.readonly',
          ...(mode === 'health-device' ? ['googlehealth.settings.readonly'] : []),
        ].map((s) => `https://www.googleapis.com/auth/${s}`)
      : ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'];
  type OAuthTokens = {
    refresh_token?: string;
    access_token: string;
    expires_in: number;
    scope?: string;
  };
  const pendingPath = `secrets/pending-${mode}-oauth.json`;
  let tokens: OAuthTokens | undefined;
  try {
    const cached = JSON.parse(await readFile(pendingPath, 'utf8'));
    if (cached.clientId === client.client_id && cached.validUntil > Date.now()) {
      tokens = cached.tokens;
      console.log('Resuming authorized token installation; browser consent is not needed.');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (!tokens) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('Authorization timed out after 10 minutes'));
      }, 600000);
      const server = createServer((req, res) => {
        const callback = new URL(req.url ?? '/', 'http://127.0.0.1:8787');
        if (
          callback.pathname !== '/oauth/callback' ||
          callback.searchParams.get('state') !== state
        ) {
          res.writeHead(400);
          res.end('Invalid callback');
          return;
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Authorization received. Return to terminal.');
        clearTimeout(timer);
        server.close();
        const code = callback.searchParams.get('code');
        if (!code) reject(new Error('Authorization denied'));
        else resolve(code);
      });
      server.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.listen(8787, '127.0.0.1', () => console.log(`Open this URL in your browser:\n${url}`));
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) throw new Error(`OAuth exchange failed (${response.status})`);
    tokens = (await response.json()) as {
      refresh_token?: string;
      access_token: string;
      expires_in: number;
      scope?: string;
    };
    await mkdir('secrets', { recursive: true });
    await writeFile(
      pendingPath,
      JSON.stringify({
        clientId: client.client_id,
        validUntil: Date.now() + (tokens.expires_in - 60) * 1000,
        tokens,
      }),
      { mode: 0o600 },
    );
  }
  if (!tokens.refresh_token)
    throw new Error('No refresh token; authorize with offline consent again');
  const granted = new Set(tokens.scope?.split(/\s+/) ?? []);
  const required = mode === 'gmail' ? ['https://www.googleapis.com/auth/gmail.send'] : scopes;
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length)
    throw new Error(
      `Missing scopes: ${missing.join(', ')}. Returned scopes: ${tokens.scope ?? '(absent)'}`,
    );
  if (mode === 'gmail') {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) throw new Error('Unable to verify Gmail owner');
    const user = (await res.json()) as { email?: string; verified_email?: boolean };
    if (!user.email || !user.verified_email) throw new Error('Verified account email required');
    await secret('GMAIL_CLIENT_ID', client.client_id);
    await secret('GMAIL_CLIENT_SECRET', client.client_secret);
    await secret('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
    await secret('SELF_EMAIL', user.email);
    console.log(
      'Self-recipient verified. Enable WEEKLY_EMAIL in config after reviewing the first export.',
    );
  } else {
    await secret('GOOGLE_CLIENT_ID', client.client_id);
    await secret('GOOGLE_CLIENT_SECRET', client.client_secret);
    const temp = await mkdtemp(join(tmpdir(), 'health-oauth-'));
    const rel = relative(resolve(tmpdir()), resolve(temp));
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !rel.startsWith('health-oauth-'))
      throw new Error('Unsafe temporary cleanup path');
    try {
      for (const [key, value] of Object.entries({
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expires_at: String(Math.floor(Date.now() / 1000) + tokens.expires_in),
      })) {
        const target = join(temp, key);
        await writeFile(target, value, { mode: 0o600 });
        await wrangler([
          'kv',
          'key',
          'put',
          key,
          '--path',
          target,
          '--binding',
          'TOKENS',
          '--remote',
          '-c',
          config,
        ]);
      }
    } finally {
      await rm(resolve(temp), { recursive: true, force: true });
    }
    console.log('Health OAuth installed. No tokens printed.');
  }
  await rm(pendingPath, { force: true });
}
async function main() {
  const [action, mode, path] = process.argv.slice(2);
  if (action === 'provision') return provision();
  if (action === 'init-access') return initializeAccess();
  if (action === 'init-mcp') return initializeAccess(['MCP_OWNER_KEY']);
  if (action === 'authorize' && mode && path) return authorize(mode, path);
  throw new Error(
    'Usage: pnpm tsx scripts/workflow-setup.ts provision | init-access | init-mcp | authorize health|health-device|gmail oauth-client.json',
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Setup failed');
  process.exitCode = 1;
});
