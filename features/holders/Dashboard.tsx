"use client";

import { useState } from "react";
import { PageHeader } from "@/features/layout/PageHeader";
import { cn } from "@/lib/utils";
import { FlowFeed } from "./FlowFeed";
import { RiskPanel } from "./RiskPanel";
import { WhaleTable } from "./WhaleTable";
import { pct, usd } from "./format";
import { useHolderStream } from "./useHolderStream";

const STATUS_STYLE = {
  connecting: { label: "connecting", cls: "bg-track text-muted" },
  live: { label: "live", cls: "bg-accent/15 text-accent" },
  polling: { label: "polling", cls: "bg-track text-fg-dim" },
  error: { label: "error", cls: "bg-neg/15 text-neg" },
} as const;

export function Dashboard({ token, pair }: { token?: string; pair?: string }) {
  const [paused, setPaused] = useState(false);
  const { snapshot, status, error } = useHolderStream({ token, pair, paused });

  const s = snapshot;
  const badge = STATUS_STYLE[paused ? "polling" : status];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Whales"
        context={
          <>
            <span className={cn("rounded-full px-2 py-0.5", badge.cls)}>
              {paused ? "paused" : badge.label}
            </span>
            {s && (
              <span>
                block {s.indexedBlock > 0 ? s.indexedBlock.toLocaleString() : "—"}
                {s.backfilling && ` · indexing ${pct(s.backfillProgress, 0)}`}
              </span>
            )}
            <button
              onClick={() => setPaused((p) => !p)}
              className="rounded-full border border-border px-2 py-0.5 normal-case tracking-normal hover:border-[rgb(var(--c-accent))]/40"
            >
              {paused ? "resume" : "pause"}
            </button>
          </>
        }
        blurb={
          s ? (
            <span>
              {s.token.name} ({s.token.symbol}) · {usd(s.market.priceUsd)}
              {s.market.priceChange24hPct !== null && (
                <span
                  className={cn(
                    "ml-1",
                    s.market.priceChange24hPct >= 0 ? "text-accent" : "text-neg",
                  )}
                >
                  {s.market.priceChange24hPct >= 0 ? "+" : ""}
                  {s.market.priceChange24hPct.toFixed(1)}% 24h
                </span>
              )}
              {" · "}
              holders ranked as economic actors, not addresses.
            </span>
          ) : (
            "Reading holders from chain state."
          )
        }
      />

      {/* Configuration and source problems are shown, never swallowed: an empty
          table with no explanation is indistinguishable from a token nobody
          holds. */}
      {s?.warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      {error && !s?.warnings.includes(error) && <Notice tone="warn">{error}</Notice>}
      {s?.market.error && <Notice tone="warn">{s.market.error}</Notice>}

      {s && s.backfilling && (
        <Notice tone="info">
          Backfilling history — {pct(s.backfillProgress, 0)} of the range indexed. Balances
          shown are complete only for the blocks scanned so far.
        </Notice>
      )}

      {!s ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-[13px] text-muted">
          Connecting to the chain…
        </div>
      ) : (
        <>
          <RiskPanel snap={s} />
          <div className="grid gap-3 xl:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)]">
            <WhaleTable snap={s} />
            <FlowFeed snap={s} />
          </div>

          {s.relayers.length > 0 && (
            <div className="rounded-lg border border-border bg-surface p-3">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                Relayers and shared signers (excluded from clustering)
              </h3>
              <ul className="flex flex-wrap gap-2">
                {s.relayers.map((r) => (
                  <li
                    key={r.address}
                    className="rounded-full bg-track px-2 py-0.5 font-mono text-[10px] text-muted"
                    title={`${r.txCount} transactions across ${r.fanOut} addresses`}
                  >
                    {r.address.slice(0, 10)}… · {r.fanOut} addrs
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted">
                These signers serve too many unrelated addresses to be identity evidence.
                Excluding them is what stops every user of one forwarding service from
                collapsing into a single phantom whale.
              </p>
            </div>
          )}

          <Footnotes snap={s} />
        </>
      )}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone: "warn" | "info" }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-[12px]",
        tone === "warn" ? "border-neg/30 bg-neg/5 text-neg" : "border-border bg-surface text-muted",
      )}
    >
      {children}
    </div>
  );
}

function Footnotes({ snap }: { snap: ReturnType<typeof useHolderStream>["snapshot"] }) {
  if (!snap) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 text-[11px] text-muted">
      <p>
        Balances are replayed from the token&apos;s Transfer logs and are chain truth, not an
        aggregator&apos;s cache. Buy and sell classification comes from transfers touching the
        pair, priced from the Swap event in the same transaction.
      </p>
      {snap.costBasisIsApproximate && (
        <p>
          Cost basis is exact in quote terms and approximate in dollars: quote amounts are
          exact from the Swap events, but they are converted at the current quote price
          because no historical quote/USD series is available here.
        </p>
      )}
      <p>
        Exit values assume a single market sale into the tracked pool at x*y=k with a 30bp
        fee, gross of gas, and ignore any other venue.
      </p>
      <p>
        Clustering infers that addresses act as one actor from funding, conduit, sweep and
        signer patterns. It is evidence, not identity — each row shows what it was based on.
      </p>
    </div>
  );
}
