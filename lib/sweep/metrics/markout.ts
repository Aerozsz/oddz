import type { Trade } from "../types";

/**
 * Mark-out: whether the aggressive side is being proven right.
 *
 * Every print has a buyer and a seller and one of them is about to look
 * foolish. Mark-out asks which, by comparing the trade price against the mid a
 * fixed interval later. If prints that lifted the offer are followed by a
 * higher mid, the buyers knew something; if the mid is unchanged or lower, they
 * paid the spread for nothing.
 *
 * Two things fall out of that, and they are the reason this module exists
 * rather than being a curiosity:
 *
 *  1. **Direction with a track record.** Every other directional input here
 *     describes the state of the book — how thin it is, where the stops sit.
 *     None of them says whether the people currently pushing have been right.
 *     This does, and it is the only input in the tool that is scored against
 *     what actually happened next rather than against a model.
 *
 *  2. **The mechanism behind withdrawal.** A market maker earns the spread and
 *     pays the mark-out. When mark-out exceeds the half-spread, quoting is a
 *     losing trade and the rational response is to widen or leave. That is
 *     precisely the depth withdrawal the rest of this tool is built to detect —
 *     so toxicity is a *leading* indicator of it, measured on the flow that
 *     causes it rather than on the depth that has already gone.
 *
 * What it is not: a forecast. A positive mark-out says informed flow has been
 * present over the measurement window, not that the next print is informed.
 * The horizons are short for that reason.
 */

/** Seconds after a print at which the mid is compared back to it. */
export const HORIZONS = [1, 5, 30] as const;
export type Horizon = (typeof HORIZONS)[number];

/**
 * Prints are bucketed before being marked out. A busy second on this contract
 * is a few hundred aggTrades and each would otherwise carry three pending
 * resolutions; bucketing costs nothing in accuracy at a one-second horizon and
 * bounds the work to a few hundred live objects.
 */
const BUCKET_MS = 200;

/** Half-life of the rolling mean, in seconds of wall time. */
const DECAY_HALF_LIFE_SEC = 180;

/**
 * Floor on the half-spread used as the reference for "is this flow expensive".
 * A book quoted a tick wide would otherwise divide by something near zero and
 * report every print as catastrophically toxic.
 */
const MIN_REFERENCE_BPS = 0.5;

interface Bucket {
  t: number;
  buyNotional: number;
  sellNotional: number;
  /** Notional-weighted average price, per side. */
  buyVwap: number;
  sellVwap: number;
  /** Horizons already resolved for this bucket. */
  done: number;
}

/** One decaying notional-weighted mean. */
class DecayingMean {
  private sumW = 0;
  private sumWX = 0;
  private at = 0;

  add(t: number, x: number, w: number) {
    this.decayTo(t);
    this.sumW += w;
    this.sumWX += w * x;
  }

  /** Weight is decayed to `t` before reading, so a quiet market goes cold. */
  value(t: number): number | null {
    this.decayTo(t);
    return this.sumW > 0 ? this.sumWX / this.sumW : null;
  }

  weight(t: number): number {
    this.decayTo(t);
    return this.sumW;
  }

  private decayTo(t: number) {
    if (this.at === 0) {
      this.at = t;
      return;
    }
    const dt = (t - this.at) / 1000;
    if (dt <= 0) return;
    const factor = Math.pow(0.5, dt / DECAY_HALF_LIFE_SEC);
    this.sumW *= factor;
    this.sumWX *= factor;
    this.at = t;
  }
}

export interface HorizonRead {
  sec: number;
  /** Mean mark-out on aggressive buys, in bps. Positive = buyers were right. */
  buyBps: number | null;
  /** Mean mark-out on aggressive sells, in bps. Positive = sellers were right. */
  sellBps: number | null;
  /**
   * What the passive side lost per unit traded, both sides blended. This is the
   * quantity a market maker actually cares about, and it is not the difference
   * between the two above — a maker loses on a correct buyer *and* on a correct
   * seller.
   */
  costToMakerBps: number | null;
  /** Notional behind the estimate, decayed. */
  weight: number;
}

