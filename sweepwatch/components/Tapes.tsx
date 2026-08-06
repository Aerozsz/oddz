"use client";

import { useState } from "react";
import type { Snapshot } from "../lib/types";
import { clock, price as fmtPrice, qty, usd } from "./format";

type Tab = "liq" | "prints" | "thin";

/**
 * The measured feeds. Everything on this panel actually happened — no model
 * touches it. The liquidation tape in particular is the only direct sight of
 * forced flow anyone gets: an order that had to execute, at whatever price was
 * there.
 */
export default function Tapes({ snap }: { snap: Snapshot }) {
  const [tab, setTab] = useState<Tab>("liq");
  const precision = snap.meta?.pricePrecision ?? 2;

  return (
    <section className="panel">
      <header>
        <h2>Live tape</h2>
        <div className="controls">
          <button aria-pressed={tab === "liq"} onClick={() => setTab("liq")}>
            liquidations
          </button>
          <button aria-pressed={tab === "prints"} onClick={() => setTab("prints")}>
            large prints
          </button>
          <button aria-pressed={tab === "thin"} onClick={() => setTab("thin")}>
            withdrawals
          </button>
        </div>
      </header>

      {tab === "liq" && (
        <div className="tape">
          {snap.liquidations.length === 0 ? (
            <p className="empty">
              No forced orders since this page opened. The feed is live — Binance only
              publishes a liquidation when one happens.
            </p>
          ) : (
            snap.liquidations.map((l, i) => (
              <div
                className="row"
                key={`${l.t}-${i}`}
                style={{ gridTemplateColumns: "58px 1fr auto auto" }}
              >
                <span className="t">{clock(l.t)}</span>
                <span className={`tag ${l.positionSide === "long" ? "down" : "up"}`}>
                  {l.positionSide} liquidated
                </span>
                <span>{fmtPrice(l.price, precision)}</span>
                <span style={{ color: "var(--ink-2)" }}>{usd(l.notional)}</span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "prints" && (
        <div className="tape">
          {snap.largeTrades.length === 0 ? (
            <p className="empty">No prints above the size filter yet.</p>
          ) : (
            snap.largeTrades.map((t, i) => (
              <div
                className="row"
                key={`${t.t}-${i}`}
                style={{ gridTemplateColumns: "58px 44px 1fr auto" }}
              >
                <span className="t">{clock(t.t)}</span>
                <span className={`tag ${t.buyerIsMaker ? "down" : "up"}`}>
                  {t.buyerIsMaker ? "sell" : "buy"}
                </span>
                <span>{fmtPrice(t.price, precision)}</span>
                <span style={{ color: "var(--ink-2)" }}>
                  {usd(t.notional)} <span className="sub">/ {qty(t.qty)}</span>
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "thin" && (
        <div className="tape">
          {snap.thinning.length === 0 ? (
            <p className="empty">
              No withdrawal events. Depth has not dropped sharply without trading
              against it since this page opened.
            </p>
          ) : (
            snap.thinning.map((e, i) => (
              <div
                className="row"
                key={`${e.t}-${i}`}
                style={{ gridTemplateColumns: "58px 1fr auto" }}
              >
                <span className="t">{clock(e.t)}</span>
                <span>
                  <span className="tag down">{e.side === "bid" ? "bids" : "asks"} pulled</span>{" "}
                  <span className="sub">
                    {usd(e.withdrawn)} cancelled vs {usd(e.consumed)} traded
                  </span>
                </span>
                <span style={{ color: "var(--serious)" }}>
                  {(e.remainingFrac * 100).toFixed(0)}% left
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
