import { CONFIG } from "../config";
import type { BookLevel } from "../types";

export interface DepthDiff {
  U: number; // first update id in this event
  u: number; // final update id in this event
  pu: number; // final update id in the previous event
  b: [string, string][];
  a: [string, string][];
}

/**
 * A locally maintained L2 book, kept in sync with the 100ms diff stream using
 * Binance's documented procedure: buffer diffs, take a REST snapshot, discard
 * everything the snapshot already covers, require the first applied diff to
 * straddle the snapshot id, then require every later diff to chain (pu equals
 * the previous u). A broken chain means we missed an update and the book is no
 * longer trustworthy, so it resyncs rather than drifting quietly.
 *
 * This is the difference between real-time and polled snapshots: the book here
 * is continuous, so depth that vanishes between two polls is still observable.
 */
export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sortedBids: BookLevel[] = [];
  private sortedAsks: BookLevel[] = [];
  private dirty = true;

  private buffer: DepthDiff[] = [];
  private snapshotId = 0;
  private lastUpdateId = 0;
  private primed = false;

  synced = false;
  resyncs = 0;
  lastAppliedAt = 0;

  reset() {
    this.bids.clear();
    this.asks.clear();
    this.sortedBids = [];
    this.sortedAsks = [];
    this.buffer = [];
    this.snapshotId = 0;
    this.lastUpdateId = 0;
    this.primed = false;
    this.synced = false;
    this.dirty = true;
  }

  /** Diffs that arrive before the snapshot are held, not dropped. */
  buffer_(diff: DepthDiff) {
    this.buffer.push(diff);
    if (this.buffer.length > 5000) this.buffer.shift();
  }

  applySnapshot(snap: { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }) {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of snap.bids) {
      const qty = Number(q);
      if (qty > 0) this.bids.set(Number(p), qty);
    }
    for (const [p, q] of snap.asks) {
      const qty = Number(q);
      if (qty > 0) this.asks.set(Number(p), qty);
    }
    this.snapshotId = snap.lastUpdateId;
    this.lastUpdateId = snap.lastUpdateId;
    this.primed = false;
    this.dirty = true;

    // Replay anything buffered while the snapshot was in flight.
    const pending = this.buffer.filter((d) => d.u >= this.snapshotId);
    this.buffer = [];
    for (const d of pending) this.apply(d);
    // If the buffer never straddled the snapshot we stay unsynced; the next
    // live diff that does will complete the handshake.
    if (pending.length === 0) this.synced = false;
  }

  /**
   * @returns false when the update chain broke and a resync is required.
   */
  apply(diff: DepthDiff): boolean {
    if (!this.snapshotId) {
      this.buffer_(diff);
      return true;
    }
    if (diff.u < this.snapshotId) return true; // already in the snapshot

    if (!this.primed) {
      if (!(diff.U <= this.snapshotId && diff.u >= this.snapshotId)) {
        // Not the straddling event yet. Hold it — a later one will straddle,
        // or the snapshot is stale and the caller will resync.
        if (diff.U > this.snapshotId) {
          this.synced = false;
          this.resyncs++;
          return false;
        }
        return true;
      }
      this.primed = true;
    } else if (diff.pu !== this.lastUpdateId) {
      this.synced = false;
      this.resyncs++;
      return false;
    }

    for (const [p, q] of diff.b) {
      const price = Number(p);
      const qty = Number(q);
      if (qty === 0) this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const [p, q] of diff.a) {
      const price = Number(p);
      const qty = Number(q);
      if (qty === 0) this.asks.delete(price);
      else this.asks.set(price, qty);
    }

    this.lastUpdateId = diff.u;
    this.synced = true;
    this.dirty = true;
    this.lastAppliedAt = Date.now();
    return true;
  }

  private rebuild() {
    if (!this.dirty) return;
    this.sortedBids = [...this.bids.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => b.price - a.price);
    this.sortedAsks = [...this.asks.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => a.price - b.price);
    this.dirty = false;

    // Prune far levels so a long session doesn't accumulate stale dust.
    const mid = this.mid();
    if (mid) {
      const lo = mid * (1 - CONFIG.bookRetentionPct / 100);
      const hi = mid * (1 + CONFIG.bookRetentionPct / 100);
      if (this.sortedBids.length > 4000) {
        for (const l of this.sortedBids) if (l.price < lo) this.bids.delete(l.price);
        this.sortedBids = this.sortedBids.filter((l) => l.price >= lo);
      }
      if (this.sortedAsks.length > 4000) {
        for (const l of this.sortedAsks) if (l.price > hi) this.asks.delete(l.price);
        this.sortedAsks = this.sortedAsks.filter((l) => l.price <= hi);
      }
    }
  }

  bidLevels(): BookLevel[] {
    this.rebuild();
    return this.sortedBids;
  }

  askLevels(): BookLevel[] {
    this.rebuild();
    return this.sortedAsks;
  }

  bestBid(): number | null {
    this.rebuild();
    return this.sortedBids[0]?.price ?? null;
  }

  bestAsk(): number | null {
    this.rebuild();
    return this.sortedAsks[0]?.price ?? null;
  }

  mid(): number | null {
    const b = this.sortedBids[0]?.price;
    const a = this.sortedAsks[0]?.price;
    if (b === undefined || a === undefined) return null;
    return (b + a) / 2;
  }

  size() {
    return { bids: this.bids.size, asks: this.asks.size };
  }
}
