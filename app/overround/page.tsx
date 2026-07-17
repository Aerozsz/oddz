import Link from "next/link";
import { listOverround } from "@/features/overround/queries";
import { VenueBadge } from "@/features/markets/components/VenueBadge";
import { cn, formatPct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export const metadata = {
  title: "Overround",
  description:
    "Multi-outcome markets whose outcome prices don't sum to $1 — house vig when over, risk-free buy-all arbitrage when under.",
};

export default async function OverroundPage() {
  const rows = await listOverround(0.01, 60);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overround</h1>
        <p className="max-w-2xl text-sm text-zinc-500">
          On a multi-outcome market the outcome prices should sum to $1. When they sum{" "}
          <span className="text-red-300">over</span>, you&apos;re paying the house&apos;s vig. When
          they sum <span className="text-emerald-300">under</span>, you can buy every outcome for
          less than $1 and one must pay $1 — risk-free.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-zinc-400">
          No multi-outcome markets deviating from fair pricing right now.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
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
                        className="block text-zinc-100 hover:text-white"
                      >
                        <span className="line-clamp-2">{r.question}</span>
                        {r.category && <span className="text-xs text-zinc-500">{r.category}</span>}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <VenueBadge venue={r.venue} name={r.venueName} />
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-400">
                      {r.outcomes.length}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-300">
                      {formatPct(r.sum)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 font-mono text-xs",
                          isArb
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300",
                        )}
                      >
                        {isArb ? "arb " : "vig "}
                        {r.overround > 0 ? "+" : ""}
                        {(r.overround * 100).toFixed(1)}pp
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
  );
}
