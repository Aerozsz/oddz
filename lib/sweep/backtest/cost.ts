/**
 * What a round trip actually costs on this contract, measured rather than assumed.
 *
 * The replay's bar was a constant: seven basis points, two taker fills and
 * nothing else. That was defensible on BTCUSDT, where the spread ran about
 * 0.012bp and rounding it away changed nothing. On a small-cap perpetual it is
 * the difference between a finding and an artefact — a 9.6bp edge clears a 7bp
 * bar and loses to a 12bp one, and nothing about the report said which bar was
 * real.
 *
 * Two independent estimates, because a cost number that decides whether to
 * trade should not rest on one method.
 *
 * ## Roll
 *
 * Roll (1984): if trades bounce between bid and ask with no information
 * arriving, successive price changes are negatively autocorrelated purely from
 * the bounce, and Cov(dP_t, dP_t-1) = -s^2/4. So s = 2*sqrt(-Cov).
 *
 * Its assumption — that the negative autocovariance is *only* bounce — is not
 * true in general, and that is the direction of its error: genuine short-term
 * mean reversion inflates it, genuine momentum deflates it and can push the
 * covariance positive, at which point the estimator has no real root and the
 * honest answer is that it cannot be computed. Returning null there rather than
 * zero matters, because zero is a cost bar that every finding clears.
 *
 * ## Bounce
 *
 * The delayed-entry test already measures the same thing from the other side.
 * Scoring a feature entered at the decision bar's close and again one bar later
 * isolates how much of its edge came from the entry price sitting at bid or ask
 * instead of mid. That difference is half a spread by construction, so twice it
 * is the spread, and it is measured on this contract's own data with no
 * distributional assumption at all.
 *
 * Agreement between the two is the point. They fail in different directions, so
 * two numbers that land near each other are worth more than either alone, and
 * two that do not are a reason to distrust the bar rather than to pick one.
 */

import type { Minute } from "./features";
import { maxOf } from "../numeric";

export interface CostEstimate {
  /** Fees alone, both sides, in bps — the old constant. */
  feesBps: number;
  /** Roll's effective spread, or null when the covariance is not negative. */
  rollBps: number | null;
  /** Spread implied by the delayed-entry test, or null when unavailable. */
  bounceBps: number | null;
  /**
   * What a taker round trip costs: fees plus one spread.
   *
   * One spread, not two. Crossing on the way in and again on the way out costs
   * the spread twice in principle, but the decile returns this is compared
   * against are measured close-to-close, and a close is itself already a traded
   * price sitting on one side or the other — so half the cost is inside the
   * measurement already. Charging two would double-count it.
   */
  roundTripBps: number;
  /**
   * The spread observed on the tape, when a tick measurement exists.
   *
   * Not an estimate. `sweep-spread` reads the aggTrades archive, where every
   * print carries which side was the maker, so the gap at a direction flip is
   * the distance from bid to ask — measured, with no model and no inference of
   * trade direction. When this is present it is the answer and the two
   * estimators below are demoted to a cross-check.
   */
  tickBps: number | null;
  /** Which estimate roundTripBps used, so the bar can be argued with. */
  basis: "tick" | "roll" | "bounce" | "agreed" | "fees-only";
  note: string;
}

/**
 * Roll's effective spread over a series of closes, in basis points.
 *
 * Returns in basis points rather than price so contracts can be compared, and
 * uses log-ish relative changes for the same reason.
 */
