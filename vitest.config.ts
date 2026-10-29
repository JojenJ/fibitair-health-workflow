import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/helpers/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
