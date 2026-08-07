"use client";

import type { CascadeCalibration } from "@/lib/sweep/metrics/cascade-outcomes";
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

      <Calibration cal={snap.cascadeCalibration} />

      <div className="cascade-pair">
        <CascadeSide label="Pushing price down" dir="down" path={snap.cascadeDown} precision={precision} mid={mid} flowMinute={snap.flowMinute.sell} />
        <CascadeSide label="Pushing price up" dir="up" path={snap.cascadeUp} precision={precision} mid={mid} flowMinute={snap.flowMinute.buy} />
      </div>
    </section>
  );
}

/**
 * Whether any of this has ever been right.
 *
 * The panel projects a chain and a terminal price, and until now said nothing
 * about whether those projections were borne out. That is the difference
 * between a model and a claim, and watching levels get crossed without the move
 * following is precisely the case where the difference matters.
 *
 * Three numbers, because "it is not accurate" can mean three different things:
 * whether price reaches the first level at all, how far it carries once it
 * does, and whether liquidations actually printed there. Shown even while cold,
 * because "not yet measured" is information and an unlabelled projection reads
 * as a verified one.
 */
function Calibration({ cal }: { cal: CascadeCalibration }) {
  if (!cal) return null;
  const pctOf = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
  return (
    <div className={`cascade-cal${cal.warm ? "" : " cold"}`}>
      {cal.warm ? (
        <>
          <span className="cal-item">
            <b className="num">{pctOf(cal.reachRate)}</b> reached the first level
          </span>
          <span className="cal-item">
            <b className="num">{pctOf(cal.travelFactor)}</b> of the projected distance, when they did
          </span>
          <span className="cal-item">
            <b className="num">{pctOf(cal.dischargeRate)}</b> printed liquidations
          </span>
          <span className="sub">
            over {cal.settled} outcomes · the projection below is scaled by the measured{" "}
            {cal.factor.toFixed(2)}×
          </span>
        </>
      ) : (
        <span className="sub">
          <b>Unverified.</b> {cal.note}. Everything below is a forward simulation on the
          current book — it has not yet been checked against what price actually did.
        </span>
      )}
    </div>
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
 * How close price is to setting the first level off.
 *
 * An earlier version filled this against aggressive flow versus the seed, which
 * was the wrong quantity: on this contract a minute of real flow is a few
 * thousand dollars against a seed in the hundreds of thousands, so the bar sat
 * at zero permanently and told you nothing.
 *
 * Distance is the quantity that actually moves. Price is either near the level
 * or it is not, that changes continuously, and it is the thing that has to
 * happen first — the seed is only what it costs to close that distance. The
 * seed stays on screen as a figure; the bar tracks the approach.
 */
function SeedProgress({
  path,
  flowMinute,
  precision,
  mid,
}: {
  path: CascadePath;
  flowMinute: number;
  precision: number;
  mid: number;
}) {
  const first = path.links[0]?.cluster;
  if (!first || !mid) return null;

  const distPct = Math.abs((first.price - mid) / mid) * 100;
  // Full when price is at the level, empty a full percent away. Beyond that the
  // level is not in play and the bar should read as such rather than clipping.
  const WINDOW_PCT = 1;
  const frac = Math.max(0, Math.min(1, 1 - distPct / WINDOW_PCT));
  const hot = frac >= 0.8;
  const near = frac >= 0.5;

  return (
    <div className="seedbar" style={{ marginTop: 10 }}>
      {/* The headline of the whole panel: how far price has to travel before
          any of the rest of it matters. Sized to be readable at a glance from
          across a desk, because it is the number being watched. */}
      <div className="distance">
        <span
          className="distance-value num"
          style={{ color: hot ? "var(--critical)" : near ? "var(--warning)" : "var(--ink)" }}
        >
          {fmtPrice(first.price, precision)}
        </span>
        <span
          className="distance-pct num"
          style={{ color: hot ? "var(--critical)" : near ? "var(--warning)" : "var(--ink-2)" }}
        >
          {distPct.toFixed(2)}%
        </span>
        <span className="distance-label">away · first level</span>
      </div>
      <div className="seedbar-track">
        <i
          style={{
            width: `${frac * 100}%`,
            background: hot ? "var(--critical)" : near ? "var(--warning)" : "var(--liq)",
          }}
        />
      </div>
      <span className="sub">
        {hot
          ? `Price is on top of it. ${usd(path.seedNotional)} of aggressive flow would take it through.`
          : `${usd(path.seedNotional)} would close the gap · ${usd(flowMinute)} traded that way in the last minute.`}
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
            {status.label} — {path.risk.toFixed(0)}/100 fragility score
          </strong>
          <div className="sub" style={{ marginTop: 2 }}>
            Someone buying or selling {usd(path.seedNotional)} at market would push price
            into the first batch of stop-losses. Those firing could carry it through{" "}
            {path.links.length} batch{path.links.length === 1 ? "" : "es"} in total, down to{" "}
            {fmtPrice(path.terminalPrice, precision)} ({pct(path.terminalPct)}) — if nobody steps in.
          </div>
        </div>
      </div>

      <SeedProgress path={path} flowMinute={flowMinute} precision={precision} mid={mid} />

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
