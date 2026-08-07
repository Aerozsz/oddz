import {
  DEFAULT_FEES,
  type FeeBudget,
  type FeeSchedule,
  type RoundTrip,
  type StylePair,
  canPostEntry,
  feeBudget,
  roundTripCost,
} from "../metrics/fees";
import { type CarryEstimate, estimateCarry } from "../metrics/funding";
import type { ExecutionStyle } from "../metrics/fees";
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
  /** Refuse once this many trades have been taken today. Overtrading is the
   *  usual way a disciplined plan stops being one. */
  maxTradesPerDay: number;
  /** Wait this long after a loss before another entry is allowed. */
  lossCooldownMin: number;
  /** Refuse entirely while the Nasdaq cash market is shut. */
  requireCashOpen: boolean;
  /** Minimum reward-to-risk. Overrides the config default when higher. */
  minRewardRisk: number;
}

export interface SizingConfig {
  /** Fraction of equity risked if the stop is hit. 0.005 = 0.5%. */
  riskFraction: number;
  /** Stop must clear this multiple of recent volatility to sit outside noise. */
  volatilityMultiple: number;
  /** Stop is placed this much beyond a cluster, in percent, to avoid the crowd. */
  clusterBufferPct: number;
  /**
   * How far past the intended stop an adverse cluster may sit and still drag
   * the stop out beyond it.
   *
   * The risk this guards is real but local: a stop resting *just short* of
   * where the crowd's stops sit is the one a sweep collects on its way to them,
   * and it gets collected right before the reversal. That argument holds while
   * the cluster is near. It does not hold at any distance, and treating it as
   * though it did was a bug with teeth — a cluster 1.8% below a wanted 0.5%
   * stop pushed the stop to 1.95%, which is not the same trade. Four times the
   * loss on a stop-out, and every level ahead now has to be three times further
   * away to justify it, so most setups were refused for a reward that was never
   * the problem.
   *
   * Past this multiple, price reaching the cluster does not mean the stop was
   * badly placed — it means the trade was wrong, which is what a stop is for.
   */
  clusterReachMultiple: number;
  /** Entry may consume at most this share of depth inside the stop distance. */
  maxDepthShare: number;
  /**
   * Floor under the combined size derate.
   *
   * Not a fee argument — fees are proportional to notional on both sides of the
   * reward-over-fees test, so shrinking a position never makes it fail that
   * check, and an earlier version of this comment claiming otherwise was simply
   * wrong. What the floor actually guards is the difference between sizing down
   * and abstaining. Past some point they are the same decision, and it should
   * be made explicitly by a refusal that names its reason rather than implicitly
   * by a size asymptoting toward zero while every check still reports pass.
   *
   * Set low on purpose. The real fix for derates compounding into nothing is
   * not to clamp the result, it is to stop multiplying readings that are
   * measuring the same thing — see the aggregation below. This is the backstop
   * for whatever that still misses.
   */
  minSizeScale: number;
  /**
   * How much of each condition derate to actually apply, 0 to 1.
   *
   * The derates below are priors, not measurements — nobody has shown that an
   * overnight setup on this contract wins less often, only that the book is
   * thinner. Priors that shrink every position are a decision about expected
   * return wearing the clothes of a decision about risk, and the honest thing
   * is to make their strength a setting rather than a constant.
   *
   * This scales every one of them toward 1. What it deliberately does not touch
   * is the stop distance, the daily loss cap, the trade ceiling, the cooldown or
   * the reward-to-risk floor: those bound what a mistake costs, which is a
   * different question from how much conviction to size a good setup with.
   */
  derateStrength: number;
  /**
   * A target must be worth at least this multiple of the round-trip cost.
   *
   * Was 3, which was a prior rather than a measurement and turned out to be
   * wrong for the trades this is meant to take. Four real INTC winners moved
   * 0.165% to 0.287% against a round trip near 0.10% — a reward/cost between
   * 1.7x and 2.9x — and every one of them made money. A 3x floor refuses all
   * four, which is not conservatism, it is a threshold set above the edge it
   * was supposed to protect.
   *
   * 2 is still a real filter: it refuses anything where the venue takes more
   * than half of what the move is worth, which is where a strategy stops being
   * a strategy and becomes a rebate scheme for Binance. Below about 1.5 the
   * hit rate required to break even climbs past anything observed here.
   */
  minRewardOverFees: number;
  /**
   * Fallback reward-to-risk floor, used only when the limits do not set one.
   *
   * Deliberately a fallback rather than a floor. This was previously combined
   * with the configured limit by taking the larger of the two, which made the
   * operator's dial one-way: it could tighten the requirement and could not
   * loosen it, so moving it from 1.5 to 1.2 — or to 1.0 — changed nothing at
   * all and the setting silently lied. A control that only moves one way is
   * worse than no control, because it is debugged as though it worked.
   */
  minRewardRisk: number;
  /** Maker/taker rates, discounts, any escalating tier, and the day's budget. */
  fees: FeeSchedule;
  /**
   * How the exit is expected to execute. Kept separate from the entry because
   * the entry is a choice — it can be posted and waited on — while an exit is
   * usually a stop, and a stop is a market order by construction. Assuming a
   * maker exit would understate the cost of every proposal.
   */
  exitStyle: ExecutionStyle;
  /** Above this mark-out toxicity, an entry is assumed to cross rather than rest. */
  postableToxicity: number;
  /**
   * Whether the execution path can actually post an entry rather than cross.
   *
   * Defaults to false, and that default is load-bearing. The order layer sends
   * MARKET orders, so quoting a maker entry would advertise a 7bp round trip
   * that the system cannot deliver and then fill at 10bp — an error that makes
   * every proposal look better than the trade it produces, which is the worst
   * available direction to be wrong in. Flip this when post-only entries exist,
   * not before.
   */
  canPostEntries: boolean;
  /**
   * How long a position is assumed to be held, for funding purposes.
   *
   * An assumption, and named as one. It exists because funding is charged in a
   * lump at settlement rather than accruing, so the only way to know whether a
   * trade pays it is to know whether the trade is still open at the settlement
   * instant. Nothing here predicts an exit, so a working figure is used and the
   * carry it implies is reported alongside the proposal rather than hidden.
   */
  expectedHoldMin: number;
  /**
   * Refuse when funding would eat more than this share of the expected reward.
   * A microstructure trade aiming at 30bp does not survive a 15bp settlement.
   */
  maxFundingShareOfReward: number;
  /**
   * Refuse when mark-out says the passive side is being run over this badly.
   * Entering as a taker into toxic flow means crossing a spread that is about
   * to widen, against people who have been right.
   */
  maxToxicity: number;
}

