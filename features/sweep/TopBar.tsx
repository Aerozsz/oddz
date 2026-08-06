"use client";

import { SYMBOL } from "@/lib/sweep/config";
import type { Snapshot } from "@/lib/sweep/types";
import { duration, pct, price as fmtPrice, qty, usd } from "./format";

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
  const session = snap.session;
  const sessionDot = ready ? (session.cashOpen ? "live" : "warn") : "warn";

  // Open interest is the one polled figure here. When a poll fails the previous
  // value stays on screen, which is the right call — but it must not keep
  // looking current, so anything older than three poll intervals is labelled.
  const oiAgeMs = snap.openInterest ? snap.ts - snap.openInterest.fetchedAt : 0;
  const oiStale = snap.openInterest !== null && oiAgeMs > 60_000;

  return (
    <div className="topbar">
      <div className="brand">
        <b>{SYMBOL}</b>
        <span>Binance USDⓈ-M equity perp · Intel Corp</span>
      </div>

      <div className="price">
        <span className="big num">{fmtPrice(snap.last ?? snap.mid, precision)}</span>
        <span className="sub num">
          {snap.bestBid !== null && snap.bestAsk !== null
            ? `${fmtPrice(snap.bestBid, precision)} / ${fmtPrice(snap.bestAsk, precision)}`
            : "—"}
        </span>
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
