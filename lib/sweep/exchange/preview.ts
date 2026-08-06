import type { Cluster } from "../types";

/**
 * What a position would look like before it exists.
 *
 * The exchange shows size, margin and a liquidation price on the order ticket.
 * This reproduces that, and then does the thing the exchange cannot: checks the
 * liquidation price against the trigger clusters the monitor has mapped. A
 * liquidation sitting just past a cluster of other people's stops is not a
 * neutral number — it is the level a sweep is most likely to reach, because the
 * flow released there is what carries price the rest of the way.
 *
 * Every figure here is an estimate and is labelled as one. Binance's own
 * liquidation price is authoritative and accounts for the maintenance-amount
 * bracket for the position's notional tier, accrued funding, and — under cross
 * margin — the whole wallet rather than this position alone.
 */

export interface PreviewInput {
  side: "long" | "short";
  /** Position size in USD notional. Converted to quantity at entryPrice. */
  notionalUsd: number;
  leverage: number;
  entryPrice: number;
  /** Free collateral, for the affordability check. */
  availableBalance: number;
  /** Modelled maintenance margin rate, e.g. 0.015 for 1.5%. */
  maintMarginRate: number;
  takerFeeRate: number;
  makerFeeRate: number;
  /** Contract quantity step, for realistic rounding. */
  stepSize: number;
  pricePrecision: number;
  /** Mapped levels, so the liquidation can be read against them. */
  clusters: Cluster[];
}

export interface PreviewWarning {
  level: "info" | "warning" | "critical";
  message: string;
}

export interface Preview {
  side: "long" | "short";
  qty: number;
  notional: number;
  entryPrice: number;
  leverage: number;
  initialMargin: number;
  /** Estimated. See the note on the module. */
  liquidationPrice: number;
  /** How far price must travel against the position to liquidate it, percent. */
  liqDistancePct: number;
  entryFeeTaker: number;
  entryFeeMaker: number;
  /** Entry taker + exit taker — the realistic worst case for a market in/out. */
  roundTripFeeTaker: number;
  /** That fee as a percentage of the margin put up. */
  feeAsPctOfMargin: number;
  /** Price move needed just to cover a taker round trip, percent. */
  breakevenMovePct: number;
  balanceAfter: number;
  affordable: boolean;
  /** Amplifying clusters sitting between entry and the liquidation price. */
  clustersBeforeLiquidation: Cluster[];
  nearestClusterToLiquidation: { cluster: Cluster; distancePct: number } | null;
  warnings: PreviewWarning[];
}

function roundToStep(qty: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return qty;
  return Math.floor(qty / step) * step;
}

export function previewPosition(input: PreviewInput): Preview {
  const {
    side, leverage, entryPrice, availableBalance,
    maintMarginRate: mmr, takerFeeRate, makerFeeRate, stepSize, clusters,
  } = input;

  const warnings: PreviewWarning[] = [];
  const long = side === "long";

  const qty = roundToStep(input.notionalUsd / entryPrice, stepSize);
  const notional = qty * entryPrice;
  const initialMargin = leverage > 0 ? notional / leverage : notional;

  /*
   * Isolated-margin liquidation, derived rather than looked up:
   *
   *   loss at liquidation = initial margin − maintenance margin
   *   (EP − P)·q          = EP·q/L − mmr·P·q          [long]
   *
   * which rearranges to the expressions below. Cross margin liquidates later
   * because the rest of the wallet backs the position, so treating every
   * position as isolated is the conservative reading.
   */
  const liquidationPrice = long
    ? (entryPrice * (1 - 1 / leverage)) / (1 - mmr)
    : (entryPrice * (1 + 1 / leverage)) / (1 + mmr);

  const liqDistancePct = Math.abs((liquidationPrice - entryPrice) / entryPrice) * 100;

  const entryFeeTaker = notional * takerFeeRate;
  const entryFeeMaker = notional * makerFeeRate;
  const roundTripFeeTaker = entryFeeTaker * 2;
  const feeAsPctOfMargin = initialMargin > 0 ? (roundTripFeeTaker / initialMargin) * 100 : 0;
  const breakevenMovePct = takerFeeRate * 2 * 100;

  const balanceAfter = availableBalance - initialMargin - entryFeeTaker;
  const affordable = balanceAfter >= 0;

  /*
   * The point of doing this here rather than on the exchange: a position whose
   * liquidation sits beyond a cluster of stops is one where the move that
   * closes it is the move the cluster itself produces.
   */
  const amplifying = clusters.filter((c) => c.effect === "amplifying" && c.notional > 0);
  const clustersBeforeLiquidation = amplifying
    .filter((c) => (long ? c.price <= entryPrice && c.price >= liquidationPrice
                         : c.price >= entryPrice && c.price <= liquidationPrice))
    .sort((a, b) => (long ? b.price - a.price : a.price - b.price));

  let nearestClusterToLiquidation: Preview["nearestClusterToLiquidation"] = null;
  for (const c of amplifying) {
    const distancePct = Math.abs((c.price - liquidationPrice) / liquidationPrice) * 100;
    if (!nearestClusterToLiquidation || distancePct < nearestClusterToLiquidation.distancePct) {
      nearestClusterToLiquidation = { cluster: c, distancePct };
    }
  }

  if (!affordable) {
    warnings.push({
      level: "critical",
      message: `Not affordable: needs ${(initialMargin + entryFeeTaker).toFixed(2)} USDT of margin and fees, ${availableBalance.toFixed(2)} available.`,
    });
  }
  if (qty <= 0) {
    warnings.push({ level: "critical", message: "Size rounds to zero at this contract's step size." });
  }
  if (clustersBeforeLiquidation.length > 0) {
    const total = clustersBeforeLiquidation.reduce((s, c) => s + c.notional, 0);
    warnings.push({
      level: "critical",
      message:
        `${clustersBeforeLiquidation.length} amplifying cluster${clustersBeforeLiquidation.length === 1 ? "" : "s"} ` +
        `(${Math.round(total).toLocaleString()} USD modelled) sit between entry and liquidation. ` +
        `Flow released there pushes price toward this position's liquidation, not away from it.`,
    });
  }
  if (nearestClusterToLiquidation && nearestClusterToLiquidation.distancePct < 0.5 && clustersBeforeLiquidation.length === 0) {
    warnings.push({
      level: "warning",
      message: `Liquidation sits ${nearestClusterToLiquidation.distancePct.toFixed(2)}% from a mapped cluster at ${nearestClusterToLiquidation.cluster.price}.`,
    });
  }
  if (liqDistancePct < 3) {
    warnings.push({
      level: "warning",
      message: `Liquidation is only ${liqDistancePct.toFixed(2)}% away. Ordinary noise on this contract can cover that.`,
    });
  }
  if (feeAsPctOfMargin > 5) {
    warnings.push({
      level: "warning",
      message: `A taker round trip costs ${feeAsPctOfMargin.toFixed(1)}% of the margin put up; price must move ${breakevenMovePct.toFixed(3)}% just to break even.`,
    });
  }

  return {
    side, qty, notional, entryPrice, leverage, initialMargin,
    liquidationPrice, liqDistancePct,
    entryFeeTaker, entryFeeMaker, roundTripFeeTaker, feeAsPctOfMargin, breakevenMovePct,
    balanceAfter, affordable,
    clustersBeforeLiquidation, nearestClusterToLiquidation,
    warnings,
  };
}
