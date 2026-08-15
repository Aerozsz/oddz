import { createBinanceAdapter } from "../lib/sweep/exchange/adapter";
import { dayDrawdown, startOfDayUtc } from "../lib/sweep/exchange/activity";
import type { BinanceConfig } from "../lib/sweep/exchange/binance";
import type { AgentState, TradeIntent } from "../lib/sweep/agent/types";

let fail=0; const ok=(c:boolean,m:string)=>{ if(!c){console.error("FAIL: "+m);fail++;} else console.log("ok   "+m); };

const cfg={apiKey:"k",apiSecret:"s",baseUrl:"https://stub",live:false,recvWindowMs:5000} as BinanceConfig;
const LIM={maxPositionUsd:4679,maxLeverage:8,maxDailyLossUsd:351,maxOpenPositions:1,
  maxTradesPerDay:12,lossCooldownMin:15,stopLossPct:3,tradingEnabled:true};
const state={mid:101.58,health:{tradeable:true,summary:"live"}} as AgentState;
const intent:TradeIntent={id:"i1",t:Date.now(),side:"sell",signalId:"s",signalKind:"withdrawal",
  reason:"test",confidence:.5,reference:{mid:101.58,trigger:null,invalidation:null}};

// stub exchange
let income:any[]=[], positions:any[]=[], posted:any[]=[];
globalThis.fetch=(async(u:any,init:any)=>{
  const url=String(u);
  if(url.includes("/income")) return new Response(JSON.stringify(income),{status:200});
  if(url.includes("/v2/account")) return new Response(JSON.stringify({availableBalance:"7019",totalWalletBalance:"7019",
    totalUnrealizedProfit:"0",totalMaintMargin:"0",totalMarginBalance:"7019",positions:positions}),{status:200});
  if(url.includes("/positionRisk")) return new Response(JSON.stringify(positions),{status:200});
  if(url.includes("/openOrders")) return new Response(JSON.stringify([]),{status:200});
  // Stops and targets moved to the Algo Order endpoint. Without this branch the
  // stub swallowed them and the fixture could not tell a placed stop from a
  // missing one — the single most important thing this file checks.
  if(url.includes("/algoOrder")&&init?.method==="POST"){
    const q=Object.fromEntries(new URL(url).searchParams); posted.push(q);
    return new Response(JSON.stringify({algoId:99,symbol:q.symbol,side:q.side,type:q.type,
      triggerPrice:q.triggerPrice??"0",closePosition:q.closePosition==="true",status:"NEW"}),{status:200});
  }
  if(url.includes("/v1/order")&&init?.method==="POST"){
    const q=Object.fromEntries(new URL(url).searchParams); posted.push(q);
    if(q.type==="MARKET") positions=[{symbol:"INTCUSDT",positionAmt:"-46",entryPrice:"101.58",markPrice:"101.58",
      unrealizedProfit:"0",liquidationPrice:"0",leverage:"8"}];
    return new Response(JSON.stringify({orderId:1,symbol:q.symbol,side:q.side,type:q.type,
      stopPrice:q.stopPrice??"0",closePosition:q.closePosition==="true",status:"NEW"}),{status:200});
  }
  return new Response("{}",{status:200});
}) as any;

async function main(){
  // --- happy path
  let a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit(intent,state);
  ok(a.history[0].outcome==="submitted", `submits when everything is clear (${a.history[0].outcome}: ${a.history[0].detail.slice(0,60)})`);
  ok(posted.some(p=>p.type==="MARKET"), "sent a market entry");
  ok(posted.some(p=>p.type==="STOP_MARKET"&&p.closePosition==="true"&&p.triggerPrice), "sent a protective stop via the algo endpoint with closePosition");
  ok(posted.find(p=>p.type==="MARKET").side==="SELL", "short intent -> SELL entry");

  // --- refuses when already holding
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i2"},state);
  ok(a.history[0].outcome==="refused"&&a.history[0].detail.includes("already holding"), "refuses to add to an open position");
  positions=[];

  // --- disarmed
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>({...LIM,tradingEnabled:false}),quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i3"},state);
  ok(a.history[0].detail==="trading is disarmed", "refuses while disarmed");

  // --- daily loss cap, fees included
  income=[{symbol:"INTCUSDT",incomeType:"REALIZED_PNL",income:"-340",time:Date.now()-3600e3},
          {symbol:"INTCUSDT",incomeType:"COMMISSION",income:"-15",time:Date.now()-3600e3}];
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i4"},state);
  ok(a.history[0].outcome==="refused"&&a.history[0].detail.includes("daily loss cap"),
     `daily cap counts fees too (${a.history[0].detail.slice(0,58)})`);

  // --- cooldown after a loss
  income=[{symbol:"INTCUSDT",incomeType:"REALIZED_PNL",income:"-10",time:Date.now()-60e3}];
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i5"},state);
  ok(a.history[0].detail.includes("cooling off"), `cooldown enforced (${a.history[0].detail.slice(0,50)})`);

  // --- trades-per-day
  income=Array.from({length:12},(_,i)=>({symbol:"INTCUSDT",incomeType:"REALIZED_PNL",income:"5",time:Date.now()-i*3600e3}));
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i6"},state);
  ok(a.history[0].detail.includes("trades today"), "trades-per-day cap enforced");

  // --- unhealthy feed
  income=[];
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>LIM,quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i7"},{...state,health:{tradeable:false,summary:"socket down"}} as AgentState);
  ok(a.history[0].detail.includes("not tradeable"), "refuses on an unhealthy feed");

  // --- leverage ceiling
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>({...LIM,maxLeverage:0.5}),quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i8"},state);
  ok(a.history[0].detail.includes("ceiling"), "leverage ceiling enforced");

  // --- a limits file with no marginHeadroomPct must not void the cap
  a=createBinanceAdapter({cfg,symbol:"INTCUSDT",limits:()=>({...LIM,maxLeverage:0.5,marginHeadroomPct:undefined as any}),
    quantityPrecision:0,size:()=>({notionalUsd:4672,stopPct:2,leverage:8,reason:"fixture"})});
  await a.submit({...intent,id:"i9"},state);
  ok(a.history[0].outcome!=="submitted", `an absent marginHeadroomPct still refuses (${a.history[0].outcome}: ${a.history[0].detail.slice(0,70)})`);

  // --- drawdown maths
  ok(dayDrawdown({realisedPnl:-100,fees:20,funding:5,realisedLoss:100,trades:1,lastLossAt:0,since:0})===125,
     "drawdown nets pnl, fees and funding");
  ok(dayDrawdown({realisedPnl:200,fees:20,funding:5,realisedLoss:0,trades:1,lastLossAt:0,since:0})===0,
     "a profitable day has no drawdown");
  ok(startOfDayUtc(Date.UTC(2026,7,6,13,45))===Date.UTC(2026,7,6), "day starts at UTC midnight");

  console.log(fail===0?"\nALL PASS":`\n${fail} FAILED`);
  process.exitCode=fail?1:0;
}
void main();
