"use client";

import { useEffect, useRef, useState } from "react";
import { SYMBOL } from "@/lib/sweep/config";
import type { Snapshot } from "@/lib/sweep/types";
import { duration, levelHeat, pct, price as fmtPrice, qty, usd } from "./format";

/**
 * The nearer of the two first trigger levels, up or down.
 *
 * Lives in the top strip because it is the figure that has to be readable
 * without hunting for it: the panel below says what a sweep would cost, but
 * none of that is in play until price actually arrives, and which side is
 * closer changes on its own as the book moves.
 */
function nearestLevel(snap: Snapshot): { price: number; distPct: number; below: boolean } | null {
  const mid = snap.mid ?? 0;
  if (!mid) return null;

  const candidates = [snap.cascadeDown?.links[0]?.cluster.price, snap.cascadeUp?.links[0]?.cluster.price]
    .filter((p): p is number => typeof p === "number" && p > 0);
  if (!candidates.length) return null;

  const nearest = candidates.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
  return {
    price: nearest,
    distPct: Math.abs((nearest - mid) / mid) * 100,
    below: nearest < mid,
  };
}

/**
 * Price change over a fixed window, rather than against the previous frame.
 *
 * The engine publishes ten times a second, so a frame-to-frame delta is mostly
 * the last tick and reads as flicker. Sampling against a price a few seconds
 * old gives a number that actually corresponds to a move, and holding the
 * reference for the whole window means the figure is stable enough to read
 * before it changes.
 */
function usePriceChange(price: number | null, windowMs = 5_000) {
  const ref = useRef<{ price: number; at: number }>({ price: 0, at: 0 });
  const [change, setChange] = useState<{ abs: number; pct: number } | null>(null);

  useEffect(() => {
    if (price === null || price <= 0) return;
    const prev = ref.current;
    if (prev.price === 0) {
      ref.current = { price, at: Date.now() };
      return;
    }
    if (Date.now() - prev.at < windowMs) return;
    setChange({ abs: price - prev.price, pct: ((price - prev.price) / prev.price) * 100 });
    ref.current = { price, at: Date.now() };
  }, [price, windowMs]);

  return change;
}

