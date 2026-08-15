/** Drives the protection logic against a stubbed Binance. */
import { checkProtection, ensureProtected, findProtectiveStop, type Order } from "../lib/sweep/exchange/orders";
import type { BinanceConfig, Position } from "../lib/sweep/exchange/binance";

let fail=0; const ok=(c:boolean,m:string)=>{ if(!c){console.error("FAIL: "+m);fail++;} else console.log("ok   "+m); };

const cfg = { apiKey:"k", apiSecret:"s", baseUrl:"https://stub", live:false, recvWindowMs:5000 } as BinanceConfig;
const longPos: Position = { symbol:"INTCUSDT", positionAmt:10, entryPrice:100, markPrice:100,
  unrealizedPnl:0, liquidationPrice:50, leverage:2, notional:1000, marginType:"cross", isolatedMargin:0 };
const shortPos: Position = { ...longPos, positionAmt:-10 };

let placed: any[] = [];
let openOrders: any[] = [];
let algoOrders: any[] = [];
globalThis.fetch = (async (u: any, init: any) => {
  const url = String(u);
  // Protection now rests in the algo service, so the stub has to answer both
  // endpoints or the fixture tests a path production no longer takes.
  if (url.includes("/openAlgoOrders")) return new Response(JSON.stringify(algoOrders), {status:200});
  if (url.includes("/openOrders")) return new Response(JSON.stringify(openOrders), {status:200});
  if (url.includes("/algoOrder") && init?.method === "POST") {
    const q = Object.fromEntries(new URL(url).searchParams);
    placed.push(q);
    return new Response(JSON.stringify({algoId:7,symbol:q.symbol,side:q.side,type:q.type,
      triggerPrice:q.triggerPrice,closePosition:q.closePosition==="true",status:"NEW"}), {status:200});
  }
  if (url.includes("/fapi/v1/order") && init?.method === "POST") {
    const q = Object.fromEntries(new URL(url).searchParams);
    placed.push(q);
    return new Response(JSON.stringify({orderId:1,symbol:q.symbol,side:q.side,type:q.type,
      stopPrice:q.stopPrice,closePosition:q.closePosition==="true",status:"NEW"}), {status:200});
  }
  return new Response("{}", {status:200});
}) as any;

async function main(){
// flat
ok((await checkProtection(cfg,"INTCUSDT",null)).protected, "flat counts as protected");

// long with no stop
openOrders = [];
const bare = await checkProtection(cfg,"INTCUSDT",longPos);
ok(bare.protected===false, "long with no orders is unprotected");
ok(bare.reason.includes("NO STOP"), "reason names the danger plainly");

// ensureProtected places one below mark
placed=[];
const fixed = await ensureProtected(cfg,"INTCUSDT",longPos,2,2);
ok(fixed.protected, "ensureProtected reports protected");
ok(placed.length===1, "exactly one order placed");
ok(placed[0].side==="SELL", "long is protected by a SELL");
ok(placed[0].type==="STOP_MARKET", "uses STOP_MARKET");
ok(placed[0].closePosition==="true", "closePosition=true (position-level, auto-cancels)");
ok(placed[0].workingType==="MARK_PRICE", "triggers on mark price, not last");
ok(Math.abs(Number(placed[0].triggerPrice)-98)<0.01, `stop at 98 for 2% below 100 (got ${placed[0].triggerPrice})`);

// short mirrors
placed=[];
await ensureProtected(cfg,"INTCUSDT",shortPos,2,2);
ok(placed[0].side==="BUY", "short is protected by a BUY");
ok(Math.abs(Number(placed[0].triggerPrice)-102)<0.01, `short stop at 102 (got ${placed[0].triggerPrice})`);

// an existing valid stop is detected and not duplicated
openOrders = [{orderId:9,symbol:"INTCUSDT",side:"SELL",type:"STOP_MARKET",stopPrice:"97",closePosition:true,status:"NEW"}];
placed=[];
const already = await ensureProtected(cfg,"INTCUSDT",longPos,2,2);
ok(already.protected && placed.length===0, "an existing stop is reused, not duplicated");
ok(Math.abs((already.stopDistancePct??0)-3)<0.01, `distance reported as 3% (got ${already.stopDistancePct})`);

// a wrong-side order must not count as protection
openOrders = [{orderId:9,symbol:"INTCUSDT",side:"BUY",type:"STOP_MARKET",stopPrice:"97",closePosition:true,status:"NEW"}];
ok(findProtectiveStop(openOrders.map(o=>({...o,stopPrice:Number(o.stopPrice),reduceOnly:false,quantity:0} as Order)), longPos)===null,
   "a BUY stop does not protect a long");

// a take-profit above a long must not count either
openOrders = [{orderId:9,symbol:"INTCUSDT",side:"SELL",type:"STOP_MARKET",stopPrice:"110",closePosition:true,status:"NEW"}];
ok(findProtectiveStop(openOrders.map(o=>({...o,stopPrice:Number(o.stopPrice),reduceOnly:false,quantity:0} as Order)), longPos)===null,
   "a SELL stop above the mark does not protect a long");

console.log(fail===0?"\nALL PASS":`\n${fail} FAILED`);
process.exitCode = fail?1:0;
}
void main();