export function rollSpreadBps(minutes: Minute[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < minutes.length; i++) {
    const a = minutes[i - 1].close;
    const b = minutes[i].close;
    if (!(a > 0) || !(b > 0)) continue;
    /*
     * Gaps break the pairing. A missing minute makes the "change" span two
     * intervals, which is a different quantity and biases the covariance, so
     * anything not exactly a minute apart starts a new run instead.
     */
    if (minutes[i].ts - minutes[i - 1].ts !== 60_000) {
      d.push(NaN);
      continue;
    }
    d.push(((b - a) / a) * 10_000);
  }

  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  for (let i = 1; i < d.length; i++) {
    const x = d[i - 1];
    const y = d[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sx += x;
    sy += y;
    sxy += x * y;
  }
  if (n < 100) return null;
  const cov = sxy / n - (sx / n) * (sy / n);
  /*
   * A non-negative covariance means momentum dominates whatever bounce is
   * present, and the estimator has no real root. Null, never zero: a zero cost
   * bar is one every finding clears, which is the most expensive possible way
   * to be wrong here.
   */
  if (cov >= 0) return null;
  return 2 * Math.sqrt(-cov);
}

/**
 * The spread implied by how much edge a one-bar delay removes.
 *
 * `immediate` and `delayed` are the same feature's decile spread entered at the
 * decision close and one bar later. The gap between them is the part of the
 * edge that came from the entry price being a traded price rather than the mid
 * — half a spread — so the spread is twice it.
 *
 * Only short horizons carry a usable signal here. Over an hour a fixed two
 * basis point entry bias is a rounding error on a twenty-five point move, and
 * dividing two noisy numbers to recover it produces confident nonsense; the
 * caller passes the shortest horizon for that reason.
 */
export function bounceSpreadBps(immediate: number, delayed: number): number | null {
  if (!Number.isFinite(immediate) || !Number.isFinite(delayed)) return null;
  // Same-sign requirement: a delay that flips the sign is not measuring an
  // entry-price bias, it is measuring two different things.
  if (Math.sign(immediate) !== Math.sign(delayed)) return null;
  const lost = Math.abs(immediate) - Math.abs(delayed);
  if (lost <= 0) return null;
  return 2 * lost;
}

export function estimateCost(
  minutes: Minute[],
  feesBps: number,
  bounce: { immediate: number; delayed: number } | null,
  tickBps: number | null = null,
): CostEstimate {
  const rollBps = rollSpreadBps(minutes);
  const bounceBps = bounce ? bounceSpreadBps(bounce.immediate, bounce.delayed) : null;

  let spread: number | null = null;
  let basis: CostEstimate["basis"] = "fees-only";
  let note: string;

  if (tickBps !== null && Number.isFinite(tickBps) && tickBps >= 0) {
    /*
     * A measurement beats two estimates, even the larger of them.
     *
     * Taking the larger is the right rule between two estimators that fail in
     * different directions and cannot be checked. It is the wrong rule once
     * the quantity has been observed: on LITUSDT these two returned 0.48bp and
     * 5.52bp while the tape said 0.243bp, landing exactly on the contract's
     * own tick size — and a 12.5bp bar built from the larger one was quietly
     * failing every finding worth between 7 and 13 basis points.
     *
     * Both estimators read a price path, and at one-minute resolution that
     * path is dominated by whatever the market did rather than by bounce, so
     * they measure mean reversion and call it spread. The tick measurement
     * does not infer direction at all — `isBuyerMaker` states it — so it has
     * no way to make that error.
     *
     * Charged twice, unlike the estimates. The one-spread rule below exists
     * because half the cost is already inside a close-to-close return; it is
     * an argument worth making when the spread is five basis points and not
     * worth making when it is a quarter of one. Charging both legs costs
     * 0.24bp here and removes the assumption, which is the right trade.
     */
    spread = tickBps * 2;
    basis = "tick";
    const others = [rollBps, bounceBps].filter((x): x is number => x !== null);
    note =
      `Spread observed on the tape: ${tickBps.toFixed(3)}bp, charged on both legs. ` +
      (others.length
        ? `The minute-resolution estimators said ${others.map((x) => x.toFixed(2)).join(" and ")}bp — ` +
          // maxOf, not Math.max(...others). The array is two long and spreading
          // it is safe, which is exactly what was believed the two previous
          // times this pattern took the research loop down for days.
          `${((maxOf(others) ?? 0) / Math.max(1e-9, tickBps)).toFixed(0)}x the measured value, which is what ` +
          `reading a price path at one-minute resolution does to a bounce estimator.`
        : "Neither minute-resolution estimator could be computed, which no longer matters.");
  } else if (rollBps !== null && bounceBps !== null) {
    /*
     * Both available: take the larger, and say whether they agreed.
     *
     * The larger because being wrong about a cost in the cheap direction is how
     * a project talks itself into trading something that does not pay, and this
     * one has already produced four findings that did not survive contact with
     * a control.
     */
    spread = Math.max(rollBps, bounceBps);
    const ratio = Math.max(rollBps, bounceBps) / Math.max(1e-9, Math.min(rollBps, bounceBps));
    basis = ratio <= 2 ? "agreed" : rollBps > bounceBps ? "roll" : "bounce";
    note =
      ratio <= 2
        ? `Roll ${rollBps.toFixed(2)}bp and the bounce test ${bounceBps.toFixed(2)}bp agree within 2x; using the larger.`
        : `Roll ${rollBps.toFixed(2)}bp and the bounce test ${bounceBps.toFixed(2)}bp disagree by more than 2x — ` +
          `the bar is the larger of the two, and the disagreement is itself a reason to distrust it.`;
  } else if (rollBps !== null) {
    spread = rollBps;
    basis = "roll";
    note = `Roll only: ${rollBps.toFixed(2)}bp. No usable delayed-entry pair to cross-check it.`;
  } else if (bounceBps !== null) {
    spread = bounceBps;
    basis = "bounce";
    note = `Delayed-entry only: ${bounceBps.toFixed(2)}bp. Roll had non-negative covariance, so momentum dominates the bounce at this resolution.`;
  } else {
    note =
      "Neither estimate could be computed, so the bar is fees alone and understates the real cost. " +
      "Treat anything clearing it by less than a few basis points as unproven.";
  }

  return {
    feesBps,
    rollBps,
    bounceBps,
    tickBps,
    roundTripBps: feesBps + (spread ?? 0),
    basis,
    note,
  };
}
