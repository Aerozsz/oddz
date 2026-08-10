import type { Trade } from "../types";

/**
 * Who is standing in the book, inferred from how the book behaves.
 *
 * Nothing in public market data names a participant. What it does carry is
 * behaviour, and automated liquidity behaves in ways a person cannot: it
 * replaces consumed depth in well under a second, it re-posts the same size at
 * the same price repeatedly, it updates quotes far more often than it trades,
 * and when it executes a large order it slices it into near-identical pieces at
 * a near-constant rate.
 *
 * Each measure below is one of those fingerprints. None of them identifies
 * anyone, and every one has an innocent explanation available — so they are
 * reported with a confidence and combined into a regime rather than a verdict.
 * The useful output is not "a market maker is here" but "depth is being
 * replaced in 200ms, so an order that walks the book will be refilled behind
 * it" versus "nothing is coming back, so the next order travels".
 */

interface LevelState {
  /** Size last seen resting at this price. */
  qty: number;
  /** When it was last emptied, for measuring how fast it comes back. */
  emptiedAt: number;
  /** How many times it has been emptied and restored. */
  refills: number;
}

/**
 * Whether the flow looks computed or decided.
 *
 * People and machines leave different marks. A person picks a round price and a
 * round quantity — 10 contracts at 30.00, not 7.413 at 29.97 — because round
 * numbers are easier to hold in mind and feel like decisions; that is unit bias
 * and price-level anchoring, and it shows up as clustering that continuous
 * sizing would never produce. A machine sizes from a formula, prices to the
 * tick, and trades on a cadence.
 *
 * Both readings have innocent explanations — a market maker may quote a round
 * price, a person may place an odd size — so this is reported as two scores and
 * a confidence rather than a verdict.
 */
export interface FlowCharacter {
  /** 0..1 — computed sizes, tick-level pricing, regular cadence. */
  mechanical: number;
  /** 0..1 — round prices and round quantities, irregular timing. */
  human: number;
  label: "mechanical" | "human" | "mixed" | "unclear";
  /** Observed clustering at round prices over what chance would give. */
  priceRoundnessRatio: number;
  /** Share of trade sizes that are round numbers. */
  quantityRoundness: number;
  /** 0..1 — how evenly spaced trades are in time. */
  timingRegularity: number;
  notes: string[];
}

/**
 * The other half of the book: orders that never rest.
 *
 * Everything above characterises participants by what they leave sitting. That
 * misses the ones who never leave anything — the marketable order that arrives,
 * eats three levels and is gone before the next book update. Those are not a
 * detail of this strategy, they are its subject: a cluster is reached because
 * somebody crossed the spread hard enough to reach it, and the question at
 * entry is always whether the flow doing that is a drip or a sweep.
 *
 * The two are distinguishable without any private data. A marketable order
 * large enough to clear the touch prints as several trades in the same few
 * milliseconds, all on the same aggressive side, at successively worse prices —
 * because it is one order walking the book, reported piece by piece. A stream
 * of separate small takers has the same total volume and none of that
 * structure. Grouping prints into bursts recovers the original orders, and the
 * size distribution of those is the thing worth knowing: a hundred lots
 * arriving as one instant order moves price, and the same hundred arriving as
 * forty prints over a minute does not.
 *
 * What it deliberately does not claim: which of two adjacent bursts came from
 * the same desk. Bursts are orders, not senders.
 */
export interface AggressorRead {
  /** Marketable orders per minute, after grouping prints back into orders. */
  burstsPerMin: number;
  /** The largest single instant order in the window, in notional. */
  largestBurstUsd: number;
  /** How many distinct prices that order ate through. 1 = it fit at the touch. */
  largestBurstLevels: number;
  /**
   * Share of aggressive notional that arrived in orders big enough to walk more
   * than one level. High means price is being taken; low means it is drifting.
   */
  sweepShare: number;
  /** Signed −1..1 — aggressive buying against aggressive selling. */
  aggressorImbalance: number;
  /** Aggressive notional per second, for scale on everything above. */
  takerIntensity: number;
  /**
   * 0..1 — how much of the aggression is concentrated in its largest orders.
   * A single participant taking size, versus a crowd all crossing at once.
   */
  concentration: number;
  notes: string[];
}

