/**
 * The extremes helpers must survive an array bigger than the argument limit.
 *
 * `Math.min(...xs)` works on every fixture anyone writes and throws once real
 * data accumulates. It took down the replay in the research loop: the price-span
 * check spread every close in the fetched window, so each pass refused with
 * "the replay refused; nothing was written" and FINDINGS quietly stopped
 * regenerating while the loop looked like it was running.
 */

import { maxOf, minOf } from "/home/user/oddz/lib/sweep/numeric";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

// Large enough to blow the spread on every engine this runs on.
const big = Array.from({ length: 500_000 }, (_, i) => (i === 271_828 ? -5 : i % 1000));

let threw = false;
try { minOf(big); maxOf(big); } catch { threw = true; }
ok("half a million elements does not throw", !threw);
ok("and the minimum is right", minOf(big) === -5, String(minOf(big)));
ok("and the maximum is right", maxOf(big) === 999, String(maxOf(big)));

// The spread it replaces genuinely fails, so this is not a hypothetical.
let spreadThrew = false;
try { Math.min(...big); } catch { spreadThrew = true; }
ok("the spread it replaces really does throw", spreadThrew);

ok("empty is null, not Infinity", minOf([]) === null && maxOf([]) === null,
  `${minOf([])} / ${maxOf([])}`);
/*
 * Infinity would satisfy most comparisons downstream, turning "there was no
 * data" into a bound that quietly passes every check — the same class of
 * mistake as an empty bucket rendering as 0.0000.
 */
ok("a null minimum is not usable as a number by accident",
  !Number.isFinite(minOf([]) as unknown as number));

ok("non-finite values are skipped", minOf([NaN, 3, Infinity, 1]) === 1, String(minOf([NaN, 3, Infinity, 1])));
ok("and an all-garbage array is null", minOf([NaN, Infinity, -Infinity]) === null);
ok("single element works", minOf([7]) === 7 && maxOf([7]) === 7);
ok("negatives work", minOf([-3, -9, -1]) === -9 && maxOf([-3, -9, -1]) === -1);

console.log("\nall good — numeric");
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
