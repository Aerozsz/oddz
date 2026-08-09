import type { Trade } from "../types";

/**
 * News, detected from the tape, in milliseconds.
 *
 * The first version of the news feed polled three crypto outlets over RSS every
 * three minutes. That was the wrong instrument for the job and worth spelling
 * out why, because the mistake is seductive: those outlets *report* moves. By
 * the time CoinDesk has a headline, the liquidation cascade it describes has
 * been over for twenty minutes, the book has re-formed, and an agent reacting to
 * the story is trading the aftermath. A feed that is structurally late is not a
 * fast feed with a delay — it is a record of history.
 *
 * What actually arrives first is the market. Every event that matters to a
 * trading agent — an exchange halt, a large liquidation, an unexpected print, a
 * macro release — reaches the order book before it reaches any wire, because the
 * book *is* how it reaches the world. So the primary detector here reads the
 * tape and asks one question: is this market still behaving like the market
 * this strategy was calibrated on?
 *
 * Four independent readings, because any one of them alone has a common
 * innocent explanation and all four together do not:
 *
 *  - **Volatility break.** Realised movement far above its own recent baseline.
 *  - **Spread blowout.** Market makers widening or leaving, which is what they
 *    do when they cannot price the next few seconds.
 *  - **Volume surge.** Aggressive size far above baseline.
 *  - **Directional persistence.** One-way flow, which separates a genuine
 *    repricing from ordinary two-sided noise.
 *
 * Deliberately never a direction. The output is "the market is in a different
 * regime and it started N seconds ago". Inferring which way to trade from a
 * shock is a separate and much harder claim, and one this cannot support.
 *
 * The RSS feed stays, demoted to what it is good for: labelling a shock after
 * the fact so a human reading a post-mortem can see what it was. Detection is
 * the tape's job.
 */

export interface ShockRead {
  /** 0 nothing, 1 unsettled, 2 significant, 3 severe. Matches news impact. */
  level: number;
  /** Seconds since the shock began. Null when there is none. */
  secondsSince: number | null;
  /** Which readings broke, for the log and the post-mortem. */
  reasons: string[];
  /** How far past baseline each reading sits, as a multiple. */
  volatilityMult: number;
  spreadMult: number;
  volumeMult: number;
  persistence: number;
  /** False until the baselines have seen enough to compare against. */
  warm: boolean;
}

export const NO_SHOCK: ShockRead = {
  level: 0, secondsSince: null, reasons: [],
  volatilityMult: 1, spreadMult: 1, volumeMult: 1, persistence: 0, warm: false,
};

/** Half-life of the slow baselines, in seconds. */
const BASELINE_HALF_LIFE = 900;
/** A shock is considered live for this long after it starts. */
const SHOCK_LIVE_MS = 10 * 60_000;

interface Ewma {
  value: number;
  seen: number;
}

function step(e: Ewma, sample: number, dtSec: number, halfLife: number): Ewma {
  if (!Number.isFinite(sample)) return e;
  if (e.seen === 0) return { value: sample, seen: 1 };
  const alpha = 1 - Math.pow(0.5, dtSec / halfLife);
  return { value: e.value + alpha * (sample - e.value), seen: e.seen + 1 };
}

export class ShockDetector {
  private volFast: Ewma = { value: 0, seen: 0 };
  private volSlow: Ewma = { value: 0, seen: 0 };
  private spreadSlow: Ewma = { value: 0, seen: 0 };
  private volumeFast: Ewma = { value: 0, seen: 0 };
  private volumeSlow: Ewma = { value: 0, seen: 0 };
  private lastMid = 0;
  private lastAt = 0;
  private shockStartedAt = 0;
  private lastLevel = 0;
  private buyVol = 0;
  private sellVol = 0;

