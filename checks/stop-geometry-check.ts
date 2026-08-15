/**
 * The two defects that made the risk dials lie, pinned so they cannot return.
 *
 *  1. An adverse cluster at any distance dragged the stop out beyond it. A
 *     0.5% stop became 1.95% because the crowd's stops sat 1.8% away — four
 *     times the loss on a stop-out, and it moved the required target from
 *     0.60% to 2.93%, which is why setups were refused for a reward that was
 *     never the problem.
 *
 *  2. The reward-to-risk dial was combined with the code default by taking the
 *     larger of the two, so it could tighten and could not loosen. 1.5, 1.2 and
 *     1.0 all behaved identically as 1.5.
 */

import { proposePosition, type SizingLimits } from "@/lib/sweep/agent/sizing";
import type { AgentState } from "@/lib/sweep/agent/types";
import { NO_EVENT_RISK } from "@/lib/sweep/metrics/events";
import { EMPTY_FUNDING } from "@/lib/sweep/metrics/funding";
import { NO_NEWS } from "@/lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "@/lib/sweep/metrics/markout";
import { DEFAULT_FEES } from "@/lib/sweep/metrics/fees";
import { WEIGHTS } from "@/lib/sweep/metrics/session";
import type { Cluster, CostPoint } from "@/lib/sweep/types";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const ENTRY = 100;

const at = (pct: number): Cluster => {
  const price = Number((ENTRY * (1 + pct / 100)).toFixed(2));
  return {
    price,
    effect: "amplifying",
    pushes: pct > 0 ? "up" : "down",
    notional: 400_000,
    confidence: 0.6,
    sources: ["leverage-long"],
    spent: 0,
    distPct: Math.abs(pct),
  };
};

const costCurve: CostPoint[] = [0.1, 0.25, 0.5, 1, 2, 3, 5].map((pct) => ({
  pct, downNotional: pct * 900_000, upNotional: pct * 900_000,
  downExhausted: false, upExhausted: false,
}));

function state(volPct: number, clusters: Cluster[]): AgentState {
  const above = clusters.filter((c) => c.price > ENTRY).sort((a, b) => a.price - b.price)[0] ?? null;
  const below = clusters.filter((c) => c.price < ENTRY).sort((a, b) => b.price - a.price)[0] ?? null;
  return {
    ts: Date.now(), symbol: "INTCUSDT",
    health: { level: "ok", tradeable: true, reasons: [], summary: "live", snapshotAgeMs: 50 },
    session: { cashOpen: true, phase: "regular", msToNext: 3_600_000, nextLabel: "cash close",
      intraday: "morning", weights: WEIGHTS.morning, msSincePhaseStart: 30 * 60_000, transitioning: false },
    mid: ENTRY, mark: ENTRY, last: ENTRY, bestBid: ENTRY - 0.01, bestAsk: ENTRY + 0.01,
    liquidity: { lwi: 0.95, lwiBid: 0.95, lwiAsk: 0.95, lwiAdj: 0.95, lwiBidAdj: 0.95, lwiAskAdj: 0.95,
      warm: true, imbalance: 0, spreadBps: 2, bidNotional: 200_000, askNotional: 200_000,
      withdrawnBid: 5_000, withdrawnAsk: 5_000, consumedBid: 15_000, consumedAsk: 15_000, windowSec: 10 },
    cascadeUp: { direction: "up", risk: 40, seedNotional: 300_000, terminalPct: 1, linkCount: 2, firstClusterPrice: above?.price ?? null },
    cascadeDown: { direction: "down", risk: 55, seedNotional: 200_000, terminalPct: -1, linkCount: 2, firstClusterPrice: below?.price ?? null },
    nearestAbove: above, nearestBelow: below,
    volatilityPct: volPct, participants: null,
    markout: EMPTY_MARKOUT,
    news: NO_NEWS, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
    openInterestNotional: 80_000_000, longShortRatio: 1.1, flow: { buy: 5_000, sell: 5_000 },
  };
}

const limits: SizingLimits = {
  maxPositionUsd: 5_000, maxLeverage: 5, maxDailyLossUsd: 200,
  stopLossPct: 0.5, maxTradesPerDay: 8, lossCooldownMin: 15,
  requireCashOpen: false, minRewardRisk: 1.2,
};

const propose = (volPct: number, clusters: Cluster[], over: Partial<SizingLimits> = {}) =>
  proposePosition({
    direction: "up",
    state: state(volPct, clusters),
    equity: 2_000,
    realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits: { ...limits, ...over },
    costCurve, clusters,
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true },
  });

/* ------------------------------------------------ the stop stays where set */

console.log("\n## an adverse cluster only moves the stop when it is in reach");

