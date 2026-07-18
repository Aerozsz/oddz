import Link from "next/link";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { listMovers, type MoverRow } from "@/features/markets/queries";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Movers",
  description: "Biggest prediction-market odds moves in the last 24 hours, across all venues.",
};

function MoverColumn({
  title,
  rows,
  max,
  positive,
}: {
  title: string;
  rows: MoverRow[];
  max: number;
  positive: boolean;
}) {
  const accent = positive ? "rgb(var(--c-accent))" : "rgb(var(--c-neg))";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
        <span style={{ color: accent }}>{positive ? "▲" : "▼"}</span>
        {title}
        <span className="text-muted/60">({rows.length})</span>
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted">Nothing here in this window.</div>
        ) : (
          rows.map((m) => {
            const mag = max > 0 ? Math.abs(m.delta) / max : 0;
            return (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent(m.id)}`}
                className="relative flex flex-col gap-1 border-b border-border-subtle px-3 py-2.5 last:border-b-0 hover:bg-[rgb(var(--c-surface-hover))]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm text-fg">{m.question}</span>
                  <span
                    className="shrink-0 font-mono text-sm font-semibold tabular-nums"
                    style={{ color: accent }}
                  >
                    {m.delta >= 0 ? "+" : ""}
                    {(m.delta * 100).toFixed(1)}pp
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <VenueBadge venue={m.venue} name={m.venueName} />
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {formatPct(m.yesThen)} → {formatPct(m.yesNow)}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] tabular-nums text-muted">
                    {formatUSD(m.volume)}
                  </span>
                </div>
                {/* magnitude bar, scaled to the column's biggest move */}
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-track">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(3, mag * 100)}%`, backgroundColor: accent }}
                  />
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

export default async function MoversPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string }>;
}) {
  const sp = await searchParams;
  const hours = [6, 24, 168].includes(Number(sp.h)) ? Number(sp.h) : 24;
  const rows = await listMovers(hours, 60);

  const gainers = rows
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20);
  const losers = rows
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 20);
  const max = Math.max(
    ...gainers.map((m) => Math.abs(m.delta)),
    ...losers.map((m) => Math.abs(m.delta)),
    0.0001,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Movers</h1>
          <p className="text-sm text-muted">Biggest odds swings, all venues.</p>
        </div>
        <div className="flex gap-1 text-xs">
          {[6, 24, 168].map((h) => (
            <Link
              key={h}
              href={`/movers?h=${h}` as never}
              className={cn(
                "rounded-full border px-3 py-1 font-mono",
                h === hours
                  ? "border-transparent bg-fg text-bg"
                  : "border-border text-muted hover:border-[rgb(var(--c-accent))]/40",
              )}
            >
              {h === 168 ? "7D" : `${h}H`}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          No moves yet in this window — needs at least two snapshots per market.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <MoverColumn title="Gainers" rows={gainers} max={max} positive />
          <MoverColumn title="Losers" rows={losers} max={max} positive={false} />
        </div>
      )}
    </div>
  );
}
