import type { Snapshot, Wall } from "../types";
import type { FeedHealth, Signal, SignalKind, SignalSeverity } from "./types";

/** Tunables for what counts as worth emitting. */
export interface SignalOptions {
  /** Cascade risk bands. Crossing one upward or downward emits a signal. */
  riskBands: number[];
  /** Emit `cluster-approach` inside this distance from mid, in percent. */
  clusterApproachPct: number;
  /** ...for amplifying clusters at or above this modelled notional, in USD. */
  clusterMinNotional: number;
  /** `liquidation-burst` when this much liquidation notional prints in the window. */
  liquidationBurstNotional: number;
  liquidationWindowMs: number;
  /** Minimum gap between two signals sharing the same dedupe key. */
  cooldownMs: number;
  /** `flow-toxic` once mark-out reaches this fraction of the half-spread. */
  toxicityThreshold: number;
  /** `funding-window` this long before a settlement, when the rate is material. */
  fundingWarnMs: number;
  /** ...and only when the rate is at least this big, as a fraction. */
  fundingMinRate: number;
}

export const DEFAULT_SIGNAL_OPTIONS: SignalOptions = {
  riskBands: [30, 50, 70],
  clusterApproachPct: 0.35,
  clusterMinNotional: 250_000,
  liquidationBurstNotional: 150_000,
  liquidationWindowMs: 10_000,
  cooldownMs: 15_000,
  toxicityThreshold: 0.85,
  fundingWarnMs: 15 * 60_000,
  // 0.01% per settlement. Below this the payment is smaller than a tick on a
  // sensible position and there is nothing to warn about.
  fundingMinRate: 0.0001,
};

/**
 * Turns the published snapshot stream into discrete events.
 *
 * Snapshots arrive ten times a second and mostly say the same thing, so the
 * work here is deciding what is *new*. Two mechanisms do that: level crossings
 * are edge-triggered against the previous snapshot, so a risk score sitting at
 * 72 emits once rather than ten times a second; and everything else is keyed
 * and held down by a cooldown, so an approach to one cluster does not re-fire
 * while price loiters next to it.
 *
 * Health is the exception. It is edge-triggered but never suppressed, because a
 * consumer that misses the transition into `blind` keeps trading on a dead
 * feed — the failure this whole layer exists to prevent.
 */
export class SignalEngine {
  private readonly opts: SignalOptions;
  private lastEmitted = new Map<string, number>();

  private prevRisk: { up: number; down: number } | null = null;
  private prevHealthLevel: string | null = null;
  private prevWalls: Wall[] = [];
  private seenThinningAt = 0;
  private prevToxic = false;
  private prevBlackout: boolean | null = null;
  private seq = 0;

  constructor(options: Partial<SignalOptions> = {}) {
    this.opts = { ...DEFAULT_SIGNAL_OPTIONS, ...options };
  }

  /** Detect everything newly true in this snapshot. */
  detect(snap: Snapshot, health: FeedHealth, now = Date.now()): Signal[] {
    const out: Signal[] = [];

    // Always first, and never rate-limited: a consumer that misses this keeps
    // acting on a feed that has stopped being true.
    if (health.level !== this.prevHealthLevel) {
      const from = this.prevHealthLevel;
      this.prevHealthLevel = health.level;
      if (from !== null) {
        const severity: SignalSeverity =
          health.level === "ok" ? "info" : health.level === "blind" ? "critical" : "warning";
        const sig = this.make("health", now, severity, {
          direction: null,
          price: null,
          detail: `feed ${from} → ${health.level}: ${health.summary}`,
          data: { from, to: health.level, tradeable: health.tradeable },
          key: "health",
          force: true,
        });
        if (sig) out.push(sig);
      }
    }

    // A blind feed produces numbers that still look like numbers. Deriving
    // market signals from them is exactly the mistake the health gate exists to
    // stop, so nothing below runs.
    if (health.level === "blind") {
      this.prevRisk = null;
      return out;
    }

    out.push(...this.thinning(snap, now));
    out.push(...this.wallsPulled(snap, now));
    out.push(...this.cascadeRisk(snap, now));
    out.push(...this.clusterApproach(snap, now));
    out.push(...this.liquidationBurst(snap, now));
    out.push(...this.flowToxic(snap, now));
    out.push(...this.fundingWindow(snap, now));
    out.push(...this.eventWindow(snap, now));

    return out;
  }

