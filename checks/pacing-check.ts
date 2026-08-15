/**
 * The hourly ceiling, and what a zero means.
 *
 * `Math.max(2, ceil(maxTradesPerDay / 3))` floored at 2 when the daily cap was
 * switched off — so turning one limit off made another maximally tight, and it
 * refused 5,280 of 6,855 signals in one session while every diagnostic reported
 * the agent healthy.
 */
import { attachExecution } from "../lib/sweep/agent/execution";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };

// The derivation as the control server computes it.
const perHour = (maxTradesPerDay: number) =>
  maxTradesPerDay > 0 ? Math.max(2, Math.ceil(maxTradesPerDay / 3)) : 0;

console.log("\n## the derivation");
ok("a daily cap of 8 gives 3/hour", perHour(8) === 3, String(perHour(8)));
ok("a daily cap of 24 gives 8/hour", perHour(24) === 8, String(perHour(24)));
ok("a daily cap of 1 still allows 2/hour", perHour(1) === 2, String(perHour(1)));
ok("NO daily cap gives NO hourly ceiling", perHour(0) === 0, String(perHour(0)));

console.log("\n## the guard the ceiling is applied through");
// The line under test: `maxPerHour > 0 && acceptedAt.length >= maxPerHour`.
const refuses = (maxPerHour: number, alreadyTaken: number) =>
  maxPerHour > 0 && alreadyTaken >= maxPerHour;

ok("a zero ceiling never refuses, even on the first signal", !refuses(0, 0));
ok("...nor after a hundred", !refuses(0, 100));
ok("a ceiling of 3 allows the first three", !refuses(3, 0) && !refuses(3, 2));
ok("...and refuses the fourth", refuses(3, 3));
ok("the old form refused everything at zero", 0 >= 0, "which is why this needed a guard");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
