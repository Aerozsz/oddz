# Sweepwatch — INTCUSDT

Real-time liquidity and trigger-cluster monitoring for the Binance USDⓈ-M
`INTCUSDT` perpetual.

It exists to answer one question continuously: **how much would it cost, right
now, to set a cascade off — and is that number falling?**

## The mechanism it tracks

Thin depth does not fire anything by itself. Price still has to reach a trigger
level. What withdrawal changes is how much size that takes.

1. Market makers pull quotes. Depth in the band around mid drops.
2. An ordinary-sized order now walks price much further than it used to.
3. Price reaches a cluster of stops or liquidations. Those are market orders in
   the direction of travel, so they execute regardless of price.
4. That fired volume walks the (already thinner) book into the next cluster.
5. The chain ends when there is nothing left below, or when flow runs out.

Only two of the three common trigger types extend a move. Stops and
liquidations are market orders in the direction of travel — they push.
Take-profits are resting limit orders on the far side — a take-profit above is
an ask that a rally has to eat through, so it absorbs. The two are kept on
opposite sides of the cluster map and are never summed.

## What is measured vs what is modelled

| | Source | Status |
|---|---|---|
| Order book | `@depth@100ms` diff stream, locally maintained | measured, continuous |
| Trades | `@aggTrade` | measured |
| Liquidations | `@forceOrder` | measured |
| Mark / index / funding | `@markPrice@1s` | measured |
| Bars | `@kline_1m` | measured |
| Open interest | `/fapi/v1/openInterest` | **polled, 20s** — no stream exists |
| Cluster sizes | leverage ladder + prior structure + round numbers | **modelled** |

Nobody publishes a book of stops. Cluster magnitudes are estimates anchored to
open interest, and the UI marks confidence by opacity — levels where
liquidations have actually printed render solid, inference renders faint.

## The one metric worth the streaming architecture

Depth falling is ambiguous. It can mean liquidity was **consumed** (trades ate
it, which is ordinary and self-limiting) or **withdrawn** (quotes cancelled with
nothing printed against them, which is the precondition above).

They separate because trades are observable. Over a window:

```
Δdepth = added − consumed − withdrawn
```

`consumed` is known from the trade tape, so the residual is cancellation. This
is why the book is maintained from a continuous diff feed rather than polled:
sampled snapshots lose exactly the fast pulls the metric exists to catch.

## Cluster sources

- **round** — psychological levels, scaled to price magnitude
- **extremes** — prior day/week/month highs and lows, cash-session extremes,
  swing pivots; offset past the level, because stops rest beyond what they
  protect, not on it
- **leverage ladder** — a volume-weighted profile of where positions were
  opened, mapped through `long liq ≈ P·(1 − 1/L + mmr)` per leverage tier
- **observed** — liquidations off the live feed, which both confirm a level and
  mark it partly *spent*: forced flow discharges once

`INTCUSDT` caps at 10x, not 100x, so even the most levered tier liquidates
roughly 8.5% from entry. The ladder is correspondingly wide and sparse, and the
nearest amplifying level below the mark is usually a stop cluster rather than a
liquidation one.

## Architecture

Data flows **browser → Binance directly**. No server sits in the live path:
one combined WebSocket, opened by the visitor, carries every stream. That keeps
latency at the wire, avoids rate limits entirely, and means Vercel's egress IPs
are never the thing Binance is deciding about.

REST is used only where no stream exists (contract metadata, the snapshot that
seeds the diff feed, klines, open interest). Those calls try Binance directly
first and fall back once to `/api/binance/*`, a region-pinned proxy limited to a
fixed allowlist of public read-only paths. The WebSocket has no fallback — a
network that blocks `fstream.binance.com` will stop the page, and it says so.

```
lib/binance/   streams.ts (combined WS)  book.ts (U/u/pu sync)  rest.ts (fallback)
lib/metrics/   depth.ts  withdrawal.ts  clusters.ts  cascade.ts  session.ts
lib/engine.ts  owns all state outside React; republishes a snapshot at 10 Hz
components/    canvas cluster map, liquidity panel, cascade chain, tapes
```

React subscribes through `useSyncExternalStore`. Incoming socket data is never
throttled; only the render is paced.

## Nasdaq session

The perp trades 24/7; Intel does not. When the cash market is shut there is no
arbitrage anchor and no cash-market maker to lean on, so depth is structurally
thinner and the first cluster is structurally cheaper to reach. Session phase is
shown in the header and is part of reading everything else. Market holidays and
half-days are not modelled.

## Local development

```bash
npm install
npm run dev     # http://localhost:3000
npm run build
```
