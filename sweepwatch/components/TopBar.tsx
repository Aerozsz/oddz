"use client";

import { SYMBOL } from "../lib/config";
import type { Snapshot } from "../lib/types";
import { duration, pct, price as fmtPrice, qty, usd } from "./format";

export default function TopBar({ snap }: { snap: Snapshot }) {
  const precision = snap.meta?.pricePrecision ?? 2;
  const mark = snap.mark;
  const basis =
    mark && mark.indexPrice > 0 ? ((mark.markPrice - mark.indexPrice) / mark.indexPrice) * 100 : null;

  const conn = snap.connection;
  const live = conn.socket === "open" && conn.bookSynced;
  const dotClass = live ? "live" : conn.socket === "open" ? "warn" : "bad";
  const connLabel = live
    ? `live · ${conn.messagesPerSec.toFixed(0)} msg/s`
    : conn.socket === "open"
      ? "syncing book"
      : conn.socket === "connecting"
        ? "connecting"
        : "disconnected";

  const session = snap.session;
  const sessionDot = session.cashOpen ? "live" : "warn";

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
        <span className="v">
          {usd(snap.openInterest?.notional)}{" "}
          <span className="sub">{qty(snap.openInterest?.qty)}</span>
        </span>
      </div>
      <div className="field">
        <span className="k">Long/short</span>
        <span className="v">{snap.longShortRatio?.toFixed(2) ?? "—"}</span>
      </div>

      <div className="spacer" />

      <span className="pill" title={`${session.nextLabel} in ${duration(session.msToNext)}`}>
        <i className={`dot ${sessionDot}`} />
        Nasdaq {session.phase} · {session.nextLabel} in {duration(session.msToNext)}
      </span>

      <span className="pill" title={conn.error ?? undefined}>
        <i className={`dot ${dotClass}`} />
        {connLabel}
        {conn.resyncs > 0 && ` · ${conn.resyncs} resync${conn.resyncs === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