  /* ------------------------------------------------------------- detectors */

  /** Depth that left the band without prints against it. */
  private thinning(snap: Snapshot, now: number): Signal[] {
    const events = snap.thinning.filter((e) => e.t > this.seenThinningAt);
    if (events.length === 0) return [];
    this.seenThinningAt = Math.max(...events.map((e) => e.t));

    return events.flatMap((e) => {
      // Withdrawal on the bid thins the floor, so the exposure is downward.
      const direction = e.side === "bid" ? "down" : "up";
      const severity: SignalSeverity = e.remainingFrac < 0.5 ? "critical" : "warning";
      const sig = this.make("withdrawal", e.t, severity, {
        direction,
        price: snap.mid,
        detail:
          `${fmtUsd(e.withdrawn)} withdrawn from the ${e.side} side vs ` +
          `${fmtUsd(e.consumed)} consumed — ${(e.remainingFrac * 100).toFixed(0)}% of baseline depth remains`,
        data: {
          side: e.side,
          withdrawn: e.withdrawn,
          consumed: e.consumed,
          remainingFrac: e.remainingFrac,
        },
        key: `withdrawal:${e.side}`,
      });
      return sig ? [sig] : [];
    });
  }

  /**
   * A wall that disappeared without being traded through. Distinct from
   * thinning: this is one identifiable resting order pulled, which is the
   * clearest single-actor version of the same precondition.
   */
  private wallsPulled(snap: Snapshot, now: number): Signal[] {
    const current = snap.liquidity?.walls ?? [];
    const prev = this.prevWalls;
    this.prevWalls = current;
    if (prev.length === 0 || snap.mid === null) return [];

    const out: Signal[] = [];
    for (const wall of prev) {
      if (wall.notional < this.opts.clusterMinNotional) continue;
      const still = current.some((w) => Math.abs(w.price - wall.price) < 1e-9);
      if (still) continue;
      // If price traded through it, it was eaten rather than pulled — that is
      // ordinary and not what this is looking for.
      const tradedThrough = wall.side === "bid" ? snap.mid <= wall.price : snap.mid >= wall.price;
      if (tradedThrough) continue;

      const sig = this.make("wall-pulled", now, "warning", {
        direction: wall.side === "bid" ? "down" : "up",
        price: wall.price,
        detail: `${fmtUsd(wall.notional)} ${wall.side} wall at ${wall.price} pulled without trading through`,
        data: { side: wall.side, price: wall.price, notional: wall.notional },
        key: `wall:${wall.side}:${wall.price}`,
      });
      if (sig) out.push(sig);
    }
    return out;
  }

  /** Edge-triggered crossings of the configured risk bands. */
  private cascadeRisk(snap: Snapshot, now: number): Signal[] {
    const up = snap.cascadeUp?.risk ?? 0;
    const down = snap.cascadeDown?.risk ?? 0;
    const prev = this.prevRisk;
    this.prevRisk = { up, down };
    if (!prev) return [];

    const out: Signal[] = [];
    for (const [direction, before, after, path] of [
      ["up", prev.up, up, snap.cascadeUp],
      ["down", prev.down, down, snap.cascadeDown],
    ] as const) {
      for (const band of this.opts.riskBands) {
        const rising = before < band && after >= band;
        const falling = before >= band && after < band;
        if (!rising && !falling) continue;
        const sig = this.make("cascade-risk", now, rising ? (band >= 70 ? "critical" : "warning") : "info", {
          direction,
          price: path?.links[0]?.cluster.price ?? snap.mid,
          detail: rising
            ? `${direction}side cascade risk crossed ${band} (now ${after.toFixed(0)}), seed ${fmtUsd(path?.seedNotional ?? 0)}`
            : `${direction}side cascade risk fell back below ${band} (now ${after.toFixed(0)})`,
          data: {
            direction,
            band,
            risk: after,
            rising,
            seedNotional: path?.seedNotional ?? 0,
            terminalPct: path?.terminalPct ?? 0,
            links: path?.links.length ?? 0,
          },
          // Keyed per band and per crossing sense so that a score oscillating
          // around a threshold cannot alternate its way past the cooldown.
          key: `risk:${direction}:${band}:${rising ? "up" : "down"}`,
        });
        if (sig) out.push(sig);
      }
    }
    return out;
  }

