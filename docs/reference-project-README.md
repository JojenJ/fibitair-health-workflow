# google-health-worker-mcp

Personal remote MCP server on Cloudflare Workers that connects Claude (iPhone / desktop / web via Custom Connector) to **Google Health API v4** — read activity, sleep, heart rate, SpO₂, HRV, respiratory rate, skin temperature, weight and nutrition.

> All 16 `HealthProvider` read methods run on Google Health v4 (`GoogleHealthProvider`). This edition exposes the read surface; the write/delete methods are present in the interface but not implemented.

Based on [tachibanayu24/fitbit-googlehealth-mcp](https://github.com/tachibanayu24/fitbit-googlehealth-mcp) (MIT). Upstream docs preserved under `docs/upstream-*`.

## Why

The legacy Fitbit Web API shuts down in **September 2026**. Google Health API v4 is its successor. This project keeps the upstream's Workers / Hono / MCP architecture — the only form factor usable from the Claude mobile app — and swaps the data source to v4.

## Capabilities

| Domain | Methods | Status |
|---|---|---|
| Profile · devices | `getProfile`, `listDevices` | ✅ live |
| Activity | `getActivityTimeSeries` (steps/distance/calories/floors), `getDailySummary` | ✅ live |
| Exercise | `getExerciseList` | ✅ live (mapping unverified — no exercise data on account) |
| Sleep | `getSleep`, `getSleepRange` (stage mapping) | ✅ live |
| Heart | `getHeartRateRange` (resting), `getHeartRateIntraday` (downsampled) | ✅ live |
| Metrics | `getHRV`, `getSpO2`, `getRespiratoryRate`, `getSkinTemperature`, `getCardioFitness` | ✅ live |
| Body · food | `getBodyLog` (weight), `getFoodLog` (nutrition) | ✅ live |

The `HealthProvider` interface also declares write/delete methods (`logFood`, `logWeight`, …); in this edition they throw "not implemented".

Skin temperature is confirmed **absolute °C + baseline**; the mapper reports the nightly-relative delta. Reconcile calls omit `filter` (v4 filter members are type-specific and mostly 400); range narrowing is done client-side on the civil date.

## Setup

One-time bootstrap.

**Google Cloud (console):**

1. Create a project → APIs & Services → enable **Health API**.
2. OAuth consent screen (User type **External**): add the read scopes below, add your own Gmail as a **test user**, then **Publish the app to "In production"**. (Testing-mode refresh tokens expire after 7 days, which breaks an unattended Worker.)
3. Credentials → create an OAuth client (**Web application**), Authorized redirect URI `http://127.0.0.1:8787/oauth/callback`. Note the client id / secret.

Read scopes (prefix `https://www.googleapis.com/auth/`):

```
googlehealth.profile.readonly
googlehealth.settings.readonly
googlehealth.activity_and_fitness.readonly
googlehealth.health_metrics_and_measurements.readonly
googlehealth.sleep.readonly
googlehealth.nutrition.readonly
```

> Do **not** add `include_granted_scopes` to the authorization URL — mixing legacy scopes can cause `403`s on reads. Use `access_type=offline&prompt=consent` to get a refresh token.

**This repo:**

```bash
pnpm install                      # you run this — deps are never auto-installed

cp wrangler.toml.example wrangler.toml
pnpm wrangler kv namespace create TOKENS   # paste ids into wrangler.toml
pnpm wrangler kv namespace create CACHE

export GOOGLE_CLIENT_ID=...        # the Web OAuth client from above
export GOOGLE_CLIENT_SECRET=...
pnpm run setup:google             # browser consent -> prints wrangler secret/kv commands

pnpm deploy                       # then add the Custom Connector in claude.ai:
                                  #   https://<worker>.workers.dev/mcp/<MCP_SHARED_SECRET>
```

`MCP_SHARED_SECRET` must be **hex** (`openssl rand -hex 32`) — it is embedded in the URL path, so base64's `/` would break routing. Secrets live in Cloudflare, tokens in KV — never in this repo.

## Architecture

```
Claude (mobile / desktop / web)
  │ Streamable HTTP  /mcp/<SECRET>
  ▼
Cloudflare Workers
  ├─ guard (shared secret + Anthropic CIDR allowlist)
  ├─ @hono/mcp (Streamable HTTP transport)
  └─ McpServer → tools/* → HealthProvider
                              └─ GoogleHealthProvider → health.googleapis.com/v4
  KV: TOKENS (Google OAuth refresh/access) · CACHE (read cache)
```

Two auth layers: **① Claude → Worker** = shared secret in the URL path + Anthropic CIDR allowlist; **② Worker → Google** = KV refresh token, auto-refreshed. The tools layer is provider-agnostic (`HealthProvider`); swapping Fitbit → Google was one line in `src/server.ts`.

## Development

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest (113 tests)
pnpm lint          # biome
pnpm deploy        # wrangler deploy
```

Provider field mappings are covered by fixture tests using shapes probed from the live v4 API. Deployment: connect the repo in **Cloudflare Workers Builds** (dashboard → Workers → Builds → connect GitHub) so `push main` runs install + test + `wrangler deploy` automatically.

## Documents

| Doc | What |
|---|---|
| `docs/upstream-*.md` | Upstream README / research / journal (Fitbit-era reference) |

## License

MIT — see [LICENSE](./LICENSE) (upstream copyright preserved).
