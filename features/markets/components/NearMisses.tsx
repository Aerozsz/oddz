import Link from "next/link";
import { listDivergences } from "@/features/divergence/queries";
import { VenueBadge } from "./VenueBadge";
import { formatPct } from "@/lib/utils";

/**
 * Empty-state upgrade for the cross-venue signal pages. Instead of a dead
 * end ("no arbitrage right now"), show the closest live gaps — the same
 * events the signal will fire on first — so the page always gives the user
 * somewhere to go.
 */
export async function NearMisses({ lead }: { lead: string }) {
  const rows = await listDivergences(6).catch(() => []);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No cross-venue matches yet — the matcher links the same question across venues as
        snapshots accumulate.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{lead}</div>
      <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {rows.map((r) => {
          const sorted = [...r.legs].sort((a, b) => b.yes - a.yes);
          return (
            <Link
              key={r.eventId}
              href={`/events/${encodeURIComponent(r.eventId)}`}
              className="flex items-center gap-3 px-3 py-2.5 hover:bg-[rgb(var(--c-surface-hover))]"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.title}</span>
              <span className="flex shrink-0 items-center gap-2">
                {sorted.slice(0, 2).map((l) => (
                  <span key={l.marketId} className="flex items-center gap-1.5">
                    <VenueBadge venue={l.venue} />
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {formatPct(l.yes)}
                    </span>
                  </span>
                ))}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-fg">
                {(r.spread * 100).toFixed(1)}pp
              </span>
            </Link>
          );
        })}
      </div>
      <Link href="/divergence" className="link self-start text-xs text-accent">
        All cross-venue gaps →
      </Link>
    </div>
  );
}
