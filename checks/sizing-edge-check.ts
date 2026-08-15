import { directionalBias } from "@/lib/sweep/agent/bias";
import { proposePosition, type SizingLimits } from "@/lib/sweep/agent/sizing";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { NO_NEWS } from "@/lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster, CostPoint } from "@/lib/sweep/types";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const cluster = (price: number): Cluster => ({
  price,
  effect: "amplifying",
  pushes: price > 100 ? "up" : "down",
  notional: 500_000,
  confidence: 0.6,
  sources: ["leverage-long"],
  spent: 0,
  distPct: Math.abs((price - 100) / 100) * 100,
});

const costCurve: CostPoint[] = [0.1, 0.25, 0.5, 1, 2, 3, 5].map((pct) => ({
  pct,
  downNotional: pct * 400_000,
  upNotional: pct * 400_000,
  downExhausted: false,
  upExhausted: false,
}));

function baseState(over: Partial<AgentState> = {}): AgentState {
  return {
    ts: Date.now(),
    symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: {
      cashOpen: true,
      phase: "regular",
      msToNext: 3_600_000,
      nextLabel: "cash close",
      intraday: "morning",
      weights: WEIGHTS.morning,
      msSincePhaseStart: 30 * 60_000,
      transitioning: false,
    },
    mid: 100,
    mark: 100,
    last: 100,
    bestBid: 99.99,
    bestAsk: 100.01,
    liquidity: {
      lwi: 0.9,
      lwiBid: 0.8,
      lwiAsk: 1.0,
      lwiAdj: 0.9,
      lwiBidAdj: 0.8,
      lwiAskAdj: 1.0,
      warm: true,
      imbalance: -0.1,
      spreadBps: 2,
      bidNotional: 80_000,
      askNotional: 100_000,
      withdrawnBid: 20_000,
      withdrawnAsk: 4_000,
      consumedBid: 3_000,
      consumedAsk: 3_000,
      windowSec: 10,
    },
    cascadeUp: { direction: "up", risk: 30, seedNotional: 400_000, terminalPct: 1, linkCount: 2, firstClusterPrice: 101 },
    cascadeDown: { direction: "down", risk: 60, seedNotional: 150_000, terminalPct: -2, linkCount: 3, firstClusterPrice: 99 },
    nearestAbove: cluster(102),
    nearestBelow: cluster(99.5),
    volatilityPct: 0.15,
    participants: null,
    markout: EMPTY_MARKOUT,
    news: NO_NEWS,
    funding: EMPTY_FUNDING,
    events: NO_EVENT_RISK,
    openInterestNotional: 50_000_000,
    longShortRatio: 1.2,
    flow: { buy: 5_000, sell: 4_000 },
    ...over,
  };
}

const limits: SizingLimits = {
  maxPositionUsd: 50_000,
  maxLeverage: 8,
  maxDailyLossUsd: 400,
  stopLossPct: 0.5,
  maxTradesPerDay: 12,
  lossCooldownMin: 15,
  requireCashOpen: false,
  minRewardRisk: 1.5,
};

const propose = (state: AgentState) =>
  proposePosition({
    direction: "up",
    state,
    equity: 10_000,
    realisedLossToday: 0,
    tradesToday: 0,
    lastLossAt: 0,
    limits,
    costCurve,
    clusters: [cluster(99.5), cluster(102)],
  });

/* ------------------------------------------------------------------ checks */

console.log("\n## sizing with the new inputs");

const baseline = propose(baseState());
ok("a clean state still produces a proposal", baseline.ok, baseline.ok ? "" : baseline.reasons.join("; "));
const baseNotional = baseline.ok ? baseline.notionalUsd : 0;
if (baseline.ok) {
  ok("carry is reported on the proposal", baseline.carry !== undefined);
  ok("no funding schedule means free carry", baseline.carry.free);
}

/* Event blackout is a hard refusal. */
{
  const r = propose(
    baseState({
      events: { ...NO_EVENT_RISK, blackout: true, sizeScale: 0, reason: "Intel Q3 earnings — inside the blackout window" },
    }),
  );
  ok("a confirmed blackout refuses outright", !r.ok);
  ok("and says why", !r.ok && r.reasons.some((x) => x.includes("blackout")), !r.ok ? r.reasons[0] : "");
}

/* A projected event derates rather than refusing. */
{
  const r = propose(
    baseState({ events: { ...NO_EVENT_RISK, sizeScale: 0.5, reason: "inside the estimated earnings window", needsConfirmation: true } }),
  );
  ok("a projected event still allows a trade", r.ok, r.ok ? "" : r.reasons.join("; "));
  ok("...at reduced size", r.ok && r.notionalUsd < baseNotional * 0.75, r.ok ? `${r.notionalUsd.toFixed(0)} vs ${baseNotional.toFixed(0)}` : "");
  ok("...and says so", r.ok && r.reasoning.some((x) => x.includes("estimated earnings")));
}

/* Toxic flow refuses. */
{
  const r = propose(
    baseState({
      markout: { ...EMPTY_MARKOUT, warm: true, toxicity: 0.97, informed: 0.7, regime: "toxic", notes: ["mark-out exceeds the half-spread"] },
    }),
  );
  ok("toxic flow refuses a taker entry", !r.ok);
  ok("and names it", !r.ok && r.reasons.some((x) => x.includes("toxic")), !r.ok ? r.reasons[0] : "");
}

/* Mild toxicity does not. */
{
  const r = propose(
    baseState({ markout: { ...EMPTY_MARKOUT, warm: true, toxicity: 0.5, informed: 0.3, regime: "one-sided", notes: ["buyers ahead"] } }),
  );
  ok("ordinary one-sided flow does not block a trade", r.ok, r.ok ? "" : r.reasons.join("; "));
}

