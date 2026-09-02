import { toUnits } from "./abi";
import { exitFor, tokensToDrawdown } from "./exit";
import type { ClusterEvidence, Snapshot } from "./types";

/**
 * Wire format.
 *
 * bigint does not survive JSON, and shipping raw base units would force the
 * client to carry its own decimal math. Everything is converted once here,
 * server-side, where the token's decimals are known for certain.
 */

export interface WireBehavior {
  boughtTokens: number;
  soldTokens: number;
  /** Quote spent/received, valued at the CURRENT quote price — see costBasisIsApproximate. */
  spentUsd: number | null;
  receivedUsd: number | null;
  buyCount: number;
  sellCount: number;
  receivedOffMarket: number;
  sentOffMarket: number;
  avgEntryUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  distributionRatio: number;
  acquisition: "bought" | "farmed" | "mixed" | "none";
  firstTradeBlock: number | null;
  lastTradeBlock: number | null;
}

export interface WireEntity {
  id: string;
  rank: number;
  addresses: string[];
  addressCount: number;
  balance: number;
  share: number;
  kind: string;
  label: string | null;
  delta: number;
  prevRank: number | null;
  valueUsd: number | null;
  /** What the pool would actually pay for the whole position. */
  realizableUsd: number | null;
  /** Price impact of exiting the whole position, negative fraction. */
  exitImpact: number | null;
  /** realizableUsd / valueUsd. */
  recovery: number | null;
  behavior: WireBehavior;
  confidence: number;
  viaRelayer: boolean;
  evidence: ClusterEvidence[];
  firstSeenBlock: number;
  lastActiveBlock: number;
  transferCount: number;
}

export interface WireFlow {
  blockNumber: number;
  txHash: string;
  from: string;
  to: string;
  value: number;
  direction: string;
  valueUsd: number | null;
  priceUsd: number | null;
  /** Entity ids, so the feed can show the actor rather than the address. */
  fromEntity: string | null;
  toEntity: string | null;
}

export interface WireSnapshot {
  token: { address: string; symbol: string; name: string; decimals: number; totalSupply: number };
  chainId: number | null;
  entities: WireEntity[];
  relayers: { address: string; fanOut: number; txCount: number }[];
  clusteredAddresses: number;
  holderCount: number;
  trackedSupply: number;
  circulatingSupply: number;
  poolBalance: number;
  market: Snapshot["market"];
  pool: { reserveToken: number; reserveQuote: number; quoteDecimals: number; priceQuote: number | null } | null;
  concentration: Snapshot["concentration"];
  flows: WireFlow[];
  depthLadder: { sizeUsd: number; priceImpact: number }[];
  /** Tokens that must be sold to halve the price, and that as a share of float. */
  cascade: { tokensToHalve: number | null; shareOfFloat: number | null } | null;
  headBlock: number;
  indexedBlock: number;
  backfilling: boolean;
  backfillProgress: number;
  updatedAt: number;
  warnings: string[];
  /**
   * True when trade values were converted with the current quote price rather
   * than the price at the time of each trade. We have exact quote amounts from
   * the Swap events but no historical quote/USD series, so cost basis is
   * accurate in quote terms and approximate in dollar terms.
   */
  costBasisIsApproximate: boolean;
}

