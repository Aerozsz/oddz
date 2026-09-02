import { log } from "@/lib/logger";
import {
  SWAP_TOPIC,
  SYNC_TOPIC,
  TRANSFER_TOPIC,
  decodeSwap,
  decodeSync,
  topicToAddress,
} from "./abi";
import { BURN_ADDRESSES, ZERO_ADDRESS, type TrackerConfig } from "./config";
import { RangeTooWideError, RpcClient, hex } from "./rpc";
import type { Flow, PoolState } from "./types";

/** Raw log shape as returned by eth_getLogs. */
interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/** Everything the replay knows about one address. */
export interface Account {
  balance: bigint;
  totalIn: bigint;
  totalOut: bigint;
  transferCount: number;
  firstSeenBlock: number;
  lastActiveBlock: number;
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
}

/** An aggregated address-to-address transfer edge in the token's own graph. */
export interface TransferEdge {
  from: string;
  to: string;
  value: bigint;
  count: number;
  firstBlock: number;
  lastBlock: number;
}

function emptyAccount(block: number): Account {
  return {
    balance: 0n,
    totalIn: 0n,
    totalOut: 0n,
    transferCount: 0,
    firstSeenBlock: block,
    lastActiveBlock: block,
    boughtTokens: 0n,
    soldTokens: 0n,
    spentQuote: 0n,
    receivedQuote: 0n,
    buyCount: 0,
    sellCount: 0,
    receivedOffMarket: 0n,
    sentOffMarket: 0n,
    firstTradeBlock: null,
    lastTradeBlock: null,
  };
}

/**
 * The replay state.
 *
 * Held in memory and advanced incrementally: the expensive full history walk
 * happens once, then each refresh only asks for the blocks since the cursor.
 * That is what makes "real time" affordable — a poll costs one eth_getLogs
 * over a handful of blocks, not a rescan of the chain.
 */
export class Ledger {
  readonly accounts = new Map<string, Account>();
  /** Last block consumed. -1 means nothing indexed yet. */
  cursor = -1;
  startBlock = 0;
  headBlock = 0;
  flows: Flow[] = [];
  pool: PoolState | null = null;
  /** Balance per address at the previous published snapshot, for deltas. */
  private prevBalances = new Map<string, bigint>();
  private prevRanks = new Map<string, number>();
  /**
   * The wallet-to-wallet transfer graph, excluding the pair and burns.
   * This is the substrate the clustering pass runs over: a trail split across
   * fresh addresses still has to move tokens, and every move is an edge here.
   */
  readonly edges = new Map<string, TransferEdge>();
  /**
   * Addresses touched by each transaction, most recent first, capped.
   * Used to attribute a transaction's signer to its participants without
   * holding the whole chain's history in memory.
   */
  readonly txParticipants = new Map<string, Set<string>>();
  private static readonly MAX_TX_PARTICIPANTS = 20_000;
  private chunk: number;
  readonly warnings: string[] = [];

  constructor(
    private readonly rpc: RpcClient,
    private readonly cfg: TrackerConfig,
    private readonly tokenDecimals: number,
  ) {
    this.chunk = cfg.logChunk;
  }

  get backfilling(): boolean {
    return this.cursor >= 0 && this.cursor < this.headBlock;
  }

  get progress(): number {
    if (this.cursor < 0) return 0;
    const span = this.headBlock - this.startBlock;
    if (span <= 0) return 1;
    return Math.min(1, Math.max(0, (this.cursor - this.startBlock) / span));
  }

  account(addr: string): Account | undefined {
    return this.accounts.get(addr);
  }

  /** Seed pool geometry once the pair's token ordering is known. */
  setPool(pool: PoolState) {
    this.pool = pool;
  }

  /**
   * Advance the replay toward head, spending at most `budgetMs`.
   *
   * The budget exists because this runs in a serverless request. A cold
   * tracker on a long chain cannot finish in one call, so it walks as far as
   * it can, keeps its cursor, and reports `backfilling` — the UI shows partial
   * data labelled as partial rather than blocking on a complete history.
   */
  async advance(head: number, budgetMs = 8_000): Promise<void> {
    this.headBlock = head;
    if (this.cursor < 0) {
      this.cursor = Math.max(0, this.cfg.fromBlock) - 1;
      this.startBlock = this.cursor + 1;
    }
    const deadline = Date.now() + budgetMs;

    while (this.cursor < head && Date.now() < deadline) {
      const from = this.cursor + 1;
      const to = Math.min(head, from + this.chunk - 1);
      const ok = await this.consume(from, to);
      if (!ok) {
        // Range refused. Halve and retry the same window; give up below 32.
        if (this.chunk <= 32) {
          this.warnings.push(`RPC refused a ${this.chunk}-block log range at ${from}`);
          this.cursor = to;
          continue;
        }
        this.chunk = Math.max(32, Math.floor(this.chunk / 2));
        continue;
      }
      this.cursor = to;
      // Widen again after a clean pass, so one bad window does not pin the
      // chunk size low for the rest of the backfill.
      if (this.chunk < this.cfg.logChunk) this.chunk = Math.min(this.cfg.logChunk, this.chunk * 2);
    }
  }

