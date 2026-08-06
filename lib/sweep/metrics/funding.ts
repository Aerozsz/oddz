import type { MarkPrice } from "../types";

/**
 * The funding leg.
 *
 * A perpetual has no expiry, so it is tethered to spot by a periodic payment
 * between the two sides. Three separate things follow from that, and the tool
 * was blind to all of them:
 *
 *  1. **It is a cost.** Funding settles at fixed instants. A position held
 *     across one pays or receives the full rate on its whole notional, no
 *     matter how long it was open — thirty seconds either side of settlement
 *     costs the same as eight hours. On a microstructure trade aiming at a few
 *     tens of basis points, an 0.01% settlement is a meaningful slice of the
 *     edge and a 0.05% one can be all of it.
 *
 *  2. **It is a positioning read.** Funding is positive when longs pay shorts,
 *     which happens when the perp trades above the index, which happens when
 *     longs are crowded. Crowded longs are liquidation fuel below the market.
 *     That is an independent line of evidence to the account-ratio the cluster
 *     ladder already uses, and it is harder to game — someone paying to hold a
 *     position has actual money at stake.
 *
 *  3. **It is occasionally the trade.** Funding capture: hold the side that
 *     receives, hedged or not, over the settlement. Unhedged that is only worth
 *     it when the rate is stretched far enough to pay for the directional risk,
 *     which the `carryEdgeBps` figure below is for.
 *
 * All three need the rate expressed against a *holding period*, which is what
 * this module produces. The raw rate off the mark-price stream is not directly
 * comparable to anything else the tool measures.
 */

export interface FundingSettlement {
  time: number;
  rate: number;
}

export interface FundingRead {
  /** Predicted rate for the next settlement, as a fraction. 0.0001 = 0.01%. */
  rate: number;
  /** Hours between settlements, inferred from the published history. */
  intervalHours: number;
  nextFundingTime: number;
  msToFunding: number;
  /** The same rate expressed per year, in percent. Comparable to a yield. */
  annualisedPct: number;
  /** Mark over index, in bps — the premium the payment exists to close. */
  basisBps: number;
  /** Who pays whom at the next settlement. */
  paying: "longs" | "shorts" | "neither";
  /**
   * Where this rate sits in its own recent history, 0..1. Absolute rates mean
   * nothing without it: 0.01% is the resting rate on most contracts and a
   * scandal on some.
   */
  percentile: number | null;
  /** Mean of the published history, as a fraction. */
  meanRate: number | null;
  historyCount: number;
  /**
   * True when the rate is far enough from its own norm that it is saying
   * something about positioning rather than just existing.
   */
  stretched: boolean;
  /** Which side the stretch implicates as crowded, when it is stretched. */
  crowded: "longs" | "shorts" | null;
  notes: string[];
}

export const EMPTY_FUNDING: FundingRead = {
  rate: 0,
  intervalHours: 8,
  nextFundingTime: 0,
  msToFunding: 0,
  annualisedPct: 0,
  basisBps: 0,
  paying: "neither",
  percentile: null,
  meanRate: null,
  historyCount: 0,
  stretched: false,
  crowded: null,
  notes: [],
};

/** Below this the rate is noise around zero and nobody is crowded. */
const FLAT_RATE = 0.00002;
/** A rate this far into its own distribution counts as stretched. */
const STRETCH_PERCENTILE = 0.85;

/**
 * Settlement interval, inferred rather than assumed.
 *
 * Binance runs most contracts on 8h but several on 4h, and changes it on
 * individual symbols without notice. Getting it wrong scales every carry figure
 * here by two, in the direction that makes a trade look cheaper than it is, so
 * it is read off consecutive settlement timestamps and only falls back to 8h
 * when there is no history to read.
 */
export function inferIntervalHours(history: FundingSettlement[]): number {
  if (history.length < 2) return 8;
  const gaps: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const gap = (history[i].time - history[i - 1].time) / 3_600_000;
    if (gap > 0.5 && gap < 25) gaps.push(gap);
  }
  if (!gaps.length) return 8;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // Snap to the intervals Binance actually uses rather than reporting 7.98.
  const candidates = [1, 2, 4, 8];
  return candidates.reduce((best, c) => (Math.abs(c - median) < Math.abs(best - median) ? c : best), 8);
}

