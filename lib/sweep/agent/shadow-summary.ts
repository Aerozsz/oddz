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
  conditions?: {
    lwiAdj?: number | null;
    targetDistPct?: number | null;
    biasComposite?: number | null;
    biasFactors?: Record<string, number> | null;
  } | null;
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

/**
 * A difference between two buckets, with the error term that decides it.
 *
 * Buckets get compared by eye, and by eye a 9bp gap between two means looks
 * decisive whether it is 1.9 standard errors or 19. Computing the contrast in
 * code — including the standard error of the *difference*, which is not either
 * bucket's own — means the comparison is made once, correctly, by whoever
 * generated it rather than by whoever reads it.
 */
export interface Contrast {
  label: string;
  /**
   * Thin minus thick, in percent.
   *
   * Sign convention matters here and is the whole point. The strategy claims a
   * thin book on the side price must travel through predicts a *favourable*
   * move, so the thesis predicts this is POSITIVE. Negative means the signal
   * is real but pointing the wrong way, which is a different situation from
   * the signal being absent — and a much more useful one, because the fix for
   * a backwards signal is to take the other side.
   */
  deltaPct: number;
  /** Standard error of the difference: sqrt(se_thin^2 + se_thick^2). */
  sePct: number;
  /** deltaPct / sePct. */
  sigma: number;
  nThin: number;
  nThick: number;
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
  matched: {
    n: number;
    horizon: string;
    byHorizon: Record<string, Bucket>;
    /**
     * The same matched trades split by side, at the longest horizon.
     *
     * The one thing that can still explain away a monotonic gain with holding
     * time: a two-hour hold accumulates whatever the market did over two hours,
     * so a long-biased strategy in a rising sample shows a rising edge that is
     * beta rather than alpha. If longs and shorts are both positive the drift
     * explanation is dead; if only one side carries it, the "edge" is the
     * calendar and n=10,723 will not save it.
     */
    bySide: Record<string, Bucket>;
  };
  /**
   * The thesis, tested inside each side and at every horizon.
   *
   * Two separate results have now been explained away by the same thing. The
   * two-hour "edge" was drift: the book is 3:1 long, the sample rose, longs
   * collected it and shorts paid it, and equal-weighted the mean was zero. The
   * depth breakdown is exposed to exactly that confound — if thin-book entries
   * happen to skew short, "thin does worse" is only "shorts did worse" wearing
   * a different label, and that would be the third time the same artifact was
   * read as a finding.
   *
   * So the contrast is computed *within* long and *within* short, never only
   * pooled. A depth effect that survives inside both sides cannot be the
   * calendar, because both sides shared the same calendar.
   *
   * And it is computed at every horizon, not just the primary one, because the
   * short horizons are the cleaner test rather than the weaker one: at sixty
   * seconds the overall mean is indistinguishable from zero, so there is no
   * drift there to mistake for a signal. An effect visible at t60 has nowhere
   * to hide.
   */
  /**
   * Why the book is one-sided, factor by factor.
   *
   * A microstructure read of which side of the book has thinned has no business
   * being 3:1 long. Something upstream leans, and until now the composite was
   * collapsed to "buy" before anything recorded it, so the skew was visible and
   * its cause was not.
   *
   * Averaged over thousands of decisions, a factor that measures an asymmetry
   * between two sides of a book should sit near zero. Any factor whose mean is
   * far from zero is either reading a real persistent asymmetry — which would
   * be a finding — or is signed wrongly, which would be a defect. Both matter
   * and neither is visible from the side counts alone.
   *
   * `meanAll` is the honest denominator: it averages over every decision that
   * carried a reading, including the ones where the composite fell in the dead
   * zone and no trade followed, so a factor is not scored only on the occasions
   * it happened to win the argument.
   */
  biasBalance: {
    long: number;
    short: number;
    /** Rows carrying the decomposition at all. Absence is not balance. */
    withFactors: number;
    /** Mean composite over rows that carry one; zero would be even-handed. */
    meanComposite: number;
    /** factor name -> mean score across every decision that recorded it. */
    meanByFactor: Record<string, { mean: number; n: number; weight?: number }>;
  };
  depthContrast: {
    /** horizon -> "long" | "short" | "both" -> thin-minus-thick. */
    byHorizon: Record<string, Record<string, Contrast>>;
    /** The two thin bands pooled; the extreme band alone is too small to read. */
    thinBelow: number;
    thickAtOrAbove: number;
  };
}

