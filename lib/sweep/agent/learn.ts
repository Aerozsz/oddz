import type { EntryConditions, TradeRecord } from "./postmortem";
import { evidenceFor } from "./evidence";

/**
 * What the losses have in common, measured rather than modelled.
 *
 * The request this answers was for a loop that "learns the patterns". The
 * honest version of that at this sample size is not a model — it is arithmetic
 * with the error bars left on, and a refusal to state a finding the counts do
 * not support. Two things make that refusal necessary rather than fussy.
 *
 * The first is multiplicity. There are twenty-odd fields on every entry. Split
 * each at its median and test both halves and you have run forty comparisons;
 * at the conventional threshold, two of them come back "significant" on pure
 * noise, every time, guaranteed by the arithmetic and not by the market. A
 * learning loop that acts on those is not learning, it is laundering noise into
 * parameters — and it will do it confidently, repeatedly, and with a plausible
 * story attached each time. So the interval width here widens with the number
 * of fields examined, and a split whose arms overlap is printed as undecided
 * instead of quietly rounded to a conclusion.
 *
 * The second is that the interesting question is answerable without any of
 * that. `Why did this lose` has four possible answers that are visible in one
 * trade each, because they are descriptions rather than inferences: it never
 * worked, it worked and was given back, it was stopped mid-move, or it was cut
 * by the hold engine. Those need opposite fixes — the first is an entry
 * problem, the second an exit problem, the third a geometry problem, the fourth
 * a patience problem — and the closing price alone cannot tell them apart while
 * MAE and MFE can. That section is trustworthy at n=5. The conditional section
 * is not trustworthy until n is much larger, and says so on its face.
 *
 * Nothing here changes a parameter. Every output is a recommendation addressed
 * to a human, because the failure mode of an auto-tuner on forty trades is that
 * it fits the last week and then trades the next one on it.
 */

/* --------------------------------------------------------------- statistics */

/**
 * Wilson score interval for a proportion.
 *
 * Not the textbook normal interval, which at these counts produces bounds
 * outside [0,1] and an interval of exactly zero width when a small sample
 * happens to be all wins — the two cases most likely to arise here and the two
 * most likely to be believed.
 */
export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

export interface MeanCi {
  mean: number;
  lo: number;
  hi: number;
  n: number;
  /** Standard error, kept so two arms can be compared properly rather than by eye. */
  se: number;
}

/** Mean with a normal interval on the standard error. Undefined below n=2. */
export function meanCi(values: number[], z = 1.96): MeanCi {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n, se: Infinity };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, lo: -Infinity, hi: Infinity, n, se: Infinity };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { mean, lo: mean - z * se, hi: mean + z * se, n, se };
}

/**
 * How many standard errors apart two means are.
 *
 * The comparison that belongs here, in place of the tempting one. Reading two
 * confidence intervals and checking whether they overlap is the intuitive test
 * and it is not the right one — it is roughly √2 stricter than testing the
 * difference, because it charges the full width of both intervals against a
 * difference whose own uncertainty is the two standard errors added in
 * quadrature. Stack that on top of a Bonferroni correction and the result is a
 * test that reports a 6%-versus-65% win rate as undecided, which is not caution,
 * it is a broken instrument.
 */
export function separation(a: MeanCi, b: MeanCi): number {
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  if (!Number.isFinite(se) || se <= 0) return 0;
  return Math.abs(a.mean - b.mean) / se;
}

/**
 * The z that keeps the family-wide error rate at 5% across `tests` comparisons.
 *
 * Bonferroni, which is conservative, and conservative is the correct direction
 * to err when the cost of a false finding is a parameter change applied to real
 * money. Approximated by inverting the normal tail rather than pulling in a
 * dependency for it; accurate to about a percent over the range that matters.
 */
