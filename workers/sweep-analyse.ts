/**
 * Reads the paper log and says which of the tool's readings actually predict
 * anything.
 *
 *   npm run sweep:analyse
 *   npm run sweep:analyse -- --in data/sweep-paper.jsonl --horizon 300
 *
 * Why this exists: nearly every threshold in this project is a prior. The
 * per-phase session weights, the 0.85 stretch percentile on funding, the 0.85
 * toxicity threshold, the weights on each bias factor — all chosen because they
 * were reasonable, none measured. The paper log was built to replace them and
 * has been accumulating columns for exactly that, but a JSONL file is not an
 * answer. This turns it into one.
 *
 * What it does NOT do, and the distinction is the whole point: it does not
 * backtest a strategy. There is no entry rule, no position, no P&L. It asks a
 * narrower and much harder-to-fool question — does knowing this number tell you
 * anything about where price goes next — and reports the answer with enough
 * context to see when the answer is noise.
 *
 * Three habits are built in because the alternative is fooling yourself:
 *
 *  1. **Every split reports its sample size and standard error.** A 12bp edge
 *     on 40 observations is nothing; the same edge on 4,000 is worth having.
 *     Any split too small to mean anything is labelled rather than shown as a
 *     result.
 *  2. **Overlapping windows are counted honestly.** Rows land every 15s and are
 *     scored at 60/300/900s, so consecutive rows share most of their forward
 *     window and are nowhere near independent. The effective sample size is
 *     deflated accordingly before any standard error is computed — without
 *     that, a 900s horizon looks about eight times more significant than it is.
 *  3. **Everything is measured in basis points against the fee floor.** A
 *     signal that predicts 3bp of movement is not tradeable at a 10bp round
 *     trip, however statistically clean it is, and a table that does not say so
 *     invites building on it anyway.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_FEES, roundTripCost } from "../lib/sweep/metrics/fees";

/* ------------------------------------------------------------------- input */

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const IN = resolve(arg("in", "data/sweep-paper.jsonl"));
const HORIZON = Number(arg("horizon", "300"));
/** Rows land this far apart; used to deflate for overlapping forward windows. */
const SAMPLE_SEC = Number(arg("sample-sec", "15"));
/** Below this many effective observations a split is not reported as a result. */
const MIN_EFFECTIVE = 30;

if (!existsSync(IN)) {
  console.error(`\n  No log at ${IN}\n`);
  console.error("  Run the sampler first, and leave it running:\n");
  console.error("      npm run sweep:paper\n");
  console.error("  It needs no credentials and places nothing. A day gives about 5,700 rows,");
  console.error("  which is roughly where the splits below start to mean something.\n");
  process.exit(1);
}

interface Row {
  t: number;
  iso: string;
  midAtSignal: number | null;
  health: string;
  session: string;
  intraday?: string;
  sessionTransitioning?: boolean;
  lwi: number | null;
  lwiAdj: number | null;
  warm: boolean | null;
  imbalance: number | null;
  spreadBps: number | null;
  riskUp: number | null;
  riskDown: number | null;
  flowCharacter?: string;
  biasDirection: string | null;
  biasConviction: number | null;
  markoutInformed?: number | null;
  markoutToxicity?: number | null;
  markoutWarm?: boolean;
  markout5sBps?: number | null;
  fundingRate?: number | null;
  fundingStretched?: boolean;
  fundingCrowded?: string | null;
  eventBlackout?: boolean;
  signals?: string[];
  outcomes: Record<string, { mid: number | null; pct: number | null }>;
}

const rows: Row[] = [];
let malformed = 0;
for (const line of readFileSync(IN, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line) as Row);
  } catch {
    malformed++;
  }
}

/** Only rows the horizon actually resolved for, on a feed that was healthy. */
const key = `t${HORIZON}`;
const scored = rows.filter((r) => {
  const o = r.outcomes?.[key];
  return o && typeof o.pct === "number" && Number.isFinite(o.pct) && r.health === "ok";
});

console.log(`\n  ${IN}`);
console.log(`  ${rows.length} rows, ${scored.length} scored at ${HORIZON}s on a healthy feed` +
  (malformed ? `, ${malformed} unreadable` : ""));

if (scored.length === 0) {
  console.log("\n  Nothing scored yet. Each row is only resolved once the horizon has elapsed,");
  console.log(`  so the first ${HORIZON}s of a run never resolves. Leave the sampler running.\n`);
  process.exit(0);
}

const firstAt = new Date(scored[0].t);
const lastAt = new Date(scored[scored.length - 1].t);
const spanH = (lastAt.getTime() - firstAt.getTime()) / 3_600_000;
console.log(`  covering ${spanH.toFixed(1)}h, ${firstAt.toISOString().slice(0, 16)} to ${lastAt.toISOString().slice(0, 16)}\n`);

