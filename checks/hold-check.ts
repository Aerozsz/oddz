/**
 * Hold time decided from whether the reason is still true, not from a clock.
 *
 * The risk in making this adaptive is obvious and worth pinning hard: logic
 * that can talk itself into holding is how the original problem — positions
 * kept open precisely because they were losing — comes back wearing a cleverer
 * hat. So the extension branch must require evidence, and the hard cap must be
 * unreachable by any combination of inputs.
 */
import { holdDecision, DEFAULT_HOLD } from "@/lib/sweep/agent/hold";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster } from "@/lib/sweep/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cluster = (price: number): Cluster => ({
  price, effect: "amplifying", pushes: price > 100 ? "up" : "down", notional: 400_000,
  confidence: 0.6, sources: ["leverage-long"], spent: 0, distPct: Math.abs(price - 100),
});

function state(over: Partial<AgentState> = {}, mark = 100): AgentState {
  return {
    ts: Date.now(), symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: { cashOpen: true, phase: "regular", msToNext: 3_600_000, nextLabel: "cash close",
      intraday: "morning", weights: WEIGHTS.morning, msSincePhaseStart: 30 * 60_000, transitioning: false },
    mid: mark, mark, last: mark, bestBid: mark - 0.01, bestAsk: mark + 0.01,
    liquidity: { lwi: 0.4, lwiBid: 0.4, lwiAsk: 0.4, lwiAdj: 0.4, lwiBidAdj: 0.4, lwiAskAdj: 0.4,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 100_000, askNotional: 100_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 5_000, consumedAsk: 5_000, windowSec: 10 },
    cascadeUp: null, cascadeDown: null,
    nearestAbove: cluster(101), nearestBelow: cluster(99),
    volatilityPct: 0.15, participants: null,
    markout: EMPTY_MARKOUT, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
    openInterestNotional: 50_000_000, longShortRatio: 1.1, flow: { buy: 1000, sell: 1000 },
    ...over,
  };
}

const MIN = 60_000;
const decide = (over: Record<string, unknown> = {}) =>
  holdDecision({
    state: state(), side: "long", entryPrice: 100, targetPrice: 101,
    heldMs: 5 * MIN, entryLwi: 0.4, ...over,
  } as Parameters<typeof holdDecision>[0]);

console.log("\n## a working trade earns more time, a stalled one loses it");
{
  // 70% of the way there at minute 20 — a fixed 30 would cut this.
  const working = decide({ state: state({}, 100.7), heldMs: 20 * MIN });
  ok("a trade near its target is not closed at minute 20", !working.close, working.reason);
  ok("...and the limit is extended past the base", working.deadlineMs > DEFAULT_HOLD.baseMinutes * MIN,
    `${Math.round(working.deadlineMs / MIN)} min`);
  ok("...saying so", working.notes.some((x) => x.includes("extended")));

  // Same trade at minute 29 under the old rule would die; here it lives.
  const late = decide({ state: state({}, 100.7), heldMs: 29 * MIN });
  ok("...so it survives minute 29", !late.close, late.reason);
}

console.log("\n## the glass cannon: a setup that never started is cut early");
{
  const stalled = decide({ state: state({}, 100.02), heldMs: 8 * MIN });
  ok("no progress by the stall window closes it", stalled.close, stalled.reason);
  ok("...well inside the nominal limit", 8 < DEFAULT_HOLD.baseMinutes);
  ok("...saying the mechanism is a fast one", stalled.reason.includes("has not started"), stalled.reason);

  const early = decide({ state: state({}, 100.02), heldMs: 3 * MIN });
  ok("but it is given a chance first", !early.close, early.reason);
}

console.log("\n## the thesis expiring closes it regardless of the clock");
{
  // Depth refilled: the thinness the trade was opened on is gone.
  const refilled = decide({
    state: state({ liquidity: { ...state().liquidity!, lwiAskAdj: 0.95, lwiBidAdj: 0.95 } }, 100.3),
    heldMs: 6 * MIN, entryLwi: 0.4,
  });
  ok("a refilled book closes the trade", refilled.close, refilled.reason);
  ok("...at six minutes, not thirty", refilled.reason.includes("expired"), refilled.reason);
  ok("...naming the depth", refilled.notes.some((x) => x.includes("refilled")));

  // Flow turned hard against the position.
  const against = decide({
    state: state({ markout: { ...EMPTY_MARKOUT, warm: true, informed: -0.8, regime: "one-sided", notes: ["sellers have been right"] } }, 100.3),
    heldMs: 6 * MIN,
  });
  ok("flow turning against it costs thesis health", against.thesisHealth < 1, against.thesisHealth.toFixed(2));
}

