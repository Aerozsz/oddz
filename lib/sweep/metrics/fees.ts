/**
 * What trading actually costs, and when the cost has eaten the edge.
 *
 * Fees were a single constant until now — 5bp, applied twice, done. That is
 * wrong in three ways that all matter at this frequency:
 *
 *  1. **Maker and taker are different trades.** 2bp against 5bp is not a
 *     rounding difference when the target is 30–50bp: a round trip crossing
 *     the spread twice costs 10bp and eats a fifth to a third of gross reward,
 *     while resting on both sides costs 4bp. Whether an entry can be posted
 *     rather than crossed is the single largest lever on net return here, and
 *     the sizer could not previously express the difference.
 *
 *  2. **A schedule can escalate.** Some venues charge more as activity rises,
 *     whether through an explicit anti-scalping tier or through losing a
 *     rebate. A flat constant cannot represent that, and a strategy that
 *     silently gets more expensive the more it trades is the exact failure
 *     mode worth designing against. `tiers` below handles any monotonic
 *     schedule; leaving it empty gives the ordinary flat one.
 *
 *  3. **The daily total is its own risk.** Each individual trade can clear a
 *     reward-over-fees test and the day can still end with fees larger than
 *     gross profit. That is not a losing strategy being discovered, it is a
 *     winning one being farmed, and it needs its own cap.
 */

export type ExecutionStyle = "maker" | "taker";

/** How an entry and an exit are each expected to be executed. */
export interface StylePair {
  entry: ExecutionStyle;
  exit: ExecutionStyle;
}

export interface FeeTier {
  /** Applies once this many trades have been taken today. */
  fromTradeCount: number;
  makerRate: number;
  takerRate: number;
  note?: string;
}

export interface FeeSchedule {
  makerRate: number;
  takerRate: number;
  /**
   * Multiplier on both rates. Binance's BNB discount is 0.9; a broker or
   * referral rebate stacks in here too. 1 means no discount.
   */
  discount: number;
  /**
   * Optional escalating schedule, sorted or not. The tier with the highest
   * `fromTradeCount` at or below today's count wins. Empty means flat.
   */
  tiers: FeeTier[];
  /**
   * Refuse further entries once the day's fees reach this share of the day's
   * gross profit. Zero disables it.
   */
  maxFeeShareOfGross: number;
  /** Hard ceiling on fees paid in one day, in USD. Zero disables it. */
  maxDailyFeeUsd: number;
}

/**
 * Binance USDⓈ-M futures, VIP 0, no discounts applied.
 *
 * These are the published standard rates and the honest default: assuming a
 * discount that has not been switched on would make every proposal look
 * cheaper than it is, which is the wrong direction for this particular number
 * to be wrong in. Set `discount: 0.9` once BNB fee payment is enabled.
 */
export const DEFAULT_FEES: FeeSchedule = {
  makerRate: 0.0002,
  takerRate: 0.0005,
  discount: 1,
  tiers: [],
  maxFeeShareOfGross: 0.6,
  maxDailyFeeUsd: 0,
};

/** The rates in force for the next trade, given what has been done today. */
export function ratesFor(schedule: FeeSchedule, tradesToday: number): {
  makerRate: number;
  takerRate: number;
  tier: FeeTier | null;
} {
  const applicable = schedule.tiers
    .filter((t) => tradesToday >= t.fromTradeCount)
    .sort((a, b) => b.fromTradeCount - a.fromTradeCount)[0] ?? null;

  const maker = applicable ? applicable.makerRate : schedule.makerRate;
  const taker = applicable ? applicable.takerRate : schedule.takerRate;
  return {
    makerRate: maker * schedule.discount,
    takerRate: taker * schedule.discount,
    tier: applicable,
  };
}

export interface RoundTrip {
  entryFeeUsd: number;
  exitFeeUsd: number;
  totalUsd: number;
  /** As a fraction of notional, in basis points. Comparable to a price move. */
  bps: number;
  /** The move needed just to get back to flat, in percent. */
  breakevenPct: number;
  style: StylePair;
  tierNote: string | null;
}

export function roundTripCost(
  schedule: FeeSchedule,
  notionalUsd: number,
  style: StylePair,
  tradesToday = 0,
): RoundTrip {
  const { makerRate, takerRate, tier } = ratesFor(schedule, tradesToday);
  const rate = (s: ExecutionStyle) => (s === "maker" ? makerRate : takerRate);

  const entryFeeUsd = notionalUsd * rate(style.entry);
  const exitFeeUsd = notionalUsd * rate(style.exit);
  const totalUsd = entryFeeUsd + exitFeeUsd;
  const fraction = notionalUsd > 0 ? totalUsd / notionalUsd : 0;

  return {
    entryFeeUsd,
    exitFeeUsd,
    totalUsd,
    bps: fraction * 10_000,
    breakevenPct: fraction * 100,
    style,
    tierNote: tier?.note ?? null,
  };
}

/**
 * Whether an entry can realistically be posted rather than crossed.
 *
 * This is a fee question answered by a mark-out measurement, which is the
 * pleasing part: `toxicity` is defined as mark-out over the half-spread, so it
 * is *already* the quantity that decides whether resting on the book makes
 * money. Below the threshold the passive side is being paid to be there. Above
 * it, posting means being adversely selected, and the fee saved is smaller
 * than the mark-out paid to earn it.
 *
 * Deliberately conservative: an entry is only assumed to be a maker fill when
 * the measurement is warm. Assuming a maker fill that turns into a taker fill
 * understates the cost of every proposal, which is the one error here with a
 * direct route to losing money.
 */
/**
 * Mark-out above which a resting entry is not worth posting.
 *
 * Exported because the analysis that asks why the gate never opens has to
 * bucket against the same number the gate uses, and a copy of it in the summary
 * would drift silently the first time this one moved.
 */
