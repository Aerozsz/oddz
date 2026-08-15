import { ParticipantTracker } from "../lib/sweep/metrics/participants";
import type { Trade } from "../lib/sweep/types";

let fail=0; const ok=(c:boolean,m:string)=>{ if(!c){console.error("FAIL: "+m);fail++;} else console.log("ok   "+m); };
const T=(price:number,qty:number,t:number):Trade=>({t,price,qty,notional:price*qty,buyerIsMaker:false});

// --- machine: computed sizes, tick pricing, even cadence
const mech = new ParticipantTracker();
let now = 1_800_000_000_000;
for (let i=0;i<120;i++){
  const price = 30.07 + (i%7)*0.01;          // tick-level, not round
  const qty   = 7.413 + (i%3)*0.0007;        // computed, near-identical
  now += 500;                                 // perfectly regular
  mech.onTrade(T(price,qty,now), now);
}
const m = mech.read(now).character;
console.log(`   mechanical=${m.mechanical.toFixed(2)} human=${m.human.toFixed(2)} label=${m.label} roundPx=${m.priceRoundnessRatio.toFixed(1)}x roundQty=${(m.quantityRoundness*100).toFixed(0)}% cadence=${m.timingRegularity.toFixed(2)}`);
ok(m.label==="mechanical", `computed flow reads mechanical (got ${m.label})`);
ok(m.timingRegularity>0.8, "even cadence detected");
ok(m.quantityRoundness<0.1, "computed sizes are not round");

// --- human: round prices, round sizes, bursty timing
const hum = new ParticipantTracker();
now = 1_800_000_000_000;
const roundPx=[30.00,30.50,31.00,29.50,30.00];
const roundQ=[10,5,25,100,50,10];
for (let i=0;i<120;i++){
  now += (i%5===0) ? 9000 : 120;             // bursts, then gaps
  hum.onTrade(T(roundPx[i%roundPx.length], roundQ[i%roundQ.length], now), now);
}
const h = hum.read(now).character;
console.log(`   mechanical=${h.mechanical.toFixed(2)} human=${h.human.toFixed(2)} label=${h.label} roundPx=${h.priceRoundnessRatio.toFixed(1)}x roundQty=${(h.quantityRoundness*100).toFixed(0)}% cadence=${h.timingRegularity.toFixed(2)}`);
ok(h.label==="human", `round-number flow reads human (got ${h.label})`);
ok(h.priceRoundnessRatio>2, `price clustering above chance (${h.priceRoundnessRatio.toFixed(1)}x)`);
ok(h.quantityRoundness>0.5, "unit bias in sizes detected");
ok(h.notes.some(n=>n.includes("unit bias")), "names unit bias explicitly");

// --- too little data
const thin = new ParticipantTracker();
thin.onTrade(T(30,1,now), now);
ok(thin.read(now).character.label==="unclear", "refuses to characterise on thin data");

console.log(fail===0?"\nALL PASS":`\n${fail} FAILED`);
process.exitCode = fail?1:0;