export interface ParticipantRead {
  /**
   * Median seconds for consumed top-of-book depth to be restored. Sub-second
   * means something automated is quoting; several seconds means it is not.
   * Null until enough refills have been seen to measure.
   */
  replenishSec: number | null;
  /**
   * Price levels emptied and restored at least three times in the window.
   * Repeated refills at one price is the classic signature of hidden size — an
   * iceberg working a larger order than it shows.
   */
  refillLevels: number;
  /** Book updates per second that produced no trade. High means quote churn. */
  flickerPerSec: number;
  /**
   * 0..1. How alike recent trade sizes are. Execution algorithms slice a parent
   * order into near-identical children, so uniformity plus a steady rate is the
   * fingerprint of someone working size rather than a crowd trading.
   */
  sliceUniformity: number;
  /** 0..1, how one-sided aggressive flow has been. Sustained = a worked order. */
  flowPersistence: number;
  /** Trades per second, for context on everything above. */
  tradesPerSec: number;

  /** Whether this flow looks computed or decided. */
  character: FlowCharacter;
  /** The orders that executed on arrival rather than resting. */
  aggressor: AggressorRead;
  regime: ParticipantRegime;
  /** 0..1 — how much data the regime call rests on. */
  confidence: number;
  notes: string[];
}

export type ParticipantRegime =
  /** Depth replaced quickly, quotes plentiful: orders get absorbed. */
  | "liquidity-present"
  /** Quotes thinning or slow to return: orders travel further than usual. */
  | "liquidity-withdrawing"
  /** Uniform slices at a steady rate: someone is working a large order. */
  | "worked-order"
  /** Repeated refills at a level: hidden size sitting there. */
  | "hidden-size"
  /** Not enough evidence yet. */
  | "unclear";

const WINDOW_MS = 60_000;
const MAX_TRADES = 400;
const MAX_LEVELS = 2_000;

export class ParticipantTracker {
  private levels = new Map<number, LevelState>();
  /*
   * What counts as a round number on this contract.
   *
   * Defaulted rather than required, so a caller that never learns the contract
   * metadata still gets the old behaviour instead of nothing — but every engine
   * calls setScale() once exchangeInfo arrives, which is what makes the reading
   * comparable across a $30 stock and a $100,000 perp.
   */
  private scale: RoundingScale = DEFAULT_SCALE;
  private replenishTimes: number[] = [];
  private trades: Trade[] = [];
  private bookUpdates: number[] = [];
  private tradeTimes: number[] = [];

  /**
   * Fed the raw diff, before it is folded into the book. Only levels near the
   * touch are tracked — refills far from mid are ordinary housekeeping and
   * would swamp the signal.
   */
  onDepthDiff(bids: [string, string][], asks: [string, string][], mid: number, now: number) {
    this.bookUpdates.push(now);
    if (!mid) return;

    for (const [side, rows] of [["b", bids], ["a", asks]] as const) {
      for (const [priceStr, qtyStr] of rows) {
        const price = Number(priceStr);
        const qty = Number(qtyStr);
        // Within 0.5% of mid: where the contest actually happens.
        if (!Number.isFinite(price) || Math.abs((price - mid) / mid) > 0.005) continue;

        const key = side === "b" ? price : -price;
        const prev = this.levels.get(key);

        if (qty === 0) {
          if (prev && prev.qty > 0) this.levels.set(key, { ...prev, qty: 0, emptiedAt: now });
          continue;
        }
        if (prev && prev.qty === 0 && prev.emptiedAt > 0) {
          const gap = now - prev.emptiedAt;
          // A refill an hour later is not a refill. Cap what counts.
          if (gap <= 10_000) {
            this.replenishTimes.push(gap);
            if (this.replenishTimes.length > 200) this.replenishTimes.shift();
            this.levels.set(key, { qty, emptiedAt: 0, refills: prev.refills + 1 });
            continue;
          }
        }
        this.levels.set(key, { qty, emptiedAt: 0, refills: prev?.refills ?? 0 });
      }
    }

    if (this.levels.size > MAX_LEVELS) {
      // Drop the levels furthest from mid rather than the oldest; distance is
      // what makes a level irrelevant here.
      const sorted = [...this.levels.entries()].sort(
        (a, b) => Math.abs(Math.abs(a[0]) - mid) - Math.abs(Math.abs(b[0]) - mid),
      );
      this.levels = new Map(sorted.slice(0, MAX_LEVELS));
    }
    this.prune(now);
  }

