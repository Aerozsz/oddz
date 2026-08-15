/**
 * Why thousands of signals produced no orders.
 *
 * The sizer aimed at the *nearest* cluster. With a 0.5% stop and a 1.2
 * reward-to-risk floor a target must be 0.6% away, and the nearest cluster on
 * this contract is routinely a tenth of that — so every setup failed on a
 * reward that was never the point.
 */
import { proposePosition, type SizingLimits } from "@/lib/sweep/agent/sizing";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { NO_NEWS } from "@/lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster, CostPoint } from "@/lib/sweep/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const MID = 100;
const cl = (p: number): Cluster => ({
  price: p, effect: "amplifying", pushes: p > MID ? "up" : "down", notional: 400_000,
  confidence: 0.6, sources: ["leverage-long"], spent: 0, distPct: Math.abs((p - MID) / MID) * 100,
});
const costCurve: CostPoint[] = [0.1, 0.25, 0.5, 1, 2, 3, 5].map((pct) => ({
  pct, downNotional: pct * 400_000, upNotional: pct * 400_000, downExhausted: false, upExhausted: false,
}));

const limits: SizingLimits = {
  maxPositionUsd: 5000, maxLeverage: 5, maxDailyLossUsd: 300, stopLossPct: 0.5,
  maxTradesPerDay: 8, lossCooldownMin: 15, requireCashOpen: false, minRewardRisk: 1.2,
};

function state(): AgentState {
  return {
    ts: Date.now(), symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: { cashOpen: true, phase: "regular", msToNext: 3.6e6, nextLabel: "x", intraday: "morning",
      weights: WEIGHTS.morning, msSincePhaseStart: 30 * 60_000, transitioning: false },
    mid: MID, mark: MID, last: MID, bestBid: MID - 0.01, bestAsk: MID + 0.01,
    liquidity: { lwi: 0.9, lwiBid: 0.9, lwiAsk: 0.9, lwiAdj: 0.9, lwiBidAdj: 0.9, lwiAskAdj: 0.9,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 80_000, askNotional: 80_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 3_000, consumedAsk: 3_000, windowSec: 10 },
    cascadeUp: { direction: "up", risk: 40, seedNotional: 300_000, terminalPct: 1, linkCount: 2, firstClusterPrice: 100.1 },
    cascadeDown: { direction: "down", risk: 40, seedNotional: 300_000, terminalPct: -1, linkCount: 2, firstClusterPrice: 99.9 },
    // The realistic case: a cluster right on top of price, and better ones further out.
    nearestAbove: cl(100.1), nearestBelow: cl(99.9),
    volatilityPct: 0.1, participants: null, markout: EMPTY_MARKOUT, news: NO_NEWS, funding: EMPTY_FUNDING,
    events: NO_EVENT_RISK, openInterestNotional: 5e7, longShortRatio: 1.2, flow: { buy: 5000, sell: 4000 },
  };
}

const go = (clusters: Cluster[]) => proposePosition({
  direction: "up", state: state(), equity: 5000, realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
  limits, costCurve, clusters, config: { riskFraction: 0.02, canPostEntries: true },
});

console.log("\n## the target");

// A near cluster and a worthwhile one further out. Before the fix the near one
// was chosen and the trade refused; now the further one is.
let r = go([cl(99.9), cl(100.1), cl(101.5)]);
ok("a level too close no longer blocks the trade", r.ok, r.ok ? "" : r.reasons.join("; "));
ok("...the worthwhile one is targeted instead", r.ok && r.targetPrice === 101.5, r.ok ? String(r.targetPrice) : "");
ok("...and reward-to-risk clears the floor", r.ok && (r.rewardRisk ?? 0) >= 1.2, r.ok ? (r.rewardRisk ?? 0).toFixed(2) : "");
ok("...with the near level explained, not ignored",
  r.ok && r.reasoning.some((x) => x.includes("looking further out")));

// Only near levels: correctly nothing to aim at.
r = go([cl(99.9), cl(100.1)]);
ok("nothing worth reaching still refuses", !r.ok, !r.ok ? r.reasons[0] : "");

// The nearest *worthwhile* one is picked, not the furthest.
r = go([cl(101.0), cl(103.0), cl(106.0)]);
ok("the nearest qualifying level wins, not the furthest", r.ok && r.targetPrice === 101, r.ok ? String(r.targetPrice) : "");

// A short looks the other way.
const short = proposePosition({
  direction: "down", state: state(), equity: 5000, realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
  limits, costCurve, clusters: [cl(100.1), cl(99.9), cl(98.5)], config: { riskFraction: 0.02, canPostEntries: true },
});
ok("a short targets below", short.ok && (short.targetPrice ?? 0) < MID, short.ok ? String(short.targetPrice) : short.reasons.join("; "));

console.log("\n## what this changes in practice");
const near = go([cl(99.9), cl(100.1)]);
const far = go([cl(99.9), cl(100.1), cl(101.5)]);
console.log(`    only levels within 0.1%:        ${near.ok ? "trades" : "REFUSED — " + near.reasons[0].slice(0, 55)}`);
console.log(`    one level 1.5% out as well:     ${far.ok ? `trades ${far.quantity.toFixed(0)} @ RR ${(far.rewardRisk ?? 0).toFixed(2)}` : "refused"}`);

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails ? 1 : 0);
