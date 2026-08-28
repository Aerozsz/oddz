import { type Engine, getEngine } from "../engine";
import type { CascadePath, Cluster, ConnectionState, CostPoint, Snapshot } from "../types";
import { assessHealth } from "./health";
import { type SignalOptions, SignalEngine } from "./signals";
import { NO_NEWS, type AgentCascade, type AgentState, type NewsPressure, type Signal } from "./types";

export interface SweepFeedOptions {
  signals?: Partial<SignalOptions>;
  /** How many signals to retain for `recentSignals`. */
  historyLimit?: number;
  /**
   * Minimum gap between `onState` deliveries, in ms. The engine publishes at
   * 10Hz for a canvas; a decision loop rarely wants that and paying to rebuild
   * the projection ten times a second is waste. Signals are never throttled.
   */
  stateIntervalMs?: number;
  /**
   * Which contract to read. Ignored when `engine` is given — the engine already
   * knows its own symbol, and taking both would let them disagree.
   */
  symbol?: string;
  /** Injectable for tests. Defaults to the per-symbol shared engine. */
  engine?: Engine;
}

export interface SweepFeed {
  /** The current projection. Cheap; computed at most once per state interval. */
  getState(): AgentState;
  /**
   * Every mapped level, not just the nearest either side. Needed to answer
   * questions about a price that is not the current one — where a proposed
   * position's liquidation would sit, for instance.
   */
  getClusters(): Cluster[];
  /** Live depth curve, for sizing against how far an order would move price. */
  getCostCurve(): CostPoint[];
  /** Newest first. */
  recentSignals(limit?: number): Signal[];
  onSignal(cb: (signal: Signal, state: AgentState) => void): () => void;
  onState(cb: (state: AgentState) => void): () => void;
  /**
   * Socket state, including the per-event message counts.
   *
   * Deliberately not folded into AgentState: that is a decision-shaped view of
   * the market, and how many frames arrived on which stream is a fact about the
   * plumbing. It is exposed at all because the plumbing turned out to be able
   * to fail silently — depth alone keeps the socket healthy and the book
   * synced, so aggTrade delivered nothing for weeks behind a green panel.
   */
  getConnection(): ConnectionState;
  close(): void;
}

/**
 * A read-only, decision-shaped view of the running monitor.
 *
 * This does not start a second connection. It attaches to the same engine the
 * dashboard uses, so an agent and a human watching the same tab see numbers
 * derived from one book and one trade tape — no drift between what was acted on
 * and what was displayed.
 */
