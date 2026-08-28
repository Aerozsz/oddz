import type {
  Cluster,
  Direction,
  EventRisk,
  FundingRead,
  MarkoutRead,
  ParticipantRead,
  SessionState,
  Side,
} from "../types";

/**
 * The agent-facing surface of the monitor.
 *
 * The dashboard's Snapshot is shaped for rendering: it carries book levels by
 * reference, a downsampled history for a canvas, tapes sized for a scroll pane.
 * None of that is what a decision needs, and depending on it would tie any
 * consumer to the layout. What follows is a separate, narrower projection —
 * stable field names, plain numbers, no references into engine-owned arrays.
 */

/* ------------------------------------------------------------------ health */

/**
 * Whether the feed is fit to act on. This is the first thing an execution layer
 * must read and the reason the layer exists at all: every number here is
 * derived from a continuous stream, and a stream that has stalled, desynced or
 * been rate-limited keeps producing *plausible* values rather than obviously
 * broken ones. A stale book still has a mid; a cascade still scores. Acting on
 * either is worse than not acting.
 *
 *  - `ok`       every input is live and the baselines are established
 *  - `degraded` usable, but something that feeds sizing is stale or unwarmed
 *  - `blind`    the book or the stream cannot be trusted; do not act
 */
export type HealthLevel = "ok" | "degraded" | "blind";

export interface FeedHealth {
  level: HealthLevel;
  /** True only at `ok`. Execution must gate on this and nothing looser. */
  tradeable: boolean;
  /** Machine-readable causes, most severe first. Empty when `ok`. */
  reasons: HealthReason[];
  /** Human-readable one-liner, for logs and for the UI. */
  summary: string;
  /** Age of the snapshot this was computed from, in ms. */
  snapshotAgeMs: number;
}

export type HealthReasonCode =
  | "socket-down"
  | "book-desynced"
  | "feed-stalled"
  | "no-price"
  | "rate-limited"
  | "snapshot-stale"
  | "baseline-cold"
  | "open-interest-stale"
  | "metadata-missing";

export interface HealthReason {
  code: HealthReasonCode;
  /** `blind` reasons veto trading; `degraded` ones only downgrade it. */
  severity: Exclude<HealthLevel, "ok">;
  detail: string;
}

/* ------------------------------------------------------------------ signals */

export type SignalKind =
  /** Depth left the band without being traded through — the precondition. */
  | "withdrawal"
  /** A resting wall vanished without prints against it. */
  | "wall-pulled"
  /** Modelled cascade risk crossed a band, in either direction. */
  | "cascade-risk"
  /** Price came within range of a significant amplifying cluster. */
  | "cluster-approach"
  /** Liquidations printed above a notional threshold inside a short window. */
  | "liquidation-burst"
  /**
   * Aggressive flow started marking out past the spread. Leading indicator of
   * withdrawal: quoting into it loses money, so depth is about to leave.
   */
  | "flow-toxic"
  /** A funding settlement is close enough to matter to an open position. */
  | "funding-window"
  /** A scheduled release entered or left its blackout window. */
  | "event-window"
  /** The tradeability gate changed state. Always emitted, never suppressed. */
  | "health";

export type SignalSeverity = "info" | "warning" | "critical";

export interface Signal {
  /** Stable and unique; safe to use for idempotent handling. */
  id: string;
  kind: SignalKind;
  t: number;
  severity: SignalSeverity;
  /** Which way this points, when it points anywhere. */
  direction: Direction | null;
  /** Price the signal is anchored to, when it has one. */
  price: number | null;
  /** One line, already written for a human. */
  detail: string;
  /** Kind-specific payload; see each detector for the shape it emits. */
  data: Record<string, number | string | boolean | null>;
}

/* -------------------------------------------------------------------- state */

export interface AgentLiquidity {
  /** Primary-band depth over its slow baseline. Below 1 is thinner than usual. */
  lwi: number;
  lwiBid: number;
  lwiAsk: number;
  /** Session-corrected; see LiquidityState.lwiAdj. Prefer these for decisions. */
  lwiAdj: number;
  lwiBidAdj: number;
  lwiAskAdj: number;
  /** False until the slow baseline means something; see LiquidityState.warm. */
  warm: boolean;
  imbalance: number;
  spreadBps: number;
  bidNotional: number;
  askNotional: number;
  /** Decomposition over the tracker's window, in USD. */
  withdrawnBid: number;
  withdrawnAsk: number;
  consumedBid: number;
  consumedAsk: number;
  windowSec: number;
}

export interface AgentCascade {
  direction: Direction;
  /** 0..100. */
  risk: number;
  /** Aggressive notional needed to set the first link off, in USD. */
  seedNotional: number;
  terminalPct: number;
  linkCount: number;
  firstClusterPrice: number | null;
}

