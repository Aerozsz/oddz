import Link from "next/link";
import { LiveDot, PageHeader } from "@/features/layout/PageHeader";
import { listArbitrage } from "@/features/arbitrage/queries";
import { NearMisses } from "@/features/markets/components/NearMisses";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Arbitrage",
  description:
    "Risk-free cross-venue arbitrage: buy YES on one venue and NO on another for a guaranteed payout under $1.",
};

export default async function ArbitragePage() {
  const arbs = await listArbitrage(0.005, 50);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Arbitrage"
        context={<><LiveDot /> {arbs.length} open · live scan</>}
        blurb={<>Same event, two venues, mispriced. Buy YES on the cheaper venue and NO on the pricier one
          — you pay under $1 for a guaranteed $1 payout. Edge shown is gross, before venue fees and
          slippage.</>}
      />

      {arbs.length === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            No live arbitrage right now — venues are priced in line. Lock-ins appear when the same
            event trades at different prices on two venues; it tightens fast when news hits.
          </div>
          <NearMisses lead="Closest gaps right now — where an arb would open first" />
        </div>
      ) : (
        <>
        {/* Stat cards per the handoff: open opps / best edge / executable depth */}
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Open opportunities
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-fg">
              {arbs.length}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Best edge
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-accent">
              +{formatPct(arbs[0].edge)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              Executable depth
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-fg">
              {(() => {
                const depths = arbs
                  .map((a) =>
                    a.buyYes.liquidity !== null && a.buyNo.liquidity !== null
                      ? Math.min(a.buyYes.liquidity, a.buyNo.liquidity)
                      : null,
                  )
                  .filter((d): d is number => d !== null);
                if (depths.length === 0) return <span className="text-muted">n/a</span>;
                return formatUSD(depths.reduce((a, b) => a + b, 0));
              })()}
            </div>
            <div className="text-[10px] text-muted">min book across both legs, summed</div>
          </div>
        </div>
        <div className="stagger grid gap-3 lg:grid-cols-2">
          {arbs.map((a) => (
            <div
              key={a.eventId}
              className="lift flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 hover:border-[rgb(var(--c-accent))]/40 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/events/${encodeURIComponent(a.eventId)}`}
                  className="text-zinc-100 hover:text-white"
                >
                  {a.title}
                </Link>
                {a.category && <div className="text-xs text-zinc-500">{a.category}</div>}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-zinc-400">Buy</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">
                    YES
                  </span>
                  <span className="text-zinc-400">on</span>
                  <a href={a.buyYes.sourceUrl} target="_blank" rel="noopener noreferrer">
                    <VenueBadge venue={a.buyYes.venue} />
                  </a>
                  <span className="font-mono text-zinc-300">@ {formatPct(a.yesCost)}</span>
                  <span className="text-zinc-600">+</span>
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-medium text-red-300">
                    NO
                  </span>
                  <span className="text-zinc-400">on</span>
                  <a href={a.buyNo.sourceUrl} target="_blank" rel="noopener noreferrer">
                    <VenueBadge venue={a.buyNo.venue} />
                  </a>
                  <span className="font-mono text-zinc-300">@ {formatPct(a.noCost)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end">
                <div className="text-right">
                  <div className="font-mono text-2xl font-semibold text-emerald-300">
                    +{formatPct(a.edge)}
                  </div>
                  <div className="text-xs text-zinc-500">locked edge</div>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  cost <span className="font-mono text-zinc-400">${a.totalCost.toFixed(3)}</span>
                  <br />
                  per $1 payout
                  {a.buyYes.liquidity !== null && a.buyNo.liquidity !== null && (
                    <>
                      <br />
                      depth{" "}
                      <span className="font-mono text-zinc-400">
                        {formatUSD(Math.min(a.buyYes.liquidity, a.buyNo.liquidity))}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
}
