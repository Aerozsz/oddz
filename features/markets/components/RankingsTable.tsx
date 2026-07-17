import Link from "next/link";
import type { MoverRow } from "../queries";
import { cn, formatPct, formatUSD } from "@/lib/utils";

/**
 * Dense rankings table (design section 03): # / MARKET (name + category
 * pill) / ODDS (mini progress bar + %) / 24H VOL / Δ24H. Rows link to the
 * market. `rows` reuse the movers shape (which carries yesNow + delta).
 */
export function RankingsTable({ rows }: { rows: MoverRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
        No ranked markets yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="grid grid-cols-[26px_1fr_120px_110px_84px] gap-3 border-b border-border px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        <span>#</span>
        <span>Market</span>
        <span>Odds</span>
        <span className="text-right">24h Vol</span>
        <span className="text-right">Δ 24h</span>
      </div>
      {rows.map((r, i) => (
        <Link
          key={r.id}
          href={`/markets/${encodeURIComponent(r.id)}`}
          className="grid grid-cols-[26px_1fr_120px_110px_84px] items-center gap-3 border-b border-border-subtle px-4 py-3 transition-colors last:border-0 hover:bg-[rgb(var(--c-surface-hover))]"
        >
          <span className="font-mono text-xs text-muted">{i + 1}</span>
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="truncate text-sm text-fg">{r.question}</span>
            {r.category && (
              <span className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] capitalize text-muted">
                {r.category}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-block h-[5px] w-11 overflow-hidden rounded-full bg-track">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.round(r.yesNow * 100)}%` }}
              />
            </span>
            <span className="font-mono text-xs text-fg">{formatPct(r.yesNow)}</span>
          </span>
          <span className="text-right font-mono text-xs text-fg">{formatUSD(r.volume)}</span>
          <span
            className={cn("text-right font-mono text-xs", r.delta >= 0 ? "text-accent" : "text-neg")}
          >
            {r.delta >= 0 ? "+" : ""}
            {(r.delta * 100).toFixed(1)}pp
          </span>
        </Link>
      ))}
    </div>
  );
}
