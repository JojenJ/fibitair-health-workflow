import type { WorkflowEnv } from './core';
import { packet, previousWeek } from './core';

export function mime(email: string, week: string, body: string) {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))
    throw new Error('Invalid self email');
  return [
    `To: ${email}`,
    `From: ${email}`,
    `Subject: Health data packet ${week}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '',
  ].join('\r\n');
}
export async function weekly(env: WorkflowEnv, now = new Date()) {
  if (env.WEEKLY_EMAIL !== 'true') return 'disabled';
  if (
    !env.SELF_EMAIL ||
    !env.GMAIL_CLIENT_ID ||
    !env.GMAIL_CLIENT_SECRET ||
    !env.GMAIL_REFRESH_TOKEN
  )
    throw new Error('Gmail setup required');
  const { start, end } = previousWeek(now);
  const data = await packet(env, start, end);
  const message = mime(
    env.SELF_EMAIL,
    start,
    `Weekly data package (not an AI report).\n\n${JSON.stringify(data, null, 2)}`,
  );
  if (message.length > 4_000_000) throw new Error('Packet too large; use export');
  // Reserve BEFORE network send. An ambiguous timeout is not retried automatically, avoiding duplicate mail.
  const reserved = await env.DB.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?)')
    .bind(start, 'sending', new Date().toISOString())
    .run();
  if (!reserved.meta.changes) return 'already_reserved';
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: env.GMAIL_REFRESH_TOKEN,
        client_id: env.GMAIL_CLIENT_ID,
        client_secret: env.GMAIL_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) throw new Error('Gmail refresh failed');
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('Missing Gmail token');
    const sent = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') }),
    });
    if (!sent.ok) throw new Error('Gmail send failed');
    await env.DB.prepare('UPDATE deliveries SET state=?,updated_at=? WHERE week=?')
      .bind('sent', new Date().toISOString(), start)
      .run();
    return 'sent';
  } catch {
    await env.DB.prepare('UPDATE deliveries SET state=?,updated_at=? WHERE week=?')
      .bind('needs_review', new Date().toISOString(), start)
      .run();
    return 'needs_review';
  }
}
