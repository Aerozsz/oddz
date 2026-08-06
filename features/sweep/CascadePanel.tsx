"use client";

import type { CascadePath, Snapshot } from "@/lib/sweep/types";
import { pct, price as fmtPrice, riskStatus, STATUS_VAR, usd } from "./format";

/**
 * The chain, priced, in both directions at once.
 *
 * Read the seed figure first: it is what an aggressor has to spend to reach the
 * first cluster from here. Everything after it is paid for by the clusters
 * themselves. When the seed number falls while price has not moved, the book
 * got thinner — that is the sweep becoming affordable, and it is visible before
 * anything shows up on a price chart.
 *
 * Shown side by side rather than behind a toggle because the two directions are
 * read against each other: a downside seed a fraction of the upside one is the
 * asymmetry, and a tab hides exactly that comparison.
 */
export default function CascadePanel({ snap }: { snap: Snapshot }) {
  const precision = snap.meta?.pricePrecision ?? 2;
  const mid = snap.mid ?? 0;

  return (
    <section className="panel cascade-panel">
      <header>
        <h2>If a sweep starts here</h2>
        <span className="sub">what it would cost, and how far it could go</span>
      </header>

      <div className="cascade-pair">
        <CascadeSide label="Pushing price down" dir="down" path={snap.cascadeDown} precision={precision} mid={mid} flowMinute={snap.flowMinute.sell} />
        <CascadeSide label="Pushing price up" dir="up" path={snap.cascadeUp} precision={precision} mid={mid} flowMinute={snap.flowMinute.buy} />
      </div>
    </section>
  );
}

function CascadeSide({
  label,
  dir,
  path,
  precision,
  mid,
  flowMinute,
}: {
  label: string;
  dir: "down" | "up";
  path: CascadePath | null;
  precision: number;
  mid: number;
  flowMinute: number;
}) {
  const status = path ? riskStatus(path.risk) : null;

  return (
    <div className="cascade-side">
      <div className="side-head">
        <h3>{label}</h3>
        {status && path && (
          <span className="side-risk" style={{ color: STATUS_VAR[status.key] }}>
            {status.label} · {path.risk.toFixed(0)}/100
          </span>
        )}
      </div>

      {!path ? (
        <p className="empty">
          No stop-loss build-up found {dir === "down" ? "below" : "above"} the price right now.
        </p>
      ) : (
        <CascadeBody path={path} precision={precision} mid={mid} flowMinute={flowMinute} />
      )}
    </div>
  );
}

/**
 * How close the market currently is to paying for the first link.
 *
 * The seed is a quantity of aggressive flow, and a bare dollar figure gives no
 * sense of whether that is a lot here or nothing at all. Against the flow the
 * last minute actually produced, it becomes readable: a bar near full means
 * ordinary current activity is already the size that would set this off.
 */
function SeedProgress({
  path,
  flowMinute,
  precision,
}: {
  path: CascadePath;
  flowMinute: number;
  precision: number;
}) {
  const frac = path.seedNotional > 0 ? Math.min(1, flowMinute / path.seedNotional) : 0;
  const hot = frac >= 0.75;
  return (
    <div className="seedbar" style={{ marginTop: 10 }}>
      <div className="seedbar-head">
        <span className="sub">flow in the last minute vs what it takes</span>
        <span className="num" style={{ color: hot ? "var(--critical)" : "var(--ink-2)" }}>
          {usd(flowMinute)} / {usd(path.seedNotional)}
        </span>
      </div>
      <div className="seedbar-track">
        <i
          style={{
            width: `${frac * 100}%`,
            background: hot ? "var(--critical)" : frac > 0.4 ? "var(--warning)" : "var(--liq)",
          }}
        />
      </div>
      <span className="sub">
        {frac >= 1
          ? `Current activity alone is already the size that reaches ${fmtPrice(path.links[0]?.cluster.price ?? 0, precision)}.`
          : `${(frac * 100).toFixed(0)}% of the way — ${usd(Math.max(0, path.seedNotional - flowMinute))} more would do it.`}
      </span>
    </div>
  );
}

function CascadeBody({
  path,
  precision,
  mid,
  flowMinute,
}: {
  path: CascadePath;
  precision: number;
  mid: number;
  flowMinute: number;
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
            {status.label} — {path.risk.toFixed(0)}/100 chance-of-a-sweep score
          </strong>
          <div className="sub" style={{ marginTop: 2 }}>
            Someone buying or selling {usd(path.seedNotional)} at market would push price
            into the first batch of stop-losses. Those firing could carry it through{" "}
            {path.links.length} batch{path.links.length === 1 ? "" : "es"} in total, down to{" "}
            {fmtPrice(path.terminalPrice, precision)} ({pct(path.terminalPct)}) — if nobody steps in.
          </div>
        </div>
      </div>

      <SeedProgress path={path} flowMinute={flowMinute} precision={precision} />

      <div className="tiles" style={{ marginTop: 12 }}>
        <div className="tile">
          <span className="k">1 · Cost to start it</span>
          <span className="v">{usd(path.seedNotional)}</span>
          <span className="d">to reach the first stops</span>
        </div>
        <div className="tile">
          <span className="k">2 · Sets off</span>
          <span className="v">{usd(released)}</span>
          <span className="d">across {path.links.length} price levels</span>
        </div>
        <div className="tile">
          <span className="k">3 · Ends around</span>
          <span className="v">{fmtPrice(path.terminalPrice, precision)}</span>
          <span className="d">{pct(path.terminalPct)} from here</span>
        </div>
        <div className="tile">
          <span className="k">Amplification</span>
          <span className="v">
            {path.seedNotional > 0 ? `${(released / path.seedNotional).toFixed(1)}×` : "—"}
          </span>
          <span className="d">$ set off per $1 spent</span>
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
                {i === 0 ? "costs" : "paid for by the level above"} {usd(link.costToReach)}
                {link.modelledPortion > 0 &&
                  ` (${usd(link.modelledPortion)} of it beyond what we can actually see)`}
              </div>
              <div className="detail lands">
                price lands at <b>{fmtPrice(link.priceAfter, precision)}</b>{" "}
                <span className="sub">
                  ({pct(((link.priceAfter - mid) / mid) * 100)} from here)
                </span>
              </div>
              <div className="detail">
                {link.cluster.sources.join(", ") || "order book"} · how sure{" "}
                {(link.cluster.confidence * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="sub" style={{ margin: "2px 0 0" }}>
        {modelled > 0
          ? `${usd(modelled)} of this happens past the last visible order, so that part is an educated guess.`
          : "All of this stays within orders we can actually see."}{" "}
        How much sits at each level is estimated from open positions, typical leverage
        and past price highs and lows. Nobody publishes where stop-losses are, so these
        are informed guesses, not facts.
      </p>
    </>
  );
}
