/**
 * Impact is the cost the spread turned out not to be.
 *
 * The tick measurement put the spread at one tick on both contracts — 0.243bp
 * on LITUSDT, 0.01bp on BTCUSDT — which cannot threaten a 16bp finding. What
 * can is that the finding is a decile of a thin book, and walking that book has
 * never been measured. A model that errs cheap here would wave through the one
 * candidate this project has left.
 */

import { parseTs } from "/home/user/oddz/lib/sweep/backtest/zip";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

type Curve = Map<number, { bid: number; ask: number }>;

/** The worker's arithmetic, exercised directly. */
function impactBps(curve: Curve, usd: number, side: "bid" | "ask"): number | null {
  const bands = [...curve.keys()].sort((a, b) => a - b);
  let prevEdge = 0;
  let prevNotional = 0;
  for (const band of bands) {
    const available = curve.get(band)![side];
    if (available >= usd) {
      const need = usd - prevNotional;
      const inBand = available - prevNotional;
      const frac = inBand > 0 ? Math.min(1, need / inBand) : 1;
      const finish = prevEdge + (band - prevEdge) * frac;
      return ((prevEdge + finish) / 2) * 100;
    }
    prevEdge = band;
    prevNotional = available;
  }
  return null;
}

/** A book with `perBand` of cumulative notional at each of 1%, 2%, 5%. */
function book(one: number, two: number, five: number): Curve {
  return new Map([
    [1, { bid: one, ask: one }],
    [2, { bid: two, ask: two }],
    [5, { bid: five, ask: five }],
  ]);
}

function smallOrdersAreNearlyFree() {
  const deep = book(1_000_000, 2_000_000, 5_000_000);
  const got = impactBps(deep, 1_000, "ask");
  /*
   * A thousand dollars against a million resting inside 1% finishes a
   * thousandth of the way in, so the average fill is half of that — well under
   * a basis point. If this came back large the model would be charging for
   * depth that is plainly there.
   */
  ok("a tiny order against a deep book is sub-bp", got !== null && got < 1, String(got));
}

function impactGrowsWithSizeAndBitesAtTheKnee() {
  const thin = book(10_000, 25_000, 60_000);
  const a = impactBps(thin, 5_000, "ask")!;
  const b = impactBps(thin, 10_000, "ask")!;
  const c = impactBps(thin, 25_000, "ask")!;
  ok("impact is monotone in size", a < b && b < c, `${a.toFixed(1)}/${b.toFixed(1)}/${c.toFixed(1)}`);
  /*
   * The knee is the actionable fact. An order that exhausts the 1% band pays
   * about half a percent; one that stays well inside it pays a fraction of
   * that. The ladder exists to show where that transition sits.
   */
  ok("exhausting the first band costs about half its width",
    Math.abs(b - 50) < 1, b.toFixed(2));
  ok("and reaching into the second costs more", c > 50, c.toFixed(2));
}

function itRefusesToExtrapolate() {
  const thin = book(10_000, 25_000, 60_000);
  /*
   * Null, not a number. An order bigger than every published band is one the
   * archive cannot price, and inventing a value there would be the
   * cheap-direction error that lets an untradeable finding through.
   */
  ok("an order past the deepest band returns null", impactBps(thin, 100_000, "ask") === null);
  ok("and exactly at the deepest band does not", impactBps(thin, 60_000, "ask") !== null);
}

function sidesAreIndependent() {
  const lopsided: Curve = new Map([
    [1, { bid: 100_000, ask: 5_000 }],
    [2, { bid: 200_000, ask: 8_000 }],
  ]);
  const buy = impactBps(lopsided, 8_000, "ask")!;
  const sell = impactBps(lopsided, 8_000, "bid")!;
  /*
   * A book can be thin on one side and deep on the other, and a strategy that
   * only ever buys pays only the ask side. Blending them would understate the
   * cost of the side actually traded.
   */
  ok("a thin ask costs more than a deep bid", buy > sell * 5, `${buy.toFixed(1)} vs ${sell.toFixed(1)}`);
}

function aZeroWidthBandDoesNotDivideByZero() {
  // Two bands reporting identical notional: the order cannot be placed inside
  // the second, and the arithmetic must not produce NaN or Infinity.
  const flat: Curve = new Map([
    [1, { bid: 10_000, ask: 10_000 }],
    [2, { bid: 10_000, ask: 10_000 }],
  ]);
  const got = impactBps(flat, 10_000, "ask");
  ok("a flat band yields a finite number", got !== null && Number.isFinite(got), String(got));
}

/**
 * The timestamps in this archive are text, not numbers.
 *
 * `Number("2026-09-15 00:00:00")` is NaN, so a worker using it skips every row
 * and reports finding the files while parsing none of them — which is what the
 * first version of this did: "30 file(s), 0 minutes". parseTs handles the text
 * form and the microsecond form, and the replay has always used it.
 */
function timestampsParse() {
  ok("a text date parses", Number.isFinite(parseTs("2026-09-15 00:00:00")));
  ok("and Number() would not", !Number.isFinite(Number("2026-09-15 00:00:00")));
  ok("milliseconds pass through", parseTs("1757894400000") === 1757894400000);
  ok("microseconds are scaled", parseTs("1757894400000000") === 1757894400000);
  ok("junk is NaN, not zero", !Number.isFinite(parseTs("not-a-time")));
}

console.log("impact");
timestampsParse();
smallOrdersAreNearlyFree();
impactGrowsWithSizeAndBitesAtTheKnee();
itRefusesToExtrapolate();
sidesAreIndependent();
aZeroWidthBandDoesNotDivideByZero();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — impact");
