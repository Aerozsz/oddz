/**
 * The cost bar decides which findings are real, so it has to be hard to fool.
 *
 * Seven basis points was a constant calibrated on a contract whose spread
 * rounds to zero. Applied to a small-cap it is the difference between a finding
 * and an artefact: a 9.6bp edge clears a 7bp bar and loses to a 12bp one.
 */

import { rollSpreadBps, bounceSpreadBps, estimateCost } from "/home/user/oddz/lib/sweep/backtest/cost";
import type { Minute } from "/home/user/oddz/lib/sweep/backtest/features";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

/**
 * A bid-ask bounce around a flat mid, with a known spread.
 *
 * The trade side is a coin flip, not an alternation, and the coin has to be a
 * real one. That distinction is the whole model: Roll assumes trade direction
 * is serially independent, and violating it does not degrade the estimate
 * gracefully — a deterministic bid/ask/bid/ask series returns exactly twice the
 * true spread, and a linear congruential generator sampled on its low bit is
 * deterministic in precisely that way while looking random.
 *
 * Two earlier versions of this fixture got both wrong and both "failures" were
 * the fixture rather than the estimator. Against a real generator it recovers
 * 4bp, 12bp and 40bp to within a percent.
 *
 * xorshift64, seeded, so a run that fails can be reproduced.
 */
function bouncing(n: number, mid: number, spreadBps: number, gapAt: number[] = []): Minute[] {
  const half = (mid * spreadBps) / 2 / 10_000;
  const out: Minute[] = [];
  let ts = 1_700_000_000_000;
  let s = 88172645463325252n;
  const coin = () => {
    s ^= s << 13n; s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n; s &= 0xffffffffffffffffn;
    return Number(s % 10000n) / 10000 < 0.5 ? 1 : -1;
  };
  for (let i = 0; i < n; i++) {
    if (gapAt.includes(i)) ts += 60_000;
    const px = mid + coin() * half;
    out.push({ ts, open: px, high: px, low: px, close: px, volume: 1, quoteVolume: mid } as Minute);
    ts += 60_000;
  }
  return out;
}

function rollRecoversAKnownSpread() {
  /*
   * The estimator's own definition, run forwards: alternate between bid and ask
   * around a flat mid and Roll must return the spread that was put in.
   */
  for (const s of [4, 12, 40]) {
    const got = rollSpreadBps(bouncing(50_000, 2.5, s));
    ok(`roll recovers a ${s}bp spread`, got !== null && Math.abs(got - s) < s * 0.05,
      got === null ? "null" : got.toFixed(2));
  }
}

function rollRefusesWhenItCannotAnswer() {
  /*
   * Trending prices have positive autocovariance, so the estimator has no real
   * root. Null is the only honest answer — zero would be a cost bar that every
   * finding clears, which is the most expensive way to be wrong here.
   */
  const trend: Minute[] = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < 3000; i++) {
    const px = 2.5 * (1 + i * 0.0001);
    trend.push({ ts, open: px, high: px, low: px, close: px, volume: 1, quoteVolume: 1 } as Minute);
    ts += 60_000;
  }
  ok("a trending series returns null, not zero", rollSpreadBps(trend) === null, String(rollSpreadBps(trend)));
  ok("too few samples returns null", rollSpreadBps(bouncing(40, 2.5, 10)) === null);

  /*
   * Gaps break the pairing: a missing minute makes a "change" span two
   * intervals, which is a different quantity. It must not be silently folded in.
   */
  const withGaps = bouncing(50_000, 2.5, 10, [500, 1200, 2600]);
  const got = rollSpreadBps(withGaps);
  ok("gaps do not corrupt the estimate", got !== null && Math.abs(got - 10) < 1.0,
    got === null ? "null" : got.toFixed(2));
}

