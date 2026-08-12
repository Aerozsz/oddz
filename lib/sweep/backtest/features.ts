/**
 * Candidate predictors, and the right statistic to judge them by.
 *
 * The first pass tested one hypothesis — thin book, price travels that way —
 * and measured it with a close-to-close mean. Both choices were wrong in the
 * same direction.
 *
 * Wrong hypothesis, because there is no reason to believe the only predictive
 * feature in a limit-order book is the one someone thought of first. The right
 * move is to score a family of candidates on identical footing and let the
 * counts decide, with the multiplicity paid for honestly.
 *
 * Wrong statistic, because this is an event strategy and a mean is a drift
 * statistic. The claim is not "the average minute after a thin book drifts up";
 * it is "a thin book raises the odds of a large, fast move". A run of +80bp that
 * retraces lands in a close-to-close mean as approximately zero, while a resting
 * target would have filled. So the measurements below are excursions — the
 * best and worst price reached inside the window, which is what a bracket
 * actually catches — and tail probabilities.
 */

export interface Minute {
  ts: number;
  /** Notional resting within 1% of mid, per side. */
  bid1: number;
  ask1: number;
  /* ---- positioning and carry: who is committed, and what it costs to stay */
  /** Open interest in contracts, from the metrics file. */
  oi?: number;
  /** Long/short ratio of top traders by position, not by account. */
  topPosRatio?: number;
  /** Long/short ratio across all accounts — the crowd, equally weighted. */
  accountRatio?: number;
  /** Taker buy/sell volume ratio as the venue computes it. */
  takerRatio?: number;
  /** Premium of the perpetual over the index, in basis points. */
  basisBps?: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  /** Of `volume`, how much lifted the offer. The order-flow imbalance's input. */
  takerBuy: number;
  trades: number;
}

/** One scored observation: every feature, plus what price then did. */
export interface Sample {
  ts: number;
  features: Record<string, number>;
  /** Best favourable and worst adverse excursion in bp, per horizon, for a long. */
  mfe: Record<string, number>;
  mae: Record<string, number>;
  /** Close-to-close, kept so the two statistics can be compared directly. */
  ret: Record<string, number>;
}

const HALF_LIFE = 30;
const ALPHA = 1 - Math.pow(0.5, 1 / HALF_LIFE);

/**
 * Rolling state, carried minute to minute.
 *
 * Everything is an EWMA of the series' own recent history rather than a global
 * constant, because every one of these quantities moves by an order of magnitude
 * between a Sunday night and an FOMC minute. A feature normalised against a
 * fixed number is mostly a clock.
 */
interface Roll {
  bid: number;
  ask: number;
  vol: number;
  trades: number;
  absRet: number;
  oi: number;
  basis: number;
  n: number;
}

/**
 * Feature values for one minute, or null while the baselines are still warming.
 *
 * Returned rather than accumulated so the caller owns the sample set, and so a
 * warmup refusal is explicit instead of a quietly fabricated zero — which is the
 * failure that produced 6.5x mention-velocity spikes out of an empty baseline
 * earlier in this project.
 */
