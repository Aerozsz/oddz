import type { Report } from "./learn";
import { classifyLoss, type LossKind } from "./learn";
import type { TradeRecord } from "./postmortem";

/**
 * Move the caps in response to what the closed trades actually did.
 *
 * This is the loop closed. The analyser says what went wrong; this decides
 * whether the evidence is strong enough to act and, if it is, by how much.
 *
 * The whole design is about one failure mode, because it is the failure mode
 * every naive version of this has: chasing its own tail. A run of stop-outs
 * makes the stop look too tight, so it widens; the next run of give-backs makes
 * it look too wide, so it tightens; each move is locally justified by real data
 * and the sequence as a whole is a random walk that never lets any setting
 * accumulate enough trades to be evaluated. Four mechanisms stop that, and none
 * of them is a judgement call the tuner gets to make:
 *
 *  1. **Bounds.** Every setting has a floor and ceiling it cannot leave, no
 *     matter what the data says. If the evidence wants a 5% stop, the evidence
 *     is wrong or the strategy is broken, and either way a human should see it.
 *  2. **Step limits.** A change moves a bounded fraction of the way toward what
 *     the data suggests, never all the way. One unrepresentative week can
 *     therefore nudge but not relocate.
 *  3. **Spacing in trades, not time.** A setting cannot move again until enough
 *     *new closes* have happened to evaluate the last move. Wall-clock spacing
 *     would let a quiet week authorise a change nothing was learned from.
 *  4. **Hysteresis.** Reversing a recent change needs materially stronger
 *     evidence than making it did. This is what actually kills the oscillation:
 *     it makes the round trip cost more than the one-way trip, so noise cannot
 *     fund it.
 *
 * On top of that, evidence is priced asymmetrically. Reducing exposure is
 * allowed on ordinary evidence, because being wrong costs a smaller position.
 * Increasing it needs a lot more, because being wrong costs money on every
 * trade until the next review. That asymmetry is not caution for its own sake —
 * it is the recognition that the two errors have different sizes.
 *
 * One clarification that matters, because it changes which dials are dangerous:
 * widening the stop does not increase risk here. The sizer computes
 * `notional = riskUsd / stopPct`, so a wider stop buys a smaller position and
 * the dollars at risk are identical. Stop distance is a geometry dial, not a
 * risk dial, and it can be tuned freely inside its bounds. What genuinely
 * changes exposure is `riskPerTradePct`, and that is the one with the strictest
 * gate.
 */

/**
 * The settings the tuner is allowed to touch. Nothing outside this can move.
 *
 * Three dials are deliberately absent, and their absence is a decision rather
 * than an oversight: `maxDailyLossUsd`, `lossCooldownMin` and `maxTradesPerDay`
 * govern how much the system is permitted to trade at all. They are the
 * operator's throttle on data collection — relaxed to gather evidence, tightened
 * to stop bleeding — and a tuner that could quietly close that throttle would
 * be cutting off its own supply of evidence while claiming to learn from it.
 * Worse, it would do so exactly when the data is worst, which is when the
 * decision most needs a person.
 */
export interface TunableLimits {
  breakEvenAtPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  riskPerTradePct: number;
  minRewardRisk: number;
}

export type Tunable = keyof TunableLimits;

interface Bounds {
  min: number;
  max: number;
  /** The largest single move, as a fraction of the current value. */
  maxStep: number;
  /** Which way reduces exposure. "none" means the dial does not change risk. */
  safer: "down" | "up" | "none";
  /** Decimal places to round to, matching what the form accepts. */
  dp: number;
}

/**
 * The box the tuner runs inside.
 *
 * Chosen so that every corner of it is somewhere a person would be willing to
 * wake up and find the system, because that is exactly what these guarantee and
 * the only thing they guarantee.
 */
