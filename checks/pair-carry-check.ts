/**
 * The perpetual-against-perpetual spread is the only structure left that this
 * account could place, so the ways it could look better than it is are each
 * asserted here:
 *
 *  - reporting a leg's funding rate instead of the differential, which is the
 *    same error as quoting a decile spread as a per-trade return
 *  - taking the mean of a differential that flips sign, which pays a held spread
 *    nothing however wide the average looks
 *  - getting the orientation from symbol order rather than from the data, so the
 *    sign means different things in different rows
 *  - pairing two series whose settlements never line up and calling the empty
 *    intersection a result
 *  - claiming the hedge cancels the price term without measuring what it leaves
 */

import { existsSync, statSync } from "node:fs";

import { pairUp, residual } from "/home/user/oddz/workers/sweep-pair-carry";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

const H = 3_600_000;
/** A funding series: `n` settlements eight hours apart, in bps. */
const series = (n: number, rate: (i: number) => number, start = Date.UTC(2026, 6, 1)) => {
  const m = new Map<number, number>();
  for (let i = 0; i < n; i++) m.set(start + i * 8 * H, rate(i));
  return m;
};

function theDifferentialIsWhatIsCollected() {
  console.log("\nthe differential is reported, not either leg's rate");
  /*
   * Both legs pay longs 10bp and 6bp. A spread collects the 4bp gap, not the
   * 10bp headline — and reporting the headline is how a trade that needs two
   * million dollars gets presented as needing eight hundred thousand.
   */
  const a = { symbol: "XUSDT", rates: series(200, () => 10) };
  const b = { symbol: "XUSDC", rates: series(200, () => 6) };
  const p = pairUp("X", a, b, 1);
  ok("a pair is produced", p !== null);
  ok("the differential is the gap", Math.abs((p?.meanDiffBps ?? 0) - 4) < 1e-9, String(p?.meanDiffBps));
  ok("not either leg", (p?.meanDiffBps ?? 0) < 6, String(p?.meanDiffBps));
  ok("daily is three settlements", Math.abs((p?.dailyBps ?? 0) - 12) < 1e-9, String(p?.dailyBps));
  ok(
    "capital follows the differential",
    Math.abs((p?.notionalForTargetUsd ?? 0) - 300 / 0.0012) < 1,
    String(p?.notionalForTargetUsd),
  );
}

function theSideComesFromTheData() {
  console.log("\nthe orientation is taken from the rates, not the argument order");
  const hi = { symbol: "AUSDT", rates: series(200, () => 12) };
  const lo = { symbol: "AUSDC", rates: series(200, () => 3) };
  /*
   * Whichever way round the pair is passed, the answer must be the same trade and
   * the reported differential must be positive. A sign that depends on argument
   * order means the column means different things in different rows, which is
   * how a table gets averaged into nonsense.
   */
  const one = pairUp("A", hi, lo, 1);
  const two = pairUp("A", lo, hi, 1);
  ok("both orderings give the same differential", Math.abs((one?.meanDiffBps ?? 0) - (two?.meanDiffBps ?? -1)) < 1e-9);
  ok("and it is positive", (one?.meanDiffBps ?? -1) > 0 && (two?.meanDiffBps ?? -1) > 0);
  ok("both name the same short leg", one?.short === two?.short, `${one?.short} vs ${two?.short}`);
  ok("both name the same long leg", one?.long === two?.long, `${one?.long} vs ${two?.long}`);
  /*
   * Longs pay when the rate is positive, so the leg charging 12 is the one to be
   * short: the short collects it. This is the link between the sign of the rate
   * and the side of the trade, and it is the easiest thing here to invert.
   */
  ok("the short is the leg paying more", one?.short === "AUSDT", String(one?.short));
}

function aFlippingDifferentialIsNotACarry() {
  console.log("\na differential that flips is not a carry");
  /*
   * Mean +1bp, but it is +11 and -9 alternating. A held spread collects the mean
   * only if the sign persists; this one is a coin flip that happens to be biased,
   * and one-sidedness is the column that says so.
   */
  const a = { symbol: "BUSDT", rates: series(200, (i) => (i % 2 === 0 ? 11 : -9)) };
  const b = { symbol: "BUSDC", rates: series(200, () => 0) };
  const p = pairUp("B", a, b, 1);
  ok("the mean is still reported", Math.abs((p?.meanDiffBps ?? 0) - 1) < 1e-9, String(p?.meanDiffBps));
  ok("but one-sidedness exposes it", (p?.oneSidedShare ?? 1) <= 0.55, String(p?.oneSidedShare));

  const steady = pairUp(
    "C",
    { symbol: "CUSDT", rates: series(200, () => 1) },
    { symbol: "CUSDC", rates: series(200, () => 0) },
    1,
  );
  ok("a steady one reads as one-sided", (steady?.oneSidedShare ?? 0) > 0.99, String(steady?.oneSidedShare));
  ok("on the same mean", Math.abs((steady?.meanDiffBps ?? 0) - 1) < 1e-9, String(steady?.meanDiffBps));
}