  onTrade(trade: Trade, now: number) {
    this.trades.push(trade);
    this.tradeTimes.push(now);
    if (this.trades.length > MAX_TRADES) {
      this.trades.shift();
      this.tradeTimes.shift();
    }
  }

  private prune(now: number) {
    const cutoff = now - WINDOW_MS;
    while (this.bookUpdates.length && this.bookUpdates[0] < cutoff) this.bookUpdates.shift();
    while (this.tradeTimes.length && this.tradeTimes[0] < cutoff) {
      this.tradeTimes.shift();
      this.trades.shift();
    }
  }

  /** Called once the contract's tick and lot step are known. */
  setScale(tickSize: number, stepSize: number, price: number) {
    if (!(tickSize > 0) || !(stepSize > 0) || !(price > 0)) return;
    this.scale = roundingScale(tickSize, stepSize, price);
  }

  read(now = Date.now()): ParticipantRead {
    this.prune(now);
    const notes: string[] = [];

    const replenishSec = median(this.replenishTimes);
    const refillLevels = [...this.levels.values()].filter((l) => l.refills >= 3).length;

    const windowSec = WINDOW_MS / 1000;
    const tradesPerSec = this.tradeTimes.length / windowSec;
    const updatesPerSec = this.bookUpdates.length / windowSec;
    // Quote churn that produced no execution.
    const flickerPerSec = Math.max(0, updatesPerSec - tradesPerSec);

    const sizes = this.trades.map((t) => t.notional).filter((v) => v > 0);
    const sliceUniformity = uniformity(sizes);

    const buy = this.trades.filter((t) => !t.buyerIsMaker).reduce((s, t) => s + t.notional, 0);
    const sell = this.trades.reduce((s, t) => s + t.notional, 0) - buy;
    const total = buy + sell;
    const flowPersistence = total > 0 ? Math.abs(buy - sell) / total : 0;

    /* ------------------------------------------------------------- regime */

    // Evidence is thin early on; say so rather than classifying on nothing.
    const sampleScore = Math.min(1, this.trades.length / 60) * Math.min(1, this.bookUpdates.length / 200);
    let regime: ParticipantRegime = "unclear";
    let confidence = sampleScore;

    if (sampleScore < 0.3) {
      notes.push("not enough activity yet to characterise the book");
    } else if (refillLevels >= 2) {
      regime = "hidden-size";
      notes.push(
        `${refillLevels} price levels have been emptied and restored repeatedly — size is being shown in pieces`,
      );
    } else if (sliceUniformity > 0.7 && flowPersistence > 0.6 && tradesPerSec > 0.5) {
      regime = "worked-order";
      notes.push(
        `trades are unusually alike in size and ${(flowPersistence * 100).toFixed(0)}% one-sided — ` +
          `consistent with a large order being worked in slices`,
      );
    } else if (replenishSec !== null && replenishSec < 1 && flickerPerSec > 2) {
      regime = "liquidity-present";
      notes.push(
        `consumed depth is replaced in ${replenishSec.toFixed(2)}s — orders will be absorbed rather than travel`,
      );
    } else if (replenishSec === null || replenishSec > 3) {
      regime = "liquidity-withdrawing";
      notes.push(
        replenishSec === null
          ? "consumed depth is not coming back within the window — the next order travels further"
          : `depth takes ${replenishSec.toFixed(1)}s to return — slow enough that an order moves price before it is replaced`,
      );
      confidence = Math.min(confidence, 0.7);
    } else {
      regime = "liquidity-present";
      notes.push(`depth returns in ${replenishSec.toFixed(2)}s — ordinary two-sided quoting`);
    }

    const aggressor = readAggressors(this.trades, windowSec);
    if (aggressor.sweepShare > 0.5 && aggressor.largestBurstLevels > 1) {
      notes.push(
        `${(aggressor.sweepShare * 100).toFixed(0)}% of aggressive volume arrived as orders that walked the ` +
          `book — the largest took ${aggressor.largestBurstLevels} levels for $${Math.round(aggressor.largestBurstUsd).toLocaleString()}`,
      );
    }

    const character = flowCharacter(this.trades, this.tradeTimes, sliceUniformity, replenishSec, this.scale);
    if (character.label !== "unclear") {
      notes.push(`flow looks ${character.label}${character.notes[0] ? ` — ${character.notes[0]}` : ""}`);
    }

    return {
      character,
      aggressor,
      replenishSec,
      refillLevels,
      flickerPerSec,
      sliceUniformity,
      flowPersistence,
      tradesPerSec,
      regime,
      confidence,
      notes,
    };
  }
}

