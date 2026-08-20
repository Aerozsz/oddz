/**
 * What the shadow run has already learned, condensed enough to travel.
 *
 * The live account has paid for 28 trades. The shadow run has recorded 552, on
 * the same books, from the same decisions, scored against what price really
 * did. Every question about whether the *signal* predicts anything is answerable
 * from those 552 — see evidence.ts for why: a shadow row models the fill, not
 * the market, and the market did not know the order was hypothetical.
 *
 * They were being ignored because they were not visible from anywhere the
 * analysis happens. The dashboard showed a row count and a net figure; the file
 * is on the trading machine and `data/` is not shared. So the cheapest evidence
 * in the project was the only evidence nobody could read, while the most
 * expensive was being generated at $7.60 a round trip to answer the same
 * question.
 *
 * This is deliberately a summary rather than the rows. Five hundred records with
 * full entry conditions is megabytes; the buckets below are the shape of the
 * answer, and they are what a conditional split would read anyway.
 */

export interface ShadowRowLike {
  at: number;
  side: "long" | "short";
  signalKind: string;
  entryPrice: number;
  notionalUsd: number;
  feeUsd: number;
  spreadBps: number;
  resolved?: string;
  style?: { entry?: string };
  outcomes: Record<string, { pct: number | null; netUsd: number | null }>;
  conditions?: { lwiAdj?: number | null; targetDistPct?: number | null } | null;
}

export interface Bucket {
  label: string;
  n: number;
  wins: number;
  /** Mean signed move in percent, before costs. The signal's own edge. */
  meanPct: number;
  /** Same thing net of the modelled round trip, in dollars. */
  netUsd: number;
  /** Standard error of meanPct, so a difference can be judged rather than eyeballed. */
  sePct: number;
}

function bucket(label: string, rows: ShadowRowLike[], horizon: string): Bucket {
  const pcts: number[] = [];
  let netUsd = 0;
  let wins = 0;
  for (const r of rows) {
    const o = r.outcomes?.[horizon];
    if (!o || typeof o.pct !== "number" || typeof o.netUsd !== "number") continue;
    pcts.push(o.pct);
    netUsd += o.netUsd;
    if (o.netUsd > 0) wins++;
  }
  const n = pcts.length;
  const meanPct = n ? pcts.reduce((a, b) => a + b, 0) / n : 0;
  /*
   * The standard error, not the standard deviation.
   *
   * The question these buckets exist to answer is whether one group's mean
   * differs from another's, and at n in the dozens an eyeballed difference
   * between two means is almost always noise. Carrying the error term means the
   * comparison can be made properly by whoever reads it.
   */
  const variance = n > 1 ? pcts.reduce((a, b) => a + (b - meanPct) ** 2, 0) / (n - 1) : 0;
  return {
    label,
    n,
    wins,
    meanPct,
    netUsd,
    sePct: n > 1 ? Math.sqrt(variance / n) : Infinity,
  };
}

export interface ShadowSummary {
  rows: number;
  /**
   * How many rows carry an entry reading at all.
   *
   * Reported because its absence looked exactly like a measurement. The
   * `conditions` field was never assigned by the producer, so every depth
   * bucket came back n=0 with a mean of 0.0000 — which reads as "no effect"
   * rather than "no data", and sat in the summary for two days being treated
   * as the former.
   */
  withConditions: number;
  /** Horizons present in the file, so a reader knows what was measurable. */
  horizons: string[];
  /** Overall, per horizon. */
  overall: Record<string, Bucket>;
  /**
   * The question the whole strategy rests on.
   *
   * The entry says the side price must travel through is thin. If that predicts
   * anything, the thin buckets move further in the trade's favour than the thick
   * ones. If every bucket has the same mean, the signal is not a signal, and no
   * amount of exit tuning or fee saving will make it one.
   */
  byEntryDepth: Bucket[];
  bySignal: Bucket[];
  /** Where trades ended up: stop first, target first, or neither inside the window. */
  resolved: Record<string, number>;
  /** Total modelled cost, against the total gross — the fee load, measured. */
  feesUsd: number;
  grossUsd: number;
  /** Set only when the depth breakdown could not be computed at all. */
  note?: string;
  /**
   * Every horizon scored over the rows that reached the longest one.
   *
   * `overall` scores each horizon across whatever rows carry it, and a longer
   * horizon can only be carried by an older trade — so comparing them there
   * compares different samples and different market conditions. Holding two
   * hours looked dramatically better than holding fifteen minutes, and most of
   * that gap could have been the subsets rather than the holding.
   *
   * This restricts every horizon to the rows that reached the last one, so the
   * comparison is the same trades measured at different times, which is the
   * only version of the question worth answering.
   */
  matched: { n: number; horizon: string; byHorizon: Record<string, Bucket> };
}

