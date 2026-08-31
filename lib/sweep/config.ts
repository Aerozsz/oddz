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

/**
 * The contract everything reads and trades.
 *
 * Overridable so the order path can be exercised on a symbol the demo
 * environment actually supports. INTCUSDT is a TradFi perpetual, and Binance
 * requires a separate agreement for those which the demo site does not reliably
 * let you sign — so proving that an entry places, a stop attaches and a close
 * flattens has to happen on something like BTCUSDT:
 *
 *     SWEEP_SYMBOL=BTCUSDT npm run sweep:control
 *
 * Only the plumbing transfers. Every model here — the leverage ladder, the
 * maintenance rate, the session weights, the earnings calendar — is calibrated
 * to an equity perp tracking a stock on Nasdaq, and none of it means anything
 * on a crypto pair. Use another symbol to test that orders work, not to decide
 * whether the strategy does.
 */
/*
 * Default changed to LITUSDT on 2026-08-31, at the operator's instruction to
 * move to LIT and drop BTCUSDT.
 *
 * The instruction named LITUSDC. That contract does not exist. Checked against
 * the Binance archive from a host that can reach it, with BTCUSDT and BTCUSDC
 * as controls so an absent reading could be told from a broken method:
 * um/LITUSDT present, um/LITUSDC absent on every date tried, both BTC controls
 * present. BTCUSDC being present is what rules out the obvious alternative
 * explanation — USDC-margined perpetuals are archived, so LITUSDC is missing
 * because it is not listed, not because its class is absent. LITUSDT is the
 * only LIT perpetual, so that is what this points at.
 *
 * Two things about this are worth stating plainly rather than discovering
 * later. First, LITUSDC is a small-cap crypto perpetual, so none of the
 * calibrated models apply — the leverage ladder, the maintenance rate, the
 * session weights and the earnings calendar are all fitted to an equity perp on
 * a Nasdaq clock, and `isCalibrated` reports that rather than pretending
 * otherwise.
 *
 * Second, and more consequential: the cost arithmetic gets worse, not better.
 * On BTCUSDT the spread ran around 0.012bp and the modelled round trip $0.5826
 * a decision against a gross price contribution of $0.0223 — fees already 26x
 * gross. A thinner book means a wider spread and more slippage per unit size,
 * so the bar this has to clear rises. That is not a reason to refuse the
 * change; it is the number to watch first, and `spreadBps` in the shadow
 * summary is where it shows up.
 */
export const SYMBOL =
  (typeof process !== "undefined" ? process.env?.SWEEP_SYMBOL?.trim() : "") || "LITUSDT";

/**
 * Every contract watched at once.
 *
 *     SWEEP_SYMBOLS=INTCUSDT,SNDKUSDT,MUUSDT npm run sweep:control
 *
 * Why more than one, given the strategy is unchanged: the binding constraint on
 * this system is not how good each trade is, it is how often a setup appears.
 * A week of real trading averaged under five entries a day on one contract, and
 * every risk cap here is per-trade or per-day rather than per-symbol — so
 * watching three contracts roughly triples the number of chances at unchanged
 * risk per chance.
 *
 * That is only true while the caps stay account-wide. They do: the daily loss
 * budget, the trade counter, the cooldown and the open-position ceiling are all
 * counted across every desk, not per symbol. Three symbols is three times the
 * opportunity, not three times the exposure.
 *
 * The one thing it is *not* is diversification. Correlated names — memory,
 * semis — go down together, which is exactly why `maxOpenPositions` defaults to
 * 1: holding three at once is one position in the sector wearing three tickers.
 *
 * `SWEEP_SYMBOL` still works and means a list of one.
 */
export const SYMBOLS: string[] = (() => {
  const raw = typeof process !== "undefined" ? process.env?.SWEEP_SYMBOLS?.trim() : "";
  if (!raw) return [SYMBOL];
  const list = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  // Order is kept — the first is the default focus in the GUI — but duplicates
  // would otherwise mean two engines on one contract, each with its own
  // WebSocket, competing for the same rate limit.
  return list.length > 0 ? [...new Set(list)] : [SYMBOL];
})();

/**
 * Contracts the models below were built for.
 *
 * Everything in CONFIG describes an *equity* perpetual tracking a US-listed
 * stock: the leverage ladder assumes the 20x cap those carry, the session module
 * is the Nasdaq clock in US Eastern, and the earnings calendar is a US filing
 * calendar. On a crypto pair none of it means anything, and on an equity perp
 * listed elsewhere the session model — which is most of the edge here — is
 * simply the wrong clock.
 *
 * The maintenance margin rate is the looser one: it was measured on INTCUSDT and
 * is an approximation on any other contract, erring toward placing modelled
 * liquidations slightly nearer than they are.
 *
 * A symbol outside this set still runs; it is reported as uncalibrated in the
 * diagnostics rather than blocked, because proving the order path works is a
 * legitimate reason to point it at BTCUSDT.
 */
export const CALIBRATED_SYMBOLS = new Set(["INTCUSDT", "SNDKUSDT"]);

export function isCalibrated(symbol: string): boolean {
  return CALIBRATED_SYMBOLS.has(symbol.toUpperCase());
}

/** True when running against something the models were not built for. */
export const IS_CALIBRATED_SYMBOL = isCalibrated(SYMBOL);

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
   * Measured, not inferred. A real position on this contract — 1,400 contracts
   * at 101.58, so $142,212 of notional — carried $2,805 of maintenance margin,
   * which is this rate directly. Binance only exposes the bracket table over a
   * signed endpoint, and maintenance margin divided by notional needs neither
   * that nor any assumption about leverage or margin mode.
   *
   * An earlier value here was back-solved from a liquidation price instead.
   * That was unsound: under cross margin the liquidation price moves with the
   * whole wallet, so it cannot identify a rate belonging to one position. It
   * came out 18% low.
   *
   * Caveat that matters for sizing: this was measured at $142k of notional,
   * which is a higher bracket than anything this tool would propose. Smaller
   * positions sit in lower brackets at lower rates, so using this figure places
   * modelled liquidations slightly nearer than they really are — the safe
   * direction for a risk model to be wrong in.
   */
  maintenanceMarginRate: 0.0197,

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
