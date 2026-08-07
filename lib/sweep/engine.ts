"use client";

import { OrderBook, type DepthDiff } from "./binance/book";
import {
  RateLimited,
  currentRoute,
  fetchDepthSnapshot,
  fetchFundingHistory,
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
import { activeEvents } from "./metrics/event-store";
import { NO_EVENT_RISK, eventRisk, parseEnvEvents, type MarketEvent } from "./metrics/events";
import { EMPTY_FUNDING, type FundingSettlement, readFunding } from "./metrics/funding";
import { EMPTY_MARKOUT, MarkoutTracker } from "./metrics/markout";
import { PLACEHOLDER_SESSION, sessionState } from "./metrics/session";
import { ParticipantTracker } from "./metrics/participants";
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

/** Floor between depth-snapshot requests, however often the book asks for one. */
const MIN_RESYNC_INTERVAL_MS = 1_000;

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
  private participants = new ParticipantTracker();
  private markout = new MarkoutTracker();
  private fundingHistory: FundingSettlement[] = [];

  /**
   * Calendar entries supplied out of band. Read once: the engine runs in the
   * browser as well as headless, and only the headless side has an environment
   * to read, so a browser session sees the projected dates and the standing
   * prompt to confirm them.
   */
  private extraEvents = parseEnvEvents(
    typeof process !== "undefined" ? process.env?.SWEEP_EVENTS : undefined,
  ).events;

  /**
   * The file-backed calendar, re-read on a timer.
   *
   * A timer rather than a one-off read because the agent writes to this file
   * while the engine is running — a date confirmed at 10am is no use if it
   * takes a restart to be seen. Reading it in the browser is skipped: there is
   * no filesystem there, and the projection plus its standing prompt is the
   * right thing for a page anyone can open.
   */
  private storedEvents: MarketEvent[] = [];

  private reloadEvents() {
    if (typeof window !== "undefined") return;
    try {
      this.storedEvents = activeEvents();
    } catch {
      /* a bad calendar file falls back to the projection */
    }
  }

  /** Fill-quality tracking for our own executions. */
  recordOwnFill(fill: Parameters<MarkoutTracker["recordFill"]>[0]) {
    this.markout.recordFill(fill);
  }

  fillQuality() {
    return this.markout.fillQuality();
  }

  private meta: SymbolMeta | null = null;
  private mark: MarkPrice | null = null;
  private last: number | null = null;
  private minutes: Kline[] = [];
  private daily: Kline[] = [];
  private liquidations: Liquidation[] = [];
  private largeTrades: Trade[] = [];
  private openInterest: Snapshot["openInterest"] = null;
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
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncAttempt = 0;
  private lastResyncAt = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = emptySnapshot();
  private started = false;
  private unsubRoute: (() => void) | null = null;
  private onVisibility: (() => void) | null = null;

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

    // Coming back to the tab must not show whatever the polls last managed
    // before it was hidden; refresh on the spot rather than waiting out the
    // remainder of a 20s or 5min interval.
    if (typeof document !== "undefined") {
      this.onVisibility = () => {
        if (document.visibilityState !== "visible") return;
        void this.refreshOpenInterest();
        void this.refreshRatio();
      };
      document.addEventListener("visibilitychange", this.onVisibility);
    }

    void this.bootstrap();

    this.timers.push(setInterval(() => this.sample(), CONFIG.sampleIntervalMs));
    this.timers.push(setInterval(() => this.recomputeClusters(), 2_000));
    this.timers.push(setInterval(() => this.publish(), 1000 / CONFIG.publishHz));
    // Open interest has no stream on Binance futures; it is the one figure
    // here that is polled, and it is labelled as such in the UI.
    this.timers.push(setInterval(() => void this.refreshOpenInterest(), 20_000));
    this.timers.push(setInterval(() => void this.refreshRatio(), 300_000));
    this.timers.push(setInterval(() => void this.refreshFundingHistory(), 1_800_000));
    this.reloadEvents();
    this.timers.push(setInterval(() => this.reloadEvents(), 60_000));
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
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    if (this.onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.onVisibility = null;
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
      this.refreshFundingHistory(),
    ]);
    this.recomputeClusters();
  }

  private async loadKlines() {
    const [minutes, daily] = await Promise.all([
      fetchKlines("1m", 1000),
      fetchKlines("1d", 60),
    ]);
    // The socket opens independently of this fetch and may already have pushed
    // live bars into `minutes`. Assigning the REST result over the top would
    // discard them and, worse, leave a bar that the stream has since updated.
    // Merge by open time with the live copy winning.
    const byTime = new Map<number, Kline>();
    for (const bar of minutes) byTime.set(bar.openTime, bar);
    for (const bar of this.minutes) byTime.set(bar.openTime, bar);
    this.minutes = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
    if (this.minutes.length > 1200) this.minutes = this.minutes.slice(-1200);
    this.daily = daily;
  }

  /**
   * The engine is a tab-level singleton that is deliberately never stopped, so
   * these polls otherwise keep running for as long as the tab exists — in a
   * background tab, or after the visitor has navigated to another route
   * entirely. Nobody is reading the number then, and it is refetched the moment
   * the page is looked at again, so the request is pure rate-limit spend.
   */
  private get pollable() {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  private async refreshOpenInterest() {
    if (!this.pollable) return;
    try {
      const oi = await fetchOpenInterest();
      const price = this.mark?.markPrice ?? this.book.mid() ?? this.last ?? 0;
      this.openInterest = {
        qty: oi.qty,
        notional: oi.qty * price,
        t: oi.t,
        fetchedAt: Date.now(),
      };
    } catch {
      /* transient; the previous value stays on screen */
    }
  }

  /**
   * Settled rates change once every few hours at most, so this is fetched once
   * at start and refreshed on a slow timer purely to pick up the settlement
   * that just happened. There is nothing to gain from polling it faster and a
   * shared rate-limit budget to lose.
   */
  private async refreshFundingHistory() {
    if (!this.pollable) return;
    const rows = await fetchFundingHistory(200);
    if (rows.length) this.fundingHistory = rows;
  }

  private async refreshRatio() {
    if (!this.pollable) return;
    // Only polled every five minutes, so a single failure would blank the
    // ladder's long/short split for that long. Keep the last good reading.
    const ratio = await fetchLongShortRatio();
    if (ratio !== null) this.longShortRatio = ratio;
  }

  /**
   * A depth snapshot is the most expensive call this page makes (weight 20 of a
   * 2400/min budget), and a broken book asks for one on *every* diff — ten times
   * a second. The retry therefore has to be a single chain: one timer, backed
   * off, cancelled on stop. Rescheduling unconditionally is what turns a brief
   * outage into a rate-limit ban, and on the proxy route that ban is shared by
   * every visitor.
   */
  private scheduleResync(delayMs: number) {
    if (this.resyncTimer || !this.started) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      void this.resync();
    }, delayMs);
  }

  private async resync() {
    if (this.snapshotPending || this.resyncTimer || !this.started) return;
    // A snapshot can be fetched successfully and still leave the book unsynced
    // — a stale snapshot never straddles the incoming diffs. Every diff then
    // asks to resync again, so success alone is not enough to allow another
    // immediate call; the floor applies to attempts, not to failures.
    const since = Date.now() - this.lastResyncAt;
    if (since < MIN_RESYNC_INTERVAL_MS) {
      this.scheduleResync(MIN_RESYNC_INTERVAL_MS - since);
      return;
    }
    this.lastResyncAt = Date.now();
    this.snapshotPending = true;
    try {
      const snap = await fetchDepthSnapshot(1000);
      this.book.applySnapshot(snap);
    } catch (err) {
      this.connection = {
        ...this.connection,
        error: `book snapshot: ${err instanceof Error ? err.message : String(err)}`,
      };
      // Honour an explicit cooldown when Binance gave us one; otherwise back off
      // exponentially to a 30s ceiling, with jitter so that reconnecting tabs do
      // not all come back in the same instant.
      const limited = err instanceof RateLimited ? err.retryAfterMs : 0;
      const backoff = Math.min(30_000, 1_000 * 2 ** this.resyncAttempt);
      this.resyncAttempt++;
      this.scheduleResync(Math.max(limited, backoff) + Math.random() * 500);
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
        const diff = d as unknown as DepthDiff;
        const midNow = this.book.mid();
        if (midNow) this.participants.onDepthDiff(diff.b ?? [], diff.a ?? [], midNow, Date.now());
        const ok = this.book.apply(diff);
        if (!ok) void this.resync();
        // Only a book that is actually applying diffs clears the backoff. The
        // snapshot request returning 200 does not mean the handshake completed.
        else if (this.book.synced) this.resyncAttempt = 0;
        this.connection.bookSynced = this.book.synced;
        this.connection.resyncs = this.book.resyncs;
        // Mark-outs resolve here rather than in the 2Hz sampler: the shortest
        // horizon is one second, and resolving it half a second late would put
        // most of the error in the most informative measurement.
        const after = this.book.mid();
        if (after) {
          const bb = this.book.bestBid();
          const ba = this.book.bestAsk();
          this.markout.onMid(Date.now(), after, bb && ba ? ((ba - bb) / after) * 10_000 : 0);
        }
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
        this.participants.onTrade(trade, Date.now());
        this.markout.onTrade(trade, Date.now());
        if (notional >= CONFIG.largeTradeNotional) {
          this.largeTrades.unshift(trade);
          if (this.largeTrades.length > 200) this.largeTrades.length = 200;
        }
        break;
      }
      case "forceOrder": {
        const o = d.o as Record<string, unknown>;
        // `ap` is the average fill price and is "0" until the order actually
        // fills. Taking it blindly puts a liquidation at price 0, which then
        // anchors a phantom cluster at the bottom of the map.
        const avg = Number(o.ap);
        const price = Number.isFinite(avg) && avg > 0 ? avg : Number(o.p);
        const qty = Number(o.q);
        const side = String(o.S) as "BUY" | "SELL";
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) break;
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
    // The expected-depth multiplier goes in with the sample so the baseline and
    // the expectation decay over identical windows.
    const scale = sessionState().weights.depthScale;
    this.tracker.sample(Date.now(), primary.bidNotional, primary.askNotional, mid, scale);
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

  /**
   * Recent movement of mid, expressed as a percent-per-minute standard
   * deviation. Sizing needs this so a stop is not placed inside the noise: a
   * 0.5% stop on a contract that routinely moves 0.8% a minute is a donation.
   */
  private realisedVolPct(): number {
    const samples = this.tracker.history(240);
    if (samples.length < 20) return 0;
    const returns: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].mid;
      const b = samples[i].mid;
      if (a > 0 && b > 0) returns.push(Math.log(b / a));
    }
    if (returns.length < 10) return 0;
    const mean = returns.reduce((x, y) => x + y, 0) / returns.length;
    const variance = returns.reduce((x, y) => x + (y - mean) ** 2, 0) / returns.length;
    const perSample = Math.sqrt(variance);
    // Samples land every CONFIG.sampleIntervalMs; scale to one minute.
    const perMinute = perSample * Math.sqrt(60_000 / CONFIG.sampleIntervalMs);
    return perMinute * 100;
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
      const adj = idx.sessionAdj;
      liquidity = {
        bands,
        primary,
        costCurve: costCurve(bids, asks, mid),
        walls: findWalls(bids, asks, mid),
        lwi: this.tracker.warm ? idx.total : 1,
        lwiBid: this.tracker.warm ? idx.bid : 1,
        lwiAsk: this.tracker.warm ? idx.ask : 1,
        lwiAdj: this.tracker.warm ? idx.total * adj : 1,
        lwiBidAdj: this.tracker.warm ? idx.bid * adj : 1,
        lwiAskAdj: this.tracker.warm ? idx.ask * adj : 1,
        sessionAdj: adj,
        warm: this.tracker.warm,
        baselineNotional: idx.baseline,
        fastNotional: idx.fast,
        decomp,
        imbalance: total > 0 ? (primary.bidNotional - primary.askNotional) / total : 0,
        spreadBps: bestBid && bestAsk ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
      };
    }

    // The *adjusted* index, not the raw one. The cascade cost already comes off
    // the real book, so a thin overnight book has made the seed cheap on its
    // own; feeding the raw index in as well would score that thinness a second
    // time as if somebody had pulled it.
    const cascadeInput = {
      bids,
      asks,
      mid: mid ?? 0,
      clusters: this.clusters,
      lwiBid: liquidity?.lwiBidAdj ?? 1,
      lwiAsk: liquidity?.lwiAskAdj ?? 1,
      openInterestNotional: this.openInterest?.notional ?? 0,
    };

    const now = Date.now();
    this.snapshot = {
      ts: now,
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
      flowMinute: this.tracker.flowSince(60_000),
      volatilityPct: this.realisedVolPct(),
      participants: this.participants.read(),
      markout: this.markout.read(now),
      funding: readFunding(this.mark, this.fundingHistory, now),
      events: eventRisk(now, [...this.extraEvents, ...this.storedEvents]),
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
    session: PLACEHOLDER_SESSION,
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
    flowMinute: { buy: 0, sell: 0 },
    volatilityPct: 0,
    participants: null,
    markout: EMPTY_MARKOUT,
    funding: EMPTY_FUNDING,
    events: NO_EVENT_RISK,
  };
}

let singleton: Engine | null = null;

/** One engine per tab, shared by every component that reads from it. */
export function getEngine(): Engine {
  if (!singleton) singleton = new Engine();
  return singleton;
}

export { SYMBOL };
