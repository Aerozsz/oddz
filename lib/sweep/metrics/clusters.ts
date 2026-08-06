import { CONFIG } from "../config";
import type { Cluster, ClusterSource, Direction, Kline, Liquidation, Wall } from "../types";
import { inRegularSession } from "./session";

/**
 * Where forced flow sits.
 *
 * Nothing here is a claim to see other people's orders — Binance publishes no
 * stop or liquidation book. Four independent estimators are combined instead,
 * and each level carries the sources that produced it so the reader can tell
 * evidence from inference:
 *
 *   round      — psychological levels, weak individually, everywhere at once
 *   extremes   — prior highs and lows, where protective stops actually rest
 *   leverage   — a liquidation ladder built from where positions were opened
 *   observed   — liquidations that have already printed, from the live feed
 *
 * Only the last is measurement. It is also the only one that tells you a
 * cluster has been *spent*: forced flow fires once, and a level that has
 * already discharged cannot discharge again.
 *
 * Amplifying and absorbing levels are kept apart deliberately. Stops and
 * liquidations are market orders in the direction of travel, so they extend a
 * move and can chain. Resting limit orders — take-profits, maker walls — sit
 * on the far side and absorb. Sizing them together would be wrong in sign.
 */

interface WeightedLevel {
  price: number;
  weight: number;
  source: ClusterSource;
}

/* ------------------------------------------------------------------ round */

export function roundLevels(mid: number, rangePct: number): WeightedLevel[] {
  const out: WeightedLevel[] = [];
  const seen = new Map<number, number>();
  const lo = mid * (1 - rangePct / 100);
  const hi = mid * (1 + rangePct / 100);

  for (let exp = -2; exp <= 3; exp++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * Math.pow(10, exp);
      if (step < mid * 0.0025 || step > mid * 0.12) continue;
      // Larger round numbers carry more weight than the small ones between them.
      const weight = step / mid;
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
        const price = Number(p.toFixed(6));
        seen.set(price, Math.max(seen.get(price) ?? 0, weight));
      }
    }
  }
  for (const [price, weight] of seen) out.push({ price, weight, source: "round" });
  return out;
}

/* --------------------------------------------------------------- extremes */

export function extremeLevels(
  daily: Kline[],
  minutes: Kline[],
  mid: number,
): WeightedLevel[] {
  const out: WeightedLevel[] = [];
  const push = (price: number, weight: number, source: ClusterSource) => {
    if (Number.isFinite(price) && price > 0) out.push({ price, weight, source });
  };

  // Stops rest *past* the level they protect, not on it.
  const buf = CONFIG.stopBufferPct / 100;
  const below = (p: number) => p * (1 - buf);
  const above = (p: number) => p * (1 + buf);

  if (daily.length >= 2) {
    const prev = daily[daily.length - 2];
    push(above(prev.high), 1.0, "prior-high");
    push(below(prev.low), 1.0, "prior-low");

    const week = daily.slice(-6, -1);
    if (week.length) {
      push(above(Math.max(...week.map((k) => k.high))), 1.3, "prior-high");
      push(below(Math.min(...week.map((k) => k.low))), 1.3, "prior-low");
    }
    const month = daily.slice(-21, -1);
    if (month.length) {
      push(above(Math.max(...month.map((k) => k.high))), 1.6, "prior-high");
      push(below(Math.min(...month.map((k) => k.low))), 1.6, "prior-low");
    }
  }

  // Cash-session extremes. The perp runs through the close, so the levels the
  // cash session printed stay live as reference points long after Nasdaq shuts.
  const regular = minutes.filter((k) => inRegularSession(k.openTime));
  if (regular.length > 30) {
    const daySpanMs = 24 * 3600_000;
    const latest = regular[regular.length - 1].openTime;
    const todays = regular.filter((k) => latest - k.openTime < daySpanMs * 0.5);
    if (todays.length > 10) {
      push(above(Math.max(...todays.map((k) => k.high))), 1.2, "session-high");
      push(below(Math.min(...todays.map((k) => k.low))), 1.2, "session-low");
    }
  }

  // Intraday swing pivots: a bar whose high dominates N bars either side.
  const n = CONFIG.pivotStrength;
  const bars = compress(minutes, 5);
  for (let i = n; i < bars.length - n; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    // Recent pivots matter more than stale ones.
    const recency = 0.4 + 0.6 * (i / bars.length);
    if (isHigh) push(above(bars[i].high), 0.7 * recency, "pivot-high");
    if (isLow) push(below(bars[i].low), 0.7 * recency, "pivot-low");
  }

  // A prior low above the current price has already been swept; the stops that
  // sat under it are gone. Same for a prior high below. Keep only live ones.
  return out.filter((l) =>
    l.source.endsWith("high") ? l.price > mid : l.price < mid,
  );
}

