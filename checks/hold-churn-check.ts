/**
 * The depth-expiry branch must not be able to churn the account.
 *
 * Replays the five consecutive live trades that closed on it at 1, 1, 2, 2 and
 * 4 minutes held, for -$8.86, -$10.96, -$10.64, -$11.09 and -$28.85. Their
 * adverse excursions were -0.007% to -0.068%: none was losing on price. They
 * paid a full round trip each to act on a depth reading that had reverted
 * within a minute of entry.
 *
 * Two properties are asserted, and the second is the one that regressed twice:
 *
 *  1. A genuine refill, held long enough, still closes. The rule must keep
 *     working — a fix that only makes it quieter is a fix that removes it.
 *  2. Neither a fresh reading nor a small-denominator ratio can close a
 *     position on its own.
 */

import { holdDecision, DEFAULT_HOLD } from "../lib/sweep/agent/hold";
import type { AgentState } from "../lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "../lib/sweep/metrics/markout";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok — ${name}`);
  }
};

/** A state carrying nothing but the depth reading the branch reads. */
function stateWith(lwiAsk: number, lwiBid: number, mid: number): AgentState {
  return {
    liquidity: {
      lwi: 1, lwiBid, lwiAsk, lwiAdj: 1, lwiBidAdj: lwiBid, lwiAskAdj: lwiAsk,
      warm: true, imbalance: 0, spreadBps: 1,
      bidNotional: 0, askNotional: 0,
      withdrawnBid: 0, withdrawnAsk: 0, consumedBid: 0, consumedAsk: 0, windowSec: 60,
    },
    mid,
    mark: mid,
    // Everything else the other branches read, set so only the depth branch
    // can move health. A warm mark-out or a missing cluster would confound the
    // measurement this file is making.
    markout: EMPTY_MARKOUT,
    nearestAbove: null,
    nearestBelow: { price: 63_657, notional: 1e6 },
    session: { intraday: "regular", transitioning: false },
  } as unknown as AgentState;
}

/** The five real trades: entry depth, depth at the close, minutes held. */
const CHURN = [
  { entryLwi: 0.61, nowLwi: 1.25, min: 4, lost: 28.85 },
  { entryLwi: 0.69, nowLwi: 1.40, min: 1, lost: 8.86 },
  { entryLwi: 0.80, nowLwi: 1.09, min: 2, lost: 10.64 },
  { entryLwi: 0.88, nowLwi: 1.52, min: 2, lost: 11.09 },
  { entryLwi: 0.83, nowLwi: 0.98, min: 1, lost: 10.96 },
];

/*
 * All five were shorts, so the side price must travel through is the bid, and
 * the entry reading is the bid reading. Prices sit flat at entry: these trades
 * were not losing on price, which is the whole point.
 */
function decideShort(entryLwi: number, nowLwi: number, minutes: number) {
  return holdDecision({
    state: stateWith(1, nowLwi, 64_300),
    side: "short",
    entryPrice: 64_300,
    targetPrice: 63_657, // 1% away, the usual 0.5% stop at 2R
    heldMs: minutes * 60_000,
    entryLwi,
  });
}

function replay() {
  const closed: typeof CHURN = [];
  let saved = 0;
  for (const t of CHURN) {
    const d = decideShort(t.entryLwi, t.nowLwi, t.min);
    if (d.close) closed.push(t);
    else saved += t.lost;
  }

  /*
   * One of the five was a real exit and must survive.
   *
   * 0.61x to 1.25x is a book that was genuinely thin and genuinely came back,
   * and it was held four minutes — past the floor. Closing it was right. The
   * other four were held one or two minutes, and three of them had a thinness
   * at entry smaller than the series' own noise. A fix that suppressed all five
   * would have removed the rule rather than corrected it, which is why this
   * asserts the survivor by name.
   */
  ok(
    "only the one genuine refill still closes",
    closed.length === 1 && closed[0].entryLwi === 0.61,
    `${closed.length} closed: ${closed.map((c) => `${c.entryLwi}x@${c.min}min`).join(", ")}`,
  );
  ok(
    "the four noise-triggered exits are all prevented",
    saved > 41 && saved < 42,
    `$${saved.toFixed(2)} of the $70.40 no longer spent`,
  );
  console.log(`     $${saved.toFixed(2)} of the $70.40 no longer spent on these exits`);
}

function stillWorks() {
  /*
   * A genuinely thin entry that genuinely refilled, held past the floor. This
   * must still close, or the rule has been removed rather than corrected.
   */
  const d = decideShort(0.55, 1.2, 10);
  ok("a real refill past the floor still closes", d.close, `health ${d.thesisHealth}`);
  ok("and it says why", /refilled/.test(d.reason), d.reason);

  // The same reading, one minute in. Same evidence, too soon to spend on.
  const early = decideShort(0.55, 1.2, 1);
  ok("the same reading at 1 min does not close", !early.close, early.reason);
  ok(
    "but it is recorded rather than ignored",
    early.thesisHealth < 1 && early.notes.some((n) => /too soon/.test(n)),
    JSON.stringify(early.notes),
  );
}

function smallDenominator() {
  /*
   * The mechanism that produced the churn: a marginal entry makes the ratio
   * explode. 0.88x entry, thinness 0.12, so a 0.15 wobble reads as 1.25
   * recovery. Held well past the floor, so only the depth logic decides.
   */
  /*
   * Five minutes, not ten: past the 3-minute floor but inside the 7.5-minute
   * stall window. Beyond that the stall rule closes a motionless trade on
   * price, which is a different mechanism working correctly and would mask what
   * this is measuring.
   */
  const wobble = decideShort(0.88, 0.95, 5);
  ok(
    "a wobble below baseline cannot close a marginally-thin entry",
    !wobble.close,
    `${wobble.reason} · health ${wobble.thesisHealth}`,
  );

  // The same marginal entry, but depth is genuinely back above its baseline.
  const real = decideShort(0.88, 1.15, 5);
  ok("a return to baseline still closes it", real.close, real.reason);
}

function configured() {
  ok("the floor is part of the config", DEFAULT_HOLD.minThesisMinutes === 3);
  const off = holdDecision({
    state: stateWith(1, 1.4, 64_300),
    side: "short",
    entryPrice: 64_300,
    targetPrice: 63_657,
    heldMs: 60_000,
    entryLwi: 0.55,
    config: { minThesisMinutes: 0 },
  });
  ok("and can be turned off explicitly", off.close, "a zero floor must restore the old behaviour");
}

console.log("hold: depth-expiry churn");
replay();
stillWorks();
smallDenominator();
configured();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