function unalignedSettlementsAreRefused() {
  console.log("\ntwo series that never line up are refused");
  const a = { symbol: "DUSDT", rates: series(200, () => 5, Date.UTC(2026, 6, 1)) };
  /* Four hours offset: settlements interleave and never coincide. */
  const b = { symbol: "DUSDC", rates: series(200, () => 1, Date.UTC(2026, 6, 1) + 4 * H) };
  ok("no pair is produced", pairUp("D", a, b, 1) === null);

  /*
   * But a couple of seconds of jitter must still pair. Settlements land within a
   * second or two of the hour and the two contracts are not stamped identically,
   * so an exact-timestamp join finds nothing and every pair reads as having no
   * shared history.
   */
  const jittered = {
    symbol: "DUSD1",
    rates: (() => {
      const m = new Map<number, number>();
      for (let i = 0; i < 200; i++) m.set(Date.UTC(2026, 6, 1) + i * 8 * H + 1_400, 1);
      return m;
    })(),
  };
  const hourly = new Map<number, number>();
  for (const [ts, v] of jittered.rates) hourly.set(Math.round(ts / H) * H, v);
  ok(
    "a second of jitter still pairs once rounded",
    pairUp("D", a, { symbol: "DUSD1", rates: hourly }, 1) !== null,
  );
}

function theResidualIsMeasured() {
  console.log("\nwhat the hedge leaves behind is measured, not assumed");
  const mk = (drift: (i: number) => number) => {
    const m = new Map<number, number>();
    for (let i = 0; i < 20_000; i++) m.set(i * 60_000, 100 * (1 + drift(i)));
    return m;
  };
  /*
   * Two contracts tracking identically: the ratio never moves, so the hedge is
   * perfect and the residual is zero. Anything above zero here would mean the
   * measurement is picking up the common move rather than the difference.
   */
  const same = residual(mk((i) => Math.sin(i / 500) / 50), mk((i) => Math.sin(i / 500) / 50));
  ok("identical series leave no residual", same !== null && Math.abs(same) < 1e-6, String(same));

  /*
   * One drifts against the other. The ratio then moves, and that movement is the
   * risk the spread is actually carrying.
   */
  const apart = residual(mk((i) => Math.sin(i / 500) / 50), mk((i) => Math.sin(i / 500) / 50 + i / 2_000_000));
  ok("a diverging pair leaves one", apart !== null && apart > 0, String(apart));
  ok("and it travels into the pair", (pairUp("E",
    { symbol: "EUSDT", rates: series(200, () => 4) },
    { symbol: "EUSDC", rates: series(200, () => 1) },
    apart,
  )?.residualSdBps ?? null) === apart);

  const p = pairUp("E",
    { symbol: "EUSDT", rates: series(200, () => 4) },
    { symbol: "EUSDC", rates: series(200, () => 1) },
    6,
  );
  ok(
    "carry over risk is the differential against the residual",
    Math.abs((p?.carryOverRisk ?? 0) - 3 / 6) < 1e-9,
    String(p?.carryOverRisk),
  );
  /*
   * Null rather than a large number when the residual is unknown, so a pair whose
   * price history could not be read cannot rank first by default.
   */
  const unknown = pairUp("F",
    { symbol: "FUSDT", rates: series(200, () => 4) },
    { symbol: "FUSDC", rates: series(200, () => 1) },
    null,
  );
  ok("an unknown residual gives no ratio", unknown?.carryOverRisk === null);
  ok("a short price history gives no residual", residual(mk(() => 0), new Map()) === null);
}

/**
 * Importing the worker must not run the worker.
 *
 * The first run of this file printed "952 symbols · 41 underlyings" and wrote an
 * empty report to evidence/: `void main()` at module scope means importing
 * `pairUp` to test it also starts a live survey and overwrites the artefact. Same
 * defect as the hardcoded FINDINGS path, one day apart — a module doing work as a
 * side effect of being read.
 */
function importingDoesNotRunIt() {
  console.log("\nimporting the worker does not run it");
  /*
   * If main() had run, this process would have made hundreds of network requests
   * before reaching here, and evidence/pair-carry.json would have been rewritten.
   * The observable proof available inside the process is that no report was
   * written for a run nobody asked for.
   */
  const report = "/home/user/oddz/evidence/pair-carry.json";
  const before = existsSync(report) ? statSync(report).mtimeMs : null;
  ok(
    "no report was written by the import",
    before === null || Date.now() - before > 5_000,
    before === null ? "absent" : `modified ${((Date.now() - before) / 1000).toFixed(1)}s ago`,
  );
}

console.log("perp-against-perp carry");
importingDoesNotRunIt();
theDifferentialIsWhatIsCollected();
theSideComesFromTheData();
aFlippingDifferentialIsNotACarry();
unalignedSettlementsAreRefused();
theResidualIsMeasured();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — perp-against-perp carry");