{
  // 0.5% stop wanted; the crowd sits 1.8% below. Nothing to step around.
  const r = propose(0.05, [at(-1.8), at(1.0), at(2.0)]);
  ok("a distant cluster leaves the stop alone", r.ok && Math.abs(r.stopDistancePct - 0.5) < 1e-9,
    r.ok ? `${r.stopDistancePct.toFixed(2)}%` : r.reasons.join("; "));
  ok("...and says why it was left alone",
    r.ok && r.reasoning.some((x) => x.includes("nothing to step around")),
    r.ok ? (r.reasoning.find((x) => x.includes("step around")) ?? "(not mentioned)") : "");
}

{
  // The same 0.5% stop with the crowd 0.6% below — inside its reach, so the
  // stop that rests at 0.5% is exactly the one a sweep to 0.6% collects.
  const r = propose(0.05, [at(-0.6), at(1.0), at(2.0)]);
  ok("a nearby cluster still pushes the stop beyond it",
    r.ok && r.stopDistancePct > 0.7 && r.stopDistancePct < 0.8,
    r.ok ? `${r.stopDistancePct.toFixed(2)}%` : r.reasons.join("; "));
  ok("...and says it stepped around it",
    r.ok && r.reasoning.some((x) => x.includes("inside the") && x.includes("reach")));
}

{
  // Volatility widens the base stop, which widens what counts as "in reach".
  // The same 1.8% cluster that was ignored above is now genuinely near.
  const quiet = propose(0.05, [at(-1.8), at(3.0)]);
  const lively = propose(0.6, [at(-1.8), at(3.0)]);
  ok("the reach scales with the stop it is measured against",
    quiet.ok && lively.ok && quiet.stopDistancePct < 1 && lively.stopDistancePct > 1.9,
    quiet.ok && lively.ok ? `${quiet.stopDistancePct.toFixed(2)}% quiet vs ${lively.stopDistancePct.toFixed(2)}% lively` : "");
}

{
  // The consequence that mattered: a wider stop demands a further target, so
  // the old behaviour refused setups whose reward was never in question.
  const r = propose(0.05, [at(-1.8), at(0.8)]);
  ok("a target 0.8% out now qualifies against a 0.5% stop", r.ok,
    r.ok ? `RR ${r.rewardRisk?.toFixed(2)}` : r.reasons.join("; "));
  ok("...and risks what was configured, not four times it",
    r.ok && r.riskUsd / r.notionalUsd < 0.006,
    r.ok ? `${((r.riskUsd / r.notionalUsd) * 100).toFixed(2)}% of notional` : "");
}

/* ------------------------------------------------------- the dial is live */

console.log("\n## the reward-to-risk dial moves in both directions");

{
  const ladder = [-2.0, 0.3, 0.45, 0.6, 0.75, 0.9, 1.2, 1.8].map(at);
  const results = [0.8, 1.0, 1.2, 1.5, 2.0].map((rr) => ({
    rr,
    r: propose(0.05, ladder, { minRewardRisk: rr }),
  }));
  for (const { rr, r } of results) {
    console.log(`      ${rr.toFixed(1)} → ${r.ok ? `target ${r.targetPrice} RR ${r.rewardRisk?.toFixed(2)}` : r.reasons[0].slice(0, 60)}`);
  }
  ok("every setting produces a proposal", results.every((x) => x.r.ok));
  const rrs = results.map((x) => (x.r.ok ? (x.r.rewardRisk ?? 0) : 0));
  ok("...and a looser floor takes a nearer target", rrs[0] < rrs[4],
    `${rrs[0].toFixed(2)} at 0.8 vs ${rrs[4].toFixed(2)} at 2.0`);
  ok("...monotonically, with no dead zone below 1.5",
    rrs.every((v, i) => i === 0 || v >= rrs[i - 1]) && new Set(rrs.map((v) => v.toFixed(2))).size >= 4,
    rrs.map((v) => v.toFixed(2)).join(" "));
  ok("each proposal actually clears the floor it was given",
    results.every((x) => x.r.ok && (x.r.rewardRisk ?? 0) >= x.rr - 1e-9));
}

{
  // Below 1 is permitted, because whether it is sane depends on a hit rate this
  // code does not know — but the arithmetic has to be stated.
  const r = propose(0.05, [at(-2.0), at(0.45), at(1.5)], { minRewardRisk: 0.8 });
  ok("a sub-1 floor is allowed", r.ok, r.ok ? "" : r.reasons.join("; "));
  ok("...and reports the break-even hit rate it implies",
    r.ok && r.reasoning.some((x) => x.includes("hit rate")),
    r.ok ? (r.reasoning.find((x) => x.includes("hit rate")) ?? "(not mentioned)") : "");
}

