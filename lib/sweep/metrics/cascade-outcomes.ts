/**
 * Did the cascade actually happen, and did it go where the model said?
 *
 * The projection has never been checked against anything. It says what a sweep
 * would cost and how far it could carry, and the honest status of that claim has
 * always been "a forward simulation on a snapshot of the book" — which is not
 * the same as a claim that survives contact with the tape. Watching it live and
 * seeing levels get crossed without the projected move following is exactly the
 * observation that should turn into a number rather than an impression.
 *
 * So this measures three separate things, because "it isn't accurate" can mean
 * any of them and the fix differs for each:
 *
 *  1. **Reach.** Of the times price came close to the first cluster, how often
 *     did it actually trade through it. If this is low the levels are in the
 *     wrong place, and nothing downstream matters.
 *  2. **Travel.** Once price *did* trade through, how far did it carry compared
 *     to the projected terminal. This is the ratio the projection is scaled by.
 *     A value near 1 means the model is right; the failure being reported would
 *     show up here as something well under 1.
 *  3. **Discharge.** Whether liquidations actually printed at the level. A
 *     cluster is a guess about resting stop-losses, and the liquidation stream
 *     is the only direct evidence any of them existed.
 *
 * Why the model would overstate travel, mechanically, before any data:
 *
 *  - `released` assumes a cluster discharges in full the moment price touches
 *    it. Stops sit distributed around a level rather than stacked on it, and
 *    Binance liquidates incrementally rather than dumping a position at market.
 *  - The walk spends a frozen snapshot of the book. A real sweep takes seconds,
 *    and quotes arrive during it — the depth that refills is depth the
 *    simulation never charges the sweep for.
 *
 * Both push the same way, which is consistent with what is being seen. Neither
 * is corrected by guesswork here: the measured ratio is what scales the
 * projection, and until there are enough samples the projection is shown
 * uncalibrated and says so.
 */

/** How close to the first cluster price has to come before a prediction is armed. */
const ARM_PCT = 0.12;
/** How long after a trigger the realised extreme is measured over. */
const HORIZON_MS = 10 * 60_000;
/** An armed prediction that never triggers expires after this. */
const ARM_TTL_MS = 30 * 60_000;
/** Below this many settled samples, nothing is calibrated. */
const MIN_SAMPLES = 12;
/** Calibration is never allowed outside this band, however few or odd the samples. */
const MIN_FACTOR = 0.15;
const MAX_FACTOR = 1.5;

export interface CascadeSample {
  direction: "up" | "down";
  armedAt: number;
  triggeredAt: number | null;
  settledAt: number | null;
  /** Mid when the prediction was armed. */
  armMid: number;
  /** The first cluster's price — the level that had to be crossed. */
  triggerPrice: number;
  /** Where the projection said price would end up. */
  predictedTerminal: number;
  /** The risk score at arm time, for bucketing. */
  risk: number;
  /** Extreme price reached in the projected direction after the trigger. */
  realisedExtreme: number | null;
  /** Liquidation notional that printed between trigger and settle. */
  liquidationNotional: number;
  /**
   * Realised travel beyond the trigger as a fraction of projected travel beyond
   * it. Null until settled, or when the projection had nowhere to go.
   */
  travelFraction: number | null;
}

export interface CascadeCalibration {
  /** Enough settled samples for any of this to mean something. */
  warm: boolean;
  armed: number;
  triggered: number;
  settled: number;
  /** Of armed predictions that resolved, the share that actually traded through. */
  reachRate: number | null;
  /** Median of travelFraction across settled, triggered samples. */
  travelFactor: number | null;
  /** Share of triggered samples where any liquidation printed. */
  dischargeRate: number | null;
  /** What the projection should be multiplied by. 1 until measured. */
  factor: number;
  note: string;
}