export type MarkoutRegime =
  /** Flow is paying the spread and not being rewarded. Quoting is profitable. */
  | "benign"
  /** One side is informed, the other is not. Directional, not yet toxic. */
  | "one-sided"
  /** Mark-out exceeds the spread. Quoting loses money; expect depth to leave. */
  | "toxic"
  | "unknown";

export interface MarkoutRead {
  warm: boolean;
  /**
   * Which of the three warm-up conditions is unmet, and by how far.
   *
   * `warm` is an AND of three separate things and reports as one boolean, so a
   * tracker that never warms gives no clue which gate is shut. That cost the
   * project a genuinely expensive mistake: `canPostEntry` refuses on its first
   * line when mark-out is cold, so the maker path — carried for weeks as "the
   * largest unexplored lever, gated on toxicity" — was never gated on toxicity
   * at all. It was never reached. 23,880 shadow decisions and every live record
   * came back cold, and the toxicity test ran zero times.
   *
   * A boolean that is false for three possible reasons is not an observation.
   * These are the three, so the next reading says which.
   */
  warmth: {
    /** One-second horizons resolved. Needs 40. */
    resolved: number;
    resolvedNeeded: number;
    /** Milliseconds since the first trade arrived. Needs 60,000. */
    sinceFirstTradeMs: number | null;
    /** Decayed weight behind the five-second horizon. Needs to be above zero. */
    mainWeight: number;
    /** Trades handed to the tracker at all — zero means it is not wired up. */
    tradesSeen: number;
  };
  horizons: HorizonRead[];
  /**
   * −1..1. Positive means aggressive buying has been the informed side over the
   * measurement window. Read as "who has been right lately", not as a forecast.
   */
  informed: number;
  /**
   * 0..1. How far mark-out has run past the half-spread. At 1 the passive side
   * is losing at least as much to adverse selection as it earns from quoting,
   * which is the condition under which depth gets pulled.
   */
  toxicity: number;
  regime: MarkoutRegime;
  /** Half-spread the toxicity figure was measured against, in bps. */
  referenceBps: number;
  notes: string[];
}

export const EMPTY_MARKOUT: MarkoutRead = {
  warm: false,
  warmth: { resolved: 0, resolvedNeeded: 40, sinceFirstTradeMs: null, mainWeight: 0, tradesSeen: 0 },
  horizons: HORIZONS.map((sec) => ({ sec, buyBps: null, sellBps: null, costToMakerBps: null, weight: 0 })),
  informed: 0,
  toxicity: 0,
  regime: "unknown",
  referenceBps: MIN_REFERENCE_BPS,
  notes: [],
};

/* --------------------------------------------------------------- own fills */

export interface OwnFill {
  t: number;
  side: "buy" | "sell";
  price: number;
  notional: number;
  /** Mid at the moment the order was sent, when known. */
  arrivalMid: number | null;
  tag?: string;
}

export interface FillQuality {
  count: number;
  /** Mean distance from arrival mid to fill price, in bps. Positive = paid up. */
  slippageBps: number | null;
  /** Mean mark-out at 30s from our own side's view. Negative = we were run over. */
  markoutBps: number | null;
}

/* ------------------------------------------------------------------ tracker */

export class MarkoutTracker {
  private buckets: Bucket[] = [];
  private current: Bucket | null = null;

  private buy = new Map<number, DecayingMean>();
  private sell = new Map<number, DecayingMean>();

  private lastMid = 0;
  private lastSpreadBps = 0;
  private firstTradeAt = 0;
  /*
   * Counted so a cold tracker can be told from an unwired one. Zero here means
   * no trade stream reached this object at all, which is a different fault from
   * a stream that arrived and did not resolve — and the two were previously
   * indistinguishable from outside, both reporting warm:false.
   */
  private tradesSeen = 0;
  private resolved = 0;

  private ownFills: (OwnFill & { markBps: number | null; resolvedAt: number })[] = [];

  constructor() {
    for (const h of HORIZONS) {
      this.buy.set(h, new DecayingMean());
      this.sell.set(h, new DecayingMean());
    }
  }

