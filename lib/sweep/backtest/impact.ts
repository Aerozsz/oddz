/**
 * The cost bar as a function of size, rather than a single number.
 *
 * Every verdict this project has produced was scored against one scalar: a
 * round trip of seven basis points, later fees plus a measured spread. That
 * number is the cost of trading an infinitesimal order, and it is the only
 * size at which it is correct. The tick measurement showed why the distinction
 * now matters — the spread on LITUSDT is one tick, 0.243bp, which cannot
 * threaten anything, so the entire cost of trading this contract is walking
 * the book, and the size-blind bar charges exactly zero for that.
 *
 * `sweep-impact` already measures the walk from the archive's depth curve and
 * writes it to `evidence/impact-<symbol>.json`. Nothing read it. This is the
 * part that reads it, so a finding is no longer reported as "beats fees" — a
 * claim that is true at every size and useful at none — but as the largest
 * size at which it still pays, which is the number an order is actually sent
 * with.
 *
 * ## Why the answer is a size and not a yes
 *
 * Impact is nothing until the order approaches resting depth and then it is
 * everything. On LITUSDT a $1,000 order pays 0.36bp round trip and a $50,000
 * order pays 16.87bp, against an edge of 16.66bp — the same finding is
 * comfortably profitable and comfortably unprofitable depending only on a
 * choice nobody had written down. Reporting the knee makes that choice
 * explicit and hands the operator the one lever that changes the answer.
 *
 * ## Two guards that decide whether a row may be believed
 *
 * `offCurveShare` is the share of minutes where the order exceeded every
 * published band. Those minutes are dropped from the median, so a row with a
 * high share has had its expensive minutes silently deleted and reads cheap
 * for that reason alone. Past a threshold the row is refused rather than
 * discounted, because there is no honest way to price what the archive did not
 * publish.
 *
 * The ladder is also computed twice, at the median minute and at the ninetieth
 * percentile. A signal fires when it fires and does not get to wait for a deep
 * book, so the median is the optimistic case and p90 is the case worth sizing
 * against. Both are reported; neither is hidden behind the other.
 */

import { existsSync, readFileSync } from "node:fs";

export interface ImpactSizeRow {
  usd: number;
  /** One-way, in bps. A round trip pays it twice. Null when off the curve. */
  medianBps: number | null;
  p75Bps: number | null;
  p90Bps: number | null;
  offCurveShare: number;
}

export interface ImpactReport {
  symbol: string;
  minutes: number;
  bandsPct: number[];
  sizes: ImpactSizeRow[];
}

/**
 * Above this share of minutes running off the end of the published curve, the
 * row is refused.
 *
 * A tenth is already generous. At that point one minute in ten was priced by
 * deleting it, and the surviving nine are the deep ones — the median is a
 * statistic about the book on its good days, which is not the book an order
 * arrives at.
 */
const MAX_OFF_CURVE = 0.1;

/**
 * The same ladder measured on executed sweeps, from `realized-<symbol>.json`.
 *
 * `moveBps` is the whole distance a real order of this size travelled, and
 * `temporaryBps` is the part that came back within a minute. The first is the
 * pessimistic bound — it includes the information the order carried, which a
 * mechanical signal does not have — and the second is the optimistic one, being
 * only the push that reverts. A round trip's true cost is between them, and
 * neither is worth reporting without the other.
 */
export interface RealizedCurve {
  sizes: { usd: number; moveBps: number | null; temporaryBps: number | null; bursts: number }[];
}

export interface SizedCost {
  usd: number;
  /** Fees plus spread: what the size-blind bar charged. */
  baseBps: number;
  /** Round-trip impact at the median minute, or null when unpriceable. */
  impactBps: number | null;
  /** Round-trip impact at the ninetieth percentile minute. */
  stressImpactBps: number | null;
  /** baseBps + impactBps, the bar at this size. Null when unpriceable. */
  totalBps: number | null;
  /** baseBps + stressImpactBps. */
  stressTotalBps: number | null;
  offCurveShare: number;
  /**
   * The bar at this size if a real order pays everything an executed sweep of
   * the same size moved. Null when no burst of this size was measured.
   */
  realizedTotalBps?: number | null;
  /** The bar if it pays only the part that reverts. */
  revertingTotalBps?: number | null;
  /** Why this row carries nulls, when it does. */
  refused?: string;
}

export function loadImpact(path: string): ImpactReport | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ImpactReport;
    if (!Array.isArray(parsed?.sizes) || parsed.sizes.length === 0) return null;
    return parsed;
  } catch {
    /*
     * A half-written report is a missing report. The worker writes this file
     * from a runner that can be cancelled mid-write, and a JSON parse error
     * that kills the replay would take the whole loop down for a file that is
     * strictly an enrichment.
     */
    return null;
  }
}

