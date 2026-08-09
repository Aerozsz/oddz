import type { AgentState } from "./types";

/**
 * When to take money off, and when to let it run.
 *
 * Everything else in this system points one way. There is a stop, a ratchet to
 * break-even, an exit when the thesis dies, and a time limit — four adaptive
 * mechanisms, all of which decide when to *stop losing*. Against them sat a
 * single take-profit at a price chosen at entry: the one moment in the trade's
 * life with the least information about it.
 *
 * Expectancy is `P(win) × avgWin − P(loss) × avgLoss`. Three of those four
 * terms were being worked on. `avgWin` was fixed at whatever the first cluster
 * happened to be, and every improvement to the loss side made the asymmetry
 * worse rather than better: a system that cuts faster and faster while capping
 * its winners at the same place is converging on a smaller and smaller edge.
 *
 * The right tail is where this particular strategy earns. A liquidation cascade
 * that clears one cluster frequently runs into the next — that is what a
 * cascade *is* — so the distribution of favourable excursions has a long right
 * side, and a fixed target is a decision to sell it. Three mechanisms here, in
 * the order they fire:
 *
 *  1. **A trailing stop, once the trade has earned it.** The largest loss
 *     category measured in the post-mortem was "gave it back": positions that
 *     reached most of the way to target and returned to the stop. A stop that
 *     follows the high-water mark converts that whole category from a full loss
 *     into a partial win. It is the highest-value change here and the one that
 *     needs no forecast — it reacts to what already happened.
 *  2. **Scaling out.** Taking part of the position at a defined multiple of
 *     risk raises the hit rate and lowers the variance, at the cost of an extra
 *     exit fee and a smaller tail. Whether that trade is worth making is an
 *     arithmetic question this file answers explicitly rather than assuming.
 *  3. **Extending the target when the reasoning is intact.** The exact mirror
 *     of the hold engine's thesis-death exit. If price arrives at the target
 *     while the book is still thin, flow is still pushing and another cluster
 *     sits beyond it, then closing is selling the exact scenario the trade was
 *     opened to catch.
 *
 * The discipline that keeps this from becoming hope: **the stop only ever moves
 * toward the position**, and the target only extends when there is a *named
 * level* to extend to. "It might keep going" is not a reason to hold; "there is
 * a cluster 0.4% further and the book is still thin" is.
 */

export interface ProfitConfig {
  /**
   * Multiples of risk before the trail activates.
   *
   * Below this the break-even ratchet governs. Trailing from the first tick
   * would put the stop inside the noise the original stop was widened to sit
   * outside of, which turns ordinary retracement into a scratch.
   */
  trailArmsAtR: number;
  /**
   * Trail distance as a multiple of the initial stop distance, at the moment
   * the trail arms. The same distance that was judged to be outside the noise
   * when the trade was sized, because the noise has not changed.
   */
  trailStartMultiple: number;
  /**
   * The tightest the trail ever gets, as a multiple of the initial stop.
   *
   * It tightens as the move extends, because a move that has already run a long
   * way has less left in it than one that has just started, and because the open
   * profit at risk grows with every R while the informational value of the
   * original stop distance does not.
   */
  trailMinMultiple: number;
  /** R at which the trail reaches its tightest. */
  trailTightensByR: number;
  /** Multiples of risk at which to take part of the position off. 0 disables. */
  scaleOutAtR: number;
  /** Fraction of the original position taken at that point. */
  scaleOutFraction: number;
  /**
   * How close to the target price counts as "arrived", as a fraction.
   *
   * Extension has to be decided *before* the resting take-profit fills, so it
   * triggers on approach rather than on touch.
   */
  extendNearTarget: number;
  /** Thesis health required to extend rather than take the target. */
  extendMinHealth: number;
  /**
   * How many times one position's target may be rolled out. 0 disables.
   *
   * Unbounded rolling is not "letting a winner run", it is removing the exit.
   * There is almost always another cluster beyond the current one, so a target
   * that extends whenever price approaches it retreats every time it is nearly
   * reached, and the position cannot close at a profit however far it goes. A
   * hard count is the only thing that makes extension safe, because every
   * individual roll looks justified.
   */
  maxTargetRolls: number;
  /**
   * The furthest a rolled target may sit from entry, in multiples of risk.
   *
   * A second, independent ceiling. The roll count bounds how often; this bounds
   * how far, so a single enormous jump to a distant cluster cannot do what a
   * sequence of rolls is prevented from doing.
   */
  maxTargetR: number;
}