  onTrade(trade: Trade, now = trade.t) {
    if (!Number.isFinite(trade.price) || trade.price <= 0) return;
    if (!this.firstTradeAt) this.firstTradeAt = now;
    this.tradesSeen++;

    const slot = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    if (!this.current || this.current.t !== slot) {
      if (this.current) this.buckets.push(this.current);
      this.current = { t: slot, buyNotional: 0, sellNotional: 0, buyVwap: 0, sellVwap: 0, done: 0 };
    }
    const b = this.current;

    // buyerIsMaker means the aggressor was a seller.
    if (trade.buyerIsMaker) {
      const total = b.sellNotional + trade.notional;
      b.sellVwap = total > 0 ? (b.sellVwap * b.sellNotional + trade.price * trade.notional) / total : trade.price;
      b.sellNotional = total;
    } else {
      const total = b.buyNotional + trade.notional;
      b.buyVwap = total > 0 ? (b.buyVwap * b.buyNotional + trade.price * trade.notional) / total : trade.price;
      b.buyNotional = total;
    }
  }

  /**
   * Called on every book update. This is what resolves pending mark-outs, so it
   * must be driven by the depth feed rather than by a slow sampler — a 500ms
   * sampler resolving a one-second horizon carries half a second of error into
   * the shortest and most informative measurement.
   */
  onMid(t: number, mid: number, spreadBps: number) {
    if (!Number.isFinite(mid) || mid <= 0) return;
    this.lastMid = mid;
    if (Number.isFinite(spreadBps) && spreadBps > 0) this.lastSpreadBps = spreadBps;

    // The in-progress bucket becomes resolvable once its window has closed.
    if (this.current && t - this.current.t >= BUCKET_MS) {
      this.buckets.push(this.current);
      this.current = null;
    }

    let keep = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      const b = this.buckets[i];
      for (let hi = 0; hi < HORIZONS.length; hi++) {
        const bit = 1 << hi;
        if (b.done & bit) continue;
        const h = HORIZONS[hi];
        if (t - b.t < h * 1000) continue;
        b.done |= bit;
        this.resolveOne(b, h, t, mid);
      }
      const allDone = b.done === (1 << HORIZONS.length) - 1;
      if (!allDone) this.buckets[keep++] = b;
    }
    this.buckets.length = keep;