/** Which horizon to lead with when several are present. */
export const PRIMARY_HORIZON = "t900";

export function summariseShadow(rows: ShadowRowLike[], horizon = PRIMARY_HORIZON): ShadowSummary {
  const horizons = [...new Set(rows.flatMap((r) => Object.keys(r.outcomes ?? {})))].sort();

  const overall: Record<string, Bucket> = {};
  for (const h of horizons) overall[h] = bucket("all", rows, h);

  /*
   * Depth bands, not quantiles.
   *
   * Fixed edges because the interesting comparison is against 1.0 — the book's
   * own baseline — and quantile edges move with whatever the sample happened to
   * contain, which makes two runs incomparable. 0.7 and 0.85 sit either side of
   * the thinness the entry gate treats as a full signal.
   */
  const bands: [string, (x: number) => boolean][] = [
    ["very thin <0.70", (x) => x < 0.7],
    ["thin 0.70-0.85", (x) => x >= 0.7 && x < 0.85],
    ["marginal 0.85-1.00", (x) => x >= 0.85 && x < 1],
    ["at or above baseline >=1.00", (x) => x >= 1],
  ];
  const byEntryDepth = bands.map(([label, test]) =>
    bucket(
      label,
      rows.filter((r) => {
        const x = r.conditions?.lwiAdj;
        return typeof x === "number" && test(x);
      }),
      horizon,
    ),
  );

  const kinds = [...new Set(rows.map((r) => r.signalKind).filter(Boolean))];
  const bySignal = kinds
    .map((k) => bucket(k, rows.filter((r) => r.signalKind === k), horizon))
    .filter((b) => b.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  const resolved: Record<string, number> = {};
  for (const r of rows) {
    const k = r.resolved ?? "unscored";
    resolved[k] = (resolved[k] ?? 0) + 1;
  }

  let feesUsd = 0;
  let grossUsd = 0;
  for (const r of rows) {
    const o = r.outcomes?.[horizon];
    if (!o || typeof o.netUsd !== "number" || typeof o.pct !== "number") continue;
    feesUsd += r.feeUsd;
    grossUsd += (o.pct / 100) * r.notionalUsd;
  }

  const withConditions = rows.filter((r) => typeof r.conditions?.lwiAdj === "number").length;

  /*
   * The longest horizon any row reached, and the rows that reached it.
   */
  const longest = horizons
    .map((h) => ({ h, n: rows.filter((r) => typeof r.outcomes?.[h]?.netUsd === "number").length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => Number(b.h.replace(/^t/, "")) - Number(a.h.replace(/^t/, "")))[0];
  const matchedRows = longest
    ? rows.filter((r) => typeof r.outcomes?.[longest.h]?.netUsd === "number")
    : [];
  const matchedByHorizon: Record<string, Bucket> = {};
  for (const h of horizons) matchedByHorizon[h] = bucket(`matched ${h}`, matchedRows, h);
  return {
    rows: rows.length,
    withConditions,
    horizons,
    overall,
    byEntryDepth: withConditions > 0 ? byEntryDepth : [],
    bySignal,
    resolved,
    feesUsd,
    grossUsd,
    matched: { n: matchedRows.length, horizon: longest?.h ?? "", byHorizon: matchedByHorizon },
    /*
     * Said in words, not left to be inferred from a count of zero.
     *
     * An empty bucket list is unambiguous; four buckets reading 0.0000 are not,
     * and the difference is two days of believing a broken pipeline was a null
     * result.
     */
    ...(withConditions === 0
      ? { note: "no row carries an entry reading — the depth breakdown cannot be computed, this is missing data and not a null result" }
      : {}),
  };
}
