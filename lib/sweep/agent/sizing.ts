import type { Cluster, CostPoint, Direction } from "../types";
import type { AgentState } from "./types";

/**
 * Position sizing, computed per opportunity rather than fixed in advance.
 *
 * Three things this is not, stated up front because the gap between them and
 * what it is matters more than the arithmetic:
 *
 *  1. It does not identify market makers, bots or desks. Nothing in public
 *     market data says who sent an order. What is observable is behaviour —
 *     how quickly depth is replaced, and whether depth is leaving by being
 *     traded or by being cancelled — and that is what `makerPresence` below
 *     measures. It is a description of the book, not of who is standing in it.
 *
 *  2. It is not optimal. Optimal sizing requires knowing the edge, and the edge
 *     here is unmeasured — that is what the evidence log exists to establish.
 *     These rules are principled, which is a different and weaker claim.
 *
 *  3. It does not replace the caps. Every output is clamped to the configured
 *     limits afterwards. Sizing rules are the part most likely to be wrong, so
 *     they are not permitted to be the last word on exposure.
 *
 * The governing idea is fixed-fractional risk: decide what a losing trade costs
 * first, place the stop where the market says it belongs, and let size fall out
 * of the two. Size is never chosen directly, and leverage is a consequence
 * rather than an input — picking leverage first is how a position ends up sized
 * by what the account permits instead of by what the trade is worth.
 */

export interface SizingLimits {
  maxPositionUsd: number;
  maxLeverage: number;
  maxDailyLossUsd: number;
  stopLossPct: number;
}

export interface SizingConfig {
  /** Fraction of equity risked if the stop is hit. 0.005 = 0.5%. */
  riskFraction: number;
  /** Stop must clear this multiple of recent volatility to sit outside noise. */
  volatilityMultiple: number;
  /** Stop is placed this much beyond a cluster, in percent, to avoid the crowd. */
  clusterBufferPct: number;
  /** Entry may consume at most this share of depth inside the stop distance. */
  maxDepthShare: number;
  /** A target must be worth at least this multiple of the round-trip fee. */
  minRewardOverFees: number;
  /** Minimum acceptable reward-to-risk before a trade is worth taking. */
  minRewardRisk: number;
  takerFeeRate: number;
  /** Size is scaled by this when the cash market is shut. */
  closedSessionScale: number;
}

export const DEFAULT_SIZING: SizingConfig = {
  riskFraction: 0.005,
  volatilityMultiple: 2.5,
  clusterBufferPct: 0.15,
  maxDepthShare: 0.1,
  minRewardOverFees: 3,
  minRewardRisk: 1.5,
  takerFeeRate: 0.0005,
  closedSessionScale: 0.5,
};

export interface SizingInput {
  direction: Direction;
  state: AgentState;
  /** Free collateral in USDT. */
  equity: number;
  /** Loss already taken today, positive number. */
  realisedLossToday: number;
  limits: SizingLimits;
  /** Depth curve from the live book, for the liquidity cap. */
  costCurve: CostPoint[];
  clusters: Cluster[];
  config?: Partial<SizingConfig>;
}

export interface Proposal {
  ok: true;
  direction: Direction;
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  stopDistancePct: number;
  notionalUsd: number;
  quantity: number;
  /** Loss if the stop fills at its trigger. */
  riskUsd: number;
  rewardUsd: number | null;
  rewardRisk: number | null;
  leverage: number;
  marginUsd: number;
  roundTripFeeUsd: number;
  /** 0..1 — how much of the raw size survived the scaling factors. */
  sizeRetained: number;
  reasoning: string[];
}

export interface Refusal {
  ok: false;
  reasons: string[];
}

export type SizingResult = Proposal | Refusal;

/** Depth available within `pct` of mid on the side a stop would sweep. */
function depthWithin(curve: CostPoint[], pct: number, dir: Direction): number {
  const usable = curve.filter((c) => c.pct <= pct);
  const point = usable.at(-1) ?? curve[0];
  if (!point) return 0;
  const n = dir === "down" ? point.downNotional : point.upNotional;
  return n ?? 0;
}

/**
 * How present the passive side is.
 *
 * Depth leaving because it was traded is ordinary. Depth leaving because it was
 * cancelled means the quotes are being pulled, and whoever was standing there
 * has stepped back — which is exactly when an ordinary-sized order travels
 * furthest and when a fill is worst. Expressed as a 0..1 factor that shrinks
 * size as cancellation dominates.
 */