export function serialize(s: Snapshot): WireSnapshot {
  const d = s.token.decimals;
  const qd = s.pool?.quoteDecimals ?? 18;
  const quoteUsd = s.market.quoteUsd;
  const spot = s.market.priceUsd;

  const reserves =
    s.pool && s.pool.reserveToken > 0n && s.pool.reserveQuote > 0n
      ? { token: toUnits(s.pool.reserveToken, d), quote: toUnits(s.pool.reserveQuote, qd) }
      : null;

  // address -> entity id, so the flow feed can name the actor behind a hop.
  const entityOf = new Map<string, string>();
  for (const e of s.entities) for (const a of e.addresses) entityOf.set(a, e.id);

  const entities: WireEntity[] = s.entities.map((e) => {
    const balance = toUnits(e.balance, d);
    const bought = toUnits(e.behavior.boughtTokens, d);
    const sold = toUnits(e.behavior.soldTokens, d);
    const spentUsd =
      quoteUsd !== null ? toUnits(e.behavior.spentQuote, qd) * quoteUsd : null;
    const receivedUsd =
      quoteUsd !== null ? toUnits(e.behavior.receivedQuote, qd) * quoteUsd : null;
    const avgEntryUsd = spentUsd !== null && bought > 0 ? spentUsd / bought : null;
    const exit = reserves ? exitFor(balance, reserves, quoteUsd, spot) : null;

    return {
      id: e.id,
      rank: e.rank,
      addresses: e.addresses,
      addressCount: e.addresses.length,
      balance,
      share: e.share,
      kind: e.kind,
      label: e.label,
      delta: toUnits(e.delta, d),
      prevRank: e.prevRank,
      valueUsd: spot !== null ? balance * spot : null,
      realizableUsd: exit?.realizableUsd ?? null,
      exitImpact: exit?.priceImpact ?? null,
      recovery: exit?.recovery ?? null,
      behavior: {
        boughtTokens: bought,
        soldTokens: sold,
        spentUsd,
        receivedUsd,
        buyCount: e.behavior.buyCount,
        sellCount: e.behavior.sellCount,
        receivedOffMarket: toUnits(e.behavior.receivedOffMarket, d),
        sentOffMarket: toUnits(e.behavior.sentOffMarket, d),
        avgEntryUsd,
        // Realized PnL uses average-cost basis. A wallet that only ever
        // received tokens off-market has no cost basis to net against, so it
        // reports null rather than booking the full proceeds as profit.
        realizedPnlUsd:
          receivedUsd !== null && avgEntryUsd !== null ? receivedUsd - sold * avgEntryUsd : null,
        unrealizedPnlUsd:
          spot !== null && avgEntryUsd !== null ? balance * (spot - avgEntryUsd) : null,
        distributionRatio: e.behavior.distributionRatio,
        acquisition: e.behavior.acquisition,
        firstTradeBlock: e.behavior.firstTradeBlock,
        lastTradeBlock: e.behavior.lastTradeBlock,
      },
      confidence: e.confidence,
      viaRelayer: e.viaRelayer,
      evidence: e.evidence.slice(0, 6),
      firstSeenBlock: e.firstSeenBlock,
      lastActiveBlock: e.lastActiveBlock,
      transferCount: e.transferCount,
    };
  });

  const flows: WireFlow[] = s.flows.map((f) => {
    const value = toUnits(f.value, d);
    const quote = f.quoteValue !== null ? toUnits(f.quoteValue, qd) : null;
    return {
      blockNumber: f.blockNumber,
      txHash: f.txHash,
      from: f.from,
      to: f.to,
      value,
      direction: f.direction,
      valueUsd: quote !== null && quoteUsd !== null ? quote * quoteUsd : null,
      priceUsd: f.priceQuote !== null && quoteUsd !== null ? f.priceQuote * quoteUsd : null,
      fromEntity: entityOf.get(f.from) ?? null,
      toEntity: entityOf.get(f.to) ?? null,
    };
  });

  const float = toUnits(s.circulatingSupply, d);
  const tokensToHalve = reserves ? tokensToDrawdown(0.5, reserves) : null;

  return {
    token: {
      address: s.token.address,
      symbol: s.token.symbol,
      name: s.token.name,
      decimals: d,
      totalSupply: toUnits(s.token.totalSupply, d),
    },
    chainId: s.chainId,
    entities,
    relayers: s.relayers.slice(0, 10),
    clusteredAddresses: s.clusteredAddresses,
    holderCount: s.holderCount,
    trackedSupply: toUnits(s.trackedSupply, d),
    circulatingSupply: float,
    poolBalance: toUnits(s.poolBalance, d),
    market: s.market,
    pool: s.pool
      ? {
          reserveToken: toUnits(s.pool.reserveToken, d),
          reserveQuote: toUnits(s.pool.reserveQuote, qd),
          quoteDecimals: qd,
          priceQuote: s.pool.priceQuote,
        }
      : null,
    concentration: s.concentration,
    flows,
    depthLadder: s.depthLadder,
    cascade: {
      tokensToHalve,
      shareOfFloat: tokensToHalve !== null && float > 0 ? tokensToHalve / float : null,
    },
    headBlock: s.headBlock,
    indexedBlock: s.indexedBlock,
    backfilling: s.backfilling,
    backfillProgress: s.backfillProgress,
    updatedAt: s.updatedAt,
    warnings: s.warnings,
    costBasisIsApproximate: true,
  };
}