export const DEFAULT_SIZING: SizingConfig = {
  riskFraction: 0.005,
  volatilityMultiple: 2.5,
  clusterBufferPct: 0.15,
  clusterReachMultiple: 1.5,
  maxDepthShare: 0.1,
  minSizeScale: 0.05,
  derateStrength: 1,
  minRewardOverFees: 2,
  minRewardRisk: 1.5,
  fees: DEFAULT_FEES,
  exitStyle: "taker",
  postableToxicity: 0.6,
  canPostEntries: false,
  expectedHoldMin: 30,
  maxFundingShareOfReward: 0.35,
  maxToxicity: 0.95,
};

export interface SizingInput {
  direction: Direction;
  state: AgentState;
  /** Free collateral in USDT. */
  equity: number;
  /** Loss already taken today, positive number. */
  realisedLossToday: number;
  /** Entries already taken today. */
  tradesToday: number;
  /**
   * Trade count used to select the fee tier. Defaults to `tradesToday`.
   *
   * Separate because the advisory path deliberately zeroes the day counters so
   * a suggestion is not suppressed by the daily caps — but the *price* of that
   * suggestion still has to be quoted at the tier actually in force, or the
   * numbers shown are cheaper than the trade would really be.
   */
  feeTierTradeCount?: number;
  /** Fees paid today, in USD. From the exchange ledger, not from memory. */
  feesPaidToday?: number;
  /** Today's profit *before* fees, in USD. Negative is fine. */
  grossProfitToday?: number;
  /** When the last losing trade closed, epoch ms. 0 when there has not been one. */
  lastLossAt: number;
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
  /** The full fee picture, including which side could be posted and which crossed. */
  fees: RoundTrip;
  /** Whether the entry was priced as a resting order, and why. */
  entryPostable: { ok: boolean; reason: string };
  /** Where the day's fee budget stands. */
  budget: FeeBudget;
  /** Funding over the assumed hold. Positive is paid, negative is received. */
  carry: CarryEstimate;
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
  if (limits.maxTradesPerDay > 0 && input.tradesToday >= limits.maxTradesPerDay) {
    reasons.push(`already took ${input.tradesToday} trades today, the cap is ${limits.maxTradesPerDay}`);
  }
  if (limits.lossCooldownMin > 0 && input.lastLossAt > 0) {
    const elapsedMin = (Date.now() - input.lastLossAt) / 60_000;
    if (elapsedMin < limits.lossCooldownMin) {
      reasons.push(
        `cooling off after a loss — ${Math.ceil(limits.lossCooldownMin - elapsedMin)} min left of ${limits.lossCooldownMin}`,
      );
    }
  }
  // The book is structurally thinner with no cash market to anchor it, which
  // is exactly when a stop is cheapest to reach. Refusing outright is stricter
  // than sizing down for it, and that is the point.
  if (limits.requireCashOpen && !state.session.cashOpen) {
    reasons.push(`Nasdaq is ${state.session.phase} — trading only while the cash market is open`);
  }
  // A scheduled release gaps price past every level in the model. Nothing here
  // applies across one, so this is a refusal rather than a size adjustment.
  if (state.events.blackout) {
    reasons.push(state.events.reason ?? "inside a scheduled-event blackout");
  }
  // Crossing the spread into flow that has been marking out against the passive
  // side means paying a spread that is about to widen, to people who have been
  // right. Whichever way the trade points, this is the wrong moment to be a taker.
  if (state.markout.warm && state.markout.toxicity >= cfg.maxToxicity) {
    reasons.push(
      `flow is toxic (${state.markout.toxicity.toFixed(2)}) — ${state.markout.notes[0] ?? "mark-out exceeds the spread"}`,
    );
  }
  // Every trade can pass its own reward-over-fees test and the day still end
  // with the venue taking most of what the edge produced. That is a winning
  // strategy being farmed rather than a losing one being found, so it needs a
  // cap of its own rather than being caught by the loss limit.
  const budget = feeBudget(cfg.fees, input.feesPaidToday ?? 0, input.grossProfitToday ?? 0);
  if (budget.exhausted) reasons.push(budget.reason ?? "daily fee budget spent");
  if (reasons.length) return { ok: false, reasons };