export const DEFAULT_PROFIT: ProfitConfig = {
  // One R. At this point the trade has produced as much as it risked, and a
  // stop that gives all of that back is indefensible.
  trailArmsAtR: 1,
  trailStartMultiple: 1,
  // Not tighter than half the original stop. Below that the trail sits inside
  // the range the price covers on its way up, and the trail stops being
  // protection and becomes an exit signal of its own.
  trailMinMultiple: 0.5,
  trailTightensByR: 3,
  scaleOutAtR: 1.5,
  scaleOutFraction: 0.4,
  extendNearTarget: 0.85,
  extendMinHealth: 0.7,
  // Two. Enough to follow a cascade through a second and third cluster, few
  // enough that the position still has a place it is trying to get to.
  maxTargetRolls: 2,
  maxTargetR: 6,
};

export interface ProfitInput {
  state: AgentState;
  side: "long" | "short";
  entryPrice: number;
  /** Where the stop rests now. The decision may only improve it. */
  stopPrice: number | null;
  /** The stop distance the position was sized against, in percent. */
  initialStopPct: number;
  targetPrice: number | null;
  /** Best price reached since entry, from the live excursion tracker. */
  highWaterPrice: number;
  /** Fraction of the original position already taken off, 0..1. */
  scaledOut: number;
  /** How many times this position's target has already been moved out. */
  targetRolls: number;
  /** Round-trip fee in percent of notional, for the scale-out arithmetic. */
  feePct: number;
  /**
   * How much of the entry's reasoning still holds, 0..1.
   *
   * Supplied by the caller from the hold engine rather than recomputed, so the
   * two cannot disagree about the same position — one saying the thesis is dead
   * while the other extends the target on it would be the worst possible pair
   * of decisions.
   */
  thesisHealth: number;
  config?: Partial<ProfitConfig>;
}