function bounceEstimatesTheEntryBias() {
  // Losing 2bp of a 8bp edge to a one-bar delay implies a 4bp spread.
  ok("bounce doubles the lost edge", bounceSpreadBps(-8, -6) === 4, String(bounceSpreadBps(-8, -6)));
  ok("sign is respected", bounceSpreadBps(8, 6) === 4, String(bounceSpreadBps(8, 6)));
  ok("a delay that gains edge yields null", bounceSpreadBps(-8, -9) === null);
  ok("a sign flip yields null, not a number", bounceSpreadBps(-8, 6) === null);
}

function theBarIsNeverAccidentallyFree() {
  const flat = bouncing(50_000, 2.5, 10);

  const both = estimateCost(flat, 7, { immediate: -12, delayed: -8 });
  ok("fees are carried through", both.feesBps === 7);
  ok("the bar is fees plus a spread", both.roundTripBps > 7, String(both.roundTripBps));
  ok("close estimates are reported as agreeing", both.basis === "agreed", both.basis);
  ok("and it takes the larger of the two",
    Math.abs(both.roundTripBps - (7 + 10)) < 1.5, String(both.roundTripBps));

  /*
   * The case that matters most: nothing measurable. The bar must fall back to
   * fees and say so in words, because a silent fees-only bar reads exactly like
   * a measured one and is the reason this module exists.
   */
  const none = estimateCost([], 7, null);
  ok("with nothing measurable the bar is fees only", none.roundTripBps === 7);
  ok("and it is named as such", none.basis === "fees-only", none.basis);
  ok("and the understatement is stated", /understates the real cost/.test(none.note), none.note);

  // A wide disagreement is reported rather than averaged away.
  const far = estimateCost(flat, 7, { immediate: -100, delayed: -20 });
  ok("a large disagreement is named", /disagree by more than 2x/.test(far.note), far.note);
  ok("and the larger still wins", far.roundTripBps > 7 + 10, String(far.roundTripBps));
}


function aMeasuredSpreadBeatsTwoEstimates() {
  console.log("\nthe tape outranks the estimators");
  const flat = bouncing(50_000, 2.5, 10);
  /*
   * The failure this exists to prevent, in the numbers it actually happened
   * in. On LITUSDT Roll said 0.48bp, the delayed-entry test said 5.52bp, and
   * the tape said 0.243bp — landing on the contract's own tick size. Taking
   * the larger built a 12.52bp bar, and every finding worth between 7 and 13
   * basis points was failed by a number the project had already disproved.
   */
  const withTick = estimateCost(flat, 7, { immediate: -12, delayed: -8 }, 0.243);
  ok("the measured spread is used", withTick.basis === "tick", withTick.basis);
  ok(
    "and it is charged on both legs",
    Math.abs(withTick.roundTripBps - (7 + 0.486)) < 1e-9,
    String(withTick.roundTripBps),
  );
  ok("the bar is far below the estimators' bar", withTick.roundTripBps < 8, String(withTick.roundTripBps));
  ok("the estimates are still reported", withTick.bounceBps !== null && withTick.rollBps !== null);
  ok("and the size of their error is named", /x the measured value/.test(withTick.note), withTick.note);

  // Zero is a real reading on a one-tick book and must not fall back.
  const free = estimateCost(flat, 7, null, 0);
  ok("a zero tick spread is still a measurement", free.basis === "tick", free.basis);
  ok("and leaves the bar at fees", free.roundTripBps === 7, String(free.roundTripBps));

  // Absent, and the old behaviour is untouched.
  const without = estimateCost(flat, 7, { immediate: -12, delayed: -8 }, null);
  ok("without a tick file nothing changes", without.basis !== "tick", without.basis);
  ok("and the estimator bar is unchanged", without.roundTripBps > 7, String(without.roundTripBps));
  ok("a nonsense tick reading is refused", estimateCost(flat, 7, null, NaN).basis !== "tick");
  ok("a negative one too", estimateCost(flat, 7, null, -1).basis !== "tick");
}

console.log("cost bar");
rollRecoversAKnownSpread();
rollRefusesWhenItCannotAnswer();
bounceEstimatesTheEntryBias();
theBarIsNeverAccidentallyFree();
aMeasuredSpreadBeatsTwoEstimates();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — cost bar");
