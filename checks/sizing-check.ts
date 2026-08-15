import { WEIGHTS } from "../lib/sweep/metrics/session";
import { NO_NEWS } from "../lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "../lib/sweep/metrics/markout";
import { EMPTY_FUNDING } from "../lib/sweep/metrics/funding";
import { NO_EVENT_RISK } from "../lib/sweep/metrics/events";
import { proposePosition } from "../lib/sweep/agent/sizing";
import type { AgentState } from "../lib/sweep/agent/types";
import type { Cluster, CostPoint } from "../lib/sweep/types";

let fail=0; const ok=(c:boolean,m:string)=>{ if(!c){console.error("FAIL: "+m);fail++;} else console.log("ok   "+m); };

const curve: CostPoint[] = [0.1,0.25,0.5,1,2,3,5].map(p=>({pct:p,downNotional:p*400_000,upNotional:p*400_000,downExhausted:false,upExhausted:false}));
const clusters: Cluster[] = [
  {price:98,effect:"amplifying",pushes:"down",notional:2e6,confidence:.6,sources:["round"],spent:0,distPct:-2},
  {price:106,effect:"amplifying",pushes:"up",notional:2e6,confidence:.6,sources:["round"],spent:0,distPct:6},
];
const base = (over: Partial<AgentState> = {}): AgentState => ({
  ts:Date.now(), symbol:"INTCUSDT",
  health:{level:"ok",tradeable:true,reasons:[],summary:"live",snapshotAgeMs:100},
  session:{cashOpen:true,phase:"regular",msToNext:1e6,nextLabel:"cash close",intraday:"morning",weights:WEIGHTS.morning,msSincePhaseStart:30*60_000,transitioning:false},
  mid:100, mark:100, last:100, bestBid:99.99, bestAsk:100.01,
  liquidity:{lwi:1,lwiBid:1,lwiAsk:1,lwiAdj:1,lwiBidAdj:1,lwiAskAdj:1,warm:true,imbalance:0,spreadBps:2,bidNotional:5e5,askNotional:5e5,
    withdrawnBid:0,withdrawnAsk:0,consumedBid:1e5,consumedAsk:1e5,windowSec:10},
  cascadeUp:null, cascadeDown:null,
  nearestAbove:clusters[1], nearestBelow:clusters[0],
  volatilityPct:0.2, participants:null,
  news: NO_NEWS, markout: EMPTY_MARKOUT, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
  openInterestNotional:5e6, longShortRatio:1, flow:{buy:0,sell:0}, ...over,
} as AgentState);

const limits = { maxPositionUsd:5000, maxLeverage:5, maxDailyLossUsd:100, stopLossPct:2 };
const call = (over={}, lim=limits) => proposePosition({direction:"up",state:base(over),equity:1000,realisedLossToday:0,limits:lim,costCurve:curve,clusters});

const p = call();
ok(p.ok, "proposes a position on a healthy feed");
if(!p.ok) console.log("   refused because:", p.reasons.join(" | "));
if (p.ok) {
  ok(Math.abs(p.riskUsd - 5) < 2.5, `risk lands near 0.5% of 1000 (got ${p.riskUsd.toFixed(2)})`);
  ok(p.stopPrice < p.entryPrice, "long stop is below entry");
  ok(p.leverage <= limits.maxLeverage, "leverage within cap");
  ok(p.notionalUsd <= limits.maxPositionUsd, "notional within cap");
  ok(p.stopDistancePct >= 2, `stop at least the configured 2% (got ${p.stopDistancePct.toFixed(2)})`);
  console.log("   reasoning:", p.reasoning.slice(0,2).join(" | "));
}

// stop must clear the noise
const volatile = call({volatilityPct:1.5});
ok(volatile.ok && volatile.stopDistancePct > 2, `high volatility widens the stop (got ${volatile.ok?volatile.stopDistancePct.toFixed(2):"n/a"})`);

// refusals
ok(!call({health:{level:"blind",tradeable:false,reasons:[],summary:"socket down",snapshotAgeMs:0}}).ok, "refuses on a blind feed");
ok(!call({liquidity:{...base().liquidity!,warm:false}}).ok, "refuses on a cold baseline");
ok(!proposePosition({direction:"up",state:base(),equity:1000,realisedLossToday:100,limits,costCurve:curve,clusters}).ok, "refuses at the daily loss cap");
// Zero means "no ceiling" now, matching every other cap. One empty box must
// never be able to refuse every order — see the adapter for what that cost.
ok(proposePosition({direction:"up",state:base(),equity:1000,realisedLossToday:0,limits:{...limits,maxPositionUsd:0},costCurve:curve,clusters}).ok, "a zero position cap means no ceiling, not a refusal");

// behavioural read shrinks size
const withdrawing = call({participants:{replenishSec:null,refillLevels:0,flickerPerSec:1,sliceUniformity:0,flowPersistence:0,tradesPerSec:1,regime:"liquidity-withdrawing",confidence:0.8,notes:["depth not coming back"]}});
const present = call({participants:{replenishSec:0.2,refillLevels:0,flickerPerSec:5,sliceUniformity:0,flowPersistence:0,tradesPerSec:2,regime:"liquidity-present",confidence:0.8,notes:["fast refill"]}});
ok(withdrawing.ok && present.ok && withdrawing.notionalUsd < present.notionalUsd,
   `withdrawing book sizes smaller (${withdrawing.ok?withdrawing.notionalUsd.toFixed(0):"n/a"} vs ${present.ok?present.notionalUsd.toFixed(0):"n/a"})`);

// closed session halves
const closed = call({session:{cashOpen:false,phase:"closed",msToNext:1e6,nextLabel:"pre-market opens",intraday:"overnight",weights:WEIGHTS.overnight,msSincePhaseStart:30*60_000,transitioning:false}});
ok(closed.ok && present.ok && closed.notionalUsd < present.notionalUsd, "closed session sizes smaller");

// a mediocre reward-to-risk is declined on purpose
const tight: Cluster[] = [clusters[0], {price:103,effect:"amplifying",pushes:"up",notional:2e6,confidence:.6,sources:["round"],spent:0,distPct:3}];
const marginal = proposePosition({direction:"up",state:{...base(),nearestAbove:tight[1]},equity:1000,realisedLossToday:0,limits,costCurve:curve,clusters:tight});
ok(!marginal.ok && marginal.reasons[0].includes("reward-to-risk"), "declines a trade whose reward does not justify the stop");

console.log(fail===0?"\nALL PASS":`\n${fail} FAILED`);
process.exitCode = fail?1:0;