export interface ProfitDecision {
  /** Where the stop should rest. Null leaves it alone. Never moves away. */
  stopPrice: number | null;
  /** Fraction of the original position to close now. 0 for none. */
  scaleOutFraction: number;
  /** Where the target should rest. Null leaves it alone. */
  targetPrice: number | null;
  /** Profit so far, in multiples of the risk taken. */
  rMultiple: number;
  reason: string;
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function profitDecision(input: ProfitInput): ProfitDecision {
  const cfg = { ...DEFAULT_PROFIT, ...input.config };
  const { state, side, entryPrice, targetPrice, highWaterPrice } = input;
  const notes: string[] = [];
  const long = side === "long";

  const mark = state.mark ?? state.mid ?? entryPrice;
  const riskDistance = entryPrice * (input.initialStopPct / 100);
  if (!(riskDistance > 0) || !(entryPrice > 0)) {
    return { stopPrice: null, scaleOutFraction: 0, targetPrice: null, rMultiple: 0,
      reason: "no risk distance to measure profit against", notes };
  }

  // Measured from the high-water mark, not from the mark. The trail's whole
  // purpose is to remember the best the trade ever was, and a decision that
  // reads only the current price forgets it the moment price ticks back.
  const peak = long ? Math.max(highWaterPrice, entryPrice) : Math.min(highWaterPrice, entryPrice);
  const travelledPeak = long ? peak - entryPrice : entryPrice - peak;
  const travelledNow = long ? mark - entryPrice : entryPrice - mark;
  const rPeak = travelledPeak / riskDistance;
  const rNow = travelledNow / riskDistance;

  let stopPrice: number | null = null;
  let scaleOutFraction = 0;
  let newTarget: number | null = null;

  /* ------------------------------------------------------------- the trail */

  // Same tolerance as the scale-out gate below, for the same reason.
  if (rPeak >= cfg.trailArmsAtR - 1e-9) {
    /*
     * Tightens as the move extends.
     *
     * At the arming point the trail sits a full stop distance behind the peak —
     * the distance already judged to be outside this contract's noise. By
     * `trailTightensByR` it has closed to `trailMinMultiple`, because the open
     * profit being protected has grown severalfold while the noise has not, and
     * a fixed-width trail therefore risks progressively more to learn the same
     * thing.
     */
    const progress = clamp((rPeak - cfg.trailArmsAtR) / Math.max(1e-9, cfg.trailTightensByR - cfg.trailArmsAtR), 0, 1);
    const multiple = cfg.trailStartMultiple - (cfg.trailStartMultiple - cfg.trailMinMultiple) * progress;
    const trailDistance = riskDistance * multiple;
    const candidate = long ? peak - trailDistance : peak + trailDistance;

    /*
     * Only ever an improvement, and never through the mark.
     *
     * The first condition is what makes this a ratchet rather than a stop that
     * wanders; the second stops a fast retracement from placing a stop the
     * wrong side of price, which fills instantly at market and turns a managed
     * exit into whatever the book happens to offer.
     */
    const improves = input.stopPrice === null || (long ? candidate > input.stopPrice : candidate < input.stopPrice);
    const safe = long ? candidate < mark : candidate > mark;
    if (improves && safe) {
      stopPrice = candidate;
      notes.push(
        `${rPeak.toFixed(1)}R at best — trailing ${multiple.toFixed(2)} stops behind ${peak.toFixed(4)}, ` +
          `locking in ${((long ? candidate - entryPrice : entryPrice - candidate) / riskDistance).toFixed(1)}R`,
      );
    } else if (improves && !safe) {
      notes.push("the trail would sit the wrong side of mark — left where it is until price recovers");
    }
  }

  /* ---------------------------------------------------------- the scale-out */

  /*
   * A tolerance on the threshold, because R is derived from price differences.
   *
   * `100.3 - 100` is 0.29999999999999716 in binary floating point, so a
   * position exactly 1.5R in profit computes as 1.4999999 and silently misses a
   * `>= 1.5` gate. On a threshold checked every twenty seconds that mostly
   * resolves itself a tick later, which is worse than failing outright: it
   * makes the mechanism look like it works while its behaviour at the boundary
   * depends on rounding.
   */
  const R_EPSILON = 1e-9;
  if (cfg.scaleOutAtR > 0 && input.scaledOut <= 0 && rNow >= cfg.scaleOutAtR - R_EPSILON) {
    /*
     * What the partial exit actually costs, which is less than it looks.
     *
     * The instinct is to charge a scale-out a full extra round trip, and that
     * is wrong: the fraction being taken pays an exit fee whenever it exits,
     * at the target or at the stop. Taking it here changes *when* that fee is
     * paid, not whether. The genuine cost is the tail — whatever that fraction
     * would have earned beyond this point — and the genuine benefit is that it
     * can no longer be given back.
     *
     * So the test is only that the piece is being banked at a real profit
     * rather than at a fee-sized scratch. Half again the round trip is the
     * floor. An earlier version demanded three times, which on a 0.1% round
     * trip needed a 0.3% move — larger than most of the winners this strategy
     * actually produces, so the mechanism would have been switched on and
     * never fired. That is the same miscalibration as setting the reward
     * floor above the observed edge, and it fails silently in the same way.
     */
    const bankedPct = (travelledNow / entryPrice) * 100;
    if (bankedPct > input.feePct * 1.5) {
      scaleOutFraction = clamp(cfg.scaleOutFraction, 0, 0.9);
      notes.push(
        `${rNow.toFixed(1)}R reached — taking ${(scaleOutFraction * 100).toFixed(0)}% off at ${mark.toFixed(4)}, ` +
          `banking ${bankedPct.toFixed(3)}% against a ${input.feePct.toFixed(3)}% round trip and leaving the rest to run`,
      );
    } else {
      notes.push(
        `${rNow.toFixed(1)}R is only ${bankedPct.toFixed(3)}% of price — too close to the ` +
          `${input.feePct.toFixed(3)}% round trip for a partial exit to be worth its fee`,
      );
    }
  }

  /* ------------------------------------------------------ target extension */

  if (targetPrice !== null && rPeak > 0) {
    const distance = Math.abs(targetPrice - entryPrice);
    const progressToTarget = distance > 0 ? travelledNow / distance : 0;
    const arrived = progressToTarget >= cfg.extendNearTarget;

    if (arrived) {
      /*
       * Extend only to a named level, never on a feeling.
       *
       * "It might keep going" is how a target becomes no target at all. What
       * justifies holding past the level the trade was sized against is another
       * observable level beyond it, plus the reading that got us here still
       * being true — which is exactly the cascade case this strategy exists to
       * catch, where clearing one cluster is what triggers the next.
       */
      const beyond = long ? state.nearestAbove : state.nearestBelow;
      const further = beyond !== null && (long ? beyond.price > targetPrice : beyond.price < targetPrice);

      /*
       * Three gates, all of which must hold, because each closes a different
       * way this turns into a position that never takes profit.
       *
       * The roll count stops the target retreating every time price nearly
       * reaches it — the failure that actually happened, where a winner could
       * not close because there is always another cluster further out and every
       * single roll looked justified on its own.
       *
       * The distance ceiling stops one jump doing what a sequence cannot.
       *
       * The trail requirement is the important one. Moving the target only
       * makes sense if something else has become the exit; with the trail
       * unarmed, rolling removes the only thing that would have closed the
       * position in profit and replaces it with nothing.
       */
      const rollsLeft = input.targetRolls < cfg.maxTargetRolls;
      const newR = beyond !== null ? Math.abs(beyond.price - entryPrice) / riskDistance : Infinity;
      const withinReach = newR <= cfg.maxTargetR;
      const trailIsLive = rPeak >= cfg.trailArmsAtR - 1e-9;

      if (further && input.thesisHealth >= cfg.extendMinHealth && rollsLeft && withinReach && trailIsLive) {
        newTarget = beyond!.price;
        notes.push(
          `arrived at ${targetPrice} with the reasoning ${(input.thesisHealth * 100).toFixed(0)}% intact and ` +
            `another cluster at ${beyond!.price} — target rolled out, with the trail behind it`,
        );
      } else if (further) {
        const why = !rollsLeft
          ? `the target has already been rolled ${input.targetRolls} time${input.targetRolls === 1 ? "" : "s"} — ` +
            `it stands now, so this position has somewhere it is actually trying to get to`
          : !withinReach
            ? `${beyond!.price} is ${newR.toFixed(1)}R from entry, past the ${cfg.maxTargetR}R ceiling`
            : !trailIsLive
              ? `the trail has not armed yet, so rolling the target would leave nothing to close this in profit`
              : `the reasoning is only ${(input.thesisHealth * 100).toFixed(0)}% intact`;
        notes.push(`there is a level at ${beyond!.price} beyond the target, but ${why} — taking the target that was planned`);
      }
    }
  }

  const acted = stopPrice !== null || scaleOutFraction > 0 || newTarget !== null;
  return {
    stopPrice,
    scaleOutFraction,
    targetPrice: newTarget,
    rMultiple: rNow,
    reason: acted
      ? notes[0] ?? "managing the position"
      : rPeak >= cfg.trailArmsAtR
        ? `${rNow.toFixed(1)}R, nothing to improve — the trail is already where it should be`
        : `${rNow.toFixed(1)}R of the ${cfg.trailArmsAtR}R the trail needs before it arms`,
    notes,
  };
}
