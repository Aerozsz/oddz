import type { SweepFeed } from "./feed";
import type { AgentState, ExecutionAdapter, Signal, Strategy, TradeIntent } from "./types";

export interface ExecutionOptions {
  strategy: Strategy;
  adapter: ExecutionAdapter;
  /**
   * Minimum gap between two accepted intents, in ms. A cascade fires several
   * correlated signals within a second — a withdrawal, a cluster approach, a
   * liquidation burst are three views of one event, not three opportunities.
   */
  minIntervalMs?: number;
  /** Hard ceiling on accepted intents per rolling hour. */
  maxPerHour?: number;
  /** Called whenever an intent is refused, with the reason. */
  onRejected?: (reason: string, signal: Signal, intent: TradeIntent | null) => void;
  /** Called when the strategy looked at a signal and produced no intent. */
  onDeclined?: (signal: Signal, state: AgentState, reason: string | null) => void;
}

export interface ExecutionRunner {
  /** Stop consuming signals. Does not touch anything already submitted. */
  stop(): void;
  /**
   * Called by a strategy immediately before it returns null, to say why.
   *
   * Passing the reason back through the runner rather than having the caller
   * recompute it is the point: a bias evaluated a moment later can disagree
   * with the one that produced the decision, and reporting the later one
   * describes a state that arrived after the fact.
   */
  noteDecline(reason: string): void;
  stats(): {
    /**
     * Signals this runner received. Counted here rather than at the feed so
     * the columns add up: a counter attached when the engine starts includes
     * everything that fired before the loop was armed, which leaves a
     * permanent unexplained gap in the panel.
     */
    seen: number;
    accepted: number;
    rejected: number;
    /**
     * Signals the strategy looked at and passed on — most often because the
     * bias could not call a side. Counted separately from `rejected`, which
     * means an intent was formed and then refused. Without the distinction the
     * numbers do not add up, and "7 signals, 0 orders, 0 rejections" reads as a
     * broken loop rather than as a strategy that declined seven times.
     */
    declined: number;
    lastAcceptedAt: number;
  };
}

/**
 * Connects signals to an execution adapter, with the safety interlocks in one
 * place rather than in every strategy.
 *
 * The rules enforced here are the ones that must not be a strategy's choice:
 *
 *  1. Nothing is submitted unless the feed is `tradeable`. A degraded feed is
 *     not "trade smaller" — the numbers a strategy would size from are the ones
 *     that are wrong.
 *  2. An intent id is delivered at most once, so a re-fired signal or a
 *     reconnected consumer cannot double-submit.
 *  3. Rate and frequency ceilings apply regardless of how many signals arrive.
 *
 * What it deliberately does not do is decide anything about an order. Sizing,
 * leverage, order type, venue and account risk belong to the adapter, which is
 * yours — see ExecutionAdapter.
 */
export function attachExecution(feed: SweepFeed, options: ExecutionOptions): ExecutionRunner {
  const minIntervalMs = options.minIntervalMs ?? 30_000;
  const maxPerHour = options.maxPerHour ?? 12;

  const submitted = new Set<string>();
  let acceptedAt: number[] = [];
  let lastAcceptedAt = 0;
  let seen = 0;
  let accepted = 0;
  let rejected = 0;
  let declined = 0;

  /**
   * Set by a strategy through `noteDecline` to explain the null it is about to
   * return. Read once and cleared, so a stale reason cannot be attached to a
   * later decline that had a different cause.
   */
  let lastDeclineReason: string | null = null;

  const reject = (reason: string, signal: Signal, intent: TradeIntent | null) => {
    rejected++;
    options.onRejected?.(reason, signal, intent);
  };

  const unsubscribe = feed.onSignal((signal, state) => {
    seen++;
    // Checked before the strategy runs, so a strategy cannot be written in a
    // way that depends on being consulted during an outage.
    if (!state.health.tradeable) {
      reject(`feed not tradeable: ${state.health.summary}`, signal, null);
      return;
    }

    let intent: TradeIntent | null;
    try {
      intent = options.strategy(signal, state);
    } catch (err) {
      reject(`strategy threw: ${err instanceof Error ? err.message : String(err)}`, signal, null);
      return;
    }
    if (!intent) {
      declined++;
      // The strategy's own explanation, when it left one. Recomputing the bias
      // here instead would report a read taken a moment later, which can
      // disagree with the one that actually caused the decline — and did:
      // the panel showed "least resistance is upward" beside a declined
      // signal, describing a state that arrived after the decision.
      options.onDeclined?.(signal, state, lastDeclineReason);
      lastDeclineReason = null;
      return;
    }

    if (submitted.has(intent.id)) {
      reject(`duplicate intent ${intent.id}`, signal, intent);
      return;
    }

    const now = Date.now();
    if (now - lastAcceptedAt < minIntervalMs) {
      reject(`within the ${minIntervalMs}ms cooldown`, signal, intent);
      return;
    }

    acceptedAt = acceptedAt.filter((t) => now - t < 3_600_000);
    if (acceptedAt.length >= maxPerHour) {
      reject(`hourly ceiling of ${maxPerHour} reached`, signal, intent);
      return;
    }

    submitted.add(intent.id);
    acceptedAt.push(now);
    lastAcceptedAt = now;
    accepted++;

    void (async () => {
      try {
        await options.adapter.submit(intent, state);
      } catch (err) {
        console.error(`[sweep] adapter ${options.adapter.name} failed`, err);
      }
    })();
  });

  return {
    stop: unsubscribe,
    noteDecline(reason: string) {
      lastDeclineReason = reason;
    },
    stats: () => ({ seen, accepted, rejected, declined, lastAcceptedAt }),
  };
}

/**
 * Records intents instead of sending them. This is the default an integration
 * should run against until its own numbers have been checked against the tape
 * for a while — the signals here describe a market, they have not been shown to
 * be profitable, and nothing in this repository has been backtested.
 */
export function createDryRunAdapter(
  onIntent?: (intent: TradeIntent, state: AgentState) => void,
): ExecutionAdapter & { intents: TradeIntent[] } {
  const intents: TradeIntent[] = [];
  return {
    name: "dry-run",
    intents,
    submit(intent, state) {
      intents.push(intent);
      onIntent?.(intent, state);
      console.info(
        `[sweep dry-run] ${intent.side} · ${intent.reason} · ref ${intent.reference.mid} · confidence ${intent.confidence.toFixed(2)}`,
      );
    },
  };
}

/** Builds a well-formed intent id from the signal that caused it. */
export function intentId(signal: Signal, suffix = ""): string {
  return `intent:${signal.id}${suffix ? `:${suffix}` : ""}`;
}
