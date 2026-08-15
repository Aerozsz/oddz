import { WEIGHTS } from "@/lib/sweep/metrics/session";
console.log("\n  retained share of the risk budget, before vs after\n");
const presence = { present:1, hidden:0.6, worked:0.5, withdrawing:0.4, "all cancelled":0.25 };
const FLOOR = 0.2;
console.log("    " + "phase".padEnd(22) + Object.keys(presence).map(k=>k.slice(0,11).padStart(15)).join(""));
for (const p of ["morning","open-auction","after-hours","overnight","weekend"] as const) {
  const ss = WEIGHTS[p].sizeScale;
  const row = Object.values(presence).map(pf => {
    const before = pf*ss*0.5;                       // with a projected event too
    const after  = Math.max(FLOOR, Math.min(pf, ss, 0.5));
    return `${(before*100).toFixed(0)}→${(after*100).toFixed(0)}%`.padStart(15);
  }).join("");
  console.log(`    ${(p+` (${ss})`).padEnd(22)}${row}`);
}
console.log("\n    (each cell also includes a projected-event derate of 0.5)");
console.log(`    worst case: ${(0.25*0.2*0.5*100).toFixed(1)}% → ${(FLOOR*100).toFixed(0)}%  —  a 32x reduction becomes 5x\n`);
