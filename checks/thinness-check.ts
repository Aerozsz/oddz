/**
 * The entry gate the thesis always implied and never enforced.
 *
 * The bias scored which side of the book was thinner *than the other* and never
 * asked whether either had actually thinned. A book with bids at 1.17x and asks
 * at 1.00x called a long — on depth at and above its own baseline, where nothing
 * had been withdrawn. 59 live trades entered that way and won 3%.
 */
import { WEIGHTS } from "../lib/sweep/metrics/session";
import { NO_NEWS } from "../lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "../lib/sweep/metrics/markout";
import { EMPTY_FUNDING } from "../lib/sweep/metrics/funding";
import { NO_EVENT_RISK } from "../lib/sweep/metrics/events";
import { directionalBias } from "../lib/sweep/agent/bias";
import type { AgentState } from "../lib/sweep/agent/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

const st = (bid: number, ask: number, over: Record<string, unknown> = {}): AgentState => ({
  ts: Date.now(), symbol: "BTCUSDT",
  health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 100 },
  session: { cashOpen: true, phase: "regular", msToNext: 1e6, nextLabel: "x", intraday: "morning",
    weights: WEIGHTS.morning, msSincePhaseStart: 30 * 60_000, transitioning: false },
  mid: 65000, mark: 65000, last: 65000, bestBid: 64999, bestAsk: 65001,
  liquidity: { lwi: (bid + ask) / 2, lwiBid: bid, lwiAsk: ask,
    lwiAdj: (bid + ask) / 2, lwiBidAdj: bid, lwiAskAdj: ask,
    warm: true, imbalance: 0, spreadBps: 2, bidNotional: 5e5, askNotional: 5e5,
    withdrawnBid: 0, withdrawnAsk: 0, consumedBid: 0, consumedAsk: 0, windowSec: 10 },
  // Symmetric cascades, so the depth factor is the only thing with a view.
  cascadeUp: { direction: "up", risk: 30, seedNotional: 500_000, terminalPct: 2, linkCount: 1, firstClusterPrice: 65500 },
  cascadeDown: { direction: "down", risk: 30, seedNotional: 500_000, terminalPct: -2, linkCount: 1, firstClusterPrice: 64500 },
  nearestAbove: { price: 65500 } as never, nearestBelow: { price: 64500 } as never,
  volatilityPct: 0.2,
  news: NO_NEWS, markout: EMPTY_MARKOUT, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
  participants: null, openInterestNotional: 5e6, longShortRatio: 1, flow: { buy: 0, sell: 0 },
  ...over,
} as AgentState);

/*
 * An asymmetric cascade, matching the live screen: cheaper to push one way.
 * Depth is then the only thing varied, so any difference is the gate.
 */
const cheapUp = {
  cascadeUp: { direction: "up", risk: 55, seedNotional: 17_340_668, terminalPct: 2, linkCount: 2, firstClusterPrice: 65500 },
  cascadeDown: { direction: "down", risk: 30, seedNotional: 28_205_342, terminalPct: -2, linkCount: 2, firstClusterPrice: 64500 },
  participants: { replenishSec: 0.4, refillLevels: 0, flickerPerSec: 3, sliceUniformity: 0.2, mechanical: 0.3,
    flowPersistence: 0.1, tradesPerSec: 2, regime: "liquidity-present", confidence: 0.8, notes: [], aggressor: null },
};

console.log("\n## the exact book from the live screen: bids 1.17x, asks 1.00x");
const thick = directionalBias(st(1.17, 1.00, cheapUp));
console.log("   ", thick.direction, thick.conviction.toFixed(3), "|", thick.summary.slice(0, 120));

console.log("\n## the same setup, but the ceiling has genuinely been withdrawn");
const thin = directionalBias(st(1.17, 0.70, cheapUp));
console.log("   ", thin.direction, thin.conviction.toFixed(3), "|", thin.summary.slice(0, 120));

ok("a withdrawn ceiling convinces more than a normal one",
  thin.conviction > thick.conviction, `${thin.conviction.toFixed(3)} vs ${thick.conviction.toFixed(3)}`);
ok("and it is a large difference, not a rounding one",
  thin.conviction > thick.conviction * 1.3, `${(thin.conviction / Math.max(thick.conviction, 1e-9)).toFixed(2)}x`);

console.log("\n## depth contributes nothing while the book is at or above baseline");
for (const [b, a] of [[1.17, 1.00], [1.4, 1.2], [1.05, 1.0], [2.0, 1.5]] as [number, number][]) {
  const r = directionalBias(st(b, a, cheapUp));
  const f = r.factors?.find((x: { name: string }) => x.name === "which side thinned");
  ok(`bids ${b}x / asks ${a}x: the depth factor scores zero`, !f || Math.abs(f.score) < 1e-9,
    f ? `score ${f.score}` : "factor absent");
}

console.log("\n## and it scales with how much was withdrawn");
// A half-withdrawal plus this cascade does not clear the dead zone, which is
// the intended behaviour rather than a gap: a setup that only half-qualifies is
// not a setup. What matters is that the factor's own score scales.
const partial = directionalBias(st(1.17, 0.85, cheapUp));
const pf = partial.factors?.find((x: { name: string }) => x.name === "which side thinned");
const tf = thin.factors?.find((x: { name: string }) => x.name === "which side thinned");
ok("the depth factor scales with how much was withdrawn",
  !!pf && !!tf && Math.abs(pf.score) > 0 && Math.abs(pf.score) < Math.abs(tf.score),
  `half ${pf?.score.toFixed(3)} vs full ${tf?.score.toFixed(3)}`);
ok("...and a half-qualified setup still does not fire",
  partial.conviction <= thin.conviction, `${partial.conviction.toFixed(3)} vs ${thin.conviction.toFixed(3)}`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