export const BOUNDS: Record<Tunable, Bounds> = {
  // Below ~35% the ratchet fires on ordinary retracement and converts healthy
  // trades into scratches; above 85% almost nothing reaches it, which is the
  // same as switching it off.
  breakEvenAtPct: { min: 35, max: 85, maxStep: 0.25, safer: "down", dp: 0 },
  // 0.1% is under the round-trip cost on most venues, so a stop there loses to
  // fees before it loses to the market. 1.5% on a name that moves 0.2% a day is
  // a stop that will never be hit, which is not protection.
  stopLossPct: { min: 0.1, max: 1.5, maxStep: 0.5, safer: "none", dp: 3 },
  // The book reading behind an entry does not survive four hours, whatever the
  // trade is doing.
  maxHoldMinutes: { min: 10, max: 240, maxStep: 0.5, safer: "down", dp: 0 },
  // The real exposure dial. 6% of free collateral per trade is already past
  // quarter-Kelly at any hit rate this has measured.
  riskPerTradePct: { min: 0.5, max: 6, maxStep: 0.25, safer: "down", dp: 2 },
  // Under 1.0 the venue takes more than the move is worth.
  minRewardRisk: { min: 1, max: 3, maxStep: 0.3, safer: "up", dp: 2 },
};

export interface TuneChange {
  setting: Tunable;
  from: number;
  to: number;
  /** One line, in the trade numbers that caused it. */
  reason: string;
  direction: "safer" | "riskier" | "neutral";
}

export interface TuneEntry extends TuneChange {
  at: number;
  /** Who moved it. Operator changes are recorded so the tuner can defer to them. */
  by: "auto" | "operator";
  /** Closed trades on the books when this happened — the spacing clock. */
  tradesAt: number;
}

export interface TuneConfig {
  /** Losses needed before any anatomy-driven change. */
  minLosses: number;
  /** New closes required between two changes to the same setting. */
  spacingTrades: number;
  /**
   * New closes required between *any* two changes, across all settings.
   *
   * Per-setting spacing alone is not enough, and the gap it leaves is subtle:
   * the ranking always offers the same dial first, so if that one's own spacing
   * happens to clear every pass it takes every slot and nothing else ever
   * moves. A run of losses would ratchet exposure down over and over while the
   * stop geometry that was causing the losses went untouched.
   *
   * A global gap forces the dials to take turns, and — more importantly — means
   * that after any change there is a stretch of trades attributable to that
   * change alone. Without it, the tuner cannot evaluate its own work.
   */
  globalSpacingTrades: number;
  /** Closes the tuner waits after a human touches a setting. */
  operatorRespectTrades: number;
  /** Share of losses one class must hold to drive a change. */
  majorityShare: number;
  /** The stronger share required to reverse a recent change to the same dial. */
  reversalShare: number;
  /** Closes needed before exposure may be increased at all. */
  minTradesToRaiseRisk: number;
}

export const DEFAULT_TUNE: TuneConfig = {
  minLosses: 4,
  // Enough new closes that the last change has been exercised. Below this the
  // tuner is re-reading the same trades and calling it new evidence.
  spacingTrades: 8,
  globalSpacingTrades: 8,
  // Longer than the tuner's own spacing. If someone reached in and set a
  // number, they had a reason the log does not contain, and overriding that
  // within a couple of trades is how an operator learns not to trust this.
  operatorRespectTrades: 12,
  majorityShare: 0.5,
  // A clear margin rather than a hair over half. This is the hysteresis: the
  // return trip needs evidence the outbound trip did not.
  reversalShare: 0.65,
  minTradesToRaiseRisk: 25,
};

export interface TuneInput {
  report: Report;
  trades: TradeRecord[];
  limits: TunableLimits;
  history: TuneEntry[];
  config?: Partial<TuneConfig>;
  now?: number;
}

export interface TuneResult {
  changes: TuneChange[];
  /** Why a change that was otherwise indicated did not happen. Shown, not hidden. */
  held: string[];
}

const round = (v: number, dp: number) => Number(v.toFixed(dp));
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Losses of one kind, with their excursions, for sizing the change itself. */
function lossesOfKind(trades: TradeRecord[], kind: LossKind): TradeRecord[] {
  return trades.filter((t) => t.outcome === "loss" && classifyLoss(t).kind === kind);
}

/**
 * Clamp a proposal into the box, the step limit, and the rounding.
 *
 * Returns null when the result is not actually a change — a step limit that
 * rounds back to where it started is a no-op, and recording it would burn the
 * spacing budget and reset the hysteresis for nothing.
 */
