# oddz

**Every prediction market. One screen.** Live odds, cross-venue arbitrage, and
where the smart money is moving — aggregated from Polymarket, Kalshi, Manifold
and Metaculus.

## What it does

- **Aggregation** — one searchable table of every live market across four
  venues, with price history, sparklines and volume.
- **Signals** — cross-venue arbitrage (buy YES + NO under $1), volume-weighted
  consensus fair value, divergence between venues, lead/lag (which venue moves
  first), overround (vig & buy-all arbs), biggest movers.
- **Discovery** — trending (heat = price swing × volume), new listings,
  resolving-soon board with live countdowns, unusual volume activity.
- **Watchlist + alerts** — star markets (anonymous cookie, no account), donut
  cards, and alert rules (YES crosses a threshold / 24h move) evaluated
  against live snapshots.
- **Public API** — JSON endpoints for markets, history, arbitrage, consensus,
  movers, plus an embeddable SVG odds badge. See `/docs`.

## Stack

Next.js 15 (App Router, RSC) · TypeScript · Tailwind (CSS-variable design
tokens, dark/light) · Drizzle ORM · Neon Postgres · Zod at every API boundary.

## Architecture

```
lib/sources/*        one adapter per venue behind a MarketSource interface
workers/snapshot.ts  paged, time-budgeted ingest -> markets + price_snapshots
lib/normalize/       canonical-key matcher links the same event across venues
features/*           vertical slices: queries + components per feature
app/*                thin pages; analytics SQL lives in feature queries
```

Snapshots run via `/api/cron/snapshot` (GitHub Actions every 5 min; secured by
`CRON_SECRET`). Ingest is budget-enforced (210s) so a degraded venue can only
truncate its own coverage — never the run. History older than 30 days is
thinned to hourly resolution (retention rollup, daily).

## Development

```sh
npm install
DATABASE_URL=postgres://... npm run db:migrate
npm run snapshot:once   # ingest live data
npm run dev
```

`npm run typecheck` and `npm run build` must pass before pushing.

## Operating the product

- **Ingest**: GitHub Actions hits `/api/cron/snapshot?key=<CRON_SECRET>` every
  5 minutes. Budget-enforced (210s); one slow venue can only truncate itself.
  Daily retention rollup thins history older than 30 days to hourly.
- **Health**: `/status` (public) shows uptime strips + recent runs;
  `/api/health` for machines; `/api/admin/stats?key=<CRON_SECRET>` answers
  "why is page X empty" with matcher/book/history numbers.
- **Alerts**: watchlist rules evaluate lazily on page view; fired count
  badges the sidebar via `/api/alerts/summary`.
- **Calendar**: `/api/calendar` serves an .ics feed — personal (watchlist)
  when the `wid` cookie exists, else the biggest dated books.
- **Signals policy**: only pages that always carry data live in the sidebar;
  matcher/history-dependent pages (consensus, divergence, lead/lag,
  correlations) are reachable from /signals and graduate back once
  `/api/admin/stats` shows cross-venue events flowing.
- **Secrets**: `DATABASE_URL`, `CRON_SECRET` (Vercel env). Never in git.

## INTC foundry monitor

A focused, real-time watch for the news that actually reprices Intel stock —
foundry catalysts (a named 18A/14A external customer, capex, foundry P&L,
separation), not quarterly beats. Sources: Google News RSS (narrow foundry
queries), Intel's newsroom, and SEC EDGAR 8-K/10-Q/10-K filings. A weighted
classifier (`lib/intc/classify.ts`) gates for foundry relevance and scores
severity + direction; new items above `INTC_MIN_SEVERITY` are pushed instantly
to Telegram / ntfy / a webhook (all optional). Deduped exactly-once via a
deterministic id, so a re-poll never double-pushes.

- **Feed + heartbeat**: `/intc`. **Tick**: `/api/cron/intc` (Bearer
  `CRON_SECRET`), driven every minute by `.github/workflows/intc-monitor.yml`.
- **Local run**: `npm run intc:once`. **Channels**: see `.env.example`.
- **Design + thesis**: `docs/intc-foundry-monitor.md`.

## Peace ↔ War monitor

An omnisourced, at-a-glance tracker for Trump's market-moving announcements on
one bipolar axis — escalation (risk-off) ↔ de-escalation (risk-on). A live
**tilt gauge** (recency/intensity-weighted net of the last 48h) sits above a
**theater strip** (Russia–Ukraine, Middle East, China–Taiwan, N. Korea,
Trade) and **two side-by-side columns** so both sides are always in view;
click a theater to scope everything to it. Classifier scores each side
independently (`lib/geo/classify.ts`); genuinely mixed headlines land in a
Mixed lane rather than being force-picked. Sources: Google News RSS + Trump's
Truth Social feed (`TRUTH_SOCIAL_RSS_URL`).

- **Dashboard**: `/geopolitics`. **Tick**: `/api/cron/geo`, driven by
  `.github/workflows/geo-monitor.yml`. **Local run**: `npm run geo:once`.
- **Design + rationale**: `docs/geopolitics-monitor.md`.

Both monitors share one foundation: feed parsing/fetch (`lib/feeds/`) and push
channels (`lib/notify/channels.ts`).

## Deployment

Every push to the working branch auto-deploys: GitHub Actions hands the source
to Vercel, which builds remotely with production env vars
(`.github/workflows/deploy.yml`). The build runs migrations
(`drizzle-kit migrate`) before `next build`, so schema changes ship with the
code that needs them.

---

Oddz aggregates public prediction-market data. Not affiliated with any venue.
Not financial advice.
