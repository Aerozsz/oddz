import type { DislocationRead } from "../metrics/dislocation";
import { fundingSkew } from "../metrics/funding";
import type { Direction } from "../types";
import type { AgentState } from "./types";

/**
 * Which way the book is more vulnerable.
 *
 * The distinction this rests on, and the reason it is not called a forecast:
 * everything measurable here describes how far price would travel *if* it were
 * pushed, not whether anyone is going to push. A book with the bids withdrawn
 * and stops stacked below is fragile downward — that is a statement about the
 * cost of a move, and it stays true whether or not the move happens.
 *
 * So the output is a direction of least resistance with a conviction attached,
 * and conviction is capped well below certainty on purpose. Read it as "if this
 * breaks, it breaks this way", not "this is going down".
 *
 * Factors are weighted by how hard they are to fake. Seed cost and side-specific
 * depth come from the whole visible book and a ten-minute baseline, and moving
 * either takes real size. Resting imbalance is the easiest thing in the market
 * to display without meaning, so it carries the least weight.
 */

export interface BiasFactor {
  name: string;
  /** −1 fully favours down, +1 fully favours up. */
  score: number;
  weight: number;
  detail: string;
}

export interface DirectionalBias {
  /** Null when nothing meaningful separates the two sides. */
  direction: Direction | null;
  /** 0..1. Deliberately capped — see the note on this module. */
  conviction: number;
  /** Signed composite, −1 (down) to +1 (up). */
  composite: number;
  factors: BiasFactor[];
  summary: string;
  caveat: string;
}

/** Below this the two sides are too close to call. */
const DEAD_ZONE = 0.12;
/** No combination of these inputs justifies more than this. */
const MAX_CONVICTION = 0.75;

/**
 * How far below baseline counts as fully withdrawn.
 *
 * 0.3 means a side at 0.70x of its normal depth scores the factor at full
 * strength, and anything at or above 1.00x scores it at zero. Not tuned — it is
 * a statement about what the strategy is for, and the point of the evidence log
 * is to replace it with a measured number.
 */
const THINNESS_FULL = 0.3;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

const norm = (a: number, b: number): number => {
  const total = a + b;
  return total > 0 ? (a - b) / total : 0;
};

export interface BiasContext {
  /**
   * How this contract sits against the others being watched.
   *
   * Passed in rather than carried on AgentState because it is the one reading
   * here that is not a property of this contract — it cannot be computed from
   * one book, and a single-symbol run has no access to it and needs none.
   */
  dislocation?: DislocationRead;
}

