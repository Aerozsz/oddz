// Type-only, so the cycle with participants.ts (which imports Trade from here)
// is erased at compile time and never exists at runtime.
import type { ParticipantRead } from "./metrics/participants";
import type { EventRisk } from "./metrics/events";
import type { FundingRead } from "./metrics/funding";
import type { MarkoutRead } from "./metrics/markout";

export type Side = "bid" | "ask";
export type Direction = "up" | "down";

export interface SymbolMeta {
  symbol: string;
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  quantityPrecision: number;
  status: string;
  contractType: string;
}

export interface BookLevel {
  price: number;
  qty: number;
}

/** A single completed print off the aggTrade stream. */
export interface Trade {
  t: number;
  price: number;
  qty: number;
  notional: number;
  /** true when the buyer was the maker, i.e. an aggressive *sell*. */
  buyerIsMaker: boolean;
}

/** A forced order off the forceOrder stream — the "forced swaps" of the model. */
export interface Liquidation {
  t: number;
  price: number;
  qty: number;
  notional: number;
  /** Side of the liquidating order. A long being liquidated sends a SELL. */
  side: "BUY" | "SELL";
  /** Position that got closed out. */
  positionSide: "long" | "short";
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closed: boolean;
}

export interface MarkPrice {
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  t: number;
}

export interface BandDepth {
  bps: number;
  bidNotional: number;
  askNotional: number;
  bidQty: number;
  askQty: number;
}

export interface CostPoint {
  pct: number;
  /** Notional required to walk price this far. Null when the book can't reach. */
  downNotional: number | null;
  upNotional: number | null;
  /** True when the visible book is exhausted before the target is reached. */
  downExhausted: boolean;
  upExhausted: boolean;
}

export interface Wall {
  price: number;
  side: Side;
  notional: number;
  /** How many times the local median level size this is. */
  multiple: number;
  distBps: number;
}

export interface Decomposition {
  windowSec: number;
  /** Notional removed from the band by trades hitting it. */
  consumedBid: number;
  consumedAsk: number;
  /** Notional removed by cancellation — quotes that left rather than traded. */
  withdrawnBid: number;
  withdrawnAsk: number;
  /** Notional newly posted into the band. */
  addedBid: number;
  addedAsk: number;
}

export interface LiquidityState {
  bands: BandDepth[];
  primary: BandDepth;
  costCurve: CostPoint[];
  walls: Wall[];
  /** Current primary-band depth over its slow EWMA baseline. 1 = normal. */
  lwi: number;
  lwiBid: number;
  lwiAsk: number;
  /**
   * The same, corrected for the session.
   *
   * The raw index compares depth now against a ten-minute baseline. Across a
   * session boundary that baseline belongs to a different regime: at 16:00 ET
   * depth halves because the cash market shut, and the raw index reports a mass
   * withdrawal that nobody performed. These divide out the expected change, so
   * a reading below 1 means depth left *beyond* what the clock accounts for.
   */
  lwiAdj: number;
  lwiBidAdj: number;
  lwiAskAdj: number;
  /** Expected-depth multiplier the baseline accumulated at, over the current one. */
  sessionAdj: number;
  /**
   * Whether the slow baseline has seen enough data to mean anything. Until it
   * has, the indices above are pinned to 1 — indistinguishable from a genuinely
   * normal book, which is a difference anything trading off them has to know.
   */
  warm: boolean;
  baselineNotional: number;
  fastNotional: number;
  decomp: Decomposition;
  /** Imbalance in [-1, 1]; positive means bids outweigh asks. */
  imbalance: number;
  spreadBps: number;
}

export type ClusterSource =
  | "round"
  | "prior-high"
  | "prior-low"
  | "pivot-high"
  | "pivot-low"
  | "session-high"
  | "session-low"
  | "leverage-long"
  | "leverage-short"
  | "observed";

/**
 * Amplifying levels are market orders in the direction of the move — stops and
 * liquidations. Absorbing levels are resting limit orders on the far side —
 * take-profits and maker walls. Only amplifying levels can chain.
 */
export type ClusterEffect = "amplifying" | "absorbing";

export interface Cluster {
  price: number;
  effect: ClusterEffect;
  /** Direction this cluster pushes price if it fires. */
  pushes: Direction;
  /** Modelled notional, in USD. */
  notional: number;
  /** 0..1 — how much of the estimate rests on observed vs modelled evidence. */
  confidence: number;
  sources: ClusterSource[];
  /** Notional already consumed by prints at this level, decayed over time. */
  spent: number;
  distPct: number;
}

import type { CascadeCalibration } from "./metrics/cascade-outcomes";

export interface CascadeLink {
  cluster: Cluster;
  /** Notional of aggressive flow needed to walk price into this cluster. */
  costToReach: number;
  /** Of that, how much had to be modelled past the end of the visible book. */
  modelledPortion: number;
  /** Flow released by the cluster, net of absorbing liquidity on the way. */
  released: number;
  priceAfter: number;
}

export interface CascadePath {
  direction: Direction;
  /** Aggressive notional needed to set the first link off. */
  seedNotional: number;
  links: CascadeLink[];
  terminalPrice: number;
  terminalPct: number;
  /** 0..100. */
  risk: number;
}

export interface ThinningEvent {
  t: number;
  side: Side;
  withdrawn: number;
  consumed: number;
  /** Band depth after the event, as a fraction of baseline. */
  remainingFrac: number;
}

/**
 * Finer than `phase`: the equity market's intraday shape, which the perp
 * inherits through the people who hedge in it.
 */
export type IntradayPhase =
  | "pre-market"
  | "open-auction"
  | "morning"
  | "midday"
  | "afternoon"
  | "close-ramp"
  | "after-hours"
  | "overnight"
  | "weekend";

