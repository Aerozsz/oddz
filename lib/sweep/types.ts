// Type-only, so the cycle with participants.ts (which imports Trade from here)
// is erased at compile time and never exists at runtime.
import type { ParticipantRead } from "./metrics/participants";

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

export interface SessionState {
  /** Regular Nasdaq cash hours. */
  cashOpen: boolean;
  phase: "pre-market" | "regular" | "after-hours" | "closed" | "weekend";
  /** ms until the next phase boundary. */
  msToNext: number;
  nextLabel: string;
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
  liquidations: Liquidation[];
  largeTrades: Trade[];
  thinning: ThinningEvent[];
  depthHistory: DepthSample[];
  /** Rolling per-second traded notional, buy and sell aggressor. */
  flow: { buy: number; sell: number };
  /** Recent realised movement of mid, as a percent-per-minute figure. */
  volatilityPct: number;
  /** What the book's behaviour suggests about who is quoting it. */
  participants: ParticipantRead | null;
}

export type { ParticipantRead } from "./metrics/participants";

export interface DepthSample {
  t: number;
  bid: number;
  ask: number;
  mid: number;
}
