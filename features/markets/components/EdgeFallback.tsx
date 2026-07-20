import Link from "next/link";
import { listMovers } from "@/features/markets/queries";
import { listYields } from "@/features/yields/queries";
import { VenueBadge } from "./VenueBadge";
import { cn, formatPct } from "@/lib/utils";

/**
 * Fills a signal page that has nothing to show yet with edges that ALWAYS
 * exist — best yields and biggest movers — so no page is ever a stretched
 * empty box. The user came for an edge; give them one.
 */
export async function EdgeFallback({ stacked = false }: { stacked?: boolean }) {
  const [yields, movers] = await Promise.all([
    listYields({ maxDays: 30, limit: 5 }).catch(() => []),
    listMovers(24, 5).catch(() => []),
  ]);

  return (
    <div className={cn("grid gap-4", stacked ? "" : "sm:grid-cols-2")}>
      <section className="min-w-0">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Meanwhile: best yields ≤30d
          </h2>
          <Link href="/yields" className="link font-mono text-[11px] text-accent">
            all →
          </Link>
        </div>
        <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
          {yields.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">No favorites in window.</div>
          ) : (
            yields.map((r) => (
              <Link
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
              >
                <span className="line-clamp-1 text-[13px] text-fg">{r.question}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <VenueBadge venue={r.venue} />
                  <span className="w-12 text-right font-mono text-sm font-semibold tabular-nums text-accent">
                    {r.apr >= 10 ? `${r.apr.toFixed(0)}×` : formatPct(r.apr)}
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="min-w-0">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Meanwhile: biggest movers 24h
          </h2>
          <Link href="/movers" className="link font-mono text-[11px] text-accent">
            all →
          </Link>
        </div>
        <div className="stagger flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
          {movers.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted">No moves in window.</div>
          ) : (
            movers.map((m) => (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent(m.id)}`}
                className="tap flex items-center justify-between gap-3 px-3 py-2 hover:bg-[rgb(var(--c-surface-hover))]"
              >
                <span className="line-clamp-1 text-[13px] text-fg">{m.question}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <VenueBadge venue={m.venue} />
                  <span
                    className={cn(
                      "w-14 text-right font-mono text-sm font-semibold tabular-nums",
                      m.delta >= 0 ? "text-accent" : "text-neg",
                    )}
                  >
                    {m.delta >= 0 ? "+" : ""}
                    {(m.delta * 100).toFixed(1)}pp
                  </span>
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
