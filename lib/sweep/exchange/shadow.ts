import type { AgentState, ExecutionAdapter, TradeIntent } from "../agent/types";
import { proposePosition, type SizingConfig, type SizingLimits } from "../agent/sizing";
import { roundTripCost, type FeeSchedule, type StylePair } from "../metrics/fees";
import type { Cluster, CostPoint } from "../types";
import { captureConditions, type EntryConditions } from "../agent/postmortem";

/**
 * The whole decision path, against real prices, without an order.
 *
 * This is the thing that answers "does it work", and it is not the same
 * question as "does the plumbing work". Demo trading exercises signing, order
 * types and stop attachment against a synthetic book — useful once, and it
 * says nothing about the strategy, because the microstructure this tool reads
 * does not exist on a demo venue. Backtesting says nothing either, since every
 * threshold here was chosen by hand and a backtest of a guess only confirms the
 * guess.
 *
 * Shadow mode is the middle thing that is actually informative: real feed, real
 * book, real signals, real sizing, real fee arithmetic — and instead of an
 * order, a record of exactly what would have been sent, followed later by what
 * price actually did. It costs nothing, risks nothing, needs no credentials,
 * and produces the only evidence that matters before real money.
 *
 * Two honesty constraints are built in, because a shadow log that flatters
 * itself is worse than no log:
 *
 *  1. **Entry is priced where a real order would have gone**, not at the mid.
 *     A taker entry crosses the spread; a maker entry rests and may not fill at
 *     all. Filling every shadow entry at the mid is the single most common way
 *     a paper record beats a live one.
 *  2. **The outcome is measured against that entry price**, net of the round
 *     trip that the fee model says it would have cost, so a "winning" trade
 *     that would have lost to fees is recorded as a loss.
 */

export interface ShadowTrade {
  at: number;
  /** Which contract. Needed once one file holds rows from several desks. */
  symbol: string;
  intentId: string;
  signalKind: string;
  reason: string;
  side: "long" | "short";

  /** What the sizer produced. */
  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;
  quantity: number;
  notionalUsd: number;
  leverage: number;
  riskUsd: number;
  rewardRisk: number | null;

  /** How this would have executed, and what that costs. */
  style: StylePair;
  feeUsd: number;
  feeBps: number;
  fundingUsd: number;

  /** Market context at the moment of the decision, for splitting later. */
  mid: number;
  spreadBps: number;
  markoutToxicity: number | null;
  markoutInformed: number | null;
  intraday: string;
  biasConviction: number | null;

  /**
   * Filled in later. `pct` is measured from `entryPrice`, signed so that
   * positive is a win for the side taken, and `netUsd` has fees and funding
   * taken out.
   */
  outcomes: Record<string, { mid: number | null; pct: number | null; netUsd: number | null }>;

  /** Set when the stop or the target would have been hit inside the window. */
  resolved?: "stop" | "target" | "open";

  /**
   * Highest and lowest mid seen while the trade was open.
   *
   * Written by the runner from the same live feed the control server samples,
   * so the excursion derived from these is the same measurement the live path
   * takes rather than an approximation of it. That equivalence is what lets the
   * loss anatomy treat shadow and live rows identically.
   */
  high?: number;
  low?: number;

  /**
   * The full entry state, captured with the same function the live path uses.
   *
   * Without this a shadow row could only be grouped by the handful of context
   * fields above, and the conditional analysis — the part that most needs the
   * extra sample size shadow exists to provide — could not read it at all.
   */
  conditions?: EntryConditions;
}

export interface ShadowOptions {
  symbol: string;
  limits: () => SizingLimits;
  sizingConfig: () => Partial<SizingConfig>;
  fees: FeeSchedule;
  /** Free collateral to size against. Fixed, so results are comparable. */
  equity: number;
  getCostCurve: () => CostPoint[];
  getClusters: () => Cluster[];
  /** How the entry would have executed. Comes from the same test live uses. */
  entryStyle: (state: AgentState) => StylePair;
  onTrade: (trade: ShadowTrade) => void;
  onRefused?: (intent: TradeIntent, reasons: string[]) => void;
}

/**
 * An adapter that records instead of ordering.
 *
 * Deliberately implements the same interface as the live one and is driven by
 * the same runner, so the sequencing, the deduplication and the rate limits are
 * exercised too — not just the sizing. A shadow harness that reimplements the
 * loop tests a different program from the one that will run.
 */