/** Whole or half unit — the levels people actually think in. */
/**
 * The scale a person actually rounds to on this contract.
 *
 * Both of these were hardcoded for a $30 stock with a $0.01 tick and whole-share
 * quantities, and on anything else they did not degrade — they inverted.
 *
 * On BTCUSDT the tick is $0.10, so one price in ten lands on a whole dollar by
 * arithmetic alone. Measured against a constant "2% of prices are round" that
 * reads as five times more round-number clustering than chance, and the human
 * score pinned near 0.5 on pure tick size. Quantities went the other way: BTC
 * trades in 0.002 and 0.015, never integers, so the integer test could never be
 * true and quantity roundness was structurally zero.
 *
 * One reading permanently overstated and another permanently absent is worse
 * than no reading, because `participantRegime` is the grouping the whole
 * strategy is a bet on — it is what distinguishes a book that is thin because
 * quotes were pulled from one that is thin because someone is working an order.
 * Deriving the scale from the contract makes the measure mean the same thing on
 * a $30 stock and a $100,000 perp.
 */
export interface RoundingScale {
  /** Price increments a person plausibly aims at, largest first. */
  priceSteps: number[];
  /** Share of all valid prices that land on one of those steps. */
  priceBaseRate: number;
  /** Quantity increments a person plausibly reaches for. */
  qtySteps: number[];
  /** Share of valid quantities that land on one of those steps by chance. */
  qtyBaseRate: number;
}

/**
 * Derived from the tick and the lot step rather than assumed.
 *
 * The rule is the same one a person uses without thinking: round to something
 * two to three orders of magnitude coarser than the smallest move available.
 * On a $0.01 tick that is $1 and $0.50; on a $0.10 tick it is $100 and $50;
 * the intent — "a number I can hold in my head" — is identical.
 */
export function roundingScale(tickSize: number, stepSize: number, price: number): RoundingScale {
  const tick = tickSize > 0 ? tickSize : 0.01;
  const step = stepSize > 0 ? stepSize : 1;

  /*
   * Anchored to the price, because that is what "round" is relative to.
   *
   * $100 is a round price for Bitcoin and an absurd one for a $30 stock, where
   * the same instinct produces $1. Two percent of price, snapped to the nearest
   * power of ten, reproduces both: $30 → $1 and $0.50; $100,000 → $1,000 and
   * $500; $3,000 → $100 and $50. Nearest rather than floor, or $30 would snap
   * down to $0.10 and call a tick-level price round.
   */
  const magnitude = Math.max(tick, Math.pow(10, Math.round(Math.log10(Math.max(price * 0.02, tick)))));
  const priceSteps = [magnitude, magnitude / 2].filter((s) => s >= tick);
  // Each step of size s catches tick/s of all valid prices; every multiple of
  // the whole is also a multiple of the half, so the union is the half's rate.
  const priceBaseRate = priceSteps.length
    ? Math.min(1, Math.max(...priceSteps.map((s) => tick / s)))
    : 1;

  /*
   * Quantities, in units of the lot step.
   *
   * "10 contracts" and "0.10 BTC" are the same gesture expressed in different
   * units, and only the second one has a fractional quantity — so counting in
   * steps rather than whole units makes them the same measurement.
   *
   * The lot step itself is deliberately not on this list. Every valid quantity
   * is a multiple of it by definition, so including it would score every trade
   * on every contract as round and the measure would be the constant 1.
   */
  const qtySteps = [100, 50, 25, 10, 5].map((n) => n * step);

  return {
    priceSteps,
    priceBaseRate: priceBaseRate > 0 ? priceBaseRate : 0.02,
    qtySteps,
    // The union of the multiples above is the multiples of 5 steps, since 10,
    // 25, 50 and 100 are all multiples of 5. Continuous sizing lands there one
    // time in five, so that is the bar an excess is measured against.
    qtyBaseRate: 0.2,
  };
}