export default function TopBar({ snap }: { snap: Snapshot }) {
  const precision = snap.meta?.pricePrecision ?? 2;
  const mark = snap.mark;
  const basis =
    mark && mark.indexPrice > 0 ? ((mark.markPrice - mark.indexPrice) / mark.indexPrice) * 100 : null;

  const conn = snap.connection;
  // An open socket that has gone quiet still reads as connected for up to a
  // minute, until the stale check cycles it. On a symbol with a live book that
  // silence means the numbers below have stopped moving, so it cannot keep
  // saying "live" in the meantime.
  const silentMs = conn.lastMessageAt > 0 ? snap.ts - conn.lastMessageAt : 0;
  const stalled = conn.socket === "open" && silentMs > 5_000;
  const live = conn.socket === "open" && conn.bookSynced && !stalled;

  const dotClass = live ? "live" : stalled ? "bad" : conn.socket === "open" ? "warn" : "bad";
  const connLabel = live
    ? `live · ${conn.messagesPerSec.toFixed(0)} msg/s`
    : stalled
      ? `no data for ${duration(silentMs)}`
      : conn.socket === "open"
        ? "syncing book"
        : conn.socket === "connecting"
          ? "connecting"
          : "disconnected";

  // Nothing has been published yet, so the session phase in the prerendered
  // markup is a placeholder rather than a reading. Say so instead of counting
  // down to a boundary we have not worked out.
  const ready = snap.ts > 0;
  const shown = snap.last ?? snap.mid;
  const change = usePriceChange(shown);
  const dir = !change || Math.abs(change.pct) < 0.005 ? 0 : change.pct > 0 ? 1 : -1;
  const dirColor = dir > 0 ? "var(--good)" : dir < 0 ? "var(--critical)" : "var(--ink-muted)";

  const session = snap.session;
  const sessionDot = ready ? (session.cashOpen ? "live" : "warn") : "warn";

  // Open interest is the one polled figure here. When a poll fails the previous
  // value stays on screen, which is the right call — but it must not keep
  // looking current, so anything older than three poll intervals is labelled.
  const oiAgeMs = snap.openInterest ? snap.ts - snap.openInterest.fetchedAt : 0;
  const oiStale = snap.openInterest !== null && oiAgeMs > 60_000;

  const nearest = nearestLevel(snap);
  const nearestColor = nearest ? levelHeat(nearest.distPct) : "var(--ink)";

  return (
    <div className="topbar">
      <div className="brand">
        <b>{SYMBOL}</b>
        <span>Binance USDⓈ-M equity perp · Intel Corp</span>
      </div>

      <div className="price">
        <span className="big num" style={{ color: dirColor }}>
          {fmtPrice(shown, precision)}
        </span>
        <span className="pricechange num" style={{ color: dirColor }}>
          {change === null
            ? ""
            : `${dir > 0 ? "▲" : dir < 0 ? "▼" : "—"} ${change.abs >= 0 ? "+" : ""}${change.abs.toFixed(precision)} (${pct(change.pct, 2)})`}
          <span className="sub"> 5s</span>
        </span>
        <span className="sub num">
          {snap.bestBid !== null && snap.bestAsk !== null
            ? `${fmtPrice(snap.bestBid, precision)} / ${fmtPrice(snap.bestAsk, precision)}`
            : "—"}
        </span>
      </div>

      <div className="nearest">
        <span className="k">Nearest trigger level</span>
        {nearest ? (
          <span className="nearest-row">
            <b className="num" style={{ color: nearestColor }}>
              {fmtPrice(nearest.price, precision)}
            </b>
            <span className="nearest-pct num" style={{ color: nearestColor }}>
              {nearest.distPct.toFixed(2)}%
            </span>
            <span className="sub">{nearest.below ? "below" : "above"}</span>
          </span>
        ) : (
          <span className="nearest-row">
            <b className="num">—</b>
          </span>
        )}
      </div>

      <div className="field">
        <span className="k">Mark</span>
        <span className="v">{fmtPrice(mark?.markPrice, precision)}</span>
      </div>
      <div className="field">
        <span className="k">Index</span>
        <span className="v">{fmtPrice(mark?.indexPrice, precision)}</span>
      </div>
      <div className="field">
        <span className="k">Basis</span>
        <span className="v">{basis === null ? "—" : pct(basis, 3)}</span>
      </div>
      <div className="field">
        <span className="k">Funding</span>
        <span className="v">
          {mark ? `${(mark.fundingRate * 100).toFixed(4)}%` : "—"}{" "}
          <span className="sub">
            {mark ? duration(mark.nextFundingTime - snap.ts) : ""}
          </span>
        </span>
      </div>
      <div className="field">
        <span className="k">Open interest</span>
        <span className="v" title={oiStale ? `Last successful poll ${duration(oiAgeMs)} ago` : undefined}>
          {usd(snap.openInterest?.notional)}{" "}
          <span className="sub">
            {oiStale ? `stale · ${duration(oiAgeMs)} old` : qty(snap.openInterest?.qty)}
          </span>
        </span>
      </div>
      <div className="field">
        <span className="k">Long/short</span>
        <span className="v">{snap.longShortRatio?.toFixed(2) ?? "—"}</span>
      </div>

      <div className="spacer" />

      <span
        className="pill"
        title={ready ? `${session.nextLabel} in ${duration(session.msToNext)}` : undefined}
      >
        <i className={`dot ${sessionDot}`} />
        {ready
          ? `Nasdaq ${session.phase} · ${session.nextLabel} in ${duration(session.msToNext)}`
          : "Nasdaq session —"}
      </span>

      <span className="pill" title={conn.error ?? undefined}>
        <i className={`dot ${dotClass}`} />
        {connLabel}
        {conn.resyncs > 0 && ` · ${conn.resyncs} resync${conn.resyncs === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
