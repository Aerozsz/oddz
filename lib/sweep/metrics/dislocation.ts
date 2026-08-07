/**
 * Where one contract has come loose from the ones it usually moves with.
 *
 * The claim being tested is narrow and worth stating precisely, because the
 * loose version of it — "there are discrepancies between correlated names, go
 * and exploit them" — describes an arbitrage, and this is not one. An arbitrage
 * needs a mechanism that forces two prices back together: the same asset in two
 * venues, a creation-redemption basket, a deliverable future against its spot.
 * Two semiconductor stocks have none of that. They move together because they
 * are exposed to the same demand, and nothing whatsoever obliges them to keep
 * doing so. When one diverges, the single commonest explanation is that
 * something happened to that company, and betting on convergence is then
 * betting against news.
 *
 * What survives that objection is smaller and still useful. Over a horizon of
 * minutes, a large part of a liquid equity name's move is the sector, not the
 * name. When one contract moves and its peers do not, the move is *more likely*
 * to be flow than information — someone working an order, a stop run, a thin
 * book being pushed — and flow-driven moves are the ones the rest of this system
 * is built to read. So a divergence is not a signal to fade. It is evidence
 * about which kind of move is happening, and it earns a modest weight in the
 * bias alongside everything else.
 *
 * Two guards keep that from becoming wishful:
 *
 *  1. The group has to actually be a group. Average pairwise correlation of
 *     returns is measured over the same window, and below `MIN_CORRELATION` the
 *     reading is suppressed entirely rather than scaled down — "diverged from
 *     the group" is meaningless when there is no group, and a small number
 *     derived from noise is worse than no number.
 *  2. The residual is expressed as a z-score against its own recent
 *     distribution, so a name that always wanders relative to its peers needs a
 *     larger gap to register than one that never does.
 *
 * Nothing here is fitted. These are the plainest possible estimators over a
 * short window, and the paper log is what will eventually say whether the
 * factor is worth its weight.
 */

/** Samples are taken on this grid, so desks publishing at different rates align. */
const BUCKET_MS = 5_000;
/** How far back returns are measured. Long enough for a sector move to show. */
export const LOOKBACK_MS = 20 * 60_000;
/** The horizon a divergence is measured over. */
const RETURN_MS = 3 * 60_000;
/** Below this average pairwise correlation the names are not a group. */
const MIN_CORRELATION = 0.35;
/** Fewer buckets than this and nothing is reported. */
const MIN_SAMPLES = 24;
/** A residual smaller than this is inside the noise of any equity pair. */
const MIN_RESIDUAL_BPS = 8;

export interface DislocationRead {
  /** False whenever anything below is not trustworthy; everything else is then 0. */
  warm: boolean;
  /** True when the group's members have actually been moving together. */
  coupled: boolean;
  /** Average pairwise correlation of returns over the window, −1..1. */
  correlation: number;
  /** This contract's return over the horizon, in basis points. */
  ownBps: number;
  /** The peer group's median return over the same horizon, in basis points. */
  groupBps: number;
  /** own − group. Positive means this name has outrun its peers. */
  residualBps: number;
  /** The residual against its own recent distribution. */
  z: number;
  /**
   * −1..1, positive favouring up.
   *
   * Signed *against* the residual: a name that has outrun its group scores
   * negative. See the note above — this is a mild prior that an unaccompanied
   * move is flow rather than information, not a conviction that it reverts.
   */
  score: number;
  /** How many contracts were in the comparison. */
  peers: number;
  note: string;
}

export const EMPTY_DISLOCATION: DislocationRead = {
  warm: false,
  coupled: false,
  correlation: 0,
  ownBps: 0,
  groupBps: 0,
  residualBps: 0,
  z: 0,
  score: 0,
  peers: 0,
  note: "not enough history across contracts yet",
};

