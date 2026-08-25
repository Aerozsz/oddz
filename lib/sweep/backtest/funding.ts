/**
 * What the perpetual pays you for holding it, and whether that is worth taking.
 *
 * Every measurement this project has made asks the same question — which way
 * will price go — and the answer has come back "unpredictable" four times, on
 * 513,000 historical samples, 20,000 shadow decisions, 36 live trades and a
 * beta test. Meanwhile a perpetual future has a cash flow attached to it that
 * requires no opinion about direction whatsoever, is scheduled, is published in
 * advance, and has been downloaded and never once looked at.
 *
 * A perp is pinned to spot by funding: every eight hours, longs pay shorts (or
 * the reverse) in proportion to how far the contract trades from its index. The
 * side that is *unpopular* gets paid for taking the other side of a crowded
 * position. That is not a prediction, it is a fee schedule.
 *
 * ## What makes it hard, and why it is still worth measuring
 *
 * Funding is not free money, and anyone who says otherwise has not held the
 * position through a move. Collecting it means holding a directional position
 * for hours, so the payment competes against whatever price does in the
 * meantime — and price moves far more per hour than funding pays per eight.
 *
 * Which is exactly why it has to be measured rather than assumed. The question
 * is narrow and answerable: **conditioned on funding being extreme, does the
 * paid side's realised return beat the payment's own volatility?** If yes, there
 * is a strategy whose edge does not depend on predicting anything. If no, that
 * is one more family honestly closed, and it cost a day rather than a week.
 */

/** One funding observation and what happened around it. */
export interface FundingPoint {
  ts: number;
  /**
   * The premium of the perpetual over its index, in basis points.
   *
   * Funding is computed from this, clamped and averaged over the interval, so
   * the premium is the observable that leads it rather than a proxy for it.
   */
  basisBps: number;
  /** Mark price at this minute, for scoring what holding actually returned. */
  close: number;
}

export interface FundingBucket {
  label: string;
  n: number;
  /** Mean basis in the bucket, in bp — what the position would be paid. */
  meanBasisBps: number;
  /**
   * Mean return over the horizon to the side that *collects* funding, in bp.
   *
   * Signed so positive is a gain for the collector: when the basis is positive
   * longs pay, so the collector is short, and the return is negated.
   */
  meanCollectorBps: number;
  seBps: number;
  /** The payment itself over the horizon, in bp, at the observed basis. */
  meanCarryBps: number;
  /** Payment plus price move: what the position actually nets, before fees. */
  meanTotalBps: number;
}

/**
 * Binance funds every eight hours, and the rate is the clamped average premium.
 *
 * Approximated here as the premium itself scaled to the holding period, which
 * is what a position actually accrues between payments. The clamp matters at
 * extremes and is applied, because the tail is precisely where this strategy
 * would live and an unclamped estimate would promise money the venue does not
 * pay.
 */
const CLAMP_BPS = 75; // ±0.75% per interval, Binance's cap on most contracts
const INTERVAL_MIN = 8 * 60;

export function carryOver(basisBps: number, minutes: number): number {
  const clamped = Math.max(-CLAMP_BPS, Math.min(CLAMP_BPS, basisBps));
  return clamped * (minutes / INTERVAL_MIN);
}

/**
 * Score the paid side against what price did, bucketed by how extreme the
 * basis was.
 *
 * Deciles of the basis rather than fixed thresholds: the interesting region is
 * the tail, and where the tail begins is a property of the sample rather than
 * something to assert in advance. The comparison that decides everything is the
 * top and bottom buckets — the most crowded longs and the most crowded shorts —
 * because a strategy here only ever takes the unpopular side of an extreme.
 */
export function scoreFunding(points: FundingPoint[], horizonMin: number, buckets = 10): FundingBucket[] {
  const byTs = new Map(points.map((p) => [p.ts, p]));
  const rows: { basis: number; fwdBps: number }[] = [];
  for (const p of points) {
    const later = byTs.get(p.ts + horizonMin * 60_000);
    if (!later || !(p.close > 0)) continue;
    rows.push({ basis: p.basisBps, fwdBps: ((later.close - p.close) / p.close) * 10_000 });
  }
  if (rows.length < buckets * 20) return [];

  rows.sort((a, b) => a.basis - b.basis);
  const per = Math.floor(rows.length / buckets);
  const out: FundingBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const slice = rows.slice(i * per, i === buckets - 1 ? rows.length : (i + 1) * per);
    const n = slice.length;
    const meanBasis = slice.reduce((a, r) => a + r.basis, 0) / n;
    /*
     * The collector is short when the basis is positive.
     *
     * Orienting every bucket to the collector is what makes the top and bottom
     * comparable at all: without it the extremes differ by the sign of the
     * position as well as the size of the payment, and the two effects cannot
     * be separated by eye.
     */
    const side = meanBasis >= 0 ? -1 : 1;
    const collector = slice.map((r) => side * r.fwdBps);
    const meanCollector = collector.reduce((a, b) => a + b, 0) / n;
    const varr = collector.reduce((a, b) => a + (b - meanCollector) ** 2, 0) / Math.max(1, n - 1);
    const meanCarry = Math.abs(carryOver(meanBasis, horizonMin));
    out.push({
      label: `basis decile ${i}`,
      n,
      meanBasisBps: meanBasis,
      meanCollectorBps: meanCollector,
      seBps: Math.sqrt(varr / n),
      meanCarryBps: meanCarry,
      meanTotalBps: meanCollector + meanCarry,
    });
  }
  return out;
}
