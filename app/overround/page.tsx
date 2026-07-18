import Link from "next/link";
import { getOverroundDistribution, listOverround } from "@/features/overround/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Overround",
  description:
    "Multi-outcome markets whose outcome prices don't sum to $1 — house vig when over, risk-free buy-all arbitrage when under.",
};

function pp(x: number) {
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
}

export default async function OverroundPage() {
  const [rows, dist] = await Promise.all([
    listOverround(0.01, 60),
    getOverroundDistribution(),
  ]);

  const maxBin = Math.max(...dist.bins.map((b) => b.count), 1);
  const maxCat = Math.max(...dist.byCategory.map((c) => Math.abs(c.avg)), 0.0001);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overround</h1>
        <p className="max-w-2xl text-sm text-muted">
          On a multi-outcome market the outcome prices should sum to $1. When they sum{" "}
          <span className="text-neg">over</span>, you&apos;re paying the house&apos;s vig. When they
          sum <span className="text-accent">under</span>, you can buy every outcome for less than $1
          and one must pay $1 — risk-free.
        </p>
      </div>

      {/* Stat cards */}
      <div className="stagger grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Markets analysed
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-fg">
            {dist.count.toLocaleString()}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Median vig
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-fg">
            {dist.median === null ? "—" : pp(dist.median)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Buy-all arbs
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-accent">
            {dist.values.filter((v) => v.overround < 0).length}
          </div>
        </div>
      </div>

      {/* Histogram + category bars */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Vig distribution
          </div>
          <div className="flex h-40 items-end gap-1">
            {dist.bins.map((b, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${pp(b.from)}…${pp(b.to)}: ${b.count}`}>
                <span className="font-mono text-[9px] text-muted">{b.count || ""}</span>
                <div
                  className="w-full rounded-t-[3px]"
                  style={{
                    height: `${Math.max(2, (b.count / maxBin) * 100)}%`,
                    backgroundColor: b.healthy ? "rgb(var(--c-accent))" : "rgb(var(--c-neg))",
                    opacity: b.count ? 1 : 0.25,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between font-mono text-[9px] text-muted">
            <span>−6pp</span>
            <span>fair</span>
            <span>+20pp</span>
          </div>
          <p className="mt-3 text-xs text-muted">
            <span className="text-accent">Green</span> = healthy (≤4pp). The{" "}
            <span className="text-neg">red</span> tail is where the book gets expensive.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Avg vig by category
          </div>
          {dist.byCategory.length === 0 ? (
            <div className="text-sm text-muted">Not enough categorised markets yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {dist.byCategory.map((c) => (
                <div key={c.category} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-xs text-fg" title={c.category}>
                    {c.category}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-track">
                    <div
                      className="grow-x h-full rounded-full"
                      style={{
                        width: `${Math.max(3, (Math.abs(c.avg) / maxCat) * 100)}%`,
                        backgroundColor: c.avg <= 0.04 ? "rgb(var(--c-accent))" : "rgb(var(--c-neg))",
                      }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted">
                    {pp(c.avg)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actionable table: most extreme deviations */}
      <div>
        <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
          Biggest deviations
        </h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-muted">
            No multi-outcome markets deviating from fair pricing right now.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead className="bg-surface font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Market</th>
                  <th className="px-3 py-2 text-left">Venue</th>
                  <th className="px-3 py-2 text-right">Outcomes</th>
                  <th className="px-3 py-2 text-right">Sum</th>
                  <th className="px-3 py-2 text-right">Signal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isArb = r.overround < 0;
                  return (
                    <tr key={r.id} className="border-t border-border-subtle hover:bg-[rgb(var(--c-surface-hover))]">
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
                        <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                          <VenueBadge venue={r.venue} name={r.venueName} />
                        </a>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted">
                        {r.outcomes.length}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                        {formatPct(r.sum)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className={cn(
                            "rounded px-2 py-0.5 font-mono text-xs",
                            isArb ? "bg-accent/15 text-accent" : "bg-neg/15 text-neg",
                          )}
                        >
                          {isArb ? "arb " : "vig "}
                          {pp(r.overround)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
