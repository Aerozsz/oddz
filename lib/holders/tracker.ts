import { log } from "@/lib/logger";
import {
  SELECTOR,
  decodeReserves,
  decodeString,
  decodeUint,
  encodeBalanceOf,
  padAddress,
  toUnits,
} from "./abi";
import { BURN_ADDRESSES, ZERO_ADDRESS, type TrackerConfig } from "./config";
import { depthLadder } from "./exit";
import { Ledger, priceFromReserves } from "./ledger";
import { buildEntities, cluster } from "./cluster";
import { EMPTY_MARKET, getMarket } from "./market";
import { RpcClient } from "./rpc";
import type {
  AddressKind,
  Behavior,
  Entity,
  Holder,
  MarketState,
  PoolState,
  RankedEntity,
  Snapshot,
  TokenMeta,
} from "./types";

/**
 * Orchestrates one tracked token: bootstraps metadata, advances the log
 * replay, and assembles snapshots.
 *
 * One instance per token, cached at module scope. Next.js may recycle the
 * process between requests, in which case the tracker rebuilds from scratch —
 * correctness never depends on the cache surviving, only latency does.
 */
export class Tracker {
  private rpc: RpcClient;
  private ledger: Ledger | null = null;
  private token: TokenMeta | null = null;
  private pool: PoolState | null = null;
  private chainId: number | null = null;
  private kinds = new Map<string, AddressKind>();
  /** txHash -> tx.from, the address that actually signed. Cached forever:
   *  a mined transaction's sender never changes. */
  private signers = new Map<string, string>();
  private relayers: { address: string; fanOut: number; txCount: number }[] = [];
  private prevEntityRanks = new Map<string, number>();
  private prevEntityBalances = new Map<string, bigint>();
  private bootError: string | null = null;
  private inflight: Promise<Snapshot> | null = null;

  constructor(readonly cfg: TrackerConfig) {
    this.rpc = new RpcClient(cfg.rpcUrls);
  }

  /** Refresh, coalescing concurrent callers onto one in-flight pass. */
  async refresh(budgetMs = 8_000): Promise<Snapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(budgetMs).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(budgetMs: number): Promise<Snapshot> {
    if (!this.rpc.configured) {
      return this.emptySnapshot([
        "HOLDERS_RPC_URLS is not set. The tracker reads holders from chain state, so it needs a JSON-RPC endpoint for the chain the token lives on.",
      ]);
    }
    try {
      if (!this.token) await this.bootstrap();
    } catch (err) {
      this.bootError = String(err).slice(0, 300);
      log.error("tracker bootstrap failed", { error: this.bootError });
    }
    if (!this.token || !this.ledger) {
      return this.emptySnapshot([this.bootError ?? "bootstrap did not complete"]);
    }

    const head = await this.rpc.blockNumber().catch(() => this.ledger!.headBlock);
    await this.ledger.advance(head, budgetMs);
    // Signer resolution is what defeats a relayer: the transfer says who moved
    // tokens, the transaction says who authorised it, and those differ exactly
    // when someone is routing through infrastructure to break the trail.
    await this.resolveSigners(2_500);
    const market = await getMarket(this.cfg).catch(() => EMPTY_MARKET);
    return this.buildSnapshot(market);
  }

