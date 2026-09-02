/**
 * Types for the live holder tracker.
 *
 * Balances are carried as bigint in raw base units and only converted to a
 * float at the render boundary. A 128,910-token position at 18 decimals does
 * not survive a round trip through Number, and a holder table that quietly
 * loses the low digits of a balance is worse than no table.
 */

/** What an address is, as far as chain state alone can tell us. */
export type AddressKind =
  | "pair" // the AMM pool itself — its balance is the float's other side
  | "zero" // 0x0 / 0xdead: mint source and burn sink
  | "contract" // has bytecode: vault, farm, router, bridge, multisig
  | "wallet"; // no bytecode at head — an EOA

/**
 * Per-wallet trading behavior, reconstructed from Transfer logs joined to the
 * pair's Swap events by transaction hash.
 *
 * Quote amounts are exact and stay in quote units. They are NOT converted to
 * USD here: we have no historical quote/USD series, and multiplying an old
 * trade by today's quote price would invent a cost basis rather than measure
 * one. The render layer converts with the current quote price and says so.
 */
export interface Behavior {
  /** Tokens received directly from the pair — i.e. bought. */
  boughtTokens: bigint;
  /** Tokens sent directly to the pair — i.e. sold. */
  soldTokens: bigint;
  /** Quote paid across all buys, exact, in quote base units. */
  spentQuote: bigint;
  /** Quote received across all sells, exact, in quote base units. */
  receivedQuote: bigint;
  buyCount: number;
  sellCount: number;
  /** Tokens received from somewhere that is not the pair: farm claims,
   *  bridge unlocks, OTC, team allocations. The un-bought supply. */
  receivedOffMarket: bigint;
  /** Tokens sent somewhere that is not the pair. */
  sentOffMarket: bigint;
  firstTradeBlock: number | null;
  lastTradeBlock: number | null;
  /** Tokens sold as a share of everything ever acquired (0..1). */
  distributionRatio: number;
  /**
   * How this wallet got its position. "farmed" is the one that matters for
   * dump risk: a wallet with a large balance and no buys paid nothing for it.
   */
  acquisition: "bought" | "farmed" | "mixed" | "none";
}

export interface Holder {
  address: string;
  balance: bigint;
  /** Share of circulating float (pool and burns excluded from the base). */
  share: number;
  kind: AddressKind;
  /** Human label when we can pin one down ("RIPE/NVDA pool", "burn"). */
  label: string | null;
  /** Block at which this address first held a non-zero balance. */
  firstSeenBlock: number;
  lastActiveBlock: number;
  totalIn: bigint;
  totalOut: bigint;
  transferCount: number;
  /** Balance change since the previous published snapshot. */
  delta: bigint;
  /** Rank in the previous snapshot; null if new to the tracked set. */
  prevRank: number | null;
  behavior: Behavior;
}

/** One Transfer, kept for the live flow feed. */
export interface Flow {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  /** Classified against the pair. A transfer into the pair is a sell. */
  direction: "buy" | "sell" | "mint" | "burn" | "move";
  /** Quote leg of the same transaction, when this was a swap. */
  quoteValue: bigint | null;
  /** Execution price in quote units per token, when this was a swap. */
  priceQuote: number | null;
}

/** Live market overlay. DexScreener first, GeckoTerminal as fallback. */
export interface MarketState {
  source: "dexscreener" | "geckoterminal" | "reserves" | "none";
  priceUsd: number | null;
  /** USD price of one quote token, used to value the exact on-chain quote
   *  amounts the log replay produces. */
  quoteUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  buys24h: number | null;
  sells24h: number | null;
  pairAddress: string | null;
  quoteSymbol: string | null;
  fetchedAt: number;
  /** Populated when every configured price source failed. */
  error: string | null;
}

/** Live pool reserves, read from the pair's own Sync events. */
export interface PoolState {
  reserveToken: bigint;
  reserveQuote: bigint;
  tokenIsToken0: boolean;
  quoteDecimals: number;
  /** Spot price in quote per token, straight from the reserve ratio. */
  priceQuote: number | null;
  updatedBlock: number;
}

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: bigint;
}

export interface Snapshot {
  token: TokenMeta;
  chainId: number | null;
  holders: Holder[];
  holderCount: number;
  /** Supply actually accounted for by the log replay. */
  trackedSupply: bigint;
  /** Supply excluding the pool balance and burns — the float that can sell. */
  circulatingSupply: bigint;
  poolBalance: bigint;
  market: MarketState;
  pool: PoolState | null;
  concentration: {
    top1: number;
    top5: number;
    top10: number;
    top25: number;
    /** Herfindahl index over the float. 1.0 = one holder owns everything. */
    hhi: number;
    /** Largest holder's balance as a multiple of the pool's token reserve. */
    top1OverPool: number | null;
  };
  /** Addresses folded into economic actors. This is the ranked view. */
  entities: RankedEntity[];
  /** Signers judged to be shared infrastructure rather than an identity. */
  relayers: { address: string; fanOut: number; txCount: number }[];
  /** How many addresses collapsed into a multi-address entity. */
  clusteredAddresses: number;
  flows: Flow[];
  /** Slippage ladder for fixed USD sizes against the live reserves. */
  depthLadder: { sizeUsd: number; priceImpact: number }[];
  headBlock: number;
  /** Block the replay has consumed up to. */
  indexedBlock: number;
  backfilling: boolean;
  backfillProgress: number;
  updatedAt: number;
  /** Non-fatal problems, surfaced rather than hidden. */
  warnings: string[];
}

// ------------------------------------------------------------------ entities
export type EntityKind = AddressKind;

/** Why two addresses were judged to be the same actor. */
export interface ClusterEvidence {
  kind:
    | "shared-signer"
    | "pass-through"
    | "sole-funder"
    | "amount-echo"
    | "consolidation"
    | "co-timing";
  a: string;
  b: string;
  weight: number;
  detail: string;
}

/**
 * A set of addresses that behaves as one economic actor.
 *
 * Ranking entities rather than addresses is the point of the clustering pass:
 * a position deliberately split across six wallets is one seller, and a table
 * that shows it as six holders understates the concentration it exists to
 * measure.
 */
export interface Entity {
  /** The entity's primary (largest-balance) address, used as its id. */
  id: string;
  addresses: string[];
  balance: bigint;
  firstSeenBlock: number;
  lastActiveBlock: number;
  transferCount: number;
  behavior: Behavior;
  evidence: ClusterEvidence[];
  /** 0..1. Exactly 1 for a singleton, which needs no inference. */
  confidence: number;
  kind: EntityKind;
}

/** An entity as presented in the ranked table. */
export interface RankedEntity extends Entity {
  rank: number;
  share: number;
  label: string | null;
  delta: bigint;
  prevRank: number | null;
  /** Set when the actor moved tokens through an address it does not control. */
  viaRelayer: boolean;
}