  /** Price approaching a significant amplifying cluster. */
  private clusterApproach(snap: Snapshot, now: number): Signal[] {
    const mid = snap.mid;
    if (mid === null) return [];

    const out: Signal[] = [];
    for (const c of snap.clusters) {
      if (c.effect !== "amplifying") continue;
      // Already net: buildClusters subtracts the spent portion from `notional`
      // and leaves `spent` at its gross value, so taking the difference here
      // deducts it twice. An observed-only cluster came out negative and was
      // filtered out permanently — silently suppressing exactly the levels
      // where liquidations have printed, which carry the highest confidence.
      const remaining = c.notional;
      if (remaining < this.opts.clusterMinNotional) continue;
      const distPct = Math.abs((c.price - mid) / mid) * 100;
      if (distPct > this.opts.clusterApproachPct) continue;

      const sig = this.make("cluster-approach", now, remaining >= this.opts.clusterMinNotional * 4 ? "warning" : "info", {
        direction: c.pushes,
        price: c.price,
        detail:
          `price ${distPct.toFixed(2)}% from a ${fmtUsd(remaining)} amplifying cluster at ${c.price} ` +
          `(${c.sources.join(", ")}, confidence ${(c.confidence * 100).toFixed(0)}%)`,
        data: {
          price: c.price,
          distPct,
          notional: remaining,
          confidence: c.confidence,
          pushes: c.pushes,
          sources: c.sources.join(","),
        },
        key: `cluster:${c.price}`,
      });
      if (sig) out.push(sig);
    }
    return out;
  }

  /** Liquidations clustering in time — triggers already firing. */
  private liquidationBurst(snap: Snapshot, now: number): Signal[] {
    const cutoff = now - this.opts.liquidationWindowMs;
    const recent = snap.liquidations.filter((l) => l.t >= cutoff);
    if (recent.length === 0) return [];

    const total = recent.reduce((sum, l) => sum + l.notional, 0);
    if (total < this.opts.liquidationBurstNotional) return [];

    const longs = recent.filter((l) => l.positionSide === "long").reduce((s, l) => s + l.notional, 0);
    const shorts = total - longs;
    // Liquidated longs are closed with sells, so they push price down.
    const direction = longs >= shorts ? "down" : "up";

    const sig = this.make("liquidation-burst", now, total >= this.opts.liquidationBurstNotional * 3 ? "critical" : "warning", {
      direction,
      price: recent[0]?.price ?? snap.mid,
      detail:
        `${fmtUsd(total)} liquidated in ${Math.round(this.opts.liquidationWindowMs / 1000)}s ` +
        `(${fmtUsd(longs)} longs, ${fmtUsd(shorts)} shorts)`,
      data: { total, longs, shorts, count: recent.length, direction },
      key: `liq:${direction}`,
    });
    return sig ? [sig] : [];
  }

