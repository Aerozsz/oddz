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

function carryIsReportedWithItsCost() {
  const run: RunSummary = {
    symbol: "BTCUSDT", samples: 100, spanDays: 30, bonferroniSigma: 3.4, roundTripBps: 7, survivors: [],
    carry: [{ basisBps: -40, collectorBps: 3.2, seBps: 1.1, carryBps: 40, totalBps: 43.2 }],
  };
  const out = renderFindings([run]);
  ok("carry shows price, payment and total apart", /carry \+40\.00bp, \*\*total 43\.20bp\*\*/.test(out), out);

  const missing: RunSummary = { ...run, carry: undefined, carryNote: "no premium index data — missing data" };
  ok("and a missing premium index reads as missing data",
    /missing data/.test(renderFindings([missing])));
}

console.log("findings page");
everySettledClaimCarriesItsEvidence();
rendersWithoutARun();
separatesClearingTheBarFromBeatingFees();
carryIsReportedWithItsCost();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good");
