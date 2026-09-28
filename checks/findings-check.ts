/**
 * The orientation page has to be right, because it is what a cold pass believes.
 *
 * Fourteen days of scheduled firings produced six journal entries, all of them
 * written by interactive sessions. A large part of that is orientation cost: a
 * pass with no memory reads a journal of thousands of words, re-reads a
 * snapshot, and re-derives conclusions already paid for. This file is the fix,
 * so a wrong claim in it is worse than no file at all — it would send a pass to
 * repeat work that is already settled, or to trust a signal already rejected.
 */
import { renderFindings, SETTLED, type RunSummary } from "../lib/sweep/backtest/findings";

let failures = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (!c) { failures++; console.error(`  FAIL ${n}${d ? ` — ${d}` : ""}`); }
  else console.log(`  ok — ${n}`);
};

function everySettledClaimCarriesItsEvidence() {
  ok("there are settled verdicts", SETTLED.length >= 5, String(SETTLED.length));
  for (const v of SETTLED) {
    ok(`${v.id} states a claim`, v.claim.length > 30);
    ok(`${v.id} states its evidence`, v.evidence.length > 60);
  }
  const rejected = SETTLED.filter((v) => v.status === "rejected");
  ok("the rejected ones carry a sample size so a later pass can argue with them",
    rejected.every((v) => typeof v.n === "number" && v.n > 0),
    JSON.stringify(rejected.filter((v) => !v.n).map((v) => v.id)));
}

function rendersWithoutARun() {
  /*
   * The state a cold pass will actually find when the replay failed — which has
   * happened for days at a stretch. It must say that plainly rather than
   * printing an empty section that reads like "nothing to report".
   */
  const out = renderFindings([]);
  ok("it renders with no runs at all", out.length > 500);
  ok("and calls an empty run a fault rather than a null result",
    /fault, not a null result/.test(out), out.slice(-400));
  ok("the settled work is present so it is not repeated", /sweep-direction/.test(out));
  ok("and the open work is present so there is something to do", /sub-minute/.test(out));
  ok("it forbids arming", /Do not arm trading/.test(out));
}

function separatesClearingTheBarFromBeatingFees() {
  /*
   * The distinction that decides everything. A feature can clear a Bonferroni
   * bar at huge sigma and still be worthless, because sigma measures confidence
   * that an effect exists and the round trip measures whether it is worth
   * taking. Every negative result in this project has had that shape.
   */
  const run: RunSummary = {
    symbol: "BTCUSDT", samples: 500_000, spanDays: 365, bonferroniSigma: 3.4, roundTripBps: 7,
    survivors: [
      { feature: "tiny", horizon: "t15", sigma: 12.0, spreadBps: 1.2 },
      { feature: "real", horizon: "t60", sigma: 4.1, spreadBps: 19.0 },
    ],
  };
  const out = renderFindings([run]);
  ok("it counts the ones that beat the round trip", /\*\*1 also beat the round trip\*\*/.test(out), out.slice(out.indexOf("cleared the bar") - 60, out.indexOf("cleared the bar") + 90));
  ok("and marks the one that does", /`real`.*beats fees/.test(out));
  ok("while not marking the one that does not", !/`tiny`.*beats fees/.test(out));

  const none: RunSummary = { ...run, survivors: [{ feature: "tiny", horizon: "t15", sigma: 12.0, spreadBps: 1.2 }] };
  ok("with none tradeable it says so explicitly",
    /none is tradeable as a directional signal/.test(renderFindings([none])));
}

/**
 * A tied bucket must not print a price number at all.
 *
 * The render is where a withheld statistic either stays withheld or gets quietly
 * formatted as something. Four buckets of pure calendar drift were read off a
 * page like this and reported as a carry finding.
 */
function aTiedCarryBucketPrintsNoPriceNumber() {
  const run: RunSummary = {
    symbol: "BTCUSDT", samples: 100, spanDays: 30, bonferroniSigma: 3.4, roundTripBps: 7, survivors: [],
    carry: [{ basisBps: 0, collectorBps: null, seBps: null, carryBps: 0, totalBps: null, tied: true }],
  };
  const out = renderFindings([run]);
  ok("the price term is named as withheld", /price term is withheld/.test(out), out.slice(-500));
  ok("and the reason is given", /slice of the calendar/.test(out), out.slice(-500));
  ok("no price figure is printed", !/price -?\d/.test(out.split("Carry at 8h")[1] ?? ""), out.slice(-500));
}

/**
 * The instruction list must not outlive what it instructs.
 *
 * Every item on the previous version was finished — write the tick replay,
 * measure why canPostEntry never allowed a maker fill, find the long bias — and
 * it regenerated unchanged for a week, directing passes at solved problems. A
 * generated file that regenerates a stale instruction is worse than a
 * hand-maintained one, because it looks current.
 *
 * So the finished items are asserted absent by name. If the search reopens, this
 * check is the thing that has to be edited deliberately, which is the point.
 */
function theInstructionsDoNotDirectSolvedWork() {
  const out = renderFindings([]);
  for (const done of [
    "Write the tick replay",
    "canPostEntry has never allowed a maker fill",
    "entry gate is 3.6:1 long-biased",
  ]) {
    ok(`no longer asks for: ${done}`, !out.includes(done));
  }
  ok("the search is declared finished", /search is finished/.test(out));
  ok("and the binding constraint is named", /constraint is capital, not edge/.test(out), out.slice(-900));
  ok(
    "a failed-but-green run is named as a thing to look for",
    /published nothing while reporting success/.test(out),
  );
  ok("arming is still refused", /Do not arm trading/.test(out));
}

function carryIsReportedWithItsCost() {
  const run: RunSummary = {
    symbol: "BTCUSDT", samples: 100, spanDays: 30, bonferroniSigma: 3.4, roundTripBps: 7, survivors: [],
    carry: [{ basisBps: -40, collectorBps: 3.2, seBps: 1.1, carryBps: 40, totalBps: 43.2 }],
  };
  const out = renderFindings([run]);
  ok(
    "the carry term leads, since it is the only mechanical part",
    /\*\*carry \+40\.00bp\*\*/.test(out),
    out.slice(-600),
  );
  ok("the price term is shown beside it", /price 3\.20bp ±1\.10/.test(out), out.slice(-600));
  ok("and the total is still there", /total 43\.20bp/.test(out), out.slice(-600));
  ok(
    "with the price term's requirement named",
    /needs a view or a hedge/.test(out),
    out.slice(-600),
  );

  const missing: RunSummary = { ...run, carry: undefined, carryNote: "no premium index data — missing data" };
  ok("and a missing premium index reads as missing data",
    /missing data/.test(renderFindings([missing])));
}

console.log("findings page");
everySettledClaimCarriesItsEvidence();
rendersWithoutARun();
separatesClearingTheBarFromBeatingFees();
carryIsReportedWithItsCost();
theInstructionsDoNotDirectSolvedWork();
aTiedCarryBucketPrintsNoPriceNumber();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good");
