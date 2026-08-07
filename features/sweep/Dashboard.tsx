"use client";

import { useEffect } from "react";
import { exposeSweepFeed } from "@/lib/sweep/agent/browser";
import { CONFIG } from "@/lib/sweep/config";
import "./sweep.css";
import CascadePanel from "./CascadePanel";
import ClusterMap from "./ClusterMap";
import ContextPanel from "./ContextPanel";
import NewsPanel from "./NewsPanel";
import LiquidityPanel from "./LiquidityPanel";
import Tapes from "./Tapes";
import TopBar from "./TopBar";
import { useSnapshot, useSnapshotThrottled } from "./useEngine";

export default function Dashboard() {
  // Full rate for the canvas, throttled for everything made of text.
  const snap = useSnapshot();
  const slow = useSnapshotThrottled();

  // Hand the same running engine to anything automating this page, so an agent
  // and the display below can never disagree about what the book said.
  useEffect(() => {
    exposeSweepFeed();
  }, []);

  const conn = snap.connection;
  const blocked =
    conn.socket === "error" ||
    (conn.socket !== "open" && conn.error !== null && snap.ts > 0 && !snap.mid);

  return (
    // Every style in sweep.css is scoped to this class, so the dashboard keeps
    // its own dark surface without touching the surrounding app's theme.
    <div className="sweep-root">
      <div className="shell">
        <TopBar snap={slow} />

      {blocked && (
        <div className="banner critical">
          <span className="icon" style={{ color: "var(--critical)" }}>
            !!
          </span>
          <div>
            <strong>No connection to Binance.</strong>
            <div className="sub" style={{ marginTop: 2 }}>
              {conn.error ?? "The stream could not be opened."} Market data is read
              straight from Binance by your browser, so a region Binance refuses,
              a VPN, or a network that blocks <code>fstream.binance.com</code> will
              stop it here. REST calls fall back to a server proxy automatically;
              the WebSocket has no fallback.
            </div>
          </div>
        </div>
      )}

        <div className="grid cols">
          {/* Spans all three columns; see .cascade-panel in sweep.css. */}
          <CascadePanel snap={slow} />

          <div className="stack">
            <ContextPanel snap={slow} />
            {/* Directly under the context it qualifies: a withdrawal with a
                headline behind it is a different situation from an identical
                one without, and the two readings belong side by side. */}
            <NewsPanel symbol={slow.meta?.symbol ?? "INTCUSDT"} />
            <LiquidityPanel snap={slow} />
          </div>

          <div className="stack">
            <ClusterMap snap={snap} />
            <Method />
          </div>

          <div className="stack">
            <Tapes snap={slow} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Method() {
  return (
    <section className="panel">
      <header>
        <h2>What this measures</h2>
      </header>
      <div className="prose">
        <p>
          <strong>Depth thinning does not fire anything by itself.</strong> Price
          still has to reach a trigger level. What withdrawal changes is how much
          size that takes. So the order is: depth thins, an ordinary order now
          moves price far enough to reach a cluster, the cluster fires, and that
          fired volume is what carries price into the next one. Triggers feeding
          triggers is the reflexive part; withdrawal is the precondition that makes
          the first one cheap.
        </p>
        <p>
          <strong>Only two of the three trigger types extend a move.</strong> Stops
          and liquidations are market orders in the direction of travel, so they
          push. Take-profits are resting limit orders on the far side — a
          take-profit above is an ask a rally has to eat through. Those absorb.
          They are drawn on opposite sides of the divider above and are never
          summed together.
        </p>
        <p>
          Depth, prints, liquidations and mark price arrive over one combined
          WebSocket and the book is maintained continuously from the 100ms diff
          feed. Open interest is the single exception — Binance publishes no stream
          for it, so it is polled every 20s.
        </p>
        <p>
          Cluster sizes are estimates. Nobody publishes a book of stops. The
          leverage ladder assumes a {(CONFIG.maintenanceMarginRate * 100).toFixed(1)}%
          maintenance margin rate and a mix skewed toward this contract&rsquo;s 20x
          cap, and scales to {(CONFIG.liquidatableOiFraction * 100).toFixed(0)}% of
          open interest. Levels where liquidations have actually printed are marked
          at full opacity; everything fainter is inference.
        </p>
      </div>
    </section>
  );
}
