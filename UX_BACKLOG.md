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

## Recommended next (in value order)

1. **Live verification sweep** — click through every page on production with
   real data; tune grid density per page (needs a human or a reachable
   deployment; the sandbox is firewalled).
2. Mobile pass at 360–430px: nav, hero, board columns, table min-widths.
3. Verify Kalshi/Manifold/Metaculus outbound links on fresh snapshots.
4. Lead/lag + Overround: same density v2 treatment as Resolving got.
5. Watchlist alert rules (schema + UI panel from the handoff design).
6. Onchain trader-PnL leaderboard (whale tracking) — roadmap headline.