/** What the news store says about right now, as numbers. */
export interface NewsPressure {
  /** 3 high, 2 medium, 1 low, 0 nothing, within the recent window. */
  impact: number;
  /** Minutes since the most recent item. Null when there is none. */
  minutesSince: number | null;
  /** Items in the last six hours. */
  count6h: number;
  /** The most recent headline, for display and the post-mortem. Never parsed. */
  latest: string | null;
  /**
   * The tape's own verdict, which arrives in milliseconds rather than minutes.
   *
   * Every network source here is at best seconds late and usually minutes. The
   * order book is not late — it is where the event happens. So this is folded
   * into the same `impact` the sizer reads, and in practice it is what fires
   * first on anything that matters.
   */
  shockLevel: number;
  shockReasons: string[];
  /**
   * How often this ticker is being mentioned across forums and social, against
   * its own baseline. 1 is normal.
   *
   * The only thing crowd sources are worth to a machine. Reading a Reddit thread
   * yields nothing actionable; a sixfold jump in how often BTC is named inside
   * five minutes says the crowd has noticed something, needs no judgement about
   * what any single post meant, and arrives well before a wire writes it up.
   * Folded into `impact` so it can only ever make the agent smaller, never
   * bolder — a chatter spike is not a direction.
   */
  chatterVelocity: number;
}

export const NO_NEWS: NewsPressure = {
  impact: 0, minutesSince: null, count6h: 0, latest: null,
  shockLevel: 0, shockReasons: [], chatterVelocity: 1,
};

export interface AgentState {
  ts: number;
  symbol: string;
  health: FeedHealth;
  session: SessionState;

  mid: number | null;
  mark: number | null;
  last: number | null;
  bestBid: number | null;
  bestAsk: number | null;

  liquidity: AgentLiquidity | null;
  cascadeUp: AgentCascade | null;
  cascadeDown: AgentCascade | null;

  /** Nearest amplifying cluster either side of mid, if any. */
  nearestAbove: Cluster | null;
  nearestBelow: Cluster | null;

  /** Recent movement, percent per minute. Used to keep stops out of the noise. */
  volatilityPct: number;
  /** Inferred from book behaviour, not from any identity. */
  participants: ParticipantRead | null;
  /**
   * Whether the aggressive side has been proven right. The only input here
   * scored against what happened next rather than against a model.
   */
  markout: MarkoutRead;
  /** Carry cost, and what the rate implies about which side is crowded. */
  funding: FundingRead;
  /** Scheduled releases. `blackout` is a hard stop for execution. */
  events: EventRisk;
  /**
   * Headlines live right now, reduced to something a decision can use.
   *
   * Deliberately not the text. Nothing here reads a story or takes a view on
   * what it means — inferring direction from a headline is how a news feed
   * becomes a random number generator with a narrative attached. All the agent
   * gets is "something significant is happening and how long ago", which is
   * enough to stand back from a market that is reacting and nothing more.
   */
  news: NewsPressure;
  openInterestNotional: number | null;
  longShortRatio: number | null;
  /** Rolling one-second aggressive flow, in USD. */
  flow: { buy: number; sell: number };
}

/* ---------------------------------------------------------------- execution */

/**
 * What a strategy proposes. Deliberately not an order: no quantity, no order
 * type, no venue. Turning an intent into an order means position sizing,
 * account state and risk limits that live in the execution layer, not here —
 * this module observes a market, it does not know what anyone's book looks
 * like.
 */
export interface TradeIntent {
  /** Derived from the signal, so re-delivery is detectable. */
  id: string;
  t: number;
  side: "buy" | "sell";
  /** The signal that produced it. */
  signalId: string;
  signalKind: SignalKind;
  /** Why, in one line — carry this into the order's client id or your log. */
  reason: string;
  /** 0..1, the strategy's own confidence. Not a probability. */
  confidence: number;
  /**
   * The read that chose the side, carried rather than collapsed to a letter.
   *
   * The one input that decides long or short was the one input never recorded.
   * Shadow rows came out 3:1 long over 13,718 decisions — a microstructure
   * signal meant to be symmetric taking three longs for every short — and the
   * question "which factor is off-centre" was unanswerable, because by the time
   * a row was written the composite had already been reduced to "buy".
   *
   * Averaged over thousands of decisions each factor should sit near zero; the
   * one that does not is the answer. Structurally shaped like the bias module's
   * output rather than importing it, because that module imports this one.
   */
  bias?: {
    /** Signed composite, −1 down to +1 up. */
    composite: number;
    conviction: number;
    factors: { name: string; score: number; weight: number }[];
  } | null;
  reference: {
    mid: number;
    /** Level the thesis is built on, when there is one. */
    trigger: number | null;
    /** Level at which the thesis is wrong, when the strategy names one. */
    invalidation: number | null;
  };
}

/**
 * Where a real trading implementation plugs in.
 *
 * Nothing in this repository places orders, holds an API key or signs a
 * request. An adapter is the seam where that code — yours, with your own
 * credentials and risk limits — receives intents. The runner guarantees only
 * what it can: it will not call you when the feed is not tradeable, and it will
 * not deliver the same intent id twice.
 */
export interface ExecutionAdapter {
  readonly name: string;
  submit(intent: TradeIntent, state: AgentState): Promise<void> | void;
}

/**
 * Maps state and a signal onto an intent, or declines by returning null.
 * Called only while the feed is tradeable.
 */
export type Strategy = (signal: Signal, state: AgentState) => TradeIntent | null;

export type { Direction, ParticipantRead, Side };