  /** Fetch and apply one block window. Returns false if the range was refused. */
  private async consume(from: number, to: number): Promise<boolean> {
    const filters: { method: string; params: unknown[] }[] = [
      {
        method: "eth_getLogs",
        params: [
          {
            address: this.cfg.token,
            topics: [TRANSFER_TOPIC],
            fromBlock: hex.block(from),
            toBlock: hex.block(to),
          },
        ],
      },
    ];
    if (this.cfg.pair) {
      filters.push({
        method: "eth_getLogs",
        params: [
          {
            address: this.cfg.pair,
            // One filter for both pair events: topic position 0 accepts an
            // array as an OR, which halves the request count.
            topics: [[SWAP_TOPIC, SYNC_TOPIC]],
            fromBlock: hex.block(from),
            toBlock: hex.block(to),
          },
        ],
      });
    }

    const results = await this.rpc.batch<RawLog[]>(filters);
    for (const r of results) {
      if (r instanceof RangeTooWideError) return false;
      if (r instanceof Error) {
        // A transport failure is not a range problem: record and move on so a
        // single flaky window cannot wedge the backfill forever.
        log.warn("log fetch failed", { from, to, error: r.message.slice(0, 160) });
        this.warnings.push(`log fetch failed for blocks ${from}-${to}`);
        return true;
      }
    }

    const transfers = (results[0] as RawLog[]) ?? [];
    const pairLogs = (results[1] as RawLog[] | undefined) ?? [];
    this.apply(transfers, pairLogs);
    return true;
  }