function makerPresence(state: AgentState): { factor: number; note: string } {
  // The behavioural read is preferred when it has enough evidence: how fast
  // depth is actually replaced is a more direct answer than how much of it left.
  const p = state.participants;
  if (p && p.confidence > 0.4) {
    if (p.regime === "liquidity-withdrawing") {
      return { factor: 0.4, note: `${p.notes[0] ?? "depth not being replaced"} — sizing down` };
    }
    if (p.regime === "hidden-size") {
      return { factor: 0.6, note: `${p.notes[0] ?? "repeated refills"} — a resting order is absorbing here` };
    }
    if (p.regime === "worked-order") {
      return { factor: 0.5, note: `${p.notes[0] ?? "sliced flow"} — trading alongside someone working size` };
    }
    if (p.regime === "liquidity-present") {
      return { factor: 1, note: p.notes[0] ?? "depth is being replaced quickly" };
    }
  }

  const liq = state.liquidity;
  if (!liq) return { factor: 0, note: "no depth reading" };
  const withdrawn = liq.withdrawnBid + liq.withdrawnAsk;
  const consumed = liq.consumedBid + liq.consumedAsk;
  const removed = withdrawn + consumed;
  if (removed <= 0) return { factor: 1, note: "book steady, nothing being pulled" };

  const cancelShare = withdrawn / removed;
  // 0% cancelled -> full size; 100% cancelled -> a quarter.
  const factor = Math.max(0.25, 1 - cancelShare * 0.75);
  return {
    factor,
    note: `${(cancelShare * 100).toFixed(0)}% of depth left by cancellation — passive side ${
      cancelShare > 0.6 ? "stepping away" : cancelShare < 0.25 ? "still present" : "partly withdrawn"
    }`,
  };
}