export function familyZ(tests: number): number {
  const alpha = 0.05 / Math.max(1, tests);
  // Acklam's rational approximation to the inverse normal CDF, upper tail.
  const p = 1 - alpha / 2;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* ------------------------------------------------------------ derived views */

/**
 * The result in multiples of the risk that was taken.
 *
 * Dollars are not comparable across trades here: the sizer varies notional by a
 * factor of ten with conditions, so a $300 winner on a small position and a
 * $300 winner on a large one are different events being counted as the same
 * one. R divides that out, which is the only way a mean over mixed sizes means
 * anything.
 */
export function rMultiple(t: TradeRecord): number | null {
  if (t.realisedPnlUsd === null) return null;
  if (t.stopPrice !== null && t.entryPrice > 0 && t.notionalUsd > 0) {
    const riskUsd = (Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice) * t.notionalUsd;
    if (riskUsd > 0) return t.realisedPnlUsd / riskUsd;
  }
  return null;
}

/** How far the stop sat from entry, in percent. */
function stopDistPct(t: TradeRecord): number | null {
  if (t.stopPrice === null || !(t.entryPrice > 0)) return null;
  return (Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice) * 100;
}

export type LossKind = "never-worked" | "gave-it-back" | "stopped-mid-move" | "cut-on-time" | "unclassified";

export interface LossClass {
  kind: LossKind;
  /** One line naming what went wrong, in the trade's own numbers. */
  detail: string;
}

/**
 * Which of the four failures this was.
 *
 * Descriptive, not inferential — every branch reads two numbers off one trade.
 * That is what makes this section usable at a sample size where the conditional
 * section below is still guessing.
 */
export function classifyLoss(t: TradeRecord): LossClass {
  const stop = stopDistPct(t);
  const timeExit = /expired|has not started|held \d|min left|thesis/i.test(t.exitReason);

  if (t.peakProgress >= 0.6) {
    return {
      kind: "gave-it-back",
      detail:
        `reached ${(t.peakProgress * 100).toFixed(0)}% of the way to target (+${t.mfePct.toFixed(3)}%) ` +
        `and closed at ${t.roiPct !== null ? `${t.roiPct.toFixed(1)}% ROI` : "a loss"}`,
    };
  }

  // Below here every branch reads a *small* excursion as meaningful, which a
  // partial window cannot support: an unwatched stretch looks identical to a
  // motionless one. The branch above is safe on a partial window because a
  // large MFE that was observed did happen.
  if (!t.excursionComplete) {
    return { kind: "unclassified", detail: `${t.exitReason} — the process restarted while this was open, so its excursion is incomplete` };
  }

  // Never moved even a fifth of the distance it was allowed to move against.
  // A setup whose mechanism is supposed to act in seconds and that never got
  // going was misread at entry, whatever happened afterwards.
  if (stop !== null && t.mfePct < stop * 0.2) {
    return {
      kind: "never-worked",
      detail: `best it ever got was +${t.mfePct.toFixed(3)}% against a ${stop.toFixed(2)}% stop — it never started`,
    };
  }

  if (timeExit) {
    return {
      kind: "cut-on-time",
      detail: `closed by the hold engine at ${(t.peakProgress * 100).toFixed(0)}% progress — ${t.exitReason}`,
    };
  }

  if (stop !== null && Math.abs(t.maePct) >= stop * 0.9) {
    return {
      kind: "stopped-mid-move",
      detail:
        `went +${t.mfePct.toFixed(3)}% then ${t.maePct.toFixed(3)}% into a ${stop.toFixed(2)}% stop — ` +
        `the stop is inside this trade's own noise`,
    };
  }

  return { kind: "unclassified", detail: `${t.exitReason} at ${(t.peakProgress * 100).toFixed(0)}% progress` };
}

export interface Anatomy {
  kind: LossKind;
  count: number;
  share: number;
  costUsd: number;
  /** What this class of failure is fixed by. Not applied automatically. */
  prescription: string;
  examples: string[];
}

const PRESCRIPTIONS: Record<LossKind, string> = {
  "never-worked":
    "an entry problem. These trades were wrong the moment they were placed, so no exit rule reaches " +
    "them — the filter that let them through is what has to change. Look at the conditions table below " +
    "for what they share.",
  "gave-it-back":
    "an exit problem, and the cheapest one to fix. The position was right and the profit was not taken. " +
    "Lower the break-even ratchet threshold so a trade this far along can no longer end as a full loss.",
  "stopped-mid-move":
    "a geometry problem. The stop sits inside the range the price covers on the way to the target, so " +
    "the trade is being asked to move without breathing. Widen the stop and cut the size by the same " +
    "factor — the risk per trade is unchanged and the trade gets room.",
  "cut-on-time":
    "a patience problem, and the one to be most careful with. The hold engine closed these before the " +
    "stop or target did. If they were near their target it is cutting winners; if they were flat it is " +
    "doing its job and the entries are the problem.",
  unclassified: "no clean story from MAE and MFE — read the individual records.",
};

export function lossAnatomy(trades: TradeRecord[]): Anatomy[] {
  const losses = trades.filter((t) => t.outcome === "loss");
  const groups = new Map<LossKind, { count: number; cost: number; examples: string[] }>();
  for (const t of losses) {
    const c = classifyLoss(t);
    const g = groups.get(c.kind) ?? { count: 0, cost: 0, examples: [] };
    g.count++;
    g.cost += Math.abs(t.realisedPnlUsd ?? 0);
    if (g.examples.length < 3) g.examples.push(`${t.symbol} ${t.side} — ${c.detail}`);
    groups.set(c.kind, g);
  }
  return [...groups.entries()]
    .map(([kind, g]) => ({
      kind,
      count: g.count,
      share: losses.length > 0 ? g.count / losses.length : 0,
      costUsd: g.cost,
      prescription: PRESCRIPTIONS[kind],
      examples: g.examples,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/* -------------------------------------------------- conditions vs. outcomes */

/** Every numeric field an entry can be grouped by, with a readable name. */
const NUMERIC_FIELDS: { key: keyof EntryConditions; label: string; unit?: string }[] = [
  { key: "lwiAdj", label: "depth ahead of the trade", unit: "x" },
  { key: "lwiOtherAdj", label: "depth behind the trade", unit: "x" },
  { key: "spreadBps", label: "spread", unit: "bp" },
  { key: "cancelShare", label: "share of depth that left by cancelling" },
  { key: "cascadeRisk", label: "cascade risk" },
  { key: "seedNotional", label: "cascade seed", unit: "$" },
  { key: "targetDistPct", label: "distance to target", unit: "%" },
  { key: "adverseDistPct", label: "distance to the cluster the other way", unit: "%" },
  { key: "markoutInformed", label: "informed-flow mark-out" },
  { key: "markoutToxicity", label: "toxicity" },
  { key: "volatilityPct", label: "volatility", unit: "%" },
  { key: "fundingRate", label: "funding rate" },
  { key: "minutesToFunding", label: "minutes to funding" },
  { key: "utcHour", label: "hour of day (UTC)" },
  { key: "biasConviction", label: "bias conviction" },
  { key: "sizeRetained", label: "size retained after derates" },

  // Who was standing in the book, by conduct. These are the fields the strategy
  // is actually a bet on, so they lead the ranking when they separate anything.
  { key: "replenishSec", label: "seconds for depth to be replaced", unit: "s" },
  { key: "refillLevels", label: "levels refilled repeatedly (iceberg)" },
  { key: "flickerPerSec", label: "quote churn per second" },
  { key: "sliceUniformity", label: "how alike the trade sizes are" },
  { key: "mechanical", label: "how computed the flow looks" },

  // Who was crossing the spread.
  { key: "sweepShare", label: "share of aggression that walked the book" },
  { key: "largestBurstUsd", label: "largest single instant order", unit: "$" },
  { key: "largestBurstLevels", label: "levels the largest order ate" },
  { key: "aggressorImbalance", label: "aggression pushing the trade's way" },
  { key: "takerIntensity", label: "aggressive notional per second", unit: "$" },
  { key: "aggressorConcentration", label: "aggression concentrated in few orders" },
];

const CATEGORICAL_FIELDS: { key: keyof EntryConditions; label: string }[] = [
  // First deliberately: of everything recorded, this is the grouping most
  // likely to carry a real difference, because it is the one the entry rule is
  // implicitly conditioning on already.
  { key: "participantRegime", label: "what the book was doing" },
  { key: "session", label: "session" },
  { key: "signalKind", label: "signal kind" },
  { key: "cashOpen", label: "cash market open" },
  { key: "markoutWarm", label: "mark-out warm" },
];

export interface Arm {
  label: string;
  n: number;
  wins: number;
  winRate: number;
  winLo: number;
  winHi: number;
  /** Mean result in R, with the family-corrected interval. */
  r: MeanCi;
  pnlUsd: number;
}

export interface Split {
  field: string;
  label: string;
  arms: Arm[];
  /** Difference in mean R between the best and worst arm. */
  spreadR: number;
  /** How many standard errors separate the best arm from the worst. */
  sigma: number;
  /** True when that separation survives the correction for every field tested. */
  decisive: boolean;
  note: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function buildArm(label: string, rows: TradeRecord[], z: number): Arm {
  const wins = rows.filter((t) => t.outcome === "win").length;
  const [winLo, winHi] = wilson(wins, rows.length, z);
  const rs = rows.map(rMultiple).filter((x): x is number => x !== null);
  return {
    label,
    n: rows.length,
    wins,
    winRate: rows.length > 0 ? wins / rows.length : 0,
    winLo,
    winHi,
    r: meanCi(rs, z),
    pnlUsd: rows.reduce((a, t) => a + (t.realisedPnlUsd ?? 0), 0),
  };
}

/**
 * Split the trades by every condition and report which splits separate them.
 *
 * `minPerArm` is the honesty dial. Below it a split is dropped entirely rather
 * than shown with a caveat, because a two-trade arm shown next to a twenty-
 * trade arm gets read as a comparison no matter what the caveat says.
 */
export function splits(trades: TradeRecord[], minPerArm = 5): Split[] {
  const tests = NUMERIC_FIELDS.length + CATEGORICAL_FIELDS.length;
  const z = familyZ(tests);
  const out: Split[] = [];

  for (const f of NUMERIC_FIELDS) {
    const usable = trades.filter((t) => typeof t.entryConditions[f.key] === "number");
    if (usable.length < minPerArm * 2) continue;
    const values = usable.map((t) => t.entryConditions[f.key] as number);
    const cut = median(values);
    const low = usable.filter((t) => (t.entryConditions[f.key] as number) <= cut);
    const high = usable.filter((t) => (t.entryConditions[f.key] as number) > cut);
    if (low.length < minPerArm || high.length < minPerArm) continue;
    const unit = f.unit === "$" ? "" : (f.unit ?? "");
    const fmt = (v: number) => (f.unit === "$" ? `$${Math.round(v).toLocaleString()}` : `${v.toFixed(2)}${unit}`);
    out.push(
      finish(f.key as string, f.label, [
        buildArm(`≤ ${fmt(cut)}`, low, z),
        buildArm(`> ${fmt(cut)}`, high, z),
      ]),
    );
  }

  for (const f of CATEGORICAL_FIELDS) {
    const byValue = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const v = t.entryConditions[f.key];
      if (v === null || v === undefined) continue;
      const key = String(v);
      byValue.set(key, [...(byValue.get(key) ?? []), t]);
    }
    const arms = [...byValue.entries()].filter(([, rows]) => rows.length >= minPerArm);
    if (arms.length < 2) continue;
    out.push(finish(f.key as string, f.label, arms.map(([k, rows]) => buildArm(k, rows, z))));
  }

  return out.sort((a, b) => b.spreadR - a.spreadR);
}

function finish(field: string, label: string, arms: Arm[]): Split {
  const tests = NUMERIC_FIELDS.length + CATEGORICAL_FIELDS.length;
  const threshold = familyZ(tests);
  const withR = arms.filter((a) => a.r.n >= 2);
  const best = withR.reduce<Arm | null>((acc, a) => (!acc || a.r.mean > acc.r.mean ? a : acc), null);
  const worst = withR.reduce<Arm | null>((acc, a) => (!acc || a.r.mean < acc.r.mean ? a : acc), null);
  const spreadR = best && worst ? best.r.mean - worst.r.mean : 0;
  const sigma = best && worst && best !== worst ? separation(best.r, worst.r) : 0;
  /*
   * The difference itself has to clear the corrected threshold.
   *
   * Bonferroni over every field examined, so a finding here has already been
   * charged for the fact that thirty-odd of these were run. That is the whole
   * correction and it is enough — the earlier version also demanded that the
   * two arms' own intervals not overlap, which sounds like extra rigour and is
   * really the same correction applied twice, at a cost of never reporting
   * anything.
   */
  const decisive = sigma > threshold;
  const n = arms.reduce((a, x) => a + x.n, 0);
  const note =
    !best || !worst || best === worst
      ? "not enough trades on both sides to compare"
      : decisive
        ? `${best.label} returns ${spreadR.toFixed(2)}R more per trade than ${worst.label} — ` +
          `${sigma.toFixed(1)} standard errors apart, which clears the bar even after correcting for the ` +
          `${tests} conditions examined. This one is worth acting on.`
        : `${best.label} looks ${spreadR.toFixed(2)}R better than ${worst.label}, but at ${sigma.toFixed(1)} ` +
          `standard errors over ${n} trades that is inside what ${tests} comparisons throw up by chance. ` +
          `Watch it, do not act on it.`;
  return { field, label, arms, spreadR, sigma, decisive, note };
}

/* -------------------------------------------------------------- the report */

export interface Report {
  n: number;
  wins: number;
  winRate: number;
  winLo: number;
  winHi: number;
  expectancyR: MeanCi;
  netUsd: number;
  anatomy: Anatomy[];
  splits: Split[];
  /** Splits the counts actually support, if any. */
  actionable: Split[];
  /** Conclusions the operator should not draw from this, stated up front. */
  caveats: string[];
  lines: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

export function analyse(trades: TradeRecord[], minPerArm = 5): Report {
  /*
   * Each section reads only the evidence entitled to answer it.
   *
   * Filtered here rather than at the call sites because forgetting is silent:
   * an expectancy that quietly included shadow rows would not throw, it would
   * simply be optimistic, and the first symptom would be sizing up into an edge
   * that had never been collected. See evidence.ts for the rule.
   */
  const priced = evidenceFor(trades, "expectancy");
  const observed = evidenceFor(trades, "entry-quality");

  const n = priced.length;
  const wins = priced.filter((t) => t.outcome === "win").length;
  const [winLo, winHi] = wilson(wins, n);
  const rs = priced.map(rMultiple).filter((x): x is number => x !== null);
  const expectancyR = meanCi(rs);
  const netUsd = priced.reduce((a, t) => a + (t.realisedPnlUsd ?? 0), 0);
  // Anatomy and splits read the wider pool: both are derived from price.
  const anatomy = lossAnatomy(evidenceFor(trades, "loss-anatomy"));
  const all = splits(observed, minPerArm);
  const actionable = all.filter((s) => s.decisive);

  const caveats: string[] = [];
  const shadowCount = trades.length - priced.length;
  if (shadowCount > 0) {
    caveats.push(
      `${shadowCount} of ${trades.length} records are shadow trades — real decisions on a real book whose ` +
        `fill was modelled rather than observed. They count toward the loss anatomy and the conditions table, ` +
        `which are questions about what price did. They are excluded from the win rate, the expectancy and ` +
        `the net figure, which are questions about what our orders did.`,
    );
  }
  /*
   * Measured against the number of comparisons actually run, not a fixed count.
   *
   * "Thirty trades is enough" is the wrong shape of rule: thirty trades split
   * across one condition is a thin but real comparison, and the same thirty
   * split across twenty conditions is one and a half trades per test. The
   * sample that matters is per comparison, so the threshold has to move with
   * how many were made.
   */
  if (n < 30 || n < all.length * 5) {
    const ratio = all.length > 0 ? ` — ${all.length} conditions compared, ${(n / all.length).toFixed(1)} trades each` : "";
    caveats.push(
      actionable.length > 0
        ? `${n} trades is thin for ${all.length} comparisons${ratio}. The findings marked actionable have ` +
          `already been charged for that — the bar they cleared is the corrected one — but everything ` +
          `unmarked should be read as a thing to watch and nothing more.`
        : `${n} trades is too few for any conditional finding${ratio}. The loss anatomy is descriptive and ` +
          `holds at this size; the conditions table is shown so it can be watched, not acted on.`,
    );
  }
  if (actionable.length > 1) {
    caveats.push(
      `${actionable.length} conditions came back actionable, and they are unlikely to be ${actionable.length} ` +
        `separate discoveries. Depth that is slow to return, a book classed as withdrawing, and large orders ` +
        `walking it are three views of one market state, so they rise and fall together — treat them as one ` +
        `finding described three ways rather than three reasons to change three settings.`,
    );
  }
  caveats.push(
    "Participants are grouped by conduct, not identity. Replenishment speed, repeated refills at one " +
      "price, slice uniformity and the size of the orders that walked the book are all recorded and " +
      "compared here — what is not claimed is that two similar-looking bursts came from the same desk. " +
      "These are orders, not senders.",
  );
  if (trades.some((t) => t.news.length > 0)) {
    caveats.push(
      "Headlines are recorded next to each trade as context and are never used as a cause. Establishing " +
        "that news moved a price needs far more events than this log will ever hold.",
    );
  }
  if (actionable.length === 0 && all.length > 0) {
    caveats.push(
      `${all.length} conditions had enough trades on both sides to compare and none of them separated ` +
        `winners from losers by more than the noise. That is a result, not a failure — it means the ` +
        `losses are not concentrated in one readable condition, and the anatomy above is where the ` +
        `money is.`,
    );
  }

  const lines: string[] = [];
  lines.push(`${n} closed trades — ${wins} won (${pct(wins / Math.max(1, n))}, ${pct(winLo)}–${pct(winHi)} at 95%)`);
  if (expectancyR.n >= 2) {
    lines.push(
      `expectancy ${expectancyR.mean >= 0 ? "+" : ""}${expectancyR.mean.toFixed(2)}R per trade ` +
        `(${expectancyR.lo.toFixed(2)} to ${expectancyR.hi.toFixed(2)}) · net ${usd(netUsd)}`,
    );
    if (expectancyR.lo < 0 && expectancyR.hi > 0) {
      lines.push(
        `the interval spans zero, so this sample cannot yet tell a profitable strategy from a flat one`,
      );
    }
  }

  for (const a of anatomy) {
    lines.push(`${a.count} × ${a.kind} (${pct(a.share)} of losses, ${usd(-a.costUsd)}) — ${a.prescription}`);
  }
  for (const s of actionable) lines.push(`${s.label}: ${s.note}`);

  return { n, wins, winRate: n > 0 ? wins / n : 0, winLo, winHi, expectancyR, netUsd, anatomy, splits: all, actionable, caveats, lines };
}

/* ---------------------------------------------------------- recommendations */

export interface Recommendation {
  /** The limit this concerns, matching the names on the control page. */
  setting: string;
  current: number | null;
  suggested: number | null;
  why: string;
  /** Evidence strength, so a thin one is never mistaken for a strong one. */
  support: "descriptive" | "measured";
}

/**
 * What to change, addressed to the operator.
 *
 * Returned rather than applied. An auto-tuner reading forty trades will fit the
 * last week and trade the next one on it, and it will do so during the drawdown
 * that made the sample unrepresentative in the first place — which is the exact
 * moment the parameters are least worth moving.
 *
 * Only the anatomy drives these, and only where the anatomy is unambiguous: a
 * class has to be both the largest loss category and a clear majority of it
 * before it produces a number, because a 40/35 split between two failure modes
 * with opposite fixes is a request to change nothing until it separates.
 */
export function recommendations(
  report: Report,
  current: { breakEvenAtPct: number; stopLossPct: number; maxHoldMinutes: number; riskPerTradePct: number },
): Recommendation[] {
  const out: Recommendation[] = [];
  const top = report.anatomy[0];
  const losses = report.anatomy.reduce((a, x) => a + x.count, 0);
  // A strict majority, not half. Two failure modes at four trades each have
  // opposite fixes — widen the stop, tighten the ratchet — and applying either
  // on a tie is a coin flip dressed as a finding.
  if (!top || losses < 4 || top.share <= 0.5) return out;

  if (top.kind === "gave-it-back") {
    // Ratchet earlier than the level these trades reached, so the next one is
    // covered before it turns. Floored at 40% because a ratchet that fires on a
    // twitch converts ordinary retracements into scratches.
    const suggested = Math.max(40, Math.min(current.breakEvenAtPct, 50));
    out.push({
      setting: "Break-even at",
      current: current.breakEvenAtPct,
      suggested: suggested < current.breakEvenAtPct ? suggested : null,
      why:
        `${top.count} of ${losses} losses reached at least 60% of the way to target before reversing, ` +
        `costing ${usd(-top.costUsd)}. The ratchet at ${current.breakEvenAtPct}% did not reach them. ` +
        `Moving it to ${suggested}% makes that class of trade a scratch instead of a full loss.`,
      support: "descriptive",
    });
  }

  if (top.kind === "stopped-mid-move") {
    const wider = Number((current.stopLossPct * 1.5).toFixed(3));
    out.push({
      setting: "Stop distance",
      current: current.stopLossPct,
      suggested: wider,
      why:
        `${top.count} of ${losses} losses were stopped after moving in favour first — the stop is sitting ` +
        `inside the range these trades cover on the way to target. Widening to ${wider}% and letting the ` +
        `sizer shrink the position by the same factor keeps the risk per trade identical and stops paying ` +
        `for noise.`,
      support: "descriptive",
    });
  }

  if (top.kind === "never-worked") {
    out.push({
      setting: "Entry filter",
      current: null,
      suggested: null,
      why:
        `${top.count} of ${losses} losses never moved in favour at all, which no exit rule can reach. ` +
        (report.actionable.length > 0
          ? `The conditions table found a split that separates them: ${report.actionable[0].label}. ${report.actionable[0].note}`
          : `No single entry condition separates them yet, so the next useful thing is more trades rather ` +
            `than a tighter filter guessed at now.`),
      support: report.actionable.length > 0 ? "measured" : "descriptive",
    });
  }

  if (top.kind === "cut-on-time") {
    out.push({
      setting: "Max hold",
      current: current.maxHoldMinutes,
      suggested: null,
      why:
        `${top.count} of ${losses} losses were closed by the hold engine rather than by the stop or the ` +
        `target. Check whether they were near their targets when it fired — if they were, the engine is ` +
        `cutting winners and the base window is too short; if they were flat, it is working and the ` +
        `entries are what needs attention.`,
      support: "descriptive",
    });
  }

  return out;
}