/*
 * Where thin stops and thick starts.
 *
 * The two thin bands are pooled rather than compared at the extreme, because
 * the extreme band carries a few hundred rows against several thousand and the
 * question being asked is the *sign* of the effect, not its shape. A shape
 * needs the bands; a sign needs samples.
 */
export const THIN_BELOW = 0.85;
export const THICK_AT_OR_ABOVE = 1;

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

  const matchedBySide: Record<string, Bucket> = {};
  if (longest) {
    for (const side of ["long", "short"] as const) {
      matchedBySide[side] = bucket(side, matchedRows.filter((r) => r.side === side), longest.h);
    }
  }

  /*
   * Thin minus thick, within each side, at every horizon.
   *
   * `bucket` already returns the standard error of each mean; the error of the
   * difference is the root of the sum of squares, not either one of them. That
   * distinction is what separates the 1.9 sigma this actually is from the
   * "obviously significant" it looks like when the two means are 9bp apart.
   */
  const contrastByHorizon: Record<string, Record<string, Contrast>> = {};
  for (const h of horizons) {
    const cells: Record<string, Contrast> = {};
    for (const side of ["long", "short", "both"] as const) {
      const inSide = side === "both" ? rows : rows.filter((r) => r.side === side);
      const depth = (r: ShadowRowLike) => r.conditions?.lwiAdj;
      const thin = bucket(
        "thin",
        inSide.filter((r) => typeof depth(r) === "number" && depth(r)! < THIN_BELOW),
        h,
      );
      const thick = bucket(
        "thick",
        inSide.filter((r) => typeof depth(r) === "number" && depth(r)! >= THICK_AT_OR_ABOVE),
        h,
      );
      const deltaPct = thin.meanPct - thick.meanPct;
      /*
       * Infinity is what `bucket` reports for a standard error it cannot
       * compute, and it propagates correctly here: a contrast against an
       * unmeasurable end has an infinite error and a sigma of zero, which is
       * exactly the claim "this says nothing". No special case needed, but the
       * zero has to be produced deliberately rather than as Infinity/Infinity.
       */
      const sePct = Math.sqrt(thin.sePct ** 2 + thick.sePct ** 2);
      cells[side] = {
        label: `${side} · thin<${THIN_BELOW} minus thick>=${THICK_AT_OR_ABOVE} @ ${h}`,
        deltaPct,
        sePct,
        sigma: Number.isFinite(sePct) && sePct > 0 ? deltaPct / sePct : 0,
        nThin: thin.n,
        nThick: thick.n,
      };
    }
    contrastByHorizon[h] = cells;
  }

  /*
   * The side counts, and the decomposition that produced them.
   *
   * Kept in one place because the counts without the factors are what the
   * project already had: a known 3:1 skew with no way to ask why.
   */
  const factorSums = new Map<string, { sum: number; n: number }>();
  let compositeSum = 0;
  let withFactors = 0;
  for (const r of rows) {
    const f = r.conditions?.biasFactors;
    if (!f) continue;
    withFactors++;
    compositeSum += r.conditions?.biasComposite ?? 0;
    for (const [name, score] of Object.entries(f)) {
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      const acc = factorSums.get(name) ?? { sum: 0, n: 0 };
      acc.sum += score;
      acc.n++;
      factorSums.set(name, acc);
    }
  }
  const meanByFactor: Record<string, { mean: number; n: number }> = {};
  /*
   * Sorted by how far from zero, because that ordering is the finding. The
   * factor at the top of this list is the one making the book one-sided, and
   * putting it there means a reader does not have to scan a map to find it.
   */
  for (const [name, acc] of [...factorSums.entries()].sort(
    (a, b) => Math.abs(b[1].sum / b[1].n) - Math.abs(a[1].sum / a[1].n),
  )) {
    meanByFactor[name] = { mean: acc.sum / acc.n, n: acc.n };
  }

  return {
    rows: rows.length,
    withConditions,
    biasBalance: {
      long: rows.filter((r) => r.side === "long").length,
      short: rows.filter((r) => r.side === "short").length,
      withFactors,
      meanComposite: withFactors > 0 ? compositeSum / withFactors : 0,
      meanByFactor,
    },
    horizons,
    overall,
    byEntryDepth: withConditions > 0 ? byEntryDepth : [],
    bySignal,
    resolved,
    feesUsd,
    grossUsd,
    matched: {
      n: matchedRows.length,
      horizon: longest?.h ?? "",
      byHorizon: matchedByHorizon,
      bySide: matchedBySide,
    },
    depthContrast: {
      byHorizon: contrastByHorizon,
      thinBelow: THIN_BELOW,
      thickAtOrAbove: THICK_AT_OR_ABOVE,
    },
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
