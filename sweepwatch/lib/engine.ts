"use client";

import { OrderBook, type DepthDiff } from "./binance/book";
import {
  currentRoute,
  fetchDepthSnapshot,
  fetchKlines,
  fetchLongShortRatio,
  fetchMeta,
  fetchOpenInterest,
  onRouteChange,
} from "./binance/rest";
import { StreamClient, type StreamMessage } from "./binance/streams";
import { CONFIG, SYMBOL } from "./config";
import { simulate } from "./metrics/cascade";
import { buildClusters } from "./metrics/clusters";
import { bandDepths, costCurve, findWalls } from "./metrics/depth";
import { sessionState } from "./metrics/session";
import { WithdrawalTracker } from "./metrics/withdrawal";
import type {
  Cluster,
  ConnectionState,
  Kline,
  Liquidation,
  MarkPrice,
  Snapshot,
  SymbolMeta,
  Trade,
} from "./types";

/**
 * Owns every live connection and every derived number, outside React.
 *
 * React subscribes to a snapshot that is republished at a fixed rate. The
 * socket runs at whatever rate Binance sends — depth diffs land every 100ms,
 * prints land whenever they happen — and none of that is throttled on the way
 * in. Only the render is paced. Metrics that depend on continuity, above all
 * the withdrawn-versus-consumed split, see every update.
 */
export class Engine {
  private book = new OrderBook();
  private stream: StreamClient | null = null;
  private tracker = new WithdrawalTracker();

  private meta: SymbolMeta | null = null;
  private mark: MarkPrice | null = null;
  private last: number | null = null;
  private minutes: Kline[] = [];
  private daily: Kline[] = [];
  private liquidations: Liquidation[] = [];
  private largeTrades: Trade[] = [];
  private openInterest: { qty: number; notional: number; t: number } | null = null;
  private longShortRatio: number | null = null;
  private clusters: Cluster[] = [];

  private connection: ConnectionState = {
    socket: "connecting",
    bookSynced: false,
    resyncs: 0,
    lastMessageAt: 0,
    messagesPerSec: 0,
    restVia: "unknown",
    error: null,
  };

  private msgCount = 0;
  private msgWindowStart = Date.now();
  private snapshotPending = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = emptySnapshot();
  private started = false;
  private unsubRoute: (() => void) | null = null;

  /* ------------------------------------------------------------- lifecycle */

