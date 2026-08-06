"use client";
import type { Snapshot } from "@/lib/sweep/types";
import { duration } from "./format";

/**
 * The three things that are true about this market regardless of what the book
 * is doing this second, and which the rest of the page cannot see.
 *
 *  - Whether the people paying the spread have been right (mark-out)
 *  - What holding a position costs (funding)
 *  - Whether something is scheduled that the model cannot see through (events)
 *
 * Grouped rather than scattered because they share a property: each one can
 * invalidate an otherwise good-looking setup on its own, and none of them
 * changes fast enough to need watching continuously. This is the panel you read
 * once before deciding, not the one you stare at.
 */
export default function ContextPanel({ snap }: { snap: Snapshot }) {
  return (
    <section className="panel">
      <header>
        <h2>Before you act on any of this</h2>
        <span className="sub">three things the order book cannot tell you</span>
      </header>

      <EventRow snap={snap} />
      <FlowRow snap={snap} />
      <FundingRow snap={snap} />
      <SessionRow snap={snap} />
    </section>
  );
}

/* ------------------------------------------------------------------ events */

function EventRow({ snap }: { snap: Snapshot }) {
  const e = snap.events;

  if (e.blackout) {
    return (
      <div className="ctx critical">
        <span className="ctx-k">Scheduled release</span>
        <span className="ctx-v" style={{ color: "var(--critical)" }}>
          Blackout
        </span>
        <span className="ctx-d">{e.reason}</span>
      </div>
    );
  }

  if (!e.next) {
    return (
      <div className="ctx">
        <span className="ctx-k">Scheduled release</span>
        <span className="ctx-v">Nothing ahead</span>
        <span className="ctx-d">no dates on the calendar</span>
      </div>
    );
  }

  const projected = e.next.certainty === "projected";
  return (
    <div className={`ctx ${e.sizeScale < 1 ? "warning" : ""}`}>
      <span className="ctx-k">Scheduled release</span>
      <span className="ctx-v" style={{ color: e.sizeScale < 1 ? "var(--warning)" : undefined }}>
        {e.msToNext !== null && e.msToNext < 14 * 86_400_000
          ? `${e.next.label} in ${duration(e.msToNext)}`
          : new Date(e.next.at).toDateString()}
      </span>
      <span className="ctx-d">
        {projected ? (
          <>
            <b>This date is a guess.</b> It comes from Intel&rsquo;s reporting pattern, not from an
            announcement, so it is good to about a week.{" "}
            {e.sizeScale < 1
              ? `Size is scaled to ${(e.sizeScale * 100).toFixed(0)}% while inside the estimated window.`
              : "No effect on sizing at this distance."}{" "}
            A guess is never allowed to halt trading outright — confirm the real date to get a proper
            blackout instead of this hedge.
          </>
        ) : (
          (e.reason ?? "confirmed date; trading stops inside the window around it")
        )}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- flow quality */

function FlowRow({ snap }: { snap: Snapshot }) {
  const m = snap.markout;

  if (!m.warm) {
    return (
      <div className="ctx">
        <span className="ctx-k">Is the aggressive side right?</span>
        <span className="ctx-v">Measuring…</span>
        <span className="ctx-d">
          needs a minute of prints before the answer means anything — each one is scored against the
          mid a few seconds later
        </span>
      </div>
    );
  }

  const label =
    m.regime === "toxic"
      ? "Yes — and it is costing the other side"
      : m.regime === "one-sided"
        ? m.informed > 0
          ? "Buyers have been"
          : "Sellers have been"
        : "No — they are paying for nothing";
  const colour =
    m.regime === "toxic" ? "var(--critical)" : m.regime === "one-sided" ? "var(--warning)" : "var(--good)";

  return (
    <div className={`ctx ${m.regime === "toxic" ? "critical" : m.regime === "one-sided" ? "warning" : ""}`}>
      <span className="ctx-k">Is the aggressive side right?</span>
      <span className="ctx-v" style={{ color: colour }}>
        {label}
      </span>
      <span className="ctx-d">
        {m.notes[0]}
        {m.regime === "toxic" && (
          <>
            {" "}
            <b>This is the warning that comes before the depth goes,</b> not after — whoever is
            quoting here is losing money doing it.
          </>
        )}
      </span>
      <div className="ctx-bar">
        <i
          style={{
            width: `${Math.min(100, m.toxicity * 100)}%`,
            background: colour,
          }}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- funding */

function FundingRow({ snap }: { snap: Snapshot }) {
  const f = snap.funding;
  if (!f.nextFundingTime) {
    return (
      <div className="ctx">
        <span className="ctx-k">Cost of holding</span>
        <span className="ctx-v">—</span>
        <span className="ctx-d">waiting for the mark-price stream</span>
      </div>
    );
  }

  const soon = f.msToFunding < 30 * 60_000 && f.paying !== "neither";
  return (
    <div className={`ctx ${f.stretched ? "warning" : ""}`}>
      <span className="ctx-k">Cost of holding</span>
      <span className="ctx-v" style={{ color: f.stretched ? "var(--warning)" : undefined }}>
        {f.paying === "neither"
          ? "Free either way"
          : `${f.paying === "longs" ? "Longs" : "Shorts"} pay ${(Math.abs(f.rate) * 100).toFixed(4)}%`}
      </span>
      <span className="ctx-d">
        {f.notes.join(" · ")}
        {soon && (
          <>
            {" "}
            <b>
              It is charged in full at the instant, not spread over time — closing a minute early
              costs nothing, a minute late costs the lot.
            </b>
          </>
        )}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- session */

function SessionRow({ snap }: { snap: Snapshot }) {
  const s = snap.session;
  const w = s.weights;
  const thin = w.depthScale < 0.6;

  return (
    <div className={`ctx ${s.transitioning ? "warning" : ""}`}>
      <span className="ctx-k">What time it is for this book</span>
      <span className="ctx-v">{s.intraday.replace("-", " ")}</span>
      <span className="ctx-d">
        {thin
          ? `Depth here normally runs about ${(w.depthScale * 100).toFixed(0)}% of the cash session, so the same order moves price much further. `
          : `Depth here normally runs about ${(w.depthScale * 100).toFixed(0)}% of the cash-session average. `}
        The thinness readings above already divide this out, so a low number there means somebody
        pulled depth — not just that Nasdaq is shut.
        {s.transitioning && (
          <>
            {" "}
            <b>
              This phase started {Math.round(s.msSincePhaseStart / 60_000)} min ago,
            </b>{" "}
            so the ten-minute baselines are still partly describing the last one.
          </>
        )}
      </span>
    </div>
  );
}
