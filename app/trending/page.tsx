import Link from "next/link";
import { listTrending } from "@/features/markets/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct, formatUSD } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Trending",
  description: "What's hot right now — markets ranked by a blend of price movement and volume.",
};

/**
 * The one place in the app a green→red gradient bar is allowed (per brand
 * spec). `heat` is 0..1, the market's score normalised to the hottest in view.
 */
function HeatBar({ heat }: { heat: number }) {
  const pct = Math.max(4, Math.round(heat * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-track">
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct}%`,
          background: "linear-gradient(90deg, rgb(var(--c-accent)), rgb(var(--c-neg)))",
        }}
      />
    </div>
  );
}

function MoveChip({ move }: { move: number }) {
  const up = move >= 0;
  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        Math.abs(move) < 0.001 ? "text-muted" : up ? "text-accent" : "text-neg",
      )}
    >
      {up ? "▲" : "▼"} {(Math.abs(move) * 100).toFixed(1)}pp
    </span>
  );
}

export default async function TrendingPage() {
  const rows = await listTrending(24, 40);
  const maxScore = rows.reduce((m, r) => Math.max(m, r.score), 0) || 1;
  const top3 = rows.slice(0, 3);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Trending</h1>
        <p className="text-sm text-muted">
          What&apos;s hot right now — real odds movement with real money behind it. Heat blends
          24h price swing with volume.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
          Nothing trending yet — needs a couple of snapshots to measure movement.
        </div>
      ) : (
        <>
          {/* Top-3 heat cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {top3.map((r, i) => (
              <Link
                key={r.id}
                href={`/markets/${encodeURIComponent(r.id)}`}
                className="lift group flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 hover:border-[rgb(var(--c-accent))]/40"
              >
                <div className="flex items-center justify-between">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-track font-mono text-xs font-semibold text-fg">
                    {i + 1}
                  </span>
                  <VenueBadge venue={r.venue} name={r.venueName} />
                </div>
                <div className="min-h-[2.5rem] text-sm text-fg">
                  <span className="line-clamp-2">{r.question}</span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="font-mono text-3xl font-semibold tabular-nums text-fg">
                    {formatPct(r.yes)}
                  </span>
                  <div className="flex flex-col items-end gap-0.5">
                    <MoveChip move={r.move} />
                    <span className="font-mono text-[11px] text-muted">{formatUSD(r.volume)}</span>
                  </div>
                </div>
                <HeatBar heat={r.score / maxScore} />
              </Link>
            ))}
          </div>

          {/* Heat-ranked table */}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead className="bg-surface font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Market</th>
                  <th className="px-3 py-2 text-left">Venue</th>
                  <th className="px-3 py-2 text-right">YES</th>
                  <th className="px-3 py-2 text-right">24h</th>
                  <th className="px-3 py-2 text-right">Volume</th>
                  <th className="px-3 py-2 text-left">Heat</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.id}
                    className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-muted">{i + 1}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/markets/${encodeURIComponent(r.id)}`}
                        className="block text-fg hover:text-white"
                      >
                        <span className="line-clamp-2">{r.question}</span>
                        {r.category && <span className="text-xs text-muted">{r.category}</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <VenueBadge venue={r.venue} name={r.venueName} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                      {formatPct(r.yes)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoveChip move={r.move} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted">
                      {formatUSD(r.volume)}
                    </td>
                    <td className="w-28 px-3 py-2">
                      <HeatBar heat={r.score / maxScore} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