/** The default scale, for a $30 equity perp. Kept so callers without meta work. */
export const DEFAULT_SCALE: RoundingScale = roundingScale(0.01, 1, 30);

function isRoundPrice(p: number, scale: RoundingScale): boolean {
  // Half a tick of tolerance, so a price that *is* the round number is not
  // missed by floating point.
  return scale.priceSteps.some((s) => {
    const r = Math.abs(p / s - Math.round(p / s)) * s;
    return r < s * 1e-6 || r < 1e-9;
  });
}

function isRoundQty(q: number, scale: RoundingScale): boolean {
  if (q <= 0) return false;
  return scale.qtySteps.some((s) => {
    const n = q / s;
    return Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) >= 1;
  });
}

/**
 * Character of the flow. Each measure is compared against what continuous,
 * computed trading would produce, so the signal is the excess rather than the
 * raw share.
 */
function flowCharacter(
  trades: Trade[],
  times: number[],
  sliceUniformity: number,
  replenishSec: number | null,
  scale: RoundingScale,
): FlowCharacter {
  const notes: string[] = [];
  if (trades.length < 20) {
    return {
      mechanical: 0, human: 0, label: "unclear",
      priceRoundnessRatio: 0, quantityRoundness: 0, timingRegularity: 0,
      notes: ["not enough trades yet to characterise the flow"],
    };
  }

  // Against this contract's own base rate, so the excess means the same thing
  // on a $0.01 tick and a $0.10 one.
  const roundPrices = trades.filter((t) => isRoundPrice(t.price, scale)).length / trades.length;
  const priceRoundnessRatio = roundPrices / scale.priceBaseRate;

  const quantityRoundness = trades.filter((t) => isRoundQty(t.qty, scale)).length / trades.length;

  // Even spacing is a machine cadence; people arrive in bursts.
  let timingRegularity = 0;
  if (times.length > 10) {
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean > 0) {
      const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
      const cv = Math.sqrt(varr) / mean;
      timingRegularity = Math.max(0, Math.min(1, 1 - cv / 2));
    }
  }

  const mechanical = Math.min(
    1,
    sliceUniformity * 0.4 + timingRegularity * 0.35 + (replenishSec !== null && replenishSec < 1 ? 0.25 : 0),
  );
  /*
   * Both roundness terms are excess over chance, not raw share.
   *
   * Multiples of five lot steps are one valid quantity in five on every
   * contract, so a purely computed tape scores 0.2 before anyone has decided
   * anything. Scoring the raw share put a fifth of that straight into the human
   * reading as a constant.
   */
  const qtyExcess = Math.max(0, quantityRoundness - scale.qtyBaseRate) / Math.max(1e-9, 1 - scale.qtyBaseRate);
  const human = Math.min(
    1,
    Math.min(1, Math.max(0, priceRoundnessRatio - 1) / 3) * 0.5 +
      Math.min(1, qtyExcess * 1.5) * 0.35 +
      (1 - timingRegularity) * 0.15,
  );

  if (priceRoundnessRatio > 2) {
    notes.push(`trades cluster at round prices ${priceRoundnessRatio.toFixed(1)}x more than chance would give`);
  }
  if (qtyExcess > 0.25) {
    notes.push(`${(quantityRoundness * 100).toFixed(0)}% of sizes are round numbers against ${(scale.qtyBaseRate * 100).toFixed(0)}% by chance — unit bias, a person choosing`);
  }
  if (timingRegularity > 0.6) notes.push("trades arrive on a regular cadence, not in bursts");
  if (sliceUniformity > 0.7) notes.push("sizes are near-identical — computed, not chosen");

  const gap = mechanical - human;
  const label: FlowCharacter["label"] =
    Math.max(mechanical, human) < 0.25 ? "unclear" : gap > 0.2 ? "mechanical" : gap < -0.2 ? "human" : "mixed";

  if (label === "mixed") notes.push("both signatures present — machines quoting into human order flow");

  return { mechanical, human, label, priceRoundnessRatio, quantityRoundness, timingRegularity, notes };
}

