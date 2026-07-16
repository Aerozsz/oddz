import Link from "next/link";
import { listConsensus } from "@/features/consensus/queries";
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
        <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-400">
          No meaningful gaps right now — venues agree with the consensus. Gaps open when news breaks
          or one venue&apos;s liquidity is thin.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.eventId} className="rounded border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-start justify-between gap-4">
                <Link
                  href={`/events/${encodeURIComponent(r.eventId)}`}
                  className="min-w-0 text-zinc-100 hover:text-white"
                >
                  <span className="line-clamp-2">{r.title}</span>
                  {r.category && <span className="text-xs text-zinc-500">{r.category}</span>}
                </Link>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-xl text-zinc-100">{formatPct(r.consensus)}</div>
                  <div className="text-xs text-zinc-500">consensus · {formatUSD(r.totalVolume)}</div>
                </div>
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
                      className="inline-flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 hover:border-zinc-600"
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