function compress(minutes: Kline[], factor: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < minutes.length; i += factor) {
    const chunk = minutes.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({
      openTime: chunk[0].openTime,
      open: chunk[0].open,
      high: Math.max(...chunk.map((k) => k.high)),
      low: Math.min(...chunk.map((k) => k.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, k) => s + k.volume, 0),
      quoteVolume: chunk.reduce((s, k) => s + k.quoteVolume, 0),
      closed: true,
    });
  }
  return out;
}

/* --------------------------------------------------------------- leverage */

/**
 * Where positions were opened, inferred from traded volume by price and decayed
 * so that stale inventory stops dominating. Each entry bucket implies a
 * liquidation price per leverage tier:
 *
 *     long  liq ≈ P · (1 − 1/L + mmr)
 *     short liq ≈ P · (1 + 1/L − mmr)
 *
 * INTCUSDT caps at 20x, so the most levered tier liquidates roughly 3.4%
 * from entry rather than the sub-1% of a 100x crypto perp. The ladder is
 * correspondingly wide and sparse, which is worth knowing: the first cluster
 * below is usually a stop cluster, not a liquidation one.
 */
export function leverageLadder(
  minutes: Kline[],
  mid: number,
  longShare: number,
): WeightedLevel[] {
  if (!minutes.length) return [];
  const now = minutes[minutes.length - 1].openTime;
  const lookback = CONFIG.entryProfileLookbackHours * 3600_000;
  const halfLife = CONFIG.entryProfileHalfLifeHours * 3600_000;
  const bucketSize = mid * 0.001;

  const entries = new Map<number, number>();
  for (const k of minutes) {
    const age = now - k.openTime;
    if (age > lookback) continue;
    const decay = Math.pow(0.5, age / halfLife);
    const w = k.quoteVolume * decay;
    if (w <= 0) continue;
    // Spread the bar's volume across the range it traded.
    const loB = Math.floor(k.low / bucketSize);
    const hiB = Math.floor(k.high / bucketSize);
    const span = Math.max(1, hiB - loB + 1);
    for (let b = loB; b <= hiB; b++) {
      entries.set(b, (entries.get(b) ?? 0) + w / span);
    }
  }

  const mmr = CONFIG.maintenanceMarginRate;
  const liq = new Map<number, { long: number; short: number }>();
  for (const [bucket, w] of entries) {
    const entry = (bucket + 0.5) * bucketSize;
    for (const { leverage, share } of CONFIG.leverageMix) {
      const longLiq = entry * (1 - 1 / leverage + mmr);
      const shortLiq = entry * (1 + 1 / leverage - mmr);
      addTo(liq, Math.floor(longLiq / bucketSize), "long", w * share * longShare);
      addTo(liq, Math.floor(shortLiq / bucketSize), "short", w * share * (1 - longShare));
    }
  }

  const out: WeightedLevel[] = [];
  for (const [bucket, v] of liq) {
    const price = (bucket + 0.5) * bucketSize;
    // A long's liquidation is a forced sell, so it only matters below price;
    // a short's is a forced buy, only above. The other half is already closed.
    if (v.long > 0 && price < mid) out.push({ price, weight: v.long, source: "leverage-long" });
    if (v.short > 0 && price > mid) out.push({ price, weight: v.short, source: "leverage-short" });
  }
  return out;
}

function addTo(
  m: Map<number, { long: number; short: number }>,
  bucket: number,
  side: "long" | "short",
  w: number,
) {
  const cur = m.get(bucket) ?? { long: 0, short: 0 };
  cur[side] += w;
  m.set(bucket, cur);
}

/* --------------------------------------------------------------- observed */

interface ObservedBucket {
  notional: number;
  /** Direction the printed forced flow pushed. */
  pushes: Direction;
}

export function observedLevels(
  liquidations: Liquidation[],
  mid: number,
  now: number,
): Map<number, ObservedBucket> {
  const bucketSize = mid * 0.001;
  const halfLife = CONFIG.observedLiqHalfLifeMin * 60_000;
  const out = new Map<number, ObservedBucket>();
  for (const l of liquidations) {
    const decay = Math.pow(0.5, (now - l.t) / halfLife);
    if (decay < 0.02) continue;
    const bucket = Math.floor(l.price / bucketSize);
    const cur = out.get(bucket) ?? { notional: 0, pushes: l.side === "SELL" ? "down" : "up" };
    cur.notional += l.notional * decay;
    out.set(bucket, cur);
  }
  return out;
}

/* ------------------------------------------------------------------ merge */

const CONFIDENCE: Record<ClusterSource, number> = {
  observed: 0.92,
  "prior-high": 0.55,
  "prior-low": 0.55,
  "session-high": 0.55,
  "session-low": 0.55,
  "pivot-high": 0.45,
  "pivot-low": 0.45,
  "leverage-long": 0.5,
  "leverage-short": 0.5,
  round: 0.28,
};

