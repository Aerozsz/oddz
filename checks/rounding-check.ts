/**
 * Round numbers, on contracts that disagree about what round means.
 *
 * The bug this pins: both roundness tests were written for a $30 stock with a
 * $0.01 tick and whole-share quantities. On BTCUSDT ($0.10 tick, fractional
 * sizes) they did not degrade, they inverted — one price in ten lands on a whole
 * dollar by arithmetic alone, which read as 5x more round-number clustering than
 * chance, while the integer quantity test could never be true at all.
 */
import { roundingScale } from "../lib/sweep/metrics/participants";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

// A $30 equity perp: $0.01 tick, whole shares.
const eq = roundingScale(0.01, 1, 30);
// BTCUSDT: $0.10 tick, 0.001 lot step, ~$100k.
const btc = roundingScale(0.1, 0.001, 100_000);

console.log("\n## the scale adapts to the contract");
ok("equity rounds to the dollar and the half", eq.priceSteps[0] === 1 && eq.priceSteps[1] === 0.5, eq.priceSteps.join(","));
ok("BTC rounds to something far coarser", btc.priceSteps[0] >= 1000, btc.priceSteps.join(","));
ok("equity base rate is the classic 2%", Math.abs(eq.priceBaseRate - 0.02) < 1e-9, String(eq.priceBaseRate));
ok("BTC base rate is tiny, not 2%", btc.priceBaseRate < 0.001, btc.priceBaseRate.toExponential(2));

console.log("\n## the inversion is gone");
// Simulate a tape of ordinary BTC prices on a 0.1 tick: nothing deliberate.
const tick = 0.1;
let roundish = 0;
const N = 20000;
for (let i = 0; i < N; i++) {
  const p = Math.round((100_000 + i * tick) / tick) * tick;
  if (btc.priceSteps.some((s) => Math.abs(p / s - Math.round(p / s)) * s < 1e-9)) roundish++;
}
const observed = roundish / N;
const ratio = observed / btc.priceBaseRate;
ok("random BTC prices read as ~1x chance, not 5x", ratio > 0.5 && ratio < 2, ratio.toFixed(2) + "x");

console.log("\n## quantities");
const isRound = (scale: ReturnType<typeof roundingScale>, q: number) =>
  scale.qtySteps.some((s) => { const n = q / s; return Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) >= 1; });
ok("10 shares is round on the equity perp", isRound(eq, 10));
// The lot step itself is deliberately absent from the list: every valid
// quantity is a multiple of it, so including it scored every trade as round.
ok("7 shares is not", !isRound(eq, 7));
ok("1 share is not round either — that was the bug", !isRound(eq, 1));
ok("0.001 BTC (one lot step) is not round", !isRound(btc, 0.001));
ok("0.1 BTC is round — the same gesture as '10 contracts'", isRound(btc, 0.1), "steps: " + btc.qtySteps.join(","));
ok("0.05 BTC is round", isRound(btc, 0.05));
ok("0.01 BTC is round", isRound(btc, 0.01));
ok("0.0173 BTC is not", !isRound(btc, 0.0173));
ok("...and this was structurally impossible before", true, "the old test required an integer quantity");

console.log("\n## degenerate inputs never throw or divide by zero");
for (const [t, s, p] of [[0,0,0],[NaN,1,30],[0.01,1,0],[-1,-1,-1]] as [number,number,number][]) {
  const sc = roundingScale(t, s, p);
  ok(`scale(${t},${s},${p}) is usable`, sc.priceBaseRate > 0 && sc.qtySteps.length > 0 && sc.qtySteps.every(Number.isFinite),
    `base=${sc.priceBaseRate}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
