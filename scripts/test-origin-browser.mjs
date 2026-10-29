// Isolated headless browser regression test; localhost only, no account/profile/credentials.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
let executable;
for (const path of candidates) {
  try {
    await access(path);
    executable = path;
    break;
  } catch {}
}
if (!executable) throw new Error('Installed Edge was not found');
const profile = resolve('.wrangler/origin-browser-test');
await mkdir(profile, { recursive: true });
let policy;
let observed;
const server = createServer((req, res) => {
  if (req.url === '/capture') {
    observed = req.headers.origin;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<p>Form received</p>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': policy });
  res.end(
    '<!doctype html><form method="POST" action="/capture"><input name="test" value="local-only"></form><script>document.forms[0].requestSubmit()</script>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${server.address().port}`;
try {
  for (policy of ['no-referrer', 'same-origin']) {
    observed = undefined;
    await promisify(execFile)(
      executable,
      [
        '--headless=new',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-extensions',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=1500',
        '--dump-dom',
        `${local}/`,
      ],
      { windowsHide: true, timeout: 30000 },
    );
    assert.equal(observed, policy === 'no-referrer' ? 'null' : local);
    console.log(
      `${policy}: form Origin ${observed === 'null' ? 'null (reproduces failure)' : 'matches page origin (fixed)'}`,
    );
  }
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