export interface ClusterInputs {
  mid: number;
  daily: Kline[];
  minutes: Kline[];
  liquidations: Liquidation[];
  walls: Wall[];
  openInterestNotional: number;
  longShortRatio: number | null;
  now: number;
}

export function buildClusters(input: ClusterInputs): Cluster[] {
  const { mid, daily, minutes, liquidations, walls, openInterestNotional, now } = input;
  if (!mid) return [];

  const longShare = input.longShortRatio
    ? input.longShortRatio / (1 + input.longShortRatio)
    : 0.5;

  const structural = [
    ...roundLevels(mid, CONFIG.clusterRangePct),
    ...extremeLevels(daily, minutes, mid),
  ].filter((l) => Math.abs(l.price / mid - 1) * 100 <= CONFIG.clusterRangePct);

  const ladder = leverageLadder(minutes, mid, longShare).filter(
    (l) => Math.abs(l.price / mid - 1) * 100 <= CONFIG.clusterRangePct,
  );

  // Open interest anchors the dollar scale. Without it the map still shows the
  // shape of the ladder, just without meaningful magnitudes.
  const budget = openInterestNotional * CONFIG.liquidatableOiFraction;
  const ladderBudget = budget * 0.7;
  const structuralBudget = budget * 0.3;

  const bins = new Map<number, Cluster>();
  const binSize = mid * (CONFIG.clusterMergePct / 100);
  const key = (price: number) => Math.round(price / binSize);

  const add = (
    price: number,
    notional: number,
    source: ClusterSource,
    confidence: number,
  ) => {
    if (!(notional > 0)) return;
    const k = key(price);
    const existing = bins.get(k);
    const pushes: Direction = price < mid ? "down" : "up";
    if (existing) {
      // Weighted mean price keeps the merged level where the mass actually is.
      const total = existing.notional + notional;
      existing.price = (existing.price * existing.notional + price * notional) / total;
      existing.notional = total;
      existing.confidence = Math.max(existing.confidence, confidence);
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      bins.set(k, {
        price,
        effect: "amplifying",
        pushes,
        notional,
        confidence,
        sources: [source],
        spent: 0,
        distPct: 0,
      });
    }
  };

  const spread = (levels: WeightedLevel[], totalBudget: number) => {
    const total = levels.reduce((s, l) => s + l.weight, 0);
    if (total <= 0) return;
    for (const l of levels) {
      add(l.price, (l.weight / total) * totalBudget, l.source, CONFIDENCE[l.source]);
    }
  };

  spread(structural, structuralBudget);
  spread(ladder, ladderBudget);

  // Printed liquidations both confirm a level and consume it. Confirmation
  // lifts confidence; consumption is subtracted, because forced flow discharges
  // once and a spent cluster cannot fire again.
  const observed = observedLevels(liquidations, mid, now);
  const bucketSize = mid * 0.001;
  for (const [bucket, v] of observed) {
    const price = (bucket + 0.5) * bucketSize;
    if (Math.abs(price / mid - 1) * 100 > CONFIG.clusterRangePct) continue;
    const k = key(price);
    const existing = bins.get(k);
    // v.notional is already time-decayed by observedLevels.
    if (existing) {
      existing.confidence = Math.max(existing.confidence, CONFIDENCE.observed);
      if (!existing.sources.includes("observed")) existing.sources.push("observed");
      existing.spent += v.notional;
    } else {
      bins.set(k, {
        price,
        effect: "amplifying",
        pushes: v.pushes,
        notional: v.notional,
        confidence: CONFIDENCE.observed,
        sources: ["observed"],
        spent: v.notional,
        distPct: 0,
      });
    }
  }

  const clusters: Cluster[] = [];
  for (const c of bins.values()) {
    c.notional = Math.max(0, c.notional - c.spent * spentWeight());
    c.pushes = c.price < mid ? "down" : "up";
    c.distPct = ((c.price - mid) / mid) * 100;
    if (c.notional > 0) clusters.push(c);
  }

  // Absorbing levels are measured, not modelled: they are posted size sitting
  // in the live book. They oppose the move rather than extending it.
  for (const w of walls) {
    clusters.push({
      price: w.price,
      effect: "absorbing",
      pushes: w.side === "ask" ? "down" : "up",
      notional: w.notional,
      confidence: 1,
      sources: [],
      spent: 0,
      distPct: ((w.price - mid) / mid) * 100,
    });
  }

  return clusters.sort((a, b) => a.price - b.price);
}

/**
 * How much of an already-fired cluster to treat as gone. Not all of it: a level
 * that liquidates once tends to attract fresh positioning at the same place.
 */
function spentWeight() {
  return 0.8;
}