/**
 * How long apart two prints can be and still belong to one arriving order.
 *
 * An order walking three levels is matched by the engine in one pass and the
 * prints leave together; the gap between them is the exchange's own reporting
 * jitter, not a decision by anybody. Fifty milliseconds is comfortably above
 * that jitter and comfortably below human reaction time, so it splits "one
 * order, several fills" from "two people who happened to cross at once"
 * without needing either to be rare.
 *
 * Too tight and a single sweep is counted as three small orders, which
 * understates exactly the events that matter. Too loose and an active second of
 * ordinary trading merges into one fictional monster order — the error that
 * would make this metric look most impressive and be least true.
 */
const BURST_GAP_MS = 50;

function readAggressors(trades: Trade[], windowSec: number): AggressorRead {
  const empty: AggressorRead = {
    burstsPerMin: 0, largestBurstUsd: 0, largestBurstLevels: 0, sweepShare: 0,
    aggressorImbalance: 0, takerIntensity: 0, concentration: 0,
    notes: ["no aggressive flow in the window"],
  };
  if (trades.length === 0) return empty;

  // Sorted defensively: the feed delivers in order, and one out-of-order print
  // would otherwise split a burst in half and halve the size it reports.
  const rows = [...trades].sort((a, b) => a.t - b.t);

  interface Burst { buy: boolean; usd: number; prices: Set<number>; lastAt: number; }
  const bursts: Burst[] = [];
  for (const t of rows) {
    const buy = !t.buyerIsMaker;
    const last = bursts[bursts.length - 1];
    if (last && last.buy === buy && t.t - last.lastAt <= BURST_GAP_MS) {
      last.usd += t.notional;
      last.prices.add(t.price);
      last.lastAt = t.t;
    } else {
      bursts.push({ buy, usd: t.notional, prices: new Set([t.price]), lastAt: t.t });
    }
  }

  const totalUsd = bursts.reduce((a, b) => a + b.usd, 0);
  if (totalUsd <= 0) return empty;

  const buyUsd = bursts.filter((b) => b.buy).reduce((a, b) => a + b.usd, 0);
  const sweeping = bursts.filter((b) => b.prices.size > 1);
  const largest = bursts.reduce((a, b) => (b.usd > a.usd ? b : a), bursts[0]);
  const bySize = [...bursts].sort((a, b) => b.usd - a.usd);
  const topDecile = Math.max(1, Math.round(bursts.length * 0.1));
  const concentration = bySize.slice(0, topDecile).reduce((a, b) => a + b.usd, 0) / totalUsd;

  const notes: string[] = [];
  if (sweeping.length > 0) {
    notes.push(
      `${sweeping.length} of ${bursts.length} marketable orders walked more than one level`,
    );
  }
  if (concentration > 0.5 && bursts.length >= 10) {
    notes.push(
      `${(concentration * 100).toFixed(0)}% of the aggression came from the largest tenth of orders — ` +
        `size is being taken by few participants, not many`,
    );
  }

  return {
    burstsPerMin: (bursts.length / windowSec) * 60,
    largestBurstUsd: largest.usd,
    largestBurstLevels: largest.prices.size,
    sweepShare: sweeping.reduce((a, b) => a + b.usd, 0) / totalUsd,
    aggressorImbalance: (buyUsd - (totalUsd - buyUsd)) / totalUsd,
    takerIntensity: totalUsd / windowSec,
    concentration,
    notes: notes.length > 0 ? notes : ["aggressive flow is arriving in small, unremarkable pieces"],
  };
}

function median(xs: number[]): number | null {
  if (xs.length < 5) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) / 1000;
}

/**
 * 1 minus the coefficient of variation, floored at 0. A parent order sliced by
 * an algorithm produces children of near-identical size, so low dispersion is
 * the tell; a genuine crowd produces a wide spread of sizes.
 */
function uniformity(xs: number[]): number {
  if (xs.length < 10) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean <= 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, 1 - cv);
}