export function proposePosition(input: SizingInput): SizingResult {
  const cfg = { ...DEFAULT_SIZING, ...input.config };
  const { state, limits, direction } = input;
  const reasons: string[] = [];
  const reasoning: string[] = [];

  /* ---------------------------------------------------------- hard refusals */

  if (!state.health.tradeable) reasons.push(`feed not tradeable: ${state.health.summary}`);
  if (!state.mid || state.mid <= 0) reasons.push("no price");
  if (input.equity <= 0) reasons.push("no free collateral");
  if (limits.maxPositionUsd <= 0) reasons.push("max position size is 0 — set your caps first");
  if (state.liquidity && !state.liquidity.warm) {
    reasons.push("depth baseline not warm yet — the thinness reading would be meaningless");
  }
  if (limits.maxDailyLossUsd > 0 && input.realisedLossToday >= limits.maxDailyLossUsd) {
    reasons.push(`daily loss cap reached (${input.realisedLossToday.toFixed(2)} of ${limits.maxDailyLossUsd})`);
  }
  if (reasons.length) return { ok: false, reasons };

  const entry = state.mid as number;
  const long = direction === "up";

  /* ------------------------------------------------------------ stop placing */

  // Volatility floor: a stop inside recent noise is a donation.
  const volPct = state.volatilityPct ?? 0;
  const volFloor = volPct * cfg.volatilityMultiple;

  // Cluster-aware: the level a sweep would actually reach is just past where
  // everyone else's stops sit, so a stop resting short of that is the one the
  // sweep collects. Place beyond it instead.
  const adverse = long ? state.nearestBelow : state.nearestAbove;
  let clusterFloor = 0;
  if (adverse) {
    const distPct = Math.abs((adverse.price - entry) / entry) * 100;
    clusterFloor = distPct + cfg.clusterBufferPct;
    reasoning.push(
      `stop-loss build-up at ${adverse.price} sits ${distPct.toFixed(2)}% away; ` +
        `placing beyond it rather than in front of it`,
    );
  }

  const stopPct = Math.max(limits.stopLossPct, volFloor, clusterFloor);
  if (volFloor > limits.stopLossPct) {
    reasoning.push(`widened to ${stopPct.toFixed(2)}% — recent movement is ${volPct.toFixed(2)}% and a tighter stop sits inside the noise`);
  }
  const stopPrice = long ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);

  /* ------------------------------------------------------------- risk budget */

  let riskUsd = input.equity * cfg.riskFraction;
  reasoning.push(`risking ${(cfg.riskFraction * 100).toFixed(2)}% of ${input.equity.toFixed(2)} = ${riskUsd.toFixed(2)}`);

  if (limits.maxDailyLossUsd > 0) {
    const remaining = limits.maxDailyLossUsd - input.realisedLossToday;
    if (remaining < riskUsd) {
      riskUsd = Math.max(0, remaining);
      reasoning.push(`trimmed to ${riskUsd.toFixed(2)} — only that much of the daily loss cap is left`);
    }
  }

  const presence = makerPresence(state);
  const sessionScale = state.session.cashOpen ? 1 : cfg.closedSessionScale;
  if (!state.session.cashOpen) {
    reasoning.push(`Nasdaq ${state.session.phase} — halving size, the book is structurally thinner with no cash market to lean on`);
  }
  reasoning.push(presence.note);

  const rawRisk = riskUsd;
  riskUsd = riskUsd * presence.factor * sessionScale;

  /* -------------------------------------------------------------------- size */

  // Fixed fractional: a stop-out costs the risk budget, whatever the distance.
  let notional = (riskUsd / (stopPct / 100));

  const depth = depthWithin(input.costCurve, stopPct, direction);
  const depthCap = depth * cfg.maxDepthShare;
  if (depth > 0 && notional > depthCap) {
    notional = depthCap;
    reasoning.push(
      `capped at ${notional.toFixed(0)} — more than ${(cfg.maxDepthShare * 100).toFixed(0)}% of the ${depth.toFixed(0)} of depth inside the stop would move the price against the entry`,
    );
  }

  if (notional > limits.maxPositionUsd) {
    notional = limits.maxPositionUsd;
    reasoning.push(`capped at your ${limits.maxPositionUsd} maximum position size`);
  }

  /* ---------------------------------------------------------------- leverage */

  // Derived, not chosen: the smallest leverage that funds this notional, then
  // checked against the cap rather than used to justify a larger position.
  let leverage = Math.max(1, Math.ceil(notional / Math.max(input.equity, 1e-9)));
  if (leverage > limits.maxLeverage) {
    leverage = limits.maxLeverage;
    const affordable = input.equity * leverage;
    if (notional > affordable) {
      notional = affordable;
      reasoning.push(`reduced to ${notional.toFixed(0)} — ${limits.maxLeverage}x on ${input.equity.toFixed(2)} funds no more`);
    }
  }

  const quantity = notional / entry;
  const margin = notional / leverage;
  const actualRisk = notional * (stopPct / 100);
  const roundTripFee = notional * cfg.takerFeeRate * 2;

  /* ------------------------------------------------------------------ target */

  const favourable = long ? state.nearestAbove : state.nearestBelow;
  const targetPrice = favourable ? favourable.price : null;
  const rewardUsd = targetPrice ? Math.abs((targetPrice - entry) / entry) * notional : null;
  const rewardRisk = rewardUsd !== null && actualRisk > 0 ? rewardUsd / actualRisk : null;

  /* -------------------------------------------------------- viability checks */

  if (notional <= 0) return { ok: false, reasons: ["size worked out to zero after the caps"] };

  if (rewardUsd !== null && rewardUsd < roundTripFee * cfg.minRewardOverFees) {
    return {
      ok: false,
      reasons: [
        `the move to ${targetPrice} is worth ${rewardUsd.toFixed(2)} against ${roundTripFee.toFixed(2)} of fees — ` +
          `not enough to be worth the round trip`,
      ],
    };
  }
  if (rewardRisk !== null && rewardRisk < cfg.minRewardRisk) {
    return {
      ok: false,
      reasons: [`reward-to-risk is ${rewardRisk.toFixed(2)}, below the ${cfg.minRewardRisk} minimum`],
    };
  }
  if (margin > input.equity) {
    return { ok: false, reasons: [`needs ${margin.toFixed(2)} margin, only ${input.equity.toFixed(2)} free`] };
  }

  return {
    ok: true,
    direction,
    side: long ? "long" : "short",
    entryPrice: entry,
    stopPrice,
    targetPrice,
    stopDistancePct: stopPct,
    notionalUsd: notional,
    quantity,
    riskUsd: actualRisk,
    rewardUsd,
    rewardRisk,
    leverage,
    marginUsd: margin,
    roundTripFeeUsd: roundTripFee,
    sizeRetained: rawRisk > 0 ? riskUsd / rawRisk : 0,
    reasoning,
  };
}