/**
 * Per-phase multipliers. Each has exactly one consumer — see metrics/session.ts.
 * Nothing here is applied twice, which is the trap with session adjustments: the
 * cascade cost is computed from the real book and already reflects a thin
 * overnight one, so scaling the risk score for the same reason would count it
 * again.
 */
export interface SessionWeights {
  /** Expected depth vs the regular session. Normalises the withdrawal index. */
  depthScale: number;
  /** Expected volatility vs the regular session. Widens stops across a boundary. */
  volScale: number;
  /** Multiplier on position size. */
  sizeScale: number;
}

export interface SessionState {
  /** Regular Nasdaq cash hours. */
  cashOpen: boolean;
  phase: "pre-market" | "regular" | "after-hours" | "closed" | "weekend";
  /** ms until the next phase boundary. */
  msToNext: number;
  nextLabel: string;
  intraday: IntradayPhase;
  weights: SessionWeights;
  msSincePhaseStart: number;
  /** True just after a boundary, while the EWMA baselines still lag it. */
  transitioning: boolean;
}

export type StreamName = "depth" | "aggTrade" | "forceOrder" | "markPrice" | "kline";

export interface ConnectionState {
  socket: "connecting" | "open" | "closed" | "error";
  bookSynced: boolean;
  resyncs: number;
  lastMessageAt: number;
  messagesPerSec: number;
  restVia: "direct" | "proxy" | "unknown";
  error: string | null;
  /**
   * Messages received per event type, cumulative.
   *
   * A combined socket carries five streams and reports one health. Depth alone
   * keeps `messagesPerSec` healthy and the book synced, so four consumers of a
   * second stream can sit silent behind a green panel indefinitely — which is
   * what happened: `aggTrade` reached no consumer, and mark-out, the flow read,
   * the participant model, the shock tape and the large-trade tape were all
   * dead while every surface said the feed was fine.
   *
   * Per type, because "the socket is up" and "this stream is arriving" are
   * different facts and only the second one is actionable.
   */
  byEvent: Record<string, number>;
  /**
   * The most recent frame that was not a stream payload, verbatim.
   *
   * Binance answers subscription problems on the market socket itself, in a
   * frame with no `stream` field. Those were discarded, so the only message
   * that could explain four silent streams was the only one guaranteed not to
   * be kept. Truncated, because a stray large frame should not bloat every
   * snapshot from here to the end of the run.
   */
  lastControlFrame: string | null;
  controlFrames: number;
  /** What was asked for, so it can be compared against what arrived. */
  subscribed: string[];
  /**
   * Frames per stream *name*, which is the level the fault lives at.
   *
   * byEvent counts by event type and so cannot distinguish "not subscribed"
   * from "subscribed and silent" — the two have opposite fixes and only this
   * tells them apart.
   */
  framesByStream: Record<string, number>;
  /**
   * State of any per-stream rescue socket opened for a silent subscription.
   *
   * Empty when the combined socket delivered everything. A socket that never
   * connects and one that connects and receives nothing are the same zero in
   * the frame counts and have opposite causes, so the state is kept separately.
   */
  fallbackStates: Record<string, string>;
  /**
   * Where the trade tape is actually coming from.
   *
   * "socket" is the intended path. "rest" means the aggTrade stream delivered
   * nothing and the tape is being polled instead — degraded but working, and it
   * must be visible, because a silently polled tape resolving a one-second
   * mark-out horizon two seconds late is a real measurement with a real error
   * in it, and nobody should read those numbers without knowing.
   */
  tapeVia: "socket" | "rest" | "rest-failing" | "none";
  tapePolledPrints: number;
}

export interface Snapshot {
  ts: number;
  meta: SymbolMeta | null;
  connection: ConnectionState;
  session: SessionState;
  mark: MarkPrice | null;
  last: number | null;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /**
   * `t` is Binance's own timestamp; `fetchedAt` is local. Age is measured from
   * the local one on purpose — a browser clock that disagrees with the exchange
   * would otherwise report a fresh figure as minutes old, or vice versa.
   */
  openInterest: { qty: number; notional: number; t: number; fetchedAt: number } | null;
  longShortRatio: number | null;
  liquidity: LiquidityState | null;
  /** Live book levels, passed by reference for the depth profile render. */
  bookBids: BookLevel[];
  bookAsks: BookLevel[];
  clusters: Cluster[];
  cascadeDown: CascadePath | null;
  cascadeUp: CascadePath | null;
  /** Whether the projection above has been borne out by the tape, and by how much. */
  cascadeCalibration: CascadeCalibration;
  liquidations: Liquidation[];
  largeTrades: Trade[];
  thinning: ThinningEvent[];
  depthHistory: DepthSample[];
  /** Rolling per-second traded notional, buy and sell aggressor. */
  flow: { buy: number; sell: number };
  /**
   * The same over a minute. A seed is a quantity of aggressive flow, so
   * progress toward one is only meaningful against a window long enough to
   * accumulate it — a single second never approaches the figure.
   */
  flowMinute: { buy: number; sell: number };
  /** Recent realised movement of mid, as a percent-per-minute figure. */
  volatilityPct: number;
  /** What the book's behaviour suggests about who is quoting it. */
  participants: ParticipantRead | null;
  /** Whether the aggressive side has been proven right lately. */
  markout: MarkoutRead;
  /** Carry, and what the rate implies about crowded positioning. */
  funding: FundingRead;
  /** Scheduled releases the model cannot see through. */
  events: EventRisk;
}

export type { ParticipantRead } from "./metrics/participants";
export type { EventRisk } from "./metrics/events";
export type { FundingRead } from "./metrics/funding";
export type { MarkoutRead } from "./metrics/markout";

export interface DepthSample {
  t: number;
  bid: number;
  ask: number;
  mid: number;
}
