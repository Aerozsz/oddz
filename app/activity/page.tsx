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

export default async function ActivityPage() {
  const rows = await listUnusualActivity(24, 40);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Unusual activity</h1>
        <p className="text-sm text-zinc-500">
          Biggest 24h volume surges. A spike in money is usually the first sign that news is about to
          move the odds.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-zinc-400">
          No volume surges in the last 24 hours — needs at least two snapshots per market.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="bg-zinc-900/60 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2 text-right">Volume then → now</th>
                <th className="px-3 py-2 text-right">Added</th>
                <th className="px-3 py-2 text-right">×</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                    {formatUSD(r.volumeThen)} → {formatUSD(r.volumeNow)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-300">
                    +{formatUSD(r.delta)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">
                    {Number.isFinite(r.ratio) ? `${r.ratio.toFixed(1)}×` : "new"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