  const entry = state.mid as number;
  const long = direction === "up";

  /* ------------------------------------------------------------ stop placing */

  // Volatility floor: a stop inside recent noise is a donation.
  let volPct = state.volatilityPct ?? 0;
  // Realised volatility is a trailing window, so for the first minutes after a
  // session boundary it is still describing the phase that ended. Crossing into
  // the opening auction with a stop sized on overnight quiet is the specific
  // failure this covers; the phase multiplier stands in until the measurement
  // catches up, and then stops being applied.
  if (state.session.transitioning && state.session.weights.volScale > 1) {
    const lifted = volPct * state.session.weights.volScale;
    reasoning.push(
      `${state.session.intraday} started ${Math.round(state.session.msSincePhaseStart / 60_000)} min ago — ` +
        `measured volatility still describes the previous phase, so it is scaled ` +
        `${state.session.weights.volScale.toFixed(1)}x to ${lifted.toFixed(2)}% for the stop`,
    );
    volPct = lifted;
  }
  const volFloor = volPct * cfg.volatilityMultiple;

  // Where the stop wants to be before the crowd is considered: the operator's
  // configured distance, widened only if recent movement would put it inside
  // the noise.
  const baseStop = Math.max(limits.stopLossPct, volFloor);
  if (volFloor > limits.stopLossPct) {
    reasoning.push(
      `widened to ${baseStop.toFixed(2)}% — recent movement is ${volPct.toFixed(2)}% and a tighter stop sits inside the noise`,
    );
  }

