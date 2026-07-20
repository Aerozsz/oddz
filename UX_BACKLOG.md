# UX overhaul — state of play

Working branch: `claude/refactor-project-structure-JIiXS`. Every commit
auto-deploys via GitHub Actions (remote Vercel build). `git log --oneline`
tells the story; this file is the review companion.

## Design principles now enforced app-wide

1. **Price-first hierarchy.** The number a trader acts on (YES price, edge,
   delta) is the largest element in its row; meta is quiet mono-caps.
2. **Bars are glyphs, not filler.** Compact fixed-width odds glyphs beside the
   number they explain. Full-width bars only where they're comparative data
   (movers magnitude, heat ranks, uptime strips, histograms).
3. **One motion language.** easeOutQuint + reserved spring, 90/150/240/360ms
   tokens; press-sink on every control, lift+sheen on cards, staggered
   entrances, View Transitions page fades, draw-in sparklines, cross-tint
   theme switch. All instant under prefers-reduced-motion.
4. **Muted semantics.** Desaturated green/red reserved for probability
   meaning; consistent across UI, charts, OG cards, badge, favicon, docs.
5. **Wide screens get columns.** 1280px shell; multi-column boards/grids on
   every list page. No stretched single strips.
6. **No dead ends.** Empty signal pages show the nearest live cross-venue
   gaps (NearMisses) instead of an apology.

## Shipped this session (chronological)

- Auto-deploy fixed (remote Vercel build; CI never touches the DB)
- "Currents" logo everywhere: nav, favicon (both themes), OG cards, hero
- 14 handoff page designs implemented; then density v2 passes on Resolving
  (urgency-coded countdowns, price hero, integrated resolution source),
  New, MarketTable/PriceCell, Consensus (0–100% venue strip + consensus
  tick), Events (venue-position strip, Trade pill)
- Watchlist: donut-ring starred cards, 2/3/4-col grid
- Grouped nav (3 primary + Signals/Discover dropdowns w/ hints, aria-current)
- Snapshot cron 300s timeouts fixed (budget-enforced fetching, signal
  plumbing through fetchJson, capped retry-after, runs never stuck 'running')
- System-preference theme default on first visit
- Homepage hero: venue eyebrow, CTA pair, Currents ambience

## Recommended next (updated)

Verified-shippable-here work is largely done. Remaining items need live access
or a product decision:

1. **Whale tracker / PnL leaderboard** — the headline pay feature. Blocked on
   a Polygon indexer decision (Goldsky subgraph vs Dune API). Needs your call.
2. **Polymarket per-market rewards ingestion** — adapter field additions;
   sandbox is firewalled from the API so the exact schema must be confirmed on
   a machine with network. Surface as a rewards chip on /yields + market pages.
3. **Live data verification** — `/api/admin/stats?key=<CRON_SECRET>` reports
   matcher/book/history counts; decides whether the demoted signal pages
   (consensus/divergence/lead-lag/correlations) need matcher work or just more
   venue overlap. They auto-graduate back to the sidebar once they carry data.
4. Outbound link spot-check Kalshi/Manifold/Metaculus (one live click each).
5. Backtesting sandbox — wait for more resolved-market history.
6. Stripe billing on the existing API-key/tier system (pro funnel).

## Shipped this session (major)

Auto-deploy fix · Currents logo · 16-page handoff redesign + density v2 ·
sidebar nav (data-bearing signals only) · one-screen /discover + /signals ·
/venues (stats + dominance chart) · /yields · /calendar + .ics feed ·
/correlations matrix · category dashboards · Overround sibling-book
reconstruction · market TLDR (verbatim-only) · watchlist alert rules ·
global ⌘K search · admin data-health endpoint · motion system + amped haptics ·
heat-bar fix (volume fallback) · muted palette everywhere.

Resume protocol: read this + ROADMAP.md, `git log --oneline -12`, implement
next unblocked item, typecheck + build, commit, push (auto-deploys).