export function readFunding(
  mark: MarkPrice | null,
  history: FundingSettlement[],
  now = Date.now(),
): FundingRead {
  if (!mark) return EMPTY_FUNDING;

  const rate = Number.isFinite(mark.fundingRate) ? mark.fundingRate : 0;
  const intervalHours = inferIntervalHours(history);
  const perYear = (365 * 24) / intervalHours;
  const msToFunding = Math.max(0, mark.nextFundingTime - now);

  const basisBps =
    mark.indexPrice > 0 ? ((mark.markPrice - mark.indexPrice) / mark.indexPrice) * 10_000 : 0;

  const rates = history.map((h) => h.rate).filter((r) => Number.isFinite(r));
  const meanRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

  // Percentile on absolute value: the question is "is this rate unusual", and a
  // deeply negative rate is every bit as unusual as a deeply positive one.
  let percentile: number | null = null;
  if (rates.length >= 20) {
    const abs = rates.map(Math.abs).sort((a, b) => a - b);
    const target = Math.abs(rate);
    let below = 0;
    while (below < abs.length && abs[below] < target) below++;
    percentile = below / abs.length;
  }

  const paying: FundingRead["paying"] =
    Math.abs(rate) < FLAT_RATE ? "neither" : rate > 0 ? "longs" : "shorts";
  const stretched = percentile !== null && percentile >= STRETCH_PERCENTILE && paying !== "neither";
  const crowded = stretched ? (rate > 0 ? "longs" : "shorts") : null;

  const notes: string[] = [];
  const pctPerSettlement = rate * 100;
  if (paying === "neither") {
    notes.push(`funding is flat (${pctPerSettlement.toFixed(4)}% per ${intervalHours}h) — no positioning signal in it`);
  } else {
    notes.push(
      `${paying} pay ${Math.abs(pctPerSettlement).toFixed(4)}% every ${intervalHours}h ` +
        `(${(Math.abs(rate) * perYear * 100).toFixed(1)}% a year)`,
    );
  }
  if (stretched && crowded) {
    notes.push(
      `that is in the top ${((1 - (percentile as number)) * 100).toFixed(0)}% of its own recent range — ` +
        `${crowded} are paying up to stay on, which is where the liquidation fuel sits`,
    );
  }
  if (msToFunding < 30 * 60_000 && paying !== "neither") {
    notes.push(
      `settles in ${Math.round(msToFunding / 60_000)} min — a position open across it pays the full rate on its whole notional`,
    );
  }

  return {
    rate,
    intervalHours,
    nextFundingTime: mark.nextFundingTime,
    msToFunding,
    annualisedPct: rate * perYear * 100,
    basisBps,
    paying,
    percentile,
    meanRate,
    historyCount: rates.length,
    stretched,
    crowded,
    notes,
  };
}

/* ------------------------------------------------------------------- carry */

export interface CarryEstimate {
  /** Settlements a position opened now would be held across. */
  settlements: number;
  /** USD paid (positive) or received (negative) over the hold. */
  costUsd: number;
  /** The same as a fraction of notional, in bps. Comparable to a price move. */
  costBps: number;
  /** True when the hold does not reach a settlement, so funding is free. */
  free: boolean;
  note: string;
}

/**
 * What funding does to a specific position over a specific hold.
 *
 * The step function is the whole point and the thing that gets modelled wrong:
 * funding is not accrued continuously, it is charged in full at the settlement
 * instant. A trade that closes five minutes before settlement pays nothing; the
 * same trade closing five minutes after pays the entire rate. So this counts
 * settlement boundaries crossed, not elapsed time.
 */
export function estimateCarry(
  funding: FundingRead,
  side: "long" | "short",
  notionalUsd: number,
  holdMs: number,
  now = Date.now(),
): CarryEstimate {
  const intervalMs = funding.intervalHours * 3_600_000;
  if (!funding.nextFundingTime || intervalMs <= 0 || notionalUsd <= 0) {
    return { settlements: 0, costUsd: 0, costBps: 0, free: true, note: "no funding schedule known" };
  }

  const exitAt = now + Math.max(0, holdMs);
  let settlements = 0;
  for (let t = funding.nextFundingTime; t <= exitAt; t += intervalMs) settlements++;

  // A positive rate is paid by longs. Cost is positive when we pay.
  const perSettlement = notionalUsd * funding.rate * (side === "long" ? 1 : -1);
  const costUsd = perSettlement * settlements;
  const costBps = notionalUsd > 0 ? (costUsd / notionalUsd) * 10_000 : 0;

  const minsToFirst = Math.round((funding.nextFundingTime - now) / 60_000);
  const note = settlements === 0
    ? `closes ${minsToFirst} min before the next settlement — no funding paid`
    : `crosses ${settlements} settlement${settlements === 1 ? "" : "s"}, ` +
      `${costUsd >= 0 ? "paying" : "receiving"} ${Math.abs(costUsd).toFixed(2)} (${Math.abs(costBps).toFixed(1)}bp)`;

  return { settlements, costUsd, costBps, free: settlements === 0, note };
}

/**
 * Directional read from funding, in the same −1..1 convention the bias module
 * uses: negative favours down.
 *
 * The logic is deliberately contrarian and worth stating plainly, because the
 * naive reading is the opposite one. Positive funding means longs are paying to
 * stay on — the perp is above the index and the crowd is long. A crowded long
 * book is not a bullish signal; it is where the stops and liquidations are
 * stacked, and this tool is in the business of finding where the fuel is. So
 * positive funding scores negative.
 *
 * Returns 0 unless the rate is genuinely stretched. At ordinary rates funding
 * says nothing about positioning and this would be noise dressed as evidence.
 */
export function fundingSkew(funding: FundingRead): number {
  if (!funding.stretched || !funding.crowded || funding.percentile === null) return 0;
  // Ramp from nothing at the stretch threshold to full weight at the extreme.
  const intensity = Math.min(1, (funding.percentile - STRETCH_PERCENTILE) / (1 - STRETCH_PERCENTILE));
  return funding.crowded === "longs" ? -intensity : intensity;
}
