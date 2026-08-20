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
