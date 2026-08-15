import { WEIGHTS } from "../lib/sweep/metrics/session";
import { NO_NEWS } from "../lib/sweep/agent/types";
import { EMPTY_MARKOUT } from "../lib/sweep/metrics/markout";
import { EMPTY_FUNDING } from "../lib/sweep/metrics/funding";
import { NO_EVENT_RISK } from "../lib/sweep/metrics/events";
import { directionalBias } from "../lib/sweep/agent/bias";
import type { AgentState } from "../lib/sweep/agent/types";

let fail=0; const ok=(c:boolean,m:string)=>{ if(!c){console.error("FAIL: "+m);fail++;} else console.log("ok   "+m); };

const st = (over: any = {}): AgentState => ({
  ts:Date.now(), symbol:"INTCUSDT",
  health:{level:"ok",tradeable:true,reasons:[],summary:"live",snapshotAgeMs:100},
  session:{cashOpen:true,phase:"regular",msToNext:1e6,nextLabel:"x",intraday:"morning",weights:WEIGHTS.morning,msSincePhaseStart:30*60_000,transitioning:false},
  mid:100, mark:100, last:100, bestBid:99.99, bestAsk:100.01,
  liquidity:{lwi:1,lwiBid:1,lwiAsk:1,lwiAdj:1,lwiBidAdj:1,lwiAskAdj:1,warm:true,imbalance:0,spreadBps:2,bidNotional:5e5,askNotional:5e5,
    withdrawnBid:0,withdrawnAsk:0,consumedBid:0,consumedAsk:0,windowSec:10},
  cascadeUp:{direction:"up",risk:20,seedNotional:500_000,terminalPct:2,linkCount:1,firstClusterPrice:103},
  cascadeDown:{direction:"down",risk:20,seedNotional:500_000,terminalPct:-2,linkCount:1,firstClusterPrice:97},
  nearestAbove:{price:103}as any, nearestBelow:{price:97}as any,
  volatilityPct:0.2,
  news: NO_NEWS, markout: EMPTY_MARKOUT, funding: EMPTY_FUNDING, events: NO_EVENT_RISK,
  participants:{replenishSec:.3,refillLevels:0,flickerPerSec:3,sliceUniformity:0,mechanical:0,
    flowPersistence:0,tradesPerSec:1,regime:"liquidity-present",confidence:.8,notes:["ok"],aggressor:null},
  openInterestNotional:5e6, longShortRatio:1, flow:{buy:0,sell:0}, ...over,
} as AgentState);

// symmetric -> no call
const flat = directionalBias(st());
ok(flat.direction===null, `symmetric book gives no direction (got ${flat.direction})`);
ok(flat.conviction===0, "no conviction when there is no side");

// cheap downside + thin bids -> down
const down = directionalBias(st({
  cascadeDown:{direction:"down",risk:70,seedNotional:60_000,terminalPct:-5,linkCount:3,firstClusterPrice:98},
  liquidity:{...st().liquidity!, lwiBid:0.4, lwiAsk:1.0, lwiBidAdj:0.4, lwiAskAdj:1.0},
}));
ok(down.direction==="down", `cheap downside + thin bids -> down (got ${down.direction})`);
ok(down.conviction>0.1, `has some conviction (${down.conviction.toFixed(2)})`);
ok(down.conviction<=0.75, "conviction stays capped");
console.log("   ", down.summary.slice(0,110));

// mirror
const up = directionalBias(st({
  cascadeUp:{direction:"up",risk:70,seedNotional:60_000,terminalPct:5,linkCount:3,firstClusterPrice:102},
  liquidity:{...st().liquidity!, lwiBid:1.0, lwiAsk:0.4, lwiBidAdj:1.0, lwiAskAdj:0.4},
}));
ok(up.direction==="up", `mirrored inputs -> up (got ${up.direction})`);

// evidence quality gates conviction
const blind = directionalBias(st({
  cascadeDown:{direction:"down",risk:70,seedNotional:60_000,terminalPct:-5,linkCount:3,firstClusterPrice:98},
  liquidity:{...st().liquidity!, lwiBid:0.4, lwiAsk:1.0, lwiBidAdj:0.4, lwiAskAdj:1.0},
  health:{level:"blind",tradeable:false,reasons:[],summary:"socket down",snapshotAgeMs:0},
}));
ok(blind.conviction < down.conviction*0.5, `a blind feed collapses conviction (${blind.conviction.toFixed(3)} vs ${down.conviction.toFixed(3)})`);

const cold = directionalBias(st({
  cascadeDown:{direction:"down",risk:70,seedNotional:60_000,terminalPct:-5,linkCount:3,firstClusterPrice:98},
  liquidity:{...st().liquidity!, lwiBid:0.4, lwiAsk:1.0, lwiBidAdj:0.4, lwiAskAdj:1.0, warm:false},
}));
ok(cold.conviction < down.conviction, "a cold baseline lowers conviction");

// imbalance alone must not swing the call
const spoof = directionalBias(st({ liquidity:{...st().liquidity!, imbalance:0.9} }));
ok(spoof.direction===null||spoof.conviction<0.2, `resting imbalance alone barely moves it (${spoof.direction}, ${spoof.conviction.toFixed(2)})`);

console.log(fail===0?"\nALL PASS":`\n${fail} FAILED`);
process.exitCode = fail?1:0;