  /*
   * Cluster-aware, but only within reach.
   *
   * A stop resting just short of where the crowd's stops sit is the one a sweep
   * collects on its way to them. That is worth stepping around — when the
   * cluster is near. When it sits far past where the stop was going anyway,
   * there is nothing to step around: price getting there means the trade was
   * wrong, and dragging the stop out to meet it multiplies the loss without
   * buying any protection. See clusterReachMultiple.
   */
  const adverse = long ? state.nearestBelow : state.nearestAbove;
  let clusterFloor = 0;
  if (adverse) {
    const distPct = Math.abs((adverse.price - entry) / entry) * 100;
    const withinReach = distPct <= baseStop * cfg.clusterReachMultiple;
    if (withinReach) {
      clusterFloor = distPct + cfg.clusterBufferPct;
      reasoning.push(
        `stop-loss build-up at ${adverse.price} sits ${distPct.toFixed(2)}% away, inside the ` +
          `${baseStop.toFixed(2)}% stop's reach; placing beyond it rather than in front of it`,
      );
    } else {
      reasoning.push(
        `stop-loss build-up at ${adverse.price} is ${distPct.toFixed(2)}% away — far past the ` +
          `${baseStop.toFixed(2)}% stop, so there is nothing to step around and the stop stays where it belongs`,
      );
    }
  }

  const stopPct = Math.max(baseStop, clusterFloor);
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

  // Per-phase rather than a flat halving when the cash market is shut. The two
  // sides of a lunchtime session and an overnight one are not the same book,
  // and neither is the opening auction — where depth is thin *and* every price
  // is being repriced on real information.
  const sessionScale = state.session.weights.sizeScale;
  if (sessionScale !== 1) {
    reasoning.push(
      `${state.session.intraday} — size at ${(sessionScale * 100).toFixed(0)}% ` +
        `(depth here typically runs ${state.session.weights.depthScale.toFixed(2)}x the regular session)`,
    );
  }

  // A projected earnings date derates; a confirmed one already refused above.
  const eventScale = state.events.sizeScale;
  if (eventScale < 1 && state.events.reason) reasoning.push(state.events.reason);

  reasoning.push(presence.note);

  /*
   * One combined derate, not three multiplied together.
   *
   * These were previously a product, and that was wrong for a reason that only
   * shows up at the extremes: they are not independent risks, they are three
   * views of one question — how far this book can be trusted right now.
   * Overnight books are thin *and* more prone to having quotes pulled, so the
   * session factor and the presence factor are largely reporting the same fact.
   * Multiplying correlated readings counts that fact two or three times.
   *
   * The arithmetic got indefensible fast. Overnight (0.25) with quotes leaving
   * (0.4) and a projected event (0.5) kept 3% of the intended risk — a 32-fold
   * reduction, which does not produce a careful trade, it produces a position
   * too small for the reward to clear its own fees. Every individual factor was
   * defensible and the product was not.
   *
   * So the most binding view governs, with a floor under it. That still sizes
   * down hard when any one reading is bad, still ranks conditions in the same
   * order, and cannot compound into a position that is not worth having.
   */
  const book: { name: string; scale: number }[] = [
    { name: presence.note, scale: presence.factor },
    { name: `the ${state.session.intraday} session`, scale: sessionScale },
  ];
  const binding = book.reduce((worst, s) => (s.scale < worst.scale ? s : worst), book[0]);
  const others = book.filter((s) => s !== binding).reduce((p, s) => p * s.scale, 1);
  /*
   * The most binding reading governs and the rest apply at half strength — in
   * logs, half the weight. Full compounding assumes independence they do not
   * have; the plain minimum assumes a correlation of one, which they also do
   * not have. `worst × sqrt(others)` sits between, is the identity when only
   * one reading is below full, and keeps the ordering intact.
   */
  const rawBookScale = binding.scale * Math.sqrt(others);

  // Toward 1 by however much the operator has dialled the priors down.
  const soften = (x: number) => 1 - cfg.derateStrength * (1 - x);
  const bookScale = soften(rawBookScale);