console.log("\n## nothing can extend past the hard cap");
{
  const cap = DEFAULT_HOLD.baseMinutes * DEFAULT_HOLD.maxExtension;
  // Every input as favourable as it can be, held far past everything.
  const forever = decide({
    state: state({ markout: { ...EMPTY_MARKOUT, warm: true, informed: 0.9, regime: "one-sided", notes: ["buyers right"] } }, 100.99),
    heldMs: 500 * MIN,
  });
  ok("a maximally favourable trade still closes", forever.close, forever.reason);
  ok("...at the hard cap", forever.deadlineMs <= cap * MIN + 1, `${Math.round(forever.deadlineMs / MIN)} of ${cap}`);
}

console.log("\n## going backwards");
{
  const losing = decide({ state: state({}, 99.6), heldMs: 10 * MIN });
  ok("negative progress is reported as negative", losing.progress < 0, losing.progress.toFixed(2));
  ok("...and it is closed rather than given the benefit of the doubt", losing.close, losing.reason);
}

console.log("\n## it degrades safely");
{
  const noTarget = decide({ targetPrice: null, heldMs: 10 * MIN });
  ok("no target means no progress rather than a crash", noTarget.progress === 0);
  ok("...and the clock still governs", noTarget.close || noTarget.deadlineMs > 0);

  const cold = decide({
    state: state({ liquidity: { ...state().liquidity!, warm: false } }, 100.3),
    entryLwi: null, heldMs: 10 * MIN,
  });
  ok("an unreadable book does not invent a reason to close", !cold.close || cold.reason.includes("min"),
    cold.reason);

  const short = holdDecision({
    state: state({}, 99.3), side: "short", entryPrice: 100, targetPrice: 99,
    heldMs: 20 * MIN, entryLwi: 0.4,
  });
  ok("a short measures progress the other way", short.progress > 0.6, short.progress.toFixed(2));
  ok("...and is not closed while working", !short.close, short.reason);
}

console.log("\n## THE CHURN — an entry on a book that was not thin");
{
  /*
   * Reproduces the weekend directly. 37 of 55 real entries were taken at
   * lwiAdj >= 1 — at or above baseline depth — and every one was closed within
   * about ninety seconds by the depth-refilled branch. The old divisor clamped
   * to 0.1, so a 0.07 rise in depth read as 70% recovery and killed the trade.
   */
  const thick = state({
    liquidity: { ...state().liquidity, lwiAskAdj: 1.18, lwiBidAdj: 1.18 },
  } as Partial<AgentState>);
  const d = holdDecision({
    state: thick, side: "long", entryPrice: 100, targetPrice: 101,
    heldMs: 90_000, entryLwi: 1.11,
  });
  ok("an entry at 1.11x is not killed by a drift to 1.18x", !d.close, d.reason);
  ok("...and health stays high", d.thesisHealth > 0.8, d.thesisHealth.toFixed(2));
  ok("...and it names the real problem", d.notes.some((n) => n.includes("no thinness")), d.notes.join(" | "));

  // The branch must still work when the book genuinely was thin.
  const refilled = state({
    liquidity: { ...state().liquidity, lwiAskAdj: 0.95, lwiBidAdj: 0.95 },
  } as Partial<AgentState>);
  const real = holdDecision({
    state: refilled, side: "long", entryPrice: 100, targetPrice: 101,
    heldMs: 5 * 60_000, entryLwi: 0.4,
  });
  ok("a genuinely thin entry that refills still closes", real.close, real.reason);

  /*
   * The same evidence at ninety seconds, which is what this used to assert.
   *
   * It was right about the mechanism and wrong about the cost: closing on a
   * reading taken ninety seconds after entry pays a full round trip for one
   * sample of a series that moves further than that in a minute. Five
   * consecutive live trades were closed this way for $70 of commission on
   * adverse excursions under 0.07%. The reading is now held rather than acted
   * on until `minThesisMinutes` has passed — and if it is real it is still
   * there then, having cost nothing to wait for.
   */
  const tooSoon = holdDecision({
    state: refilled, side: "long", entryPrice: 100, targetPrice: 101,
    heldMs: 90_000, entryLwi: 0.4,
  });
  ok("...but not at 90 seconds, when it is one sample and a round trip", !tooSoon.close, tooSoon.reason);
  ok(
    "...and the reading is recorded, not discarded",
    tooSoon.thesisHealth < 1 && tooSoon.notes.some((n) => n.includes("too soon")),
    tooSoon.notes.join(" | "),
  );

  // And a barely-thin entry must not divide by near-zero.
  const barely = holdDecision({
    state: thick, side: "long", entryPrice: 100, targetPrice: 101,
    heldMs: 90_000, entryLwi: 0.97,
  });
  ok("a barely-thin entry does not explode on a small move", !barely.close, barely.reason);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
