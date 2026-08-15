import { DEFAULT_FEES, canPostEntry, feeBudget, parseFeeTiers, ratesFor, roundTripCost } from "@/lib/sweep/metrics/fees";

let fails = 0;
const ok = (n: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "  ok " : "FAIL "} ${n}${d ? ` — ${d}` : ""}`); };

console.log("\n## the arithmetic that decides this");
const N = 4679;
const taker = roundTripCost(DEFAULT_FEES, N, { entry: "taker", exit: "taker" });
const mixed = roundTripCost(DEFAULT_FEES, N, { entry: "maker", exit: "taker" });
const maker = roundTripCost(DEFAULT_FEES, N, { entry: "maker", exit: "maker" });
console.log(`     taker/taker  ${taker.bps.toFixed(1)}bp  $${taker.totalUsd.toFixed(2)}  breakeven +${taker.breakevenPct.toFixed(3)}%`);
console.log(`     maker/taker  ${mixed.bps.toFixed(1)}bp  $${mixed.totalUsd.toFixed(2)}  breakeven +${mixed.breakevenPct.toFixed(3)}%`);
console.log(`     maker/maker  ${maker.bps.toFixed(1)}bp  $${maker.totalUsd.toFixed(2)}  breakeven +${maker.breakevenPct.toFixed(3)}%`);
ok("taker round trip is 10bp", Math.abs(taker.bps - 10) < 0.01);
ok("maker round trip is 4bp", Math.abs(maker.bps - 4) < 0.01);
ok("posting the entry saves 30% of the round trip", mixed.totalUsd < taker.totalUsd * 0.75);

const discounted = roundTripCost({ ...DEFAULT_FEES, discount: 0.9 }, N, { entry: "taker", exit: "taker" });
ok("BNB discount applies", Math.abs(discounted.bps - 9) < 0.01, `${discounted.bps.toFixed(2)}bp`);

console.log("\n## an escalating schedule");
const tiers = parseFeeTiers(JSON.stringify([
  { fromTradeCount: 10, makerRate: 0.0004, takerRate: 0.0008, note: "escalated tier" },
  { fromTradeCount: 20, makerRate: 0.0006, takerRate: 0.0012, note: "second escalation" },
]));
ok("tiers parse", tiers.tiers.length === 2 && tiers.error === null);
const sched = { ...DEFAULT_FEES, tiers: tiers.tiers };
ok("below the first tier, base rates apply", ratesFor(sched, 5).takerRate === 0.0005);
ok("at the first tier, rates escalate", ratesFor(sched, 12).takerRate === 0.0008);
ok("the highest applicable tier wins", ratesFor(sched, 25).takerRate === 0.0012);
const escalated = roundTripCost(sched, N, { entry: "taker", exit: "taker" }, 25);
ok("cost tracks the tier", Math.abs(escalated.bps - 24) < 0.01, `${escalated.bps.toFixed(1)}bp`);
ok("and the tier is named", escalated.tierNote === "second escalation");
ok("malformed tiers are dropped, not thrown", parseFeeTiers("{oops").error !== null);

console.log("\n## can the entry be posted");
ok("cold mark-out assumes crossing", !canPostEntry({ warm: false, toxicity: 0 }).ok);
ok("benign flow can be posted into", canPostEntry({ warm: true, toxicity: 0.3 }).ok);
ok("toxic flow cannot", !canPostEntry({ warm: true, toxicity: 0.8 }).ok);

console.log("\n## the day budget");
ok("a quiet day is fine", !feeBudget(DEFAULT_FEES, 10, 200).exhausted);
// The cap is 60% now, not 40%. At 40% it sat below what the sizer's own
// reward-over-fees floor produces — trades were admitted at a 50% fee share and
// then the day budget refused them, 1055 times against 1200 signals.
const farmed = feeBudget(DEFAULT_FEES, 140, 200);
ok("fees past 60% of gross stops further entries", farmed.exhausted, farmed.reason ?? "");
ok("share is reported", Math.abs((farmed.share ?? 0) - 0.7) < 0.001, String(farmed.share));
ok("a 45% share no longer does", !feeBudget(DEFAULT_FEES, 90, 200).exhausted);
ok("a losing day is left to the loss cap", !feeBudget(DEFAULT_FEES, 90, -50).exhausted);
ok("a hard ceiling bites", feeBudget({ ...DEFAULT_FEES, maxDailyFeeUsd: 100 }, 100, 5000).exhausted);
ok("zero disables the ceiling", !feeBudget({ ...DEFAULT_FEES, maxDailyFeeUsd: 0 }, 100000, 0).exhausted);

console.log("\n## what this means for a target 0.4% away");
for (const [label, rt] of [["taker/taker", taker], ["maker/taker", mixed], ["maker/maker", maker]] as const) {
  const reward = N * 0.004;
  console.log(`     ${label}: fees are ${((rt.totalUsd / reward) * 100).toFixed(0)}% of a $${reward.toFixed(2)} gross target`);
}


/* ---------------- the fee budget must not contradict the sizer ------------ */

console.log("\n## the day cap cannot refuse what the trade filter admits");
{
  const { feeBudget, DEFAULT_FEES } = require("@/lib/sweep/metrics/fees");
  // A day of trades taken at exactly the sizer's floor: each pays 1/rc of its
  // own gross in fees, so the day's share sits at that level by construction.
  const rc = 2;
  const gross = 1000;
  const fees = gross / rc;          // 50% — precisely what reward/cost 2 produces

  const unaware = feeBudget(DEFAULT_FEES, fees, gross);
  const aware = feeBudget(DEFAULT_FEES, fees, gross, rc);
  ok("told the sizer's floor, the day is not refused", !aware.exhausted,
    aware.reason ?? "allowed");
  ok("...because the cap is lifted above what a compliant trade produces",
    !aware.exhausted || (unaware.exhausted && !aware.exhausted));

  // It still bites when fees genuinely take almost everything.
  const farmed = feeBudget(DEFAULT_FEES, gross * 0.92, gross, rc);
  ok("a day that pays 92% of gross away is still refused", farmed.exhausted, farmed.reason ?? "allowed");
  ok("...naming the share", farmed.exhausted && (farmed.reason ?? "").includes("92%"), farmed.reason ?? "");
}

console.log("\n## one small trade cannot trip the day cap");
{
  const { feeBudget, DEFAULT_FEES } = require("@/lib/sweep/metrics/fees");
  // The realistic first trade: a few dollars of gross, a couple of fees. The
  // ratio is meaningless and used to refuse everything for the rest of the day.
  const tiny = feeBudget(DEFAULT_FEES, 4, 6, 2);
  ok("a $6 gross day does not exhaust the budget", !tiny.exhausted, tiny.reason ?? "allowed");

  const real = feeBudget(DEFAULT_FEES, 480, 500, 2);
  ok("...but a real day still can", real.exhausted, real.reason ?? "allowed");
}

console.log(fails === 0 ? "\nall passed\n" : `\n${fails} FAILED\n`);
process.exit(fails ? 1 : 0);