export function featuresFor(
  m: Minute,
  prev: Minute | null,
  roll: Roll,
  history: Minute[],
): Record<string, number> | null {
  roll.n++;
  if (roll.n === 1) {
    roll.bid = m.bid1;
    roll.ask = m.ask1;
    roll.vol = m.volume;
    roll.trades = m.trades;
    roll.absRet = 0;
    roll.oi = m.oi ?? 0;
    roll.basis = m.basisBps ?? 0;
    return null;
  }

  const ret1 = prev && prev.close > 0 ? ((m.close - prev.close) / prev.close) * 10_000 : 0;
  roll.bid += ALPHA * (m.bid1 - roll.bid);
  roll.ask += ALPHA * (m.ask1 - roll.ask);
  roll.vol += ALPHA * (m.volume - roll.vol);
  roll.trades += ALPHA * (m.trades - roll.trades);
  roll.absRet += ALPHA * (Math.abs(ret1) - roll.absRet);
  if (typeof m.oi === "number") roll.oi += ALPHA * (m.oi - roll.oi);
  if (typeof m.basisBps === "number") roll.basis += ALPHA * (m.basisBps - roll.basis);

  if (roll.n < 60 || !(roll.bid > 0) || !(roll.ask > 0) || !(roll.vol > 0)) return null;

  const lwiBid = m.bid1 / roll.bid;
  const lwiAsk = m.ask1 / roll.ask;

  /*
   * Signed so that positive always means "expect price up".
   *
   * Uniform orientation is not cosmetic here: the summary compares features
   * against each other, and a feature that predicts perfectly with the opposite
   * sign is the same discovery as one that predicts perfectly — but only if the
   * convention makes that visible rather than burying it as a negative mean
   * somebody reads as failure.
   */
  const denom = lwiBid + lwiAsk;
  const asymmetry = denom > 0 ? (lwiBid - lwiAsk) / denom : 0;
  const thinAsk = Math.max(0, Math.min(1, (1 - lwiAsk) / 0.3));
  const thinBid = Math.max(0, Math.min(1, (1 - lwiBid) / 0.3));

  /*
   * Order-flow imbalance, from a field that was already being downloaded.
   *
   * `taker_buy_base_asset_volume` is column 9 of every kline: of the volume in
   * this minute, how much of it lifted the offer. Aggressive buying against
   * passive selling is the most durably predictive thing in a limit-order book,
   * it needs no extra file, and this project has been trading a depth ratio for
   * a week without ever computing it.
   */
  const ofi = m.volume > 0 ? (2 * m.takerBuy) / m.volume - 1 : 0;

  const back = (k: number) => history[history.length - k];
  const retAgo = (k: number) => {
    const b = back(k);
    return b && b.close > 0 ? ((m.close - b.close) / b.close) * 10_000 : 0;
  };

  /*
   * Depth *change*, not depth level.
   *
   * The strategy's actual claim is about withdrawal — someone stepping away —
   * and a level cannot express that. A side that has halved in five minutes is
   * the event; a side that has been thin all day is a regime.
   */
  const b5 = back(5);
  const dBid5 = b5 && b5.bid1 > 0 ? m.bid1 / b5.bid1 - 1 : 0;
  const dAsk5 = b5 && b5.ask1 > 0 ? m.ask1 / b5.ask1 - 1 : 0;

  return {
    /* the incumbent, kept so it is scored on the same footing as the rest */
    sweepSignal: asymmetry * (asymmetry > 0 ? thinAsk : thinBid),
    asymmetry,
    /* thinness of each side, oriented: a thin ask should mean up */
    thinAskUp: thinAsk,
    thinBidUp: -thinBid,
    /* withdrawal: the ask emptying should mean up */
    askWithdrawn: -dAsk5,
    bidWithdrawn: dBid5,
    /* flow */
    ofi,
    ofiVsVol: ofi * Math.min(3, m.volume / roll.vol),
    /* momentum and reversal, at the horizons the strategy operates on */
    mom5: retAgo(5),
    mom30: retAgo(30),
    revert5: -retAgo(5),
    /* regime */
    volSurge: Math.min(5, m.volume / roll.vol) - 1,
    tradeSurge: Math.min(5, m.trades / Math.max(1, roll.trades)) - 1,
    volatility: roll.absRet,
    spreadProxy: (m.high - m.low) / Math.max(1e-9, m.close) * 10_000,

    /* --------------------------------------------------- positioning */

    /*
     * Open interest against price, which is the oldest positioning read there
     * is and one this project has never computed. Rising OI into a rising price
     * is new longs being added; rising OI into a falling price is new shorts.
     * Falling OI either way is unwinding, and an unwind is the thing a squeeze
     * is made of.
     */
    oiChange: roll.oi > 0 && typeof m.oi === "number" ? (m.oi / roll.oi - 1) * 100 : 0,
    oiUpPriceUp:
      roll.oi > 0 && typeof m.oi === "number" ? (m.oi / roll.oi - 1) * Math.sign(retAgo(5)) * 100 : 0,

    /*
     * The crowd, oriented to fade it.
     *
     * A ratio above 1 means more accounts are long than short. Retail
     * positioning is the classic contrarian read, so this is signed negative:
     * a crowded long should mean down. Whether that is true here is exactly
     * what the ranking is for — it has never been measured on this venue.
     */
    crowdFade: typeof m.accountRatio === "number" ? -(m.accountRatio - 1) : 0,
    /*
     * The same question asked of the traders who are actually large. Kept apart
     * from the crowd deliberately: if the two disagree, that disagreement is
     * the signal, and averaging them together would erase it.
     */
    topTraderFollow: typeof m.topPosRatio === "number" ? m.topPosRatio - 1 : 0,
    takerRatioFade: typeof m.takerRatio === "number" ? -(m.takerRatio - 1) : 0,

    /* --------------------------------------------------------- carry */

    /*
     * Basis, and how stretched it is against its own recent level.
     *
     * A perpetual is pinned to spot by a payment that changes hands every eight
     * hours, so the premium is a carry rather than an opinion. It is the one
     * structurally persistent edge this instrument has, and it needs no view on
     * direction at all — which is the entire point given that 513,000 samples
     * just said direction is not predictable here and step size is.
     */
    basis: typeof m.basisBps === "number" ? m.basisBps : 0,
    basisStretch: typeof m.basisBps === "number" ? m.basisBps - roll.basis : 0,
    /** Signed to fade: an expensive perp should fall against the index. */
    basisFade: typeof m.basisBps === "number" ? -(m.basisBps - roll.basis) : 0,

    /* -------------------------------------------------------- session */

    /*
     * Time of day, as two coordinates rather than one number.
     *
     * An hour index would tell a decile split that 23:00 and 00:00 are at
     * opposite ends of the range when they are one minute apart. Sine and
     * cosine of the daily angle keep the wrap-around intact, which is what lets
     * a bucket mean anything at the boundary.
     */
    hourSin: Math.sin((2 * Math.PI * ((m.ts / 3_600_000) % 24)) / 24),
    hourCos: Math.cos((2 * Math.PI * ((m.ts / 3_600_000) % 24)) / 24),
  };
}