  /**
   * Apply one window's logs.
   *
   * Swaps are indexed by transaction first so that each token Transfer
   * touching the pair can be priced from the quote leg of the same
   * transaction. That join is what turns "balance went down" into "sold 400
   * tokens for 38 NVDA at 0.095".
   */
  private apply(transfers: RawLog[], pairLogs: RawLog[]) {
    const pool = this.pool;
    const pair = this.cfg.pair;

    // ---- pass 1: aggregate the quote and token legs of each swap, per tx.
    const swapByTx = new Map<string, { tokenIn: bigint; tokenOut: bigint; quoteIn: bigint; quoteOut: bigint }>();
    const syncs: { block: number; logIndex: number; r0: bigint; r1: bigint }[] = [];

    for (const l of pairLogs) {
      const topic0 = l.topics[0]?.toLowerCase();
      if (topic0 === SWAP_TOPIC && pool) {
        const s = decodeSwap(l.data);
        if (!s) continue;
        const tokenIn = pool.tokenIsToken0 ? s.amount0In : s.amount1In;
        const tokenOut = pool.tokenIsToken0 ? s.amount0Out : s.amount1Out;
        const quoteIn = pool.tokenIsToken0 ? s.amount1In : s.amount0In;
        const quoteOut = pool.tokenIsToken0 ? s.amount1Out : s.amount0Out;
        const key = l.transactionHash.toLowerCase();
        const prev = swapByTx.get(key) ?? { tokenIn: 0n, tokenOut: 0n, quoteIn: 0n, quoteOut: 0n };
        prev.tokenIn += tokenIn;
        prev.tokenOut += tokenOut;
        prev.quoteIn += quoteIn;
        prev.quoteOut += quoteOut;
        swapByTx.set(key, prev);
      } else if (topic0 === SYNC_TOPIC) {
        const s = decodeSync(l.data);
        if (!s) continue;
        syncs.push({
          block: hex.toNumber(l.blockNumber),
          logIndex: hex.toNumber(l.logIndex),
          r0: s.r0,
          r1: s.r1,
        });
      }
    }

    // ---- pass 2: replay transfers in chain order.
    const ordered = [...transfers].sort((a, b) => {
      const bd = hex.toNumber(a.blockNumber) - hex.toNumber(b.blockNumber);
      return bd !== 0 ? bd : hex.toNumber(a.logIndex) - hex.toNumber(b.logIndex);
    });

    for (const l of ordered) {
      if (l.topics.length < 3) continue; // not a standard Transfer
      const from = topicToAddress(l.topics[1]);
      const to = topicToAddress(l.topics[2]);
      const value = hex.toBigInt(l.data);
      const block = hex.toNumber(l.blockNumber);
      const txHash = l.transactionHash.toLowerCase();

      const isMint = from === ZERO_ADDRESS;
      const isBurn = BURN_ADDRESSES.has(to);
      const fromPair = pair !== null && from === pair;
      const toPair = pair !== null && to === pair;

      // Price this leg from the swap in the same transaction, pro-rata when a
      // multi-hop route moved tokens through the pair more than once.
      let quoteValue: bigint | null = null;
      const swap = swapByTx.get(txHash);
      if (swap) {
        if (fromPair && swap.tokenOut > 0n) {
          quoteValue = (swap.quoteIn * value) / swap.tokenOut;
        } else if (toPair && swap.tokenIn > 0n) {
          quoteValue = (swap.quoteOut * value) / swap.tokenIn;
        }
      }

      const direction: Flow["direction"] = isMint
        ? "mint"
        : isBurn
          ? "burn"
          : fromPair
            ? "buy"
            : toPair
              ? "sell"
              : "move";

      // --- debit the sender
      if (!isMint) {
        const acc = this.touch(from, block);
        acc.balance -= value;
        acc.totalOut += value;
        acc.transferCount++;
        acc.lastActiveBlock = block;
        if (toPair) {
          acc.soldTokens += value;
          acc.receivedQuote += quoteValue ?? 0n;
          acc.sellCount++;
          acc.firstTradeBlock ??= block;
          acc.lastTradeBlock = block;
        } else if (!fromPair) {
          acc.sentOffMarket += value;
        }
      }

      // --- credit the recipient
      if (!isBurn) {
        const acc = this.touch(to, block);
        acc.balance += value;
        acc.totalIn += value;
        acc.transferCount++;
        acc.lastActiveBlock = block;
        if (fromPair) {
          acc.boughtTokens += value;
          acc.spentQuote += quoteValue ?? 0n;
          acc.buyCount++;
          acc.firstTradeBlock ??= block;
          acc.lastTradeBlock = block;
        } else if (!toPair) {
          acc.receivedOffMarket += value;
        }
      } else {
        // Burns still need an account so the sink shows up in the table.
        const acc = this.touch(to, block);
        acc.balance += value;
        acc.totalIn += value;
        acc.lastActiveBlock = block;
      }

      // Record the wallet-to-wallet edge. Pair legs are trades, not transfers
      // between identities, so they are excluded from the clustering graph.
      if (!isMint && !isBurn && !fromPair && !toPair && from !== to && value > 0n) {
        const key = from + ">" + to;
        const e = this.edges.get(key);
        if (e) {
          e.value += value;
          e.count++;
          e.lastBlock = block;
        } else {
          this.edges.set(key, {
            from,
            to,
            value,
            count: 1,
            firstBlock: block,
            lastBlock: block,
          });
        }
      }

      // Track who participated in each transaction so a later signer lookup
      // can be attributed to the right addresses.
      if (!this.txParticipants.has(txHash)) {
        if (this.txParticipants.size >= Ledger.MAX_TX_PARTICIPANTS) {
          // Map iteration is insertion-ordered, so the first key is the oldest.
          const oldest = this.txParticipants.keys().next().value;
          if (oldest !== undefined) this.txParticipants.delete(oldest);
        }
        this.txParticipants.set(txHash, new Set());
      }
      const participants = this.txParticipants.get(txHash)!;
      if (!isMint) participants.add(from);
      if (!isBurn) participants.add(to);

      const priceQuote =
        quoteValue !== null && value > 0n && pool
          ? Number(quoteValue) /
            10 ** pool.quoteDecimals /
            (Number(value) / 10 ** this.tokenDecimals)
          : null;

      this.flows.push({
        blockNumber: block,
        txHash,
        logIndex: hex.toNumber(l.logIndex),
        from,
        to,
        value,
        direction,
        quoteValue,
        priceQuote: Number.isFinite(priceQuote ?? NaN) ? priceQuote : null,
      });
    }

    // Keep only the most recent flows; the feed is a window, not an archive.
    if (this.flows.length > this.cfg.maxFlows) {
      this.flows = this.flows.slice(-this.cfg.maxFlows);
    }

    // ---- pass 3: latest reserves win.
    if (syncs.length > 0 && pool) {
      syncs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      const last = syncs[syncs.length - 1];
      pool.reserveToken = pool.tokenIsToken0 ? last.r0 : last.r1;
      pool.reserveQuote = pool.tokenIsToken0 ? last.r1 : last.r0;
      pool.updatedBlock = last.block;
      pool.priceQuote = priceFromReserves(pool, this.tokenDecimals);
    }
  }

  private touch(addr: string, block: number): Account {
    let acc = this.accounts.get(addr);
    if (!acc) {
      acc = emptyAccount(block);
      this.accounts.set(addr, acc);
    }
    return acc;
  }

  /** Balance change for an address since the last published snapshot. */
  deltaFor(addr: string, balance: bigint): bigint {
    return balance - (this.prevBalances.get(addr) ?? balance);
  }

  prevRankFor(addr: string): number | null {
    return this.prevRanks.get(addr) ?? null;
  }

  /** Record the published ordering so the next snapshot can diff against it. */
  commitSnapshot(ranked: { address: string; balance: bigint }[]) {
    this.prevBalances = new Map(ranked.map((r) => [r.address, r.balance]));
    this.prevRanks = new Map(ranked.map((r, i) => [r.address, i + 1]));
  }
}

/** Spot price in quote per token straight from the reserve ratio. */
export function priceFromReserves(pool: PoolState, tokenDecimals: number): number | null {
  if (pool.reserveToken === 0n) return null;
  const t = Number(pool.reserveToken) / 10 ** tokenDecimals;
  const q = Number(pool.reserveQuote) / 10 ** pool.quoteDecimals;
  if (!Number.isFinite(t) || !Number.isFinite(q) || t === 0) return null;
  return q / t;
}
