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
- [x] **Deployed to Vercel production** — LIVE at https://oddz-ruby.vercel.app
      (project prj_3BEhAzYqcrFUpAjtr2Q8QdXYf4zE). Deployed via clone bootstrap
      during a brief repo-public window; migrations applied to Neon, venues
      seeded, first snapshot ingested Polymarket 100 + Kalshi 600 markets.
- [x] Verify build logs clean, migration applied, venues seeded
- [x] /api/health ok:true, db connected; first snapshot ingested real data (Polymarket, Kalshi live; Manifold/Metaculus in same run)
- [x] Cron: Vercel Hobby caps at 1/day, so vercel.json cron is daily (backup) and .github/workflows/snapshot.yml runs every 5 min. NEEDS: repo Actions secret CRON_SECRET added by user.
- [ ] Optional: set NEXT_PUBLIC_SITE_URL=https://oddz-ruby.vercel.app env var (sitemap/robots absolute URLs) and redeploy

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

## Phase: pre-launch audit (IN PROGRESS — do this before any marketing)

Security + API-validation pass DONE (commit f3f90e1): fixed limit/offset
cap-bypass (NaN→no-LIMIT dumped whole table), history hours=NaN 500
crash, /api/health raw-error leak, api_usage unbounded growth, StarButton
alert(). Remaining audit scope, each its own cycle — verify against the
running server, fix, commit:

- [ ] Frontend/UX: load every page at 375px and 1280px (Playwright, chromium
      at /opt/pw-browsers). Nav bar has 7 links now — check mobile overflow/wrap.
      Verify each page's empty state (fresh DB) and loading.tsx match. Confirm
      404 path. Check hydration risk from timeAgo() using Date.now() in server
      components (may need a client relative-time component or absolute ts).
- [ ] Accessibility: focus-visible rings, contrast of zinc-500/600 on #09090b,
      aria on sparkline SVG, keyboard nav of star/filters.
- [ ] Backend data correctness: adapter price normalization per venue
      (kalshi cents, polymarket JSON-string parse failure handling), the
      600-markets/venue silent cap (PAGES_PER_VENUE×PAGE_SIZE) — log when a
      venue is truncated. listMarkets inner-join drops markets with no
      snapshot (intended? confirm). Matcher O(n²) fuzzy blowup at real scale.
- [ ] Verify snapshot worker fails gracefully per-venue on API errors
      (Promise.allSettled) and still records the run — run workers/run-once.ts.
- [ ] Rate-limiter: x-forwarded-for leftmost is client-influenced off-Vercel;
      confirm Vercel sets it trustworthily, else use a platform header.
- [ ] Add security headers (CSP, X-Content-Type-Options, Referrer-Policy) via
      next.config headers() or middleware.
- [ ] drizzle-kit generate must report "no changes" (schema/migration drift check).

## Phase: DefiLlama-grade analytics & alpha (THE BIG BUILD — no compromise)

Base layer (venues → events → markets → outcomes → snapshots) is done.
This phase is the downstream derived-data + alpha, distilled for every
audience (casual bettor → weekend gambler → sophisticated trader →
whale-watcher). Competitors (Oddpool, PredictMarketCap, Converge) already
ship much of this; we build it all, better UX, then go to market.

Derivable from CURRENT data (do these first):
- [x] Cross-venue arbitrage scanner (/arbitrage)
- [x] Overview dashboard: total volume, venue dominance, category rollup (/overview)
- [x] "What you'd win" payout calculator w/ best-venue payout (market detail)
- [x] Consensus / fair-value odds: volume-weighted, flags mispriced venue (/consensus)
- [ ] Overround / vig per market (sum of outcome prices); multi-outcome
      buy-all-outcomes arb detection
- [x] New markets feed: recently first-seen listings (/new)
- [ ] Unusual activity: volume/liquidity surge vs trailing history
- [x] Resolution calendar: markets ending soon (/resolving)
- [x] Venue pages /venues/[slug]: per-venue volume, market count, share, top markets
- [x] Category pages /categories/[slug]: volume, market count, top markets
- [ ] Lead/lag analysis: which venue moves first on matched events (front-run signal)
- [ ] Market efficiency / liquidity depth score per market
- [ ] Trending: velocity of volume + price move combined
- [ ] Casual-bettor mode: dead-simple mobile "should I bet & where" flow

Needs NEW data sources (bigger lifts):
- [ ] Whale tracking: Polymarket positions are onchain (Polygon) — index large
      holders/positions per market (the highest-demand competitor feature)
- [ ] Orderbook depth: venue CLOB endpoints (Polymarket CLOB, Kalshi orderbook)
      for real slippage-aware arb and liquidity depth
- [ ] News integration: headlines tied to markets (RSS/news API), sentiment
- [ ] Real-time: WebSocket feeds from venues instead of 5-min polling

Distribution / product surface:
- [ ] Alerts: odds-move + arb + new-market via email/Telegram (Trader tier hook)
- [ ] Daily digest email (subscribers table already captures signups)
- [ ] Embeddable widgets (odds badge) for blogs/Twitter — distribution flywheel
- [ ] Public API expansion: arbitrage, consensus, movers endpoints

## Phase: data quality (needs live prod data first)

- [ ] Inspect real cross-venue matches on prod; tune FUZZY_THRESHOLD and stopwords against actual Polymarket↔Kalshi titles
- [x] Multi-outcome market support end-to-end (Polymarket outcomes>2 render, divergence excludes correctly)
- [x] Snapshot retention policy: roll up snapshots older than 30d to hourly (daily 04:0x UTC prune piggybacked on cron)
- [x] Per-venue error alerting: /status highlights venue failing >=3 consecutive runs

## Phase: trader features

- [x] /movers page: biggest YES swings over 6h/24h/7d windows, all venues
- [x] /docs API documentation page (endpoints, params, rate limits)
- [x] scripts/create-api-key.ts — mint keys (prints raw once, stores hash)
- [x] Watchlists — anonymous wid cookie, star toggle on rows + detail, /watchlist page (docs/watchlists-design.md)
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