export function emptyRoll(): Roll {
  return { bid: 0, ask: 0, vol: 0, trades: 0, absRet: 0, oi: 0, basis: 0, n: 0 };
}

/* --------------------------------------------------------------- scoring */

export interface Score {
  feature: string;
  /** Which decile of the feature this row describes; 0 is the lowest. */
  bucket: number;
  n: number;
  /** Mean favourable excursion for a long, in bp. Sign follows the feature. */
  meanMfe: number;
  meanMae: number;
  meanRet: number;
  seRet: number;
  /** Share of windows whose favourable excursion cleared the threshold. */
  tail25: number;
  tail50: number;
  tail100: number;
}

/**
 * Decile buckets, top versus bottom.
 *
 * Deciles rather than fixed edges because these features have no natural zero
 * to place a boundary at, and a threshold chosen by eye is the mistake that put
 * DEAD_ZONE at 0.12 without anybody measuring it.
 */
export function scoreFeature(samples: Sample[], feature: string, horizon: string, buckets = 10): Score[] {
  const rows = samples
    .filter((s) => Number.isFinite(s.features[feature]) && Number.isFinite(s.ret[horizon]))
    .map((s) => ({ x: s.features[feature], ret: s.ret[horizon], mfe: s.mfe[horizon], mae: s.mae[horizon] }))
    .sort((a, b) => a.x - b.x);
  if (rows.length < buckets * 20) return [];

  const per = Math.floor(rows.length / buckets);
  const out: Score[] = [];
  for (let i = 0; i < buckets; i++) {
    const slice = rows.slice(i * per, i === buckets - 1 ? rows.length : (i + 1) * per);
    const n = slice.length;
    const mean = (f: (r: (typeof slice)[number]) => number) => slice.reduce((a, r) => a + f(r), 0) / n;
    const meanRet = mean((r) => r.ret);
    const varr = slice.reduce((a, r) => a + (r.ret - meanRet) ** 2, 0) / Math.max(1, n - 1);
    out.push({
      feature,
      bucket: i,
      n,
      meanMfe: mean((r) => r.mfe),
      meanMae: mean((r) => r.mae),
      meanRet,
      seRet: Math.sqrt(varr / n),
      tail25: slice.filter((r) => r.mfe >= 25).length / n,
      tail50: slice.filter((r) => r.mfe >= 50).length / n,
      tail100: slice.filter((r) => r.mfe >= 100).length / n,
    });
  }
  return out;
}

/**
 * How far apart the extreme deciles are, in standard errors of the difference.
 *
 * The single number worth ranking features by. Not the top decile's mean on its
 * own — that is high whenever the market rose over the sample — but the spread
 * between the top and the bottom, which is what a strategy can actually take a
 * side on.
 */
export function edge(scores: Score[]): { sigma: number; spreadBps: number; tailLift: number } {
  if (scores.length < 2) return { sigma: 0, spreadBps: 0, tailLift: 0 };
  const lo = scores[0];
  const hi = scores[scores.length - 1];
  const se = Math.sqrt(hi.seRet ** 2 + lo.seRet ** 2);
  return {
    sigma: se > 0 ? (hi.meanRet - lo.meanRet) / se : 0,
    spreadBps: hi.meanRet - lo.meanRet,
    tailLift: lo.tail50 > 0 ? hi.tail50 / lo.tail50 : hi.tail50 > 0 ? Infinity : 1,
  };
}