interface Series {
  /** Bucket start → last mid seen in that bucket. */
  points: { t: number; logPrice: number }[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  const xa = a.slice(-n);
  const xb = b.slice(-n);
  const ma = xa.reduce((s, v) => s + v, 0) / n;
  const mb = xb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const u = xa[i] - ma;
    const v = xb[i] - mb;
    num += u * v;
    da += u * u;
    db += v * v;
  }
  const denom = Math.sqrt(da * db);
  return denom > 0 ? num / denom : 0;
}

/** Where the factor stops growing, in standard deviations. */
const PEAK_Z = 2.5;

/**
 * How much a divergence of `z` is worth, 0..~0.85, unsigned.
 *
 * Rises and then falls, which is the whole argument of this module expressed as
 * a curve. A name a standard deviation away from its peers is mildly more
 * likely to be moving on flow than on news, and that is worth a small nudge. A
 * name four standard deviations away is not four times as interesting — it is a
 * different event. Nothing about ordinary book pressure separates a liquid
 * equity from its sector by that much, and the explanations that remain
 * (earnings, a guidance cut, an acquisition) are all reasons the gap is real and
 * will not close.
 *
 * So the curve returns to zero at the extreme rather than saturating. The
 * failure it is built to avoid is the expensive one: reading the largest
 * possible divergence as the strongest possible signal to fade, moments after a
 * company-specific headline, and being run over by the follow-through.
 */
function divergenceScore(z: number): number {
  const a = Math.abs(z);
  const rise = Math.tanh(a / 2);
  const excess = Math.max(0, a - PEAK_Z);
  const decay = Math.exp(-(excess * excess) / 2);
  return Math.sign(z) * rise * decay;
}

export class DislocationTracker {
  private series = new Map<string, Series>();

  /**
   * Record a price. Safe to call at any rate — samples are bucketed, so a desk
   * publishing at 10Hz and one publishing every few seconds contribute the same
   * number of observations and neither dominates the correlation.
   */
  record(symbol: string, price: number, now = Date.now()) {
    if (!(price > 0)) return;
    let s = this.series.get(symbol);
    if (!s) {
      s = { points: [] };
      this.series.set(symbol, s);
    }
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const last = s.points.at(-1);
    const logPrice = Math.log(price);
    if (last && last.t === bucket) last.logPrice = logPrice;
    else s.points.push({ t: bucket, logPrice });

    const cutoff = now - LOOKBACK_MS;
    while (s.points.length > 0 && s.points[0].t < cutoff) s.points.shift();
  }

  /** Drop a contract entirely — used when a desk stops. */
  forget(symbol: string) {
    this.series.delete(symbol);
  }

  symbols(): string[] {
    return [...this.series.keys()];
  }

  /** Bucket-to-bucket log returns, oldest first. */
  private returns(symbol: string): number[] {
    const s = this.series.get(symbol);
    if (!s || s.points.length < 2) return [];
    const out: number[] = [];
    for (let i = 1; i < s.points.length; i++) out.push(s.points[i].logPrice - s.points[i - 1].logPrice);
    return out;
  }