/**
 * The cost bar at each measured size.
 *
 * `baseBps` is the size-blind bar — fees plus spread — which every row pays
 * before impact. Impact is doubled because the published number is one way and
 * a position is opened and closed.
 */
export function sizeLadder(
  report: ImpactReport,
  baseBps: number,
  realized: RealizedCurve | null = null,
): SizedCost[] {
  return report.sizes.map((row) => {
    const offCurve = Number.isFinite(row.offCurveShare) ? row.offCurveShare : 1;
    const priceable =
      typeof row.medianBps === "number" && Number.isFinite(row.medianBps) && offCurve <= MAX_OFF_CURVE;

    const impactBps = priceable ? (row.medianBps as number) * 2 : null;
    const stress =
      priceable && typeof row.p90Bps === "number" && Number.isFinite(row.p90Bps)
        ? (row.p90Bps as number) * 2
        : null;

    const real = realized?.sizes.find((r) => r.usd === row.usd);
    // Doubled for the same reason the modelled curve is: a position is opened
    // and closed, and each leg walks the book.
    const twice = (x: number | null | undefined) =>
      typeof x === "number" && Number.isFinite(x) ? baseBps + x * 2 : null;

    return {
      usd: row.usd,
      baseBps,
      realizedTotalBps: twice(real?.moveBps),
      revertingTotalBps: twice(real?.temporaryBps),
      impactBps,
      stressImpactBps: stress,
      totalBps: impactBps === null ? null : baseBps + impactBps,
      stressTotalBps: stress === null ? null : baseBps + stress,
      offCurveShare: offCurve,
      refused:
        impactBps !== null
          ? undefined
          : offCurve > MAX_OFF_CURVE
            ? `${(offCurve * 100).toFixed(0)}% of minutes ran off the end of the published curve — ` +
              `the median below that is computed on the deep minutes only and understates the cost`
            : "the archive published no depth curve reaching this size",
    };
  });
}

export interface TradableSize {
  usd: number;
  /** Edge less the bar at this size, in bps. */
  netBps: number;
  /** What that is worth on one round trip, in dollars. */
  netUsd: number;
  /** Round trips a day needed to make `target` dollars at this size. */
  tradesPerDay: number;
}

/**
 * The largest measured size at which an edge still pays, and what it earns there.
 *
 * Largest rather than best: dollars per trade rises with size until the knee
 * and falls after it, so the maximum of `netUsd` is the answer to "how much
 * should this order be" and the maximum paying size is the answer to "where
 * does this stop working". They are different numbers and the caller wants
 * both, so this returns the peak earner and `ladderNet` exposes the rest.
 *
 * Null when no measured size pays, which is a verdict and not an error: it
 * means the edge is smaller than the cost of the smallest order the archive
 * can price.
 */
export function bestSize(
  ladder: SizedCost[],
  edgeBps: number,
  target = 300,
  stress = false,
): TradableSize | null {
  let best: TradableSize | null = null;
  for (const row of ladder) {
    const bar = stress ? row.stressTotalBps : row.totalBps;
    if (bar === null) continue;
    const netBps = Math.abs(edgeBps) - bar;
    if (netBps <= 0) continue;
    const netUsd = (netBps / 10_000) * row.usd;
    if (best === null || netUsd > best.netUsd) {
      best = {
        usd: row.usd,
        netBps,
        netUsd,
        tradesPerDay: netUsd > 0 ? target / netUsd : Infinity,
      };
    }
  }
  return best;
}

/** Every measured size scored against one edge, for the report table. */
export function ladderNet(ladder: SizedCost[], edgeBps: number, target = 300) {
  return ladder.map((row) => {
    const net = row.totalBps === null ? null : Math.abs(edgeBps) - row.totalBps;
    const netUsd = net === null ? null : (net / 10_000) * row.usd;
    const stressNet = row.stressTotalBps === null ? null : Math.abs(edgeBps) - row.stressTotalBps;
    return {
      usd: row.usd,
      totalBps: row.totalBps,
      stressTotalBps: row.stressTotalBps,
      netBps: net,
      netUsd,
      stressNetBps: stressNet,
      /*
       * Infinity, not a large number, when the size does not pay. A trade
       * count of 4,000 reads as merely demanding; "never" reads as what it is.
       */
      tradesPerDay: netUsd !== null && netUsd > 0 ? target / netUsd : Infinity,
      refused: row.refused,
    };
  });
}
