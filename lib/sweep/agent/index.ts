/**
 * Programmatic access to the liquidity-sweep monitor.
 *
 * The dashboard at /sweep is one consumer of the engine; this is the other. It
 * exposes the same live state as a decision-shaped projection, turns it into
 * discrete signals, and provides the seam where an execution implementation
 * attaches.
 *
 * Minimal use:
 *
 * ```ts
 * import { createSweepFeed } from "@/lib/sweep/agent";
 *
 * const feed = createSweepFeed();
 * feed.onSignal((signal, state) => {
 *   if (!state.health.tradeable) return;
 *   console.log(signal.kind, signal.detail);
 * });
 * ```
 *
 * With an execution adapter:
 *
 * ```ts
 * import { attachExecution, createDryRunAdapter, createSweepFeed, intentId } from "@/lib/sweep/agent";
 *
 * const feed = createSweepFeed();
 * attachExecution(feed, {
 *   adapter: createDryRunAdapter(),
 *   strategy: (signal, state) =>
 *     signal.kind === "withdrawal" && signal.direction === "down" && state.liquidity!.lwi < 0.7
 *       ? {
 *           id: intentId(signal),
 *           t: Date.now(),
 *           side: "sell",
 *           signalId: signal.id,
 *           signalKind: signal.kind,
 *           reason: signal.detail,
 *           confidence: 0.4,
 *           reference: {
 *             mid: state.mid!,
 *             trigger: state.nearestBelow?.price ?? null,
 *             invalidation: state.bestAsk,
 *           },
 *         }
 *       : null,
 * });
 * ```
 *
 * Two things to be clear about before this is pointed at a live account.
 *
 * Nothing here places an order, holds a key or signs a request, and that is
 * deliberate rather than unfinished. `ExecutionAdapter` is where your own code
 * — with your credentials, position sizing and risk limits — receives intents.
 *
 * And the signals are descriptive, not validated. They report a mechanism the
 * monitor can observe: depth leaving the book without being traded through, and
 * price approaching levels where triggers are estimated to rest. Cluster sizes
 * are modelled, not published by anyone. None of it has been backtested, and a
 * correct reading of the order book is not the same as an edge.
 */

export { createSweepFeed, type SweepFeed, type SweepFeedOptions } from "./feed";
export { assessHealth } from "./health";
export { DEFAULT_SIGNAL_OPTIONS, SignalEngine, type SignalOptions } from "./signals";
export {
  attachExecution,
  createDryRunAdapter,
  intentId,
  type ExecutionOptions,
  type ExecutionRunner,
} from "./execution";
export type {
  AgentCascade,
  AgentLiquidity,
  AgentState,
  ExecutionAdapter,
  FeedHealth,
  HealthLevel,
  HealthReason,
  HealthReasonCode,
  Signal,
  SignalKind,
  SignalSeverity,
  Strategy,
  TradeIntent,
} from "./types";