    this.resolveOwnFills(t, mid);
  }

  private resolveOne(b: Bucket, h: Horizon, t: number, mid: number) {
    if (b.buyNotional > 0 && b.buyVwap > 0) {
      // A buy aggressor profits when the mid ends up above what they paid.
      const bps = ((mid - b.buyVwap) / b.buyVwap) * 10_000;
      this.buy.get(h)!.add(t, bps, b.buyNotional);
      if (h === 1) this.resolved++;
    }
    if (b.sellNotional > 0 && b.sellVwap > 0) {
      const bps = ((b.sellVwap - mid) / b.sellVwap) * 10_000;
      this.sell.get(h)!.add(t, bps, b.sellNotional);
      if (h === 1) this.resolved++;
    }
  }

  /* ------------------------------------------------------------ own fills */

  /** Record one of our own executions so its quality can be measured the same way. */
  recordFill(fill: OwnFill) {
    this.ownFills.push({ ...fill, markBps: null, resolvedAt: 0 });
    if (this.ownFills.length > 400) this.ownFills.shift();
  }

  private resolveOwnFills(t: number, mid: number) {
    const horizon = 30_000;
    for (const f of this.ownFills) {
      if (f.markBps !== null) continue;
      if (t - f.t < horizon) continue;
      // From our own side: a long is marked out favourably when mid rises.
      f.markBps =
        f.side === "buy"
          ? ((mid - f.price) / f.price) * 10_000
          : ((f.price - mid) / f.price) * 10_000;
      f.resolvedAt = t;
    }
  }

  fillQuality(): FillQuality {
    const withArrival = this.ownFills.filter((f) => f.arrivalMid !== null && f.arrivalMid > 0);
    const marked = this.ownFills.filter((f) => f.markBps !== null);

    const slippage = withArrival.length
      ? withArrival.reduce((s, f) => {
          const arrival = f.arrivalMid as number;
          // Positive means we paid worse than the mid we saw when we decided.
          const bps = f.side === "buy" ? ((f.price - arrival) / arrival) * 10_000 : ((arrival - f.price) / arrival) * 10_000;
          return s + bps * f.notional;
        }, 0) / withArrival.reduce((s, f) => s + f.notional, 0)
      : null;

    const markout = marked.length
      ? marked.reduce((s, f) => s + (f.markBps as number) * f.notional, 0) /
        marked.reduce((s, f) => s + f.notional, 0)
      : null;

    return { count: this.ownFills.length, slippageBps: slippage, markoutBps: markout };
  }

  /* ------------------------------------------------------------------ read */

  read(now = Date.now()): MarkoutRead {
    const reference = Math.max(MIN_REFERENCE_BPS, this.lastSpreadBps / 2);

    const horizons: HorizonRead[] = HORIZONS.map((sec) => {
      const buyMean = this.buy.get(sec)!;
      const sellMean = this.sell.get(sec)!;
      const buyBps = buyMean.value(now);
      const sellBps = sellMean.value(now);
      const wBuy = buyMean.weight(now);
      const wSell = sellMean.weight(now);
      const total = wBuy + wSell;
      return {
        sec,
        buyBps,
        sellBps,
        costToMakerBps:
          total > 0 ? ((buyBps ?? 0) * wBuy + (sellBps ?? 0) * wSell) / total : null,
        weight: total,
      };
    });

    // The 5s horizon is the working one: long enough to escape the bounce off
    // the touch that follows any print, short enough that it is still about
    // this flow rather than about the next thing that happened.
    const main = horizons[1];
    /*
     * Null, not a huge number, when no trade has ever arrived.
     *
     * `firstTradeAt` starts at zero, so `now - 0` is thirty-odd years of
     * milliseconds and this gate passed vacuously on a tracker that had never
     * seen a trade — the sixth zero-means-something-else in this codebase. It
     * did not change the verdict, because `resolved` was also zero, but it did
     * mean the reported reason would have been wrong.
     */
    const sinceFirstTradeMs = this.firstTradeAt ? now - this.firstTradeAt : null;
    const warmth = {
      resolved: this.resolved,
      resolvedNeeded: 40,
      sinceFirstTradeMs,
      mainWeight: main.weight,
      tradesSeen: this.tradesSeen,
    };
    const warm =
      this.resolved >= 40 && sinceFirstTradeMs !== null && sinceFirstTradeMs >= 60_000 && main.weight > 0;

    if (!warm) {
      return { ...EMPTY_MARKOUT, horizons, warmth, referenceBps: reference, warm: false };
    }

    const buyBps = main.buyBps ?? 0;
    const sellBps = main.sellBps ?? 0;
    const cost = main.costToMakerBps ?? 0;

    // Directional: buys being right pushes up, sells being right pushes down.
    // Divided by the reference so the scale is "in units of the spread".
    const informed = clamp(-1, 1, (buyBps - sellBps) / (2 * reference));
    const toxicity = clamp(0, 1, cost / reference);

    const regime: MarkoutRegime =
      toxicity >= 0.85
        ? "toxic"
        : Math.abs(informed) >= 0.5
          ? "one-sided"
          : "benign";

    const notes: string[] = [];
    if (regime === "toxic") {
      notes.push(
        `aggressive flow is marking out ${cost.toFixed(2)}bp against a ${reference.toFixed(2)}bp half-spread — ` +
          `quoting into it loses money, so expect depth to be pulled rather than replaced`,
      );
    } else if (regime === "one-sided") {
      notes.push(
        informed > 0
          ? `buyers have been right: lifting the offer marked out ${buyBps.toFixed(2)}bp higher 5s later`
          : `sellers have been right: hitting the bid marked out ${sellBps.toFixed(2)}bp lower 5s later`,
      );
    } else {
      notes.push(
        `flow is paying the spread and not being rewarded (${cost.toFixed(2)}bp mark-out vs ${reference.toFixed(2)}bp half-spread) — ` +
          `the passive side is making money here`,
      );
    }

    const fast = horizons[0].costToMakerBps;
    const slow = horizons[2].costToMakerBps;
    if (fast !== null && slow !== null && Math.abs(slow) > Math.abs(fast) * 1.8 && Math.abs(slow) > reference) {
      notes.push(`the move keeps going out to 30s (${slow.toFixed(2)}bp) — this is position-building, not a one-off print`);
    }

    return { warm: true, warmth, horizons, informed, toxicity, regime, referenceBps: reference, notes };
  }
}

function clamp(lo: number, hi: number, v: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0;
}