/* Session weighting scales size per phase. */
{
  const overnight = propose(
    baseState({
      session: {
        cashOpen: false,
        phase: "closed",
        msToNext: 3_600_000,
        nextLabel: "pre-market opens",
        intraday: "overnight",
        weights: WEIGHTS.overnight,
        msSincePhaseStart: 60 * 60_000,
        transitioning: false,
      },
    }),
  );
  ok("overnight sizes far below the morning", overnight.ok && overnight.notionalUsd < baseNotional * 0.4,
    overnight.ok ? `${overnight.notionalUsd.toFixed(0)} vs ${baseNotional.toFixed(0)}` : overnight.reasons.join("; "));
  ok("and explains the phase", overnight.ok && overnight.reasoning.some((x) => x.includes("overnight")));
}

/* Volatility is lifted only while transitioning into a livelier phase. */
{
  const settled = propose(
    baseState({
      session: { ...baseState().session, intraday: "open-auction", weights: WEIGHTS["open-auction"], msSincePhaseStart: 20 * 60_000, transitioning: false },
    }),
  );
  const fresh = propose(
    baseState({
      session: { ...baseState().session, intraday: "open-auction", weights: WEIGHTS["open-auction"], msSincePhaseStart: 60_000, transitioning: true },
    }),
  );
  ok("no volatility lift once the phase has settled", settled.ok && !settled.reasoning.some((x) => x.includes("still describes")));
  ok("volatility is lifted right after the bell", fresh.ok && fresh.reasoning.some((x) => x.includes("still describes")),
    fresh.ok ? "" : fresh.reasons.join("; "));
}

/* Funding: a settlement inside the hold that eats the target refuses. */
{
  const now = Date.now();
  const heavy = propose(
    baseState({
      funding: {
        ...EMPTY_FUNDING,
        rate: 0.01, // 1% per settlement — absurd, and that is the point
        intervalHours: 8,
        nextFundingTime: now + 60_000,
        msToFunding: 60_000,
        paying: "longs",
      },
    }),
  );
  ok("funding that swallows the target refuses", !heavy.ok);
  ok("and names funding", !heavy.ok && heavy.reasons.some((x) => x.includes("funding")), !heavy.ok ? heavy.reasons[0] : "");

  const light = propose(
    baseState({
      funding: { ...EMPTY_FUNDING, rate: 0.0001, intervalHours: 8, nextFundingTime: now + 60_000, msToFunding: 60_000, paying: "longs" },
    }),
  );
  ok("an ordinary rate does not", light.ok, light.ok ? "" : light.reasons.join("; "));
  ok("but is still reported", light.ok && light.carry.settlements === 1 && light.carry.costUsd > 0,
    light.ok ? light.carry.note : "");

  // A short receives it, and that is a credit rather than a cost. The level
  // geometry has to be mirrored for a short to have anywhere to go.
  const shortSide = proposePosition({
    direction: "down",
    state: baseState({
      nearestAbove: cluster(100.5),
      nearestBelow: cluster(98),
      funding: { ...EMPTY_FUNDING, rate: 0.0001, intervalHours: 8, nextFundingTime: now + 60_000, msToFunding: 60_000, paying: "longs" },
    }),
    equity: 10_000,
    realisedLossToday: 0,
    tradesToday: 0,
    lastLossAt: 0,
    limits,
    costCurve,
    // The target is now chosen from the full cluster list, so a short needs a
    // level below it in that list — not merely in state.nearestBelow.
    clusters: [cluster(100.5), cluster(98)],
  });
  ok("the receiving side books a credit", shortSide.ok && shortSide.carry.costUsd < 0,
    shortSide.ok ? shortSide.carry.note : shortSide.reasons.join("; "));
}

/* Bias picks up the new factors. */
console.log("\n## bias");
{
  const plain = directionalBias(baseState());
  const withMarkout = directionalBias(
    baseState({
      markout: { ...EMPTY_MARKOUT, warm: true, informed: -0.8, toxicity: 0.4, regime: "one-sided", notes: ["sellers have been right"] },
    }),
  );
  ok("mark-out appears as a factor", withMarkout.factors.some((f) => f.name === "who has been right"));
  ok("informed selling pushes the composite down", withMarkout.composite < plain.composite,
    `${withMarkout.composite.toFixed(3)} vs ${plain.composite.toFixed(3)}`);

  const crowdedLongs = directionalBias(
    baseState({
      funding: { ...EMPTY_FUNDING, rate: 0.001, stretched: true, crowded: "longs", percentile: 0.98, intervalHours: 8, paying: "longs" },
    }),
  );
  ok("stretched funding appears as a factor", crowdedLongs.factors.some((f) => f.name === "who is paying to hold"));
  ok("crowded longs push the composite down", crowdedLongs.composite < plain.composite,
    `${crowdedLongs.composite.toFixed(3)} vs ${plain.composite.toFixed(3)}`);

  const flatFunding = directionalBias(baseState({ funding: { ...EMPTY_FUNDING, rate: 0.00001 } }));
  ok("an ordinary rate contributes nothing", !flatFunding.factors.some((f) => f.name === "who is paying to hold"));

  const transitioning = directionalBias(
    baseState({ session: { ...baseState().session, transitioning: true } }),
  );
  ok("a phase change lowers conviction", transitioning.conviction < plain.conviction,
    `${transitioning.conviction.toFixed(3)} vs ${plain.conviction.toFixed(3)}`);
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
