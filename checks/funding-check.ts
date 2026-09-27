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
  /*
   * A continuous basis, not two values.
   *
   * The first version used exactly 60 and 2, so ninety per cent of rows shared
   * one value — which is the degenerate case the tie guard now refuses, and
   * refuses correctly: two distinct values cannot support ten basis deciles. The
   * real premium index is quantised but not that coarse, and a fixture with two
   * levels was testing a distribution the venue never publishes.
   */
  const p = series((i) => (i % 10 === 0 ? 55 + (i % 7) : ((i * 13) % 31) - 5), (i) => (i % 10 === 0 ? -3 : 0));
  const b = scoreFunding(p, 480);
  ok("buckets are produced", b.length === 10, String(b.length));
  const top = b[b.length - 1];
  ok("the extreme bucket has the largest basis", top.meanBasisBps > b[0].meanBasisBps);
  ok("the bucket is not a tie", top.tied !== true, top.tiedNote ?? "");
  ok("the collector's price return is positive there",
    (top.meanCollectorBps ?? 0) > 0, String(top.meanCollectorBps));
  ok("and the total beats the carry alone",
    (top.meanTotalBps ?? 0) > top.meanCarryBps,
    `${(top.meanTotalBps ?? 0).toFixed(2)} vs ${top.meanCarryBps.toFixed(2)}`);
}

/**
 * A quantised basis must not be reported as a basis finding.
 *
 * On LITUSDT about forty per cent of minutes carry a basis of exactly zero. A
 * sorted array sliced by index puts that tied group across four or five buckets,
 * and JavaScript's sort is stable, so within the tie the order is time order.
 * Those buckets reported collector returns of -101, -50, +38 and -55 basis
 * points at fifteen-plus sigma — eight-hour price drifts in different weeks,
 * labelled by a basis they did not vary in. They were quoted as a carry finding.
 *
 * The carry term itself survives, because it is arithmetic on the basis rather
 * than a statistic about price.
 */
function aQuantisedBasisWithholdsItsPriceTerm() {
  /* Half the sample at exactly zero, the rest spread. */
  const p = series(
    (i) => (i % 2 === 0 ? 0 : ((i * 17) % 41) - 20),
    (i) => (i % 97 === 0 ? -40 : 1),
    6000,
  );
  const b = scoreFunding(p, 480);
  ok("buckets are produced", b.length === 10, String(b.length));
  const tiedBuckets = b.filter((x) => x.tied);
  ok("the zero-basis buckets are flagged", tiedBuckets.length >= 3, String(tiedBuckets.length));
  ok("their price term is withheld", tiedBuckets.every((x) => x.meanCollectorBps === null));
  ok("and so is their total", tiedBuckets.every((x) => x.meanTotalBps === null));
  ok("but the carry term survives", tiedBuckets.every((x) => Number.isFinite(x.meanCarryBps)));
  ok("and each says why", tiedBuckets.every((x) => /array order/.test(x.tiedNote ?? "")));
  ok("the untied buckets still report", b.some((x) => !x.tied && x.meanCollectorBps !== null));
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
  /*
   * A varying basis, because a constant one is entirely tied and every bucket's
   * price term is withheld by design. The old fixture used basis 10 for every
   * row, which now (correctly) produces no price statistics at all — a constant
   * has no deciles.
   */
  const b = scoreFunding(series((i) => ((i * 11) % 37) - 18, () => 0), 480);
  const priced = b.filter((x) => !x.tied);
  ok("most buckets are priceable", priced.length >= 8, String(priced.length));
  ok("every priced bucket carries a standard error", priced.every((x) => Number.isFinite(x.seBps)));
  ok("a flat series has no edge to find",
    Math.abs(priced[priced.length - 1].meanCollectorBps ?? 1) < 1e-6,
    String(priced[priced.length - 1].meanCollectorBps));
}

/**
 * A basis that never moves is not a basis distribution.
 *
 * Every bucket is then the same value and every boundary is array order, so
 * there is nothing to report but the payment. Asserted because the previous
 * fixture did exactly this and its numbers looked fine.
 */
function aConstantBasisReportsOnlyTheCarry() {
  const b = scoreFunding(series(() => 10, () => 0), 480);
  ok("buckets are produced", b.length === 10, String(b.length));
  ok("all of them are tied", b.every((x) => x.tied === true));
  ok("no price term anywhere", b.every((x) => x.meanCollectorBps === null && x.meanTotalBps === null));
  ok("the payment is still reported", b.every((x) => x.meanCarryBps > 0));
}

console.log("funding carry");
carryScales();
crowdWrongIsProfitable();
aQuantisedBasisWithholdsItsPriceTerm();
crowdRightIsATrap();
errorTermsTravel();
aConstantBasisReportsOnlyTheCarry();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good");
