"use client";

import { CONFIG } from "@/lib/sweep/config";
import type { Snapshot } from "@/lib/sweep/types";
import DepthHistory from "./DepthHistory";
import { pct, price as fmtPrice, ratio, usd } from "./format";

/**
 * The reserves side of the picture. Two numbers carry it:
 *
 *   the withdrawal index — depth now against this book's own slow baseline
 *   the split            — of the depth that left, how much traded and how
 *                          much was simply cancelled
 *
 * The split is why the feed has to be continuous. Sampled snapshots can tell
 * you depth fell; only an unbroken trade tape alongside an unbroken book can
 * tell you whether anything was actually bought or sold in the process.
 */
export default function LiquidityPanel({ snap }: { snap: Snapshot }) {
  const liq = snap.liquidity;

  if (!liq) {
    return (
      <section className="panel">
        <header>
          <h2>Liquidity</h2>
        </header>
        <p className="empty">Syncing the order book…</p>
      </section>
    );
  }

  // The curve was computed against this same mid in the engine's publish pass,
  // so deriving the target prices here cannot drift from the costs beside them.
  const mid = snap.mid ?? 0;
  const precision = snap.meta?.pricePrecision ?? 2;

  const { decomp } = liq;
  const withdrawn = decomp.withdrawnBid + decomp.withdrawnAsk;
  const consumed = decomp.consumedBid + decomp.consumedAsk;
  const added = decomp.addedBid + decomp.addedAsk;
  const removed = withdrawn + consumed;
  const wShare = removed > 0 ? withdrawn / removed : 0;

  const lwiPct = Math.min(100, liq.lwi * 50);
  const thinning = liq.lwi < 0.7;

  return (
    <section className="panel">
      <header>
        <h2>How much is on the order book</h2>
        <p className="note">within {(CONFIG.primaryBandBps / 100).toFixed(2)}% of the price</p>
      </header>

      <div className="tiles">
        <div className="tile">
          <span className="k">vs. normal</span>
          <span className="v" style={{ color: thinning ? "var(--serious)" : undefined }}>
            {ratio(liq.lwi)}
          </span>
          <span className="d">
            {liq.lwi < 1
              ? `${((1 - liq.lwi) * 100).toFixed(0)}% thinner than usual`
              : `${((liq.lwi - 1) * 100).toFixed(0)}% thicker than usual`}
          </span>
          <div className="meter" style={{ marginTop: 4 }}>
            <i
              style={{
                width: `${lwiPct}%`,
                background: thinning ? "var(--serious)" : "var(--liq)",
              }}
            />
          </div>
        </div>

        <div className="tile">
          <span className="k">Orders nearby</span>
          <span className="v">{usd(liq.primary.bidNotional + liq.primary.askNotional)}</span>
          <span className="d">
            bid {usd(liq.primary.bidNotional)} · ask {usd(liq.primary.askNotional)}
          </span>
        </div>

        <div className="tile">
          <span className="k">Lopsided?</span>
          <span className="v">{pct(liq.imbalance * 100, 0)}</span>
          <span className="d">{liq.imbalance >= 0 ? "more buyers waiting" : "more sellers waiting"}</span>
        </div>

        <div className="tile">
          <span className="k">Spread</span>
          <span className="v">{liq.spreadBps.toFixed(1)}</span>
          <span className="d">gap between buy and sell, in hundredths of a %</span>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
            Did those orders get bought, or just cancelled?
          </h3>
          <span className="sub">last {decomp.windowSec}s</span>
        </div>

        {removed <= 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Orders are steady or being added — {usd(added)} posted, nothing pulled on balance.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                height: 10,
                borderRadius: 3,
                overflow: "hidden",
                gap: 2,
              }}
            >
              <div
                style={{
                  width: `${wShare * 100}%`,
                  background: "var(--forced)",
                  borderRadius: 2,
                }}
              />
              <div
                style={{
                  width: `${(1 - wShare) * 100}%`,
                  background: "var(--liq)",
                  borderRadius: 2,
                }}
              />
            </div>
            <div className="legend" style={{ marginTop: 7 }}>
              <span>
                <i className="swatch" style={{ background: "var(--forced)" }} /> cancelled{" "}
                {usd(withdrawn)}
              </span>
              <span>
                <i className="swatch" style={{ background: "var(--liq)" }} /> actually bought/sold{" "}
                {usd(consumed)}
              </span>
            </div>
            <p className="sub" style={{ margin: "7px 0 0" }}>
              {wShare > 0.6
                ? "Mostly cancelled. People are pulling their orders without trading, so the same size order now moves price further than it did a minute ago."
                : wShare < 0.25
                  ? "Mostly traded. Orders are being filled rather than yanked, which is normal and tends to settle down on its own."
                  : "A mix of both — some traded, some pulled."}
            </p>
          </>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
          How order-book depth has changed
        </h3>
        <DepthHistory snap={snap} />
      </div>

      <div style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
          What it would cost to move the price
        </h3>
        <table>
          <thead>
            <tr>
              <th>Move</th>
              <th>Down</th>
              <th>Up</th>
            </tr>
          </thead>
          <tbody>
            {liq.costCurve.map((c) => (
              <tr key={c.pct}>
                <td className="num">{c.pct}%</td>
                <td className={`num${c.downExhausted ? " exhausted" : ""}`}>
                  {c.downExhausted ? "book ends" : usd(c.downNotional)}
                  <span className="cost-px">{fmtPrice(mid * (1 - c.pct / 100), precision)}</span>
                </td>
                <td className={`num${c.upExhausted ? " exhausted" : ""}`}>
                  {c.upExhausted ? "book ends" : usd(c.upNotional)}
                  <span className="cost-px">{fmtPrice(mid * (1 + c.pct / 100), precision)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub" style={{ margin: "6px 0 0" }}>
          How much someone would have to buy or sell at market to push the price
          that far, and where it would end up. “Book ends” means there aren’t
          enough orders to get there at all.
        </p>
      </div>

      {liq.walls.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
            Big orders in the way
          </h3>
          <table>
            <thead>
              <tr>
                <th>Price</th>
                <th>Side</th>
                <th>Notional</th>
                <th>× median</th>
              </tr>
            </thead>
            <tbody>
              {liq.walls.slice(0, 6).map((w) => (
                <tr key={`${w.side}-${w.price}`}>
                  <td className="num">{w.price.toFixed(snap.meta?.pricePrecision ?? 2)}</td>
                  <td>{w.side === "bid" ? "bid" : "ask"}</td>
                  <td className="num">{usd(w.notional)}</td>
                  <td className="num">{w.multiple.toFixed(0)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub" style={{ margin: "6px 0 0" }}>
            Resting limit size, so these work against a move rather than
            extending it — the opposite sign to a stop cluster.
          </p>
        </div>
      )}
    </section>
  );
}
