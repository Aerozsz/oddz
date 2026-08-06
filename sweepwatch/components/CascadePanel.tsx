"use client";

import { useState } from "react";
import type { CascadePath, Snapshot } from "../lib/types";
import { pct, price as fmtPrice, riskStatus, STATUS_VAR, usd } from "./format";

/**
 * The chain, priced.
 *
 * Read the seed figure first: it is what an aggressor has to spend to reach the
 * first cluster from here. Everything after it is paid for by the clusters
 * themselves. When the seed number falls while price has not moved, the book
 * got thinner — that is the sweep becoming affordable, and it is visible before
 * anything shows up on a price chart.
 */
export default function CascadePanel({ snap }: { snap: Snapshot }) {
  const [dir, setDir] = useState<"down" | "up">("down");
  const path = dir === "down" ? snap.cascadeDown : snap.cascadeUp;
  const precision = snap.meta?.pricePrecision ?? 2;

  return (
    <section className="panel">
      <header>
        <h2>Cascade path</h2>
        <div className="controls">
          <button aria-pressed={dir === "down"} onClick={() => setDir("down")}>
            downside
          </button>
          <button aria-pressed={dir === "up"} onClick={() => setDir("up")}>
            upside
          </button>
        </div>
      </header>

      {!path ? (
        <p className="empty">
          No amplifying levels mapped {dir === "down" ? "below" : "above"} the mark within range.
        </p>
      ) : (
        <CascadeBody path={path} precision={precision} mid={snap.mid ?? 0} />
      )}
    </section>
  );
}

function CascadeBody({
  path,
  precision,
  mid,
}: {
  path: CascadePath;
  precision: number;
  mid: number;
}) {
  const status = riskStatus(path.risk);
  const modelled = path.links.reduce((s, l) => s + l.modelledPortion, 0);
  const released = path.links.reduce((s, l) => s + l.released, 0);

  return (
    <>
      <div className={`banner ${status.key}`}>
        <span className="icon" style={{ color: STATUS_VAR[status.key] }}>
          {status.icon}
        </span>
        <div>
          <strong style={{ color: STATUS_VAR[status.key] }}>
            {status.label} — sweep risk {path.risk.toFixed(0)}/100
          </strong>
          <div className="sub" style={{ marginTop: 2 }}>
            {usd(path.seedNotional)} of aggressive flow reaches the first cluster.{" "}
            {path.links.length} link{path.links.length === 1 ? "" : "s"} chain from there to{" "}
            {fmtPrice(path.terminalPrice, precision)} ({pct(path.terminalPct)}).
          </div>
        </div>
      </div>

      <div className="tiles" style={{ marginTop: 12 }}>
        <div className="tile">
          <span className="k">Seed to first cluster</span>
          <span className="v">{usd(path.seedNotional)}</span>
          <span className="d">at current depth</span>
        </div>
        <div className="tile">
          <span className="k">Forced flow released</span>
          <span className="v">{usd(released)}</span>
          <span className="d">across {path.links.length} levels</span>
        </div>
        <div className="tile">
          <span className="k">Terminal</span>
          <span className="v">{fmtPrice(path.terminalPrice, precision)}</span>
          <span className="d">{pct(path.terminalPct)} from mid</span>
        </div>
        <div className="tile">
          <span className="k">Leverage</span>
          <span className="v">
            {path.seedNotional > 0 ? `${(released / path.seedNotional).toFixed(1)}×` : "—"}
          </span>
          <span className="d">released per seed dollar</span>
        </div>
      </div>

      <div className="chain">
        {path.links.map((link, i) => (
          <div className="link" key={`${link.cluster.price}-${i}`}>
            <div className="rail">
              <span className="node" />
            </div>
            <div className="body">
              <div className="head">
                <b>{fmtPrice(link.cluster.price, precision)}</b>
                <span className="sub">{pct(((link.cluster.price - mid) / mid) * 100)}</span>
                <span className="sub">·</span>
                <span className="sub">{usd(link.cluster.notional)} released</span>
              </div>
              <div className="detail">
                {i === 0 ? "seed pays" : "carried by the level above"} {usd(link.costToReach)}
                {link.modelledPortion > 0 &&
                  ` (${usd(link.modelledPortion)} past the end of the book)`}
                {" → "}
                {fmtPrice(link.priceAfter, precision)}
              </div>
              <div className="detail">
                {link.cluster.sources.join(", ") || "book"} · confidence{" "}
                {(link.cluster.confidence * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="sub" style={{ margin: "2px 0 0" }}>
        {modelled > 0
          ? `${usd(modelled)} of the walk happens past the last posted level, where depth is estimated rather than observed.`
          : "The whole walk stays inside posted book depth."}{" "}
        Cluster sizes are modelled from open interest, leverage tiers and prior
        structure — they are estimates, not an order book of stops.
      </p>
    </>
  );
}