/* ------------------------------------------------- refusals arrive at once */

console.log("\n## a refusal names everything wrong, not the first thing");

{
  // Nothing ahead at all, and not enough margin for what was asked.
  const r = proposePosition({
    direction: "up",
    state: state(0.05, [at(-0.6)]),
    equity: 20, // far too little for the 5,000 cap
    realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits: { ...limits, maxLeverage: 1 },
    costCurve, clusters: [at(-0.6)],
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true },
  });
  ok("it refuses", !r.ok);
  ok("...naming the missing target with the geometry behind it",
    !r.ok && r.reasons.some((x) => x.includes("no level ahead") && x.includes("stop")),
    !r.ok ? r.reasons.join(" | ") : "");
}

{
  // A target that clears reward-to-risk but not the cost of the round trip, so
  // two independent checks have something to say.
  const r = proposePosition({
    direction: "up",
    state: state(0.05, [at(-2), at(0.62)]),
    equity: 2_000,
    realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits: { ...limits, maxPositionUsd: 60 }, // tiny, so fees dominate
    costCurve, clusters: [at(-2), at(0.62)],
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true, minRewardOverFees: 50 },
  });
  ok("a cost-dominated setup refuses", !r.ok, r.ok ? "unexpectedly allowed" : "");
  ok("...and the reason carries both figures",
    !r.ok && r.reasons.some((x) => x.includes("of costs")),
    !r.ok ? r.reasons.join(" | ") : "");
}


/* --------------------------------------------- derates must not compound */

console.log("\n## size derates take the most binding view, not the product");

{
  const ladder = [-2.0, 0.9].map(at);
  const overnight = { cashOpen: false, phase: "closed" as const, msToNext: 3_600_000,
    nextLabel: "pre-market opens", intraday: "overnight" as const, weights: WEIGHTS.overnight,
    msSincePhaseStart: 60 * 60_000, transitioning: false };

  const clean = propose(0.05, ladder);
  const base = clean.ok ? clean.notionalUsd : 0;

  // Overnight alone: 0.25 sizeScale.
  const night = proposePosition({
    direction: "up",
    state: { ...state(0.05, ladder), session: overnight },
    equity: 2_000, realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits, costCurve, clusters: ladder,
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true },
  });
  ok("overnight sizes down", night.ok && night.notionalUsd < base, night.ok ? `${night.notionalUsd.toFixed(0)} vs ${base.toFixed(0)}` : night.reasons.join("; "));

  // Overnight AND quotes being pulled AND a projected event. Under the old
  // product this kept 0.25 x 0.25 x 0.5 = 3% of the budget.
  const stacked = proposePosition({
    direction: "up",
    state: {
      ...state(0.05, ladder),
      session: overnight,
      liquidity: { ...state(0.05, ladder).liquidity!, withdrawnBid: 100_000, withdrawnAsk: 100_000, consumedBid: 0, consumedAsk: 0 },
      events: { ...NO_EVENT_RISK, sizeScale: 0.5, reason: "inside the estimated earnings window", needsConfirmation: true },
    },
    equity: 2_000, realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits, costCurve, clusters: ladder,
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true },
  });
  ok("three bad conditions still produce a proposal", stacked.ok, stacked.ok ? "" : stacked.reasons.join("; "));
  ok("...keeping several times what the product gave",
    stacked.ok && stacked.sizeRetained > 0.031 * 2,
    stacked.ok ? `retained ${(stacked.sizeRetained * 100).toFixed(1)}% vs 3.1% under the product` : "");
  // The event derate is a different risk from a thin book, so it does stack —
  // stacked must be smaller than overnight alone, just not 32 times smaller.
  ok("...still smaller than the session alone, since the event is a separate risk",
    stacked.ok && night.ok && stacked.notionalUsd < night.notionalUsd,
    stacked.ok && night.ok ? `${stacked.notionalUsd.toFixed(0)} vs ${night.notionalUsd.toFixed(0)} overnight-only` : "");
  // Three genuinely bad conditions at once should produce a small position —
  // the objection was never to that, it was to correlated readings multiplying.
  // What must hold is that the two book readings did not compound: the derate
  // is the worst of them softened by the other, times the event, and nothing
  // more.
  {
    const expected = 0.25 * Math.sqrt(0.25) * 0.5; // presence, session, event
    ok("...by exactly the stated aggregation and no more",
      stacked.ok && Math.abs(stacked.sizeRetained - expected) < 1e-9,
      stacked.ok ? `${(stacked.sizeRetained * 100).toFixed(2)}% vs ${(expected * 100).toFixed(2)}% expected` : "");
  }
  ok("...and says which reading governed",
    stacked.ok && stacked.reasoning.some((x) => x.includes("% of the risk budget — set by")),
    stacked.ok ? (stacked.reasoning.find((x) => x.includes("% of the risk budget")) ?? "(absent)") : "");

  // Ordering must survive: worse conditions still size smaller than better ones.
  ok("a clean book still sizes largest", clean.ok && stacked.ok && clean.notionalUsd > stacked.notionalUsd,
    clean.ok && stacked.ok ? `${clean.notionalUsd.toFixed(0)} vs ${stacked.notionalUsd.toFixed(0)}` : "");
}


