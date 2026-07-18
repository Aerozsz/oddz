import Link from "next/link";
import type { MarketRow } from "@/features/markets/queries";
import { Sparkline } from "@/features/markets/components/Sparkline";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { StarButton } from "./StarButton";
import { cn, formatPct, formatUSD } from "@/lib/utils";

/** Donut progress ring showing YES probability. Green arc over a track. */
function Donut({ yes, size = 56 }: { yes: number; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const filled = c * Math.min(Math.max(yes, 0), 1);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--c-track))" strokeWidth="5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgb(var(--c-accent))"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        style={{ transition: "stroke-dasharray 600ms var(--ease-out)" }}
      />
    </svg>
  );
}

export function WatchCard({ row, spark }: { row: MarketRow; spark: number[] }) {
  const yes = row.prices?.[0] ?? null;
  // 24h move from the sparkline window (first vs last point).
  const delta = spark.length >= 2 ? spark[spark.length - 1] - spark[0] : null;

  return (
    <div className="lift relative flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="absolute right-2 top-2">
        <StarButton marketId={row.id} initialWatched />
      </div>
      <div className="flex items-center gap-3 pr-6">
        {yes !== null && (
          <div className="relative">
            <Donut yes={yes} />
            <span className="absolute inset-0 flex rotate-0 items-center justify-center font-mono text-[11px] font-semibold tabular-nums text-fg">
              {Math.round(yes * 100)}
            </span>
          </div>
        )}
        <Link
          href={`/markets/${encodeURIComponent(row.id)}`}
          className="min-w-0 text-sm text-fg hover:text-white"
        >
          <span className="line-clamp-2">{row.question}</span>
        </Link>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <VenueBadge venue={row.venue} name={row.venueName} />
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {formatUSD(row.volume)} vol
          </span>
        </div>
        <div className="flex flex-col items-end gap-1">
          {delta !== null && (
            <span
              className={cn(
                "font-mono text-xs tabular-nums",
                Math.abs(delta) < 0.001 ? "text-muted" : delta > 0 ? "text-accent" : "text-neg",
              )}
            >
              {delta > 0 ? "▲" : delta < 0 ? "▼" : ""} {formatPct(Math.abs(delta))} 24h
            </span>
          )}
          <Sparkline values={spark} width={88} height={24} />
        </div>
      </div>
    </div>
  );
}