export function createShadowAdapter(options: ShadowOptions): ExecutionAdapter & {
  trades: ShadowTrade[];
  refusals: number;
} {
  const trades: ShadowTrade[] = [];
  let refusals = 0;

  return {
    name: "shadow",
    trades,
    get refusals() {
      return refusals;
    },
    submit(intent: TradeIntent, state: AgentState) {
      const direction = intent.side === "buy" ? "up" : "down";
      const proposal = proposePosition({
        direction,
        state,
        equity: options.equity,
        // Shadow runs are not allowed to be stopped by yesterday's losses:
        // the question is what the signal was worth, and a day cap answered
        // separately. The trade caps in the runner still bound frequency.
        realisedLossToday: 0,
        tradesToday: trades.length,
        lastLossAt: 0,
        limits: options.limits(),
        costCurve: options.getCostCurve(),
        clusters: options.getClusters(),
        config: { ...options.sizingConfig(), fees: options.fees },
      });

      if (!proposal.ok) {
        refusals++;
        options.onRefused?.(intent, proposal.reasons);
        return;
      }

      const style = options.entryStyle(state);
      // Priced where a real order would have gone, not at the mid. A taker
      // crosses; a maker rests at the touch. Recording a mid fill is the usual
      // way a paper record quietly beats the live one it is meant to predict.
      const long = proposal.side === "long";
      const entryPrice =
        style.entry === "taker"
          ? (long ? state.bestAsk : state.bestBid) ?? proposal.entryPrice
          : (long ? state.bestBid : state.bestAsk) ?? proposal.entryPrice;

      const fees = roundTripCost(options.fees, proposal.notionalUsd, style, trades.length);

      trades.push({
        at: Date.now(),
        symbol: options.symbol,
        intentId: intent.id,
        signalKind: intent.signalKind,
        reason: intent.reason,
        side: proposal.side,
        entryPrice,
        stopPrice: proposal.stopPrice,
        targetPrice: proposal.targetPrice,
        quantity: proposal.quantity,
        notionalUsd: proposal.notionalUsd,
        leverage: proposal.leverage,
        riskUsd: proposal.riskUsd,
        rewardRisk: proposal.rewardRisk,
        style,
        feeUsd: fees.totalUsd,
        feeBps: fees.bps,
        fundingUsd: proposal.carry.costUsd,
        mid: state.mid ?? 0,
        spreadBps: state.liquidity?.spreadBps ?? 0,
        markoutToxicity: state.markout.warm ? state.markout.toxicity : null,
        markoutInformed: state.markout.warm ? state.markout.informed : null,
        intraday: state.session.intraday,
        biasConviction: intent.bias?.conviction ?? null,
        /*
         * The whole entry reading, captured with the function the live path uses.
         *
         * This field has existed on the type since the beginning, with a comment
         * saying the conditional analysis cannot read a shadow row without it —
         * and nothing ever assigned it. 2,052 rows were written with it absent,
         * so every depth bucket in the summary reported n=0 while the four
         * scalars above made the row look complete.
         *
         * The same `captureConditions` the live post-mortem calls, so a shadow
         * row and a live row group by identical fields. Anything else would make
         * the two pools uncomparable, which is the entire point of collecting
         * both.
         */
        conditions: captureConditions(state, proposal.side, {
          targetPrice: proposal.targetPrice,
          signalKind: intent.signalKind,
          sizeRetained: proposal.sizeRetained,
          // The read that chose the side. Without it a row records what was
          // decided and nothing about why, which is how 13,718 decisions came
          // out 3:1 long with no way to ask which factor leaned.
          bias: intent.bias ?? null,
        }),
        outcomes: {},
      });

      options.onTrade(trades[trades.length - 1]);
    },
  };
}

/**
 * Score a shadow trade against a later price.
 *
 * Net of the round trip and of funding, because a move that does not clear its
 * own costs is not a win however it looks on a chart — and at a 30-50bp target
 * against a 7-10bp round trip, that distinction changes the sign of a
 * meaningful share of trades.
 */
export function scoreShadow(
  trade: ShadowTrade,
  horizonKey: string,
  mid: number | null,
): void {
  if (mid === null || !(trade.entryPrice > 0)) {
    trade.outcomes[horizonKey] = { mid: null, pct: null, netUsd: null };
    return;
  }
  const raw = (mid - trade.entryPrice) / trade.entryPrice;
  const signed = trade.side === "long" ? raw : -raw;
  const grossUsd = signed * trade.notionalUsd;
  trade.outcomes[horizonKey] = {
    mid,
    pct: signed * 100,
    netUsd: grossUsd - trade.feeUsd - Math.max(0, trade.fundingUsd),
  };
}

/**
 * Would the stop or the target have been hit first?
 *
 * Called with the running high and low since entry. Order matters: when both
 * were touched inside the same window there is no way to know from
 * high/low alone which came first, so the stop is assumed — the pessimistic
 * reading, and the one that stops a shadow record from being systematically
 * better than reality.
 */
export function resolveShadow(trade: ShadowTrade, high: number, low: number): "stop" | "target" | "open" {
  const long = trade.side === "long";
  const stopHit = long ? low <= trade.stopPrice : high >= trade.stopPrice;
  const targetHit =
    trade.targetPrice !== null && (long ? high >= trade.targetPrice : low <= trade.targetPrice);

  if (stopHit) return "stop";
  if (targetHit) return "target";
  return "open";
}
