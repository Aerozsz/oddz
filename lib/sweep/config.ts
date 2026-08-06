/**
 * Everything tunable in one place.
 *
 * The instrument is INTCUSDT: a Binance USDⓈ-M *equity* perpetual tracking
 * Intel Corp on Nasdaq. Two properties of that make it different from a crypto
 * perp and drive several defaults below:
 *
 *  1. Max leverage is 20x — high enough that liquidations sit close to entry.
 *     A 20x long liquidates ~3.4% below it. The leverage ladder in the cluster
 *     model is built accordingly.
 *  2. The underlying cash market closes; the perp does not. Depth withdrawal
 *     is structurally worse when Nasdaq is shut, which is exactly the
 *     precondition that makes the first trigger cluster cheap to reach.
 */

export const SYMBOL = "INTCUSDT";

/** Binance USDⓈ-M futures endpoints. */
export const FAPI_REST = "https://fapi.binance.com";
export const FAPI_WS = "wss://fstream.binance.com/stream";

/** Same-origin fallback used when the browser cannot reach Binance directly. */
export const REST_PROXY = "/api/sweep/binance";

export const CONFIG = {
  /** Bands (in basis points from mid) that depth is measured across. */
  depthBands: [5, 10, 25, 50, 100, 250] as const,
  /** The band that headline liquidity numbers and the withdrawal index use. */
  primaryBandBps: 25,

  /** Percent moves the cost-to-move curve is evaluated at. */
  costTargetsPct: [0.1, 0.25, 0.5, 1, 2, 3, 5] as const,

  /** Local book keeps levels within this fraction of mid; the rest is pruned. */
  bookRetentionPct: 25,

  /** Liquidity sampler cadence and history length. */
  sampleIntervalMs: 500,
  sampleHistorySec: 1800,

  /** EWMA half-lives (seconds) for the fast/slow depth baselines. */
  fastHalfLifeSec: 10,
  slowHalfLifeSec: 600,

  /** Window over which withdrawn-vs-consumed is decomposed. */
  decompWindowSec: 10,

  /**
   * A thinning event fires when, inside decompWindowSec, quote withdrawal
   * exceeds this fraction of the slow baseline *and* exceeds trade
   * consumption — i.e. depth left rather than being eaten.
   */
  thinningWithdrawFrac: 0.2,

  /** A resting level counts as a wall at this multiple of the local median. */
  wallMultiple: 8,
  /** ...and at least this much notional, so a quiet book doesn't cry wolf. */
  wallMinNotional: 25_000,

  /** Cluster map half-range around mark, in percent. */
  clusterRangePct: 12,
  /** Levels closer together than this (percent) are merged into one cluster. */
  clusterMergePct: 0.15,

  /**
   * Maintenance margin rate for the liquidation ladder.
   *
   * Not assumed: back-solved from an observed position on this contract — a
   * short entered at 101.58 that Binance reported as liquidating at 104.91,
   * which at 20x implies exactly this rate and reproduces that price to the
   * cent. Binance only exposes real brackets over a signed endpoint, so a
   * single observed liquidation is the best calibration available without one,
   * and it beats a round number picked for looking plausible.
   *
   * It is a first-tier rate. Larger notionals sit in higher brackets with
   * higher rates, so the ladder understates how close a big position's
   * liquidation really is.
   */
  maintenanceMarginRate: 0.01667,

  /**
   * Leverage mix assumed across open positions, skewed toward the cap the way
   * retail positioning generally is. Must sum to 1.
   *
   * The cap is 20x. An earlier version of this table stopped at 10x, which
   * pushed every modelled liquidation to roughly twice its true distance from
   * price — and the levels that matter most are the near ones, so the ladder
   * was missing them entirely rather than merely misplacing them.
   */
  leverageMix: [
    { leverage: 2, share: 0.1 },
    { leverage: 3, share: 0.15 },
    { leverage: 5, share: 0.2 },
    { leverage: 10, share: 0.25 },
    { leverage: 20, share: 0.3 },
  ],

  /** Half-life (hours) applied to kline volume when inferring where positions were opened. */
  entryProfileHalfLifeHours: 6,
  /** Lookback (hours) of 1m klines used for that entry profile. */
  entryProfileLookbackHours: 16,

  /**
   * Fraction of open interest treated as liquidatable inside the mapped range.
   * Scales modelled cluster sizes into dollars; deliberately conservative.
   */
  liquidatableOiFraction: 0.35,

  /** Stops sit *past* a prior extreme, not on it. Offset applied, in percent. */
  stopBufferPct: 0.05,

  /** Swing-pivot detection: bars either side that a fractal must dominate. */
  pivotStrength: 3,

  /** Observed-liquidation memory: half-life (minutes) of a printed liq cluster. */
  observedLiqHalfLifeMin: 45,
  /**
   * A cluster that just fired is spent. Recent liquidation volume at a level
   * is subtracted from that level's modelled size with this half-life (min).
   */
  spentHalfLifeMin: 30,

  /** Trades at or above this notional hit the large-print tape. */
  largeTradeNotional: 25_000,

  /** UI publish rate. */
  publishHz: 10,

  /** Cascade sim: flow beyond the visible book decays at this rate per 10bp. */
  tailDecayPer10Bp: 0.93,
  /** Cascade sim stops after this many links. */
  maxCascadeLinks: 8,
} as const;

export type DepthBand = (typeof CONFIG.depthBands)[number];
