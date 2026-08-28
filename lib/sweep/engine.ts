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
import { NO_EVENT_RISK, eventRisk, parseEnvEvents, type MarketEvent } from "./metrics/events";
import { EMPTY_FUNDING, type FundingSettlement, readFunding } from "./metrics/funding";
import { EMPTY_MARKOUT, MarkoutTracker } from "./metrics/markout";
import { PLACEHOLDER_SESSION, sessionState } from "./metrics/session";
import { CascadeOutcomes, EMPTY_CALIBRATION } from "./metrics/cascade-outcomes";
import { ShockDetector, NO_SHOCK } from "./metrics/shock";
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
  /**
   * The contract this engine watches.
   *
   * One engine per symbol rather than one engine handling several: the book,
   * the withdrawal baselines, the participant tracker and the mark-out tracker
   * are all per-contract state with no meaningful cross-symbol form, and
   * interleaving them in one object would mean threading a symbol through every
   * one of them to keep them apart again.
   */
  readonly symbol: string;

  constructor(symbol: string = SYMBOL) {
    this.symbol = symbol;
  }

  private book = new OrderBook();
  private stream: StreamClient | null = null;
  private tracker = new WithdrawalTracker();
  private participants = new ParticipantTracker();
  /** Price the rounding scale was last derived at, so it is not redone per trade. */
  private scaleAt = 0;
  /** Regime-break detector fed from the same stream. See metrics/shock.ts. */
  private shock = new ShockDetector();
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
   * Extra calendar entries, pushed in from outside.
   *
   * A setter rather than the engine reading the file itself, because this
   * module is bundled for the browser and a static `node:fs` import breaks that
   * build outright — a `typeof window` guard does not help, since the import is
   * resolved at bundle time regardless of whether the code runs. Inverting it
   * is also the better shape: this is a market-data engine, and which file the
   * calendar lives in is not its business.
   *
   * The headless workers call this on a timer, so a date the agent confirms at
   * 10am is picked up without a restart. A browser session never calls it and
   * correctly falls back to the projection with its standing prompt to confirm.
   */
  private storedEvents: MarketEvent[] = [];

  setCalendar(events: MarketEvent[]) {
    this.storedEvents = events;
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
  /**
   * Whether the cascade projection is borne out by the tape.
   *
   * Lives on the engine rather than beside the simulator because it needs the
   * one thing a pure function cannot have: memory of what was projected before,
   * and of what price did afterwards. See metrics/cascade-outcomes.ts.
   */
  private readonly outcomes = new CascadeOutcomes();
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
    byEvent: {},
    lastControlFrame: null,
    controlFrames: 0,
    subscribed: [],
    framesByStream: {},
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
      onControlFrame: (raw) => {
        this.connection = {
          ...this.connection,
          controlFrames: this.connection.controlFrames + 1,
          lastControlFrame: raw.slice(0, 400),
        };
      },
    }, this.symbol);
    this.connection = { ...this.connection, subscribed: this.stream.subscribedTo() };
    // Refreshed on a timer rather than per frame: this is read by a diagnostic
    // once every couple of minutes and rebuilding the object on the hot path
    // would cost far more than the question is worth.
    this.timers.push(
      setInterval(() => {
        const stream = this.stream;
        if (!stream) return;
        this.connection = { ...this.connection, framesByStream: stream.framesByStream() };
      }, 10_000),
    );
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

  /** Spread in basis points from the live book, or 0 when it is not two-sided. */
  private spreadBpsNow(): number {
    const bid = this.book.bestBid();
    const ask = this.book.bestAsk();
    const mid = this.book.mid();
    return bid && ask && mid ? ((ask - bid) / mid) * 10_000 : 0;
  }

  /**
   * The tape's own regime-break reading. Milliseconds, no network.
   *
   * Every news source is at best seconds late and usually minutes; the order
   * book is not late, because it is where the event happens. See metrics/shock.ts.
   */
  readShock(now = Date.now()) {
    try {
      return this.shock.read(this.spreadBpsNow(), now);
    } catch {
      return NO_SHOCK;
    }
  }

  getSnapshot = () => this.snapshot;

  /* -------------------------------------------------------------- bootstrap */

  private async bootstrap() {
    try {
      this.meta = await fetchMeta(this.symbol);
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
      fetchKlines("1m", 1000, this.symbol),
      fetchKlines("1d", 60, this.symbol),
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
      const oi = await fetchOpenInterest(this.symbol);
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
    const rows = await fetchFundingHistory(200, this.symbol);
    if (rows.length) this.fundingHistory = rows;
  }

  private async refreshRatio() {
    if (!this.pollable) return;
    // Only polled every five minutes, so a single failure would blank the
    // ladder's long/short split for that long. Keep the last good reading.
    const ratio = await fetchLongShortRatio(this.symbol);
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
      const snap = await fetchDepthSnapshot(1000, this.symbol);
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
    /*
     * Counted before the switch, so a message with an event name nothing
     * handles is still visible. An unrecognised name and an absent stream are
     * both "no trades arrived" from the consumer's side and have opposite
     * fixes.
     */
    const bucket = typeof type === "string" && type ? type : `(no e: ${Object.keys(d).slice(0, 6).join(",")})`;
    this.connection.byEvent[bucket] = (this.connection.byEvent[bucket] ?? 0) + 1;

    switch (type) {
      case "depthUpdate": {
        const diff = d as unknown as DepthDiff;
        const midNow = this.book.mid();
        if (midNow) {
          this.participants.onDepthDiff(diff.b ?? [], diff.a ?? [], midNow, Date.now());
          // Same tick, so the shock baseline advances with real elapsed time
          // rather than with however often anyone happens to ask for it.
          this.shock.onTick(midNow, this.spreadBpsNow(), Date.now());
        }
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
        /*
         * Told what a round number looks like here before it is asked.
         *
         * The roundness measures are relative to the contract — a $100 price is
         * round for Bitcoin and absurd for a $30 stock — and without this the
         * tracker falls back to equity-perp constants that invert on a crypto
         * perp rather than merely degrading. Cheap enough for the hot path: it
         * recomputes only when the price has moved an order of magnitude.
         */
        if (this.meta && (this.scaleAt === 0 || price / this.scaleAt > 3 || this.scaleAt / price > 3)) {
          this.participants.setScale(this.meta.tickSize, this.meta.stepSize, price);
          this.scaleAt = price;
        }
        this.participants.onTrade(trade, Date.now());
        this.shock.onTrade(trade, Date.now());
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
        // Direct evidence that stops existed where a cluster said they did.
        this.outcomes.liquidation(price * qty);
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
    /*
     * Simulate, then feed the result to the outcome tracker before publishing.
     *
     * Order matters: the tracker arms on the projection that is about to be
     * shown, so what gets scored is the number the operator actually saw rather
     * than one recomputed later from a book that has since moved.
     */
    const calibration = this.outcomes.read();
    const cascadeDown = mid ? simulate({ ...cascadeInput, calibration: calibration.factor }, "down") : null;
    const cascadeUp = mid ? simulate({ ...cascadeInput, calibration: calibration.factor }, "up") : null;
    if (mid) {
      this.outcomes.price(mid, now);
      for (const path of [cascadeDown, cascadeUp]) {
        const first = path?.links[0]?.cluster;
        if (path && first) {
          this.outcomes.observe(path.direction, mid, first.price, path.terminalPrice, path.risk, now);
        }
      }
    }

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
      cascadeDown,
      cascadeUp,
      cascadeCalibration: calibration,
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
      byEvent: {},
      lastControlFrame: null,
      controlFrames: 0,
      subscribed: [],
      framesByStream: {},
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
    cascadeCalibration: EMPTY_CALIBRATION,
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

const engines = new Map<string, Engine>();

/**
 * One engine per symbol, shared by everything that reads that symbol.
 *
 * Keyed rather than a single instance so a group of correlated contracts can be
 * watched at once. Calling it with no argument keeps returning the same engine
 * for the configured symbol, so every existing caller is unaffected.
 */
export function getEngine(symbol: string = SYMBOL): Engine {
  let e = engines.get(symbol);
  if (!e) {
    e = new Engine(symbol);
    engines.set(symbol, e);
  }
  return e;
}

/** Every engine currently constructed. */
export function allEngines(): Engine[] {
  return [...engines.values()];
}

/**
 * Stop an engine and forget it, so a symbol can be dropped at runtime.
 *
 * Closing the feed alone is not enough and the difference is a resource leak
 * with a socket attached. A feed unsubscribes; the engine underneath keeps its
 * WebSocket, its resync timer and its rolling baselines, because it is
 * deliberately shared — the dashboard and any number of feeds read one engine so
 * they cannot drift. That sharing is right while a symbol is being watched and
 * wrong once it is removed: without this, every add/remove cycle would leave
 * another live stream behind, and the rate limit would eventually be spent on
 * contracts nobody is looking at.
 *
 * Deliberately unconditional. There is no reference count here, so the caller
 * has to know it is the last reader — which the control server does, since it
 * owns the only feed per symbol.
 */
export function dropEngine(symbol: string): boolean {
  const e = engines.get(symbol);
  if (!e) return false;
  e.stop();
  engines.delete(symbol);
  return true;
}

export { SYMBOL };
