# oddz — Development Roadmap & Autonomous-Cycle State

> **This file is the single source of truth for autonomous development
> cycles.** Every automated session reads this first, implements the next
> unchecked item, updates the checkboxes, commits, and pushes. Keep it
> accurate — a wrong checkbox wastes a whole cycle.

## Project

Prediction-market odds aggregator: unified market list, cross-venue
divergence, odds history, public API. Stack: Next.js 15 App Router,
Neon Postgres + Drizzle, Tailwind, Recharts. Branch:
`claude/refactor-project-structure-JIiXS` on `aerozsz/oddz`.

## Deployment state

- Vercel team: `team_SHExwgJuZWO8si3H3Nwf7xho`, project name `oddz` (create on first deploy)
- Deploy method: `mcp__Vercel__deploy_to_vercel` file upload — run
  `scripts/build-deploy-payload.mjs` (needs env `DATABASE_URL_DIRECT`,
  `DATABASE_URL_POOLED`, `CRON_SECRET` — values live in the session cron
  prompt, NOT in git) and upload the JSON it emits at
  `/tmp/deploy-files.json`.
- DB: Neon project (Frankfurt), migration `0000_dashing_silvermane` NOT yet applied to prod
- [ ] **Deploy to Vercel production** (blocked only on mcp__Vercel tools being connected)
- [ ] Verify build logs clean, migration applied, venues seeded
- [ ] Hit `/api/health` on the deployment — expect `ok: true`, then trigger `/api/cron/snapshot?key=<CRON_SECRET>` once and re-check health shows all four venues fresh
- [ ] Confirm Vercel cron (every 5 min, self-authenticating path in uploaded vercel.json) runs: `/status` shows runs accumulating
- [ ] Set NEXT_PUBLIC_SITE_URL rebuild once the production URL is known

## Phase: core UX (in progress)

- [x] Market list with search, venue filter, volume sort, sparklines
- [x] Market detail with 7d history chart + referral CTA
- [x] Divergence table (cross-venue YES spread)
- [x] Status page (runs, freshness)
- [x] /api/health deploy verification
- [x] loading.tsx skeletons for /markets, /divergence, /markets/[id]
- [x] error.tsx + not-found.tsx (global + markets segment)
- [x] Pagination on /markets (offset-based, ?page= param, 100/page)
- [x] Category filter chips above market table (top 8 categories by count)
- [x] Sort control on /markets (volume | liquidity | recently-updated)
- [x] Mobile: horizontal-scroll table with min-width (card collapse deferred)

## Phase: events & SEO

- [x] /events/[id] page: all venue legs, per-leg price, combined overlay chart
- [x] Link divergence rows and market detail to their event page
- [x] app/sitemap.ts (markets + events, top 1000 by volume)
- [x] app/robots.ts
- [x] generateMetadata on /markets/[id] (title = question, description = prices)
- [x] OpenGraph card metadata (static; dynamic og-image still open)
- [x] Landing page: live stats strip (market count, venues, snapshot count)

## Phase: data quality (needs live prod data first)

- [ ] Inspect real cross-venue matches on prod; tune FUZZY_THRESHOLD and stopwords against actual Polymarket↔Kalshi titles
- [x] Multi-outcome market support end-to-end (Polymarket outcomes>2 render, divergence excludes correctly)
- [x] Snapshot retention policy: roll up snapshots older than 30d to hourly (daily 04:0x UTC prune piggybacked on cron)
- [x] Per-venue error alerting: /status highlights venue failing >=3 consecutive runs

## Phase: trader features

- [x] /movers page: biggest YES swings over 6h/24h/7d windows, all venues
- [x] /docs API documentation page (endpoints, params, rate limits)
- [x] scripts/create-api-key.ts — mint keys (prints raw once, stores hash)
- [ ] Watchlists — design approved in docs/watchlists-design.md (anonymous wid cookie, migration 0002, star toggle + /watchlist page); BUILD NEXT
- [x] Dynamic OG images per market (next/og ImageResponse, live YES price)

## Phase: monetization surfaces (after live data)

- [x] Gate /api/v1 behind API keys table + `Authorization` header (anon 30/h by IP, free 60/h, pro 3600/h; Postgres fixed-window)
- [x] Landing page pricing section (free / trader $29 / API $99 placeholder)
- [ ] Referral env vars: sign up for Kalshi affiliate program (USER ACTION), set NEXT_PUBLIC_REF_KALSHI
- [x] Email capture on landing (store in `subscribers` table, no provider yet)

## House rules for autonomous cycles

1. Typecheck (`npx tsc --noEmit`) and build (`npx next build` with any
   valid DATABASE_URL/CRON_SECRET env) must pass before every commit.
2. Never commit secrets. The deploy payload generator takes them from env;
   uploaded-only override files carry them to Vercel, git never sees them.
3. Commit + push after every completed item — a cycle can be cut off at
   any moment by usage limits.
4. Local verification DB: `sudo service postgresql start`, role oddz/oddz_dev,
   db oddz; `.env.local` from `.env.example`; `lib/db/demo-seed.ts` gives
   realistic data offline (venue APIs are firewalled in the sandbox).
5. Sandbox resets wipe node_modules and .env.local — `npm install` and
   recreate before verifying.