  /*
   * The event derate is orthogonal and does multiply.
   *
   * A scheduled release gapping price past every level in the model is not a
   * statement about whether the book can be trusted — it is a different risk
   * with a different mechanism, and it is the one case where stacking is the
   * honest arithmetic rather than double-counting.
   */
  const combinedScale = Math.max(cfg.minSizeScale, bookScale * soften(eventScale));
  if (combinedScale < 1) {
    reasoning.push(
      `size at ${(combinedScale * 100).toFixed(0)}% of the risk budget — set by ${binding.name}` +
        (cfg.derateStrength < 1
          ? ` (condition derates at ${(cfg.derateStrength * 100).toFixed(0)}% strength, so ${(rawBookScale * 100).toFixed(0)}% became ${(bookScale * 100).toFixed(0)}%)`
          : "") +
        (eventScale < 1 ? `, and again by the event window` : "") +
        (bookScale * eventScale < cfg.minSizeScale
          ? `, floored at ${(cfg.minSizeScale * 100).toFixed(0)}% — below that, sizing down and not trading are the same decision`
          : ""),
    );
  }

  const rawRisk = riskUsd;
  riskUsd = riskUsd * combinedScale;

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

  /* ------------------------------------------------------------------- fees */

  // Whether the entry can rest on the book is the largest single lever on net
  // return at this frequency — 4bp against 10bp on a target worth 30–50bp — and
  // it is decided by the mark-out reading rather than by preference.
  const wouldPost = canPostEntry(state.markout, cfg.postableToxicity);
  const postable = cfg.canPostEntries
    ? wouldPost
    : {
        ok: false,
        reason: wouldPost.ok
          ? `the book would allow a resting entry (${wouldPost.reason}), but the order layer only sends market orders — priced as a taker until post-only entries exist`
          : wouldPost.reason,
      };
  const style: StylePair = {
    entry: postable.ok ? "maker" : "taker",
    exit: cfg.exitStyle,
  };
  const fees = roundTripCost(cfg.fees, notional, style, input.feeTierTradeCount ?? input.tradesToday);
  const roundTripFee = fees.totalUsd;
  reasoning.push(
    `${postable.reason} — pricing the round trip at ${fees.bps.toFixed(1)}bp ` +
      `(${style.entry} in, ${style.exit} out), ${fees.breakevenPct.toFixed(3)}% just to break even` +
      (fees.tierNote ? ` · ${fees.tierNote}` : ""),
  );

  /* ------------------------------------------------------------------ target */

  /*
   * The nearest level that is actually worth reaching, not simply the nearest.
   *
   * Targeting the closest cluster made the sizer structurally unsatisfiable.
   * With a 0.5% stop and a 1.2 reward-to-risk floor a target has to be at least
   * 0.6% away, and the nearest cluster is routinely a tenth of that — so every
   * setup was refused for a reward that was never in question, and thousands of
   * signals produced no trades at all. "0.11 against 0.21 of costs" was not a
   * quiet market, it was the model aiming at something too close to be worth
   * hitting.
   *
   * A level nearer than the round trip is not a target, it is noise between
   * here and one. So the first level far enough to clear both the reward-to-risk
   * floor and the fees is chosen, and only if none exists is the trade refused
   * for having nothing to aim at.
   */
  /*
   * The operator's floor when they have set one; the config value only fills in
   * when they have not. Taking the larger of the two made the dial one-way.
   *
   * A floor below 1 is allowed rather than clamped, because whether it is sane
   * depends on a hit rate this code does not know and the operator might. The
   * break-even hit rate it implies is reported instead, so the choice is made
   * with the arithmetic visible rather than blocked on principle.
   */
  const requiredRR = limits.minRewardRisk > 0 ? limits.minRewardRisk : cfg.minRewardRisk;
  if (requiredRR < 1) {
    reasoning.push(
      `reward-to-risk floor is ${requiredRR.toFixed(2)}, which needs a ` +
        `${((1 / (1 + requiredRR)) * 100).toFixed(0)}% hit rate before fees just to break even`,
    );
  }
  const requiredDistPct = stopPct * requiredRR;
  const ahead = input.clusters
    .filter((c) => c.effect === "amplifying" && (long ? c.price > entry : c.price < entry))
    .map((c) => ({ c, distPct: Math.abs((c.price - entry) / entry) * 100 }))
    .filter((x) => x.distPct >= requiredDistPct)
    .sort((a, b) => a.distPct - b.distPct);

  const favourable = ahead[0]?.c ?? null;

