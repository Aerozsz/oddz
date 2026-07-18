import Link from "next/link";
import { listConsensus } from "@/features/consensus/queries";
import { NearMisses } from "@/features/markets/components/NearMisses";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Consensus",
  description:
    "Volume-weighted fair-value odds across venues, and which venue is trading richest or cheapest versus the crowd.",
};

export default async function ConsensusPage() {
  const rows = await listConsensus(0.02, 50);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Consensus fair value</h1>
        <p className="max-w-2xl text-sm text-zinc-500">
          The volume-weighted YES across venues is the crowd&apos;s fair value. A venue trading far
          from it is mispriced — buy the venue below consensus, fade the one above. Sorted by the
          biggest gap.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            No meaningful gaps right now — venues agree with the consensus. Gaps open when news
            breaks or one venue&apos;s liquidity is thin.
          </div>
          <NearMisses lead="Where venues disagree most right now" />
        </div>
      ) : (
        <div className="stagger grid gap-3 lg:grid-cols-2">
          {rows.map((r) => (
            <div key={r.eventId} className="lift rounded-lg border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-4">
                <Link
                  href={`/events/${encodeURIComponent(r.eventId)}`}
                  className="min-w-0 text-zinc-100 hover:text-white"
                >
                  <span className="line-clamp-2">{r.title}</span>
                  {r.category && <span className="text-xs text-zinc-500">{r.category}</span>}
                </Link>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-xl font-semibold tabular-nums text-fg">
                    {formatPct(r.consensus)}
                  </div>
                  <div className="text-xs text-muted">consensus · {formatUSD(r.totalVolume)}</div>
                </div>
              </div>

              {/* 0–100% strip: band spans the venue range, tick = consensus */}
              <div className="relative mt-3 h-5">
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-track" />
                {(() => {
                  const ys = r.legs.map((l) => l.yes);
                  const lo = Math.min(...ys);
                  const hi = Math.max(...ys);
                  const wide = hi - lo > 0.1;
                  return (
                    <div
                      className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                      style={{
                        left: `${lo * 100}%`,
                        width: `${Math.max(1, (hi - lo) * 100)}%`,
                        backgroundColor: wide ? "rgb(var(--c-neg) / 0.7)" : "rgb(var(--c-accent) / 0.7)",
                      }}
                    />
                  );
                })()}
                {r.legs.map((l) => (
                  <span
                    key={l.marketId}
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[rgb(var(--c-surface))] bg-muted"
                    style={{ left: `${l.yes * 100}%` }}
                    title={`${l.venue}: ${formatPct(l.yes)}`}
                  />
                ))}
                <span
                  className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg"
                  style={{ left: `${r.consensus * 100}%` }}
                  title={`consensus ${formatPct(r.consensus)}`}
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {r.legs
                  .slice()
                  .sort((a, b) => a.edge - b.edge)
                  .map((l) => (
                    <a
                      key={l.marketId}
                      href={l.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-2 py-1 hover:border-zinc-600"
                    >
                      <VenueBadge venue={l.venue} />
                      <span className="font-mono text-zinc-300">{formatPct(l.yes)}</span>
                      <span
                        className={cn(
                          "font-mono text-xs",
                          Math.abs(l.edge) < 0.005
                            ? "text-zinc-500"
                            : l.edge > 0
                              ? "text-red-300"
                              : "text-emerald-300",
                        )}
                      >
                        {l.edge > 0 ? "+" : ""}
                        {(l.edge * 100).toFixed(1)}pp
                      </span>
                    </a>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
