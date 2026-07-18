import Link from "next/link";
import { listUnusualActivity } from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Unusual activity",
  description: "Markets with the biggest volume surges — the earliest tell that news is moving money.",
};

const WHALE = 100_000; // surges above this get the whale outline chip

export default async function ActivityPage() {
  const rows = await listUnusualActivity(24, 50);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Unusual activity</h1>
          <p className="text-sm text-muted">
            Biggest 24h volume surges. A spike in money is usually the first sign that news is about
            to move the odds.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 font-mono text-[11px] text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          {rows.length} surges · 24h
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No volume surges in the last 24 hours — needs at least two snapshots per market.
        </div>
      ) : (
        <div className="stagger grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const whale = r.delta >= WHALE;
            return (
              <Link
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-[rgb(var(--c-accent))]/40 hover:bg-[rgb(var(--c-surface-hover))]"
              >
                {/* side chip — surges are inflows, so a solid buy-side chip */}
                <span className="shrink-0 rounded-[5px] bg-accent px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-bg">
                  Surge
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-fg">{r.question}</span>
                    {whale && (
                      <span className="shrink-0 rounded-[5px] border border-[rgb(var(--c-accent))]/50 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-accent">
                        🐋 Whale
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                    <VenueBadge venue={r.venue} name={r.venueName} />
                    {r.category && <span className="truncate">{r.category}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm font-semibold tabular-nums text-accent">
                    +{formatUSD(r.delta)}
                  </div>
                  <div className="font-mono text-[11px] tabular-nums text-muted">
                    {formatUSD(r.volumeThen)} → {formatUSD(r.volumeNow)}
                  </div>
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted">
                  {Number.isFinite(r.ratio) ? `${r.ratio.toFixed(1)}×` : "new"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
