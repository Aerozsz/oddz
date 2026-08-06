import { CONFIG } from "../config";
import type { Decomposition, DepthSample, Side, ThinningEvent } from "../types";

interface Sample {
  t: number;
  bid: number;
  ask: number;
  mid: number;
  /** Cumulative aggressive notional since the tracker started. */
  cumBuy: number;
  cumSell: number;
}

/**
 * Depth falling is ambiguous on its own. It can mean liquidity was *consumed*
 * — trades ate through it, which is ordinary and self-limiting — or that it was
 * *withdrawn*, quotes cancelled with nothing printed against them. Only the
 * second one is the precondition described in the model: reserves leaving, so
 * that the next order of ordinary size travels much further than it should.
 *
 * The two are separable because trades are observable. Over a window:
 *
 *     Δdepth = added − consumed − withdrawn
 *
 * with `consumed` known from the trade tape, so the residual is cancellation.
 * A continuous feed is required for this to mean anything; sampled snapshots
 * lose exactly the fast pulls this is meant to catch.
 */
export class WithdrawalTracker {
  private samples: Sample[] = [];
  private cumBuy = 0;
  private cumSell = 0;

  private fast: { bid: number; ask: number } | null = null;
  private slow: { bid: number; ask: number } | null = null;

  /**
   * The expected-depth multiplier, decayed on the same slow half-life as the
   * depth baseline itself.
   *
   * This is what lets a session change be told apart from a withdrawal. The
   * baseline is a ten-minute EWMA, so at 16:05 ET it still describes the cash
   * session; depth has genuinely halved, and the raw index reports 0.5 as if
   * somebody pulled half the book. Carrying a matched EWMA of what depth was
   * *supposed* to be over the same window means the two divide out, and what is
   * left is the part the clock does not explain.
   */
  private slowScale: number | null = null;
  private currentScale = 1;

  private lastEventAt = 0;
  events: ThinningEvent[] = [];

  /**
   * The publish loop runs at 10Hz but samples land at 2Hz, so the derived
   * history is rebuilt five times per change. At half an hour of samples that
   * is thousands of throwaway objects a second, on a page designed to be left
   * open all day. Cached against the sample that produced it.
   */
  private historyCache: { key: number; maxPoints: number; value: DepthSample[] } | null = null;

  /** Index of the first sample at or after `t`. Samples are ordered by time. */
  private firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Aggressive prints, accumulated between samples. */
  addTrade(notional: number, buyerIsMaker: boolean) {
    if (buyerIsMaker) this.cumSell += notional;
    else this.cumBuy += notional;
  }

  /** Rolling one-second aggressive flow, for the tape headline. */
  flowSince(ms: number): { buy: number; sell: number } {
    const cutoff = Date.now() - ms;
    const ref = this.samples[this.firstAtOrAfter(cutoff)] ?? this.samples[0];
    if (!ref) return { buy: 0, sell: 0 };
    return { buy: this.cumBuy - ref.cumBuy, sell: this.cumSell - ref.cumSell };
  }

  sample(t: number, bid: number, ask: number, mid: number, depthScale = 1) {
    const prev = this.samples.at(-1);
    this.currentScale = depthScale > 0 ? depthScale : 1;
    this.samples.push({ t, bid, ask, mid, cumBuy: this.cumBuy, cumSell: this.cumSell });
    const cutoff = t - CONFIG.sampleHistorySec * 1000;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();

    // Measured, not assumed. The sampler is a setInterval, and browsers throttle
    // those to roughly once a minute in a background tab — so a nominal 500ms
    // step would decay the baseline at a fraction of real time whenever the page
    // is not in front, and the depth index would read as normal through exactly
    // the kind of withdrawal it exists to catch. A machine waking from sleep is
    // the same problem an order of magnitude larger.
    const dtSec = prev ? Math.max(0.001, (t - prev.t) / 1000) : CONFIG.sampleIntervalMs / 1000;
    this.fast = ewma(this.fast, { bid, ask }, dtSec, CONFIG.fastHalfLifeSec);
    this.slow = ewma(this.slow, { bid, ask }, dtSec, CONFIG.slowHalfLifeSec);
    // Same half-life as `slow`, so the two describe the same window and the
    // ratio between them is meaningful.
    const alphaSlow = 1 - Math.pow(0.5, dtSec / CONFIG.slowHalfLifeSec);
    this.slowScale =
      this.slowScale === null ? this.currentScale : this.slowScale + alphaSlow * (this.currentScale - this.slowScale);

    this.detect(t, bid, ask);
  }