/* ------------------------------------------ the derate strength dial works */

console.log("\n## condition derates scale, and only they scale");

{
  const ladder = [-2.0, 0.9].map(at);
  const thin = {
    ...state(0.05, ladder),
    session: { cashOpen: false, phase: "closed" as const, msToNext: 3_600_000,
      nextLabel: "pre-market opens", intraday: "overnight" as const, weights: WEIGHTS.overnight,
      msSincePhaseStart: 60 * 60_000, transitioning: false },
  };
  const run = (derateStrength: number) => proposePosition({
    direction: "up", state: thin, equity: 2_000,
    realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits, costCurve, clusters: ladder,
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true, derateStrength },
  });

  const full = run(1), half = run(0.5), off = run(0);
  for (const [label, r] of [["full", full], ["half", half], ["off", off]] as const) {
    console.log(`      ${label.padEnd(5)} → retained ${r.ok ? (r.sizeRetained * 100).toFixed(1) + "%" : "refused"}`);
  }
  ok("all three settings produce a proposal", full.ok && half.ok && off.ok);
  ok("off applies no derate at all", off.ok && Math.abs(off.sizeRetained - 1) < 1e-9,
    off.ok ? `${(off.sizeRetained * 100).toFixed(1)}%` : "");
  ok("half sits between the two", half.ok && full.ok && half.sizeRetained > full.sizeRetained && half.sizeRetained < 1,
    half.ok && full.ok ? `${(full.sizeRetained * 100).toFixed(1)} < ${(half.sizeRetained * 100).toFixed(1)} < 100` : "");
  ok("...at exactly half strength", half.ok && full.ok
      && Math.abs(half.sizeRetained - (1 - 0.5 * (1 - full.sizeRetained))) < 1e-9,
    half.ok && full.ok ? `${(half.sizeRetained * 100).toFixed(2)}%` : "");
  ok("the softening is explained when it applies",
    half.ok && half.reasoning.some((x) => x.includes("derates at 50% strength")),
    half.ok ? (half.reasoning.find((x) => x.includes("risk budget")) ?? "(absent)") : "");
  ok("...and not mentioned at full strength",
    full.ok && !full.reasoning.some((x) => x.includes("strength")));
}

{
  // The dial must not reach anything that bounds what a mistake costs. Turning
  // derates off entirely leaves every one of these exactly where it was.
  const ladder = [-0.6, 0.9].map(at);
  const mk = (derateStrength: number, over: Partial<SizingLimits> = {}) => proposePosition({
    direction: "up", state: state(0.05, ladder), equity: 2_000,
    realisedLossToday: 0, tradesToday: 0, lastLossAt: 0,
    limits: { ...limits, ...over }, costCurve, clusters: ladder,
    config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true, derateStrength },
  });
  const a = mk(1), b = mk(0);
  ok("the stop distance is untouched by the dial",
    a.ok && b.ok && a.stopDistancePct === b.stopDistancePct,
    a.ok && b.ok ? `${a.stopDistancePct.toFixed(3)}% both` : "");
  ok("the reward-to-risk floor still binds with derates off",
    mk(0, { minRewardRisk: 5 }).ok === false);
  ok("the daily loss cap still binds with derates off",
    proposePosition({
      direction: "up", state: state(0.05, ladder), equity: 2_000,
      realisedLossToday: 200, tradesToday: 0, lastLossAt: 0,
      limits, costCurve, clusters: ladder,
      config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true, derateStrength: 0 },
    }).ok === false);
  ok("the trade ceiling still binds with derates off",
    proposePosition({
      direction: "up", state: state(0.05, ladder), equity: 2_000,
      realisedLossToday: 0, tradesToday: 8, lastLossAt: 0,
      limits, costCurve, clusters: ladder,
      config: { riskFraction: 0.02, fees: DEFAULT_FEES, canPostEntries: true, derateStrength: 0 },
    }).ok === false);
  ok("the position cap still binds with derates off",
    b.ok && b.notionalUsd <= limits.maxPositionUsd,
    b.ok ? `${b.notionalUsd.toFixed(0)} <= ${limits.maxPositionUsd}` : "");
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
