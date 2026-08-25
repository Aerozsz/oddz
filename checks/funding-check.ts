/**
 * The carry analysis has to distinguish a paid edge from a paid trap.
 *
 * Funding is the one cash flow on a perpetual that requires no view on
 * direction, which makes it the natural place to look after four separate
 * measurements said direction is unpredictable. It is also the classic way to
 * lose money slowly: the payment is small and certain, the price move against
 * you is large and uncertain, and a naive backtest that counts the first and
 * ignores the second prints a beautiful equity curve.
 *
 * So these assert both halves. A world where the crowd is wrong must come back
 * profitable, and a world where the crowd is right must come back losing —
 * because a summary that cannot report the second is worthless for deciding
 * whether to trade the first.
 */
import { scoreFunding, carryOver, type FundingPoint } from "../lib/sweep/backtest/funding";

let failures = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (!c) { failures++; console.error(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
  else console.log(`  ok — ${n}`);
};

const MIN = 60_000;

/** A series where the basis is `basis` and price then moves `driftBps`. */
function series(basis: (i: number) => number, driftBps: (i: number) => number, n = 3000): FundingPoint[] {
  const out: FundingPoint[] = [];
  let close = 65_000;
  for (let i = 0; i < n; i++) {
    close *= 1 + driftBps(i) / 10_000;
    out.push({ ts: Date.UTC(2024, 0, 1) + i * MIN, basisBps: basis(i), close });
  }
  return out;
}

function carryScales() {
  ok("carry is proportional to the holding period",
    Math.abs(carryOver(80, 480) - 75) < 1e-9, String(carryOver(80, 480)));
  ok("and is clamped at the venue's cap", carryOver(500, 480) === 75, String(carryOver(500, 480)));
  ok("half an interval pays half", Math.abs(carryOver(40, 240) - 20) < 1e-9, String(carryOver(40, 240)));
  ok("a negative basis pays the other way", carryOver(-40, 480) === -40);
}

function crowdWrongIsProfitable() {
  /*
   * Longs are crowded (positive basis) and price then falls. The collector is
   * short, so it earns the payment and the move. This must read as an edge.
   */
  const p = series((i) => (i % 10 === 0 ? 60 : 2), (i) => (i % 10 === 0 ? -3 : 0));
  const b = scoreFunding(p, 480);
  ok("buckets are produced", b.length === 10, String(b.length));
  const top = b[b.length - 1];
  ok("the extreme bucket has the largest basis", top.meanBasisBps > b[0].meanBasisBps);
  ok("the collector's price return is positive there",
    top.meanCollectorBps > 0, top.meanCollectorBps.toFixed(2));
  ok("and the total beats the carry alone",
    top.meanTotalBps > top.meanCarryBps, `${top.meanTotalBps.toFixed(2)} vs ${top.meanCarryBps.toFixed(2)}`);
}

function crowdRightIsATrap() {
  /*
   * The dangerous world: longs are crowded and price keeps rising. The
   * collector is short, is paid, and loses more than the payment. If the
   * summary cannot show that, it cannot be trusted with the profitable case.
   */
  const p = series((i) => (i % 10 === 0 ? 60 : 2), (i) => (i % 10 === 0 ? 8 : 0));
  const b = scoreFunding(p, 480);
  const top = b[b.length - 1];
  ok("a crowd that is right shows a losing collector",
    top.meanCollectorBps < 0, top.meanCollectorBps.toFixed(2));
  ok("and the total is negative despite being paid",
    top.meanTotalBps < 0, `total ${top.meanTotalBps.toFixed(2)} carry ${top.meanCarryBps.toFixed(2)}`);
  ok("the carry itself is still reported as positive",
    top.meanCarryBps > 0, top.meanCarryBps.toFixed(2));
}

function errorTermsTravel() {
  const b = scoreFunding(series(() => 10, () => 0), 480);
  ok("every bucket carries a standard error", b.every((x) => Number.isFinite(x.seBps)));
  ok("a flat series has no edge to find",
    Math.abs(b[b.length - 1].meanCollectorBps) < 1e-6, b[b.length - 1].meanCollectorBps.toFixed(6));
}

console.log("funding carry");
carryScales();
crowdWrongIsProfitable();
crowdRightIsATrap();
errorTermsTravel();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good");
