import { CONFIG } from "../config";
import type { BandDepth, BookLevel, CostPoint, Wall } from "../types";

/** Notional resting inside each configured band, both sides, in one pass. */
export function bandDepths(bids: BookLevel[], asks: BookLevel[], mid: number): BandDepth[] {
  const out: BandDepth[] = [];
  for (const bps of CONFIG.depthBands) {
    const lo = mid * (1 - bps / 10_000);
    const hi = mid * (1 + bps / 10_000);
    let bidNotional = 0;
    let bidQty = 0;
    for (const l of bids) {
      if (l.price < lo) break; // bids are descending
      bidNotional += l.price * l.qty;
      bidQty += l.qty;
    }
    let askNotional = 0;
    let askQty = 0;
    for (const l of asks) {
      if (l.price > hi) break; // asks are ascending
      askNotional += l.price * l.qty;
      askQty += l.qty;
    }
    out.push({ bps, bidNotional, askNotional, bidQty, askQty });
  }
  return out;
}

/**
 * Aggressive notional required to walk price from mid to `target`.
 * Returns how much the visible book can absorb and whether it runs out first —
 * running out is itself the signal, because it means the move continues into
 * territory where no posted liquidity exists at all.
 */
export function costToPrice(
  levels: BookLevel[],
  target: number,
  side: "bid" | "ask",
): { notional: number; exhausted: boolean; reached: number } {
  let notional = 0;
  let reached = levels[0]?.price ?? target;
  for (const l of levels) {
    const past = side === "bid" ? l.price < target : l.price > target;
    if (past) return { notional, exhausted: false, reached: target };
    notional += l.price * l.qty;
    reached = l.price;
  }
  return { notional, exhausted: true, reached };
}

export function costCurve(bids: BookLevel[], asks: BookLevel[], mid: number): CostPoint[] {
  return CONFIG.costTargetsPct.map((pct) => {
    const down = costToPrice(bids, mid * (1 - pct / 100), "bid");
    const up = costToPrice(asks, mid * (1 + pct / 100), "ask");
    return {
      pct,
      downNotional: down.exhausted ? null : down.notional,
      upNotional: up.exhausted ? null : up.notional,
      downExhausted: down.exhausted,
      upExhausted: up.exhausted,
    };
  });
}

/**
 * Resting size that stands out from its surroundings. These are the absorbing
 * levels: a rally has to eat through a large ask before it can continue, and a
 * sell-off has to eat through a large bid. Unlike stops and liquidations, they
 * work against the move rather than extending it.
 */
export function findWalls(
  bids: BookLevel[],
  asks: BookLevel[],
  mid: number,
  lookBps = 300,
): Wall[] {
  const walls: Wall[] = [];
  for (const [levels, side] of [
    [bids, "bid"],
    [asks, "ask"],
  ] as const) {
    const lo = mid * (1 - lookBps / 10_000);
    const hi = mid * (1 + lookBps / 10_000);
    const inBand = levels.filter((l) => l.price >= lo && l.price <= hi);
    if (inBand.length < 12) continue;
    const notionals = inBand.map((l) => l.price * l.qty).sort((a, b) => a - b);
    const median = notionals[Math.floor(notionals.length / 2)] || 0;
    if (median <= 0) continue;
    for (const l of inBand) {
      const notional = l.price * l.qty;
      const multiple = notional / median;
      if (multiple >= CONFIG.wallMultiple && notional >= CONFIG.wallMinNotional) {
        walls.push({
          price: l.price,
          side,
          notional,
          multiple,
          distBps: ((l.price - mid) / mid) * 10_000,
        });
      }
    }
  }
  return walls.sort((a, b) => b.notional - a.notional).slice(0, 12);
}

/**
 * Notional per basis point in the outer part of the visible book. The cascade
 * simulator uses this to extrapolate past the last posted level — beyond that
 * point nothing is observable, only estimable, and the UI marks the difference.
 */
export function tailDensity(levels: BookLevel[], mid: number, side: "bid" | "ask"): number {
  const innerBps = 50;
  const lo = mid * (1 - innerBps / 10_000);
  const hi = mid * (1 + innerBps / 10_000);
  const outer = side === "bid" ? levels.filter((l) => l.price < lo) : levels.filter((l) => l.price > hi);
  if (outer.length < 5) return 0;
  const notional = outer.reduce((s, l) => s + l.price * l.qty, 0);
  const edge = side === "bid" ? outer[outer.length - 1].price : outer[outer.length - 1].price;
  const spanBps = Math.abs((edge - mid) / mid) * 10_000 - innerBps;
  if (spanBps <= 0) return 0;
  return notional / spanBps;
}