  start() {
    if (this.started) return;
    this.started = true;

    this.unsubRoute = onRouteChange((r) => {
      this.connection = { ...this.connection, restVia: r };
    });

    this.stream = new StreamClient({
      onOpen: () => {
        this.connection = { ...this.connection, socket: "open", error: null };
        // The book must be resynced against a fresh snapshot on every
        // reconnect; diffs missed while disconnected cannot be recovered.
        this.book.reset();
        void this.resync();
      },
      onClose: (reason) => {
        this.connection = { ...this.connection, socket: "closed", bookSynced: false, error: reason };
      },
      onError: (err) => {
        this.connection = { ...this.connection, socket: "error", error: err };
      },
      onMessage: (msg) => this.handle(msg),
    });
    this.stream.start();

    void this.bootstrap();

    this.timers.push(setInterval(() => this.sample(), CONFIG.sampleIntervalMs));
    this.timers.push(setInterval(() => this.recomputeClusters(), 2_000));
    this.timers.push(setInterval(() => this.publish(), 1000 / CONFIG.publishHz));
    // Open interest has no stream on Binance futures; it is the one figure
    // here that is polled, and it is labelled as such in the UI.
    this.timers.push(setInterval(() => void this.refreshOpenInterest(), 20_000));
    this.timers.push(setInterval(() => void this.refreshRatio(), 300_000));
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        const elapsed = (now - this.msgWindowStart) / 1000;
        if (elapsed >= 1) {
          this.connection = {
            ...this.connection,
            messagesPerSec: this.msgCount / elapsed,
            restVia: currentRoute(),
          };
          this.msgCount = 0;
          this.msgWindowStart = now;
        }
      }, 1000),
    );
  }

  stop() {
    this.started = false;
    this.stream?.stop();
    this.stream = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubRoute?.();
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = () => this.snapshot;

  /* -------------------------------------------------------------- bootstrap */

  private async bootstrap() {
    try {
      this.meta = await fetchMeta();
    } catch (err) {
      this.connection = {
        ...this.connection,
        error: `metadata: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await Promise.allSettled([
      this.loadKlines(),
      this.refreshOpenInterest(),
      this.refreshRatio(),
    ]);
    this.recomputeClusters();
  }

  private async loadKlines() {
    const [minutes, daily] = await Promise.all([
      fetchKlines("1m", 1000),
      fetchKlines("1d", 60),
    ]);
    this.minutes = minutes;
    this.daily = daily;
  }

  private async refreshOpenInterest() {
    try {
      const oi = await fetchOpenInterest();
      const price = this.mark?.markPrice ?? this.book.mid() ?? this.last ?? 0;
      this.openInterest = { qty: oi.qty, notional: oi.qty * price, t: oi.t };
    } catch {
      /* transient; the previous value stays on screen */
    }
  }

  private async refreshRatio() {
    this.longShortRatio = await fetchLongShortRatio();
  }

  private async resync() {
    if (this.snapshotPending) return;
    this.snapshotPending = true;
    try {
      const snap = await fetchDepthSnapshot(1000);
      this.book.applySnapshot(snap);
    } catch (err) {
      this.connection = {
        ...this.connection,
        error: `book snapshot: ${err instanceof Error ? err.message : String(err)}`,
      };
      setTimeout(() => void this.resync(), 2_000);
    } finally {
      this.snapshotPending = false;
    }
  }

  /* ---------------------------------------------------------------- streams */

  private handle(msg: StreamMessage) {
    this.msgCount++;
    this.connection.lastMessageAt = Date.now();
    const d = msg.data as Record<string, unknown>;
    const type = d.e as string;

    switch (type) {
      case "depthUpdate": {
        const ok = this.book.apply(d as unknown as DepthDiff);
        if (!ok) void this.resync();
        this.connection.bookSynced = this.book.synced;
        this.connection.resyncs = this.book.resyncs;
        break;
      }
      case "aggTrade": {
        const price = Number(d.p);
        const qty = Number(d.q);
        const notional = price * qty;
        const trade: Trade = {
          t: Number(d.T),
          price,
          qty,
          notional,
          buyerIsMaker: Boolean(d.m),
        };
        this.last = price;
        this.tracker.addTrade(notional, trade.buyerIsMaker);
        if (notional >= CONFIG.largeTradeNotional) {
          this.largeTrades.unshift(trade);
          if (this.largeTrades.length > 200) this.largeTrades.length = 200;
        }
        break;
      }
      case "forceOrder": {
        const o = d.o as Record<string, unknown>;
        const price = Number(o.ap ?? o.p);
        const qty = Number(o.q);
        const side = String(o.S) as "BUY" | "SELL";
        this.liquidations.unshift({
          t: Number(o.T ?? d.E),
          price,
          qty,
          notional: price * qty,
          side,
          // A liquidated long is closed with a sell; a liquidated short with a buy.
          positionSide: side === "SELL" ? "long" : "short",
        });
        if (this.liquidations.length > 800) this.liquidations.length = 800;
        break;
      }
      case "markPriceUpdate": {
        this.mark = {
          markPrice: Number(d.p),
          indexPrice: Number(d.i),
          fundingRate: Number(d.r),
          nextFundingTime: Number(d.T),
          t: Number(d.E),
        };
        break;
      }
      case "kline": {
        const k = d.k as Record<string, unknown>;
        const bar: Kline = {
          openTime: Number(k.t),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
          quoteVolume: Number(k.q),
          closed: Boolean(k.x),
        };
        const lastBar = this.minutes[this.minutes.length - 1];
        if (lastBar && lastBar.openTime === bar.openTime) {
          this.minutes[this.minutes.length - 1] = bar;
        } else {
          this.minutes.push(bar);
          if (this.minutes.length > 1200) this.minutes.shift();
          // A closed bar can extend the session range, so extremes are
          // re-derived on the next cluster pass rather than being refetched.
        }
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- compute */

  private sample() {
    const mid = this.book.mid();
    if (!mid) return;
    const bands = bandDepths(this.book.bidLevels(), this.book.askLevels(), mid);
    const primary = bands.find((b) => b.bps === CONFIG.primaryBandBps);
    if (!primary) return;
    this.tracker.sample(Date.now(), primary.bidNotional, primary.askNotional, mid);
  }

  private recomputeClusters() {
    const mid = this.book.mid() ?? this.mark?.markPrice ?? this.last;
    if (!mid) return;
    const walls = this.book.bidLevels().length
      ? findWalls(this.book.bidLevels(), this.book.askLevels(), mid)
      : [];
    this.clusters = buildClusters({
      mid,
      daily: this.daily,
      minutes: this.minutes,
      liquidations: this.liquidations,
      walls,
      openInterestNotional: this.openInterest?.notional ?? 0,
      longShortRatio: this.longShortRatio,
      now: Date.now(),
    });
  }

  private publish() {
    const bids = this.book.bidLevels();
    const asks = this.book.askLevels();
    const mid = this.book.mid();
    const bestBid = this.book.bestBid();
    const bestAsk = this.book.bestAsk();

    let liquidity: Snapshot["liquidity"] = null;
    if (mid && bids.length && asks.length) {
      const bands = bandDepths(bids, asks, mid);
      const primary = bands.find((b) => b.bps === CONFIG.primaryBandBps)!;
      const idx = this.tracker.index();
      const decomp = this.tracker.decompose() ?? {
        windowSec: CONFIG.decompWindowSec,
        consumedBid: 0,
        consumedAsk: 0,
        withdrawnBid: 0,
        withdrawnAsk: 0,
        addedBid: 0,
        addedAsk: 0,
      };
      const total = primary.bidNotional + primary.askNotional;
      liquidity = {
        bands,
        primary,
        costCurve: costCurve(bids, asks, mid),
        walls: findWalls(bids, asks, mid),
        lwi: this.tracker.warm ? idx.total : 1,
        lwiBid: this.tracker.warm ? idx.bid : 1,
        lwiAsk: this.tracker.warm ? idx.ask : 1,
        baselineNotional: idx.baseline,
        fastNotional: idx.fast,
        decomp,
        imbalance: total > 0 ? (primary.bidNotional - primary.askNotional) / total : 0,
        spreadBps: bestBid && bestAsk ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
      };
    }

    const cascadeInput = {
      bids,
      asks,
      mid: mid ?? 0,
      clusters: this.clusters,
      lwi: liquidity?.lwi ?? 1,
      openInterestNotional: this.openInterest?.notional ?? 0,
    };

    this.snapshot = {
      ts: Date.now(),
      meta: this.meta,
      connection: { ...this.connection },
      session: sessionState(),
      mark: this.mark,
      last: this.last,
      mid,
      bestBid,
      bestAsk,
      openInterest: this.openInterest,
      longShortRatio: this.longShortRatio,
      liquidity,
      bookBids: bids,
      bookAsks: asks,
      clusters: this.clusters,
      cascadeDown: mid ? simulate(cascadeInput, "down") : null,
      cascadeUp: mid ? simulate(cascadeInput, "up") : null,
      liquidations: this.liquidations.slice(0, 60),
      largeTrades: this.largeTrades.slice(0, 40),
      thinning: this.tracker.events.slice(0, 30),
      depthHistory: this.tracker.history(),
      flow: this.tracker.flowSince(1000),
    };

    for (const cb of this.listeners) cb();
  }
}

export function emptySnapshot(): Snapshot {
  return {
    ts: 0,
    meta: null,
    connection: {
      socket: "connecting",
      bookSynced: false,
      resyncs: 0,
      lastMessageAt: 0,
      messagesPerSec: 0,
      restVia: "unknown",
      error: null,
    },
    session: sessionState(),
    mark: null,
    last: null,
    mid: null,
    bestBid: null,
    bestAsk: null,
    openInterest: null,
    longShortRatio: null,
    liquidity: null,
    bookBids: [],
    bookAsks: [],
    clusters: [],
    cascadeDown: null,
    cascadeUp: null,
    liquidations: [],
    largeTrades: [],
    thinning: [],
    depthHistory: [],
    flow: { buy: 0, sell: 0 },
  };
}

let singleton: Engine | null = null;

/** One engine per tab, shared by every component that reads from it. */
export function getEngine(): Engine {
  if (!singleton) singleton = new Engine();
  return singleton;
}

export { SYMBOL };