  /**
   * The trailing-horizon return at every bucket, in basis points.
   *
   * Computed over the whole stored window rather than only at `now`, because the
   * z-score needs the residual's own recent distribution and that distribution
   * has to be a property of the data. An earlier version accumulated residuals
   * as a side effect of calling `read`, which made the answer depend on how
   * often something happened to ask — the GUI polling faster would have widened
   * the distribution and shrunk every z-score with it. This is deterministic and
   * `read` is pure.
   *
   * Keyed by bucket so two contracts can be compared at the same instants even
   * when one of them had no update in some bucket.
   */
  private horizonSeries(symbol: string): Map<number, number> {
    const out = new Map<number, number>();
    const s = this.series.get(symbol);
    if (!s || s.points.length < 2) return out;
    const pts = s.points;
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const target = pts[i].t - RETURN_MS;
      // Advance to the newest point at or before the target, so the window is
      // as close to RETURN_MS as the data allows without ever exceeding it.
      while (start + 1 < i && pts[start + 1].t <= target) start++;
      if (pts[start].t > target) continue; // not enough history behind this bucket yet
      out.set(pts[i].t, (pts[i].logPrice - pts[start].logPrice) * 10_000);
    }
    return out;
  }

  read(symbol: string, now = Date.now()): DislocationRead {
    const own = this.series.get(symbol);
    const peers = [...this.series.keys()].filter((k) => k !== symbol);
    if (!own || own.points.length < MIN_SAMPLES || peers.length === 0) return EMPTY_DISLOCATION;

    const ownReturns = this.returns(symbol);
    const usable = peers.filter((p) => (this.series.get(p)?.points.length ?? 0) >= MIN_SAMPLES);
    if (usable.length === 0) return EMPTY_DISLOCATION;

    const corrs = usable.map((p) => correlation(ownReturns, this.returns(p)));
    const corr = corrs.reduce((s, v) => s + v, 0) / corrs.length;

    const ownSeries = this.horizonSeries(symbol);
    const peerSeries = usable.map((p) => this.horizonSeries(p));

    // Residual at every bucket where this contract and at least one peer both
    // have a horizon return. Median across peers rather than mean: with three
    // names, one of them having its own news would drag a mean into claiming
    // the whole sector moved.
    const buckets = [...ownSeries.keys()].sort((a, b) => a - b);
    const residuals: number[] = [];
    let latest: { residualBps: number; ownBps: number; groupBps: number } | null = null;
    for (const t of buckets) {
      const peerVals = peerSeries.map((m) => m.get(t)).filter((v): v is number => v !== undefined);
      if (peerVals.length === 0) continue;
      const ownBps = ownSeries.get(t)!;
      const groupBps = median(peerVals);
      const residualBps = ownBps - groupBps;
      residuals.push(residualBps);
      latest = { residualBps, ownBps, groupBps };
    }
    if (!latest || residuals.length < MIN_SAMPLES) return { ...EMPTY_DISLOCATION, peers: usable.length };
    const { ownBps, groupBps, residualBps } = latest;

    const coupled = corr >= MIN_CORRELATION;
    if (!coupled) {
      return {
        warm: true,
        coupled: false,
        correlation: corr,
        ownBps,
        groupBps,
        residualBps,
        z: 0,
        score: 0,
        peers: usable.length,
        note:
          `${symbol} and its peers have only been ${(corr * 100).toFixed(0)}% correlated over the last ` +
          `${Math.round(LOOKBACK_MS / 60_000)} minutes — too loose for a divergence to mean anything`,
      };
    }

    const n = residuals.length;
    const mean = residuals.reduce((s, v) => s + v, 0) / n;
    const variance = residuals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
    const sd = Math.sqrt(variance);
    const z = sd > 0 ? (residualBps - mean) / sd : 0;

    if (Math.abs(residualBps) < MIN_RESIDUAL_BPS) {
      return {
        warm: true,
        coupled: true,
        correlation: corr,
        ownBps,
        groupBps,
        residualBps,
        z,
        score: 0,
        peers: usable.length,
        note: `${symbol} is tracking its peers (${residualBps >= 0 ? "+" : ""}${residualBps.toFixed(0)}bp apart)`,
      };
    }

    const score = -divergenceScore(z);

    return {
      warm: true,
      coupled: true,
      correlation: corr,
      ownBps,
      groupBps,
      residualBps,
      z,
      score,
      peers: usable.length,
      note:
        `${symbol} is ${Math.abs(residualBps).toFixed(0)}bp ${residualBps > 0 ? "ahead of" : "behind"} ` +
        `${usable.length === 1 ? usable[0] : `its ${usable.length} peers`} ` +
        `(${z >= 0 ? "+" : ""}${z.toFixed(1)}σ), while they moved ${groupBps >= 0 ? "+" : ""}${groupBps.toFixed(0)}bp — ` +
        (Math.abs(z) > PEAK_Z + 1
          ? "too far out of line to be ordinary flow, so this is being read as news about the name and discounted"
          : "unaccompanied moves are more often flow than news"),
    };
  }
}
