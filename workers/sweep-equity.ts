/**
 * How much does this need to trade at all?
 *
 *   npm run sweep:equity
 *   npm run sweep:equity -- --price 100 --risk 2 --stop 3
 *
 * Not a preference question. INTCUSDT trades in whole contracts of about $100,
 * so below a certain equity the sizer produces a position smaller than one
 * contract, it rounds to zero, and the adapter refuses. Every time, in every
 * session phase, for reasons that read like the strategy being cautious rather
 * than the account being too small — which is the expensive way to discover it.
 *
 * This runs the real sizer across a range of balances and reports where the
 * floor actually is, so the number can be checked rather than taken on trust
 * and re-checked after changing the risk settings.
 */

import { loadEnv } from "./load-env";
import { proposePosition } from "../lib/sweep/agent/sizing";
import type { AgentState } from "../lib/sweep/agent/types";
import { NO_NEWS } from "../lib/sweep/agent/types";
import { NO_EVENT_RISK } from "../lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "../lib/sweep/metrics/funding";
import { EMPTY_MARKOUT } from "../lib/sweep/metrics/markout";
import { WEIGHTS } from "../lib/sweep/metrics/session";
import type { Cluster, CostPoint } from "../lib/sweep/types";
import { SYMBOL } from "../lib/sweep/config";

loadEnv();

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

/** One contract's notional. INTCUSDT tracks Intel, so roughly the share price. */
const PRICE = arg("price", 100);
const RISK_PCT = arg("risk", 2);
const STOP_PCT = arg("stop", 3);

const cluster = (p: number): Cluster => ({
  price: p,
  effect: "amplifying",
  pushes: p > PRICE ? "up" : "down",
  notional: 500_000,
  confidence: 0.6,
  sources: ["leverage-long"],
  spent: 0,
  distPct: Math.abs((p - PRICE) / PRICE) * 100,
});

const costCurve: CostPoint[] = [0.1, 0.25, 0.5, 1, 2, 3, 5].map((pct) => ({
  pct,
  downNotional: pct * 400_000,
  upNotional: pct * 400_000,
  downExhausted: false,
  upExhausted: false,
}));

/*
 * A deliberately favourable setup: healthy feed, warm baselines, and a target
 * far enough away to clear reward-to-risk. The question here is only whether
 * the *size* works, so everything that could refuse for another reason is set
 * out of the way. A real market refuses more often, not less.
 */
function state(phase: keyof typeof WEIGHTS): AgentState {
  return {
    ts: Date.now(),
    symbol: SYMBOL,
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: {
      cashOpen: phase === "morning",
      phase: "regular",
      msToNext: 3.6e6,
      nextLabel: "cash close",
      intraday: phase,
      weights: WEIGHTS[phase],
      msSincePhaseStart: 30 * 60_000,
      transitioning: false,
    },
    mid: PRICE,
    mark: PRICE,
    last: PRICE,
    bestBid: PRICE - 0.01,
    bestAsk: PRICE + 0.01,
    liquidity: {
      lwi: 0.9, lwiBid: 0.9, lwiAsk: 0.9, lwiAdj: 0.9, lwiBidAdj: 0.9, lwiAskAdj: 0.9,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 80_000, askNotional: 80_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 3_000, consumedAsk: 3_000, windowSec: 10,
    },
    cascadeUp: { direction: "up", risk: 40, seedNotional: 300_000, terminalPct: 1, linkCount: 2, firstClusterPrice: PRICE * 1.01 },
    cascadeDown: { direction: "down", risk: 50, seedNotional: 200_000, terminalPct: -1, linkCount: 2, firstClusterPrice: PRICE * 0.99 },
    nearestAbove: cluster(PRICE * 1.06),
    nearestBelow: cluster(PRICE * 0.995),
    volatilityPct: 0.15,
    participants: null,
    markout: EMPTY_MARKOUT,
    funding: EMPTY_FUNDING,
    events: NO_EVENT_RISK,
    news: NO_NEWS,
    openInterestNotional: 5e7,
    longShortRatio: 1.2,
    flow: { buy: 5000, sell: 4000 },
  };
}