  // Whether or not a target was found, say when a nearer level was passed over.
  // Skipping one silently is how the sizer's arithmetic became unreadable: the
  // refusal named a reward figure without saying which level it came from.
  const nearest = long ? state.nearestAbove : state.nearestBelow;
  const nearestPct = nearest ? Math.abs((nearest.price - entry) / entry) * 100 : null;
  if (nearestPct !== null && nearestPct < requiredDistPct) {
    reasoning.push(
      `nearest level ahead is only ${nearestPct.toFixed(2)}% away and ${requiredDistPct.toFixed(2)}% is needed ` +
        `to justify a ${stopPct.toFixed(2)}% stop — looking further out` +
        (favourable ? ` and targeting ${favourable.price} instead` : ", and there is nothing further out"),
    );
  }
  const targetPrice = favourable ? favourable.price : null;
  const rewardUsd = targetPrice ? Math.abs((targetPrice - entry) / entry) * notional : null;
  const rewardRisk = rewardUsd !== null && actualRisk > 0 ? rewardUsd / actualRisk : null;

  const carry = estimateCarry(
    state.funding,
    long ? "long" : "short",
    notional,
    cfg.expectedHoldMin * 60_000,
  );
  reasoning.push(
    carry.free
      ? `funding: ${carry.note}`
      : `funding over an assumed ${cfg.expectedHoldMin} min hold: ${carry.note}`,
  );

  /* -------------------------------------------------------- viability checks */

  /*
   * Every failing check, not the first one.
   *
   * These used to return early, one at a time, so a setup blocked by three
   * things took three rounds of watching-and-changing to understand — and each
   * round looked like a fresh problem rather than the same one. The refusal is
   * more useful as a list than as a headline, and the tally that groups them
   * only groups what it is given.
   */
  const failures: string[] = [];

  if (notional <= 0) failures.push("size worked out to zero after the caps");

  // Fees and funding are both costs of holding the position and are checked
  // against the same reward. Funding is the one that gets forgotten, because it
  // is invisible until the settlement instant and then arrives in full.
  const totalCost = roundTripFee + Math.max(0, carry.costUsd);
  if (rewardUsd !== null && rewardUsd < totalCost * cfg.minRewardOverFees) {
    failures.push(
      `the move to ${targetPrice} is worth ${rewardUsd.toFixed(2)} against ${totalCost.toFixed(2)} of costs ` +
        `(${roundTripFee.toFixed(2)} fees${carry.costUsd > 0 ? ` + ${carry.costUsd.toFixed(2)} funding` : ""}) — ` +
        `not enough to be worth the round trip`,
    );
  }
  if (rewardUsd !== null && carry.costUsd > 0 && carry.costUsd > rewardUsd * cfg.maxFundingShareOfReward) {
    failures.push(
      `funding would take ${carry.costUsd.toFixed(2)} of a ${rewardUsd.toFixed(2)} target ` +
        `(${((carry.costUsd / rewardUsd) * 100).toFixed(0)}% of it) — ${carry.note}. ` +
        `Either the target is too near or this is the wrong side of the carry.`,
    );
  }
  if (rewardRisk !== null && rewardRisk < requiredRR) {
    failures.push(`reward-to-risk is ${rewardRisk.toFixed(2)}, below the ${requiredRR} minimum`);
  }
  if (rewardRisk === null) {
    // The geometry, not just the verdict. "Nothing to target" is unactionable;
    // knowing the stop is 1.95% wide because of where the crowd sits, and that
    // this is what pushed the requirement out to 2.93%, is the whole answer.
    failures.push(
      `no level ahead is ${requiredDistPct.toFixed(2)}% away — that is what a ${stopPct.toFixed(2)}% stop ` +
        `at ${requiredRR} reward-to-risk needs, and the furthest amplifying cluster ahead is ` +
        (nearestPct !== null ? `${nearestPct.toFixed(2)}% out` : "not mapped yet"),
    );
  }
  if (margin > input.equity) {
    failures.push(`needs ${margin.toFixed(2)} margin, only ${input.equity.toFixed(2)} free`);
  }
  if (failures.length) return { ok: false, reasons: failures };

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
    fees,
    entryPostable: postable,
    budget,
    carry,
    sizeRetained: rawRisk > 0 ? riskUsd / rawRisk : 0,
    reasoning,
  };
}
