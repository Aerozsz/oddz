# UX overhaul backlog — fragmented for usage-limit resilience

Working branch: `claude/refactor-project-structure-JIiXS`. Every fragment ends
with typecheck + build + commit + push (auto-deploys via GitHub Actions).
If resuming cold: `git log --oneline -5` to see which fragments landed.

## Quality bar (read this first)

Not "add some transitions". The goal: the app feels engineered — every
interactive element acknowledges the user instantly (<150ms), motion has a
consistent physical language (one easing family, one duration scale), nothing
jumps or flashes, and wide screens get real multi-column layouts, never
stretched single strips. All motion respects `prefers-reduced-motion`.

## Fragment A — motion foundation (globals.css + theme + nav)  [status: DONE]
- Easing/duration design tokens (`--ease-out`, `--ease-spring`, `--dur-*`)
- View Transitions API cross-page fade (progressive enhancement)
- Staggered entrance system (`.stagger`) — children cascade in 30ms apart
- Refined press physics (spring scale), card hover sheen, table row accent bar
- Accent-tinted text selection, caret color, mobile tap-highlight removal
- Buttery theme switch: temporary global color transition class on `<html>`
- Nav dropdown: scale/fade origin-top entrance

## Fragment B — apply everywhere + wide layouts  [status: DONE]
- `.stagger` on every grid/list page (trending, movers, new, activity,
  divergence, overround, consensus, arbitrage, resolving, status)
- Resolving → 3-column urgency board (today | this week | later)
- Arbitrage, Consensus → 2-col card grids (kill the A4 strips)
- Table row hover: inset accent bar everywhere (MarketTable + all tables)
- Watchlist empty state: pill button w/ spring hover

## Fragment C — detail polish + verification  [status: DONE]
- Sparkline draw-in animation (stroke-dashoffset) in MarketTable
- Market detail page: entrance stagger, chart fade-in, payout calc physics
- Homepage + overview: stat card hover lift, stagger
- Build + screenshot verification (dark/light, 1440px), commit, push

## Fragment D — if time remains  [status: DONE]
- Remove temporary /api/debug/pm endpoint
- Empty cross-venue pages: richer empty states w/ near-miss data
- Number tabular alignment audit (`tabular-nums` everywhere)

## Fragment E — chart theming + detail motion + leadlag empty state  [status: DONE]
- PriceHistoryChart / EventOverlayChart / VolumeChart: muted brand colors,
  themed tooltips (inline style var()), entrance fade
- Market detail page motion pass (rise/stagger)
- Lead/lag empty state gets NearMisses panel

## Fragment F — snapshot cron timeout mitigation  [status: DONE]
- Prod logged 2× "Task timed out after 300 seconds" on /api/cron/snapshot
- Parallelize venue fetches if sequential; per-venue time budget so one slow
  venue can't kill the whole run; keep Kalshi page cap
