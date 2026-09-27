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
  /*
   * Null when the bucket is a tied slice: the premium index is quantised, and a
   * bucket whose rows share one basis value has its boundaries set by array
   * order, so any price statistic on it describes a stretch of the calendar.
   */
  meanCollectorBps: number | null;
  seBps: number | null;
  /** The payment itself over the horizon, in bp, at the observed basis. */
  meanCarryBps: number;
  /** True when the bucket is a calendar slice rather than a basis slice. */
  tied?: boolean;
  tiedNote?: string;
  /** Distinct days the bucket's rows fall on. */
  days?: number;
  /**
   * The largest single day's share of the bucket.
   *
   * An extreme basis clusters in the episodes that produced it, so a decile can
   * be a few days of one selloff. High here means the bucket's price statistic
   * describes those days rather than the basis level.
   */
  topDayShare?: number;
  /** The collector's mean price return in each half of the window. */
  firstHalfBps?: number | null;
  secondHalfBps?: number | null;
  /** Whether both halves point the same way for the collector. */
  halvesAgree?: boolean | null;
  /** Payment plus price move: what the position actually nets, before fees. */
  meanTotalBps: number | null;
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
  const rows: { basis: number; fwdBps: number; ts: number }[] = [];
  for (const p of points) {
    const later = byTs.get(p.ts + horizonMin * 60_000);
    if (!later || !(p.close > 0)) continue;
    rows.push({ basis: p.basisBps, fwdBps: ((later.close - p.close) / p.close) * 10_000, ts: p.ts });
  }
  if (rows.length < buckets * 20) return [];

  rows.sort((a, b) => a.basis - b.basis);
  const per = Math.floor(rows.length / buckets);

  /*
   * How many rows share each basis value.
   *
   * This matters more than it looks, and getting it wrong produced the most
   * confident wrong number in the project. The premium index is quantised, so on
   * LITUSDT roughly forty per cent of minutes carry a basis of exactly zero —
   * and slicing a sorted array by index puts that tied group across four or five
   * buckets. JavaScript's sort is stable, so within the tie the order is the
   * order the rows were built in, which is time order.
   *
   * The result was four buckets labelled by basis that were really consecutive
   * slices of the calendar, reporting "collector" returns of -101, -50, +38 and
   * -55 basis points at fifteen-plus sigma. Those are eight-hour price drifts in
   * different weeks of one month. They were quoted as a carry finding — by me,
   * to the operator — and they are not a finding about basis at all.
   *
   * A bucket whose rows are mostly one tied value cannot say anything about
   * basis, so it says so instead of reporting drift.
   */
  const shareOf = new Map<number, number>();
  for (const r of rows) shareOf.set(r.basis, (shareOf.get(r.basis) ?? 0) + 1);

  /*
   * The midpoint of the window in time, for refitting each bucket on its halves.
   *
   * The tie guard catches a bucket whose *basis* does not vary. It does not catch
   * the subtler version of the same problem: an extreme basis is not spread
   * evenly through a month, it clusters in the episodes that produced it. A
   * decile of very negative basis can be four days of one selloff, and a price
   * statistic on it then describes those four days at whatever confidence the
   * row count implies.
   *
   * Two numbers separate the cases. The busiest single day's share of the bucket
   * says how concentrated it is, and refitting on the two halves of the window
   * says whether the effect exists twice or once.
   */
  const allTs = rows.map((r) => r.ts).sort((a, b) => a - b);
  const midTs = allTs.length ? allTs[Math.floor(allTs.length / 2)] : 0;
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
    /*
     * Is this bucket a real slice of the basis distribution, or a slice of the
     * calendar that happens to share one basis value?
     */
    const dominant = slice.reduce(
      (best, r) => Math.max(best, (shareOf.get(r.basis) ?? 0) / rows.length),
      0,
    );
    /*
     * Tied when a single basis value is common enough across the whole sample to
     * span more than one bucket. That is the condition that makes the boundary
     * arbitrary: the tied rows have to be split somewhere, and the split falls
     * wherever array order puts it.
     *
     * A value occupying exactly one bucket is not a problem — it is a legitimate
     * decile that happens to be one number wide — so the test is the share, not
     * whether the bucket holds more than one value. An earlier version flagged
     * both and refused a bucket that was perfectly well defined.
     */
    const tied = dominant > 1 / buckets;

    const side = meanBasis >= 0 ? -1 : 1;
    const collector = slice.map((r) => side * r.fwdBps);
    const meanCollector = collector.reduce((a, b) => a + b, 0) / n;
    const varr = collector.reduce((a, b) => a + (b - meanCollector) ** 2, 0) / Math.max(1, n - 1);
    const meanCarry = Math.abs(carryOver(meanBasis, horizonMin));

    /*
     * How much of this bucket is one day, and does it hold in both halves.
     *
     * Reported rather than enforced: a concentrated bucket is not automatically
     * wrong, but a reader who is not told cannot tell an effect from an episode,
     * and this project has already published one number that was an episode.
     */
    const byDay = new Map<number, number>();
    for (const r of slice) {
      const day = Math.floor(r.ts / 86_400_000);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    let busiest = 0;
    for (const count of byDay.values()) busiest = Math.max(busiest, count);
    const topDayShare = n > 0 ? busiest / n : 0;
    const days = byDay.size;

    const halfMean = (pick: (ts: number) => boolean): number | null => {
      const xs = slice.filter((r) => pick(r.ts)).map((r) => side * r.fwdBps);
      if (xs.length < 20) return null;
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    const firstHalf = halfMean((ts) => ts < midTs);
    const secondHalf = halfMean((ts) => ts >= midTs);
    /*
     * Agreement means both halves point the same way for the collector. A bucket
     * that pays in one half and costs in the other is one episode, whatever the
     * pooled sigma says.
     */
    const halvesAgree =
      firstHalf !== null && secondHalf !== null
        ? Math.sign(firstHalf) === Math.sign(secondHalf)
        : null;
    out.push({
      label: `basis decile ${i}`,
      n,
      meanBasisBps: meanBasis,
      /*
       * Null rather than a number when the bucket is a calendar slice. A number
       * here gets read, quoted and acted on; a null gets asked about.
       */
      meanCollectorBps: tied ? null : meanCollector,
      seBps: tied ? null : Math.sqrt(varr / n),
      /*
       * The carry itself stays, because it is arithmetic on the basis rather
       * than a statistic about price, and it is the only part of this table that
       * was ever a carry measurement. It is also small: at eight hours the
       * widest decile here pays under twelve basis points.
       */
      meanCarryBps: meanCarry,
      meanTotalBps: tied ? null : meanCollector + meanCarry,
      tied,
      /** Days the bucket spans, and the largest single day's share of it. */
      days,
      topDayShare,
      firstHalfBps: tied ? null : firstHalf,
      secondHalfBps: tied ? null : secondHalf,
      halvesAgree: tied ? null : halvesAgree,
      tiedNote: tied
        ? "this bucket's rows share one basis value, so its boundaries were set by array order " +
          "rather than by basis — any price statistic on it is a slice of the calendar, not a " +
          "finding about carry"
        : undefined,
    });
  }
  return out;
}