  /**
   * Mark-out has run past the half-spread.
   *
   * Emitted as a *warning about depth*, not as a directional call. A market
   * maker who is losing more to adverse selection than they earn from the
   * spread stops quoting, and the withdrawal detector only sees that once the
   * depth has already gone. This sees the cause, which is a few seconds earlier
   * and is the whole reason the mark-out module exists.
   *
   * Edge-triggered on entering the toxic band, so a persistently ugly tape does
   * not fire continuously.
   */
  private flowToxic(snap: Snapshot, now: number): Signal[] {
    const mk = snap.markout;
    if (!mk.warm) {
      this.prevToxic = false;
      return [];
    }
    const toxic = mk.toxicity >= this.opts.toxicityThreshold;
    const entering = toxic && !this.prevToxic;
    this.prevToxic = toxic;
    if (!entering) return [];

    const sig = this.make("flow-toxic", now, "warning", {
      // Where it points is where the informed side has been pushing, when it
      // has been one-sided. Toxic-but-balanced points nowhere.
      direction: Math.abs(mk.informed) > 0.3 ? (mk.informed > 0 ? "up" : "down") : null,
      price: snap.mid,
      detail: mk.notes[0] ?? `mark-out ${mk.toxicity.toFixed(2)} of the half-spread — expect depth to be pulled`,
      data: {
        toxicity: mk.toxicity,
        informed: mk.informed,
        referenceBps: mk.referenceBps,
        costToMakerBps: mk.horizons[1]?.costToMakerBps ?? null,
      },
      key: "toxic",
    });
    return sig ? [sig] : [];
  }

  /**
   * A settlement is close and the rate is big enough to matter.
   *
   * The point is the step: funding is charged in full at the instant, so a
   * position that would have paid nothing pays the whole rate by being held a
   * minute longer. Anything holding a position needs the chance to decide
   * before that, not a note afterwards.
   */
  private fundingWindow(snap: Snapshot, now: number): Signal[] {
    const f = snap.funding;
    if (!f.nextFundingTime || Math.abs(f.rate) < this.opts.fundingMinRate) return [];
    if (f.msToFunding > this.opts.fundingWarnMs) return [];

    const sig = this.make("funding-window", now, "info", {
      // Longs paying is a cost to a long and a credit to a short, which is a
      // reason to prefer one side over the other for a hold across it.
      direction: f.paying === "longs" ? "down" : f.paying === "shorts" ? "up" : null,
      price: snap.mid,
      detail:
        `funding settles in ${Math.max(1, Math.round(f.msToFunding / 60_000))} min — ` +
        `${f.paying} pay ${(Math.abs(f.rate) * 100).toFixed(4)}% of notional`,
      data: {
        rate: f.rate,
        paying: f.paying,
        msToFunding: f.msToFunding,
        intervalHours: f.intervalHours,
        stretched: f.stretched,
      },
      key: `funding:${f.nextFundingTime}`,
    });
    return sig ? [sig] : [];
  }

  /** Entering or leaving a scheduled-event blackout. Never suppressed. */
  private eventWindow(snap: Snapshot, now: number): Signal[] {
    const inBlackout = snap.events.blackout;
    if (inBlackout === this.prevBlackout) return [];
    const from = this.prevBlackout;
    this.prevBlackout = inBlackout;
    if (from === null) return [];

    const sig = this.make("event-window", now, inBlackout ? "critical" : "info", {
      direction: null,
      price: snap.mid,
      detail: inBlackout
        ? (snap.events.reason ?? "entered a scheduled-event blackout — nothing here survives a gap")
        : "scheduled-event blackout is over",
      data: {
        blackout: inBlackout,
        label: snap.events.next?.label ?? null,
        msToNext: snap.events.msToNext,
      },
      key: "event",
      force: true,
    });
    return sig ? [sig] : [];
  }

  /* ---------------------------------------------------------------- helper */

  private make(
    kind: SignalKind,
    t: number,
    severity: SignalSeverity,
    o: {
      direction: Signal["direction"];
      price: number | null;
      detail: string;
      data: Signal["data"];
      key: string;
      force?: boolean;
    },
  ): Signal | null {
    const last = this.lastEmitted.get(o.key) ?? 0;
    if (!o.force && t - last < this.opts.cooldownMs) return null;
    this.lastEmitted.set(o.key, t);
    return {
      id: `${kind}:${t}:${(this.seq++).toString(36)}`,
      kind,
      t,
      severity,
      direction: o.direction,
      price: o.price,
      detail: o.detail,
      data: o.data,
    };
  }
}

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}
