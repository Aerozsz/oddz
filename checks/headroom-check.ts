/**
 * The -2019 fix, checked against the arithmetic that caused it.
 *
 * The sizer's affordability ceiling was `equity × leverage`, which is by
 * definition the largest position the account can fund and therefore rejects as
 * soon as the opening commission comes out of the same balance. This walks the
 * real sizer at the real settings and asserts the resulting order is fundable
 * with the fee included — the check the code never made.
 */
import { proposePosition } from "@/lib/sweep/agent/sizing";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { NO_NEWS } from "@/lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { DEFAULT_FEES } from "@/lib/sweep/metrics/fees";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster } from "@/lib/sweep/types";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

const cluster = (price: number, pushes: "up" | "down"): Cluster => ({
  price, effect: "amplifying", pushes, notional: 900_000, confidence: 0.8,
  sources: ["leverage-long"], spent: 0, distPct: Math.abs(price - 100) / 100 * 100,
});

const state = (mark = 100): AgentState => ({
  ts: Date.now(), symbol: "BTCUSDT",
  health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 40 },
  session: { cashOpen: true, phase: "regular", msToNext: 3_600_000, nextLabel: "close",
    intraday: "morning", weights: WEIGHTS.morning, msSincePhaseStart: 30 * 60_000, transitioning: false },
  mid: mark, mark, last: mark, bestBid: mark - 0.01, bestAsk: mark + 0.01,
  liquidity: { lwi: 0.3, lwiBid: 0.3, lwiAsk: 0.3, lwiAdj: 0.3, lwiBidAdj: 0.3, lwiAskAdj: 0.3,
    warm: true, imbalance: 0.4, spreadBps: 2, bidNotional: 200_000, askNotional: 80_000,
    withdrawnBid: 4_000, withdrawnAsk: 30_000, consumedBid: 3_000, consumedAsk: 4_000, windowSec: 10 },
  cascadeUp: null, cascadeDown: null,
  nearestAbove: cluster(101.5, "up"), nearestBelow: cluster(99.4, "down"),
  volatilityPct: 0.2, participants: null,
  markout: EMPTY_MARKOUT,
  news: NO_NEWS, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
  openInterestNotional: 90_000_000, longShortRatio: 1.05, flow: { buy: 4000, sell: 1500 },
} as unknown as AgentState);

const LIMITS = {
  maxPositionUsd: 100_000, maxLeverage: 20, maxDailyLossUsd: 0, stopLossPct: 0.2,
  maxTradesPerDay: 0, lossCooldownMin: 0, requireCashOpen: false, minRewardRisk: 1.2,
};

const size = (equity: number) => proposePosition({
  direction: "up", state: state(), equity,
  realisedLossToday: 0, tradesToday: 0, lastLossAt: 0, feesPaidToday: 0, grossProfitToday: 0,
  limits: LIMITS,
  costCurve: [{ targetPct: 0.2, notional: 5_000_000 }, { targetPct: 0.5, notional: 9_000_000 }],
  clusters: [cluster(101.5, "up"), cluster(99.4, "down")],
  config: { riskFraction: 0.04, fees: DEFAULT_FEES, canPostEntries: true, derateStrength: 0.5, minRewardOverFees: 2 },
} as unknown as Parameters<typeof proposePosition>[0]);

/** Would Binance accept it? Margin plus the taker fee on the way in. */
const fundable = (notional: number, leverage: number, balance: number) =>
  notional / leverage + notional * DEFAULT_FEES.takerRate <= balance;

const BALANCE = 5_000;

console.log("\n## the old behaviour, reproduced");
{
  // Sizing against the whole balance is what the adapter used to do.
  const p = size(BALANCE);
  if (p.ok) {
    const atCeiling = Math.abs(p.notionalUsd - BALANCE * LIMITS.maxLeverage) < 1;
    if (atCeiling) {
      ok("a position at the leverage ceiling is NOT fundable once the fee is counted",
        !fundable(p.notionalUsd, p.leverage, BALANCE),
        `notional ${p.notionalUsd.toFixed(0)}, margin ${(p.notionalUsd / p.leverage).toFixed(0)}, balance ${BALANCE}`);
    } else {
      ok("this setup does not reach the ceiling, so the boundary is not exercised here", true,
        `notional ${p.notionalUsd.toFixed(0)} of a ${BALANCE * LIMITS.maxLeverage} ceiling`);
    }
  } else ok("sizer produced a proposal", false, p.reasons.join("; "));
}

console.log("\n## with headroom, every order the sizer produces is fundable");
{
  let worst: string | null = null;
  let produced = 0;
  // Sweep balances and headrooms: the boundary is a fraction, so it has to hold
  // at every account size rather than at the one that happened to be tested.
  for (const balance of [200, 500, 1_000, 5_000, 20_000, 100_000]) {
    for (const headroom of [5, 10, 20]) {
      const committable = balance * (1 - headroom / 100);
      const p = size(committable);
      if (!p.ok) continue;
      produced++;
      // The adapter derives leverage from the committable balance too.
      const implied = p.notionalUsd / Math.max(committable, 1e-9);
      const lev = Math.min(LIMITS.maxLeverage, Math.max(1, Math.ceil(implied)));
      if (!fundable(p.notionalUsd, lev, balance)) {
        worst = `balance ${balance}, headroom ${headroom}%: notional ${p.notionalUsd.toFixed(0)} at ${lev}x ` +
          `needs ${(p.notionalUsd / lev + p.notionalUsd * 0.0005).toFixed(2)}`;
      }
    }
  }
  // Guards against the assertion passing because nothing was ever sized.
  ok("the sweep actually produced proposals to check", produced >= 10, `${produced} of 18`);
  ok("every one of them is fundable with the fee counted", worst === null, worst ?? "clean");
}

console.log("\n## headroom costs size but never changes the risk taken");
{
  const a = size(BALANCE);
  const b = size(BALANCE * 0.9);
  if (a.ok && b.ok) {
    // Risk is a fraction of the equity handed in, so a smaller committable
    // balance means a proportionally smaller risk AND position — the ratio,
    // which is what the stop distance sets, is untouched.
    const ratioA = a.riskUsd / a.notionalUsd;
    const ratioB = b.riskUsd / b.notionalUsd;
    ok("the risk-to-notional ratio is unchanged by headroom",
      Math.abs(ratioA - ratioB) < 1e-9, `${ratioA.toFixed(6)} vs ${ratioB.toFixed(6)}`);
    ok("...and the stop distance is the same", Math.abs(a.stopDistancePct - b.stopDistancePct) < 1e-9);
  } else ok("both sized", false);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
