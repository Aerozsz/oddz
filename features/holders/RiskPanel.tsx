"use client";

import type { WireSnapshot } from "@/lib/holders/serialize";
import { cn } from "@/lib/utils";
import { pct, tokens, usd } from "./format";

/**
 * Concentration and exit depth.
 *
 * Every figure here is derived from the same two inputs — the clustered
 * holder set and the live reserves — so the table above and this panel can
 * never disagree about who holds what or what the pool would pay for it.
 */
export function RiskPanel({ snap }: { snap: WireSnapshot }) {
  const c = snap.concentration;
  const sym = snap.token.symbol;

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card title="Concentration (of float)">
        <Stat label="Top 1" value={pct(c.top1)} tone={c.top1 > 0.3 ? "neg" : undefined} />
        <Stat label="Top 5" value={pct(c.top5)} tone={c.top5 > 0.5 ? "neg" : undefined} />
        <Stat label="Top 10" value={pct(c.top10)} />
        <Stat
          label="HHI"
          value={c.hhi.toFixed(3)}
          hint="Herfindahl index. Above 0.25 is a concentrated market."
          tone={c.hhi > 0.25 ? "neg" : undefined}
        />
        <Stat
          label="Top 1 vs pool"
          value={c.top1OverPool !== null ? `${c.top1OverPool.toFixed(2)}x` : "—"}
          hint="Largest holder's stack as a multiple of the pool's token reserve. Above 1 means the pool cannot absorb them."
          tone={(c.top1OverPool ?? 0) > 1 ? "neg" : undefined}
        />
      </Card>

      <Card title="Exit depth">
        {snap.depthLadder.length === 0 ? (
          <p className="text-[11px] text-muted">
            Reserves unavailable — connect an RPC that serves the pair.
          </p>
        ) : (
          snap.depthLadder.map((d) => (
            <Stat
              key={d.sizeUsd}
              label={usd(d.sizeUsd) + " sold"}
              value={pct(d.priceImpact, 0)}
              tone={d.priceImpact < -0.2 ? "neg" : undefined}
            />
          ))
        )}
        {snap.cascade?.tokensToHalve != null && (
          <Stat
            label="To halve price"
            value={`${tokens(snap.cascade.tokensToHalve)} ${sym}`}
            hint={
              snap.cascade.shareOfFloat !== null
                ? `${pct(snap.cascade.shareOfFloat, 1)} of float`
                : undefined
            }
          />
        )}
      </Card>

      <Card title="Supply">
        <Stat label="Holders" value={snap.holderCount.toLocaleString()} />
        <Stat
          label="Entities"
          value={snap.entities.length.toLocaleString()}
          hint={
            snap.clusteredAddresses > 0
              ? `${snap.clusteredAddresses} addresses collapsed into multi-address actors`
              : "no multi-address actors detected"
          }
        />
        <Stat label="Float" value={`${tokens(snap.circulatingSupply)} ${sym}`} />
        <Stat label="In pool" value={`${tokens(snap.poolBalance)} ${sym}`} />
        <Stat
          label="Liquidity"
          value={usd(snap.market.liquidityUsd)}
          hint={`price source: ${snap.market.source}`}
        />
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        {title}
      </h3>
      <dl className="flex flex-col gap-1.5">{children}</dl>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neg";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd
        className={cn(
          "font-mono text-[12px] tabular-nums",
          tone === "neg" ? "text-neg" : "text-fg",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
