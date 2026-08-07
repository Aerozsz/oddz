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
  onDeclined?: (signal: Signal, state: AgentState) => void;
}

export interface ExecutionRunner {
  /** Stop consuming signals. Does not touch anything already submitted. */
  stop(): void;
  stats(): {
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
  let accepted = 0;
  let rejected = 0;
  let declined = 0;

  const reject = (reason: string, signal: Signal, intent: TradeIntent | null) => {
    rejected++;
    options.onRejected?.(reason, signal, intent);
  };

  const unsubscribe = feed.onSignal((signal, state) => {
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
      options.onDeclined?.(signal, state);
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
    stats: () => ({ accepted, rejected, declined, lastAcceptedAt }),
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