export function createSweepFeed(options: SweepFeedOptions = {}): SweepFeed {
  const historyLimit = options.historyLimit ?? 200;
  const stateIntervalMs = options.stateIntervalMs ?? 250;

  const engine = options.engine ?? getEngine(options.symbol);
  engine.start();
  const symbol = engine.symbol;

  const detector = new SignalEngine(options.signals);
  const signalListeners = new Set<(s: Signal, st: AgentState) => void>();
  const stateListeners = new Set<(st: AgentState) => void>();
  const history: Signal[] = [];

  let state = project(engine.getSnapshot(), symbol);
  let lastStateAt = 0;
  let closed = false;

  const unsubscribe = engine.subscribe(() => {
    if (closed) return;
    const snap = engine.getSnapshot();
    const now = Date.now();

    // Signals are edge-triggered, so every published snapshot has to be seen —
    // throttling detection would drop the transition rather than delay it.
    const health = assessHealth(snap, now);
    const signals = detector.detect(snap, health, now);

    const dueForState = now - lastStateAt >= stateIntervalMs;
    if (dueForState || signals.length > 0) {
      state = project(snap, symbol, now);
      lastStateAt = now;
    }

    for (const signal of signals) {
      history.unshift(signal);
      if (history.length > historyLimit) history.length = historyLimit;
      for (const cb of signalListeners) {
        try {
          cb(signal, state);
        } catch (err) {
          // One bad consumer must not stop the others, or the feed.
          console.error("[sweep] signal listener threw", err);
        }
      }
    }

    if (dueForState) {
      for (const cb of stateListeners) {
        try {
          cb(state);
        } catch (err) {
          console.error("[sweep] state listener threw", err);
        }
      }
    }
  });

  return {
    getState: () => state,
    getClusters: () => engine.getSnapshot().clusters,
    getCostCurve: () => engine.getSnapshot().liquidity?.costCurve ?? [],
    recentSignals: (limit = 50) => history.slice(0, limit),
    getConnection: () => engine.getSnapshot().connection,
    onSignal(cb) {
      signalListeners.add(cb);
      return () => signalListeners.delete(cb);
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    close() {
      closed = true;
      unsubscribe();
      signalListeners.clear();
      stateListeners.clear();
      // The engine is intentionally left running: it is shared with the
      // dashboard and with any other feed, and restarting it would throw away
      // the continuous history the withdrawal metrics depend on.
    },
  };
}

/* ------------------------------------------------------------- projection */

/**
 * How the live news store is read into state.
 *
 * Injected rather than imported so this module stays free of file access and
 * can run in the browser. The control server supplies the real reader; anything
 * that does not care gets NO_NEWS and behaves exactly as before.
 */
let readNewsPressure: ((symbol: string, now: number) => NewsPressure) | null = null;
export function attachNews(reader: (symbol: string, now: number) => NewsPressure) {
  readNewsPressure = reader;
}

function project(snap: Snapshot, symbol: string, now = Date.now()): AgentState {
  const health = assessHealth(snap, now);
  const liq = snap.liquidity;
  const mid = snap.mid;

  let nearestAbove: Cluster | null = null;
  let nearestBelow: Cluster | null = null;
  if (mid !== null) {
    for (const c of snap.clusters) {
      if (c.effect !== "amplifying") continue;
      if (c.price > mid) {
        if (!nearestAbove || c.price < nearestAbove.price) nearestAbove = c;
      } else if (c.price < mid) {
        if (!nearestBelow || c.price > nearestBelow.price) nearestBelow = c;
      }
    }
  }

  return {
    ts: snap.ts,
    symbol,
    health,
    news: readNewsPressure ? readNewsPressure(symbol, now) : NO_NEWS,
    session: snap.session,
    mid,
    mark: snap.mark?.markPrice ?? null,
    last: snap.last,
    bestBid: snap.bestBid,
    bestAsk: snap.bestAsk,
    liquidity: liq
      ? {
          lwi: liq.lwi,
          lwiBid: liq.lwiBid,
          lwiAsk: liq.lwiAsk,
          lwiAdj: liq.lwiAdj,
          lwiBidAdj: liq.lwiBidAdj,
          lwiAskAdj: liq.lwiAskAdj,
          warm: liq.warm,
          imbalance: liq.imbalance,
          spreadBps: liq.spreadBps,
          bidNotional: liq.primary.bidNotional,
          askNotional: liq.primary.askNotional,
          withdrawnBid: liq.decomp.withdrawnBid,
          withdrawnAsk: liq.decomp.withdrawnAsk,
          consumedBid: liq.decomp.consumedBid,
          consumedAsk: liq.decomp.consumedAsk,
          windowSec: liq.decomp.windowSec,
        }
      : null,
    cascadeUp: cascade(snap.cascadeUp),
    cascadeDown: cascade(snap.cascadeDown),
    nearestAbove,
    nearestBelow,
    volatilityPct: snap.volatilityPct,
    participants: snap.participants,
    markout: snap.markout,
    funding: snap.funding,
    events: snap.events,
    openInterestNotional: snap.openInterest?.notional ?? null,
    longShortRatio: snap.longShortRatio,
    flow: snap.flow,
  };
}

function cascade(path: CascadePath | null): AgentCascade | null {
  if (!path) return null;
  return {
    direction: path.direction,
    risk: path.risk,
    seedNotional: path.seedNotional,
    terminalPct: path.terminalPct,
    linkCount: path.links.length,
    firstClusterPrice: path.links[0]?.cluster.price ?? null,
  };
}