/* --------------------------------------------------------------- statistics */

const bps = (r: Row): number => (r.outcomes[key].pct as number) * 100;

/**
 * How many of these observations are actually independent.
 *
 * Rows every SAMPLE_SEC seconds scored over a HORIZON-second forward window
 * overlap by (HORIZON / SAMPLE_SEC) rows. Treating them as independent inflates
 * every t-statistic by roughly the square root of that factor, which at 900s
 * and 15s sampling is a factor of about eight — more than enough to turn noise
 * into a publishable-looking result.
 */
const OVERLAP = Math.max(1, HORIZON / SAMPLE_SEC);

interface Stat {
  label: string;
  n: number;
  effectiveN: number;
  meanBps: number;
  stdErrBps: number;
  /** mean / stderr. Above about 2 is worth a second look, nothing more. */
  t: number;
  /** Share of observations where the move went the way the split implies. */
  hitRate: number | null;
}

function describe(label: string, values: number[], expectSign = 0): Stat {
  const n = values.length;
  if (n === 0) return { label, n: 0, effectiveN: 0, meanBps: 0, stdErrBps: 0, t: 0, hitRate: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const effectiveN = Math.max(1, n / OVERLAP);
  const stdErr = Math.sqrt(variance / effectiveN);
  const hitRate =
    expectSign === 0 ? null : values.filter((v) => Math.sign(v) === Math.sign(expectSign)).length / n;
  return {
    label,
    n,
    effectiveN,
    meanBps: mean,
    stdErrBps: stdErr,
    t: stdErr > 0 ? mean / stdErr : 0,
    hitRate,
  };
}

const FEE_FLOOR_BPS = roundTripCost(DEFAULT_FEES, 10_000, { entry: "maker", exit: "taker" }).bps;

/**
 * Two ways to judge a split, and using the wrong one is how a tool like this
 * ends up agreeing with whatever it is shown.
 *
 * `signed` tests the mean against zero. Correct when the quantity can be
 * negative and zero is the null — a directional call, where "no edge" really
 * does mean a mean of zero.
 *
 * `spread` tests each split against the pooled mean of the *other* splits.
 * Required whenever the quantity is an absolute move, because |x| has a
 * positive mean by construction: testing it against zero always succeeds and
 * says nothing. The question for those tables is never "is the move non-zero",
 * it is "is the move *different* in this bucket than elsewhere" — and an
 * earlier version of this file got that wrong and handed out four confident
 * verdicts on four identical buckets.
 */
type Mode = "signed" | "spread";

function table(title: string, stats: Stat[], note?: string, mode: Mode = "signed") {
  console.log(`  ${title}`);
  if (note) console.log(`    ${note}`);
  const usable = stats.filter((s) => s.n > 0);
  if (!usable.length) {
    console.log("    no observations\n");
    return;
  }

  // Pooled mean and its error across every split, for the `spread` comparison.
  const totalEff = usable.reduce((s, x) => s + x.effectiveN, 0);
  const pooledMean = usable.reduce((s, x) => s + x.meanBps * x.effectiveN, 0) / Math.max(1, totalEff);

  const col = mode === "spread" ? "vs rest" : "t";
  console.log(
    `    ${"split".padEnd(26)}${"n".padStart(7)}${"eff".padStart(7)}${"mean bp".padStart(10)}${"± se".padStart(9)}${col.padStart(8)}${"hit".padStart(7)}  verdict`,
  );

  for (const s of usable) {
    const thin = s.effectiveN < MIN_EFFECTIVE;

    let stat: number;
    let verdict: string;
    if (mode === "spread") {
      // Everything except this split, as one group.
      const others = usable.filter((x) => x !== s);
      const otherEff = others.reduce((a, x) => a + x.effectiveN, 0);
      const otherMean = otherEff > 0 ? others.reduce((a, x) => a + x.meanBps * x.effectiveN, 0) / otherEff : pooledMean;
      // Standard error of the difference: this split's, and the rest pooled.
      const otherSe = otherEff > 0
        ? Math.sqrt(others.reduce((a, x) => a + (x.stdErrBps * x.effectiveN) ** 2, 0)) / otherEff
        : 0;
      const diff = s.meanBps - otherMean;
      const se = Math.sqrt(s.stdErrBps ** 2 + otherSe ** 2);
      stat = se > 0 ? diff / se : 0;
      verdict = thin
        ? "too few to say"
        : Math.abs(stat) < 2
          ? "no different from the rest"
          : Math.abs(diff) < FEE_FLOOR_BPS
            ? `separates, but by less than the ${FEE_FLOOR_BPS.toFixed(0)}bp fee floor`
            : `separates by ${diff > 0 ? "+" : ""}${diff.toFixed(1)}bp — worth a look`;
    } else {
      stat = s.t;
      verdict = thin
        ? "too few to say"
        : Math.abs(stat) < 2
          ? "indistinguishable from noise"
          : Math.abs(s.meanBps) < FEE_FLOOR_BPS
            ? `real but below the ${FEE_FLOOR_BPS.toFixed(0)}bp fee floor`
            : "worth a look";
    }

    console.log(
      `    ${s.label.padEnd(26)}${String(s.n).padStart(7)}${s.effectiveN.toFixed(0).padStart(7)}` +
        `${s.meanBps.toFixed(2).padStart(10)}${s.stdErrBps.toFixed(2).padStart(9)}` +
        `${stat.toFixed(2).padStart(8)}${(s.hitRate === null ? "—" : `${(s.hitRate * 100).toFixed(0)}%`).padStart(7)}  ${verdict}`,
    );
  }
  console.log("");
}

/* -------------------------------------------------------------- the splits */

console.log(`  Forward move over ${HORIZON}s, in basis points. Fee floor for reference: ` +
  `${FEE_FLOOR_BPS.toFixed(1)}bp round trip (maker in, taker out).\n`);

// 1. The directional bias — does calling a side beat not calling one?
{
  const up = scored.filter((r) => r.biasDirection === "up");
  const down = scored.filter((r) => r.biasDirection === "down");
  const none = scored.filter((r) => !r.biasDirection);
  table("Directional bias", [
    describe("called up", up.map(bps), 1),
    describe("called down", down.map(bps), -1),
    describe("no call", none.map(bps)),
    describe("signed (up − down)", [...up.map(bps), ...down.map((r) => -bps(r))], 1),
  ], "The last line is the one that matters: the move in the direction called, pooled.");
}

// 2. Conviction — does more of it mean more move?
{
  const called = scored.filter((r) => r.biasDirection && r.biasConviction !== null);
  const signed = (r: Row) => (r.biasDirection === "down" ? -bps(r) : bps(r));
  const bands: [string, (c: number) => boolean][] = [
    ["conviction < 0.2", (c) => c < 0.2],
    ["conviction 0.2–0.4", (c) => c >= 0.2 && c < 0.4],
    ["conviction 0.4–0.6", (c) => c >= 0.4 && c < 0.6],
    ["conviction ≥ 0.6", (c) => c >= 0.6],
  ];
  table(
    "Conviction",
    bands.map(([label, f]) =>
      describe(label, called.filter((r) => f(r.biasConviction as number)).map(signed), 1),
    ),
    "If conviction means anything, mean bp should rise down this column.",
  );
}

// 3. Mark-out — the input with a claim to predicting rather than describing.
{
  const warm = scored.filter((r) => r.markoutWarm && typeof r.markoutInformed === "number");
  const inf = (r: Row) => r.markoutInformed as number;
  table(
    "Mark-out: informed side",
    [
      describe("informed < −0.4", warm.filter((r) => inf(r) < -0.4).map((r) => -bps(r)), 1),
      describe("informed −0.4 to 0.4", warm.filter((r) => Math.abs(inf(r)) <= 0.4).map(bps)),
      describe("informed > 0.4", warm.filter((r) => inf(r) > 0.4).map(bps), 1),
    ],
    "First and last rows are signed toward the informed side, so both should be positive if it works.",
  );

  const tox = (r: Row) => r.markoutToxicity as number;
  const withTox = scored.filter((r) => r.markoutWarm && typeof r.markoutToxicity === "number");
  table(
    "Mark-out: toxicity (absolute move, not direction)",
    [
      describe("toxicity < 0.4", withTox.filter((r) => tox(r) < 0.4).map((r) => Math.abs(bps(r)))),
      describe("toxicity 0.4–0.7", withTox.filter((r) => tox(r) >= 0.4 && tox(r) < 0.7).map((r) => Math.abs(bps(r)))),
      describe("toxicity 0.7–0.85", withTox.filter((r) => tox(r) >= 0.7 && tox(r) < 0.85).map((r) => Math.abs(bps(r)))),
      describe("toxicity ≥ 0.85", withTox.filter((r) => tox(r) >= 0.85).map((r) => Math.abs(bps(r)))),
    ],
    "Toxicity claims to predict movement, not direction. The 0.85 threshold in the code is a guess — this says where it should be.",
    "spread",
  );
}

// 4. Cascade risk.
{
  const bands: [string, (r: Row) => boolean][] = [
    ["risk < 30", (r) => Math.max(r.riskUp ?? 0, r.riskDown ?? 0) < 30],
    ["risk 30–50", (r) => { const m = Math.max(r.riskUp ?? 0, r.riskDown ?? 0); return m >= 30 && m < 50; }],
    ["risk 50–70", (r) => { const m = Math.max(r.riskUp ?? 0, r.riskDown ?? 0); return m >= 50 && m < 70; }],
    ["risk ≥ 70", (r) => Math.max(r.riskUp ?? 0, r.riskDown ?? 0) >= 70],
  ];
  table(
    "Cascade risk (absolute move)",
    bands.map(([label, f]) => describe(label, scored.filter(f).map((r) => Math.abs(bps(r))))),
    "The score claims a sweep is more likely, which should show up as a bigger move either way.",
    "spread",
  );
}

// 5. Depth thinness, raw against session-corrected. This is a direct test of
//    whether the session correction was worth adding.
{
  const withBoth = scored.filter((r) => r.warm && typeof r.lwi === "number" && typeof r.lwiAdj === "number");
  table(
    "Depth index (absolute move)",
    [
      describe("raw lwi < 0.7", withBoth.filter((r) => (r.lwi as number) < 0.7).map((r) => Math.abs(bps(r)))),
      describe("raw lwi ≥ 0.7", withBoth.filter((r) => (r.lwi as number) >= 0.7).map((r) => Math.abs(bps(r)))),
      describe("adjusted lwi < 0.7", withBoth.filter((r) => (r.lwiAdj as number) < 0.7).map((r) => Math.abs(bps(r)))),
      describe("adjusted lwi ≥ 0.7", withBoth.filter((r) => (r.lwiAdj as number) >= 0.7).map((r) => Math.abs(bps(r)))),
    ],
    "If the session correction earns its place, the adjusted split separates the two rows more cleanly than the raw one.",
    "spread",
  );
}

// 6. Session phase. These are the priors the weights table is built on.
{
  const phases = [...new Set(scored.map((r) => r.intraday ?? r.session))];
  table(
    "By session phase (absolute move)",
    phases.map((p) => describe(p, scored.filter((r) => (r.intraday ?? r.session) === p).map((r) => Math.abs(bps(r))))),
    "Realised movement per phase. The volScale column in metrics/session.ts should be proportional to this.",
    "spread",
  );
}

// 7. Funding.
{
  const withF = scored.filter((r) => typeof r.fundingRate === "number");
  table(
    "Funding",
    [
      describe("stretched, longs crowded", withF.filter((r) => r.fundingStretched && r.fundingCrowded === "longs").map((r) => -bps(r)), 1),
      describe("stretched, shorts crowded", withF.filter((r) => r.fundingStretched && r.fundingCrowded === "shorts").map(bps), 1),
      describe("not stretched", withF.filter((r) => !r.fundingStretched).map(bps)),
    ],
    "The first two are signed against the crowd, which is the contrarian claim in metrics/funding.ts. Positive means the claim holds.",
  );
}

// 8. Flow character — mechanical against human.
{
  const chars = [...new Set(scored.map((r) => r.flowCharacter ?? "unclear"))];
  table(
    "Flow character (absolute move)",
    chars.map((c) => describe(c, scored.filter((r) => (r.flowCharacter ?? "unclear") === c).map((r) => Math.abs(bps(r))))),
    undefined,
    "spread",
  );
}

// 9. Signals against the baseline. The narrow question the log was first built for.
{
  const fired = scored.filter((r) => (r.signals?.length ?? 0) > 0);
  const kinds = [...new Set(fired.flatMap((r) => r.signals ?? []))];
  table(
    "When a signal fired (absolute move)",
    [
      describe("no signal", scored.filter((r) => !(r.signals?.length ?? 0)).map((r) => Math.abs(bps(r)))),
      ...kinds.map((k) => describe(k, fired.filter((r) => r.signals?.includes(k)).map((r) => Math.abs(bps(r))))),
    ],
    "A signal that does not beat the no-signal row is not a signal.",
    "spread",
  );
}

/* ---------------------------------------------------------------- closing */

const enough = scored.length / OVERLAP;
console.log("  ─────");
if (enough < 200) {
  console.log(`  About ${enough.toFixed(0)} effectively independent observations so far. That is not`);
  console.log("  enough to change any parameter on. Keep the sampler running — a few days of");
  console.log("  continuous recording is roughly where these tables start to be worth acting on.");
} else {
  console.log(`  About ${enough.toFixed(0)} effectively independent observations. Splits marked "worth a look"`);
  console.log("  are candidates for replacing the corresponding prior in the code. Splits below the");
  console.log("  fee floor are real findings that still cannot be traded at this cost base.");
}
console.log("");
console.log("  Caveat that does not go away with more data: every split above was chosen after");
console.log("  seeing the data exist. Testing nine tables means one of them looking significant");
console.log("  at t≈2 is expected by chance. Treat a single striking row as a hypothesis to");
console.log("  check on fresh rows, not as a result.\n");