  // ------------------------------------------------------------- bootstrap
  private async bootstrap(): Promise<void> {
    const t = this.cfg.token;
    const calls = [
      { method: "eth_call", params: [{ to: t, data: SELECTOR.decimals }, "latest"] },
      { method: "eth_call", params: [{ to: t, data: SELECTOR.symbol }, "latest"] },
      { method: "eth_call", params: [{ to: t, data: SELECTOR.name }, "latest"] },
      { method: "eth_call", params: [{ to: t, data: SELECTOR.totalSupply }, "latest"] },
    ];
    const [dec, sym, nam, sup] = await this.rpc.batch<string>(calls);
    if (dec instanceof Error) throw new Error(`token decimals() failed: ${dec.message}`);

    const decimals = Number(decodeUint(dec as string));
    this.token = {
      address: t,
      decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
      symbol: (!(sym instanceof Error) && decodeString(sym as string)) || "TOKEN",
      name: (!(nam instanceof Error) && decodeString(nam as string)) || "Unknown token",
      totalSupply: sup instanceof Error ? 0n : decodeUint(sup as string),
    };

    this.chainId = await this.rpc.chainId();
    await this.bootstrapPool();

    this.ledger = new Ledger(this.rpc, this.cfg, this.token.decimals);
    if (this.pool) this.ledger.setPool(this.pool);

    // Start the replay at the token's own deploy block. Walking from genesis
    // on a chain with millions of empty blocks is the difference between a
    // backfill that finishes and one that never does.
    if (this.cfg.fromBlock === 0) {
      const deploy = await this.findDeployBlock().catch(() => null);
      if (deploy !== null) {
        this.cfg.fromBlock = deploy;
        log.info("token deploy block located", { token: t, block: deploy });
      }
    }
  }

  /** Read the pair's token ordering and reserves so swaps can be priced. */
  private async bootstrapPool(): Promise<void> {
    const pair = this.cfg.pair;
    if (!pair || !this.token) return;
    const [t0, t1, res] = await this.rpc.batch<string>([
      { method: "eth_call", params: [{ to: pair, data: SELECTOR.token0 }, "latest"] },
      { method: "eth_call", params: [{ to: pair, data: SELECTOR.token1 }, "latest"] },
      { method: "eth_call", params: [{ to: pair, data: SELECTOR.getReserves }, "latest"] },
    ]);
    if (t0 instanceof Error || t1 instanceof Error) {
      log.warn("pair does not expose token0/token1 — swap pricing disabled", { pair });
      return;
    }
    const token0 = ("0x" + (t0 as string).slice(-40)).toLowerCase();
    const token1 = ("0x" + (t1 as string).slice(-40)).toLowerCase();
    const tokenIsToken0 = token0 === this.token.address;
    if (!tokenIsToken0 && token1 !== this.token.address) {
      log.warn("configured pair does not contain the token", { pair, token0, token1 });
      return;
    }
    const quoteAddr = tokenIsToken0 ? token1 : token0;
    const [qd] = await this.rpc.batch<string>([
      { method: "eth_call", params: [{ to: quoteAddr, data: SELECTOR.decimals }, "latest"] },
    ]);
    const quoteDecimals = qd instanceof Error ? 18 : Number(decodeUint(qd as string)) || 18;

    const r = res instanceof Error ? null : decodeReserves(res as string);
    this.pool = {
      reserveToken: r ? (tokenIsToken0 ? r.r0 : r.r1) : 0n,
      reserveQuote: r ? (tokenIsToken0 ? r.r1 : r.r0) : 0n,
      tokenIsToken0,
      quoteDecimals,
      priceQuote: null,
      updatedBlock: 0,
    };
    this.pool.priceQuote = priceFromReserves(this.pool, this.token.decimals);
  }

