/**
 * The size ladder is the only place the project converts basis points to dollars.
 *
 * Every earlier verdict rested on a scalar cost bar, which is the cost of an
 * order small enough not to exist. This module turns a measured depth curve
 * into "at $10,000 the edge is 5.6bp and earns $5.60 a round trip", and that
 * sentence is what an order gets sent on. The ways it can lie are specific and
 * each one is asserted here:
 *
 *  - charging impact once instead of twice, halving the cost of every trade
 *  - believing a median computed after the expensive minutes were dropped
 *  - reporting a demanding trade count where the honest answer is "never"
 *  - picking the largest paying size rather than the one that earns most
 */

import {
  sizeLadder,
  bestSize,
  ladderNet,
  loadImpact,
  type ImpactReport,
} from "/home/user/oddz/lib/sweep/backtest/impact";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ok — ${name}`);
};

/** A curve shaped like LITUSDT's: linear in size, cheap small, ruinous large. */
const curve = (): ImpactReport => ({
  symbol: "TESTUSDT",
  minutes: 43_200,
  bandsPct: [0.2, 1, 2, 3, 4, 5],
  sizes: [
    { usd: 1_000, medianBps: 0.18, p75Bps: 0.24, p90Bps: 0.31, offCurveShare: 0 },
    { usd: 10_000, medianBps: 1.79, p75Bps: 2.39, p90Bps: 3.08, offCurveShare: 0 },
    { usd: 50_000, medianBps: 8.93, p75Bps: 11.95, p90Bps: 15.4, offCurveShare: 0 },
  ],
});

function impactIsChargedBothWays() {
  console.log("\nimpact is a round trip, not a fill");
  const ladder = sizeLadder(curve(), 7.5);
  const ten = ladder.find((r) => r.usd === 10_000)!;
  /*
   * 1.79 one way is 3.58 there and back. Charging it once is the single most
   * expensive arithmetic error available here: it halves the cost of every
   * trade and moves the knee out by roughly a factor of two, which is exactly
   * the region where this contract's largest finding lives.
   */
  ok("impact is doubled", Math.abs((ten.impactBps as number) - 3.58) < 0.01, String(ten.impactBps));
  ok("the bar is fees plus spread plus impact", Math.abs((ten.totalBps as number) - 11.08) < 0.01, String(ten.totalBps));
  ok("the stress row uses p90", Math.abs((ten.stressImpactBps as number) - 6.16) < 0.01, String(ten.stressImpactBps));
  ok("and is worse than the median row", (ten.stressTotalBps as number) > (ten.totalBps as number));
}

function aDeletedMedianIsRefused() {
  console.log("\na median computed on the surviving minutes is refused");
  const r = curve();
  /*
   * The worker drops minutes where the order ran past the deepest published
   * band. Those are the thin minutes, so the median of what remains is a
   * statistic about the book on its good days — cheap for the one reason that
   * should make it untrustworthy. Past a tenth it is refused outright rather
   * than discounted, because there is no honest way to price minutes the
   * archive never published.
   */
  r.sizes.push({ usd: 100_000, medianBps: 2.0, p75Bps: 2.5, p90Bps: 3.0, offCurveShare: 0.42 });
  const ladder = sizeLadder(r, 7.5);
  const big = ladder.find((x) => x.usd === 100_000)!;
  ok("the row carries no cost", big.totalBps === null, String(big.totalBps));
  ok("and says why", /ran off the end/.test(big.refused ?? ""), big.refused);
  ok("a suspiciously cheap big row cannot be chosen", bestSize(ladder, 16.66)?.usd !== 100_000);

  const clean = sizeLadder(curve(), 7.5);
  ok("a fully-priced row is not refused", clean.every((x) => x.refused === undefined));
}

function theKneeIsTheEarner() {
  console.log("\nthe best size is the one that earns most, not the largest that pays");
  const ladder = sizeLadder(curve(), 7.5);
  const best = bestSize(ladder, 16.66);
  /*
   * At $1,000 the edge survives almost intact and earns $0.88. At $10,000 it
   * is cut to 5.58bp and earns $5.58. Both pay; only one is worth sending.
   * Choosing the largest paying size would pick $50,000, where the edge is
   * already negative, and choosing the highest net bps would pick $1,000 and
   * demand 341 round trips a day.
   */
  ok("the earner is chosen", best?.usd === 10_000, String(best?.usd));
  ok("dollars per trip are right", Math.abs((best?.netUsd ?? 0) - 5.58) < 0.05, String(best?.netUsd));
  ok("a bigger losing size is not chosen", best!.usd !== 50_000);
  ok(
    "the daily count follows from the dollars",
    Math.abs(best!.tradesPerDay - 300 / best!.netUsd) < 1e-9,
  );

  const stressed = bestSize(ladder, 16.66, 300, true);
  ok("the stress case is sized no larger", (stressed?.usd ?? 0) <= (best?.usd ?? 0), String(stressed?.usd));
}

function anEdgeThatDoesNotPayReturnsNothing() {
  console.log("\nan edge under the smallest priceable order is a verdict");
  const ladder = sizeLadder(curve(), 7.5);
  /*
   * Null rather than a token size. The failure this guards is the one the
   * scalar bar made easy: reporting that something "beats fees" when the
   * cheapest order the book can price already costs more than the edge.
   */
  ok("no size is returned", bestSize(ladder, 7.6) === null);
  const rows = ladderNet(ladder, 7.6);
  ok("every row is negative", rows.every((r) => (r.netBps ?? 0) <= 0));
  ok(
    "and the trade count is never, not merely large",
    rows.every((r) => !Number.isFinite(r.tradesPerDay)),
    JSON.stringify(rows.map((r) => r.tradesPerDay)),
  );
}

function aMissingReportIsNotAFailure() {
  console.log("\na contract with no measured depth still replays");
  const dir = mkdtempSync(join(tmpdir(), "sizing-"));
  ok("an absent file is null", loadImpact(join(dir, "nope.json")) === null);

  const half = join(dir, "half.json");
  writeFileSync(half, '{"symbol":"X","sizes":[');
  /*
   * The worker writes this from a runner that can be cancelled mid-write. A
   * parse error thrown here would take down a replay that does not need the
   * file at all — the sizing table is an enrichment, and losing it must not
   * cost the verdicts.
   */
  ok("a truncated file is null, not a throw", loadImpact(half) === null);

  const empty = join(dir, "empty.json");
  writeFileSync(empty, '{"symbol":"X","minutes":0,"bandsPct":[],"sizes":[]}');
  ok("an empty ladder is null", loadImpact(empty) === null);
}

console.log("size ladder");
impactIsChargedBothWays();
aDeletedMedianIsRefused();
theKneeIsTheEarner();
anEdgeThatDoesNotPayReturnsNothing();
aMissingReportIsNotAFailure();

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall good — size ladder");
