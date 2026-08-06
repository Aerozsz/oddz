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

    const character = flowCharacter(this.trades, this.tradeTimes, sliceUniformity, replenishSec);
    if (character.label !== "unclear") {
      notes.push(`flow looks ${character.label}${character.notes[0] ? ` — ${character.notes[0]}` : ""}`);
    }

    return {
      character,
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
function isRoundPrice(p: number): boolean {
  const whole = Math.abs(p - Math.round(p));
  const half = Math.abs(p * 2 - Math.round(p * 2)) / 2;
  return whole < 0.005 || half < 0.005;
}

/** 1, 5, 10, 25, 50, 100 ... the quantities a person reaches for. */
function isRoundQty(q: number): boolean {
  if (q <= 0) return false;
  const nearInt = Math.abs(q - Math.round(q)) < 1e-6;
  if (!nearInt) return false;
  const n = Math.round(q);
  return n % 100 === 0 || n % 50 === 0 || n % 25 === 0 || n % 10 === 0 || n % 5 === 0 || n <= 10;
}

/**
 * Character of the flow. Each measure is compared against what continuous,
 * computed trading would produce, so the signal is the excess rather than the
 * raw share.
 */
function flowCharacter(trades: Trade[], times: number[], sliceUniformity: number, replenishSec: number | null): FlowCharacter {
  const notes: string[] = [];
  if (trades.length < 20) {
    return {
      mechanical: 0, human: 0, label: "unclear",
      priceRoundnessRatio: 0, quantityRoundness: 0, timingRegularity: 0,
      notes: ["not enough trades yet to characterise the flow"],
    };
  }

  // With a 0.01 tick, whole-or-half prices are 2% of all possible prices.
  const roundPrices = trades.filter((t) => isRoundPrice(t.price)).length / trades.length;
  const priceRoundnessRatio = roundPrices / 0.02;

  const quantityRoundness = trades.filter((t) => isRoundQty(t.qty)).length / trades.length;

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
  const human = Math.min(
    1,
    Math.min(1, Math.max(0, priceRoundnessRatio - 1) / 3) * 0.5 +
      Math.min(1, quantityRoundness * 1.5) * 0.35 +
      (1 - timingRegularity) * 0.15,
  );

  if (priceRoundnessRatio > 2) {
    notes.push(`trades cluster at round prices ${priceRoundnessRatio.toFixed(1)}x more than chance would give`);
  }
  if (quantityRoundness > 0.4) {
    notes.push(`${(quantityRoundness * 100).toFixed(0)}% of sizes are round numbers — unit bias, a person choosing`);
  }
  if (timingRegularity > 0.6) notes.push("trades arrive on a regular cadence, not in bursts");
  if (sliceUniformity > 0.7) notes.push("sizes are near-identical — computed, not chosen");

  const gap = mechanical - human;
  const label: FlowCharacter["label"] =
    Math.max(mechanical, human) < 0.25 ? "unclear" : gap > 0.2 ? "mechanical" : gap < -0.2 ? "human" : "mixed";

  if (label === "mixed") notes.push("both signatures present — machines quoting into human order flow");

  return { mechanical, human, label, priceRoundnessRatio, quantityRoundness, timingRegularity, notes };
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