  /**
   * Binary search for the first block where the token has bytecode.
   *
   * Needs historical eth_getCode. Public RPCs that prune state answer with an
   * error or an empty result at old heights; either way we fall back to
   * scanning from 0 rather than reporting a wrong deploy block.
   */
  private async findDeployBlock(): Promise<number | null> {
    const head = await this.rpc.blockNumber();
    const codeAt = async (b: number): Promise<boolean> => {
      const [c] = await this.rpc.batch<string>([
        { method: "eth_getCode", params: [this.cfg.token, "0x" + b.toString(16)] },
      ]);
      if (c instanceof Error) throw c;
      return typeof c === "string" && c.length > 2;
    };
    if (!(await codeAt(head))) return null; // not a contract at head
    let lo = 0;
    let hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await codeAt(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Resolve tx.from for transactions we have not seen a signer for.
   *
   * Bounded by a time budget and worked newest-first: recent movement is what
   * a live tracker is for, and an unresolved old transaction only costs one
   * clustering signal, never correctness of a balance.
   */
  private async resolveSigners(budgetMs: number): Promise<void> {
    const ledger = this.ledger;
    if (!ledger) return;
    const deadline = Date.now() + budgetMs;

    const pending: string[] = [];
    // Map iteration is insertion-ordered; reverse it to take newest first.
    const hashes = [...ledger.txParticipants.keys()].reverse();
    for (const h of hashes) {
      if (!this.signers.has(h)) pending.push(h);
      if (pending.length >= 400) break;
    }
    if (pending.length === 0) return;

    for (let i = 0; i < pending.length && Date.now() < deadline; i += 25) {
      const slice = pending.slice(i, i + 25);
      const res = await this.rpc.batch<{ from?: string } | null>(
        slice.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })),
      );
      slice.forEach((h, j) => {
        const tx = res[j];
        if (tx instanceof Error || !tx || typeof tx.from !== "string") return;
        this.signers.set(h, tx.from.toLowerCase());
      });
    }
  }

  // -------------------------------------------------------------- snapshot
  private async buildSnapshot(market: MarketState): Promise<Snapshot> {
    const token = this.token!;
    const ledger = this.ledger!;
    const pair = this.cfg.pair;

    // Rank every account with a positive balance.
    const ranked: { address: string; balance: bigint }[] = [];
    let trackedSupply = 0n;
    for (const [address, acc] of ledger.accounts) {
      if (acc.balance <= 0n) continue;
      trackedSupply += acc.balance;
      ranked.push({ address, balance: acc.balance });
    }
    ranked.sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0));

    const poolBalance = pair ? (ledger.account(pair)?.balance ?? 0n) : 0n;
    let burned = 0n;
    for (const b of BURN_ADDRESSES) burned += ledger.account(b)?.balance ?? 0n;
    // The float is what can actually be sold: the pool's own inventory is the
    // other side of the trade, and burns are gone.
    const circulating = trackedSupply - poolBalance - burned;

    const top = ranked.slice(0, this.cfg.topN);
    await this.classify(top.map((r) => r.address));

    const holders: Holder[] = top.map((r, i) => {
      const acc = ledger.account(r.address)!;
      const base = circulating > 0n ? circulating : trackedSupply;
      const isFloat = r.address !== pair && !BURN_ADDRESSES.has(r.address);
      return {
        address: r.address,
        balance: r.balance,
        share: isFloat && base > 0n ? Number((r.balance * 1_000_000n) / base) / 1_000_000 : 0,
        kind: this.kindOf(r.address),
        label: this.labelOf(r.address),
        firstSeenBlock: acc.firstSeenBlock,
        lastActiveBlock: acc.lastActiveBlock,
        totalIn: acc.totalIn,
        totalOut: acc.totalOut,
        transferCount: acc.transferCount,
        delta: ledger.deltaFor(r.address, r.balance),
        prevRank: ledger.prevRankFor(r.address),
        behavior: behaviorOf(acc),
      };
    });

    ledger.commitSnapshot(ranked);

    // ---- entity resolution: fold split positions back into one actor.
    const excluded = new Set<string>([...BURN_ADDRESSES]);
    if (pair) excluded.add(pair);
    const { assignment, evidence, relayers } = cluster({
      accounts: ledger.accounts,
      edges: ledger.edges,
      signers: this.signers,
      txParticipants: ledger.txParticipants,
      excluded,
    });
    this.relayers = relayers;
    const relayerSet = new Set(relayers.map((r) => r.address));
    // Precompute the addresses that ever appeared in a relayer-signed
    // transaction. Doing this per entity would be a scan of every indexed
    // transaction per row.
    const relayerTouched = new Set<string>();
    for (const [txHash, participants] of ledger.txParticipants) {
      const signer = this.signers.get(txHash);
      if (signer && relayerSet.has(signer)) {
        for (const a of participants) relayerTouched.add(a);
      }
    }
    const entityMap = buildEntities(assignment, ledger.accounts, ledger.edges, evidence);

    const base = circulating > 0n ? circulating : trackedSupply;
    const rankedEntities: RankedEntity[] = [...entityMap.values()]
      .filter((e: Entity) => e.balance > 0n)
      .sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0))
      .slice(0, this.cfg.topN)
      .map((e, i) => ({
        ...e,
        rank: i + 1,
        share: base > 0n ? Number((e.balance * 1_000_000n) / base) / 1_000_000 : 0,
        kind: this.kindOf(e.id),
        label: this.labelOf(e.id),
        delta: e.balance - (this.prevEntityBalances.get(e.id) ?? e.balance),
        prevRank: this.prevEntityRanks.get(e.id) ?? null,
        viaRelayer: e.addresses.some((a) => relayerTouched.has(a)),
      }));

    // Classify the entity primaries too, so a clustered actor still shows
    // whether its main address is a contract or an EOA.
    await this.classify(rankedEntities.map((e) => e.id));

    this.prevEntityBalances = new Map(rankedEntities.map((e) => [e.id, e.balance]));
    this.prevEntityRanks = new Map(rankedEntities.map((e) => [e.id, e.rank]));

    const clusteredAddresses = [...entityMap.values()]
      .filter((e) => e.addresses.length > 1)
      .reduce((s, e) => s + e.addresses.length, 0);

    // Concentration is measured over entities and over the float. Measuring it
    // over raw addresses would let anyone dilute their apparent share just by
    // splitting a position, which is the exact behaviour being tracked; and
    // counting the pool as a holder would understate how concentrated the
    // sellable side really is.
    const tradable = rankedEntities.filter((e) => e.kind !== "pair" && e.kind !== "zero");
    const shareAt = (n: number) => tradable.slice(0, n).reduce((s, e) => s + e.share, 0);
    const hhi = tradable.reduce((s, e) => s + e.share * e.share, 0);

    const reserves = this.reservesFloat();
    const spot = market.priceUsd ?? this.derivedSpotUsd(market.quoteUsd);

    return {
      token,
      chainId: this.chainId,
      holders,
      entities: rankedEntities,
      relayers,
      clusteredAddresses,
      holderCount: ranked.length,
      trackedSupply,
      circulatingSupply: circulating,
      poolBalance,
      market: spot !== null && market.priceUsd === null ? { ...market, priceUsd: spot } : market,
      pool: this.pool,
      concentration: {
        top1: shareAt(1),
        top5: shareAt(5),
        top10: shareAt(10),
        top25: shareAt(25),
        hhi,
        top1OverPool:
          poolBalance > 0n && tradable[0]
            ? Number((tradable[0].balance * 10_000n) / poolBalance) / 10_000
            : null,
      },
      flows: [...ledger.flows].reverse(),
      depthLadder: reserves ? depthLadder(reserves, spot) : [],
      headBlock: ledger.headBlock,
      indexedBlock: ledger.cursor,
      backfilling: ledger.backfilling,
      backfillProgress: ledger.progress,
      updatedAt: Date.now(),
      warnings: [...new Set(ledger.warnings)].slice(-5),
    };
  }

  /** Pool reserves as floats, for the AMM math. */
  reservesFloat(): { token: number; quote: number } | null {
    if (!this.pool || !this.token) return null;
    if (this.pool.reserveToken <= 0n || this.pool.reserveQuote <= 0n) return null;
    return {
      token: toUnits(this.pool.reserveToken, this.token.decimals),
      quote: toUnits(this.pool.reserveQuote, this.pool.quoteDecimals),
    };
  }

  /** Spot in USD from reserves when no aggregator answered but we know quote. */
  private derivedSpotUsd(quoteUsd: number | null): number | null {
    if (quoteUsd === null || !this.pool?.priceQuote) return null;
    return this.pool.priceQuote * quoteUsd;
  }

  /** eth_getCode on addresses we have not classified yet. */
  private async classify(addresses: string[]): Promise<void> {
    const unknown = addresses.filter((a) => !this.kinds.has(a) && !this.isSpecial(a));
    if (unknown.length === 0) return;
    // Chunked: a 100-call batch is rejected outright by some providers.
    for (let i = 0; i < unknown.length; i += 25) {
      const slice = unknown.slice(i, i + 25);
      const res = await this.rpc.batch<string>(
        slice.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })),
      );
      slice.forEach((a, j) => {
        const c = res[j];
        if (c instanceof Error) return; // retry on a later refresh
        this.kinds.set(a, typeof c === "string" && c.length > 2 ? "contract" : "wallet");
      });
    }
  }

  private isSpecial(a: string): boolean {
    return BURN_ADDRESSES.has(a) || a === this.cfg.pair;
  }

  private kindOf(a: string): AddressKind {
    if (a === this.cfg.pair) return "pair";
    if (BURN_ADDRESSES.has(a)) return "zero";
    return this.kinds.get(a) ?? "wallet";
  }

  private labelOf(a: string): string | null {
    if (a === this.cfg.pair) {
      const q = this.pool ? "pool" : "pair";
      return `${this.token?.symbol ?? "TOKEN"} ${q}`;
    }
    if (a === ZERO_ADDRESS) return "mint / burn (0x0)";
    if (BURN_ADDRESSES.has(a)) return "burn";
    return null;
  }

  private emptySnapshot(warnings: string[]): Snapshot {
    return {
      token: this.token ?? {
        address: this.cfg.token,
        symbol: "TOKEN",
        name: "Unknown token",
        decimals: 18,
        totalSupply: 0n,
      },
      chainId: this.chainId,
      holders: [],
      entities: [],
      relayers: [],
      clusteredAddresses: 0,
      holderCount: 0,
      trackedSupply: 0n,
      circulatingSupply: 0n,
      poolBalance: 0n,
      market: EMPTY_MARKET,
      pool: this.pool,
      concentration: { top1: 0, top5: 0, top10: 0, top25: 0, hhi: 0, top1OverPool: null },
      flows: [],
      depthLadder: [],
      headBlock: 0,
      indexedBlock: -1,
      backfilling: false,
      backfillProgress: 0,
      updatedAt: Date.now(),
      warnings,
    };
  }
}