  private detect(t: number, bid: number, ask: number) {
    if (!this.slow) return;
    if (t - this.lastEventAt < 5_000) return;
    const d = this.decompose();
    if (!d) return;
    // Compare against what depth is expected to be *now*, not against what it
    // averaged over a window that may have straddled the cash close. Without
    // this, every session boundary fires a thinning event on both sides.
    const expectedFrac = this.slowScale && this.slowScale > 0 ? this.currentScale / this.slowScale : 1;
    for (const side of ["bid", "ask"] as const) {
      const withdrawn = side === "bid" ? d.withdrawnBid : d.withdrawnAsk;
      const consumed = side === "bid" ? d.consumedBid : d.consumedAsk;
      const baseline = (side === "bid" ? this.slow.bid : this.slow.ask) * expectedFrac;
      const now = side === "bid" ? bid : ask;
      if (baseline <= 0) continue;
      if (withdrawn > baseline * CONFIG.thinningWithdrawFrac && withdrawn > consumed) {
        this.events.unshift({
          t,
          side,
          withdrawn,
          consumed,
          remainingFrac: now / baseline,
        });
        this.events = this.events.slice(0, 60);
        this.lastEventAt = t;
        return;
      }
    }
  }

  decompose(windowSec = CONFIG.decompWindowSec): Decomposition | null {
    const last = this.samples.at(-1);
    if (!last) return null;
    const cutoff = last.t - windowSec * 1000;
    const first = this.samples[this.firstAtOrAfter(cutoff)];
    if (!first || first === last) return null;

    const dBid = last.bid - first.bid;
    const dAsk = last.ask - first.ask;
    // Aggressive sells hit bids; aggressive buys lift offers.
    const consumedBid = last.cumSell - first.cumSell;
    const consumedAsk = last.cumBuy - first.cumBuy;

    // added − consumed − withdrawn = Δ, and a level cannot be both added and
    // withdrawn on net, so the residual lands on exactly one of the two.
    const residBid = dBid + consumedBid;
    const residAsk = dAsk + consumedAsk;

    return {
      windowSec,
      consumedBid,
      consumedAsk,
      withdrawnBid: residBid < 0 ? -residBid : 0,
      withdrawnAsk: residAsk < 0 ? -residAsk : 0,
      addedBid: residBid > 0 ? residBid : 0,
      addedAsk: residAsk > 0 ? residAsk : 0,
    };
  }

  /**
   * Current depth over its slow baseline. Below 1 means thinner than usual.
   *
   * `sessionAdj` is what the raw figures must be multiplied by to remove the
   * part of the change that the clock already accounts for — see `slowScale`.
   * It is reported rather than folded in so both readings stay available: the
   * raw one is what the book actually looks like to an order, the adjusted one
   * is whether anybody did anything unusual.
   */
  index(): {
    total: number;
    bid: number;
    ask: number;
    baseline: number;
    fast: number;
    sessionAdj: number;
  } {
    const last = this.samples.at(-1);
    if (!last || !this.slow || !this.fast) {
      return { total: 1, bid: 1, ask: 1, baseline: 0, fast: 0, sessionAdj: 1 };
    }
    const baseline = this.slow.bid + this.slow.ask;
    const now = last.bid + last.ask;
    const sessionAdj =
      this.slowScale && this.slowScale > 0 && this.currentScale > 0 ? this.slowScale / this.currentScale : 1;
    return {
      total: baseline > 0 ? now / baseline : 1,
      bid: this.slow.bid > 0 ? last.bid / this.slow.bid : 1,
      ask: this.slow.ask > 0 ? last.ask / this.slow.ask : 1,
      baseline,
      fast: this.fast.bid + this.fast.ask,
      sessionAdj,
    };
  }

  history(maxPoints = 600): DepthSample[] {
    const n = this.samples.length;
    const key = n === 0 ? 0 : this.samples[n - 1].t * 1e6 + n;
    const cached = this.historyCache;
    if (cached && cached.key === key && cached.maxPoints === maxPoints) return cached.value;

    let value: DepthSample[];
    if (n <= maxPoints) {
      value = this.samples.map(toPublic);
    } else {
      const stride = Math.ceil(n / maxPoints);
      value = [];
      for (let i = n - 1; i >= 0; i -= stride) value.unshift(toPublic(this.samples[i]));
    }
    this.historyCache = { key, maxPoints, value };
    return value;
  }

  /**
   * True once the slow baseline has seen enough data to mean something.
   *
   * Measured as elapsed time rather than a sample count, for the same reason
   * the EWMA step is: a throttled tab accumulates samples slowly, and counting
   * them would report a baseline as cold for an hour of real observation. Both
   * conditions are required — a handful of samples spread over a minute is not
   * a baseline either.
   */
  get warm() {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last) return false;
    return last.t - first.t >= 30_000 && this.samples.length >= 10;
  }
}

function toPublic(s: Sample): DepthSample {
  return { t: s.t, bid: s.bid, ask: s.ask, mid: s.mid };
}

function ewma(
  prev: { bid: number; ask: number } | null,
  next: { bid: number; ask: number },
  dtSec: number,
  halfLifeSec: number,
) {
  if (!prev) return { ...next };
  const alpha = 1 - Math.pow(0.5, dtSec / halfLifeSec);
  return {
    bid: prev.bid + alpha * (next.bid - prev.bid),
    ask: prev.ask + alpha * (next.ask - prev.ask),
  };
}

export function sideLabel(s: Side) {
  return s === "bid" ? "bids" : "asks";
}