export function directionalBias(state: AgentState, ctx: BiasContext = {}): DirectionalBias {
  const factors: BiasFactor[] = [];
  const liq = state.liquidity;

  /* Cheapness of the push. The clearest signal the tool has: how much
   * aggressive size it takes to reach the first stop cluster each way. */
  const seedUp = state.cascadeUp?.seedNotional ?? 0;
  const seedDown = state.cascadeDown?.seedNotional ?? 0;
  if (seedUp > 0 && seedDown > 0) {
    // Cheaper down => favours down => negative.
    const score = norm(seedDown, seedUp);
    factors.push({
      name: "cost to trigger",
      score,
      weight: 0.3,
      detail:
        `${Math.round(seedDown).toLocaleString()} to set off the downside vs ` +
        `${Math.round(seedUp).toLocaleString()} upside — ` +
        `${score < 0 ? "cheaper to push down" : "cheaper to push up"}`,
    });
  }

  /* Which side of the book has actually thinned. Measured against each side's
   * own ten-minute baseline, corrected for what the clock alone would do to it
   * — otherwise the cash close reads as a two-sided withdrawal every day. */
  if (liq && liq.warm) {
    /*
     * Relative thinness, scaled by whether anything was actually withdrawn.
     *
     * This was the whole factor, and it only ever asked which side was thinner
     * than the other. On a book with bids at 1.17x and asks at 1.00x it called
     * a long — "the ceiling has thinned more" — when neither side had thinned
     * at all: 1.00x is the baseline and 1.17x is above it. The strategy is a bet
     * that withdrawn depth lets price travel, so a book at or above its own
     * normal depth is not a setup, it is the absence of one.
     *
     * The cost was not subtle. Fifty-nine live trades entered at 1.00x, 1.08x,
     * 1.34x and 1.42x depth, won 3% of the time, and the hold engine kept
     * closing them with "there was no thinness to expire" — the exit already
     * knew what the entry had not checked.
     *
     * So the relative reading survives, multiplied by an absolute one: how far
     * below baseline the side price must travel through actually sits. At
     * baseline the factor contributes nothing, and conviction has to come from
     * the cascade cost and the mark-out instead.
     */
    const score = norm(liq.lwiBidAdj, liq.lwiAskAdj);
    // The side a move has to eat through: upward travel consumes asks.
    const travelSide = score > 0 ? liq.lwiAskAdj : liq.lwiBidAdj;
    const withdrawn = clamp01((1 - travelSide) / THINNESS_FULL);
    factors.push({
      name: "which side thinned",
      score: score * withdrawn,
      weight: 0.25,
      detail:
        `bids at ${liq.lwiBidAdj.toFixed(2)}x expected, asks at ${liq.lwiAskAdj.toFixed(2)}x — ` +
        (withdrawn <= 0
          ? `neither side is below its own baseline, so nothing has been withdrawn to travel into`
          : `${score < 0 ? "the floor has thinned more" : score > 0 ? "the ceiling has thinned more" : "both alike"}` +
            `, and the side it would travel through sits at ${travelSide.toFixed(2)}x` +
            (withdrawn < 1 ? ` — only ${(withdrawn * 100).toFixed(0)}% of a full withdrawal` : "")),
    });
  }

  /* Who has been right. The one factor scored against realised outcomes rather
   * than against the state of the book, which is why it carries weight
   * comparable to the seed cost despite being a shorter-lived reading. */
  const mk = state.markout;
  if (mk.warm && Math.abs(mk.informed) > 0.05) {
    factors.push({
      name: "who has been right",
      score: mk.informed,
      weight: 0.25,
      detail:
        mk.notes[0] ??
        `aggressive ${mk.informed > 0 ? "buying" : "selling"} has been marking out in its own favour`,
    });
  }

  /* Crowding, from what people are paying to stay on. Contrarian by
   * construction — see fundingSkew — and silent unless the rate is stretched. */
  const skew = fundingSkew(state.funding);
  if (skew !== 0) {
    factors.push({
      name: "who is paying to hold",
      score: skew,
      weight: 0.1,
      detail:
        `${state.funding.crowded} are paying ${Math.abs(state.funding.rate * 100).toFixed(4)}% ` +
        `every ${state.funding.intervalHours}h to stay on — crowded, and the fuel sits under them`,
    });
  }

  /* How far the first trigger sits. A cluster that is close is cheap to reach
   * regardless of what it would release. */
  if (state.mid && (state.nearestAbove || state.nearestBelow)) {
    const up = state.nearestAbove ? Math.abs(state.nearestAbove.price - state.mid) / state.mid : Infinity;
    const down = state.nearestBelow ? Math.abs(state.nearestBelow.price - state.mid) / state.mid : Infinity;
    if (Number.isFinite(up) || Number.isFinite(down)) {
      // Nearer down => favours down. Invert distances so nearer scores higher.
      const score = norm(Number.isFinite(up) ? 1 / up : 0, Number.isFinite(down) ? 1 / down : 0);
      factors.push({
        name: "nearest trigger",
        score,
        weight: 0.15,
        detail:
          `${Number.isFinite(down) ? `${(down * 100).toFixed(2)}% below` : "none below"}, ` +
          `${Number.isFinite(up) ? `${(up * 100).toFixed(2)}% above` : "none above"}`,
      });
    }
  }

  /* Who is currently paying the spread. Real, but noisy over a one-second
   * window and easily reversed, so it is weighted accordingly. */
  const flowTotal = state.flow.buy + state.flow.sell;
  if (flowTotal > 0) {
    const score = norm(state.flow.buy, state.flow.sell);
    const persistence = state.participants?.flowPersistence ?? 0;
    factors.push({
      name: "aggressive flow",
      score: score * (0.4 + 0.6 * persistence),
      weight: 0.2,
      detail:
        `${(Math.abs(score) * 100).toFixed(0)}% ${score > 0 ? "buy" : "sell"}-sided` +
        (persistence > 0.6 ? `, and sustained — consistent with a worked order` : `, but not sustained`),
    });
  }

  /* Where this name sits against the ones it usually moves with. Weighted
   * below the book-derived factors and above the resting imbalance: it is a
   * real measurement over a real window, but it says something about the
   * *character* of a move rather than about the cost of the next one, and the
   * situation it fires hardest in is also the one most likely to be news. It is
   * silent entirely unless the group has actually been correlated. */
  const dis = ctx.dislocation;
  if (dis?.warm && dis.coupled && dis.score !== 0) {
    factors.push({
      name: "against its peers",
      score: dis.score,
      weight: 0.12,
      detail: dis.note,
    });
  }

  /* Resting imbalance. Included for completeness and weighted last: displaying
   * size you do not intend to trade is the cheapest deception in the book. */
  if (liq) {
    factors.push({
      name: "resting imbalance",
      score: liq.imbalance,
      weight: 0.1,
      detail: `${(Math.abs(liq.imbalance) * 100).toFixed(0)}% ${liq.imbalance > 0 ? "more bids" : "more asks"} resting (easily faked)`,
    });
  }

  /* --------------------------------------------------------------- combine */

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const composite = totalWeight > 0 ? factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight : 0;

  // Evidence quality gates conviction independently of how lopsided the score is.
  let quality = 1;
  if (!state.health.tradeable) quality *= 0.2;
  if (liq && !liq.warm) quality *= 0.4;
  if (factors.length < 3) quality *= 0.6;
  // Just after a session boundary the depth and volatility baselines still
  // describe the phase that ended, and two of the factors above are built on
  // them. The reading is not wrong so much as premature.
  if (state.session.transitioning) quality *= 0.6;
  const behaviouralConfidence = state.participants?.confidence ?? 0.5;
  quality *= 0.5 + 0.5 * behaviouralConfidence;

  const magnitude = Math.abs(composite);
  const direction: Direction | null = magnitude < DEAD_ZONE ? null : composite > 0 ? "up" : "down";
  const conviction = direction ? Math.min(MAX_CONVICTION, magnitude * quality) : 0;

  const leaders = [...factors].sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight)).slice(0, 2);

  return {
    direction,
    conviction,
    composite,
    factors,
    summary: direction
      ? `Least resistance is ${direction === "down" ? "downward" : "upward"} — ` +
        leaders.map((f) => f.detail).join("; ")
      : "Neither side is meaningfully more exposed than the other right now.",
    caveat:
      "This is where price would travel if it gets pushed, not a prediction that it will be. " +
      "Nothing here measures intent, and none of it has been backtested.",
  };
}