export const EMPTY_CALIBRATION: CascadeCalibration = {
  warm: false,
  armed: 0,
  triggered: 0,
  settled: 0,
  reachRate: null,
  travelFactor: null,
  dischargeRate: null,
  factor: 1,
  note: "no outcomes recorded yet — the projection is uncalibrated",
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class CascadeOutcomes {
  private open: CascadeSample[] = [];
  private settled: CascadeSample[] = [];

  /**
   * Offer the current projection. Arms a prediction when price is close enough
   * to the first level for the question to be live, and at most one per
   * direction at a time — re-arming on every tick while price hovers near a
   * level would fill the sample with copies of one event and make a single
   * outcome look like fifty.
   */
  observe(
    direction: "up" | "down",
    mid: number,
    triggerPrice: number,
    predictedTerminal: number,
    risk: number,
    now = Date.now(),
  ) {
    if (!(mid > 0) || !(triggerPrice > 0)) return;
    const distPct = Math.abs((triggerPrice - mid) / mid) * 100;
    if (distPct > ARM_PCT) return;
    if (this.open.some((s) => s.direction === direction && s.triggeredAt === null)) return;

    this.open.push({
      direction,
      armedAt: now,
      triggeredAt: null,
      settledAt: null,
      armMid: mid,
      triggerPrice,
      predictedTerminal,
      risk,
      realisedExtreme: null,
      liquidationNotional: 0,
      travelFraction: null,
    });
  }

  /** Every price tick, so triggers and extremes are caught as they happen. */
  price(mid: number, now = Date.now()) {
    if (!(mid > 0)) return;
    for (const s of this.open) {
      if (s.triggeredAt === null) {
        const crossed = s.direction === "down" ? mid <= s.triggerPrice : mid >= s.triggerPrice;
        if (crossed) {
          s.triggeredAt = now;
          s.realisedExtreme = mid;
        } else if (now - s.armedAt > ARM_TTL_MS) {
          // Never traded through. That is a real outcome — it is what "reach"
          // measures — so it settles rather than being discarded.
          s.settledAt = now;
        }
        continue;
      }
      // Triggered: track how far it actually went, in the projected direction.
      if (s.realisedExtreme === null) s.realisedExtreme = mid;
      else if (s.direction === "down") s.realisedExtreme = Math.min(s.realisedExtreme, mid);
      else s.realisedExtreme = Math.max(s.realisedExtreme, mid);

      if (now - s.triggeredAt >= HORIZON_MS) s.settledAt = now;
    }
    this.sweep();
  }

  /** Liquidation notional printing while a prediction is live. */
  liquidation(notional: number) {
    if (!(notional > 0)) return;
    for (const s of this.open) if (s.triggeredAt !== null) s.liquidationNotional += notional;
  }

  private sweep() {
    const done = this.open.filter((s) => s.settledAt !== null);
    if (done.length === 0) return;
    for (const s of done) {
      if (s.triggeredAt !== null && s.realisedExtreme !== null) {
        const predicted = s.predictedTerminal - s.triggerPrice;
        const realised = s.realisedExtreme - s.triggerPrice;
        // Same sign required: a projection down that resolved up did not travel
        // 30% of the way, it went the other way, and recording it as a positive
        // fraction would flatter the model with its own failures.
        s.travelFraction =
          Math.abs(predicted) > 0 && Math.sign(realised) === Math.sign(predicted)
            ? realised / predicted
            : 0;
      }
      this.settled.push(s);
    }
    this.open = this.open.filter((s) => s.settledAt === null);
    if (this.settled.length > 400) this.settled = this.settled.slice(-400);
  }

  read(): CascadeCalibration {
    const settled = this.settled;
    const triggered = settled.filter((s) => s.triggeredAt !== null);
    const fractions = triggered
      .map((s) => s.travelFraction)
      .filter((v): v is number => v !== null);

    if (settled.length < MIN_SAMPLES) {
      return {
        ...EMPTY_CALIBRATION,
        armed: settled.length + this.open.length,
        triggered: triggered.length,
        settled: settled.length,
        note:
          `${settled.length} of ${MIN_SAMPLES} outcomes needed before the projection can be ` +
          `calibrated — it is shown as modelled until then`,
      };
    }

    const reachRate = settled.length > 0 ? triggered.length / settled.length : null;
    const travelFactor = fractions.length > 0 ? median(fractions) : null;
    const dischargeRate =
      triggered.length > 0
        ? triggered.filter((s) => s.liquidationNotional > 0).length / triggered.length
        : null;

    const factor =
      travelFactor === null ? 1 : Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, travelFactor));

    return {
      warm: true,
      armed: settled.length + this.open.length,
      triggered: triggered.length,
      settled: settled.length,
      reachRate,
      travelFactor,
      dischargeRate,
      factor,
      note:
        `over ${settled.length} outcomes: price traded through the first level ` +
        `${((reachRate ?? 0) * 100).toFixed(0)}% of the time, and when it did it carried ` +
        `${((travelFactor ?? 0) * 100).toFixed(0)}% of the projected distance` +
        (dischargeRate !== null
          ? `; liquidations printed in ${(dischargeRate * 100).toFixed(0)}% of them`
          : ""),
    };
  }

  /** Recent settled outcomes, newest first — the evidence behind the factor. */
  recent(limit = 20): CascadeSample[] {
    return [...this.settled].reverse().slice(0, limit);
  }
}