  /** Fed on every book update. Cheap enough for the hot path. */
  onTick(mid: number, spreadBps: number, now: number) {
    if (!(mid > 0)) return;
    const dtSec = this.lastAt > 0 ? Math.max(0.001, (now - this.lastAt) / 1000) : 1;
    if (this.lastMid > 0) {
      /*
       * Absolute return per second, not per tick.
       *
       * Per tick would make the reading depend on how often the venue happens
       * to publish, so a burst of updates would look like volatility even when
       * price had not moved — and a burst of updates is exactly what happens
       * during the events this is meant to catch.
       */
      const perSec = (Math.abs(mid - this.lastMid) / this.lastMid) / Math.sqrt(dtSec);
      this.volFast = step(this.volFast, perSec, dtSec, 20);
      this.volSlow = step(this.volSlow, perSec, dtSec, BASELINE_HALF_LIFE);
    }
    if (spreadBps > 0) this.spreadSlow = step(this.spreadSlow, spreadBps, dtSec, BASELINE_HALF_LIFE);
    this.lastMid = mid;
    this.lastAt = now;
  }

  onTrade(t: Trade, now: number) {
    const dtSec = this.lastAt > 0 ? Math.max(0.001, (now - this.lastAt) / 1000) : 1;
    this.volumeFast = step(this.volumeFast, t.notional, dtSec, 20);
    this.volumeSlow = step(this.volumeSlow, t.notional, dtSec, BASELINE_HALF_LIFE);
    if (t.buyerIsMaker) this.sellVol += t.notional;
    else this.buyVol += t.notional;
    // Bounded so persistence reflects the recent tape rather than the session.
    const total = this.buyVol + this.sellVol;
    if (total > 5_000_000) { this.buyVol *= 0.5; this.sellVol *= 0.5; }
  }

  read(spreadBps: number, now = Date.now()): ShockRead {
    // Enough samples that a baseline means something. Below this, everything
    // looks like a break because there is nothing to break from.
    const warm = this.volSlow.seen > 120 && this.spreadSlow.seen > 60;
    if (!warm) return { ...NO_SHOCK, warm: false };

    const volatilityMult = this.volSlow.value > 0 ? this.volFast.value / this.volSlow.value : 1;
    const spreadMult = this.spreadSlow.value > 0 ? spreadBps / this.spreadSlow.value : 1;
    const volumeMult = this.volumeSlow.value > 0 ? this.volumeFast.value / this.volumeSlow.value : 1;
    const total = this.buyVol + this.sellVol;
    const persistence = total > 0 ? Math.abs(this.buyVol - this.sellVol) / total : 0;

    const reasons: string[] = [];
    let score = 0;
    if (volatilityMult > 3) { score += 2; reasons.push(`price moving ${volatilityMult.toFixed(1)}x its usual rate`); }
    else if (volatilityMult > 2) { score += 1; reasons.push(`price moving ${volatilityMult.toFixed(1)}x its usual rate`); }

    if (spreadMult > 3) { score += 2; reasons.push(`spread ${spreadMult.toFixed(1)}x wider than normal — makers are stepping back`); }
    else if (spreadMult > 2) { score += 1; reasons.push(`spread ${spreadMult.toFixed(1)}x wider than normal`); }

    if (volumeMult > 4) { score += 2; reasons.push(`${volumeMult.toFixed(1)}x the usual aggressive size`); }
    else if (volumeMult > 2.5) { score += 1; reasons.push(`${volumeMult.toFixed(1)}x the usual aggressive size`); }

    /*
     * Persistence is a multiplier on the others, never a trigger on its own.
     *
     * One-sided flow in a quiet market is ordinary — someone is working an
     * order. One-sided flow *during* a volatility and spread break is a
     * repricing, and that distinction is the whole reason this is combined
     * rather than scored separately.
     */
    if (score > 0 && persistence > 0.7) { score += 1; reasons.push(`flow ${(persistence * 100).toFixed(0)}% one-way`); }

    const level = score >= 5 ? 3 : score >= 3 ? 2 : score >= 1 ? 1 : 0;

    if (level >= 2 && this.lastLevel < 2) this.shockStartedAt = now;
    if (level === 0 && now - this.shockStartedAt > SHOCK_LIVE_MS) this.shockStartedAt = 0;
    this.lastLevel = level;

    return {
      level,
      secondsSince: this.shockStartedAt > 0 ? (now - this.shockStartedAt) / 1000 : null,
      reasons,
      volatilityMult, spreadMult, volumeMult, persistence,
      warm: true,
    };
  }
}