interface Row {
  equity: number;
  phase: string;
  contracts: number;
  notional: number;
  refusal: string | null;
}

function sizeAt(equity: number, phase: keyof typeof WEIGHTS): Row {
  const r = proposePosition({
    direction: "up",
    state: state(phase),
    equity,
    realisedLossToday: 0,
    tradesToday: 0,
    lastLossAt: 0,
    limits: {
      maxPositionUsd: equity,
      maxLeverage: 8,
      maxDailyLossUsd: equity * 0.07,
      stopLossPct: STOP_PCT,
      maxTradesPerDay: 12,
      lossCooldownMin: 15,
      requireCashOpen: false,
      minRewardRisk: 1.2,
    },
    costCurve,
    clusters: [cluster(PRICE * 0.995), cluster(PRICE * 1.06)],
    config: { riskFraction: RISK_PCT / 100 },
  });
  if (!r.ok) return { equity, phase, contracts: 0, notional: 0, refusal: r.reasons[0] };
  return {
    equity,
    phase,
    // Whole contracts, which is what the exchange actually accepts.
    contracts: Math.floor(r.notionalUsd / PRICE),
    notional: r.notionalUsd,
    refusal: null,
  };
}

const PHASES = ["morning", "overnight"] as const;
const LADDER = [100, 250, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10_000];

console.log("");
console.log(`  ${SYMBOL} — one contract is about $${PRICE}, and quantity is whole contracts.`);
console.log(`  Risking ${RISK_PCT}% of equity per trade behind a ${STOP_PCT}% stop.`);
console.log("");
console.log(`  ${"equity".padStart(9)}   ${"cash hours".padStart(20)}   ${"overnight".padStart(20)}`);

const rows: Row[] = [];
for (const equity of LADDER) {
  const cells = PHASES.map((p) => {
    const r = sizeAt(equity, p);
    rows.push(r);
    if (r.refusal) return "REFUSED".padStart(20);
    return (r.contracts < 1
      ? "0 — rounds to zero"
      : `${r.contracts} contract${r.contracts === 1 ? "" : "s"} ($${r.notional.toFixed(0)})`
    ).padStart(20);
  });
  console.log(`  ${("$" + equity.toLocaleString()).padStart(9)}   ${cells.join("   ")}`);
}

const firstAny = LADDER.find((e) => rows.some((r) => r.equity === e && r.contracts >= 1));
const firstAll = LADDER.find((e) => PHASES.every((p) => (rows.find((r) => r.equity === e && r.phase === p)?.contracts ?? 0) >= 1));
// Granularity: below a few contracts, size moves in jumps too big to call sizing.
const firstSmooth = LADDER.find((e) =>
  PHASES.every((p) => (rows.find((r) => r.equity === e && r.phase === p)?.contracts ?? 0) >= 4),
);

const refusal = rows.find((r) => r.refusal)?.refusal;
if (refusal) {
  console.log("");
  console.log("  Every size was refused for the same reason, which means the settings rule this");
  console.log("  out before equity is even relevant:");
  console.log("");
  console.log(`    ${refusal}`);
}

console.log("");
console.log("  ─────");
console.log(`  Trades at all, cash hours only:   ${firstAny ? "$" + firstAny.toLocaleString() : "not within this range"}`);
console.log(`  Trades in every session phase:    ${firstAll ? "$" + firstAll.toLocaleString() : "not within this range"}`);
console.log(`  Enough granularity to size:       ${firstSmooth ? "$" + firstSmooth.toLocaleString() : "not within this range"}`);
console.log("");
console.log("  The last line matters more than it looks. At two contracts the smallest change");
console.log("  in size is fifty per cent, so risk-based sizing is a label rather than a fact —");
console.log("  the position is whatever rounding produced. Four is where it starts being real.");
console.log("");
console.log("  This assumes a setup that clears every other check. A real market refuses more");
console.log("  often, never less, so treat these as floors and not as expectations.");
console.log("");