/** Derive the behavior summary from the raw account counters. */
function behaviorOf(acc: {
  boughtTokens: bigint;
  soldTokens: bigint;
  spentQuote: bigint;
  receivedQuote: bigint;
  buyCount: number;
  sellCount: number;
  receivedOffMarket: bigint;
  sentOffMarket: bigint;
  firstTradeBlock: number | null;
  lastTradeBlock: number | null;
}): Behavior {
  const acquired = acc.boughtTokens + acc.receivedOffMarket;
  const distributed = acc.soldTokens + acc.sentOffMarket;
  const acquisition: Behavior["acquisition"] =
    acquired === 0n
      ? "none"
      : acc.boughtTokens === 0n
        ? "farmed"
        : acc.receivedOffMarket === 0n
          ? "bought"
          : "mixed";
  return {
    boughtTokens: acc.boughtTokens,
    soldTokens: acc.soldTokens,
    spentQuote: acc.spentQuote,
    receivedQuote: acc.receivedQuote,
    buyCount: acc.buyCount,
    sellCount: acc.sellCount,
    receivedOffMarket: acc.receivedOffMarket,
    sentOffMarket: acc.sentOffMarket,
    firstTradeBlock: acc.firstTradeBlock,
    lastTradeBlock: acc.lastTradeBlock,
    distributionRatio:
      acquired > 0n ? Number((distributed * 10_000n) / acquired) / 10_000 : 0,
    acquisition,
  };
}

// ------------------------------------------------------------------ registry
const trackers = new Map<string, Tracker>();

export function getTracker(cfg: TrackerConfig): Tracker {
  const key = `${cfg.token}:${cfg.pair ?? ""}:${cfg.rpcUrls.join(",")}`;
  let t = trackers.get(key);
  if (!t) {
    t = new Tracker(cfg);
    trackers.set(key, t);
  }
  return t;
}
