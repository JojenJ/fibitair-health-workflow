import { describe, expect, it } from 'vitest';
import type { WorkflowEnv } from '../../src/workflow/core';
import { oauthFetch, publicOrigin } from '../../src/workflow/oauth';

const ctx = {} as ExecutionContext;

describe('deployment-specific OAuth origin', () => {
  it('accepts a new deployment and normalizes a trailing slash', () => {
    expect(publicOrigin('https://health.example.com/')).toBe('https://health.example.com');
  });

  it.each([
    undefined,
    '',
    'http://health.example.com',
    'https://user:pass@health.example.com',
    'https://health.example.com/path',
    'https://health.example.com/?x=1',
    'https://health.example.com/#x',
  ])('rejects invalid configured origins: %s', (value) => {
    expect(() => publicOrigin(value)).toThrow();
  });

  it('fails closed before OAuth access when deployment configuration is missing', async () => {
    const result = await oauthFetch(
      new Request('https://health.example.com/live-mcp'),
      {} as WorkflowEnv,
      ctx,
    );
    expect(result.status).toBe(503);
  });

  it('rejects a request host different from the configured issuer', async () => {
    const result = await oauthFetch(
      new Request('https://attacker.example/live-mcp'),
      {
        PUBLIC_ORIGIN: 'https://health.example.com',
      } as WorkflowEnv,
      ctx,
    );
    expect(result.status).toBe(403);
  });

  it('advertises the new deployment in protected resource metadata', async () => {
    const result = await oauthFetch(
      new Request('https://health.example.com/.well-known/oauth-protected-resource/live-mcp'),
      {
        PUBLIC_ORIGIN: 'https://health.example.com',
      } as WorkflowEnv,
      ctx,
    );
    expect(result.status).toBe(200);
    const metadata = (await result.json()) as { resource: string; authorization_servers: string[] };
    expect(metadata.resource).toBe('https://health.example.com/live-mcp');
    expect(metadata.authorization_servers).toEqual(['https://health.example.com']);
  });
});