export const POSTABLE_TOXICITY = 0.6;

export function canPostEntry(
  markout: { warm: boolean; toxicity: number },
  threshold = POSTABLE_TOXICITY,
): {
  ok: boolean;
  reason: string;
} {
  if (!markout.warm) {
    return {
      ok: false,
      reason: "mark-out has not warmed, so assuming the entry crosses the spread — the expensive assumption is the safe one here",
    };
  }
  if (markout.toxicity >= threshold) {
    return {
      ok: false,
      reason:
        `flow is marking out at ${markout.toxicity.toFixed(2)} of the half-spread — ` +
        `a resting entry gets picked off, and the fee saved is less than the mark-out paid for it`,
    };
  }
  return {
    ok: true,
    reason: `mark-out is ${markout.toxicity.toFixed(2)} of the half-spread — resting on the book is being paid for, so the entry can be posted`,
  };
}

/* ------------------------------------------------------------- day budget */

export interface FeeBudget {
  feesPaidUsd: number;
  grossProfitUsd: number;
  /** Fees over gross profit. Above 1 means the day paid the exchange, not you. */
  share: number | null;
  /** True when a further entry should be refused. */
  exhausted: boolean;
  reason: string | null;
}

/**
 * Where the day's costs stand.
 *
 * Gross profit here means profit *before* fees, so the ratio answers "how much
 * of what this made went to the venue". Measured on the day's realised ledger
 * rather than on anything this process remembers, for the same reason the loss
 * cap is: a restart is exactly when a bad run has just happened.
 */
/**
 * Gross that must exist before the share test means anything.
 *
 * A ratio computed on the first trade of the day is not a measurement of
 * anything. One 0.25% winner on a small position produces a gross of a few
 * dollars against a fee of a couple, and a share that reads 45% — which then
 * refuses every subsequent setup on the strength of a single sample. The
 * absolute floor makes the check start describing a day rather than a trade.
 */
const MIN_GROSS_FOR_SHARE_USD = 50;

export function feeBudget(
  schedule: FeeSchedule,
  feesPaidUsd: number,
  grossProfitUsd: number,
  /**
   * The reward-to-cost floor the sizer is enforcing, when it is known.
   *
   * These two settings are the same quantity seen from opposite ends, and left
   * independent they contradict each other silently. A trade admitted at
   * reward/cost of 2 pays half its own gross in fees by construction; a 40%
   * share cap then refuses the exact profile the sizer just approved. That
   * combination produced 1055 consecutive refusals against 1200 signals — the
   * strategy was working as designed and being blocked for working as designed.
   *
   * So the cap can never sit below what a compliant trade produces. Passing
   * this raises it to `1/minRewardOverFees` plus headroom for the losing trades
   * that pay fees and contribute no gross.
   */
  minRewardOverFees?: number,
): FeeBudget {
  const share = grossProfitUsd > 0 ? feesPaidUsd / grossProfitUsd : null;
  const floorFromSizer = minRewardOverFees && minRewardOverFees > 0 ? 1 / minRewardOverFees + 0.2 : 0;
  const cap = Math.max(schedule.maxFeeShareOfGross, floorFromSizer);

  if (schedule.maxDailyFeeUsd > 0 && feesPaidUsd >= schedule.maxDailyFeeUsd) {
    return {
      feesPaidUsd,
      grossProfitUsd,
      share,
      exhausted: true,
      reason: `${feesPaidUsd.toFixed(2)} of fees paid today against a ${schedule.maxDailyFeeUsd} ceiling`,
    };
  }

  // Only bites once there is something to compare against. A losing day is
  // caught by the loss cap; this one is about a *winning* day being farmed.
  if (
    cap > 0 &&
    grossProfitUsd >= MIN_GROSS_FOR_SHARE_USD &&
    share !== null &&
    share >= cap
  ) {
    return {
      feesPaidUsd,
      grossProfitUsd,
      share,
      exhausted: true,
      reason:
        `fees are ${(share * 100).toFixed(0)}% of today's gross profit ` +
        `(${feesPaidUsd.toFixed(2)} of ${grossProfitUsd.toFixed(2)}) — ` +
        `past the ${(cap * 100).toFixed(0)}% cap. ` +
        `The edge is being converted into commission.`,
    };
  }

  return { feesPaidUsd, grossProfitUsd, share, exhausted: false, reason: null };
}

/**
 * Parse an escalating schedule from the environment, so a venue rule can be
 * encoded without a code change.
 *
 *   SWEEP_FEE_TIERS='[{"fromTradeCount":10,"makerRate":0.0004,"takerRate":0.0008,
 *                      "note":"anti-scalping tier"}]'
 *
 * Malformed input is dropped rather than thrown: a bad variable must not be
 * able to stop the monitor, and the flat schedule is the safe fallback.
 */
export function parseFeeTiers(raw: string | undefined): { tiers: FeeTier[]; error: string | null } {
  if (!raw?.trim()) return { tiers: [], error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { tiers: [], error: "SWEEP_FEE_TIERS is not a JSON array" };
    const tiers: FeeTier[] = [];
    for (const row of parsed) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const from = Number(r.fromTradeCount);
      const maker = Number(r.makerRate);
      const taker = Number(r.takerRate);
      if (!Number.isFinite(from) || !Number.isFinite(maker) || !Number.isFinite(taker)) continue;
      tiers.push({
        fromTradeCount: from,
        makerRate: maker,
        takerRate: taker,
        note: r.note === undefined ? undefined : String(r.note),
      });
    }
    return { tiers, error: null };
  } catch (err) {
    return { tiers: [], error: `SWEEP_FEE_TIERS could not be parsed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
