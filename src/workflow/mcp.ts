import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { dateSchema, packet, type WorkflowEnv } from './core';
import { fetchLatest } from './live';

export async function handleMcp(c: Context<{ Bindings: WorkflowEnv }>) {
  const server = new McpServer(
    { name: 'fibitair', version: '1.1.0' },
    {
      instructions:
        'When asked for recent health, call fetch_latest_health first. It fetches Google Health now, archives observations and returns dates and collection status. Do not substitute weekly Gmail packets for a live fetch. Use Gmail only for recent activity context or an explicitly dated fallback. Missing data is not zero. A successful fetch does not force the wearable to sync.',
    },
  );
  server.registerTool(
    'fetch_latest_health',
    {
      description:
        'Use this when the user asks about recent health, sleep, recovery or fatigue. Fetch Google Health now, update the private archive, and return the last 1–7 days including today plus baseline/context. No health data is edited in Google. Always inspect refreshSucceeded, dates and missing data.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe('Number of recent days including today; default 7'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ days }) => ({
      content: [{ type: 'text', text: JSON.stringify(await fetchLatest(c.env, days)) }],
    }),
  );
  server.registerTool(
    'health_packet',
    {
      description:
        'Read archived historical health data for a specific date range; does not refresh. For current health call fetch_latest_health instead.',
      inputSchema: { start: dateSchema, end: dateSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ start, end }) => ({
      content: [{ type: 'text', text: JSON.stringify(await packet(c.env, start, end)) }],
    }),
  );
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.body(null, 202);
}
