import { rateLimitCooldownMs } from "../binance/rest";
import type { Snapshot } from "../types";
import type { FeedHealth, HealthReason } from "./types";

/**
 * Thresholds for calling the feed unfit.
 *
 * The stall threshold is the one that matters. INTCUSDT publishes depth diffs
 * every 100ms whenever the book moves, so multi-second silence on a live symbol
 * means the socket is a zombie — but the client only cycles it at 60s, and the
 * whole minute in between would otherwise read as connected.
 */
const STALL_MS = 5_000;
/** The publish loop runs at 10Hz; a snapshot this old means it has stopped. */
const SNAPSHOT_STALE_MS = 3_000;
/** Open interest polls every 20s and only scales cluster sizing. */
const OPEN_INTEREST_STALE_MS = 90_000;

/**
 * Decide whether the feed can be acted on.
 *
 * Written as a veto list rather than a score on purpose. A partially broken
 * market feed does not degrade gracefully — it keeps returning numbers that
 * look ordinary, because a stale book still has a mid and a stale cluster map
 * still scores a cascade. Anything that makes those numbers untrue has to stop
 * execution outright, not lower a confidence value that a strategy might decide
 * to trade through anyway.
 */
export function assessHealth(snap: Snapshot, now = Date.now()): FeedHealth {
  const reasons: HealthReason[] = [];
  const conn = snap.connection;
  const snapshotAgeMs = snap.ts > 0 ? now - snap.ts : Number.POSITIVE_INFINITY;

  if (snap.ts === 0) {
    return {
      level: "blind",
      tradeable: false,
      reasons: [
        { code: "snapshot-stale", severity: "blind", detail: "the engine has not published yet" },
      ],
      summary: "starting up",
      snapshotAgeMs: 0,
    };
  }

  if (conn.socket !== "open") {
    reasons.push({
      code: "socket-down",
      severity: "blind",
      detail: `stream ${conn.socket}${conn.error ? `: ${conn.error}` : ""}`,
    });
  }

  if (!conn.bookSynced) {
    reasons.push({
      code: "book-desynced",
      severity: "blind",
      detail: "local book is not in sync with the diff stream",
    });
  }

  const silentMs = conn.lastMessageAt > 0 ? now - conn.lastMessageAt : Number.POSITIVE_INFINITY;
  if (conn.socket === "open" && silentMs > STALL_MS) {
    reasons.push({
      code: "feed-stalled",
      severity: "blind",
      detail: `no stream message for ${Math.round(silentMs / 1000)}s`,
    });
  }

  if (snap.mid === null || !Number.isFinite(snap.mid) || snap.mid <= 0) {
    reasons.push({ code: "no-price", severity: "blind", detail: "no two-sided book" });
  }

  if (snapshotAgeMs > SNAPSHOT_STALE_MS) {
    reasons.push({
      code: "snapshot-stale",
      severity: "blind",
      detail: `state is ${Math.round(snapshotAgeMs / 1000)}s old`,
    });
  }

  // Being throttled does not by itself corrupt the book — the stream is a
  // separate connection and keeps running. It does mean the snapshot cannot be
  // resynced if the chain breaks, so it is a warning rather than a veto.
  const cooldown = rateLimitCooldownMs();
  if (cooldown > 0) {
    reasons.push({
      code: "rate-limited",
      severity: "degraded",
      detail: `REST throttled for another ${Math.ceil(cooldown / 1000)}s`,
    });
  }

  if (snap.liquidity && !snap.liquidity.warm) {
    reasons.push({
      code: "baseline-cold",
      severity: "degraded",
      detail: "withdrawal baseline not established; the depth index is pinned to 1",
    });
  }

  if (snap.openInterest && now - snap.openInterest.fetchedAt > OPEN_INTEREST_STALE_MS) {
    reasons.push({
      code: "open-interest-stale",
      severity: "degraded",
      detail: `open interest ${Math.round((now - snap.openInterest.fetchedAt) / 1000)}s old; cluster sizing drifts`,
    });
  } else if (!snap.openInterest) {
    reasons.push({
      code: "open-interest-stale",
      severity: "degraded",
      detail: "open interest unavailable; the leverage ladder is unscaled",
    });
  }

  if (!snap.meta) {
    reasons.push({
      code: "metadata-missing",
      severity: "degraded",
      detail: "contract metadata unavailable; tick and step size assumed",
    });
  }

  reasons.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blind" ? -1 : 1));

  const blind = reasons.some((r) => r.severity === "blind");
  const level = blind ? "blind" : reasons.length > 0 ? "degraded" : "ok";

  return {
    level,
    tradeable: level === "ok",
    reasons,
    summary: blind
      ? `not tradeable — ${reasons[0].detail}`
      : reasons.length > 0
        ? `degraded — ${reasons.map((r) => r.detail).join("; ")}`
        : "live",
    snapshotAgeMs,
  };
}
