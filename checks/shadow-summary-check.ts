/**
 * The shadow summary has to survive a live file and answer the depth question.
 *
 * It runs inside the snapshot writer, so anything it throws on takes down the
 * state file that explains why — including on a half-written last line, which is
 * the normal condition of a file being appended to.
 */

import { summariseShadow, type ShadowRowLike } from "../lib/sweep/agent/shadow-summary";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok — ${name}`);
  }
};

function row(lwiAdj: number | null, pct: number | null, over: Partial<ShadowRowLike> = {}): ShadowRowLike {
  return {
    at: 1, side: "long", signalKind: "cluster-approach",
    entryPrice: 64_000, notionalUsd: 10_000, feeUsd: 7.6, spreadBps: 0.02,
    resolved: "open",
    outcomes: { t900: { pct, netUsd: pct === null ? null : (pct / 100) * 10_000 - 7.6 } },
    conditions: { lwiAdj, targetDistPct: 1 },
    ...over,
  };
}

function separatesDepthBands() {
  /*
   * A synthetic edge: thin books move +0.20%, thick books move -0.05%. If the
   * summary cannot recover a difference this large it cannot recover a real one.
   */
  const rows = [
    ...Array.from({ length: 30 }, () => row(0.6, 0.2)),
    ...Array.from({ length: 30 }, () => row(1.1, -0.05)),
  ];
  const s = summariseShadow(rows);

  const veryThin = s.byEntryDepth.find((b) => b.label.startsWith("very thin"))!;
  const thick = s.byEntryDepth.find((b) => b.label.startsWith("at or above"))!;
  ok("the very thin band is found", veryThin.n === 30, String(veryThin.n));
  ok("the at-baseline band is found", thick.n === 30, String(thick.n));
  ok("and they are separated", veryThin.meanPct > thick.meanPct, `${veryThin.meanPct} vs ${thick.meanPct}`);
  ok("with an error term to judge it by", Number.isFinite(veryThin.sePct), String(veryThin.sePct));

  /*
   * Costs are the point, not a footnote: +0.20% on $10,000 is $20 gross against
   * a $7.60 round trip, so the net is what decides whether the edge is real.
   */
  ok("net is after fees", Math.abs(veryThin.netUsd - 30 * (20 - 7.6)) < 0.01, String(veryThin.netUsd));
  ok("and gross is reported separately", s.grossUsd > 0 && s.feesUsd > 0, `${s.grossUsd} / ${s.feesUsd}`);
}

function toleratesRealFiles() {
  const messy: ShadowRowLike[] = [
    row(0.6, 0.2),
    // Not yet scored — the normal state of a trade still inside its window.
    row(0.6, null),
    // No conditions captured, which older rows do not have.
    row(null, 0.1, { conditions: null }),
    // A row whose outcomes object is missing entirely.
    { ...row(0.7, 0.1), outcomes: {} as ShadowRowLike["outcomes"] },
  ];
  let threw = false;
  let s: ReturnType<typeof summariseShadow> | null = null;
  try { s = summariseShadow(messy); } catch { threw = true; }
  ok("a messy file does not throw", !threw);
  ok("unscored rows are excluded from the means", s !== null && s.overall.t900.n === 2, String(s?.overall.t900.n));
  ok("but still counted in the row total", s !== null && s.rows === 4, String(s?.rows));

  const empty = summariseShadow([]);
  ok("an empty file is not an error", empty.rows === 0);
  ok("and yields no depth buckets rather than four zeros", empty.byEntryDepth.length === 0);
  ok("and says so in words", /missing data/.test(empty.note ?? ""), empty.note ?? "(none)");
}

/*
 * The failure that hid for two days.
 *
 * `conditions` was declared on the shadow row type from the start, with a
 * comment saying the conditional analysis could not read a row without it — and
 * no producer ever assigned it. 2,052 rows were written with the field absent,
 * so every depth bucket reported n=0 and a mean of 0.0000. That reads as "no
 * effect", which is a finding, when it meant "no data", which is a defect. It
 * was reported as the former in two consecutive status updates.
 */
function missingConditionsIsNotANullResult() {
  const blind = Array.from({ length: 200 }, () => row(null, 0.2, { conditions: null }));
  const s = summariseShadow(blind);
  ok("rows still count", s.rows === 200);
  ok("the horizon summary still works", s.overall.t900.n === 200);
  ok("no depth bucket is invented", s.byEntryDepth.length === 0, JSON.stringify(s.byEntryDepth));
  ok("the count of usable rows is reported", s.withConditions === 0, String(s.withConditions));
  ok("and the absence is named", /missing data and not a null result/.test(s.note ?? ""), s.note ?? "(none)");

  // With readings present the breakdown comes back, and the counter is honest.
  const seeing = [
    ...Array.from({ length: 60 }, () => row(0.6, 0.2)),
    ...Array.from({ length: 40 }, () => row(null, 0.1, { conditions: null })),
  ];
  const t = summariseShadow(seeing);
  ok("partial coverage is counted, not rounded", t.withConditions === 60, String(t.withConditions));
  ok("and the buckets return", t.byEntryDepth.length === 4);
}

function reportsWhereTradesEnd() {
  const s = summariseShadow([
    row(0.6, 0.2, { resolved: "target" }),
    row(0.6, -0.5, { resolved: "stop" }),
    row(0.6, 0.0, { resolved: "stop" }),
  ]);
  ok("stop and target counts are kept", s.resolved.stop === 2 && s.resolved.target === 1, JSON.stringify(s.resolved));
}

console.log("shadow summary");
separatesDepthBands();
toleratesRealFiles();
missingConditionsIsNotANullResult();
reportsWhereTradesEnd();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");

/* -------------------------------------------- comparing like with like */

/**
 * A longer horizon can only be carried by an older trade.
 *
 * `overall` scores each horizon over whatever rows have it, so the two-hour
 * bucket is built from a strictly older sample than the fifteen-minute one —
 * different trades, different market. Holding two hours appeared to turn
 * −$6,338 into +$670, and most of that gap could have been the subsets rather
 * than the holding. Reading it as a finding would have been the fourth time in
 * this project that a sampling artefact was mistaken for an edge.
 */
function matchedComparesTheSameTrades() {
  /*
   * Twenty rows reach both horizons and lose at each; eighty reach only the
   * short one and win there. `overall` will therefore say the short horizon is
   * excellent, while the matched view — the same twenty rows — says it is not.
   */
  const both = Array.from({ length: 20 }, () => ({
    ...row(0.6, -0.5),
    outcomes: {
      t900: { pct: -0.5, netUsd: -50 },
      t7200: { pct: -0.2, netUsd: -20 },
    } as ShadowRowLike["outcomes"],
  }));
  const shortOnly = Array.from({ length: 80 }, () => ({
    ...row(0.6, 1.0),
    outcomes: { t900: { pct: 1.0, netUsd: 100 } } as ShadowRowLike["outcomes"],
  }));
  const s = summariseShadow([...both, ...shortOnly], "t900");

  ok("overall t900 is dominated by the rows that only reached it",
    s.overall.t900.n === 100 && s.overall.t900.netUsd > 0, JSON.stringify(s.overall.t900));
  ok("the matched set is only the rows that reached the longest horizon",
    s.matched.n === 20, String(s.matched.n));
  ok("and it names that horizon", s.matched.horizon === "t7200", s.matched.horizon);
  ok("the same trades lose at the short horizon too",
    s.matched.byHorizon.t900.netUsd === -1000, String(s.matched.byHorizon.t900.netUsd));
  ok("and the long horizon is compared against them, not against others",
    s.matched.byHorizon.t7200.netUsd === -400, String(s.matched.byHorizon.t7200.netUsd));
  ok("so the apparent improvement survives as a real one",
    s.matched.byHorizon.t7200.netUsd > s.matched.byHorizon.t900.netUsd);
}

matchedComparesTheSameTrades();
if (failures) {
  console.error(`\n${failures} failure(s) in the matched comparison`);
  process.exit(1);
}

/* ------------------------------------------------- beta, or an edge */

/**
 * A monotonic gain with holding time can be drift rather than skill.
 *
 * Two hours of holding accumulates two hours of whatever the market did. A
 * long-biased strategy in a rising sample therefore shows an edge that grows
 * with the horizon and is entirely beta. The split by side is what separates
 * them: if longs and shorts are both positive the drift explanation is dead,
 * and if only one side carries it then n does not matter, because the sample
 * size of the market period is one.
 */
function sideSplitSeparatesBetaFromEdge() {
  const long = (pct: number) => ({ ...row(0.6, pct), side: "long" as const,
    outcomes: { t7200: { pct, netUsd: pct * 100 } } as ShadowRowLike["outcomes"] });
  const short = (pct: number) => ({ ...row(0.6, pct), side: "short" as const,
    outcomes: { t7200: { pct, netUsd: pct * 100 } } as ShadowRowLike["outcomes"] });

  // Pure drift: longs win exactly as much as shorts lose.
  const drift = summariseShadow([
    ...Array.from({ length: 100 }, () => long(1.0)),
    ...Array.from({ length: 100 }, () => short(-1.0)),
  ], "t7200");
  ok("drift shows up as one side positive and the other negative",
    drift.matched.bySide.long.meanPct > 0 && drift.matched.bySide.short.meanPct < 0,
    JSON.stringify({ l: drift.matched.bySide.long.meanPct, s: drift.matched.bySide.short.meanPct }));

  // A real edge: both sides make money.
  const edge = summariseShadow([
    ...Array.from({ length: 100 }, () => long(0.5)),
    ...Array.from({ length: 100 }, () => short(0.5)),
  ], "t7200");
  ok("an edge shows up as both sides positive",
    edge.matched.bySide.long.meanPct > 0 && edge.matched.bySide.short.meanPct > 0,
    JSON.stringify({ l: edge.matched.bySide.long.meanPct, s: edge.matched.bySide.short.meanPct }));
  ok("and both carry an error term so the difference can be judged",
    Number.isFinite(edge.matched.bySide.long.sePct) && Number.isFinite(edge.matched.bySide.short.sePct));
  ok("the split is taken at the longest horizon", edge.matched.horizon === "t7200");
}

sideSplitSeparatesBetaFromEdge();
if (failures) {
  console.error(`\n${failures} failure(s) in the side split`);
  process.exit(1);
}

/* ------------------------------ the depth effect, or the side effect again */

/**
 * The confound that has already explained away two results.
 *
 * The two-hour "edge" was drift: 3:1 long book, rising sample, longs collected
 * what shorts paid, equal-weighted zero. The depth breakdown is exposed to the
 * identical confound — if thin-book entries skew toward one side, then "thin
 * does worse" is only "that side did worse" relabelled, and reading it as a
 * finding would be the third time the same artefact was promoted.
 *
 * The contrast is therefore computed inside each side. Both sides shared the
 * same calendar, so an effect present in both cannot be the calendar.
 */
function depthContrastSurvivesTheSideConfound() {
  const at = (side: "long" | "short", lwi: number, pct: number) => ({
    ...row(lwi, pct),
    side,
    outcomes: { t60: { pct, netUsd: pct * 100 } } as ShadowRowLike["outcomes"],
  });

  /*
   * Pure confound. Depth carries no information at all: inside longs, thin and
   * thick both return +1.0; inside shorts, both return -1.0. The only reason
   * thin looks bad pooled is that thin rows are mostly shorts.
   */
  const confounded = summariseShadow([
    ...Array.from({ length: 20 }, () => at("long", 0.6, 1.0)),
    ...Array.from({ length: 180 }, () => at("short", 0.6, -1.0)),
    ...Array.from({ length: 180 }, () => at("long", 1.2, 1.0)),
    ...Array.from({ length: 20 }, () => at("short", 1.2, -1.0)),
  ], "t60");
  const c = confounded.depthContrast.byHorizon.t60;
  ok("pooled, the confound looks like a large depth effect",
    c.both.deltaPct < -1.0, String(c.both.deltaPct));
  ok("inside longs it vanishes", Math.abs(c.long.deltaPct) < 1e-9, String(c.long.deltaPct));
  ok("inside shorts it vanishes", Math.abs(c.short.deltaPct) < 1e-9, String(c.short.deltaPct));
  ok("and the within-side sigma says nothing rather than something",
    Math.abs(c.long.sigma) < 1e-6 && Math.abs(c.short.sigma) < 1e-6,
    JSON.stringify({ l: c.long.sigma, s: c.short.sigma }));

  /*
   * A real inverted signal: inside BOTH sides, thin books do worse. This is the
   * shape the live data hints at, and the one that would matter — a signal
   * pointing the wrong way is fixable by taking the other side, where an absent
   * signal is not fixable at all.
   */
  const real = summariseShadow([
    ...Array.from({ length: 100 }, (_, i) => at("long", 0.6, -0.5 + (i % 5) * 0.01)),
    ...Array.from({ length: 100 }, (_, i) => at("short", 0.6, -0.5 + (i % 5) * 0.01)),
    ...Array.from({ length: 100 }, (_, i) => at("long", 1.2, 0.5 + (i % 5) * 0.01)),
    ...Array.from({ length: 100 }, (_, i) => at("short", 1.2, 0.5 + (i % 5) * 0.01)),
  ], "t60");
  const r = real.depthContrast.byHorizon.t60;
  ok("a real inverted effect survives inside longs", r.long.deltaPct < -0.9 && r.long.sigma < -10,
    JSON.stringify({ d: r.long.deltaPct, sigma: r.long.sigma }));
  ok("and inside shorts", r.short.deltaPct < -0.9 && r.short.sigma < -10,
    JSON.stringify({ d: r.short.deltaPct, sigma: r.short.sigma }));
  ok("the counts behind each end are carried", r.long.nThin === 100 && r.long.nThick === 100,
    JSON.stringify({ thin: r.long.nThin, thick: r.long.nThick }));

  /*
   * The sign convention is the finding. The thesis says thin predicts a
   * favourable move, so it predicts a POSITIVE delta; the test has to be able
   * to tell "backwards" from "absent" rather than reporting both as "not
   * significant".
   */
  const asThesisClaims = summariseShadow([
    ...Array.from({ length: 100 }, (_, i) => at("long", 0.6, 0.5 + (i % 5) * 0.01)),
    ...Array.from({ length: 100 }, (_, i) => at("long", 1.2, -0.5 + (i % 5) * 0.01)),
  ], "t60");
  ok("a signal pointing the way the thesis claims comes back positive",
    asThesisClaims.depthContrast.byHorizon.t60.long.deltaPct > 0.9,
    String(asThesisClaims.depthContrast.byHorizon.t60.long.deltaPct));
}

/**
 * The contrast has to exist at the short horizons, not only the primary one.
 *
 * At sixty seconds the overall mean is indistinguishable from zero, so there is
 * no drift there to mistake for a signal. That makes t60 the cleanest test in
 * the set rather than the weakest, and it is only available if every horizon is
 * crossed rather than just the one the summary leads with.
 */
function contrastCoversEveryHorizon() {
  const s = summariseShadow([
    { ...row(0.6, -0.5), outcomes: { t60: { pct: -0.5, netUsd: -50 }, t7200: { pct: -0.5, netUsd: -50 } } as ShadowRowLike["outcomes"] },
    { ...row(1.2, 0.5), outcomes: { t60: { pct: 0.5, netUsd: 50 }, t7200: { pct: 0.5, netUsd: 50 } } as ShadowRowLike["outcomes"] },
  ], "t900");
  ok("every horizon present in the file gets a contrast",
    Object.keys(s.depthContrast.byHorizon).sort().join(",") === "t60,t7200",
    Object.keys(s.depthContrast.byHorizon).join(","));
  ok("each carries all three splits",
    Object.keys(s.depthContrast.byHorizon.t60).sort().join(",") === "both,long,short",
    Object.keys(s.depthContrast.byHorizon.t60).join(","));
  ok("the band edges are reported with the numbers they produced",
    s.depthContrast.thinBelow === 0.85 && s.depthContrast.thickAtOrAbove === 1,
    JSON.stringify(s.depthContrast));

  /*
   * An unmeasurable end must report a sigma of zero, not NaN and not Infinity.
   * `bucket` returns an infinite standard error for n<=1, and Infinity/Infinity
   * is NaN — which serialises to null, renders as blank, and reads as "no
   * result" in exactly the place a reader is looking for one.
   */
  const oneSided = summariseShadow(
    Array.from({ length: 30 }, () => row(0.6, 0.2)),
    "t900",
  );
  const b = oneSided.depthContrast.byHorizon.t900.both;
  ok("a contrast with no thick end is not NaN", Number.isFinite(b.sigma), String(b.sigma));
  ok("and it claims nothing", b.sigma === 0, String(b.sigma));
  ok("while still reporting the counts", b.nThin === 30 && b.nThick === 0,
    JSON.stringify({ thin: b.nThin, thick: b.nThick }));
}

depthContrastSurvivesTheSideConfound();
contrastCoversEveryHorizon();
if (failures) {
  console.error(`\n${failures} failure(s) in the depth contrast`);
  process.exit(1);
}
console.log("\nall good — depth contrast");