function bounded(setting: Tunable, from: number, want: number): number | null {
  const b = BOUNDS[setting];
  const step = Math.abs(from) * b.maxStep;
  const limited = Math.max(from - step, Math.min(from + step, want));
  const clamped = Math.max(b.min, Math.min(b.max, limited));
  const to = round(clamped, b.dp);
  return to === round(from, b.dp) ? null : to;
}

function directionOf(setting: Tunable, from: number, to: number): TuneChange["direction"] {
  const safer = BOUNDS[setting].safer;
  if (safer === "none") return "neutral";
  const movedDown = to < from;
  return (safer === "down") === movedDown ? "safer" : "riskier";
}

export function proposeTuning(input: TuneInput): TuneResult {
  const cfg = { ...DEFAULT_TUNE, ...input.config };
  const { report, trades, limits, history } = input;
  const changes: TuneChange[] = [];
  const held: string[] = [];
  const total = trades.length;

  /* -------------------------------------------------------------- gating */

  const lastFor = (setting: Tunable) =>
    history.filter((h) => h.setting === setting).reduce<TuneEntry | null>((a, h) => (!a || h.at > a.at ? h : a), null);

  /*
   * The global gap, checked once before anything else is considered.
   *
   * Deliberately counts operator changes too. A human who has just retuned
   * something is mid-thought, and the tuner joining in on the next close makes
   * the two of them impossible to tell apart in the record afterwards.
   */
  const lastAny = history.reduce<TuneEntry | null>((a, h) => (!a || h.at > a.at ? h : a), null);
  if (lastAny) {
    const since = total - lastAny.tradesAt;
    if (since < cfg.globalSpacingTrades) {
      return {
        changes: [],
        held: [
          `${lastAny.setting} changed ${since} close${since === 1 ? "" : "s"} ago — nothing else moves for ` +
            `${cfg.globalSpacingTrades - since} more, so those trades measure that change and nothing else`,
        ],
      };
    }
  }

  /**
   * May this setting move at all, and how hard is it to move this way?
   *
   * Returns the share of losses required, or null when the setting is locked.
   * Everything that stops a change lives here so no branch below can forget one.
   */
  const gate = (setting: Tunable, direction: "down" | "up"): number | null => {
    const last = lastFor(setting);
    if (last) {
      const since = total - last.tradesAt;
      const need = last.by === "operator" ? cfg.operatorRespectTrades : cfg.spacingTrades;
      if (since < need) {
        held.push(
          last.by === "operator"
            ? `${setting} was set by hand ${since} close${since === 1 ? "" : "s"} ago — leaving it alone for ` +
              `${need - since} more, because whoever set it had a reason this log does not contain`
            : `${setting} was moved ${since} close${since === 1 ? "" : "s"} ago — waiting ${need - since} more ` +
              `so the last change has actually been exercised`,
        );
        return null;
      }
      // Hysteresis: reversing costs more than the original move did.
      const lastWentDown = last.to < last.from;
      const reversing = lastWentDown === (direction === "up");
      if (reversing) return cfg.reversalShare;
    }
    return cfg.majorityShare;
  };

  const anatomyShare = (kind: LossKind) =>
    report.anatomy.find((a) => a.kind === kind)?.share ?? 0;
  const anatomyCount = (kind: LossKind) =>
    report.anatomy.find((a) => a.kind === kind)?.count ?? 0;

  const totalLosses = report.anatomy.reduce((a, x) => a + x.count, 0);
  if (totalLosses < cfg.minLosses) {
    held.push(
      `${totalLosses} losing trade${totalLosses === 1 ? "" : "s"} on record — the anatomy needs ` +
        `${cfg.minLosses} before it can drive anything`,
    );
  }

  const canUseAnatomy = totalLosses >= cfg.minLosses;

  /* ------------------------------------------ 1. the ratchet, on give-backs */

  if (canUseAnatomy) {
    const need = gate("breakEvenAtPct", "down");
    const share = anatomyShare("gave-it-back");
    if (need !== null && share > need) {
      const gaveBack = lossesOfKind(trades, "gave-it-back");
      /*
       * Only the give-backs the current threshold could not reach.
       *
       * This distinction is the difference between a fix and a no-op, and
       * getting it wrong produces a change that looks reasonable and does
       * nothing. A trade that peaked at 85% with the ratchet set to 60% should
       * have had its stop moved to break-even on the way past, and should
       * therefore have ended as a scratch. That it ended as a full loss does
       * not mean 60% was too high — it means the ratchet did not fire, which is
       * a defect in the bracket code and cannot be repaired by moving the
       * number that was already low enough.
       *
       * So the threshold is only re-derived from trades that turned *below* it.
       * Those are the ones a lower setting would genuinely have caught.
       */
      const threshold = limits.breakEvenAtPct / 100;
      const unreached = gaveBack.filter((t) => t.peakProgress < threshold);
      const missedDespite = gaveBack.length - unreached.length;

      if (unreached.length < Math.max(2, gaveBack.length * 0.5)) {
        held.push(
          `${missedDespite} of ${gaveBack.length} give-backs peaked ABOVE the ${limits.breakEvenAtPct}% ratchet ` +
            `and still ended as full losses — the ratchet should have moved those stops to break-even and did ` +
            `not. Lowering the threshold cannot fix that; check that the ratchet is firing at all.`,
        );
      } else {
        const reached = median(unreached.map((t) => t.peakProgress));
        /*
         * Aim below where these trades actually turned, not at a round number.
         *
         * The ratchet has to fire *before* the reversal to catch it, so the
         * target is a margin under the median peak. Ten points is roughly the
         * spread of peaks in a typical batch — enough to get ahead of the
         * median case without landing so early that ordinary retracement trips
         * it.
         */
        if (reached !== null) {
          const want = Math.round(reached * 100) - 10;
          const to = bounded("breakEvenAtPct", limits.breakEvenAtPct, want);
          if (to !== null && to < limits.breakEvenAtPct) {
            changes.push({
              setting: "breakEvenAtPct",
              from: limits.breakEvenAtPct,
              to,
              direction: directionOf("breakEvenAtPct", limits.breakEvenAtPct, to),
              reason:
                `${unreached.length} of ${totalLosses} losses turned at a median ${(reached * 100).toFixed(0)}% ` +
                `of the way to target — short of the ${limits.breakEvenAtPct}% ratchet, so their stops were never ` +
                `moved up. At ${to}% that class of trade ends as a scratch instead of a full loss.`,
            });
          }
        }
      }
    } else if (need !== null && share > 0) {
      held.push(
        `give-backs are ${(share * 100).toFixed(0)}% of losses, under the ${(need * 100).toFixed(0)}% ` +
          `needed${need > cfg.majorityShare ? " to reverse a recent change" : ""}`,
      );
    }
  }

  /* ------------------------------- 2. stop geometry, on mid-move stop-outs */

  if (canUseAnatomy) {
    const need = gate("stopLossPct", "up");
    const share = anatomyShare("stopped-mid-move");
    if (need !== null && share > need) {
      const stopped = lossesOfKind(trades, "stopped-mid-move");
      const worst = median(stopped.map((t) => Math.abs(t.maePct)));
      /*
       * Put the stop outside the range these trades actually covered.
       *
       * A fifth of headroom over the median adverse excursion, because the
       * median is by construction the level half of them exceeded. And this
       * costs nothing in risk: the sizer divides the same dollar risk by the
       * new distance, so the position shrinks by exactly the factor the stop
       * widened. The trade gets room and the loss stays the same size.
       */
      if (worst !== null && worst > 0) {
        const to = bounded("stopLossPct", limits.stopLossPct, worst * 1.2);
        if (to !== null) {
          const shrink = limits.stopLossPct / to;
          changes.push({
            setting: "stopLossPct",
            from: limits.stopLossPct,
            to,
            direction: directionOf("stopLossPct", limits.stopLossPct, to),
            reason:
              `${anatomyCount("stopped-mid-move")} of ${totalLosses} losses moved in favour first and were ` +
              `then stopped, with a median adverse excursion of ${worst.toFixed(3)}% against a ` +
              `${limits.stopLossPct}% stop. At ${to}% the stop sits outside that range; the sizer divides ` +
              `the same risk by the wider distance, so positions become ${shrink.toFixed(2)}x smaller and ` +
              `the dollars at risk are unchanged.`,
          });
        }
      }
    }
  }

  /* --------------------------------------- 3. hold window, on time-cut losses */

  if (canUseAnatomy) {
    const share = anatomyShare("cut-on-time");
    const cut = lossesOfKind(trades, "cut-on-time");
    const progress = median(cut.map((t) => t.peakProgress));
    if (share > cfg.majorityShare && progress !== null) {
      /*
       * The one place the anatomy alone is not enough to know what to do.
       *
       * "The hold engine closed most of the losers" has two opposite readings.
       * If those positions were making progress it is cutting winners early and
       * the window is too short. If they were flat it is doing precisely its
       * job, and lengthening the window would mean holding dead trades longer —
       * the exact behaviour the time stop was introduced to end. The excursion
       * settles it, which is why this branch reads progress before direction.
       */
      if (progress > 0.4) {
        const need = gate("maxHoldMinutes", "up");
        if (need !== null && share > need) {
          const heldMins = median(cut.map((t) => t.heldMs / 60_000)) ?? limits.maxHoldMinutes;
          const to = bounded("maxHoldMinutes", limits.maxHoldMinutes, heldMins * 1.5);
          if (to !== null) {
            changes.push({
              setting: "maxHoldMinutes",
              from: limits.maxHoldMinutes,
              to,
              direction: directionOf("maxHoldMinutes", limits.maxHoldMinutes, to),
              reason:
                `${anatomyCount("cut-on-time")} of ${totalLosses} losses were closed by the hold engine at a ` +
                `median ${(progress * 100).toFixed(0)}% of the way to target — those were working trades cut ` +
                `short, not dead ones. Extending the window to ${to} min gives them room.`,
            });
          }
        }
      } else {
        held.push(
          `the hold engine closed ${anatomyCount("cut-on-time")} losses, but at a median ` +
            `${(progress * 100).toFixed(0)}% progress they were going nowhere — that is the time stop working, ` +
            `so the window stays and the entries are what need attention`,
        );
      }
    }
  }

  /* ----------------------------------------- 4. exposure, on measured results */

  /*
   * The only dial here that changes what a loss costs, so it is the only one
   * driven by the outcome distribution rather than by the anatomy of losses.
   *
   * Cutting is allowed as soon as the interval says the edge is negative.
   * Raising needs a much larger sample and an interval clear of zero, because
   * the two mistakes are not the same size: sizing down when the edge was fine
   * costs some upside, and sizing up when it was not costs money on every trade
   * until somebody notices.
   */
  const exp = report.expectancyR;
  if (exp.n >= 10 && exp.hi < 0) {
    const need = gate("riskPerTradePct", "down");
    if (need !== null) {
      const to = bounded("riskPerTradePct", limits.riskPerTradePct, limits.riskPerTradePct * 0.75);
      if (to !== null) {
        changes.push({
          setting: "riskPerTradePct",
          from: limits.riskPerTradePct,
          to,
          direction: "safer",
          reason:
            `expectancy over ${exp.n} trades is ${exp.mean.toFixed(2)}R with the whole interval below zero ` +
            `(${exp.lo.toFixed(2)} to ${exp.hi.toFixed(2)}). That is a measured negative edge, not a bad run, ` +
            `so exposure comes down to ${to}% while it is diagnosed.`,
        });
      }
    }
  } else if (exp.n >= cfg.minTradesToRaiseRisk && exp.lo > 0.1) {
    const need = gate("riskPerTradePct", "up");
    if (need !== null) {
      const to = bounded("riskPerTradePct", limits.riskPerTradePct, limits.riskPerTradePct * 1.25);
      if (to !== null) {
        changes.push({
          setting: "riskPerTradePct",
          from: limits.riskPerTradePct,
          to,
          direction: "riskier",
          reason:
            `expectancy over ${exp.n} trades is +${exp.mean.toFixed(2)}R with the whole interval above zero ` +
            `(${exp.lo.toFixed(2)} to ${exp.hi.toFixed(2)}) — a measured edge rather than a good run. ` +
            `Exposure goes to ${to}%, a quarter step, not the whole distance.`,
        });
      }
    }
  } else if (exp.n >= 10 && exp.lo < 0 && exp.hi > 0) {
    held.push(
      `expectancy is ${exp.mean.toFixed(2)}R over ${exp.n} trades but the interval spans zero ` +
        `(${exp.lo.toFixed(2)} to ${exp.hi.toFixed(2)}) — exposure does not move on a number this uncertain`,
    );
  }

  /* ------------------------------- 5. entry quality, on never-worked losses */

  if (canUseAnatomy && anatomyShare("never-worked") > cfg.majorityShare) {
    /*
     * Entries that were wrong on arrival, which no exit rule can reach.
     *
     * The right fix is a better filter and the tuner cannot write one. What it
     * can do is make each setup clear a higher bar before it is taken, which
     * reduces the count of these without pretending to know which ones were
     * bad. Reported as a change to the reward floor, not to the entry logic.
     */
    const need = gate("minRewardRisk", "up");
    if (need !== null && anatomyShare("never-worked") > need) {
      const to = bounded("minRewardRisk", limits.minRewardRisk, limits.minRewardRisk * 1.15);
      if (to !== null) {
        changes.push({
          setting: "minRewardRisk",
          from: limits.minRewardRisk,
          to,
          direction: directionOf("minRewardRisk", limits.minRewardRisk, to),
          reason:
            `${anatomyCount("never-worked")} of ${totalLosses} losses never moved in favour at all, which no ` +
            `exit rule reaches. Raising the reward floor to ${to} makes each setup clear a higher bar — a ` +
            `blunt fix for an entry problem, and the only one available without a filter a human has written. ` +
            (report.actionable.length > 0
              ? `The conditions table has a real split now (${report.actionable[0].label}); that is the sharper fix.`
              : `Watch the conditions table for a split that separates them.`),
        });
      }
    }
  }

  /*
   * Never more than one change per pass.
   *
   * Two settings moving together cannot be told apart afterwards: if the stop
   * widens and the ratchet drops on the same close and the next ten trades
   * improve, nothing in the record says which one did it — and the tuner has
   * just destroyed its own ability to evaluate itself. Highest-cost failure
   * first; the rest wait for the next close.
   */
  /*
   * Rotation: the dial that moved last goes to the back of the queue.
   *
   * Without this the ranking is a monopoly. A sustained losing run keeps
   * exposure top-ranked, so it gets cut, and cut again, and again — down to the
   * floor — while the stop geometry that was causing the losses is never
   * touched, because it never reaches the front of a list exposure permanently
   * occupies. The account ends up trading a broken setup in ever smaller size,
   * which is a slower way to lose rather than a fix.
   *
   * Deferring the incumbent means a second problem gets its turn as soon as one
   * is indicated, and costs nothing when it is the only candidate.
   */
  const incumbent = lastAny?.setting;
  const ranked = changes.sort(
    (a, b) => (rank(a.setting) + (a.setting === incumbent ? 100 : 0)) -
              (rank(b.setting) + (b.setting === incumbent ? 100 : 0)),
  );
  if (ranked.length > 1) {
    held.push(
      `${ranked.length - 1} other change${ranked.length === 2 ? "" : "s"} indicated (` +
        `${ranked.slice(1).map((c) => c.setting).join(", ")}) — held back so this one can be evaluated on its own`,
    );
  }
  return { changes: ranked.slice(0, 1), held };
}

/**
 * Which change goes first when several are indicated.
 *
 * Exposure ahead of everything, because it is the only one that changes what a
 * loss costs. Then the two that convert existing losses into smaller ones, then
 * the blunt instruments.
 */
function rank(setting: Tunable): number {
  const order: Tunable[] = [
    "riskPerTradePct",
    "breakEvenAtPct",
    "stopLossPct",
    "maxHoldMinutes",
    "minRewardRisk",
  ];
  const i = order.indexOf(setting);
  return i < 0 ? order.length : i;
}
