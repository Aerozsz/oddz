// What does the sizer actually do at small equity on INTCUSDT?
import { proposePosition } from "@/lib/sweep/agent/sizing";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { NO_NEWS } from "@/lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster, CostPoint } from "@/lib/sweep/types";

const PRICE = 100;                       // one INTCUSDT contract is about this
const cluster = (p: number): Cluster => ({
  price: p, effect: "amplifying", pushes: p > PRICE ? "up" : "down", notional: 500_000,
  confidence: 0.6, sources: ["leverage-long"], spent: 0, distPct: Math.abs((p - PRICE) / PRICE) * 100,
});
const costCurve: CostPoint[] = [0.1, 0.25, 0.5, 1, 2, 3, 5].map((pct) => ({
  pct, downNotional: pct * 400_000, upNotional: pct * 400_000, downExhausted: false, upExhausted: false,
}));

function state(phase: keyof typeof WEIGHTS): AgentState {
  return {
    ts: Date.now(), symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: { cashOpen: phase === "morning", phase: "regular", msToNext: 3.6e6, nextLabel: "x",
      intraday: phase, weights: WEIGHTS[phase], msSincePhaseStart: 30 * 60_000, transitioning: false },
    mid: PRICE, mark: PRICE, last: PRICE, bestBid: PRICE - 0.01, bestAsk: PRICE + 0.01,
    liquidity: { lwi: 0.9, lwiBid: 0.9, lwiAsk: 0.9, lwiAdj: 0.9, lwiBidAdj: 0.9, lwiAskAdj: 0.9,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 80_000, askNotional: 80_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 3_000, consumedAsk: 3_000, windowSec: 10 },
    cascadeUp: { direction: "up", risk: 40, seedNotional: 300_000, terminalPct: 1, linkCount: 2, firstClusterPrice: 101 },
    cascadeDown: { direction: "down", risk: 50, seedNotional: 200_000, terminalPct: -1, linkCount: 2, firstClusterPrice: 99 },
    nearestAbove: cluster(106), nearestBelow: cluster(99.5),
    volatilityPct: 0.15, participants: null, markout: EMPTY_MARKOUT, news: NO_NEWS, funding: EMPTY_FUNDING,
    events: NO_EVENT_RISK, openInterestNotional: 5e7, longShortRatio: 1.2, flow: { buy: 5000, sell: 4000 },
  };
}

console.log("\n  One INTCUSDT contract is about $" + PRICE + ", and quantity is whole contracts.\n");
console.log(`  ${"equity".padStart(8)}  ${"phase".padEnd(11)}  ${"notional".padStart(10)}  ${"contracts".padStart(10)}  outcome`);

for (const equity of [100, 250, 500, 1000, 2500, 5000]) {
  for (const phase of ["morning", "overnight"] as const) {
    const r = proposePosition({
      direction: "up", state: state(phase), equity,
      realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
      limits: { maxPositionUsd: equity, maxLeverage: 8, maxDailyLossUsd: equity * 0.07,
        stopLossPct: 3, maxTradesPerDay: 12, lossCooldownMin: 15, requireCashOpen: false, minRewardRisk: 1.2 },
      costCurve, clusters: [cluster(99.5), cluster(106)],
      config: { riskFraction: 0.02 },
    });
    if (r.ok) {
      const contracts = Math.floor(r.notionalUsd / PRICE);
      console.log(`  ${("$" + equity).padStart(8)}  ${phase.padEnd(11)}  ${r.notionalUsd.toFixed(0).padStart(10)}  ` +
        `${String(contracts).padStart(10)}  ${contracts < 1 ? "ROUNDS TO ZERO — no order possible" : "ok"}`);
    } else {
      console.log(`  ${("$" + equity).padStart(8)}  ${phase.padEnd(11)}  ${"—".padStart(10)}  ${"—".padStart(10)}  refused: ${r.reasons[0].slice(0, 60)}`);
    }
  }
}
console.log("");
